import type {
  TerminalOscNotification,
  TerminalProgramStatus,
} from '../../shared/lib/terminal-escape';

export interface TerminalNotificationEvent extends TerminalOscNotification {
  terminalId: string;
}

type Listener = (event: TerminalNotificationEvent) => void;

const listeners = new Set<Listener>();
const titleListeners = new Set<(terminalId: string, title: string | null) => void>();
const programStatusListeners = new Set<
  (terminalId: string, status: TerminalProgramStatus) => void
>();

export function onTerminalTitle(
  listener: (terminalId: string, title: string | null) => void
): () => void {
  titleListeners.add(listener);
  return () => {
    titleListeners.delete(listener);
  };
}

/** null ends the PTY generation; late title timers must never affect its replacement. */
export function emitTerminalTitle(terminalId: string, title: string | null): void {
  for (const listener of titleListeners) listener(terminalId, title);
}

export function onTerminalProgramStatus(
  listener: (terminalId: string, status: TerminalProgramStatus) => void
): () => void {
  programStatusListeners.add(listener);
  return () => {
    programStatusListeners.delete(listener);
  };
}

export function emitTerminalProgramStatus(terminalId: string, status: TerminalProgramStatus): void {
  for (const listener of programStatusListeners) listener(terminalId, status);
}

export function onTerminalOscNotification(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitTerminalOscNotification(event: TerminalNotificationEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
