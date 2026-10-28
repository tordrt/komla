/**
 * @vitest-environment jsdom
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bumpReloadKey = vi.fn();
const bumpProbeKey = vi.fn();
const toggleAutoReload = vi.fn();
const startSshPreviewForward = vi.fn();
const requestSshPreviewForward = vi.fn();
const stopSshPreviewForward = vi.fn().mockResolvedValue(undefined);
const updateConfig = vi.fn().mockResolvedValue({ ok: true, error: null });
const updateWorkspace = vi.fn().mockResolvedValue(undefined);
const updateWorkspaceStore = vi.fn();
const openExternal = vi.fn().mockResolvedValue(undefined);
const clearDevPreviewSiteData = vi.fn().mockResolvedValue(true);
const reloadDevPreview = vi.fn().mockResolvedValue(true);
const navigateDevPreview = vi.fn().mockResolvedValue(true);
const detectDevPreviewServices = vi.fn();

// The browser pane under test, and its tabs' ids, which start with the pane's surface id.
const BROWSER_ID = 'surface:browser:test';
const TAB_1 = `${BROWSER_ID}/tab-1`;
const TAB_2 = `${BROWSER_ID}/tab-2`;

let navigationStateCallback:
  | ((state: {
      workspaceId: string;
      tabId: string;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loadError: string | null;
    }) => void)
  | undefined;
let menuCloseAutoFocus: ((event: Event) => void) | undefined;
let scannerResult: string[] = [];
let scannerExecutionLocation: 'workspace' | 'local-mirror' = 'workspace';

let remoteForwardState: any;
let configState: {
  defaultInlinePreviewLayout?: 'full' | 'side-by-side';
  defaultDevServerPreviewAutoReload?: boolean;
} | null = {
  defaultInlinePreviewLayout: 'full',
  defaultDevServerPreviewAutoReload: true,
};
let workspaceDevServerUrl: string | undefined = 'http://localhost:5173';
let workspaceDevServerExecutionLocation: 'workspace' | 'local-mirror' | undefined;
let workspaceBackend: { kind: 'ssh' } | undefined;
let recentLinks: Array<{ url: string; openedAt?: number; printedAt?: number }> | undefined;
let autoReload: boolean | undefined;
let defaultAutoReload = true;

vi.mock('../../../src/renderer/stores/dev-server-preview.store', () => ({
  useDevServerPreviewStore: (selector: any) =>
    selector({
      remoteForwardByWorkspace: remoteForwardState
        ? { [BROWSER_ID]: { tabId: TAB_1, ...remoteForwardState } }
        : {},
      autoReloadByWorkspace: { 'ws-1': autoReload },
      bumpReloadKey,
      bumpProbeKey,
      toggleAutoReload,
      startSshPreviewForward,
      requestSshPreviewForward,
      stopSshPreviewForward,
    }),
}));

vi.mock('../../../src/renderer/stores/config.store', () => {
  const useConfigStore: any = (selector?: any) => {
    const state = {
      config: { ...configState, defaultDevServerPreviewAutoReload: defaultAutoReload },
      updateConfig,
    };
    return selector ? selector(state) : state;
  };
  useConfigStore.getState = () => ({
    config: { ...configState, defaultDevServerPreviewAutoReload: defaultAutoReload },
    updateConfig,
  });
  useConfigStore.setState = (nextState: { config?: typeof configState }) => {
    if ('config' in nextState) configState = nextState.config ?? null;
  };
  return { useConfigStore };
});

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

vi.mock('../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({
    children,
    disableHoverableContent,
  }: React.PropsWithChildren<{ disableHoverableContent?: boolean }>) => (
    <span data-tooltip-hoverable={disableHoverableContent ? 'false' : 'true'}>{children}</span>
  ),
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({
    children,
    side,
    avoidCollisions,
  }: React.PropsWithChildren<{
    side?: 'top' | 'right' | 'bottom' | 'left';
    avoidCollisions?: boolean;
  }>) => (
    <div data-tooltip-side={side} data-tooltip-avoid-collisions={avoidCollisions}>
      {children}
    </div>
  ),
}));

vi.mock('../../../src/renderer/components/ui/popover', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const Ctx = React.createContext<{
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  } | null>(null);
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => React.createElement(Ctx.Provider, { value: { open, onOpenChange } }, children),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => {
      const ctx = React.useContext(Ctx);
      if (React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
          onClick: () => ctx?.onOpenChange?.(true),
        });
      }
      return <>{children}</>;
    },
    // Like Radix, the content is there only while open.
    PopoverContent: ({ children }: React.PropsWithChildren) =>
      React.useContext(Ctx)?.open === false ? null : <div>{children}</div>,
  };
});

vi.mock('../../../src/renderer/components/ui/dropdown-menu', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const Ctx = React.createContext<{ onOpenChange?: (open: boolean) => void } | null>(null);
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: {
      children: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => React.createElement(Ctx.Provider, { value: { onOpenChange } }, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => {
      const ctx = React.useContext(Ctx);
      if (React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
          onClick: () => ctx?.onOpenChange?.(true),
        });
      }
      return <>{children}</>;
    },
    DropdownMenuContent: ({
      children,
      onCloseAutoFocus,
    }: React.PropsWithChildren<{ onCloseAutoFocus?: (event: Event) => void }>) => {
      menuCloseAutoFocus = onCloseAutoFocus;
      return <div>{children}</div>;
    },
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      onSelect,
    }: React.PropsWithChildren<{ onSelect?: () => void }>) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      uncheckedIndicator,
      indicatorClassName,
      onCheckedChange,
    }: React.PropsWithChildren<{
      checked?: boolean;
      uncheckedIndicator?: React.ReactNode;
      indicatorClassName?: string;
      onCheckedChange?: () => void;
    }>) => (
      <button type="button" aria-pressed={checked} onClick={onCheckedChange}>
        <span>
          {checked && <span className={indicatorClassName} />} {!checked && uncheckedIndicator}
        </span>
        {children}
      </button>
    ),
  };
});

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
    const pathSuffix =
      url.pathname === '/' && !url.search && !url.hash
        ? ''
        : `${url.pathname}${url.search}${url.hash}`;
    return { remotePort, pathSuffix, scheme: url.protocol === 'https:' ? 'https' : 'http' };
  },
}));

import { InlineDevServerPreviewHeader } from '../../../src/renderer/components/terminal/InlineDevServerPreviewHeader';
import { LIVE_REFRESH_MS } from '../../../src/renderer/hooks/useDevPreviewServices';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';

import type { BrowserTabsState } from '../../../src/shared/lib/browser-tabs';

// Each change the toolbar makes to the browser pane's tabs, as the pane store saw it.
let tabWrites: BrowserTabsState[] = [];
let seeding = false;
usePaneSurfacesStore.subscribe((state, previous) => {
  const surface = state.surfaces[BROWSER_ID];
  if (seeding || surface === previous.surfaces[BROWSER_ID] || surface?.kind !== 'browser') return;
  tabWrites.push({
    browserTabs: surface.browserTabs,
    activeBrowserTabId: surface.activeBrowserTabId,
  });
});

/** The toolbar of the test's browser pane, whose one tab the test's variables describe. */
function header() {
  seeding = true;
  usePaneSurfacesStore.setState({
    surfaces: {
      [BROWSER_ID]: {
        kind: 'browser',
        workspaceId: 'ws-1',
        browserTabs: [
          {
            id: TAB_1,
            url: workspaceDevServerUrl ?? '',
            ...(workspaceDevServerExecutionLocation
              ? { urlExecutionLocation: workspaceDevServerExecutionLocation }
              : {}),
          },
        ],
        activeBrowserTabId: TAB_1,
      },
    },
  });
  seeding = false;
  return <InlineDevServerPreviewHeader workspaceId="ws-1" browserId={BROWSER_ID} />;
}

beforeEach(() => {
  bumpReloadKey.mockReset();
  bumpProbeKey.mockReset();
  toggleAutoReload.mockReset();
  startSshPreviewForward.mockReset();
  requestSshPreviewForward.mockReset();
  stopSshPreviewForward.mockReset();
  stopSshPreviewForward.mockResolvedValue(undefined);
  updateConfig.mockReset();
  updateConfig.mockResolvedValue({ ok: true, error: null });
  updateWorkspace.mockReset();
  updateWorkspaceStore.mockReset();
  openExternal.mockReset();
  clearDevPreviewSiteData.mockReset();
  clearDevPreviewSiteData.mockResolvedValue(true);
  reloadDevPreview.mockReset();
  reloadDevPreview.mockResolvedValue(true);
  navigateDevPreview.mockReset();
  navigateDevPreview.mockResolvedValue(true);
  navigationStateCallback = undefined;
  usePaneSurfacesStore.setState({ surfaces: {} });
  tabWrites = [];
  remoteForwardState = undefined;
  configState = { defaultInlinePreviewLayout: 'full', defaultDevServerPreviewAutoReload: true };
  workspaceDevServerUrl = 'http://localhost:5173';
  workspaceDevServerExecutionLocation = undefined;
  workspaceBackend = undefined;
  recentLinks = undefined;
  autoReload = undefined;
  defaultAutoReload = true;
  scannerResult = [];
  scannerExecutionLocation = 'workspace';
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
    clearDevPreviewSiteData,
    detectDevPreviewServices,
    getLinkPreview: vi.fn().mockResolvedValue(null),
    navigateDevPreview,
    onDevPreviewNavigationStateChanged: vi.fn((callback) => {
      navigationStateCallback = callback;
      return vi.fn();
    }),
    openExternal,
    reloadDevPreview,
    updateWorkspace,
  };
});

describe('InlineDevServerPreviewHeader', () => {
  it('leaves the address bar empty when no URL is saved', () => {
    workspaceDevServerUrl = undefined;
    render(header());

    const input = screen.getByLabelText('Address') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('http://localhost:3000');

    fireEvent.click(screen.getByLabelText('More preview actions'));
    fireEvent.click(screen.getByText('Open in external browser'));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('enables back and forward controls from native navigation state', async () => {
    render(header());
    expect(screen.getByLabelText('Go back')).toBeDisabled();
    expect(screen.getByLabelText('Go forward')).toBeDisabled();

    navigationStateCallback?.({
      workspaceId: 'ws-1',
      tabId: TAB_1,
      title: '',
      loadError: null,
      url: 'http://localhost:5173/dashboard',
      canGoBack: true,
      canGoForward: true,
    });

    await waitFor(() => expect(screen.getByLabelText('Go back')).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Go back'));
    fireEvent.click(screen.getByLabelText('Go forward'));
    expect(navigateDevPreview).toHaveBeenCalledWith('ws-1', TAB_1, 'back');
    expect(navigateDevPreview).toHaveBeenCalledWith('ws-1', TAB_1, 'forward');
  });

  it('positions browser action tooltips above the native preview', () => {
    render(header());

    for (const label of [
      'Back',
      'Forward',
      'Reload (auto reload on file changes is on)',
      'More preview actions',
    ]) {
      const tooltip = screen.getByText(label);
      expect(tooltip).toHaveAttribute('data-tooltip-side', 'top');
      expect(tooltip).toHaveAttribute('data-tooltip-avoid-collisions', 'false');
      // Over the tab row, it closes once the pointer leaves the button.
      expect(tooltip.closest('[data-tooltip-hoverable]')).toHaveAttribute(
        'data-tooltip-hoverable',
        'false'
      );
    }
  });

  it('leaves focus off the menu button when the menu closes, so its tooltip stays shut', () => {
    render(header());
    const event = new Event('focusout', { cancelable: true });

    menuCloseAutoFocus?.(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('returns null when the browser has no tab', () => {
    usePaneSurfacesStore.setState({
      surfaces: {
        [BROWSER_ID]: {
          kind: 'browser',
          workspaceId: 'ws-1',
          browserTabs: [],
          activeBrowserTabId: undefined,
        },
      },
    });
    const { container } = render(
      <InlineDevServerPreviewHeader workspaceId="ws-1" browserId={BROWSER_ID} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('submits a new URL on Enter into the tab', () => {
    render(header());

    const input = screen.getByDisplayValue('http://localhost:5173') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://localhost:8080' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(tabWrites).toContainEqual(tabUpdate('http://localhost:8080'));
  });

  it('does not persist when the submitted URL equals the current URL', () => {
    render(header());

    const input = screen.getByDisplayValue('http://localhost:5173') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(tabWrites).toEqual([]);
  });

  it('opens any web address, adding the scheme a typed host leaves out', () => {
    render(header());

    const input = screen.getByDisplayValue('http://localhost:5173') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com/docs' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(tabWrites).toContainEqual(tabUpdate('https://example.com/docs'));
  });

  it('opens a typed web page directly in an SSH workspace', () => {
    workspaceBackend = { kind: 'ssh' };
    render(header());

    const input = screen.getByDisplayValue('http://localhost:5173') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(requestSshPreviewForward).not.toHaveBeenCalled();
    expect(tabWrites).toContainEqual(tabUpdate('https://example.com'));
  });

  it('does not persist text that is not a web address and marks the input invalid', () => {
    render(header());

    const input = screen.getByDisplayValue('http://localhost:5173') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'file:///etc/passwd' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(tabWrites).toEqual([]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('ignores navigation of other tabs', async () => {
    render(header());

    navigationStateCallback?.({
      workspaceId: 'ws-1',
      tabId: TAB_2,
      title: '',
      loadError: null,
      url: 'https://example.com/',
      canGoBack: true,
      canGoForward: false,
    });

    await Promise.resolve();
    expect(screen.getByLabelText('Go back')).toBeDisabled();
    expect(screen.getByDisplayValue('http://localhost:5173')).toBeTruthy();
  });

  it('reload button bumps the store reload key', () => {
    render(header());

    fireEvent.click(screen.getByLabelText('Reload'));
    expect(bumpReloadKey).toHaveBeenCalledWith(BROWSER_ID);
  });

  it('auto-reload button toggles file-change refresh for the workspace', () => {
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    const button = screen.getByText('Auto reload on changes').closest('button');
    expect(button!.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(button!);
    expect(toggleAutoReload).toHaveBeenCalledWith('ws-1', true);
  });

  it('uses the configured default auto reload state before a workspace override exists', () => {
    defaultAutoReload = false;
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    const button = screen.getByText('Auto reload on changes').closest('button');
    expect(button!.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows auto reload as active when enabled', () => {
    autoReload = true;
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    const button = screen.getByText('Auto reload on changes').closest('button');
    expect(button!.getAttribute('aria-pressed')).toBe('true');
    expect(button!.querySelector('.text-primary')).toBeTruthy();
  });

  it('shows auto reload as off for a page that is not on this computer', () => {
    autoReload = true;
    workspaceDevServerUrl = 'https://example.com/';
    render(header());

    expect(screen.getByLabelText('Reload').className).not.toContain('text-primary');
    expect(screen.queryByText('Auto reload on file changes is on')).toBeNull();
    fireEvent.click(screen.getByLabelText('More preview actions'));
    expect(screen.getByText('Only for pages on this computer')).toBeTruthy();
  });

  it('surfaces auto reload state on the visible reload button', () => {
    autoReload = true;
    render(header());

    const reloadButton = screen.getByLabelText('Reload');
    expect(reloadButton.className).toContain('text-primary');
    expect(reloadButton.getAttribute('aria-describedby')).toBe(
      screen.getByText('Auto reload on file changes is on').id
    );
  });

  it('open-external button opens the persisted URL', () => {
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    fireEvent.click(screen.getByText('Open in external browser'));
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('keeps forwarded double-slash paths on the local origin when opening externally', () => {
    workspaceBackend = { kind: 'ssh' };
    remoteForwardState = {
      status: 'active',
      remotePort: 4242,
      pathSuffix: '//example.com/escape?tab=preview',
      forward: {
        localUrl: 'http://127.0.0.1:59321',
        localPort: 59321,
        remotePort: 4242,
        workspaceId: 'ws-1',
      },
    };
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    fireEvent.click(screen.getByText('Open in external browser'));

    expect(openExternal).toHaveBeenCalledWith(
      'http://127.0.0.1:59321//example.com/escape?tab=preview'
    );
  });

  it('hard-reload button reloads the native preview while ignoring cache', () => {
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    fireEvent.click(screen.getByText('Hard reload'));

    expect(reloadDevPreview).toHaveBeenCalledWith('ws-1', TAB_1, true);
    expect(bumpProbeKey).toHaveBeenCalledWith(BROWSER_ID);
    expect(bumpReloadKey).not.toHaveBeenCalled();
  });

  it('reset-site-data button clears storage for the origin then bumps the reload key', async () => {
    render(header());

    fireEvent.click(screen.getByLabelText('More preview actions'));
    fireEvent.click(screen.getByText('Reset site data'));

    expect(clearDevPreviewSiteData).toHaveBeenCalledTimes(1);
    expect(clearDevPreviewSiteData).toHaveBeenCalledWith('ws-1', TAB_1);
    await Promise.resolve();
    expect(bumpReloadKey).toHaveBeenCalledWith(BROWSER_ID);
  });

  describe('terminal URL picker', () => {
    it('lists scanned URLs; clicking one saves it in the tab', async () => {
      scannerResult = ['http://localhost:5173/', 'http://localhost:3001/dashboard'];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));

      fireEvent.click(await screen.findByText('localhost:3001/dashboard'));

      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:3001/dashboard'));
    });

    it('shows an empty-state message when nothing is found', async () => {
      scannerResult = [];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));

      expect(screen.getByText('Checking running servers…')).toBeTruthy();
      expect(await screen.findByText('No running servers or links found.')).toBeTruthy();
    });

    it('ranks servers as the globe button list does, the rest behind Show more', async () => {
      scannerResult = ['http://localhost:3000/', 'http://localhost:5173/'];
      detectDevPreviewServices.mockResolvedValue({
        services: [
          {
            port: 5173,
            scheme: 'http',
            pid: 41,
            processName: 'vite',
            terminalId: 'terminal-1',
            executionLocation: 'workspace',
          },
          {
            port: 6006,
            scheme: 'http',
            pid: 42,
            processName: 'node',
            terminalId: 'terminal-1',
            executionLocation: 'workspace',
          },
          {
            port: 5432,
            scheme: null,
            pid: 43,
            processName: 'postgres',
            terminalId: 'terminal-1',
            executionLocation: 'workspace',
          },
        ],
        otherServers: [
          { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
        ],
        openPorts: [],
      });
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));

      expect(await screen.findByText('localhost:5173')).toBeTruthy();
      expect(detectDevPreviewServices).toHaveBeenCalledWith('ws-1', [3000, 5173], [], []);
      const rows = () =>
        screen
          .getAllByRole('button')
          .map((button) => button.textContent ?? '')
          .filter(
            (text) =>
              text.includes('localhost:') || text.includes('more') || text.includes('Outside Komla')
          );
      expect(rows()).toEqual(['localhost:5173viteOpen', 'Show 3 more…', 'Outside Komla1 server']);

      fireEvent.click(screen.getByText('Show 3 more…'));
      fireEvent.click(screen.getByRole('button', { name: /Outside Komla/ }));

      expect(rows()).toEqual([
        'localhost:5173viteOpen',
        'localhost:6006nodeOpen',
        'localhost:5432postgres · not HTTPOpen',
        'localhost:3000not runningOpen',
        'localhost:8765python3Open',
      ]);

      fireEvent.click(screen.getByText('localhost:6006'));

      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:6006/'));
    });

    it('opens a link in the tab and counts it as opened', async () => {
      workspaceBackend = { kind: 'ssh' };
      recentLinks = [{ url: 'https://github.com/acme/app/pull/9', printedAt: Date.now() }];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));
      fireEvent.click(await screen.findByText('/acme/app/pull/9'));

      // A web page loads directly, even in an SSH workspace.
      expect(startSshPreviewForward).not.toHaveBeenCalled();
      expect(tabWrites).toContainEqual(tabUpdate('https://github.com/acme/app/pull/9'));
      expect(updateWorkspaceStore).toHaveBeenCalledWith('ws-1', {
        recentLinks: [expect.objectContaining({ openedAt: expect.any(Number) })],
      });
    });

    it('lists running servers when the address field is clicked and keeps focus there', async () => {
      scannerResult = ['http://localhost:5173/'];
      render(header());
      const field = screen.getByLabelText('Address');
      field.focus();

      fireEvent.click(field);

      expect(await screen.findByText('localhost:5173')).toBeTruthy();
      expect(document.activeElement).toBe(field);

      fireEvent.change(field, { target: { value: 'http://localhost:4' } });

      await waitFor(() => expect(screen.queryByText('localhost:5173')).toBeNull());
      expect(document.activeElement).toBe(field);
      fireEvent.click(field);
      expect(screen.queryByText('localhost:5173')).toBeNull();
    });

    it('checks again each time the picker opens', async () => {
      scannerResult = ['http://localhost:5173/'];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));
      await waitFor(() => expect(screen.queryByText('Checking running servers…')).toBeNull());
      // Picking a URL closes the picker.
      fireEvent.click(screen.getByText('localhost:5173'));
      fireEvent.click(screen.getByLabelText('Pick a running server or link'));

      expect(screen.getByText('Checking running servers…')).toBeTruthy();
      await waitFor(() => expect(detectDevPreviewServices).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText('Checking running servers…')).toBeNull());
    });

    it('keeps checking while the picker stays open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        scannerResult = [];
        render(header());
        fireEvent.click(screen.getByLabelText('Pick a running server or link'));
        expect(await screen.findByText('No running servers or links found.')).toBeTruthy();

        scannerResult = ['http://localhost:5173/'];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
        });

        expect(await screen.findByText('localhost:5173')).toBeTruthy();
        expect(detectDevPreviewServices).toHaveBeenLastCalledWith('ws-1', [5173], [], []);
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards selected terminal URLs for SSH workspaces instead of persisting them', async () => {
      workspaceBackend = { kind: 'ssh' };
      scannerResult = ['http://localhost:5173/', 'http://localhost:3001/dashboard'];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));
      fireEvent.click(await screen.findByText('localhost:3001/dashboard'));

      expect(stopSshPreviewForward).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(startSshPreviewForward).toHaveBeenCalledWith(
          'ws-1',
          TAB_1,
          3001,
          '/dashboard',
          'http',
          'http://localhost:3001/dashboard'
        );
      });
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:3001/dashboard'));
    });

    it('reclassifies a saved local-mirror preview when selecting a remote terminal URL', async () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerExecutionLocation = 'local-mirror';
      scannerResult = ['http://localhost:3001/dashboard'];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));
      fireEvent.click(await screen.findByText('localhost:3001/dashboard'));

      await waitFor(() => {
        expect(tabWrites).toContainEqual(tabUpdate('http://localhost:3001/dashboard'));
      });
      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        3001,
        '/dashboard',
        'http',
        'http://localhost:3001/dashboard'
      );
    });

    it('opens a selected local-mirror URL directly in an SSH workspace', async () => {
      workspaceBackend = { kind: 'ssh' };
      scannerExecutionLocation = 'local-mirror';
      scannerResult = ['http://localhost:3001/dashboard'];
      render(header());

      fireEvent.click(screen.getByLabelText('Pick a running server or link'));
      fireEvent.click(await screen.findByText('localhost:3001/dashboard'));

      expect(startSshPreviewForward).not.toHaveBeenCalled();
      expect(tabWrites).toContainEqual(
        tabUpdate('http://localhost:3001/dashboard', 'local-mirror')
      );
    });

    it('hides SSH forwarding actions for a saved local-mirror URL', () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerExecutionLocation = 'local-mirror';
      render(header());

      fireEvent.click(screen.getByLabelText('More preview actions'));

      expect(screen.queryByText('Forward remote port...')).toBeNull();
    });

    it('keeps a user-stopped SSH forward stopped', () => {
      workspaceBackend = { kind: 'ssh' };
      remoteForwardState = { status: 'active', remotePort: 5173, pathSuffix: '', scheme: 'http' };
      render(header());

      fireEvent.click(screen.getByLabelText('More preview actions'));
      fireEvent.click(screen.getByText('Stop SSH port forward'));

      expect(stopSshPreviewForward).toHaveBeenCalledWith('ws-1', {
        keepStopped: true,
        tabId: TAB_1,
      });
    });

    it('offers a new forward once the SSH forward is stopped', () => {
      workspaceBackend = { kind: 'ssh' };
      remoteForwardState = { status: 'stopped', remotePort: 5173 };
      render(header());

      fireEvent.click(screen.getByLabelText('More preview actions'));

      expect(screen.getByText('Forward remote port...')).toBeTruthy();
      expect(screen.queryByText('Stop SSH port forward')).toBeNull();
    });

    it('saves the URL of a manually forwarded remote port', async () => {
      workspaceBackend = { kind: 'ssh' };
      render(header());

      fireEvent.click(screen.getByLabelText('More preview actions'));
      fireEvent.click(screen.getByText('Forward remote port...'));
      fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '4242' } });
      fireEvent.click(screen.getByRole('button', { name: 'Forward' }));

      await vi.waitFor(() =>
        expect(startSshPreviewForward).toHaveBeenCalledWith(
          'ws-1',
          TAB_1,
          4242,
          '',
          'http',
          'http://localhost:4242'
        )
      );
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:4242'));
    });

    it('does not request a forward when the address field loses focus unchanged', () => {
      workspaceBackend = { kind: 'ssh' };
      remoteForwardState = { status: 'stopped', remotePort: 5173 };
      render(header());

      fireEvent.blur(screen.getByLabelText('Address'));

      expect(requestSshPreviewForward).not.toHaveBeenCalled();
      expect(startSshPreviewForward).not.toHaveBeenCalled();
    });

    it('keeps a starting SSH tunnel when the address field loses focus', () => {
      workspaceBackend = { kind: 'ssh' };
      workspaceDevServerUrl = 'http://localhost:4242/app';
      remoteForwardState = {
        status: 'starting',
        remotePort: 4242,
        pathSuffix: '/app',
        scheme: 'http',
      };
      render(header());

      fireEvent.blur(screen.getByLabelText('Address'));

      expect(requestSshPreviewForward).not.toHaveBeenCalled();
      expect(startSshPreviewForward).not.toHaveBeenCalled();
    });

    it('does not open a saved remote URL externally without its tunnel', () => {
      workspaceBackend = { kind: 'ssh' };
      render(header());

      fireEvent.click(screen.getByLabelText('More preview actions'));
      fireEvent.click(screen.getByText('Open in external browser'));

      expect(openExternal).not.toHaveBeenCalled();
    });

    it('requests confirmation for manually entered SSH URLs on Enter', () => {
      workspaceBackend = { kind: 'ssh' };
      render(header());

      const input = screen.getByLabelText('Address');
      fireEvent.change(input, { target: { value: 'http://localhost:4242/app?tab=preview' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(requestSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        4242,
        '/app?tab=preview',
        'http',
        'http://localhost:5173'
      );
      expect(stopSshPreviewForward).not.toHaveBeenCalled();
      expect(startSshPreviewForward).not.toHaveBeenCalled();
      expect(tabWrites).toEqual([]);
    });

    it('preserves HTTPS for manually entered SSH URLs', () => {
      workspaceBackend = { kind: 'ssh' };
      render(header());

      const input = screen.getByLabelText('Address');
      fireEvent.change(input, { target: { value: 'https://localhost/app' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(requestSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        443,
        '/app',
        'https',
        'http://localhost:5173'
      );
    });

    it('reuses an active forward when only the manually entered path changes', () => {
      workspaceBackend = { kind: 'ssh' };
      remoteForwardState = {
        status: 'active',
        remotePort: 4242,
        pathSuffix: '/old',
        scheme: 'http',
        forward: {
          localUrl: 'http://127.0.0.1:59321',
          localPort: 59321,
          remotePort: 4242,
          workspaceId: 'ws-1',
        },
      };
      render(header());

      const input = screen.getByLabelText('Address');
      fireEvent.change(input, { target: { value: 'http://localhost:4242/new-path' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        4242,
        '/new-path',
        'http',
        'http://localhost:4242/new-path'
      );
      expect(requestSshPreviewForward).not.toHaveBeenCalled();
      expect(tabWrites).toContainEqual(tabUpdate('http://localhost:4242/new-path'));
    });

    it('shows the remote target URL while an SSH forward is active', () => {
      workspaceBackend = { kind: 'ssh' };
      remoteForwardState = {
        status: 'active',
        remotePort: 4242,
        pathSuffix: '/app',
        forward: {
          localUrl: 'http://127.0.0.1:59321',
          localPort: 59321,
          remotePort: 4242,
          workspaceId: 'ws-1',
        },
      };

      render(header());

      expect(screen.getByLabelText('Address')).toHaveValue('http://localhost:4242/app');
    });

    it('maps native tunnel navigation back to the SSH target URL', async () => {
      workspaceBackend = { kind: 'ssh' };
      remoteForwardState = {
        status: 'active',
        remotePort: 4242,
        pathSuffix: '/app',
        scheme: 'http',
        forward: {
          localUrl: 'http://127.0.0.1:59321',
          localPort: 59321,
          remotePort: 4242,
          workspaceId: 'ws-1',
        },
      };
      render(header());

      act(() => {
        navigationStateCallback?.({
          workspaceId: 'ws-1',
          tabId: TAB_1,
          title: '',
          loadError: null,
          url: 'http://127.0.0.1:59321/dashboard?tab=activity#latest',
          canGoBack: true,
          canGoForward: false,
        });
      });

      const input = await screen.findByDisplayValue(
        'http://localhost:4242/dashboard?tab=activity#latest'
      );
      fireEvent.blur(input);

      expect(requestSshPreviewForward).not.toHaveBeenCalled();
      expect(startSshPreviewForward).toHaveBeenCalledWith(
        'ws-1',
        TAB_1,
        4242,
        '/dashboard?tab=activity#latest',
        'http',
        'http://localhost:4242/dashboard?tab=activity#latest'
      );
    });
  });
});
