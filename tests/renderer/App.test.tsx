/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sidebarProps, terminalTabsProps, bannerMounts, executeShortcutAction, Null, Passthrough } =
  vi.hoisted(() => ({
    sidebarProps: vi.fn(),
    terminalTabsProps: vi.fn(),
    bannerMounts: vi.fn(),
    executeShortcutAction: vi.fn(),
    Null: () => null,
    Passthrough: ({ children }: { children?: unknown }) => children,
  }));

// The real AppShell provides tooltips, which the tab row's icon buttons need.
vi.mock('../../src/renderer/components/layout/AppShell', async () => {
  const { TooltipProvider } = await import('../../src/renderer/components/ui/tooltip');
  return { AppShell: TooltipProvider };
});
vi.mock('../../src/renderer/components/ShortcutProvider', () => ({
  ShortcutProvider: Passthrough,
}));
vi.mock('../../src/renderer/components/layout/TitleBar', () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}));
vi.mock('../../src/renderer/components/layout/status-bar/StatusBar', () => ({ StatusBar: Null }));
vi.mock('../../src/renderer/components/layout/UpdateBanner', () => ({
  UpdateBanner: () => {
    React.useEffect(() => bannerMounts(), []);
    return null;
  },
}));
vi.mock('../../src/renderer/components/layout/AnnouncementBanner', () => ({
  AnnouncementBanner: Null,
}));
vi.mock('../../src/renderer/components/layout/AnnouncementDialog', () => ({
  AnnouncementDialog: Null,
}));
vi.mock('../../src/renderer/components/layout/UsageAnalyticsConsentBanner', () => ({
  UsageAnalyticsConsentBanner: Null,
}));
vi.mock('../../src/renderer/components/layout/AgentIntegrationUpdateBanner', () => ({
  AgentIntegrationUpdateBanner: Null,
}));
vi.mock('../../src/renderer/components/layout/PassphraseDialog', () => ({
  PassphraseDialog: Null,
}));
vi.mock('../../src/renderer/components/layout/PushConflictDialog', () => ({
  PushConflictDialog: Null,
}));
vi.mock('../../src/renderer/components/projects/ProjectIconPromptDialog', () => ({
  ProjectIconPromptDialog: Null,
}));
vi.mock('../../src/renderer/components/layout/Sidebar', () => ({
  Sidebar: (props: { width: number; onResize: (width: number) => void }) => {
    sidebarProps(props);
    return <div data-testid="sidebar" data-width={props.width} />;
  },
}));
vi.mock('../../src/renderer/components/terminal/TerminalTabs', () => ({
  TerminalTabs: (props: { renderCollapsedSidebarControls?: () => React.ReactNode }) => {
    terminalTabsProps(props);
    return <div data-testid="terminal-tabs">{props.renderCollapsedSidebarControls?.()}</div>;
  },
}));
vi.mock('../../src/renderer/components/layout/AppMenu', () => ({
  AppMenu: ({ placement }: { placement: string }) => <div data-testid={`app-menu-${placement}`} />,
}));
vi.mock('../../src/renderer/lib/shortcut-actions', () => ({ executeShortcutAction }));
vi.mock('../../src/renderer/components/ui/DeferredDialog', () => ({ DeferredDialog: Null }));
vi.mock('../../src/renderer/components/layout/settings/SettingsDialogHost', () => ({
  SettingsDialogHost: Null,
}));
vi.mock('../../src/renderer/components/ssh-hosts/SshHostDialogHost', () => ({
  SshHostDialogHost: Null,
}));
vi.mock('../../src/renderer/components/ssh-hosts/SshHostProjectsDialog', () => ({
  SshHostProjectsDialogHost: Null,
}));
vi.mock('../../src/renderer/components/ui/toast', () => ({ ToastContainer: Null }));
vi.mock('../../src/renderer/components/workspaces/SshCommandExecutionLocationDialogHost', () => ({
  SshCommandExecutionLocationDialogHost: Null,
}));
vi.mock('../../src/renderer/components/layout/SetupWizard', () => ({
  SetupWizard: ({ resumeProjectId }: { resumeProjectId?: string }) => (
    <div data-testid="setup-wizard" data-resume-project-id={resumeProjectId ?? ''} />
  ),
}));
vi.mock('../../src/renderer/hooks/useAgentsMenuBarItem', () => ({
  useAgentsMenuBarItem: vi.fn(),
}));
vi.mock('../../src/renderer/hooks/useAppLifecycle', () => ({ useAppLifecycle: vi.fn() }));
vi.mock('../../src/renderer/hooks/useAskpassRequests', () => ({
  useAskpassRequests: () => ({ request: null, respond: vi.fn() }),
}));
vi.mock('../../src/renderer/hooks/useVirtualDesktopHint', () => ({
  useVirtualDesktopHint: vi.fn(),
}));
vi.mock('../../src/renderer/hooks/useGitProgressEvents', () => ({ useGitProgressEvents: vi.fn() }));
vi.mock('../../src/renderer/hooks/useWindowTitle', () => ({ useWindowTitle: vi.fn() }));
vi.mock('../../src/renderer/lib/palette-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/lib/palette-runtime')>()),
  claimWindowsTitleBarOverlaySurface: () => () => {},
}));
vi.mock('../../src/renderer/hooks/useWorkspaceObservations', () => ({
  useWorkspaceObservations: vi.fn(),
}));
vi.mock('../../src/renderer/hooks/useWorktreeWatcher', () => ({
  useWorktreeWatcher: vi.fn(),
}));

const workspacesState = {
  selectedWorkspaceId: 'ws-1' as string | null,
  showDashboard: false,
  hasLoaded: true,
  workspaces: [{ id: 'ws-1', status: 'active', windowId: 'window-1' }] as Array<{
    id: string;
    status: string;
    windowId: string;
    provisioning?: boolean;
  }>,
  restartingWorkspaceIds: new Set<string>(),
};
vi.mock('../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: typeof workspacesState) => unknown) =>
    selector(workspacesState),
}));
vi.mock('../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (state: { windowId: string }) => unknown) =>
    selector({ windowId: 'window-1' }),
}));

const projectsState = {
  hasLoaded: true,
  projects: [{ id: 'project-1' }] as Array<{ id: string }>,
};
vi.mock('../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

import App from '../../src/renderer/App';
import { useConfigStore } from '../../src/renderer/stores/config.store';
import { openNewWorkspaceDialog, useDialogsStore } from '../../src/renderer/stores/dialogs.store';
import { useSshHostDialogStore } from '../../src/renderer/stores/ssh-host-dialog.store';

import type { AppConfig } from '../../src/renderer/types';

function setConfig(hasProjects: boolean, agentSetupComplete: boolean): void {
  useConfigStore.setState({
    isLoading: false,
    hasProjects,
    config: { agentSetupComplete } as AppConfig,
  });
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
    sidebarProps.mockClear();
    terminalTabsProps.mockClear();
    bannerMounts.mockClear();
    executeShortcutAction.mockClear();
    workspacesState.selectedWorkspaceId = 'ws-1';
    workspacesState.showDashboard = false;
    workspacesState.hasLoaded = true;
    workspacesState.workspaces = [{ id: 'ws-1', status: 'active', windowId: 'window-1' }];
    workspacesState.restartingWorkspaceIds = new Set();
    projectsState.hasLoaded = true;
    projectsState.projects = [{ id: 'project-1' }];
    useDialogsStore.getState().setNewWorkspaceDialogPrefill(null);
  });

  describe('setup wizard gate', () => {
    it('shows the wizard on a fresh install', async () => {
      setConfig(false, false);
      render(<App />);

      expect(await screen.findByTestId('setup-wizard')).toHaveAttribute(
        'data-resume-project-id',
        ''
      );
    });

    it('resumes onboarding that was quit after the project step', async () => {
      window.localStorage.setItem('komla.onboardingProjectId', 'project-1');
      setConfig(true, false);
      render(<App />);

      expect(await screen.findByTestId('setup-wizard')).toHaveAttribute(
        'data-resume-project-id',
        'project-1'
      );
    });

    it('does not show the wizard to existing users who never started onboarding', () => {
      setConfig(true, false);
      render(<App />);

      expect(screen.getByTestId('terminal-tabs')).toBeInTheDocument();
      expect(screen.queryByTestId('setup-wizard')).toBeNull();
    });

    it('ignores an onboarding marker whose project no longer exists', () => {
      window.localStorage.setItem('komla.onboardingProjectId', 'deleted-project');
      setConfig(true, false);
      render(<App />);

      expect(screen.getByTestId('terminal-tabs')).toBeInTheDocument();
      expect(screen.queryByTestId('setup-wizard')).toBeNull();
    });

    it('does not resume once agent setup is complete', () => {
      window.localStorage.setItem('komla.onboardingProjectId', 'project-1');
      setConfig(true, true);
      render(<App />);

      expect(screen.queryByTestId('setup-wizard')).toBeNull();
    });
  });

  it('closes the SSH host dialog when something in it opens New Workspace', () => {
    setConfig(true, true);
    render(<App />);
    act(() => useSshHostDialogStore.getState().openReady('ssh-1'));

    act(() => openNewWorkspaceDialog({ prefill: { sshHostId: 'ssh-1' } }));

    expect(useSshHostDialogStore.getState().open).toBe(false);
  });

  // Both are memoized, so opening a dialog skips them only while their props hold still.
  it('passes the sidebar and workspace view the same props when New Workspace opens', () => {
    setConfig(true, true);
    render(<App />);
    const changedProps = (spy: typeof sidebarProps, before: Record<string, unknown>) => {
      const after = spy.mock.lastCall![0] as Record<string, unknown>;
      return Object.keys(after).filter((key) => after[key] !== before[key]);
    };
    const sidebarBefore = sidebarProps.mock.lastCall![0] as Record<string, unknown>;
    const tabsBefore = terminalTabsProps.mock.lastCall![0] as Record<string, unknown>;
    const renders = sidebarProps.mock.calls.length;

    act(() => openNewWorkspaceDialog());

    expect(sidebarProps.mock.calls.length).toBeGreaterThan(renders);
    expect(changedProps(sidebarProps, sidebarBefore)).toEqual([]);
    expect(changedProps(terminalTabsProps, tabsBefore)).toEqual([]);
  });

  describe('sidebar width', () => {
    it('restores the persisted sidebar width', () => {
      window.localStorage.setItem('komla.sidebarWidth', '320');
      setConfig(true, true);
      render(<App />);

      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-width', '320');
    });

    it('persists the sidebar width when it is resized', () => {
      setConfig(true, true);
      render(<App />);

      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-width', '232');
      const { onResize } = sidebarProps.mock.lastCall![0] as { onResize: (w: number) => void };
      act(() => onResize(280));

      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-width', '280');
      expect(window.localStorage.getItem('komla.sidebarWidth')).toBe('280');
    });

    it('keeps the sidebar when there are no workspaces', () => {
      workspacesState.selectedWorkspaceId = null;
      workspacesState.workspaces = [];
      setConfig(true, true);
      render(<App />);

      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    it('hides the sidebar on the dashboard', () => {
      workspacesState.selectedWorkspaceId = null;
      workspacesState.showDashboard = true;
      setConfig(true, true);
      render(<App />);

      // Kept mounted, so closing the dashboard doesn't rebuild every card.
      expect(screen.getByTestId('sidebar')).not.toBeVisible();
    });

    it('waits for workspaces to load before showing an empty sidebar', () => {
      workspacesState.selectedWorkspaceId = null;
      workspacesState.workspaces = [];
      workspacesState.hasLoaded = false;
      setConfig(true, true);
      render(<App />);

      expect(screen.queryByTestId('sidebar')).toBeNull();
    });
  });

  describe('top of the window', () => {
    // TitleBarSlot leaves the title bar out while the workspace's tab row takes its place.
    const titleBarHidden = () => screen.queryByTestId('title-bar') === null;

    it('hides the title bar under an open workspace', () => {
      setConfig(true, true);
      render(<App />);

      expect(titleBarHidden()).toBe(true);
    });

    it('keeps the title bar while the workspace restarts or is set up, which draw no tab row', () => {
      setConfig(true, true);
      workspacesState.restartingWorkspaceIds = new Set(['ws-1']);
      const { rerender } = render(<App />);
      expect(titleBarHidden()).toBe(false);

      workspacesState.restartingWorkspaceIds = new Set();
      workspacesState.workspaces = [
        { id: 'ws-1', status: 'active', windowId: 'window-1', provisioning: true },
      ];
      rerender(<App />);
      expect(titleBarHidden()).toBe(false);
    });

    it('keeps the title bar when the selected workspace is gone', () => {
      setConfig(true, true);
      workspacesState.selectedWorkspaceId = 'ws-missing';
      render(<App />);

      expect(titleBarHidden()).toBe(false);
    });

    it('gives the tab row Command center before the settings menu, for a collapsed sidebar', () => {
      setConfig(true, true);
      render(<App />);

      const tabRow = within(screen.getByTestId('terminal-tabs'));
      const commandCenter = tabRow.getByRole('button', { name: 'Command center' });
      const settingsMenu = tabRow.getByTestId('app-menu-top-row');
      expect(commandCenter.nextElementSibling).toBe(settingsMenu);

      fireEvent.click(commandCenter);
      expect(executeShortcutAction).toHaveBeenCalledWith('commandCenter.open');
    });

    it('keeps the banners mounted when the tab row takes the top of the window', () => {
      setConfig(true, true);
      workspacesState.selectedWorkspaceId = null;
      const { rerender } = render(<App />);

      workspacesState.selectedWorkspaceId = 'ws-1';
      rerender(<App />);

      expect(bannerMounts).toHaveBeenCalledTimes(1);
    });
  });

  it("gives the work area the floating banner's height, for the panes under it to leave free", () => {
    const observed = new Map<Element, () => void>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private element?: Element;
        constructor(private readonly callback: () => void) {}
        observe(element: Element) {
          this.element = element;
          observed.set(element, this.callback);
        }
        unobserve() {}
        disconnect() {
          if (this.element) observed.delete(this.element);
        }
      }
    );
    try {
      setConfig(true, true);
      render(<App />);
      const workArea = screen.getByTestId('work-area');
      const bannerLayer = screen.getByTestId('banner-layer');
      const resize = (height: number) => {
        Object.defineProperty(bannerLayer, 'offsetHeight', { configurable: true, value: height });
        act(() => observed.get(bannerLayer)?.());
      };

      const root = document.documentElement;

      resize(50);
      expect(workArea.style.getPropertyValue('--banner-inset')).toBe('50px');
      // For what floats over the whole window, such as a settings change left waiting, under a
      // name of its own so nothing portaled out of the work area pads by it.
      expect(root.style.getPropertyValue('--window-banner-inset')).toBe('50px');
      expect(root.style.getPropertyValue('--banner-inset')).toBe('');

      resize(0);
      expect(workArea.style.getPropertyValue('--banner-inset')).toBe('0px');
      expect(root.style.getPropertyValue('--window-banner-inset')).toBe('0px');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
