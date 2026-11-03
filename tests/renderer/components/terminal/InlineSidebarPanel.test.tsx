/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { addPanelWithAgent } = vi.hoisted(() => ({ addPanelWithAgent: vi.fn() }));
vi.mock('../../../../src/renderer/lib/customize-agent', () => ({ addPanelWithAgent }));

import {
  InlineSidebarPanel,
  SidebarTabs,
  SidebarTabsMenu,
} from '../../../../src/renderer/components/terminal/InlineSidebarPanel';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useSidebarPanelsStore } from '../../../../src/renderer/stores/sidebar-panels.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { AppConfig } from '../../../../src/renderer/types';
import type { KomlaEvent } from '../../../../src/shared/types/komla-events';
import type { Project } from '../../../../src/shared/types/project';
import type { Workspace } from '../../../../src/shared/types/workspace';
import type {
  SidebarPanel,
  SidebarPanelList,
  SidebarPanelResult,
} from '../../../../src/shared/types/sidebar-panels';

const ci: SidebarPanel = { id: 'ci', title: 'CI', intervalSeconds: 60 };
const usage: SidebarPanel = { id: 'usage', title: 'Usage', intervalSeconds: 300, plugin: 'Usage' };

function mockApi({
  list = { panels: [ci] },
  result = { id: 'ci', workspaceId: 'ws-1', content: { markdown: '**All pass**', buttons: [] } },
}: { list?: SidebarPanelList; result?: SidebarPanelResult } = {}) {
  const api = {
    listSidebarPanels: vi.fn(async () => list),
    onSidebarPanelsChange: vi.fn(() => () => {}),
    listSidebarPanelStates: vi.fn(async () => []),
    onSidebarPanelStateChange: vi.fn(() => () => {}),
    onKomlaEvent: vi.fn(() => () => {}),
    runSidebarPanel: vi.fn(async () => result),
    runSidebarPanelButton: vi.fn(async () => ({})),
    openExternal: vi.fn(async () => {}),
    // Choosing Diff or Files saves the tree's mode with the workspace.
    updateWorkspace: vi.fn(async () => {}),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function renderPanel(panel: SidebarPanel) {
  return render(
    <TooltipProvider>
      <InlineSidebarPanel workspaceId="ws-1" panel={panel} />
    </TooltipProvider>
  );
}

const tabClass = (active: boolean) => (active ? 'active-tab' : 'tab');

function renderTabs({ isGitWorkspace = true }: { isGitWorkspace?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <SidebarTabsMenu workspaceId="ws-1" isGitWorkspace={isGitWorkspace}>
        <div data-testid="tab-row">
          <SidebarTabs workspaceId="ws-1" isGitWorkspace={isGitWorkspace} tabClass={tabClass} />
        </div>
      </SidebarTabsMenu>
    </TooltipProvider>
  );
}

/** The tab row's buttons, by name, without the menu's. */
function tabNames() {
  return [...screen.getByTestId('tab-row').querySelectorAll('[data-sidebar-tab]')].map(
    (tab) => tab.textContent
  );
}

const updateConfig = vi.fn(async (updates: Partial<AppConfig>) => {
  useConfigStore.setState((state) => ({ config: { ...state.config, ...updates } as AppConfig }));
  return { ok: true, error: null };
});

describe('SidebarTabs', () => {
  beforeEach(() => {
    addPanelWithAgent.mockClear();
    updateConfig.mockClear();
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useSidebarPanelsStore.setState(useSidebarPanelsStore.getInitialState(), true);
    useConfigStore.setState({ config: {} as AppConfig, updateConfig });
    useWorkspacesStore.setState({
      workspaces: [{ id: 'ws-1', projectId: 'p-1' } as Workspace],
      selectedWorkspaceId: 'ws-1',
    });
    useProjectsStore.setState({ projects: [{ id: 'p-1', name: 'Komla' } as Project] });
  });

  it('shows the badge a page or plugin code set on its tab', async () => {
    mockApi();
    useSidebarPanelsStore.setState({
      states: {
        'ws-1\0ci': { workspaceId: 'ws-1', id: 'ci', badge: { text: '3', tone: 'warning' } },
      },
    });
    renderTabs({ isGitWorkspace: false });
    const tab = await screen.findByRole('button', { name: /CI/ });
    expect(tab).toHaveTextContent('CI3');
    expect(tab.querySelector('[data-sidebar-panel-badge="ci"]')).toHaveClass('text-warning');

    act(() => useSidebarPanelsStore.setState({ states: {} }));
    expect(tab).toHaveTextContent(/^CI$/);
  });

  it('shows Diff and Files, with no menu, while the workspace has no panels', async () => {
    const api = mockApi({ list: { panels: [] } });
    renderTabs();
    await waitFor(() => expect(api.listSidebarPanels).toHaveBeenCalledWith('ws-1'));
    expect(tabNames()).toEqual(['Diff', 'Files']);
    expect(screen.queryByRole('button', { name: 'More sidebar tabs' })).not.toBeInTheDocument();
  });

  it('shows a panel beside Files in a workspace without git', async () => {
    mockApi({ list: { panels: [ci, usage] } });
    renderTabs({ isGitWorkspace: false });
    await screen.findByRole('button', { name: 'CI' });
    expect(tabNames()).toEqual(['Files', 'CI']);
  });

  it('shows a panel in place of the tree from its tab, until the tree is chosen again', async () => {
    const user = userEvent.setup();
    mockApi();
    renderTabs({ isGitWorkspace: false });

    const tab = await screen.findByRole('button', { name: 'CI' });
    expect(tab).toHaveClass('tab');
    await user.click(tab);

    expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace['ws-1']).toEqual({
      id: 'ci',
      shown: true,
    });
    expect(tab).toHaveClass('active-tab');

    // Choosing Diff or Files, or anything that shows the tree, hides the panel, which the tab keeps.
    act(() => useFileViewerStore.getState().setInlineFileTreeMode('ws-1', 'browse'));
    expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace['ws-1']).toEqual({
      id: 'ci',
      shown: false,
    });
    expect(screen.getByRole('button', { name: 'CI' })).toHaveClass('tab');
    expect(screen.getByRole('button', { name: 'Files' })).toHaveClass('active-tab');
  });

  it("keeps the panel when the tree's mode changes without the user, as on restore or live follow", async () => {
    mockApi();
    useFileViewerStore.setState({
      inlineSidebarPanelByWorkspace: { 'ws-1': { id: 'ci', shown: true } },
    });

    useFileViewerStore.getState().setInlineFileTreeMode('ws-1', 'diff', { keepSidebarPanel: true });

    expect(useFileViewerStore.getState().inlineFileTreeByWorkspace['ws-1']?.mode).toBe('diff');
    expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace['ws-1']).toEqual({
      id: 'ci',
      shown: true,
    });
  });

  it("keeps two tabs, and a picked one takes the place of the one that isn't showing, for the project", async () => {
    const user = userEvent.setup();
    mockApi({ list: { panels: [ci, usage] } });
    renderTabs();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'More sidebar tabs' })).toBeVisible()
    );
    expect(tabNames()).toEqual(['Diff', 'Files']);
    await user.click(screen.getByRole('button', { name: 'More sidebar tabs' }));
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Diff',
      'Files',
      'CI',
      'Usage',
    ]);
    await user.click(screen.getByRole('menuitemradio', { name: 'CI' }));

    // Diff was showing, so CI takes Files' place.
    expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace['ws-1']).toEqual({
      id: 'ci',
      shown: true,
    });
    expect(tabNames()).toEqual(['Diff', 'CI']);
    expect(screen.getByRole('button', { name: 'CI' })).toHaveClass('active-tab');
    expect(updateConfig).toHaveBeenCalledWith({
      projectSidebarTabs: { 'p-1': ['diff', 'panel:ci'] },
    });
  });

  it('shows a panel opened from elsewhere, as by a status item, in place of the last tab', async () => {
    mockApi({ list: { panels: [ci, usage] } });
    useConfigStore.setState({
      config: { projectSidebarTabs: { 'p-1': ['diff', 'panel:ci'] } } as AppConfig,
    });
    renderTabs();
    await screen.findByRole('button', { name: 'CI' });
    expect(tabNames()).toEqual(['Diff', 'CI']);

    act(() => useFileViewerStore.getState().showInlineSidebarPanel('ws-1', 'usage'));
    expect(tabNames()).toEqual(['Diff', 'Usage']);
    expect(updateConfig).not.toHaveBeenCalled();

    act(() => useFileViewerStore.getState().setInlineFileTreeMode('ws-1', 'diff'));
    expect(tabNames()).toEqual(['Diff', 'CI']);
  });

  /** Right-clicks a tab and picks a view from its Replace submenu, opened from the keyboard. */
  async function replaceTab(user: ReturnType<typeof userEvent.setup>, tab: string, view: string) {
    fireEvent.contextMenu(screen.getByRole('button', { name: tab }));
    const replace = await screen.findByRole('menuitem', { name: `Replace ${tab} with` });
    act(() => replace.focus());
    await user.keyboard('{ArrowRight}');
    fireEvent.click(await screen.findByRole('menuitem', { name: view }));
  }

  it('puts another view in place of a right-clicked tab, showing it if that tab was', async () => {
    const user = userEvent.setup();
    mockApi({ list: { panels: [ci, usage] } });
    renderTabs();
    await screen.findByRole('button', { name: 'More sidebar tabs' });

    // Files isn't showing: Usage takes its place, and Diff stays showing.
    await replaceTab(user, 'Files', 'Usage');
    expect(updateConfig).toHaveBeenLastCalledWith({
      projectSidebarTabs: { 'p-1': ['diff', 'panel:usage'] },
    });
    await waitFor(() => expect(tabNames()).toEqual(['Diff', 'Usage']));
    expect(screen.getByRole('button', { name: 'Diff' })).toHaveClass('active-tab');

    // Diff is showing: CI takes its place and shows.
    await replaceTab(user, 'Diff', 'CI');
    await waitFor(() => expect(tabNames()).toEqual(['CI', 'Usage']));
    expect(screen.getByRole('button', { name: 'CI' })).toHaveClass('active-tab');
    expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace['ws-1']).toEqual({
      id: 'ci',
      shown: true,
    });
  });

  it('offers no view to replace a tab with when the row shows every one', async () => {
    mockApi({ list: { panels: [] } });
    renderTabs();

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Diff' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Add a panel with your agent…' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Replace/ })).not.toBeInTheDocument();
  });

  it('offers to add a panel with an agent from a right-click on the tabs, with no panel yet', async () => {
    const user = userEvent.setup();
    mockApi({ list: { panels: [] } });
    renderTabs();

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Files' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add a panel with your agent…' }));
    expect(addPanelWithAgent).toHaveBeenCalledOnce();
  });

  it('offers to add a panel with an agent at the end of the menu with the other tabs', async () => {
    const user = userEvent.setup();
    mockApi({ list: { panels: [ci, usage] } });
    renderTabs();

    await user.click(await screen.findByRole('button', { name: 'More sidebar tabs' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add a panel with your agent…' }));
    expect(addPanelWithAgent).toHaveBeenCalledOnce();
  });

  it("hides a panel in the workspace's project from its tab, and shows it there again", async () => {
    const user = userEvent.setup();
    mockApi({ list: { panels: [ci] } });
    renderTabs({ isGitWorkspace: false });

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'CI' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide CI in Komla' }));
    expect(updateConfig).toHaveBeenCalledWith({ projectHiddenItems: { 'p-1': ['panel:ci'] } });
    await waitFor(() => expect(tabNames()).toEqual(['Files']));

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Files' }));
    expect(screen.queryByRole('menuitem', { name: /^Hide/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Show CI in Komla' }));
    expect(updateConfig).toHaveBeenLastCalledWith({ projectHiddenItems: {} });
    await waitFor(() => expect(tabNames()).toEqual(['Files', 'CI']));
  });

  it('falls back to the first panel once the one picked is gone', async () => {
    mockApi({ list: { panels: [usage] } });
    useFileViewerStore.setState({
      inlineSidebarPanelByWorkspace: { 'ws-1': { id: 'ci', shown: true } },
    });
    renderTabs({ isGitWorkspace: false });

    expect(await screen.findByRole('button', { name: 'Usage' })).toHaveClass('tab');
    expect(screen.getByRole('button', { name: 'Files' })).toHaveClass('active-tab');
  });

  it("says what's wrong with a sidebar-panels.json Komla can't read", async () => {
    mockApi({ list: { panels: [], problem: 'sidebar-panels.json is not valid JSON' } });
    renderTabs();

    expect(
      await screen.findByRole('img', { name: 'sidebar-panels.json is not valid JSON' })
    ).toBeInTheDocument();
  });
});

describe('InlineSidebarPanel', () => {
  beforeEach(() => {
    useSidebarPanelsStore.setState(useSidebarPanelsStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the panel's command in the window's theme as it opens and shows its Markdown", async () => {
    const api = mockApi();
    renderPanel(ci);

    expect(await screen.findByText('All pass')).toBeInTheDocument();
    expect(api.runSidebarPanel).toHaveBeenCalledWith(
      'ws-1',
      'ci',
      expect.objectContaining({ scheme: expect.any(String) })
    );
  });

  it('fills the panel with an HTML page in the sandbox', async () => {
    mockApi({
      result: {
        id: 'ci',
        workspaceId: 'ws-1',
        content: { markdown: '', htmlUrl: 'komla-preview://t/popover.html', buttons: [] },
      },
    });
    renderPanel(ci);

    const frame = await screen.findByTitle('CI');
    expect(frame).toHaveAttribute('src', 'komla-preview://t/popover.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame).toHaveStyle({ height: '100%' });
  });

  it("runs a button's command, then the panel again", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      result: {
        id: 'ci',
        workspaceId: 'ws-1',
        content: { markdown: 'Failing', buttons: [{ label: 'Rerun', run: 'rerun' }] },
      },
    });
    renderPanel(ci);

    const button = await screen.findByRole('button', { name: 'Rerun' });
    expect(button).toHaveAttribute('title', 'Runs “rerun” from sidebar-panels.json');
    await user.click(button);

    expect(api.runSidebarPanelButton).toHaveBeenCalledWith('ws-1', 'ci', 'rerun');
    await waitFor(() => expect(api.runSidebarPanel).toHaveBeenCalledTimes(2));
  });

  it('keeps what the panel showed when a run fails, with the error', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    renderPanel(ci);
    await screen.findByText('All pass');

    api.runSidebarPanel.mockResolvedValueOnce({
      id: 'ci',
      workspaceId: 'ws-1',
      content: null,
      error: 'timed out after 30 seconds',
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByText("The panel's command failed: timed out after 30 seconds")
    ).toBeInTheDocument();
    expect(screen.getByText('All pass')).toBeInTheDocument();
  });

  it('runs again on its interval while the window can be seen, and not while it is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi();
    renderPanel({ ...ci, intervalSeconds: 10 });
    await screen.findByText('All pass');
    expect(api.runSidebarPanel).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(api.runSidebarPanel).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.runSidebarPanel).toHaveBeenCalledTimes(2);

    // Showing the window again catches up on the run it missed.
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(api.runSidebarPanel).toHaveBeenCalledTimes(3);
  });

  it('shows the last page at once when it opens again, while it runs', async () => {
    const api = mockApi();
    const { unmount } = renderPanel(ci);
    await screen.findByText('All pass');
    unmount();

    api.runSidebarPanel.mockReturnValue(new Promise(() => {}));
    renderPanel(ci);
    expect(screen.getByText('All pass')).toBeInTheDocument();
  });
});

describe('A panel with a page of its own', () => {
  const board: SidebarPanel = {
    id: 'board',
    title: 'Board',
    intervalSeconds: 60,
    page: true,
    command: true,
  };

  let eventListeners: ((event: KomlaEvent) => void)[] = [];
  const publish = (event: KomlaEvent) =>
    act(() => {
      for (const listener of eventListeners) listener(event);
    });

  function mockPageApi() {
    eventListeners = [];
    const api = {
      ...mockApi(),
      getSidebarPanelPage: vi.fn(async () => ({ url: 'komla-preview://t/index.html' })),
      runSidebarPanelData: vi.fn(async () => ({ data: { count: 1 } })),
      runSidebarPanelOperation: vi.fn(async () => ({ ok: true as const, result: { tags: [] } })),
      sendSidebarPanelMessage: vi.fn(async () => ({ ok: true as const, result: 'started' })),
      setSidebarPanelBadge: vi.fn(async () => {}),
      onKomlaEvent: vi.fn((listener: (event: KomlaEvent) => void) => {
        eventListeners.push(listener);
        return () => {
          eventListeners = eventListeners.filter((each) => each !== listener);
        };
      }),
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    return api;
  }

  async function renderPage() {
    renderPanel(board);
    const frame = (await screen.findByTitle('Board')) as HTMLIFrameElement;
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>);
    });
    const fromPage = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
      });
    return { frame, posted, fromPage };
  }

  beforeEach(() => {
    useSidebarPanelsStore.setState(useSidebarPanelsStore.getInitialState(), true);
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads its page in the sandbox and brings it the theme and its data', async () => {
    const api = mockPageApi();
    const { frame, posted, fromPage } = await renderPage();

    expect(frame).toHaveAttribute('src', 'komla-preview://t/index.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(api.getSidebarPanelPage).toHaveBeenCalledWith(
      'ws-1',
      'board',
      expect.objectContaining({ scheme: 'light' })
    );
    await waitFor(() => expect(api.runSidebarPanelData).toHaveBeenCalledWith('ws-1', 'board'));

    // The page says hello once it loads, and gets what it missed.
    await fromPage({ komlaPanel: 'hello', token: 'secret' });
    expect(posted).toContainEqual({ komlaPanel: 'theme', theme: expect.any(Object) });
    expect(posted).toContainEqual({ komlaPanel: 'data', data: { count: 1 } });
  });

  it("passes the page's operations on, saying whether they came from a click", async () => {
    const api = mockPageApi();
    const { posted, fromPage } = await renderPage();
    await fromPage({ komlaPanel: 'hello', token: 'secret' });

    await fromPage({ komlaPanel: 'call', id: 1, request: { type: 'tag.list' } });
    await fromPage({
      komlaPanel: 'call',
      id: 2,
      request: { type: 'agent.launch' },
      workspace: 'ws-2',
      token: 'secret',
    });
    // A second hello can't change the token.
    await fromPage({ komlaPanel: 'hello', token: 'forged' });
    await fromPage({ komlaPanel: 'call', id: 3, request: { type: 'tag.list' }, token: 'forged' });

    expect(api.runSidebarPanelOperation.mock.calls).toEqual([
      ['ws-1', 'board', { type: 'tag.list' }, { activated: false }],
      ['ws-1', 'board', { type: 'agent.launch' }, { activated: true, workspace: 'ws-2' }],
      ['ws-1', 'board', { type: 'tag.list' }, { activated: false }],
    ]);
    await waitFor(() =>
      expect(posted).toContainEqual({ komlaPanel: 'reply', id: 1, ok: true, result: { tags: [] } })
    );
  });

  it('runs a command the panel names only from a click, then its data again', async () => {
    const api = mockPageApi();
    const { posted, fromPage } = await renderPage();
    await waitFor(() => expect(api.runSidebarPanelData).toHaveBeenCalledTimes(1));
    await fromPage({ komlaPanel: 'hello', token: 'secret' });

    await fromPage({ komlaPanel: 'run', id: 1, name: 'bump' });
    await waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({ komlaPanel: 'reply', id: 1, ok: false })
      )
    );
    expect(api.runSidebarPanelButton).not.toHaveBeenCalled();

    await fromPage({ komlaPanel: 'run', id: 2, name: 'bump', token: 'secret' });
    await waitFor(() => expect(posted).toContainEqual({ komlaPanel: 'reply', id: 2, ok: true }));
    expect(api.runSidebarPanelButton).toHaveBeenCalledWith('ws-1', 'board', 'bump');
    await waitFor(() => expect(api.runSidebarPanelData).toHaveBeenCalledTimes(2));
  });

  it("ignores messages that don't come from its page", async () => {
    const api = mockPageApi();
    await renderPage();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { komlaPanel: 'call', id: 1, request: { type: 'tag.list' } },
          source: window,
        })
      );
    });
    expect(api.runSidebarPanelOperation).not.toHaveBeenCalled();
  });

  it('tells the page when the theme changes, without loading it again', async () => {
    const api = mockPageApi();
    const { posted } = await renderPage();

    document.documentElement.classList.add('dark');
    await waitFor(() =>
      expect(posted).toContainEqual({
        komlaPanel: 'theme',
        theme: expect.objectContaining({ scheme: 'dark' }),
      })
    );
    expect(api.getSidebarPanelPage).toHaveBeenCalledTimes(1);
  });

  it("sets its tab's badge and sends its plugin's code messages, saying whether from a click", async () => {
    const api = mockPageApi();
    const { posted, fromPage } = await renderPage();
    await fromPage({ komlaPanel: 'hello', token: 'secret' });

    await fromPage({ komlaPanel: 'badge', id: 1, badge: { text: 3, tone: 'warning' } });
    await fromPage({ komlaPanel: 'badge', id: 2, badge: { html: '<b>' } });
    await fromPage({ komlaPanel: 'send', id: 3, message: { want: 'review' }, token: 'secret' });
    await fromPage({ komlaPanel: 'send', id: 4, message: 'hi' });

    expect(api.setSidebarPanelBadge).toHaveBeenCalledTimes(1);
    expect(api.setSidebarPanelBadge).toHaveBeenCalledWith('ws-1', 'board', {
      text: 3,
      tone: 'warning',
    });
    expect(api.sendSidebarPanelMessage.mock.calls).toEqual([
      ['ws-1', 'board', { want: 'review' }, { activated: true }],
      ['ws-1', 'board', 'hi', { activated: false }],
    ]);
    await waitFor(() =>
      expect(posted).toContainEqual({ komlaPanel: 'reply', id: 3, ok: true, result: 'started' })
    );
    expect(posted).toContainEqual(
      expect.objectContaining({ komlaPanel: 'reply', id: 2, ok: false })
    );
  });

  it("brings the page its workspace's events, and what its plugin's code posts", async () => {
    mockPageApi();
    const { posted, fromPage } = await renderPage();
    await fromPage({ komlaPanel: 'hello', token: 'secret' });

    await publish({ type: 'agent.done', workspaceId: 'ws-1', agent: 'codex' });
    await publish({ type: 'agent.done', workspaceId: 'ws-2' });
    expect(posted.filter((message) => message.komlaPanel === 'event')).toEqual([
      { komlaPanel: 'event', event: { type: 'agent.done', workspaceId: 'ws-1', agent: 'codex' } },
    ]);

    act(() => {
      useSidebarPanelsStore.setState({
        states: { '\0board': { workspaceId: '', id: 'board', data: { data: { prs: [7] } } } },
      });
    });
    await waitFor(() => expect(posted).toContainEqual({ komlaPanel: 'data', data: { prs: [7] } }));
  });

  it('runs its command again when an event it refreshes on settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = mockPageApi();
      renderPanel({ ...board, refreshOn: ['branch.changed'] });
      await waitFor(() => expect(api.runSidebarPanelData).toHaveBeenCalledTimes(1));

      await publish({ type: 'branch.changed', workspaceId: 'ws-2' });
      await publish({ type: 'agent.done', workspaceId: 'ws-1' });
      await publish({ type: 'branch.changed', workspaceId: 'ws-1' });
      await publish({ type: 'branch.changed', workspaceId: 'ws-1' });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      await waitFor(() => expect(api.runSidebarPanelData).toHaveBeenCalledTimes(2));
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(api.runSidebarPanelData).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why its page can't load", async () => {
    const api = mockPageApi();
    api.getSidebarPanelPage.mockResolvedValue({
      error: "panels/board isn't in the settings folder",
    } as never);
    renderPanel(board);

    expect(
      await screen.findByText(
        "The panel's page can't load: panels/board isn't in the settings folder"
      )
    ).toBeInTheDocument();
  });
});

describe('A panel that prints text for a terminal', () => {
  beforeEach(() => {
    useSidebarPanelsStore.setState(useSidebarPanelsStore.getInitialState(), true);
  });

  it('shows its lines in their colors, as text', async () => {
    mockApi({
      result: {
        id: 'ci',
        workspaceId: 'ws-1',
        content: {
          markdown: '',
          terminal: [[{ text: '✓', color: 'success' }, { text: ' <b>unit</b>' }], []],
          buttons: [],
        },
      },
    });
    renderPanel(ci);

    const check = await screen.findByText('✓');
    expect(check).toHaveClass('text-success');
    expect(screen.getByText('<b>unit</b>', { exact: false })).toBeInTheDocument();
  });
});
