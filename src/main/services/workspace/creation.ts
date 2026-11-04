import { basename } from 'path';

import {
  requestedWorkspaceEnvironment,
  resolveWorkspaceCreationEnvironment,
} from '../../../shared/lib/agent-environment';
import { projectRepoPath } from '../../../shared/lib/project-repo-path';
import {
  branchSuffixToName,
  generateBranchSuffix,
  sanitizeBranchName,
} from '../../../shared/lib/random-names';
import {
  normalizeSshStartPoint,
  normalizeSshTargetBranch,
} from '../../../shared/lib/ssh-target-branch';
import {
  isSshWorkspace,
  SshProjectNeedsRemoteError,
  type WorkspaceBackend,
} from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { createWorkspaceId } from '../../lib/workspace-id';
import { actionService } from '../action.service';
import { agentPresetService } from '../agent-preset.service';
import { configService } from '../config.service';
import { gitService } from '../git.service';
import { metricsCollectorService } from '../metrics-collector.service';
import { projectService } from '../project.service';
import { remoteCompanionService } from '../remote-companion.service';
import { sshHostService } from '../ssh-host.service';
import { sshWorkspaceProvisioningService } from '../ssh-workspace-provisioning.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceSetupService } from '../workspace-setup.service';
import { worktreeWatcherService } from '../worktree-watcher.service';

import {
  assertPromptAttachmentsExist,
  importPromptAttachments,
  publishCreated,
  resolveInitialCommand,
  resolveLaunchModeId,
  resolvePreset,
  resolveReasoningLevelId,
} from './agent-launch';
import { workspaceStore } from './store';
import {
  AUTO_BRANCH_MAX_ATTEMPTS,
  branchPrefix,
  createAutoBranchCandidate,
  createBranchConflictError,
  fastForwardManagedProjectTargetBeforeCreation,
  findBranchConflict,
  normalizeCreateWorktreeError,
  recoverMissingProjectBaseBranch,
  resolveLocalWorkspaceTarget,
  resolveSshTargetBranch,
  sshWorkspaceTargetBranch,
  toSafeWorktreePath,
  withBranchPrefix,
} from './worktree-branches';

import type { WorkspaceNaming } from './naming';
import type { WorkspaceProvisioning } from './provisioning';
import type { WorkspaceTerminals } from './terminals';
import type { CreateWorkspaceParams, Project, Workspace } from '../../../shared/types';
import type { SshHost } from '../../../shared/types/ssh';

const logger = createLogger('WorkspaceService');

/** The Action a workspace's run button starts on: the most recently run one its project has. */
function lastUsedActionId(projectId: string | null): string | undefined {
  let lastUsed: { id: string; lastUsedAt: number } | undefined;
  for (const action of actionService.list()) {
    const inProject =
      !action.projectIds?.length || (projectId !== null && action.projectIds.includes(projectId));
    if (inProject && action.lastUsedAt && action.lastUsedAt > (lastUsed?.lastUsedAt ?? 0)) {
      lastUsed = { id: action.id, lastUsedAt: action.lastUsedAt };
    }
  }
  return lastUsed?.id;
}

/** Branches an SSH host fetches from origin to start this workspace. */
async function sshBranchesToPublish(
  params: CreateWorkspaceParams,
  project: Project,
  repoPath: string
): Promise<string[]> {
  const targetBranch =
    resolveSshTargetBranch(project, normalizeSshTargetBranch(params.baseBranch)) ||
    (await gitService.getTargetBranch(repoPath).catch(() => undefined));
  const existingBranch = params.checkoutExistingBranch
    ? normalizeSshTargetBranch(params.branchName)
    : undefined;
  const branches = [targetBranch, normalizeSshTargetBranch(params.baseBranch), existingBranch];
  return [...new Set(branches.filter((branch): branch is string => !!branch))];
}

// Records the worktree start point as workspace metadata only when it differs
// from the project's default — used for the "Branched from <branch>" badge on
// the workspace card. Has no effect on diffs or PR target (those use baseBranch).
function computeBranchedFrom(params: CreateWorkspaceParams, project: Project): string | undefined {
  if (!params.baseBranch) return undefined;
  if (params.baseBranch === project.baseBranch) return undefined;
  return params.baseBranch;
}

export interface WorkspaceCreationDeps {
  naming: WorkspaceNaming;
  terminals: WorkspaceTerminals;
  provisioning: WorkspaceProvisioning;
}

/** Creates workspaces from what the caller asked for: resolves where they run and publishes them. */
export class WorkspaceCreation {
  constructor(private readonly deps: WorkspaceCreationDeps) {}

  /** The Action a new workspace's run button starts on: the one that launches it, else the
   *  last used one its project has. */
  private resolveInitialDefaultActionId(
    params: CreateWorkspaceParams,
    projectId: string | null
  ): string | undefined {
    return params.defaultActionId ?? lastUsedActionId(projectId);
  }

  /** Normalize new environment intent and legacy fields before creation branches. */
  private resolveWorkspaceCreationParams(params: CreateWorkspaceParams): CreateWorkspaceParams {
    const config = configService.get();
    const configuredSshHosts = sshHostService.list();
    // The agent launch gate reads placement the same way, to know where an agent would start.
    let environment = requestedWorkspaceEnvironment(params);

    if (!environment) {
      const decision = resolveWorkspaceCreationEnvironment({
        ...config,
        sshHosts: configuredSshHosts,
      });
      // SSH hosts only run worktrees, so a folder opens locally instead.
      if (params.mode === 'directory' && decision.environment.kind === 'ssh') {
        decision.environment = { kind: 'local' };
        decision.issue = undefined;
      }
      if (decision.issue === 'missing-ssh-host') {
        throw new Error('The SSH host new workspaces start on is no longer configured.');
      }
      environment = decision.environment;
    }

    if (environment.kind === 'ssh') {
      const shouldValidateConfiguredHost =
        params.environment !== undefined || params.location?.kind !== 'ssh';
      if (shouldValidateConfiguredHost && !sshHostService.has(environment.hostId)) {
        throw new Error('The selected SSH host is no longer configured.');
      }
      const sourceWorkspace = params.sourceWorkspaceId
        ? workspaceStore.workspaces.get(params.sourceWorkspaceId)
        : undefined;
      const matchingSourceBackend =
        sourceWorkspace &&
        isSshWorkspace(sourceWorkspace) &&
        sourceWorkspace.backend.hostId === environment.hostId &&
        sourceWorkspace.projectId === (params.projectId ?? null)
          ? sourceWorkspace.backend
          : undefined;
      const existingLocation =
        params.location?.kind === 'ssh' && params.location.hostId === environment.hostId
          ? params.location
          : undefined;
      return {
        ...params,
        environment,
        location: matchingSourceBackend
          ? {
              kind: 'ssh',
              hostId: environment.hostId,
              gitUrl: matchingSourceBackend.gitUrl,
              sourceBackend: matchingSourceBackend,
            }
          : (existingLocation ?? { kind: 'ssh', hostId: environment.hostId }),
      };
    }

    return {
      ...params,
      environment: { kind: 'local' },
      location: { kind: 'local' },
    };
  }

  async create(params: CreateWorkspaceParams): Promise<Workspace> {
    return this.createResolved(this.resolveWorkspaceCreationParams(params));
  }

  async createBatch(params: CreateWorkspaceParams[]): Promise<Workspace[]> {
    if (params.length === 0) return [];
    params = params.map((entry) => this.resolveWorkspaceCreationParams(entry));
    const results = await Promise.allSettled(params.map((entry) => this.createResolved(entry)));
    const workspaces: Workspace[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      workspaces.push(result.value);
    }
    return workspaces;
  }

  /** Creates from params `resolveWorkspaceCreationParams` already resolved. */
  private async createResolved(params: CreateWorkspaceParams): Promise<Workspace> {
    await assertPromptAttachmentsExist(params);
    let workingDirectory: string;
    let branchName: string | undefined;
    let isWorktree: boolean;
    let projectId: string | null;
    let repoName: string | undefined;
    let baseBranch: string | undefined;
    let branchedFrom: string | undefined;
    let backend: WorkspaceBackend | undefined;
    let prepareCreatedSshWorkspace: ((workspace: Workspace) => Promise<void>) | undefined;

    if (params.location?.kind === 'ssh') {
      if (params.mode !== 'worktree') {
        throw new Error('SSH workspaces only support worktree mode');
      }
      const project = params.projectId ? projectService.get(params.projectId) : undefined;
      if (params.projectId && !project) {
        throw new Error(`Project ${params.projectId} not found`);
      }
      if (project?.kind === 'directory') {
        throw new Error('Directory projects cannot create SSH worktree workspaces');
      }
      const repoPath =
        project?.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project?.repositoryPath;
      if (!project && !params.location.gitUrl) {
        throw new Error('A git project is required for SSH workspaces');
      }
      // Don't wait behind a background fetch of the project; creation fetches what it needs.
      if (repoPath) gitService.stopBackgroundWork(repoPath);
      const remoteUrl = repoPath ? await gitService.getRemoteUrl(repoPath).catch(() => null) : null;
      const gitUrl = params.location.gitUrl?.trim() || remoteUrl;
      if (!gitUrl) {
        if (!project || !repoPath) {
          throw new Error('SSH workspaces require a Git remote URL.');
        }
        throw new SshProjectNeedsRemoteError({
          projectId: project.id,
          branches: await sshBranchesToPublish(params, project, repoPath),
        });
      }
      this.startSshHostPreparation(params.location.hostId, !params.location.sourceBackend);
      if (project && params.deferBranchNaming) {
        return this.createDeferredSshWorkspace(params, project, gitUrl);
      }
      const workspaceStartPoint = normalizeSshStartPoint(params.baseBranch);
      const workspaceBaseBranch = sshWorkspaceTargetBranch(params);
      const sshProjectBaseBranch = resolveSshTargetBranch(project, workspaceBaseBranch);
      const requestedStartPoint = workspaceStartPoint || sshProjectBaseBranch;
      const startsFromProjectTarget =
        !!sshProjectBaseBranch &&
        normalizeSshTargetBranch(requestedStartPoint) === sshProjectBaseBranch;
      // The host resolves its own branches, which origin doesn't have.
      const startPoint = !requestedStartPoint
        ? undefined
        : startsFromProjectTarget || params.baseBranchOnHost
          ? requestedStartPoint
          : project && repoPath && !params.location.sourceBackend
            ? await gitService.resolvePublishedCommit(repoPath, requestedStartPoint || 'HEAD')
            : requestedStartPoint;
      const requestedBranch = params.branchName?.trim() || generateBranchSuffix();
      branchName = params.useExactBranchName
        ? requestedBranch
        : withBranchPrefix(requestedBranch, branchPrefix(project));
      const resolvedBasePath = params.location.sourceBackend
        ? undefined
        : await sshWorkspaceService.resolveWorkspaceBasePath(params.location.hostId);
      const sshLocation = params.location;
      const createSshPlan = (candidate: string) =>
        sshWorkspaceService.createWorkspacePlan({
          hostId: sshLocation.hostId,
          gitUrl,
          projectId: project?.id,
          projectName: project?.name ?? branchSuffixToName(requestedBranch),
          branchName: candidate,
          checkoutExistingBranch: params.checkoutExistingBranch,
          baseBranch: sshProjectBaseBranch,
          startPoint,
          resolvedBasePath,
          sourceBackend: sshLocation.sourceBackend,
        });
      const sshPlan = sshWorkspaceProvisioningService.plan({
        initialBranchName: branchName,
        params,
        branchPrefix: branchPrefix(project),
        createPlan: createSshPlan,
      });
      const { remote } = sshPlan;
      branchName = sshPlan.branchName;
      workingDirectory = remote.workingDirectory;
      backend = remote.backend;
      baseBranch = sshProjectBaseBranch;
      branchedFrom = project ? computeBranchedFrom(params, project) : undefined;
      isWorktree = true;
      projectId = project?.id ?? null;
      repoName = project?.name ?? remote.repoName;
      prepareCreatedSshWorkspace = async (workspace) => {
        await sshWorkspaceProvisioningService.prepare(workspace, {
          initialBranchName: sshPlan.branchName,
          params,
          branchPrefix: branchPrefix(project),
          createPlan: createSshPlan,
        });
      };
    } else if (params.mode === 'worktree') {
      if (!params.projectId) {
        throw new Error('Project ID is required for worktree mode');
      }
      const project = projectService.get(params.projectId);
      if (!project) {
        throw new Error(`Project ${params.projectId} not found`);
      }
      if (project.kind === 'directory') {
        throw new Error('Directory projects cannot create worktree workspaces');
      }
      // Don't wait behind a background fetch of the project; creation fetches what it needs.
      gitService.stopBackgroundWork(projectRepoPath(project));

      if (params.deferBranchNaming) {
        return this.createDeferredWorkspace(params, project);
      }

      const result = await this.createWorktreeWithRetries(params, project);
      workingDirectory = result.workingDirectory;
      branchName = result.branchName;
      baseBranch = result.baseBranch;
      branchedFrom = computeBranchedFrom(params, project);

      this.applyAutoNameFromBranch(params, project, branchName);

      isWorktree = true;
      projectId = params.projectId;
      repoName = project.name;
    } else {
      workingDirectory = this.resolveDirectoryWorkingDirectory(params);
      isWorktree = false;
      projectId = params.projectId ?? null;
      repoName = params.projectId ? projectService.get(params.projectId)?.name : undefined;
    }

    const workspace = this.buildWorkspaceObject({
      params,
      workingDirectory,
      branchName,
      isWorktree,
      projectId,
      repoName,
      baseBranch,
      branchedFrom,
      backend,
    });

    const activePreset = resolvePreset(params.presetId);
    workspace.presetId = activePreset?.id ?? null;
    workspace.launchModeId = resolveLaunchModeId(activePreset, params.launchModeId);
    workspace.reasoningLevelId = resolveReasoningLevelId(activePreset, params.reasoningLevelId);
    if (prepareCreatedSshWorkspace) {
      await prepareCreatedSshWorkspace(workspace);
    }
    const command = resolveInitialCommand(
      params,
      activePreset,
      workspace,
      await importPromptAttachments(workspace, params, activePreset)
    );
    if (activePreset && !params.skipRecordUsage) {
      agentPresetService.recordPresetUsage?.(
        activePreset.id,
        params.launchModeId,
        params.reasoningLevelId
      );
    }

    // Only publish the workspace after initial SSH preparation succeeds.
    for (const existingWorkspace of workspaceStore.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }
    workspaceStore.workspaces.set(workspace.id, workspace);
    workspaceStore.saveWorkspaces();
    this.armProjectIconPrompt(workspace);

    if (workspace.baseBranch && !isSshWorkspace(workspace)) {
      gitService.registerTargetBranch(workspace.workingDirectory, workspace.baseBranch);
    }

    if (!isSshWorkspace(workspace)) {
      worktreeWatcherService
        .startWatching(workspace.id, workspace.workingDirectory)
        .catch((err) => {
          logger.error(`Failed to start watcher for workspace ${workspace.id}:`, err);
        });
    }

    return this.spawnPrimaryTerminal(workspace, params, command);
  }

  // Its files, here or on its SSH host, are where the project's icons are found.
  private armProjectIconPrompt(workspace: Workspace): void {
    if (workspace.projectId) projectService.armIconPrompt(workspace.projectId, workspace.id);
  }

  /** Construct the new Workspace record from resolved create() inputs. */
  private buildWorkspaceObject(args: {
    params: CreateWorkspaceParams;
    workingDirectory: string;
    branchName: string | undefined;
    isWorktree: boolean;
    projectId: string | null;
    repoName: string | undefined;
    baseBranch: string | undefined;
    branchedFrom: string | undefined;
    backend?: WorkspaceBackend;
  }): Workspace {
    const {
      params,
      workingDirectory,
      branchName,
      isWorktree,
      projectId,
      repoName,
      baseBranch,
      branchedFrom,
      backend,
    } = args;
    const appConfig = configService.get();
    return {
      id: createWorkspaceId(),
      name: params.name || 'Workspace',
      customName: params.customName,
      customDescription: params.customDescription,
      customNameSource: params.customName ? 'manual' : undefined,
      workingDirectory,
      ...(backend ? { backend } : {}),
      branchName,
      isWorktree,
      projectId,
      ...(repoName ? { repoName } : {}),
      baseBranch,
      ...(branchedFrom ? { branchedFrom } : {}),
      windowId: params.windowId || null,
      categoryId: params.categoryId || null,
      fileTreeOpen: appConfig.defaultFileTreeOpen,
      fileTreeMode: appConfig.defaultFileTreeMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      order: 0,
      status: 'active',
      terminals: [],
      defaultActionId: this.resolveInitialDefaultActionId(params, projectId),
    };
  }

  /**
   * Spawn the workspace's primary terminal. Worktree-mode workspaces get a
   * chance to apply project setup steps first; if those produced a terminal,
   * we use that as the primary instead of opening a new one.
   */
  private async spawnPrimaryTerminal(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    command: string | null
  ): Promise<Workspace> {
    if (params.mode === 'worktree' && params.projectId) {
      const primaryTerminal = workspaceSetupService.start(workspace, command, 'create');
      if (primaryTerminal) {
        publishCreated(workspace, this.deps.naming.maybeAutoName(workspace, params));
        return workspace;
      }
    }
    const terminal = await this.deps.terminals.addTerminal(workspace.id, workspace.name, command);
    workspace.primaryTerminalId = terminal.id;
    publishCreated(workspace, this.deps.naming.maybeAutoName(workspace, params));
    return workspace;
  }

  /**
   * Build a placeholder workspace and kick off background provisioning.
   * Used when the caller passes deferBranchNaming so the UI gets an immediate
   * workspace row while branch naming + worktree creation run async.
   */
  private createDeferredWorkspace(params: CreateWorkspaceParams, project: Project): Workspace {
    const appConfig = configService.get();

    // When the caller already knows the branch name, include it on the
    // placeholder so the renderer can show accurate provisioning status.
    const placeholderBranch = params.branchName
      ? params.useExactBranchName
        ? params.branchName
        : withBranchPrefix(params.branchName, branchPrefix(project))
      : undefined;

    // Fail fast on branch conflicts when the caller didn't opt into auto-resolve.
    // This lets API callers get an immediate error instead of a silent provisionError.
    if (placeholderBranch && params.autoResolveBranchConflicts !== true) {
      const conflict = findBranchConflict(params.projectId!, placeholderBranch);
      if (conflict) {
        throw createBranchConflictError(placeholderBranch, conflict);
      }
    }

    for (const existingWorkspace of workspaceStore.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }

    // Resolve the preset once so the placeholder and the later
    // finishProvisioning pass resolve to the same preset, even if the
    // preset changes during async provisioning.
    const placeholderPreset = resolvePreset(params.presetId);

    const placeholderBranchedFrom = computeBranchedFrom(params, project);
    const workspace: Workspace = {
      id: createWorkspaceId(),
      name: params.name || 'Workspace',
      customName: params.customName,
      customDescription: params.customDescription,
      customNameSource: params.customName ? 'manual' : undefined,
      workingDirectory: '',
      branchName: placeholderBranch,
      isWorktree: true,
      projectId: project.id,
      repoName: project.name,
      baseBranch: project.baseBranch || undefined,
      ...(placeholderBranchedFrom ? { branchedFrom: placeholderBranchedFrom } : {}),
      windowId: params.windowId || null,
      categoryId: params.categoryId || null,
      fileTreeOpen: appConfig.defaultFileTreeOpen,
      fileTreeMode: appConfig.defaultFileTreeMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      order: 0,
      status: 'active',
      terminals: [],
      defaultActionId: this.resolveInitialDefaultActionId(params, params.projectId ?? null),
      ...(placeholderPreset
        ? {
            presetId: placeholderPreset.id,
            launchModeId: resolveLaunchModeId(placeholderPreset, params.launchModeId),
            reasoningLevelId: resolveReasoningLevelId(placeholderPreset, params.reasoningLevelId),
          }
        : {}),
      provisioning: true,
      provisioningRepoPath:
        project.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project.repositoryPath,
    };

    workspaceStore.workspaces.set(workspace.id, workspace);
    workspaceStore.saveWorkspaces();
    metricsCollectorService.increment('workspacesCreated');
    this.armProjectIconPrompt(workspace);

    // Fire-and-forget: finish provisioning in the background. The outer catch
    // is a safety net — finishProvisioning has its own try/catch, but if an
    // error escapes (e.g., broadcastWorkspaceUpdate throws inside the inner
    // catch), we must still clean up the provisioning state.
    this.deps.provisioning.finishProvisioning(workspace.id, params, project).catch((err) => {
      logger.error(`Provisioning failed for workspace ${workspace.id}:`, err);
      const ws = workspaceStore.workspaces.get(workspace.id);
      if (ws?.provisioning) {
        ws.provisioning = false;
        ws.provisionStatus = undefined;
        ws.provisionError = err instanceof Error ? err.message : 'Workspace setup failed';
        ws.provisioningRepoPath = undefined;
        workspaceStore.saveWorkspaces();
        try {
          workspaceStore.broadcastWorkspaceUpdate(ws);
        } catch (broadcastErr) {
          logger.warn('Failed to broadcast provisioning error update:', broadcastErr);
        }
      }
    });

    return workspace;
  }

  /**
   * Starts the host work SSH workspace creation waits on: the remote base path, the Remote
   * Companion worktree setup asks for, and the connections worktree setup and the first
   * terminal run on. Their handshakes then overlap each other and branch naming instead of
   * running one by one.
   */
  private startSshHostPreparation(hostId: string, resolveBasePath: boolean): void {
    let host: SshHost;
    try {
      host = sshWorkspaceService.getHost(hostId);
    } catch {
      return;
    }
    // The install reuses the connection the base path opens, so a host that asks for a
    // password asks once. Setup, and the companion every SSH workspace runs, reuse it.
    if (resolveBasePath) {
      void sshWorkspaceService
        .resolveWorkspaceBasePath(hostId)
        .then((basePath) => remoteCompanionService.ensureInstalled(host, basePath))
        .catch(() => undefined);
    }
    sshWorkspaceService.warmConnections(host);
  }

  private createDeferredSshWorkspace(
    params: CreateWorkspaceParams,
    project: Project,
    gitUrl: string
  ): Workspace {
    const appConfig = configService.get();
    const providedBranch = params.branchName && sanitizeBranchName(params.branchName);
    const placeholderSuffix = providedBranch || generateBranchSuffix();
    const placeholderBranch = params.useExactBranchName
      ? placeholderSuffix
      : withBranchPrefix(placeholderSuffix, branchPrefix(project));

    const placeholderPreset = resolvePreset(params.presetId);
    const sshLocation = params.location?.kind === 'ssh' ? params.location : undefined;
    if (!sshLocation) throw new Error('SSH workspace location is required');
    const workspaceStartPoint = normalizeSshStartPoint(params.baseBranch);
    const workspaceBaseBranch = sshWorkspaceTargetBranch(params);
    const sshProjectBaseBranch = resolveSshTargetBranch(project, workspaceBaseBranch);
    const initialPlan = sshWorkspaceProvisioningService.plan({
      initialBranchName: placeholderBranch,
      params,
      branchPrefix: branchPrefix(project),
      createPlan: (candidate) =>
        sshWorkspaceService.createWorkspacePlan({
          hostId: sshLocation.hostId,
          gitUrl,
          projectId: project.id,
          projectName: project.name,
          branchName: candidate,
          checkoutExistingBranch: params.checkoutExistingBranch,
          baseBranch: sshProjectBaseBranch,
          startPoint: workspaceStartPoint || sshProjectBaseBranch,
          sourceBackend: sshLocation.sourceBackend,
        }),
    });
    const { remote } = initialPlan;

    for (const existingWorkspace of workspaceStore.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }

    const workspace: Workspace = {
      id: createWorkspaceId(),
      name:
        params.name || (providedBranch ? branchSuffixToName(initialPlan.branchName) : 'Workspace'),
      customName: params.customName,
      customDescription: params.customDescription,
      customNameSource: params.customName ? 'manual' : undefined,
      workingDirectory: remote.workingDirectory,
      backend: remote.backend,
      branchName: providedBranch ? initialPlan.branchName : undefined,
      isWorktree: true,
      projectId: project.id,
      repoName: project.name,
      baseBranch: sshProjectBaseBranch,
      branchedFrom: computeBranchedFrom(params, project),
      windowId: params.windowId || null,
      categoryId: params.categoryId || null,
      fileTreeOpen: false,
      fileTreeMode: appConfig.defaultFileTreeMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      order: 0,
      status: 'active',
      terminals: [],
      defaultActionId: this.resolveInitialDefaultActionId(params, project.id),
      ...(placeholderPreset
        ? {
            presetId: placeholderPreset.id,
            launchModeId: resolveLaunchModeId(placeholderPreset, params.launchModeId),
            reasoningLevelId: resolveReasoningLevelId(placeholderPreset, params.reasoningLevelId),
          }
        : {}),
      provisioning: true,
      provisionStatus: providedBranch ? 'Checking remote branch' : 'Generating branch name',
    };

    workspaceStore.workspaces.set(workspace.id, workspace);
    workspaceStore.saveWorkspaces();
    metricsCollectorService.increment('workspacesCreated');
    this.armProjectIconPrompt(workspace);

    this.deps.provisioning
      .finishSshProvisioning(workspace.id, params, project, gitUrl)
      .catch((err) => {
        void this.deps.provisioning.recordProvisioningError(workspace.id, err);
      });

    return workspace;
  }

  /**
   * Run the worktree-creation loop, retrying with auto-renamed branches on
   * Komla-side or git-level conflicts when autoResolveBranchConflicts is on.
   * Returns the created working directory and the final branch name used.
   */
  private async createWorktreeWithRetries(
    params: CreateWorkspaceParams,
    project: Project
  ): Promise<{ workingDirectory: string; branchName: string; baseBranch: string | undefined }> {
    // Auto-generate branch name if not provided; sanitize user input.
    // Fall back to a random suffix if sanitization strips everything.
    const inputBranchName =
      (params.branchName && sanitizeBranchName(params.branchName)) || generateBranchSuffix();
    const initialBranchName = params.useExactBranchName
      ? inputBranchName
      : withBranchPrefix(inputBranchName, branchPrefix(project));

    const projectName = project.name;
    // For managed projects, create worktree from the bare clone.
    // This allows worktrees on any branch including main/master.
    const repoPath =
      project.managed && project.managedRepoPath ? project.managedRepoPath : project.repositoryPath;
    const target = await resolveLocalWorkspaceTarget(params, project, repoPath);
    let worktreeStartPoint = target.startPoint;
    let baseBranch = target.baseBranch;
    await fastForwardManagedProjectTargetBeforeCreation(
      params,
      project,
      repoPath,
      target.baseBranch
    );
    const shouldAutoResolveBranchConflict = params.autoResolveBranchConflicts === true;
    let branchName = initialBranchName;
    const nextCandidate = (attempt: number): string =>
      createAutoBranchCandidate(
        initialBranchName,
        branchPrefix(project),
        attempt,
        params.useExactBranchName
      );

    for (let attempt = 1; attempt <= AUTO_BRANCH_MAX_ATTEMPTS; attempt++) {
      const existingWorkspace = findBranchConflict(params.projectId!, branchName);
      if (existingWorkspace) {
        if (!shouldAutoResolveBranchConflict) {
          throw createBranchConflictError(branchName, existingWorkspace);
        }
        branchName = nextCandidate(attempt);
        continue;
      }

      const worktreeDestination = toSafeWorktreePath(projectName, branchName);
      try {
        const { path: workingDirectory } = await gitService.createWorktree(
          repoPath,
          branchName,
          worktreeDestination,
          worktreeStartPoint,
          { fetchRemote: params.fetchRemote }
        );
        return { workingDirectory, branchName, baseBranch };
      } catch (error) {
        if (!params.baseBranch) {
          const recoveredBaseBranch = await recoverMissingProjectBaseBranch(
            error,
            project,
            repoPath,
            worktreeStartPoint
          );
          if (recoveredBaseBranch) {
            worktreeStartPoint = recoveredBaseBranch;
            baseBranch = recoveredBaseBranch;
            // Retry the same branch candidate; base-branch recovery is not a name conflict.
            attempt--;
            continue;
          }
        }

        const normalizedError = normalizeCreateWorktreeError(error, branchName);
        const isConflict =
          normalizedError.message.includes('already has an active worktree') ||
          normalizedError.message.includes('already open in workspace');

        if (!isConflict || !shouldAutoResolveBranchConflict) {
          throw normalizedError;
        }
        branchName = nextCandidate(attempt);
      }
    }

    throw new Error(
      `Could not find an available branch name after ${AUTO_BRANCH_MAX_ATTEMPTS} attempts. Please try again.`
    );
  }

  /**
   * Validate directory-mode params and return the resolved working directory.
   * Mutates params.name to fall back to the directory basename when blank, so
   * the caller's later `params.name || 'Workspace'` still reflects this.
   */
  private resolveDirectoryWorkingDirectory(params: CreateWorkspaceParams): string {
    let directoryPath = params.directoryPath;
    if (params.projectId) {
      const project = projectService.get(params.projectId);
      if (!project) {
        throw new Error(`Project ${params.projectId} not found`);
      }
      if (project.kind !== 'directory') {
        throw new Error('Directory mode requires a directory project');
      }
      directoryPath = project.repositoryPath;
    }

    if (!directoryPath) {
      throw new Error('Directory path is required for directory mode');
    }
    // A folder opens as its folder project, so it gets the project's color, icon and settings.
    if (!params.projectId) {
      params.projectId = projectService.findOrCreateDirectoryProject(directoryPath).id;
    }

    // Directory workspaces don't detect git — add as a project for git features
    if (!params.name) {
      params.name = basename(directoryPath);
    }
    return directoryPath;
  }

  /**
   * After auto-resolving a branch conflict, derive a friendlier workspace
   * name from the final branch suffix when the caller didn't supply one.
   */
  private applyAutoNameFromBranch(
    params: CreateWorkspaceParams,
    project: Project,
    branchName: string
  ): void {
    if (params.autoResolveBranchConflicts !== true || params.customName) return;
    const prefix = branchPrefix(project);
    const suffix = branchName.toLowerCase().startsWith(prefix.toLowerCase())
      ? branchName.slice(prefix.length)
      : branchName.includes('/')
        ? branchName.slice(branchName.lastIndexOf('/') + 1)
        : branchName;
    if (suffix) {
      params.name = branchSuffixToName(suffix);
    }
  }
}
