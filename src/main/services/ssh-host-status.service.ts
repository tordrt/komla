import type { SshHostStatus } from '../../shared/types/ssh';

const MAX_MESSAGE_LENGTH = 200;
// Node stops a command whose output outgrows its buffer, after the host has answered.
const OUTPUT_LIMIT_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Whether ssh itself failed, rather than the command it ran: ssh exits 255 when it can't connect
 * or authenticate, and a quick command that hangs is killed at its timeout.
 */
export function isSshConnectionFailure(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: unknown } | null;
  return (
    failure?.code === 255 ||
    failure?.code === 'ETIMEDOUT' ||
    (failure?.killed === true && failure.code !== OUTPUT_LIMIT_CODE)
  );
}

/**
 * Whether a command was stopped at its timeout, which by itself can't tell a host that doesn't
 * answer from a slow command.
 */
export function isSshTimeout(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: unknown } | null;
  return failure?.killed === true && failure.code !== OUTPUT_LIMIT_CODE;
}

function connectionFailureMessage(error: unknown): string | undefined {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' ? stderr : '';
  const lastLine = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (lastLine) return lastLine.slice(0, MAX_MESSAGE_LENGTH);
  return (error as { killed?: unknown } | null)?.killed === true ? 'Timed out' : undefined;
}

/**
 * Whether each SSH host answered the last command Komla ran on it, for the status bar. Komla keeps
 * no connection open between commands, so this is what it last saw rather than a live state.
 */
class SshHostStatusService {
  private statuses = new Map<string, SshHostStatus>();
  private listeners = new Set<(statuses: SshHostStatus[]) => void>();

  onChange(listener: (statuses: SshHostStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SshHostStatus[] {
    return Array.from(this.statuses.values());
  }

  get(hostId: string): SshHostStatus | undefined {
    return this.statuses.get(hostId);
  }

  reached(hostId: string): void {
    this.set({ hostId, state: 'connected', checkedAt: Date.now() });
  }

  /**
   * A command on the host failed. Only ssh's own failures make the host unreachable; a remote
   * command that exited with an error shows ssh got there. Failures before ssh ran, such as
   * waiting too long for a free connection, say nothing about the host.
   */
  failed(hostId: string, error: unknown): void {
    if (!isSshConnectionFailure(error)) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'number' || code === OUTPUT_LIMIT_CODE) this.reached(hostId);
      return;
    }
    const message = connectionFailureMessage(error);
    this.set({
      hostId,
      state: 'unreachable',
      checkedAt: Date.now(),
      ...(message ? { message } : {}),
    });
  }

  private set(status: SshHostStatus): void {
    const previous = this.statuses.get(status.hostId);
    this.statuses.set(status.hostId, status);
    if (previous?.state === status.state && previous.message === status.message) return;
    const statuses = this.list();
    for (const listener of this.listeners) listener(statuses);
  }
}

export const sshHostStatusService = new SshHostStatusService();
