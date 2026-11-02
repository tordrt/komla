/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InlineSidebarPanel,
  SidebarPanelTabs,
} from '../../../../src/renderer/components/terminal/InlineSidebarPanel';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { useSidebarPanelsStore } from '../../../../src/renderer/stores/sidebar-panels.store';

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

function renderTabs() {
  return render(
    <TooltipProvider>
      <SidebarPanelTabs workspaceId="ws-1" tabClass={tabClass} />
    </TooltipProvider>
  );
}

describe('SidebarPanelTabs', () => {
  beforeEach(() => {
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useSidebarPanelsStore.setState(useSidebarPanelsStore.getInitialState(), true);
  });

  it('shows nothing while the workspace has no panels', async () => {
    const api = mockApi({ list: { panels: [] } });
    const { container } = renderTabs();
    await waitFor(() => expect(api.listSidebarPanels).toHaveBeenCalledWith('ws-1'));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a panel in place of the tree from its tab, until the tree is chosen again', async () => {
    const user = userEvent.setup();
    mockApi();
    renderTabs();

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

  it('keeps one tab for many panels, with a menu to pick another', async () => {
    const user = userEvent.setup();
    mockApi({ list: { panels: [ci, usage] } });
    renderTabs();

    await screen.findByRole('button', { name: 'CI' });
    expect(screen.queryByRole('button', { name: 'Usage' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sidebar panels' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Usage' }));

    expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace['ws-1']).toEqual({
      id: 'usage',
      shown: true,
    });
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveClass('active-tab');
  });

  it('falls back to the first panel once the one picked is gone', async () => {
    mockApi({ list: { panels: [usage] } });
    useFileViewerStore.setState({ inlineSidebarPanelByWorkspace: { 'ws-1': { id: 'ci', shown: true } } });
    renderTabs();

    expect(await screen.findByRole('button', { name: 'Usage' })).toHaveClass('tab');
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
