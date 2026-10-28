import type { WorkspaceAttention } from '../../../shared/types/workspace';

/** How long a turn's done may follow its spinner going off, as when it waits for a Stop hook. */
export const TURN_END_SETTLE_MS = 3000;

/** `done` when the agent finished its turn; `stopped` when it failed, was interrupted, or quit. */
export type AgentTurnEnd = 'done' | 'stopped';

export interface AgentTurnEvents {
  isTurnActive(terminalId: string): boolean;
  /** Returns a function that unsubscribes. */
  onWorkspaceUpdated(listener: (workspaceId: string) => void): () => void;
  /** Returns a function that unsubscribes. */
  onAttentionRaised(listener: (attention: WorkspaceAttention) => void): () => void;
}

/**
 * Calls `ended` once the agent's turn in the terminal ends. A done the terminal raises ends it
 * as `done`. Its spinner going off without one, or an error, ends it as `stopped`.
 * Returns a function that stops watching.
 */
export function watchAgentTurnEnd(
  events: AgentTurnEvents,
  workspaceId: string,
  terminalId: string,
  ended: (end: AgentTurnEnd) => void
): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  let watching = true;
  const end = (how: AgentTurnEnd) => {
    if (!watching) return;
    stop();
    ended(how);
  };
  const stopAttention = events.onAttentionRaised((attention) => {
    if (attention.terminalId !== terminalId) return;
    if (attention.kind === 'turn-complete') end('done');
    else if (attention.kind === 'error') end('stopped');
  });
  const stopUpdates = events.onWorkspaceUpdated((id) => {
    if (id !== workspaceId) return;
    if (events.isTurnActive(terminalId)) {
      // The turn went on, as when Claude resumes it for background work.
      clearTimeout(settle);
      settle = undefined;
      return;
    }
    settle ??= setTimeout(() => end('stopped'), TURN_END_SETTLE_MS);
  });
  function stop(): void {
    watching = false;
    clearTimeout(settle);
    stopAttention();
    stopUpdates();
  }
  return stop;
}
