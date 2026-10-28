import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TURN_END_SETTLE_MS,
  watchAgentTurnEnd,
  type AgentTurnEvents,
} from '../../../src/main/services/komla-operation/agent-turn-end';

import type { WorkspaceAttention } from '../../../src/shared/types/workspace';

function createEvents() {
  const updateListeners = new Set<(workspaceId: string) => void>();
  const attentionListeners = new Set<(attention: WorkspaceAttention) => void>();
  let active = true;
  const events: AgentTurnEvents = {
    isTurnActive: () => active,
    onWorkspaceUpdated: (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    onAttentionRaised: (listener) => {
      attentionListeners.add(listener);
      return () => attentionListeners.delete(listener);
    },
  };
  return {
    events,
    setActive(value: boolean, workspaceId = 'workspace-1') {
      active = value;
      for (const listener of updateListeners) listener(workspaceId);
    },
    raise(kind: WorkspaceAttention['kind'], terminalId = 'terminal-1') {
      for (const listener of attentionListeners) {
        listener({ kind, source: 'claude-code', updatedAt: Date.now(), terminalId });
      }
    },
    listenerCount: () => updateListeners.size + attentionListeners.size,
  };
}

describe('watchAgentTurnEnd', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends as done when the terminal raises its done, and stops listening', () => {
    const turn = createEvents();
    const ended = vi.fn();
    watchAgentTurnEnd(turn.events, 'workspace-1', 'terminal-1', ended);

    turn.raise('turn-complete', 'terminal-2');
    expect(ended).not.toHaveBeenCalled();
    turn.setActive(false);
    turn.raise('turn-complete');
    vi.advanceTimersByTime(TURN_END_SETTLE_MS);

    expect(ended).toHaveBeenCalledExactlyOnceWith('done');
    expect(turn.listenerCount()).toBe(0);
  });

  it('ends as stopped when the spinner goes off without a done', () => {
    const turn = createEvents();
    const ended = vi.fn();
    watchAgentTurnEnd(turn.events, 'workspace-1', 'terminal-1', ended);

    turn.setActive(false);
    vi.advanceTimersByTime(TURN_END_SETTLE_MS - 1);
    expect(ended).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(ended).toHaveBeenCalledExactlyOnceWith('stopped');
  });

  it('keeps waiting when the turn goes on after its spinner went off', () => {
    const turn = createEvents();
    const ended = vi.fn();
    watchAgentTurnEnd(turn.events, 'workspace-1', 'terminal-1', ended);

    turn.setActive(false);
    turn.setActive(true);
    vi.advanceTimersByTime(TURN_END_SETTLE_MS * 2);
    expect(ended).not.toHaveBeenCalled();
    turn.raise('turn-complete');

    expect(ended).toHaveBeenCalledExactlyOnceWith('done');
  });

  it('ends as stopped when the turn fails, and ignores other workspaces', () => {
    const turn = createEvents();
    const ended = vi.fn();
    watchAgentTurnEnd(turn.events, 'workspace-1', 'terminal-1', ended);

    turn.setActive(false, 'workspace-2');
    vi.advanceTimersByTime(TURN_END_SETTLE_MS);
    expect(ended).not.toHaveBeenCalled();
    turn.raise('error');

    expect(ended).toHaveBeenCalledExactlyOnceWith('stopped');
  });

  it('calls nothing once stopped', () => {
    const turn = createEvents();
    const ended = vi.fn();
    const stop = watchAgentTurnEnd(turn.events, 'workspace-1', 'terminal-1', ended);

    turn.setActive(false);
    stop();
    vi.advanceTimersByTime(TURN_END_SETTLE_MS);

    expect(ended).not.toHaveBeenCalled();
    expect(turn.listenerCount()).toBe(0);
  });
});
