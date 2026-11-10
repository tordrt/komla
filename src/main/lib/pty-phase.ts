import type { TerminalStatus } from '../../shared/types';

/**
 * PTY Phase: where one PTY is in its life, from spawn until node-pty reports its program's exit.
 *
 * A PTY's terminal keeps its identity across Terminal replacement, so a terminal can have one
 * current PTY and older ones still exiting. Each phase carries the timers and pending work that
 * exist only in it. The service moves a PTY between phases only through `nextPtyPhase`, and its
 * one writer ends what the phase it leaves was running.
 */

/** What ends a PTY's startup: its first output, or the remote launcher's ready marker. */
export type PtyStartupMode = 'echo-command' | 'wait-for-marker';

/** A startup command still to be typed in once the shell's output settles. */
export interface PendingCommand {
  text: string;
  timer: NodeJS.Timeout | null;
  attempts: number;
}

/** What a live program may still be held for. Both can outlast startup. */
export interface LiveHolds {
  /** Runs while the program is held stopped until its terminal has a size. */
  sizeWait: NodeJS.Timeout | null;
  command: PendingCommand | null;
}

export type PtyPhase =
  /** Reported as starting until a readiness signal its startup mode takes, or the fallback timer. */
  | { kind: 'starting'; startupTimer: NodeJS.Timeout | null; holds: LiveHolds }
  | { kind: 'running'; holds: LiveHolds }
  /**
   * Komla is quitting and has killed it. It's still its terminal's PTY and reports as before, and
   * a readiness signal still counts, until it exits.
   */
  | { kind: 'shutting-down'; reported: 'starting' | 'running'; exitWaiters: Set<() => void> }
  /** Killed, and its terminal has let go of it: nothing it does is reported again. */
  | { kind: 'exiting'; exitWaiters: Set<() => void> }
  /** node-pty reported its exit, or, once its terminal let go of it, Komla gave up waiting. */
  | { kind: 'exited' };

export type PtyReadySignal = 'output' | 'startup-timeout' | 'remote-ready';

export type PtyEvent =
  | { kind: 'ready'; signal: PtyReadySignal }
  /** killAll(): killed, but kept as its terminal's PTY until it exits. */
  | { kind: 'shutdown' }
  /** kill() or a Terminal replacement: killed, and its terminal lets go of it at once. */
  | { kind: 'kill' }
  /** node-pty reported the program's exit. */
  | { kind: 'exit' }
  /**
   * Every wait for its exit gave up, even after SIGKILL. A PTY its terminal let go of is then
   * treated as gone; one still its terminal's stays so until node-pty reports the exit.
   */
  | { kind: 'abandon' };

/** The status its terminal reports while this is its PTY. */
export function reportedStatus(phase: PtyPhase): TerminalStatus {
  switch (phase.kind) {
    case 'starting':
    case 'running':
      return phase.kind;
    case 'shutting-down':
      return phase.reported;
    case 'exiting':
    case 'exited':
      return 'stopped';
  }
}

/** Still its terminal's PTY: what it prints is the terminal's output, and its exit the terminal's. */
export function isCurrent(phase: PtyPhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'running' || phase.kind === 'shutting-down';
}

/** Its program may still be held stopped or have a command to type in; null once it's killed. */
export function liveHolds(phase: PtyPhase): LiveHolds | null {
  return phase.kind === 'starting' || phase.kind === 'running' ? phase.holds : null;
}

/** Who waits for its exit; null before it's killed and after it exits. */
export function exitWaiters(phase: PtyPhase): Set<() => void> | null {
  return phase.kind === 'shutting-down' || phase.kind === 'exiting' ? phase.exitWaiters : null;
}

/** A local shell is ready at its first output; a remote one only at the launcher's marker. */
function signalsReady(mode: PtyStartupMode, signal: PtyReadySignal): boolean {
  return signal === 'remote-ready' ? mode === 'wait-for-marker' : mode === 'echo-command';
}

/** The phase an event moves a PTY to, or null when the event changes nothing. */
export function nextPtyPhase(
  phase: PtyPhase,
  event: PtyEvent,
  startupMode: PtyStartupMode
): PtyPhase | null {
  switch (event.kind) {
    case 'ready':
      if (!signalsReady(startupMode, event.signal)) return null;
      if (phase.kind === 'starting') return { kind: 'running', holds: phase.holds };
      if (phase.kind === 'shutting-down' && phase.reported === 'starting') {
        return { ...phase, reported: 'running' };
      }
      return null;
    case 'shutdown':
      if (phase.kind !== 'starting' && phase.kind !== 'running') return null;
      return { kind: 'shutting-down', reported: phase.kind, exitWaiters: new Set() };
    case 'kill':
      if (!isCurrent(phase)) return null;
      return { kind: 'exiting', exitWaiters: exitWaiters(phase) ?? new Set() };
    case 'exit':
      return phase.kind === 'exited' ? null : { kind: 'exited' };
    case 'abandon':
      return phase.kind === 'exiting' ? { kind: 'exited' } : null;
  }
}
