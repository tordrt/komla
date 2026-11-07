/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  setAgentsMenuBarPassThrough: vi.fn(),
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
      // What the agent asked, under its workspace's place.
      'Needs input:waiting5mkomla/push-fixAllow git push?',
      'Working:busy',
    ]);
    expect(api.resizeAgentsMenuBar).toHaveBeenCalled();
  });

  it('tells what an agent did or does by its title, or else by its reply or prompt', async () => {
    const user = userEvent.setup();
    // Its title names the row, so under it, what it replied.
    const finished = createWorkspace({
      name: 'finished',
      terminals: [
        createTerminal({
          status: 'running',
          attention: attention('turn-complete', 'Yes. On main the card just disappeared.'),
        }),
      ],
    });
    // Its custom name hides the title the agent set, which says what it did.
    const titledDone = createWorkspace({
      name: 'titled-done',
      customName: 'Hiding polish',
      terminals: [
        createTerminal({
          status: 'running',
          dynamicTitle: 'Graceful hiding',
          attention: attention('turn-complete', 'It fades now.'),
        }),
      ],
    });
    // Its custom name hides the title the agent set while working, which says what it's on now.
    const titled = createWorkspace({
      name: 'titled',
      customName: 'Hiding transition',
      agentActive: true,
      promptSubmits: [{ prompt: 'make hiding graceful', submittedAt: Date.now() }],
      terminals: [
        createTerminal({ status: 'running', agentActive: true, dynamicTitle: '✳ Fading cards' }),
      ],
    });
    // Its title already names the row, so under it, what it was asked.
    const untitled = createWorkspace({
      name: 'untitled',
      agentActive: true,
      promptSubmits: [{ prompt: 'fix the flaky test', submittedAt: Date.now() }],
      terminals: [
        createTerminal({ status: 'running', agentActive: true, dynamicTitle: 'Flaky test' }),
      ],
    });
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state({ workspaces: [finished, titledDone, titled, untitled] })));

    expect(screen.getByRole('button', { name: /finished/ })).toHaveTextContent(
      /^Done:finished5mYes\. On main the card just disappeared\.$/
    );
    expect(screen.getByRole('button', { name: /Hiding polish/ })).toHaveTextContent(
      /^Done:Hiding polish5mGraceful hiding$/
    );
    expect(screen.getByRole('button', { name: /Hiding transition/ })).toHaveTextContent(
      /^Working:Hiding transitionFading cards$/
    );
    expect(screen.getByRole('button', { name: /Flaky test/ })).toHaveTextContent(
      /^Working:Flaky testfix the flaky test$/
    );

    // Its reply is a hover away.
    await user.hover(screen.getByRole('button', { name: /Hiding polish/ }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('It fades now.');
  });

  it("doesn't take a title that tells nothing new for what an agent did", () => {
    // The title it starts with is just its name.
    const generic = createWorkspace({
      name: 'generic',
      customName: 'Generic title',
      terminals: [
        createTerminal({
          status: 'running',
          name: 'Claude Code',
          dynamicTitle: '✳ Claude Code',
          attention: attention('turn-complete', 'Renamed the store.'),
        }),
      ],
    });
    // Its title is the row's name but for the spinner glyph.
    const glyphed = createWorkspace({
      name: 'glyphed',
      customName: 'Fading cards',
      agentActive: true,
      promptSubmits: [{ prompt: 'fade the cards', submittedAt: Date.now() }],
      terminals: [
        createTerminal({ status: 'running', agentActive: true, dynamicTitle: '✳ Fading cards' }),
      ],
    });
    // Its title is the row's name but for case and the glyph.
    const recased = createWorkspace({
      name: 'recased',
      customName: 'fading tabs ',
      terminals: [
        createTerminal({
          status: 'running',
          dynamicTitle: '✳ Fading tabs',
          attention: attention('turn-complete', 'Tabs fade too.'),
        }),
      ],
    });
    // The heading its notification gave says more than its terminal's title.
    const headed = createWorkspace({
      name: 'headed',
      customName: 'Headed',
      terminals: [
        createTerminal({
          status: 'running',
          dynamicTitle: 'Open the PR',
          attention: { ...attention('turn-complete', 'Opened #42.'), title: 'PR opened' },
        }),
      ],
    });
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state({ workspaces: [generic, glyphed, recased, headed] })));

    expect(screen.getByRole('button', { name: /Generic title/ })).toHaveTextContent(
      /^Done:Generic title5mRenamed the store\.$/
    );
    expect(screen.getByRole('button', { name: /Fading cards/ })).toHaveTextContent(
      /^Working:Fading cardsfade the cards$/
    );
    expect(screen.getByRole('button', { name: /fading tabs/ })).toHaveTextContent(
      /Tabs fade too\.$/
    );
    expect(screen.getByRole('button', { name: /Headed/ })).toHaveTextContent(
      /^Done:Headed5mPR opened$/
    );
  });

  it("names the agent in its card only where the card's title doesn't already", async () => {
    const user = userEvent.setup();
    const named = createWorkspace({
      name: 'named',
      customName: 'Hiding transition',
      terminals: [
        createTerminal({
          status: 'running',
          dynamicTitle: 'Graceful hiding',
          attention: attention('turn-complete', 'It fades now.'),
        }),
      ],
    });
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state({ workspaces: [named] })));

    await user.hover(screen.getByRole('button', { name: /Hiding transition/ }));
    const card = await screen.findByRole('tooltip');
    // Under the custom name, the agent's title; not again beside its state.
    expect(within(card).getAllByText('Graceful hiding')).toHaveLength(1);
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

      // Leaving out the Done group's Clear done.
      const [finishedRow, workingRow] = within(screen.getByRole('list', { name: 'Agents' }))
        .getAllByRole('button')
        .filter((button) => button.textContent !== 'Clear done');
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

  it('offers Clear done while a done agent sits in a workspace that needs the user', () => {
    const mixed = createWorkspace({
      name: 'mixed',
      terminals: [
        createTerminal({ id: 'asks', status: 'running', attention: attention('input-required') }),
        createTerminal({ id: 'done', status: 'running', attention: attention('turn-complete') }),
      ],
    });
    render(<AgentsMenuBarPopover />);
    act(() => sendState(state({ workspaces: [mixed, busy] })));

    // No Done group heads the finished agent, so the button sits under the list and counts it.
    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear 1 done' })).toBeInTheDocument();
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

  it('lets clicks through beside the panel, where the window keeps room for a card', async () => {
    const user = userEvent.setup();
    // The panel spans 340–740 across and 12–112 down; a row's card, 12–332 and 12–300.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return (
        this.matches('[data-radix-popper-content-wrapper]')
          ? { left: 12, right: 332, top: 12, bottom: 300 }
          : { left: 340, right: 740, top: 12, bottom: 112 }
      ) as DOMRect;
    });
    const moveTo = (clientX: number, clientY: number, buttons = 0) =>
      // On whatever an open menu, turning off the page's pointer events, leaves the move to.
      document.documentElement.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX, clientY, buttons })
      );
    const { unmount } = render(<AgentsMenuBarPopover />);
    act(() => sendState(state()));
    // It takes clicks on the panel, as main opens it.
    moveTo(500, 50);
    expect(api.setAgentsMenuBarPassThrough).not.toHaveBeenCalled();

    // Hovering moves the pointer about.
    await user.hover(screen.getByRole('button', { name: /waiting/ }));
    await screen.findByRole('tooltip');
    moveTo(500, 50);
    api.setAgentsMenuBarPassThrough.mockClear();
    // And on the card.
    moveTo(100, 250);
    // Nor lets go of a drag, as a selection in the card, that leaves it, until it's let go there.
    moveTo(500, 250, 1);
    expect(api.setAgentsMenuBarPassThrough).not.toHaveBeenCalled();
    document.documentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // Under the panel, beside the card, a click reaches what's under the window.
    expect(api.setAgentsMenuBarPassThrough.mock.calls).toEqual([[true]]);
    moveTo(510, 260);
    expect(api.setAgentsMenuBarPassThrough.mock.calls).toEqual([[true]]);
    moveTo(100, 250);
    expect(api.setAgentsMenuBarPassThrough.mock.calls).toEqual([[true], [false]]);

    // The card closing under a pointer at rest leaves room a click goes through.
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(api.setAgentsMenuBarPassThrough.mock.calls).toEqual([[true], [false], [true]])
    );

    // A page that goes leaves the window taking clicks.
    unmount();
    expect(api.setAgentsMenuBarPassThrough).toHaveBeenLastCalledWith(false);
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
