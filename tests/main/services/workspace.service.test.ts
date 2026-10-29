import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { IPC } from '../../../src/shared/constants/ipc-channels';
import {
  isResumable,
  isRunningHere,
  reconnectableTerminals,
  sessionEndedHere,
  showsRunning,
} from '../../../src/shared/lib/terminal-execution-state';

import {
  createWorktreeWorkspace,
  createProject,
  createManagedProject,
  createClaudePreset,
  createTabStep,
  createBackgroundStep,
  createSplitStep,
  resetIdCounter,
} from '../../factories';
import { mockElectron } from '../../mocks/electron';
import { createVirtualFs, VirtualFilesystem } from '../../mocks/fs';

import type {
  AgentHook,
  TerminalAttention,
} from '../../../src/main/services/terminal-attention/terminal-attention';
import type { Project } from '../../../src/shared/types/project';
import type { Terminal } from '../../../src/shared/types/terminal';
import type { Workspace } from '../../../src/shared/types/workspace';

// Mock electron
vi.mock('electron', () => mockElectron());

const mockWriteFileAtomic = vi.fn(() => Promise.resolve());
vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomic: mockWriteFileAtomic,
}));
/** Writes of workspaces.json, leaving out other files such as the SSH sync state. */
const workspaceFileWrites = () =>
  (mockWriteFileAtomic.mock.calls as unknown as Array<[string, string]>).filter(([path]) =>
    path.endsWith('workspaces.json')
  );
/**
 * A window whose renderer hears what the service sends. On Windows the attention
 * badge flashes the focused window's frame, so it needs those methods as well.
 */
const rendererWindow = (send: (...args: unknown[]) => void) =>
  ({
    isDestroyed: () => false,
    isFocused: () => false,
    flashFrame: vi.fn(),
    webContents: { send },
  }) as never;
/** Sends the registry's Terminal Attention State a hook the notify endpoint matched to a Terminal. */
const hookTerminal = (
  workspaceService: {
    attention: Pick<TerminalAttention, 'hook'>;
    findWorkspaceByTerminalId(terminalId: string): Workspace | undefined;
  },
  terminalId: string,
  hook: AgentHook
) =>
  workspaceService.attention.hook(
    {
      workspace: workspaceService.findWorkspaceByTerminalId(terminalId),
      terminalId,
      hasInvalidTerminalId: false,
    },
    hook
  );

const mockRemoteCompanionService = vi.hoisted(() => ({
  ensureInstalled: vi.fn(),
  detectPlatform: vi.fn(() => Promise.resolve(['Linux', 'x86_64'])),
  ensureRunning: vi.fn(),
  invalidateHost: vi.fn(),
  installedPath: vi.fn(),
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: mockRemoteCompanionService,
  resolveRemoteCompanionRuntime: vi.fn(() => ({
    installationKey: 'deterministic-installation',
    tmuxSocket: 'komla-companion-deterministic-installation',
    sessionName: 'komla-companion-deterministic-installation',
    hookInbox: '/home/dev/.komla/helpers/companion/deterministic-installation/inbox',
  })),
}));
// Create virtual filesystem
let vfs: VirtualFilesystem;
const mockRealpathSync = vi.fn((path: string) => path);
beforeEach(() => {
  vfs = createVirtualFs();
});

vi.mock('fs', () => {
  // Return a dynamic getter that always returns the current vfs.mock
  return {
    existsSync: vi.fn((...args) => vfs.mock.existsSync(...args)),
    readFileSync: vi.fn((...args) => vfs.mock.readFileSync(...args)),
    writeFileSync: vi.fn((...args) => vfs.mock.writeFileSync(...args)),
    mkdirSync: vi.fn((...args) => vfs.mock.mkdirSync(...args)),
    renameSync: vi.fn((...args) => vfs.mock.renameSync(...args)),
    rmSync: vi.fn((...args) => vfs.mock.rmSync(...args)),
    unlinkSync: vi.fn((...args) => vfs.mock.unlinkSync(...args)),
    statSync: vi.fn((...args) => vfs.mock.statSync(...args)),
    readdirSync: vi.fn((...args) => vfs.mock.readdirSync(...args)),
    copyFileSync: vi.fn((...args) => vfs.mock.copyFileSync(...args)),
    cpSync: vi.fn(),
    accessSync: vi.fn((...args) => vfs.mock.accessSync(...args)),
    chmodSync: vi.fn(),
    realpathSync: mockRealpathSync,
  };
});

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(() => Promise.resolve()),
  readFile: vi.fn(() => Promise.resolve('')),
  mkdir: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
  access: vi.fn(() => Promise.resolve()),
  stat: vi.fn(() => Promise.resolve({ isFile: () => true, isDirectory: () => false })),
  realpath: vi.fn((path: string) => Promise.resolve(path)),
}));

let mockUuidCounter = 0;
vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: vi.fn(() => `mock-uuid-${++mockUuidCounter}`),
}));

// Mock dependent services
const mockGitService = {
  createWorktree: vi.fn(() =>
    Promise.resolve({
      path: '/mock/home/.komla/worktrees/project/agent-branch',
      createdBranch: true,
    })
  ),
  deleteWorktree: vi.fn(() => Promise.resolve()),
  isGitRepo: vi.fn(() => Promise.resolve(true)),
  getCurrentBranch: vi.fn(() => Promise.resolve('main')),
  getMainBranch: vi.fn(() => Promise.resolve('main')),
  getRemoteUrl: vi.fn(() => Promise.resolve('https://github.com/example/repo.git')),
  getTargetBranch: vi.fn(() => Promise.resolve('main')),
  resolvePublishedCommit: vi.fn(() => Promise.resolve('0123456789abcdef')),
  getRepoRoot: vi.fn(() => Promise.resolve('/mock/repo')),
  getRepoName: vi.fn(() => Promise.resolve('my-repo')),
  registerTargetBranch: vi.fn(),
  setManagedWorktreeLookup: vi.fn(),
  fastForwardBranchToRemoteIfSafe: vi.fn(() => Promise.resolve(false)),
  fetchOriginStartPoint: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
  stopBackgroundWork: vi.fn(),
  readWorktreeForCleanup: vi.fn(),
  findLandedCommits: vi.fn(),
  getCommonGitDir: vi.fn(),
};
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: mockGitService,
}));

const mockSshWorkspaceDiff = {
  getWorkingTreeDiff: vi.fn(async () => ({
    files: [],
    summary: { additions: 0, deletions: 0, filesChanged: 0 },
  })),
};
vi.mock('../../../src/main/services/workspace-git/ssh-diff', () => ({
  sshWorkspaceDiff: mockSshWorkspaceDiff,
}));

const mockSshWorkspaceGit = {
  getSnapshot: vi.fn(async () => ({
    statusText: '',
    numstatText: '',
    statusTooLarge: false,
    branch: {
      currentBranch: 'feature',
      mainBranch: 'main',
      defaultBranch: 'main',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    },
  })),
  gitBatchRunner: vi.fn((hostId: string, repoPath: string) => ({ label: `${hostId}:${repoPath}` })),
  getBranchQuickStatus: vi.fn(async () => ({
    currentBranch: 'feature',
    mainBranch: 'main',
    defaultBranch: 'main',
    aheadTargetBranch: 0,
    behindTargetBranch: 0,
    hasRemote: true,
    hasOriginRemote: true,
    unpushedCommits: 0,
    behindRemote: 0,
    targetBranchHasRemote: true,
    targetBranchAheadRemote: 0,
    targetBranchBehindRemote: 0,
  })),
};
vi.mock('../../../src/main/services/workspace-git/ssh-git', () => ({
  sshWorkspaceGit: mockSshWorkspaceGit,
}));

let mockPtyStatusListener:
  | ((terminalId: string, status: 'starting' | 'running' | 'stopped') => void)
  | undefined;
let mockLocalMirrorSyncStatusListener:
  | ((status: {
      workspaceId: string;
      state: 'syncing' | 'ready' | 'error';
      message?: string;
    }) => void)
  | undefined;

const mockPtyService = {
  spawn: vi.fn(),
  restart: vi.fn(),
  kill: vi.fn(),
  releaseTerminal: vi.fn(),
  releaseTerminalAndWait: vi.fn(() => Promise.resolve()),
  isRunning: vi.fn(() => false),
  getStatus: vi.fn(() => 'running' as const),
  onAbort: vi.fn(),
  onAnswerKey: vi.fn(),
  onExit: vi.fn(),
  onManagedRemoteTerminalSessionReplaced: vi.fn(),
  onSshTerminalPoolAssignment: vi.fn(),
  onStatus: vi.fn(
    (listener: (terminalId: string, status: 'starting' | 'running' | 'stopped') => void) => {
      mockPtyStatusListener = listener;
      return vi.fn();
    }
  ),
};
vi.mock('../../../src/main/services/pty.service', () => ({
  ptyService: mockPtyService,
}));

const mockProject = createProject({
  id: 'project-1',
  name: 'Test Project',
  repositoryPath: '/mock/repo',
  defaultBranchPrefix: 'agent/',
});

// The folder projects folders open as, by path.
const folderProjects = new Map<string, Project>();
const findFolderProject = (id: string) => [...folderProjects.values()].find((p) => p.id === id);
function findOrCreateFolderProject(path: string, color?: string): Project {
  const existing = folderProjects.get(path);
  if (existing) return existing;
  const project = createProject({
    id: `folder-${folderProjects.size + 1}`,
    kind: 'directory',
    name: path.split('/').pop()!,
    repositoryPath: path,
    color,
  });
  folderProjects.set(path, project);
  return project;
}

const mockProjectService = {
  get: vi.fn((id: string) => (id === 'project-1' ? mockProject : findFolderProject(id))),
  list: vi.fn(() => [mockProject]),
  update: vi.fn(),
  armIconPrompt: vi.fn(),
  findOrCreateDirectoryProject: vi.fn(findOrCreateFolderProject),
};
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

const mockConfigService = {
  get: vi.fn(() => ({})),
  update: vi.fn((updates) => updates),
  getWorkspaceSyncDeviceId: vi.fn(() => 'this-device'),
};
vi.mock('../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

const mockSshHostService = {
  list: vi.fn(() => mockConfigService.get().sshHosts ?? []),
  has: vi.fn((hostId: string) =>
    (mockConfigService.get().sshHosts ?? []).some((host: { id: string }) => host.id === hostId)
  ),
  get: vi.fn((hostId: string) =>
    (mockConfigService.get().sshHosts ?? []).find((host: { id: string }) => host.id === hostId)
  ),
  delete: vi.fn(() => true),
};
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: mockSshHostService,
}));

const mockClaudePreset = createClaudePreset();
const mockPlanPreset = createClaudePreset({
  id: 'preset-plan',
  launchModes: [{ id: 'plan', name: 'Plan', command: 'claude --plan', color: 'blue' }],
});
const mockArgumentPreset = createClaudePreset({
  id: 'preset-arguments',
  continueCommand: 'claude --resume {{launchMode}}',
  launchModes: [{ id: 'plan', name: 'Plan', arguments: '--permission-mode plan', color: 'blue' }],
  reasoningLevels: [{ id: 'high', name: 'High', arguments: '--effort high' }],
});
const mockAgentPresetService = {
  get: vi.fn((id: string) =>
    id === mockPlanPreset.id
      ? mockPlanPreset
      : id === mockArgumentPreset.id
        ? mockArgumentPreset
        : undefined
  ),
  getActive: vi.fn(() => mockClaudePreset),
  resolveCommand: vi.fn((command: string, prompt?: string) => {
    if (!command.trim()) return '';
    if (prompt !== undefined) {
      if (command.includes('{{prompt}}')) {
        return command.replace(/\{\{prompt\}\}/g, `"${prompt}"`);
      }
      return `${command} "${prompt}"`;
    }
    return command.replace(/\s*\{\{prompt\}\}/g, '');
  }),
  resolvePresetCommand: vi.fn(
    (
      preset: ReturnType<typeof createClaudePreset>,
      intent: 'open' | 'prompt' | 'continue',
      launchModeId?: string,
      prompt?: string
    ) => {
      const mode = preset.launchModes.find((candidate) => candidate.id === launchModeId);
      if (mode?.command?.trim() && !mode.arguments?.trim() && intent !== 'continue') {
        if (prompt === undefined) return mode.command.replace(/\s*\{\{prompt\}\}/g, '');
        return mode.command.includes('{{prompt}}')
          ? mode.command.replace(/\{\{prompt\}\}/g, `"${prompt}"`)
          : `${mode.command} "${prompt}"`;
      }
      const command =
        intent === 'continue'
          ? preset.continueCommand
          : intent === 'prompt'
            ? preset.promptCommand
            : preset.openCommand;
      const launchModeArguments = mode?.arguments?.trim();
      const commandWithLaunchMode = launchModeArguments
        ? command.includes('{{launchMode}}')
          ? command.replace(/\{\{launchMode\}\}/g, launchModeArguments)
          : `${command} ${launchModeArguments}`
        : command.replace(/\s*\{\{launchMode\}\}/g, '');
      if (prompt === undefined) return commandWithLaunchMode;
      return commandWithLaunchMode.replace(/\{\{prompt\}\}/g, `"${prompt}"`);
    }
  ),
  recordPresetUsage: vi.fn(),
};
vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: mockAgentPresetService,
}));

const mockWorktreeWatcherService = {
  startWatching: vi.fn(() => Promise.resolve()),
  stopWatching: vi.fn(() => Promise.resolve()),
  startAllWatchers: vi.fn(() => Promise.resolve()),
  restartWatching: vi.fn(() => Promise.resolve()),
};
vi.mock('../../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: mockWorktreeWatcherService,
}));

const mockLicenseService = {
  canStartWorkspace: vi.fn(() => ({ allowed: true })),
  getStatus: vi.fn(() => ({ isLicensed: true })),
};
vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: mockLicenseService,
  FREE_WORKSPACE_LIMIT: 4,
}));

const mockTelemetryService = {
  sendMonetizationEvent: vi.fn(),
  sendIntegrationMilestone: vi.fn(),
};
vi.mock('../../../src/main/services/telemetry.service', () => ({
  telemetryService: mockTelemetryService,
}));

const mockBackgroundProcessService = {
  spawn: vi.fn(),
  stop: vi.fn(() => Promise.resolve()),
  killForWorkspace: vi.fn(),
  killForWorkspaceAndWait: vi.fn(() => Promise.resolve()),
  killAll: vi.fn(),
};
vi.mock('../../../src/main/services/background-process.service', () => ({
  backgroundProcessService: mockBackgroundProcessService,
}));

const mockHttpServerService = {
  getActualPort: vi.fn(() => 54183),
  getPort: vi.fn(() => 54183),
  waitForActualPort: vi.fn(() => Promise.resolve(54183)),
};
vi.mock('../../../src/main/services/http-server.service', () => ({
  httpServerService: mockHttpServerService,
}));

const mockSshPortForwardService = {
  startPreviewForward: vi.fn(() => Promise.resolve()),
  stopPreviewForward: vi.fn(() => Promise.resolve()),
  ensureKomlaDataTunnel: vi.fn(),
  stopKomlaDataTunnelsExcept: vi.fn(),
};
vi.mock('../../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: mockSshPortForwardService,
}));

vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { getMainWindowId: vi.fn(() => 'main-window') },
}));

const mockWorkspaceLinksService = {
  unlinkAll: vi.fn(() => Promise.resolve()),
  reconcileAllFromDisk: vi.fn(() => Promise.resolve(false)),
};
vi.mock('../../../src/main/services/workspace-links.service', () => ({
  workspaceLinksService: mockWorkspaceLinksService,
}));

const mockNotesService = { trashAll: vi.fn(() => Promise.resolve()) };
vi.mock('../../../src/main/services/notes.service', () => ({ notesService: mockNotesService }));

const mockWorkspaceFileService = {
  importExternalFileInto: vi.fn(
    async (_workspace: unknown, sourcePath: string) =>
      `.komla-files/${sourcePath.split('/').pop()}`
  ),
};
vi.mock('../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: mockWorkspaceFileService,
}));

function createMockSshWorkspacePlan(args: {
  branchName: string;
  projectName?: string;
  [key: string]: unknown;
}) {
  const branchPath = args.branchName.replaceAll('/', '-');
  return {
    backend: {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: `/home/dev/.komla/worktrees/test-project/${branchPath}`,
      remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
      gitUrl: 'https://github.com/example/repo.git',
      projectName: args.projectName ?? 'Test Project',
      branchName: args.branchName,
      ...(typeof args.baseBranch === 'string' ? { baseBranch: args.baseBranch } : {}),
      ...(typeof args.startPoint === 'string' ? { startPoint: args.startPoint } : {}),
    },
    workingDirectory: `ssh://ssh-dev/home/dev/.komla/worktrees/test-project/${branchPath}`,
    repoName: args.projectName ?? 'Test Project',
  };
}

const mockSshWorkspaceService = {
  createWorkspace: vi.fn(),
  getHost: vi.fn(() => ({ id: 'ssh-dev', hostname: 'example.test', basePath: '~/.komla' })),
  hasHost: vi.fn(() => true),
  ensureWorkspaceReady: vi.fn(() =>
    Promise.resolve({ createdBranch: true, createdWorktree: true })
  ),
  withRemoteDirectoryAttempt: vi.fn(
    (
      backend: { remoteProjectRoot: string; branchName: string; [key: string]: unknown },
      attempt: number
    ) => ({
      ...backend,
      remoteDirectory: `${backend.remoteProjectRoot}/${backend.branchName.replaceAll('/', '-')}-${attempt}`,
    })
  ),
  resolveWorkspaceBasePath: vi.fn(() => Promise.resolve('/home/dev/.komla')),
  managedRepoPath: vi.fn(
    (basePath: string, projectName: string) => `${basePath}/repos/${projectName}/repo.git`
  ),
  createWorkspacePlan: vi.fn(createMockSshWorkspacePlan),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  deleteHostData: vi.fn(() => Promise.resolve()),
  forgetHost: vi.fn(),
  killTerminalSessions: vi.fn(() => Promise.resolve()),
  findTerminalSessions: vi.fn(() => Promise.resolve(new Set<string>())),
  relayInterrupt: vi.fn(() => Promise.resolve()),
  warmConnections: vi.fn(),
  supportsPersistentTerminalSessions: vi.fn(() => Promise.resolve(true)),
  ensureRemoteNotificationScript: vi.fn(() => Promise.resolve()),
  recordTerminalPoolAssignment: vi.fn(),
  releaseTerminalPoolAssignment: vi.fn(),
  buildTerminalLaunchCommand: vi.fn(() => ({
    command: 'ssh remote command',
    startupMode: 'wait-for-marker' as const,
    localLoginShell: false,
  })),
  getRsyncTransport: vi.fn(() => ({
    remoteTarget: 'dev@ssh.example',
    remoteShell: 'ssh -p 2222',
  })),
  run: vi.fn(() => Promise.resolve('')),
  runStreaming: vi.fn(() => Promise.resolve(0)),
};
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: mockSshWorkspaceService,
  remoteKomlaDataPort: vi.fn(() => 62000),
  joinRemote: (...parts: string[]) => parts.join('/'),
  sshCompanionInstallationId: vi.fn((hostId: string) => `/mock/home/.komla\0${hostId}`),
}));

const mockSshWorkspaceSyncHost = {
  inspect: vi.fn(
    (): Promise<
      { state: 'present'; manifest?: string } | { state: 'missing' } | { state: 'deleted' }
    > => Promise.resolve({ state: 'present' })
  ),
  write: vi.fn(() => Promise.resolve(true)),
  removeOrphaned: vi.fn(() => Promise.resolve()),
  delete: vi.fn(() => Promise.resolve()),
  read: vi.fn((): Promise<string[]> => Promise.resolve([])),
  hasHost: vi.fn((hostId: string) => mockSshWorkspaceService.hasHost(hostId)),
  readyHosts: vi.fn(() =>
    mockSshHostService
      .list()
      .filter((host: { setupPending?: boolean }) => !host.setupPending)
      .map((host: { id: string }) => host.id)
  ),
  basePath: vi.fn((hostId: string) => mockSshWorkspaceService.resolveWorkspaceBasePath(hostId)),
  // Asks the same tmux as the host session checks, so tests set up both through one mock.
  findTerminalSessions: vi.fn((backend: unknown, terminalIds: string[]) =>
    (mockSshWorkspaceService.findTerminalSessions as (...args: unknown[]) => Promise<Set<string>>)(
      backend,
      terminalIds
    )
  ),
};
vi.mock('../../../src/main/services/ssh-workspace-sync/host', () => ({
  sshWorkspaceSyncHost: mockSshWorkspaceSyncHost,
}));

const mockLocalMirrorService = {
  getMirrorPath: vi.fn((workspaceId: string) => `/mock/home/.komla/mirrors/${workspaceId}`),
  initialize: vi.fn((workspaceId: string) =>
    Promise.resolve(`/mock/home/.komla/mirrors/${workspaceId}`)
  ),
  prepare: vi.fn((workspaceId: string) =>
    Promise.resolve(`/mock/home/.komla/mirrors/${workspaceId}`)
  ),
  onSyncStatus: vi.fn(
    (
      listener: (status: {
        workspaceId: string;
        state: 'syncing' | 'ready' | 'error';
        message?: string;
      }) => void
    ) => {
      mockLocalMirrorSyncStatusListener = listener;
      return vi.fn();
    }
  ),
  getSyncStatuses: vi.fn(() => []),
  ensureInitialSync: vi.fn(),
  requestSync: vi.fn(),
  hasMirror: vi.fn(() => false),
  remove: vi.fn(() => Promise.resolve()),
};
vi.mock('../../../src/main/services/local-mirror.service', () => ({
  localMirrorService: mockLocalMirrorService,
}));

const mockUtilityInferenceService = {
  isAvailable: vi.fn(() => true),
  labelWorkspace: vi.fn(),
  nameBranch: vi.fn(),
  labelWorkspaceAndBranch: vi.fn(),
};
vi.mock('../../../src/main/services/utility-inference.service', () => ({
  utilityInferenceService: mockUtilityInferenceService,
}));

// Mock paths module
vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
  ensureKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

const mockActionService = {
  get: vi.fn(),
  list: vi.fn(() => []),
};
vi.mock('../../../src/main/services/action.service', () => ({
  actionService: mockActionService,
}));

vi.mock('../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: {
    increment: vi.fn(),
    incrementAction: vi.fn(),
    incrementMcpTool: vi.fn(),
  },
}));

// Mock WSL
const mockIsWslMode = vi.fn(() => false);
const mockWindowsPathToWsl = vi.fn((path: string) => path);
vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: () => mockIsWslMode(),
  windowsPathToWsl: (path: string) => mockWindowsPathToWsl(path),
}));

// Mock opencode's folder release; it runs the worktree delete it wraps
const mockDeleteReleasingOpenCodeLocation = vi.fn(
  (_directory: string, remove: () => Promise<void>) => remove()
);
vi.mock('../../../src/main/lib/opencode-service', () => ({
  deleteReleasingOpenCodeLocation: (directory: string, remove: () => Promise<void>) =>
    mockDeleteReleasingOpenCodeLocation(directory, remove),
}));

// Mock logger
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockGenerateBranchSuffix = vi.fn();
vi.mock('../../../src/shared/lib/random-names', () => ({
  generateBranchSuffix: () => mockGenerateBranchSuffix(),
  branchSuffixToName: (suffix: string) =>
    suffix
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
  sanitizeBranchSuffix: (raw: string) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50),
  sanitizeBranchName: (raw: string) =>
    raw
      .replace(/@\{/g, '-')
      .replace(/[\s~^:?*[\]\\{}"'!#$%&()+=<>,;|`]/g, '-')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/\/{2,}/g, '/')
      .replace(/-{2,}/g, '-')
      .split('/')
      .map((part: string) => part.replace(/^[-.]|[-.]$/g, '').replace(/\.lock$/i, ''))
      .filter(Boolean)
      .join('/'),
  sanitizeWorktreeProjectSegment: (raw: string) => {
    const reserved = new Set([
      'CON',
      'PRN',
      'AUX',
      'NUL',
      'COM1',
      'COM2',
      'COM3',
      'COM4',
      'COM5',
      'COM6',
      'COM7',
      'COM8',
      'COM9',
      'LPT1',
      'LPT2',
      'LPT3',
      'LPT4',
      'LPT5',
      'LPT6',
      'LPT7',
      'LPT8',
      'LPT9',
    ]);
    const cleaned = raw
      .normalize('NFC')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    if (!cleaned) return 'project';
    const basename = cleaned.split('.', 1)[0].toUpperCase();
    return reserved.has(basename) ? `_${cleaned}` : cleaned;
  },
}));

function escapeForExpectedShell(value: string): string {
  const normalized = value.replace(/\r?\n/g, ' ');
  // Desktop commands run in PowerShell on Windows.
  if (process.platform === 'win32') return `'${normalized.replace(/'/g, "''")}'`;
  return `'${normalized.replace(/'/g, `'"'"'`)}'`;
}

/** What a background run streams to the SSH host: the setup that lets it run `komla`, then it. */
function sshBackgroundRun(directory: string, command: string) {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const setup = [
    `cd '${directory}' || exit $?`,
    "export KOMLA_API_URL='http://127.0.0.1:62000'",
    "export KOMLA_CLI='/home/dev/.komla/helpers/komla'",
    `PATH='/home/dev/.komla/helpers':"$PATH"; export PATH`,
  ].join('\n');
  return expect.stringMatching(
    new RegExp(`^${literal(setup)}\nexport KOMLA_WORKSPACE_ID='[^']+'\n${literal(command)}$`)
  );
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function createSshBranchAlreadyExistsError(branchName: string): Error {
  return Object.assign(new Error(`Branch "${branchName}" already exists on the SSH host.`), {
    code: 'SSH_BRANCH_ALREADY_EXISTS',
  });
}

function createSshWorktreePathConflictError(): Error {
  return Object.assign(new Error('Remote worktree path belongs to a different branch.'), {
    code: 'SSH_WORKTREE_PATH_CONFLICT',
  });
}

// Windows refuses SSH Local copy steps before preparing them (workspace-setup/step-resolution.ts).
const itWithLocalCopySteps = it.skipIf(process.platform === 'win32');

describe('WorkspaceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    resetIdCounter();
    mockUuidCounter = 0;
    mockPtyStatusListener = undefined;
    mockLocalMirrorSyncStatusListener = undefined;
    mockLocalMirrorService.hasMirror.mockReturnValue(false);
    vfs.clear();
    mockGenerateBranchSuffix.mockReset();
    mockGenerateBranchSuffix.mockReturnValue('swift-fox');
    mockSshPortForwardService.ensureKomlaDataTunnel.mockReset();

    // Set up default file system state
    vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

    // Reset WSL mocks to unix defaults
    mockIsWslMode.mockReturnValue(false);
    mockWindowsPathToWsl.mockImplementation((path: string) => path);
    mockRealpathSync.mockImplementation((path: string) => path);

    // Reset mocks to defaults
    mockLicenseService.canStartWorkspace.mockReturnValue({ allowed: true });
    mockLicenseService.getStatus.mockReturnValue({ isLicensed: true });
    mockGitService.createWorktree.mockResolvedValue({
      path: '/mock/home/.komla/worktrees/project/agent-branch',
      createdBranch: true,
    });
    mockGitService.isGitRepo.mockResolvedValue(true);
    mockGitService.getCurrentBranch.mockResolvedValue('main');
    mockGitService.getMainBranch.mockResolvedValue('main');
    mockGitService.getRemoteUrl.mockResolvedValue('https://github.com/example/repo.git');
    mockGitService.resolvePublishedCommit.mockResolvedValue('0123456789abcdef');
    mockGitService.fastForwardBranchToRemoteIfSafe.mockResolvedValue(false);
    mockSshWorkspaceService.createWorkspace.mockResolvedValue({
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
        remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
        gitUrl: 'https://github.com/example/repo.git',
        projectName: 'Test Project',
      },
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox',
      repoName: 'Test Project',
    });
    mockSshWorkspaceService.deleteWorkspace.mockResolvedValue(undefined);
    mockSshWorkspaceService.deleteHostData.mockResolvedValue(undefined);
    mockSshWorkspaceService.hasHost.mockReturnValue(true);
    mockSshWorkspaceService.createWorkspacePlan.mockImplementation(createMockSshWorkspacePlan);
    mockSshWorkspaceGit.getBranchQuickStatus.mockImplementation(async (backend) => ({
      currentBranch: backend.branchName ?? 'feature',
      mainBranch: 'main',
      defaultBranch: 'main',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    }));
    mockSshWorkspaceService.ensureWorkspaceReady.mockResolvedValue({
      createdBranch: true,
      createdWorktree: true,
    });
    mockSshWorkspaceService.killTerminalSessions.mockResolvedValue(undefined);
    mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set());
    mockSshWorkspaceService.runStreaming.mockImplementation(() => Promise.resolve(0));
    mockRemoteCompanionService.ensureInstalled.mockReset();
    mockRemoteCompanionService.ensureInstalled.mockResolvedValue(
      '/home/dev/.komla/helpers/bin/komla'
    );
    mockRemoteCompanionService.ensureRunning.mockReset();
    mockRemoteCompanionService.ensureRunning.mockResolvedValue(undefined);
    mockRemoteCompanionService.installedPath.mockReset();
    mockSshWorkspaceService.supportsPersistentTerminalSessions.mockResolvedValue(true);
    mockConfigService.get.mockReturnValue({});
    mockSshWorkspaceSyncHost.read.mockResolvedValue([]);
    mockSshWorkspaceSyncHost.inspect.mockResolvedValue({ state: 'present' });
    mockSshWorkspaceSyncHost.write.mockResolvedValue(true);
    mockConfigService.update.mockImplementation((updates) => updates);
    mockHttpServerService.getActualPort.mockReturnValue(54183);
    mockHttpServerService.waitForActualPort.mockResolvedValue(54183);
    mockPtyService.isRunning.mockReturnValue(false);
    mockPtyService.getStatus.mockReturnValue('running');
    mockAgentPresetService.get.mockImplementation((id: string) =>
      id === mockPlanPreset.id
        ? mockPlanPreset
        : id === mockArgumentPreset.id
          ? mockArgumentPreset
          : undefined
    );
    mockAgentPresetService.getActive.mockReturnValue(mockClaudePreset);
    mockWorkspaceLinksService.unlinkAll.mockResolvedValue(undefined);
    mockWorkspaceLinksService.reconcileAllFromDisk.mockResolvedValue(false);
    mockNotesService.trashAll.mockResolvedValue(undefined);
    // Reset project service to return the default mock project
    mockProject.baseBranch = undefined;
    folderProjects.clear();
    mockProjectService.findOrCreateDirectoryProject.mockImplementation(findOrCreateFolderProject);
    mockProjectService.get.mockImplementation((id: string) =>
      id === 'project-1' ? mockProject : findFolderProject(id)
    );
    mockProjectService.update.mockImplementation(
      async (_id: string, updates: Partial<typeof mockProject>) => {
        Object.assign(mockProject, updates);
        return mockProject;
      }
    );
    mockUtilityInferenceService.isAvailable.mockReset().mockReturnValue(true);
    mockUtilityInferenceService.labelWorkspace.mockReset();
    mockUtilityInferenceService.nameBranch.mockReset();
    mockUtilityInferenceService.labelWorkspaceAndBranch.mockReset();
    mockUtilityInferenceService.labelWorkspace.mockResolvedValue({
      title: 'Generated Title',
      description: 'Generated description',
    });
    mockUtilityInferenceService.nameBranch.mockResolvedValue({
      branchName: 'generated-branch',
    });
    mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValue({
      title: 'Generated Title',
      description: 'Generated description',
      branchName: 'generated-branch',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ============================================================================
  // Loading and Persistence Tests
  // ============================================================================

  describe('saveWorkspacesImmediate', () => {
    it('preserves non-throwing saves for existing callers', async () => {
      const writeError = new Error('disk full');
      mockWriteFileAtomic.mockRejectedValueOnce(writeError);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.saveWorkspacesImmediate()).resolves.toBeUndefined();
    });

    it('propagates atomic write failures to checked transaction callers', async () => {
      const writeError = new Error('disk full');
      mockWriteFileAtomic.mockRejectedValueOnce(writeError);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.saveWorkspacesImmediateChecked()).rejects.toBe(writeError);
    });

    it('holds unrelated saves until a persistence transaction finishes', async () => {
      let finishTransaction!: () => void;
      const transactionBlocker = new Promise<void>((resolve) => {
        finishTransaction = resolve;
      });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const transaction = workspaceService.withPersistenceTransaction(async (save) => {
        await save();
        await transactionBlocker;
      });
      await vi.waitFor(() => expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1));

      const unrelatedSave = workspaceService.saveWorkspacesImmediate();
      await Promise.resolve();
      expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);

      finishTransaction();
      await transaction;
      await unrelatedSave;
      expect(mockWriteFileAtomic).toHaveBeenCalledTimes(2);
    });
  });

  describe('loadWorkspaces', () => {
    it('should load empty workspaces when file does not exist', async () => {
      vfs.deleteFile('/mock/home/.komla/workspaces.json');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspaces = workspaceService.list();

      expect(workspaces).toHaveLength(0);
    });

    it('moves a folder without a project into its folder project, in its color', async () => {
      const folder = (id: string, workingDirectory: string, extra = {}) => ({
        id,
        name: id,
        workingDirectory,
        isWorktree: false,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000,
        lastActivityAt: 1000,
        order: 0,
        ...extra,
      });
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          folder('notes', '/notes', { color: 'hsl(1, 2%, 3%)' }),
          folder('notes-again', '/notes'),
          folder('gone', '/gone'),
          folder('old', '/old', { status: 'trashed' }),
        ])
      );
      mockProjectService.findOrCreateDirectoryProject.mockImplementationOnce(
        (path: string, color?: string) => {
          const project = createProject({
            id: 'folder-notes',
            kind: 'directory',
            name: 'notes',
            repositoryPath: path,
            color,
          });
          folderProjects.set(path, project);
          return project;
        }
      );
      mockProjectService.findOrCreateDirectoryProject.mockImplementation((path: string) => {
        const existing = folderProjects.get(path);
        if (existing) return existing;
        throw new Error('Selected path is not a valid directory');
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(mockProjectService.findOrCreateDirectoryProject).toHaveBeenCalledWith(
        '/notes',
        'hsl(1, 2%, 3%)'
      );
      expect(workspaceService.get('notes')).toMatchObject({
        projectId: 'folder-notes',
        repoName: 'notes',
      });
      expect(workspaceService.get('notes-again')?.projectId).toBe('folder-notes');
      // A folder that's gone stays without a project until it's back.
      expect(workspaceService.get('gone')?.projectId).toBeNull();
      // A trashed one adds no project until it's restored.
      expect(mockProjectService.findOrCreateDirectoryProject).not.toHaveBeenCalledWith(
        '/old',
        undefined
      );
      expect(workspaceService.get('old')?.projectId).toBeNull();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)![1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written.map((w) => w.projectId)).toEqual(['folder-notes', 'folder-notes', null, null]);

      folderProjects.set('/old', createProject({ id: 'folder-old', kind: 'directory', name: 'old' }));
      await workspaceService.restart('old');
      expect(workspaceService.get('old')).toMatchObject({
        status: 'active',
        projectId: 'folder-old',
        repoName: 'old',
      });
    });

    it('should load workspaces from workspaces.json', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace 1',
          workingDirectory: '/mock/ws1',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspaces = workspaceService.list();

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].id).toBe('ws-1');
      expect(workspaces[0].name).toBe('Workspace 1');
      expect(workspaces[0].terminals).toEqual([]); // Terminals are ephemeral
    });

    it.each(['HEAD', 'origin/HEAD', 'refs/remotes/origin/HEAD'])(
      'treats a persisted SSH %s target as unresolved',
      async (baseBranch) => {
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws',
              name: 'Remote',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend: {
                kind: 'ssh',
                hostId: 'ssh-dev',
                remoteDirectory: '/home/dev/worktree',
                remoteRepoPath: '/home/dev/repo.git',
                remoteProjectRoot: '/home/dev',
                gitUrl: 'git@example.com:repo.git',
                baseBranch,
              },
              isWorktree: true,
              projectId: null,
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 2000,
              order: 0,
            },
          ])
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        expect(workspaceService.get('ssh-ws')?.backend).not.toHaveProperty('baseBranch');
      }
    );

    it('restores SSH terminal identities and layouts as disconnected panes', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            terminals: [
              { id: 'term-live', name: 'Agent', createdAt: 1001 },
              { id: '../unsafe', name: 'Invalid', createdAt: 1002 },
            ],
            terminalLayout: {
              tabs: ['term-live', '../unsafe'],
              layouts: {
                'term-live': { type: 'leaf', id: 'pane-1', terminalId: 'term-live' },
              },
              focusedPanes: { 'term-live': 'pane-1' },
              activeTab: 'term-live',
            },
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = workspaceService.get('ssh-ws');

      expect(workspace?.terminals).toEqual([
        expect.objectContaining({ id: 'term-live', status: 'stopped', name: 'Agent' }),
      ]);
      expect(workspace?.terminalLayout?.tabs).toEqual(['term-live']);
      expect(workspace?.terminalLayout?.activeTab).toBe('term-live');
    });

    it('does not restore local mirror terminals from persisted SSH workspace state', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            primaryTerminalId: 'term-local',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            terminals: [
              { id: 'term-remote', name: 'Agent', createdAt: 1001 },
              {
                id: 'term-local',
                name: 'Local mirror',
                createdAt: 1002,
                executionLocation: 'local-mirror',
              },
            ],
            terminalLayout: {
              tabs: ['term-local', 'term-remote'],
              layouts: {
                'term-local': { type: 'leaf', id: 'pane-local', terminalId: 'term-local' },
                'term-remote': { type: 'leaf', id: 'pane-remote', terminalId: 'term-remote' },
              },
              focusedPanes: {
                'term-local': 'pane-local',
                'term-remote': 'pane-remote',
              },
              activeTab: 'term-local',
            },
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = workspaceService.get('ssh-ws');

      expect(workspace?.terminals.map((terminal) => terminal.id)).toEqual(['term-remote']);
      expect(workspace?.primaryTerminalId).toBe('term-remote');
      expect(workspace?.terminalLayout?.tabs).toEqual(['term-remote']);
    });

    it('restores last-known tmux activity without contacting the SSH host', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            terminals: [
              {
                id: 'term-live',
                name: 'Agent',
                createdAt: 1001,
                remoteSessionActive: true,
              },
            ],
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ssh-ws')?.terminals[0]).toEqual(
        expect.objectContaining({ status: 'stopped', remoteSessionActive: true })
      );
      expect(workspaceService.getRunningWorkspaceCount()).toBe(1);
      expect(mockSshWorkspaceService.findTerminalSessions).not.toHaveBeenCalled();
    });

    it('should load all workspaces regardless of license status', async () => {
      mockLicenseService.getStatus.mockReturnValue({ isLicensed: false });

      const persistedWorkspaces = Array.from({ length: 6 }, (_, i) => ({
        id: `ws-${i + 1}`,
        name: `Workspace ${i + 1}`,
        workingDirectory: `/mock/ws${i + 1}`,
        isWorktree: false,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + i,
        lastActivityAt: 2000 + i,
        order: i,
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspaces = workspaceService.list();

      expect(workspaces).toHaveLength(6);
    });

    it('should apply SSH workspace status snapshots and notify renderers', async () => {
      const persistedWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'SSH Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/agent-branch',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          branchName: 'agent/old',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/app/agent-branch',
            remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/app',
            gitUrl: 'https://github.com/example/app.git',
            projectName: 'app',
            branchName: 'agent/old',
            baseBranch: 'main',
          },
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');
      const firstWorkingTree = {
        files: [
          {
            path: 'src/app.ts',
            status: 'modified' as const,
            staged: false,
            additions: 3,
            deletions: 1,
          },
          {
            path: 'notes.txt',
            status: 'untracked' as const,
            staged: false,
            additions: 0,
            deletions: 0,
          },
        ],
        summary: { additions: 3, deletions: 1, filesChanged: 2 },
      };
      const branch = {
        currentBranch: 'agent/new',
        targetBranch: 'main',
        aheadTargetBranch: 2,
        behindTargetBranch: 1,
        unpushedCommits: 2,
        behindRemote: 0,
        hasRemote: true,
        hasOriginRemote: true,
        targetBranchHasRemote: true,
        targetBranchAheadRemote: 0,
        targetBranchBehindRemote: 3,
      };
      await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: 'ssh-ws-1',
          source: { kind: 'remote-companion', sequence: 1 },
          observedAt: Date.now(),
          stateHash: 'state-1',
          cwd: '/home/dev/.komla/worktrees/app/agent-branch',
          statusB64: Buffer.from(' M src/app.ts\0?? notes.txt\0').toString('base64'),
          numstatB64: Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
          branch,
        },
      });
      await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: 'ssh-ws-1',
          source: { kind: 'remote-companion', sequence: 2 },
          observedAt: Date.now(),
          stateHash: 'state-2',
          cwd: '/home/dev/.komla/worktrees/app/agent-branch',
          statusB64: Buffer.from(' M src/app.ts\0?? notes.txt\0').toString('base64'),
          numstatB64: Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
          branch,
        },
      });
      expect(mockWriteFileAtomic).not.toHaveBeenCalled();

      const activityAt = workspaceService.get('ssh-ws-1')?.lastActivityAt;
      expect(activityAt).toBe(1000);
      expect(send).toHaveBeenCalledWith(
        'git-status:worktree-changed',
        'ssh-ws-1',
        ['file', 'git-head', 'git-branch'],
        activityAt,
        undefined,
        undefined,
        undefined
      );
      expect(workspaceService.get('ssh-ws-1')?.branchName).toBe('agent/new');
      expect(workspaceService.get('ssh-ws-1')?.backend).toEqual(
        expect.objectContaining({ branchName: 'agent/new' })
      );
      expect(workspaceService.get('ssh-ws-1')?.lastKnownGitStatus).toEqual({
        branch: expect.objectContaining({
          currentBranch: 'agent/new',
          aheadTargetBranch: 2,
          behindTargetBranch: 1,
        }),
        diff: {
          files: expect.arrayContaining([
            expect.objectContaining({ path: 'src/app.ts', additions: 3, deletions: 1 }),
          ]),
          summary: { additions: 3, deletions: 1, filesChanged: 2 },
        },
        updatedAt: expect.any(Number),
        lastConfirmedAt: expect.any(Number),
      });

      await vi.advanceTimersByTimeAsync(600);
      expect(workspaceFileWrites()).toHaveLength(1);
      const written = JSON.parse(workspaceFileWrites().at(-1)?.[1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written[0]?.lastKnownGitStatus).toEqual(
        workspaceService.get('ssh-ws-1')?.lastKnownGitStatus
      );
      expect(written[0]?.lastActivityAt).toBe(1000);

      const priorSnapshot = workspaceStatusService.read({
        kind: 'working-tree-for-diff',
        workspaceId: 'ssh-ws-1',
      });
      await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: 'ssh-ws-1',
          source: { kind: 'remote-companion', sequence: 3 },
          observedAt: Date.now(),
          stateHash: 'state-3',
          cwd: '/home/dev/.komla/worktrees/app/agent-branch',
          statusTooLarge: true,
          branch,
        },
      });
      expect(priorSnapshot).toBeDefined();
      expect(
        workspaceStatusService.read({ kind: 'working-tree-for-diff', workspaceId: 'ssh-ws-1' })
      ).toBeUndefined();
      expect(send).toHaveBeenLastCalledWith(
        'git-status:worktree-changed',
        'ssh-ws-1',
        ['file'],
        expect.any(Number),
        undefined,
        undefined,
        undefined
      );

      const currentWorkingTree = {
        files: [
          {
            path: 'src/current.ts',
            status: 'modified' as const,
            staged: false,
            additions: 4,
            deletions: 2,
          },
        ],
        summary: { additions: 4, deletions: 2, filesChanged: 1 },
      };
      await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: 'ssh-ws-1',
          source: { kind: 'remote-companion', sequence: 4 },
          observedAt: Date.now(),
          stateHash: 'state-4',
          cwd: '/home/dev/.komla/worktrees/app/agent-branch',
          statusB64: Buffer.from(' M src/current.ts\0').toString('base64'),
          numstatB64: Buffer.from('4\t2\tsrc/current.ts\0').toString('base64'),
          branch,
        },
      });
      expect(
        workspaceStatusService.read({ kind: 'working-tree-for-diff', workspaceId: 'ssh-ws-1' })
      ).toEqual(currentWorkingTree);
    });

    it('rejects SSH workspace status from a different host or remote directory', async () => {
      const persistedWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'SSH Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/agent-branch',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          branchName: 'agent/branch',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/app/agent-branch',
            remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/app',
            gitUrl: 'https://github.com/example/app.git',
            projectName: 'app',
            branchName: 'agent/branch',
            baseBranch: 'main',
          },
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');

      await expect(
        workspaceStatusService.change({
          kind: 'snapshot-observed',
          snapshot: {
            source: { kind: 'remote-companion', sequence: 1 },
            observedAt: Date.now(),
            stateHash: 'wrong-directory',
            branch: {},
            workspaceId: 'ssh-ws-1',
            cwd: '/mnt/dev/.komla/worktrees/app/agent-branch',
          },
        })
      ).resolves.toMatchObject({ disposition: 'rejected', code: 'target-mismatch' });
      await expect(
        workspaceStatusService.change({
          kind: 'snapshot-observed',
          snapshot: {
            source: { kind: 'remote-companion', sequence: 2 },
            observedAt: Date.now(),
            stateHash: 'wrong-host',
            branch: {},
            hostId: 'ssh-other',
            workspaceId: 'ssh-ws-1',
            cwd: '/home/dev/.komla/worktrees/app/agent-branch',
          },
        })
      ).resolves.toMatchObject({ disposition: 'rejected', code: 'target-mismatch' });
    });

    it.each([undefined, null, 1000, 'invalid'])(
      'restores SSH git status with lastConfirmedAt %s without promoting it to the live diff cache',
      async (lastConfirmedAt) => {
        const branch = {
          behindTargetBranch: 1,
          aheadTargetBranch: 2,
          mainBranch: 'main',
          defaultBranch: 'main',
          hasRemote: true,
          hasOriginRemote: true,
          unpushedCommits: 2,
          behindRemote: 0,
          currentBranch: 'agent/branch',
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 0,
        };
        const diff = {
          files: [
            {
              path: 'src/app.ts',
              status: 'modified',
              staged: false,
              additions: 3,
              deletions: 1,
            },
          ],
          summary: { additions: 3, deletions: 1, filesChanged: 1 },
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'SSH Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              isWorktree: true,
              projectId: null,
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
              backend: {
                kind: 'ssh',
                hostId: 'ssh-dev',
                remoteDirectory: '/home/dev/worktree',
                remoteRepoPath: '/home/dev/repo.git',
                remoteProjectRoot: '/home/dev',
                gitUrl: 'git@example.com:repo.git',
              },
              lastKnownGitStatus: { branch, diff, updatedAt: 1234, lastConfirmedAt },
            },
          ])
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const { workspaceStatusService } =
          await import('../../../src/main/services/workspace-status.service');

        if (lastConfirmedAt === 'invalid') {
          expect(workspaceService.get('ssh-ws-1')?.lastKnownGitStatus).toBeUndefined();
          expect(workspaceStatusService.read()).toEqual([]);
          return;
        }
        expect(workspaceService.get('ssh-ws-1')?.lastKnownGitStatus).toEqual({
          branch,
          diff,
          updatedAt: 1234,
          ...(lastConfirmedAt === undefined ? {} : { lastConfirmedAt }),
        });
        expect(
          workspaceStatusService.read({ kind: 'working-tree-for-diff', workspaceId: 'ssh-ws-1' })
        ).toBeUndefined();
        expect(mockSshWorkspaceService.ensureWorkspaceReady).not.toHaveBeenCalled();
        expect(workspaceStatusService.read()).toEqual([
          expect.objectContaining({
            workspaceId: 'ssh-ws-1',
            workingTree: diff,
            confirmation: {
              kind: 'stale',
              staleSince: expect.any(Number),
              ...(lastConfirmedAt == null ? {} : { lastConfirmedAt }),
              reason: 'source-unreachable',
            },
          }),
        ]);

        await workspaceStatusService.change({
          kind: 'snapshot-observed',
          snapshot: {
            workspaceId: 'ssh-ws-1',
            source: { kind: 'remote-companion', sequence: 1 },
            observedAt: Date.now(),
            stateHash: 'state-1',
            cwd: '/home/dev/worktree',
            statusTooLarge: true,
            branch: {
              currentBranch: branch.currentBranch,
              targetBranch: branch.mainBranch,
              aheadTargetBranch: branch.aheadTargetBranch,
              behindTargetBranch: branch.behindTargetBranch,
              hasRemote: branch.hasRemote,
              hasOriginRemote: branch.hasOriginRemote,
              unpushedCommits: branch.unpushedCommits,
              behindRemote: branch.behindRemote,
              targetBranchHasRemote: branch.targetBranchHasRemote,
              targetBranchAheadRemote: branch.targetBranchAheadRemote,
              targetBranchBehindRemote: branch.targetBranchBehindRemote,
            },
          },
        });

        expect(workspaceService.get('ssh-ws-1')?.lastKnownGitStatus?.diff).toEqual(diff);
        expect(
          workspaceStatusService.read({ kind: 'working-tree-for-diff', workspaceId: 'ssh-ws-1' })
        ).toBeUndefined();
      }
    );

    it('should remove provisioning workspaces on startup', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-provisioning',
          name: 'Provisioning Workspace',
          workingDirectory: '',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
          provisioning: true,
        },
        {
          id: 'ws-normal',
          name: 'Normal Workspace',
          workingDirectory: '/mock/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 1,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Run the setImmediate callback that cleanupStaleWorkspaces is scheduled on
      await vi.advanceTimersByTimeAsync(0);

      const workspaces = workspaceService.list();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].id).toBe('ws-normal');
    });

    it('discards interrupted SSH provisioning without deleting an unverified remote worktree', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-provisioning',
            name: 'Remote Provisioning Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
              remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
              remoteProjectRoot: '/home/dev/.komla/worktrees/project',
              gitUrl: 'git@example.com:repo.git',
            },
            branchName: 'agent/branch',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            provisioning: true,
            provisioningBranchCreated: true,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(workspaceService.list()).toEqual([]);
      expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.deleteWorkspace).not.toHaveBeenCalled();
    });

    it('deletes a verified provisioning branch during interrupted SSH cleanup', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-provisioning',
            name: 'Remote Provisioning Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
              remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
              remoteProjectRoot: '/home/dev/.komla/worktrees/project',
              gitUrl: 'git@example.com:repo.git',
            },
            branchName: 'agent/branch',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            provisioning: true,
            provisioningBranchCreated: true,
            provisioningWorktreeCreated: true,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(workspaceService.list()).toEqual([]);
      expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        true,
        'agent/branch'
      );
    });

    it('retains interrupted SSH provisioning workspaces when remote cleanup fails', async () => {
      mockSshWorkspaceService.deleteWorkspace.mockRejectedValueOnce(new Error('host offline'));
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-provisioning',
            name: 'Remote Provisioning Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
              remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
              remoteProjectRoot: '/home/dev/.komla/worktrees/project',
              gitUrl: 'git@example.com:repo.git',
            },
            branchName: 'agent/branch',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            provisioning: true,
            provisioningBranchCreated: true,
            provisioningWorktreeCreated: true,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(workspaceService.get('ssh-provisioning')).toMatchObject({
        provisioning: false,
        provisionError: expect.stringContaining('remote resources could not be cleaned up'),
      });
      expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        true,
        'agent/branch'
      );
    });

    it('should clean up a persisted provisioning worktree on startup', async () => {
      vfs.mock.mkdirSync('/mock/home/.komla/worktrees/project/agent-branch');
      const persistedWorkspaces = [
        {
          id: 'ws-provisioning',
          name: 'Provisioning Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/agent-branch',
          branchName: 'agent/add-login-feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
          provisioning: true,
          provisioningRepoPath: '/mock/repo',
          provisioningBranchCreated: true,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await vi.advanceTimersByTimeAsync(0);

      expect(workspaceService.list()).toEqual([]);
      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        '/mock/repo',
        '/mock/home/.komla/worktrees/project/agent-branch',
        true,
        {
          deleteBranch: true,
          branchName: 'agent/add-login-feature',
        }
      );
    });

    it('keeps a branch that existed before an interrupted provisioning on startup', async () => {
      vfs.mock.mkdirSync('/mock/home/.komla/worktrees/project/agent-branch');
      const persistedWorkspaces = [
        {
          id: 'ws-provisioning',
          name: 'Provisioning Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/agent-branch',
          branchName: 'feature/existing',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
          provisioning: true,
          provisioningRepoPath: '/mock/repo',
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await vi.advanceTimersByTimeAsync(0);

      expect(workspaceService.list()).toEqual([]);
      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        '/mock/repo',
        '/mock/home/.komla/worktrees/project/agent-branch',
        true,
        { deleteBranch: false, branchName: 'feature/existing' }
      );
    });

    // The directory may only be unavailable for now (an unmounted drive or network share), and
    // git's record is what lets the worktree work again once it is back.
    it("keeps git's record of a worktree whose directory is missing on startup", async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-missing',
          name: 'Missing Workspace',
          workingDirectory: '/mock/missing',
          branchName: 'agent/missing',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
      vfs.mock.mkdirSync('/mock');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await vi.advanceTimersByTimeAsync(0);

      expect(workspaceService.list()).toEqual([]);
      expect(mockGitService.deleteWorktree).not.toHaveBeenCalled();
    });

    it('should notify windows after removing stale workspaces on startup', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-stale',
          name: 'Stale Workspace',
          workingDirectory: '/mock/missing',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);

      await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(send).toHaveBeenCalledWith('workspaces:changed');
    });

    it("moves a stale workspace's notes to the trash on startup", async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-stale',
          name: 'Stale Workspace',
          workingDirectory: '/mock/missing',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockNotesService.trashAll).toHaveBeenCalledWith('ws-stale');
    });

    it('should unlink stale linked workspace references on startup cleanup', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-stale',
          name: 'Stale Workspace',
          workingDirectory: '/mock/missing',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
          linkedWorkspaceIds: ['ws-peer'],
        },
        {
          id: 'ws-peer',
          name: 'Peer Workspace',
          workingDirectory: '/mock/peer',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1001,
          lastActivityAt: 2001,
          order: 1,
          linkedWorkspaceIds: ['ws-stale'],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
      vfs.mock.mkdirSync('/mock/peer');

      await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWorkspaceLinksService.unlinkAll).toHaveBeenCalledWith('ws-stale');
    });

    it('should run unlinkAll for stale workspaces even when their metadata has no links', async () => {
      // A peer dropped its end of the link without us noticing — the missing
      // workspace's metadata is empty, but a sibling may still have a dangling
      // symlink pointing at it. unlinkAll's cleanupLinksPointingTo handles that.
      const persistedWorkspaces = [
        {
          id: 'ws-stale-no-meta',
          name: 'Stale No Meta',
          workingDirectory: '/mock/missing',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      await import('../../../src/main/services/workspace.service');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWorkspaceLinksService.unlinkAll).toHaveBeenCalledWith('ws-stale-no-meta');
    });

    it('should reset windowId to null on startup', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/ws1',
          isWorktree: false,
          projectId: null,
          windowId: 'old-window-id', // This should be reset
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = workspaceService.get('ws-1');

      expect(workspace?.windowId).toBeNull();
    });

    it('should reset to empty list when workspaces.json is not an array', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify({ notAnArray: true }));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.list()).toEqual([]);
    });

    it('should skip invalid entries but load valid ones from workspaces.json', async () => {
      const persistedWorkspaces = [
        { id: 'ws-valid' }, // missing required fields
        {
          id: 'ws-good',
          name: 'Good Workspace',
          workingDirectory: '/mock/ws',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
        'not an object',
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspaces = workspaceService.list();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].id).toBe('ws-good');
    });

    it('registers workspace baseBranch with gitService at load time', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-with-branch',
          name: 'Branch override',
          workingDirectory: '/mock/ws',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
          baseBranch: 'feature-target',
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      await import('../../../src/main/services/workspace.service');

      expect(mockGitService.registerTargetBranch).toHaveBeenCalledWith(
        '/mock/ws',
        'feature-target'
      );
    });

    it('propagates project baseBranch at load time for workspaces without their own', async () => {
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? createProject({ id: 'project-1', baseBranch: 'develop' }) : undefined
      );
      const persistedWorkspaces = [
        {
          id: 'ws-no-branch',
          name: 'No override',
          workingDirectory: '/mock/ws',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      await import('../../../src/main/services/workspace.service');

      expect(mockGitService.registerTargetBranch).toHaveBeenCalledWith('/mock/ws', 'develop');
    });
  });

  describe('browser tab persistence', () => {
    const persistedWorkspace = {
      id: 'ws-1',
      name: 'Workspace 1',
      workingDirectory: '/mock/ws1',
      isWorktree: true,
      projectId: 'project-1',
      windowId: null,
      categoryId: null,
      createdAt: 1000,
      lastActivityAt: 2000,
      order: 0,
    };

    it('gives a new workspace a short id', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const created = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir1',
      });

      expect(created.id).toMatch(/^[a-z][0-9a-z]{9}$/);
    });

    it('drops browser tabs that are not web pages in update()', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const created = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir1',
      });
      workspaceService.update(created.id, {
        browserPanes: [
          {
            browserTabs: [
              { id: 'a', url: 'javascript:alert(1)' },
              { id: 'b', url: 'https://example.com/' },
            ],
          },
        ],
      });

      expect(workspaceService.get(created.id)?.browserPanes).toEqual([
        { browserTabs: [{ id: 'b', url: 'https://example.com/' }], activeBrowserTabId: 'b' },
      ]);
    });

    it('hydrates browser panes from disk, dropping tabs and panes that show no web page', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...persistedWorkspace,
            _version: 1,
            browserPanes: [
              {
                browserTabs: [
                  { id: 'a', url: 'https://example.com/docs' },
                  { id: 'b', url: 'file:///etc/passwd' },
                ],
                activeBrowserTabId: 'b',
              },
              { browserTabs: [{ id: 'c', url: 'javascript:alert(1)' }] },
              'not a pane',
            ],
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-1')?.browserPanes).toEqual([
        { browserTabs: [{ id: 'a', url: 'https://example.com/docs' }], activeBrowserTabId: 'a' },
      ]);
    });

    it('writes browser panes back to disk when a workspace updates them', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const created = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir1',
      });
      const browserPanes = [
        { browserTabs: [{ id: 'a', url: 'http://localhost:5173' }], activeBrowserTabId: 'a' },
      ];
      workspaceService.update(created.id, { browserPanes });

      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)![1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written[0]?.browserPanes).toEqual(browserPanes);
    });

    it('saves recent links and drops ones that are not links to other sites', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const created = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir1',
      });
      workspaceService.update(created.id, {
        recentLinks: [
          { url: 'https://example.com/printed' },
          { url: 'http://localhost:3000/' },
          { url: 'https://github.com/acme/app/pull/1', openedAt: 5 },
        ],
      });

      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const expected = [
        { url: 'https://github.com/acme/app/pull/1', openedAt: 5 },
        { url: 'https://example.com/printed' },
      ];
      expect(workspaceService.get(created.id)?.recentLinks).toEqual(expected);
      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)![1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written[0]?.recentLinks).toEqual(expected);
    });

    it('hydrates recent links from disk', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...persistedWorkspace,
            _version: 1,
            recentLinks: [{ url: 'https://example.com/a' }, { url: 'file:///etc/passwd' }],
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-1')?.recentLinks).toEqual([{ url: 'https://example.com/a' }]);
    });

    it('saves the virtual desktops and hydrates them, dropping what a hand-edited file got wrong', async () => {
      const desktop = {
        vncPort: 5901,
        shownAt: 5,
        vncPassword: 'pa55word',
        url: 'http://127.0.0.1:6081/vnc.html',
        app: 'xterm',
        vncApp: 'Screen Sharing',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...persistedWorkspace,
            _version: 1,
            virtualDesktops: [desktop, { vncPort: 70000, shownAt: 5 }],
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      expect(workspaceService.get('ws-1')?.virtualDesktops).toEqual([desktop]);

      workspaceService.update('ws-1', { name: 'Renamed' });
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)![1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written[0]?.virtualDesktops).toEqual([desktop]);
    });
  });

  describe('pins, unread marks and snoozes', () => {
    const persistedWorkspace = {
      id: 'ws-1',
      name: 'Workspace 1',
      workingDirectory: '/mock/ws1',
      isWorktree: true,
      projectId: 'project-1',
      windowId: null,
      categoryId: null,
      createdAt: 1000,
      lastActivityAt: 2000,
      order: 0,
      _version: 1,
    };

    function lastWrittenWorkspaces(): Array<Record<string, unknown>> {
      const lastCall = mockWriteFileAtomic.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      return JSON.parse(lastCall![1] as string) as Array<Record<string, unknown>>;
    }

    it('writes pins, unread marks and snoozes back to disk', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([persistedWorkspace]));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.update('ws-1', {
        pinned: true,
        unread: { reason: 'marked', at: 9_000 },
        snoozedUntil: 60_000,
        wakesOnNotification: true,
      });
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      expect(lastWrittenWorkspaces()[0]).toMatchObject({
        pinned: true,
        unread: { reason: 'marked', at: 9_000 },
        snoozedUntil: 60_000,
        wakesOnNotification: true,
      });
    });

    it('wakes a snooze that ended while Komla was closed', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([{ ...persistedWorkspace, snoozedUntil: 5_000 }])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-1')?.snoozedUntil).toBeUndefined();
      expect(workspaceService.get('ws-1')?.unread).toEqual({ reason: 'snooze-ended', at: 5_000 });
    });

    it('wakes a snooze until notified with no time to end at once Komla restarts', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          { ...persistedWorkspace, wakesOnNotification: true },
          {
            ...persistedWorkspace,
            id: 'ws-2',
            workingDirectory: '/mock/ws2',
            order: 1,
            snoozedUntil: 400_000,
            wakesOnNotification: true,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-1')).toMatchObject({
        wakesOnNotification: undefined,
        unread: { reason: 'snooze-ended', at: 10_000 },
      });
      // Until CI Finishes still ends at its time.
      expect(workspaceService.get('ws-2')).toMatchObject({
        snoozedUntil: 400_000,
        wakesOnNotification: true,
      });
    });

    it('wakes a workspace when its snooze ends and tells the windows', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([persistedWorkspace]));
      const { BrowserWindow } = await import('electron');
      const send = vi.fn();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      // Longer than one check interval, so the alarm has to look again before it wakes.
      workspaceService.update('ws-1', { snoozedUntil: 10_000 + 90_000 });

      vi.advanceTimersByTime(89_999);
      expect(workspaceService.get('ws-1')?.snoozedUntil).toBe(100_000);

      vi.advanceTimersByTime(1);
      expect(workspaceService.get('ws-1')?.snoozedUntil).toBeUndefined();
      expect(workspaceService.get('ws-1')?.unread).toEqual({
        reason: 'snooze-ended',
        at: 100_000,
      });
      expect(send).toHaveBeenCalledWith(
        IPC.WORKSPACE_UPDATED,
        expect.objectContaining({ id: 'ws-1' })
      );
    });

    it('does not wake a workspace whose snooze was cleared', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([persistedWorkspace]));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.update('ws-1', { snoozedUntil: 20_000 });
      workspaceService.update('ws-1', { snoozedUntil: undefined });
      vi.advanceTimersByTime(20_000);

      expect(workspaceService.get('ws-1')?.unread).toBeUndefined();
    });

    it("doesn't snooze away an agent that is already waiting for input", async () => {
      vi.setSystemTime(10_000);
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([persistedWorkspace]));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await hookTerminal(workspaceService, terminal.id, {
        kind: 'input-required',
        source: 'codex',
      });

      workspaceService.update('ws-1', { snoozedUntil: 40_000 });

      expect(workspaceService.get('ws-1')?.snoozedUntil).toBeUndefined();
      expect(workspaceService.get('ws-1')?.unread).toEqual({
        reason: 'snooze-ended',
        at: 10_000,
      });
    });

    it('wakes a snooze until notified at the next notification, not a plain snooze', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          persistedWorkspace,
          { ...persistedWorkspace, id: 'ws-2', workingDirectory: '/mock/ws2', order: 1 },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const notified = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const plain = workspaceService.addTerminal('ws-2', 'Terminal 2');
      workspaceService.update('ws-1', { snoozedUntil: 400_000, wakesOnNotification: true });
      workspaceService.update('ws-2', { snoozedUntil: 400_000 });

      vi.setSystemTime(20_000);
      await hookTerminal(workspaceService, notified.id, { kind: 'turn-complete', source: 'codex' });
      await hookTerminal(workspaceService, plain.id, { kind: 'turn-complete', source: 'codex' });

      expect(workspaceService.get('ws-1')).toMatchObject({
        snoozedUntil: undefined,
        wakesOnNotification: undefined,
        unread: { reason: 'snooze-ended', at: 20_000 },
      });
      expect(workspaceService.get('ws-2')?.snoozedUntil).toBe(400_000);
    });

    it('tells hooks about each prompt sent to an agent', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([persistedWorkspace]));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { onHookEvent } = await import('../../../src/main/lib/hook-events');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const events: unknown[] = [];
      const stop = onHookEvent((details) => events.push(details));

      await hookTerminal(workspaceService, terminal.id, {
        kind: 'prompt-submit',
        source: 'codex',
        message: 'Add search',
      });
      stop();
      expect(events).toEqual([
        { event: 'agent.prompt', workspaceId: 'ws-1', terminalId: terminal.id, message: 'Add search' },
      ]);
    });

    it('takes a snoozed workspace off the dock badge until it wakes', async () => {
      vi.setSystemTime(10_000);
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([persistedWorkspace]));
      const { electronAttentionWindows } =
        await import('../../../src/main/services/terminal-attention/windows');
      const badge = vi.spyOn(electronAttentionWindows, 'badge');
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await hookTerminal(workspaceService, terminal.id, { kind: 'turn-complete', source: 'codex' });
      expect(badge).toHaveBeenLastCalledWith(1);

      workspaceService.update('ws-1', { snoozedUntil: 40_000 });
      expect(badge).toHaveBeenLastCalledWith(0);

      vi.advanceTimersByTime(30_000);
      expect(badge).toHaveBeenLastCalledWith(1);
    });
  });

  describe('color persistence', () => {
    it('hydrates color from disk on load', async () => {
      const persistedWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace 1',
          workingDirectory: '/mock/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 2000,
          order: 0,
          color: 'hsl(340, 70%, 55%)',
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = workspaceService.get('ws-1');

      expect(workspace?.color).toBe('hsl(340, 70%, 55%)');
    });

    it('writes color back to disk when a directory workspace updates it', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const created = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir1',
      });
      workspaceService.update(created.id, { color: 'hsl(340, 70%, 55%)' });

      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const lastCall = mockWriteFileAtomic.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const written = JSON.parse(lastCall![1] as string) as Array<Record<string, unknown>>;
      expect(written[0]?.color).toBe('hsl(340, 70%, 55%)');
    });
  });

  describe('default action', () => {
    const usedActions = [
      { id: 'global', title: 'Global', content: 'a', lastUsedAt: 10 },
      { id: 'other', title: 'Other', content: 'b', lastUsedAt: 30, projectIds: ['proj-2'] },
      { id: 'mine', title: 'Mine', content: 'c', lastUsedAt: 20, projectIds: ['proj-1'] },
      { id: 'unused', title: 'Unused', content: 'd' },
    ];

    afterEach(() => {
      mockActionService.list.mockImplementation(() => []);
    });

    it('starts a new workspace on the last used action, or the one that launches it', async () => {
      mockActionService.list.mockImplementation(() => usedActions);
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const seeded = await workspaceService.create({ mode: 'directory', directoryPath: '/mock/a' });
      const launched = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/b',
        defaultActionId: 'unused',
      });

      expect(seeded.defaultActionId).toBe('global');
      expect(launched.defaultActionId).toBe('unused');
    });

    it('writes a picked default back to disk', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const created = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir1',
      });
      expect(created.defaultActionId).toBeUndefined();
      workspaceService.update(created.id, {
        defaultActionId: 'picked',
        paneDefaultActionId: 'picked-in-pane',
      });

      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const lastCall = mockWriteFileAtomic.mock.calls.at(-1);
      const written = JSON.parse(lastCall![1] as string) as Array<Record<string, unknown>>;
      expect(written[0]?.defaultActionId).toBe('picked');
      expect(written[0]?.paneDefaultActionId).toBe('picked-in-pane');
    });

    it('loads the right-click default saved apart from the run button one', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'ws-1',
            workingDirectory: '/mock/ws-1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            defaultActionId: 'run-button',
            paneDefaultActionId: 'right-click',
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-1')).toMatchObject({
        defaultActionId: 'run-button',
        paneDefaultActionId: 'right-click',
      });
    });
  });

  describe('saveWorkspaces', () => {
    it('should debounce multiple saves', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Create multiple workspaces rapidly
      await workspaceService.create({ mode: 'directory', directoryPath: '/mock/dir1' });
      await workspaceService.create({ mode: 'directory', directoryPath: '/mock/dir2' });
      await workspaceService.create({ mode: 'directory', directoryPath: '/mock/dir3' });

      // Before debounce
      expect(mockWriteFileAtomic).not.toHaveBeenCalled();

      // After debounce (500ms)
      vi.advanceTimersByTime(600);

      // Allow async write to complete
      await Promise.resolve();

      expect(mockWriteFileAtomic).toHaveBeenCalled();
    });

    it('persists SSH terminal identities and the last renderer layout', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.updateTerminalStatus('term-live', 'running');
      const workspace = workspaceService.get('ssh-ws')!;
      workspace.terminals.push({
        id: 'term-local',
        name: 'Local mirror',
        status: 'running',
        createdAt: 1002,
        executionLocation: 'local-mirror',
      });
      workspace.terminals.push({
        id: 'term-shell',
        name: 'Remote shell',
        status: 'running',
        createdAt: 1003,
        executionLocation: 'workspace',
        remoteSessionResumable: true,
      });
      workspace.primaryTerminalId = 'term-local';

      workspaceService.saveSshTerminalLayouts({
        'ssh-ws': {
          tabs: ['term-local'],
          layouts: {
            'term-local': {
              type: 'split',
              id: 'split-root',
              direction: 'vertical',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'pane-local', terminalId: 'term-local' },
                {
                  type: 'split',
                  id: 'split-remote',
                  direction: 'horizontal',
                  sizes: [50, 50],
                  children: [
                    { type: 'leaf', id: 'pane-remote', terminalId: 'term-live' },
                    { type: 'leaf', id: 'pane-shell', terminalId: 'term-shell' },
                  ],
                },
              ],
            },
          },
          focusedPanes: { 'term-local': 'pane-local' },
          activeTab: 'term-local',
        },
      });
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      const written = JSON.parse(workspaceFileWrites().at(-1)?.[1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written[0]?.terminals).toEqual([
        expect.objectContaining({
          id: 'term-live',
          name: 'Agent',
          remoteSessionActive: true,
        }),
        expect.objectContaining({
          id: 'term-shell',
          name: 'Remote shell',
          remoteSessionActive: true,
        }),
      ]);
      expect(written[0]?.primaryTerminalId).toBe('term-live');
      expect(written[0]?.terminalLayout).toMatchObject({
        tabs: ['term-live'],
        layouts: {
          'term-live': {
            type: 'split',
            children: [{ terminalId: 'term-live' }, { terminalId: 'term-shell' }],
          },
        },
      });
      expect(written[0]?.terminalLayout).toHaveProperty('activeTab', 'term-live');
      expect(written[0]?.terminalLayout).not.toHaveProperty('focusedPanes');

      for (const activeTab of ['term-shell', 'missing', 42, undefined]) {
        workspaceService.saveSshTerminalLayouts({
          'ssh-ws': {
            tabs: ['term-live', 'term-shell'],
            layouts: {
              'term-live': { type: 'leaf', id: 'pane-live', terminalId: 'term-live' },
              'term-shell': { type: 'leaf', id: 'pane-shell', terminalId: 'term-shell' },
            },
            activeTab,
          },
        });
        expect(workspace.terminalLayout?.activeTab).toBe(
          activeTab === 'term-shell' ? 'term-shell' : undefined
        );
      }

      const writesBeforeClearingLayout = workspaceFileWrites().length;
      workspaceService.saveSshTerminalLayouts({
        'ssh-ws': { tabs: [], layouts: {} },
      });
      vi.advanceTimersByTime(600);
      await vi.waitFor(() => {
        expect(workspaceFileWrites().length).toBeGreaterThan(writesBeforeClearingLayout);
      });

      const withoutLayout = JSON.parse(workspaceFileWrites().at(-1)?.[1] as string) as Array<
        Record<string, unknown>
      >;
      expect(withoutLayout[0]?.terminalLayout).toBeUndefined();

      workspace.terminals[0]!.remoteSessionResumable = false;
      workspace.terminals[2]!.remoteSessionResumable = false;
      await workspaceService.dispose();

      const withoutTmux = JSON.parse(workspaceFileWrites().at(-1)?.[1] as string) as Array<
        Record<string, unknown>
      >;
      expect(withoutTmux[0]?.terminals).toEqual([]);
      expect(withoutTmux[0]?.primaryTerminalId).toBeUndefined();
      expect(withoutTmux[0]?.terminalLayout).toBeUndefined();
    });

    it('does not rewrite workspaces when an SSH layout save is unchanged', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const layouts = {
        'ssh-ws': {
          tabs: ['term-live'],
          layouts: { 'term-live': { type: 'leaf', id: 'pane-live', terminalId: 'term-live' } },
          focusedPanes: { 'term-live': 'pane-live' },
          activeTab: 'term-live',
        },
      };

      const writesBeforeFirstSave = mockWriteFileAtomic.mock.calls.length;
      workspaceService.saveSshTerminalLayouts(layouts);
      await vi.advanceTimersByTimeAsync(600);
      await vi.waitFor(() => {
        expect(mockWriteFileAtomic.mock.calls.length).toBeGreaterThan(writesBeforeFirstSave);
      });
      const writesAfterFirstSave = mockWriteFileAtomic.mock.calls.length;

      workspaceService.saveSshTerminalLayouts(structuredClone(layouts));
      await vi.advanceTimersByTimeAsync(600);

      expect(mockWriteFileAtomic).toHaveBeenCalledTimes(writesAfterFirstSave);
    });
  });

  describe('dispose', () => {
    it('does not launch a managed SSH terminal after shutdown begins', async () => {
      let finishPreparation!: () => void;
      mockSshWorkspaceService.supportsPersistentTerminalSessions.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishPreparation = () => resolve(true);
          })
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ssh-ws', 'Agent');

      await workspaceService.dispose();
      finishPreparation();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPtyService.spawn).not.toHaveBeenCalled();
      expect(terminal.status).toBe('stopped');
    });
  });

  // ============================================================================
  // enforceWorkspaceLimit Tests
  // ============================================================================

  describe('enforceWorkspaceLimit', () => {
    const sshBackend = (i: number) => ({
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: `/home/dev/worktree-${i}`,
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
    });

    it('should stop terminals in excess running workspaces', async () => {
      mockLicenseService.getStatus.mockReturnValue({ isLicensed: true });

      const persistedWorkspaces = Array.from({ length: 6 }, (_, i) => ({
        id: `ws-${i + 1}`,
        name: `Workspace ${i + 1}`,
        workingDirectory: `ssh://ssh-dev/home/dev/worktree-${i + 1}`,
        backend: sshBackend(i + 1),
        isWorktree: true,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + i,
        lastActivityAt: 2000 + i, // ws-6 is most recent (2005), ws-1 is oldest (2000)
        order: i,
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // All 6 loaded
      expect(workspaceService.list()).toHaveLength(6);

      // Add running terminals to all 6 workspaces
      for (let i = 1; i <= 6; i++) {
        const ws = workspaceService.get(`ws-${i}`)!;
        ws.terminals = [{ id: `term-${i}`, name: 'T', status: 'running', createdAt: Date.now() }];
      }

      // Enforce limit
      await workspaceService.enforceWorkspaceLimit();

      // All 6 should still be in the list (not hidden/removed)
      expect(workspaceService.list()).toHaveLength(6);

      // Terminals on the 2 least recently active (ws-1, ws-2) should be killed
      expect(mockPtyService.kill).toHaveBeenCalledWith('term-1');
      expect(mockPtyService.kill).toHaveBeenCalledWith('term-2');
      // The 4 most recent should NOT have their terminals killed
      expect(mockPtyService.kill).not.toHaveBeenCalledWith('term-3');
      expect(mockPtyService.kill).not.toHaveBeenCalledWith('term-4');
      expect(mockPtyService.kill).not.toHaveBeenCalledWith('term-5');
      expect(mockPtyService.kill).not.toHaveBeenCalledWith('term-6');
    });

    it('keeps a stopped workspace in the dock badge while its card shows attention', async () => {
      mockLicenseService.getStatus.mockReturnValue({ isLicensed: true });

      const persistedWorkspaces = Array.from({ length: 6 }, (_, i) => ({
        id: `ws-${i + 1}`,
        name: `Workspace ${i + 1}`,
        workingDirectory: `ssh://ssh-dev/home/dev/worktree-${i + 1}`,
        backend: sshBackend(i + 1),
        isWorktree: true,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + i,
        lastActivityAt: 2000 + i,
        order: i,
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
      const { electronAttentionWindows } =
        await import('../../../src/main/services/terminal-attention/windows');
      const badge = vi.spyOn(electronAttentionWindows, 'badge');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      for (let i = 1; i <= 6; i++) {
        const ws = workspaceService.get(`ws-${i}`)!;
        ws.terminals = [{ id: `term-${i}`, name: 'T', status: 'running', createdAt: Date.now() }];
      }
      await hookTerminal(workspaceService, 'term-1', { kind: 'input-required', source: 'codex' });
      expect(badge).toHaveBeenLastCalledWith(1);
      // The other workspaces were in use after the agent asked.
      for (let i = 2; i <= 6; i++) {
        workspaceService.get(`ws-${i}`)!.lastActivityAt = Date.now() + i;
      }

      await workspaceService.enforceWorkspaceLimit();

      expect(mockPtyService.kill).toHaveBeenCalledWith('term-1');
      expect(workspaceService.get('ws-1')?.attention).toMatchObject({ kind: 'input-required' });
      expect(badge).toHaveBeenLastCalledWith(1);
    });

    it('takes a workspace off the dock badge while it is trashed', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace 1',
            workingDirectory: '/mock/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
          },
        ])
      );
      const { electronAttentionWindows } =
        await import('../../../src/main/services/terminal-attention/windows');
      const badge = vi.spyOn(electronAttentionWindows, 'badge');
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await hookTerminal(workspaceService, terminal.id, { kind: 'turn-complete', source: 'codex' });
      expect(badge).toHaveBeenLastCalledWith(1);

      workspaceService.update('ws-1', { status: 'trashed' });
      expect(badge).toHaveBeenLastCalledWith(0);
      workspaceService.update('ws-1', { status: 'active' });
      expect(badge).toHaveBeenLastCalledWith(1);
    });

    it('should stop file watchers on excess running workspaces', async () => {
      mockLicenseService.getStatus.mockReturnValue({ isLicensed: true });

      const persistedWorkspaces = Array.from({ length: 6 }, (_, i) => ({
        id: `ws-${i + 1}`,
        name: `Workspace ${i + 1}`,
        workingDirectory: `ssh://ssh-dev/home/dev/worktree-${i + 1}`,
        backend: sshBackend(i + 1),
        isWorktree: true,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + i,
        lastActivityAt: 2000 + i,
        order: i,
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Add running terminals to all 6 workspaces
      for (let i = 1; i <= 6; i++) {
        const ws = workspaceService.get(`ws-${i}`)!;
        ws.terminals = [{ id: `term-${i}`, name: 'T', status: 'running', createdAt: Date.now() }];
      }

      await workspaceService.enforceWorkspaceLimit();

      // ws-1 and ws-2 are the least recently active running workspaces
      expect(mockWorktreeWatcherService.stopWatching).toHaveBeenCalledWith('ws-1');
      expect(mockWorktreeWatcherService.stopWatching).toHaveBeenCalledWith('ws-2');
    });

    it('should do nothing when running count is at or under the limit', async () => {
      mockLicenseService.getStatus.mockReturnValue({ isLicensed: true });

      const persistedWorkspaces = Array.from({ length: 6 }, (_, i) => ({
        id: `ws-${i + 1}`,
        name: `Workspace ${i + 1}`,
        workingDirectory: `ssh://ssh-dev/home/dev/worktree-${i + 1}`,
        backend: sshBackend(i + 1),
        isWorktree: true,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + i,
        lastActivityAt: 2000 + i,
        order: i,
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Only add running terminals to 4 workspaces (at the limit)
      for (let i = 1; i <= 4; i++) {
        const ws = workspaceService.get(`ws-${i}`)!;
        ws.terminals = [{ id: `term-${i}`, name: 'T', status: 'running', createdAt: Date.now() }];
      }

      await workspaceService.enforceWorkspaceLimit();

      // All 6 should still be there
      expect(workspaceService.list()).toHaveLength(6);
      expect(mockPtyService.kill).not.toHaveBeenCalled();
      expect(mockWorktreeWatcherService.stopWatching).not.toHaveBeenCalled();
    });

    it('leaves running local workspaces alone, since the free plan only limits SSH ones', async () => {
      const persistedWorkspaces = Array.from({ length: 6 }, (_, i) => ({
        id: `ws-${i + 1}`,
        name: `Workspace ${i + 1}`,
        workingDirectory: `/mock/ws${i + 1}`,
        isWorktree: false,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + i,
        lastActivityAt: 2000 + i,
        order: i,
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      for (let i = 1; i <= 6; i++) {
        const ws = workspaceService.get(`ws-${i}`)!;
        ws.terminals = [{ id: `term-${i}`, name: 'T', status: 'running', createdAt: Date.now() }];
      }

      await workspaceService.enforceWorkspaceLimit();

      expect(mockPtyService.kill).not.toHaveBeenCalled();
      expect(mockWorktreeWatcherService.stopWatching).not.toHaveBeenCalled();
    });

    it('should stop detached SSH sessions in excess workspaces', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      const persistedWorkspaces = [
        {
          id: 'ssh-oldest',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
            remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'git@example.com:repo.git',
          },
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          terminals: [
            {
              id: 'term-remote',
              name: 'Remote',
              status: 'stopped',
              createdAt: 1000,
              remoteSessionActive: true,
            },
            {
              id: 'term-local-mirror',
              name: 'Local',
              status: 'running',
              createdAt: 1001,
              executionLocation: 'local-mirror',
            },
          ],
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `local-${index}`,
          name: `Newer ${index}`,
          workingDirectory: `ssh://ssh-dev/home/dev/worktree-${index}`,
          backend: sshBackend(index),
          isWorktree: true,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 2000 + index,
          lastActivityAt: 2000 + index,
          order: index + 1,
        })),
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService
        .get('ssh-oldest')!
        .terminals.find((terminal) => terminal.id === 'term-remote')!.remoteSessionActive = true;
      workspaceService.get('ssh-oldest')!.terminals.push({
        id: 'term-local-mirror',
        name: 'Local',
        status: 'running',
        createdAt: 1001,
        executionLocation: 'local-mirror',
      });
      for (let index = 0; index < 4; index++) {
        workspaceService.get(`local-${index}`)!.terminals = [
          {
            id: `local-term-${index}`,
            name: 'T',
            status: 'running',
            createdAt: 2000 + index,
          },
        ];
      }

      await workspaceService.enforceWorkspaceLimit();

      expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalledWith(
        persistedWorkspaces[0].backend,
        ['term-remote']
      );
      expect(mockPtyService.kill).toHaveBeenCalledWith('term-remote');
      expect(mockPtyService.kill).toHaveBeenCalledWith('term-local-mirror');
      expect(
        workspaceService
          .get('ssh-oldest')
          ?.terminals.find((terminal) => terminal.id === 'term-remote')?.remoteSessionActive
      ).toBe(false);
    });

    it('should preserve SSH session state when remote limit enforcement fails', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      const persistedWorkspaces = Array.from({ length: 5 }, (_, index) => ({
        id: `ssh-${index}`,
        name: `Remote ${index}`,
        workingDirectory: `ssh://ssh-dev/home/dev/worktree-${index}`,
        backend: {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: `/home/dev/worktree-${index}`,
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example.com:repo.git',
        },
        isWorktree: true,
        projectId: null,
        windowId: null,
        categoryId: null,
        createdAt: 1000 + index,
        lastActivityAt: 1000 + index,
        order: index,
        terminals: [
          {
            id: `remote-${index}`,
            name: 'Remote',
            status: 'stopped',
            createdAt: 1000 + index,
            remoteSessionActive: true,
          },
        ],
      }));
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
      mockSshWorkspaceService.killTerminalSessions.mockRejectedValueOnce(new Error('offline'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      for (let index = 0; index < 5; index++) {
        workspaceService.get(`ssh-${index}`)!.terminals[0]!.remoteSessionActive = true;
      }

      await expect(workspaceService.enforceWorkspaceLimit()).rejects.toThrow(
        'Could not stop all remote agents'
      );

      expect(mockPtyService.kill).not.toHaveBeenCalledWith('remote-0');
      expect(workspaceService.get('ssh-0')?.terminals[0]?.remoteSessionActive).toBe(true);
    });
  });

  // ============================================================================
  // Create Workspace Tests
  // ============================================================================

  describe('create', () => {
    describe('worktree mode', () => {
      it('should create a worktree workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'New Feature',
          branchName: 'new-feature',
          projectId: 'project-1',
        });

        expect(workspace.name).toBe('New Feature');
        expect(workspace.isWorktree).toBe(true);
        expect(workspace.projectId).toBe('project-1');
        expect(workspace.repoName).toBe('Test Project');
        expect(workspace.branchName).toBe('agent/new-feature');
        expect(mockGitService.createWorktree).toHaveBeenCalled();
      });

      it("offers the project's icons at each new workspace, local or remote", async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'dev.example.com',
              basePath: '~/.komla',
            },
          ],
        });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const local = await workspaceService.create({
          mode: 'worktree',
          branchName: 'local',
          projectId: 'project-1',
        });
        const deferred = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          deferBranchNaming: true,
        });
        const remote = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        const deferredRemote = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(mockProjectService.armIconPrompt.mock.calls).toEqual([
          ['project-1', local.id],
          ['project-1', deferred.id],
          ['project-1', remote.id],
          ['project-1', deferredRemote.id],
        ]);
      });

      it('should add branch prefix if not present', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        const createCall = mockGitService.createWorktree.mock.calls[0];
        expect(createCall[1]).toBe('agent/my-feature');
      });

      it('should not double-add branch prefix', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'agent/my-feature',
          projectId: 'project-1',
        });

        const createCall = mockGitService.createWorktree.mock.calls[0];
        expect(createCall[1]).toBe('agent/my-feature');
      });

      it('should not double-add branch prefix with different casing', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'Agent/my-feature',
          projectId: 'project-1',
        });

        const createCall = mockGitService.createWorktree.mock.calls[0];
        // Should normalize to the configured prefix casing, not double-prefix
        expect(createCall[1]).toBe('agent/my-feature');
      });

      it('should not add prefix when project has empty defaultBranchPrefix', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const emptyPrefixProject = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          defaultBranchPrefix: '',
        });
        mockProjectService.get.mockReturnValueOnce(emptyPrefixProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        const createCall = mockGitService.createWorktree.mock.calls[0];
        expect(createCall[1]).toBe('my-feature');
      });

      it('should auto-generate unprefixed branch name when project has empty prefix', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const emptyPrefixProject = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          defaultBranchPrefix: '',
        });
        mockProjectService.get.mockReturnValueOnce(emptyPrefixProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          projectId: 'project-1',
        });

        // Branch name should not have any prefix
        expect(workspace.branchName).toBeDefined();
        expect(workspace.branchName).not.toContain('/');
      });

      it('should use exact branch name when useExactBranchName is true', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'existing-branch',
          projectId: 'project-1',
          useExactBranchName: true,
        });

        const createCall = mockGitService.createWorktree.mock.calls[0];
        expect(createCall[1]).toBe('existing-branch');
      });

      it('should throw if projectId is missing', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'Feature',
            branchName: 'my-feature',
            // Missing projectId
          })
        ).rejects.toThrow('Project ID is required for worktree mode');
      });

      it('should auto-generate branch name if not provided', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          projectId: 'project-1',
          // No branchName provided - should auto-generate
        });

        // Branch name should have the prefix and be non-empty
        expect(workspace.branchName).toMatch(/^agent\//);
        expect(workspace.branchName!.length).toBeGreaterThan('agent/'.length);
      });

      it('should throw if project is not found', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValueOnce(undefined);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'Feature',
            branchName: 'my-feature',
            projectId: 'non-existent',
          })
        ).rejects.toThrow('Project non-existent not found');
      });

      it('should use managed repo path for managed projects', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({ id: 'managed-1' });
        mockProjectService.get.mockReturnValue(managedProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'managed-1',
        });

        const createCall = mockGitService.createWorktree.mock.calls[0];
        expect(createCall[0]).toBe(managedProject.managedRepoPath);
      });

      it('stores a detected target on a local workspace without configuring the project', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({ id: 'managed-1', baseBranch: undefined });
        mockProjectService.get.mockReturnValue(managedProject);
        mockGitService.getMainBranch.mockResolvedValueOnce('main');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'managed-1',
          deferBranchNaming: true,
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          managedProject.managedRepoPath,
          'my-feature',
          expect.any(String),
          'main',
          expect.any(Object)
        );
        expect(workspace.baseBranch).toBe('main');
        expect(managedProject.baseBranch).toBeUndefined();
        expect(mockProjectService.update).not.toHaveBeenCalled();
        expect(mockGitService.fastForwardBranchToRemoteIfSafe).toHaveBeenCalledWith(
          managedProject.managedRepoPath,
          'main'
        );
        expect(
          mockGitService.fastForwardBranchToRemoteIfSafe.mock.invocationCallOrder[0]
        ).toBeLessThan(mockGitService.createWorktree.mock.invocationCallOrder[0]);
      });

      it('fast-forwards a detected managed target before immediate worktree creation', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({ id: 'managed-1', baseBranch: undefined });
        mockProjectService.get.mockReturnValue(managedProject);
        mockGitService.getMainBranch.mockResolvedValueOnce('trunk');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'managed-1',
        });

        expect(mockGitService.fastForwardBranchToRemoteIfSafe).toHaveBeenCalledWith(
          managedProject.managedRepoPath,
          'trunk'
        );
        expect(
          mockGitService.fastForwardBranchToRemoteIfSafe.mock.invocationCallOrder[0]
        ).toBeLessThan(mockGitService.createWorktree.mock.invocationCallOrder[0]);
      });

      it('safely fast-forwards a managed project target before creating from it', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({
          id: 'managed-1',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(managedProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'managed-1',
        });

        expect(mockGitService.fastForwardBranchToRemoteIfSafe).toHaveBeenCalledWith(
          managedProject.managedRepoPath,
          'main'
        );
        expect(
          mockGitService.fastForwardBranchToRemoteIfSafe.mock.invocationCallOrder[0]
        ).toBeLessThan(mockGitService.createWorktree.mock.invocationCallOrder[0]);
      });

      it('also fast-forwards when the configured target is selected explicitly', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({
          id: 'managed-1',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(managedProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'managed-1',
          baseBranch: 'main',
        });

        expect(mockGitService.fastForwardBranchToRemoteIfSafe).toHaveBeenCalledWith(
          managedProject.managedRepoPath,
          'main'
        );
      });

      it('does not update the project target when creating from an alternate base', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({
          id: 'managed-1',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(managedProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'managed-1',
          baseBranch: 'origin/release',
        });

        expect(mockGitService.fastForwardBranchToRemoteIfSafe).not.toHaveBeenCalled();
      });

      it('does not update branches in an unmanaged repository', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const unmanagedProject = createProject({
          id: 'unmanaged-1',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(unmanagedProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'unmanaged-1',
        });

        expect(mockGitService.fastForwardBranchToRemoteIfSafe).not.toHaveBeenCalled();
      });

      it('recovers when the stored project target branch no longer exists', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const project = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(project);
        mockGitService.getMainBranch.mockResolvedValueOnce('develop');
        mockGitService.createWorktree
          .mockRejectedValueOnce(new Error('fatal: invalid reference: main'))
          .mockResolvedValueOnce('/mock/home/.komla/worktrees/Test-Project/my-feature');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        expect(workspace.baseBranch).toBe('develop');
        expect(mockProjectService.update).toHaveBeenCalledWith('project-1', {
          baseBranch: 'develop',
        });
        expect(mockGitService.createWorktree).toHaveBeenNthCalledWith(
          1,
          '/mock/repo',
          'my-feature',
          join('/mock/home/.komla/worktrees/Test-Project/my-feature'),
          'main',
          { fetchRemote: undefined }
        );
        expect(mockGitService.createWorktree).toHaveBeenNthCalledWith(
          2,
          '/mock/repo',
          'my-feature',
          join('/mock/home/.komla/worktrees/Test-Project/my-feature'),
          'develop',
          { fetchRemote: undefined }
        );
      });

      it('recovers concurrent creates when one updates the stale project target branch first', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const project = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(project);
        mockGitService.getMainBranch.mockResolvedValue('develop');
        mockGitService.createWorktree.mockImplementation(
          async (
            _repoPath: string,
            branchName: string,
            worktreeDestination: string,
            startPoint?: string
          ) => {
            if (startPoint === 'main') {
              if (branchName === 'second-feature') {
                await Promise.resolve();
                await Promise.resolve();
              }
              throw new Error('fatal: invalid reference: main');
            }
            return { path: worktreeDestination, createdBranch: true };
          }
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const [firstWorkspace, secondWorkspace] = await Promise.all([
          workspaceService.create({
            mode: 'worktree',
            name: 'First Feature',
            branchName: 'first-feature',
            projectId: 'project-1',
          }),
          workspaceService.create({
            mode: 'worktree',
            name: 'Second Feature',
            branchName: 'second-feature',
            projectId: 'project-1',
          }),
        ]);

        expect(firstWorkspace.baseBranch).toBe('develop');
        expect(secondWorkspace.baseBranch).toBe('develop');
        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/mock/repo',
          'second-feature',
          join('/mock/home/.komla/worktrees/Test-Project/second-feature'),
          'develop',
          { fetchRemote: undefined }
        );
      });

      it('retries recovered base branch without consuming the final branch-conflict attempt', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const project = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          baseBranch: 'main',
        });
        mockProjectService.get.mockReturnValue(project);
        mockGitService.getMainBranch.mockResolvedValue('develop');
        let createAttempts = 0;
        mockGitService.createWorktree.mockImplementation(
          async (
            _repoPath: string,
            _branchName: string,
            worktreeDestination: string,
            startPoint?: string
          ) => {
            createAttempts++;
            if (createAttempts < 25) {
              throw new Error("fatal: 'feature' is already checked out at '/tmp/worktree'");
            }
            if (startPoint === 'main') {
              throw new Error('fatal: invalid reference: main');
            }
            return { path: worktreeDestination, createdBranch: true };
          }
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'feature',
          projectId: 'project-1',
          autoResolveBranchConflicts: true,
        });

        expect(workspace.baseBranch).toBe('develop');
        expect(createAttempts).toBe(26);
        expect(mockGitService.createWorktree).toHaveBeenLastCalledWith(
          '/mock/repo',
          expect.any(String),
          expect.any(String),
          'develop',
          { fetchRemote: undefined }
        );
      });

      it('does not recover an explicitly requested missing start branch', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const project = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          baseBranch: 'develop',
        });
        mockProjectService.get.mockReturnValue(project);
        mockGitService.getMainBranch.mockResolvedValueOnce('develop');
        mockGitService.createWorktree.mockRejectedValueOnce(
          new Error('fatal: invalid reference: main')
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'Feature',
            branchName: 'my-feature',
            projectId: 'project-1',
            baseBranch: 'main',
          })
        ).rejects.toThrow(
          'Could not create branch "my-feature": the base branch "main" does not exist'
        );

        expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
        expect(mockProjectService.update).not.toHaveBeenCalled();
      });

      it('should fail gracefully when workspace branch already exists in Komla', async () => {
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            createWorktreeWorkspace({
              id: 'ws-existing',
              name: 'Existing Feature',
              branchName: 'agent/existing-branch',
              projectId: 'project-1',
            }),
          ])
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'New Feature',
            branchName: 'existing-branch',
            projectId: 'project-1',
          })
        ).rejects.toThrow(
          'Branch "agent/existing-branch" is already open in workspace "Existing Feature".'
        );

        expect(mockGitService.createWorktree).not.toHaveBeenCalled();
      });

      it('should auto-resolve local branch conflicts for generated names', async () => {
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            createWorktreeWorkspace({
              id: 'ws-existing',
              name: 'Existing Feature',
              branchName: 'agent/swift-fox',
              projectId: 'project-1',
            }),
          ])
        );
        mockGenerateBranchSuffix.mockReturnValueOnce('calm-river');
        mockGitService.createWorktree.mockResolvedValueOnce({
          path: '/mock/home/.komla/worktrees/Test-Project/agent-calm-river',
          createdBranch: true,
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Swift Fox',
          branchName: 'swift-fox',
          projectId: 'project-1',
          autoResolveBranchConflicts: true,
        });

        expect(workspace.branchName).toBe('agent/calm-river');
        expect(workspace.name).toBe('Calm River');
        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/mock/repo',
          'agent/calm-river',
          join('/mock/home/.komla/worktrees/Test-Project/agent-calm-river'),
          'main',
          { fetchRemote: undefined }
        );
      });

      it('should use project.name for worktree folder when repositoryPath ends in .git', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const bareRepoProject = createProject({
          id: 'project-1',
          name: 'repo',
          repositoryPath: '/some/repo.git',
          defaultBranchPrefix: '',
        });
        mockProjectService.get.mockReturnValueOnce(bareRepoProject);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/some/repo.git',
          'my-feature',
          join('/mock/home/.komla/worktrees/repo/my-feature'),
          'main',
          { fetchRemote: undefined }
        );
      });

      it('starts the worktree from origin when startFromOrigin is set', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValueOnce(
          createProject({ id: 'project-1', name: 'repo', repositoryPath: '/some/repo' })
        );
        mockGitService.fetchOriginStartPoint.mockResolvedValueOnce('origin/main');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          useExactBranchName: true,
          projectId: 'project-1',
          startFromOrigin: true,
        });

        expect(mockGitService.fetchOriginStartPoint).toHaveBeenCalledWith('/some/repo', 'main');
        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/some/repo',
          'my-feature',
          expect.any(String),
          'origin/main',
          { fetchRemote: undefined }
        );
      });

      it('keeps the local start point when origin cannot provide it', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValueOnce(
          createProject({ id: 'project-1', name: 'repo', repositoryPath: '/some/repo' })
        );
        mockGitService.fetchOriginStartPoint.mockResolvedValueOnce(undefined);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          useExactBranchName: true,
          projectId: 'project-1',
          startFromOrigin: true,
        });

        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/some/repo',
          'my-feature',
          expect.any(String),
          'main',
          { fetchRemote: undefined }
        );
      });

      it('starts a new branch off the target from origin by default', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.fetchOriginStartPoint.mockResolvedValueOnce('origin/main');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockGitService.fetchOriginStartPoint.mockClear();
        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        expect(mockGitService.fetchOriginStartPoint).toHaveBeenCalledWith('/mock/repo', 'main');
        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/mock/repo',
          'agent/my-feature',
          expect.any(String),
          'origin/main',
          { fetchRemote: undefined }
        );
      });

      it("stops the project's background fetch before waiting on its git queue", async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockGitService.stopBackgroundWork.mockClear();
        mockGitService.fetchOriginStartPoint.mockClear();
        mockGitService.fetchOriginStartPoint.mockImplementationOnce(async () => {
          expect(mockGitService.stopBackgroundWork).toHaveBeenCalledWith('/mock/repo');
          return undefined;
        });
        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        expect(mockGitService.fetchOriginStartPoint).toHaveBeenCalled();
      });

      it('stops it again after deferred branch naming, before any git work', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockGitService.stopBackgroundWork.mockClear();
        mockGitService.fetchOriginStartPoint.mockClear();
        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          deferBranchNaming: true,
        });

        await vi.waitFor(() => expect(mockGitService.fetchOriginStartPoint).toHaveBeenCalled());
        expect(mockGitService.stopBackgroundWork).toHaveBeenCalledTimes(2);
        expect(mockGitService.stopBackgroundWork.mock.invocationCallOrder[1]).toBeLessThan(
          mockGitService.fetchOriginStartPoint.mock.invocationCallOrder[0]
        );
      });

      it('starts from origin by default when the requested base is the project target', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValueOnce(
          createProject({
            id: 'project-1',
            name: 'repo',
            repositoryPath: '/some/repo',
            baseBranch: 'develop',
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockGitService.fetchOriginStartPoint.mockClear();
        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
          baseBranch: 'develop',
        });

        expect(mockGitService.fetchOriginStartPoint).toHaveBeenCalledWith('/some/repo', 'develop');
      });

      it('starts branch names with the app-wide prefix when the project has none', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({ gitDefaults: { branchPrefix: 'me/' } });
        mockProjectService.get.mockReturnValueOnce(
          createProject({ id: 'project-1', name: 'repo', repositoryPath: '/mock/repo' })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
        });

        expect(mockGitService.createWorktree).toHaveBeenCalledWith(
          '/mock/repo',
          'me/my-feature',
          expect.any(String),
          expect.anything(),
          expect.anything()
        );
      });

      it.each([
        [
          'an exact branch name, which usually opens an existing branch',
          { useExactBranchName: true },
        ],
        ['a base branch other than the target', { baseBranch: 'feature/base' }],
        ['a caller that opts out', { startFromOrigin: false }],
      ])('keeps the local start point by default for %s', async (_case, extra) => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockGitService.fetchOriginStartPoint.mockClear();
        await workspaceService.create({
          mode: 'worktree',
          name: 'Feature',
          branchName: 'my-feature',
          projectId: 'project-1',
          ...extra,
        });

        expect(mockGitService.fetchOriginStartPoint).not.toHaveBeenCalled();
      });

      it('should normalize git worktree conflict errors to friendly message', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.createWorktree.mockRejectedValueOnce(
          new Error("fatal: 'agent/existing-branch' is already checked out at '/tmp/worktree'")
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'New Feature',
            branchName: 'existing-branch',
            projectId: 'project-1',
          })
        ).rejects.toThrow('Branch "agent/existing-branch" already has an active worktree.');
      });

      it('should normalize the newer git worktree conflict error', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.createWorktree.mockRejectedValueOnce(
          new Error("fatal: 'agent/existing-branch' is already used by worktree at '/tmp/worktree'")
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'New Feature',
            branchName: 'existing-branch',
            projectId: 'project-1',
          })
        ).rejects.toThrow('Branch "agent/existing-branch" already has an active worktree.');
      });

      it('should normalize invalid reference errors to friendly message', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.createWorktree.mockRejectedValueOnce(
          new Error(
            'Command failed: git worktree add -b agent/my-feature /path main\nfatal: invalid reference: main'
          )
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'My Feature',
            branchName: 'my-feature',
            projectId: 'project-1',
          })
        ).rejects.toThrow(
          'Could not create branch "agent/my-feature": the base branch "main" does not exist in this repository.'
        );
      });

      it('should preserve empty repository errors from git worktree creation', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.createWorktree.mockRejectedValueOnce(
          new Error(
            'Cannot create branch "agent/my-feature" because this repository has no commits yet. Create an initial commit on the target branch, then try again.'
          )
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            name: 'My Feature',
            branchName: 'my-feature',
            projectId: 'project-1',
          })
        ).rejects.toThrow(
          'Cannot create branch "agent/my-feature" because this repository has no commits yet.'
        );
      });

      it('should retry with a new generated branch when git reports checked-out conflict', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGenerateBranchSuffix.mockReturnValueOnce('calm-river');
        mockGitService.createWorktree
          .mockRejectedValueOnce(
            new Error("fatal: 'agent/swift-fox' is already checked out at '/tmp/worktree'")
          )
          .mockResolvedValueOnce('/mock/home/.komla/worktrees/Test-Project/agent-calm-river');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'Swift Fox',
          branchName: 'swift-fox',
          projectId: 'project-1',
          autoResolveBranchConflicts: true,
        });

        expect(workspace.branchName).toBe('agent/calm-river');
        expect(mockGitService.createWorktree).toHaveBeenCalledTimes(2);
        expect(mockGitService.createWorktree.mock.calls[0][1]).toBe('agent/swift-fox');
        expect(mockGitService.createWorktree.mock.calls[1][1]).toBe('agent/calm-river');
      });

      it('should auto-resolve exact branch name conflicts with numeric suffix', async () => {
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            createWorktreeWorkspace({
              id: 'ws-existing',
              name: 'My Feature',
              branchName: 'feature/my-feature',
              projectId: 'project-1',
            }),
          ])
        );
        mockGitService.createWorktree.mockResolvedValueOnce({
          path: '/mock/home/.komla/worktrees/Test-Project/feature-my-feature-1',
          createdBranch: true,
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'My Feature',
          branchName: 'feature/my-feature',
          projectId: 'project-1',
          useExactBranchName: true,
          autoResolveBranchConflicts: true,
        });

        expect(workspace.branchName).toBe('feature/my-feature-1');
        expect(workspace.name).toBe('My Feature 1');
        expect(mockGitService.createWorktree.mock.calls[0][1]).toBe('feature/my-feature-1');
      });

      it('should auto-resolve exact branch name conflicts at git level', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.createWorktree
          .mockRejectedValueOnce(
            new Error("fatal: 'feature/my-feature' is already checked out at '/tmp/worktree'")
          )
          .mockResolvedValueOnce('/mock/home/.komla/worktrees/Test-Project/feature-my-feature-1');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'My Feature',
          branchName: 'feature/my-feature',
          projectId: 'project-1',
          useExactBranchName: true,
          autoResolveBranchConflicts: true,
        });

        expect(workspace.branchName).toBe('feature/my-feature-1');
        expect(mockGitService.createWorktree).toHaveBeenCalledTimes(2);
        expect(mockGitService.createWorktree.mock.calls[0][1]).toBe('feature/my-feature');
        expect(mockGitService.createWorktree.mock.calls[1][1]).toBe('feature/my-feature-1');
      });

      describe('branchedFrom', () => {
        it('is undefined when no baseBranch override is provided', async () => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockProjectService.get.mockReturnValueOnce(
            createProject({ id: 'project-1', baseBranch: 'main' })
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');

          const workspace = await workspaceService.create({
            mode: 'worktree',
            name: 'Feature',
            branchName: 'my-feature',
            projectId: 'project-1',
          });

          expect(workspace.branchedFrom).toBeUndefined();
        });

        it('is undefined when baseBranch matches the project default', async () => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockProjectService.get.mockReturnValueOnce(
            createProject({ id: 'project-1', baseBranch: 'main' })
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');

          const workspace = await workspaceService.create({
            mode: 'worktree',
            name: 'Feature',
            branchName: 'my-feature',
            projectId: 'project-1',
            baseBranch: 'main',
          });

          expect(workspace.branchedFrom).toBeUndefined();
        });

        it('is set when baseBranch differs from the project default', async () => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockProjectService.get.mockReturnValueOnce(
            createProject({ id: 'project-1', baseBranch: 'main' })
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');

          const workspace = await workspaceService.create({
            mode: 'worktree',
            name: 'Feature',
            branchName: 'my-feature',
            projectId: 'project-1',
            baseBranch: 'agent/source-branch',
          });

          expect(workspace.branchedFrom).toBe('agent/source-branch');
        });

        it('is set on the deferred-provisioning placeholder when baseBranch differs', async () => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockConfigService.get.mockReturnValue({ autoNameBranches: true });
          mockProjectService.get.mockReturnValue(
            createProject({ id: 'project-1', baseBranch: 'main' })
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');

          const workspace = await workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            initialPrompt: 'Add login feature',
            deferBranchNaming: true,
            baseBranch: 'agent/source-branch',
          });

          expect(workspace.provisioning).toBe(true);
          expect(workspace.branchedFrom).toBe('agent/source-branch');
        });
      });
    });

    describe('directory mode', () => {
      it('should create a directory workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/directory/path',
        });

        expect(workspace.isWorktree).toBe(false);
        expect(workspace.projectId).toBe('folder-1');
        expect(workspace.repoName).toBe('path');
        expect(workspace.workingDirectory).toBe('/some/directory/path');
        expect(mockProjectService.findOrCreateDirectoryProject).toHaveBeenCalledWith(
          '/some/directory/path'
        );
      });

      it('should not detect git even if directory is a git repo', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/repo',
        });

        expect(workspace.branchName).toBeUndefined();
        expect(mockGitService.isGitRepo).not.toHaveBeenCalled();
      });

      it('should auto-derive name from folder when not provided', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path/my-project',
        });

        expect(workspace.name).toBe('my-project');
      });

      it('should allow multiple directory workspaces in the folder project of one folder', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const first = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path/my-project',
          name: 'First terminal',
        });
        const second = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path/my-project',
          name: 'Second terminal',
        });

        expect(first.id).not.toBe(second.id);
        expect(first.projectId).toBe('folder-1');
        expect(second.projectId).toBe('folder-1');
        expect(first.workingDirectory).toBe('/some/path/my-project');
        expect(second.workingDirectory).toBe('/some/path/my-project');
      });

      it('should throw if directoryPath is missing', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'directory',
            // Missing directoryPath
          })
        ).rejects.toThrow('Directory path is required');
      });
    });

    describe('terminal spawning', () => {
      it('should create terminal with agent command', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
        });

        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'claude'
        );
      });

      it('should use prompt command when initialPrompt is provided', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          initialPrompt: 'Help me with tests',
        });

        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'claude "Help me with tests"'
        );
      });

      it('should use initialCommand when provided', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          initialCommand: 'npm install',
        });

        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'npm install'
        );
      });

      it('should run creation-only setup steps on workspace creation', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const projectWithSteps = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          defaultBranchPrefix: 'agent/',
          setupSteps: [
            createBackgroundStep({
              name: 'Install',
              command: 'npm install',
              trigger: 'workspace-creation',
            }),
          ],
        });
        mockProjectService.get.mockReturnValue(projectWithSteps);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          name: 'New Feature',
          branchName: 'new-feature',
          projectId: 'project-1',
        });

        expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          'npm install',
          expect.any(String),
          'Install',
          expect.objectContaining({ onData: expect.any(Function), onExit: expect.any(Function) })
        );
      });

      it('exposes background setup output and failure without blocking workspace creation', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({ id: 'install-step', name: 'Install', command: 'npm install' }),
            ],
          })
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'New Feature',
          branchName: 'new-feature',
          projectId: 'project-1',
        });

        expect(workspace.terminals).toHaveLength(1);
        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({
            workspaceId: workspace.id,
            stepId: 'install-step',
            state: 'running',
            output: '',
          }),
        ]);
        const callbacks = mockBackgroundProcessService.spawn.mock.calls[0]?.[4];
        callbacks.onData('dependency failure\r\n');
        callbacks.onData('x'.repeat(70_000));
        callbacks.onExit({ exitCode: 1, signal: 0 });
        expect(workspace.setupActivities?.[0]).toMatchObject({
          state: 'failed',
          exitCode: 1,
          truncated: true,
        });
        expect(workspace.setupActivities?.[0]?.output).toContain('earlier output truncated');
        expect(workspace.setupActivities?.[0]?.output.length).toBeLessThanOrEqual(64 * 1024);

        await vi.advanceTimersByTimeAsync(600);
        const persisted = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)?.[1] as string) as Array<
          Record<string, unknown>
        >;
        expect(persisted[0]).not.toHaveProperty('setupActivities');
      });

      it('continues launching independent Setup items after a visible PTY fails', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            agentLayoutOrder: 1,
            setupSteps: [
              createTabStep({ id: 'broken-step', name: 'Broken', command: 'broken' }),
              createTabStep({ id: 'later-step', name: 'Later', command: 'echo later' }),
            ],
          })
        );
        mockPtyService.spawn.mockImplementationOnce(() => {
          throw new Error('PTY unavailable');
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'New Feature',
          branchName: 'new-feature',
          projectId: 'project-1',
        });

        expect(workspace.terminals.map((terminal) => terminal.name)).toEqual([
          'New Feature',
          'Later',
        ]);
        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({
            stepId: 'broken-step',
            state: 'failed',
            error: 'PTY unavailable',
          }),
        ]);
      });

      it('runs default visible setup steps in the real SSH workspace repository', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createTabStep({
                name: 'Remote setup',
                command: 'printf %s {{destinationPath}}',
                destination: 'workspace-repository',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote-setup',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
            expect.objectContaining({
              remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-remote-setup',
            }),
            "printf %s '/home/dev/.komla/worktrees/test-project/agent-remote-setup'",
            expect.any(String),
            expect.any(String),
            'start',
            expect.objectContaining({ keepShellOpenAfterCommand: true })
          )
        );
      });

      it('resolves SSH Prompt Action setup commands for the remote POSIX shell', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const action = {
          id: 'review-action',
          title: 'Review',
          content: 'Review $changes `carefully`\nand report',
          type: 'prompt' as const,
        };
        mockActionService.get.mockReturnValue(action);
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createTabStep({
                id: 'review-step',
                name: 'Review',
                command: '',
                actionId: action.id,
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote-review',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
          mockClaudePreset,
          'prompt',
          null,
          action.content,
          'posix',
          null
        );
      });

      it('rewrites initial project-setup guidance for a newly created SSH workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValue(
          createProject({ id: 'project-1', name: 'Test Project', repositoryPath: '/mock/repo' })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote-guidance',
          useExactBranchName: true,
          initialPrompt:
            'Fetch http://localhost:54183/skills/komla-project-setup-instructions.md or read /Users/alex/.komla/skills.',
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalled()
        );
        const launchCommand =
          mockSshWorkspaceService.buildTerminalLaunchCommand.mock.calls.at(-1)?.[1];
        expect(launchCommand).toContain('komla skill project-setup');
        expect(launchCommand).not.toContain('komla-project-setup-ssh-instructions.md');
        expect(launchCommand).not.toContain('KOMLA_TUNNEL_TOKEN');
        expect(launchCommand).not.toContain('KOMLA_API_URL');
        expect(launchCommand).not.toContain('127.0.0.1:54183');
        expect(launchCommand).not.toContain('http://localhost');
        expect(launchCommand).not.toContain('/Users/alex');
        expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
          mockClaudePreset,
          'prompt',
          undefined,
          expect.stringContaining('komla skill project-setup'),
          'posix',
          null
        );
      });

      it.each(['projectPath', 'localProjectPath'])(
        'reports desktop-only {{%s}} as a failed remote Setup run',
        async (variable) => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockProjectService.get.mockReturnValue(
            createProject({
              id: 'project-1',
              name: 'Test Project',
              repositoryPath: '/mock/repo',
              setupSteps: [
                createBackgroundStep({
                  id: 'invalid-path',
                  name: 'Invalid path',
                  command: `cp {{${variable}}}/.env .env`,
                }),
              ],
            })
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');
          const workspace = await workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            branchName: 'agent/remote-path',
            useExactBranchName: true,
            location: { kind: 'ssh', hostId: 'ssh-dev' },
          });

          expect(workspace.setupActivities).toEqual([
            expect.objectContaining({
              stepId: 'invalid-path',
              state: 'failed',
              error: expect.stringContaining(`{{${variable}}}`),
            }),
          ]);
          expect(mockSshWorkspaceService.runStreaming).not.toHaveBeenCalled();
        }
      );

      it('aborts remote background Setup when its workspace is deleted', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'dev.example.com',
              basePath: '~/.komla',
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'remote-install',
                name: 'Remote install',
                command: 'npm install',
              }),
            ],
          })
        );
        let setupSignal: AbortSignal | undefined;
        mockSshWorkspaceService.runStreaming.mockImplementation(
          (_host: unknown, _command: string, options: { signal: AbortSignal }) => {
            setupSignal = options.signal;
            return new Promise<number>((_resolve, reject) => {
              options.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
              });
            });
          }
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/delete-setup',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.waitFor(() => expect(setupSignal).toBeDefined());

        await workspaceService.delete(workspace.id, true, false, { skipBackendCleanup: true });

        expect(setupSignal?.aborted).toBe(true);
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('waits for remote background Setup to exit before stopping the workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'dev.example.com',
              basePath: '~/.komla',
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'remote-install',
                name: 'Remote install',
                command: 'npm install',
              }),
            ],
          })
        );
        let setupSignal: AbortSignal | undefined;
        let finishSetup: (() => void) | undefined;
        let setupExited = false;
        mockSshWorkspaceService.runStreaming.mockImplementation(
          (_host: unknown, _command: string, options: { signal: AbortSignal }) => {
            setupSignal = options.signal;
            return new Promise<number>((_resolve, reject) => {
              finishSetup = () => {
                setupExited = true;
                reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
              };
            });
          }
        );
        mockSshWorkspaceService.killTerminalSessions.mockImplementation(async () => {
          expect(setupExited).toBe(true);
        });
        mockWorktreeWatcherService.stopWatching.mockImplementation(async () => {
          expect(setupExited).toBe(true);
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/stop-setup',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.waitFor(() => expect(finishSetup).toBeDefined());

        let stopped = false;
        const stopping = workspaceService.stop(workspace.id).then(() => {
          stopped = true;
        });
        await vi.waitFor(() => expect(setupSignal?.aborted).toBe(true));
        await Promise.resolve();

        expect(stopped).toBe(false);
        finishSetup?.();
        await stopping;
        expect(stopped).toBe(true);
        expect(workspace.setupActivities).toEqual([]);
      });

      itWithLocalCopySteps('prepares an SSH Local copy setup terminal independently of the action preference', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({ defaultSshWorkspaceMode: 'remote' });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            sshWorkspaceMode: 'remote',
            setupSteps: [
              createTabStep({
                name: 'Local app',
                command: 'npm install',
                destination: 'ssh-local-copy',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/local-copy',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() =>
          expect(mockLocalMirrorService.prepare).toHaveBeenCalledWith(
            workspace.id,
            workspace.backend
          )
        );
        await vi.waitFor(() =>
          expect(mockPtyService.spawn).toHaveBeenCalledWith(
            expect.any(String),
            `/mock/home/.komla/mirrors/${workspace.id}`,
            'npm install'
          )
        );
      });

      itWithLocalCopySteps('does not launch a pending SSH Local copy background step after the workspace stops', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        let finishPreparing: (() => void) | undefined;
        mockLocalMirrorService.prepare.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finishPreparing = () => resolve('/mock/home/.komla/mirrors/pending-copy');
            })
        );
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'local-copy',
                name: 'Local app',
                command: 'npm run dev',
                destination: 'ssh-local-copy',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/pending-copy',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.waitFor(() => expect(finishPreparing).toBeDefined());

        await workspaceService.stop(workspace.id);
        finishPreparing?.();
        await Promise.resolve();
        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
        expect(workspace.setupActivities).toEqual([]);
      });

      itWithLocalCopySteps('does not launch a pending SSH Local copy background step during deletion', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        let finishPreparing: (() => void) | undefined;
        let finishRemoving: (() => void) | undefined;
        mockLocalMirrorService.prepare.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finishPreparing = () => resolve('/mock/home/.komla/mirrors/pending-delete');
            })
        );
        mockLocalMirrorService.remove.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRemoving = resolve;
            })
        );
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'local-copy',
                name: 'Local app',
                command: 'npm run dev',
                destination: 'ssh-local-copy',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/pending-delete',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.waitFor(() => expect(finishPreparing).toBeDefined());

        const deletion = workspaceService.delete(workspace.id, true, false, {
          skipBackendCleanup: true,
        });
        await vi.waitFor(() => expect(finishRemoving).toBeDefined());
        finishPreparing?.();
        await vi.runAllTimersAsync();

        expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
        finishRemoving?.();
        await deletion;
      });

      itWithLocalCopySteps('substitutes sshTarget and sshPort in an SSH Local copy command', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          defaultSshWorkspaceMode: 'remote',
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'ssh.example',
              user: 'dev',
              port: 2222,
              basePath: '~/.komla',
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            sshWorkspaceMode: 'remote',
            setupSteps: [
              createTabStep({
                name: 'Upload config',
                command: 'scp -P {{sshPort}} /path/to/.env {{sshTarget}}:{{workspacePath}}/',
                destination: 'ssh-local-copy',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/sidecar',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() =>
          expect(mockLocalMirrorService.prepare).toHaveBeenCalledWith(
            workspace.id,
            workspace.backend
          )
        );
        await vi.waitFor(() =>
          expect(mockPtyService.spawn).toHaveBeenCalledWith(
            expect.any(String),
            `/mock/home/.komla/mirrors/${workspace.id}`,
            "scp -P '2222' /path/to/.env 'dev@ssh.example':'/home/dev/.komla/worktrees/test-project/agent-sidecar'/"
          )
        );
      });

      it('runs an explicit SSH workspace-repository background step in the remote worktree', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'dev.example.com',
              basePath: '~/.komla',
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'remote-install',
                name: 'Remote install',
                command: 'npm install',
                destination: 'ssh-workspace-repository',
              }),
            ],
          })
        );
        mockSshWorkspaceService.runStreaming.mockReturnValue(new Promise<number>(() => {}));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote-bg',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() => expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalled());
        expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev' }),
          sshBackgroundRun('/home/dev/.komla/worktrees/test-project/agent-remote-bg', 'npm install'),
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            workspaceId: workspace.id,
          })
        );
        expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({ stepId: 'remote-install', state: 'running' }),
        ]);
      });

      it('runs a pinned background agent directly on the SSH host', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'dev.example.com',
              basePath: '~/.komla',
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'remote-reviewer',
                name: 'Remote reviewer',
                command: '',
                agent: { presetId: mockPlanPreset.id, launchModeId: 'plan' },
                destination: 'ssh-workspace-repository',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote-reviewer',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() => expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalled());
        expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev' }),
          sshBackgroundRun('/home/dev/.komla/worktrees/test-project/agent-remote-reviewer', 'claude --plan'),
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      });

      it('skips a local-only destination on an SSH workspace without creating activity', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              name: 'SSH Devbox',
              hostname: 'dev.example.com',
              basePath: '~/.komla',
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'local-only',
                name: 'Local only',
                command: 'npm install',
                destination: 'local-workspace-repository',
              }),
              createBackgroundStep({
                id: 'remote-install',
                name: 'Remote install',
                command: 'npm install',
                destination: 'ssh-workspace-repository',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/skip-local',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() => expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalled());
        expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalledTimes(1);
        expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev' }),
          sshBackgroundRun('/home/dev/.komla/worktrees/test-project/agent-skip-local', 'npm install'),
          expect.any(Object)
        );
        expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({ stepId: 'remote-install' }),
        ]);
      });

      it('skips SSH-only destinations on a local workspace without creating activity', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'ssh-only',
                name: 'SSH only',
                command: 'npm install',
                destination: 'ssh-workspace-repository',
              }),
              createBackgroundStep({
                id: 'local-copy',
                name: 'Local copy',
                command: 'npm install',
                destination: 'ssh-local-copy',
              }),
              createBackgroundStep({
                id: 'local-install',
                name: 'Local install',
                command: 'npm install',
                destination: 'workspace-repository',
              }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'New Feature',
          branchName: 'new-feature',
          projectId: 'project-1',
        });

        expect(mockSshWorkspaceService.runStreaming).not.toHaveBeenCalled();
        expect(mockLocalMirrorService.prepare).not.toHaveBeenCalled();
        expect(mockBackgroundProcessService.spawn).toHaveBeenCalledTimes(1);
        expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
          workspace.id,
          'npm install',
          expect.any(String),
          'Local install',
          expect.any(Object)
        );
        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({ stepId: 'local-install' }),
        ]);
      });

      it('reports an unsupported Local copy step without blocking other SSH setup', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [
            {
              id: 'ssh-dev',
              capabilities: {
                localMirror: {
                  platform: 'supported',
                  localRsync: 'available',
                  remoteRsync: 'missing',
                },
              },
            },
          ],
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'copy-step',
                name: 'Install local app',
                command: 'npm install',
                destination: 'ssh-local-copy',
              }),
              createTabStep({ name: 'Remote shell', command: 'echo ready' }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/unsupported-copy',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({ stepId: 'copy-step', state: 'unsupported' }),
        ]);
        expect(mockLocalMirrorService.prepare).not.toHaveBeenCalled();
        expect(workspace.terminals.map((terminal) => terminal.name)).toContain('Remote shell');
      });

      itWithLocalCopySteps('classifies missing rsync discovered during Local copy preparation as unsupported', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLocalMirrorService.prepare.mockRejectedValueOnce(
          new Error('Local copies require rsync to be installed on this computer')
        );
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'copy-step',
                name: 'Install local app',
                command: 'npm install',
                destination: 'ssh-local-copy',
              }),
              createTabStep({ name: 'Remote shell', command: 'echo ready' }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/unprobed-copy',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() =>
          expect(workspace.setupActivities).toEqual([
            expect.objectContaining({
              stepId: 'copy-step',
              state: 'unsupported',
              error: expect.stringContaining('require rsync'),
            }),
          ])
        );
        expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
        expect(workspace.terminals.map((terminal) => terminal.name)).toContain('Remote shell');
      });

      it.runIf(process.platform === 'win32')(
        'reports SSH Local copy steps as unsupported on Windows without preparing them',
        async () => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockProjectService.get.mockReturnValue(
            createProject({
              id: 'project-1',
              name: 'Test Project',
              repositoryPath: '/mock/repo',
              setupSteps: [
                createBackgroundStep({
                  id: 'copy-step',
                  name: 'Install local app',
                  command: 'npm install',
                  destination: 'ssh-local-copy',
                }),
                createTabStep({ name: 'Remote shell', command: 'echo ready' }),
              ],
            })
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');
          const workspace = await workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            branchName: 'agent/windows-copy',
            useExactBranchName: true,
            location: { kind: 'ssh', hostId: 'ssh-dev' },
          });

          await vi.waitFor(() =>
            expect(workspace.setupActivities).toEqual([
              expect.objectContaining({
                stepId: 'copy-step',
                state: 'unsupported',
                error: 'SSH Local copy requires rsync on this computer and the SSH host',
              }),
            ])
          );
          expect(mockLocalMirrorService.prepare).not.toHaveBeenCalled();
          expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
          expect(workspace.terminals.map((terminal) => terminal.name)).toContain('Remote shell');
        }
      );

      it('isolates Local copy path allocation failures from later setup launches', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLocalMirrorService.getMirrorPath.mockImplementationOnce(() => {
          throw new Error('Could not allocate a local folder');
        });
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            name: 'Test Project',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                id: 'copy-step',
                name: 'Install local app',
                command: 'npm install',
                destination: 'ssh-local-copy',
              }),
              createTabStep({ name: 'Remote shell', command: 'echo ready' }),
            ],
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/copy-path-full',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(workspace.setupActivities).toEqual([
          expect.objectContaining({
            stepId: 'copy-step',
            state: 'failed',
            error: expect.stringContaining('Could not allocate a local folder'),
          }),
        ]);
        expect(workspace.terminals.map((terminal) => terminal.name)).toContain('Remote shell');
        expect(workspace.terminals.map((terminal) => terminal.name)).toContain(workspace.name);
      });

      it('should inherit the workspace launch mode for semantic agent setup steps', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const projectWithSteps = createProject({
          id: 'project-1',
          name: 'Test Project',
          repositoryPath: '/mock/repo',
          defaultBranchPrefix: 'agent/',
          setupSteps: [
            createSplitStep('right', {
              name: 'Second agent',
              command: '',
              agent: {},
            }),
          ],
        });
        mockProjectService.get.mockReturnValue(projectWithSteps);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          name: 'New Feature',
          branchName: 'new-feature',
          projectId: 'project-1',
          presetId: mockPlanPreset.id,
          launchModeId: 'plan',
          initialPrompt: 'Build the feature',
        });

        expect(workspace.presetId).toBe(mockPlanPreset.id);
        expect(workspace.launchModeId).toBe('plan');
        expect(workspace.terminals).toHaveLength(2);
        expect(mockPtyService.spawn).toHaveBeenCalledTimes(2);
        const secondAgent = workspace.terminals.find(
          (terminal) => terminal.name === 'Second agent'
        );
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          secondAgent!.id,
          expect.any(String),
          'claude --plan'
        );
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          workspace.primaryTerminalId,
          expect.any(String),
          'claude --plan "Build the feature"'
        );
      });
    });

    describe('environments', () => {

      it('opens a folder locally when the last-used environment is an SSH host', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [{ id: 'ssh-dev' }],
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({ mode: 'directory', directoryPath: '/some/path' });

        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'claude'
        );
      });

      it('lets an explicit local environment override the last-used SSH host', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({
          sshHosts: [{ id: 'ssh-dev' }],
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          environment: { kind: 'local' },
        });

        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'claude'
        );
      });

      it('does not wait for the companion runtime before launching an SSH terminal', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          projectName: 'Test Project',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockRemoteCompanionService.ensureRunning.mockReturnValue(new Promise(() => {}));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.addTerminal('ssh-ws-1', 'Agent', 'npm test');

        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
            backend,
            'npm test',
            expect.any(String),
            'ssh-ws-1',
            'start',
            {
              keepShellOpenAfterCommand: false,
              companion: {
                installationKey: 'deterministic-installation',
                tmuxSocket: 'komla-companion-deterministic-installation',
                sessionName: 'komla-companion-deterministic-installation',
                hookInbox: '/home/dev/.komla/helpers/companion/deterministic-installation/inbox',
              },
            }
          )
        );
      });

      it('launches without continuous status when companion startup fails', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          projectName: 'Test Project',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockRemoteCompanionService.ensureRunning.mockRejectedValue(new Error('tmux unavailable'));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const { workspaceStatusService } =
          await import('../../../src/main/services/workspace-status.service');
        const releaseAuthority = vi.spyOn(workspaceStatusService, 'change');

        await workspaceService.addTerminal('ssh-ws-1', 'Agent', 'npm test');

        await vi.waitFor(() =>
          expect(releaseAuthority).toHaveBeenCalledWith({
            kind: 'remote-source-unreachable',
            workspaceIds: ['ssh-ws-1'],
          })
        );
        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
          backend,
          'npm test',
          expect.any(String),
          'ssh-ws-1',
          'start',
          expect.objectContaining({ keepShellOpenAfterCommand: false })
        );

        mockRemoteCompanionService.ensureRunning.mockResolvedValue({
          installationKey: 'install-key',
          tmuxSocket: 'komla-companion-install-key',
          sessionName: 'komla-companion-install-key',
          hookInbox: '/home/dev/.komla/helpers/companion/install-key/inbox',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() =>
          expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalledTimes(2)
        );
      });

      it('keeps a live companion available when terminal setup transiently fails', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          projectName: 'Test Project',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        const runtime = {
          installationKey: 'install-key',
          tmuxSocket: 'komla-companion-install-key',
          sessionName: 'komla-companion-install-key',
          hookInbox: '/home/dev/.komla/helpers/companion/install-key/inbox',
        };
        mockRemoteCompanionService.ensureRunning.mockResolvedValue(runtime);
        mockSshWorkspaceService.ensureRemoteNotificationScript
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('connection reset'));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const { workspaceStatusService } =
          await import('../../../src/main/services/workspace-status.service');
        const releaseAuthority = vi.spyOn(workspaceStatusService, 'change');

        await workspaceService.addTerminal('ssh-ws-1', 'Agent 1', 'npm test');
        await vi.waitFor(() => expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalled());
        releaseAuthority.mockClear();

        await workspaceService.addTerminal('ssh-ws-1', 'Agent 2', 'npm test');
        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.ensureRemoteNotificationScript).toHaveBeenCalledTimes(2)
        );

        expect(releaseAuthority).not.toHaveBeenCalled();
      });

      it('launches an SSH terminal when its resumability broadcast throws', async () => {
        const existingWorkspaces = [
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'https://github.com/example/repo.git',
              branchName: 'agent/test',
              baseBranch: 'main',
            },
            branchName: 'agent/test',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

        let resolveResumable!: (resumable: boolean) => void;
        mockSshWorkspaceService.supportsPersistentTerminalSessions.mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              resolveResumable = resolve;
            })
        );
        const send = vi.fn();
        const { BrowserWindow } = await import('electron');
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await vi.advanceTimersByTimeAsync(0);
        send.mockClear();

        const terminal = workspaceService.addTerminal('ssh-ws-1', 'Remote shell');
        expect(terminal.remoteSessionResumable).toBeUndefined();

        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.supportsPersistentTerminalSessions).toHaveBeenCalled()
        );
        send.mockImplementationOnce(() => {
          throw new Error('renderer unavailable');
        });
        resolveResumable(true);

        await vi.waitFor(() =>
          expect(send).toHaveBeenCalledWith(
            'workspace:updated',
            expect.objectContaining({
              id: 'ssh-ws-1',
              terminals: expect.arrayContaining([
                expect.objectContaining({
                  id: terminal.id,
                  remoteSessionResumable: true,
                }),
              ]),
            })
          )
        );
        await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      });

      it('launches an SSH terminal while the Komla data tunnel connects in the background', async () => {
        const existingWorkspaces = [
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'https://github.com/example/repo.git',
              projectName: 'Test Project',
              branchName: 'agent/test',
              baseBranch: 'main',
            },
            branchName: 'agent/test',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        let markPortReady: (() => void) | undefined;
        mockHttpServerService.waitForActualPort.mockReturnValueOnce(
          new Promise<number>((resolve) => {
            markPortReady = () => resolve(54184);
          })
        );
        let markReady: (() => void) | undefined;
        mockSshPortForwardService.ensureKomlaDataTunnel.mockReturnValueOnce(
          new Promise<void>((resolve) => {
            markReady = resolve;
          })
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const terminal = workspaceService.addTerminal('ssh-ws-1', 'Agent', 'npm test');
        expect(terminal).toEqual(expect.objectContaining({ status: 'starting' }));
        await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalledOnce());
        expect(mockSshPortForwardService.ensureKomlaDataTunnel).not.toHaveBeenCalled();
        markPortReady?.();
        await vi.waitFor(() =>
          expect(mockSshPortForwardService.ensureKomlaDataTunnel).toHaveBeenCalledWith(
            'ssh-dev',
            54184,
            expect.any(Function)
          )
        );
        markReady?.();
      });

      it('does not repeat workspace provisioning when opening additional SSH terminals', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          projectName: 'Test Project',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              branchName: 'agent/test',
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
              terminals: [],
            },
          ])
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        workspaceService.addTerminal('ssh-ws-1', 'First');
        workspaceService.addTerminal('ssh-ws-1', 'Second');

        await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalledTimes(2));
        expect(mockSshWorkspaceService.ensureWorkspaceReady).not.toHaveBeenCalled();
      });

      it('launches an SSH terminal when the Komla data tunnel is unavailable', async () => {
        const existingWorkspaces = [
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'https://github.com/example/repo.git',
              projectName: 'Test Project',
              branchName: 'agent/test',
              baseBranch: 'main',
            },
            branchName: 'agent/test',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        mockSshPortForwardService.ensureKomlaDataTunnel.mockRejectedValueOnce(
          new Error('forward unavailable')
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        workspaceService.addTerminal('ssh-ws-1', 'Agent', 'npm test');

        await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalledOnce());
        expect(workspaceService.get('ssh-ws-1')?.terminals).toHaveLength(1);
      });

      it('does not synchronize companion routing after the remote session is ready', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: null,
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const terminal = workspaceService.addTerminal('ssh-ws-1', 'Agent');
        await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalled());
        mockRemoteCompanionService.ensureRunning.mockClear();

        workspaceService.updateTerminalStatus(terminal.id, 'running');

        await vi.waitFor(() => expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalled());
        expect(mockRemoteCompanionService.ensureRunning.mock.calls.at(-1)?.[1]).not.toHaveProperty(
          'terminalIds'
        );
      });

      it('keeps a failed asynchronous SSH terminal visible and releases its quota slot', async () => {
        const existingWorkspaces = [
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'https://github.com/example/repo.git',
              projectName: 'Test Project',
              branchName: 'agent/test',
              baseBranch: 'main',
            },
            branchName: 'agent/test',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        mockSshWorkspaceService.supportsPersistentTerminalSessions
          .mockRejectedValueOnce(new Error('host unreachable'))
          .mockResolvedValueOnce(true);
        mockLicenseService.canStartWorkspace.mockImplementation((count: number) =>
          count === 0
            ? { allowed: true }
            : { allowed: false, reason: 'WORKSPACE_LIMIT: pending slot leaked' }
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const failedTerminal = workspaceService.addTerminal('ssh-ws-1', 'First agent', 'npm test');
        await vi.waitFor(() => expect(failedTerminal.status).toBe('stopped'));
        expect(failedTerminal.startupError).toBe('host unreachable');

        const secondTerminal = workspaceService.addTerminal('ssh-ws-1', 'Second agent', 'npm test');
        expect(secondTerminal).toEqual(expect.objectContaining({ name: 'Second agent' }));
        expect(mockLicenseService.canStartWorkspace).toHaveBeenLastCalledWith(0);
        expect(workspaceService.get('ssh-ws-1')?.terminals).toHaveLength(2);
      });

      it('syncs the Local copy before launching a Terminal Command', async () => {
        let finishSync: (() => void) | undefined;
        mockLocalMirrorService.prepare.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finishSync = () => resolve('/mock/home/.komla/mirrors/ssh-ws-1');
            })
        );
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              branchName: 'agent/test',
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockConfigService.get.mockReturnValue({
          defaultSshWorkspaceMode: 'local-mirror-actions',
        });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const terminal = await workspaceService.addTerminalWithPreparation(
          'ssh-ws-1',
          'Run app',
          'npm run dev',
          undefined,
          'host'
        );

        expect(mockLocalMirrorService.prepare).toHaveBeenCalledWith('ssh-ws-1', backend);
        expect(mockPtyService.spawn).not.toHaveBeenCalled();

        finishSync?.();
        await vi.waitFor(() =>
          expect(mockPtyService.spawn).toHaveBeenCalledWith(
            terminal.id,
            '/mock/home/.komla/mirrors/ssh-ws-1',
            'npm run dev'
          )
        );
        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).not.toHaveBeenCalled();
        expect(terminal.executionLocation).toBe('local-mirror');
      });

      it('keeps an explicitly remote command Action on the SSH host', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              branchName: 'agent/test',
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockConfigService.get.mockReturnValue({
          defaultSshWorkspaceMode: 'local-mirror-actions',
        });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const terminal = await workspaceService.addTerminalWithPreparation(
          'ssh-ws-1',
          'Run remotely',
          'npm run dev',
          undefined,
          'host',
          'remote'
        );

        expect(mockLocalMirrorService.initialize).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalled()
        );
        expect(terminal.executionLocation).toBe('workspace');
      });

      it('opens an explicit local mirror terminal before its sync starts', async () => {
        let finishInitialization: (() => void) | undefined;
        mockLocalMirrorService.initialize.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finishInitialization = () => resolve('/mock/home/.komla/mirrors/ssh-ws-1');
            })
        );
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              branchName: 'agent/test',
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockConfigService.get.mockReturnValue({
          defaultSshWorkspaceMode: 'local-mirror-actions',
        });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const terminal = await workspaceService.addTerminalWithPreparation(
          'ssh-ws-1',
          'Local mirror',
          null,
          undefined,
          'host-shell',
          'local-mirror'
        );

        expect(terminal.status).toBe('starting');
        expect(mockPtyService.spawn).not.toHaveBeenCalled();

        finishInitialization?.();
        await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
        expect(mockLocalMirrorService.ensureInitialSync).toHaveBeenCalledWith('ssh-ws-1', backend);
      });

      it('keeps a stopped terminal when its local copy folder cannot be initialized', async () => {
        mockLocalMirrorService.initialize.mockRejectedValueOnce(
          new Error('local copy folder is unavailable')
        );
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          branchName: 'agent/test',
          baseBranch: 'main',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              branchName: 'agent/test',
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockConfigService.get.mockReturnValue({
          defaultSshWorkspaceMode: 'local-mirror-actions',
        });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const terminal = await workspaceService.addTerminalWithPreparation(
          'ssh-ws-1',
          'Local mirror',
          null,
          undefined,
          'host-shell',
          'local-mirror'
        );

        await vi.waitFor(() => expect(terminal.status).toBe('stopped'));
        expect(terminal.startupError).toBe('local copy folder is unavailable');
        expect(mockPtyService.spawn).not.toHaveBeenCalled();
      });

      it('reconnects an SSH terminal as a plain remote shell when requested', async () => {
        const existingWorkspaces = [
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory:
              'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
              remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
              remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
              gitUrl: 'https://github.com/example/repo.git',
              projectName: 'Test Project',
              branchName: 'agent/swift-fox',
              baseBranch: 'main',
            },
            branchName: 'agent/swift-fox',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const terminal = await workspaceService.addTerminal('ssh-ws-1', 'Agent', 'npm test');
        mockSshWorkspaceService.buildTerminalLaunchCommand.mockClear();
        mockPtyService.restart.mockClear();

        await workspaceService.reconnectSshTerminal(terminal.id);

        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
          existingWorkspaces[0].backend,
          null,
          terminal.id,
          'ssh-ws-1',
          'reconnect',
          expect.objectContaining({ keepShellOpenAfterCommand: false })
        );
      });

      it('attaches a restored resumable session without refreshing remote capabilities', async () => {
        const existingWorkspaces = [
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'https://github.com/example/repo.git',
              projectName: 'Test Project',
            },
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'restored-terminal', name: 'Agent', createdAt: 1001 }],
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        mockPtyService.getStatus.mockReturnValue(undefined);
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const terminal = workspaceService.get('ssh-ws-1')!.terminals[0]!;
        mockPtyService.restart.mockClear();
        mockSshWorkspaceService.supportsPersistentTerminalSessions.mockClear();
        mockHttpServerService.waitForActualPort.mockReturnValueOnce(new Promise(() => {}));
        mockRemoteCompanionService.ensureRunning.mockClear();

        const result = workspaceService.reconnectSshTerminal(terminal.id);

        expect(result).toBe(terminal);
        expect(terminal.status).toBe('starting');
        expect(mockSshWorkspaceService.supportsPersistentTerminalSessions).not.toHaveBeenCalled();
        expect(mockPtyService.restart).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalled());
      });

      it('preserves remote activity when unknown reconnect preparation fails', async () => {
        const backend = {
          kind: 'ssh' as const,
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          projectName: 'Test Project',
        };
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws-1',
              name: 'Remote Workspace',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
              terminals: [
                {
                  id: 'restored-terminal',
                  name: 'Agent',
                  createdAt: 1001,
                  remoteSessionActive: true,
                  activeAgentSources: { codex: 1 },
                },
              ],
            },
          ])
        );
        mockPtyService.getStatus.mockReturnValue(undefined);
        mockSshWorkspaceService.supportsPersistentTerminalSessions.mockRejectedValueOnce(
          new Error('SSH host is offline')
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const terminal = workspaceService.get('ssh-ws-1')!.terminals[0]!;
        terminal.remoteSessionResumable = undefined;

        await expect(workspaceService.reconnectSshTerminal(terminal.id)).rejects.toThrow(
          'SSH host is offline'
        );

        expect(terminal).toEqual(
          expect.objectContaining({
            status: 'stopped',
            remoteSessionActive: true,
            agentActive: true,
          })
        );
        expect(workspaceService.get('ssh-ws-1')?.agentActive).toBe(true);
        expect(workspaceService.getRunningWorkspaceCount()).toBe(1);
        expect(mockPtyService.restart).not.toHaveBeenCalled();
      });

      it('deferred provisioning pins the preset on the placeholder so later resolution matches', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({ autoNameBranches: true });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Help me',
          deferBranchNaming: true,
        });

        expect(workspace.provisioning).toBe(true);
        expect(workspace.presetId).toBe('claude-code');
      });

      it('addAgentTab rolls back preset changes and phantom terminal when spawn fails', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
        });
        const originalPresetId = workspace.presetId;
        const originalTerminalCount = workspace.terminals.length;

        mockPtyService.spawn.mockImplementationOnce(() => {
          throw new Error('spawn failed');
        });

        expect(() =>
          workspaceService.addAgentTab(workspace.id, 'Help me', undefined, 'claude-code')
        ).toThrow('spawn failed');

        expect(workspace.presetId).toBe(originalPresetId);
        expect(workspace.terminals.length).toBe(originalTerminalCount);
      });
    });

    describe('preset usage recording', () => {
      it('should record preset usage on create', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockAgentPresetService.recordPresetUsage.mockClear();
        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          launchModeId: 'plan-mode',
        });

        expect(mockAgentPresetService.recordPresetUsage).toHaveBeenCalledWith(
          mockClaudePreset.id,
          'plan-mode',
          undefined
        );
      });

      it('applies, persists, and records the selected reasoning level', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockAgentPresetService.recordPresetUsage.mockClear();
        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          presetId: mockArgumentPreset.id,
          reasoningLevelId: 'high',
        });

        expect(workspace.reasoningLevelId).toBe('high');
        expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
          mockArgumentPreset,
          'open',
          undefined,
          undefined,
          undefined,
          'high'
        );
        expect(mockAgentPresetService.recordPresetUsage).toHaveBeenCalledWith(
          mockArgumentPreset.id,
          undefined,
          'high'
        );
      });

      it('drops reasoning levels the preset does not define', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          presetId: mockArgumentPreset.id,
          reasoningLevelId: 'removed',
        });

        expect(workspace.reasoningLevelId).toBeNull();
      });

      it('should not record preset usage when skipRecordUsage is true', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        mockAgentPresetService.recordPresetUsage.mockClear();
        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          launchModeId: 'plan-mode',
          skipRecordUsage: true,
        });

        expect(mockAgentPresetService.recordPresetUsage).not.toHaveBeenCalled();
      });
    });

    describe('license enforcement', () => {
      const sshParams = (branchName: string) => ({
        mode: 'worktree' as const,
        projectId: 'project-1',
        branchName,
        useExactBranchName: true,
        location: { kind: 'ssh' as const, hostId: 'ssh-dev' },
      });

      it('should allow workspace creation regardless of license status', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.getStatus.mockReturnValue({ isLicensed: false });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
        });

        expect(workspace).toBeDefined();
        expect(workspace.workingDirectory).toBe('/some/path');
      });

      it('should throw when creating workspace at running limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace.mockReturnValue({
          allowed: false,
          reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(workspaceService.create(sshParams('agent/remote'))).rejects.toThrow(
          'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces'
        );
        expect(mockTelemetryService.sendMonetizationEvent).toHaveBeenCalledWith('free_limit_hit', {
          source: 'create_workspace',
          limit: 4,
          runningCount: 0,
        });
      });

      it('should create, start and restart local workspaces without checking the limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace.mockReturnValue({
          allowed: false,
          reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const [workspace] = await workspaceService.createBatch([
          { mode: 'directory', directoryPath: '/some/path' },
        ]);
        await workspaceService.create({ mode: 'directory', directoryPath: '/other/path' });
        workspace.terminals = [];
        workspaceService.addTerminal(workspace.id, 'Terminal');
        workspace.terminals = [];
        workspaceService.restart(workspace.id);

        expect(mockLicenseService.canStartWorkspace).not.toHaveBeenCalled();
        expect(workspaceService.getRunningRemoteWorkspaceCount()).toBe(0);
      });

      it('should reserve slots only for the SSH members of a batch', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.create({ mode: 'directory', directoryPath: '/running/local' });

        await workspaceService.createBatch([
          { mode: 'directory', directoryPath: '/batch/local' },
          sshParams('agent/batch-remote'),
        ]);

        // Counting the local workspaces would have checked 1 + 2 - 1.
        expect(mockLicenseService.canStartWorkspace).toHaveBeenNthCalledWith(1, 0);
        expect(workspaceService.getRunningRemoteWorkspaceCount()).toBe(1);
      });

      it('should throw when adding terminal to stopped workspace at running limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace.mockReturnValue({ allowed: true });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create(sshParams('agent/remote'));

        // Remove all terminals to make workspace stopped
        workspace.terminals = [];

        // Now limit is reached
        mockLicenseService.canStartWorkspace.mockReturnValue({
          allowed: false,
          reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
        });

        expect(() => workspaceService.addTerminal(workspace.id, 'Terminal')).toThrow(
          'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces'
        );
        expect(mockTelemetryService.sendMonetizationEvent).toHaveBeenCalledWith('free_limit_hit', {
          source: 'start_workspace',
          limit: 4,
          runningCount: 0,
        });
      });

      it('starts a Local copy shell in a stopped SSH workspace at the limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create(sshParams('agent/remote'));
        workspace.terminals = [];
        mockLicenseService.canStartWorkspace.mockClear().mockReturnValue({
          allowed: false,
          reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
        });

        await workspaceService.addTerminal(
          workspace.id,
          'Local',
          null,
          undefined,
          'host-shell',
          'local-mirror'
        );

        // It runs on this computer, so it takes no SSH slot.
        expect(mockLicenseService.canStartWorkspace).not.toHaveBeenCalled();
        expect(workspace.terminals.map((terminal) => terminal.executionLocation)).toEqual([
          'local-mirror',
        ]);
        expect(workspaceService.getRunningRemoteWorkspaceCount()).toBe(0);
      });

      it('should allow adding terminal to already-running workspace at limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace.mockReturnValue({ allowed: true });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
        });

        // Workspace already has a running terminal from create
        expect(workspace.terminals.length).toBeGreaterThan(0);

        // Now limit is reached
        mockLicenseService.canStartWorkspace.mockReturnValue({
          allowed: false,
          reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
        });

        // Should succeed because workspace already has running terminals
        const terminal = workspaceService.addTerminal(workspace.id, 'Terminal 2');
        expect(terminal).toBeDefined();
        expect(terminal.name).toBe('Terminal 2');
      });

      it('should throw when restarting stopped workspace at running limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace.mockReturnValue({ allowed: true });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create(sshParams('agent/remote'));

        // Stop the workspace (clear terminals)
        workspace.terminals = [];

        // Now limit is reached
        mockLicenseService.canStartWorkspace.mockReturnValue({
          allowed: false,
          reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
        });

        expect(() => workspaceService.restart(workspace.id)).toThrow(
          'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces'
        );
      });

      it('should allow restarting already-running workspace at limit', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace.mockReturnValue({ allowed: true });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
        });

        // Workspace has running terminals from create
        expect(workspace.terminals.length).toBeGreaterThan(0);

        // Limit is reached — but this workspace is already counted
        mockLicenseService.canStartWorkspace.mockImplementation((count: number) => {
          if (count >= 4) {
            return { allowed: false, reason: 'WORKSPACE_LIMIT: limit reached' };
          }
          return { allowed: true };
        });

        // Should succeed because restart of a running workspace doesn't add to the count
        const terminal = workspaceService.restart(workspace.id);
        expect(terminal).toBeDefined();
      });

      it('should count provisioning workspaces against the workspace limit', async () => {
        const persistedWorkspaces = Array.from({ length: 4 }, (_, i) => ({
          id: `ws-provisioning-${i}`,
          name: `Provisioning ${i}`,
          workingDirectory: '',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: `/home/dev/worktree-${i}`,
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'git@example.com:repo.git',
          },
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000 + i,
          lastActivityAt: 2000 + i,
          order: i,
          provisioning: true,
          provisioningRepoPath: '/mock/repo',
        }));
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(persistedWorkspaces));
        mockLicenseService.canStartWorkspace.mockImplementation((count: number) => {
          if (count >= 4) {
            return {
              allowed: false,
              reason: 'WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces',
            };
          }
          return { allowed: true };
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            initialPrompt: 'Prompt 5',
            deferBranchNaming: true,
            location: { kind: 'ssh', hostId: 'ssh-dev' },
          })
        ).rejects.toThrow('WORKSPACE_LIMIT: Free plan is limited to 4 running workspaces');
      });

      it('should reject an entire batch when provisioning workspaces leave too few slots', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create(sshParams('agent/running-one'));
        await workspaceService.create(sshParams('agent/running-two'));
        mockSshWorkspaceService.ensureWorkspaceReady.mockReturnValue(new Promise(() => {}));
        const provisioning = await workspaceService.create({
          ...sshParams('agent/provisioning'),
          deferBranchNaming: true,
        });
        expect(provisioning.provisioning).toBe(true);

        mockLicenseService.canStartWorkspace.mockImplementation((count: number) =>
          count >= 4
            ? { allowed: false, reason: 'WORKSPACE_LIMIT: limit reached' }
            : { allowed: true }
        );

        await expect(
          workspaceService.createBatch([sshParams('agent/batch-one'), sshParams('agent/batch-two')])
        ).rejects.toThrow('WORKSPACE_LIMIT: limit reached');

        expect(workspaceService.list()).toHaveLength(3);
        expect(mockLicenseService.canStartWorkspace).toHaveBeenLastCalledWith(4);
      });

      it('should release a failed batch member reservation while siblings are pending', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        // Only the batch member on ssh-slow waits, here for its host's base path.
        let resolveBasePath!: (path: string) => void;
        const slowBasePath = new Promise<string>((resolve) => {
          resolveBasePath = resolve;
        });
        mockSshWorkspaceService.resolveWorkspaceBasePath.mockImplementation((hostId: string) =>
          hostId === 'ssh-slow' ? slowBasePath : Promise.resolve('/home/dev/.komla')
        );
        const stillRunning = {
          ...sshParams('agent/still-running'),
          location: { kind: 'ssh' as const, hostId: 'ssh-slow' },
        };
        mockLicenseService.canStartWorkspace.mockImplementation((count: number) =>
          count >= 2
            ? { allowed: false, reason: 'WORKSPACE_LIMIT: limit reached' }
            : { allowed: true }
        );

        let batchSettled = false;
        let batchError: unknown;
        const batchResult = workspaceService
          .createBatch([
            { ...sshParams('agent/invalid'), projectId: 'missing-project' },
            stillRunning,
          ])
          .then(
            () => {
              batchSettled = true;
            },
            (error) => {
              batchSettled = true;
              batchError = error;
            }
          );

        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }

        expect(batchSettled).toBe(false);
        const competingWorkspace = await workspaceService.create(sshParams('agent/competing'));
        expect(competingWorkspace.branchName).toBe('agent/competing');

        resolveBasePath('/home/dev/.komla');
        await batchResult;

        expect(batchError).toEqual(new Error('Project missing-project not found'));
        expect(workspaceService.list()).toHaveLength(2);
        await expect(workspaceService.create(sshParams('agent/after-batch'))).rejects.toThrow(
          'WORKSPACE_LIMIT: limit reached'
        );
      });

      it('should not double-count a completed batch member as still pending', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        // Only the batch member on ssh-slow waits, here for its host's base path.
        let resolveBasePath!: (path: string) => void;
        const slowBasePath = new Promise<string>((resolve) => {
          resolveBasePath = resolve;
        });
        mockSshWorkspaceService.resolveWorkspaceBasePath.mockImplementation((hostId: string) =>
          hostId === 'ssh-slow' ? slowBasePath : Promise.resolve('/home/dev/.komla')
        );
        const stillRunning = {
          ...sshParams('agent/still-running'),
          location: { kind: 'ssh' as const, hostId: 'ssh-slow' },
        };
        mockLicenseService.canStartWorkspace.mockImplementation((count: number) =>
          count >= 3
            ? { allowed: false, reason: 'WORKSPACE_LIMIT: limit reached' }
            : { allowed: true }
        );

        const batchResult = workspaceService.createBatch([
          sshParams('agent/complete'),
          stillRunning,
        ]);

        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }

        await expect(workspaceService.create(sshParams('agent/competing'))).resolves.toEqual(
          expect.objectContaining({ branchName: 'agent/competing' })
        );

        resolveBasePath('/home/dev/.komla');
        await expect(batchResult).resolves.toHaveLength(2);

        expect(workspaceService.list()).toHaveLength(3);
        await expect(workspaceService.create(sshParams('agent/after-batch'))).rejects.toThrow(
          'WORKSPACE_LIMIT: limit reached'
        );
      });
    });

    describe('ordering', () => {
      it('should insert new workspace at order 0 and shift others', async () => {
        const existingWorkspaces = [
          {
            id: 'ws-1',
            name: 'First',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
          {
            id: 'ws-2',
            name: 'Second',
            workingDirectory: '/ws2',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 1,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const newWorkspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/new',
        });

        expect(newWorkspace.order).toBe(0);
        expect(workspaceService.get('ws-1')?.order).toBe(1);
        expect(workspaceService.get('ws-2')?.order).toBe(2);
      });
    });

    describe('file watcher', () => {
      it('should start file watcher for new workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
        });

        expect(mockWorktreeWatcherService.startWatching).toHaveBeenCalledWith(
          workspace.id,
          '/some/path'
        );
      });
    });

    it('retries remote existing branches during immediate SSH creation', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
      mockSshWorkspaceService.ensureWorkspaceReady
        .mockRejectedValueOnce(createSshBranchAlreadyExistsError('agent/swift-fox'))
        .mockResolvedValueOnce(undefined);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'worktree',
        projectId: 'project-1',
        branchName: 'agent/swift-fox',
        useExactBranchName: true,
        autoResolveBranchConflicts: true,
        location: { kind: 'ssh', hostId: 'ssh-dev' },
      });

      expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledTimes(2);
      expect(workspace).toMatchObject({
        branchName: 'agent/swift-fox-1',
        workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox-1',
        backend: {
          branchName: 'agent/swift-fox-1',
          remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox-1',
        },
      });
    });

    it('does not persist an immediate SSH workspace when remote preparation fails', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-existing',
          name: 'Existing',
          workingDirectory: '/existing',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          status: 'active',
          terminals: [],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockSshWorkspaceService.ensureWorkspaceReady.mockRejectedValueOnce(
        new Error('SSH host is offline')
      );
      mockConfigService.get.mockReturnValue({ defaultSshWorkspaceMode: 'remote' });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(
        workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        })
      ).rejects.toThrow('SSH host is offline');
      await vi.advanceTimersByTimeAsync(600);

      expect(workspaceService.list()).toHaveLength(1);
      expect(workspaceService.get('ws-existing')?.order).toBe(0);
      expect(mockAgentPresetService.recordPresetUsage).not.toHaveBeenCalled();
      expect(JSON.parse(String(vfs.getFile('/mock/home/.komla/workspaces.json')))).toEqual(
        existingWorkspaces
      );
    });

    describe('prompt attachments', () => {
      it('copies attachments into the workspace and references them after the prompt', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          initialPrompt: 'Fix this',
          attachments: ['/tmp/shot.png', '/home/me/notes.pdf'],
        });

        expect(mockWorkspaceFileService.importExternalFileInto.mock.calls).toEqual([
          [expect.objectContaining({ workingDirectory: '/some/path' }), '/tmp/shot.png'],
          [expect.objectContaining({ workingDirectory: '/some/path' }), '/home/me/notes.pdf'],
        ]);
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'claude "Fix this\n\n@.komla-files/shot.png @.komla-files/notes.pdf"'
        );
      });

      it('prompts with the attachments alone when there is no text', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          attachments: ['/tmp/shot.png'],
        });

        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/some/path',
          'claude "@.komla-files/shot.png"'
        );
      });

      it('fails the launch when an attachment cannot be copied', async () => {
        mockWorkspaceFileService.importExternalFileInto.mockRejectedValueOnce(
          new Error('ENOENT: no such file')
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'directory',
            directoryPath: '/some/path',
            initialPrompt: 'Fix this',
            attachments: ['/tmp/shot.png'],
          })
        ).rejects.toThrow("Couldn't attach shot.png: ENOENT: no such file");
        expect(mockPtyService.spawn).not.toHaveBeenCalled();
        expect(workspaceService.list()).toEqual([]);
      });

      it.each([
        [
          'is gone',
          Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
          "Couldn't attach shot.png: it no longer exists",
        ],
        [
          'is a folder',
          { isFile: () => false, isDirectory: () => true },
          "Couldn't attach shot.png: it isn’t a file",
        ],
      ])(
        'creates nothing when an attachment %s before the launch',
        async (_case, statResult, message) => {
          const { stat } = await import('fs/promises');
          if (statResult instanceof Error) vi.mocked(stat).mockRejectedValueOnce(statResult);
          else vi.mocked(stat).mockResolvedValueOnce(statResult as never);
          const { workspaceService } = await import('../../../src/main/services/workspace.service');

          await expect(
            workspaceService.create({
              mode: 'worktree',
              projectId: 'project-1',
              initialPrompt: 'Fix login',
              attachments: ['/tmp/shot.png'],
              deferBranchNaming: true,
            })
          ).rejects.toThrow(message);
          expect(mockGitService.createWorktree).not.toHaveBeenCalled();
          expect(workspaceService.list()).toEqual([]);
        }
      );

      it('copies attachments once the deferred worktree exists', async () => {
        mockConfigService.get.mockReturnValue({ autoNameBranches: true });
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'Fix Login',
          branchName: 'fix-login',
        });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Fix login',
          attachments: ['/tmp/shot.png'],
          deferBranchNaming: true,
        });
        await vi.advanceTimersByTimeAsync(50000);

        expect(mockUtilityInferenceService.labelWorkspaceAndBranch).toHaveBeenCalledWith(
          'Fix login',
          expect.anything()
        );
        expect(mockWorkspaceFileService.importExternalFileInto).toHaveBeenCalledWith(
          expect.objectContaining({
            workingDirectory: '/mock/home/.komla/worktrees/project/agent-branch',
          }),
          '/tmp/shot.png'
        );
        expect(mockGitService.createWorktree.mock.invocationCallOrder[0]).toBeLessThan(
          mockWorkspaceFileService.importExternalFileInto.mock.invocationCallOrder[0]
        );
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/mock/home/.komla/worktrees/project/agent-branch',
          'claude "Fix login\n\n@.komla-files/shot.png"'
        );
      });

      it('shows a deferred workspace whose attachment cannot be copied as failed', async () => {
        mockWorkspaceFileService.importExternalFileInto.mockRejectedValueOnce(new Error('gone'));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/fix-login',
          useExactBranchName: true,
          initialPrompt: 'Fix login',
          attachments: ['/tmp/shot.png'],
          deferBranchNaming: true,
        });
        await vi.advanceTimersByTimeAsync(50000);

        expect(workspaceService.get(workspace.id)?.provisionError).toBe(
          "Couldn't attach shot.png: gone"
        );
        expect(mockPtyService.spawn).not.toHaveBeenCalled();
      });

      it('uploads attachments to the SSH host after the remote worktree is ready', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          initialPrompt: 'Fix login',
          attachments: ['/tmp/shot.png'],
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        await vi.waitFor(() =>
          expect(mockWorkspaceFileService.importExternalFileInto).toHaveBeenCalledWith(
            expect.objectContaining({ backend: expect.objectContaining({ kind: 'ssh' }) }),
            '/tmp/shot.png'
          )
        );
        const [readyOrder] = mockSshWorkspaceService.ensureWorkspaceReady.mock.invocationCallOrder;
        const { invocationCallOrder } = mockWorkspaceFileService.importExternalFileInto.mock;
        expect(readyOrder).toBeLessThan(invocationCallOrder[0]);
        await vi.waitFor(() =>
          expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
            mockClaudePreset,
            'prompt',
            undefined,
            'Fix login\n\n@.komla-files/shot.png',
            'posix',
            null
          )
        );
      });

      it('uploads attachments to the SSH host when the branch is named up front', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/remote',
          useExactBranchName: true,
          initialPrompt: 'Fix login',
          attachments: ['/tmp/shot.png'],
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(mockWorkspaceFileService.importExternalFileInto).toHaveBeenCalledWith(
          expect.objectContaining({ backend: expect.objectContaining({ kind: 'ssh' }) }),
          '/tmp/shot.png'
        );
        expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
          mockClaudePreset,
          'prompt',
          undefined,
          'Fix login\n\n@.komla-files/shot.png',
          'posix',
          null
        );
      });

      it('ignores attachments when no agent starts', async () => {
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'directory',
          directoryPath: '/some/path',
          initialCommand: 'npm install',
          attachments: ['/tmp/shot.png'],
        });

        expect(mockWorkspaceFileService.importExternalFileInto).not.toHaveBeenCalled();
      });
    });

    describe('deferred branch naming', () => {
      beforeEach(() => {
        mockConfigService.get.mockReturnValue({ autoNameBranches: true });
      });

      it('should return a provisioning workspace immediately', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Add login feature',
          deferBranchNaming: true,
        });

        expect(workspace.provisioning).toBe(true);
        expect(workspace.workingDirectory).toBe('');
        expect(workspace.branchName).toBeUndefined();
        expect(workspace.isWorktree).toBe(true);
        expect(workspace.terminals).toEqual([]);
      });

      it('safely fast-forwards the managed target during deferred provisioning', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const managedProject = createManagedProject({
          id: 'managed-1',
          baseBranch: 'main',
          defaultBranchPrefix: 'agent/',
        });
        mockProjectService.get.mockReturnValue(managedProject);
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'Add Login Feature',
          branchName: 'add-login-feature',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'managed-1',
          initialPrompt: 'Add login feature',
          deferBranchNaming: true,
        });
        await vi.advanceTimersByTimeAsync(50000);

        expect(mockGitService.fastForwardBranchToRemoteIfSafe).toHaveBeenCalledWith(
          managedProject.managedRepoPath,
          'main'
        );
        expect(
          mockGitService.fastForwardBranchToRemoteIfSafe.mock.invocationCallOrder[0]
        ).toBeLessThan(mockGitService.createWorktree.mock.invocationCallOrder[0]);
      });

      it('starts SSH host preparation while the branch name is still being generated', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockReturnValueOnce(
          new Promise(() => {})
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Add login feature',
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        const host = mockSshWorkspaceService.getHost.mock.results[0]?.value;
        expect(mockSshWorkspaceService.resolveWorkspaceBasePath).toHaveBeenCalledWith('ssh-dev');
        expect(mockSshWorkspaceService.warmConnections).toHaveBeenCalledWith(host);
        await vi.waitFor(() =>
          expect(mockRemoteCompanionService.detectPlatform).toHaveBeenCalledWith(host)
        );
        expect(mockSshWorkspaceService.ensureWorkspaceReady).not.toHaveBeenCalled();
      });

      it('checks the SSH host platform over the connection the base path lookup opens', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        let resolveBasePath!: (path: string) => void;
        mockSshWorkspaceService.resolveWorkspaceBasePath.mockReturnValueOnce(
          new Promise((resolve) => {
            resolveBasePath = resolve;
          })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockRemoteCompanionService.detectPlatform).not.toHaveBeenCalled();
        resolveBasePath('/home/dev/.komla');
        await vi.waitFor(() =>
          expect(mockRemoteCompanionService.detectPlatform).toHaveBeenCalledOnce()
        );
      });

      it('returns an SSH provisioning workspace before remote setup completes', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        let finishRemoteSetup!: () => void;
        mockSshWorkspaceService.ensureWorkspaceReady.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRemoteSetup = resolve;
            })
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(workspace.provisioning).toBe(true);
        expect(workspace.provisionStatus).toBeTruthy();
        expect(workspace.backend?.kind).toBe('ssh');
        expect(workspace.workingDirectory).toBe(
          'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox'
        );
        expect(workspace.terminals).toHaveLength(0);
        expect(mockSshWorkspaceService.createWorkspace).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledWith(
          expect.objectContaining({ hostId: 'ssh-dev', branchName: 'agent/swift-fox' }),
          expect.any(Function)
        );
        const companion = mockSshWorkspaceService.ensureWorkspaceReady.mock.calls[0]?.[1] as
          | (() => Promise<string | undefined>)
          | undefined;
        await expect(companion?.()).resolves.toBe('/home/dev/.komla/helpers/bin/komla');
        expect(mockRemoteCompanionService.ensureInstalled).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev' }),
          '/home/dev/.komla'
        );

        finishRemoteSetup();
        await vi.advanceTimersByTimeAsync(0);
        expect(workspaceService.get(workspace.id)?.provisioning).toBe(false);
        expect(workspaceService.get(workspace.id)?.terminals).toHaveLength(1);
        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenCalledWith(
          expect.objectContaining({
            hostId: 'ssh-dev',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'agent/swift-fox',
            resolvedBasePath: '/home/dev/.komla',
          })
        );
      });

      it('recovers an owned SSH worktree when creation finishes after workspace deletion', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        let finishRemoteSetup!: (result: {
          createdWorktree: boolean;
          createdBranch: boolean;
        }) => void;
        mockSshWorkspaceService.ensureWorkspaceReady.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRemoteSetup = resolve;
            })
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(finishRemoteSetup).toBeTypeOf('function');

        await workspaceService.delete(workspace.id);
        expect(workspaceService.get(workspace.id)).toBeUndefined();
        mockSshWorkspaceService.deleteWorkspace.mockClear();

        finishRemoteSetup({ createdWorktree: true, createdBranch: false });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledExactlyOnceWith(
          workspace.backend,
          false,
          'agent/swift-fox'
        );
        expect(workspaceService.get(workspace.id)).toBeUndefined();
        expect(workspace.terminals).toHaveLength(0);
      });

      it('cleans up remote state before discarding an SSH workspace that fails after setup', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace
          .mockReturnValueOnce({ allowed: true })
          .mockReturnValueOnce({ allowed: false, reason: 'terminal limit reached' });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledOnce();
        expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(
          workspace.backend,
          true,
          'agent/swift-fox'
        );
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('cleans up a remote worktree when persisting completed SSH setup fails', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const writeError = new Error('disk full');
        mockWriteFileAtomic.mockRejectedValueOnce(writeError);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledOnce();
        expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(
          workspace.backend,
          true,
          'agent/swift-fox'
        );
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('retains a failed SSH workspace when its remote cleanup fails', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockLicenseService.canStartWorkspace
          .mockReturnValueOnce({ allowed: true })
          .mockReturnValueOnce({ allowed: false, reason: 'terminal limit reached' });
        mockSshWorkspaceService.deleteWorkspace.mockRejectedValueOnce(new Error('host offline'));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(workspaceService.get(workspace.id)).toMatchObject({
          provisioning: false,
          provisionError: expect.stringContaining(
            'Remote cleanup also failed; delete this workspace to retry cleanup.'
          ),
        });
      });

      it('retries a colliding remote worktree path with a readable numeric suffix', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady
          .mockRejectedValueOnce(createSshWorktreePathConflictError())
          .mockResolvedValueOnce(undefined);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledTimes(2);
        expect(mockSshWorkspaceService.withRemoteDirectoryAttempt).toHaveBeenCalledWith(
          expect.objectContaining({
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
          }),
          2
        );
        expect(workspace.backend).toEqual(
          expect.objectContaining({
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox-2',
          })
        );
        expect(workspace.workingDirectory).toBe(
          'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox-2'
        );
      });

      it('does not retry an unrelated SSH error containing the setup command text', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady.mockRejectedValueOnce(
          new Error(
            'Command failed: ssh dev.example.com remote worktree path belongs to a different branch; permission denied'
          )
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledOnce();
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('reports remote Git authentication failures without retrying branch or folder names', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const authError = Object.assign(
          new Error(
            'The SSH host could not authenticate to the Git remote. Enable "Forward SSH agent" in this SSH host\'s settings, or configure Git credentials on the remote machine.'
          ),
          { code: 'SSH_GIT_AUTH_FAILED' }
        );
        mockSshWorkspaceService.ensureWorkspaceReady.mockRejectedValueOnce(authError);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          autoResolveBranchConflicts: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledOnce();
        expect(mockSshWorkspaceService.withRemoteDirectoryAttempt).not.toHaveBeenCalled();
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('retries a branch that already exists in the remote bare repo', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady
          .mockRejectedValueOnce(createSshBranchAlreadyExistsError('agent/swift-fox'))
          .mockResolvedValueOnce(undefined);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          autoResolveBranchConflicts: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        const updated = workspaceService.get(workspace.id);
        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledTimes(2);
        expect(updated).toMatchObject({
          branchName: 'agent/swift-fox-1',
          workingDirectory:
            'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox-1',
          provisioning: false,
          provisionError: undefined,
          backend: {
            branchName: 'agent/swift-fox-1',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox-1',
          },
        });
      });

      it('reports a remote existing branch when automatic resolution is disabled', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady.mockRejectedValueOnce(
          createSshBranchAlreadyExistsError('agent/swift-fox')
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledOnce();
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('reports the conflict source after exhausting remote branch candidates', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady.mockRejectedValue(
          createSshBranchAlreadyExistsError('conflict')
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          autoResolveBranchConflicts: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.ensureWorkspaceReady).toHaveBeenCalledTimes(25);
        expect(workspaceService.get(workspace.id)).toBeUndefined();
      });

      it('rejects duplicate SSH branches for URL-only sibling workspaces', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const params = {
          mode: 'worktree' as const,
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          location: {
            kind: 'ssh' as const,
            hostId: 'ssh-dev',
            gitUrl: 'https://github.com/example/repo.git',
          },
        };

        await workspaceService.create(params);

        await expect(workspaceService.create(params)).rejects.toThrow(
          'Branch "agent/swift-fox" is already open'
        );
        expect(workspaceService.list()).toHaveLength(1);
      });

      it('rejects SSH workspaces when the project has no cloneable remote URL', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.getRemoteUrl.mockResolvedValueOnce(null);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            branchName: 'agent/swift-fox',
            useExactBranchName: true,
            deferBranchNaming: true,
            location: { kind: 'ssh', hostId: 'ssh-dev' },
          })
        ).rejects.toMatchObject({
          message: 'SSH workspaces require a Git remote URL. Add a remote to this project.',
          detail: { projectId: 'project-1', branches: ['main'] },
        });

        expect(mockSshWorkspaceService.createWorkspacePlan).not.toHaveBeenCalled();
      });

      it('names the branches a remote needs for an SSH workspace from an existing branch', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockGitService.getRemoteUrl.mockResolvedValueOnce(null);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            branchName: 'feature/login',
            useExactBranchName: true,
            checkoutExistingBranch: true,
            baseBranch: 'origin/release',
            deferBranchNaming: true,
            location: { kind: 'ssh', hostId: 'ssh-dev' },
          })
        ).rejects.toMatchObject({
          detail: { projectId: 'project-1', branches: ['release', 'feature/login'] },
        });
      });

      it('rejects a blank Git URL without a project as a plain error', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.create({
            mode: 'worktree',
            branchName: 'agent/swift-fox',
            location: { kind: 'ssh', hostId: 'ssh-dev', gitUrl: '   ' },
          })
        ).rejects.toThrow('SSH workspaces require a Git remote URL.');
      });

      it('uses explicit SSH base branch as start point without changing the project target', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProject.baseBranch = 'main';

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'origin/release',
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project-1',
            baseBranch: 'main',
            startPoint: '0123456789abcdef',
          })
        );
        expect(mockGitService.resolvePublishedCommit).toHaveBeenCalledWith(
          '/mock/repo',
          'origin/release'
        );
        expect(workspace.baseBranch).toBe('main');
        expect(workspace.branchedFrom).toBe('origin/release');
      });

      it('normalizes a qualified SSH base branch when the project target is missing', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady.mockResolvedValueOnce({
          createdBranch: true,
          createdWorktree: true,
          defaultBranch: 'master',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'origin/release',
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(workspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'release',
          startPoint: 'origin/release',
          defaultBranch: 'master',
        });
        expect(workspace.baseBranch).toBe('release');
        expect(mockProjectService.update).not.toHaveBeenCalled();
        expect(mockProject.baseBranch).toBeUndefined();

        const updated = workspaceService.update(workspace.id, { baseBranch: undefined });
        expect(updated.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'master',
          defaultBranch: 'master',
        });
      });

      it('preserves a deferred explicit SSH base branch when another workspace resolves the remote default', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady
          .mockResolvedValueOnce({
            createdBranch: true,
            createdWorktree: true,
            baseBranch: 'master',
          })
          .mockResolvedValueOnce({
            createdBranch: true,
            createdWorktree: true,
            baseBranch: 'master',
          });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'origin/release',
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/second',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(workspace.baseBranch).toBe('release');
        expect(workspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'release',
          startPoint: 'origin/release',
        });
        expect(mockProjectService.update).not.toHaveBeenCalled();
        expect(mockProject.baseBranch).toBeUndefined();
      });

      it('preserves existing-branch checkout intent in the SSH workspace plan', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'feature/existing',
          useExactBranchName: true,
          checkoutExistingBranch: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenLastCalledWith(
          expect.objectContaining({
            branchName: 'feature/existing',
            checkoutExistingBranch: true,
          })
        );
      });

      it('stores the resolved remote default on the workspace without configuring the project', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady.mockResolvedValueOnce({
          createdBranch: true,
          createdWorktree: true,
          baseBranch: 'master',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(workspace.baseBranch).toBeUndefined();
        expect(workspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'master',
          defaultBranch: 'master',
        });
        expect(mockProjectService.update).not.toHaveBeenCalled();
        expect(mockProject.baseBranch).toBeUndefined();
        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenLastCalledWith(
          expect.objectContaining({
            projectId: 'project-1',
            baseBranch: undefined,
            startPoint: undefined,
          })
        );
        expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
        expect(mockGitService.resolvePublishedCommit).not.toHaveBeenCalled();
      });

      it('treats a legacy HEAD target as an unresolved remote default', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady.mockResolvedValueOnce({
          createdBranch: true,
          createdWorktree: true,
          baseBranch: 'main',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'HEAD',
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });

        expect(mockGitService.resolvePublishedCommit).not.toHaveBeenCalled();
        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenLastCalledWith(
          expect.objectContaining({ baseBranch: undefined, startPoint: undefined })
        );
        expect(workspace.baseBranch).toBeUndefined();
        expect(workspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'main',
          defaultBranch: 'main',
        });
      });

      it('resolves the current remote default independently for each workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockSshWorkspaceService.ensureWorkspaceReady
          .mockResolvedValueOnce({
            createdBranch: true,
            createdWorktree: true,
            baseBranch: 'main',
          })
          .mockResolvedValueOnce({
            createdBranch: true,
            createdWorktree: true,
            baseBranch: 'trunk',
          });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const firstWorkspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/first',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/second',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(firstWorkspace.baseBranch).toBeUndefined();
        expect(firstWorkspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'main',
          defaultBranch: 'main',
        });
        expect(workspace.baseBranch).toBeUndefined();
        expect(workspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'trunk',
          defaultBranch: 'trunk',
        });
        expect(mockProject.baseBranch).toBeUndefined();
        expect(mockProjectService.update).not.toHaveBeenCalled();
      });

      it('stores a sibling workspace remote default without changing its source or project', async () => {
        const sourceWorkspace = createWorktreeWorkspace({
          id: 'ssh-source',
          branchName: 'feature/source',
          projectId: 'project-1',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/feature-source',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/feature-source',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectId: 'project-1',
            projectName: 'Test Project',
            branchName: 'feature/source',
          },
        });
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([sourceWorkspace]));
        mockSshWorkspaceService.ensureWorkspaceReady.mockResolvedValueOnce({
          createdBranch: true,
          createdWorktree: true,
          baseBranch: 'master',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          sourceWorkspaceId: 'ssh-source',
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockProjectService.update).not.toHaveBeenCalled();
        expect(mockProject.baseBranch).toBeUndefined();
        expect(workspace.baseBranch).toBeUndefined();
        expect(workspace.backend).toMatchObject({
          kind: 'ssh',
          baseBranch: 'master',
          defaultBranch: 'master',
        });
        expect(workspaceService.get('ssh-source')?.backend.baseBranch).toBeUndefined();
      });

      it('lets the SSH host resolve the project target when creating a workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProject.baseBranch = 'main';

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenLastCalledWith(
          expect.objectContaining({
            projectId: 'project-1',
            baseBranch: 'main',
            startPoint: 'main',
          })
        );
        expect(mockGitService.resolvePublishedCommit).not.toHaveBeenCalled();
      });

      it('lets the SSH host resolve a branch when creating from an SSH workspace', async () => {
        const sourceWorkspace = createWorktreeWorkspace({
          id: 'ssh-source',
          branchName: 'feature/host-only',
          projectId: 'project-1',
          workingDirectory:
            'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/feature-host-only',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/feature-host-only',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectId: 'project-1',
            projectName: 'Test Project',
            branchName: 'feature/host-only',
          },
        });
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([sourceWorkspace]));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'feature/host-only',
          deferBranchNaming: true,
          sourceWorkspaceId: 'ssh-source',
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockGitService.resolvePublishedCommit).not.toHaveBeenCalled();
        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenLastCalledWith(
          expect.objectContaining({
            hostId: 'ssh-dev',
            startPoint: 'feature/host-only',
            sourceBackend: sourceWorkspace.backend,
          })
        );
      });

      it('leaves the SSH platform check to setup when creating from an SSH workspace', async () => {
        const sourceWorkspace = createWorktreeWorkspace({
          id: 'ssh-source',
          branchName: 'feature/host-only',
          projectId: 'project-1',
          workingDirectory:
            'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/feature-host-only',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/feature-host-only',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectId: 'project-1',
            projectName: 'Test Project',
            branchName: 'feature/host-only',
          },
        });
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([sourceWorkspace]));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'feature/host-only',
          deferBranchNaming: true,
          sourceWorkspaceId: 'ssh-source',
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        // No base path lookup opens a connection for the check to share.
        expect(mockSshWorkspaceService.resolveWorkspaceBasePath).not.toHaveBeenCalled();
        expect(mockRemoteCompanionService.detectPlatform).not.toHaveBeenCalled();
        expect(mockSshWorkspaceService.warmConnections).toHaveBeenCalledOnce();
      });

      it('surfaces an unpublished SSH start point and discards the provisioning workspace', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProject.baseBranch = 'main';
        mockGitService.resolvePublishedCommit.mockRejectedValueOnce(
          new Error(
            'Selected revision "feature/local" has not been pushed to origin. Push it before creating an SSH workspace.'
          )
        );
        const send = vi.fn();
        const { BrowserWindow } = await import('electron');
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'feature/local',
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(workspaceService.get(workspace.id)).toBeUndefined();
        expect(workspaceService.list()).toHaveLength(0);
        expect(send).toHaveBeenCalledWith(
          'workspace:updated',
          expect.objectContaining({
            id: workspace.id,
            provisionError: expect.stringContaining('has not been pushed to origin'),
          })
        );
        expect(send).toHaveBeenCalledWith('workspaces:changed');
      });

      it('leaves a base branch on the SSH host for the host to resolve', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockProject.baseBranch = 'main';

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'feature/on-host',
          baseBranchOnHost: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockGitService.resolvePublishedCommit).not.toHaveBeenCalled();
        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenCalledWith(
          expect.objectContaining({ baseBranch: 'main', startPoint: 'feature/on-host' })
        );
      });

      it("doesn't make a branch only the SSH host has the workspace's target", async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'agent/swift-fox',
          useExactBranchName: true,
          baseBranch: 'feature/on-host',
          baseBranchOnHost: true,
          deferBranchNaming: true,
          location: { kind: 'ssh', hostId: 'ssh-dev' },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(mockGitService.resolvePublishedCommit).not.toHaveBeenCalled();
        expect(mockSshWorkspaceService.createWorkspacePlan).toHaveBeenLastCalledWith(
          expect.objectContaining({ baseBranch: undefined, startPoint: 'feature/on-host' })
        );
        expect(workspaceService.get(workspace.id)?.baseBranch).not.toBe('feature/on-host');
      });

      it('should finish provisioning with combined title + branch from one AI call', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'Add Login Feature',
          description: 'Implement user login with OAuth',
          branchName: 'add-login-feature',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Add login feature',
          deferBranchNaming: true,
        });

        // Initially provisioning
        expect(workspace.provisioning).toBe(true);

        // Let the background provisioning complete
        await vi.advanceTimersByTimeAsync(50000);

        // After provisioning, workspace should have title, description, and branch
        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.workingDirectory).toBe('/mock/home/.komla/worktrees/project/agent-branch');
        expect(updated?.branchName).toBe('agent/add-login-feature');
        expect(updated?.customName).toBe('Add Login Feature');
        expect(updated?.customDescription).toBe('Implement user login with OAuth');
        expect(mockUtilityInferenceService.labelWorkspaceAndBranch).toHaveBeenCalledWith(
          'Add login feature',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(mockUtilityInferenceService.nameBranch).not.toHaveBeenCalled();
      });

      it('should normalize overlong combined titles before applying them', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: `  ${'A'.repeat(70)}  `,
          description: 'Implement user login with OAuth',
          branchName: 'add-login-feature',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Add login feature',
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.customName).toBe('A'.repeat(50));
      });

      it('should uppercase the first letter of combined utility-generated titles before applying them', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'auth token fix',
          description: 'Fix expired tokens not refreshing on API calls',
          branchName: 'fix-auth-token-refresh',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          projectPath: '/mock/project',
          initialPrompt: 'fix auth token refresh',
          agentName: 'claude',
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.customName).toBe('Auth token fix');
      });

      it('should preserve initialCommand in deferred provisioning', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'Add Login Feature',
          description: 'Implement user login with OAuth',
          branchName: 'add-login-feature',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Add login feature',
          initialCommand: 'echo boot',
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.primaryTerminalId).toBeDefined();
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          expect.any(String),
          '/mock/home/.komla/worktrees/project/agent-branch',
          'echo boot'
        );
      });

      it('should fall back to random name if AI returns null', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockRejectedValueOnce(
          new Error('utility failed')
        );
        mockUtilityInferenceService.nameBranch.mockRejectedValueOnce(new Error('utility failed'));
        mockGenerateBranchSuffix.mockReturnValue('random-fox');

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Some prompt',
          deferBranchNaming: true,
        });

        // Let provisioning complete
        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.branchName).toBe('agent/random-fox');
      });

      it('should fall back when combined naming returns null title', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: null,
          description: null,
          branchName: 'some-branch',
        });
        // The fallback auto-naming call also returns null (insufficient context)
        mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
          title: null,
          description: null,
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'hi',
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        // Title should not be set since both combined and fallback returned null
        expect(updated?.customName).toBeUndefined();
        // Branch should still be created via fallback (combined had a valid branchName
        // but was rejected due to null title, so branch-only naming is tried — but
        // the default nameBranch mock kicks in here)
        expect(updated?.branchName).toBeDefined();
      });

      it('should fall back when combined naming returns null branchName', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'Good Title',
          description: 'Good description',
          branchName: null,
        });
        mockUtilityInferenceService.nameBranch.mockResolvedValueOnce({
          branchName: 'fallback-branch',
        });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'do something',
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        // Combined failed due to null branch, so title from combined is lost
        expect(updated?.branchName).toBe('agent/fallback-branch');
      });

      it('should set provisionError on worktree creation failure', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockResolvedValueOnce({
          title: 'Good Branch',
          description: 'good branch description',
          branchName: 'good-branch',
        });
        mockGitService.createWorktree.mockRejectedValueOnce(new Error('disk full'));

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Some prompt',
          deferBranchNaming: true,
        });

        // Let provisioning complete
        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.provisionError).toBe('disk full');
      });

      it('should handle deletion during provisioning', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        let abortedSignal: AbortSignal | undefined;
        mockUtilityInferenceService.labelWorkspaceAndBranch.mockImplementationOnce(
          async (_prompt: string, options?: { signal?: AbortSignal }) => {
            abortedSignal = options?.signal;
            return new Promise((_, reject) => {
              options?.signal?.addEventListener('abort', () => reject(createAbortError()));
            });
          }
        );

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          initialPrompt: 'Some prompt',
          deferBranchNaming: true,
        });

        await Promise.resolve();

        // Delete before provisioning finishes
        await workspaceService.delete(workspace.id);

        const deleted = workspaceService.get(workspace.id);
        expect(deleted).toBeUndefined();
        expect(abortedSignal?.aborted).toBe(true);
      });

      it.each([
        { branchExisted: true, deleteBranch: false },
        { branchExisted: false, deleteBranch: true },
      ])(
        'deletes the branch on cancel only when provisioning created it (existed: $branchExisted)',
        async ({ branchExisted, deleteBranch }) => {
          vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
          mockConfigService.get.mockReturnValue({});
          let finishCreate!: (created: { path: string; createdBranch: boolean }) => void;
          mockGitService.createWorktree.mockImplementationOnce(
            () => new Promise((resolve) => (finishCreate = resolve))
          );

          const { workspaceService } = await import('../../../src/main/services/workspace.service');

          const workspace = await workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            branchName: 'feature/existing',
            useExactBranchName: true,
            deferBranchNaming: true,
          });
          await vi.waitFor(() => expect(mockGitService.createWorktree).toHaveBeenCalled());

          await workspaceService.delete(workspace.id, true, true);
          finishCreate({
            path: '/mock/home/.komla/worktrees/project/feature-existing',
            createdBranch: !branchExisted,
          });

          await vi.waitFor(() =>
            expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
              '/mock/repo',
              '/mock/home/.komla/worktrees/project/feature-existing',
              true,
              { deleteBranch, branchName: 'feature/existing' }
            )
          );
        }
      );

      it('should use provided branch name with prefix when deferring', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({});

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'my-feature',
          deferBranchNaming: true,
        });

        // Workspace returned immediately (provisioning may already be done since
        // provided branch names skip AI naming and createWorktree mock resolves instantly)
        expect(workspace.id).toBeDefined();
        expect(workspace.isWorktree).toBe(true);

        // Let any pending provisioning complete
        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.branchName).toBe('agent/my-feature');
        expect(updated?.workingDirectory).toBe('/mock/home/.komla/worktrees/project/agent-branch');
      });

      it('should use exact branch name when useExactBranchName is true', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({});

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'feature/login',
          useExactBranchName: true,
          deferBranchNaming: true,
        });

        expect(workspace.id).toBeDefined();

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.branchName).toBe('feature/login');
      });

      it('should skip AI naming when branch name is provided', async () => {
        vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
        mockConfigService.get.mockReturnValue({ autoNameBranches: true });

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'my-explicit-branch',
          initialPrompt: 'Some prompt that should not trigger AI naming',
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        // Should use provided branch, not AI-generated one
        expect(updated?.branchName).toBe('agent/my-explicit-branch');
        expect(mockUtilityInferenceService.labelWorkspaceAndBranch).not.toHaveBeenCalled();
        expect(mockUtilityInferenceService.nameBranch).not.toHaveBeenCalled();
      });

      it('should throw immediately when provided branch conflicts without autoResolve', async () => {
        // Create an existing workspace with the conflicting branch
        const existingWorkspaces = [
          {
            id: 'ws-existing',
            name: 'Existing',
            workingDirectory: '/existing',
            branchName: 'feature/login',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        mockConfigService.get.mockReturnValue({});

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        // Should throw before creating a placeholder — callers get an immediate error
        await expect(
          workspaceService.create({
            mode: 'worktree',
            projectId: 'project-1',
            branchName: 'feature/login',
            useExactBranchName: true,
            deferBranchNaming: true,
          })
        ).rejects.toThrow('already open in workspace');
      });

      it('should auto-resolve branch conflict when autoResolveBranchConflicts is true', async () => {
        // Create an existing workspace with the conflicting branch
        const existingWorkspaces = [
          {
            id: 'ws-existing',
            name: 'Existing',
            workingDirectory: '/existing',
            branchName: 'agent/my-feature',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        mockConfigService.get.mockReturnValue({});

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'my-feature',
          autoResolveBranchConflicts: true,
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.provisionError).toBeUndefined();
        // Should have resolved to a different branch name
        expect(updated?.branchName).toBeDefined();
        expect(updated?.branchName).not.toBe('agent/my-feature');
      });

      it('should preserve trailing digits in branch names on conflict resolution', async () => {
        // Branch name ends in digits (e.g. "release-2026") — these must NOT be stripped
        const existingWorkspaces = [
          {
            id: 'ws-existing',
            name: 'Existing',
            workingDirectory: '/existing',
            branchName: 'agent/release-2026',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ];
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
        mockConfigService.get.mockReturnValue({});

        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: 'project-1',
          branchName: 'release-2026',
          autoResolveBranchConflicts: true,
          deferBranchNaming: true,
        });

        await vi.advanceTimersByTimeAsync(50000);

        const updated = workspaceService.get(workspace.id);
        expect(updated?.provisioning).toBeFalsy();
        expect(updated?.provisionError).toBeUndefined();
        // Should append -1, not strip "2026" and produce "release-1"
        expect(updated?.branchName).toBe('agent/release-2026-1');
      });
    });
  });

  // ============================================================================
  // Terminal Management Tests
  // ============================================================================

  describe('addTerminal', () => {
    it('expands launch placeholders from the selected Codex preset for a workspace', async () => {
      const codexPreset = createClaudePreset({
        id: 'preset-codex',
        name: 'Codex',
        openCommand: 'codex --cd "{{workspacePath}}"',
      });
      mockAgentPresetService.get.mockImplementation((id: string) =>
        id === codexPreset.id ? codexPreset : undefined
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          createWorktreeWorkspace({
            id: 'ws-1',
            workingDirectory: '/workspace',
            isWorktree: false,
          }),
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addAgentTab('ws-1', undefined, undefined, codexPreset.id);

      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        expect.any(String),
        '/workspace',
        `codex --cd '${join('/workspace')}'`
      );
    });

    it('opens an agent that cannot start with a prompt instead of leaving a shell', async () => {
      const kimiPreset = createClaudePreset({
        id: 'preset-kimi',
        name: 'Kimi Code',
        openCommand: 'kimi',
        promptCommand: '',
      });
      mockAgentPresetService.get.mockImplementation((id: string) =>
        id === kimiPreset.id ? kimiPreset : undefined
      );
      mockAgentPresetService.getActive.mockReturnValue(kimiPreset);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          createWorktreeWorkspace({
            id: 'ws-1',
            workingDirectory: '/workspace',
            isWorktree: false,
          }),
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addAgentTab('ws-1', 'Fix the tests', undefined, kimiPreset.id);
      await workspaceService.create({
        mode: 'directory',
        directoryPath: '/some/path',
        initialPrompt: 'Fix the tests',
      });

      expect(mockPtyService.spawn).toHaveBeenCalledWith(expect.any(String), '/workspace', 'kimi');
      expect(mockPtyService.spawn).toHaveBeenCalledWith(expect.any(String), '/some/path', 'kimi');
    });

    it('passes auto-trust from the selected preset into the SSH login shell', async () => {
      const codexPreset = createClaudePreset({
        id: 'preset-codex',
        name: 'Antigravity CLI',
        openCommand: 'agy {{antigravityAutoTrustArgs}}',
      });
      mockAgentPresetService.get.mockImplementation((id: string) =>
        id === codexPreset.id ? codexPreset : undefined
      );
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/work tree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          createWorktreeWorkspace({
            id: 'ws-ssh',
            workingDirectory: 'ssh://ssh-dev/home/dev/work tree',
            backend,
            isWorktree: false,
          }),
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addAgentTab('ws-ssh', undefined, undefined, codexPreset.id);
      await vi.waitFor(() =>
        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalled()
      );

      expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
        backend,
        'agy --add-dir "$PWD"',
        expect.any(String),
        'ws-ssh',
        'start',
        expect.any(Object)
      );
    });

    it('should add a terminal to existing workspace', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1', 'npm test');

      expect(terminal.name).toBe('Terminal 1');
      expect(terminal.status).toBe('starting');
      expect(terminal.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(mockPtyService.spawn).toHaveBeenCalledWith(terminal.id, '/ws1', 'npm test');
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.addTerminal('non-existent', 'Terminal')).toThrow(
        'Workspace non-existent not found'
      );
    });

    it('should generate default terminal name if not provided', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal1 = workspaceService.addTerminal('ws-1');
      const terminal2 = workspaceService.addTerminal('ws-1');

      expect(terminal1.name).toMatch(/Terminal \d+/);
      expect(terminal2.name).toMatch(/Terminal \d+/);
      expect(terminal1.name).not.toBe(terminal2.name);
    });

    it('should add layoutHint when provided', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Split Terminal', null, 'split-right');

      expect(terminal.layoutHint).toBe('split-right');
    });

    it('should auto-activate trashed workspace on addTerminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          status: 'trashed',
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addTerminal('ws-1', 'Terminal 1');

      const workspace = workspaceService.get('ws-1');
      expect(workspace?.status).toBe('active');
      expect(mockWorktreeWatcherService.startWatching).toHaveBeenCalledWith('ws-1', '/ws1');
    });
  });

  describe('addAgentTab', () => {
    it('should add agent tab using open command when no prompt provided', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addAgentTab('ws-1');

      expect(terminal.name).toMatch(/Terminal \d+/);
      expect(terminal.status).toBe('starting');
      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        mockClaudePreset.openCommand
      );
    });

    it('should add agent tab with resolved prompt command', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addAgentTab('ws-1', 'Fix the bug');

      const expectedCommand = mockClaudePreset.promptCommand.replace(
        /\{\{prompt\}\}/g,
        '"Fix the bug"'
      );
      expect(mockPtyService.spawn).toHaveBeenCalledWith(terminal.id, '/ws1', expectedCommand);
    });

    it('resolves SSH project-setup guidance for the remote POSIX shell', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addAgentTab(
        'ssh-ws',
        'Fetch http://localhost:54183/skills/komla-project-setup-instructions.md.'
      );

      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenCalledWith(
        mockClaudePreset,
        'prompt',
        undefined,
        expect.stringContaining('komla skill project-setup'),
        'posix',
        undefined
      );
    });

    it('should fall back to the prompt command when the selected launch mode is empty', async () => {
      const emptyModePreset = createClaudePreset({
        id: 'preset-empty-mode',
        promptCommand: 'claude --prompt {{prompt}}',
        launchModes: [{ id: 'empty', name: 'Empty', command: '' }],
      });
      mockAgentPresetService.get.mockImplementation((id: string) =>
        id === emptyModePreset.id ? emptyModePreset : undefined
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addAgentTab(
        'ws-1',
        'Fix the bug',
        'empty',
        emptyModePreset.id
      );

      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        'claude --prompt "Fix the bug"'
      );
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.addAgentTab('non-existent')).toThrow(
        'Workspace non-existent not found'
      );
    });

    it('should update workspace preset when spawning with a different preset', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          presetId: 'old-preset',
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addAgentTab('ws-1');

      // The resolved preset is mockClaudePreset (id: 'claude-code'), which differs from 'old-preset'
      const workspace = workspaceService.get('ws-1');
      expect(workspace?.presetId).toBe(mockClaudePreset.id);
    });

    it("can run another agent without changing the workspace's agent or the last one used", async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            presetId: 'old-preset',
            launchModeId: 'old-mode',
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      mockAgentPresetService.recordPresetUsage.mockClear();

      const terminal = workspaceService.addAgentTab(
        'ws-1',
        'Set yourself up',
        undefined,
        mockClaudePreset.id,
        { keepWorkspaceAgent: true }
      );

      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        expect.stringContaining('Set yourself up')
      );
      expect(workspaceService.get('ws-1')).toMatchObject({
        presetId: 'old-preset',
        launchModeId: 'old-mode',
      });
      expect(mockAgentPresetService.recordPresetUsage).not.toHaveBeenCalled();
    });

    it('should not save when spawning with the same preset', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          presetId: mockClaudePreset.id,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      // Let the save that moves the folder into a folder project land first.
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      mockWriteFileAtomic.mockClear();
      workspaceService.addAgentTab('ws-1');

      // Advance past debounce
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      // No save should occur since preset didn't change
      expect(mockWriteFileAtomic).not.toHaveBeenCalled();
    });
  });

  describe('removeTerminal', () => {
    it('cancels a deferred SSH launch when its pane is removed', async () => {
      let finishPreparation!: () => void;
      mockSshWorkspaceService.supportsPersistentTerminalSessions.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishPreparation = () => resolve(true);
          })
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ssh-ws', 'Agent');
      await workspaceService.removeTerminal('ssh-ws', terminal.id);
      finishPreparation();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
      expect(mockPtyService.spawn).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([]);
    });

    it('removes a pre-launch SSH failure without contacting the unavailable host again', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ])
      );
      mockSshWorkspaceService.supportsPersistentTerminalSessions.mockRejectedValueOnce(
        new Error('host unreachable')
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ssh-ws', 'Agent');
      await vi.waitFor(() => expect(terminal.startupError).toBe('host unreachable'));
      await expect(workspaceService.removeTerminal('ssh-ws', terminal.id)).resolves.toBeUndefined();

      expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([]);
    });

    it('should remove terminal from workspace', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await workspaceService.removeTerminal('ws-1', terminal.id);

      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(0);
    });

    it('removes the right terminal when the list changes while it is released', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const [first, second, third, fourth] = ['A', 'B', 'C', 'D'].map((name) =>
        workspaceService.addTerminal('ws-1', name)
      );
      let release: () => void = () => undefined;
      mockPtyService.releaseTerminal.mockReturnValueOnce(
        new Promise<void>((resolve) => (release = resolve)) as never
      );

      const removing = workspaceService.removeTerminal('ws-1', second!.id);
      // E.g. session recovery dropping an ended terminal meanwhile.
      const workspace = workspaceService.get('ws-1')!;
      workspace.terminals = workspace.terminals.filter((terminal) => terminal.id !== first!.id);
      release();
      await removing;

      expect(workspaceService.get('ws-1')?.terminals.map((terminal) => terminal.id)).toEqual([
        third!.id,
        fourth!.id,
      ]);
    });

    it('should kill PTY when removing running terminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockPtyService.isRunning.mockReturnValue(true);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await workspaceService.removeTerminal('ws-1', terminal.id);

      expect(mockPtyService.releaseTerminal).toHaveBeenCalledWith(terminal.id);
    });

    it('should update primaryTerminalId when primary is removed', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal1 = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const terminal2 = workspaceService.addTerminal('ws-1', 'Terminal 2');

      const workspace = workspaceService.get('ws-1')!;
      workspace.primaryTerminalId = terminal1.id;

      await workspaceService.removeTerminal('ws-1', terminal1.id);

      expect(workspace.primaryTerminalId).toBe(terminal2.id);
    });

    it('should clear terminal-scoped attention and activity before removing terminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await hookTerminal(workspaceService, terminal.id, { kind: 'prompt-submit', source: 'codex' });
      await hookTerminal(workspaceService, terminal.id, {
        kind: 'input-required',
        source: 'codex',
      });

      await workspaceService.removeTerminal('ws-1', terminal.id);

      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(0);
      expect(workspace?.agentActive).toBe(false);
      expect(workspace?.attention).toBeUndefined();
      expect(workspace?.needsAttention).toBe(false);
    });

    it('should broadcast the workspace after removing a terminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');

      await workspaceService.removeTerminal('ws-1', terminal.id);

      expect(send).toHaveBeenCalledWith(
        'workspace:updated',
        expect.objectContaining({ id: 'ws-1', terminals: [] })
      );
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.removeTerminal('non-existent', 'term-1')).rejects.toThrow(
        'Workspace non-existent not found'
      );
    });

    it('should throw if terminal not found', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.removeTerminal('ws-1', 'non-existent')).rejects.toThrow(
        'Terminal non-existent not found in workspace ws-1'
      );
    });
  });

  describe('findWorkspaceByTerminalId', () => {
    it('should find workspace containing terminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const workspace = workspaceService.findWorkspaceByTerminalId(terminal.id);

      expect(workspace?.id).toBe('ws-1');
    });

    it('should return undefined if terminal not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = workspaceService.findWorkspaceByTerminalId('non-existent');

      expect(workspace).toBeUndefined();
    });
  });

  describe('getTerminal', () => {
    it('should get terminal by ID', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const addedTerminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const foundTerminal = workspaceService.getTerminal(addedTerminal.id);

      expect(foundTerminal?.id).toBe(addedTerminal.id);
      expect(foundTerminal?.name).toBe('Terminal 1');
    });

    it('should return undefined for non-existent terminal', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.getTerminal('non-existent');

      expect(terminal).toBeUndefined();
    });
  });

  describe('terminal-scoped agent state', () => {
    it('clears only the aborted terminal spinner', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal1 = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const terminal2 = workspaceService.addTerminal('ws-1', 'Terminal 2');
      await hookTerminal(workspaceService, terminal1.id, { kind: 'activity', source: 'codex' });
      await hookTerminal(workspaceService, terminal2.id, { kind: 'activity', source: 'codex' });

      const abortCallback = mockPtyService.onAbort.mock.calls[0]?.[0] as
        | ((terminalId: string) => void)
        | undefined;
      expect(abortCallback).toBeDefined();

      abortCallback?.(terminal1.id);

      expect(workspaceService.get('ws-1')?.agentActive).toBe(true);
      expect(terminal1.agentActive).toBe(false);
      expect(terminal2.agentActive).toBe(true);
      // A local tab has no other device to tell.
      expect(mockSshWorkspaceService.relayInterrupt).not.toHaveBeenCalled();
    });

    it("spins the Terminal whose Codex reports working in the Terminal's output", async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { emitTerminalProgramStatus } =
        await import('../../../src/main/lib/terminal-notification-events');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      emitTerminalProgramStatus(terminal.id, { app: 'codex', state: 'idle' });
      vi.advanceTimersByTime(60_000);

      emitTerminalProgramStatus(terminal.id, { app: 'codex', state: 'working' });

      expect(terminal.agentActive).toBe(true);
      expect(workspaceService.get('ws-1')?.agentActive).toBe(true);
    });

    it('holds back tool activity after an interrupt the title confirmed, until the title spins again', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      mockPtyService.onAbort.mockClear();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { emitTerminalTitle } =
        await import('../../../src/main/lib/terminal-notification-events');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const toolUse = { kind: 'activity', source: 'codex' } as const;
      const abortCallback = mockPtyService.onAbort.mock.calls.at(-1)?.[0] as (
        terminalId: string,
        confirmed: boolean
      ) => void;

      abortCallback(terminal.id, true);
      await hookTerminal(workspaceService, terminal.id, toolUse);
      expect(terminal.agentActive).toBeFalsy();

      emitTerminalTitle(terminal.id, '⠋ Fix tests');
      await hookTerminal(workspaceService, terminal.id, toolUse);
      expect(terminal.agentActive).toBe(true);
    });
  });

  // ============================================================================
  // Workspace Lifecycle Tests
  // ============================================================================

  describe('stop', () => {
    it('should stop all terminals in workspace', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockPtyService.isRunning.mockReturnValue(true);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal1 = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const terminal2 = workspaceService.addTerminal('ws-1', 'Terminal 2');

      await workspaceService.stop('ws-1');

      expect(mockPtyService.kill).toHaveBeenCalledWith(terminal1.id);
      expect(mockPtyService.kill).toHaveBeenCalledWith(terminal2.id);
    });

    it('keeps an SSH workspace active when remote session cleanup cannot be confirmed', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
            remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'https://github.com/example/repo.git',
            projectName: 'Project',
            branchName: 'branch',
            baseBranch: 'main',
            startPoint: 'main',
          },
          branchName: 'branch',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ssh-ws-1', 'Agent', 'claude');
      await vi.waitFor(() =>
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          terminal.id,
          expect.any(String),
          expect.any(String),
          [],
          undefined,
          undefined,
          0,
          undefined,
          undefined,
          expect.any(String),
          false
        )
      );
      mockPtyService.kill.mockClear();
      mockSshWorkspaceService.killTerminalSessions.mockRejectedValueOnce(new Error('offline'));

      await expect(workspaceService.stop('ssh-ws-1')).rejects.toThrow('workspace remains active');

      expect(mockPtyService.kill).not.toHaveBeenCalled();
      expect(terminal.status).not.toBe('stopped');
      expect(workspaceService.get('ssh-ws-1')?.lastStoppedAt).toBeUndefined();
    });

    it('does not retain a Terminal rejected during an in-flight SSH workspace stop', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const existingTerminal = workspaceService.addTerminal('ssh-ws-1', 'Agent');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      let finishRemoteStop!: () => void;
      mockSshWorkspaceService.killTerminalSessions.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoteStop = resolve;
          })
      );

      const stop = workspaceService.stop('ssh-ws-1');
      await vi.waitFor(() => expect(finishRemoteStop).toBeTypeOf('function'));

      expect(() => workspaceService.addTerminal('ssh-ws-1', 'Another Agent')).toThrow(
        'Managed remote workspace ssh-ws-1 is being stopped'
      );
      expect(workspaceService.get('ssh-ws-1')?.terminals).toEqual([existingTerminal]);

      finishRemoteStop();
      await stop;
    });

    it('should set terminal status to stopped', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockPtyService.isRunning.mockReturnValue(true);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await workspaceService.stop('ws-1');

      expect(terminal.status).toBe('stopped');
    });

    it('should record lastStoppedAt when workspace is stopped', async () => {
      vi.setSystemTime(12345);
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.stop('ws-1');
      const workspace = workspaceService.get('ws-1');

      expect(workspace?.lastStoppedAt).toBe(12345);
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.stop('non-existent')).rejects.toThrow(
        'Workspace non-existent not found'
      );
    });

    describe('stop steps', () => {
      function seedWorktree() {
        vfs.mock.mkdirSync('/mock/home/.komla/worktrees/project/feature');
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ws-1',
              name: 'Feature',
              workingDirectory: '/mock/home/.komla/worktrees/project/feature',
              branchName: 'agent/feature',
              isWorktree: true,
              projectId: 'project-1',
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
            },
          ])
        );
        mockProjectService.get.mockReturnValue(
          createProject({
            id: 'project-1',
            repositoryPath: '/mock/repo',
            setupSteps: [
              createBackgroundStep({
                name: 'Containers up',
                command: 'docker compose up -d',
              }),
              createBackgroundStep({
                name: 'Containers down',
                command: 'docker compose down',
                trigger: 'workspace-stop',
              }),
            ],
          })
        );
        mockPtyService.isRunning.mockReturnValue(true);
      }

      const spawnedCommands = () =>
        mockBackgroundProcessService.spawn.mock.calls.map((call) => call[1]);
      const finishSpawn = (command: string) =>
        mockBackgroundProcessService.spawn.mock.calls
          .find((call) => call[1] === command)?.[4]
          .onExit({ exitCode: 0, signal: 0 });

      it('run after a running workspace stops, and its next start waits for them', async () => {
        seedWorktree();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const terminal = workspaceService.addTerminal('ws-1', 'Agent');

        await workspaceService.stop('ws-1');
        expect(mockPtyService.kill).toHaveBeenCalledWith(terminal.id);
        expect(spawnedCommands()).toEqual(['docker compose down']);
        expect(workspaceService.stopStepsSettled('ws-1')).toBeDefined();

        const started = workspaceService.restart('ws-1');
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnedCommands()).toEqual(['docker compose down']);

        finishSpawn('docker compose down');
        await started;
        expect(spawnedCommands()).toEqual(['docker compose down', 'docker compose up -d']);
      });

      it('keep running when the workspace is stopped again, as moving it to the Trash does', async () => {
        seedWorktree();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        workspaceService.addTerminal('ws-1', 'Agent');
        await workspaceService.stop('ws-1');
        mockBackgroundProcessService.killForWorkspace.mockClear();

        let stoppedAgain = false;
        const again = workspaceService.stop('ws-1').then(() => (stoppedAgain = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(stoppedAgain).toBe(false);
        expect(mockBackgroundProcessService.killForWorkspace).not.toHaveBeenCalled();

        finishSpawn('docker compose down');
        await again;
        expect(spawnedCommands()).toEqual(['docker compose down']);
      });

      it("don't run when the workspace was already stopped", async () => {
        seedWorktree();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.stop('ws-1');

        expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
      });

      it('run once a running workspace being deleted has no terminals, before its worktree goes', async () => {
        seedWorktree();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const terminal = workspaceService.addTerminal('ws-1', 'Agent');

        const deleted = workspaceService.delete('ws-1', true);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnedCommands()).toEqual(['docker compose down']);
        expect(mockPtyService.releaseTerminalAndWait).toHaveBeenCalledWith(terminal.id);
        expect(mockPtyService.releaseTerminalAndWait.mock.invocationCallOrder[0]).toBeLessThan(
          mockBackgroundProcessService.spawn.mock.invocationCallOrder[0]
        );
        expect(mockGitService.deleteWorktree).not.toHaveBeenCalled();

        finishSpawn('docker compose down');
        await deleted;
        expect(mockGitService.deleteWorktree).toHaveBeenCalled();
      });

      it('run for a running local workspace at quit, for at most the time given', async () => {
        seedWorktree();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const terminal = workspaceService.addTerminal('ws-1', 'Agent');

        let done = false;
        const quitting = workspaceService.runStopStepsBeforeQuit(5_000).then(() => (done = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(mockPtyService.kill).toHaveBeenCalledWith(terminal.id);
        expect(spawnedCommands()).toEqual(['docker compose down']);

        await vi.advanceTimersByTimeAsync(4_999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await quitting;
      });
    });
  });

  describe('stopTerminal', () => {
    it('should stop a specific terminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockPtyService.isRunning.mockReturnValue(true);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await workspaceService.stopTerminal(terminal.id);

      expect(mockPtyService.kill).toHaveBeenCalledWith(terminal.id);
      expect(terminal.status).toBe('stopped');
    });

    it('should throw if terminal not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.stopTerminal('non-existent')).rejects.toThrow(
        'Terminal non-existent not found'
      );
    });

    it('marks remote observation stale when the final managed terminal stops', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      mockRemoteCompanionService.ensureRunning.mockResolvedValue({
        installationKey: 'install-key',
        tmuxSocket: 'komla-companion-install-key',
        sessionName: 'komla-companion-install-key',
        hookInbox: '/home/dev/.komla/helpers/companion/install-key/inbox',
      });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');
      const releaseAuthority = vi.spyOn(workspaceStatusService, 'change');
      const terminal = await workspaceService.addTerminal('ssh-ws', 'Agent', 'npm test');
      await vi.waitFor(() => expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalled());
      releaseAuthority.mockClear();

      await workspaceService.stopTerminal(terminal.id);

      await vi.waitFor(() =>
        expect(releaseAuthority).toHaveBeenCalledWith({
          kind: 'remote-source-unreachable',
          workspaceIds: ['ssh-ws'],
        })
      );
    });
  });

  describe('SSH workspace manifests', () => {
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/fix-login',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@example.com:acme/app.git',
      projectName: 'app',
    };
    const { hostId: _hostId, kind: _kind, ...portableBackend } = backend;
    const manifest = {
      schema: 1,
      workspaceId: 'ws-42',
      name: 'fix-login',
      branchName: 'fix-login',
      repoName: 'app',
      backend: portableBackend,
      terminals: [
        { id: 't1', name: 'Claude', createdAt: 1001 },
        { id: 't2', name: 'Codex', createdAt: 1002, layoutHint: 'split-right' },
      ],
      primaryTerminalId: 't1',
      terminalLayout: { activeTab: 't1', tabs: ['t1'], layouts: {} },
      createdAt: 1000,
      updatedAt: 5000,
    };
    const otherDevice = { writtenBy: 'other-device', syncs: true };

    /** The host copies this device saw before it restarted, the bases of its merges. */
    function savedOnHost(...manifests: Array<{ workspaceId: string }>) {
      vfs.setFile(
        '/mock/home/.komla/ssh-workspace-sync.json',
        JSON.stringify(Object.fromEntries(manifests.map((saved) => [saved.workspaceId, saved])))
      );
    }

    /** What the host lists and, read again before writing, holds for each workspace. */
    function onHost(...manifests: object[]) {
      const texts = manifests.map((candidate) => JSON.stringify(candidate));
      mockSshWorkspaceSyncHost.read.mockResolvedValue(texts);
      mockSshWorkspaceSyncHost.inspect.mockImplementation(async (_, workspaceId) => {
        const text = texts.find((candidate) => JSON.parse(candidate).workspaceId === workspaceId);
        return { state: 'present', ...(text ? { manifest: text } : {}) };
      });
    }

    function persistSshWorkspace() {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-42',
            name: 'fix-login',
            workingDirectory: `ssh://ssh-dev${backend.remoteDirectory}`,
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'active',
            terminals: [{ id: 't1', name: 'Claude', createdAt: 1001 }],
          },
        ])
      );
    }

    it('adopts a workspace published by another installation', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      mockSshWorkspaceSyncHost.read.mockResolvedValue([JSON.stringify(manifest)]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.sshSync.listOnHost('ssh-dev')).resolves.toEqual([
        expect.objectContaining({ workspaceId: 'ws-42', terminalCount: 2, adopted: false }),
      ]);
      const adopted = await workspaceService.sshSync.adopt('ssh-dev', 'ws-42');

      expect(adopted).toMatchObject({
        id: 'ws-42',
        projectId: null,
        workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/fix-login',
        backend: { ...backend },
        primaryTerminalId: 't1',
      });
      expect(adopted.terminals).toEqual([
        expect.objectContaining({ id: 't1', status: 'stopped', remoteSessionResumable: true }),
        expect.objectContaining({ id: 't2', layoutHint: 'split-right' }),
      ]);
      await expect(workspaceService.sshSync.listOnHost('ssh-dev')).resolves.toEqual([
        expect.objectContaining({ workspaceId: 'ws-42', adopted: true }),
      ]);
      await expect(workspaceService.sshSync.adopt('ssh-dev', 'ws-42')).resolves.toBe(adopted);
    });

    it('adds workspaces agents created on the host while Komla was disconnected', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      stored[0].projectId = 'project-1';
      stored[0].presetId = 'preset-claude';
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
      const offline = {
        ...manifest,
        workspaceId: 'ws-offline',
        name: 'Add Search',
        branchName: 'add-search',
        backend: {
          ...manifest.backend,
          remoteDirectory: '/home/dev/.komla/worktrees/app/add-search',
          branchName: 'add-search',
        },
        terminals: [{ id: 't-offline', name: 'Claude Code', createdAt: 3000 }],
        primaryTerminalId: 't-offline',
        terminalLayout: undefined,
        sourceWorkspaceId: 'ws-42',
        adoptOnConnect: true,
      };
      mockSshWorkspaceSyncHost.read.mockResolvedValue([
        JSON.stringify(manifest),
        JSON.stringify(offline),
      ]);
      let connected: (() => void) | undefined;
      mockSshPortForwardService.ensureKomlaDataTunnel.mockImplementation(
        (_hostId: string, _port: number, onConnected: () => void) => {
          connected = onConnected;
          return Promise.resolve();
        }
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addTerminal('ws-42', 'Agent', 'claude');
      await vi.waitFor(() => expect(connected).toBeDefined());
      connected?.();

      await vi.waitFor(() => expect(workspaceService.get('ws-offline')).toBeDefined());
      expect(workspaceService.get('ws-offline')).toMatchObject({
        projectId: 'project-1',
        presetId: 'preset-claude',
        branchName: 'add-search',
        primaryTerminalId: 't-offline',
      });
      expect(workspaceService.get('ws-offline')?.terminals).toEqual([
        expect.objectContaining({ id: 't-offline', remoteSessionResumable: true }),
      ]);
      // Rewriting the manifest from this installation clears the pending adoption.
      await vi.advanceTimersByTimeAsync(600);
      const rewrite = mockSshWorkspaceSyncHost.write.mock.calls.find(
        (call) => (call as unknown[])[1] === 'ws-offline'
      ) as unknown[] | undefined;
      expect(JSON.parse(String(rewrite?.[2]))).not.toHaveProperty('adoptOnConnect');
    });

    it('puts an adopted workspace in the local project for the same repository', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      mockGitService.getRemoteUrl.mockResolvedValue('https://example.com/acme/app');
      mockSshWorkspaceSyncHost.read.mockResolvedValue([JSON.stringify(manifest)]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const adopted = await workspaceService.sshSync.adopt('ssh-dev', 'ws-42');

      expect(adopted.projectId).toBe('project-1');
    });

    it('puts an adopted workspace with the project of another workspace on the same clone', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      stored[0].projectId = 'project-1';
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
      // The local project's origin no longer matches, but the host clone is the same.
      mockGitService.getRemoteUrl.mockResolvedValue('https://example.com/acme/renamed');
      mockSshWorkspaceSyncHost.read.mockResolvedValue([
        JSON.stringify({
          ...manifest,
          workspaceId: 'ws-43',
          backend: {
            ...manifest.backend,
            remoteDirectory: '/home/dev/.komla/worktrees/app/other',
          },
        }),
      ]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const adopted = await workspaceService.sshSync.adopt('ssh-dev', 'ws-43');

      expect(adopted.projectId).toBe('project-1');
    });

    it('moves SSH workspaces into a project once their repository is added here', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      mockGitService.getRemoteUrl.mockResolvedValue('ssh://git@example.com/acme/app.git');
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      mockProjectService.list.mockReturnValueOnce([]);
      await workspaceService.assignSshWorkspaceProjects();
      expect(workspaceService.get('ws-42')?.projectId).toBeNull();

      await workspaceService.assignSshWorkspaceProjects();
      expect(workspaceService.get('ws-42')?.projectId).toBe('project-1');
    });

    it('looks up the origin of each project once per session', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const lookups = () =>
        mockGitService.getRemoteUrl.mock.calls.filter(
          ([path]) => path === mockProject.repositoryPath
        ).length;

      await workspaceService.assignSshWorkspaceProjects();
      const first = lookups();
      await workspaceService.assignSshWorkspaceProjects();

      expect(first).toBe(1);
      expect(lookups()).toBe(1);
    });

    it('links an SSH workspace and others on the same clone to a chosen project', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      const sibling = {
        ...stored[0],
        id: 'ws-43',
        backend: { ...backend, remoteDirectory: '/home/dev/.komla/worktrees/app/other' },
      };
      const otherRepo = {
        ...stored[0],
        id: 'ws-44',
        backend: {
          ...backend,
          remoteDirectory: '/home/dev/.komla/worktrees/web/main',
          remoteRepoPath: '/home/dev/.komla/repos/web/repo.git',
          remoteProjectRoot: '/home/dev/.komla/worktrees/web',
        },
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([stored[0], sibling, otherRepo])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.linkSshWorkspaceToProject('ws-42', 'project-1');

      expect(workspaceService.get('ws-42')?.projectId).toBe('project-1');
      expect(workspaceService.get('ws-43')?.projectId).toBe('project-1');
      expect(workspaceService.get('ws-44')?.projectId).toBeNull();
      expect(() => workspaceService.linkSshWorkspaceToProject('ws-42', 'missing')).toThrow(
        'not found'
      );
    });

    const startedElsewhere = {
      ...manifest,
      workspaceId: 'ws-other',
      name: 'add-search',
      backend: { ...manifest.backend, remoteDirectory: '/home/dev/.komla/worktrees/app/search' },
      terminals: [{ id: 't-other', name: 'Claude', createdAt: 3000 }],
      primaryTerminalId: 't-other',
      terminalLayout: undefined,
      ...otherDevice,
    };

    it('adds every workspace other devices started on a host it syncs with', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      mockSshWorkspaceSyncHost.read.mockResolvedValue([JSON.stringify(startedElsewhere)]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-other')).toMatchObject({
        name: 'add-search',
        primaryTerminalId: 't-other',
        // The sidebar lists only a window's own workspaces, so one without a window stays hidden.
        windowId: 'main-window',
      });
    });

    it('puts a workspace from another device in the window holding most of its project', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      stored[0].projectId = 'project-1';
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
      onHost(manifest, startedElsewhere);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.moveWorkspaceToWindow('ws-42', 'second-window');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-other')).toMatchObject({
        projectId: 'project-1',
        windowId: 'second-window',
      });
    });

    it('puts a workspace from another device at the top of the manual order', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      onHost(manifest, startedElsewhere);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-other')?.order).toBe(0);
      expect(workspaceService.get('ws-42')?.order).toBe(1);
    });

    it('gives workspaces that share a position their own, keeping the order shown', async () => {
      persistSshWorkspace();
      const [stored] = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      const at = (id: string, order: number) => ({
        ...stored,
        id,
        order,
        backend: { ...backend, remoteDirectory: `/home/dev/.komla/worktrees/app/${id}` },
      });
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([stored, at('ws-43', 0), at('ws-44', 1)])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(['ws-42', 'ws-43', 'ws-44'].map((id) => workspaceService.get(id)?.order)).toEqual([
        0, 1, 2,
      ]);
    });

    it('dates a workspace from another device by when it last changed there, not when it arrived', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      onHost(startedElsewhere);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-other')?.lastActivityAt).toBe(startedElsewhere.updatedAt);
    });

    it('puts the newest of several workspaces from another device on top', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      const older = { ...startedElsewhere, workspaceId: 'ws-b', createdAt: 2000 };
      const newer = {
        ...startedElsewhere,
        workspaceId: 'ws-a',
        backend: { ...manifest.backend, remoteDirectory: '/home/dev/.komla/worktrees/app/newer' },
        terminals: [{ id: 't-newer', name: 'Claude', createdAt: 3000 }],
        primaryTerminalId: 't-newer',
        createdAt: 3000,
      };
      // Listed by id, as the host does.
      onHost(newer, older);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-a')?.order).toBe(0);
      expect(workspaceService.get('ws-b')?.order).toBe(1);
    });

    it('marks the tabs whose tmux session runs on the host without this device attached', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      onHost(manifest, startedElsewhere);
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['t-other']));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        ['t1', 't-other'],
        { background: true }
      );
      const [other] = workspaceService.get('ws-other')!.terminals;
      expect(other).toMatchObject({ remoteSessionOnHost: true });
      // Only what is shown changes: reconnecting and limits still go by what this device saw.
      expect(other?.remoteSessionActive).toBeUndefined();
      expect(workspaceService.get('ws-42')?.terminals[0]?.remoteSessionOnHost).toBe(false);
      expect(vfs.getFile('/mock/home/.komla/workspaces.json')).not.toContain('remoteSessionOnHost');
    });

    // Added before its agent's tmux session starts, it showed in the sidebar but counted as
    // active only once opened.
    it('shows a workspace another device started running once its session starts, unopened', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      onHost(startedElsewhere);
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({} as never);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      expect(showsRunning(workspaceService.get('ws-other'))).toBe(false);

      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['t-other']));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(showsRunning(workspaceService.get('ws-other'))).toBe(true);
    });

    it('does not check the host for tabs attached here', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      onHost(manifest);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.get('ws-42')!.terminals[0]!.status = 'running';

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(mockSshWorkspaceService.findTerminalSessions).not.toHaveBeenCalled();
    });

    it('tells the windows once about the tabs it marks', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      onHost(manifest, startedElsewhere);
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['t-other']));
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-other')?.terminals[0]?.remoteSessionOnHost).toBe(true);
      const channels = send.mock.calls.map(([channel]) => channel);
      expect(channels).not.toContain(IPC.WORKSPACE_UPDATED);
      // One for adding ws-other, one for both workspaces' tabs.
      expect(channels.filter((channel) => channel === IPC.WORKSPACES_CHANGED)).toHaveLength(2);
    });

    it('does not mark the tabs of a workspace whose files went missing while the host was checked', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      onHost(manifest);
      let answer!: (running: Set<string>) => void;
      mockSshWorkspaceService.findTerminalSessions.mockReturnValue(
        new Promise<Set<string>>((resolve) => (answer = resolve))
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const sync = workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.waitFor(() =>
        expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalled()
      );
      workspaceService.markSshWorkspaceRemoved('ws-42');
      answer(new Set(['t1']));
      await sync;

      expect(workspaceService.get('ws-42')?.terminals[0]?.remoteSessionOnHost).toBeUndefined();
    });

    it('forgets what it saw on the host for a workspace it no longer checks', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      onHost(manifest);
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['t1']));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      expect(workspaceService.get('ws-42')?.terminals[0]?.remoteSessionOnHost).toBe(true);

      workspaceService.markSshWorkspaceRemoved('ws-42');
      // Its files are gone, so checking again doesn't find it.
      mockSshWorkspaceSyncHost.inspect.mockResolvedValue({ state: 'missing' });
      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      // Otherwise it would show running, and stay observed, until restart.
      expect(workspaceService.get('ws-42')?.terminals[0]?.remoteSessionOnHost).toBeUndefined();
    });

    describe('a tab whose session is gone from its host', () => {
      /** This device's ws-42 with tab t1, and the host copy of it it last saw. */
      function persistWithHostCopy(lastSeen?: { remoteSessionActive: boolean }) {
        persistSshWorkspace();
        const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
        Object.assign(stored[0].terminals[0], lastSeen);
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
        const theirs = {
          ...manifest,
          terminals: [manifest.terminals[0]],
          terminalLayout: undefined,
          status: 'active',
          ...otherDevice,
        };
        savedOnHost(theirs);
        onHost(theirs);
      }

      function seen(workspace: Workspace) {
        return {
          runningHere: isRunningHere(workspace),
          showsRunning: showsRunning(workspace),
          reconnects: reconnectableTerminals(workspace).map((terminal) => terminal.id),
          ended: sessionEndedHere(workspace, workspace.terminals[0]!),
        };
      }

      const ended = { runningHere: false, showsRunning: false, reconnects: [], ended: true };

      it('ends a tab another device stopped after taking it over from here', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        // Attached here until another device attached with -d, so last seen running.
        persistWithHostCopy({ remoteSessionActive: true });
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        expect(isRunningHere(workspaceService.get('ws-42'))).toBe(true);

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

        expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
          expect.objectContaining({ hostId: 'ssh-dev' }),
          ['t1'],
          { background: true }
        );
        // Selecting it restarts the agent rather than reconnecting to a new, empty session.
        expect(seen(workspaceService.get('ws-42')!)).toEqual(ended);
      });

      it('ends a tab a sync saw running elsewhere once its session is gone', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistWithHostCopy();
        mockSshWorkspaceService.findTerminalSessions.mockResolvedValueOnce(new Set(['t1']));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        expect(showsRunning(workspaceService.get('ws-42'))).toBe(true);

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

        expect(seen(workspaceService.get('ws-42')!)).toEqual(ended);
      });

      it('keeps reconnecting a tab no check saw running, whose session may not have started', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistWithHostCopy();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

        expect(seen(workspaceService.get('ws-42')!)).toEqual({
          runningHere: false,
          showsRunning: false,
          reconnects: ['t1'],
          ended: false,
        });
      });

      it('waits for the next sync when a hook copy arrives while the host is read', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistWithHostCopy({ remoteSessionActive: true });
        let answer!: (running: Set<string>) => void;
        mockSshWorkspaceService.findTerminalSessions.mockReturnValue(
          new Promise<Set<string>>((resolve) => (answer = resolve))
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await hookTerminal(workspaceService, 't1', { kind: 'activity', source: 'claude-code' });

        const sync = workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalled()
        );
        // Another device restarted the agent after the host was read.
        await hookTerminal(workspaceService, 't1', {
          kind: 'activity',
          source: 'claude-code',
          copy: true,
        });
        answer(new Set());
        await sync;

        expect(seen(workspaceService.get('ws-42')!)).toEqual({
          runningHere: true,
          showsRunning: true,
          reconnects: ['t1'],
          ended: false,
        });
      });

      it('leaves a tab it could not end as it was until the next sync', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistWithHostCopy();
        mockSshWorkspaceService.findTerminalSessions.mockResolvedValueOnce(new Set(['t1']));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const { managedRemoteTerminalLifecycleService } =
          await import('../../../src/main/services/managed-remote-terminal-lifecycle.service');
        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        // This device's own view changed while the host was read, e.g. a recovery tracked it.
        vi.spyOn(managedRemoteTerminalLifecycleService, 'sessionGoneFromHost').mockReturnValue(
          false
        );

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

        // Not "missing", which no later sync would end.
        expect(showsRunning(workspaceService.get('ws-42'))).toBe(true);
      });

      it('saves once and tells the windows once for every tab it ends', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistWithHostCopy({ remoteSessionActive: true });
        const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
        stored[0].terminals.push({
          id: 't2',
          name: 'Codex',
          createdAt: 1002,
          remoteSessionActive: true,
        });
        vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
        const theirs = { ...manifest, terminalLayout: undefined, status: 'active', ...otherDevice };
        savedOnHost(theirs);
        onHost(theirs);
        const send = vi.fn();
        const { BrowserWindow } = await import('electron');
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        await vi.advanceTimersByTimeAsync(600);

        const workspace = workspaceService.get('ws-42')!;
        expect(
          workspace.terminals.map((terminal) => sessionEndedHere(workspace, terminal))
        ).toEqual([true, true]);
        const channels = send.mock.calls.map(([channel]) => channel);
        expect(channels).not.toContain(IPC.WORKSPACE_UPDATED);
        expect(channels.filter((channel) => channel === IPC.WORKSPACES_CHANGED)).toHaveLength(1);
        expect(workspaceFileWrites()).toHaveLength(1);
        const saved = JSON.parse(workspaceFileWrites()[0]![1]);
        expect(saved[0].terminals.map((entry: Terminal) => entry.remoteSessionActive)).toEqual([
          false,
          false,
        ]);
      });

      it('keeps a tab whose session ended while attached here saved and on its host', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        mockPtyService.onExit.mockClear();
        persistWithHostCopy();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        const workspace = workspaceService.get('ws-42')!;
        const terminal = workspace.terminals[0]!;
        terminal.status = 'running';

        // Another device stops the workspace, which ends the session attached here.
        const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (id: string) => void;
        exitHandler('t1');
        await vi.waitFor(() => expect(sessionEndedHere(workspace, terminal)).toBe(true));
        await vi.advanceTimersByTimeAsync(600);

        expect(isResumable(workspace, terminal)).toBe(true);
        const saved = JSON.parse(workspaceFileWrites().at(-1)![1]);
        expect(saved[0].terminals.map((entry: { id: string }) => entry.id)).toEqual(['t1']);
        // The host still lists the tab, so other devices keep it.
        expect(mockSshWorkspaceSyncHost.write).not.toHaveBeenCalled();
      });
    });

    it('applies tabs, renames and trashing another device made', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
      savedOnHost({
        ...manifest,
        terminals: [manifest.terminals[0]],
        status: 'active',
        ...otherDevice,
      });
      onHost({
        ...manifest,
        customName: 'Fix login (review)',
        customNameSource: 'manual',
        status: 'trashed',
        ...otherDevice,
      });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.waitFor(() => expect(workspaceService.get('ws-42')?.status).toBe('trashed'));

      const workspace = workspaceService.get('ws-42');
      expect(workspace).toMatchObject({
        customName: 'Fix login (review)',
        customNameSource: 'manual',
        status: 'trashed',
      });
      await vi.waitFor(() =>
        expect(mockLocalMirrorService.remove).toHaveBeenCalledWith('ws-42', expect.anything())
      );
      expect(workspace?.terminals.map((terminal) => terminal.id)).toEqual(['t1', 't2']);
      expect(send).toHaveBeenCalledWith(IPC.WORKSPACE_LAYOUT_CHANGED_ON_OTHER_DEVICE, {
        workspaceId: 'ws-42',
        terminalIds: ['t2'],
        arranged: false,
      });
      // Everything this device would write is already on the host.
      await vi.advanceTimersByTimeAsync(600);
      expect(mockSshWorkspaceSyncHost.write).not.toHaveBeenCalledWith(
        expect.anything(),
        'ws-42',
        expect.anything()
      );
    });

    it('publishes a rename made before a restart over the host copy saved then', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      stored[0].customName = 'Renamed offline';
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
      const theirs = {
        ...manifest,
        terminals: [manifest.terminals[0]],
        terminalLayout: undefined,
        ...otherDevice,
      };
      vfs.setFile('/mock/home/.komla/ssh-workspace-sync.json', JSON.stringify({ 'ws-42': theirs }));
      onHost(theirs);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.waitFor(() => expect(mockSshWorkspaceSyncHost.write).toHaveBeenCalled());

      expect(workspaceService.get('ws-42')?.customName).toBe('Renamed offline');
      expect(
        JSON.parse(String(mockSshWorkspaceSyncHost.write.mock.calls.at(-1)?.[2]))
      ).toMatchObject({ customName: 'Renamed offline' });
      await vi.waitFor(() =>
        expect(mockWriteFileAtomic).toHaveBeenCalledWith(
          join('/mock/home/.komla/ssh-workspace-sync.json'),
          expect.stringContaining('"customName":"Renamed offline"')
        )
      );
    });

    function persistWithSecondTab() {
      persistSshWorkspace();
      const stored = JSON.parse(vfs.getFile('/mock/home/.komla/workspaces.json')!);
      stored[0].terminals.push({ id: 't2', name: 'Codex', createdAt: 1002 });
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(stored));
      savedOnHost({ ...manifest, status: 'active', ...otherDevice });
      onHost({
        ...manifest,
        terminals: [manifest.terminals[0]],
        terminalLayout: undefined,
        ...otherDevice,
      });
    }

    it('drops a tab another device closed, even while attached, once tmux confirms it ended', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistWithSecondTab();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.get('ws-42')!.terminals[1]!.status = 'running';

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.waitFor(() =>
        expect(workspaceService.get('ws-42')?.terminals.map((terminal) => terminal.id)).toEqual([
          't1',
        ])
      );
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        ['t2']
      );
      expect(mockSshWorkspaceSyncHost.write).not.toHaveBeenCalled();
    });

    it('keeps a workspace another device trashed active while its agents cannot be stopped', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      savedOnHost({ ...manifest, status: 'active', ...otherDevice });
      onHost({ ...manifest, status: 'trashed', ...otherDevice });
      mockSshWorkspaceService.killTerminalSessions.mockRejectedValue(new Error('offline'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.advanceTimersByTimeAsync(600);
      expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalled();
      expect(workspaceService.get('ws-42')?.status).toBe('active');

      mockSshWorkspaceService.killTerminalSessions.mockResolvedValue(undefined);
      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await vi.waitFor(() => expect(workspaceService.get('ws-42')?.status).toBe('trashed'));
    });

    it('syncs again when the host connects during a sync that could not read it', async () => {
      let failRead: (error: Error) => void = () => undefined;
      mockSshWorkspaceSyncHost.read
        .mockImplementationOnce(() => new Promise<string[]>((_, reject) => (failRead = reject)))
        .mockResolvedValue([]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const first = workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      const afterConnect = workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      failRead(new Error('offline'));
      await first;
      await afterConnect;

      expect(mockSshWorkspaceSyncHost.read).toHaveBeenCalledTimes(2);
    });

    it('brings a removed host’s workspaces back when the host is added again', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      mockConfigService.get.mockReturnValue({ sshHosts: [{ id: 'ssh-dev', name: 'Devbox' }] });
      onHost({ ...manifest, ...otherDevice });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.deleteSshHost('ssh-dev');
      expect(workspaceService.get('ws-42')).toBeUndefined();
      await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });

      expect(workspaceService.get('ws-42')).toBeDefined();
    });

    it('does not add back the workspaces of a host removed while a sync read it', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      mockConfigService.get.mockReturnValue({ sshHosts: [{ id: 'ssh-dev', name: 'Devbox' }] });
      let list: (texts: string[]) => void = () => undefined;
      mockSshWorkspaceSyncHost.read.mockImplementationOnce(
        () => new Promise<string[]>((resolve) => (list = resolve))
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const sync = workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
      await workspaceService.deleteSshHost('ssh-dev');
      mockSshWorkspaceService.hasHost.mockReturnValue(false);
      list([JSON.stringify({ ...manifest, ...otherDevice })]);
      await sync;

      expect(workspaceService.get('ws-42')).toBeUndefined();
    });

    it('removes the manifest when an SSH workspace is deleted', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.delete('ws-42');

      expect(mockSshWorkspaceSyncHost.delete).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        'ws-42'
      );
    });

    it('marks a workspace removed when its files are gone from the host', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.markSshWorkspaceRemoved('ws-42');

      expect(workspaceService.get('ws-42')).toMatchObject({
        removedFromHost: true,
        provisionError: expect.stringContaining('no longer on its SSH host'),
      });
    });

    it('removes a workspace another device deleted without touching the host', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      mockSshWorkspaceSyncHost.inspect.mockResolvedValue({ state: 'deleted' });
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.update('ws-42', { customName: 'Fix login' });
      await vi.advanceTimersByTimeAsync(600);

      await vi.waitFor(() => expect(workspaceService.get('ws-42')).toBeUndefined());
      expect(mockSshWorkspaceService.deleteWorkspace).not.toHaveBeenCalled();
      expect(mockSshWorkspaceSyncHost.delete).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(IPC.WORKSPACE_REMOVED_ON_OTHER_DEVICE, {
        workspaceId: 'ws-42',
        name: 'Fix login',
      });
    });

    it('clears the mark once a missing workspace’s files are back', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.markSshWorkspaceRemoved('ws-42');
      workspaceService.markSshWorkspaceFound('ws-42');

      expect(workspaceService.get('ws-42')).toMatchObject({
        removedFromHost: undefined,
        provisionError: undefined,
      });
    });

    it('removes a workspace missing from its host from this device only', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.markSshWorkspaceRemoved('ws-42');

      await workspaceService.sshSync.removeMissing('ws-42');

      expect(workspaceService.get('ws-42')).toBeUndefined();
      expect(mockSshWorkspaceService.deleteWorkspace).not.toHaveBeenCalled();
      expect(mockSshWorkspaceSyncHost.delete).not.toHaveBeenCalled();
      expect(mockSshWorkspaceSyncHost.removeOrphaned).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        'ws-42'
      );
    });

    it('keeps the manifest when the workspace is only forgotten locally', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      persistSshWorkspace();
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.delete('ws-42', false, false, { skipBackendCleanup: true });

      expect(mockSshWorkspaceSyncHost.delete).not.toHaveBeenCalled();
    });

    describe('the spinner of an agent another device is attached to', () => {
      const companionPath = '/home/dev/.komla/helpers/bin/protocol-1/digest/komla';
      const abort = (terminalId: string) =>
        (mockPtyService.onAbort.mock.calls[0]?.[0] as (terminalId: string) => void)(terminalId);
      const savedSources = () =>
        JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)?.[1] as string)[0].terminals[0]
          .activeAgentSources;
      const working: AgentHook = { kind: 'activity', source: 'claude-code' };
      const copied: AgentHook = { ...working, copy: true };

      it('tells the other devices when the agent is interrupted here', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        mockRemoteCompanionService.installedPath.mockReturnValue(Promise.resolve(companionPath));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await hookTerminal(workspaceService, 't1', working);

        abort('t1');
        abort('t1');
        await vi.advanceTimersByTimeAsync(0);

        expect(workspaceService.get('ws-42')?.agentActive).toBe(false);
        // Esc also closes menus, so it's relayed only while the spinner is on.
        expect(mockSshWorkspaceService.relayInterrupt).toHaveBeenCalledTimes(1);
        expect(mockSshWorkspaceService.relayInterrupt).toHaveBeenCalledWith(
          expect.objectContaining({ hostId: 'ssh-dev' }),
          {
            executable: companionPath,
            hookInbox: '/home/dev/.komla/helpers/companion/deterministic-installation/inbox',
          },
          't1',
          ['claude-code']
        );
      });

      it('does not install a companion to relay an interrupt', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await hookTerminal(workspaceService, 't1', working);

        abort('t1');
        await vi.advanceTimersByTimeAsync(0);

        expect(workspaceService.get('ws-42')?.agentActive).toBe(false);
        expect(mockSshWorkspaceService.relayInterrupt).not.toHaveBeenCalled();
      });

      it('saves a spinner only while its own hooks keep it on', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        // Copies stop while this device is away, so a saved one could be stale on restart.
        await hookTerminal(workspaceService, 't1', copied);
        await workspaceService.persistSshAttention('ws-42');
        expect(savedSources()).toBeUndefined();

        await hookTerminal(workspaceService, 't1', working);
        await workspaceService.persistSshAttention('ws-42');
        expect(savedSources()).toEqual({ 'claude-code': 1 });
      });

      it('tells the other devices when the workspace is stopped here', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        mockRemoteCompanionService.installedPath.mockReturnValue(Promise.resolve(companionPath));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await hookTerminal(workspaceService, 't1', { kind: 'activity', source: 'codex' });

        await workspaceService.stop('ws-42');
        await vi.advanceTimersByTimeAsync(0);

        expect(mockSshWorkspaceService.relayInterrupt).toHaveBeenCalledWith(
          expect.objectContaining({ hostId: 'ssh-dev' }),
          expect.objectContaining({ executable: companionPath }),
          't1',
          ['codex']
        );
      });

      it('records a copied delivery without rewriting the workspace file right away', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await vi.advanceTimersByTimeAsync(1_000);
        const writes = workspaceFileWrites().length;

        workspaceService.recordCopiedHookDelivery('ws-42', { terminalId: 't1', deliveryId: 'd1' });

        expect(workspaceService.hasAcceptedTerminalHook('t1', 'd1')).toBe(true);
        expect(workspaceFileWrites()).toHaveLength(writes);
        await vi.advanceTimersByTimeAsync(600);
        expect(workspaceFileWrites()).toHaveLength(writes + 1);
      });

      it('keeps a spinner that a copy turned on while the host was checked', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        onHost(manifest);
        let answer!: (running: Set<string>) => void;
        mockSshWorkspaceService.findTerminalSessions.mockReturnValue(
          new Promise((resolve) => (answer = resolve))
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const sync = workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        await vi.waitFor(() =>
          expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalled()
        );
        await hookTerminal(workspaceService, 't1', copied);
        answer(new Set());
        await sync;
        await vi.advanceTimersByTimeAsync(600);

        expect(workspaceService.get('ws-42')?.agentActive).toBe(true);
      });

      it('stops the spinner of a tab whose session is gone from the host', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        onHost(manifest);
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await hookTerminal(workspaceService, 't1', copied);

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalled();
        expect(workspaceService.get('ws-42')?.agentActive).toBe(false);
      });

      it('keeps the spinner of a tab whose session runs on the host', async () => {
        mockPtyService.getStatus.mockReturnValue(undefined);
        persistSshWorkspace();
        onHost(manifest);
        mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['t1']));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await hookTerminal(workspaceService, 't1', copied);

        await workspaceService.sshSync.syncSoon('ssh-dev', { now: true });
        await vi.advanceTimersByTimeAsync(600);

        expect(workspaceService.get('ws-42')?.agentActive).toBe(true);
      });
    });
  });

  describe('recoverSshSessions', () => {
    it('restores SSH mailbox observation at startup without attaching or probing terminals', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      const backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'configured-ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'active',
            terminals: [
              {
                id: 'configured-term-live',
                name: 'Agent',
                createdAt: 1001,
                remoteSessionActive: true,
              },
            ],
          },
          {
            id: 'missing-ssh-ws',
            name: 'Removed host',
            workingDirectory: 'ssh://missing-host/home/dev/worktree',
            backend: { ...backend, hostId: 'missing-host' },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 1,
            status: 'active',
            terminals: [
              {
                id: 'missing-term-live',
                name: 'Agent',
                createdAt: 1001,
                remoteSessionActive: true,
              },
            ],
          },
        ])
      );
      mockSshWorkspaceService.hasHost.mockImplementation((hostId) => hostId !== 'missing-host');
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.reconcilePersistedSshSessions();

      expect(mockSshWorkspaceService.findTerminalSessions).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.supportsPersistentTerminalSessions).not.toHaveBeenCalled();
      expect(workspaceService.getRunningWorkspaceCount()).toBe(1);
      expect(workspaceService.get('missing-ssh-ws')).toEqual(
        expect.objectContaining({
          provisionError: 'This workspace’s SSH host is no longer configured.',
          terminals: [expect.objectContaining({ status: 'stopped', remoteSessionActive: false })],
        })
      );
      await vi.waitFor(() =>
        expect(mockSshPortForwardService.ensureKomlaDataTunnel).toHaveBeenCalledWith(
          'ssh-dev',
          54183,
          expect.any(Function)
        )
      );
      await vi.waitFor(() =>
        expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            workspaces: [expect.objectContaining({ workspaceId: 'configured-ssh-ws' })],
          })
        )
      );
      expect(mockSshWorkspaceService.findTerminalSessions).not.toHaveBeenCalled();
      expect(mockPtyService.spawn).not.toHaveBeenCalled();
    });

    it('marks an inactive SSH workspace unavailable when its host was removed', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      mockSshWorkspaceService.hasHost.mockReturnValue(false);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://missing-host/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'missing-host',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'trashed',
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.recoverSshSessions('ssh-ws');

      expect(mockSshWorkspaceService.findTerminalSessions).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws')).toEqual(
        expect.objectContaining({
          provisionError: 'This workspace’s SSH host is no longer configured.',
          terminals: [expect.objectContaining({ status: 'stopped', remoteSessionActive: false })],
        })
      );
    });

    it('marks only confirmed exact tmux sessions as remotely active', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      const backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'active',
            primaryTerminalId: 'term-ended',
            terminals: [
              {
                id: 'term-live',
                name: 'Agent',
                createdAt: 1001,
                remoteSessionActive: true,
              },
              {
                id: 'term-ended',
                name: 'Shell',
                createdAt: 1002,
                remoteSessionActive: true,
              },
            ],
            terminalLayout: {
              tabs: ['term-ended', 'term-live'],
              layouts: {
                'term-ended': {
                  type: 'leaf',
                  id: 'pane-ended',
                  terminalId: 'term-ended',
                },
                'term-live': { type: 'leaf', id: 'pane-live', terminalId: 'term-live' },
              },
            },
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['term-live']));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.recoverSshSessions('ssh-ws');

      expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
        expect.objectContaining(backend),
        ['term-live', 'term-ended']
      );
      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([
        expect.objectContaining({
          id: 'term-live',
          status: 'stopped',
          remoteSessionActive: true,
          remoteSessionResumable: true,
        }),
      ]);
      expect(workspaceService.get('ssh-ws')?.primaryTerminalId).toBe('term-live');
      expect(workspaceService.get('ssh-ws')?.terminalLayout).toEqual({
        tabs: ['term-live'],
        layouts: {
          'term-live': { type: 'leaf', id: 'pane-live', terminalId: 'term-live' },
        },
      });
      expect(workspaceService.getRunningWorkspaceCount()).toBe(1);
      await vi.waitFor(() =>
        expect(mockSshPortForwardService.ensureKomlaDataTunnel).toHaveBeenCalledWith(
          'ssh-dev',
          54183,
          expect.any(Function)
        )
      );
      await vi.waitFor(() =>
        expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            workspaces: [expect.objectContaining({ workspaceId: 'ssh-ws' })],
          })
        )
      );

      await workspaceService.recoverSshSessions('ssh-ws');
      // Opening it also syncs the host, whose check for sessions runs in the background.
      const recoveryChecks = mockSshWorkspaceService.findTerminalSessions.mock.calls.filter(
        (call) => !(call as unknown[])[2]
      );
      expect(recoveryChecks).toHaveLength(1);
    });

    it('clears restored terminal activity when its managed session has ended', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'active',
            terminals: [
              {
                id: 'term-ended',
                name: 'Agent',
                createdAt: 1001,
                remoteSessionActive: true,
                activeAgentSources: { codex: 1 },
              },
            ],
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set());
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ssh-ws')?.agentActive).toBe(true);
      await workspaceService.recoverSshSessions('ssh-ws');

      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([]);
      expect(workspaceService.get('ssh-ws')?.agentActive).toBe(false);
    });

    it('leaves recovery state unknown when the SSH host is unreachable', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockRejectedValue(new Error('offline'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.recoverSshSessions('ssh-ws')).rejects.toThrow('offline');

      expect(workspaceService.get('ssh-ws')?.terminals[0]?.remoteSessionActive).toBeUndefined();
    });

    it('does not let late selection recovery overwrite a terminal changed meanwhile', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'active',
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      let finishProbe: ((sessions: Set<string>) => void) | undefined;
      mockSshWorkspaceService.findTerminalSessions.mockReturnValue(
        new Promise((resolve) => {
          finishProbe = resolve;
        })
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const recovery = workspaceService.recoverSshSessions('ssh-ws');
      workspaceService.updateTerminalStatus('term-live', 'running');
      finishProbe?.(new Set());
      await recovery;

      expect(workspaceService.get('ssh-ws')?.terminals[0]).toEqual(
        expect.objectContaining({ status: 'running', remoteSessionActive: undefined })
      );
      expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalled();
    });

    it('returns the live PTY status when recovering an already-recovered SSH workspace', async () => {
      mockPtyService.getStatus.mockReturnValue(undefined);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 2000,
            order: 0,
            status: 'active',
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['term-live']));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.recoverSshSessions('ssh-ws');
      mockPtyService.restart.mockImplementationOnce((terminalId: string) => {
        mockPtyStatusListener?.(terminalId, 'stopped');
        mockPtyStatusListener?.(terminalId, 'starting');
      });
      await workspaceService.reconnectSshTerminal('term-live');

      expect((await workspaceService.recoverSshSessions('ssh-ws'))?.terminals[0]?.status).toBe(
        'starting'
      );

      mockPtyStatusListener?.('term-live', 'running');

      const recovered = await workspaceService.recoverSshSessions('ssh-ws');

      expect(recovered?.terminals[0]?.status).toBe('running');
    });
  });

  describe('restartTerminal', () => {
    it('replaces the terminal PTY with the active agent command', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      mockPtyService.restart.mockClear();

      const restarted = workspaceService.restartTerminal(terminal.id);

      expect(restarted).toBe(terminal);
      expect(terminal.status).toBe('starting');
      expect(terminal.dynamicTitle).toBeUndefined();
      expect(mockPtyService.restart).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        mockClaudePreset.openCommand,
        'ws-1',
        undefined,
        undefined
      );
    });

    it('uses the active preset when the workspace preset no longer exists', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            presetId: 'deleted-preset',
            launchModeId: 'deleted-mode',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      mockPtyService.restart.mockClear();

      workspaceService.restartTerminal(terminal.id);

      expect(mockPtyService.restart).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        mockClaudePreset.openCommand,
        'ws-1',
        undefined,
        undefined
      );
      expect(workspaceService.get('ws-1')).toEqual(
        expect.objectContaining({ presetId: mockClaudePreset.id, launchModeId: null })
      );
    });

    it('uses the selected preset launch mode when provided', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      mockPtyService.restart.mockClear();

      workspaceService.restartTerminal(terminal.id, mockPlanPreset.id, 'plan');

      expect(mockPtyService.restart).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        'claude --plan',
        'ws-1',
        undefined,
        undefined
      );
      expect(mockAgentPresetService.recordPresetUsage).toHaveBeenCalledWith(
        mockPlanPreset.id,
        'plan'
      );
      expect(workspaceService.get('ws-1')?.presetId).toBe(mockPlanPreset.id);
    });

    it('forwards the terminal dimensions so the PTY is born at the right size', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      mockPtyService.restart.mockClear();

      workspaceService.restartTerminal(terminal.id, mockPlanPreset.id, 'plan', 95, 42);

      expect(mockPtyService.restart).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        'claude --plan',
        'ws-1',
        95,
        42
      );
    });

    it('restarts the existing terminal with an explicit host command', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      mockPtyService.restart.mockClear();

      workspaceService.restartTerminal(terminal.id, undefined, undefined, 95, 42, {
        command: 'npm run dev',
        commandKind: 'host',
      });

      expect(mockPtyService.restart).toHaveBeenCalledWith(
        terminal.id,
        '/ws1',
        'npm run dev',
        'ws-1',
        95,
        42
      );
      expect(mockAgentPresetService.recordPresetUsage).not.toHaveBeenCalled();
    });

    it('clears terminal activity and attention before replacing its PTY', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await hookTerminal(workspaceService, terminal.id, { kind: 'prompt-submit', source: 'codex' });
      await hookTerminal(workspaceService, terminal.id, {
        kind: 'input-required',
        source: 'codex',
      });

      workspaceService.restartTerminal(terminal.id, undefined, undefined, undefined, undefined, {
        command: 'npm run dev',
        commandKind: 'host',
      });

      expect(terminal.agentActive).toBe(false);
      expect(workspaceService.get('ws-1')?.agentActive).toBe(false);
      expect(terminal.attention).toBeUndefined();
      expect(workspaceService.get('ws-1')?.attention).toBeUndefined();
      expect(workspaceService.get('ws-1')?.needsAttention).toBe(false);
    });

    it('replaces a running SSH session when the pane explicitly requests it', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
        branchName: 'agent/test',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-1', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.restartTerminal('term-1', mockPlanPreset.id, 'plan', 120, 30, {
        sshAction: 'replace',
      });

      expect(mockSshWorkspaceService.findTerminalSessions).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
        backend,
        'claude --plan',
        'term-1',
        'ssh-ws',
        'replace',
        expect.objectContaining({ keepShellOpenAfterCommand: false })
      );
      expect(mockPtyService.restart).toHaveBeenCalledWith(
        'term-1',
        '/mock/home/.komla',
        'ssh remote command',
        'ssh-ws',
        120,
        30,
        'wait-for-marker',
        false
      );
    });

    it('restores stopped state when implicit SSH replacement probing is unreachable', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-1', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockRejectedValueOnce(new Error('offline'));
      mockPtyService.getStatus.mockReturnValue(undefined);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.restartTerminal('term-1')).rejects.toThrow(
        'terminal replacement was cancelled'
      );

      expect(workspaceService.get('ssh-ws')?.terminals[0]?.status).toBe('stopped');
      expect(mockPtyService.restart).not.toHaveBeenCalled();
    });

    it('preserves terminal metadata when implicit SSH replacement finds a live session', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-1', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValueOnce(new Set(['term-1']));
      mockPtyService.getStatus.mockReturnValue(undefined);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.get('ssh-ws')!.terminals[0];
      terminal.dynamicTitle = 'Working';
      await hookTerminal(workspaceService, terminal.id, { kind: 'prompt-submit', source: 'codex' });
      await hookTerminal(workspaceService, terminal.id, {
        kind: 'input-required',
        source: 'codex',
      });
      const attention = terminal.attention;
      expect(attention?.kind).toBe('input-required');

      await expect(workspaceService.restartTerminal('term-1')).rejects.toThrow(
        'A running remote session was recovered'
      );

      expect(terminal.agentActive).toBe(true);
      expect(terminal.attention).toEqual(attention);
      expect(terminal.dynamicTitle).toBe('Working');
      expect(mockPtyService.restart).not.toHaveBeenCalled();
    });

    it('does not finalize preset metadata for a superseded SSH replacement', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-1', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      let finishPersistenceCheck: (() => void) | undefined;
      mockSshWorkspaceService.supportsPersistentTerminalSessions.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishPersistenceCheck = () => resolve(true);
          })
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const replacement = workspaceService.restartTerminal(
        'term-1',
        mockPlanPreset.id,
        'plan',
        undefined,
        undefined,
        { sshAction: 'replace' }
      );
      await vi.waitFor(() => expect(finishPersistenceCheck).toBeTypeOf('function'));
      await workspaceService.stopTerminal('term-1');
      finishPersistenceCheck?.();
      await replacement;

      expect(workspaceService.get('ssh-ws')?.presetId).toBeUndefined();
      expect(mockAgentPresetService.recordPresetUsage).not.toHaveBeenCalledWith(
        mockPlanPreset.id,
        'plan'
      );
    });

    it('moves a local mirror pane back to remote execution when replacing it with an agent', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
        branchName: 'agent/test',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [
              {
                id: 'term-local',
                name: 'Local mirror',
                createdAt: 1001,
                executionLocation: 'local-mirror',
              },
            ],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.get('ssh-ws')!.terminals.push({
        id: 'term-local',
        name: 'Local mirror',
        status: 'stopped',
        createdAt: 1001,
        executionLocation: 'local-mirror',
      });

      await workspaceService.restartTerminal(
        'term-local',
        mockPlanPreset.id,
        'plan',
        undefined,
        undefined,
        { sshAction: 'replace' }
      );

      expect(workspaceService.get('ssh-ws')?.terminals[0]?.executionLocation).toBe('workspace');
      expect(mockLocalMirrorService.getMirrorPath).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
        backend,
        'claude --plan',
        'term-local',
        'ssh-ws',
        'replace',
        expect.objectContaining({ keepShellOpenAfterCommand: false })
      );
    });

    describe('moving a local mirror pane back to a shell on the host', () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
        branchName: 'agent/test',
      };
      const localTerminal = {
        id: 'term-local',
        name: 'Local terminal',
        createdAt: 1001,
        executionLocation: 'local-mirror' as const,
      };
      async function loadLocalTerminal() {
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws',
              name: 'Remote',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: null,
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
              terminals: [localTerminal],
            },
          ])
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        workspaceService.get('ssh-ws')!.terminals.push({ ...localTerminal, status: 'running' });
        return workspaceService;
      }

      it('stops the local shell, then starts a shell on the host', async () => {
        const workspaceService = await loadLocalTerminal();

        // Without a session replacement flag too: asking for the host is enough.
        await workspaceService.restartTerminal('term-local', undefined, undefined, 90, 30, {
          plainShell: true,
          executionLocation: 'workspace',
        });

        expect(workspaceService.get('ssh-ws')?.terminals[0]?.executionLocation).toBe('workspace');
        expect(mockLocalMirrorService.getMirrorPath).not.toHaveBeenCalled();
        expect(mockPtyService.kill).toHaveBeenCalledWith('term-local');
        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
          backend,
          null,
          'term-local',
          'ssh-ws',
          'replace',
          expect.anything()
        );
        expect(mockPtyService.kill.mock.invocationCallOrder[0]).toBeLessThan(
          mockPtyService.restart.mock.invocationCallOrder[0]
        );
      });

      it('stops the local shell even when the host session cannot start', async () => {
        mockSshWorkspaceService.supportsPersistentTerminalSessions.mockRejectedValueOnce(
          new Error('host unreachable')
        );
        const workspaceService = await loadLocalTerminal();

        await workspaceService
          .restartTerminal('term-local', undefined, undefined, 90, 30, {
            plainShell: true,
            executionLocation: 'workspace',
          })
          ?.catch(() => {});

        expect(mockPtyService.kill).toHaveBeenCalledWith('term-local');
        expect(workspaceService.get('ssh-ws')?.terminals[0]?.executionLocation).toBe('workspace');
      });

      it('cancels a local shell still waiting on its first sync', async () => {
        let finishPreparing: (() => void) | undefined;
        mockLocalMirrorService.initialize.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finishPreparing = () => resolve('/mock/home/.komla/mirrors/ssh-ws');
            })
        );
        const workspaceService = await loadLocalTerminal();
        const localLaunch = workspaceService.restartTerminal(
          'term-local',
          undefined,
          undefined,
          90,
          30,
          { plainShell: true }
        );
        await vi.waitFor(() => expect(finishPreparing).toBeDefined());

        await workspaceService.restartTerminal('term-local', undefined, undefined, 90, 30, {
          plainShell: true,
          executionLocation: 'workspace',
        });
        finishPreparing?.();
        await localLaunch;

        const localStarts = mockPtyService.restart.mock.calls.filter(
          ([, cwd]) => cwd === '/mock/home/.komla/mirrors/ssh-ws'
        );
        expect(localStarts).toEqual([]);
      });

      it('starts a shell, not an agent, when only asked to move to the host', async () => {
        const workspaceService = await loadLocalTerminal();

        await workspaceService.restartTerminal('term-local', undefined, undefined, 90, 30, {
          executionLocation: 'workspace',
        });

        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
          backend,
          null,
          'term-local',
          'ssh-ws',
          'replace',
          expect.anything()
        );
      });
    });

    it('syncs a stopped Local copy before restarting its Terminal Command', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
        branchName: 'agent/test',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ])
      );
      let finishPreparing: (() => void) | undefined;
      mockLocalMirrorService.prepare.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishPreparing = () => resolve('/mock/home/.komla/mirrors/ssh-ws');
          })
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.get('ssh-ws')!.terminals.push({
        id: 'term-local',
        name: 'Local app',
        status: 'stopped',
        createdAt: 1001,
        executionLocation: 'local-mirror',
      });

      const restarting = workspaceService.restartTerminal(
        'term-local',
        undefined,
        undefined,
        90,
        30,
        {
          command: 'npm run dev',
          commandKind: 'host',
        }
      );

      expect(mockLocalMirrorService.prepare).toHaveBeenCalledWith('ssh-ws', backend);
      expect(mockLocalMirrorService.initialize).not.toHaveBeenCalled();
      expect(mockPtyService.restart).not.toHaveBeenCalled();
      finishPreparing?.();
      await restarting;
      expect(mockPtyService.restart).toHaveBeenCalledWith(
        'term-local',
        '/mock/home/.komla/mirrors/ssh-ws',
        'npm run dev',
        'ssh-ws',
        90,
        30
      );
      expect(mockLocalMirrorService.ensureInitialSync).toHaveBeenCalledWith('ssh-ws', backend);
    });

    describe('converting an SSH terminal to a Local copy shell', () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
        branchName: 'agent/test',
      };
      const persistRemoteTerminal = () =>
        vfs.setFile(
          '/mock/home/.komla/workspaces.json',
          JSON.stringify([
            {
              id: 'ssh-ws',
              name: 'Remote',
              workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
              backend,
              isWorktree: true,
              projectId: null,
              windowId: null,
              categoryId: null,
              createdAt: 1000,
              lastActivityAt: 1000,
              order: 0,
              terminals: [{ id: 'term-1', name: 'Agent', createdAt: 1001 }],
            },
          ])
        );

      it('stops the remote session before launching a Local copy shell in the same pane', async () => {
        persistRemoteTerminal();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await workspaceService.restartTerminal('term-1', undefined, undefined, 90, 30, {
          executionLocation: 'local-mirror',
        });

        expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalledWith(backend, [
          'term-1',
        ]);
        expect(mockPtyService.kill).toHaveBeenCalledWith('term-1');
        expect(mockPtyService.releaseTerminalAndWait).not.toHaveBeenCalled();
        expect(
          mockSshWorkspaceService.killTerminalSessions.mock.invocationCallOrder[0]
        ).toBeLessThan(mockPtyService.restart.mock.invocationCallOrder[0]);
        expect(mockLocalMirrorService.initialize).toHaveBeenCalledWith('ssh-ws', backend);
        expect(mockPtyService.restart).toHaveBeenCalledWith(
          'term-1',
          '/mock/home/.komla/mirrors/ssh-ws',
          null,
          'ssh-ws',
          90,
          30
        );
        const workspace = workspaceService.get('ssh-ws')!;
        const terminal = workspace.terminals[0]!;
        expect(terminal.executionLocation).toBe('local-mirror');
        expect(isResumable(workspace, terminal)).toBe(false);
      });

      it('converts without reaching the host when the remote session was seen to stop', async () => {
        persistRemoteTerminal();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        await workspaceService.stopTerminal('term-1');
        mockSshWorkspaceService.killTerminalSessions.mockClear();

        await workspaceService.restartTerminal('term-1', undefined, undefined, 90, 30, {
          executionLocation: 'local-mirror',
        });

        expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
        expect(workspaceService.get('ssh-ws')?.terminals[0]?.executionLocation).toBe(
          'local-mirror'
        );
        expect(mockPtyService.restart).toHaveBeenCalledWith(
          'term-1',
          '/mock/home/.komla/mirrors/ssh-ws',
          null,
          'ssh-ws',
          90,
          30
        );
      });

      it('still stops a remote session that is only recorded as gone', async () => {
        persistRemoteTerminal();
        const { workspaceService } = await import('../../../src/main/services/workspace.service');
        workspaceService.get('ssh-ws')!.terminals[0]!.remoteSessionActive = false;

        await workspaceService.restartTerminal('term-1', undefined, undefined, 90, 30, {
          executionLocation: 'local-mirror',
        });

        expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalledWith(backend, [
          'term-1',
        ]);
      });

      it('leaves the SSH terminal untouched when the Local copy cannot be prepared', async () => {
        persistRemoteTerminal();
        mockLocalMirrorService.initialize.mockRejectedValueOnce(new Error('rsync missing'));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.restartTerminal('term-1', undefined, undefined, 90, 30, {
            executionLocation: 'local-mirror',
          })
        ).rejects.toThrow('rsync missing');

        expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
        expect(mockPtyService.kill).not.toHaveBeenCalled();
        expect(workspaceService.get('ssh-ws')?.terminals[0]?.executionLocation).not.toBe(
          'local-mirror'
        );
      });

      it('does not relaunch a terminal removed while its remote session was stopping', async () => {
        persistRemoteTerminal();
        let finishStopping: (() => void) | undefined;
        mockSshWorkspaceService.killTerminalSessions.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishStopping = resolve;
            })
        );
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        const converting = workspaceService.restartTerminal(
          'term-1',
          undefined,
          undefined,
          90,
          30,
          {
            executionLocation: 'local-mirror',
          }
        );
        await vi.waitFor(() => expect(finishStopping).toBeTypeOf('function'));
        workspaceService.get('ssh-ws')!.terminals = [];
        finishStopping?.();
        await converting;

        expect(mockPtyService.restart).not.toHaveBeenCalled();
      });

      it('keeps the SSH terminal when the remote session cannot be stopped', async () => {
        persistRemoteTerminal();
        mockSshWorkspaceService.killTerminalSessions.mockRejectedValueOnce(new Error('offline'));
        const { workspaceService } = await import('../../../src/main/services/workspace.service');

        await expect(
          workspaceService.restartTerminal('term-1', undefined, undefined, 90, 30, {
            executionLocation: 'local-mirror',
          })
        ).rejects.toThrow('Could not confirm the remote agent stopped');

        expect(workspaceService.get('ssh-ws')?.terminals[0]?.executionLocation).not.toBe(
          'local-mirror'
        );
        expect(mockPtyService.restart).not.toHaveBeenCalled();
      });
    });

    it('throws if terminal not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.restartTerminal('non-existent')).toThrow(
        'Terminal non-existent not found'
      );
    });
  });

  describe('restart', () => {
    it('confirms SSH session cleanup before replacing workspace terminals', async () => {
      const backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-old', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const replacement = await workspaceService.restartWithCleanup('ssh-ws');

      expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalledWith(backend, [
        'term-old',
      ]);
      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([replacement]);
      expect(replacement.id).not.toBe('term-old');
    });

    it('retains SSH terminals when restart cleanup cannot be confirmed', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-old', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockSshWorkspaceService.killTerminalSessions.mockRejectedValue(new Error('offline'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.restartWithCleanup('ssh-ws')).rejects.toThrow(
        'workspace restart was cancelled'
      );

      expect(workspaceService.get('ssh-ws')?.terminals.map((terminal) => terminal.id)).toEqual([
        'term-old',
      ]);
      expect(mockPtyService.kill).not.toHaveBeenCalledWith('term-old');
    });

    it('does not replace SSH terminals while their recovered session state is unknown', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-old', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockSshWorkspaceService.findTerminalSessions.mockRejectedValue(new Error('offline'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.restartWithCleanup('ssh-ws')).rejects.toThrow(
        'workspace restart was cancelled'
      );

      expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([
        expect.objectContaining({ id: 'term-old', remoteSessionActive: undefined }),
      ]);
    });

    it('stops and replaces a live SSH session discovered by an explicit restart', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
              projectName: 'Repo',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-live', name: 'Agent', createdAt: 1001 }],
          },
        ])
      );
      mockPtyService.getStatus.mockReturnValue(undefined);
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set(['term-live']));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const replacement = await workspaceService.restartWithCleanup('ssh-ws');

      expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        ['term-live']
      );
      expect(workspaceService.get('ssh-ws')?.terminals).toEqual([replacement]);
      expect(replacement.id).not.toBe('term-live');
    });

    it('should clear old terminals and create new one with continue command', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Add and stop a terminal
      workspaceService.addTerminal('ws-1', 'Old Terminal');

      // Restart
      const newTerminal = workspaceService.restart('ws-1');

      // Check old terminals are cleared
      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(1);
      expect(workspace?.terminals[0].id).toBe(newTerminal.id);

      // Check continue command is used
      expect(mockPtyService.spawn).toHaveBeenLastCalledWith(
        newTerminal.id,
        '/ws1',
        'claude --resume'
      );
    });

    it('applies the workspace launch mode arguments to the continue command', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            presetId: mockArgumentPreset.id,
            launchModeId: 'plan',
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.restart('ws-1');

      expect(mockPtyService.spawn).toHaveBeenLastCalledWith(
        terminal.id,
        '/ws1',
        'claude --resume --permission-mode plan'
      );
    });

    it('applies the workspace reasoning level to the continue command', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            presetId: mockArgumentPreset.id,
            launchModeId: 'plan',
            reasoningLevelId: 'high',
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.restart('ws-1');

      expect(mockAgentPresetService.resolvePresetCommand).toHaveBeenLastCalledWith(
        mockArgumentPreset,
        'continue',
        'plan',
        undefined,
        undefined,
        'high'
      );
    });

    it('should kill existing terminals before creating replacement terminals', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const oldTerminal1 = workspaceService.addTerminal('ws-1', 'Old Terminal 1');
      const oldTerminal2 = workspaceService.addTerminal('ws-1', 'Old Terminal 2');
      oldTerminal1.status = 'running';
      oldTerminal2.status = 'starting';

      const newTerminal = workspaceService.restart('ws-1');

      expect(mockPtyService.kill).toHaveBeenCalledWith(oldTerminal1.id);
      expect(mockPtyService.kill).toHaveBeenCalledWith(oldTerminal2.id);
      expect(mockPtyService.kill).not.toHaveBeenCalledWith(newTerminal.id);
      expect(workspaceService.get('ws-1')?.terminals).toEqual([newTerminal]);
    });

    it('should clear lastStoppedAt when workspace is restarted', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          lastStoppedAt: 2000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.restart('ws-1');
      const workspace = workspaceService.get('ws-1');

      expect(workspace?.lastStoppedAt).toBeUndefined();
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.restart('non-existent')).toThrow(
        'Workspace non-existent not found'
      );
    });

    it('should not restart a workspace that is still provisioning', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          provisioning: true,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.restart('ws-1')).toThrow(
        'Workspace ws-1 is still being provisioned'
      );
      expect(mockPtyService.spawn).not.toHaveBeenCalled();
    });

    it('should restart file watcher on restart', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      expect(mockWorktreeWatcherService.startWatching).toHaveBeenCalledWith('ws-1', '/ws1');
    });

    it('should kill existing background processes before restart', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      expect(mockBackgroundProcessService.killForWorkspace).toHaveBeenCalledWith('ws-1');
    });

    it('should re-apply setup steps with background processes on restart', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({ name: 'Dev Server', command: 'npm run dev' }),
          createBackgroundStep({ name: 'Watcher', command: 'npm run watch' }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.restart('ws-1');

      // Background processes should be spawned
      expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
        'ws-1',
        'npm run dev',
        '/ws1',
        'Dev Server',
        expect.objectContaining({ onData: expect.any(Function), onExit: expect.any(Function) })
      );
      expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
        'ws-1',
        'npm run watch',
        '/ws1',
        'Watcher',
        expect.objectContaining({ onData: expect.any(Function), onExit: expect.any(Function) })
      );

      // Agent terminal should still be created with continue command
      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(1);
      expect(workspace?.primaryTerminalId).toBe(terminal.id);
    });

    it('should skip workspace-creation trigger setup steps on restart', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({
            name: 'Install',
            command: 'npm install',
            trigger: 'workspace-creation',
          }),
          createBackgroundStep({
            name: 'Watcher',
            command: 'npm run watch',
            trigger: 'every-workspace-start',
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const spawnCalls = mockBackgroundProcessService.spawn.mock.calls;
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.slice(0, 4)).toEqual(['ws-1', 'npm run watch', '/ws1', 'Watcher']);
    });

    it('should fall through to single terminal when all setup steps run only on creation on restart', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({
            name: 'Install',
            command: 'npm install',
            trigger: 'workspace-creation',
          }),
          createTabStep({
            name: 'Dev Server',
            command: 'npm run dev',
            trigger: 'workspace-creation',
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.restart('ws-1');

      expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();
      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(1);
      expect(workspace?.primaryTerminalId).toBe(terminal.id);
      expect(mockPtyService.spawn).toHaveBeenLastCalledWith(terminal.id, '/ws1', 'claude --resume');
    });

    it('should re-apply setup steps with terminal layout on restart', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [createTabStep({ name: 'Dev Server', command: 'npm run dev' })],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const agentTerminal = workspaceService.restart('ws-1');

      // Should have 2 terminals: agent + dev server tab
      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(2);
      expect(workspace?.primaryTerminalId).toBe(agentTerminal.id);

      // Agent terminal uses continue command
      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        agentTerminal.id,
        '/ws1',
        'claude --resume'
      );

      // Setup step terminal has layout hint
      const devServerTerminal = workspace?.terminals.find((t) => t.id !== agentTerminal.id);
      expect(devServerTerminal?.layoutHint).toBe('tab');
    });

    it('should not apply setup steps for non-worktree workspaces on restart', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      // No background processes spawned
      expect(mockBackgroundProcessService.spawn).not.toHaveBeenCalled();

      // Single terminal with continue command
      const workspace = workspaceService.get('ws-1');
      expect(workspace?.terminals).toHaveLength(1);
    });

    it('should substitute template variables in setup step commands on restart', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({
            name: 'Build',
            command: 'cd {{worktreePath}} && npm run build --branch={{branchName}}',
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/my-feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
        'ws-1',
        `cd ${escapeForExpectedShell('/ws1')} && npm run build --branch=${escapeForExpectedShell('agent/my-feature')}`,
        '/ws1',
        'Build',
        expect.objectContaining({ onData: expect.any(Function), onExit: expect.any(Function) })
      );
    });

    it('waits for remote background Setup to exit before relaunching setup', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({ id: 'install-step', name: 'Install', command: 'npm install' }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'SSH Devbox',
            hostname: 'dev.example.com',
            basePath: '~/.komla',
          },
        ],
      });
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Test Project',
        branchName: 'agent/my-feature',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            branchName: 'agent/my-feature',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ])
      );
      let firstSignal: AbortSignal | undefined;
      let finishFirstRun: (() => void) | undefined;
      mockSshWorkspaceService.runStreaming.mockImplementation(
        (_host: unknown, _command: string, options: { signal: AbortSignal }) => {
          if (!firstSignal) {
            firstSignal = options.signal;
            return new Promise<number>((_resolve, reject) => {
              finishFirstRun = () =>
                reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
            });
          }
          return Promise.resolve(0);
        }
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ssh-ws');
      await vi.waitFor(() => expect(finishFirstRun).toBeDefined());

      const restarting = workspaceService.restart('ssh-ws');
      await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
      expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalledTimes(1);

      finishFirstRun?.();
      await restarting;
      expect(mockSshWorkspaceService.runStreaming).toHaveBeenCalledTimes(2);
    });

    it('preserves legacy visible-step variables that are already quoted', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createTabStep({
            name: 'Dev Server',
            command: 'cd "{{worktreePath}}" && npm run dev',
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/workspaces/my feature',
            branchName: 'agent/my-feature',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const devServerCall = mockPtyService.spawn.mock.calls.find(
        ([, , command]) => typeof command === 'string' && command.includes('npm run dev')
      );
      expect(devServerCall?.[2]).toBe("cd '/workspaces/my feature' && npm run dev");
    });

    it('preserves quoted token suffixes while safely substituting remote paths', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createTabStep({
            name: 'Copy environment',
            command: 'cp "{{destinationPath}}/.env" .env',
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/my $repo',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Test Project',
        branchName: 'agent/my-feature',
      };
      mockSshWorkspaceService.createWorkspacePlan.mockReturnValue({
        backend,
        workingDirectory: 'ssh://ssh-dev/home/dev/my $repo',
        repoName: 'Test Project',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = await workspaceService.create({
        mode: 'worktree',
        projectId: 'project-1',
        branchName: 'agent/my-feature',
        useExactBranchName: true,
        location: { kind: 'ssh', hostId: 'ssh-dev' },
      });

      await vi.waitFor(() =>
        expect(mockSshWorkspaceService.buildTerminalLaunchCommand).toHaveBeenCalledWith(
          backend,
          'cp "/home/dev/my \\$repo/.env" .env',
          expect.any(String),
          workspace.id,
          'start',
          expect.objectContaining({ keepShellOpenAfterCommand: true })
        )
      );
    });

    it('preserves surrounding quote context when a quoted placeholder is nested', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({
            name: 'Print branch',
            command: `printf '%s\\n' '"{{branchName}}"'`,
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            branchName: 'agent/feature; touch /tmp/pwn',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
        'ws-1',
        `printf '%s\\n' '"agent/feature; touch /tmp/pwn"'`,
        '/ws1',
        'Print branch',
        expect.any(Object)
      );
    });

    it('should expand launch placeholders for a semantic agent step on restart', async () => {
      mockAgentPresetService.getActive.mockReturnValue(
        createClaudePreset({
          name: 'Antigravity CLI',
          openCommand: 'agy {{antigravityAutoTrustArgs}}',
        })
      );
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [createSplitStep('right', { name: 'Second agent', command: '', agent: {} })],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const workspace = workspaceService.get('ws-1');
      // Agent terminal + second agent split
      expect(workspace?.terminals).toHaveLength(2);

      const secondTerminal = workspace?.terminals.find((t) => t.id !== workspace.primaryTerminalId);
      expect(secondTerminal?.layoutHint).toBe('split-right');
      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        secondTerminal!.id,
        '/ws1',
        // Local terminals launch in PowerShell on Windows.
        process.platform === 'win32' ? 'agy --add-dir $PWD.ProviderPath' : 'agy --add-dir "$PWD"'
      );
    });

    it('should use a pinned preset launch mode for a semantic agent setup step', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createSplitStep('right', {
            name: 'Reviewer',
            command: '',
            agent: { presetId: mockPlanPreset.id, launchModeId: 'plan' },
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          presetId: mockClaudePreset.id,
          launchModeId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const workspace = workspaceService.get('ws-1');
      const reviewer = workspace?.terminals.find((terminal) => terminal.name === 'Reviewer');
      expect(reviewer).toBeDefined();
      expect(mockPtyService.spawn).toHaveBeenCalledWith(reviewer!.id, '/ws1', 'claude --plan');
    });

    it('should inherit the workspace agent when a setup step pinned preset was deleted', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createSplitStep('right', {
            name: 'Reviewer',
            command: '',
            agent: { presetId: 'deleted-preset' },
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          presetId: mockPlanPreset.id,
          launchModeId: 'plan',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const reviewer = workspaceService
        .get('ws-1')
        ?.terminals.find((terminal) => terminal.name === 'Reviewer');
      expect(reviewer).toBeDefined();
      expect(mockPtyService.spawn).toHaveBeenCalledWith(reviewer!.id, '/ws1', 'claude --plan');
    });

    it('should restore an inherited agent launch mode after an app restart', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createSplitStep('right', {
            name: 'Second agent',
            command: '',
            agent: {},
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          presetId: mockPlanPreset.id,
          launchModeId: 'plan',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const workspace = workspaceService.get('ws-1');
      const secondAgent = workspace?.terminals.find((terminal) => terminal.name === 'Second agent');
      expect(secondAgent).toBeDefined();
      expect(mockPtyService.spawn).toHaveBeenCalledWith(secondAgent!.id, '/ws1', 'claude --plan');
    });

    it('should escape substituted background variables containing shell metacharacters', async () => {
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createBackgroundStep({
            name: 'Build',
            command: 'echo {{branchName}} && echo {{projectName}}',
          }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feat;touch /tmp/pwn',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
        'ws-1',
        `echo ${escapeForExpectedShell('agent/feat;touch /tmp/pwn')} && echo ${escapeForExpectedShell('Test Project')}`,
        '/ws1',
        'Build',
        expect.objectContaining({ onData: expect.any(Function), onExit: expect.any(Function) })
      );
    });

    it('should auto-activate trashed workspace on restart', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          status: 'trashed',
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.restart('ws-1');

      const workspace = workspaceService.get('ws-1');
      expect(workspace?.status).toBe('active');
    });

    it('should resolve action-based setup steps with prompt type', async () => {
      const mockAction = {
        id: 'action-1',
        title: 'Review branch',
        content: 'Review the current branch for issues',
        type: 'prompt' as const,
        presetId: 'claude-code',
      };
      mockActionService.get.mockImplementation((id: string) =>
        id === 'action-1' ? mockAction : undefined
      );

      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [createTabStep({ name: 'Review', command: '', actionId: 'action-1' })],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.restart('ws-1');

      expect(mockActionService.get).toHaveBeenCalledWith('action-1');
      const spawnCalls = mockPtyService.spawn.mock.calls;
      const actionTerminalCall = spawnCalls.find(
        (call: unknown[]) =>
          typeof call[2] === 'string' && call[2].includes('Review the current branch for issues')
      );
      expect(actionTerminalCall).toBeDefined();
      expect(actionTerminalCall![2]).toBe('claude "Review the current branch for issues"');
    });

    it('should inherit the workspace agent when a prompt action pinned preset was deleted', async () => {
      const mockAction = {
        id: 'action-stale-preset',
        title: 'Review branch',
        content: 'Review the current branch for issues',
        type: 'prompt' as const,
        presetId: 'deleted-preset',
        launchModeId: 'deleted-mode',
      };
      mockActionService.get.mockImplementation((id: string) =>
        id === 'action-stale-preset' ? mockAction : undefined
      );

      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createTabStep({ name: 'Review', command: '', actionId: 'action-stale-preset' }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          presetId: mockPlanPreset.id,
          launchModeId: 'plan',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      workspaceService.restart('ws-1');

      const reviewTerminal = workspaceService
        .get('ws-1')
        ?.terminals.find((terminal) => terminal.name === 'Review');
      expect(mockPtyService.spawn).toHaveBeenCalledWith(
        reviewTerminal!.id,
        '/ws1',
        'claude --plan "Review the current branch for issues"'
      );
    });

    it('should resolve action-based setup steps with command type', async () => {
      const mockAction = {
        id: 'action-2',
        title: 'Run linter',
        content: 'npm run lint',
        type: 'command' as const,
      };
      mockActionService.get.mockImplementation((id: string) =>
        id === 'action-2' ? mockAction : undefined
      );

      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [createBackgroundStep({ name: 'Lint', command: '', actionId: 'action-2' })],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.restart('ws-1');

      expect(mockActionService.get).toHaveBeenCalledWith('action-2');
      expect(mockBackgroundProcessService.spawn).toHaveBeenCalledWith(
        'ws-1',
        'npm run lint',
        '/ws1',
        'Lint',
        expect.objectContaining({ onData: expect.any(Function), onExit: expect.any(Function) })
      );
    });

    it('should skip setup steps referencing deleted actions', async () => {
      mockActionService.get.mockReturnValue(undefined);

      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        setupSteps: [
          createTabStep({ name: 'Deleted action', command: '', actionId: 'nonexistent' }),
        ],
      });
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'project-1' ? projectWithSteps : undefined
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          branchName: 'agent/feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Should not throw
      workspaceService.restart('ws-1');

      expect(mockActionService.get).toHaveBeenCalledWith('nonexistent');
    });
  });

  // ============================================================================
  // Delete Tests
  // ============================================================================

  describe('delete', () => {
    it('does not launch a deferred SSH terminal after its workspace is deleted', async () => {
      let finishPreparation!: () => void;
      mockSshWorkspaceService.supportsPersistentTerminalSessions.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishPreparation = () => resolve(true);
          })
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addTerminal('ssh-ws', 'Agent');
      await workspaceService.delete('ssh-ws');
      finishPreparation();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
      expect(mockPtyService.spawn).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws')).toBeUndefined();
    });

    it('rejects new and replacement Terminal Attachments after SSH workspace release', async () => {
      let finishRemoteDeletion!: () => void;
      mockSshWorkspaceService.deleteWorkspace.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoteDeletion = resolve;
          })
      );
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            terminals: [{ id: 'term-1', name: 'Agent', status: 'stopped', createdAt: 1000 }],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const deletion = workspaceService.delete('ssh-ws');
      await vi.waitFor(() => expect(finishRemoteDeletion).toBeTypeOf('function'));

      expect(() => workspaceService.addTerminal('ssh-ws', 'Another Agent')).toThrow(
        'Workspace ssh-ws is being deleted'
      );
      expect(() => workspaceService.restartTerminal('term-1')).toThrow(
        'Workspace ssh-ws is being deleted'
      );

      finishRemoteDeletion();
      await deletion;
    });

    it('should delete workspace and stop watchers', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');
      const removeObservation = vi.spyOn(workspaceStatusService, 'change');

      await workspaceService.delete('ws-1');

      expect(mockWorktreeWatcherService.stopWatching).toHaveBeenCalledWith('ws-1');
      expect(mockNotesService.trashAll).toHaveBeenCalledWith('ws-1');
      expect(removeObservation).toHaveBeenCalledWith({
        kind: 'workspace-removed',
        workspaceId: 'ws-1',
      });
      expect(workspaceService.get('ws-1')).toBeUndefined();
    });

    it('retains SSH workspace metadata when managed session cleanup is uncertain', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
            remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'https://github.com/example/repo.git',
            projectName: 'Project',
            branchName: 'branch',
            baseBranch: 'main',
            startPoint: 'main',
          },
          branchName: 'branch',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const terminal = workspaceService.addTerminal('ssh-ws-1', 'Agent', 'claude');
      await vi.waitFor(() =>
        expect(mockPtyService.spawn).toHaveBeenCalledWith(
          terminal.id,
          expect.any(String),
          expect.any(String),
          [],
          undefined,
          undefined,
          0,
          undefined,
          undefined,
          expect.any(String),
          false
        )
      );
      mockSshWorkspaceService.killTerminalSessions.mockRejectedValueOnce(new Error('offline'));

      await expect(workspaceService.delete('ssh-ws-1')).rejects.toThrow(
        'workspace deletion was cancelled'
      );

      expect(mockSshWorkspaceService.deleteWorkspace).not.toHaveBeenCalled();
      expect(mockWorktreeWatcherService.stopWatching).not.toHaveBeenCalledWith('ssh-ws-1');
      expect(mockBackgroundProcessService.killForWorkspaceAndWait).not.toHaveBeenCalledWith(
        'ssh-ws-1'
      );
      expect(workspaceService.get('ssh-ws-1')).toBeDefined();
    });

    it('removes the remote worktree, requested branch, and local mirror for an SSH workspace', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
        remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/project',
        gitUrl: 'https://github.com/example/repo.git',
        projectName: 'Project',
        branchName: 'feature/cleanup',
        baseBranch: 'main',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
            backend,
            branchName: 'feature/cleanup',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.delete('ssh-ws-1', true, true);

      expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(
        backend,
        true,
        'feature/cleanup',
        { allowBranchToRemain: true }
      );
      expect(mockLocalMirrorService.remove).toHaveBeenCalledWith('ssh-ws-1', backend);
      expect(workspaceService.get('ssh-ws-1')).toBeUndefined();
    });

    it('does not report failure when persistence fails after irreversible SSH deletion', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
        remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/project',
        gitUrl: 'https://github.com/example/repo.git',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
            backend,
            branchName: 'feature/cleanup',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const writeError = new Error('disk full');
      mockWriteFileAtomic.mockRejectedValueOnce(writeError);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.delete('ssh-ws-1')).resolves.toBeUndefined();

      expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(
        backend,
        false,
        'feature/cleanup',
        { allowBranchToRemain: true }
      );
      expect(workspaceService.get('ssh-ws-1')).toBeUndefined();

      await vi.runAllTimersAsync();
      expect(mockWriteFileAtomic).toHaveBeenCalledTimes(2);
    });

    it('retains SSH workspace metadata when local mirror cleanup fails', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
        remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/project',
        gitUrl: 'https://github.com/example/repo.git',
        projectName: 'Project',
        branchName: 'feature/cleanup',
        baseBranch: 'main',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/project/branch',
            backend,
            branchName: 'feature/cleanup',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      mockLocalMirrorService.remove.mockRejectedValueOnce(new Error('mirror directory is busy'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.delete('ssh-ws-1', true, true)).rejects.toThrow(
        'mirror directory is busy'
      );

      expect(mockSshWorkspaceService.deleteWorkspace).toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws-1')).toBeDefined();
    });

    it('should remove prompt submit history from persisted state when deleting a workspace', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          promptSubmits: [{ prompt: 'Secret task prompt', submittedAt: 1000 }],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.delete('ws-1');

      const lastCall = mockWriteFileAtomic.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const written = JSON.parse(lastCall![1] as string) as Array<Record<string, unknown>>;
      expect(written).toEqual([]);
      expect(JSON.stringify(written)).not.toContain('Secret task prompt');
    });

    it('should await persistence before resolving delete', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      let resolveKill: (() => void) | null = null;
      mockBackgroundProcessService.killForWorkspaceAndWait.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveKill = resolve;
          })
      );

      let resolveWrite: (() => void) | null = null;
      mockWriteFileAtomic.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          })
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const deletePromise = workspaceService.delete('ws-1');

      // Drain the resolved-promise awaits in delete()'s prologue so it's
      // parked on killForWorkspaceAndWait.
      await Promise.resolve();
      await Promise.resolve();
      // Sync on the kill step: while it's pending, delete must not have
      // removed the workspace from the in-memory map yet.
      expect(workspaceService.get('ws-1')).toBeDefined();

      // Complete the kill step — delete should now proceed to the map removal
      // and then await the persistence write.
      resolveKill?.();
      await resolveKill;
      await Promise.resolve();

      expect(workspaceService.get('ws-1')).toBeUndefined();

      let settled = false;
      void deletePromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.waitFor(() => expect(resolveWrite).toBeTypeOf('function'));
      resolveWrite?.();
      await deletePromise;
      expect(settled).toBe(true);
    });

    it('should await terminal exit before deleting the workspace', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockPtyService.isRunning.mockReturnValue(true);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      let resolveRelease: (() => void) | undefined;
      mockPtyService.releaseTerminalAndWait.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRelease = resolve;
          })
      );

      const deletePromise = workspaceService.delete('ws-1');
      await vi.waitFor(() => expect(resolveRelease).toBeTypeOf('function'));

      expect(workspaceService.get('ws-1')).toBeDefined();
      resolveRelease?.();
      await deletePromise;

      expect(mockPtyService.releaseTerminalAndWait).toHaveBeenCalledWith(terminal.id);
      expect(workspaceService.get('ws-1')).toBeUndefined();
    });

    it('should delete worktree for worktree-based workspace', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/branch',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'agent/branch',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      // Set a file inside the worktree directory so existsSync returns true for the directory
      vfs.setFile('/mock/home/.komla/worktrees/project/branch/.git', 'worktree marker');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Access fs module after importing workspace service to use the same mock
      const fs = await import('fs');
      // Make existsSync return true for the worktree directory path
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/mock/home/.komla/worktrees/project/branch') return true;
        return vfs.mock.existsSync(path);
      });

      await workspaceService.delete('ws-1');

      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        '/mock/repo',
        '/mock/home/.komla/worktrees/project/branch',
        false,
        { deleteBranch: false, branchName: 'agent/branch' }
      );
    });

    it('releases the worktree from opencode while deleting it', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/branch',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'agent/branch',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      vfs.setFile('/mock/home/.komla/worktrees/project/branch/.git', 'worktree marker');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/mock/home/.komla/worktrees/project/branch') return true;
        return vfs.mock.existsSync(path);
      });

      await workspaceService.delete('ws-1', true);

      expect(mockDeleteReleasingOpenCodeLocation).toHaveBeenCalledWith(
        '/mock/home/.komla/worktrees/project/branch',
        expect.any(Function)
      );
      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        '/mock/repo',
        '/mock/home/.komla/worktrees/project/branch',
        true,
        { deleteBranch: false, branchName: 'agent/branch' }
      );
    });

    it('should not unlink workspace links when worktree deletion fails', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/branch',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'agent/branch',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          linkedWorkspaceIds: ['ws-2'],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      vfs.setFile('/mock/home/.komla/worktrees/project/branch/.git', 'worktree marker');
      mockGitService.deleteWorktree.mockRejectedValueOnce(new Error('uncommitted changes'));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/mock/home/.komla/worktrees/project/branch') return true;
        return vfs.mock.existsSync(path);
      });

      await expect(workspaceService.delete('ws-1')).rejects.toThrow('uncommitted changes');

      expect(mockWorkspaceLinksService.unlinkAll).not.toHaveBeenCalled();
      expect(workspaceService.get('ws-1')).toBeDefined();
    });

    it("never deletes the project's target branch", async () => {
      mockProject.baseBranch = 'develop';
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/develop',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'develop',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      vfs.setFile('/mock/home/.komla/worktrees/project/develop/.git', 'worktree marker');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/mock/home/.komla/worktrees/project/develop') return true;
        return vfs.mock.existsSync(path);
      });

      await workspaceService.delete('ws-1', true, true);

      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        '/mock/repo',
        '/mock/home/.komla/worktrees/project/develop',
        true,
        { deleteBranch: false, branchName: 'develop' }
      );
    });

    it('cleans up the worktree record and branch when the directory is already gone', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/branch',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'agent/branch',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      vfs.setFile('/mock/home/.komla/worktrees/project/branch/.git', 'worktree marker');
      vfs.mock.mkdirSync('/mock/home/.komla/worktrees/project', { recursive: true });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      // The directory disappears after startup has loaded the workspace.
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/mock/home/.komla/worktrees/project/branch') return false;
        return vfs.mock.existsSync(path);
      });

      await workspaceService.delete('ws-1', true, true);

      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        '/mock/repo',
        '/mock/home/.komla/worktrees/project/branch',
        true,
        { deleteBranch: true, branchName: 'agent/branch' }
      );
      expect(workspaceService.get('ws-1')).toBeUndefined();
    });

    it("leaves git's worktree records alone when the worktree's drive is not mounted", async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/Volumes/External/worktrees/project/branch',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'agent/branch',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      vfs.setFile('/Volumes/External/worktrees/project/branch/.git', 'worktree marker');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockImplementation(
        (path) => !String(path).startsWith('/Volumes/External') && vfs.mock.existsSync(path)
      );

      await workspaceService.delete('ws-1', true, true);

      expect(mockGitService.deleteWorktree).not.toHaveBeenCalled();
      expect(workspaceService.get('ws-1')).toBeUndefined();
    });

    it('should pass deleteBranch option to git service', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/mock/home/.komla/worktrees/project/branch',
          isWorktree: true,
          projectId: 'project-1',
          branchName: 'agent/branch',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      vfs.setFile('/mock/home/.komla/worktrees/project/branch/.git', 'worktree marker');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Access fs module after importing workspace service to use the same mock
      const fs = await import('fs');
      // Make existsSync return true for the worktree directory path
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/mock/home/.komla/worktrees/project/branch') return true;
        return vfs.mock.existsSync(path);
      });

      await workspaceService.delete('ws-1', false, true);

      expect(mockGitService.deleteWorktree).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        false,
        { deleteBranch: true, branchName: 'agent/branch' }
      );
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.delete('non-existent')).rejects.toThrow(
        'Workspace non-existent not found'
      );
    });

    it('should save immediately after delete', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.delete('ws-1');

      // Should save immediately without waiting for debounce
      await Promise.resolve();
      expect(mockWriteFileAtomic).toHaveBeenCalled();
    });

    it('rejects connection profile changes while an SSH host owns workspaces', async () => {
      const existingHost = {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: 'dev.example.com',
        user: 'dev',
        basePath: '~/.komla',
        forwardAgent: true,
        identityFile: '~/.ssh/id_ed25519',
        extraSshArgs: ['-J', 'bastion'],
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws-1',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'https://github.com/example/repo.git',
            },
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      mockConfigService.get.mockReturnValue({ sshHosts: [existingHost] });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() =>
        workspaceService.assertSshHostConnectionUpdateAllowed({
          ...existingHost,
          name: 'Renamed devbox',
        })
      ).not.toThrow();
      expect(() =>
        workspaceService.assertSshHostConnectionUpdateAllowed({
          ...existingHost,
          forwardAgent: false,
        })
      ).not.toThrow();
      expect(() =>
        workspaceService.assertSshHostConnectionUpdateAllowed({
          ...existingHost,
          extraSshArgs: ['-J', 'other-bastion'],
        })
      ).toThrow('Remove existing SSH workspaces');
    });

    it('rejects remote Komla path changes even when the SSH host has no workspaces', async () => {
      const existingHost = {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: 'dev.example.com',
        user: 'dev',
        basePath: '/home/dev/.komla',
      };
      mockConfigService.get.mockReturnValue({ sshHosts: [existingHost] });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() =>
        workspaceService.assertSshHostConnectionUpdateAllowed({
          ...existingHost,
          basePath: '/var/lib/dev/.komla',
        })
      ).toThrow('Remote Komla path is fixed after this machine is connected');
    });

    it('deletes an SSH host and removes its workspace records locally by default', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectName: 'Test Project',
            branchName: 'agent/swift-fox',
            baseBranch: 'main',
          },
          branchName: 'agent/swift-fox',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          terminals: [
            {
              id: 'term-host-delete',
              name: 'Remote Agent',
              status: 'stopped',
              createdAt: 1000,
              remoteSessionActive: true,
            },
          ],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'Devbox',
            hostname: 'dev.example.com',
            basePath: '/home/dev/.komla',
          },
        ],
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const result = await workspaceService.deleteSshHost('ssh-dev');

      expect(result.deletedWorkspaceIds).toEqual(['ssh-ws-1']);
      expect(mockSshWorkspaceService.killTerminalSessions).toHaveBeenCalledWith(
        existingWorkspaces[0].backend,
        ['term-host-delete']
      );
      expect(mockSshWorkspaceService.deleteWorkspace).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.deleteHostData).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.forgetHost).toHaveBeenCalledWith('ssh-dev');
      expect(mockSshHostService.delete).toHaveBeenCalledWith('ssh-dev');
      expect(workspaceService.get('ssh-ws-1')).toBeUndefined();
    });

    it('deletes all remote Komla data before removing the host when requested', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectName: 'Test Project',
            branchName: 'agent/swift-fox',
            baseBranch: 'main',
          },
          branchName: 'agent/swift-fox',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'Devbox',
            hostname: 'dev.example.com',
            basePath: '/home/dev/.komla',
          },
        ],
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.deleteSshHost('ssh-dev', { deleteRemoteData: true });

      expect(mockSshWorkspaceService.deleteHostData).toHaveBeenCalledWith('ssh-dev');
      expect(mockSshWorkspaceService.killTerminalSessions).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.deleteWorkspace).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.forgetHost).toHaveBeenCalledWith('ssh-dev');
      expect(mockSshHostService.delete).toHaveBeenCalledWith('ssh-dev');
      expect(workspaceService.get('ssh-ws-1')).toBeUndefined();
    });

    it('sends new workspaces back to local when deleting their last-used SSH host', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'Devbox',
            hostname: 'dev.example.com',
            basePath: '/home/dev/.komla',
          },
        ],
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-dev' },
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.deleteSshHost('ssh-dev');

      expect(mockConfigService.update).toHaveBeenCalledWith({
        lastWorkspaceEnvironment: undefined,
      });
    });

    it('clears the agent launch SSH host pin when deleting that host', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'Devbox',
            hostname: 'dev.example.com',
            basePath: '/home/dev/.komla',
          },
        ],
        agentLaunchDefaultSshHostId: 'ssh-dev',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.deleteSshHost('ssh-dev');

      expect(mockConfigService.update).toHaveBeenCalledWith({
        agentLaunchDefaultSshHostId: undefined,
      });
    });

    it('keeps SSH host and workspace records when requested remote cleanup fails', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectName: 'Test Project',
            branchName: 'agent/swift-fox',
            baseBranch: 'main',
          },
          branchName: 'agent/swift-fox',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'Devbox',
            hostname: 'dev.example.com',
            basePath: '/home/dev/.komla',
          },
        ],
      });
      mockSshWorkspaceService.deleteHostData.mockRejectedValueOnce(new Error('ssh failed'));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(
        workspaceService.deleteSshHost('ssh-dev', { deleteRemoteData: true })
      ).rejects.toThrow('ssh failed');

      expect(mockConfigService.update).not.toHaveBeenCalled();
      expect(mockSshHostService.delete).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws-1')).toBeDefined();
    });

    it('keeps SSH host and workspace records when managed session cleanup fails', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws-1',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/test-project/agent-swift-fox',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/test-project/agent-swift-fox',
            remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
            gitUrl: 'https://github.com/example/repo.git',
            projectName: 'Test Project',
            branchName: 'agent/swift-fox',
            baseBranch: 'main',
          },
          branchName: 'agent/swift-fox',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          terminals: [
            {
              id: 'term-host-delete',
              name: 'Remote Agent',
              status: 'stopped',
              createdAt: 1000,
              remoteSessionActive: true,
            },
          ],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockConfigService.get.mockReturnValue({
        sshHosts: [
          {
            id: 'ssh-dev',
            name: 'Devbox',
            hostname: 'dev.example.com',
            basePath: '/home/dev/.komla',
          },
        ],
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-dev' },
      });
      mockSshWorkspaceService.killTerminalSessions.mockRejectedValueOnce(new Error('offline'));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.deleteSshHost('ssh-dev')).rejects.toThrow('offline');

      expect(mockConfigService.update).not.toHaveBeenCalled();
      expect(mockSshWorkspaceService.forgetHost).not.toHaveBeenCalled();
      expect(mockSshHostService.delete).not.toHaveBeenCalled();
      expect(workspaceService.get('ssh-ws-1')).toBeDefined();
    });
  });

  // ============================================================================
  // Retrieval Tests
  // ============================================================================

  describe('list', () => {
    it('should return all workspaces', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'First',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
        {
          id: 'ws-2',
          name: 'Second',
          workingDirectory: '/ws2',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 2000,
          lastActivityAt: 2000,
          order: 1,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspaces = workspaceService.list();

      expect(workspaces).toHaveLength(2);
      expect(workspaces.map((w) => w.id)).toContain('ws-1');
      expect(workspaces.map((w) => w.id)).toContain('ws-2');
    });

    it('should update terminal statuses from PTY service', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      mockPtyService.getStatus.mockReturnValue('stopped');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.addTerminal('ws-1', 'Terminal 1');

      const workspaces = workspaceService.list();
      expect(workspaces[0].terminals[0].status).toBe('stopped');
    });
  });

  describe('get', () => {
    it('should return workspace by ID', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = workspaceService.get('ws-1');

      expect(workspace?.id).toBe('ws-1');
      expect(workspace?.name).toBe('Workspace');
    });

    it('should return undefined for non-existent ID', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = workspaceService.get('non-existent');

      expect(workspace).toBeUndefined();
    });
  });

  describe('getWorkspacesByProjectId', () => {
    it('should return only workspaces matching the project', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'First',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
        {
          id: 'ws-2',
          name: 'Second',
          workingDirectory: '/ws2',
          isWorktree: false,
          projectId: 'project-2',
          windowId: null,
          categoryId: null,
          createdAt: 2000,
          lastActivityAt: 2000,
          order: 1,
        },
        {
          id: 'ws-3',
          name: 'Third',
          workingDirectory: '/ws3',
          isWorktree: false,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 3000,
          lastActivityAt: 3000,
          order: 2,
        },
        {
          id: 'ws-4',
          name: 'Fourth',
          workingDirectory: '/ws4',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 4000,
          lastActivityAt: 4000,
          order: 3,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const result = workspaceService.getWorkspacesByProjectId('project-1');

      expect(result).toHaveLength(2);
      expect(result.map((w) => w.id)).toEqual(['ws-1', 'ws-3']);
    });

    it('should return empty array when no workspaces match', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'First',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const result = workspaceService.getWorkspacesByProjectId('non-existent');

      expect(result).toHaveLength(0);
    });
  });

  describe('getBranchCleanupScope', () => {
    function sshWorkspace(id: string, hostId: string, branchName: string, projectId: string) {
      return {
        id,
        name: id,
        workingDirectory: `ssh://${hostId}/home/dev/${id}`,
        branchName,
        backend: {
          kind: 'ssh',
          hostId,
          remoteDirectory: `/home/dev/${id}`,
          remoteRepoPath: `/home/dev/.komla/repos/test-project/repo.git`,
          remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
          gitUrl: 'git@example.com:repo.git',
          baseBranch: 'origin/develop',
        },
        isWorktree: true,
        projectId,
        windowId: null,
        categoryId: null,
        createdAt: 1000,
        lastActivityAt: 1000,
        order: 0,
      };
    }

    it("cleans up an SSH host's clone, keeping branches any workspace sharing it uses", async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          sshWorkspace('ws-1', 'ssh-dev', 'agent/one', 'project-1'),
          sshWorkspace('ws-2', 'ssh-other', 'agent/two', 'project-1'),
          sshWorkspace('ws-3', 'ssh-dev', 'agent/three', 'project-2'),
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const scope = await workspaceService.getBranchCleanupScope('project-1', 'ssh-dev');

      expect(mockSshWorkspaceGit.gitBatchRunner).toHaveBeenCalledWith(
        'ssh-dev',
        '/home/dev/.komla/repos/test-project/repo.git'
      );
      // No target set: the clone's HEAD, which is origin's default branch.
      expect(scope.targetBranch).toBe('');
      expect(scope.skipBranchesOnOrigin).toBe(true);
      expect([...scope.keep]).toEqual(
        expect.arrayContaining(['agent/one', 'agent/two', 'agent/three', 'develop'])
      );
      await expect(
        workspaceService.getBranchCleanupScope('project-1', 'ssh-unused')
      ).rejects.toThrow('The project has no workspaces on this host');
    });
  });

  describe('checkWorkspacesForCleanup', () => {
    function worktreeWorkspace(id: string, extra: Record<string, unknown> = {}) {
      return {
        id,
        name: id,
        workingDirectory: `/worktrees/${id}`,
        branchName: `agent/${id}`,
        isWorktree: true,
        projectId: 'project-1',
        windowId: null,
        categoryId: null,
        createdAt: 1000,
        lastActivityAt: 1000,
        order: 0,
        status: 'active',
        ...extra,
      };
    }
    const landed = (workspaceId: string, targetBranch: string) => ({
      workspaceId,
      targetBranch,
      ok: true,
      landed: true,
      uncommittedChanges: false,
    });

    /** Worktrees of /mock/repo, but `managed-*` ones of the managed clone and `stray` of neither. */
    function commonGitDir(path: string): Promise<string> {
      const name = path.split('/').pop() ?? '';
      if (path === '/mock/managed' || name.startsWith('managed-')) {
        return Promise.resolve('/mock/managed');
      }
      return Promise.resolve(name === 'stray' ? '/home/user/.git' : '/mock/repo/.git');
    }

    beforeEach(() => {
      mockGitService.getCommonGitDir.mockImplementation(commonGitDir);
      mockGitService.readWorktreeForCleanup.mockImplementation(async (repo: { label: string }) => {
        if (repo.label === '/worktrees/broken') throw new Error('not a git repository');
        return { commit: `c-${repo.label.split('/').pop()}`, uncommittedChanges: false };
      });
      mockGitService.findLandedCommits.mockImplementation(async (_repo, _target, commits) =>
        (commits as string[]).map((commit) => commit !== 'c-local-2')
      );
      return () => {
        mockProject.managedRepoPath = undefined;
      };
    });

    it('reads each active worktree in place, and checks it landed once per repository and target', async () => {
      mockProject.baseBranch = 'origin/develop';
      mockProject.managedRepoPath = '/mock/managed';
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          worktreeWorkspace('local'),
          worktreeWorkspace('local-2'),
          worktreeWorkspace('managed-1'),
          worktreeWorkspace('own-target', { baseBranch: 'release' }),
          worktreeWorkspace('remote', {
            workingDirectory: 'ssh://ssh-dev/home/dev/remote',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/remote',
              remoteRepoPath: '/home/dev/.komla/repos/test-project/repo.git',
              remoteProjectRoot: '/home/dev/.komla/worktrees/test-project',
              gitUrl: 'git@example.com:repo.git',
            },
          }),
          worktreeWorkspace('broken'),
          worktreeWorkspace('stray'),
          worktreeWorkspace('trashed', { status: 'trashed' }),
          worktreeWorkspace('provisioning', { provisioning: true }),
          worktreeWorkspace('main-checkout', { isWorktree: false }),
          worktreeWorkspace('elsewhere', { projectId: 'project-2' }),
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const statuses = await workspaceService.checkWorkspacesForCleanup('project-1');

      // One check per repository and target, in whatever order their worktrees were read.
      const checks = mockGitService.findLandedCommits.mock.calls.map(([repo, target, commits]) => [
        (repo as { label: string }).label,
        target,
        commits,
      ]);
      expect(checks).toHaveLength(4);
      expect(checks).toEqual(
        expect.arrayContaining([
          ['/mock/repo', 'develop', ['c-local', 'c-local-2']],
          ['/mock/managed', 'develop', ['c-managed-1']],
          ['/mock/repo', 'release', ['c-own-target']],
          ['ssh-dev:/home/dev/.komla/repos/test-project/repo.git', 'develop', ['c-remote']],
        ])
      );
      expect(mockSshWorkspaceGit.gitBatchRunner).toHaveBeenCalledWith('ssh-dev', '/home/dev/remote');
      expect(statuses).toEqual([
        landed('local', 'develop'),
        { ...landed('local-2', 'develop'), landed: false },
        landed('managed-1', 'develop'),
        landed('own-target', 'release'),
        landed('remote', 'develop'),
        { workspaceId: 'broken', targetBranch: 'develop', ok: false, error: 'not a git repository' },
        {
          workspaceId: 'stray',
          targetBranch: 'develop',
          ok: false,
          error: "The workspace isn't a worktree of the project's repository",
        },
      ]);
    });

    it("falls back to the main branch of each worktree's repository, and checks nothing in a directory project", async () => {
      mockProject.managedRepoPath = '/mock/managed';
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([worktreeWorkspace('local'), worktreeWorkspace('managed-1')])
      );
      mockGitService.getMainBranch.mockImplementation(async (repoPath: string) =>
        repoPath === '/mock/managed' ? 'trunk' : 'main'
      );
      mockGitService.readWorktreeForCleanup.mockResolvedValue({
        commit: 'c',
        uncommittedChanges: true,
      });
      mockGitService.findLandedCommits.mockResolvedValue([false]);
      folderProjects.set('/folder', createProject({ id: 'folder-1', kind: 'directory', name: 'f' }));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.checkWorkspacesForCleanup('project-1')).resolves.toEqual([
        { ...landed('local', 'main'), landed: false, uncommittedChanges: true },
        { ...landed('managed-1', 'trunk'), landed: false, uncommittedChanges: true },
      ]);
      await expect(workspaceService.checkWorkspacesForCleanup('folder-1')).resolves.toEqual([]);
      await expect(workspaceService.checkWorkspacesForCleanup('missing')).rejects.toThrow(
        'Project not found'
      );
    });

    it("says why each workspace couldn't be checked when the repository's check fails", async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([worktreeWorkspace('local'), worktreeWorkspace('local-2')])
      );
      mockGitService.findLandedCommits.mockRejectedValue(new Error('bad object'));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.checkWorkspacesForCleanup('project-1')).resolves.toEqual([
        { workspaceId: 'local', targetBranch: 'main', ok: false, error: 'bad object' },
        { workspaceId: 'local-2', targetBranch: 'main', ok: false, error: 'bad object' },
      ]);
    });
  });

  describe('listHostBranches', () => {
    it("lists the host clone's branches that have commits origin doesn't", async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
      const run = vi.fn(async () => [
        {
          ok: true,
          output: ['c1 agent/one', 'c2 release-x', 'c3 feature/host-only', 'c2 main'].join('\n'),
        },
        // release-x and main are the copies the clone made of origin's branches.
        { ok: true, output: 'c1\nc3\nc0' },
      ]);
      mockSshWorkspaceGit.gitBatchRunner.mockImplementationOnce(
        (hostId: string, repoPath: string) => ({ label: `${hostId}:${repoPath}`, run })
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.listHostBranches('project-1', 'ssh-dev')).resolves.toEqual([
        'agent/one',
        'feature/host-only',
      ]);
      // The clone a new workspace uses, as creation picks it.
      expect(mockSshWorkspaceGit.gitBatchRunner).toHaveBeenCalledWith(
        'ssh-dev',
        '/home/dev/.komla/repos/Test Project/repo.git'
      );
      expect(run).toHaveBeenCalledWith([
        {
          args: [
            'for-each-ref',
            '--sort=-committerdate',
            '--format=%(objectname) %(refname:short)',
            'refs/heads',
          ],
        },
        { args: ['rev-list', '--branches', '--not', '--remotes=origin'] },
      ]);
    });

    it('lists nothing when the host has no clone yet', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');
      const run = vi.fn(async () => [
        { ok: false, error: 'not a git repository' },
        { ok: false, error: 'not a git repository' },
      ]);
      mockSshWorkspaceGit.gitBatchRunner.mockImplementationOnce(
        (hostId: string, repoPath: string) => ({ label: `${hostId}:${repoPath}`, run })
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await expect(workspaceService.listHostBranches('project-1', 'ssh-dev')).resolves.toEqual([]);
    });
  });

  // ============================================================================
  // Update Tests
  // ============================================================================

  describe('the Trash', () => {
    const saved = (id: string, extra = {}) => ({
      id,
      name: id,
      workingDirectory: `/${id}`,
      isWorktree: false,
      projectId: null,
      windowId: null,
      categoryId: null,
      createdAt: 1000,
      lastActivityAt: 1000,
      order: 0,
      ...extra,
    });

    it('keeps a saved workspace in the Trash only when saved there, counting from its move', async () => {
      vi.setSystemTime(50_000);
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          saved('moved', { status: 'trashed', trashedAt: 20_000 }),
          saved('undated', { status: 'trashed' }),
          saved('hand-edited', { status: 'archived', trashedAt: 20_000 }),
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('moved')).toMatchObject({ status: 'trashed', trashedAt: 20_000 });
      expect(workspaceService.get('undated')).toMatchObject({
        status: 'trashed',
        trashedAt: 50_000,
      });
      // A status Komla doesn't know never puts a workspace where it would be deleted.
      expect(workspaceService.get('hand-edited')?.status).toBe('active');
      expect(workspaceService.get('hand-edited')?.trashedAt).toBeUndefined();
    });

    it('dates a move to the Trash, keeps the date across updates and drops it on restore', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([saved('ws-1')]));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      vi.setSystemTime(20_000);
      workspaceService.update('ws-1', { status: 'trashed' });
      vi.setSystemTime(30_000);
      workspaceService.update('ws-1', { status: 'trashed', order: 3 });
      expect(workspaceService.get('ws-1')?.trashedAt).toBe(20_000);

      vi.advanceTimersByTime(600);
      await Promise.resolve();
      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)![1] as string) as Array<
        Record<string, unknown>
      >;
      expect(written[0]).toMatchObject({ status: 'trashed', trashedAt: 20_000 });

      workspaceService.update('ws-1', { status: 'active' });
      expect(workspaceService.get('ws-1')?.trashedAt).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update workspace properties', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Old Name',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const updated = workspaceService.update('ws-1', { name: 'New Name', categoryId: 'cat-1' });

      expect(updated.name).toBe('New Name');
      expect(updated.categoryId).toBe('cat-1');
    });

    it('should not change lastActivityAt', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const updated = workspaceService.update('ws-1', { name: 'Updated' });

      expect(updated.lastActivityAt).toBe(1000);
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.update('non-existent', { name: 'Test' })).toThrow(
        'Workspace non-existent not found'
      );
    });

    it('should register project baseBranch when workspace baseBranch override is cleared', async () => {
      mockProjectService.get.mockReturnValue(
        createProject({ id: 'project-1', baseBranch: 'develop' })
      );

      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          baseBranch: 'feature-branch',
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Clear the workspace baseBranch override
      workspaceService.update('ws-1', { baseBranch: undefined });

      // Should fall back to project baseBranch, not delete the registration
      expect(mockGitService.registerTargetBranch).toHaveBeenCalledWith('/ws1', 'develop');
    });

    it('should register workspace baseBranch when explicitly set', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.update('ws-1', { baseBranch: 'main' });

      expect(mockGitService.registerTargetBranch).toHaveBeenCalledWith('/ws1', 'main');
    });

    it('should synchronize an SSH backend when its baseBranch changes', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'feature',
            baseBranch: 'main',
          },
          branchName: 'feature',
          baseBranch: 'main',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const updated = workspaceService.update('ssh-ws', { baseBranch: 'develop' });

      expect(updated.backend).toMatchObject({ kind: 'ssh', baseBranch: 'develop' });
    });

    it('should restore the resolved SSH default when its baseBranch override is cleared', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'feature',
            baseBranch: 'trunk',
            defaultBranch: 'trunk',
          },
          branchName: 'feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.update('ssh-ws', { baseBranch: 'release' });
      const updated = workspaceService.update('ssh-ws', { baseBranch: undefined });

      expect(updated.baseBranch).toBeUndefined();
      expect(updated.backend).toMatchObject({
        kind: 'ssh',
        baseBranch: 'trunk',
        defaultBranch: 'trunk',
      });
    });

    it('reconfigures a running SSH companion when its target branch changes', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'feature',
            baseBranch: 'main',
          },
          branchName: 'feature',
          baseBranch: 'main',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          status: 'active',
          terminals: [
            {
              id: 'term-live',
              name: 'Agent',
              status: 'running',
              remoteSessionActive: true,
              createdAt: 1001,
              executionLocation: 'workspace',
            },
          ],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.update('ssh-ws', { baseBranch: 'develop' });

      await vi.waitFor(() =>
        expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            workspaces: [
              expect.objectContaining({ workspaceId: 'ssh-ws', targetBranch: 'develop' }),
            ],
          })
        )
      );
    });

    it('does not start a remote companion for a running Local copy terminal', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'feature',
            baseBranch: 'main',
          },
          branchName: 'feature',
          baseBranch: 'main',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          status: 'active',
          terminals: [],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.addTerminal(
        'ssh-ws',
        'Local app',
        'npm run dev',
        undefined,
        'host',
        'local-mirror',
        async () => {}
      );
      workspaceService.update('ssh-ws', { baseBranch: 'develop' });
      await vi.advanceTimersByTimeAsync(1);

      expect(mockSshWorkspaceService.ensureRemoteNotificationScript).not.toHaveBeenCalled();
      expect(mockRemoteCompanionService.ensureRunning).not.toHaveBeenCalled();
      expect(mockSshPortForwardService.stopKomlaDataTunnelsExcept).toHaveBeenCalledWith(new Set());
    });

    it('should synchronize an SSH backend when its branchName changes', async () => {
      const existingWorkspaces = [
        {
          id: 'ssh-ws',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'feature',
          },
          branchName: 'feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const updated = workspaceService.update('ssh-ws', { branchName: 'develop' });

      expect(updated.branchName).toBe('develop');
      expect(updated.backend).toMatchObject({ kind: 'ssh', branchName: 'develop' });
    });

    it('should synchronize inherited SSH backend base branches after a project update', async () => {
      mockProjectService.get.mockReturnValue(
        createProject({ id: 'project-1', baseBranch: 'develop' })
      );
      const existingWorkspaces = [
        {
          id: 'ssh-ws',
          name: 'Remote Workspace',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'https://github.com/example/repo.git',
            branchName: 'feature',
            baseBranch: 'main',
          },
          branchName: 'feature',
          isWorktree: true,
          projectId: 'project-1',
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
          status: 'active',
          terminals: [
            {
              id: 'term-live',
              name: 'Agent',
              remoteSessionActive: true,
              createdAt: 1001,
              executionLocation: 'workspace',
            },
          ],
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.propagateProjectBaseBranch('project-1');

      expect(workspaceService.get('ssh-ws')?.backend).toMatchObject({
        kind: 'ssh',
        baseBranch: 'develop',
      });
      await vi.waitFor(() =>
        expect(mockRemoteCompanionService.ensureRunning).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            workspaces: [
              expect.objectContaining({ workspaceId: 'ssh-ws', targetBranch: 'develop' }),
            ],
          })
        )
      );
    });

    it.each([
      ['local-mirror-actions', false],
      ['local-mirror-actions', true],
      ['remote', false],
      ['remote', true],
    ] as const)('syncs snapshots in %s mode only when a copy exists (%s)', async (mode, exists) => {
      mockConfigService.get.mockReturnValue({ defaultSshWorkspaceMode: mode });
      mockLocalMirrorService.hasMirror.mockReturnValue(exists);
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'https://github.com/example/repo.git',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            branchName: 'feature',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );

      await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');

      await workspaceStatusService.change({ kind: 'repository-mutated', workspaceId: 'ssh-ws' });
      expect(mockLocalMirrorService.requestSync).not.toHaveBeenCalled();

      await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: 'ssh-ws',
          source: { kind: 'remote-companion', sequence: 1 },
          observedAt: Date.now(),
          stateHash: 'after-mutation',
          cwd: backend.remoteDirectory,
          statusB64: '',
          numstatB64: '',
          branch: { currentBranch: 'feature', targetBranch: 'main' },
        },
      });

      if (exists) {
        expect(mockLocalMirrorService.requestSync).toHaveBeenCalledExactlyOnceWith(
          'ssh-ws',
          backend
        );
      } else {
        expect(mockLocalMirrorService.requestSync).not.toHaveBeenCalled();
      }
    });

    it('should request a mirror sync while an explicit local mirror terminal is open', async () => {
      mockLocalMirrorService.hasMirror.mockReturnValue(true);
      mockConfigService.get.mockReturnValue({ defaultSshWorkspaceMode: 'remote' });
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'https://github.com/example/repo.git',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            branchName: 'feature',
            isWorktree: true,
            projectId: 'project-1',
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');
      workspaceService.addTerminal(
        'ssh-ws',
        'Local mirror',
        null,
        undefined,
        'host-shell',
        'local-mirror'
      );

      await workspaceStatusService.change({ kind: 'repository-mutated', workspaceId: 'ssh-ws' });
      expect(mockLocalMirrorService.requestSync).not.toHaveBeenCalled();

      await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          workspaceId: 'ssh-ws',
          source: { kind: 'remote-companion', sequence: 1 },
          observedAt: Date.now(),
          stateHash: 'after-mutation',
          cwd: backend.remoteDirectory,
          statusB64: '',
          numstatB64: '',
          branch: { currentBranch: 'feature', targetBranch: 'main' },
        },
      });

      expect(mockLocalMirrorService.requestSync).toHaveBeenCalledExactlyOnceWith('ssh-ws', backend);
    });

    it('broadcasts local mirror sync status to renderer windows', async () => {
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
      await import('../../../src/main/services/workspace.service');

      mockLocalMirrorSyncStatusListener?.({ workspaceId: 'ssh-ws', state: 'syncing' });

      expect(send).toHaveBeenCalledWith('workspace:local-mirror-sync-status', {
        workspaceId: 'ssh-ws',
        state: 'syncing',
      });
    });

    it('retries a failed local mirror sync for an SSH workspace', async () => {
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'https://github.com/example/repo.git',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ssh-ws',
            name: 'Remote Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend,
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.retryLocalMirrorSync('ssh-ws');

      expect(mockLocalMirrorService.requestSync).toHaveBeenCalledWith('ssh-ws', backend, 'retry');
    });
  });

  describe('updateTerminal', () => {
    it('should update terminal properties', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      const updated = workspaceService.updateTerminal(terminal.id, {
        name: 'Renamed Terminal',
        dynamicTitle: 'Running tests',
      });

      expect(updated.name).toBe('Renamed Terminal');
      expect(updated.dynamicTitle).toBe('Running tests');
    });

    it('should throw if terminal not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.updateTerminal('non-existent', { name: 'Test' })).toThrow(
        'Terminal non-existent not found'
      );
    });
  });

  describe('updateTerminalStatus', () => {
    it('should update terminal status', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      workspaceService.updateTerminalStatus(terminal.id, 'stopped');

      expect(terminal.status).toBe('stopped');
    });

    it('should not throw for non-existent terminal', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Should not throw
      workspaceService.updateTerminalStatus('non-existent', 'stopped');
    });
  });

  // ============================================================================
  // Reorder Tests
  // ============================================================================

  describe('reorderWorkspace', () => {
    it('should reorder workspace and shift others', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'First',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
        {
          id: 'ws-2',
          name: 'Second',
          workingDirectory: '/ws2',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 2000,
          lastActivityAt: 2000,
          order: 1,
        },
        {
          id: 'ws-3',
          name: 'Third',
          workingDirectory: '/ws3',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 3000,
          lastActivityAt: 3000,
          order: 2,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // Move first to last position
      workspaceService.reorderWorkspace('ws-1', 2);

      expect(workspaceService.get('ws-1')?.order).toBe(2);
      expect(workspaceService.get('ws-2')?.order).toBe(0);
      expect(workspaceService.get('ws-3')?.order).toBe(1);
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.reorderWorkspace('non-existent', 0)).toThrow(
        'Workspace non-existent not found'
      );
    });
  });

  // ============================================================================
  // Window Management Tests
  // ============================================================================

  describe('moveWorkspaceToWindow', () => {
    it('should update workspace windowId', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.moveWorkspaceToWindow('ws-1', 'window-123');

      expect(workspaceService.get('ws-1')?.windowId).toBe('window-123');
    });

    it('should throw if workspace not found', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', '[]');

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(() => workspaceService.moveWorkspaceToWindow('non-existent', 'window-123')).toThrow(
        'Workspace non-existent not found'
      );
    });
  });

  describe('assignUnassignedToMainWindow', () => {
    it('should assign unassigned workspaces to main window', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Unassigned',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
        {
          id: 'ws-2',
          name: 'Assigned',
          workingDirectory: '/ws2',
          isWorktree: false,
          projectId: null,
          windowId: 'other-window',
          categoryId: null,
          createdAt: 2000,
          lastActivityAt: 2000,
          order: 1,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.assignUnassignedToMainWindow('main-window');

      expect(workspaceService.get('ws-1')?.windowId).toBe('main-window');
      // Note: windowId is reset to null on load, so ws-2 would also be null
    });
  });

  describe('reassignWindowWorkspaces', () => {
    it('should reassign workspaces from closing window to target', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: 'closing-window',
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      // First assign the workspace to closing-window
      workspaceService.moveWorkspaceToWindow('ws-1', 'closing-window');

      const affected = workspaceService.reassignWindowWorkspaces('closing-window', 'target-window');

      expect(affected).toContain('ws-1');
      expect(workspaceService.get('ws-1')?.windowId).toBe('target-window');
    });
  });

  describe('setPaneSurfaceWorkspaces', () => {
    it('keeps a workspace running while any window shows its browser or note pane', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      workspaceService.setPaneSurfaceWorkspaces('window-1', ['ws-1']);
      workspaceService.setPaneSurfaceWorkspaces('window-2', ['ws-1']);
      expect(workspaceService.get('ws-1')?.showsPaneSurfaces).toBe(true);
      expect(workspaceService.getRunningWorkspaceCount()).toBe(1);

      workspaceService.setPaneSurfaceWorkspaces('window-1', []);
      expect(workspaceService.get('ws-1')?.showsPaneSurfaces).toBe(true);

      workspaceService.clearWindowPaneSurfaces('window-2');
      expect(workspaceService.get('ws-1')?.showsPaneSurfaces).toBeUndefined();
      expect(workspaceService.getRunningWorkspaceCount()).toBe(0);
    });
  });

  // ============================================================================
  // Attention Management Tests
  // ============================================================================

  describe('persisted attention', () => {
    it('restores uncleared attention for a persisted SSH terminal', async () => {
      const attention = {
        kind: 'input-required' as const,
        source: 'codex',
        updatedAt: 2_000,
        title: 'Review ready',
        body: 'Authentication changes are waiting.',
        color: 'oklch(62% 0.2 285)',
        badge: 'Review',
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        iconColor: 'foreground',
        terminalId: 'terminal-1',
      };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-ssh',
            name: 'Remote',
            workingDirectory: 'ssh://host-1/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'host-1',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.test:repo.git',
              projectName: 'Repo',
              branchName: 'feature',
            },
            isWorktree: true,
            projectId: null,
            terminals: [
              {
                id: 'terminal-1',
                name: 'Agent',
                createdAt: 1_000,
                remoteSessionActive: true,
                attention,
              },
            ],
            attention,
            needsAttention: true,
            windowId: null,
            categoryId: null,
            createdAt: 1_000,
            lastActivityAt: 1_000,
            order: 0,
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-ssh')?.attention).toEqual(attention);
      expect(workspaceService.get('ws-ssh')?.terminals[0]?.attention).toEqual(attention);
      expect(workspaceService.get('ws-ssh')?.needsAttention).toBe(true);
    });

    it('counts restored attention in the dock badge', async () => {
      const done = { kind: 'turn-complete' as const, source: 'codex', updatedAt: 2_000 };
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-ssh',
            name: 'Remote',
            workingDirectory: 'ssh://host-1/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'host-1',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.test:repo.git',
              projectName: 'Repo',
              branchName: 'feature',
            },
            isWorktree: true,
            projectId: null,
            terminals: [],
            attention: done,
            needsAttention: true,
            windowId: null,
            categoryId: null,
            createdAt: 1_000,
            lastActivityAt: 1_000,
            order: 0,
          },
        ])
      );
      const { electronAttentionWindows } =
        await import('../../../src/main/services/terminal-attention/windows');
      const badge = vi.spyOn(electronAttentionWindows, 'badge');

      await import('../../../src/main/services/workspace.service');

      expect(badge).toHaveBeenLastCalledWith(1);
    });
  });

  describe('active agent source tracking', () => {
    const baseWorkspace = {
      id: 'ws-1',
      name: 'Workspace',
      workingDirectory: '/ws1',
      isWorktree: false,
      projectId: null,
      windowId: null,
      categoryId: null,
      createdAt: 1000,
      lastActivityAt: 1000,
      order: 0,
    };

    async function loadService() {
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([baseWorkspace]));
      return (await import('../../../src/main/services/workspace.service')).workspaceService;
    }

    it('restores durable terminal-scoped activity for a managed SSH session', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...baseWorkspace,
            id: 'ws-ssh',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            terminals: [
              {
                id: 'terminal-1',
                name: 'Agent',
                createdAt: 1_001,
                remoteSessionActive: true,
                activeAgentSources: {
                  codex: 1,
                  ignoredZeroCount: 0,
                  ignoredStringCount: '1',
                  ['x'.repeat(65)]: 1,
                },
              },
            ],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-ssh')?.agentActive).toBe(true);
      expect(workspaceService.getTerminal('terminal-1')?.agentActive).toBe(true);
      expect(workspaceService.attention.persistedSources('ws-ssh', 'terminal-1')).toEqual({
        codex: 1,
      });

      workspaceService.attention.sessionGone('terminal-1');
      expect(workspaceService.get('ws-ssh')?.agentActive).toBe(false);
    });

    it('persists terminal-scoped activity before acknowledging an SSH hook', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...baseWorkspace,
            id: 'ws-ssh',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            terminals: [
              {
                id: 'terminal-1',
                name: 'Agent',
                createdAt: 1_001,
                remoteSessionActive: true,
              },
            ],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      await hookTerminal(workspaceService, 'terminal-1', { kind: 'activity', source: 'codex' });

      await workspaceService.persistSshAttention('ws-ssh');

      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)?.[1] as string) as Array<{
        terminals?: Array<{ activeAgentSources?: Record<string, number> }>;
      }>;
      expect(written[0]?.terminals?.[0]?.activeAgentSources).toEqual({ codex: 1 });
    });

    it('saves a background run ending on an SSH workspace at once', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...baseWorkspace,
            id: 'ws-ssh',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            terminals: [],
          },
        ])
      );
      const { workspaceSetupService } =
        await import('../../../src/main/services/workspace-setup.service');
      const configure = vi.spyOn(workspaceSetupService, 'configure');
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const dependencies = configure.mock.calls[0][0];
      const persist = vi.spyOn(workspaceService, 'persistSshAttention');

      dependencies.notifyActionRunFinished(workspaceService.get('ws-ssh')!, {
        id: 'run-1',
        workspaceId: 'ws-ssh',
        setupRunId: 'action-run-1',
        stepId: 'watch-ci',
        stepName: 'Watch CI',
        actionId: 'watch-ci',
        retryable: true,
        state: 'failed',
        startedAt: 0,
        completedAt: 1_000,
        exitCode: 1,
        output: '',
      });
      await vi.waitFor(() => expect(persist).toHaveBeenCalledWith('ws-ssh'));

      expect(workspaceService.get('ws-ssh')?.attention).toMatchObject({
        kind: 'error',
        title: 'Watch CI',
      });
    });

    it('persists the accepted delivery id with remote terminal attention state', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...baseWorkspace,
            id: 'ws-ssh',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            terminals: [
              {
                id: 'terminal-1',
                name: 'Agent',
                createdAt: 1_001,
                remoteSessionActive: true,
              },
            ],
          },
        ])
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      await workspaceService.persistSshAttention('ws-ssh', {
        terminalId: 'terminal-1',
        deliveryId: 'delivery-1',
      });

      const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)?.[1] as string) as Array<{
        terminals?: Array<{ lastAcceptedHookDeliveryId?: string }>;
      }>;
      expect(written[0]?.terminals?.[0]?.lastAcceptedHookDeliveryId).toBe('delivery-1');
      expect(workspaceService.hasAcceptedTerminalHook('terminal-1', 'delivery-1')).toBe(true);
    });

    it('does not report a terminal hook as accepted while its persistence is pending', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            ...baseWorkspace,
            id: 'ws-ssh',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.com:repo.git',
            },
            terminals: [
              {
                id: 'terminal-1',
                name: 'Agent',
                createdAt: 1_001,
                remoteSessionActive: true,
              },
            ],
          },
        ])
      );
      let finishWrite!: () => void;
      mockWriteFileAtomic.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          })
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const persistence = workspaceService.persistSshAttention('ws-ssh', {
        terminalId: 'terminal-1',
        deliveryId: 'delivery-1',
      });

      expect(workspaceService.hasAcceptedTerminalHook('terminal-1', 'delivery-1')).toBe(false);
      await vi.waitFor(() => expect(mockWriteFileAtomic).toHaveBeenCalled());
      finishWrite();
      await persistence;
      expect(workspaceService.hasAcceptedTerminalHook('terminal-1', 'delivery-1')).toBe(true);
    });

    it('clears active sources when the pty emits abort for a terminal in the workspace', async () => {
      mockPtyService.onAbort.mockClear();
      const workspaceService = await loadService();

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await workspaceService.attention.hook(
        { workspace: workspaceService.get('ws-1'), hasInvalidTerminalId: false },
        { kind: 'prompt-submit', source: 'claude-code' }
      );

      const abortHandler = mockPtyService.onAbort.mock.calls.at(-1)?.[0] as (
        terminalId: string
      ) => void;
      expect(abortHandler).toBeTypeOf('function');
      abortHandler(terminal.id);

      expect(workspaceService.get('ws-1')?.agentActive).toBe(false);
    });

    it('clears active sources when the pty emits exit for a terminal in the workspace', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();

      const terminal = workspaceService.addTerminal('ws-1', 'Terminal 1');
      await workspaceService.attention.hook(
        { workspace: workspaceService.get('ws-1'), hasInvalidTerminalId: false },
        { kind: 'prompt-submit', source: 'codex' }
      );

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string
      ) => void;
      expect(exitHandler).toBeTypeOf('function');
      exitHandler(terminal.id);

      expect(workspaceService.get('ws-1')?.agentActive).toBe(false);
    });

    it('clears persisted activity when reconnect creates a replacement Managed Remote Terminal Session', async () => {
      mockPtyService.onManagedRemoteTerminalSessionReplaced.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const terminal = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      await hookTerminal(workspaceService, terminal.id, { kind: 'activity', source: 'codex' });

      const replacementHandler =
        mockPtyService.onManagedRemoteTerminalSessionReplaced.mock.calls.at(-1)?.[0] as (
          terminalId: string
        ) => void;
      expect(replacementHandler).toBeTypeOf('function');
      replacementHandler(terminal.id);

      expect(terminal.agentActive).toBe(false);
      expect(workspace.agentActive).toBe(false);
    });

    it('keeps the SSH data tunnel when the remote session survives a pty exit', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const terminal = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      terminal.status = 'running';
      terminal.remoteSessionActive = true;
      terminal.remoteSessionResumable = true;
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set([terminal.id]));
      mockSshPortForwardService.stopKomlaDataTunnelsExcept.mockClear();

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string
      ) => void;
      exitHandler(terminal.id);

      expect(terminal.remoteSessionActive).toBe(true);
      await vi.waitFor(() =>
        expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
          workspace.backend,
          [terminal.id]
        )
      );
      expect(terminal).toEqual(
        expect.objectContaining({
          status: 'stopped',
          remoteSessionActive: true,
          remoteSessionResumable: true,
        })
      );
      expect(mockSshPortForwardService.stopKomlaDataTunnelsExcept).toHaveBeenCalledWith(
        new Set(['ssh-dev'])
      );
    });

    it('keeps why ssh failed on the terminal until it runs again', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const terminal = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      terminal.status = 'running';
      terminal.remoteSessionActive = true;
      terminal.remoteSessionResumable = true;
      mockSshWorkspaceService.findTerminalSessions.mockRejectedValue(new Error('offline'));

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string,
        exit?: { exitCode: number; output: string }
      ) => void;
      exitHandler(terminal.id, {
        exitCode: 255,
        output: 'ssh: connect to host devbox port 22: Network is unreachable\r\n',
      });

      expect(terminal.connectionError).toBe(
        'ssh: connect to host devbox port 22: Network is unreachable'
      );
      // Nothing in it is saved: the next launch tries again from scratch.
      await vi.waitFor(() => expect(workspaceFileWrites().length).toBeGreaterThan(0));
      for (const [, contents] of workspaceFileWrites()) {
        expect(contents).not.toContain('Network is unreachable');
      }

      mockPtyStatusListener?.(terminal.id, 'running');
      expect(terminal.connectionError).toBeUndefined();
    });

    it('records no connection failure when the remote command itself exits', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const terminal = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      terminal.status = 'running';
      terminal.connectionError = 'ssh: an earlier failure';

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string,
        exit?: { exitCode: number; output: string }
      ) => void;
      exitHandler(terminal.id, { exitCode: 0, output: 'logout\r\n' });

      expect(terminal.connectionError).toBeUndefined();
    });

    it('coalesces simultaneous SSH pty exits into one remote session check', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const first = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      const second = await workspaceService.addTerminal('ws-1', 'Terminal 2');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalledTimes(2));
      for (const terminal of [first, second]) {
        terminal.status = 'running';
        terminal.remoteSessionActive = true;
        terminal.remoteSessionResumable = true;
      }
      mockSshWorkspaceService.findTerminalSessions.mockClear();
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(
        new Set([first.id, second.id])
      );

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string
      ) => void;
      exitHandler(first.id);
      await Promise.resolve();
      exitHandler(second.id);

      await vi.waitFor(() =>
        expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
          workspace.backend,
          [first.id, second.id]
        )
      );
      expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledTimes(1);
    });

    it('stops the SSH data tunnel when a pty exit confirms the remote session ended', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const terminal = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      terminal.status = 'running';
      terminal.remoteSessionActive = true;
      terminal.remoteSessionResumable = true;
      await hookTerminal(workspaceService, terminal.id, { kind: 'activity', source: 'codex' });
      mockSshWorkspaceService.findTerminalSessions.mockResolvedValue(new Set());
      mockSshPortForwardService.stopKomlaDataTunnelsExcept.mockClear();

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string
      ) => void;
      exitHandler(terminal.id);

      expect(terminal.remoteSessionActive).toBe(true);
      await vi.waitFor(() =>
        expect(terminal).toEqual(
          expect.objectContaining({
            remoteSessionActive: false,
            remoteSessionResumable: true,
            agentActive: false,
          })
        )
      );
      expect(workspace.agentActive).toBe(false);
      expect(mockSshPortForwardService.stopKomlaDataTunnelsExcept).toHaveBeenCalledWith(new Set());
    });

    it('keeps the SSH data tunnel when remote session confirmation fails', async () => {
      mockPtyService.onExit.mockClear();
      const workspaceService = await loadService();
      const workspace = workspaceService.get('ws-1')!;
      workspace.backend = {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      };
      const terminal = await workspaceService.addTerminal('ws-1', 'Terminal 1');
      await vi.waitFor(() => expect(mockPtyService.spawn).toHaveBeenCalled());
      terminal.status = 'running';
      terminal.remoteSessionActive = true;
      terminal.remoteSessionResumable = true;
      await hookTerminal(workspaceService, terminal.id, { kind: 'activity', source: 'codex' });
      mockSshWorkspaceService.findTerminalSessions.mockRejectedValue(new Error('offline'));
      mockSshPortForwardService.stopKomlaDataTunnelsExcept.mockClear();

      const exitHandler = mockPtyService.onExit.mock.calls.at(-1)?.[0] as (
        terminalId: string
      ) => void;
      exitHandler(terminal.id);

      await vi.waitFor(() =>
        expect(mockSshWorkspaceService.findTerminalSessions).toHaveBeenCalledWith(
          workspace.backend,
          [terminal.id]
        )
      );
      await Promise.resolve();
      expect(terminal).toEqual(
        expect.objectContaining({
          status: 'stopped',
          remoteSessionActive: true,
          remoteSessionResumable: true,
          agentActive: true,
        })
      );
      expect(workspace.agentActive).toBe(true);
      expect(mockSshPortForwardService.stopKomlaDataTunnelsExcept).not.toHaveBeenCalled();
    });
  });

  describe('Workspace Status refresh', () => {
    it('should call restartWatching with correct workspace directory', async () => {
      const existingWorkspaces = [
        {
          id: 'ws-1',
          name: 'Workspace',
          workingDirectory: '/ws1',
          isWorktree: false,
          projectId: null,
          windowId: null,
          categoryId: null,
          createdAt: 1000,
          lastActivityAt: 1000,
          order: 0,
        },
      ];
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify(existingWorkspaces));

      await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');

      await workspaceStatusService.change({ kind: 'refresh-requested', workspaceId: 'ws-1' });

      expect(mockWorktreeWatcherService.restartWatching).toHaveBeenCalledWith('ws-1', '/ws1');
    });

    it('uses the Komla CLI snapshot for a manual SSH refresh', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-ssh',
            name: 'SSH Workspace',
            workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
            isWorktree: true,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            backend: {
              kind: 'ssh',
              hostId: 'ssh-dev',
              remoteDirectory: '/home/dev/worktree',
              remoteRepoPath: '/home/dev/repo.git',
              remoteProjectRoot: '/home/dev',
              gitUrl: 'git@example.test:repo.git',
              projectName: 'Repo',
              branchName: 'feature',
            },
          },
        ])
      );
      await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');

      await workspaceStatusService.change({ kind: 'refresh-requested', workspaceId: 'ws-ssh' });

      expect(mockSshWorkspaceGit.getSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: 'ssh-dev' }),
        'main'
      );
      expect(mockSshWorkspaceDiff.getWorkingTreeDiff).not.toHaveBeenCalled();
    });

    it('should throw for unknown workspace', async () => {
      vfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([]));

      await import('../../../src/main/services/workspace.service');
      const { workspaceStatusService } =
        await import('../../../src/main/services/workspace-status.service');

      await expect(
        workspaceStatusService.change({ kind: 'refresh-requested', workspaceId: 'unknown' })
      ).rejects.toThrow('Workspace unknown not found');
    });
  });

  // ============================================================================
  // Auto-naming Tests
  // ============================================================================

  describe('auto-naming workspaces', () => {
    it('should auto-name using the utility inference service', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockAgentPresetService.getActive.mockReturnValueOnce(null);
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Fix Auth',
        description: 'Fix the authentication bug in login.ts',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-autoname',
        initialPrompt: 'Fix the authentication bug in login.ts',
      });

      // Allow the async auto-naming to complete
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Fix Auth');
      expect(updated?.customDescription).toBe('Fix the authentication bug in login.ts');
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        'Fix the authentication bug in login.ts',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('skips auto-naming when no AI helper is available, as in a build from source', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockAgentPresetService.getActive.mockReturnValueOnce(null);
      mockUtilityInferenceService.isAvailable.mockReturnValue(false);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-autoname',
        initialPrompt: 'Fix the authentication bug in login.ts',
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(mockUtilityInferenceService.labelWorkspace).not.toHaveBeenCalled();
      expect(workspaceService.get(workspace.id)?.customName).toBeUndefined();
    });

    it('tells hooks about a new workspace once it has its name', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockAgentPresetService.getActive.mockReturnValueOnce(null);
      let finishNaming!: (label: { title: string; description: string }) => void;
      mockUtilityInferenceService.labelWorkspace.mockReturnValueOnce(
        new Promise((resolve) => {
          finishNaming = resolve;
        })
      );
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { onHookEvent } = await import('../../../src/main/lib/hook-events');
      const events: string[] = [];
      const stop = onHookEvent((details) =>
        events.push(`${details.event}:${workspaceService.get(details.workspaceId)?.customName}`)
      );

      await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-created-hook',
        initialPrompt: 'Fix the authentication bug in login.ts',
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual([]);

      finishNaming({ title: 'Fix Auth', description: 'Fix the authentication bug' });
      await vi.advanceTimersByTimeAsync(100);
      stop();
      expect(events).toEqual(['workspace.created:Fix Auth']);
    });

    it('tells hooks about a workspace moved to the Trash, once', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      mockAgentPresetService.getActive.mockReturnValueOnce(null);
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { onHookEvent } = await import('../../../src/main/lib/hook-events');
      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-trashed-hook',
      });
      const events: string[] = [];
      const stop = onHookEvent((details) => events.push(`${details.event}:${details.workspaceId}`));

      workspaceService.update(workspace.id, { status: 'trashed' });
      workspaceService.update(workspace.id, { status: 'trashed' });
      workspaceService.update(workspace.id, { status: 'active' });
      stop();
      expect(events).toEqual([`workspace.trashed:${workspace.id}`]);
    });

    it('tells hooks about a new workspace without waiting long for a name', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockAgentPresetService.getActive.mockReturnValueOnce(null);
      mockUtilityInferenceService.labelWorkspace.mockReturnValueOnce(new Promise(() => {}));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const { onHookEvent } = await import('../../../src/main/lib/hook-events');
      const events: string[] = [];
      const stop = onHookEvent((details) => events.push(details.event));

      await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-created-hook-slow',
        initialPrompt: 'Fix the authentication bug in login.ts',
      });
      await vi.advanceTimersByTimeAsync(15_100);
      stop();
      expect(events).toEqual(['workspace.created']);
    });

    it('should normalize overlong utility-generated titles before applying them', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: `  ${'B'.repeat(70)}  `,
        description: 'Fix the authentication bug in login.ts',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-autoname-trim',
        initialPrompt: 'Fix the authentication bug in login.ts',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('B'.repeat(50));
    });

    it('should uppercase the first letter of non-deferred utility-generated titles', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'auth token fix',
        description: 'Fix expired tokens not refreshing on API calls',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-autoname-uppercase',
        initialPrompt: 'fix auth token refresh',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Auth token fix');
    });

    it('should skip auto-naming when setting is disabled', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-noautoname',
        initialPrompt: 'Some task',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBeUndefined();
      expect(mockUtilityInferenceService.labelWorkspace).not.toHaveBeenCalled();
    });

    it('should skip auto-naming when customName is already set', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-customname',
        initialPrompt: 'Some task',
        customName: 'My Custom Name',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('My Custom Name');
      expect(mockUtilityInferenceService.labelWorkspace).not.toHaveBeenCalled();
    });

    it('should clear autoNaming when utility inference fails', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockRejectedValueOnce(
        new Error('utility unavailable')
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-timeout',
        initialPrompt: 'Some task',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBeUndefined();
      expect(updated?.autoNaming).toBe(false);
    });

    it('should auto-name worktree-mode workspace with initialPrompt (no setup steps)', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Refactor Auth',
        description: 'Refactor the authentication flow to use OAuth2',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'worktree',
        projectId: 'project-1',
        initialPrompt: 'Refactor the authentication flow to use OAuth2',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Refactor Auth');
      expect(updated?.customDescription).toBe('Refactor the authentication flow to use OAuth2');
      expect(updated?.isWorktree).toBe(true);
    });

    it('should auto-name worktree-mode workspace with setup steps', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Add OAuth',
        description: 'Add OAuth support to the login page',
      });

      // Override project to include a setup step so applySetupSteps returns a terminal
      const projectWithSteps = createProject({
        id: 'project-1',
        name: 'Test Project',
        repositoryPath: '/mock/repo',
        defaultBranchPrefix: 'agent/',
        setupSteps: [createTabStep({ name: 'Dev Server', command: 'npm run dev' })],
      });
      mockProjectService.get.mockReturnValue(projectWithSteps);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'worktree',
        projectId: 'project-1',
        initialPrompt: 'Add OAuth support to the login page',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Add OAuth');
      expect(updated?.customDescription).toBe('Add OAuth support to the login page');
      expect(updated?.isWorktree).toBe(true);
    });

    it('should skip auto-naming when utility inference returns null title', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: null,
        description: null,
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-null-title',
        initialPrompt: 'hi',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBeUndefined();
      expect(updated?.autoNaming).toBe(false);
    });

    it('should apply title but skip null description', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Quick Task',
        description: null,
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-null-desc',
        initialPrompt: 'do something',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Quick Task');
      expect(updated?.customDescription).toBeUndefined();
    });

    it('should cancel in-flight auto-naming requests when deleting a workspace', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let abortedSignal: AbortSignal | undefined;
      mockUtilityInferenceService.labelWorkspace.mockImplementationOnce(
        async (_prompt: string, options?: { signal?: AbortSignal }) => {
          abortedSignal = options?.signal;
          return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () => reject(createAbortError()));
          });
        }
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-cancel',
        initialPrompt: 'Some long running task',
      });

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      await workspaceService.delete(workspace.id);

      expect(abortedSignal?.aborted).toBe(true);
    });
  });

  // ============================================================================
  // Prompt-submit rename history
  // ============================================================================

  describe('agent turn activity', () => {
    const createWorkspaceForTurns = async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-turn-activity',
      });
      return { workspaceService, workspaceId: workspace.id, createdAt: Date.now() };
    };

    it('counts as workspace activity at most once a minute, saved and sent to the windows', async () => {
      const { workspaceService, workspaceId, createdAt } = await createWorkspaceForTurns();
      const send = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow(send)]);
      await vi.advanceTimersByTimeAsync(600);
      mockWriteFileAtomic.mockClear();

      vi.setSystemTime(createdAt + 59_000);
      workspaceService.recordAgentTurnActivity(workspaceId);
      expect(workspaceService.get(workspaceId)?.lastActivityAt).toBe(createdAt);
      expect(send).not.toHaveBeenCalled();

      vi.setSystemTime(createdAt + 60_000);
      workspaceService.recordAgentTurnActivity(workspaceId);
      expect(workspaceService.get(workspaceId)?.lastActivityAt).toBe(createdAt + 60_000);
      expect(send).toHaveBeenCalledWith(
        IPC.WORKSPACE_UPDATED,
        expect.objectContaining({ id: workspaceId, lastActivityAt: createdAt + 60_000 })
      );
      await vi.advanceTimersByTimeAsync(600);
      const written = JSON.parse(workspaceFileWrites().at(-1)?.[1] as string) as Workspace[];
      expect(written.find((saved) => saved.id === workspaceId)?.lastActivityAt).toBe(
        createdAt + 60_000
      );
    });

    it('replaces an activity time ahead of this clock', async () => {
      const { workspaceService, workspaceId, createdAt } = await createWorkspaceForTurns();
      workspaceService.get(workspaceId)!.lastActivityAt = createdAt + 60 * 60 * 1000;

      workspaceService.recordAgentTurnActivity(workspaceId);

      expect(workspaceService.get(workspaceId)?.lastActivityAt).toBe(createdAt);
    });

    it('leaves a trashed workspace as it was', async () => {
      const { workspaceService, workspaceId, createdAt } = await createWorkspaceForTurns();
      workspaceService.get(workspaceId)!.status = 'trashed';

      vi.setSystemTime(createdAt + 60_000);
      workspaceService.recordAgentTurnActivity(workspaceId);

      expect(workspaceService.get(workspaceId)?.lastActivityAt).toBe(createdAt);
    });
  });

  describe('workspace tags', () => {
    it('keeps a tag through prompts: it stays until it is taken off', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-tag-stays',
      });
      workspaceService.update(workspace.id, { tag: 'In review' });

      workspaceService.recordPromptSubmit(workspace.id, 'Address the review comments');

      expect(workspaceService.get(workspace.id)?.tag).toBe('In review');
    });

    it("drops a script's tooltip once the tag changes, but not when it stays", async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-tag-tooltip',
      });
      workspaceService.update(workspace.id, { tag: 'CI running', tagTooltip: 'build 7 of 9' });
      workspaceService.update(workspace.id, { tag: 'CI running' });
      expect(workspaceService.get(workspace.id)?.tagTooltip).toBe('build 7 of 9');

      workspaceService.update(workspace.id, { tag: 'CI failed' });
      expect(workspaceService.get(workspace.id)?.tagTooltip).toBeUndefined();
    });
  });

  describe('prompt-submit rename history', () => {
    it('should not store new workspace initial prompts as prompt submits', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-initial-prompt-history',
        initialPrompt: 'Create the billing dashboard',
      });

      expect(workspace.promptSubmits).toBeUndefined();
      await expect(workspaceService.regenerateWorkspaceName(workspace.id)).rejects.toThrow(
        'No recorded prompts'
      );
    });

    it('should auto-name from the first prompt submit when the workspace has no custom name', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Login Redirect',
        description: 'Fix the login redirect bug',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Login Redirect');
      expect(updated?.customDescription).toBe('Fix the login redirect bug');
      expect(updated?.promptSubmits).toEqual([
        expect.objectContaining({ prompt: 'Fix the login redirect bug' }),
      ]);
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        'Fix the login redirect bug',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should regenerate generated workspace names after 20 more prompt submits and 10 minutes', async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace
        .mockResolvedValueOnce({
          title: 'Login Redirect',
          description: 'Fix the login redirect bug',
        })
        .mockResolvedValueOnce({
          title: 'OAuth Login',
          description: 'Fix login redirect and add OAuth',
        });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-regenerate',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      let updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Login Redirect');
      expect(updated?.customNameSource).toBe('generated');
      expect(updated?.promptSubmitsSinceCustomNameGeneration).toBe(0);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      for (let index = 1; index <= 19; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `Follow-up prompt ${index}`);
      }
      await Promise.resolve();
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(1);

      workspaceService.recordPromptSubmit(workspace.id, 'Add OAuth to the login flow');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('OAuth Login');
      expect(updated?.customDescription).toBe('Fix login redirect and add OAuth');
      expect(updated?.customNameSource).toBe('generated');
      expect(updated?.promptSubmitsSinceCustomNameGeneration).toBe(0);
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(2);
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenLastCalledWith(
        expect.stringContaining(
          'Follow-up prompt 19\n</prompt>\n<prompt>\nAdd OAuth to the login flow\n</prompt>'
        ),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should not regenerate generated workspace names before 10 minutes have elapsed', async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Login Redirect',
        description: 'Fix the login redirect bug',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-regenerate-too-soon',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      for (let index = 1; index <= 20; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `Follow-up prompt ${index}`);
      }
      await Promise.resolve();

      expect(workspaceService.get(workspace.id)?.customName).toBe('Login Redirect');
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(1);
    });

    it('should preserve prompt submit count recorded while generated title regeneration is in flight', async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let resolveRegenerate:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace
        .mockResolvedValueOnce({
          title: 'Login Redirect',
          description: 'Fix the login redirect bug',
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRegenerate = resolve;
            })
        );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-regenerate-in-flight',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      for (let index = 1; index <= 20; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `Follow-up prompt ${index}`);
      }
      await Promise.resolve();

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(2);
      workspaceService.recordPromptSubmit(workspace.id, 'Prompt submitted during regeneration');

      resolveRegenerate?.({
        title: 'OAuth Login',
        description: 'Fix login redirect and add OAuth',
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('OAuth Login');
      expect(updated?.promptSubmitsSinceCustomNameGeneration).toBe(1);
    });

    it('should not overwrite a manual title edited while generated title regeneration is in flight', async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let resolveRegenerate:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace
        .mockResolvedValueOnce({
          title: 'Login Redirect',
          description: 'Fix the login redirect bug',
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRegenerate = resolve;
            })
        );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-regenerate-manual-race',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      for (let index = 1; index <= 20; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `Follow-up prompt ${index}`);
      }
      await Promise.resolve();

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(2);
      workspaceService.update(workspace.id, { customName: 'Manual Title' });

      resolveRegenerate?.({
        title: 'OAuth Login',
        description: 'Fix login redirect and add OAuth',
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Manual Title');
      expect(updated?.customNameSource).toBe('manual');
      expect(updated?.autoNaming).toBe(false);
    });

    it('should not restore a cleared title while generated title regeneration is in flight', async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let resolveRegenerate:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace
        .mockResolvedValueOnce({
          title: 'Login Redirect',
          description: 'Fix the login redirect bug',
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRegenerate = resolve;
            })
        );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-regenerate-clear-race',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      for (let index = 1; index <= 20; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `Follow-up prompt ${index}`);
      }
      await Promise.resolve();

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(2);
      workspaceService.update(workspace.id, { customName: undefined });

      resolveRegenerate?.({
        title: 'OAuth Login',
        description: 'Fix login redirect and add OAuth',
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBeUndefined();
      expect(updated?.customNameSource).toBeUndefined();
      expect(updated?.autoNaming).toBe(false);
    });

    it('should preserve prompt submit count recorded while first title generation is in flight', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let resolveAutoName:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAutoName = resolve;
          })
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-first-generation-in-flight',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');
      await Promise.resolve();
      workspaceService.recordPromptSubmit(workspace.id, 'Prompt submitted during first generation');

      resolveAutoName?.({
        title: 'Login Redirect',
        description: 'Fix the login redirect bug',
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Login Redirect');
      expect(updated?.promptSubmitsSinceCustomNameGeneration).toBe(1);
    });

    it('should not regenerate manually edited workspace names', async () => {
      vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'));
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-manual-title',
        customName: 'Manual Title',
      });

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      for (let index = 1; index <= 25; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `Follow-up prompt ${index}`);
      }
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Manual Title');
      expect(updated?.customNameSource).toBe('manual');
      expect(mockUtilityInferenceService.labelWorkspace).not.toHaveBeenCalled();
    });

    it('should not start prompt-submit auto-naming while initial-prompt auto-naming is in flight', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let resolveAutoName:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAutoName = resolve;
          })
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-dedupe',
        initialPrompt: 'Fix the login redirect bug',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(1);
      expect(workspaceService.get(workspace.id)?.promptSubmits).toEqual([
        expect.objectContaining({ prompt: 'Fix the login redirect bug' }),
      ]);

      resolveAutoName?.({
        title: 'Login Redirect',
        description: 'Fix the login redirect bug',
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    });

    it('should store prompt submits without auto-naming when a custom name exists', async () => {
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-custom-name',
        customName: 'Existing Title',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix the login redirect bug');

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Existing Title');
      expect(updated?.promptSubmits).toEqual([
        expect.objectContaining({ prompt: 'Fix the login redirect bug' }),
      ]);
      expect(mockUtilityInferenceService.labelWorkspace).not.toHaveBeenCalled();
    });

    it('should preserve the start and end of oversized prompt submits', async () => {
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-large-prompt',
        customName: 'Existing Title',
      });

      workspaceService.recordPromptSubmit(
        workspace.id,
        `${'Start '.repeat(8000)} middle ${'End '.repeat(8000)}`
      );

      const updated = workspaceService.get(workspace.id);
      const storedPrompt = updated?.promptSubmits?.[0]?.prompt;
      expect(storedPrompt).toBeDefined();
      expect(storedPrompt?.length).toBeLessThanOrEqual(32_000);
      expect(storedPrompt).toContain('Start Start');
      expect(storedPrompt).toContain('[...PROMPT_TRUNCATED...]');
      expect(storedPrompt).toContain('End End');
    });

    it('should keep the first prompt submits and drop the oldest of the rest when stored history exceeds the workspace cap', async () => {
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-budget',
        customName: 'Existing Title',
      });

      for (let index = 1; index <= 9; index++) {
        workspaceService.recordPromptSubmit(
          workspace.id,
          `prompt-${index} ${'x'.repeat(70_000)} tail-${index}`
        );
      }

      const updated = workspaceService.get(workspace.id);
      expect(updated?.promptSubmits?.map((entry) => entry.prompt.split(' ')[0])).toEqual([
        'prompt-1',
        'prompt-2',
        'prompt-3',
        'prompt-5',
        'prompt-6',
        'prompt-7',
        'prompt-8',
        'prompt-9',
      ]);
      const totalLength =
        updated?.promptSubmits?.reduce((total, entry) => total + entry.prompt.length, 0) ?? 0;
      expect(totalLength).toBeLessThanOrEqual(256_000);
    });

    it('should keep the first prompt submits and the newest of the rest up to 1000 as a tiny-prompt guardrail', async () => {
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-count-budget',
        customName: 'Existing Title',
      });

      for (let index = 1; index <= 1005; index++) {
        workspaceService.recordPromptSubmit(workspace.id, `p-${index}`);
      }

      const updated = workspaceService.get(workspace.id);
      expect(updated?.promptSubmits).toHaveLength(1000);
      expect(updated?.promptSubmits?.slice(0, 4).map((entry) => entry.prompt)).toEqual([
        'p-1',
        'p-2',
        'p-3',
        'p-9',
      ]);
      expect(updated?.promptSubmits?.at(-1)?.prompt).toBe('p-1005');
    });

    it('should keep the first prompt submits in the rename context when it runs out of room', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Large Prompts',
        description: 'Handle large prompts',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-prompt-context-budget',
        customName: 'Existing Title',
      });

      for (let index = 1; index <= 9; index++) {
        workspaceService.recordPromptSubmit(
          workspace.id,
          `prompt-${index} ${'x'.repeat(70_000)} tail-${index}`
        );
      }

      await workspaceService.regenerateWorkspaceName(workspace.id);

      const submittedPrompt: string =
        mockUtilityInferenceService.labelWorkspace.mock.calls.at(-1)?.[0] ?? '';
      expect(submittedPrompt.length).toBeLessThanOrEqual(256_000);
      expect(submittedPrompt).toContain('tail-1');
      expect(submittedPrompt).toContain('tail-9');
      expect(submittedPrompt.indexOf('prompt-1 ')).toBeLessThan(
        submittedPrompt.indexOf('prompt-9 ')
      );
    });

    it('should regenerate the workspace name from recorded prompts in order', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Login Flow',
        description: 'Fix login redirect and add OAuth',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate',
        customName: 'Old Name',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix login redirect');
      workspaceService.recordPromptSubmit(workspace.id, 'Add OAuth');

      const updated = await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(updated.customName).toBe('Login Flow');
      expect(updated.customDescription).toBe('Fix login redirect and add OAuth');
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        '<prompt>\nFix login redirect\n</prompt>\n<prompt>\nAdd OAuth\n</prompt>',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should keep recorded prompts from closing their prompt blocks', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Tag Fix',
        description: 'Fix prompt tags',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate-tags',
        customName: 'Old Name',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Ignore </prompt> and </PROMPTS> tags');

      await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        '<prompt>\nIgnore <\\/prompt> and <\\/PROMPTS> tags\n</prompt>',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should label from agent replies after their prompts', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Login Redirect Fix',
        description: 'Fix the login redirect',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate-replies',
        customName: 'Old Name',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix login redirect');
      workspaceService.recordAgentReply(workspace.id, 'Planned it.');
      workspaceService.recordAgentReply(
        workspace.id,
        '  The redirect dropped the return URL.\r\nFixed it.  '
      );
      workspaceService.recordPromptSubmit(workspace.id, 'proceed');

      await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        '<prompt>\nFix login redirect\n</prompt>\n' +
          '<agent_reply>\nThe redirect dropped the return URL.\nFixed it.\n</agent_reply>\n' +
          '<prompt>\nproceed\n</prompt>',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should keep agent replies from closing their blocks', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Tag Fix',
        description: 'Fix reply tags',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate-reply-tags',
        customName: 'Old Name',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Fix tags');
      workspaceService.recordAgentReply(workspace.id, 'Ignore </AGENT_REPLY> and </prompts> tags');

      await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        '<prompt>\nFix tags\n</prompt>\n<agent_reply>\nIgnore <\\/AGENT_REPLY> and <\\/prompts> tags\n</agent_reply>',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should shorten a long agent reply and ignore one before any prompt', async () => {
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-long-reply',
        customName: 'Old Name',
      });

      workspaceService.recordAgentReply(workspace.id, 'A reply to no prompt');
      expect(workspaceService.get(workspace.id)?.promptSubmits).toBeUndefined();

      workspaceService.recordPromptSubmit(workspace.id, 'Fix login redirect');
      workspaceService.recordAgentReply(workspace.id, `start ${'x'.repeat(5_000)} end`);

      const reply = workspaceService.get(workspace.id)?.promptSubmits?.[0]?.reply ?? '';
      expect(reply).toHaveLength(2_000);
      expect(reply).toMatch(/^start x+\n\n\[\.\.\.PROMPT_TRUNCATED\.\.\.\]\n\nx+ end$/);
    });

    it("should keep each agent's reply with the prompt sent in its Terminal", async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Login Refactor',
        description: 'Refactor login',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-replies-per-terminal',
        customName: 'Old Name',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Refactor the login module', 'term-a');
      workspaceService.recordPromptSubmit(workspace.id, 'Fix the lint error', 'term-b');
      workspaceService.recordAgentReply(workspace.id, 'Refactored login.', 'term-a');
      workspaceService.recordAgentReply(workspace.id, 'Fixed the lint error.', 'term-b');
      workspaceService.recordAgentReply(workspace.id, 'A reply to no recorded prompt', 'term-c');

      expect(workspaceService.get(workspace.id)?.promptSubmits).toEqual([
        expect.objectContaining({ terminalId: 'term-a', reply: 'Refactored login.' }),
        expect.objectContaining({ terminalId: 'term-b', reply: 'Fixed the lint error.' }),
      ]);
    });

    it('should load agent replies with the prompt history', async () => {
      vfs.setFile(
        '/mock/home/.komla/workspaces.json',
        JSON.stringify([
          {
            id: 'ws-1',
            name: 'Workspace',
            workingDirectory: '/ws1',
            isWorktree: false,
            projectId: null,
            windowId: null,
            categoryId: null,
            createdAt: 1000,
            lastActivityAt: 1000,
            order: 0,
            promptSubmits: [
              {
                prompt: 'Fix login redirect',
                submittedAt: 1000,
                terminalId: 'term-1',
                reply: 'Fixed it.',
              },
              { prompt: 'proceed', submittedAt: 2000, terminalId: 7, reply: 42 },
            ],
          },
        ])
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(workspaceService.get('ws-1')?.promptSubmits).toEqual([
        {
          prompt: 'Fix login redirect',
          submittedAt: 1000,
          terminalId: 'term-1',
          reply: 'Fixed it.',
        },
        { prompt: 'proceed', submittedAt: 2000 },
      ]);
    });

    it('should reset prompt history when the workspace title is cleared', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'New Task',
        description: 'Work from the new prompt only',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-reset-title-history',
        customName: 'Old Task',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Old prompt that should be forgotten');
      const firstWindowSend = vi.fn();
      const secondWindowSend = vi.fn();
      const { BrowserWindow } = await import('electron');
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        rendererWindow(firstWindowSend),
        rendererWindow(secondWindowSend),
      ]);
      workspaceService.update(workspace.id, { customName: undefined });

      expect(workspaceService.get(workspace.id)?.promptSubmits).toBeUndefined();
      for (const send of [firstWindowSend, secondWindowSend]) {
        expect(send).toHaveBeenCalledWith(
          'workspace:updated',
          expect.objectContaining({
            id: workspace.id,
            customName: undefined,
            customNameSource: undefined,
            promptSubmits: undefined,
            autoNaming: false,
          })
        );
      }

      workspaceService.recordPromptSubmit(workspace.id, 'New prompt after reset');
      await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        '<prompt>\nNew prompt after reset\n</prompt>',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should cancel manual title regeneration when the workspace title is reset', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      let abortedSignal: AbortSignal | undefined;
      let resolveRegenerate:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace.mockImplementationOnce(
        async (_prompt: string, options?: { signal?: AbortSignal }) => {
          abortedSignal = options?.signal;
          return new Promise((resolve) => {
            resolveRegenerate = resolve;
          });
        }
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-reset-title-regeneration',
        customName: 'Old Task',
      });
      workspaceService.recordPromptSubmit(workspace.id, 'Old prompt that should be forgotten');

      const regeneration = workspaceService.regenerateWorkspaceName(workspace.id);
      await Promise.resolve();
      workspaceService.update(workspace.id, { customName: undefined });

      expect(abortedSignal?.aborted).toBe(true);
      resolveRegenerate?.({
        title: 'Stale Generated Task',
        description: 'Generated from cleared prompt history',
      });
      await expect(regeneration).resolves.toEqual(
        expect.objectContaining({
          customName: undefined,
          customNameSource: undefined,
          promptSubmits: undefined,
          autoNaming: false,
        })
      );
    });

    it('should not clear a newer auto-naming request when an aborted request unwinds', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'first-prompt' });
      let resolveNewAutoName:
        | ((value: { title: string; description: string | null }) => void)
        | undefined;
      mockUtilityInferenceService.labelWorkspace
        .mockImplementationOnce(
          async (_prompt: string, options?: { signal?: AbortSignal }) =>
            new Promise((_, reject) => {
              options?.signal?.addEventListener('abort', () => reject(createAbortError()));
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveNewAutoName = resolve;
            })
        );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-reset-title-consecutive-regeneration',
        customName: 'Old Task',
      });
      workspaceService.recordPromptSubmit(workspace.id, 'Old prompt');

      const oldRegeneration = workspaceService.regenerateWorkspaceName(workspace.id);
      await Promise.resolve();
      workspaceService.update(workspace.id, { customName: undefined });
      workspaceService.recordPromptSubmit(workspace.id, 'First new prompt');
      await oldRegeneration;

      expect(workspaceService.get(workspace.id)?.autoNaming).toBe(true);

      resolveNewAutoName?.({
        title: 'New Task',
        description: 'Generated only from the new prompt',
      });
      await Promise.resolve();
    });

    it('should regenerate manually when automatic workspace naming is disabled', async () => {
      mockConfigService.get.mockReturnValue({ autoNameWorkspaces: 'off' });
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Manual Rename',
        description: 'Name from recorded prompts',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate-disabled',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Rename from this prompt');

      const updated = await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(updated.customName).toBe('Manual Rename');
      expect(updated.customDescription).toBe('Name from recorded prompts');
      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledTimes(1);
    });

    it('should reject regenerate when utility inference fails', async () => {
      mockUtilityInferenceService.labelWorkspace.mockRejectedValueOnce(
        new Error('utility unavailable')
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate-failure',
        customName: 'Old Name',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Rename from this prompt');

      await expect(workspaceService.regenerateWorkspaceName(workspace.id)).rejects.toThrow(
        'utility unavailable'
      );

      const updated = workspaceService.get(workspace.id);
      expect(updated?.customName).toBe('Old Name');
      expect(updated?.autoNaming).toBe(false);
    });

    it('should clear stale description when regenerate returns no description', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'New Title',
        description: null,
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-regenerate-null-description',
        customName: 'Old Name',
        customDescription: 'Old description',
      });

      workspaceService.recordPromptSubmit(workspace.id, 'Rename from this prompt');

      const updated = await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(updated.customName).toBe('New Title');
      expect(updated.customDescription).toBeUndefined();
    });

    it('should reject regenerate when no prompts are recorded', async () => {
      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-no-prompts',
      });

      await expect(workspaceService.regenerateWorkspaceName(workspace.id)).rejects.toThrow(
        'No recorded prompts'
      );
      expect(mockUtilityInferenceService.labelWorkspace).not.toHaveBeenCalled();
    });

    it('should omit inline image data from regenerate context', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Image Bug',
        description: 'Fix image handling',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-image-prompt',
        customName: 'Existing Title',
      });

      workspaceService.recordPromptSubmit(
        workspace.id,
        'Fix this screenshot: data:image/png;base64,aGVsbG8='
      );

      await workspaceService.regenerateWorkspaceName(workspace.id);

      expect(mockUtilityInferenceService.labelWorkspace).toHaveBeenCalledWith(
        expect.stringContaining('Fix this screenshot: [IMAGE_DATA_OMITTED]'),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should omit oversized inline image data before storing prompt history', async () => {
      mockUtilityInferenceService.labelWorkspace.mockResolvedValueOnce({
        title: 'Image Bug',
        description: 'Fix image handling',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const workspace = await workspaceService.create({
        mode: 'directory',
        directoryPath: '/mock/dir-large-image-prompt',
        customName: 'Existing Title',
      });

      workspaceService.recordPromptSubmit(
        workspace.id,
        `Fix this screenshot: data:image/png;base64,${'a'.repeat(70_000)}`
      );

      const updated = workspaceService.get(workspace.id);
      expect(updated?.promptSubmits?.[0]?.prompt).toBe('Fix this screenshot: [IMAGE_DATA_OMITTED]');

      await workspaceService.regenerateWorkspaceName(workspace.id);

      const submittedPrompt = mockUtilityInferenceService.labelWorkspace.mock.calls.at(-1)?.[0];
      expect(submittedPrompt).toContain('Fix this screenshot: [IMAGE_DATA_OMITTED]');
      expect(submittedPrompt).not.toContain('aaaaaaaaaa');
      expect(submittedPrompt).not.toContain('[...PROMPT_TRUNCATED...]');
    });

    it('should use the utility inference service for branch naming', async () => {
      mockAgentPresetService.getActive.mockReturnValue(null);
      mockUtilityInferenceService.nameBranch.mockResolvedValueOnce({
        branchName: 'fix-auth-bug',
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const result = await workspaceService.generateBranchName('Some task', '/mock/dir');

      expect(result).toBe('fix-auth-bug');
      expect(mockUtilityInferenceService.nameBranch).toHaveBeenCalledWith(
        'Some task',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('returns null without asking when no AI helper is available', async () => {
      mockUtilityInferenceService.isAvailable.mockReturnValue(false);

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      expect(await workspaceService.generateBranchName('Some task', '/mock/dir')).toBeNull();
      expect(mockUtilityInferenceService.nameBranch).not.toHaveBeenCalled();
    });

    it('should return null when utility inference fails', async () => {
      mockUtilityInferenceService.nameBranch.mockRejectedValueOnce(new Error('utility failed'));

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const result = await workspaceService.generateBranchName('Some task', '/mock/dir');

      expect(result).toBeNull();
    });

    it('should return null when utility inference returns null branchName', async () => {
      mockUtilityInferenceService.nameBranch.mockResolvedValueOnce({
        branchName: null,
      });

      const { workspaceService } = await import('../../../src/main/services/workspace.service');
      const result = await workspaceService.generateBranchName('hi', '/mock/dir');

      expect(result).toBeNull();
    });

    it('should abort in-flight branch naming when cancelBranchNaming is called', async () => {
      let abortedSignal: AbortSignal | undefined;
      mockUtilityInferenceService.nameBranch.mockImplementationOnce(
        async (_prompt: string, options?: { signal?: AbortSignal }) => {
          abortedSignal = options?.signal;
          return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () => reject(createAbortError()));
          });
        }
      );

      const { workspaceService } = await import('../../../src/main/services/workspace.service');

      const resultPromise = workspaceService.generateBranchName('Some task', '/mock/dir');
      await Promise.resolve();

      workspaceService.cancelBranchNaming();

      await expect(resultPromise).resolves.toBeNull();
      expect(abortedSignal?.aborted).toBe(true);
    });
  });
});
