/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updatePaneBrowserTabs } from '../../../src/renderer/lib/browser-tabs';
import { findPaneByTerminalId, getAllLeaves } from '../../../src/renderer/lib/layout-utils';
import {
  adoptPaneSurfaces,
  closePagesOfRemovedPaneBrowserTabs,
  closePaneBrowserTab,
  closePaneSurface,
  closingPanesStopsWorkspace,
  confirmStoppingWorkspace,
  followMovedFilePanes,
  forgetSurfacesOfRemovedPanes,
  getFilePaneDraft,
  getPaneSurfaceTitle,
  getUnsavedFileNames,
  getUnsavedFilePanePaths,
  handOffWorkspacePaneSurfaces,
  hasUnsavedFilePane,
  isPaneSurfaceClosed,
  isPaneSurfaceLayoutLocked,
  openBrowserPane,
  openFilePane,
  openInBrowserPane,
  openPaneSurface,
  registerPaneCloseConfirm,
  replacePaneSurface,
  reportUnsavedFiles,
  reportWorkspacesShowingPaneSurfaces,
  requestClosePaneSurface,
  restoreSavedBrowserPanes,
  saveBrowserPanes,
  setFilePaneDraft,
  splitAgentBesidePane,
  takeFilePaneOpening,
} from '../../../src/renderer/lib/pane-surfaces';
import { useAgentPresetsStore } from '../../../src/renderer/stores/agent-presets.store';
import { useFileViewerStore } from '../../../src/renderer/stores/file-viewer.store';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useNotesStore } from '../../../src/renderer/stores/notes.store';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';
import { useTerminalCloseStore } from '../../../src/renderer/stores/terminal-close.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { addBrowserTab } from '../../../src/shared/lib/browser-tabs';
import { isPaneSurfaceId } from '../../../src/shared/lib/pane-surface-id';
import { createTerminal, createWorkspace } from '../../factories';

import type { PaneSurface } from '../../../src/renderer/stores/pane-surfaces.store';

const WS = 'ws-1';

function leafIds(tabId: string): string[] {
  const root = useLayoutStore.getState().layoutsByTab[WS]?.[tabId];
  return root ? getAllLeaves(root).map((leaf) => leaf.terminalId) : [];
}

function browserTabIds(surfaceId: string): string[] {
  const surface = usePaneSurfacesStore.getState().surfaces[surfaceId];
  return surface?.kind === 'browser' ? surface.browserTabs.map((tab) => tab.id) : [];
}

const BLANK_BROWSER: PaneSurface = {
  kind: 'browser',
  workspaceId: WS,
  browserTabs: [],
  activeBrowserTabId: undefined,
};

let stopForgetting: () => void;
let stopClosingPages: () => void;
const closeDevPreview = vi.fn();

beforeEach(() => {
  closeDevPreview.mockClear();
  Object.assign(window, { api: { closeDevPreview } });
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  usePaneSurfacesStore.setState({ surfaces: {} });
  useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
  useLayoutStore.getState().setCurrentWorkspace(WS, 'term-1');
  stopForgetting = forgetSurfacesOfRemovedPanes();
  stopClosingPages = closePagesOfRemovedPaneBrowserTabs();
});

afterEach(() => {
  stopForgetting();
  stopClosingPages();
});

describe('openPaneSurface', () => {
  it('splits beside the focused pane and focuses the new pane', () => {
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );

    expect(isPaneSurfaceId(id)).toBe(true);
    expect(leafIds('term-1')).toEqual(['term-1', id]);
    const layout = useLayoutStore.getState();
    expect(layout.getFocusedPaneId()).toBe(
      findPaneByTerminalId(layout.layoutsByTab[WS]['term-1'], id)?.id
    );
  });

  it('opens a tab of its own and switches to it', () => {
    const id = openPaneSurface(WS, BLANK_BROWSER, { kind: 'tab' });

    expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual(['term-1', id]);
    expect(useLayoutStore.getState().getActiveTabId()).toBe(id);
  });

  describe('beside the file panel in Full layout', () => {
    function showFilePanel(layout: 'full' | 'side-by-side', isDirty = false) {
      useFileViewerStore.setState({
        inlineFilePreviewByWorkspace: {
          [WS]: { open: true, mode: 'browse', filePath: 'a.ts', layout, isDirty },
        },
      });
    }

    beforeEach(() => {
      useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    });

    // As the panel's Unsaved Changes prompt answers: both clear the prompt, Discard then closes.
    function answerUnsavedPrompt(answer: 'discard' | 'cancel') {
      const fileViewer = useFileViewerStore.getState();
      fileViewer.clearAllInlineFilePreviewPendingDiscardSlots(WS);
      if (answer === 'discard') fileViewer.closeInlineFilePreview(WS);
      return Promise.resolve();
    }

    it('closes the file panel, which would cover the new pane', () => {
      showFilePanel('full');

      openPaneSurface(WS, BLANK_BROWSER, { kind: 'tab' });

      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace[WS]?.open).toBe(false);
    });

    it('asks before closing a file panel with unsaved edits', async () => {
      showFilePanel('full', true);

      openPaneSurface(WS, BLANK_BROWSER, { kind: 'tab' });

      const fileViewer = useFileViewerStore.getState();
      expect(fileViewer.inlineFilePreviewByWorkspace[WS]?.open).toBe(true);
      expect(fileViewer.inlineFilePreviewPendingCloseByWorkspace[WS]).toBe(true);
      await answerUnsavedPrompt('cancel');
    });

    it('opens the pane only once the unsaved edits are discarded', async () => {
      showFilePanel('full', true);

      const id = openPaneSurface(WS, BLANK_BROWSER, { kind: 'tab' });
      expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual(['term-1']);

      await answerUnsavedPrompt('discard');
      expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual(['term-1', id]);
      expect(useLayoutStore.getState().getActiveTabId()).toBe(id);
    });

    it('drops the pane when the unsaved edits stay', async () => {
      showFilePanel('full', true);

      const id = openPaneSurface(WS, BLANK_BROWSER, { kind: 'tab' });
      await answerUnsavedPrompt('cancel');

      expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual(['term-1']);
      expect(usePaneSurfacesStore.getState().surfaces[id]).toBeUndefined();
    });

    it('opens a page only once the unsaved edits are discarded, and not when they stay', async () => {
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: WS, terminals: [createTerminal({ id: 'term-1' })] })],
      });
      showFilePanel('full', true);

      openInBrowserPane(WS, 'https://a.test/');
      await answerUnsavedPrompt('cancel');
      expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual(['term-1']);

      openInBrowserPane(WS, 'https://b.test/');
      await answerUnsavedPrompt('discard');
      const tabs = useLayoutStore.getState().tabsByWorkspace[WS];
      expect(tabs).toHaveLength(2);
      const browser = usePaneSurfacesStore.getState().surfaces[tabs[1]];
      expect(browser?.kind === 'browser' && browser.browserTabs.map((tab) => tab.url)).toEqual([
        'https://b.test/',
      ]);
    });

    it('leaves a panel beside the panes open', () => {
      showFilePanel('side-by-side');

      openPaneSurface(WS, BLANK_BROWSER, { kind: 'tab' });

      expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace[WS]?.open).toBe(true);
    });
  });
});

describe('openBrowserPane', () => {
  it('opens a browser with a blank tab, whose id names its pane', () => {
    const id = openBrowserPane(WS, { kind: 'tab' });

    const [tabId] = browserTabIds(id);
    expect(tabId.startsWith(`${id}/`)).toBe(true);
    // A tab added later belongs to the pane too.
    updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, 'http://localhost:3000'));
    expect(browserTabIds(id)[1].startsWith(`${id}/`)).toBe(true);
  });

  it('opens anything but a web page as a blank tab', () => {
    const long = openBrowserPane(WS, { kind: 'tab' }, `https://a.test/${'x'.repeat(2048)}`);
    const file = openBrowserPane(WS, { kind: 'tab' }, 'file:///etc/passwd');

    for (const id of [long, file]) {
      const surface = usePaneSurfacesStore.getState().surfaces[id];
      expect(surface?.kind === 'browser' && surface.browserTabs.map((tab) => tab.url)).toEqual([
        '',
      ]);
    }
  });
});

describe('openInBrowserPane', () => {
  function browserUrls(surfaceId: string): string[] {
    const surface = usePaneSurfacesStore.getState().surfaces[surfaceId];
    return surface?.kind === 'browser' ? surface.browserTabs.map((tab) => tab.url) : [];
  }

  it('opens a browser in a tab of its own, shown and focused, without splitting', () => {
    const id = openInBrowserPane(WS, 'http://localhost:5173/');

    const layout = useLayoutStore.getState();
    expect(layout.tabsByWorkspace[WS]).toEqual(['term-1', id]);
    expect(leafIds('term-1')).toEqual(['term-1']);
    expect(layout.getActiveTabId()).toBe(id);
    expect(layout.getFocusedPaneId()).toBe(layout.layoutsByTab[WS][id].id);
    expect(browserUrls(id)).toEqual(['http://localhost:5173/']);
  });

  it("opens the page in a new tab of the workspace's browser, and shows that browser", () => {
    const first = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });
    useLayoutStore.getState().addTab(WS, 'term-2');
    useLayoutStore.getState().showTabInFullPane('term-2');

    const id = openInBrowserPane(WS, 'https://example.com/docs');

    expect(id).toBe(first);
    const layout = useLayoutStore.getState();
    expect(layout.tabsByWorkspace[WS]).toEqual(['term-1', 'term-2']);
    expect(layout.getActiveTabId()).toBe('term-1');
    expect(layout.getFocusedPaneId()).toBe(
      findPaneByTerminalId(layout.layoutsByTab[WS]['term-1'], first)?.id
    );
    // The blank tab the browser opened with shows the page.
    expect(browserUrls(first)).toEqual(['https://example.com/docs']);
    openInBrowserPane(WS, 'https://example.com/other');
    expect(browserUrls(first)).toEqual(['https://example.com/docs', 'https://example.com/other']);
  });

  it('prefers a browser in the tab on screen', () => {
    openBrowserPane(WS, { kind: 'tab' });
    useLayoutStore.getState().showTabInFullPane('term-1');
    const beside = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });

    expect(openInBrowserPane(WS, 'https://example.com/')).toBe(beside);
  });

  it('shows the browser without a new tab when given no page', () => {
    const id = openBrowserPane(WS, { kind: 'tab' });
    useLayoutStore.getState().showTabInFullPane('term-1');

    expect(openInBrowserPane(WS)).toBe(id);
    expect(browserUrls(id)).toEqual(['']);
    expect(useLayoutStore.getState().getActiveTabId()).toBe(id);
  });

  it("opens in a workspace that isn't on screen, after its terminal's tab", () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 'term-9' })] })],
    });

    const id = openInBrowserPane('ws-2', 'https://example.com/');

    const layout = useLayoutStore.getState();
    expect(layout.currentWorkspaceId).toBe(WS);
    expect(layout.tabsByWorkspace['ws-2']).toEqual(['term-9', id]);
    expect(layout.activeTabByWorkspace['ws-2']).toBe(id);
    // Selecting the workspace keeps the browser.
    layout.setCurrentWorkspace('ws-2', 'term-9');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-9', id]);
  });
});

describe('closePaneBrowserTab', () => {
  it('closes a tab and its page, and the pane with its last tab', async () => {
    const id = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });
    updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, 'http://localhost:3000'));
    const [first, second] = browserTabIds(id);

    closePaneBrowserTab(WS, first);

    expect(browserTabIds(id)).toEqual([second]);
    expect(leafIds('term-1')).toEqual(['term-1', id]);
    await vi.waitFor(() => expect(closeDevPreview).toHaveBeenCalledWith(WS, first));

    closePaneBrowserTab(WS, second);

    expect(leafIds('term-1')).toEqual(['term-1']);
    await vi.waitFor(() => expect(closeDevPreview).toHaveBeenCalledWith(WS, second));
  });

  it('keeps the last tab while a pane of its tab is closing', () => {
    const id = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });
    useTerminalCloseStore.setState({ closingTerminalIds: new Set(['term-1']) });

    closePaneBrowserTab(WS, browserTabIds(id)[0]);

    expect(leafIds('term-1')).toEqual(['term-1', id]);
    useTerminalCloseStore.setState({ closingTerminalIds: new Set() });
  });
});

describe('closePaneSurface', () => {
  it('removes the pane and forgets the surface', () => {
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );

    closePaneSurface(WS, id);

    expect(leafIds('term-1')).toEqual(['term-1']);
    expect(usePaneSurfacesStore.getState().surfaces[id]).toBeUndefined();
    expect(isPaneSurfaceClosed(id)).toBe(true);
  });

  it('closes the tab a surface was alone in, and its page', async () => {
    const id = openBrowserPane(WS, { kind: 'tab' });
    const [tabId] = browserTabIds(id);

    closePaneSurface(WS, id);

    expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual(['term-1']);
    expect(useLayoutStore.getState().getActiveTabId()).toBe('term-1');
    await vi.waitFor(() => expect(closeDevPreview).toHaveBeenCalledWith(WS, tabId));
  });

  it('stops a workspace when its last pane closes and it has no terminal', async () => {
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: WS, terminals: [] })],
      stopWorkspace,
    });
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );
    useLayoutStore.getState().removeTerminalPane(WS, 'term-1');

    closePaneSurface(WS, id);

    expect(useLayoutStore.getState().tabsByWorkspace[WS]).toEqual([]);
    expect(stopWorkspace).toHaveBeenCalledWith(WS);
  });

  it('keeps a workspace running while a terminal is left', () => {
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: WS, terminals: [createTerminal({ id: 'term-2' })] })],
      stopWorkspace,
    });
    const id = openBrowserPane(WS, { kind: 'tab' });
    useLayoutStore.getState().removeTerminalPane(WS, 'term-1');

    closePaneSurface(WS, id);

    expect(stopWorkspace).not.toHaveBeenCalled();
  });
});

describe('reportWorkspacesShowingPaneSurfaces', () => {
  it('tells main which workspaces show a browser or note pane, once per change', () => {
    const setPaneSurfaceWorkspaces = vi.fn();
    Object.assign(window, { api: { closeDevPreview, setPaneSurfaceWorkspaces } });
    const stopReporting = reportWorkspacesShowingPaneSurfaces();

    // The first report clears what a reloaded window left in main.
    expect(setPaneSurfaceWorkspaces).toHaveBeenLastCalledWith([]);
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );
    expect(setPaneSurfaceWorkspaces).toHaveBeenLastCalledWith([WS]);
    useLayoutStore.getState().splitPane('vertical', 'term-2');
    expect(setPaneSurfaceWorkspaces).toHaveBeenCalledTimes(2);

    closePaneSurface(WS, id);
    expect(setPaneSurfaceWorkspaces).toHaveBeenLastCalledWith([]);
    stopReporting();
  });
});

describe('saved browser panes', () => {
  const updateWorkspace = vi.fn().mockResolvedValue(undefined);
  let stopRestoring: () => void;
  let stopSaving: () => void;

  function browsers(workspaceId: string) {
    return Object.entries(usePaneSurfacesStore.getState().surfaces).flatMap(([id, surface]) =>
      surface.kind === 'browser' && surface.workspaceId === workspaceId ? [{ id, ...surface }] : []
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    updateWorkspace.mockClear();
    Object.assign(window, { api: { closeDevPreview, updateWorkspace } });
    stopRestoring = restoreSavedBrowserPanes();
    stopSaving = saveBrowserPanes();
  });

  afterEach(() => {
    stopRestoring();
    stopSaving();
    vi.useRealTimers();
  });

  it("opens a workspace's saved browsers in tabs after its terminal's when it starts", () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-2',
          terminals: [createTerminal({ id: 'term-9' })],
          browserPanes: [
            {
              browserTabs: [
                { id: 'a', url: 'https://a.test/', title: 'A' },
                { id: 'b', url: 'http://localhost:5173/' },
              ],
              activeBrowserTabId: 'b',
            },
          ],
        }),
      ],
    });

    useLayoutStore.getState().setCurrentWorkspace('ws-2', 'term-9');

    const [browser] = browsers('ws-2');
    const layout = useLayoutStore.getState();
    expect(layout.tabsByWorkspace['ws-2']).toEqual(['term-9', browser.id]);
    expect(layout.activeTabByWorkspace['ws-2']).toBe('term-9');
    expect(browser.browserTabs).toEqual([
      { id: `${browser.id}/a`, url: 'https://a.test/', title: 'A' },
      { id: `${browser.id}/b`, url: 'http://localhost:5173/' },
    ]);
    expect(browser.activeBrowserTabId).toBe(`${browser.id}/b`);
  });

  it('opens the saved browsers of a workspace whose layout came back before it loaded', () => {
    // Loading workspaces sets up their saved layouts first, as an SSH workspace's after a restart.
    useWorkspacesStore.setState({ workspaces: [] });
    useLayoutStore.getState().applyWorkspaceLayout(
      'ws-2',
      {
        tabs: ['term-9'],
        layouts: { 'term-9': { type: 'leaf', id: 'p1', terminalId: 'term-9' } },
        focusedPanes: {},
        activeTab: 'term-9',
      } as never,
      { setCurrentWorkspace: false }
    );
    expect(browsers('ws-2')).toEqual([]);

    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-2',
          terminals: [createTerminal({ id: 'term-9' })],
          browserPanes: [{ browserTabs: [{ id: 'a', url: 'https://a.test/' }] }],
        }),
      ],
    });

    const [browser] = browsers('ws-2');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-9', browser.id]);
    expect(browser.browserTabs.map((tab) => tab.url)).toEqual(['https://a.test/']);
  });

  it('waits for the terminal of a workspace that is still being set up', () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-2',
          terminals: [],
          browserPanes: [{ browserTabs: [{ id: 'a', url: 'https://a.test/' }] }],
        }),
      ],
    });

    useLayoutStore.getState().setCurrentWorkspace('ws-2');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['ws-2']);
    expect(browsers('ws-2')).toEqual([]);

    useLayoutStore.getState().initializeWorkspaceLayout('ws-2', 'term-9', true);
    const [browser] = browsers('ws-2');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-9', browser.id]);
  });

  it("opens a page in the saved browser of a workspace that isn't set up yet", () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-2',
          terminals: [createTerminal({ id: 'term-9' })],
          browserPanes: [{ browserTabs: [{ id: 'a', url: 'https://a.test/' }] }],
        }),
      ],
    });

    const id = openInBrowserPane('ws-2', 'https://b.test/');

    expect(browsers('ws-2').map((browser) => browser.id)).toEqual([id]);
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-9', id]);
    expect(browsers('ws-2')[0].browserTabs.map((tab) => tab.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
  });

  it('opens a page once the terminal of a workspace being set up has its tab', () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-2', terminals: [], provisioning: true })],
    });
    useLayoutStore.getState().setCurrentWorkspace('ws-2');

    expect(openInBrowserPane('ws-2', 'https://b.test/')).toBeNull();
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['ws-2']);

    useLayoutStore.getState().initializeWorkspaceLayout('ws-2', 'term-9', true);
    const [browser] = browsers('ws-2');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-9', browser.id]);
    expect(browser.browserTabs.map((tab) => tab.url)).toEqual(['https://b.test/']);
  });

  it('forgets the pages waiting on a workspace that is removed', () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-2', terminals: [], provisioning: true })],
    });
    useLayoutStore.getState().setCurrentWorkspace('ws-2');
    expect(openInBrowserPane('ws-2', 'https://b.test/')).toBeNull();

    useWorkspacesStore.setState({ workspaces: [] });
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 'term-9' })] })],
    });
    useLayoutStore.getState().initializeWorkspaceLayout('ws-2', 'term-9', true);

    expect(browsers('ws-2')).toEqual([]);
  });

  it("opens a page once a workspace this window hasn't loaded yet has its terminal's tab", () => {
    useWorkspacesStore.setState({ workspaces: [] });

    expect(openInBrowserPane('ws-2', 'https://b.test/')).toBeNull();
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toBeUndefined();

    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 'term-9' })] })],
    });
    useLayoutStore.getState().setCurrentWorkspace('ws-2', 'term-9');
    const [browser] = browsers('ws-2');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-9', browser.id]);
    expect(browser.browserTabs.map((tab) => tab.url)).toEqual(['https://b.test/']);
  });

  it('opens a page in the saved browser of a stopped workspace with no terminal', () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-2',
          terminals: [],
          browserPanes: [
            { browserTabs: [{ id: 'a', url: 'https://a.test/' }] },
            { browserTabs: [{ id: 'c', url: 'https://c.test/' }] },
          ],
        }),
      ],
    });

    const id = openInBrowserPane('ws-2', 'https://b.test/');

    const restored = browsers('ws-2');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(
      restored.map((browser) => browser.id)
    );
    expect(restored.map((browser) => browser.browserTabs.map((tab) => tab.url))).toEqual([
      ['https://a.test/', 'https://b.test/'],
      ['https://c.test/'],
    ]);
    expect(id).toBe(restored[0].id);
  });

  it('opens a browser on its own in a set-up workspace with no terminal open', () => {
    useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: 'ws-2', terminals: [] })] });

    const id = openInBrowserPane('ws-2', 'https://b.test/');

    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual([id]);
  });

  it('keeps the browsers of a workspace another window handed over', () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-2',
          terminals: [createTerminal({ id: 'term-9' })],
          browserPanes: [{ browserTabs: [{ id: 'a', url: 'https://a.test/' }] }],
        }),
      ],
    });
    adoptPaneSurfaces({ 'surface:browser:moved': { ...BLANK_BROWSER, workspaceId: 'ws-2' } });

    useLayoutStore.getState().applyWorkspaceLayout('ws-2', {
      tabs: ['term-9', 'surface:browser:moved'],
      layouts: {
        'term-9': { type: 'leaf', id: 'p1', terminalId: 'term-9' },
        'surface:browser:moved': { type: 'leaf', id: 'p2', terminalId: 'surface:browser:moved' },
      },
      focusedPanes: {},
      activeTab: 'term-9',
    } as never);

    expect(browsers('ws-2').map((browser) => browser.id)).toEqual(['surface:browser:moved']);
  });

  it("saves a workspace's browsers once its pages settle, and none once the last one closes", () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: WS, terminals: [createTerminal({ id: 'term-1' })] })],
    });
    const id = openInBrowserPane(WS, 'https://a.test/');
    vi.advanceTimersByTime(500);
    updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, 'https://b.test/'));
    vi.runAllTimers();

    expect(updateWorkspace).toHaveBeenCalledExactlyOnceWith(WS, {
      browserPanes: [
        {
          browserTabs: [
            { id: expect.not.stringContaining('surface:'), url: 'https://a.test/' },
            { id: expect.not.stringContaining('surface:'), url: 'https://b.test/' },
          ],
          activeBrowserTabId: expect.not.stringContaining('surface:'),
        },
      ],
    });

    closePaneSurface(WS, id);
    vi.runAllTimers();
    expect(updateWorkspace).toHaveBeenLastCalledWith(WS, { browserPanes: [] });
  });

  it("saves a workspace's other browsers when a tab's URL can't be saved", () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: WS, terminals: [createTerminal({ id: 'term-1' })] })],
    });
    const id = openInBrowserPane(WS, 'https://a.test/');
    openBrowserPane(WS, { kind: 'tab' }, 'https://b.test/');
    updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, `https://a.test/${'x'.repeat(2048)}`));
    vi.runAllTimers();

    expect(updateWorkspace).toHaveBeenCalledExactlyOnceWith(WS, {
      browserPanes: [
        expect.objectContaining({
          browserTabs: [expect.objectContaining({ url: 'https://a.test/' })],
        }),
        expect.objectContaining({
          browserTabs: [expect.objectContaining({ url: 'https://b.test/' })],
        }),
      ],
    });
  });

  it('saves the order of browsers that only moved', () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: WS, terminals: [createTerminal({ id: 'term-1' })] })],
    });
    const first = openBrowserPane(WS, { kind: 'tab' }, 'https://a.test/');
    openBrowserPane(WS, { kind: 'tab' }, 'https://b.test/');
    vi.runAllTimers();
    updateWorkspace.mockClear();

    useLayoutStore.getState().reorderTabs(WS, 1, 2);
    vi.runAllTimers();

    expect(updateWorkspace).toHaveBeenCalledExactlyOnceWith(WS, {
      browserPanes: [
        expect.objectContaining({
          browserTabs: [expect.objectContaining({ url: 'https://b.test/' })],
        }),
        expect.objectContaining({
          browserTabs: [expect.objectContaining({ url: 'https://a.test/' })],
        }),
      ],
    });
    expect(useLayoutStore.getState().tabsByWorkspace[WS].at(-1)).toBe(first);
  });

  it('waits to save only when a browser changes', () => {
    useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: WS })] });
    openInBrowserPane(WS, 'https://a.test/');
    vi.runAllTimers();

    usePaneSurfacesStore.getState().addSurface({ kind: 'note', workspaceId: WS, name: 'a.md' });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('saves a browser closed just before the workspace stops as closed', () => {
    useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: WS })] });
    const id = openInBrowserPane(WS, 'https://a.test/')!;
    vi.runAllTimers();
    updateWorkspace.mockClear();

    closePaneSurface(WS, id);
    vi.advanceTimersByTime(100);
    useLayoutStore.getState().clearWorkspaceLayout(WS);
    vi.runAllTimers();

    expect(updateWorkspace).toHaveBeenCalledExactlyOnceWith(WS, { browserPanes: [] });
  });

  it('keeps the saved browsers when the workspace stops', () => {
    useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: WS })] });
    openInBrowserPane(WS, 'https://a.test/');
    vi.runAllTimers();
    updateWorkspace.mockClear();

    useLayoutStore.getState().clearWorkspaceLayout(WS);
    vi.runAllTimers();

    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});

describe('forgetSurfacesOfRemovedPanes', () => {
  it('keeps a surface whose pane moves to a tab of its own', () => {
    const id = openPaneSurface(WS, BLANK_BROWSER, { kind: 'split', direction: 'vertical' });
    const layout = useLayoutStore.getState();
    const paneId = findPaneByTerminalId(layout.layoutsByTab[WS]['term-1'], id)!.id;

    layout.movePaneToNewTab(paneId);

    expect(usePaneSurfacesStore.getState().surfaces[id]).toBeDefined();
  });

  it('forgets the surfaces of a cleared workspace and closes their pages', async () => {
    const id = openBrowserPane(WS, { kind: 'tab' });
    const [tabId] = browserTabIds(id);

    useLayoutStore.getState().clearWorkspaceLayout(WS);

    expect(usePaneSurfacesStore.getState().surfaces[id]).toBeUndefined();
    expect(isPaneSurfaceClosed(id)).toBe(true);
    await vi.waitFor(() => expect(closeDevPreview).toHaveBeenCalledWith(WS, tabId));
  });

  it('counts a surface handed to another window as moved, not closed', () => {
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );

    const handed = handOffWorkspacePaneSurfaces(WS);
    useLayoutStore.getState().clearWorkspaceLayout(WS);

    expect(handed).toEqual({ [id]: { kind: 'note', workspaceId: WS, name: 'a.md' } });
    expect(usePaneSurfacesStore.getState().surfaces[id]).toBeUndefined();
    expect(isPaneSurfaceClosed(id)).toBe(false);
  });
});

describe('isPaneSurfaceLayoutLocked', () => {
  it('locks a surface whose tab has a pane closing', () => {
    const id = openPaneSurface(WS, BLANK_BROWSER, { kind: 'split', direction: 'vertical' });
    expect(isPaneSurfaceLayoutLocked(WS, id)).toBe(false);

    useTerminalCloseStore.setState({ closingTerminalIds: new Set(['term-1']) });

    expect(isPaneSurfaceLayoutLocked(WS, id)).toBe(true);
    useTerminalCloseStore.setState({ closingTerminalIds: new Set() });
  });
});

describe('adoptPaneSurfaces', () => {
  it('shows the panes of a workspace another window handed over', () => {
    const surfaces = { 'surface:note:x': { kind: 'note', workspaceId: WS, name: 'a.md' } };

    adoptPaneSurfaces(surfaces);
    useLayoutStore.getState().addTab(WS, 'surface:note:x');

    expect(usePaneSurfacesStore.getState().surfaces).toEqual(surfaces);
  });

  it('closes a surface for real once it came back from another window', () => {
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );
    const handed = handOffWorkspacePaneSurfaces(WS);
    useLayoutStore.getState().clearWorkspaceLayout(WS);

    adoptPaneSurfaces(handed);
    useLayoutStore.getState().addTab(WS, id);
    closePaneSurface(WS, id);

    expect(isPaneSurfaceClosed(id)).toBe(true);
  });
});

describe('getPaneSurfaceTitle', () => {
  it("names a browser by its active tab's title, else its host", () => {
    const browser = (tab: { url: string; title?: string }): PaneSurface => ({
      ...BLANK_BROWSER,
      browserTabs: [
        { id: 'other', url: 'http://example.com' },
        { id: 'shown', ...tab },
      ],
      activeBrowserTabId: 'shown',
    });
    expect(getPaneSurfaceTitle(browser({ url: 'http://localhost:3000/a' }), [])).toBe(
      'localhost:3000'
    );
    expect(getPaneSurfaceTitle(browser({ url: 'http://localhost:3000/a', title: 'App' }), [])).toBe(
      'App'
    );
    expect(getPaneSurfaceTitle(browser({ url: '' }), [])).toBe('Browser');
  });

  it('names a note by its title', () => {
    const notes = [{ name: 'n.md', title: 'Plan', path: '/notes/n.md', modifiedMs: 0 }];
    expect(getPaneSurfaceTitle({ kind: 'note', workspaceId: WS, name: 'n.md' }, notes)).toBe(
      'Plan'
    );
    expect(getPaneSurfaceTitle({ kind: 'note', workspaceId: WS, name: 'x.md' }, notes)).toBe(
      'Untitled note'
    );
  });
});

describe('replacePaneSurface', () => {
  function openNote(): { id: string; paneId: string } {
    const id = openPaneSurface(
      WS,
      { kind: 'note', workspaceId: WS, name: 'a.md' },
      { kind: 'split', direction: 'vertical' }
    );
    const root = useLayoutStore.getState().layoutsByTab[WS]['term-1'];
    return { id, paneId: findPaneByTerminalId(root, id)!.id };
  }

  it("opens a terminal in the surface's place and forgets the surface", async () => {
    useWorkspacesStore.setState({ addTerminal: vi.fn().mockResolvedValue({ id: 'term-2' }) });
    const note = openNote();

    await replacePaneSurface(WS, note.id, note.paneId, 'terminal');

    expect(leafIds('term-1')).toEqual(['term-1', 'term-2']);
    expect(usePaneSurfacesStore.getState().surfaces[note.id]).toBeUndefined();
  });

  it('opens a browser in its place', async () => {
    const note = openNote();

    await replacePaneSurface(WS, note.id, note.paneId, 'browser');

    const [, browserId] = leafIds('term-1');
    expect(leafIds('term-1')).toHaveLength(2);
    expect(usePaneSurfacesStore.getState().surfaces[browserId]?.kind).toBe('browser');
  });

  it('opens a terminal in the Local copy of an SSH workspace in its place', async () => {
    const addTerminal = vi.fn().mockResolvedValue({ id: 'term-2' });
    useWorkspacesStore.setState({ addTerminal });
    const note = openNote();

    await replacePaneSurface(WS, note.id, note.paneId, 'local-terminal');

    expect(addTerminal).toHaveBeenCalledWith(
      WS,
      'Local terminal',
      null,
      undefined,
      'host-shell',
      'local-mirror'
    );
    expect(leafIds('term-1')).toEqual(['term-1', 'term-2']);
    expect(usePaneSurfacesStore.getState().surfaces[note.id]).toBeUndefined();
  });

  it('launches an agent in its place', async () => {
    const addAgentTab = vi.fn().mockResolvedValue({ id: 'term-2' });
    useWorkspacesStore.setState({ addAgentTab });
    useAgentPresetsStore.setState({ setActivePreset: vi.fn().mockResolvedValue(undefined) });
    const note = openNote();

    await replacePaneSurface(WS, note.id, note.paneId, {
      kind: 'agent',
      presetId: 'codex',
      launchModeId: null,
    });

    expect(addAgentTab).toHaveBeenCalledWith(WS, undefined, undefined, 'codex');
    expect(leafIds('term-1')).toEqual(['term-1', 'term-2']);
  });

  it("keeps the surface when the agent can't start", async () => {
    useWorkspacesStore.setState({ addAgentTab: vi.fn().mockRejectedValue(new Error('no agent')) });
    const note = openNote();

    await replacePaneSurface(WS, note.id, note.paneId, {
      kind: 'agent',
      presetId: 'codex',
      launchModeId: null,
    });

    expect(leafIds('term-1')).toEqual(['term-1', note.id]);
  });

  it("keeps the surface when the terminal can't open", async () => {
    useWorkspacesStore.setState({ addTerminal: vi.fn().mockRejectedValue(new Error('no shell')) });
    const note = openNote();

    await replacePaneSurface(WS, note.id, note.paneId, 'terminal');

    expect(leafIds('term-1')).toEqual(['term-1', note.id]);
  });

  it("keeps the surface when the note can't start", async () => {
    useNotesStore.setState({ create: vi.fn().mockRejectedValue(new Error('disk full')) });
    const browserId = openPaneSurface(
      WS,
      { kind: 'browser', workspaceId: WS, browserTabs: [], activeBrowserTabId: undefined },
      { kind: 'split', direction: 'vertical' }
    );
    const root = useLayoutStore.getState().layoutsByTab[WS]['term-1'];

    await replacePaneSurface(WS, browserId, findPaneByTerminalId(root, browserId)!.id, 'note');

    expect(leafIds('term-1')).toEqual(['term-1', browserId]);
  });
});

describe('splitAgentBesidePane', () => {
  it('launches the agent beside the pane and remembers it as the last used', async () => {
    const addAgentTab = vi.fn().mockResolvedValue({ id: 'term-2' });
    const setActivePreset = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({ addAgentTab });
    useAgentPresetsStore.setState({ setActivePreset });
    const root = useLayoutStore.getState().layoutsByTab[WS]['term-1'];

    await splitAgentBesidePane(WS, root.id, 'vertical', 'codex', 'yolo');

    expect(addAgentTab).toHaveBeenCalledWith(WS, undefined, 'yolo', 'codex');
    expect(leafIds('term-1')).toEqual(['term-1', 'term-2']);
    expect(setActivePreset).toHaveBeenCalledWith('codex', 'yolo');
  });

  it("leaves the layout alone when the agent can't start", async () => {
    useWorkspacesStore.setState({ addAgentTab: vi.fn().mockRejectedValue(new Error('no agent')) });
    const root = useLayoutStore.getState().layoutsByTab[WS]['term-1'];

    await splitAgentBesidePane(WS, root.id, 'vertical', 'codex', null);

    expect(leafIds('term-1')).toEqual(['term-1']);
  });
});

describe('file panes', () => {
  const surfaces = () => usePaneSurfacesStore.getState().surfaces;

  it('opens a file in a pane named after it, at its line once', () => {
    const id = openFilePane(WS, 'src/app.ts', { kind: 'split', direction: 'vertical' }, 12);

    expect(leafIds('term-1')).toEqual(['term-1', id]);
    expect(surfaces()[id]).toEqual({ kind: 'file', workspaceId: WS, path: 'src/app.ts' });
    expect(getPaneSurfaceTitle(surfaces()[id], [])).toBe('app.ts');
    expect(takeFilePaneOpening(id)).toEqual({ lineNumber: 12 });
    // A remounted pane stays where it was.
    expect(takeFilePaneOpening(id)).toBeUndefined();
  });

  it('keeps unsaved text apart from the pane, and tells which other copy has some', () => {
    const first = openFilePane(WS, 'a.ts', { kind: 'tab' });
    const second = openFilePane(WS, 'a.ts', { kind: 'tab' });

    setFilePaneDraft(first, 'edited');

    expect(getFilePaneDraft(first)).toBe('edited');
    expect(hasUnsavedFilePane(surfaces(), WS, 'a.ts', second)).toBe(true);
    expect(hasUnsavedFilePane(surfaces(), WS, 'a.ts', first)).toBe(false);
    expect(hasUnsavedFilePane(surfaces(), WS, 'b.ts')).toBe(false);
    expect(hasUnsavedFilePane(surfaces(), 'ws-2', 'a.ts')).toBe(false);

    setFilePaneDraft(first, null);
    expect(getFilePaneDraft(first)).toBeUndefined();
    expect(hasUnsavedFilePane(surfaces(), WS, 'a.ts', second)).toBe(false);
  });

  it("lists the workspace's files with unsaved edits in a pane", () => {
    const edited = openFilePane(WS, 'a.ts', { kind: 'tab' });
    openFilePane(WS, 'b.ts', { kind: 'tab' });
    setFilePaneDraft(edited, 'edited');

    expect(getUnsavedFilePanePaths(WS)).toEqual(['a.ts']);
    expect(getUnsavedFilePanePaths('ws-2')).toEqual([]);
  });

  it('follows a file tree move, also of the folder holding the file', () => {
    const file = openFilePane(WS, 'src/a.ts', { kind: 'tab' });
    const other = openFilePane(WS, 'README.md', { kind: 'tab' });
    const path = (id: string) => {
      const surface = surfaces()[id];
      return surface?.kind === 'file' ? surface.path : null;
    };

    followMovedFilePanes(WS, { from: 'src/a.ts', to: 'src/b.ts' });
    expect(path(file)).toBe('src/b.ts');

    followMovedFilePanes(WS, { from: 'src', to: 'lib' });
    expect(path(file)).toBe('lib/b.ts');
    expect(path(other)).toBe('README.md');

    followMovedFilePanes('ws-2', { from: 'lib', to: 'x' });
    expect(path(file)).toBe('lib/b.ts');
  });

  it('forgets unsaved text with its pane', () => {
    const id = openFilePane(WS, 'a.ts', { kind: 'tab' });
    setFilePaneDraft(id, 'edited');

    closePaneSurface(WS, id);

    expect(getFilePaneDraft(id)).toBeUndefined();
  });

  it('carries unsaved text to the window a workspace moves to', () => {
    const id = openFilePane(WS, 'a.ts', { kind: 'tab' });
    setFilePaneDraft(id, 'edited');

    const handed = handOffWorkspacePaneSurfaces(WS);
    useLayoutStore.getState().clearWorkspaceLayout(WS);
    expect(getFilePaneDraft(id)).toBeUndefined();
    adoptPaneSurfaces(handed);

    expect(getFilePaneDraft(id)).toBe('edited');
    expect(surfaces()[id]).toEqual({ kind: 'file', workspaceId: WS, path: 'a.ts', dirty: true });
  });

  describe('closing with unsaved edits', () => {
    let unregister: (() => void) | undefined;
    afterEach(() => unregister?.());

    function openEditedFile(): string {
      const id = openFilePane(WS, 'src/a.ts', { kind: 'split', direction: 'vertical' });
      setFilePaneDraft(id, 'edited');
      return id;
    }

    it('closes a pane without unsaved edits without asking', async () => {
      const confirm = vi.fn();
      unregister = registerPaneCloseConfirm(confirm);
      const id = openFilePane(WS, 'a.ts', { kind: 'split', direction: 'vertical' });

      expect(await requestClosePaneSurface(WS, id)).toBe(true);

      expect(confirm).not.toHaveBeenCalled();
      expect(leafIds('term-1')).toEqual(['term-1']);
    });

    it('asks first, and keeps the pane when the edits stay', async () => {
      const confirm = vi.fn().mockResolvedValue(false);
      unregister = registerPaneCloseConfirm(confirm);
      const id = openEditedFile();

      expect(await requestClosePaneSurface(WS, id)).toBe(false);

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'a.ts has unsaved changes. Discard them?' })
      );
      expect(leafIds('term-1')).toEqual(['term-1', id]);
      expect(getFilePaneDraft(id)).toBe('edited');
    });

    it('closes the pane once the edits may go', async () => {
      unregister = registerPaneCloseConfirm(vi.fn().mockResolvedValue(true));
      const id = openEditedFile();

      expect(await requestClosePaneSurface(WS, id)).toBe(true);

      expect(leafIds('term-1')).toEqual(['term-1']);
    });

    it('keeps the edits when there is no dialog to ask in', async () => {
      const id = openEditedFile();

      expect(await requestClosePaneSurface(WS, id)).toBe(false);

      expect(leafIds('term-1')).toEqual(['term-1', id]);
    });

    it('asks before replacing the pane', async () => {
      unregister = registerPaneCloseConfirm(vi.fn().mockResolvedValue(false));
      const id = openEditedFile();
      const root = useLayoutStore.getState().layoutsByTab[WS]['term-1'];

      await replacePaneSurface(WS, id, findPaneByTerminalId(root, id)!.id, 'browser');

      expect(leafIds('term-1')).toEqual(['term-1', id]);
    });
  });
});

describe('stopping the workspace with its last pane', () => {
  let unregister: (() => void) | undefined;
  const confirm = vi.fn();

  beforeEach(() => {
    confirm.mockReset().mockResolvedValue(false);
    unregister = registerPaneCloseConfirm(confirm);
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: WS,
          name: 'fix-login',
          terminals: [createTerminal({ id: 'term-1' })],
        }),
      ],
    });
  });

  afterEach(() => {
    unregister?.();
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
  });

  describe('closingPanesStopsWorkspace', () => {
    it('is true for the last terminal', () => {
      expect(closingPanesStopsWorkspace(WS, ['term-1'])).toBe(true);
    });

    it('is false while another terminal stays, even one without a pane', () => {
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({
            id: WS,
            terminals: [createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })],
          }),
        ],
      });

      expect(closingPanesStopsWorkspace(WS, ['term-1'])).toBe(false);
    });

    it('counts terminals already closing as gone', () => {
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({
            id: WS,
            terminals: [createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })],
          }),
        ],
      });
      useTerminalCloseStore.setState({ closingTerminalIds: new Set(['term-2']) });

      expect(closingPanesStopsWorkspace(WS, ['term-1'])).toBe(true);
    });

    it('is false while a browser or note pane stays, and true when it closes too', () => {
      const id = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });

      expect(closingPanesStopsWorkspace(WS, ['term-1'])).toBe(false);
      expect(closingPanesStopsWorkspace(WS, ['term-1', id])).toBe(true);
    });

    it('is true for the last browser pane of a workspace without terminals', () => {
      useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: WS, terminals: [] })] });
      const id = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });

      expect(closingPanesStopsWorkspace(WS, [id])).toBe(true);
    });

    it('is false for an unknown workspace', () => {
      expect(closingPanesStopsWorkspace('ws-unknown', ['term-1'])).toBe(false);
    });
  });

  describe('confirmStoppingWorkspace', () => {
    it('names the workspace, with the Stop button focused so Enter confirms', async () => {
      expect(await confirmStoppingWorkspace(WS)).toBe(false);

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Nothing else is open in "fix-login", so closing this stops it.',
          confirmLabel: 'Stop Workspace',
          focusConfirm: true,
        })
      );
    });

    it('shortens a long title, such as a shell user@host and path', async () => {
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: WS, name: `agent@host: /${'deep/'.repeat(20)}repo` })],
      });

      await confirmStoppingWorkspace(WS);

      const { description } = confirm.mock.calls[0][0] as { description: string };
      expect(description).toMatch(/^Nothing else is open in "agent@host: \/deep\/.*…", so/);
      expect(description.length).toBeLessThan(120);
    });

    it('goes ahead when there is no dialog to ask in', async () => {
      unregister?.();

      expect(await confirmStoppingWorkspace(WS)).toBe(true);
    });
  });

  describe('the last browser, note or file pane', () => {
    function showOnlyBrowserPane(): string {
      useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: WS, terminals: [] })] });
      const id = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });
      useLayoutStore.getState().removeTerminalPane(WS, 'term-1');
      return id;
    }

    it('asks before its close button stops the workspace, and keeps it when cancelled', async () => {
      const id = showOnlyBrowserPane();

      expect(await requestClosePaneSurface(WS, id)).toBe(false);

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop Workspace?' }));
      expect(usePaneSurfacesStore.getState().surfaces[id]).toBeDefined();
    });

    it('closes once the stop is confirmed', async () => {
      const id = showOnlyBrowserPane();
      confirm.mockResolvedValue(true);

      expect(await requestClosePaneSurface(WS, id)).toBe(true);

      expect(usePaneSurfacesStore.getState().surfaces[id]).toBeUndefined();
    });

    it('asks before closing its last browser tab stops the workspace', async () => {
      const id = showOnlyBrowserPane();

      closePaneBrowserTab(WS, browserTabIds(id)[0]);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalled());

      expect(usePaneSurfacesStore.getState().surfaces[id]).toBeDefined();

      confirm.mockResolvedValue(true);
      closePaneBrowserTab(WS, browserTabIds(id)[0]);
      await vi.waitFor(() => expect(usePaneSurfacesStore.getState().surfaces[id]).toBeUndefined());
    });

    it('keeps the pane when a tab opens in it while the stop is asked', async () => {
      const id = showOnlyBrowserPane();
      const [tabId] = browserTabIds(id);
      let answer: (confirmed: boolean) => void = () => {};
      confirm.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      closePaneBrowserTab(WS, tabId);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
      updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, 'http://localhost:3000'));
      answer(true);

      await vi.waitFor(() => expect(browserTabIds(id)).not.toContain(tabId));
      expect(browserTabIds(id)).toHaveLength(1);
      expect(usePaneSurfacesStore.getState().surfaces[id]).toBeDefined();
    });

    it('closes a pane beside a terminal without asking', async () => {
      const id = openBrowserPane(WS, { kind: 'split', direction: 'vertical' });

      expect(await requestClosePaneSurface(WS, id)).toBe(true);

      expect(confirm).not.toHaveBeenCalled();
    });
  });
});

describe('unsaved files', () => {
  function editInPane(workspaceId: string, path: string): string {
    const id = openFilePane(workspaceId, path, { kind: 'tab' });
    setFilePaneDraft(id, 'edited');
    return id;
  }

  function editInPanel(workspaceId: string, filePath: string) {
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [workspaceId]: {
          open: true,
          mode: 'browse',
          filePath,
          layout: 'side-by-side',
          isDirty: true,
        },
      },
    });
  }

  beforeEach(() => {
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
  });

  it('names the files with unsaved edits in file panes and the file panel', () => {
    editInPane(WS, 'src/a.ts');
    openFilePane(WS, 'src/clean.ts', { kind: 'tab' });
    editInPanel('ws-2', 'docs/b.md');

    expect(getUnsavedFileNames()).toEqual(['a.ts', 'b.md']);
    expect(getUnsavedFileNames([WS])).toEqual(['a.ts']);
    expect(getUnsavedFileNames(['ws-3'])).toEqual([]);
  });

  it('tells main whenever they change', () => {
    const setUnsavedFiles = vi.fn();
    Object.assign(window, { api: { closeDevPreview, setUnsavedFiles } });
    const stopReporting = reportUnsavedFiles();
    expect(setUnsavedFiles).toHaveBeenLastCalledWith([]);

    const id = editInPane(WS, 'src/a.ts');
    expect(setUnsavedFiles).toHaveBeenLastCalledWith(['a.ts']);
    editInPanel(WS, 'b.md');
    expect(setUnsavedFiles).toHaveBeenLastCalledWith(['a.ts', 'b.md']);
    const calls = setUnsavedFiles.mock.calls.length;
    usePaneSurfacesStore.getState().setFilePath(id, 'src/a.ts');
    expect(setUnsavedFiles).toHaveBeenCalledTimes(calls);

    setFilePaneDraft(id, null);
    expect(setUnsavedFiles).toHaveBeenLastCalledWith(['b.md']);
    stopReporting();
  });
});
