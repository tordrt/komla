import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flashWaitingAgents } from '../../../src/renderer/components/workspaces/agent-state';
import {
  flashPanes,
  PANE_FLASH_MS,
  usePaneFlashStore,
} from '../../../src/renderer/stores/pane-flash.store';
import { createTerminal, createWorkspace } from '../../factories';

describe('pane flash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePaneFlashStore.setState({ flash: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flashes the panes until the flash has run, so a pane mounted later does not replay it', () => {
    flashPanes(['t1']);
    expect([...(usePaneFlashStore.getState().flash?.terminalIds ?? [])]).toEqual(['t1']);

    vi.advanceTimersByTime(PANE_FLASH_MS);

    expect(usePaneFlashStore.getState().flash).toBeNull();
  });

  it('keeps a newer flash when an earlier one ends', () => {
    flashPanes(['t1']);
    vi.advanceTimersByTime(PANE_FLASH_MS - 100);
    flashPanes(['t2']);
    vi.advanceTimersByTime(100);

    expect([...(usePaneFlashStore.getState().flash?.terminalIds ?? [])]).toEqual(['t2']);
  });

  it('does nothing without a pane to flash', () => {
    flashPanes([]);

    expect(usePaneFlashStore.getState().flash).toBeNull();
  });

  it("flashes a workspace's agents that wait on the user, not the working ones", () => {
    const at = Date.now();
    flashWaitingAgents(
      createWorkspace({
        terminals: [
          createTerminal({
            id: 'input',
            agentActive: true,
            attention: { kind: 'input-required', source: 'claude-code', updatedAt: at },
          }),
          createTerminal({
            id: 'done',
            attention: { kind: 'turn-complete', source: 'codex', updatedAt: at },
          }),
          createTerminal({ id: 'working', agentActive: true }),
          createTerminal({ id: 'quiet' }),
        ],
      })
    );

    expect([...(usePaneFlashStore.getState().flash?.terminalIds ?? [])]).toEqual(['input', 'done']);
  });
});
