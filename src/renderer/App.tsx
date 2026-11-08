import React, {
  Activity,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

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
import { PublishRepoDialogHost } from '@/components/layout/PublishRepoDialogHost';
import { PushConflictDialog } from '@/components/layout/PushConflictDialog';
import { RebaseAbortDialog } from '@/components/layout/RebaseAbortDialog';
import { RunningAtLastQuitBanner } from '@/components/layout/RunningAtLastQuitBanner';
import { SettingsDialogHost } from '@/components/layout/settings/SettingsDialogHost';
import { Sidebar } from '@/components/layout/Sidebar';
import { StatusBar } from '@/components/layout/status-bar/StatusBar';
import { TitleBar } from '@/components/layout/TitleBar';
import { UpdateBanner } from '@/components/layout/UpdateBanner';
import { UsageAnalyticsConsentBanner } from '@/components/layout/UsageAnalyticsConsentBanner';
import { ProjectIconPromptDialog } from '@/components/projects/ProjectIconPromptDialog';
import { PromptDraftOutlet } from '@/components/prompt-draft/PromptDraft';
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
import { usePoppedOutPromptDraft } from '@/hooks/usePoppedOutPromptDraft';
import { useVirtualDesktopHint } from '@/hooks/useVirtualDesktopHint';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useWorkspaceObservations } from '@/hooks/useWorkspaceObservations';
import { useWorktreeWatcher } from '@/hooks/useWorktreeWatcher';
import { readOnboardingProjectId } from '@/lib/onboarding-progress';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { useSidebarCollapsed, useSidebarWindowEmpty } from '@/lib/sidebar-collapsed';
import { readStoredSidebarWidth, storeSidebarWidth } from '@/lib/sidebar-width';
import { useConfigStore } from '@/stores/config.store';
import {
  NEW_WORKSPACE_DIALOG_EVENT,
  useDialogsStore,
  type NewWorkspaceDialogPrefill,
} from '@/stores/dialogs.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

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
// Dev builds only: the import is dropped from production bundles.
const ThemeLab = import.meta.env.DEV
  ? lazy(() => import('@/components/dev/ThemeLab').then((module) => ({ default: module.ThemeLab })))
  : null;
const loadNewWorkspaceDialog = () => import('@/components/workspaces/NewWorkspaceDialog');
const NewWorkspaceDialog = lazy(() =>
  loadNewWorkspaceDialog().then((module) => ({ default: module.NewWorkspaceDialog }))
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

/** The app's banners, floating at the work area's bottom, so they never push the tab row down. */
function AppBanners() {
  return (
    <BannerHost>
      <UpdateBanner />
      <RunningAtLastQuitBanner />
      <AgentIntegrationUpdateBanner />
      <UsageAnalyticsConsentBanner />
      <AnnouncementBanner />
      <AiHelpersOffBanner />
    </BannerHost>
  );
}

/** Everything above the status bar, on the sidebar's chrome with no line between them. */
function WorkArea({ banners, children }: { banners: React.ReactNode; children: React.ReactNode }) {
  const workAreaRef = useRef<HTMLDivElement>(null);
  const bannerLayerRef = useRef<HTMLDivElement>(null);

  // The banner floats over the panes, so its height goes to `--banner-inset`: panes at the
  // work area's bottom pad by it, their own background running on under the banner. Written to
  // the DOM, not React state, so the inset changes in the frame the banner does. The root gets it
  // as `--window-banner-inset`, for what floats over the whole window above the banner, such as a
  // settings change left waiting; a name of its own keeps it from padding what's portaled out of
  // the work area.
  useLayoutEffect(() => {
    const workArea = workAreaRef.current;
    const layer = bannerLayerRef.current;
    if (!workArea || !layer || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const update = () => {
      const inset = `${layer.offsetHeight}px`;
      workArea.style.setProperty('--banner-inset', inset);
      root.style.setProperty('--window-banner-inset', inset);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(layer);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--window-banner-inset');
    };
  }, []);

  return (
    <div
      ref={workAreaRef}
      data-testid="work-area"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {children}
      {/* Above a split's divider (z-index 35) and below the blame gutter's inline z-50 menu,
          except in a full-screen preview, whose z-10 layer keeps that menu under the banner. */}
      <div
        ref={bannerLayerRef}
        data-testid="banner-layer"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-40 *:pointer-events-auto"
      >
        {banners}
      </div>
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
  // Subscribe to worktree file change events for git status updates
  useWorktreeWatcher();
  useWorkspaceObservations();
  useVirtualDesktopHint();
  useGitProgressEvents();
  useAgentsMenuBarItem();
  usePoppedOutPromptDraft();
  useWindowTitle();

  // Open the new-workspace dialog from anywhere with optional prefill (e.g. fork from a workspace card).
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

  const { openSettings } = useSettingsDialogStore.getState();

  // In the sidebar's corner, or in the tab row while the sidebar is collapsed.
  const renderAppMenu = useCallback(
    (placement: 'sidebar' | 'top-row') => (
      <AppMenu
        placement={placement}
        onOpenSettings={() => openSettings()}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenFeedback={() => setFeedbackOpen(true)}
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

  if (configLoading) {
    return (
      <AppShell>
        {/* On the sidebar's chrome, as the window controls are on Windows. */}
        <div className="flex h-screen flex-col bg-[oklch(var(--chrome))] [--card:var(--chrome)]">
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
            column, which sits on the sidebar's color too. */}
        <div className="window-chrome flex h-screen min-h-0 overflow-hidden">
          {sidebarMounted && (
            <Activity mode={showSidebar ? 'visible' : 'hidden'}>
              <Sidebar
                ref={setSidebarElement}
                width={sidebarWidth}
                onResize={handleSidebarResize}
                onNewWorkspaceDialogChange={setNewWorkspaceDialogOpen}
                onOpenCommandCenter={openCommandCenter}
                renderAppMenu={renderAppMenu}
              />
            </Activity>
          )}

          <div
            // On the sidebar's chrome with no line between them, so the rounded panes are the only
            // raised surface: the chrome runs on under the tab row, around the panes and under the
            // status bar.
            className="work-column relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            <WorkArea banners={<AppBanners />}>
              <TitleBarSlot tabsAtTop={tabsAtTop}>
                <TitleBar
                  sidebarVisible={sidebarShown}
                  onOpenSettings={() => openSettings()}
                  onOpenShortcuts={() => setShortcutsOpen(true)}
                  onOpenFeedback={() => setFeedbackOpen(true)}
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

          <DeferredDialog open={newWorkspaceDialogOpen} preload={loadNewWorkspaceDialog}>
            <NewWorkspaceDialog
              open={newWorkspaceDialogOpen}
              onOpenChange={setNewWorkspaceDialogOpen}
            />
          </DeferredDialog>

          <SshCommandExecutionLocationDialogHost />

          <OpenFolderDialogHost />

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
          <PromptDraftOutlet workspaceId={selectedWorkspaceId} />
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
