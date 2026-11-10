import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pinPlatform } from '../helpers/platform';
import { createMockBrowserWindow, mockElectron } from '../mocks/electron';

/** What quitting did, in order, and the teardowns the test holds open. */
const quit = vi.hoisted(() => {
  const log: string[] = [];
  const holds = new Map<string, () => void>();
  const failing = new Set<string>();
  const record = (name: string): void => {
    log.push(name);
    if (failing.has(name)) throw new Error(`${name} failed`);
  };
  return {
    log,
    failing,
    /** Whether the user lets the quit discard unsaved edits. */
    confirmed: true,
    /** A teardown that is over when it returns. */
    step: (name: string) => (): void => record(name),
    /** A teardown that is over when its promise settles. */
    asyncStep: (name: string) => async (): Promise<void> => record(name),
    /** A teardown that is over once the test releases it. */
    held: (name: string) => (): Promise<void> => {
      record(name);
      return new Promise((resolve) => {
        holds.set(name, () => {
          log.push(`${name} settled`);
          resolve();
        });
      });
    },
    release(name: string): void {
      const settle = holds.get(name);
      if (!settle) throw new Error(`${name} isn't under way`);
      holds.delete(name);
      settle();
    },
  };
});
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const electronMock = mockElectron();
let beforeQuit: (event: { preventDefault: () => void }) => void;
electronMock.app.on = vi.fn((event: string, handler: (...args: never[]) => void) => {
  if (event === 'before-quit') beforeQuit = handler as typeof beforeQuit;
});
// The ready handler would start services these tests don't have.
electronMock.app.whenReady = vi.fn(() => new Promise<void>(() => {}));
electronMock.app.quit = vi.fn(quit.step('app.quit'));
vi.mock('electron', () => electronMock);

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true },
}));
vi.mock('../../src/main/lib/logger', () => ({ createLogger: () => mockLogger }));
vi.mock('../../src/main/lib/atomic-write', () => ({
  cleanupTmpFilesRecursiveAsync: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/main/ipc/handlers', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/askpass.handlers', () => ({
  unregisterAskpassHandlers: quit.step('unregisterAskpassHandlers'),
}));
vi.mock('../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/komla'),
}));

// Everything the quit stops, in the order index.ts imports it.
vi.mock('../../src/main/services/action.service', () => ({
  actionService: { dispose: quit.asyncStep('action.dispose') },
  registerActionUsageTracker: vi.fn(),
}));
vi.mock('../../src/main/services/agent-preset.service', () => ({
  agentPresetService: { dispose: quit.asyncStep('agentPreset.dispose') },
}));
vi.mock('../../src/main/services/agents-menu-bar.service', () => ({
  agentsMenuBarService: { stop: quit.step('agentsMenuBar.stop') },
}));
vi.mock('../../src/main/services/automation.service', () => ({
  automationService: { stop: quit.step('automation.stop') },
  retargetAutomationsOnGitSettingsChange: vi.fn(),
}));
vi.mock('../../src/main/services/background-process.service', () => ({
  backgroundProcessService: { killAll: quit.step('backgroundProcess.killAll') },
}));
vi.mock('../../src/main/services/category.service', () => ({
  categoryService: { dispose: quit.asyncStep('category.dispose') },
}));
vi.mock('../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(() => ({})), flush: quit.step('config.flush') },
}));
vi.mock('../../src/main/services/customization.service', () => ({
  customizationService: {
    dispose: quit.asyncStep('customization.dispose'),
    syncTitleBarOverlay: vi.fn(),
  },
}));
vi.mock('../../src/main/services/diagnostics.service', () => ({
  diagnosticsService: { stop: quit.step('diagnostics.stop') },
}));
vi.mock('../../src/main/services/error-reporting.service', () => ({
  errorReportingService: { report: vi.fn() },
}));
vi.mock('../../src/main/services/git.service', () => ({ gitService: {} }));
vi.mock('../../src/main/services/hooks.service', () => ({
  startHookIntervals: vi.fn(),
  stopWatchingHooks: quit.asyncStep('stopWatchingHooks'),
  watchHooks: vi.fn(),
}));
vi.mock('../../src/main/services/http-server.service', () => ({
  httpServerService: {
    waitForActualPort: () => Promise.resolve(54183),
    stop: quit.step('httpServer.stop'),
  },
}));
vi.mock('../../src/main/services/keep-awake.service', () => ({
  keepAwakeService: { stop: quit.step('keepAwake.stop') },
  keepAwakeWhileAgentsWork: vi.fn(),
}));
vi.mock('../../src/main/services/managed-repo.service', () => ({ managedRepoService: {} }));
vi.mock('../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: { stop: quit.step('metricsCollector.stop') },
}));
vi.mock('../../src/main/services/notes.service', () => ({
  notesService: { stopWatching: quit.asyncStep('notes.stopWatching') },
}));
vi.mock('../../src/main/services/notification-sync.service', () => ({
  notificationSyncService: {},
}));
vi.mock('../../src/main/services/plugin-host', () => ({
  startPluginHost: vi.fn(),
  stopPluginHost: quit.step('stopPluginHost'),
}));
vi.mock('../../src/main/services/plugin-settings-store', () => ({
  loadPluginSettings: vi.fn(),
  stopFeedingPluginSettings: quit.step('stopFeedingPluginSettings'),
}));
vi.mock('../../src/main/services/plugins.service', () => ({
  stopWatchingPlugins: quit.asyncStep('stopWatchingPlugins'),
  watchPlugins: vi.fn(),
}));
vi.mock('../../src/main/services/project.service', () => ({
  projectService: { dispose: quit.asyncStep('project.dispose') },
}));
vi.mock('../../src/main/services/pty.service', () => ({
  ptyService: { killAll: quit.held('pty.killAll') },
}));
vi.mock('../../src/main/services/pull-request-status.service', () => ({
  pullRequestStatusService: { dispose: quit.step('pullRequestStatus.dispose') },
}));
vi.mock('../../src/main/services/remote-control-direct-autostart.service', () => ({
  startPersistedDirectRemoteServer: vi.fn(),
  stopPersistedDirectRemoteServer: quit.asyncStep('stopPersistedDirectRemoteServer'),
}));
vi.mock('../../src/main/services/remote-control-direct.service', () => ({
  remoteControlDirectService: { getState: () => ({}) },
}));
vi.mock('../../src/main/services/remote-control-keep-awake.service', () => ({
  remoteControlKeepAwakeService: { stop: quit.step('remoteControlKeepAwake.stop') },
}));
vi.mock('../../src/main/services/search.service', () => ({ searchService: {} }));
vi.mock('../../src/main/services/settings-history.service', () => ({
  settingsHistoryService: { dispose: quit.asyncStep('settingsHistory.dispose') },
}));
vi.mock('../../src/main/services/shortcuts.service', () => ({
  shortcutsService: {
    releaseGlobalShortcuts: quit.step('shortcuts.releaseGlobalShortcuts'),
    dispose: quit.asyncStep('shortcuts.dispose'),
  },
}));
vi.mock('../../src/main/services/sidebar-panels.service', () => ({
  stopWatchingSidebarPanels: quit.asyncStep('stopWatchingSidebarPanels'),
  watchSidebarPanels: vi.fn(),
}));
vi.mock('../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: { dispose: quit.asyncStep('sshPortForward.dispose') },
}));
vi.mock('../../src/main/services/status-commands.service', () => ({
  stopWatchingStatusCommands: quit.asyncStep('stopWatchingStatusCommands'),
  watchStatusCommands: vi.fn(),
}));
vi.mock('../../src/main/services/telemetry.service', () => ({
  telemetryService: { capture: vi.fn() },
}));
vi.mock('../../src/main/services/update.service', () => ({
  handlePendingUpdateRelaunch: vi.fn(() => false),
  updateService: { dispose: quit.step('update.dispose') },
}));
vi.mock('../../src/main/services/utility-inference.service', () => ({
  registerUtilityRequestTracker: vi.fn(),
  utilityInferenceService: {},
}));
vi.mock('../../src/main/services/window.service', () => ({
  windowService: {
    confirmQuit: () => {
      quit.log.push('window.confirmQuit');
      return quit.confirmed;
    },
  },
}));
vi.mock('../../src/main/services/workspace-command', () => ({
  stopWorkspaceCommands: quit.step('stopWorkspaceCommands'),
}));
vi.mock('../../src/main/services/workspace-trash.service', () => ({
  workspaceTrash: { stop: quit.held('workspaceTrash.stop') },
}));
vi.mock('../../src/main/services/workspace.service', () => ({
  workspaceService: {
    rememberRunningAtQuit: quit.step('workspace.rememberRunningAtQuit'),
    dispose: quit.asyncStep('workspace.dispose'),
  },
}));
vi.mock('../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: { stopAll: quit.asyncStep('worktreeWatcher.stopAll') },
}));

const BEFORE_THE_TRASH = [
  'window.confirmQuit',
  'shortcuts.releaseGlobalShortcuts',
  'workspace.rememberRunningAtQuit',
  'window.hide',
  'automation.stop',
  'diagnostics.stop',
  'metricsCollector.stop',
  'remoteControlKeepAwake.stop',
  'keepAwake.stop',
  'agentsMenuBar.stop',
  'pullRequestStatus.dispose',
  'update.dispose',
  'workspaceTrash.stop',
];
const AFTER_THE_TRASH = [
  'workspaceTrash.stop settled',
  'backgroundProcess.killAll',
  'stopWorkspaceCommands',
  'stopPersistedDirectRemoteServer',
  'pty.killAll',
  'sshPortForward.dispose',
  'workspace.dispose',
  'worktreeWatcher.stopAll',
  'notes.stopWatching',
  'customization.dispose',
  'shortcuts.dispose',
  'action.dispose',
  'category.dispose',
  'project.dispose',
  'agentPreset.dispose',
  'settingsHistory.dispose',
  'stopWatchingStatusCommands',
  'stopWatchingSidebarPanels',
  'stopWatchingHooks',
  'stopWatchingPlugins',
  'stopPluginHost',
  'stopFeedingPluginSettings',
];
const AFTER_THE_TERMINALS = [
  'pty.killAll settled',
  'httpServer.stop',
  'unregisterAskpassHandlers',
  'config.flush',
  'app.quit',
];

/** A turn of the event loop, by which every promise that could continue has. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Komla as it runs on `platform`, with one window open. */
async function launch(platform: NodeJS.Platform): Promise<void> {
  pinPlatform(platform);
  vi.resetModules();
  await import('../../src/main/index');
}

/** Asks Komla to quit, as the app does. Returns whether Komla held the quit back. */
function requestQuit(): boolean {
  const event = { preventDefault: vi.fn() };
  beforeQuit(event);
  return event.preventDefault.mock.calls.length > 0;
}

describe('quitting', () => {
  beforeEach(() => {
    quit.log.length = 0;
    quit.failing.clear();
    quit.confirmed = true;
    const window = createMockBrowserWindow({ hide: vi.fn(quit.step('window.hide')) });
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);
  });

  it('stops everything in order: the Trash before the last saves, the terminals before the app quits', async () => {
    await launch('darwin');

    expect(requestQuit()).toBe(true);
    await turn();
    expect(quit.log).toEqual(BEFORE_THE_TRASH);

    quit.release('workspaceTrash.stop');
    await turn();
    expect(quit.log).toEqual([...BEFORE_THE_TRASH, ...AFTER_THE_TRASH]);

    quit.release('pty.killAll');
    await turn();
    expect(quit.log).toEqual([...BEFORE_THE_TRASH, ...AFTER_THE_TRASH, ...AFTER_THE_TERMINALS]);
  });

  it('hides the windows before anything else gets a turn', async () => {
    await launch('darwin');

    requestQuit();

    expect(quit.log).toEqual(BEFORE_THE_TRASH);
  });

  it('leaves the windows showing on Linux', async () => {
    await launch('linux');

    requestQuit();

    expect(quit.log).toEqual(BEFORE_THE_TRASH.filter((step) => step !== 'window.hide'));
  });

  it('keeps running when the user keeps their unsaved edits, and asks again next time', async () => {
    await launch('darwin');
    quit.confirmed = false;

    expect(requestQuit()).toBe(true);
    await turn();
    expect(quit.log).toEqual(['window.confirmQuit']);

    quit.confirmed = true;
    expect(requestQuit()).toBe(true);
    expect(quit.log).toEqual(['window.confirmQuit', ...BEFORE_THE_TRASH]);
  });

  // A step that never settles, such as one waiting on an unreachable SSH host, would otherwise
  // leave Komla running with its windows hidden and no way to quit it.
  it('lets a quit asked for while it is stopping things go through, without starting over', async () => {
    await launch('darwin');
    requestQuit();

    expect(requestQuit()).toBe(false);
    await turn();

    expect(quit.log).toEqual(BEFORE_THE_TRASH);
  });

  it('logs a step that fails by name and still stops the rest, then quits', async () => {
    await launch('darwin');
    quit.failing.add('automation.stop');
    quit.failing.add('workspaceTrash.stop');
    quit.failing.add('stopWorkspaceCommands');
    quit.failing.add('workspace.dispose');

    requestQuit();
    await turn();
    // Its failure doesn't let the app quit before the terminals have exited.
    expect(quit.log).toEqual([
      ...BEFORE_THE_TRASH,
      ...AFTER_THE_TRASH.filter((step) => step !== 'workspaceTrash.stop settled'),
    ]);

    quit.release('pty.killAll');
    await turn();
    expect(quit.log.slice(-AFTER_THE_TERMINALS.length)).toEqual(AFTER_THE_TERMINALS);
    expect(mockLogger.error.mock.calls).toEqual([
      [
        'Quit step failed',
        {
          phase: 'stop background work',
          step: 'automations',
          error: 'Error: automation.stop failed',
        },
      ],
      [
        'Quit step failed',
        {
          phase: 'finish Trash deletion',
          step: 'Trash',
          error: 'Error: workspaceTrash.stop failed',
        },
      ],
      [
        'Quit step failed',
        {
          phase: 'stop and save',
          step: 'workspace commands',
          error: 'Error: stopWorkspaceCommands failed',
        },
      ],
      [
        'Quit step failed',
        { phase: 'stop and save', step: 'workspaces', error: 'Error: workspace.dispose failed' },
      ],
    ]);
  });

  it('lets through the quit it asks for once everything has stopped', async () => {
    await launch('darwin');
    requestQuit();
    quit.release('workspaceTrash.stop');
    await turn();
    quit.release('pty.killAll');
    await turn();
    expect(quit.log.at(-1)).toBe('app.quit');

    expect(requestQuit()).toBe(false);
    await turn();
    expect(quit.log.at(-1)).toBe('app.quit');
  });
});
