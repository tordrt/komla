import { TURN_END_SETTLE_MS } from './agent-turn-end';

import type { WorkspaceAttention } from '../../../shared/types/workspace';

/** How long an agent may stop working before its turn counts as ended without a done. */
export const TERMINAL_WAIT_SETTLE_MS = TURN_END_SETTLE_MS;

/**
 * What a terminal's agent is doing, as `komla terminals` shows it: `working`, waiting for the
 * user (`blocked`), ended its last turn `done` or with an `error`, `idle` otherwise, or `exited`
 * once its program ended.
 */
export type TerminalAgentState = 'working' | 'blocked' | 'error' | 'done' | 'idle' | 'exited';

export type TerminalWaitAttention = Pick<
  WorkspaceAttention,
  'kind' | 'updatedAt' | 'title' | 'body' | 'message'
>;

export interface TerminalWaitSnapshot {
  running: boolean;
  working: boolean;
  attention?: TerminalWaitAttention;
}

export function terminalAgentState(snapshot: TerminalWaitSnapshot): TerminalAgentState {
  if (!snapshot.running) return 'exited';
  if (snapshot.attention?.kind === 'input-required') return 'blocked';
  if (snapshot.working) return 'working';
  if (snapshot.attention?.kind === 'error') return 'error';
  if (snapshot.attention?.kind === 'turn-complete') return 'done';
  return 'idle';
}

/**
 * Why a wait returned. `done`, `error` and `idle` end a turn (idle: it stopped without saying
 * how); `blocked` waits for the user; `output` saw the text; `timeout` is a check-in, not a
 * failure; `not_started` means no turn began in time.
 */
export type TerminalWaitReason =
  | 'done'
  | 'error'
  | 'idle'
  | 'blocked'
  | 'exited'
  | 'output'
  | 'timeout'
  | 'not_started';

export interface TerminalWaitEvents {
  snapshot(): TerminalWaitSnapshot;
  /** The terminal's state may have changed. Returns a function that unsubscribes. */
  onChange(listener: () => void): () => void;
  /**
   * The terminal raised attention. A done raised while the user looks at the terminal is
   * dismissed at once, so the snapshot alone can miss it. Returns a function that unsubscribes.
   */
  onAttention(listener: (attention: TerminalWaitAttention) => void): () => void;
  /** A prompt was submitted in the terminal. Returns a function that unsubscribes. */
  onPromptSubmitted(listener: () => void): () => void;
  /** Returns a function that unsubscribes. */
  onOutput(listener: (data: string) => void): () => void;
  /** Returns a function that unsubscribes. */
  onExit(listener: () => void): () => void;
}

export interface TerminalWaitResult {
  reason: TerminalWaitReason;
  /** The done, error or question that ended the wait, as it was raised. */
  attention?: TerminalWaitAttention;
}

export interface TerminalWaitOptions {
  timeoutMs: number;
  /** Waits for this text to be printed after the wait starts, in place of the agent's turn. */
  output?: string;
  /**
   * How long to wait for a turn to start when none is under way, as after sending a prompt.
   * Without it, an agent that isn't working returns at once with its state.
   */
  startTimeoutMs?: number;
  /**
   * Waits for the turn of a message just sent, which starts at its prompt's submit or when the
   * agent starts working after it was idle. A question or done from before doesn't count, nor
   * does the end of a turn under way. Without a start within `startTimeoutMs` of the agent being
   * idle, the wait is `not_started`.
   */
  nextTurn?: boolean;
  /** With `nextTurn`: the message answers the agent's question, so the turn under way is its. */
  answering?: boolean;
  /** Ends the wait as `timeout` once aborted, as when its caller goes. */
  signal?: AbortSignal;
  now?: () => number;
}

// CSI, OSC (BEL or ST ended) and two-byte escapes, so text matches as the terminal shows it.
// oxlint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Waits for a terminal's agent to end its turn, need the user, or exit; or, with `output`, for
 * the terminal to print that text. Never longer than `timeoutMs`.
 */
export function waitForTerminal(
  events: TerminalWaitEvents,
  options: TerminalWaitOptions
): Promise<TerminalWaitResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  return new Promise((resolve) => {
    const cleanups: Array<() => void> = [];
    let settle: ReturnType<typeof setTimeout> | undefined;
    let startDeadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let turnStarted = false;
    const finish = (reason: TerminalWaitReason, attention?: TerminalWaitAttention) => {
      if (finished) return;
      finished = true;
      clearTimeout(settle);
      clearTimeout(startDeadline);
      for (const cleanup of cleanups) cleanup();
      resolve(attention ? { reason, attention } : { reason });
    };
    const timeout = setTimeout(() => finish('timeout'), options.timeoutMs);
    cleanups.push(() => clearTimeout(timeout));
    const { signal } = options;
    if (signal) {
      if (signal.aborted) return finish('timeout');
      const abort = () => finish('timeout');
      signal.addEventListener('abort', abort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', abort));
    }
    cleanups.push(events.onExit(() => finish('exited')));

    if (options.output !== undefined) {
      const wanted = options.output;
      // Keeps enough of the last output for the text to match across chunks.
      let carried = '';
      cleanups.push(
        events.onOutput((data) => {
          const seen = carried + data.replace(ESCAPES, '');
          if (seen.includes(wanted)) {
            finish('output');
            return;
          }
          carried = seen.slice(-Math.max(0, wanted.length - 1));
        })
      );
      if (!events.snapshot().running) finish('exited');
      return;
    }

    const nextTurn = options.nextTurn === true;
    const initial = events.snapshot();
    /**
     * With `nextTurn`, a turn was under way when the message went, which isn't the message's. Its
     * end doesn't count; the message's turn starts at its prompt's submit, or when the agent works
     * again after being idle a while, not after a moment's pause between tools.
     */
    const pastTurn = nextTurn && initial.working && options.answering !== true;
    /** Whether the turn waited for began: the one under way, or the message's for `nextTurn`. */
    let started = !nextTurn;
    /** Attention raised before this belongs to an earlier turn. */
    let floor = startedAt;
    /** When the agent last stopped working before the message's turn started. */
    let idleSince: number | undefined;
    const startTurn = () => {
      started = true;
      if (pastTurn) floor = now();
      clearTimeout(startDeadline);
      startDeadline = undefined;
    };
    /** A question raised since the wait began, or one still open for a plain wait. */
    const question = (attention: TerminalWaitAttention | undefined) =>
      attention?.kind === 'input-required' && (!nextTurn || attention.updatedAt >= startedAt);
    const endOf = (attention: TerminalWaitAttention | undefined): 'done' | 'error' | undefined => {
      // Without a turn under way, a done since the message is its turn's, however quick.
      if ((!started && pastTurn) || !attention || attention.updatedAt < floor) return undefined;
      if (attention.kind === 'turn-complete') return 'done';
      if (attention.kind === 'error') return 'error';
      return undefined;
    };
    const check = () => {
      const snapshot = events.snapshot();
      if (!snapshot.running) return finish('exited');
      if (question(snapshot.attention)) return finish('blocked', snapshot.attention);
      if (!started) {
        if (!snapshot.working) {
          idleSince ??= now();
          startDeadline ??= setTimeout(() => finish('not_started'), options.startTimeoutMs ?? 0);
        } else if (
          !pastTurn ||
          (idleSince !== undefined && now() - idleSince >= TERMINAL_WAIT_SETTLE_MS)
        ) {
          startTurn();
        } else {
          idleSince = undefined;
          return;
        }
      }
      if (snapshot.working) {
        turnStarted = true;
        clearTimeout(startDeadline);
        startDeadline = undefined;
        clearTimeout(settle);
        settle = undefined;
        return;
      }
      const end = endOf(snapshot.attention);
      if (end) return finish(end, snapshot.attention);
      if (!turnStarted) return;
      // The spinner went off; a done may still follow, as when it waits for a Stop hook.
      settle ??= setTimeout(() => finish('idle'), TERMINAL_WAIT_SETTLE_MS);
    };

    const state = terminalAgentState(initial);
    if (!nextTurn && state !== 'working' && state !== 'exited' && state !== 'blocked') {
      if (!options.startTimeoutMs) {
        if (state === 'done' || state === 'error') finish(state, initial.attention);
        else finish('idle');
        return;
      }
      startDeadline = setTimeout(() => finish('not_started'), options.startTimeoutMs);
    }
    cleanups.push(events.onChange(check));
    cleanups.push(
      events.onAttention((attention) => {
        if (question(attention)) return finish('blocked', attention);
        const end = endOf(attention);
        if (end) finish(end, attention);
      })
    );
    if (nextTurn) {
      cleanups.push(
        events.onPromptSubmitted(() => {
          if (started) return;
          startTurn();
          check();
        })
      );
    }
    check();
  });
}
