import { isLongRunningCommand } from './background-command';

/** Reconcile hook events before they change terminal activity or emit attention. */
export interface LifecycleNotification {
  kind?: string;
  source?: string;
  hookInput?: Record<string, unknown>;
}

type Decision =
  | 'accept'
  | 'subagent'
  | 'background'
  | 'stale'
  | 'superseded'
  | 'closed'
  | 'duplicate';
interface Identity {
  session?: string;
  turn?: string;
}
interface ScopeState {
  identity: Identity;
  inferredComplete?: boolean;
  /** A prompt started a turn that has not ended yet. */
  running?: boolean;
  /** The turn ended with a Stop, so its idle reminder adds nothing. */
  stopped?: boolean;
  /** Stop listed background work that resumes the turn; completes the turn if it never does. */
  held?: ReturnType<typeof setTimeout>;
  /** A completion settling before it shows. */
  pending?: Settling;
  /** Permission requests waiting for an automatic reply, by request id. */
  requests: Map<string, Settling>;
  /** Replies that arrived before their request, oldest first. */
  answered: string[];
}
interface Settling {
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: Decision) => void;
}

export const COMPLETION_SETTLE_MS = 750;
/** Long enough for an automatic approval, such as OpenCode's auto mode, to answer first. */
export const INPUT_REQUIRED_SETTLE_MS = 500;
/** Enough for the replies that can overtake their requests on the way to Komla. */
const ANSWERED_LIMIT = 16;
/** A misjudged background command, such as a server, must not hold its turn forever. */
export const BACKGROUND_HOLD_LIMIT_MS = 30 * 60_000;

/** Claude runs /compact and /exit as commands with their own prompt ids, outside any turn. */
const SESSION_EVENTS = new Set(['PostCompact', 'SessionEnd']);

function isSessionEvent(payload: LifecycleNotification): boolean {
  return SESSION_EVENTS.has(String(payload.hookInput?.hook_event_name));
}

export function hookIdentity(payload: LifecycleNotification): Identity {
  const input = payload.hookInput;
  const session = stringField(input?.session_id);
  if (isSessionEvent(payload)) return { session };
  return {
    session,
    turn: stringField(input?.turn_id) ?? stringField(input?.prompt_id),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isFailedTurn(payload: LifecycleNotification): boolean {
  return payload.kind === 'error' && payload.hookInput?.hook_event_name === 'StopFailure';
}

function identityConflicts(current: Identity, incoming: Identity): boolean {
  return (['session', 'turn'] as const).some(
    (field) =>
      current[field] !== undefined &&
      incoming[field] !== undefined &&
      current[field] !== incoming[field]
  );
}

export function isSubagentLifecycle(payload: LifecycleNotification): boolean {
  const input = payload.hookInput;
  return (
    input?.hook_event_name === 'SubagentStop' ||
    (!!stringField(input?.agent_id) &&
      (payload.kind === 'turn-complete' ||
        payload.kind === 'idle' ||
        payload.kind === 'activity' ||
        payload.kind === 'prompt-submit' ||
        payload.kind === 'error' ||
        payload.kind === 'interrupted'))
  );
}

/** OpenCode names a permission request, and the reply to it, with the request's id. */
function requestId(payload: LifecycleNotification): string | undefined {
  return stringField(payload.hookInput?.permissionID);
}

/**
 * Whether a hook settles before it shows, so its sender needn't wait for the outcome. Only a
 * request with an id settles, since nothing answers other prompts automatically.
 */
export function settlesBeforeShowing(payload: LifecycleNotification): boolean {
  if (!payload.hookInput?.hook_event_name) return false;
  if (payload.kind === 'input-required') return requestId(payload) !== undefined;
  return payload.kind === 'turn-complete' || payload.kind === 'idle';
}

function finish(settling: Settling, decision: Decision): void {
  clearTimeout(settling.timer);
  settling.resolve(decision);
}

function holdsTurn(task: Record<string, unknown>): boolean {
  if (task.status !== 'running') return false;
  if (task.type === 'subagent') return true;
  return (
    task.type === 'shell' && typeof task.command === 'string' && !isLongRunningCommand(task.command)
  );
}

/**
 * Claude lists background work on Stop and resumes the turn when a task finishes. A shell
 * holds unless its command looks like a server or watcher, which would hold until the limit.
 */
export function waitsForBackgroundWork(payload: LifecycleNotification): boolean {
  const tasks = payload.hookInput?.background_tasks;
  return (
    Array.isArray(tasks) &&
    tasks.some(
      (task) =>
        typeof task === 'object' && task !== null && holdsTurn(task as Record<string, unknown>)
    )
  );
}

export class NotificationLifecycle {
  private scopes = new Map<string, Map<string, ScopeState>>();

  async accept(
    scope: string,
    payload: LifecycleNotification,
    onCompletionSettling?: () => void,
    onHoldExpired?: () => void
  ): Promise<Decision> {
    if (isSubagentLifecycle(payload)) return 'subagent';
    const activity = payload.kind === 'activity' || payload.kind === 'prompt-submit';
    const completion = payload.kind === 'turn-complete' || payload.kind === 'idle';
    const interrupted = payload.kind === 'interrupted';
    if (
      !activity &&
      !completion &&
      !interrupted &&
      payload.kind !== 'input-required' &&
      payload.kind !== 'error'
    ) {
      return 'accept';
    }
    let sources = this.scopes.get(scope);
    if (!sources) {
      sources = new Map();
      this.scopes.set(scope, sources);
    }
    const source = payload.source ?? 'generic';
    let state = sources.get(source);
    const identity = hookIdentity(payload);
    if (!state) {
      state = { identity, requests: new Map(), answered: [] };
      sources.set(source, state);
    } else if (payload.kind === 'prompt-submit') {
      // A new user prompt establishes the current root session and turn.
      state.identity = identity;
    } else if (identityConflicts(state.identity, identity)) {
      return 'stale';
    } else {
      state.identity = {
        session: identity.session ?? state.identity.session,
        turn: identity.turn ?? state.identity.turn,
      };
    }
    if (interrupted) {
      // Nothing resumes an interrupted turn, so a Stop held for its background work stays quiet.
      this.release(state);
      state.running = false;
      // Nor does the agent still wait for answers to its requests.
      this.cancelRequests(state, 'superseded');
      return 'accept';
    }
    const turnEnd = this.recordTurnEnd(state, payload, onHoldExpired);
    if (turnEnd) return turnEnd;
    // Legacy/manual notifications retain their immediate behavior. Hooks carry
    // their event name even when the agent supplies no JSON metadata.
    if (!payload.hookInput?.hook_event_name) return 'accept';
    if (payload.kind === 'input-required') {
      const id = requestId(payload);
      if (!id) return 'accept';
      if (state.answered.includes(id)) return 'superseded';
      return this.settleRequest(state, id);
    }
    if (!completion) return 'accept';
    if (state.inferredComplete) return 'duplicate';
    onCompletionSettling?.();
    return new Promise((resolve) => {
      state.pending = {
        resolve,
        timer: setTimeout(() => {
          state.pending = undefined;
          resolve('accept');
        }, COMPLETION_SETTLE_MS),
      };
    });
  }

  private settleRequest(state: ScopeState, id: string): Promise<Decision> {
    const previous = state.requests.get(id);
    if (previous) finish(previous, 'duplicate');
    return new Promise((resolve) => {
      state.requests.set(id, {
        resolve,
        timer: setTimeout(() => {
          state.requests.delete(id);
          resolve('accept');
        }, INPUT_REQUIRED_SETTLE_MS),
      });
    });
  }

  private recordTurnEnd(
    state: ScopeState,
    payload: LifecycleNotification,
    onHoldExpired?: () => void
  ): Decision | undefined {
    // Checked before cancelling, so the reminder cannot drop a Stop or request still settling.
    if (payload.kind === 'idle' && (state.stopped || state.requests.size > 0)) {
      return 'duplicate';
    }
    // A command outside any turn, such as a manual /compact, lists no background work, so it
    // cannot end a turn held for it. Nor one still running, as /code-review's turn does until
    // its background review hands back.
    if (
      (state.held || state.running) &&
      payload.kind === 'turn-complete' &&
      isSessionEvent(payload)
    ) {
      return 'background';
    }
    this.supersede(state, payload);
    if (payload.kind === 'idle') return undefined;
    this.release(state);
    if (payload.kind === 'prompt-submit') state.running = true;
    else if (payload.kind === 'turn-complete' || isFailedTurn(payload)) state.running = false;
    if (payload.kind !== 'turn-complete') {
      state.inferredComplete = false;
      state.stopped = false;
      return undefined;
    }
    state.stopped = true;
    if (!waitsForBackgroundWork(payload)) return undefined;
    state.held = setTimeout(() => {
      state.held = undefined;
      onHoldExpired?.();
    }, BACKGROUND_HOLD_LIMIT_MS);
    return 'background';
  }

  recordInferredCompletion(scope: string, source: string): void {
    const state = this.scopes.get(scope)?.get(source);
    if (state) {
      state.inferredComplete = true;
      state.stopped = true;
    }
  }

  /** An interrupt the title confirmed ends the turn, though no hook reports it. */
  recordInterrupt(scope: string): void {
    this.scopes.get(scope)?.forEach((state) => {
      state.running = false;
    });
  }

  /** A reply answers its request even when the rest of what it reports is late news. */
  recordReply(scope: string, payload: LifecycleNotification): void {
    const state = this.scopes.get(scope)?.get(payload.source ?? 'generic');
    if (state) this.answer(state, payload);
  }

  close(scope: string): void {
    this.scopes.get(scope)?.forEach((state) => {
      this.cancel(state, 'closed');
      this.cancelRequests(state, 'closed');
      this.release(state);
    });
    this.scopes.delete(scope);
  }

  prune(liveScopes: Set<string>): void {
    this.scopes.forEach((_sources, scope) => {
      if (liveScopes.has(scope)) return;
      this.close(scope);
    });
  }

  clear(): void {
    this.prune(new Set());
  }

  private release(state: ScopeState): void {
    clearTimeout(state.held);
    state.held = undefined;
  }

  /**
   * A later hook supersedes a settling completion. A request waits for its reply or for the
   * turn to move on: other tool activity may be a parallel tool call, and other requests
   * wait on their own.
   */
  private supersede(state: ScopeState, payload: LifecycleNotification): void {
    this.cancel(state, 'superseded');
    if (payload.kind === 'activity') this.answer(state, payload);
    else if (payload.kind !== 'input-required') this.cancelRequests(state, 'superseded');
  }

  /** Activity naming a request is its reply, which may overtake the request itself. */
  private answer(state: ScopeState, payload: LifecycleNotification): void {
    const id = requestId(payload);
    if (!id) return;
    const request = state.requests.get(id);
    if (request) {
      state.requests.delete(id);
      finish(request, 'superseded');
      return;
    }
    state.answered.push(id);
    if (state.answered.length > ANSWERED_LIMIT) state.answered.shift();
  }

  private cancel(state: ScopeState, decision: Decision): void {
    if (!state.pending) return;
    finish(state.pending, decision);
    state.pending = undefined;
  }

  private cancelRequests(state: ScopeState, decision: Decision): void {
    state.requests.forEach((request) => finish(request, decision));
    state.requests.clear();
  }
}
