import { shellQuotePosix } from './shell-quote';

import type { SshHost } from '../types/ssh';

/** tmux server socket (`tmux -L`) that holds Managed Remote Terminal Sessions. */
export const MANAGED_TMUX_SOCKET_NAME = 'komla-v1';

/**
 * Inputs Komla's search bar sends to step through tmux's search in a Managed Remote
 * Terminal Session, whose history Komla's terminal never receives. Komla's tmux server
 * maps them to user keys; no keyboard sends them.
 */
export const MANAGED_TMUX_FIND_INPUTS = {
  older: '\x1b[29172~',
  newer: '\x1b[29173~',
  close: '\x1b[29174~',
} as const;

/** A search in a managed session's tmux history; null where the host's tmux can't tell. */
export interface ManagedTmuxFindResult {
  found: boolean | null;
  count: number | null;
  /** A full-screen program has the pane, so the only text is on screen and nothing was searched. */
  alternateScreen: boolean;
}

/**
 * Whether the host's tmux maps those inputs, as `tmux -V` reports it. Before 2.6 it has no
 * user-keys, so they would reach the program as text.
 */
export function managedTmuxSearchSupported(version: string | undefined): boolean {
  const match = version?.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 6);
}

/** tmux session that runs a terminal's Managed Remote Terminal Session. */
export function managedTmuxSessionName(terminalId: string): string {
  return `komla-${terminalId}`;
}

const SHELL_SAFE_WORD = /^[\w@%+:,./~-][\w@%+=:,./~-]*$/;

function shellWord(value: string): string {
  return SHELL_SAFE_WORD.test(value) ? value : shellQuotePosix(value);
}

/**
 * Command a user can run in their own terminal to join a terminal's managed
 * tmux session alongside Komla. It skips `attach-session -d` so Komla's own
 * client stays attached, and the exact-match `=` prefix because zsh expands a
 * leading `=` as a command path; tmux still prefers the exact session name.
 */
export function buildManagedTmuxAttachCommand(
  host: Pick<SshHost, 'hostname' | 'user' | 'port' | 'identityFile' | 'extraSshArgs'>,
  terminalId: string
): string {
  const args = ['ssh', '-t'];
  if (host.port) args.push('-p', String(host.port));
  if (host.identityFile) args.push('-i', host.identityFile);
  if (host.extraSshArgs) args.push(...host.extraSshArgs);
  args.push(host.user ? `${host.user}@${host.hostname}` : host.hostname);
  args.push(
    'tmux',
    '-L',
    MANAGED_TMUX_SOCKET_NAME,
    'attach-session',
    '-t',
    managedTmuxSessionName(terminalId)
  );
  return args.map(shellWord).join(' ');
}
