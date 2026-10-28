import { beforeEach, describe, expect, it } from 'vitest';

import { useWorktreeEventsStore } from '../../../src/renderer/stores/worktree-events.store';

function resetStore(): void {
  useWorktreeEventsStore.setState(useWorktreeEventsStore.getInitialState(), true);
}

describe('worktree-events.store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('records a worktree event timestamp for a workspace', () => {
    useWorktreeEventsStore.getState().recordEvent('ws-1', 123);

    expect(useWorktreeEventsStore.getState().lastEventByWorkspace['ws-1']).toBe(123);
  });

  it('clears recorded state for a workspace', () => {
    useWorktreeEventsStore.getState().recordEvent('ws-1', 123);
    useWorktreeEventsStore.getState().clearWorkspace('ws-1');

    expect(useWorktreeEventsStore.getState().lastEventByWorkspace['ws-1']).toBeUndefined();
  });
});
