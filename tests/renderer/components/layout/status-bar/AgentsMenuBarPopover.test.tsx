/**
 * @vitest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentsMenuBarPopover } from '../../../../../src/renderer/components/layout/status-bar/AgentsMenuBarPopover';
import { createTerminal, createWorkspace } from '../../../../factories';

import type { AgentsMenuBarState, WorkspaceAttention } from '../../../../../src/shared/types';

const config = vi.hoisted(() => ({
  state: {
    config: {},
    loadConfig: vi.fn(() => Promise.resolve()),
    subscribeToChanges: vi.fn(() => () => {}),
  },
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: Object.assign(
    (selector: (state: typeof config.state) => unknown) => selector(config.state),
    { getState: () => config.state }
  ),
}));

function attention(kind: WorkspaceAttention['kind'], message?: string): WorkspaceAttention {
  return { kind, source: 'claude-code', updatedAt: Date.now() - 5 * 60_000, message };
}

let sendState: (state: AgentsMenuBarState) => void;
const api = {
  onAgentsMenuBarState: vi.fn((callback: (state: AgentsMenuBarState) => void) => {
    sendState = callback;
    return () => {};
  }),
  requestAgentsMenuBarState: vi.fn(),
  resizeAgentsMenuBar: vi.fn(),
  openFromAgentsMenuBar: vi.fn(),
  closeAgentsMenuBar: vi.fn(),
};

const waiting = createWorkspace({
  name: 'waiting',
  windowId: 'window-2',
  projectId: 'project-1',
  branchName: 'push-fix',
  terminals: [
    createTerminal({
      id: 'codex',
      status: 'running',
      name: 'Codex',
      attention: attention('input-required', 'Allow git push?'),
    }),
  ],
});
const busy = createWorkspace({
  name: 'busy',
  windowId: 'window-1',
  agentActive: true,
  terminals: [createTerminal({ status: 'running', agentActive: true, name: 'Claude Code' })],
});

function state(overrides: Partial<AgentsMenuBarState> = {}): AgentsMenuBarState {
  return {
    workspaces: [busy, waiting],
    projects: [{ id: 'project-1', name: 'komla' }],
    theme: { className: 'dark theme-frost', style: '--background: 0.2 0 0;' },
    ...overrides,
  };
}

describe('AgentsMenuBarPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, { api });
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("lists every window's agents in the status bar's popover, in Komla's theme", () => {
    render(<AgentsMenuBarPopover />);
    // Main may have sent them before the page listened.
    expect(api.requestAgentsMenuBarState).toHaveBeenCalledOnce();
    act(() => sendState(state()));

    expect(document.documentElement.className).toBe('dark theme-frost');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('0.2 0 0');
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Needs input:waiting5mkomla/push-fix',
      'Working:busy',
    ]);
    expect(api.resizeAgentsMenuBar).toHaveBeenCalled();
  });

  it('marks how long an agent has worked apart from how long ago one got to its state', () => {
    vi.useFakeTimers();
    try {
      const finished = createWorkspace({
        name: 'finished',
        terminals: [createTerminal({ status: 'running', attention: attention('turn-complete') })],
      });
      const working = createWorkspace({
        name: 'working',
        agentActive: true,
        terminals: [
          createTerminal({
            status: 'running',
            agentActive: true,
            agentActiveSince: Date.now() - 7 * 60_000,
          }),
        ],
      });
      render(<AgentsMenuBarPopover />);
      act(() => sendState(state({ workspaces: [working, finished] })));

      const [finishedRow, workingRow] = within(
        screen.getByRole('list', { name: 'Agents' })
      ).getAllByRole('button');
      // A stopwatch stands before the time an agent has worked.
      expect(within(finishedRow).getByText('5m').querySelector('svg')).toBeNull();
      expect(within(workingRow).getByText('7m').querySelector('svg')).not.toBeNull();

      // The times keep going while the popover is open.
      act(() => vi.advanceTimersByTime(60_000));
      expect(within(finishedRow).getByText('6m')).toBeInTheDocument();
      expect(within(workingRow).getByText('8m')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an agent's pane through main", async () => {
    const user = userEvent.setup();
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state()));

    await user.click(screen.getByRole('button', { name: /waiting/ }));
    expect(api.openFromAgentsMenuBar).toHaveBeenLastCalledWith(waiting.id, 'codex');

    await user.click(screen.getByRole('button', { name: /busy/ }));
    expect(api.openFromAgentsMenuBar).toHaveBeenLastCalledWith(busy.id, busy.terminals[0].id);
  });

  it("grows the window to the left for a hovered row's card, beside the panel", async () => {
    const user = userEvent.setup();
    // The panel spans 12–412 across and 12–112 down; the card hangs 330 left of it, to 300.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return (
        this.matches('[data-radix-popper-content-wrapper]')
          ? { left: -318, right: 2, top: 12, bottom: 300 }
          : { left: 12, right: 412, top: 12, bottom: 112 }
      ) as DOMRect;
    });
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state()));
    expect(api.resizeAgentsMenuBar).toHaveBeenLastCalledWith(400, 100);
    // Rows changing at the same size don't send it again.
    await act(async () => sendState(state({ workspaces: [waiting] })));
    expect(api.resizeAgentsMenuBar).toHaveBeenCalledOnce();

    await user.hover(screen.getByRole('button', { name: /waiting/ }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Allow git push?');
    expect(api.resizeAgentsMenuBar).toHaveBeenLastCalledWith(730, 288);
  });

  it('says so while no agent needs the user, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state({ workspaces: [] })));

    expect(screen.getByText('No agent needs you or is working.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(api.closeAgentsMenuBar).toHaveBeenCalled();
  });
});
