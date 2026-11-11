/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelOpenAfterHighlight,
  highlightThenOpen,
  openWorkspaceFromCard,
  revealTerminal,
} from '../../../src/renderer/lib/open-workspace';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createWorkspace } from '../../factories';

const flash = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/pane-flash.store', () => ({ flashPanes: flash }));

const initialLayout = useLayoutStore.getState();

/** The workspace's tabs as a window gets them: the agent's pane in the second. */
function tabsArrive(): void {
  useLayoutStore.setState({
    tabsByWorkspace: { ws: ['shell', 'agent'] },
    layoutsByTab: {
      ws: {
        shell: { type: 'leaf', id: 'pane-shell', terminalId: 'term-shell' },
        agent: { type: 'leaf', id: 'pane-agent', terminalId: 'term-agent' },
      },
    },
    activeTabByWorkspace: { ws: 'shell' },
    focusedPaneByTab: {},
  });
}

describe('revealTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    flash.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    useLayoutStore.setState(initialLayout, true);
  });

  it("shows the agent's pane once a workspace that just moved here gets its tabs", () => {
    revealTerminal('ws', 'term-agent');
    expect(flash).not.toHaveBeenCalled();

    tabsArrive();

    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('agent');
    expect(useLayoutStore.getState().focusedPaneByTab.ws).toEqual({ agent: 'pane-agent' });
    expect(flash).toHaveBeenCalledExactlyOnceWith(['term-agent']);

    // Tabs set up again a moment later show it again, without another flash.
    tabsArrive();
    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('agent');
    expect(flash).toHaveBeenCalledOnce();

    // After a while, tabs coming in are the user's own.
    vi.advanceTimersByTime(2_000);
    tabsArrive();
    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('shell');
  });

  it('leaves the tabs to the user once the pane showed at once', () => {
    tabsArrive();
    revealTerminal('ws', 'term-agent');
    expect(flash).toHaveBeenCalledOnce();

    tabsArrive();

    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('shell');
  });
});

describe('openWorkspaceFromCard', () => {
  const initialWorkspaces = useWorkspacesStore.getState();
  const selectWorkspace = vi.fn(async (workspaceId: string | null) => {
    useWorkspacesStore.setState({ selectedWorkspaceId: workspaceId, highlightedWorkspaceId: null });
  });
  const here = (id: string) => createWorkspace({ id, status: 'active', windowId: 'window-1' });

  beforeEach(() => {
    vi.useFakeTimers();
    selectWorkspace.mockClear();
    useWorkspacesStore.setState({
      selectWorkspace,
      selectedWorkspaceId: 'open',
      workspaces: ['open', 'first', 'second', 'other'].map(here),
    });
  });

  afterEach(() => {
    cancelOpenAfterHighlight();
    vi.useRealTimers();
    useWorkspacesStore.setState(initialWorkspaces, true);
  });

  it('shows the card selected at once, and opens the workspace once that has painted', () => {
    openWorkspaceFromCard(here('first'), 'window-1');

    expect(useWorkspacesStore.getState().highlightedWorkspaceId).toBe('first');
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('open');
    expect(selectWorkspace).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('first');
  });

  it('opens it at once in a hidden window, which paints nothing to wait for', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    openWorkspaceFromCard(here('first'), 'window-1');
    visibility.mockRestore();

    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('first');
    vi.runAllTimers();
    expect(selectWorkspace).toHaveBeenCalledOnce();
  });

  it('opens only the last of two cards clicked before either has painted', () => {
    openWorkspaceFromCard(here('first'), 'window-1');
    openWorkspaceFromCard(here('second'), 'window-1');
    vi.runAllTimers();

    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('second');
  });

  it('still opens the clicked one when something else opened a workspace before it painted', async () => {
    openWorkspaceFromCard(here('first'), 'window-1');
    await useWorkspacesStore.getState().selectWorkspace('other');
    selectWorkspace.mockClear();
    vi.runAllTimers();

    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('first');
  });

  it('replaces a next/previous step still waiting to open', () => {
    const step = vi.fn();
    highlightThenOpen('second', step);
    openWorkspaceFromCard(here('first'), 'window-1');
    vi.runAllTimers();

    expect(step).not.toHaveBeenCalled();
    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('first');
  });

  it('opens it as it is by then, restoring one moved to the Trash meanwhile', async () => {
    const setWorkspaceTrashed = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({ setWorkspaceTrashed });

    openWorkspaceFromCard(here('first'), 'window-1');
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'first', status: 'trashed', windowId: 'window-1' })],
    });
    await vi.runAllTimersAsync();

    expect(setWorkspaceTrashed).toHaveBeenCalledWith('first', false);
  });

  it("opens one shown in another window without this window's card showing selected", async () => {
    const focusWorkspaceWindow = vi.fn().mockResolvedValue(true);
    Object.assign(window, { api: { focusWorkspaceWindow } });

    openWorkspaceFromCard(
      createWorkspace({ id: 'elsewhere', status: 'active', windowId: 'window-2' }),
      'window-1'
    );
    await vi.runAllTimersAsync();

    expect(focusWorkspaceWindow).toHaveBeenCalledWith('elsewhere', undefined);
    expect(useWorkspacesStore.getState().highlightedWorkspaceId).toBeNull();
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('drops the highlight a step left when a card in another window is clicked', async () => {
    Object.assign(window, { api: { focusWorkspaceWindow: vi.fn().mockResolvedValue(true) } });
    const step = vi.fn();

    highlightThenOpen('second', step);
    openWorkspaceFromCard(
      createWorkspace({ id: 'elsewhere', status: 'active', windowId: 'window-2' }),
      'window-1'
    );
    await vi.runAllTimersAsync();

    expect(step).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().highlightedWorkspaceId).toBeNull();
  });

  it('drops its highlight when the workspace is gone, or opens in another window, by then', async () => {
    Object.assign(window, { api: { focusWorkspaceWindow: vi.fn().mockResolvedValue(true) } });

    openWorkspaceFromCard(here('first'), 'window-1');
    useWorkspacesStore.setState({ workspaces: [] });
    await vi.runAllTimersAsync();
    expect(useWorkspacesStore.getState().highlightedWorkspaceId).toBeNull();

    openWorkspaceFromCard(here('second'), 'window-1');
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'second', status: 'active', windowId: 'window-2' })],
    });
    await vi.runAllTimersAsync();
    expect(useWorkspacesStore.getState().highlightedWorkspaceId).toBeNull();
    expect(selectWorkspace).not.toHaveBeenCalled();
  });
});
