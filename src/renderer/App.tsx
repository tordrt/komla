import React, { Activity, lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { ActionEditorHost } from '@/components/actions/ActionEditorHost';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AgentIntegrationUpdateBanner } from '@/components/layout/AgentIntegrationUpdateBanner';
import { AgentLaunchDefaultsDialog } from '@/components/layout/AgentLaunchDefaultsDialog';
import { AgentSetupNudgeDialog } from '@/components/layout/AgentSetupNudgeDialog';
import { AiHelpersOffBanner } from '@/components/layout/AiHelpersOffBanner';
import { AnnouncementBanner } from '@/components/layout/AnnouncementBanner';
import { AnnouncementDialog } from '@/components/layout/AnnouncementDialog';
import { AppMenu } from '@/components/layout/AppMenu';
import { AppShell } from '@/components/layout/AppShell';
import { BannerHost } from '@/components/layout/BannerHost';
import { CommandCenterButton } from '@/components/layout/CommandCenterButton';
import { PassphraseDialog } from '@/components/layout/PassphraseDialog';
import { PortChangedBanner } from '@/components/layout/PortChangedBanner';
import { PublishRepoDialogHost } from '@/components/layout/PublishRepoDialogHost';
import { PushConflictDialog } from '@/components/layout/PushConflictDialog';
import { RebaseAbortDialog } from '@/components/layout/RebaseAbortDialog';
import { SettingsDialogHost } from '@/components/layout/settings/SettingsDialogHost';
import { Sidebar } from '@/components/layout/Sidebar';
import { StatusBar } from '@/components/layout/status-bar/StatusBar';
import { TitleBar } from '@/components/layout/TitleBar';
import { UpdateBanner } from '@/components/layout/UpdateBanner';
import { UsageAnalyticsConsentBanner } from '@/components/layout/UsageAnalyticsConsentBanner';
import { ProjectIconPromptDialog } from '@/components/projects/ProjectIconPromptDialog';
import { ShortcutProvider } from '@/components/ShortcutProvider';
import { SshHostDialogHost } from '@/components/ssh-hosts/SshHostDialogHost';
import { SshHostProjectsDialogHost } from '@/components/ssh-hosts/SshHostProjectsDialog';
import { QuickLookDialog } from '@/components/terminal/QuickLookDialog';
import { PaneCloseConfirmHost } from '@/components/terminal/surfaces/PaneCloseConfirmHost';
import { TerminalTabs } from '@/components/terminal/TerminalTabs';
import { DeferredDialog } from '@/components/ui/DeferredDialog';
import { ToastContainer } from '@/components/ui/toast';
import { OpenFolderDialogHost } from '@/components/workspaces/OpenFolderDialogHost';
import { SshCommandExecutionLocationDialogHost } from '@/components/workspaces/SshCommandExecutionLocationDialogHost';
import { WorkspaceTagDialogHost } from '@/components/workspaces/WorkspaceTagMenu';
import { useAgentsMenuBarItem } from '@/hooks/useAgentsMenuBarItem';
import { useAppLifecycle } from '@/hooks/useAppLifecycle';
import { useAskpassRequests } from '@/hooks/useAskpassRequests';
import { useGitProgressEvents } from '@/hooks/useGitProgressEvents';
import { useVirtualDesktopHint } from '@/hooks/useVirtualDesktopHint';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useWorkspaceObservations } from '@/hooks/useWorkspaceObservations';
import { useWorktreeWatcher } from '@/hooks/useWorktreeWatcher';
import { readOnboardingProjectId } from '@/lib/onboarding-progress';
import { claimWindowsTitleBarOverlaySurface } from '@/lib/palette-runtime';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { useSidebarCollapsed, useSidebarWindowEmpty } from '@/lib/sidebar-collapsed';
import { readStoredSidebarWidth, storeSidebarWidth } from '@/lib/sidebar-width';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import {
  NEW_WORKSPACE_DIALOG_EVENT,
  useDialogsStore,
  type NewWorkspaceDialogPrefill,
} from '@/stores/dialogs.store';
import { useLicenseStore } from '@/stores/license.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { UpgradeTrigger } from '@/components/layout/UpgradeDialog';
import type { UpgradeDialogRequest } from '@/utils/workspace-error';

const FeedbackDialog = lazy(() =>
  import('@/components/layout/FeedbackDialog').then((module) => ({
    default: module.FeedbackDialog,
  }))
);
const SetupWizard = lazy(() =>
  import('@/components/layout/SetupWizard').then((module) => ({ default: module.SetupWizard }))
);
const ShortcutsDialog = lazy(() =>
  import('@/components/layout/ShortcutsDialog').then((module) => ({
    default: module.ShortcutsDialog,
  }))
);
const UpgradeDialog = lazy(() =>
  import('@/components/layout/UpgradeDialog').then((module) => ({ default: module.UpgradeDialog }))
);
// Dev builds only: the import is dropped from production bundles.
const ThemeLab = import.meta.env.DEV
  ? lazy(() => import('@/components/dev/ThemeLab').then((module) => ({ default: module.ThemeLab })))
  : null;
const NewWorkspaceDialog = lazy(() =>
  import('@/components/workspaces/NewWorkspaceDialog').then((module) => ({
    default: module.NewWorkspaceDialog,
  }))
);

type WorkspacesState = ReturnType<typeof useWorkspacesStore.getState>;

/** Whether the open workspace draws its tab row: not while it restarts or is still being set up. */
function selectTabsAtTop(s: WorkspacesState): boolean {
  const workspace = s.selectedWorkspaceId
    ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    : undefined;
  if (!workspace || workspace.provisioning || workspace.provisionError) return false;
  return !s.restartingWorkspaceIds.has(workspace.id);
}

/**
 * With a workspace open, its tab row is the top of the window. The title bar comes back, drawn
 * over that row, only above Settings, the full-window view that sits under it, and isn't mounted
 * while that row takes its place. The file viewer draws its own.
 */
function TitleBarSlot({ tabsAtTop, children }: { tabsAtTop: boolean; children: React.ReactNode }) {
  const settingsOpen = useSettingsDialogStore((s) => s.open);
  if (tabsAtTop && !settingsOpen) return null;
  return (
    <div className={tabsAtTop ? 'absolute inset-x-0 top-0 z-20 bg-background' : 'contents'}>
      {children}
    </div>
  );
}

const openCommandCenter = () => executeShortcutAction('commandCenter.open');

/** The app's banners, above the status bar, so they never push the tab row down. */
function AppBanners({ onOpenIntegrationsSettings }: { onOpenIntegrationsSettings: () => void }) {
  return (
    <BannerHost>
      <UpdateBanner />
      <PortChangedBanner onOpenSettings={onOpenIntegrationsSettings} />
      <AgentIntegrationUpdateBanner />
      <UsageAnalyticsConsentBanner />
      <AnnouncementBanner />
      <AiHelpersOffBanner />
    </BannerHost>
  );
}

/** Everything above the status bar, flat beside the sidebar. */
function WorkArea({ children }: { children: React.ReactNode }) {
  const statusBarShown = useConfigStore((s) => !!s.config && s.config.showStatusBar !== false);
  // The line above the status bar matches the work column's left edge.
  return (
    <div
      data-testid="work-area"
      className={cn(
        'relative flex min-h-0 flex-1 flex-col overflow-hidden border-foreground/15 bg-card',
        statusBarShown && 'border-b'
      )}
    >
      {children}
    </div>
  );
}

export default function App() {
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [newWorkspaceDialogOpen, setNewWorkspaceDialogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [wizardComplete, setWizardComplete] = useState(false);
  const [onboardingProjectId] = useState(readOnboardingProjectId);
  const { request: passphraseRequest, respond: handlePassphraseResponse } = useAskpassRequests();
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [upgradeTrigger, setUpgradeTrigger] = useState<UpgradeTrigger>('limit');
  const [upgradeRetryAction, setUpgradeRetryAction] = useState<(() => void) | null>(null);

  // State rather than refs, so the project accent reaches them whenever they mount.
  const [sidebarElement, setSidebarElement] = useState<HTMLDivElement | null>(null);
  const [mainElement, setMainElement] = useState<HTMLElement | null>(null);

  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const showDashboard = useWorkspacesStore((s) => s.showDashboard);
  const workspacesLoaded = useWorkspacesStore((s) => s.hasLoaded);
  // With a workspace open, its tab row is the top of the window (see TitleBarSlot).
  const tabsAtTop = useWorkspacesStore(selectTabsAtTop);
  const agentSetupComplete = useConfigStore((s) => s.config?.agentSetupComplete);
  const hasProjects = useConfigStore((s) => s.hasProjects);
  const configLoading = useConfigStore((s) => s.isLoading);
  const projectsLoaded = useProjectsStore((s) => s.hasLoaded);
  // Held back until the lists load, so a launch doesn't flash the sidebar's empty state.
  const sidebarMounted = selectedWorkspaceId !== null || (workspacesLoaded && projectsLoaded);
  // Overview hides it but keeps it mounted, so closing Overview doesn't rebuild every card.
  const showSidebar = sidebarMounted && (selectedWorkspaceId !== null || !showDashboard);
  // A window without workspaces of its own collapses it until the first one arrives.
  const currentWindowId = useWindowStore((s) => s.windowId);
  const windowHasWorkspaces = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.status === 'active' && w.windowId === currentWindowId)
  );
  useSidebarWindowEmpty(workspacesLoaded && !windowHasWorkspaces);
  // Its button in the top row collapses it; collapsed, it stays mounted but hidden.
  const sidebarCollapsed = useSidebarCollapsed();
  const sidebarShown = showSidebar && !sidebarCollapsed;
  const onboardingProjectExists = useProjectsStore((s) =>
    s.projects.some((p) => p.id === onboardingProjectId)
  );
  // Onboarding quit after its project step: resume it, but only while that
  // project still exists. Users with projects and no marker never see the wizard.
  const resumeOnboarding =
    hasProjects && onboardingProjectId !== null && (!projectsLoaded || onboardingProjectExists);
  const showSetupWizard =
    !configLoading && !agentSetupComplete && !wizardComplete && (!hasProjects || resumeOnboarding);
  const quota = useLicenseStore((s) => s.quota);
  // Subscribe to worktree file change events for git status updates
  useWorktreeWatcher();
  useWorkspaceObservations();
  useVirtualDesktopHint();
  useGitProgressEvents();
  useAgentsMenuBarItem();
  useWindowTitle();

  // Listen for upgrade dialog trigger events (fired by UI when running workspace limit is hit)
  useEffect(() => {
    const handler = (e: Event) => {
      const request = (e as CustomEvent<UpgradeDialogRequest | undefined>).detail;
      const retry = request?.retry;
      setUpgradeTrigger(request?.trigger ?? 'limit');
      setUpgradeRetryAction(() => retry ?? null);
      setUpgradeDialogOpen(true);
    };
    window.addEventListener('show-upgrade-dialog', handler);
    return () => window.removeEventListener('show-upgrade-dialog', handler);
  }, []);

  // Open the new-workspace dialog from anywhere with optional prefill (e.g. fork from a workspace card).
  // The free limit counts SSH workspaces only, so creating one checks it and offers the upgrade.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as NewWorkspaceDialogPrefill | undefined;
      useDialogsStore.getState().setNewWorkspaceDialogPrefill(detail ?? null);
      // Close Settings so the new-workspace dialog isn't buried behind it
      // when launched from a settings surface (e.g. the self-integration
      // skill button), which the SSH host dialog also shows.
      useSettingsDialogStore.getState().closeSettings();
      useSshHostDialogStore.getState().close();
      setNewWorkspaceDialogOpen(true);
    };
    window.addEventListener(NEW_WORKSPACE_DIALOG_EVENT, handler);
    return () => window.removeEventListener(NEW_WORKSPACE_DIALOG_EVENT, handler);
  }, []);

  // All lifecycle effects: data loading, subscriptions, event listeners, theming
  useAppLifecycle({
    sidebarElement,
    mainElement,
    setNewWorkspaceDialogOpen,
    setFeedbackOpen,
  });

  // The wizard's title bar sits on the sidebar's chrome, so the Windows window controls do too,
  // from the first frame rather than once the lazy wizard loads.
  useEffect(() => {
    if (!showSetupWizard) return;
    return claimWindowsTitleBarOverlaySurface('chrome');
  }, [showSetupWizard]);

  const { openSettings } = useSettingsDialogStore.getState();
  const openIntegrationsSettings = () => openSettings({ tab: 'integrations' });

  // In the sidebar's corner, or in the tab row while the sidebar is collapsed.
  const renderAppMenu = useCallback(
    (placement: 'sidebar' | 'top-row') => (
      <AppMenu
        placement={placement}
        onOpenSettings={() => openSettings()}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenFeedback={() => setFeedbackOpen(true)}
        onOpenUpgrade={() => {
          setUpgradeTrigger('settings');
          setUpgradeRetryAction(null);
          setUpgradeDialogOpen(true);
        }}
        onOpenSettingsTab={(tab, target) => openSettings({ ...target, tab })}
        onOpenNewWorkspace={() => setNewWorkspaceDialogOpen(true)}
      />
    ),
    [openSettings]
  );

  // The sidebar and the workspace view are memoized, and these hold still, so opening one of
  // the dialogs above doesn't re-render them.
  const renderCollapsedSidebarControls = useCallback(
    () => (
      <>
        <CommandCenterButton
          className="no-drag text-muted-foreground hover:text-foreground"
          onClick={openCommandCenter}
        />
        {renderAppMenu('top-row')}
      </>
    ),
    [renderAppMenu]
  );

  const handleSidebarResize = useCallback((width: number) => {
    setSidebarWidth(width);
    storeSidebarWidth(width);
  }, []);

  const handleUpgradeNeeded = useCallback((trigger: UpgradeTrigger) => {
    setUpgradeTrigger(trigger);
    setUpgradeDialogOpen(true);
  }, []);

  if (configLoading) {
    return (
      <AppShell>
        <div className="flex h-screen flex-col">
          <TitleBar />
          <div className="flex flex-1 items-center justify-center">
            <div className="text-muted-foreground">Loading...</div>
          </div>
        </div>
      </AppShell>
    );
  }

  if (showSetupWizard) {
    return (
      <AppShell>
        <div className="setup-wizard-surface flex h-screen flex-col">
          <TitleBar />
          <div className="flex-1 overflow-auto">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  Loading...
                </div>
              }
            >
              <SetupWizard
                resumeProjectId={resumeOnboarding ? onboardingProjectId : undefined}
                onComplete={() => setWizardComplete(true)}
              />
            </Suspense>
          </div>
        </div>

        <PassphraseDialog
          open={passphraseRequest !== null}
          request={passphraseRequest}
          onResponse={handlePassphraseResponse}
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <ShortcutProvider onOpenNewWorkspaceDialog={() => setNewWorkspaceDialogOpen(true)}>
        {/* The sidebar runs the full window height; the title and status bars span only the main
            column, which sits on the sidebar's color as a card with rounded left corners. */}
        <div className="window-chrome flex h-screen min-h-0 overflow-hidden">
          {sidebarMounted && (
            <Activity mode={showSidebar ? 'visible' : 'hidden'}>
              <Sidebar
                ref={setSidebarElement}
                width={sidebarWidth}
                onResize={handleSidebarResize}
                onNewWorkspaceDialogChange={setNewWorkspaceDialogOpen}
                onUpgradeNeeded={handleUpgradeNeeded}
                onOpenCommandCenter={openCommandCenter}
                renderAppMenu={renderAppMenu}
              />
            </Activity>
          )}

          <div
            className={cn(
              'work-column relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card',
              sidebarShown && 'rounded-tl-[14px] border-l border-foreground/15'
            )}
          >
            <WorkArea>
              <TitleBarSlot tabsAtTop={tabsAtTop}>
                <TitleBar
                  sidebarVisible={sidebarShown}
                  onOpenSettings={() => openSettings()}
                  onOpenShortcuts={() => setShortcutsOpen(true)}
                  onOpenFeedback={() => setFeedbackOpen(true)}
                  onOpenUpgrade={() => {
                    setUpgradeTrigger('settings');
                    setUpgradeRetryAction(null);
                    setUpgradeDialogOpen(true);
                  }}
                  onOpenSettingsTab={(tab, target) => openSettings({ ...target, tab })}
                  onOpenNewWorkspace={() => setNewWorkspaceDialogOpen(true)}
                  onOpenCommandCenter={openCommandCenter}
                />
              </TitleBarSlot>
              <main ref={setMainElement} className="min-h-0 flex-1 overflow-hidden">
                <ErrorBoundary>
                  <TerminalTabs
                    onNewWorkspaceDialogChange={setNewWorkspaceDialogOpen}
                    renderCollapsedSidebarControls={renderCollapsedSidebarControls}
                  />
                </ErrorBoundary>
              </main>
              <AppBanners onOpenIntegrationsSettings={openIntegrationsSettings} />
            </WorkArea>
            <StatusBar
              tipsActions={{
                onOpenShortcuts: () => setShortcutsOpen(true),
                onOpenFeedback: () => setFeedbackOpen(true),
                onOpenSettingsTab: (tab, target) => openSettings({ ...target, tab }),
                onOpenNewWorkspace: () => setNewWorkspaceDialogOpen(true),
              }}
            />
          </div>

          <DeferredDialog open={newWorkspaceDialogOpen}>
            <NewWorkspaceDialog
              open={newWorkspaceDialogOpen}
              onOpenChange={setNewWorkspaceDialogOpen}
            />
          </DeferredDialog>

          <SshCommandExecutionLocationDialogHost />

          <OpenFolderDialogHost />

          <DeferredDialog open={upgradeDialogOpen}>
            <UpgradeDialog
              open={upgradeDialogOpen}
              onOpenChange={(open) => {
                setUpgradeDialogOpen(open);
                if (!open) setUpgradeRetryAction(null);
              }}
              trigger={upgradeTrigger}
              workspaceLimit={quota?.limit ?? 4}
              onRetry={upgradeRetryAction ?? undefined}
            />
          </DeferredDialog>

          <SettingsDialogHost />

          <SshHostDialogHost />

          <SshHostProjectsDialogHost />

          <PublishRepoDialogHost />

          <WorkspaceTagDialogHost />

          <DeferredDialog open={shortcutsOpen}>
            <ShortcutsDialog
              open={shortcutsOpen}
              onOpenChange={setShortcutsOpen}
              onOpenShortcutsSettings={() => {
                setShortcutsOpen(false);
                openSettings({ tab: 'shortcuts' });
              }}
            />
          </DeferredDialog>

          <DeferredDialog open={feedbackOpen}>
            <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
          </DeferredDialog>

          <AnnouncementDialog />

          <PassphraseDialog
            open={passphraseRequest !== null}
            request={passphraseRequest}
            onResponse={handlePassphraseResponse}
          />

          <PushConflictDialog />
          <RebaseAbortDialog />
          <AgentSetupNudgeDialog blocked={newWorkspaceDialogOpen} />
          <AgentLaunchDefaultsDialog />
          <ProjectIconPromptDialog blocked={newWorkspaceDialogOpen} />
          <QuickLookDialog />
          <ActionEditorHost />
          <PaneCloseConfirmHost />

          <ToastContainer />
          {ThemeLab && (
            <Suspense fallback={null}>
              <ThemeLab />
            </Suspense>
          )}
        </div>
      </ShortcutProvider>
    </AppShell>
  );
}
