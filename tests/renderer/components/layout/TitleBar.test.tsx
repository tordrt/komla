/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommandCenterStore } from '../../../../src/renderer/stores/command-center.store';

const mockState = vi.hoisted(() => ({
  windowStore: {
    isFullscreen: false,
  },
  configStore: {
    config: {},
    updateConfig: vi.fn(),
  },
  workspacesStore: {
    selectedWorkspaceId: null as string | null,
    workspaces: [] as any[],
  },
  fileViewerStore: {
    openFileViewer: vi.fn(),
    fileViewerWorkspaceId: null as string | null,
    fileViewerMode: 'browse' as 'browse' | 'diff',
    setFileViewerMode: vi.fn(),
    requestCloseViewer: vi.fn(),
  },
  shortcutsStore: {
    getDisplayShortcut: vi.fn((shortcut: string) => shortcut),
  },
  licenseStore: {
    quota: null as { isLicensed: boolean } | null,
  },
}));

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (state: typeof mockState.windowStore) => unknown) =>
    selector(mockState.windowStore),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector?: (state: typeof mockState.configStore) => unknown) =>
    selector ? selector(mockState.configStore) : mockState.configStore,
}));
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: typeof mockState.workspacesStore) => unknown) =>
    selector(mockState.workspacesStore),
}));

vi.mock('../../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: () => mockState.fileViewerStore,
}));

vi.mock('../../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: (selector: (state: typeof mockState.shortcutsStore) => unknown) =>
    selector(mockState.shortcutsStore),
}));

vi.mock('../../../../src/renderer/stores/license.store', () => ({
  useLicenseStore: (selector: (state: typeof mockState.licenseStore) => unknown) =>
    selector(mockState.licenseStore),
}));


vi.mock('../../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  SetupActivityIndicator: ({ workspace }: { workspace: { id: string } }) => (
    <div data-testid="setup-activity-indicator">{workspace.id}</div>
  ),
}));

vi.mock('../../../../src/renderer/components/layout/TargetBranchSelector', () => ({
  TargetBranchSelector: () => null,
}));

vi.mock('../../../../src/renderer/components/layout/GettingStartedMenu', () => ({
  GettingStartedMenu: () => <div data-testid="getting-started-menu" />,
}));

vi.mock('../../../../src/renderer/components/layout/UnifiedMenu', () => ({
  UnifiedMenu: () => <div data-testid="unified-menu" />,
}));

vi.mock('../../../../src/renderer/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...props }, ref) => (
      <button ref={ref} {...props}>
        {children}
      </button>
    )
  ),
}));

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DropdownMenuSeparator: () => <div />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function setWindowApi(platform: 'darwin' | 'win32' | 'linux') {
  Object.assign(window as any, {
    api: {
      platform,
      getAvailableEditors: vi.fn(() => new Promise(() => {})),
      showItemInFolder: vi.fn(),
      openInEditor: vi.fn(),
      isWindowMaximized: vi.fn(() => new Promise(() => {})),
      onWindowMaximizedChange: vi.fn(() => () => {}),
      minimizeWindow: vi.fn(),
      maximizeWindow: vi.fn(),
      closeWindow: vi.fn(),
    },
  });
}

type ResizeCallback = (entries: Array<{ contentRect: { width: number } }>) => void;
const resizeObservers: Array<{ callback: ResizeCallback; element?: Element }> = [];

class FakeResizeObserver {
  private readonly entry: { callback: ResizeCallback; element?: Element };
  constructor(callback: ResizeCallback) {
    this.entry = { callback };
    resizeObservers.push(this.entry);
  }
  observe(element: Element) {
    this.entry.element = element;
  }
  unobserve() {}
  disconnect() {
    resizeObservers.splice(resizeObservers.indexOf(this.entry), 1);
  }
}

function resizeTitleBar(width: number) {
  act(() => {
    for (const observer of resizeObservers) observer.callback([{ contentRect: { width } }]);
  });
}

let TitleBar: typeof import('../../../../src/renderer/components/layout/TitleBar').TitleBar;

async function renderTitleBar(platform: 'darwin' | 'win32' | 'linux', isFullscreen: boolean) {
  mockState.windowStore.isFullscreen = isFullscreen;
  setWindowApi(platform);

  render(<TitleBar />);

  return screen.getByTestId('title-bar');
}

describe('TitleBar', { timeout: 30000 }, () => {
  beforeAll(async () => {
    setWindowApi('darwin');
    ({ TitleBar } = await import('../../../../src/renderer/components/layout/TitleBar'));
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.windowStore.isFullscreen = false;
    mockState.configStore.config = {};
    mockState.workspacesStore.selectedWorkspaceId = null;
    mockState.workspacesStore.workspaces = [];
    mockState.licenseStore.quota = null;
  });

  it('uses 80px left padding on macOS when windowed', async () => {
    const titleBar = await renderTitleBar('darwin', false);

    expect(titleBar).toHaveStyle({ paddingLeft: '80px' });
  });

  it('uses 0px left padding on macOS when fullscreen', async () => {
    const titleBar = await renderTitleBar('darwin', true);

    expect(titleBar).toHaveStyle({ paddingLeft: '0px' });
  });

  it('leaves the macOS traffic lights and Command center to the sidebar when it is shown', () => {
    setWindowApi('darwin');
    const { rerender } = render(<TitleBar onOpenCommandCenter={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Command center' })).toBeTruthy();

    rerender(<TitleBar sidebarVisible onOpenCommandCenter={vi.fn()} />);

    expect(screen.getByTestId('title-bar')).toHaveStyle({ paddingLeft: '0px' });
    expect(screen.queryByRole('button', { name: 'Command center' })).toBeNull();
  });

  it('leaves the settings menu to the sidebar when it is shown', () => {
    setWindowApi('linux');
    const { rerender } = render(<TitleBar onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();

    rerender(<TitleBar sidebarVisible onOpenSettings={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it.each(['win32', 'linux'] as const)(
    'leaves Command center to the sidebar when it is shown on %s, as on macOS',
    (platform) => {
      setWindowApi(platform);
      const { rerender } = render(<TitleBar onOpenCommandCenter={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Command center' })).toBeTruthy();

      rerender(<TitleBar sidebarVisible onOpenCommandCenter={vi.fn()} />);

      expect(screen.queryByRole('button', { name: 'Command center' })).toBeNull();
    }
  );

  it.each(['linux', 'win32'] as const)(
    'sets the window controls apart from the app buttons with a divider on %s',
    (platform) => {
      setWindowApi(platform);
      render(<TitleBar />);

      expect(screen.getByTestId('window-controls-divider')).toBeTruthy();
    }
  );

  it('needs no divider on macOS, where the traffic lights sit at the left', () => {
    setWindowApi('darwin');
    render(<TitleBar />);

    expect(screen.queryByTestId('window-controls-divider')).toBeNull();
  });

  it('keeps Windows right padding when fullscreen', async () => {
    const titleBar = await renderTitleBar('win32', true);

    expect(titleBar).toHaveStyle({ paddingRight: '138px' });
  });

  it('does not apply macOS or Windows padding on Linux when fullscreen', async () => {
    const titleBar = await renderTitleBar('linux', true);

    expect(titleBar.style.paddingLeft).toBe('');
    expect(titleBar.style.paddingRight).toBe('');
  });

  it('opens filename search for an SSH workspace', async () => {
    mockState.workspacesStore.selectedWorkspaceId = 'ssh-ws';
    mockState.workspacesStore.workspaces = [
      {
        id: 'ssh-ws',
        workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
        isWorktree: true,
        backend: { kind: 'ssh', hostId: 'ssh-dev' },
        terminals: [],
      },
    ];

    useCommandCenterStore.setState({ open: false, mode: 'workspaces', fileMode: 'files' });

    await renderTitleBar('darwin', false);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'files' });
  });

  async function renderTitleBarWithVsCode() {
    setWindowApi('darwin');
    window.api.getAvailableEditors = vi.fn(() =>
      Promise.resolve([{ id: 'vscode', name: 'VS Code' }])
    );
    render(<TitleBar />);
    await act(async () => {});
  }

  it('offers the editor and Finder for a local workspace', async () => {
    mockState.workspacesStore.selectedWorkspaceId = 'current';
    mockState.workspacesStore.workspaces = [
      { id: 'current', workingDirectory: '/tmp/current', isWorktree: true, terminals: [] },
    ];

    await renderTitleBarWithVsCode();

    expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open with' })).toBeInTheDocument();
  });

  it('hides the open-in editor and file manager button for an SSH workspace', async () => {
    mockState.workspacesStore.selectedWorkspaceId = 'ssh-ws';
    mockState.workspacesStore.workspaces = [
      {
        id: 'ssh-ws',
        workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
        isWorktree: true,
        backend: { kind: 'ssh', hostId: 'ssh-dev' },
        terminals: [],
      },
    ];

    await renderTitleBarWithVsCode();

    expect(screen.queryByRole('button', { name: 'Open in VS Code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open with' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show in Finder' })).not.toBeInTheDocument();
  });

  it('leaves setup activity to the tab row', async () => {
    mockState.workspacesStore.selectedWorkspaceId = 'current';
    mockState.workspacesStore.workspaces = [
      {
        id: 'current',
        workingDirectory: '/tmp/current',
        isWorktree: true,
        terminals: [],
      },
    ];

    const titleBar = await renderTitleBar('darwin', false);

    expect(titleBar).toBeInTheDocument();
    expect(screen.queryByTestId('setup-activity-indicator')).not.toBeInTheDocument();
  });

  it('groups settings, shortcuts, and feedback under a settings button', async () => {
    setWindowApi('darwin');
    const onOpenSettings = vi.fn();
    const onOpenShortcuts = vi.fn();
    const onOpenFeedback = vi.fn();

    render(
      <TitleBar
        onOpenSettings={onOpenSettings}
        onOpenShortcuts={onOpenShortcuts}
        onOpenFeedback={onOpenFeedback}
      />
    );

    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shortcuts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Feedback' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Settings', { selector: 'div' }));
    fireEvent.click(screen.getByText('Shortcuts', { selector: 'div' }));
    fireEvent.click(screen.getByText('Feedback', { selector: 'div' }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenShortcuts).toHaveBeenCalledOnce();
    expect(onOpenFeedback).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).not.toBeInTheDocument();
  });

  it('offers Tips even when the legacy dismissed flag is set', () => {
    setWindowApi('darwin');
    // Off the status bar, so the title bar's settings menu offers it.
    mockState.configStore.config = { onboardingTipsDismissed: true, showTipsInToolbar: false };

    render(
      <TitleBar
        onOpenShortcuts={vi.fn()}
        onOpenFeedback={vi.fn()}
        onOpenSettingsTab={vi.fn()}
        onOpenNewWorkspace={vi.fn()}
      />
    );

    expect(screen.getByTestId('getting-started-menu')).toBeInTheDocument();
  });

  it('shows Upgrade only for unlicensed users', () => {
    setWindowApi('darwin');
    mockState.licenseStore.quota = { isLicensed: false };
    const onOpenUpgrade = vi.fn();

    const { rerender } = render(
      <TitleBar onOpenSettings={vi.fn()} onOpenUpgrade={onOpenUpgrade} />
    );

    fireEvent.click(screen.getByText('Upgrade', { selector: 'div' }));
    expect(onOpenUpgrade).toHaveBeenCalledOnce();

    mockState.licenseStore.quota = { isLicensed: true };
    rerender(<TitleBar onOpenSettings={vi.fn()} onOpenUpgrade={onOpenUpgrade} />);

    expect(screen.queryByText('Upgrade', { selector: 'div' })).not.toBeInTheDocument();
  });

  describe('when the window is narrow', () => {
    beforeEach(() => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      mockState.workspacesStore.selectedWorkspaceId = 'current';
      mockState.workspacesStore.workspaces = [
        { id: 'current', workingDirectory: '/tmp/current', isWorktree: true, terminals: [] },
      ];
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      resizeObservers.length = 0;
    });

    function renderWithMenus() {
      render(
        <TitleBar
          onOpenSettings={vi.fn()}
          onOpenShortcuts={vi.fn()}
          onOpenFeedback={vi.fn()}
          onOpenSettingsTab={vi.fn()}
          onOpenNewWorkspace={vi.fn()}
        />
      );
    }

    it('keeps text labels while there is room', () => {
      setWindowApi('linux');
      renderWithMenus();
      resizeTitleBar(1200);

      expect(screen.getByRole('button', { name: 'Files' })).toHaveTextContent('Files');
      expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent('Search');
    });

    it('collapses Files and Search to icons and keeps their names', () => {
      setWindowApi('linux');
      renderWithMenus();
      resizeTitleBar(760);

      expect(screen.getByRole('button', { name: 'Files' })).toHaveTextContent(/^$/);
      expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent(/^$/);

      resizeTitleBar(1200);
      expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent('Search');
    });

    it('collapses labels on Windows at the same window width as on Linux', () => {
      // A 1280px window with the 200px sidebar leaves 910px beside the caption buttons.
      setWindowApi('win32');
      renderWithMenus();
      resizeTitleBar(910);

      expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent('Search');

      resizeTitleBar(760);
      expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent(/^$/);
    });

    it('lets the git cluster shrink so the settings menu and the window controls stay on screen', () => {
      setWindowApi('linux');
      renderWithMenus();

      const [start, end] = Array.from(screen.getByTestId('title-bar').firstElementChild!.children);
      expect(start).toHaveClass('min-w-0', 'overflow-hidden');
      expect(end).toHaveClass('shrink-0');
      expect(end).toContainElement(screen.getByRole('button', { name: 'Settings' }));
      expect(end).toContainElement(screen.getByRole('button', { name: 'Close' }));
    });
  });
});
