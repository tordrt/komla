import { existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';

import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  protocol,
  webContents,
} from 'electron';

import { IPC } from '../shared/constants/ipc-channels';
import { stepZoomLevel } from '../shared/constants/zoom';
import { getWorkspaceDisplayTitle } from '../shared/lib/workspace-title';

import { registerIpcHandlers } from './ipc/handlers';
import { moveWorkspaceToWindow } from './ipc/handlers/window.handlers';
import { cleanupTmpFilesRecursiveAsync } from './lib/atomic-write';
import { checkGitInstalled } from './lib/git-requirement';
import { createHoldToQuit } from './lib/hold-to-quit';
import { installBundledSkills } from './lib/install-skills';
import { installKomlaCli } from './lib/komla-cli';
import { createLogger } from './lib/logger';
import { MAIN_BUNDLE_DIR } from './lib/module-path';
import { reportChildProcessGone } from './lib/process-gone-reporter';
import { actionService, registerActionUsageTracker } from './services/action.service';
import { agentPresetService } from './services/agent-preset.service';
import { agentsMenuBarService } from './services/agents-menu-bar.service';
import {
  automationService,
  retargetAutomationsOnGitSettingsChange,
} from './services/automation.service';
import { backgroundProcessService } from './services/background-process.service';
import { categoryService } from './services/category.service';
import { configService } from './services/config.service';
import { customizationService } from './services/customization.service';
import { databaseService } from './services/database.service';
import { diagnosticsService } from './services/diagnostics.service';
import { errorReportingService } from './services/error-reporting.service';
import { gitBackgroundFetchService } from './services/git-background-fetch.service';
import { startHookIntervals, stopWatchingHooks, watchHooks } from './services/hooks.service';
import { HTML_PREVIEW_PROTOCOL_SCHEME, htmlPreviewService } from './services/html-preview.service';
import { httpServerService } from './services/http-server.service';
import { keepAwakeService, keepAwakeWhileAgentsWork } from './services/keep-awake.service';
import { komlaSkillService } from './services/komla-skill.service';
import { licenseService } from './services/license.service';
import { metricsCollectorService } from './services/metrics-collector.service';
import { notesService } from './services/notes.service';
import {
  foldersInCommandLine,
  requestOpenFolder,
  setFolderWindowOpener,
} from './services/open-folder-request';
import { getKomlaBasePath } from './services/paths';
import { projectService } from './services/project.service';
import { ptyService } from './services/pty.service';
import { pullRequestStatusService } from './services/pull-request-status.service';
import {
  clearRecentFolders,
  getRecentFolders,
  onRecentFoldersChanged,
  refreshRecentFolders,
} from './services/recent-folders.service';
import {
  startPersistedDirectRemoteServer,
  stopPersistedDirectRemoteServer,
} from './services/remote-control-direct-autostart.service';
import { remoteControlDirectService } from './services/remote-control-direct.service';
import { remoteControlHostAccessService } from './services/remote-control-host-access.service';
import { remoteControlKeepAwakeService } from './services/remote-control-keep-awake.service';
import { remoteMayOpenAttention } from './services/remote-control-local-access';
import { remoteControlPushService } from './services/remote-control-push.service';
import { settingsHistoryService } from './services/settings-history.service';
import { shortcutsService } from './services/shortcuts.service';
import { sshConnectionService } from './services/ssh-connection.service';
import { sshHostStatusService } from './services/ssh-host-status.service';
import { sshHostService } from './services/ssh-host.service';
import { sshPortForwardService } from './services/ssh-port-forward.service';
import {
  stopWatchingStatusCommands,
  watchStatusCommands,
} from './services/status-commands.service';
import { telemetryService } from './services/telemetry.service';
import { onAttentionRaised } from './services/terminal-attention/windows';
import { handlePendingUpdateRelaunch, updateService } from './services/update.service';
import { registerUtilityRequestTracker } from './services/utility-inference.service';
import { windowService } from './services/window.service';
import { stopWorkspaceCommands } from './services/workspace-command';
import { workspaceStatusService } from './services/workspace-status.service';
import { workspaceTrash } from './services/workspace-trash.service';
import { workspaceService } from './services/workspace.service';
import { worktreeWatcherService } from './services/worktree-watcher.service';

declare const __KOMLA_ENV__: string;

const isStaging = typeof __KOMLA_ENV__ !== 'undefined' && __KOMLA_ENV__ === 'staging';
const logger = createLogger('Main');

protocol.registerSchemesAsPrivileged([
  {
    scheme: HTML_PREVIEW_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // Status bar popovers load Komla's fonts from their sandboxed, opaque-origin page.
      corsEnabled: true,
      stream: true,
      allowExtensions: true,
    },
  },
]);

// Differentiate staging from production so both can run simultaneously.
// Chromium's process singleton (SingletonLock/SingletonSocket) lives inside the
// userData directory, which Electron derives from app.name. Without this override
// both environments share ~/Library/Application Support/komla (macOS) or the
// equivalent on other platforms, so the second app to launch sees the lock and exits.
// Setting app.name AND a separate userData path before requestSingleInstanceLock()
// gives each environment its own lock.
if (isStaging) {
  app.name = 'Komla Staging';
  app.setPath('userData', join(app.getPath('appData'), 'Komla Staging'));
}

// Ensure only one instance of Komla runs at a time per environment.
// On macOS the OS enforces this for bundled apps (via distinct bundle IDs),
// but Linux and Windows need an explicit lock.
// Skip the lock in dev mode so `npm run dev` can run alongside a packaged Komla/Staging app.
if (app.isPackaged) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    // Another instance already holds the lock — exit immediately to avoid running any
    // initialization (HTTP server, services, etc.) that would conflict with the first instance.
    process.exit(0);
  }
}

/** Create a new window and sync the title bar overlay with the app theme. */
function openNewWindow(): ReturnType<typeof windowService.createWindow> {
  const result = windowService.createWindow();
  customizationService.syncTitleBarOverlay();
  return result;
}
setFolderWindowOpener(() => openNewWindow().windowId);

function reassignTerminalsToWindow(workspaceIds: string[], targetWindowId: number): void {
  for (const workspaceId of workspaceIds) {
    const workspace = workspaceService.get(workspaceId);
    if (!workspace) continue;
    for (const terminal of workspace.terminals) {
      ptyService.setTerminalWindow(terminal.id, targetWindowId);
    }
  }
}

function sendSavedLayoutsToWindow(
  targetWindowId: string,
  workspaceIds: string[],
  savedLayouts: Record<string, unknown>
): void {
  for (const workspaceId of workspaceIds) {
    const layoutData = savedLayouts[workspaceId];
    if (!layoutData) continue;
    windowService.sendWhenReady(targetWindowId, IPC.WORKSPACE_MOVED_HERE, workspaceId, layoutData);
  }
}

// A folder dropped on the Dock icon or opened with Komla from Finder, also the one Komla started
// for, which comes before the first window: it opens there once that window is ready.
app.on('open-file', (event, path) => {
  if (requestOpenFolder(path)) event.preventDefault();
});

app.on('second-instance', (_event, argv, workingDirectory) => {
  logger.info('Second instance launched', { argv: argv.slice(1) });

  // `Komla ~/notes` while Komla runs opens the folder here.
  const folders = foldersInCommandLine(argv, workingDirectory, app.getAppPath());
  if (folders.length > 0) {
    const windowId = argv.includes('--new-window') ? openNewWindow().windowId : undefined;
    for (const folder of folders) requestOpenFolder(folder, windowId);
    return;
  }

  // Jump List (Windows) or CLI passes --new-window to open a fresh window
  if (argv.includes('--new-window')) {
    openNewWindow();
    return;
  }

  // A second instance was launched — focus or create a window in this (first) instance
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    openNewWindow();
  }
});

// On macOS, Squirrel may not finish replacing the .app bundle before the OS
// relaunches the app.  If we detect a pending update that hasn't applied yet,
// wait briefly and relaunch so the new binary gets picked up.
const pendingRelaunch = app.isPackaged && handlePendingUpdateRelaunch();

// Global error handlers - must be registered early
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection', {
    reason: error.message,
    stack: error.stack,
  });
  void errorReportingService.report(error, 'unhandledRejection');
});

process.on('uncaughtException', (error, origin) => {
  logger.error('Uncaught exception', {
    message: error.message,
    stack: error.stack,
    origin,
  });
  void errorReportingService.report(error, 'uncaughtException', { origin });
  // For uncaught exceptions, we should exit after logging
  // Give the logger and error reporting time to send, then exit
  setTimeout(() => process.exit(1), 100);
});

// Utility / GPU / sandbox helper crashes — the in-process error handlers in those
// children can't report themselves, so main has to.
app.on('child-process-gone', (_event, details) => {
  reportChildProcessGone(details, logger);
});

// The View menu's zoom items save the level like the Settings picker, so every
// window, the picker and the next launch all agree.
function saveZoomLevel(level: number): void {
  const config = configService.update({ zoomLevel: level });
  windowService.setZoomLevelAll(level);
  windowService.broadcastToAll(IPC.CONFIG_CHANGED, config);
}

function stepSavedZoomLevel(direction: 1 | -1): void {
  saveZoomLevel(stepZoomLevel(configService.get().zoomLevel ?? 0, direction));
}

// Menu clicks hand over the focused BaseWindow; only BrowserWindows host the renderer.
function sendToMenuWindow(
  window: Electron.BaseWindow | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (window instanceof BrowserWindow) window.webContents.send(channel, ...args);
}

const HOLD_TO_QUIT_PLATFORM = process.platform === 'darwin' || process.platform === 'linux';

const holdToQuit = createHoldToQuit({
  modifier: process.platform === 'darwin' ? 'meta' : 'control',
  quit: () => app.quit(),
  showHint: showHoldToQuitHint,
});

function holdToQuitEnabled(): boolean {
  return HOLD_TO_QUIT_PLATFORM && configService.get().holdToQuit === true;
}

// Electron calls any activation but a mouse click an accelerator, and every macOS menu pick
// one, so the page that saw the key go down tells the shortcut apart.
function quitMenuItem(label: string, accelerator: string): Electron.MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => {
      if (!holdToQuitEnabled()) app.quit();
      else if (holdToQuit.isShortcutDown()) holdToQuit.press();
      // A pick from the menu, as a page would have seen the shortcut.
      else if (webContents.getFocusedWebContents()) app.quit();
      // With no page to see the keys, this may be the shortcut, which can't be timed.
      else if (confirmQuit()) app.quit();
    },
  };
}

function confirmQuit(): boolean {
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    message: `Quit ${app.name}?`,
    detail: 'Running agents will stop.',
    buttons: ['Quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  return choice === 0;
}

function showHoldToQuitHint(): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(IPC.HOLD_TO_QUIT_HINT);
}

if (HOLD_TO_QUIT_PLATFORM) {
  // Every page, browser pane and popover watches the shortcut. The keyDown goes on to the
  // menu: stopping it here would make Chromium drop the keyUps that follow.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('before-input-event', (_inputEvent, input) => holdToQuit.handleInput(input));
  });
  // The key coming up goes to whatever has focus by then.
  app.on('browser-window-blur', () => holdToQuit.cancel());
}

// Folders show as ~/projects/app, as a shell prints them.
function recentFolderLabel(folder: string): string {
  const home = homedir();
  const label = folder.startsWith(home + sep) ? `~${folder.slice(home.length)}` : folder;
  // A lone & marks the key that picks the item on Windows and Linux.
  return label.replaceAll('&', '&&');
}

function recentFolderMenuItems(): Electron.MenuItemConstructorOptions[] {
  const folders = getRecentFolders();
  if (folders.length === 0) return [{ label: 'No Recent Folders', enabled: false }];
  return [
    ...folders.map((folder) => ({
      label: recentFolderLabel(folder),
      // A folder gone since the menu was built drops out of it.
      click: () => {
        if (!requestOpenFolder(folder)) void refreshRecentFolders();
      },
    })),
    { type: 'separator' },
    { label: 'Clear Recently Opened', click: () => clearRecentFolders() },
  ];
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings...',
                accelerator: 'CmdOrCtrl+,',
                click: (
                  _menuItem: Electron.MenuItem,
                  browserWindow: Electron.BaseWindow | undefined
                ) => {
                  sendToMenuWindow(browserWindow, IPC.MENU_OPEN_SETTINGS, 'general');
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              quitMenuItem(`Quit ${app.name}`, 'Cmd+Q'),
            ],
          },
        ]
      : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            openNewWindow();
          },
        },
        {
          label: 'New Workspace...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_NEW_WORKSPACE);
          },
        },
        {
          label: 'Open Folder...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_OPEN_FOLDER);
          },
        },
        { label: 'Open Recent', submenu: recentFolderMenuItems() },
        { type: 'separator' },
        {
          label: 'Add Project...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_ADD_PROJECT);
          },
        },
        {
          label: 'Workspace Setup...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_OPEN_SETTINGS, 'workspace-setup');
          },
        },
        {
          label: 'Quick Commands...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_OPEN_SETTINGS, 'actions');
          },
        },
        {
          label: 'AI Agent...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_OPEN_SETTINGS, 'agent');
          },
        },
        { type: 'separator' },
        ...(!isMac
          ? [
              {
                label: 'Settings...',
                accelerator: 'CmdOrCtrl+,',
                click: (_menuItem, browserWindow) => {
                  sendToMenuWindow(browserWindow, IPC.MENU_OPEN_SETTINGS, 'general');
                },
              } satisfies Electron.MenuItemConstructorOptions,
              { type: 'separator' as const },
            ]
          : []),
        isMac
          ? { role: 'close' }
          : process.platform === 'linux'
            ? quitMenuItem('Quit', 'Ctrl+Q')
            : { role: 'quit' },
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        ...(is.dev
          ? [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
              { type: 'separator' as const },
            ]
          : []),
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => saveZoomLevel(0) },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Plus',
          click: () => stepSavedZoomLevel(1),
        },
        // macOS matches menu shortcuts by character, so Cmd+Plus needs Shift there.
        // This hidden twin makes Cmd+= work too, as the zoom tooltips promise.
        ...(isMac
          ? [
              {
                label: 'Zoom In',
                accelerator: 'Command+=',
                visible: false,
                acceleratorWorksWhenHidden: true,
                click: () => stepSavedZoomLevel(1),
              },
            ]
          : []),
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => stepSavedZoomLevel(-1),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [
              {
                label: 'Close Window',
                click: (
                  _menuItem: Electron.MenuItem,
                  browserWindow: Electron.BaseWindow | undefined
                ) => {
                  browserWindow?.close();
                },
              },
            ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Feedback...',
          click: (_menuItem, browserWindow) => {
            sendToMenuWindow(browserWindow, IPC.MENU_OPEN_FEEDBACK);
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

void app.whenReady().then(async () => {
  // If a pending-update relaunch is scheduled, skip all initialization.
  if (pendingRelaunch) return;
  // Check that git is installed on first launch only; skip on subsequent starts
  const gitVerifiedPath = join(getKomlaBasePath(), 'git-verified');
  if (!existsSync(gitVerifiedPath)) {
    if (!(await checkGitInstalled())) return;
    try {
      writeFileSync(gitVerifiedPath, 'true');
    } catch {
      // Non-fatal — just means we'll re-check next launch
    }
  }

  electronApp.setAppUserModelId(isStaging ? 'com.komla.staging' : 'com.komla.app');

  // Set dock icon in dev mode (production uses the bundled .icns)
  if (is.dev && process.platform === 'darwin') {
    const iconPath = join(MAIN_BUNDLE_DIR, '../../resources/icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock?.setIcon(icon);
    }
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
    htmlPreviewService.attachNavigationGuard(window.webContents);
  });
  // Other devices' agents' hooks aren't copied here while asleep, so their spinners may be stale.
  powerMonitor.on('resume', () => {
    workspaceService.attention.machineResumed();
    void automationService.tick();
  });
  keepAwakeService.setMode(configService.get().keepAwakeMode);
  keepAwakeWhileAgentsWork(() => workspaceService.list());
  agentsMenuBarService.init({
    listWorkspaces: () => workspaceService.list(),
    getWorkspace: (workspaceId) => workspaceService.get(workspaceId),
    listProjects: () =>
      projectService
        .list()
        .map(({ id, name, color, icon, kind }) => ({ id, name, color, icon, kind })),
    onTerminalStatus: (listener) => ptyService.onStatus(listener),
    openWindow: () => openNewWindow().windowId,
    moveToWindow: (workspaceId, windowId) => moveWorkspaceToWindow(workspaceId, windowId),
    updateConfig: (updates) => {
      const config = configService.update(updates);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC.CONFIG_CHANGED, config);
      }
      agentsMenuBarService.setInBackgroundOnly(config.agentsMenuBarInBackgroundOnly);
      agentsMenuBarService.setEnabled(config.showAgentsInMenuBar);
    },
  });
  const menuBarConfig = configService.get();
  agentsMenuBarService.setDoneClearedAt(menuBarConfig.agentsDoneClearedAt);
  agentsMenuBarService.setInBackgroundOnly(menuBarConfig.agentsMenuBarInBackgroundOnly);
  agentsMenuBarService.setEnabled(menuBarConfig.showAgentsInMenuBar);

  htmlPreviewService.registerProtocolHandler();
  registerIpcHandlers();
  void startPersistedDirectRemoteServer('boot');

  buildAppMenu();
  onRecentFoldersChanged(buildAppMenu);
  void refreshRecentFolders();

  // Keep the latest renderer layout snapshot for window reassignment and durable SSH restoration.
  const pendingCloseLayouts = new Map<string, Record<string, unknown>>();
  ipcMain.on(IPC.WORKSPACE_SAVE_LAYOUTS_ON_CLOSE, (event, windowId, layouts) => {
    pendingCloseLayouts.set(windowId as string, layouts as Record<string, unknown>);
    workspaceService.saveSshTerminalLayouts(layouts as Record<string, unknown>);
    event.returnValue = true;
  });

  // Reassign orphaned workspaces when a window closes and notify remaining windows
  windowService.onWindowClosed = (closedWindowId) => {
    // Use main window as target (will elect new one if needed)
    const targetWindowId = windowService.getMainWindowId();
    const affected = workspaceService.reassignWindowWorkspaces(closedWindowId, targetWindowId);
    workspaceService.clearWindowPaneSurfaces(closedWindowId);

    // Retrieve layout data saved by the closing renderer
    const savedLayouts = pendingCloseLayouts.get(closedWindowId);
    pendingCloseLayouts.delete(closedWindowId);

    for (const workspaceId of affected) {
      windowService.broadcastToAll(IPC.WORKSPACE_WINDOW_CHANGED, workspaceId, targetWindowId);
    }

    if (!savedLayouts || !targetWindowId) return;
    const targetWindow = windowService.getWindow(targetWindowId);
    if (!targetWindow) return;

    // Transfer saved layouts to the target window so split state is preserved
    reassignTerminalsToWindow(affected, targetWindow.id);
    sendSavedLayoutsToWindow(targetWindowId, affected, savedLayouts);
  };

  // Update workspace lastActivityAt when file changes are detected
  worktreeWatcherService.onActivity = (workspaceId, activityAt) => {
    workspaceService.touchLastActivity(workspaceId, activityAt);
  };

  const remoteDeviceConnected = () => !!remoteControlDirectService.getState().connectedDevice;
  // Refresh git status less often while nobody can see it: every window hidden or
  // minimized and no remote-control device connected (the phone view uses it too).
  worktreeWatcherService.isBackgroundOnly = () => {
    const anyWindowVisible = BrowserWindow.getAllWindows().some(
      (window) => window.isVisible() && !window.isMinimized()
    );
    if (anyWindowVisible) return false;
    return !remoteDeviceConnected();
  };
  // A workspace no window shows has only its sidebar card to update, unless a phone may show it.
  worktreeWatcherService.isOffScreen = (workspaceId) =>
    !remoteDeviceConnected() && windowService.isWorkspaceOffScreen(workspaceId);
  const flushGitRefreshes = () => worktreeWatcherService.flushPendingNotifications();
  // Only the newly shown workspace is behind; the overview shows them all.
  windowService.onWorkspaceShown = (workspaceId) =>
    workspaceId === null
      ? flushGitRefreshes()
      : worktreeWatcherService.flushPendingNotification(workspaceId);
  app.on('browser-window-focus', flushGitRefreshes);
  // Coming back to Komla picks up what other devices changed on shared SSH hosts.
  app.on('browser-window-focus', () => void workspaceService.sshSync.syncSoon());
  // It also fetches origin, so commits behind (↓N) counts stay current.
  app.on('browser-window-focus', () => void gitBackgroundFetchService.fetchStale());
  // A push starts its pull request's checks, which notify the workspace when they finish.
  const branches = workspaceStatusService.observe((projection) =>
    pullRequestStatusService.observeBranch(projection)
  );
  for (const projection of branches.initial) pullRequestStatusService.observeBranch(projection);
  // Pull requests tag their workspaces, such as "Waiting for review", while that's turned on.
  pullRequestStatusService.startTagging();
  // Reaching an SSH host fetches its clones, which a background fetch leaves alone until then.
  sshHostStatusService.onChange(() => void gitBackgroundFetchService.fetchStaleOnSshHosts());
  app.on('browser-window-created', (_, window) => {
    window.on('show', flushGitRefreshes);
    window.on('restore', flushGitRefreshes);
  });
  remoteControlDirectService.onStateChange(flushGitRefreshes);
  // Pushes nothing until remote control is on in Settings and a phone has turned notifications on.
  remoteControlPushService.start();
  // Phone access to SSH hosts follows phone list changes over connections Komla already has.
  remoteControlHostAccessService.start();
  onAttentionRaised((event) => {
    const workspace = workspaceService.get(event.workspaceId);
    // A workspace or terminal devices may not open doesn't buzz them either.
    if (workspace && !remoteMayOpenAttention(configService.get(), workspace, event.attention)) {
      return;
    }
    void remoteControlPushService.attentionRaised(
      event,
      workspace ? getWorkspaceDisplayTitle(workspace) : undefined
    );
  });

  const { windowId: mainWindowId } = openNewWindow();
  for (const folder of foldersInCommandLine(process.argv, process.cwd(), app.getAppPath())) {
    requestOpenFolder(folder, mainWindowId);
  }
  sshPortForwardService.startConfiguredHostPortForwards(sshHostService.list());
  // A terminal's first connection uses the answer, e.g. its connect timeout. Hosts without a
  // workspace are left alone: the read can run a `Match exec` command from ~/.ssh/config.
  const sshHostIdsInUse = new Set(
    workspaceService.list().flatMap((w) => (w.backend?.kind === 'ssh' ? [w.backend.hostId] : []))
  );
  for (const host of sshHostService.list()) {
    if (sshHostIdsInUse.has(host.id)) sshConnectionService.readConfig(host);
  }

  // Assign all workspaces to the main window (handles startup with null windowIds)
  workspaceService.assignUnassignedToMainWindow(mainWindowId);

  // macOS dock: right-click -> "New Window"
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'New Window',
        click: () => {
          openNewWindow();
        },
      },
    ])
  );

  // Windows taskbar: right-click -> "New Window" via Jump List
  if (process.platform === 'win32') {
    app.setJumpList([
      {
        name: 'Tasks',
        items: [
          {
            type: 'task',
            title: 'New Window',
            program: process.execPath,
            args: '--new-window',
            description: 'Open a new Komla window',
          },
        ],
      },
    ]);
  }

  // Initialize file watchers for config services in background (don't block window)
  // This starts watching for config file changes to hot-reload settings
  void Promise.allSettled([
    customizationService.init(),
    shortcutsService.init(),
    actionService.init(),
    categoryService.init(),
    projectService.init(),
    agentPresetService.init(),
    settingsHistoryService.start(),
    watchStatusCommands(),
    watchHooks(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Could not start watching a config file', result.reason);
      }
    }
    // Local automations run even if a watcher couldn't start, e.g. at the inotify limit.
    automationService.start();
    retargetAutomationsOnGitSettingsChange();
  });

  // Deferred housekeeping — run after window creation to avoid blocking startup
  const config = configService.get();
  installKomlaCli();
  httpServerService.start(config.notificationPort);
  workspaceService.reconcilePersistedSshSessions();
  void workspaceService.assignSshWorkspaceProjects().catch((error) => {
    logger.warn('Could not match SSH workspaces to projects', error);
  });
  workspaceTrash.start();
  void cleanupTmpFilesRecursiveAsync(getKomlaBasePath());
  httpServerService.onStarted(() => {
    installBundledSkills();
    // Agents' copies of the Komla skill follow the one just installed.
    komlaSkillService.refreshInstalled();
    // Interval hooks run `komla`, which needs the CLI installed and Komla listening.
    startHookIntervals();
  });

  // Initialize auto-updater (also fetches announcements on launch + every 4 hours)
  updateService.init();

  // Periodic performance snapshots to diagnose long-running sluggishness.
  diagnosticsService.start();

  // Start collecting usage metrics (skipped in dev mode)
  registerActionUsageTracker((type) => metricsCollectorService.incrementAction(type));
  metricsCollectorService.start();

  // Fold utility AI request outcomes into the daily usage metrics
  registerUtilityRequestTracker((props) => metricsCollectorService.recordUtilityRequest(props));

  // Send install ping (fire-and-forget, runs once per installation)
  void telemetryService.sendInstallPing();

  // Send daily heartbeat with agent usage (fire-and-forget, once per calendar day)
  void telemetryService.sendDailyHeartbeat();

  // When license is revoked, enforce workspace limits and notify renderer
  licenseService.onRevoked(() => {
    void workspaceService.enforceWorkspaceLimit().catch((error) => {
      logger.error('Failed to enforce workspace limit after license revocation', error);
    });
    windowService.broadcastToAll(IPC.LICENSE_REVOKED);
  });

  // Verify license on launch (periodic re-checks handled by update service interval)
  void licenseService.startPeriodicValidation();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openNewWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let isCleaningUp = false;
// How long quitting waits for local workspaces' stop steps.
const QUIT_STOP_STEPS_TIME_LIMIT_MS = 10_000;
app.on('before-quit', (event) => {
  if (isCleaningUp) {
    return; // Already cleaning up, let the quit proceed
  }
  event.preventDefault();
  if (!windowService.confirmQuit()) return;
  isCleaningUp = true;

  // Hide windows immediately so the close feels instant — async cleanup
  // (PTY teardown, service disposal) can take ~a second.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.hide();
  }

  automationService.stop();
  diagnosticsService.stop();
  metricsCollectorService.stop();
  remoteControlKeepAwakeService.stop();
  keepAwakeService.stop();
  agentsMenuBarService.stop();
  pullRequestStatusService.dispose();

  // Workspace-stop steps such as `docker compose down` run before background commands are killed,
  // and a Trash deletion under way finishes before workspaces are saved for the last time.
  void Promise.all([
    workspaceService.runStopStepsBeforeQuit(QUIT_STOP_STEPS_TIME_LIMIT_MS),
    workspaceTrash.stop(),
  ])
    .catch((err) => {
      logger.error('Error finishing workspace work during quit', { error: String(err) });
    })
    .finally(finishQuit);
});

function finishQuit(): void {
  backgroundProcessService.killAll();
  // Hooks and status bar commands run in process groups of their own, so they would outlive Komla.
  stopWorkspaceCommands();

  // Await all shutdown cleanup, including workspace persistence, before quitting.
  // ptyService.killAll() must complete before app.quit() — otherwise node-pty's
  // exit ThreadSafeFunction can fire during Node's Environment teardown and
  // abort the process (uncaught C++ exception when calling into a dying JS env).
  Promise.all([
    stopPersistedDirectRemoteServer(),
    ptyService.killAll(),
    sshPortForwardService.dispose(),
    workspaceService.dispose(),
    worktreeWatcherService.stopAll(),
    notesService.stopWatching(),
    customizationService.dispose(),
    shortcutsService.dispose(),
    actionService.dispose(),
    categoryService.dispose(),
    projectService.dispose(),
    agentPresetService.dispose(),
    settingsHistoryService.dispose(),
    stopWatchingStatusCommands(),
    stopWatchingHooks(),
  ])
    .catch((err) => {
      logger.error('Error stopping watchers during quit', { error: String(err) });
    })
    .finally(() => {
      databaseService.close();
      app.quit();
    });
}
