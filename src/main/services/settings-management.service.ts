import { createHash, randomUUID } from 'crypto';

import { resolveWorkspaceCreationEnvironment } from '../../shared/lib/agent-environment';
import {
  BUILT_IN_THEMES,
  CUSTOM_PALETTE_ID,
  appearanceProblems,
  shownTheme,
  themeMode,
  themeSlot,
  type BuiltInTheme,
} from '../../shared/lib/appearance';
import { automationScheduleError } from '../../shared/lib/automation-schedule';
import { skipsPermissionPrompts } from '../../shared/lib/launch-mode-permissions';
import {
  resolveSshWorkspaceMode,
  type SshWorkspaceMode,
} from '../../shared/lib/ssh-workspace-mode';
import { isLocalTerminalExecutionLocation, isSshWorkspace } from '../../shared/types';
import {
  AUTOMATION_MISSED_RUN_GRACE_MINUTES,
  DEFAULT_AUTOMATION_MISSED_RUN_GRACE_MINUTES,
} from '../../shared/types/automation';
import { describeSettingsSchema, settingsJsonSchema } from '../lib/settings-schema';

import {
  actionConfig,
  describeActionChanges,
  describeSetupChanges,
  workspaceSetup,
} from './settings-approval-changes';

import type { WorkspaceSetupState } from './project.service';
import type { DesiredWorkspaceEnvironment } from '../../shared/lib/agent-environment';
import type {
  Action,
  ActivePresetEntry,
  AgentPreset,
  AppearanceSettings,
  LaunchMode,
  Project,
  SettingsApprovalChange,
  SettingsApprovalPrompt,
  SettingsFileResource,
  SetupStep,
  ThemeConfig,
  Workspace,
} from '../../shared/types';
import type {
  AutomationTarget,
  AutomationTargetSnapshot,
  SaveAutomationParams,
} from '../../shared/types/automation';
import type { SettingsSchemaSection } from '../lib/settings-schema';

export type SettingsActionScope = 'global' | 'current-project';

export interface SettingsRequestContext {
  terminalId?: string;
  workspaceId?: string;
  sshHostId?: string;
  cwd?: string;
}
export interface SettingsAction {
  id?: string;
  title: string;
  content: string;
  type: 'prompt' | 'command';
  projectCount?: number;
  presetId?: string;
  launchModeId?: string;
  sshExecutionLocation?: Action['sshExecutionLocation'];
  background?: boolean;
}

export type SettingsActionsRepresentation =
  | { scope: 'global'; actions: SettingsAction[] }
  | {
      scope: 'current-project';
      project: { id: string; name: string };
      actions: SettingsAction[];
    };

export interface WorkspaceSetupRepresentation extends WorkspaceSetupState {
  project: { id: string; name: string };
  setupCapabilities: WorkspaceSetupCapabilities;
}

export interface WorkspaceSetupCapabilities {
  currentEnvironment?: { kind: 'local' } | { kind: 'ssh' } | { kind: 'ssh-local-copy' };
  ssh: {
    configured: boolean;
    selectedForNewWorkspaces: boolean;
    actionsRunInLocalCopy: boolean;
  };
}

export interface AppearanceRepresentation extends AppearanceSettings {
  themes: ReadonlyArray<BuiltInTheme>;
  /** What keeps the current settings from working, such as a hand-edited customPalette. */
  problems: string[];
}

export type WorkspaceSetupInput = Omit<WorkspaceSetupState, 'setupSteps'> & {
  setupSteps: Array<Omit<SetupStep, 'id'> & { id?: string }>;
};

/** A current-project automation as `komla settings` shows and takes it. */
export interface SettingsAutomation {
  id?: string;
  name: string;
  prompt: string;
  target: AutomationTarget;
  presetId?: string;
  launchModeId?: string;
  /** The branch runs start from; empty or absent, the project's target branch. */
  startBranch?: string;
  /** Shown, never taken: the agent of an SSH automation whose preset isn't on this computer. */
  agentName?: string;
  /** The time zone defaults to an edited automation's, else this computer's. */
  schedule: { cron: string; timeZone?: string };
  enabled?: boolean;
  missedRunGraceMinutes?: number;
}

export interface AutomationsRepresentation {
  project: { id: string; name: string };
  /** Where this project's automations can run. */
  targets: Array<{ target: AutomationTarget; name: string; problem?: string }>;
  automations: SettingsAutomation[];
  /**
   * The agents automations can start, with every launch mode. Unlike `komla agent presets`, it
   * includes modes agents can't launch themselves, since the user approves each automation.
   */
  agents: Array<{
    id: string;
    name: string;
    modes: Array<{ id: string; name: string; skipsPermissionPrompts?: true }>;
  }>;
}

export interface SettingsProposalResult<T> {
  status: 'unchanged' | 'cancelled' | 'applied';
  applied: boolean;
  value?: T;
}

/** A settings file an agent reads and changes whole with `komla settings`. */
export interface SettingsFileAdapter {
  /** The file's name, as in messages. */
  name: string;
  /** What `komla settings schema` shows: the settings' format, then what their commands print. */
  schema: SettingsSchemaSection[];
  /** What `komla settings get` shows. */
  read(): Record<string, unknown>;
  /** Changes whenever the file does, so a change made while the user decides isn't lost. */
  revision(): string;
  /** What Komla saves for the desired settings and how it differs, or what is wrong with them. */
  prepare(
    desired: Record<string, unknown>
  ):
    | { next: unknown; changes: SettingsApprovalChange[]; warning?: string }
    | { problems: string[] };
  write(next: unknown): void;
}

export interface SettingsApprovalRequest {
  resource: SettingsApprovalPrompt['resource'];
  scope?: SettingsActionScope;
  project?: { id: string; name: string };
  workspace?: Workspace;
  changes: SettingsApprovalChange[];
  multiProjectWarning?: string;
  warning?: string;
  /** Shown live while the user decides. */
  preview?: AppearanceSettings;
  description?: string;
  /** Nobody is waiting on it, so it waits in the window rather than bringing Komla forward. */
  background?: boolean;
}

type StorageRevisionState =
  | { status: 'current'; revision: string }
  | { status: 'changed' }
  | { status: 'unreadable' };

interface Dependencies {
  actions: {
    list(): Action[];
    getStorageRevisionState(): StorageRevisionState;
    replaceAll(expectedRevision: string, actions: Action[]): string;
  };
  projects: {
    list(): Project[];
    get(id: string): Project | undefined;
    getStorageRevisionState(): StorageRevisionState;
    replaceWorkspaceSetup(
      expectedRevision: string,
      projectId: string,
      setup: WorkspaceSetupState
    ): string;
  };
  workspaces: {
    get(id: string): Workspace | undefined;
    findWorkspaceByTerminalId(id: string): Workspace | undefined;
  };
  resolveProjectByCwd(
    cwd: string,
    sshHostId?: string
  ): { project?: Project; workspace?: Workspace; error?: string };
  presets: {
    list(): AgentPreset[];
    /** The agents turned on, most recently used first. */
    getActivePresets(): ActivePresetEntry[];
  };
  appearance: {
    /** The saved theme. */
    get(): ThemeConfig;
    /** Whether the system appearance is dark, which picks the theme showing with followSystem. */
    systemIsDark(): boolean;
    set(settings: AppearanceSettings): void;
  };
  environmentConfiguration(): {
    lastWorkspaceEnvironment?: DesiredWorkspaceEnvironment;
    defaultSshWorkspaceMode?: SshWorkspaceMode;
    sshHosts: Array<{ id: string }>;
  };
  files: Record<SettingsFileResource, SettingsFileAdapter>;
  automations: {
    /** Every target's automations, as last read. */
    list(): Promise<AutomationTargetSnapshot[]>;
    /**
     * Every target's automations, with the given SSH hosts (else every host)
     * read again first; after waitMs, hosts still being read show as loading.
     */
    listCurrent(options?: {
      hostIds?: readonly string[];
      waitMs?: number;
    }): Promise<AutomationTargetSnapshot[]>;
    /** Why the project's automations couldn't run on an SSH host. */
    hostProblem(project: Project): Promise<string | undefined>;
    /** Why the agent couldn't start with a prompt where the automation runs. */
    agentProblem(
      target: AutomationTarget,
      presetId?: string,
      launchModeId?: string
    ): string | undefined;
    save(params: SaveAutomationParams): Promise<unknown>;
    setEnabled(target: AutomationTarget, id: string, enabled: boolean): Promise<void>;
    delete(target: AutomationTarget, id: string): Promise<void>;
    hostName(hostId: string): string | undefined;
    timeZone(): string;
  };
  approve(request: SettingsApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  feedback(message: string, workspace?: Workspace): void;
  generateId?: () => string;
}

export type SettingsManagementErrorCode =
  | 'ACTION_STILL_REFERENCED'
  | 'APPROVAL_PENDING'
  | 'AUTOMATION_CHANGE_FAILED'
  | 'DUPLICATE_ACTION_ID'
  | 'DUPLICATE_AUTOMATION_ID'
  | 'DUPLICATE_SETUP_STEP_ID'
  | 'INVALID_ACTION'
  | 'INVALID_APPEARANCE'
  | 'INVALID_AUTOMATION'
  | 'INVALID_ACTION_METADATA'
  | 'INVALID_ACTION_REFERENCE'
  | 'INVALID_LAUNCH_MODE'
  | 'INVALID_PRESET'
  | 'INVALID_SETTINGS'
  | 'INVALID_SSH_EXECUTION_LOCATION'
  | 'INVALID_STOP_STEP'
  | 'INVALID_BACKGROUND'
  | 'MULTI_PROJECT_ACTION_REQUIRED'
  | 'NO_APPROVAL_WINDOW'
  | 'PROJECT_CONTEXT_CONFLICT'
  | 'PROJECT_CONTEXT_REQUIRED'
  | 'SETTINGS_READ_FAILED'
  | 'STALE_ACTION_METADATA'
  | 'STALE_VERSION'
  | 'UNKNOWN_ACTION_ID'
  | 'UNKNOWN_AUTOMATION_ID'
  | 'UNKNOWN_SETUP_STEP_ID'
  | 'WORKSPACE_SETUP_UNSUPPORTED';

export class SettingsManagementError extends Error {
  constructor(
    public readonly code: SettingsManagementErrorCode,
    message: string,
    public readonly status: 400 | 409 | 412 | 422 | 500 | 503,
    public readonly details: unknown[] = [],
    public readonly shouldNotify: boolean = true
  ) {
    super(message);
    this.name = 'SettingsManagementError';
  }
}

function hashTag(value: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(value)).digest('hex')}"`;
}

// Object keys in a stable order, so a theme written with its keys in another order matches.
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])])
  );
}

function appearanceTag(settings: AppearanceSettings): string {
  return hashTag(sortedKeys(settings));
}

// The appearance settings for a theme and accent, with the custom theme and radius they share.
function appearanceOf(
  theme: ThemeConfig,
  { palette, accent }: { palette: string; accent: string }
): AppearanceSettings {
  return {
    palette,
    ...(theme.customPalette !== undefined && { customPalette: theme.customPalette }),
    accent,
    borderRadius: theme.typography.borderRadius,
  };
}

function representAppearance(settings: AppearanceSettings): AppearanceRepresentation {
  return { ...settings, themes: BUILT_IN_THEMES, problems: appearanceProblems(settings) };
}

function themeName(settings: AppearanceSettings): string {
  if (settings.palette === CUSTOM_PALETTE_ID) {
    return `${settings.customPalette?.name?.trim() || 'Custom'} (custom)`;
  }
  return BUILT_IN_THEMES.find((theme) => theme.id === settings.palette)?.name ?? settings.palette;
}

function assertCommandOnlyFields(input: SettingsAction): void {
  if (input.type === 'command') return;
  if (input.sshExecutionLocation) {
    throw new SettingsManagementError(
      'INVALID_SSH_EXECUTION_LOCATION',
      'SSH execution location is only supported for Terminal Commands.',
      422
    );
  }
  if (input.background) {
    throw new SettingsManagementError(
      'INVALID_BACKGROUND',
      'Running in the background is only supported for Terminal Commands.',
      422
    );
  }
}

function publicAction(action: Action): SettingsAction {
  return {
    id: action.id,
    title: action.title,
    content: action.content,
    type: action.type ?? 'prompt',
    ...(action.projectIds?.length ? { projectCount: action.projectIds.length } : {}),
    ...(action.presetId ? { presetId: action.presetId } : {}),
    ...(action.launchModeId ? { launchModeId: action.launchModeId } : {}),
    ...(action.type === 'command' && action.sshExecutionLocation
      ? { sshExecutionLocation: action.sshExecutionLocation }
      : {}),
    ...(action.type === 'command' && action.background ? { background: true } : {}),
  };
}

// `komla settings get` gives up after 10 s, so a slow host shows as still being read.
const AUTOMATIONS_READ_WAIT_MS = 6_000;

// What an automation does, compared to find edits; ids and display-only fields aside.
function automationConfig(automation: SettingsAutomation) {
  return {
    name: automation.name,
    prompt: automation.prompt,
    target: automation.target,
    presetId: automation.presetId,
    launchModeId: automation.launchModeId,
    startBranch: automation.startBranch,
    schedule: automation.schedule,
    enabled: automation.enabled,
    missedRunGraceMinutes: automation.missedRunGraceMinutes,
  };
}

/** The approval dialog's warning for automations it switches on. */
function automationsWarning(skipPrompts: string[]): string {
  const warning = 'Komla starts these agents with their prompts on schedule, without asking.';
  if (skipPrompts.length === 0) return warning;
  const names = skipPrompts.map((name) => `“${name}”`).join(', ');
  return skipPrompts.length === 1
    ? `${warning} ${names} skips permission prompts, so its agent acts without asking for permission.`
    : `${warning} ${names} skip permission prompts, so their agents act without asking for permission.`;
}

export class SettingsManagementService {
  private readonly pending = new Set<string>();
  // A file's format is fixed while Komla runs, so each is rendered once.
  private readonly schemas = new Map<
    SettingsFileResource,
    ReturnType<SettingsManagementService['readSettingsFileSchema']>
  >();
  private readonly generateId: () => string;

  constructor(private readonly deps: Dependencies) {
    this.generateId = deps.generateId ?? randomUUID;
  }

  readActions(
    context: SettingsRequestContext,
    scope: SettingsActionScope
  ): SettingsActionsRepresentation {
    const all = this.deps.actions.list();
    if (scope === 'global') {
      return {
        scope,
        actions: all.filter((action) => !action.projectIds?.length).map(publicAction),
      };
    }
    const { project } = this.resolveProject(context);
    return {
      scope,
      project: { id: project.id, name: project.name },
      actions: all.filter((action) => action.projectIds?.includes(project.id)).map(publicAction),
    };
  }

  async proposeActions(
    context: SettingsRequestContext,
    scope: SettingsActionScope,
    desired: { actions: SettingsAction[] },
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<SettingsActionsRepresentation>> {
    try {
      return await this.proposeActionsInternal(context, scope, desired, signal);
    } catch (error) {
      this.feedbackRejected(error, context);
      throw error;
    }
  }

  private async proposeActionsInternal(
    context: SettingsRequestContext,
    scope: SettingsActionScope,
    desired: { actions: SettingsAction[] },
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<SettingsActionsRepresentation>> {
    const resolved = scope === 'global' ? undefined : this.resolveProject(context);
    const all = this.deps.actions.list();
    const proposalTag = this.actionsTag(all);
    const storageRevision = this.requireCurrentStorageRevision(
      this.deps.actions.getStorageRevisionState(),
      'Quick Commands'
    );
    const projectsStorageRevision = this.requireCurrentStorageRevision(
      this.deps.projects.getStorageRevisionState(),
      'Workspace Setup'
    );
    const next = this.buildDesiredActions(all, scope, resolved?.project, desired.actions);
    this.validateActionReferences(this.actionsInScope(next, scope, resolved?.project));
    this.validateActionDeletions(all, next);
    if (this.actionsTag(next) === this.actionsTag(all)) {
      return { status: 'unchanged', applied: false };
    }

    const key = 'actions';
    this.acquire(key);
    try {
      const changes = this.describeActionChanges(all, next);
      const approved = await this.deps.approve(
        {
          resource: 'actions',
          scope,
          project: resolved ? { id: resolved.project.id, name: resolved.project.name } : undefined,
          workspace: resolved?.workspace,
          changes,
          multiProjectWarning: this.multiProjectWarning(all, next),
        },
        signal
      );
      if (!approved || signal?.aborted) {
        return { status: 'cancelled', applied: false };
      }
      if (this.actionsTag(this.deps.actions.list()) !== proposalTag) {
        throw new SettingsManagementError('STALE_VERSION', 'Quick Commands have changed.', 412);
      }
      this.requireUnchangedStorageRevision(
        this.deps.projects.getStorageRevisionState(),
        projectsStorageRevision,
        'Workspace Setup'
      );
      this.validateActionReferences(this.actionsInScope(next, scope, resolved?.project));
      this.validateActionDeletions(all, next);
      try {
        this.deps.actions.replaceAll(storageRevision, next);
      } catch (error) {
        if (error instanceof Error && error.message.includes('revision changed')) {
          throw new SettingsManagementError('STALE_VERSION', 'Quick Commands have changed.', 412);
        }
        throw error;
      }
      return { status: 'applied', applied: true, value: this.readActions(context, scope) };
    } finally {
      this.pending.delete(key);
    }
  }

  readWorkspaceSetup(context: SettingsRequestContext): WorkspaceSetupRepresentation {
    const { project, workspace } = this.resolveProject(context);
    this.requireWorkspaceSetupSupported(project);
    const setup = workspaceSetup(project);
    return {
      project: { id: project.id, name: project.name },
      ...setup,
      setupCapabilities: this.setupCapabilities(context, workspace, project),
    };
  }

  async proposeWorkspaceSetup(
    context: SettingsRequestContext,
    desired: WorkspaceSetupInput,
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<WorkspaceSetupRepresentation>> {
    try {
      return await this.proposeWorkspaceSetupInternal(context, desired, signal);
    } catch (error) {
      this.feedbackRejected(error, context);
      throw error;
    }
  }

  private async proposeWorkspaceSetupInternal(
    context: SettingsRequestContext,
    desired: WorkspaceSetupInput,
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<WorkspaceSetupRepresentation>> {
    const resolved = this.resolveProject(context);
    this.requireWorkspaceSetupSupported(resolved.project);
    const proposalTag = hashTag(workspaceSetup(resolved.project));
    const storageRevision = this.requireCurrentStorageRevision(
      this.deps.projects.getStorageRevisionState(),
      'Workspace Setup'
    );
    const actionsStorageRevision = this.requireCurrentStorageRevision(
      this.deps.actions.getStorageRevisionState(),
      'Quick Commands'
    );
    const normalized = this.normalizeSetup(resolved.project, desired);
    this.validateSetup(normalized, resolved.project);
    if (hashTag(normalized) === hashTag(workspaceSetup(resolved.project))) {
      return { status: 'unchanged', applied: false };
    }
    const key = `workspace-setup:${resolved.project.id}`;
    this.acquire(key);
    try {
      const approved = await this.deps.approve(
        {
          resource: 'workspace-setup',
          project: { id: resolved.project.id, name: resolved.project.name },
          workspace: resolved.workspace,
          changes: this.describeSetupChanges(workspaceSetup(resolved.project), normalized),
        },
        signal
      );
      if (!approved || signal?.aborted) {
        return { status: 'cancelled', applied: false };
      }
      if (hashTag(workspaceSetup(this.resolveProject(context).project)) !== proposalTag) {
        throw new SettingsManagementError('STALE_VERSION', 'Workspace Setup has changed.', 412);
      }
      this.requireUnchangedStorageRevision(
        this.deps.actions.getStorageRevisionState(),
        actionsStorageRevision,
        'Quick Commands'
      );
      this.validateSetup(normalized, resolved.project);
      try {
        this.deps.projects.replaceWorkspaceSetup(storageRevision, resolved.project.id, normalized);
      } catch (error) {
        if (error instanceof Error && error.message.includes('revision changed')) {
          throw new SettingsManagementError('STALE_VERSION', 'Workspace Setup has changed.', 412);
        }
        throw error;
      }
      return { status: 'applied', applied: true, value: this.readWorkspaceSetup(context) };
    } finally {
      this.pending.delete(key);
    }
  }

  async readAutomations(context: SettingsRequestContext): Promise<AutomationsRepresentation> {
    const { project } = this.resolveProject(context);
    const [snapshots, hostProblem] = await Promise.all([
      this.currentAutomations(project, AUTOMATIONS_READ_WAIT_MS),
      this.automationHostProblem(project),
    ]);
    return this.representAutomations(project, snapshots, hostProblem);
  }

  async proposeAutomations(
    context: SettingsRequestContext,
    desired: { automations: SettingsAutomation[] },
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<AutomationsRepresentation>> {
    try {
      return await this.proposeAutomationsInternal(context, desired, signal);
    } catch (error) {
      this.feedbackRejected(error, context);
      throw error;
    }
  }

  private async proposeAutomationsInternal(
    context: SettingsRequestContext,
    desired: { automations: SettingsAutomation[] },
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<AutomationsRepresentation>> {
    const resolved = this.resolveProject(context);
    const { project } = resolved;
    const before = this.projectAutomations(project, await this.currentAutomations(project));
    const proposalTag = hashTag(before);
    const hostProblem = desired.automations.some((automation) => automation.target.kind === 'ssh')
      ? await this.automationHostProblem(project)
      : undefined;
    const plan = this.planAutomations(project, before, desired.automations, hostProblem);
    if (plan.changes.length === 0) return { status: 'unchanged', applied: false };

    const key = `automations:${project.id}`;
    this.acquire(key);
    try {
      const approved = await this.deps.approve(
        {
          resource: 'automations',
          project: { id: project.id, name: project.name },
          workspace: resolved.workspace,
          changes: plan.changes,
          ...(plan.startsAgents && {
            warning: automationsWarning(plan.skipPrompts),
          }),
        },
        signal
      );
      if (!approved || signal?.aborted) {
        return { status: 'cancelled', applied: false };
      }
      if (
        hashTag(this.projectAutomations(project, await this.currentAutomations(project))) !==
        proposalTag
      ) {
        throw new SettingsManagementError('STALE_VERSION', 'Automations have changed.', 412);
      }
      for (const { name, apply } of plan.steps) {
        try {
          await apply();
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)).trim();
          throw new SettingsManagementError(
            'AUTOMATION_CHANGE_FAILED',
            `Couldn’t change the automation “${name}”: ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Changes listed before it were applied.`,
            500
          );
        }
      }
      return {
        status: 'applied',
        applied: true,
        value: this.representAutomations(
          project,
          await this.deps.automations.list(),
          await this.automationHostProblem(project)
        ),
      };
    } finally {
      this.pending.delete(key);
    }
  }

  /** Every target's automations, with the hosts the project can use read again first. */
  private currentAutomations(
    project: Project,
    waitMs?: number
  ): Promise<AutomationTargetSnapshot[]> {
    return this.deps.automations.listCurrent({
      // Folder projects have no repository to put on a host.
      ...(project.kind === 'directory' ? { hostIds: [] } : {}),
      ...(waitMs === undefined ? {} : { waitMs }),
    });
  }

  private async automationHostProblem(project: Project): Promise<string | undefined> {
    return project.kind === 'directory' ? undefined : this.deps.automations.hostProblem(project);
  }

  private projectAutomations(
    project: Project,
    snapshots: AutomationTargetSnapshot[]
  ): SettingsAutomation[] {
    return snapshots
      .flatMap((snapshot) => snapshot.automations)
      .filter((automation) => automation.projectId === project.id)
      .map((automation) => ({
        id: automation.id,
        name: automation.name,
        prompt: automation.prompt,
        target: automation.target,
        ...(automation.presetId ? { presetId: automation.presetId } : {}),
        ...(automation.launchModeId ? { launchModeId: automation.launchModeId } : {}),
        ...(automation.startBranch ? { startBranch: automation.startBranch } : {}),
        ...(!automation.presetId && automation.agentName
          ? { agentName: automation.agentName }
          : {}),
        schedule: { cron: automation.schedule.cron, timeZone: automation.schedule.timeZone },
        enabled: automation.enabled,
        missedRunGraceMinutes: automation.missedRunGraceMinutes,
      }));
  }

  private representAutomations(
    project: Project,
    snapshots: AutomationTargetSnapshot[],
    hostProblem: string | undefined
  ): AutomationsRepresentation {
    const targets: AutomationsRepresentation['targets'] = [];
    for (const snapshot of snapshots) {
      if (snapshot.target.kind === 'local') {
        targets.push({ target: snapshot.target, name: 'This computer' });
        continue;
      }
      // Folder projects have no repository to put on a host.
      if (project.kind === 'directory') continue;
      const problem = snapshot.loading
        ? 'Still reading this host’s automations, so they may be missing or out of date. Read them again shortly.'
        : snapshot.error
          ? `Couldn’t read this host’s automations: ${snapshot.error}`
          : (hostProblem ??
            (snapshot.scheduler.available
              ? undefined
              : (snapshot.scheduler.message ?? 'This host can’t start automations on schedule.')));
      targets.push({
        target: snapshot.target,
        name: this.deps.automations.hostName(snapshot.target.hostId) ?? snapshot.target.hostId,
        ...(problem ? { problem } : {}),
      });
    }
    const automations = this.projectAutomations(project, snapshots);
    return {
      project: { id: project.id, name: project.name },
      targets,
      automations,
      agents: this.automationAgents(automations),
    };
  }

  /**
   * What the Automations editor offers: the agents turned on, most recently used first,
   * and those the automations use even after they were turned off.
   */
  private automationAgents(automations: SettingsAutomation[]): AutomationsRepresentation['agents'] {
    const all = this.deps.presets.list();
    const presets = all.filter(
      (preset) => !this.deps.automations.agentProblem({ kind: 'local' }, preset.id)
    );
    const active = this.deps.presets
      .getActivePresets()
      .map((entry) => presets.find((preset) => preset.id === entry.presetId))
      .filter((preset): preset is AgentPreset => !!preset);
    const offered = active.length > 0 ? active : presets;
    const used = all.filter(
      (preset) =>
        !offered.includes(preset) &&
        automations.some((automation) => automation.presetId === preset.id)
    );
    return [...offered, ...used].map((preset) => ({
      id: preset.id,
      name: preset.name,
      modes: preset.launchModes.map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(skipsPermissionPrompts(mode) ? { skipsPermissionPrompts: true as const } : {}),
      })),
    }));
  }

  /** What saving the desired automations changes, in the order Komla applies it. */
  private planAutomations(
    project: Project,
    before: SettingsAutomation[],
    desired: SettingsAutomation[],
    hostProblem: string | undefined
  ): {
    changes: SettingsApprovalChange[];
    steps: Array<{ name: string; apply: () => Promise<void> }>;
    startsAgents: boolean;
    /** The automations it saves or switches on whose agent skips permission prompts. */
    skipPrompts: string[];
  } {
    const existing = new Map(before.map((automation) => [automation.id!, automation]));
    const presets = new Map(this.deps.presets.list().map((preset) => [preset.id, preset]));
    const seen = new Set<string>();
    const next = desired.map((input) => {
      if (input.id !== undefined) {
        if (seen.has(input.id)) {
          throw new SettingsManagementError(
            'DUPLICATE_AUTOMATION_ID',
            `Duplicate automation ID: ${input.id}`,
            422
          );
        }
        seen.add(input.id);
        if (!existing.has(input.id)) {
          throw new SettingsManagementError(
            'UNKNOWN_AUTOMATION_ID',
            `Unknown automation ID: ${input.id}`,
            422
          );
        }
      }
      return this.normalizeAutomation(project, input, existing.get(input.id ?? ''));
    });

    const changes: SettingsApprovalChange[] = [];
    const steps: Array<{ name: string; apply: () => Promise<void> }> = [];
    let startsAgents = false;
    const skipPrompts: string[] = [];
    const starts = (automation: SettingsAutomation) => {
      startsAgents = true;
      const { mode } = this.automationAgent(automation, presets);
      if (mode && skipsPermissionPrompts(mode)) skipPrompts.push(automation.name);
    };
    for (const automation of next) {
      const previous = automation.id ? existing.get(automation.id) : undefined;
      const save = (operation: 'add' | 'edit') => {
        // Only what is saved needs its agent; unchanged automations keep working as they are.
        this.validatePresetSelection(automation.presetId, automation.launchModeId, presets);
        const problem =
          (automation.target.kind === 'ssh' ? hostProblem : undefined) ??
          this.deps.automations.agentProblem(
            automation.target,
            automation.presetId,
            automation.launchModeId
          );
        if (problem) {
          throw new SettingsManagementError(
            'INVALID_AUTOMATION',
            `“${automation.name}”: ${problem}`,
            422
          );
        }
        if (automation.enabled) starts(automation);
        changes.push(this.describeAutomation(operation, automation, presets));
        steps.push({
          name: automation.name,
          apply: async () => {
            await this.deps.automations.save({
              ...(automation.id ? { id: automation.id } : {}),
              ...(previous ? { previousTarget: previous.target } : {}),
              name: automation.name,
              prompt: automation.prompt,
              projectId: project.id,
              target: automation.target,
              ...(automation.presetId ? { presetId: automation.presetId } : {}),
              ...(automation.launchModeId ? { launchModeId: automation.launchModeId } : {}),
              ...(automation.startBranch ? { startBranch: automation.startBranch } : {}),
              schedule: { cron: automation.schedule.cron, timeZone: automation.schedule.timeZone! },
              enabled: automation.enabled!,
              missedRunGraceMinutes: automation.missedRunGraceMinutes!,
            });
          },
        });
      };
      if (!previous) {
        save('add');
      } else if (
        hashTag({ ...automationConfig(previous), enabled: undefined }) !==
        hashTag({ ...automationConfig(automation), enabled: undefined })
      ) {
        if (!automation.presetId && previous.agentName) {
          throw new SettingsManagementError(
            'INVALID_PRESET',
            `Choose a presetId for “${automation.name}”: its agent, ${previous.agentName}, isn’t set up on this computer.`,
            422
          );
        }
        save('edit');
      } else if (previous.enabled !== automation.enabled) {
        // Only the switch changed, which works without its agent on this computer.
        if (automation.enabled) starts(automation);
        changes.push({
          operation: 'change',
          kind: 'automation',
          title: automation.name,
          details: [{ label: 'Runs on schedule', value: automation.enabled ? 'On' : 'Off' }],
        });
        steps.push({
          name: automation.name,
          apply: () =>
            this.deps.automations.setEnabled(previous.target, previous.id!, automation.enabled!),
        });
      }
    }
    // Deleted last, so a change that fails leaves what it was replacing.
    for (const automation of before) {
      if (seen.has(automation.id!)) continue;
      changes.push(this.describeAutomation('delete', automation, presets));
      steps.push({
        name: automation.name,
        apply: () => this.deps.automations.delete(automation.target, automation.id!),
      });
    }
    return { changes, steps, startsAgents, skipPrompts };
  }

  private normalizeAutomation(
    project: Project,
    input: SettingsAutomation,
    previous: SettingsAutomation | undefined
  ): SettingsAutomation {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const invalid = (message: string) =>
      new SettingsManagementError('INVALID_AUTOMATION', message, 422);
    if (!name) throw invalid('Automation names must not be empty.');
    if (!prompt) throw invalid(`Write the prompt “${name}” starts its agent with.`);
    const targetProblem = this.automationTargetProblem(project, input.target);
    if (targetProblem) throw invalid(`${targetProblem}: “${name}”.`);
    const schedule = {
      cron: input.schedule.cron.trim(),
      timeZone:
        input.schedule.timeZone ?? previous?.schedule.timeZone ?? this.deps.automations.timeZone(),
    };
    const scheduleError = automationScheduleError(schedule);
    if (scheduleError) throw invalid(`“${name}”: ${scheduleError}`);
    const missedRunGraceMinutes =
      input.missedRunGraceMinutes ??
      previous?.missedRunGraceMinutes ??
      DEFAULT_AUTOMATION_MISSED_RUN_GRACE_MINUTES;
    if (
      !(AUTOMATION_MISSED_RUN_GRACE_MINUTES as readonly number[]).includes(missedRunGraceMinutes)
    ) {
      throw invalid(
        `missedRunGraceMinutes must be one of ${AUTOMATION_MISSED_RUN_GRACE_MINUTES.join(', ')}.`
      );
    }
    // Empty goes back to the project's target branch.
    const startBranch = (input.startBranch ?? previous?.startBranch)?.trim();
    if (startBranch && project.kind === 'directory') {
      throw invalid(`Folder projects have no branches to start “${name}” from.`);
    }
    return {
      ...(input.id ? { id: input.id } : {}),
      name,
      prompt,
      target:
        input.target.kind === 'local'
          ? { kind: 'local' }
          : { kind: 'ssh', hostId: input.target.hostId },
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.launchModeId ? { launchModeId: input.launchModeId } : {}),
      ...(startBranch ? { startBranch } : {}),
      schedule,
      enabled: input.enabled ?? previous?.enabled ?? true,
      missedRunGraceMinutes,
    };
  }

  private automationTargetProblem(project: Project, target: AutomationTarget): string | undefined {
    if (target.kind === 'local') return undefined;
    if (project.kind === 'directory') return 'Folder projects can’t run automations on an SSH host';
    const known = this.deps
      .environmentConfiguration()
      .sshHosts.some((host) => host.id === target.hostId);
    return known ? undefined : `Unknown SSH host ${target.hostId}`;
  }

  private automationAgent(
    automation: SettingsAutomation,
    presets: Map<string, AgentPreset>
  ): { preset?: AgentPreset; mode?: LaunchMode } {
    const preset = automation.presetId ? presets.get(automation.presetId) : undefined;
    const mode = automation.launchModeId
      ? preset?.launchModes.find((candidate) => candidate.id === automation.launchModeId)
      : undefined;
    return { preset, mode };
  }

  private describeAutomation(
    operation: 'add' | 'edit' | 'delete',
    automation: SettingsAutomation,
    presets: Map<string, AgentPreset>
  ): SettingsApprovalChange {
    const { target, schedule } = automation;
    const { preset, mode } = this.automationAgent(automation, presets);
    const details: SettingsApprovalChange['details'] = [
      { label: 'Schedule', value: `${schedule.cron} (${schedule.timeZone})` },
      {
        label: 'Runs on',
        value:
          target.kind === 'local'
            ? 'This computer'
            : (this.deps.automations.hostName(target.hostId) ?? target.hostId),
      },
      {
        label: 'Agent',
        value:
          (preset?.name ?? automation.agentName ?? 'Default agent') +
          (mode ? ` (${mode.name})` : ''),
      },
      ...(automation.startBranch ? [{ label: 'Starts from', value: automation.startBranch }] : []),
    ];
    if (operation !== 'delete') {
      if (mode && skipsPermissionPrompts(mode)) {
        details.push({ label: 'Permission prompts', value: 'Skipped' });
      }
      details.push({ label: 'Runs on schedule', value: automation.enabled ? 'On' : 'Off' });
    }
    return {
      operation,
      kind: 'automation',
      title: automation.name,
      contentLabel: 'Prompt',
      content: automation.prompt,
      details,
    };
  }

  /** The appearance showing, which with followSystem depends on the system appearance. */
  readAppearance(): AppearanceRepresentation {
    const theme = shownTheme(this.deps.appearance.get(), this.deps.appearance.systemIsDark());
    return representAppearance(
      appearanceOf(theme, { palette: theme.palette, accent: theme.colors.accent })
    );
  }

  async proposeAppearance(
    context: SettingsRequestContext,
    desired: AppearanceSettings,
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<AppearanceRepresentation>> {
    try {
      return await this.proposeAppearanceInternal(context, desired, signal);
    } catch (error) {
      this.feedbackRejected(error, context);
      throw error;
    }
  }

  private async proposeAppearanceInternal(
    context: SettingsRequestContext,
    desired: AppearanceSettings,
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<AppearanceRepresentation>> {
    const problems = appearanceProblems(desired);
    if (problems.length > 0) {
      throw new SettingsManagementError(
        'INVALID_APPEARANCE',
        'Fix the appearance settings and apply them again.',
        422,
        problems.map((message) => ({ message }))
      );
    }
    // With followSystem, the desired theme replaces the theme of its own mode, whichever shows, so
    // the system appearance switching while the user decides changes nothing here.
    const mode = themeMode(desired.palette, desired.customPalette);
    const replaced = () => {
      const theme = this.deps.appearance.get();
      return appearanceOf(theme, themeSlot(theme, mode));
    };
    const current = replaced();
    const proposalTag = appearanceTag(current);
    if (appearanceTag(desired) === proposalTag) {
      return { status: 'unchanged', applied: false };
    }
    const shows = this.deps.appearance.get().followSystem
      ? `While your system is ${mode === 'light' ? 'light' : 'dark'}`
      : undefined;
    const key = 'appearance';
    this.acquire(key);
    try {
      const approved = await this.deps.approve(
        {
          resource: 'appearance',
          workspace: this.findWorkspace(context),
          changes: this.describeAppearanceChanges(current, desired, shows),
          preview: desired,
        },
        signal
      );
      if (!approved || signal?.aborted) {
        return { status: 'cancelled', applied: false };
      }
      if (appearanceTag(replaced()) !== proposalTag) {
        throw new SettingsManagementError('STALE_VERSION', 'Appearance has changed.', 412);
      }
      this.deps.appearance.set(desired);
      return { status: 'applied', applied: true, value: representAppearance(replaced()) };
    } finally {
      this.pending.delete(key);
    }
  }

  /** With `shows`, when the theme and accent show: followSystem keeps one for each appearance. */
  private describeAppearanceChanges(
    before: AppearanceSettings,
    after: AppearanceSettings,
    shows?: string
  ): SettingsApprovalChange[] {
    const changes: SettingsApprovalChange[] = [];
    const showsDetail = shows === undefined ? [] : [{ label: 'Shows', value: shows }];
    if (themeName(before) !== themeName(after)) {
      changes.push({
        operation: 'change',
        kind: 'theme',
        title: themeName(after),
        details: [{ label: 'From', value: themeName(before) }, ...showsDetail],
      });
    }
    const { customPalette: oldCustom } = before;
    const { customPalette: newCustom } = after;
    const customChanged =
      JSON.stringify(sortedKeys(oldCustom ?? null)) !==
      JSON.stringify(sortedKeys(newCustom ?? null));
    if (customChanged) {
      const custom = newCustom ?? oldCustom!;
      changes.push({
        operation: !oldCustom ? 'add' : !newCustom ? 'delete' : 'edit',
        kind: 'custom-theme',
        title: custom.name?.trim() || 'Custom',
        details: [{ label: 'Mode', value: custom.mode === 'light' ? 'Light' : 'Dark' }],
      });
    }
    if (before.accent !== after.accent) {
      changes.push({
        operation: 'change',
        kind: 'accent-color',
        title: after.accent,
        details: [{ label: 'From', value: before.accent }, ...showsDetail],
      });
    }
    if (before.borderRadius !== after.borderRadius) {
      changes.push({
        operation: 'change',
        kind: 'corner-radius',
        title: `${after.borderRadius}px`,
        details: [{ label: 'From', value: `${before.borderRadius}px` }],
      });
    }
    return changes;
  }

  readSettingsFile(resource: SettingsFileResource): Record<string, unknown> {
    return this.deps.files[resource].read();
  }

  /** The settings file's format, as text for an agent and as JSON Schema. */
  readSettingsFileSchema(resource: SettingsFileResource): {
    resource: SettingsFileResource;
    text: string;
    sections: { title?: string; schema: Record<string, unknown> }[];
  } {
    const cached = this.schemas.get(resource);
    if (cached) return cached;
    const sections = this.deps.files[resource].schema;
    const schema = {
      resource,
      text: describeSettingsSchema(resource, sections),
      sections: sections.map((section) => ({
        ...(section.title && { title: section.title }),
        schema: settingsJsonSchema(section),
      })),
    };
    this.schemas.set(resource, schema);
    return schema;
  }

  async proposeSettingsFile(
    context: SettingsRequestContext,
    resource: SettingsFileResource,
    desired: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<Record<string, unknown>>> {
    try {
      return await this.proposeSettingsFileInternal(context, resource, desired, signal);
    } catch (error) {
      this.feedbackRejected(error, context);
      throw error;
    }
  }

  private async proposeSettingsFileInternal(
    context: SettingsRequestContext,
    resource: SettingsFileResource,
    desired: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<SettingsProposalResult<Record<string, unknown>>> {
    const file = this.deps.files[resource];
    const revision = file.revision();
    const prepared = file.prepare(desired);
    if ('problems' in prepared) {
      throw new SettingsManagementError(
        'INVALID_SETTINGS',
        `Fix the ${file.name} settings and apply them again.`,
        422,
        prepared.problems.map((message) => ({ message }))
      );
    }
    if (prepared.changes.length === 0) return { status: 'unchanged', applied: false };
    this.acquire(resource);
    try {
      const approved = await this.deps.approve(
        {
          resource,
          workspace: this.findWorkspace(context),
          changes: prepared.changes,
          ...(prepared.warning && { warning: prepared.warning }),
        },
        signal
      );
      if (!approved || signal?.aborted) {
        return { status: 'cancelled', applied: false };
      }
      if (file.revision() !== revision) {
        throw new SettingsManagementError('STALE_VERSION', `${file.name} has changed.`, 412);
      }
      file.write(prepared.next);
      return { status: 'applied', applied: true, value: file.read() };
    } finally {
      this.pending.delete(resource);
    }
  }

  private requireWorkspaceSetupSupported(project: Project): void {
    if (project.kind === 'directory') {
      throw new SettingsManagementError(
        'WORKSPACE_SETUP_UNSUPPORTED',
        'Directory projects do not support Workspace Setup.',
        422
      );
    }
  }

  private actionsTag(actions: Action[]): string {
    return hashTag(actions.map(actionConfig));
  }

  private requireCurrentStorageRevision(
    state: StorageRevisionState,
    resource: 'Quick Commands' | 'Workspace Setup'
  ): string {
    if (state.status === 'unreadable') {
      throw new SettingsManagementError(
        'SETTINGS_READ_FAILED',
        `Failed to read ${resource} settings.`,
        500,
        [],
        false
      );
    }
    if (state.status === 'changed') {
      throw new SettingsManagementError('STALE_VERSION', this.changedMessage(resource), 412);
    }
    return state.revision;
  }

  private changedMessage(resource: 'Quick Commands' | 'Workspace Setup'): string {
    return `${resource} ${resource === 'Quick Commands' ? 'have' : 'has'} changed.`;
  }

  private requireUnchangedStorageRevision(
    state: StorageRevisionState,
    expectedRevision: string,
    resource: 'Quick Commands' | 'Workspace Setup'
  ): void {
    const currentRevision = this.requireCurrentStorageRevision(state, resource);
    if (currentRevision !== expectedRevision) {
      throw new SettingsManagementError('STALE_VERSION', this.changedMessage(resource), 412);
    }
  }

  private resolveProject(context: SettingsRequestContext): {
    project: Project;
    workspace?: Workspace;
  } {
    const terminalWorkspace = context.terminalId
      ? this.deps.workspaces.findWorkspaceByTerminalId(context.terminalId)
      : undefined;
    const explicitWorkspace = context.workspaceId
      ? this.deps.workspaces.get(context.workspaceId)
      : undefined;
    if (context.workspaceId && !explicitWorkspace) {
      throw new SettingsManagementError(
        'PROJECT_CONTEXT_REQUIRED',
        'Komla workspace identity could not be resolved.',
        422
      );
    }
    if (terminalWorkspace && explicitWorkspace && terminalWorkspace.id !== explicitWorkspace.id) {
      throw new SettingsManagementError(
        'PROJECT_CONTEXT_CONFLICT',
        'Terminal and workspace identity resolve to different workspaces.',
        409
      );
    }
    for (const workspace of [terminalWorkspace, explicitWorkspace]) {
      if (
        workspace &&
        context.sshHostId &&
        (workspace.backend?.kind !== 'ssh' || workspace.backend.hostId !== context.sshHostId)
      ) {
        throw new SettingsManagementError(
          'PROJECT_CONTEXT_CONFLICT',
          'Workspace identity does not belong to the forwarded SSH host.',
          409
        );
      }
    }
    const terminalProject = terminalWorkspace?.projectId
      ? this.deps.projects.get(terminalWorkspace.projectId)
      : undefined;
    const explicitProject = explicitWorkspace?.projectId
      ? this.deps.projects.get(explicitWorkspace.projectId)
      : undefined;
    const cwd = context.cwd
      ? this.deps.resolveProjectByCwd(context.cwd, context.sshHostId)
      : undefined;
    const projectIds = new Set(
      [terminalProject, explicitProject, cwd?.project]
        .filter((project): project is Project => Boolean(project))
        .map((project) => project.id)
    );
    if (projectIds.size > 1) {
      throw new SettingsManagementError(
        'PROJECT_CONTEXT_CONFLICT',
        'Settings identity hints resolve to different projects.',
        409
      );
    }
    const project = terminalProject ?? explicitProject ?? cwd?.project;
    if (!project) {
      throw new SettingsManagementError(
        'PROJECT_CONTEXT_REQUIRED',
        cwd?.error ?? 'Current project could not be resolved.',
        422
      );
    }
    return { project, workspace: terminalWorkspace ?? explicitWorkspace ?? cwd?.workspace };
  }

  private buildDesiredActions(
    all: Action[],
    scope: SettingsActionScope,
    project: Project | undefined,
    desired: SettingsAction[]
  ): Action[] {
    const ids = desired.flatMap((action) => (action.id ? [action.id] : []));
    if (new Set(ids).size !== ids.length) {
      throw new SettingsManagementError(
        'DUPLICATE_ACTION_ID',
        'Quick Command IDs must be unique.',
        400
      );
    }
    const applicable = all.filter((action) =>
      scope === 'global' ? !action.projectIds?.length : action.projectIds?.includes(project!.id)
    );
    const applicableIds = new Set(applicable.map((action) => action.id));
    for (const input of desired) {
      if (!input.title.trim() || !input.content.trim()) {
        throw new SettingsManagementError(
          'INVALID_ACTION',
          'Quick Command title and content are required.',
          422
        );
      }
      assertCommandOnlyFields(input);
      if (input.id && !applicableIds.has(input.id)) {
        throw new SettingsManagementError(
          'UNKNOWN_ACTION_ID',
          `Unknown Quick Command ID: ${input.id}`,
          422
        );
      }
      const existing = input.id ? all.find((action) => action.id === input.id)! : undefined;
      if (!existing && input.projectCount !== undefined) {
        throw new SettingsManagementError(
          'INVALID_ACTION_METADATA',
          'New Quick Commands must omit projectCount.',
          400
        );
      }
      if (
        existing?.projectIds &&
        input.projectCount !== undefined &&
        input.projectCount !== existing.projectIds.length
      ) {
        throw new SettingsManagementError(
          'STALE_ACTION_METADATA',
          'Quick Command project count has changed.',
          412
        );
      }
    }
    if (scope === 'current-project') {
      const desiredIds = new Set(ids);
      const omittedShared = applicable.find(
        (action) => (action.projectIds?.length ?? 0) > 1 && !desiredIds.has(action.id)
      );
      if (omittedShared) {
        throw new SettingsManagementError(
          'MULTI_PROJECT_ACTION_REQUIRED',
          `Multi-project Quick Command “${omittedShared.title}” cannot be removed from this resource.`,
          422
        );
      }
    }
    const replacements = desired.map((input): Action => {
      const existing = input.id ? all.find((action) => action.id === input.id)! : undefined;
      return {
        id: input.id ?? this.generateId(),
        title: input.title,
        content: input.content,
        ...(input.type === 'command' ? { type: 'command' as const } : {}),
        ...(scope === 'current-project'
          ? { projectIds: existing?.projectIds ?? [project!.id] }
          : {}),
        ...(input.presetId ? { presetId: input.presetId } : {}),
        ...(input.launchModeId ? { launchModeId: input.launchModeId } : {}),
        ...(input.type === 'command' && input.sshExecutionLocation
          ? { sshExecutionLocation: input.sshExecutionLocation }
          : {}),
        ...(input.type === 'command' && input.background ? { background: true } : {}),
        ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
        ...(existing?.lastUserInput !== undefined ? { lastUserInput: existing.lastUserInput } : {}),
      };
    });
    const lastApplicableIndex = all.findLastIndex((action) => applicableIds.has(action.id));
    let replacementIndex = 0;
    const merged = all.flatMap((action, index) => {
      if (!applicableIds.has(action.id)) return [action];
      const replacement = replacements[replacementIndex++];
      const result = replacement ? [replacement] : [];
      if (index === lastApplicableIndex) {
        result.push(...replacements.slice(replacementIndex));
        replacementIndex = replacements.length;
      }
      return result;
    });
    return lastApplicableIndex === -1 ? [...all, ...replacements] : merged;
  }

  private validateActionReferences(actions: Action[]): void {
    const presets = new Map(this.deps.presets.list().map((preset) => [preset.id, preset]));
    for (const action of actions) {
      this.validatePresetSelection(action.presetId, action.launchModeId, presets);
    }
  }

  private actionsInScope(
    actions: Action[],
    scope: SettingsActionScope,
    project?: Project
  ): Action[] {
    return actions.filter((action) =>
      scope === 'global' ? !action.projectIds?.length : action.projectIds?.includes(project!.id)
    );
  }

  private validateActionDeletions(before: Action[], after: Action[]): void {
    const remaining = new Set(after.map((action) => action.id));
    const deleted = new Map(
      before.filter((action) => !remaining.has(action.id)).map((action) => [action.id, action])
    );
    const details: Array<{
      action: { id: string; title: string };
      project: { id: string; name: string };
      step: { id: string; name: string };
    }> = [];
    for (const project of this.deps.projects.list()) {
      for (const step of project.setupSteps ?? []) {
        if (step.actionId && deleted.has(step.actionId)) {
          const action = deleted.get(step.actionId)!;
          details.push({
            action: { id: action.id, title: action.title },
            project: { id: project.id, name: project.name },
            step: { id: step.id, name: step.name },
          });
        }
      }
    }
    if (details.length) {
      throw new SettingsManagementError(
        'ACTION_STILL_REFERENCED',
        `Quick Command “${details[0].action.title}” is used by Workspace Setup.`,
        422,
        details
      );
    }
  }

  private normalizeSetup(project: Project, desired: WorkspaceSetupInput): WorkspaceSetupState {
    const existingIds = new Set((project.setupSteps ?? []).map((step) => step.id));
    const suppliedIds = desired.setupSteps.flatMap((step) => (step.id ? [step.id] : []));
    if (new Set(suppliedIds).size !== suppliedIds.length) {
      throw new SettingsManagementError(
        'DUPLICATE_SETUP_STEP_ID',
        'Setup step IDs must be unique.',
        400
      );
    }
    for (const id of suppliedIds) {
      if (!existingIds.has(id)) {
        throw new SettingsManagementError(
          'UNKNOWN_SETUP_STEP_ID',
          `Unknown setup step ID: ${id}`,
          422
        );
      }
    }
    return {
      ...desired,
      setupSteps: desired.setupSteps.map((step) => ({
        ...step,
        id: step.id || this.generateId(),
        destination: step.destination ?? 'workspace-repository',
        trigger: step.trigger ?? 'every-workspace-start',
      })),
    };
  }

  private validateSetup(setup: WorkspaceSetupState, project: Project): void {
    const actions = new Map(this.deps.actions.list().map((action) => [action.id, action]));
    const presets = new Map(this.deps.presets.list().map((preset) => [preset.id, preset]));
    for (const step of setup.setupSteps) {
      if (step.actionId) {
        const action = actions.get(step.actionId);
        if (!action || (action.projectIds?.length && !action.projectIds.includes(project.id))) {
          throw new SettingsManagementError(
            'INVALID_ACTION_REFERENCE',
            'Setup step Quick Command is not available to this project.',
            422
          );
        }
      }
      this.validatePresetSelection(step.agent?.presetId, step.agent?.launchModeId, presets);
      if (
        step.trigger === 'workspace-stop' &&
        (step.agent || (step.actionId && actions.get(step.actionId)?.type !== 'command'))
      ) {
        throw new SettingsManagementError(
          'INVALID_STOP_STEP',
          'A workspace-stop step runs a shell command or Terminal Command, not an agent.',
          422
        );
      }
    }
  }

  private validatePresetSelection(
    presetId: string | undefined,
    launchModeId: string | undefined,
    presets: Map<string, AgentPreset>
  ): void {
    const preset = presetId ? presets.get(presetId) : undefined;
    if (presetId && !preset) {
      throw new SettingsManagementError('INVALID_PRESET', `Unknown preset: ${presetId}`, 422);
    }
    if (launchModeId && !presetId) {
      throw new SettingsManagementError(
        'INVALID_LAUNCH_MODE',
        'A launch mode requires a preset.',
        422
      );
    }
    if (launchModeId && !preset?.launchModes.some((mode) => mode.id === launchModeId)) {
      throw new SettingsManagementError(
        'INVALID_LAUNCH_MODE',
        'Launch mode does not belong to the preset.',
        422
      );
    }
  }

  private acquire(key: string): void {
    if (this.pending.has(key)) {
      throw new SettingsManagementError(
        'APPROVAL_PENDING',
        'A settings approval is already pending.',
        409
      );
    }
    this.pending.add(key);
  }

  private feedbackRejected(error: unknown, context: SettingsRequestContext): void {
    if (error instanceof SettingsManagementError && !error.shouldNotify) return;
    const message =
      error instanceof SettingsManagementError ? error.message : 'Failed to update settings.';
    this.deps.feedback(message, this.findWorkspace(context));
  }

  // The caller's workspace when it has one, so Komla asks in that workspace's window.
  private findWorkspace(context: SettingsRequestContext): Workspace | undefined {
    let workspace = context.terminalId
      ? this.deps.workspaces.findWorkspaceByTerminalId(context.terminalId)
      : undefined;
    if (!workspace && context.workspaceId) {
      workspace = this.deps.workspaces.get(context.workspaceId);
    }
    if (!workspace && context.cwd) {
      try {
        workspace = this.deps.resolveProjectByCwd(context.cwd, context.sshHostId).workspace;
      } catch {
        // Komla falls back to the focused window.
      }
    }
    return workspace;
  }

  private describeActionChanges(before: Action[], after: Action[]): SettingsApprovalChange[] {
    return describeActionChanges(before, after, this.deps.presets.list());
  }

  private describeSetupChanges(
    before: WorkspaceSetupState,
    after: WorkspaceSetupState
  ): SettingsApprovalChange[] {
    return describeSetupChanges(before, after, this.deps.actions.list());
  }

  private setupCapabilities(
    context: SettingsRequestContext,
    workspace: Workspace | undefined,
    project: Project
  ): WorkspaceSetupCapabilities {
    const configuration = this.deps.environmentConfiguration();
    const { environment, issue } = resolveWorkspaceCreationEnvironment(configuration);
    const selected = issue ? undefined : environment;

    return {
      ...(workspace ? { currentEnvironment: this.currentEnvironment(context, workspace) } : {}),
      ssh: {
        configured: configuration.sshHosts.length > 0,
        selectedForNewWorkspaces: selected?.kind === 'ssh',
        actionsRunInLocalCopy:
          resolveSshWorkspaceMode(
            configuration.defaultSshWorkspaceMode,
            project.sshWorkspaceMode
          ) === 'local-mirror-actions',
      },
    };
  }

  private currentEnvironment(
    context: SettingsRequestContext,
    workspace: Workspace
  ): NonNullable<WorkspaceSetupCapabilities['currentEnvironment']> {
    if (isSshWorkspace(workspace)) {
      const terminal = context.terminalId
        ? workspace.terminals.find((candidate) => candidate.id === context.terminalId)
        : undefined;
      return isLocalTerminalExecutionLocation(terminal?.executionLocation)
        ? { kind: 'ssh-local-copy' }
        : { kind: 'ssh' };
    }
    return { kind: 'local' };
  }

  private multiProjectWarning(before: Action[], after: Action[]): string | undefined {
    const old = new Map(before.map((action) => [action.id, action]));
    const affected = after.filter(
      (action) =>
        (action.projectIds?.length ?? 0) > 1 &&
        JSON.stringify(actionConfig(old.get(action.id) ?? action)) !==
          JSON.stringify(actionConfig(action))
    );
    if (!affected.length) return undefined;
    const projectNames = new Set<string>();
    for (const action of affected)
      for (const id of action.projectIds ?? []) {
        const project = this.deps.projects.get(id);
        if (project) projectNames.add(project.name);
      }
    return `These changes affect multiple projects: ${Array.from(projectNames).join(', ')}`;
  }
}
