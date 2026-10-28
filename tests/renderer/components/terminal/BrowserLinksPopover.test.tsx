/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recentOutput } = vi.hoisted(() => ({ recentOutput: vi.fn() }));

vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  getRecentTerminalRendererOutput: recentOutput,
  getTerminalRendererOutputSinceLastScan: recentOutput,
}));

import { BrowserLinksPopover } from '../../../../src/renderer/components/terminal/BrowserLinksPopover';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import {
  LIVE_REFRESH_MS,
  QUICK_REFRESH_MS,
  QUICK_REFRESHES,
} from '../../../../src/renderer/hooks/useDevPreviewServices';
import { getAllLeaves } from '../../../../src/renderer/lib/layout-utils';
import { useDevServerPreviewStore } from '../../../../src/renderer/stores/dev-server-preview.store';
import { useLayoutStore } from '../../../../src/renderer/stores/layout.store';
import { usePaneSurfacesStore } from '../../../../src/renderer/stores/pane-surfaces.store';
import { useQuickLookStore } from '../../../../src/renderer/stores/quick-look.store';
import { useTerminalFilesStore } from '../../../../src/renderer/stores/terminal-files.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../../src/shared/types';

const openExternal = vi.fn();
const updateWorkspace = vi.fn();
const detectDevPreviewServices = vi.fn();
const getLinkPreview = vi.fn();
const getLinkPreviewImage = vi.fn();
const listViewerFolder = vi.fn();
const openVirtualDesktopInVncApp = vi.fn();
const forgetVirtualDesktops = vi.fn();
const fileContext = {
  workspaceId: 'ws-1',
  workspaceRoot: '/repo',
  workingDirectory: '/repo',
  workspaceBackendKind: 'local' as const,
};

/** A file outside the workspace that terminal t1 opened or printed. */
function terminalFile(path: string) {
  return {
    path,
    terminalId: 't1',
    target: { type: 'external' as const, fullPath: path },
    context: fileContext,
  };
}

function popover(workspaceId = 'ws-1') {
  return (
    <TooltipProvider>
      <BrowserLinksPopover workspaceId={workspaceId}>
        <button type="button">Links</button>
      </BrowserLinksPopover>
    </TooltipProvider>
  );
}

function renderPopover() {
  return render(popover());
}

beforeEach(() => {
  vi.clearAllMocks();
  openExternal.mockResolvedValue(undefined);
  updateWorkspace.mockResolvedValue(undefined);
  detectDevPreviewServices.mockResolvedValue({
    services: [],
    openPorts: [5173],
    otherServers: [],
  });
  getLinkPreview.mockResolvedValue(null);
  getLinkPreviewImage.mockResolvedValue('data:image/png;base64,b2c=');
  recentOutput.mockReturnValue([
    {
      terminalId: 't1',
      executionLocation: 'workspace',
      logicalLines: ['  Local: http://localhost:5173/', 'PR: https://github.com/acme/app/pull/9'],
    },
  ]);
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: 'ws-1',
        backend: { kind: 'local' },
        terminals: [{ id: 't1' }],
        recentLinks: [{ url: 'https://claude.ai/artifact/abc', openedAt: Date.now() }],
      },
    ] as unknown as Workspace[],
  });
  useDevServerPreviewStore.setState({ byWorkspace: {} });
  useTerminalFilesStore.setState(useTerminalFilesStore.getInitialState(), true);
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  usePaneSurfacesStore.setState({ surfaces: {} });
  useLayoutStore.getState().setCurrentWorkspace('ws-1', 't1');
  useQuickLookStore.setState(useQuickLookStore.getInitialState(), true);
  listViewerFolder.mockResolvedValue([]);
  (window as unknown as { api: unknown }).api = {
    platform: 'linux',
    listViewerFolder,
    openExternal,
    updateWorkspace,
    detectDevPreviewServices,
    getLinkPreview,
    getLinkPreviewImage,
    openVirtualDesktopInVncApp,
    forgetVirtualDesktops,
  };
});

const xtermDesktop = {
  vncPort: 5901,
  vncPassword: 'pa55word',
  url: 'http://127.0.0.1:6081/vnc.html?autoconnect=1&password=pa55word',
  app: 'xterm',
  vncApp: 'Screen Sharing',
  shownAt: 1_000,
};

/** Gives workspace ws-1 the backend and the virtual desktops `komla desktop run` showed. */
function withDesktops(backend: Workspace['backend'], virtualDesktops: unknown[]) {
  useWorkspacesStore.setState({
    workspaces: useWorkspacesStore
      .getState()
      .workspaces.map((workspace) => ({ ...workspace, backend, virtualDesktops }) as Workspace),
  });
}

describe('BrowserLinksPopover', () => {
  it('lists running servers, then links, opened ones first', async () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    expect(await screen.findByText('localhost:5173')).toBeTruthy();
    const linkRows = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('title'))
      .filter(Boolean);
    expect(linkRows).toEqual([
      'https://claude.ai/artifact/abc',
      'https://github.com/acme/app/pull/9',
    ]);
  });

  it('checks for servers every second at first, then every few seconds', async () => {
    vi.useFakeTimers();
    try {
      renderPopover();
      fireEvent.click(screen.getByRole('button', { name: 'Links' }));
      const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
      await wait(0);
      expect(detectDevPreviewServices).toHaveBeenCalledTimes(1);

      for (let check = 2; check <= QUICK_REFRESHES + 1; check++) {
        await wait(QUICK_REFRESH_MS);
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(check);
      }
      await wait(LIVE_REFRESH_MS - 1);
      expect(detectDevPreviewServices).toHaveBeenCalledTimes(QUICK_REFRESHES + 1);
      await wait(1);
      expect(detectDevPreviewServices).toHaveBeenCalledTimes(QUICK_REFRESHES + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists a server a background Quick Command printed', async () => {
    recentOutput.mockReturnValue([]);
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 'ws-1',
          backend: { kind: 'local' },
          terminals: [{ id: 't1' }],
          setupActivities: [
            {
              id: 'run-1',
              actionId: 'dev',
              state: 'running',
              output: 'Local: \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n',
            },
          ],
        },
      ] as unknown as Workspace[],
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    expect(await screen.findByText('localhost:5173')).toBeTruthy();
    expect(detectDevPreviewServices).toHaveBeenCalledWith('ws-1', [5173], [], []);
  });

  it('opens a link in the default browser and closes', async () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.click(await screen.findByTitle('https://github.com/acme/app/pull/9'));

    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/9')
    );
    expect(screen.queryByRole('toolbar', { name: 'Servers and links' })).toBeNull();
    expect(useWorkspacesStore.getState().workspaces[0]?.recentLinks?.[0]).toMatchObject({
      url: 'https://github.com/acme/app/pull/9',
      openedAt: expect.any(Number),
    });
  });

  it('opens a running server in the default browser', async () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.click(await screen.findByText('localhost:5173'));

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/'));
  });

  it("opens a link in the workspace's browser on Shift+click", async () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.click(await screen.findByTitle('https://claude.ai/artifact/abc'), { shiftKey: true });

    const [browser] = Object.values(usePaneSurfacesStore.getState().surfaces);
    expect(browser?.kind === 'browser' && browser.browserTabs.map((tab) => tab.url)).toEqual([
      'https://claude.ai/artifact/abc',
    ]);
    expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toHaveLength(2);
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.queryByRole('toolbar', { name: 'Servers and links' })).toBeNull();
  });

  it('opens a server in a browser split beside the focused pane from its menu', async () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.contextMenu(await screen.findByText('localhost:5173'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in Split Right' }));

    const root = useLayoutStore.getState().layoutsByTab['ws-1']['t1'];
    const [, beside] = getAllLeaves(root).map((leaf) => leaf.terminalId);
    const browser = usePaneSurfacesStore.getState().surfaces[beside];
    expect(browser?.kind === 'browser' && browser.browserTabs.map((tab) => tab.url)).toEqual([
      'http://localhost:5173/',
    ]);
  });

  it('opens a workspace file in a new tab from its menu, and offers no browser for it', async () => {
    useTerminalFilesStore.getState().notePrinted('ws-1', [
      {
        path: 'src/app.ts',
        lineNumber: 12,
        terminalId: 't1',
        target: { type: 'workspace', filePath: 'src/app.ts' },
        context: fileContext,
        printedAt: Date.now(),
      },
    ]);
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.contextMenu(await screen.findByText('app.ts'));

    expect(screen.queryByRole('menuitem', { name: 'Open in Komla' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in New Tab' }));

    const surfaces = Object.values(usePaneSurfacesStore.getState().surfaces);
    expect(surfaces).toEqual([{ kind: 'file', workspaceId: 'ws-1', path: 'src/app.ts' }]);
  });

  it("shows each page's title, icon and what serves it", async () => {
    detectDevPreviewServices.mockResolvedValue({
      services: [
        {
          port: 5173,
          scheme: 'http',
          pid: 4242,
          processName: 'node',
          terminalId: 't1',
          executionLocation: 'workspace',
        },
      ],
      openPorts: [5173],
      otherServers: [],
    });
    getLinkPreview.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'http://localhost:5173/') {
        return { title: 'Acme Admin', servedBy: 'Vite', iconDataUrl: 'data:image/png;base64,aWNv' };
      }
      if (url === 'https://github.com/acme/app/pull/9') {
        return { title: 'Fix login · Pull Request #9 · acme/app' };
      }
      return null;
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    const server = (await screen.findByText('Acme Admin')).closest('button')!;
    expect(server.textContent).toContain(':5173 · Vite');
    expect(server.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNv');
    const link = (await screen.findByText('Fix login · Pull Request #9 · acme/app')).closest(
      'button'
    )!;
    expect(link.textContent).toContain('github.com');
    expect(getLinkPreview).toHaveBeenCalledWith({
      url: 'http://localhost:5173/',
      onSshHost: false,
      pid: 4242,
      workspaceId: 'ws-1',
    });
    expect(getLinkPreview).toHaveBeenCalledWith({
      url: 'https://claude.ai/artifact/abc',
      onSshHost: false,
      workspaceId: 'ws-1',
    });
  });

  it("shows a link's og:image and description on hover", async () => {
    getLinkPreview.mockImplementation(async ({ url }: { url: string }) =>
      url === 'https://claude.ai/artifact/abc'
        ? {
            title: 'Launch plan',
            siteName: 'Claude',
            description: 'A plan for the launch',
            imageUrl: 'https://claude.ai/og/abc.png',
          }
        : null
    );
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.focus((await screen.findByText('Launch plan')).closest('button')!);

    expect((await screen.findAllByText('A plan for the launch')).length).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(document.querySelector('img[src="data:image/png;base64,b2c="]')).toBeTruthy()
    );
    expect(getLinkPreviewImage).toHaveBeenCalledWith('https://claude.ai/og/abc.png');
  });

  it('keeps titled servers in view and folds internal ports away', async () => {
    recentOutput.mockReturnValue([]);
    const listener = (port: number) => ({
      port,
      scheme: 'http',
      pid: port,
      processName: 'workerd',
      terminalId: 't1',
      executionLocation: 'workspace',
    });
    detectDevPreviewServices.mockResolvedValue({
      services: [listener(9229), listener(35385), listener(46049)],
      openPorts: [],
      otherServers: [],
    });
    getLinkPreview.mockImplementation(async ({ url }: { url: string }) =>
      url === 'http://localhost:35385/' || url === 'http://localhost:46049/'
        ? { title: 'Acme site' }
        : null
    );
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    expect(await screen.findByText('Acme site')).toBeTruthy();
    expect(screen.getByText('Show 2 more…')).toBeTruthy();
    expect(screen.queryByText('localhost:9229')).toBeNull();
  });

  it('lists servers outside Komla after the links', async () => {
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [5173],
      otherServers: [
        { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
      ],
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    await screen.findByText('localhost:5173');
    // Folded away, they're one row that names them and how many there are.
    const outside = screen.getByRole('button', { name: /Outside Komla/ });
    expect(outside.textContent).toBe('Outside Komla1 server');
    const links = screen.getByTitle('https://github.com/acme/app/pull/9');
    expect(links.compareDocumentPosition(outside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(outside);

    expect(screen.getByText('localhost:8765')).toBeTruthy();
    expect(screen.getByText('Outside Komla')).toBeTruthy();
  });

  it('shows servers outside Komla after the links when the workspace runs none', async () => {
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [],
      otherServers: [
        { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
      ],
    });
    recentOutput.mockReturnValue([]);
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    const server = await screen.findByText('localhost:8765');
    expect(screen.queryByText('Servers')).toBeNull();
    const link = screen.getByTitle('https://claude.ai/artifact/abc');
    expect(link.compareDocumentPosition(server) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a link by its site and path when only the site is known, without when it was printed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10 * 60_000);
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 'ws-1',
          backend: { kind: 'local' },
          terminals: [{ id: 't1' }],
          recentLinks: [{ url: 'https://example.com/login?next=/', printedAt: 7 * 60_000 }],
        },
      ] as unknown as Workspace[],
    });
    recentOutput.mockReturnValue([]);
    getLinkPreview.mockResolvedValue({ siteName: 'Example', fromSite: true });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    const row = await screen.findByTitle('https://example.com/login?next=/');
    expect(await screen.findByText('Example')).toBeTruthy();
    expect(row.textContent).toContain('/login?next=/');
    expect(row.textContent).not.toContain('3m');
    vi.mocked(Date.now).mockRestore();
  });

  it('lists pages first, then Markdown, then pictures, then other files, each opened ones first', async () => {
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    const now = Date.now();
    notePrinted(
      'ws-1',
      ['/tmp/out.log', '/tmp/shot.png', '/tmp/notes.md', '/tmp/new.html', '/tmp/old.html'].map(
        (path, i) => ({ ...terminalFile(path), printedAt: now - i })
      )
    );
    noteOpened('ws-1', terminalFile('/tmp/opened.log'));
    noteOpened('ws-1', terminalFile('/tmp/opened.html'));
    recentOutput.mockReturnValue([]);
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    // Each row reads as its name, then its folder.
    const files = await screen.findByText('Files');
    const shown = [];
    for (let row = files.nextElementSibling; row; row = row.nextElementSibling) {
      shown.push(row.textContent?.replace(/\/tmp\/$/, ''));
    }
    expect(shown).toEqual([
      'opened.html',
      'new.html',
      'old.html',
      'notes.md',
      'shot.png',
      'opened.log',
      'out.log',
    ]);
  });

  it('moves through the rows with the arrow keys and opens one with Enter', async () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    await screen.findByText('localhost:5173');
    const list = screen.getByLabelText('Servers and links');
    expect(document.activeElement).toBe(list);

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'Enter' });

    // The server, then the opened link, then the printed one; up again lands on the opened link.
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://claude.ai/artifact/abc')
    );
    expect(screen.queryByLabelText('Servers and links')).toBeNull();
  });

  it('shows a long list of links behind Show more, reading only the pages shown', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 'ws-1',
          backend: { kind: 'local' },
          terminals: [{ id: 't1' }],
          recentLinks: Array.from({ length: 11 }, (_, i) => ({
            url: `https://example.com/${i}`,
            printedAt: 1_000 - i,
          })),
        },
      ] as unknown as Workspace[],
    });
    recentOutput.mockReturnValue([]);
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    const readLinks = () =>
      getLinkPreview.mock.calls
        .map(([{ url }]: [{ url: string }]) => url)
        .filter((url) => url.startsWith('https://example.com/'));
    const more = await screen.findByText('Show 3 more…');
    expect(readLinks()).toHaveLength(8);

    fireEvent.click(more);

    expect(screen.getByTitle('https://example.com/10')).toBeTruthy();
    expect(readLinks()).toHaveLength(11);
    expect(screen.queryByText('Show 3 more…')).toBeNull();
  });

  it("lists the terminals' files after the links, opened ones first, before servers outside Komla", async () => {
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [5173],
      otherServers: [
        { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
      ],
    });
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [{ ...terminalFile('/tmp/printed.log'), printedAt: Date.now() }]);
    noteOpened('ws-1', terminalFile('/tmp/opened.log'));
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    await screen.findByText('localhost:5173');
    const titled = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('title'))
      .filter(Boolean);
    expect(titled).toEqual([
      'https://claude.ai/artifact/abc',
      'https://github.com/acme/app/pull/9',
      '/tmp/opened.log',
      '/tmp/printed.log',
    ]);
    const files = screen.getByText('Files');
    const outside = screen.getByText('Outside Komla');
    expect(
      screen.getByTitle('https://github.com/acme/app/pull/9').compareDocumentPosition(files) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(files.compareDocumentPosition(outside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads the terminals' files once the pointer reaches the button", () => {
    renderPopover();
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Links' }));

    expect(recentOutput).toHaveBeenCalledWith(
      'ws-1',
      expect.any(Number),
      'files',
      expect.any(Function)
    );
  });

  it('opens a file as its link would, and closes', async () => {
    useTerminalFilesStore
      .getState()
      .notePrinted('ws-1', [{ ...terminalFile('/tmp/out.log'), printedAt: Date.now() }]);
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.click(await screen.findByTitle('/tmp/out.log'));

    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/out.log');
    expect(screen.queryByRole('toolbar', { name: 'Servers and links' })).toBeNull();
  });

  it('lists the running virtual desktops after the servers, and has main forget those that stopped', async () => {
    withDesktops({ kind: 'ssh', hostId: 'host-1' } as Workspace['backend'], [
      xtermDesktop,
      { vncPort: 5903, app: 'gedit', vncApp: 'Screen Sharing', shownAt: 1_000 },
    ]);
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [],
      remoteOpenPorts: [5173],
      ownOpenPorts: [5901],
      checkedAt: 2_000,
      // The desktop's noVNC server, which its row already opens.
      otherServers: [
        { port: 6081, scheme: 'http', processName: 'websockify', executionLocation: 'workspace' },
      ],
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    const desktop = await screen.findByText('xterm');
    expect(detectDevPreviewServices).toHaveBeenCalledWith('ws-1', [], [5173], [5901, 5903]);
    expect(screen.getByText(':1')).toBeTruthy();
    expect(screen.queryByText('gedit')).toBeNull();
    expect(screen.queryByRole('button', { name: /Outside Komla/ })).toBeNull();
    const server = screen.getByText('localhost:5173');
    const link = screen.getByTitle('https://claude.ai/artifact/abc');
    expect(server.compareDocumentPosition(desktop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(desktop.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(forgetVirtualDesktops).toHaveBeenCalledWith('ws-1', [5903], 2_000);
    expect(updateWorkspace).not.toHaveBeenCalledWith('ws-1', {
      virtualDesktops: expect.anything(),
    });
  });

  it("hides the virtual desktops while it cannot tell whether they are this user's", async () => {
    withDesktops({ kind: 'ssh', hostId: 'host-1' } as Workspace['backend'], [xtermDesktop]);
    let answer: (detection: unknown) => void = () => {};
    detectDevPreviewServices.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    // Before the first check, only that it's checking.
    expect(await screen.findByText('Checking virtual desktops…')).toBeTruthy();
    expect(screen.queryByText('xterm')).toBeNull();

    // A host whose listening ports can't be read leaves them unknown, so hidden and kept.
    await act(async () =>
      answer({
        services: [],
        openPorts: [],
        remoteOpenPorts: [5173],
        ownOpenPorts: null,
        checkedAt: 2_000,
        otherServers: [],
      })
    );
    await screen.findByText('localhost:5173');
    expect(screen.queryByText('Checking virtual desktops…')).toBeNull();
    expect(screen.queryByText('xterm')).toBeNull();
    expect(forgetVirtualDesktops).not.toHaveBeenCalled();
  });

  it("never judges a workspace's desktops by another workspace's answer", async () => {
    const host = { kind: 'ssh', hostId: 'host-1' } as Workspace['backend'];
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'ws-1', backend: host, terminals: [{ id: 't1' }], virtualDesktops: [xtermDesktop] },
        {
          id: 'ws-2',
          backend: host,
          terminals: [],
          virtualDesktops: [{ vncPort: 5902, app: 'gedit', shownAt: 1_000 }],
        },
      ] as unknown as Workspace[],
    });
    detectDevPreviewServices.mockResolvedValueOnce({
      services: [],
      openPorts: [],
      remoteOpenPorts: [5173],
      ownOpenPorts: [5901],
      checkedAt: 2_000,
      otherServers: [],
    });
    const { rerender } = render(popover('ws-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    await screen.findByText('xterm');

    // The popover follows the workspace in view; ws-2's check is still on its way.
    detectDevPreviewServices.mockReturnValue(new Promise(() => {}));
    rerender(popover('ws-2'));
    await act(() => Promise.resolve());

    expect(screen.queryByText('xterm')).toBeNull();
    expect(screen.getByText('Checking virtual desktops…')).toBeTruthy();
    expect(forgetVirtualDesktops).not.toHaveBeenCalled();
  });

  it('falls back on no earlier answer once a check comes back unknown', async () => {
    const host = { kind: 'ssh', hostId: 'host-1' } as Workspace['backend'];
    const gedit = { vncPort: 5902, app: 'gedit', shownAt: 1_000 };
    const xclock = { vncPort: 5903, app: 'xclock', shownAt: 1_000 };
    const answer = (ownOpenPorts: number[] | null) => ({
      services: [],
      openPorts: [],
      remoteOpenPorts: [5173],
      ownOpenPorts,
      checkedAt: 2_000,
      otherServers: [],
    });
    withDesktops(host, [xtermDesktop]);
    detectDevPreviewServices.mockResolvedValue(answer([5901]));
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    await screen.findByText('xterm');

    // A desktop added means a check with its port, which can't read the host.
    detectDevPreviewServices.mockResolvedValue(answer(null));
    act(() => withDesktops(host, [xtermDesktop, gedit]));
    await vi.waitFor(() => expect(screen.queryByText('xterm')).toBeNull());

    // While the next check is on its way, the first answer doesn't come back.
    detectDevPreviewServices.mockReturnValue(new Promise(() => {}));
    act(() => withDesktops(host, [xtermDesktop, gedit, xclock]));
    await act(() => Promise.resolve());

    for (const app of ['xterm', 'gedit', 'xclock']) expect(screen.queryByText(app)).toBeNull();
    expect(forgetVirtualDesktops).not.toHaveBeenCalled();
  });

  it("lists no noVNC address `komla desktop status` printed, which holds the desktop's password", async () => {
    withDesktops({ kind: 'local' }, [xtermDesktop]);
    recentOutput.mockReturnValue([
      {
        terminalId: 't1',
        executionLocation: 'workspace',
        logicalLines: [
          '  Local: http://localhost:5173/',
          'Browser view: http://127.0.0.1:6081/vnc.html?autoconnect=1&password=pa55word',
        ],
      },
    ]);
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [5173, 5901, 6081],
      ownOpenPorts: [5901],
      checkedAt: 2_000,
      otherServers: [],
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    await screen.findByText('localhost:5173');
    expect(await screen.findByText('xterm')).toBeTruthy();
    expect(screen.queryByText(/6081/)).toBeNull();
  });

  it('lists a desktop shown since the check began, as one restarted on its display', async () => {
    withDesktops({ kind: 'ssh', hostId: 'host-1' } as Workspace['backend'], [
      { ...xtermDesktop, shownAt: 3_000 },
    ]);
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [],
      remoteOpenPorts: [5173],
      ownOpenPorts: [],
      checkedAt: 2_000,
      otherServers: [],
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));

    expect(await screen.findByText('xterm')).toBeTruthy();
    expect(forgetVirtualDesktops).not.toHaveBeenCalled();
  });

  /** Opens the popover on a local workspace whose one running desktop is `desktop`. */
  async function openWithRunningDesktop(desktop: object) {
    withDesktops({ kind: 'local' }, [desktop]);
    detectDevPreviewServices.mockResolvedValue({
      services: [],
      openPorts: [5173],
      ownOpenPorts: [5901],
      checkedAt: 2_000,
      otherServers: [],
    });
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    return screen.findByText('xterm');
  }

  it('opens a virtual desktop in the VNC app it showed in, and closes', async () => {
    openVirtualDesktopInVncApp.mockResolvedValue(undefined);
    fireEvent.click(await openWithRunningDesktop(xtermDesktop));

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
    expect(screen.queryByRole('toolbar', { name: 'Servers and links' })).toBeNull();
  });

  /** The URLs of the browser tabs open in the workspace's panes. */
  function browserTabUrls() {
    return Object.values(usePaneSurfacesStore.getState().surfaces).flatMap((surface) =>
      surface.kind === 'browser' ? surface.browserTabs.map((tab) => tab.url) : []
    );
  }

  it("opens a virtual desktop's page in the workspace's browser on Shift+click", async () => {
    fireEvent.click(await openWithRunningDesktop(xtermDesktop), { shiftKey: true });

    expect(browserTabUrls()).toEqual([
      expect.stringMatching(/:6081\/vnc\.html\?autoconnect=1&password=pa55word$/),
    ]);
    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();
  });

  it("opens a virtual desktop in Komla's browser where this computer has no VNC app", async () => {
    const { vncApp: _none, ...browserDesktop } = xtermDesktop;
    fireEvent.click(await openWithRunningDesktop(browserDesktop));

    expect(browserTabUrls()).toEqual([expect.stringContaining(':6081/vnc.html')]);
    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();
  });

  it("offers the VNC app and Komla's browser in a virtual desktop's menu", async () => {
    openVirtualDesktopInVncApp.mockResolvedValue(undefined);
    fireEvent.contextMenu(await openWithRunningDesktop(xtermDesktop));
    expect(await screen.findByRole('menuitem', { name: 'Open in Komla' })).toBeTruthy();
    // Its page's address holds the password, which the default browser would keep.
    expect(screen.queryByRole('menuitem', { name: 'Open in Default Browser' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Screen Sharing' }));

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
  });

  it('offers only the VNC app for a desktop on a host without noVNC', async () => {
    openVirtualDesktopInVncApp.mockResolvedValue(undefined);
    const { url: _none, ...desktopWithoutPage } = xtermDesktop;
    fireEvent.contextMenu(await openWithRunningDesktop(desktopWithoutPage));
    const vncApp = await screen.findByRole('menuitem', { name: 'Open in Screen Sharing' });
    expect(screen.queryByRole('menuitem', { name: 'Open in Komla' })).toBeNull();
    fireEvent.click(vncApp);

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
  });

  it('reaches a virtual desktop with the arrow keys and opens it with Enter', async () => {
    openVirtualDesktopInVncApp.mockResolvedValue(undefined);
    await openWithRunningDesktop(xtermDesktop);
    await screen.findByText('localhost:5173');
    const list = screen.getByLabelText('Servers and links');

    // The server, then the desktop.
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
  });

  it('opens the files in the viewer from their section, the first one shown', async () => {
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [{ ...terminalFile('/tmp/printed.log'), printedAt: Date.now() }]);
    noteOpened('ws-1', terminalFile('/tmp/opened.log'));
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open all in viewer' }));

    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/opened.log');
  });
});
