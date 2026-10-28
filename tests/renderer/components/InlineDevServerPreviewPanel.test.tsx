/**
 * @vitest-environment jsdom
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateWorkspace = vi.fn().mockResolvedValue(undefined);
const hideDevPreview = vi.fn();
const reloadDevPreview = vi.fn().mockResolvedValue(true);
const syncDevPreview = vi.fn();
const updateWorkspaceStore = vi.fn();
const bumpReloadKey = vi.fn();
const startSshPreviewForward = vi.fn();
const stopSshPreviewForward = vi.fn().mockResolvedValue(undefined);
const detectDevPreviewServices = vi.fn();

// The browser pane under test, and its tabs' ids, which start with the pane's surface id.
const BROWSER_ID = 'surface:browser:test';
const TAB_1 = `${BROWSER_ID}/tab-1`;
const TAB_2 = `${BROWSER_ID}/tab-2`;

let remoteForwardState: any;
let workspaceDevServerUrl: string | undefined = 'http://localhost:5173';
let workspaceBackend: { kind: 'ssh' } | undefined;
let recentLinks: Array<{ url: string; printedAt?: number }> | undefined;
let workspaceHasTab = true;
let otherBrowserTabs: Array<{ id: string; url: string }> = [];
let activeBrowserTabId = TAB_1;
let navigationStateCallback: ((state: Record<string, unknown>) => void) | undefined;
let reloadKey = 0;
let probeKey = 0;
let lastWorktreeEventAt = 0;
let autoReload: boolean | undefined;
let defaultAutoReload = true;

vi.mock('../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: any) =>
    selector({
      config: { defaultDevServerPreviewAutoReload: defaultAutoReload },
    }),
}));

vi.mock('../../../src/renderer/stores/dev-server-preview.store', () => ({
  useDevServerPreviewStore: (selector: any) =>
    selector({
      reloadKeyByWorkspace: { [BROWSER_ID]: reloadKey },
      probeKeyByWorkspace: { [BROWSER_ID]: probeKey },
      remoteForwardByWorkspace: remoteForwardState
        ? { [BROWSER_ID]: { tabId: TAB_1, ...remoteForwardState } }
        : {},
      autoReloadByWorkspace: { 'ws-1': autoReload },
      bumpReloadKey,
      startSshPreviewForward,
      stopSshPreviewForward,
    }),
}));

afterEach(() => {
  vi.useRealTimers();
  remoteForwardState = undefined;
});

let scannerResult: string[] = [];
let scannerExecutionLocation: 'workspace' | 'local-mirror' = 'workspace';

vi.mock('../../../src/renderer/stores/workspaces.store', () => {
  const state = () => ({
    workspaces: [
      {
        id: 'ws-1',
        name: 'Test',
        backend: workspaceBackend,
        recentLinks,
      },
    ],
    updateWorkspace: updateWorkspaceStore,
  });
  return {
    useWorkspacesStore: Object.assign((selector: any) => selector(state()), { getState: state }),
  };
});

// The toolbar has its own tests.
vi.mock('../../../src/renderer/components/terminal/InlineDevServerPreviewHeader', () => ({
  InlineDevServerPreviewHeader: () => <div data-testid="browser-toolbar" />,
}));

/** The browser pane's tabs once the test's tab points at a URL. */
function tabUpdate(url: string, location: 'workspace' | 'local-mirror' = 'workspace') {
  return {
    browserTabs: [
      {
        id: TAB_1,
        url,
        ...(location === 'local-mirror' ? { urlExecutionLocation: location } : {}),
      },
    ],
    activeBrowserTabId: TAB_1,
  };
}

vi.mock('../../../src/renderer/stores/worktree-events.store', () => ({
  useWorktreeEventsStore: (selector: any) =>
    selector({
      lastEventByWorkspace: { 'ws-1': lastWorktreeEventAt },
    }),
}));

vi.mock('../../../src/renderer/lib/scan-terminal-urls', () => ({
  scanWorkspaceTerminalsForLinks: () => [],
  scanWorkspaceTerminalsForLocalhostUrlCandidates: () =>
    scannerResult.map((url, index) => ({
      url,
      terminalId: `terminal-${index}`,
      executionLocation: scannerExecutionLocation,
    })),
  parseLoopbackForwardIntent: (input: string) => {
    const url = new URL(input);
    const remotePort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (remotePort < 1) return null;
    const pathSuffix =
      url.pathname === '/' && !url.search && !url.hash
        ? ''
        : `${url.pathname}${url.search}${url.hash}`;
    return { remotePort, pathSuffix, scheme: url.protocol === 'https:' ? 'https' : 'http' };
  },
  isRootlessUrl: (url: string) => {
    try {
      const path = new URL(url).pathname;
      return !path || path === '/';
    } catch {
      return false;
    }
  },
}));

import { InlineDevServerPreviewPanel } from '../../../src/renderer/components/terminal/InlineDevServerPreviewPanel';
import {
  LIVE_REFRESH_MS,
  QUICK_REFRESH_MS,
  QUICK_REFRESHES,
} from '../../../src/renderer/hooks/useDevPreviewServices';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';

import type { BrowserTabsState } from '../../../src/shared/lib/browser-tabs';

/** The browser pane's tabs as the test's variables describe them. */
function seededTabs(): BrowserTabsState {
  // The panel adds a tab when a browser has none, so every browser here has one.
  return {
    browserTabs: workspaceHasTab
      ? [{ id: TAB_1, url: workspaceDevServerUrl ?? '' }, ...otherBrowserTabs]
      : [],
    activeBrowserTabId: workspaceHasTab ? activeBrowserTabId : undefined,
  };
}

// Each change the panel makes to the browser pane's tabs, as the pane store saw it.
let tabWrites: BrowserTabsState[] = [];
let seeding = false;
let lastSeeded: string | null = null;
usePaneSurfacesStore.subscribe((state, previous) => {
  const surface = state.surfaces[BROWSER_ID];
  if (seeding || surface === previous.surfaces[BROWSER_ID] || surface?.kind !== 'browser') return;
  tabWrites.push({
    browserTabs: surface.browserTabs,
    activeBrowserTabId: surface.activeBrowserTabId,
  });
});

/**
 * The panel for the test's browser pane. The pane's tabs follow the test's
 * variables whenever those change, and keep the panel's own changes otherwise.
 */
function panel(props: { isActive?: boolean } = {}) {
  const tabs = seededTabs();
  const key = JSON.stringify(tabs);
  if (key !== lastSeeded) {
    lastSeeded = key;
    act(() => {
      seeding = true;
      usePaneSurfacesStore.setState((state) => ({
        surfaces: {
          ...state.surfaces,
          [BROWSER_ID]: { kind: 'browser', workspaceId: 'ws-1', ...tabs },
        },
      }));
      seeding = false;
    });
  }
  return <InlineDevServerPreviewPanel workspaceId="ws-1" browserId={BROWSER_ID} {...props} />;
}

/** Lets the mocked detection answer so the panel can decide. */
async function settleDetection(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  updateWorkspace.mockReset();
  updateWorkspaceStore.mockReset();
  bumpReloadKey.mockReset();
  startSshPreviewForward.mockReset();
  stopSshPreviewForward.mockReset();
  stopSshPreviewForward.mockResolvedValue(undefined);
  usePaneSurfacesStore.setState({ surfaces: {} });
  tabWrites = [];
  lastSeeded = null;
  workspaceDevServerUrl = 'http://localhost:5173';
  workspaceBackend = undefined;
  recentLinks = undefined;
  workspaceHasTab = true;
  otherBrowserTabs = [];
  activeBrowserTabId = TAB_1;
  navigationStateCallback = undefined;
  lastWorktreeEventAt = 0;
  autoReload = undefined;
  defaultAutoReload = true;
  scannerResult = [];
  scannerExecutionLocation = 'workspace';
  reloadKey = 0;
  probeKey = 0;
  hideDevPreview.mockReset();
  reloadDevPreview.mockReset();
  reloadDevPreview.mockResolvedValue(true);
  syncDevPreview.mockReset();
  // Default: every printed URL still answers and no other ports are listening.
  detectDevPreviewServices.mockReset();
  detectDevPreviewServices.mockImplementation(
    async (_workspaceId: string, ports: number[], remotePorts: number[]) => ({
      services: [],
      otherServers: [],
      openPorts: ports,
      remoteOpenPorts: remotePorts,
    })
  );
  (window as any).api = {
    detectDevPreviewServices,
    getLinkPreview: vi.fn().mockResolvedValue(null),
    hideDevPreview,
    onDevPreviewNavigationStateChanged: vi.fn((callback) => {
      navigationStateCallback = callback;
      return vi.fn();
    }),
    onDevPreviewSnapshotUpdated: vi.fn(() => vi.fn()),
    reloadDevPreview,
    syncDevPreview,
    updateWorkspace,
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 500,
    height: 400,
    left: 100,
    right: 700,
    top: 100,
    width: 600,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
  // Default: probe succeeds so the native view renders. Individual tests override
  // this to simulate an unreachable dev server.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));
});

describe('InlineDevServerPreviewPanel', () => {
  it('adds a tab when the browser has none', () => {
    workspaceHasTab = false;
    render(panel());

    expect(tabWrites).toEqual([
      {
        browserTabs: [{ id: expect.stringMatching(/^surface:browser:test\/browser-/), url: '' }],
        activeBrowserTabId: expect.stringMatching(/^surface:browser:test\/browser-/),
      },
    ]);
    expect(syncDevPreview).not.toHaveBeenCalled();
  });

  it('shows one toolbar after switching from a page to a new tab', () => {
    otherBrowserTabs = [{ id: TAB_2, url: '' }];
    const { rerender } = render(panel());
    expect(screen.getByTitle('HTTP server preview')).toBeTruthy();

    activeBrowserTabId = TAB_2;
    rerender(panel());

    expect(screen.getAllByTestId('browser-toolbar')).toHaveLength(1);
    expect(screen.queryByTitle('HTTP server preview')).toBeNull();
  });

  it('loads other sites without probing them, and says why one failed to load', async () => {
    workspaceDevServerUrl = 'https://example.com/docs';
    render(panel());

    expect(fetch).not.toHaveBeenCalled();
    expect(syncDevPreview).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      'https://example.com/docs',
      expect.any(Object)
    );

    act(() =>
      navigationStateCallback?.({
        workspaceId: 'ws-1',
        tabId: TAB_1,
        url: 'https://example.com/docs',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loadError: 'ERR_NAME_NOT_RESOLVED',
      })
    );
    expect(screen.getByText('ERR_NAME_NOT_RESOLVED')).toBeTruthy();
    expect(screen.queryByTitle('HTTP server preview')).toBeNull();

    syncDevPreview.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.queryByText('ERR_NAME_NOT_RESOLVED')).toBeNull();
    expect(syncDevPreview).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      'https://example.com/docs',
      expect.any(Object)
    );
  });

  it('ignores a load failure of another tab', () => {
    workspaceDevServerUrl = 'https://example.com/docs';
    render(panel());

    act(() =>
      navigationStateCallback?.({
        workspaceId: 'ws-1',
        tabId: TAB_2,
        url: 'https://example.org/',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loadError: 'ERR_CONNECTION_REFUSED',
      })
    );

    expect(screen.queryByText('ERR_CONNECTION_REFUSED')).toBeNull();
    expect(screen.getByTitle('HTTP server preview')).toBeTruthy();
  });

  it('forwards its own saved SSH URL when the tunnel serves another tab', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242/';
    remoteForwardState = {
      tabId: TAB_2,
      status: 'active',
      remotePort: 3000,
      savedUrl: 'http://localhost:3000/',
      forward: { localUrl: 'http://127.0.0.1:59321', localPort: 59321 },
    };
    render(panel());

    expect(startSshPreviewForward).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      4242,
      '',
      'http',
      'http://localhost:4242/'
    );
    expect(syncDevPreview).not.toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      expect.stringContaining('59321'),
      expect.any(Object)
    );
  });

  it('syncs a native preview pointed at the persisted URL', () => {
    render(panel());

    expect(screen.getByTitle('HTTP server preview')).toBeTruthy();
    expect(syncDevPreview).toHaveBeenCalledWith('ws-1', TAB_1, 'http://localhost:5173', {
      x: 100,
      y: 100,
      width: 600,
      height: 400,
    });
  });

  it('keeps forwarded double-slash paths on the local native-view origin', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242//example.com/escape?tab=preview';
    remoteForwardState = {
      status: 'active',
      remotePort: 4242,
      pathSuffix: '//example.com/escape?tab=preview',
      savedUrl: workspaceDevServerUrl,
      forward: {
        localUrl: 'http://127.0.0.1:59321',
        localPort: 59321,
        remotePort: 4242,
        workspaceId: 'ws-1',
      },
    };
    render(panel());

    expect(syncDevPreview).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      'http://127.0.0.1:59321//example.com/escape?tab=preview',
      expect.any(Object)
    );
  });

  it('forwards a persisted SSH preview URL without terminal output', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242/app?tab=preview';

    render(<StrictMode>{panel()}</StrictMode>);

    expect(startSshPreviewForward).toHaveBeenCalledTimes(1);
    expect(startSshPreviewForward).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      4242,
      '/app?tab=preview',
      'http',
      'http://localhost:4242/app?tab=preview'
    );
  });

  it('preserves HTTPS defaults when forwarding a persisted SSH preview URL', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'https://localhost/dashboard';

    render(panel());

    expect(startSshPreviewForward).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      443,
      '/dashboard',
      'https',
      'https://localhost/dashboard'
    );
  });

  it('waits until a persisted SSH preview is active before forwarding', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242';
    const { rerender } = render(panel({ isActive: false }));

    expect(startSshPreviewForward).not.toHaveBeenCalled();

    rerender(panel({ isActive: true }));

    expect(startSshPreviewForward).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'starting', 'active', 'failed'])(
    'does not restart a matching %s persisted SSH forward',
    (status) => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = 'http://localhost:4242/app';
      remoteForwardState = {
        status,
        remotePort: 4242,
        pathSuffix: '/app',
        scheme: 'http',
        savedUrl: 'http://localhost:4242/app',
      };

      render(panel());

      expect(startSshPreviewForward).not.toHaveBeenCalled();
    }
  );

  it.each(['pending', 'failed', 'stopped'])(
    'forwards a URL saved after a %s SSH forward request',
    (status) => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = 'http://localhost:4242/app';
      remoteForwardState = { status, remotePort: 8080, savedUrl: workspaceDevServerUrl };
      const { rerender } = render(panel());

      expect(startSshPreviewForward).not.toHaveBeenCalled();

      workspaceDevServerUrl = 'http://localhost:5173/';
      rerender(panel());

      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        5173,
        '',
        'http',
        'http://localhost:5173/'
      );
    }
  );

  it('shows no forward prompt while switching away from a remote URL', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242/app';
    remoteForwardState = {
      status: 'stopping',
      remotePort: 4242,
      pathSuffix: '/app',
      savedUrl: workspaceDevServerUrl,
    };
    render(panel());

    expect(screen.queryByText('Forward 4242')).toBeNull();
    expect(startSshPreviewForward).not.toHaveBeenCalled();
    expect(syncDevPreview).not.toHaveBeenCalled();
  });

  it('reconnects a saved SSH URL after a restart clears its tunnel and follows a new target', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242/app';
    const activeForward = {
      status: 'active',
      remotePort: 4242,
      pathSuffix: '/app',
      scheme: 'http',
      savedUrl: 'http://localhost:4242/app',
    };
    const { rerender } = render(panel());

    expect(startSshPreviewForward).toHaveBeenCalledTimes(1);

    remoteForwardState = activeForward;
    rerender(panel());
    expect(startSshPreviewForward).toHaveBeenCalledTimes(1);

    remoteForwardState = undefined;
    rerender(panel());
    expect(screen.getByText('Starting SSH tunnel for remote port 4242...')).toBeTruthy();
    expect(startSshPreviewForward).toHaveBeenCalledTimes(2);

    remoteForwardState = activeForward;
    workspaceDevServerUrl = 'http://localhost:5555/studio';
    rerender(panel());

    expect(startSshPreviewForward).toHaveBeenCalledTimes(3);
    expect(startSshPreviewForward).toHaveBeenLastCalledWith(
      'ws-1',
      TAB_1,
      5555,
      '/studio',
      'http',
      'http://localhost:5555/studio'
    );
  });

  it('waits for a click to forward a saved SSH URL after the user stops its tunnel', () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = 'http://localhost:4242/app';
    remoteForwardState = {
      status: 'stopped',
      remotePort: 4242,
      pathSuffix: '/app',
      savedUrl: workspaceDevServerUrl,
    };
    render(<StrictMode>{panel()}</StrictMode>);

    expect(startSshPreviewForward).not.toHaveBeenCalled();
    expect(syncDevPreview).not.toHaveBeenCalled();
    expect(screen.queryByTitle('HTTP server preview')).toBeNull();
    fireEvent.click(screen.getByText('Forward 4242'));

    expect(startSshPreviewForward).toHaveBeenCalledTimes(1);
    expect(startSshPreviewForward).toHaveBeenLastCalledWith(
      'ws-1',
      TAB_1,
      4242,
      '/app',
      'http',
      'http://localhost:4242/app'
    );
    // The URL is already saved, so forwarding it again doesn't rewrite it.
    expect(tabWrites).toEqual([]);
  });

  it('does not forward a detected remote URL after the user stops a tunnel', async () => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = undefined;
    scannerResult = ['http://localhost:5173/'];
    remoteForwardState = { status: 'stopped', remotePort: 4242 };
    render(panel());
    await settleDetection();

    expect(startSshPreviewForward).not.toHaveBeenCalled();
    expect(tabWrites).toEqual([]);
    fireEvent.click(screen.getByText('Forward 5173'));

    expect(startSshPreviewForward).toHaveBeenCalledWith(
      'ws-1',
      TAB_1,
      5173,
      '',
      'http',
      'http://localhost:5173/'
    );
  });

  it.each([
    ['pending', 'Forward remote port 8080'],
    ['starting', 'Starting SSH tunnel for remote port 8080...'],
    ['failed', "Couldn't forward remote port 8080"],
  ])('keeps a %s SSH forward request over a detected remote URL', async (status, text) => {
    workspaceBackend = { kind: 'ssh' };
    workspaceDevServerUrl = undefined;
    scannerResult = ['http://localhost:5173/'];
    remoteForwardState = { status, remotePort: 8080 };
    render(panel());
    await settleDetection();

    expect(screen.getByText(text)).toBeTruthy();
    expect(startSshPreviewForward).not.toHaveBeenCalled();
    expect(tabWrites).toEqual([]);
  });

  it('does not mount or probe the native view while the workspace layer is inactive', () => {
    render(panel({ isActive: false }));

    expect(screen.queryByTitle('HTTP server preview')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(reloadDevPreview).not.toHaveBeenCalled();
  });

  it('does not embed dev-server content in the Komla renderer', () => {
    render(panel());

    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('native-dev-preview-host')).toBeTruthy();
  });

  describe('first-open auto-pick', () => {
    it('lets the user choose in a tab added beside another', async () => {
      workspaceDevServerUrl = undefined;
      otherBrowserTabs = [{ id: TAB_2, url: 'http://localhost:5173/' }];
      scannerResult = ['http://localhost:5173/'];
      render(panel());
      await settleDetection();

      expect(screen.getByText('Choose what to preview')).toBeTruthy();
      expect(tabWrites).toEqual([]);
      expect(syncDevPreview).not.toHaveBeenCalled();
    });

    it('auto-picks the only rootless URL even when path-bearing URLs are also present', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/', 'http://localhost:5173/api/users'];
      render(panel());
      await settleDetection();

      expect(syncDevPreview).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        'http://localhost:5173/',
        expect.any(Object)
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/'));
    });

    it('auto-picks when localhost and 127.0.0.1 aliases collapse to one root URL', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = [
        'http://localhost:65136/',
        'http://127.0.0.1:65136/',
        'http://127.0.0.1:65136/cdn-cgi/handler/scheduled',
      ];
      render(panel());
      await settleDetection();

      expect(syncDevPreview).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        'http://localhost:65136/',
        expect.any(Object)
      );
      expect(screen.queryByText('Choose what to preview')).toBeNull();
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:65136/'));
    });

    it('preserves the emitted 127.0.0.1 URL when auto-picking aliases', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://127.0.0.1:65136/', 'http://localhost:65136/'];
      render(panel());
      await settleDetection();

      expect(syncDevPreview).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        'http://127.0.0.1:65136/',
        expect.any(Object)
      );
      expect(screen.queryByText('Choose what to preview')).toBeNull();
      expect(tabWrites).toContainEqual(tabUpdate('http://127.0.0.1:65136/'));
    });

    it('auto-picks the single candidate when there is only one URL', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:3000/dashboard'];
      render(panel());
      await settleDetection();

      expect(syncDevPreview).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        'http://localhost:3000/dashboard',
        expect.any(Object)
      );
    });

    it('shows the picker when only path-bearing URLs are found (banner scrolled out)', async () => {
      // No rootless URL means the dev-server banner has aged out of the
      // 500-line scrollback window; what's left is request logs from one or
      // more servers. We can't tell which port is "the" app — defer to the
      // user instead of auto-loading some random deep page.
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:3000/api/users', 'http://localhost:4000/health'];
      render(panel());

      expect(await screen.findByText('Choose what to preview')).toBeTruthy();
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();
      expect(tabWrites).toEqual([]);
    });

    it('shows the picker when 2+ rootless URLs are ambiguous (e.g. dev server + Prisma Studio)', async () => {
      // The scan can't tell Vite from Prisma Studio — both are rootless on
      // different ports. Surface both so the user decides instead of silently
      // landing on the wrong one.
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/', 'http://localhost:5555/'];
      render(panel());

      expect(await screen.findByText('Choose what to preview')).toBeTruthy();
      expect(await screen.findByText('localhost:5173')).toBeTruthy();
      expect(screen.getByText('localhost:5555')).toBeTruthy();
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();
      expect(tabWrites).toEqual([]);
    });

    it('clicking a candidate in the picker saves it in the tab', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/', 'http://localhost:5555/'];
      render(panel());

      fireEvent.click(await screen.findByText('localhost:5555'));

      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5555/'));
    });

    it('falls through to the empty state when the scan finds nothing', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      render(panel());

      expect(await screen.findByText('No HTTP server detected yet.')).toBeTruthy();
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();
      expect(tabWrites).toEqual([]);
    });

    it('lists the workspace links when no server runs, and opens one in the tab', async () => {
      workspaceDevServerUrl = undefined;
      recentLinks = [{ url: 'https://github.com/acme/app/pull/9', printedAt: Date.now() }];
      render(panel());

      expect(await screen.findByText('No HTTP server detected yet.')).toBeTruthy();
      fireEvent.click(await screen.findByText('/acme/app/pull/9'));

      expect(tabWrites).toContainEqual(tabUpdate('https://github.com/acme/app/pull/9'));
      expect(updateWorkspaceStore).toHaveBeenCalledWith('ws-1', {
        recentLinks: [expect.objectContaining({ openedAt: expect.any(Number) })],
      });
    });

    it('shows an explicit forward control for SSH workspaces when no URL is detected', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      render(panel());

      expect(await screen.findByText('No remote HTTP server detected yet.')).toBeTruthy();
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();
      expect(startSshPreviewForward).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '4242' } });
      fireEvent.click(screen.getByText('Forward'));

      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        4242,
        '',
        'http',
        'http://localhost:4242'
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:4242'));
    });

    it('does not forward invalid manually entered SSH ports', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      render(panel());

      fireEvent.change(await screen.findByLabelText('Remote port'), { target: { value: '70000' } });
      fireEvent.click(screen.getByText('Forward'));

      expect(startSshPreviewForward).not.toHaveBeenCalled();
    });

    it('shows an explicit forward button for pending SSH address-field requests', () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      remoteForwardState = {
        status: 'pending',
        remotePort: 4242,
        pathSuffix: '/app?tab=preview',
      };
      render(panel());

      expect(screen.getByText('Forward remote port 4242')).toBeTruthy();
      expect(screen.getByText(/http:\/\/localhost:4242/)).toBeTruthy();
      expect(startSshPreviewForward).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('Forward 4242'));

      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        4242,
        '/app?tab=preview',
        'http',
        'http://localhost:4242/app?tab=preview'
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:4242/app?tab=preview'));
    });

    it('forwards the only URL detected in a remote SSH terminal', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/dashboard?tab=app'];
      render(panel());
      await settleDetection();

      expect(screen.getByText('Starting SSH tunnel for remote port 5173...')).toBeTruthy();
      expect(screen.queryByText('Forward remote port 5173')).toBeNull();
      expect(syncDevPreview).not.toHaveBeenCalled();
      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        5173,
        '/dashboard?tab=app',
        'http',
        'http://localhost:5173/dashboard?tab=app'
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/dashboard?tab=app'));
    });

    it('ignores a remote URL that cannot be forwarded', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:0/'];
      render(panel());

      expect(await screen.findByText('No remote HTTP server detected yet.')).toBeTruthy();
      expect(startSshPreviewForward).not.toHaveBeenCalled();
    });

    it('opens a URL detected in a local-mirror terminal without SSH forwarding', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerExecutionLocation = 'local-mirror';
      scannerResult = ['http://localhost:5173/'];

      render(panel());
      await settleDetection();

      expect(screen.getByTitle('HTTP server preview')).toBeTruthy();
      expect(screen.queryByText('Forward remote port 5173')).toBeNull();
      expect(startSshPreviewForward).not.toHaveBeenCalled();
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/', 'local-mirror'));
    });

    it('forwards the selected candidate for SSH workspaces', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/api', 'http://localhost:5555/studio'];
      render(panel());

      fireEvent.click(await screen.findByText('localhost:5555/studio'));

      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        5555,
        '/studio',
        'http',
        'http://localhost:5555/studio'
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5555/studio'));
    });

    it('rescans and auto-picks when auto reload sees a worktree change after an empty scan', async () => {
      workspaceDevServerUrl = undefined;
      autoReload = true;
      scannerResult = [];
      const { rerender } = render(panel());

      expect(await screen.findByText('No HTTP server detected yet.')).toBeTruthy();

      scannerResult = ['http://localhost:5173/'];
      lastWorktreeEventAt = 1000;
      rerender(panel());
      await settleDetection();

      expect(syncDevPreview).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        'http://localhost:5173/',
        expect.any(Object)
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/'));
    });

    it('rescans and shows options when auto reload finds ambiguous URLs after an empty scan', async () => {
      workspaceDevServerUrl = undefined;
      autoReload = true;
      scannerResult = [];
      const { rerender } = render(panel());

      scannerResult = ['http://localhost:5173/', 'http://localhost:5555/'];
      lastWorktreeEventAt = 1000;
      rerender(panel());

      expect(await screen.findByText('Choose what to preview')).toBeTruthy();
      expect(await screen.findByText('localhost:5173')).toBeTruthy();
      expect(screen.getByText('localhost:5555')).toBeTruthy();
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();
      expect(tabWrites).toEqual([]);
    });

    it('auto-picks the only printed URL that still answers when the others stopped', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:3000/', 'http://localhost:5173/'];
      detectDevPreviewServices.mockResolvedValue({
        services: [],
        otherServers: [],
        openPorts: [5173],
      });
      render(panel());

      await waitFor(() => {
        expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/'));
      });
      expect(detectDevPreviewServices).toHaveBeenCalledWith('ws-1', [3000, 5173], [], []);
      expect(screen.queryByText('Choose what to preview')).toBeNull();
    });

    it('marks printed URLs nothing answers on as not running', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:3000/', 'http://localhost:5173/'];
      detectDevPreviewServices.mockResolvedValue({ services: [], otherServers: [], openPorts: [] });
      render(panel());

      expect(await screen.findAllByText('not running')).toHaveLength(2);
      expect(screen.getByText('localhost:3000')).toBeTruthy();
      expect(screen.getByText('localhost:5173')).toBeTruthy();
      expect(tabWrites).toEqual([]);
    });

    it('offers a port a terminal process listens on without opening it on its own', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      detectDevPreviewServices.mockResolvedValue({
        services: [
          {
            port: 5173,
            scheme: 'http',
            pid: 42,
            processName: 'node',
            terminalId: 'terminal-0',
            executionLocation: 'workspace',
          },
        ],
        otherServers: [],
        openPorts: [],
      });
      render(panel());

      // The row names the process; picking it saves it, which shows the page.
      const row = await screen.findByText('localhost:5173');
      expect(screen.getByText('node')).toBeTruthy();
      expect(tabWrites).toEqual([]);
      fireEvent.click(row);

      expect(tabWrites).toHaveLength(1);
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/'));
    });

    it('keeps ports that do not answer HTTP out of the picker', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      detectDevPreviewServices.mockResolvedValue({
        services: [
          {
            port: 5432,
            scheme: null,
            pid: 42,
            processName: 'postgres',
            terminalId: 'terminal-0',
            executionLocation: 'workspace',
          },
        ],
        otherServers: [],
        openPorts: [],
      });
      render(panel());

      expect(await screen.findByText('No HTTP server detected yet.')).toBeTruthy();
      expect(screen.queryByText('postgres')).toBeNull();
    });

    it('checks remote URLs on the SSH host and forwards the only one still running', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/api', 'http://localhost:5555/studio'];
      detectDevPreviewServices.mockResolvedValue({
        services: [],
        otherServers: [],
        openPorts: [],
        remoteOpenPorts: [5555],
      });
      render(panel());

      await waitFor(() => {
        expect(startSshPreviewForward).toHaveBeenCalledWith(
          'ws-1',
          TAB_1,
          5555,
          '/studio',
          'http',
          'http://localhost:5555/studio'
        );
      });
      expect(detectDevPreviewServices).toHaveBeenCalledWith('ws-1', [], [5173, 5555], []);
    });

    it('offers a port a remote terminal listens on for forwarding', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      detectDevPreviewServices.mockResolvedValue({
        services: [
          {
            port: 8000,
            scheme: 'http',
            pid: 42,
            processName: 'python3',
            terminalId: 'terminal-0',
            executionLocation: 'workspace',
          },
        ],
        otherServers: [],
        openPorts: [],
        remoteOpenPorts: [],
      });
      render(panel());

      // The row names the process; picking it saves it, which starts the tunnel.
      const row = await screen.findByText('localhost:8000');
      expect(screen.getByText('python3')).toBeTruthy();
      fireEvent.click(row);

      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        8000,
        '',
        'http',
        'http://localhost:8000/'
      );
    });

    it('lists servers outside Komla when the terminals run none', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      detectDevPreviewServices.mockResolvedValue({
        services: [],
        otherServers: [
          { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
        ],
        openPorts: [],
      });
      render(panel());

      expect(await screen.findByText('Outside Komla')).toBeTruthy();
      expect(tabWrites).toEqual([]);

      fireEvent.click(screen.getByText('localhost:8765'));

      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:8765/'));
    });

    it('says it is checking for running servers while detection runs', () => {
      workspaceDevServerUrl = undefined;
      scannerResult = [];
      detectDevPreviewServices.mockReturnValue(new Promise(() => {}));
      render(panel());

      expect(screen.getByText('Checking running servers…')).toBeTruthy();
      expect(screen.queryByText('No HTTP server detected yet.')).toBeNull();
    });

    it('checks again instead of reusing the last answer when the browser is shown again', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:3000/', 'http://localhost:5173/'];
      detectDevPreviewServices.mockResolvedValue({ services: [], otherServers: [], openPorts: [] });
      const { rerender } = render(panel());
      expect(await screen.findAllByText('not running')).toHaveLength(2);

      rerender(panel({ isActive: false }));
      detectDevPreviewServices.mockReturnValue(new Promise(() => {}));
      rerender(panel({ isActive: true }));

      expect(screen.getByText('Checking running servers…')).toBeTruthy();
      expect(screen.queryByText('not running')).toBeNull();
    });

    it('lists a running server instead of opening a stale URL left in scrollback', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:4780/'];
      detectDevPreviewServices.mockResolvedValue({
        services: [
          {
            port: 4777,
            scheme: 'http',
            pid: 42,
            processName: 'node',
            terminalId: 'terminal-0',
            executionLocation: 'workspace',
          },
        ],
        otherServers: [],
        openPorts: [],
      });
      render(panel());

      expect(await screen.findByText('localhost:4777')).toBeTruthy();
      // The stale URL waits behind Show more.
      expect(screen.queryByText('localhost:4780')).toBeNull();
      fireEvent.click(screen.getByText('Show 1 more…'));
      expect(screen.getByText('localhost:4780')).toBeTruthy();
      expect(tabWrites).toEqual([]);
      expect(syncDevPreview).not.toHaveBeenCalled();
    });

    it('keeps looking for a server while the pane waits for one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        workspaceDevServerUrl = undefined;
        scannerResult = [];
        render(panel());
        expect(await screen.findByText('No HTTP server detected yet.')).toBeTruthy();

        scannerResult = ['http://localhost:5173/'];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
        });

        expect(tabWrites).toContainEqual(tabUpdate('http://localhost:5173/'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('looks every second at first, then every few seconds, again each time the pane is shown', async () => {
      vi.useFakeTimers();
      try {
        workspaceDevServerUrl = undefined;
        scannerResult = [];
        const { rerender } = render(panel());
        const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
        await wait(0);
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(1);
        for (let check = 2; check <= QUICK_REFRESHES + 1; check++) {
          await wait(QUICK_REFRESH_MS);
          expect(detectDevPreviewServices).toHaveBeenCalledTimes(check);
        }
        await wait(LIVE_REFRESH_MS - 1);
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(QUICK_REFRESHES + 1);

        rerender(panel({ isActive: false }));
        rerender(panel({ isActive: true }));
        await wait(0);
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(QUICK_REFRESHES + 2);
        await wait(QUICK_REFRESH_MS);
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(QUICK_REFRESHES + 3);
      } finally {
        vi.useRealTimers();
      }
    });

    function fakeWindowVisibility(): {
      setVisibility: (state: DocumentVisibilityState) => void;
      restore: () => void;
    } {
      let visibilityState: DocumentVisibilityState = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState,
      });
      return {
        setVisibility: (state) => {
          visibilityState = state;
          document.dispatchEvent(new Event('visibilitychange'));
        },
        restore: () => Reflect.deleteProperty(document, 'visibilityState'),
      };
    }

    it('waits for a hidden window to show before looking again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { setVisibility, restore } = fakeWindowVisibility();
      try {
        workspaceDevServerUrl = undefined;
        scannerResult = [];
        render(panel());
        expect(await screen.findByText('No HTTP server detected yet.')).toBeTruthy();
        detectDevPreviewServices.mockClear();

        act(() => setVisibility('hidden'));
        for (let poll = 0; poll < 3; poll += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
          });
        }
        expect(detectDevPreviewServices).not.toHaveBeenCalled();

        await act(async () => setVisibility('visible'));
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(1);
      } finally {
        restore();
        vi.useRealTimers();
      }
    });

    it('keeps an answer that arrives while the window is hidden', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { setVisibility, restore } = fakeWindowVisibility();
      try {
        workspaceDevServerUrl = undefined;
        scannerResult = [];
        let answer: () => void = () => {};
        detectDevPreviewServices.mockReturnValueOnce(
          new Promise((resolve) => {
            answer = () =>
              resolve({ services: [], otherServers: [], openPorts: [], remoteOpenPorts: null });
          })
        );
        render(panel());

        act(() => setVisibility('hidden'));
        await act(async () => answer());
        await act(async () => setVisibility('visible'));

        expect(screen.getByText('No HTTP server detected yet.')).toBeTruthy();
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(QUICK_REFRESH_MS);
        });
        expect(detectDevPreviewServices).toHaveBeenCalledTimes(2);
      } finally {
        restore();
        vi.useRealTimers();
      }
    });

    it('decides from the scan alone when detection fails', async () => {
      workspaceDevServerUrl = undefined;
      scannerResult = ['http://localhost:5173/', 'http://localhost:5555/'];
      detectDevPreviewServices.mockRejectedValue(new Error('IPC failed'));
      render(panel());

      expect(await screen.findByText('Choose what to preview')).toBeTruthy();
      expect(await screen.findByText('localhost:5173')).toBeTruthy();
      expect(screen.getByText('localhost:5555')).toBeTruthy();
      expect(screen.queryByText('not running')).toBeNull();
    });

    it('does not auto-pick (or scan-overwrite) once a URL is already persisted', () => {
      // Stale candidates from an old dev-server run must not clobber the
      // URL the user already settled on.
      scannerResult = ['http://localhost:9999/'];
      render(panel());

      expect(syncDevPreview).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        'http://localhost:5173',
        expect.any(Object)
      );
      expect(tabWrites).toEqual([]);
    });
  });

  it('keeps the native host mounted when the reload counter bumps', () => {
    reloadKey = 0;
    const { rerender } = render(panel());
    const firstHost = screen.getByTitle('HTTP server preview');

    reloadKey = 1;
    rerender(panel());
    const afterHost = screen.getByTitle('HTTP server preview');

    expect(afterHost).toBe(firstHost);
  });

  it('asks main to reload the native preview when the reload counter bumps', () => {
    reloadKey = 0;
    const { rerender } = render(panel());

    reloadKey = 1;
    rerender(panel());

    expect(reloadDevPreview).toHaveBeenCalledWith('ws-1', TAB_1);
  });

  it('debounces a preview reload when workspace files change and auto reload is enabled', () => {
    vi.useFakeTimers();
    autoReload = true;
    const { rerender } = render(panel());

    lastWorktreeEventAt = 1000;
    rerender(panel());

    expect(bumpReloadKey).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(bumpReloadKey).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(bumpReloadKey).toHaveBeenCalledWith(BROWSER_ID);

    vi.useRealTimers();
  });

  it('reloads a local tab that missed file changes once, when it is shown again', () => {
    vi.useFakeTimers();
    autoReload = true;
    otherBrowserTabs = [{ id: TAB_2, url: 'http://localhost:6006/' }];
    const show = (tabId: string) => {
      activeBrowserTabId = tabId;
      rerender(panel());
      vi.advanceTimersByTime(250);
    };
    const { rerender } = render(panel());
    show(TAB_2);

    lastWorktreeEventAt = 1000;
    show(TAB_2);
    expect(bumpReloadKey).toHaveBeenCalledTimes(1);

    show(TAB_1);
    expect(bumpReloadKey).toHaveBeenCalledTimes(2);
    show(TAB_2);
    show(TAB_1);
    expect(bumpReloadKey).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it.each([
    ['other sites', 'https://example.com/', 0],
    ['*.localhost pages', 'http://app.localhost:3000/', 1],
  ])('reloads %s on file changes only when they are on this computer', (_, url, reloads) => {
    vi.useFakeTimers();
    autoReload = true;
    workspaceDevServerUrl = url;
    const { rerender } = render(panel());

    lastWorktreeEventAt = 1000;
    rerender(panel());
    vi.advanceTimersByTime(250);

    expect(bumpReloadKey).toHaveBeenCalledTimes(reloads);
    vi.useRealTimers();
  });

  it('does not auto-reload when auto reload is disabled', () => {
    vi.useFakeTimers();
    autoReload = false;
    const { rerender } = render(panel());

    lastWorktreeEventAt = 1000;
    rerender(panel());
    vi.advanceTimersByTime(250);

    expect(bumpReloadKey).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('uses the configured default auto reload state before a workspace override exists', () => {
    vi.useFakeTimers();
    defaultAutoReload = false;
    const { rerender } = render(panel());

    lastWorktreeEventAt = 1000;
    rerender(panel());
    vi.advanceTimersByTime(250);

    expect(bumpReloadKey).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not auto-reload for worktree changes that happened before the preview mounted', () => {
    vi.useFakeTimers();
    autoReload = true;
    lastWorktreeEventAt = 1000;

    render(panel());
    vi.advanceTimersByTime(250);

    expect(bumpReloadKey).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  describe('unreachable URL handling', () => {
    it('replaces the native view with a "couldn\'t reach" message when the probe fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      render(panel());

      await screen.findByText(/Couldn't reach/);
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();
      expect(screen.getByText(/Make sure your HTTP server is running/)).toBeTruthy();
    });

    it('lists running servers without replacing the stored URL when it stops answering', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      workspaceDevServerUrl = 'http://localhost:60952';
      scannerResult = ['http://localhost:61234/', 'http://localhost:60952/'];
      detectDevPreviewServices.mockResolvedValue({
        services: [
          {
            port: 61234,
            scheme: 'http',
            pid: 42,
            processName: 'workerd',
            terminalId: 'terminal-0',
            executionLocation: 'workspace',
          },
        ],
        otherServers: [],
        openPorts: [],
      });
      render(panel());

      const running = await screen.findByText('localhost:61234');
      expect(screen.getByText(/Couldn't reach/)).toBeTruthy();
      expect(screen.queryByText('localhost:60952')).toBeNull();
      expect(tabWrites).toEqual([]);

      fireEvent.click(running);

      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:61234/'));
    });

    it('loads the stored URL again when it is picked once its server is back', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      scannerResult = ['http://localhost:5173/'];
      render(panel());

      fireEvent.click(await screen.findByText('localhost:5173'));

      expect(bumpReloadKey).toHaveBeenCalledWith(BROWSER_ID);
      expect(tabWrites).toEqual([]);
    });

    it('the "Try again" button bumps the reload key', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      render(panel());

      const retryButton = await screen.findByRole('button', { name: /Try again/ });
      fireEvent.click(retryButton);

      expect(bumpReloadKey).toHaveBeenCalledWith(BROWSER_ID);
    });

    it('restarts an expired reachability probe when the probe counter bumps', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue(new Response());
      vi.stubGlobal('fetch', fetchMock);
      const { rerender } = render(panel());

      await screen.findByText(/Couldn't reach/);
      probeKey = 1;
      rerender(panel());

      expect(await screen.findByTitle('HTTP server preview')).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reloadDevPreview).not.toHaveBeenCalled();
    });

    it('auto-retries and mounts the native host once a booting dev server answers', async () => {
      // Agents commonly open the preview while the dev server is still
      // starting: the first probe fails, but the panel keeps polling and the
      // The native view should appear on its own — no "Try again" click needed.
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue(new Response());
      vi.stubGlobal('fetch', fetchMock);

      render(panel());

      await screen.findByText(/Couldn't reach/);
      expect(screen.queryByTitle('HTTP server preview')).toBeNull();

      // The backoff retry probes again, succeeds, and remounts the host.
      const host = await screen.findByTitle('HTTP server preview', {}, { timeout: 2000 });
      expect(host).toBeTruthy();
      expect(bumpReloadKey).not.toHaveBeenCalled();
    });
  });
});
