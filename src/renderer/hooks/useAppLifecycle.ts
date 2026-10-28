import { useEffect } from 'react';

import { isSshForwardedBrowserTab, updatePaneBrowserTabs } from '@/lib/browser-tabs';
import {
  disposeRenderersOfRemovedTerminals,
  handleTerminalExit,
  reconcileRemovedTerminalPanes,
  retryPendingTerminalExits,
  retryPendingTerminalExitsOnChange,
} from '@/lib/close-terminal-pane';
import { getFocusedTerminalId } from '@/lib/focused-terminal';
import { cacheCustomSound, CUSTOM_PREFIX, playNotificationSound } from '@/lib/notification-sounds';
import { openFolder } from '@/lib/open-folder';
import { revealTerminal } from '@/lib/open-workspace';
import {
  getActivePalette,
  subscribePalette,
  subscribeSystemAppearance,
  systemIsDark,
} from '@/lib/palette-runtime';
import {
  adoptPaneSurfaces,
  closePagesOfRemovedPaneBrowserTabs,
  forgetSurfacesOfRemovedPanes,
  getWorkspacePaneSurfaces,
  openInBrowserPane,
  reportUnsavedFiles,
  reportWorkspacesShowingPaneSurfaces,
  restoreSavedBrowserPanes,
  saveBrowserPanes,
} from '@/lib/pane-surfaces';
import { applyAccent } from '@/lib/primary-color';
import { applyReduceEffects } from '@/lib/reduce-effects';
import { resolveOpenSettingsTarget, type OpenSettingsDetail } from '@/lib/settings-navigation';
import { reportShownWorkspace } from '@/lib/shown-workspace';
import { clearTerminalHost } from '@/lib/terminal-host-tracker';
import { disposeTerminalRenderers } from '@/lib/terminal-renderer-runtime';
import { syncPaletteFromTheme } from '@/lib/theme-palette';
import { announceVirtualDesktop } from '@/lib/virtual-desktops';
import { resolveAttentionDelivery } from '@/lib/workspace-attention';
import {
  hydratePersistedWorkspaceLayout,
  isWorkspaceLayoutPlaceholder,
  keepWorkspaceLayoutView,
} from '@/lib/workspace-layout-hydration';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useAnnouncementStore } from '@/stores/announcement.store';
import { useAutomationsStore } from '@/stores/automations.store';
import { useCategoriesStore } from '@/stores/categories.store';
import { useConfigStore } from '@/stores/config.store';
import { useCustomizationStore } from '@/stores/customization.store';
import { useDialogsStore } from '@/stores/dialogs.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useLicenseStore } from '@/stores/license.store';
import { setLocalMirrorSyncStatus } from '@/stores/local-mirror-sync.store';
import { useProjectSyncStatusStore } from '@/stores/project-sync-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { formatShortcutForDisplay, useShortcutsStore } from '@/stores/shortcuts.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useUpdateStore } from '@/stores/update.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

import { shownTheme } from '../../shared/lib/appearance';
import { addBrowserTab, getBrowserTabs, recordBrowserTabPage } from '../../shared/lib/browser-tabs';
import { isLoopbackUrl } from '../../shared/lib/loopback-url';
import { getPaneSurfaceIdOfTab } from '../../shared/lib/pane-surface-id';

import { awaitUserReturn } from './useAwaitingUserReturn';
import { useProjectAccent } from './useProjectAccent';
import { useWorkspaceLayoutPersistence } from './useWorkspaceLayoutPersistence';

// How long after "online" the network usually takes to resolve names and route again.
const NETWORK_SETTLE_MS = 3000;

/** Extract OKLCH values from "oklch(L C H)" string format → "L C H" for CSS variables */
interface AppLifecycleOptions {
  sidebarElement: HTMLDivElement | null;
  mainElement: HTMLElement | null;
  setNewWorkspaceDialogOpen: (open: boolean) => void;
  setFeedbackOpen: (open: boolean) => void;
}

export function useAppLifecycle(options: AppLifecycleOptions): void {
  useWorkspaceLayoutPersistence();

  const { sidebarElement, mainElement, setNewWorkspaceDialogOpen, setFeedbackOpen } = options;

  // Select only what this hook reads: it runs in App, so any wider subscription re-renders it all.
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const updateTerminalStatus = useWorkspacesStore((s) => s.updateTerminalStatus);
  const setAttention = useWorkspacesStore((s) => s.setAttention);
  const invalidateStatus = useGitStatusStore((s) => s.invalidateStatus);
  const fetchStatus = useGitStatusStore((s) => s.fetchStatus);
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const hasProjects = useConfigStore((s) => s.hasProjects);
  const subscribeToConfigChanges = useConfigStore((s) => s.subscribeToChanges);
  const loadCategories = useCategoriesStore((s) => s.loadCategories);
  const subscribeToCategoriesChanges = useCategoriesStore((s) => s.subscribeToChanges);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const subscribeToProjectsChanges = useProjectsStore((s) => s.subscribeToChanges);
  const theme = useCustomizationStore((s) => s.theme);
  const loadCustomization = useCustomizationStore((s) => s.loadCustomization);
  const subscribeToChanges = useCustomizationStore((s) => s.subscribeToChanges);
  const loadShortcuts = useShortcutsStore((s) => s.loadShortcuts);
  const subscribeToShortcutsChanges = useShortcutsStore((s) => s.subscribeToChanges);
  const loadActions = useActionsStore((s) => s.loadActions);
  const subscribeToActionsChanges = useActionsStore((s) => s.subscribeToChanges);
  const loadPresets = useAgentPresetsStore((s) => s.loadPresets);
  const subscribeToPresetsChanges = useAgentPresetsStore((s) => s.subscribeToChanges);
  const setAvailable = useUpdateStore((s) => s.setAvailable);
  const setNotAvailable = useUpdateStore((s) => s.setNotAvailable);
  const setReady = useUpdateStore((s) => s.setReady);
  const setError = useUpdateStore((s) => s.setError);
  const setAnnouncements = useAnnouncementStore((s) => s.setAnnouncements);
  const subscribeToWindowEvents = useWindowStore((s) => s.subscribeToWindowEvents);
  const loadProjectSyncStatuses = useProjectSyncStatusStore((s) => s.loadAllStatuses);
  const loadLicenseStatus = useLicenseStore((s) => s.loadStatus);
  const loadQuota = useLicenseStore((s) => s.loadQuota);
  const loadSshHosts = useSshHostsStore((state) => state.loadHosts);
  const subscribeToSshHostChanges = useSshHostsStore((state) => state.subscribeToChanges);
  const loadAutomations = useAutomationsStore((state) => state.loadAutomations);
  const subscribeToAutomationsChanges = useAutomationsStore((state) => state.subscribeToChanges);

  // Load initial data
  useEffect(() => {
    const init = async () => {
      await Promise.all([loadConfig(), loadSshHosts()]);
      await Promise.all([
        loadCustomization(),
        loadShortcuts(),
        loadActions(),
        loadPresets(),
        loadQuota(),
        // Only hosts Komla connects to anyway; the rest are read when the automations list opens.
        loadAutomations({ readHosts: 'in-use' }),
      ]);
    };
    void init();
  }, [
    loadConfig,
    loadSshHosts,
    loadCustomization,
    loadShortcuts,
    loadActions,
    loadPresets,
    loadQuota,
    loadAutomations,
  ]);

  // Subscribe to window events, hot-reload events, and IPC events
  useEffect(() => {
    const cleanups = [
      subscribeToWindowEvents(),
      subscribeToChanges(),
      subscribeToShortcutsChanges(),
      subscribeToProjectsChanges(),
      subscribeToActionsChanges(),
      subscribeToCategoriesChanges(),
      subscribeToPresetsChanges(),
      subscribeToSshHostChanges(),
      subscribeToConfigChanges(),
      subscribeToAutomationsChanges(),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [
    subscribeToWindowEvents,
    subscribeToChanges,
    subscribeToShortcutsChanges,
    subscribeToProjectsChanges,
    subscribeToActionsChanges,
    subscribeToCategoriesChanges,
    subscribeToPresetsChanges,
    subscribeToSshHostChanges,
    subscribeToConfigChanges,
    subscribeToAutomationsChanges,
  ]);

  // Workspace window management: cross-window moves, select, and moved-here events
  useEffect(() => {
    const cleanups = [
      window.api.onWorkspaceWindowChanged((workspaceId, windowId) => {
        const store = useWorkspacesStore.getState();
        const currentWindowId = useWindowStore.getState().windowId;

        store.updateWorkspace(workspaceId, { windowId });

        // If the workspace is leaving this window, clean up its resources
        if (windowId !== currentWindowId) {
          const workspace = store.workspaces.find((w) => w.id === workspaceId);
          const terminalIds = workspace?.terminals.map((t) => t.id) || [];
          disposeTerminalRenderers(terminalIds);
          useLayoutStore.getState().clearWorkspaceLayout(workspaceId);

          if (store.selectedWorkspaceId === workspaceId) {
            useWorkspacesStore.setState({ selectedWorkspaceId: null });
          }
        }
      }),

      window.api.onWorkspaceSelect((workspaceId, terminalId) => {
        if (terminalId) revealTerminal(workspaceId, terminalId);
        void useWorkspacesStore.getState().selectWorkspace(workspaceId);
      }),

      window.api.onLocalMirrorSyncStatus((status) => {
        setLocalMirrorSyncStatus(status);
      }),

      window.api.onWorkspaceMovedHere(async (workspaceId, layoutData) => {
        // Ensure workspaces are loaded (on a fresh window they may not be yet)
        await useWorkspacesStore.getState().loadWorkspaces();

        const freshWorkspace = await window.api.getWorkspace(workspaceId);
        if (freshWorkspace) {
          const store = useWorkspacesStore.getState();
          const exists = store.workspaces.some((w) => w.id === workspaceId);
          if (exists) {
            store.updateWorkspace(workspaceId, freshWorkspace);
          } else {
            // Workspace wasn't in the store yet — add it
            useWorkspacesStore.setState((state) => ({
              workspaces: [...state.workspaces, freshWorkspace],
            }));
          }
        }

        const layoutStore = useLayoutStore.getState();
        layoutStore.clearWorkspaceLayout(workspaceId);

        if (layoutData && typeof layoutData === 'object' && 'tabs' in layoutData) {
          const data = layoutData as {
            tabs: string[];
            layouts: Record<string, unknown>;
            focusedPanes: Record<string, string>;
            activeTab: string;
            surfaces?: unknown;
          };
          // Before the layout, so its browser and note panes have something to show.
          adoptPaneSurfaces(data.surfaces);
          if (data.tabs.length > 0) {
            layoutStore.applyWorkspaceLayout(
              workspaceId,
              data as Parameters<typeof layoutStore.applyWorkspaceLayout>[1]
            );
          }
        }

        // Dismiss the dashboard so the workspace list is visible
        useWorkspacesStore.setState({ showDashboard: false });
      }),
    ];

    // Signal to main process that event listeners are mounted and ready to receive messages
    window.api.notifyRendererReady();

    return () => cleanups.forEach((fn) => fn());
  }, []);

  // Pre-cache any custom notification sounds referenced in config
  useEffect(() => {
    const ns = config?.notificationSounds;
    if (!ns) return;
    for (const val of [ns.turnCompleteSound, ns.inputRequiredSound]) {
      if (val.startsWith(CUSTOM_PREFIX)) {
        void cacheCustomSound(val.slice(CUSTOM_PREFIX.length));
      }
    }
  }, [config?.notificationSounds]);

  useEffect(() => {
    applyReduceEffects(config?.reduceEffects === true);
  }, [config?.reduceEffects]);

  useEffect(() => {
    const grouping = config?.workspaceGrouping ?? 'project';
    useWorkspacesStore.setState({ grouping });
  }, [config?.workspaceGrouping]);

  // Restore stopped workspace visibility from persisted config
  useEffect(() => {
    const hideStopped = config?.hideStoppedWorkspaces ?? false;
    useWorkspacesStore.setState({ hideStopped });
  }, [config?.hideStoppedWorkspaces]);

  useEffect(() => {
    const hideWorking = config?.hideWorkingWorkspaces ?? false;
    useWorkspacesStore.setState({ hideWorking });
  }, [config?.hideWorkingWorkspaces]);

  useEffect(() => {
    const ids = config?.hiddenWorkspaceHostIds ?? [];
    useWorkspacesStore.setState({ hiddenWorkspaceHostIds: new Set(ids) });
  }, [config?.hiddenWorkspaceHostIds]);

  useEffect(() => {
    const tags = config?.hiddenWorkspaceTags ?? [];
    useWorkspacesStore.setState({ hiddenWorkspaceTags: new Set(tags) });
  }, [config?.hiddenWorkspaceTags]);

  useEffect(() => {
    const ids = config?.dashboardHiddenWorkspaceHostIds ?? [];
    useWorkspacesStore.setState({ dashboardHiddenWorkspaceHostIds: new Set(ids) });
  }, [config?.dashboardHiddenWorkspaceHostIds]);

  // Restore hidden project IDs from persisted config
  useEffect(() => {
    const ids = config?.hiddenProjectIds ?? [];
    useWorkspacesStore.setState({ hiddenProjectIds: new Set(ids) });
  }, [config?.hiddenProjectIds]);

  // Restore the dashboard project filter from persisted config
  useEffect(() => {
    const project = config?.dashboardFilterProject ?? null;
    useWorkspacesStore.setState({ dashboardFilterProject: project });
  }, [config?.dashboardFilterProject]);

  // Load workspaces on mount so hasLoaded flips to true even when the user
  // completes the setup wizard without creating a project — otherwise the
  // TerminalTabs !hasLoaded guard shows a permanent blank screen.
  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Project-scoped data only exists once projects are configured.
  useEffect(() => {
    if (hasProjects) {
      void loadProjects();
      void loadCategories();
      void loadProjectSyncStatuses();
    }
  }, [hasProjects, loadProjects, loadCategories, loadProjectSyncStatuses]);

  // Terminal and workspace event listeners
  useEffect(() => {
    retryPendingTerminalExits();

    const cleanups = [
      retryPendingTerminalExitsOnChange(),

      window.api.onTerminalStatusChange((terminalId, status) => {
        updateTerminalStatus(terminalId, status);

        // Refresh quota so the upgrade dialog's count stays accurate across all windows,
        // even when WorkspaceQuota (sidebar) isn't mounted (e.g. dashboard view).
        void loadQuota();

        if (status === 'stopped') {
          // Drop any host badge — a restart reuses the terminal ID, and the
          // new session reports its host again if it runs on another one.
          clearTerminalHost(terminalId);
          for (const workspace of useWorkspacesStore.getState().workspaces) {
            const terminal = workspace.terminals.find((t) => t.id === terminalId);
            if (terminal && workspace.workingDirectory) {
              invalidateStatus(workspace.id);
              void fetchStatus(workspace.id, workspace.workingDirectory);
              break;
            }
          }
        }
      }),

      window.api.onTerminalExit(handleTerminalExit),

      window.api.onWorkspaceNeedsAttention((event) => {
        const { workspaceId, attention, workspaceAttention, userAway } = event;
        const { selectedWorkspaceId, workspaces } = useWorkspacesStore.getState();
        const { windowId, availableWindows } = useWindowStore.getState();
        const filePreview = useFileViewerStore.getState().inlineFilePreviewByWorkspace[workspaceId];
        const isPreviewFullscreen =
          !!filePreview?.open && (filePreview.layout ?? 'full') === 'full';
        const windowFocused = document.hasFocus();
        const workspace = workspaces.find((w) => w.id === workspaceId);
        const { action, playSound, awaitReturn } = resolveAttentionDelivery(attention, {
          currentWindowId: windowId,
          ownerWindowId: workspace?.windowId,
          openWindows: availableWindows,
          isSelected: workspaceId === selectedWorkspaceId,
          windowFocused,
          previewFullscreen: isPreviewFullscreen,
          focusedTerminalId: getFocusedTerminalId(workspaceId),
          userAway,
          snoozed: event.snoozed === true,
        });

        if (awaitReturn) {
          // The selected card keeps its badge too. A workspace-wide alert is seen once the
          // user is back while the workspace is still on screen; a terminal's clears with it.
          awaitUserReturn(
            attention.terminalId
              ? undefined
              : () => {
                  if (
                    useWorkspacesStore.getState().selectedWorkspaceId === workspaceId &&
                    document.hasFocus()
                  ) {
                    void window.api.clearWorkspaceAttention(workspaceId);
                  }
                }
          );
        }
        if (action === 'set') {
          setAttention(workspaceId, attention, workspaceAttention, {
            windowFocused: windowFocused && !awaitReturn,
          });
        } else {
          // Tell main to clear too — otherwise the next loadWorkspaces() pulls
          // the stored attention back and the badge appears once we switch away.
          void window.api.clearWorkspaceAttention(workspaceId);
        }

        const soundsCfg = useConfigStore.getState().config?.notificationSounds;
        if (soundsCfg && playSound) {
          playNotificationSound(attention.kind, soundsCfg);
        }
      }),

      window.api.onWorkspaceCreated(() => {
        void loadWorkspaces();
      }),

      window.api.onWorkspaceUpdated((workspace) => {
        useDialogsStore.getState().settleProvisioningWorkspacePrompt(workspace);
        if (workspace.provisionError && isSshWorkspace(workspace)) {
          useToastStore
            .getState()
            .addToast(`Failed to create SSH workspace: ${workspace.provisionError}`, 'error');
        }
        reconcileRemovedTerminalPanes(workspace);
        // A workspace that wakes while open is seen once the user is back at it, as its
        // attention is.
        if (useWorkspacesStore.getState().receiveWorkspaceMarks(workspace)) {
          awaitUserReturn(() => useWorkspacesStore.getState().dismissWokeIfOpen(workspace.id));
        }
        void loadWorkspaces();
      }),

      window.api.onWorkspacesChanged(() => {
        void loadWorkspaces();
      }),

      window.api.onWorkspaceTrashRequested((request) => {
        void useWorkspacesStore.getState().trashWorkspaceForAgent(request);
      }),

      window.api.onWorkspaceRemovedOnOtherDevice(({ workspaceId, name }) => {
        useWorkspacesStore.getState().removeWorkspaceLocally(workspaceId);
        useToastStore
          .getState()
          .addToast(`Removed "${name}" — it was deleted on another device.`, 'info');
        void loadWorkspaces();
      }),

      window.api.onWorkspaceLayoutChangedOnOtherDevice(({ workspaceId, terminalIds, arranged }) => {
        void loadWorkspaces().then(() => {
          const layoutStore = useLayoutStore.getState();
          const tabs = layoutStore.tabsByWorkspace[workspaceId];
          // A layout loadWorkspaces just restored from main already has the changes.
          if (!tabs?.length || isWorkspaceLayoutPlaceholder(workspaceId, tabs)) return;
          const workspace = useWorkspacesStore
            .getState()
            .workspaces.find((candidate) => candidate.id === workspaceId);
          // Main's copy of the layout can lag this window's by a save, so only another
          // device's arrangement replaces it.
          const theirs =
            arranged &&
            workspace?.terminalLayout &&
            hydratePersistedWorkspaceLayout(workspace.terminalLayout);
          if (!workspace || !theirs) {
            for (const terminalId of terminalIds) layoutStore.addTab(workspaceId, terminalId);
            return;
          }
          const current = {
            tabs,
            layouts: layoutStore.layoutsByTab[workspaceId] ?? {},
            focusedPanes: layoutStore.focusedPaneByTab[workspaceId] ?? {},
            activeTab: layoutStore.activeTabByWorkspace[workspaceId],
          };
          const openTerminalIds = new Set([
            ...workspace.terminals.map((terminal) => terminal.id),
            // Another device never sees this window's browser and note panes; they stay.
            ...Object.keys(getWorkspacePaneSurfaces(workspaceId)),
          ]);
          layoutStore.applyWorkspaceLayout(
            workspaceId,
            keepWorkspaceLayoutView(theirs, current, openTerminalIds),
            { setCurrentWorkspace: false }
          );
        });
      }),

      window.api.onAgentTabAdded(({ workspaceId, terminalId }) => {
        void loadWorkspaces().then(() => {
          const { addTab, activeTabByWorkspace } = useLayoutStore.getState();
          addTab(workspaceId, terminalId);
          // Activate the new tab within its workspace. We update activeTabByWorkspace
          // directly because setActiveTab/showTabInFullPane only operate on the
          // currently-viewed workspace (currentWorkspaceId), which may differ.
          useLayoutStore.setState({
            activeTabByWorkspace: { ...activeTabByWorkspace, [workspaceId]: terminalId },
          });
        });
      }),

      window.api.onOpenDevPreview(({ workspaceId, url, urlExecutionLocation }) => {
        openInBrowserPane(workspaceId, url, urlExecutionLocation);
      }),

      window.api.onVirtualDesktopStarted(({ workspaceId, desktop }) => {
        announceVirtualDesktop(workspaceId, desktop);
      }),

      // A tab keeps the page it shows, with its title.
      window.api.onDevPreviewNavigationStateChanged((state) => {
        const paneSurfaceId = getPaneSurfaceIdOfTab(state.tabId);
        // A failed load keeps the URL the tab asked for.
        if (!paneSurfaceId || state.loadError) return;
        const workspace = useWorkspacesStore
          .getState()
          .workspaces.find((candidate) => candidate.id === state.workspaceId);
        updatePaneBrowserTabs(paneSurfaceId, (tabs) => {
          const tab = getBrowserTabs(tabs).find((candidate) => candidate.id === state.tabId);
          if (!tab) return null;
          // A tunnelled page's own URL is only a port on this computer.
          return recordBrowserTabPage(tabs, state.tabId, {
            url: isSshForwardedBrowserTab(workspace, tab) ? undefined : state.url,
            title: state.title,
          });
        });
      }),

      closePagesOfRemovedPaneBrowserTabs(),
      disposeRenderersOfRemovedTerminals(),
      forgetSurfacesOfRemovedPanes(),
      restoreSavedBrowserPanes(),
      saveBrowserPanes(),
      reportWorkspacesShowingPaneSurfaces(),
      reportUnsavedFiles(),
      reportShownWorkspace(),

      // A link that opens a new window opens as a tab next to its page, in its own browser.
      window.api.onDevPreviewOpenTab(({ workspaceId, tabId, url }) => {
        const workspace = useWorkspacesStore
          .getState()
          .workspaces.find((candidate) => candidate.id === workspaceId);
        // Its URL already loads on this computer, even through a tunnel.
        const location =
          workspace && isSshWorkspace(workspace) && isLoopbackUrl(url) ? 'local-mirror' : undefined;
        const paneSurfaceId = getPaneSurfaceIdOfTab(tabId);
        if (paneSurfaceId) {
          updatePaneBrowserTabs(paneSurfaceId, (tabs) => addBrowserTab(tabs, url, location));
        }
      }),

      window.api.onSettingsFeedback((message) => {
        useToastStore.getState().addToast(message, 'error');
      }),

      window.api.onHookNotice((message) => {
        useToastStore.getState().addToast(message, 'error');
      }),

      window.api.onLicenseRevoked(() => {
        void loadWorkspaces();
        void loadLicenseStatus();
        void loadQuota();
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [
    updateTerminalStatus,
    invalidateStatus,
    fetchStatus,
    setAttention,
    loadWorkspaces,
    loadLicenseStatus,
    loadQuota,
  ]);

  useEffect(() => {
    if (!theme) return;
    syncPaletteFromTheme(theme);
    if (!theme.followSystem) return;
    return subscribeSystemAppearance(() => syncPaletteFromTheme(theme));
  }, [theme]);

  // Apply custom CSS variables from theme
  useEffect(() => {
    if (!theme) return;

    const root = document.documentElement;
    const { typography } = theme;

    // globals.css sets --primary-foreground per mode, so refit the accent when the mode switches.
    // Following the system, the light theme brings its own accent, and switching swaps the palette.
    const applyThemeAccent = () =>
      applyAccent(shownTheme(theme, systemIsDark()).colors.accent, getActivePalette().mode);
    applyThemeAccent();
    const unsubscribePalette = subscribePalette(applyThemeAccent);
    root.style.setProperty('--font-family', typography.fontFamily);
    root.style.setProperty('--font-size-base', `${typography.fontSize}px`);
    root.style.setProperty('--radius', `${typography.borderRadius}px`);

    return () => {
      unsubscribePalette();
      root.style.removeProperty('--primary');
      root.style.removeProperty('--ring');
      root.style.removeProperty('--dark-primary');
      root.style.removeProperty('--komla');
      root.style.removeProperty('--font-family');
      root.style.removeProperty('--font-size-base');
      root.style.removeProperty('--radius');
    };
  }, [theme]);

  useProjectAccent(sidebarElement, mainElement);

  // Listen for auto-update events
  useEffect(() => {
    const cleanups = [
      window.api.onUpdateAvailable((info) => {
        setAvailable(info);
      }),
      window.api.onUpdateNotAvailable(() => {
        setNotAvailable();
      }),
      window.api.onUpdateDownloaded((version) => {
        setReady(version);
      }),
      window.api.onUpdateError((message) => {
        setError(message);
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [setAvailable, setNotAvailable, setReady, setError]);

  // Load and subscribe to announcements
  useEffect(() => {
    window.api
      .getAnnouncements()
      .then(setAnnouncements)
      .catch(() => {});
    const cleanup = window.api.onAnnouncementsUpdated(setAnnouncements);
    return cleanup;
  }, [setAnnouncements]);

  // Listen for open-settings / open-project-settings / open-workspace-setup events
  useEffect(() => {
    const { openSettings } = useSettingsDialogStore.getState();
    const handleOpenSettings = (e: Event) => {
      const { tab, generalSection } = resolveOpenSettingsTarget(
        (e as CustomEvent<OpenSettingsDetail>).detail
      );
      openSettings({ tab, generalSection });
    };
    const handleOpenProjectSettings = (e: Event) => {
      openSettings({ tab: 'projects', editProjectId: (e as CustomEvent<string>).detail });
    };
    const handleOpenWorkspaceSetup = (e: Event) => {
      openSettings({ tab: 'workspace-setup', setupProjectId: (e as CustomEvent<string>).detail });
    };

    window.addEventListener('open-settings', handleOpenSettings);
    window.addEventListener('open-project-settings', handleOpenProjectSettings);
    window.addEventListener('open-workspace-setup', handleOpenWorkspaceSetup);
    return () => {
      window.removeEventListener('open-settings', handleOpenSettings);
      window.removeEventListener('open-project-settings', handleOpenProjectSettings);
      window.removeEventListener('open-workspace-setup', handleOpenWorkspaceSetup);
    };
  }, []);

  // Selecting a workspace reconnects its remote sessions; coming back online does the same for
  // the one on screen. "online" can come before DNS and routes work, so it waits a moment.
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const handleOnline = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        void useWorkspacesStore.getState().reconnectAfterNetworkReturns();
      }, NETWORK_SETTLE_MS);
    };
    const handleOffline = () => clearTimeout(reconnectTimer);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      clearTimeout(reconnectTimer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Listen for Electron File menu actions
  useEffect(() => {
    const { openSettings, showSettings } = useSettingsDialogStore.getState();
    let holdToQuitHintId: string | null = null;
    const cleanups = [
      window.api.onMenuAddProject(() => {
        openSettings({ tab: 'projects' });
      }),
      window.api.onMenuNewWorkspace(() => {
        setNewWorkspaceDialogOpen(true);
      }),
      window.api.onMenuOpenFolder((path) => {
        void openFolder(path);
      }),
      // Cmd+, asks for General; pressed again inside Settings, it stays put.
      window.api.onMenuOpenSettings((tab) => {
        showSettings({ tab });
      }),
      window.api.onMenuOpenFeedback(() => {
        setFeedbackOpen(true);
      }),
      // The quit shortcut pressed with hold-to-quit on; repeated presses show one hint, not a stack.
      window.api.onHoldToQuitHint(() => {
        const { addToast, removeToast } = useToastStore.getState();
        if (holdToQuitHintId) removeToast(holdToQuitHintId);
        const shortcut = formatShortcutForDisplay('Cmd+Q');
        holdToQuitHintId = addToast(`Hold ${shortcut} to quit`, 'info', { quiet: true });
      }),
    ];
    return () => cleanups.forEach((c) => c());
  }, [setNewWorkspaceDialogOpen, setFeedbackOpen]);
}
