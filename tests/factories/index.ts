/**
 * Domain object factories for creating test fixtures.
 *
 * These factories create valid domain objects with sensible defaults.
 * Override specific fields as needed for your test cases.
 *
 * Usage:
 * ```ts
 * import { createWorkspace, createTerminal, createProject } from '../factories'
 *
 * const workspace = createWorkspace({ name: 'Test Workspace' })
 * const terminal = createTerminal({ status: 'running' })
 * const project = createProject({ repositoryPath: '/path/to/repo' })
 * ```
 */

import type {
  Workspace,
  Terminal,
  TerminalStatus,
  Project,
  SetupStep,
  AgentPreset,
  ActivePresetEntry,
  CreateWorkspaceParams,
} from '../../src/shared/types';

// ============================================================================
// Counter for generating unique IDs
// ============================================================================

let idCounter = 0;

function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

/**
 * Reset the ID counter (useful in beforeEach).
 */
export function resetIdCounter(): void {
  idCounter = 0;
}

// ============================================================================
// Terminal Factory
// ============================================================================

export interface CreateTerminalOptions extends Partial<Terminal> {}

/**
 * Create a Terminal object with sensible defaults.
 */
export function createTerminal(overrides: CreateTerminalOptions = {}): Terminal {
  return {
    id: nextId('term'),
    name: 'Terminal 1',
    status: 'running' as TerminalStatus,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create multiple terminals with different statuses.
 */
export function createTerminals(count: number, overrides: CreateTerminalOptions = {}): Terminal[] {
  return Array.from({ length: count }, (_, i) =>
    createTerminal({
      name: `Terminal ${i + 1}`,
      ...overrides,
    })
  );
}

// ============================================================================
// Workspace Factory
// ============================================================================

export interface CreateWorkspaceOptions extends Partial<Workspace> {
  /**
   * Number of terminals to create (default: 0).
   * If terminals array is provided, this is ignored.
   */
  terminalCount?: number;

  /**
   * Status for auto-created terminals.
   */
  terminalStatus?: TerminalStatus;
}

/**
 * Create a Workspace object with sensible defaults.
 */
export function createWorkspace(overrides: CreateWorkspaceOptions = {}): Workspace {
  const { terminalCount = 0, terminalStatus = 'running', ...rest } = overrides;

  // Auto-generate terminals if count specified and terminals not provided
  const terminals =
    rest.terminals ??
    (terminalCount > 0 ? createTerminals(terminalCount, { status: terminalStatus }) : []);

  const workspace: Workspace = {
    id: nextId('ws'),
    name: 'Test Workspace',
    workingDirectory: '/mock/workspace',
    isWorktree: true,
    projectId: null,
    windowId: null,
    categoryId: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    order: 0,
    status: 'active',
    terminals,
    ...rest,
  };

  // Set primary terminal if terminals exist and not specified
  if (workspace.terminals.length > 0 && !workspace.primaryTerminalId) {
    workspace.primaryTerminalId = workspace.terminals[0].id;
  }

  return workspace;
}

/**
 * Create a worktree-backed workspace.
 */
export function createWorktreeWorkspace(overrides: CreateWorkspaceOptions = {}): Workspace {
  return createWorkspace({
    isWorktree: true,
    branchName: 'agent/test-branch',
    projectId: 'project-1',
    workingDirectory: '/mock/home/.komla/worktrees/my-project/agent-test-branch',
    ...overrides,
  });
}

/**
 * Create a directory-backed workspace (not a worktree).
 */
export function createDirectoryWorkspace(overrides: CreateWorkspaceOptions = {}): Workspace {
  return createWorkspace({
    isWorktree: false,
    projectId: null,
    workingDirectory: '/some/directory/path',
    ...overrides,
  });
}

/**
 * Create a workspace on an SSH host, whose Terminals have Managed Remote Terminal Sessions.
 */
export function createSshWorkspace(overrides: CreateWorkspaceOptions = {}): Workspace {
  return createWorkspace({
    backend: {
      kind: 'ssh',
      hostId: 'ssh-host-1',
      remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
      remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/project',
      gitUrl: 'git@example.com:project.git',
    },
    ...overrides,
  });
}

/**
 * Create a trashed workspace.
 */
export function createTrashedWorkspace(overrides: CreateWorkspaceOptions = {}): Workspace {
  return createWorkspace({
    status: 'trashed',
    ...overrides,
  });
}

// ============================================================================
// CreateWorkspaceParams Factory
// ============================================================================

export interface CreateWorkspaceParamsOptions extends Partial<CreateWorkspaceParams> {}

/**
 * Create CreateWorkspaceParams for worktree mode.
 */
export function createWorktreeParams(
  overrides: CreateWorkspaceParamsOptions = {}
): CreateWorkspaceParams {
  return {
    mode: 'worktree',
    name: 'New Workspace',
    branchName: 'feature-branch',
    projectId: 'project-1',
    ...overrides,
  };
}

/**
 * Create CreateWorkspaceParams for directory mode.
 */
export function createDirectoryParams(
  overrides: CreateWorkspaceParamsOptions = {}
): CreateWorkspaceParams {
  return {
    mode: 'directory',
    directoryPath: '/path/to/directory',
    ...overrides,
  };
}

// ============================================================================
// Project Factory
// ============================================================================

export interface CreateProjectOptions extends Partial<Project> {
  /**
   * Number of setup steps to create (default: 0).
   * If setupSteps array is provided, this is ignored.
   */
  setupStepCount?: number;
}

/**
 * Create a Project object with sensible defaults.
 */
export function createProject(overrides: CreateProjectOptions = {}): Project {
  const { setupStepCount = 0, ...rest } = overrides;

  const setupSteps =
    rest.setupSteps ??
    (setupStepCount > 0
      ? Array.from({ length: setupStepCount }, (_, i) => createSetupStep({ name: `Step ${i + 1}` }))
      : undefined);

  return {
    id: nextId('proj'),
    name: 'Test Project',
    repositoryPath: '/mock/repo',
    defaultBranchPrefix: '',
    createdAt: Date.now(),
    order: 0,
    managed: false,
    setupSteps,
    ...rest,
  };
}

/**
 * Create a managed project (uses bare clone).
 */
export function createManagedProject(overrides: CreateProjectOptions = {}): Project {
  const project = createProject({
    managed: true,
    ...overrides,
  });
  project.managedRepoPath = `/mock/home/.komla/repos/${project.name}.git`;
  return project;
}

// ============================================================================
// SetupStep Factory
// ============================================================================

export interface CreateSetupStepOptions extends Partial<SetupStep> {}

/**
 * Create a SetupStep object with sensible defaults.
 */
export function createSetupStep(overrides: CreateSetupStepOptions = {}): SetupStep {
  return {
    id: nextId('step'),
    name: 'Setup Step',
    command: 'npm install',
    enabled: true,
    placement: 'background',
    ...overrides,
  };
}

/**
 * Create a background setup step.
 */
export function createBackgroundStep(overrides: CreateSetupStepOptions = {}): SetupStep {
  return createSetupStep({
    placement: 'background',
    ...overrides,
  });
}

/**
 * Create a tab setup step.
 */
export function createTabStep(overrides: CreateSetupStepOptions = {}): SetupStep {
  return createSetupStep({
    placement: 'tab',
    ...overrides,
  });
}

/**
 * Create a split-right setup step.
 */
export function createSplitStep(
  direction: 'right' | 'bottom' = 'right',
  overrides: CreateSetupStepOptions = {}
): SetupStep {
  return createSetupStep({
    placement: direction === 'right' ? 'split-right' : 'split-bottom',
    ...overrides,
  });
}

/**
 * Create an action-based setup step.
 */
export function createActionStep(
  actionId: string,
  overrides: CreateSetupStepOptions = {}
): SetupStep {
  return createSetupStep({
    name: 'Action Step',
    command: '',
    placement: 'tab',
    actionId,
    ...overrides,
  });
}

// ============================================================================
// AgentPreset Factory
// ============================================================================

export interface CreateAgentPresetOptions extends Partial<AgentPreset> {}

/**
 * Create an AgentPreset object with sensible defaults.
 */
export function createAgentPreset(overrides: CreateAgentPresetOptions = {}): AgentPreset {
  return {
    id: nextId('preset'),
    name: 'Test Agent',
    openCommand: 'test-agent',
    continueCommand: 'test-agent --continue',
    promptCommand: 'test-agent {{prompt}}',
    launchModes: [],
    isBuiltin: false,
    ...overrides,
  };
}

/**
 * Create Claude Code agent preset.
 */
export function createClaudePreset(overrides: CreateAgentPresetOptions = {}): AgentPreset {
  return createAgentPreset({
    id: 'claude-code',
    name: 'Claude Code',
    openCommand: 'claude',
    continueCommand: 'claude --resume',
    promptCommand: 'claude {{prompt}}',
    launchModes: [],
    isBuiltin: true,
    ...overrides,
  });
}

/**
 * Create shell-only preset (no agent commands).
 */
export function createShellOnlyPreset(overrides: CreateAgentPresetOptions = {}): AgentPreset {
  return createAgentPreset({
    id: 'shell-only',
    name: 'Shell Only',
    openCommand: '',
    continueCommand: '',
    promptCommand: '',
    launchModes: [],
    isBuiltin: true,
    ...overrides,
  });
}

export interface CreateActivePresetEntryOptions extends Partial<ActivePresetEntry> {}

export function createActivePresetEntry(
  overrides: Partial<ActivePresetEntry> = {}
): ActivePresetEntry {
  return {
    presetId: nextId('preset'),
    lastUsedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Category Factory
// ============================================================================

export interface Category {
  id: string;
  name: string;
  color?: string;
  order: number;
}

export interface CreateCategoryOptions extends Partial<Category> {}

/**
 * Create a Category object with sensible defaults.
 */
export function createCategory(overrides: CreateCategoryOptions = {}): Category {
  return {
    id: nextId('cat'),
    name: 'Test Category',
    order: 0,
    ...overrides,
  };
}

// ============================================================================
// Config Factory
// ============================================================================

export interface AppConfig {
  agentSetupComplete: boolean;
  scrollbackLines: number;
  theme: 'system' | 'light' | 'dark';
  defaultProjectId: string | null;
  notificationsEnabled: boolean;
  notificationPort: number;
  telemetryPingSent: boolean;
  lastHeartbeatDate?: string;
  usageTelemetryEnabled?: boolean;
  agentLaunchDefaultPresetId?: string;
  agentLaunchDefaultLaunchModeId?: string;
  voice?: {
    modelId: string;
    modelPath: string | null;
  };
}

export interface CreateConfigOptions extends Partial<AppConfig> {}

/**
 * Create an AppConfig object with sensible defaults.
 */
export function createConfig(overrides: CreateConfigOptions = {}): AppConfig {
  return {
    agentSetupComplete: false,
    scrollbackLines: 10000,
    theme: 'system',
    defaultProjectId: null,
    notificationsEnabled: false,
    notificationPort: 52863,
    telemetryPingSent: false,
    usageTelemetryEnabled: true,
    voice: {
      modelId: 'parakeet-tdt-0.6b-v3-int8',
      modelPath: null,
    },
    ...overrides,
  };
}

/**
 * Create a fully configured AppConfig (setup complete, notifications enabled).
 */
export function createConfiguredConfig(overrides: CreateConfigOptions = {}): AppConfig {
  return createConfig({
    agentSetupComplete: true,
    notificationsEnabled: true,
    defaultProjectId: 'project-1',
    ...overrides,
  });
}

// ============================================================================
// Git-related Factories
// ============================================================================

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
  additions: number;
  deletions: number;
}

export interface CreateFileChangeOptions extends Partial<FileChange> {}

/**
 * Create a FileChange object with sensible defaults.
 */
export function createFileChange(overrides: CreateFileChangeOptions = {}): FileChange {
  return {
    path: 'src/index.ts',
    status: 'modified',
    staged: false,
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

/**
 * Create a set of typical file changes for testing.
 */
export function createTypicalFileChanges(): FileChange[] {
  return [
    createFileChange({ path: 'src/index.ts', status: 'modified', staged: true }),
    createFileChange({ path: 'src/new-file.ts', status: 'added', staged: false }),
    createFileChange({ path: 'tests/index.test.ts', status: 'modified', staged: false }),
    createFileChange({ path: 'README.md', status: 'untracked', staged: false }),
  ];
}
