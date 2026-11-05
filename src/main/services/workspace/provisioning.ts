import {
  branchSuffixToName,
  generateBranchSuffix,
  sanitizeBranchName,
} from '../../../shared/lib/random-names';
import {
  normalizeSshStartPoint,
  normalizeSshTargetBranch,
} from '../../../shared/lib/ssh-target-branch';
import { isSshWorkspace } from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { agentPresetService } from '../agent-preset.service';
import { configService } from '../config.service';
import { gitService } from '../git.service';
import { ptyService } from '../pty.service';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';
import { sshWorkspaceProvisioningService } from '../ssh-workspace-provisioning.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceSetupService } from '../workspace-setup.service';
import { worktreeWatcherService } from '../worktree-watcher.service';

import {
  importPromptAttachments,
  publishCreated,
  resolveInitialCommand,
  resolveLaunchModeId,
  resolvePreset,
  resolveReasoningLevelId,
  resolveModelId,
} from './agent-launch';
import { workspaceStore } from './store';
import {
  AUTO_BRANCH_MAX_ATTEMPTS,
  branchPrefix,
  createAutoBranchCandidate,
  createBranchConflictError,
  deriveBranchSuffixForName,
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
import type { WorkspaceTerminals } from './terminals';
import type { CreateWorkspaceParams, Project, Workspace } from '../../../shared/types';
import type { TerminalAttention } from '../terminal-attention/terminal-attention';

const logger = createLogger('WorkspaceService');

export interface WorkspaceProvisioningDeps {
  attention: TerminalAttention;
  naming: WorkspaceNaming;
  terminals: WorkspaceTerminals;
}

/** Finishes a workspace created with its name deferred: branch naming, worktree, first terminals. */
export class WorkspaceProvisioning {
  private provisioningCancelled: Set<string> = new Set();
  constructor(private readonly deps: WorkspaceProvisioningDeps) {}

  async finishProvisioning(
    workspaceId: string,
    params: CreateWorkspaceParams,
    project: Project
  ): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) return;

    // Check if this provisioning was cancelled (e.g., workspace was deleted)
    if (this.provisioningCancelled.has(workspaceId)) {
      this.provisioningCancelled.delete(workspaceId);
      return;
    }

    try {
      // 1. Resolve branch name: use provided name, generate via AI, or fall back to random
      const repoPath =
        project.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project.repositoryPath;

      const prefix = branchPrefix(project);
      const hasProvidedBranch = !!params.branchName;
      let branchName: string;
      let aiTitle: string | undefined;
      let aiDescription: string | undefined;
      // Controls whether conflicts use numeric suffixes (true) or random retries (false)
      let preserveNameOnConflict: boolean;

      if (hasProvidedBranch) {
        // Branch name already provided — sanitize and use (with prefix if needed)
        // Fall back to a random suffix if sanitization strips everything
        const sanitized = sanitizeBranchName(params.branchName!) || generateBranchSuffix();
        branchName = params.useExactBranchName
          ? sanitized
          : withBranchPrefix(sanitized, branchPrefix(project));
        preserveNameOnConflict = true;

        logger.debug(`Provisioning ${workspaceId}: using provided branch name`, {
          branchName,
          exact: params.useExactBranchName,
        });
      } else {
        const aiResult = await this.generateAIBranchSuffix(workspaceId, params, repoPath);
        if (aiResult.cancelled) return;
        aiTitle = aiResult.aiTitle;
        aiDescription = aiResult.aiDescription;
        const suffix = aiResult.branchSuffix || generateBranchSuffix();
        branchName = withBranchPrefix(suffix, prefix);
        preserveNameOnConflict = !!aiResult.branchSuffix;
      }

      logger.debug(`Provisioning ${workspaceId}: resolved branch name: ${branchName}`);

      // Check workspace still exists (may have been deleted during AI generation)
      // Also check if provisioning was cancelled
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      // 2. Create worktree with conflict resolution
      const projectName = project.name;
      // A focus during branch naming may have started a background fetch since create().
      gitService.stopBackgroundWork(repoPath);
      const target = await resolveLocalWorkspaceTarget(params, project, repoPath);
      let baseBranch = target.baseBranch;
      const worktreeStartPoint = target.startPoint;
      await fastForwardManagedProjectTargetBeforeCreation(
        params,
        project,
        repoPath,
        target.baseBranch
      );
      logger.debug(
        `Provisioning ${workspaceId}: creating worktree in ${repoPath} from startPoint=${worktreeStartPoint ?? '(default)'} baseBranch=${baseBranch ?? '(none)'}`
      );
      // When the caller provided an explicit branch name, only auto-resolve
      // conflicts if they opted in. AI/random names always auto-resolve.
      const shouldAutoResolve = hasProvidedBranch
        ? params.autoResolveBranchConflicts === true
        : true;

      const worktreeResult = await this.createWorktreeWithConflictResolution(
        workspace,
        params,
        project,
        branchName,
        preserveNameOnConflict,
        shouldAutoResolve,
        worktreeStartPoint,
        baseBranch,
        repoPath,
        projectName
      );
      branchName = worktreeResult.resolvedBranchName;
      baseBranch = worktreeResult.resolvedBaseBranch;
      const workingDirectory = worktreeResult.workingDirectory;

      // Check workspace still exists after worktree creation (or was cancelled)
      if (
        await this.consumeWorktreeCheckpoint(
          workspaceId,
          repoPath,
          workingDirectory,
          branchName,
          worktreeResult.createdBranch
        )
      )
        return;

      // 3. Update workspace with resolved values
      logger.debug(`Provisioning ${workspaceId}: worktree created at ${workingDirectory}`);
      this.applyProvisionedWorkspaceState(
        workspace,
        workingDirectory,
        branchName,
        baseBranch,
        prefix,
        aiTitle,
        aiDescription,
        params
      );
      logger.info(`Provisioning ${workspaceId}: complete — branch=${branchName}`);

      // 4. Register target branch with git service
      if (workspace.baseBranch) {
        gitService.registerTargetBranch(workspace.workingDirectory, workspace.baseBranch);
      }

      // 5. Start file watcher (fire-and-forget)
      worktreeWatcherService
        .startWatching(workspace.id, workspace.workingDirectory)
        .catch((err) => {
          logger.error(`Failed to start watcher for workspace ${workspace.id}:`, err);
        });

      // 6. Create terminal(s) and trigger optional auto-naming
      await this.startProvisionedTerminals(workspace, params, aiTitle);
    } catch (err) {
      await this.recordProvisioningError(workspaceId, err);
    }
  }

  async finishSshProvisioning(
    workspaceId: string,
    params: CreateWorkspaceParams,
    project: Project,
    gitUrl: string
  ): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    const sshLocation = params.location?.kind === 'ssh' ? params.location : undefined;
    if (!workspace || !sshLocation) return;

    try {
      const repoPath =
        project.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project.repositoryPath;
      const providedBranch = params.branchName && sanitizeBranchName(params.branchName);
      let aiTitle: string | undefined;
      let aiDescription: string | undefined;
      let branchSuffix = providedBranch;

      if (!branchSuffix) {
        const aiResult = await this.generateAIBranchSuffix(workspaceId, params, repoPath);
        if (aiResult.cancelled) return;
        branchSuffix = aiResult.branchSuffix || generateBranchSuffix();
        aiTitle = aiResult.aiTitle;
        aiDescription = aiResult.aiDescription;
      }
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      const initialBranch = params.useExactBranchName
        ? branchSuffix
        : withBranchPrefix(branchSuffix, branchPrefix(project));
      this.updateProvisionStatus(workspaceId, 'Checking remote branch');
      const workspaceStartPoint = normalizeSshStartPoint(params.baseBranch);
      const workspaceBaseBranch = sshWorkspaceTargetBranch(params);
      const sshProjectBaseBranch = resolveSshTargetBranch(project, workspaceBaseBranch);
      const requestedStartPoint = workspaceStartPoint || sshProjectBaseBranch;
      const startsFromProjectTarget =
        !!sshProjectBaseBranch &&
        normalizeSshTargetBranch(requestedStartPoint) === sshProjectBaseBranch;
      const startPoint = !requestedStartPoint
        ? undefined
        : sshLocation.sourceBackend || startsFromProjectTarget || params.baseBranchOnHost
          ? requestedStartPoint
          : await gitService.resolvePublishedCommit(repoPath, requestedStartPoint || 'HEAD');
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      this.updateProvisionStatus(workspaceId, 'Connecting to SSH host');
      const resolvedBasePath = sshLocation.sourceBackend
        ? undefined
        : await sshWorkspaceService.resolveWorkspaceBasePath(sshLocation.hostId);
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      if (aiTitle && !params.customName) {
        workspace.customName = aiTitle;
        workspace.customNameSource = 'generated';
        workspace.customNameGeneratedAt = Date.now();
        workspace.promptSubmitsSinceCustomNameGeneration = 0;
        if (aiDescription) workspace.customDescription = aiDescription;
      }
      this.updateProvisionStatus(workspaceId, 'Creating remote worktree');

      await sshWorkspaceProvisioningService.prepare(workspace, {
        initialBranchName: initialBranch,
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
            startPoint,
            resolvedBasePath,
            sourceBackend: sshLocation.sourceBackend,
          }),
      });
      if (
        !workspaceStore.workspaces.has(workspaceId) ||
        this.provisioningCancelled.has(workspaceId)
      ) {
        await sshWorkspaceProvisioningService.recover(workspace, 'cancelled');
        this.provisioningCancelled.delete(workspaceId);
        return;
      }

      await this.startProvisionedTerminals(workspace, params, aiTitle);
      sshWorkspaceProvisioningService.complete(workspace);
      workspaceStore.saveWorkspaces();
      workspaceStore.broadcastWorkspaceUpdate(workspace);
    } catch (err) {
      await this.recordProvisioningError(workspaceId, err);
    }
  }

  /**
   * Resolve a branch suffix and (optionally) workspace title/description via AI.
   * Returns `cancelled: true` when provisioning was cancelled between the
   * combined naming and branch-only fallback so the caller can bail before
   * issuing a second AI call. NOTE: this path does not consume the cancel flag
   * (matching pre-refactor behavior); finishProvisioning's early return then
   * skips the post-branch-naming checkpoint, so the entry persists in
   * `provisioningCancelled` for that one specific path. Acceptable in practice
   * because workspace IDs are UUIDs (no recycling).
   */
  private async generateAIBranchSuffix(
    workspaceId: string,
    params: CreateWorkspaceParams,
    repoPath: string
  ): Promise<{
    branchSuffix: string | null;
    aiTitle?: string;
    aiDescription?: string;
    cancelled: boolean;
  }> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    const provisionConfig = configService.get();
    const resolvedPresetId = params.presetId ?? workspace?.presetId;
    const wantBranch = params.autoNameBranches ?? provisionConfig.autoNameBranches === true;
    const wantTitle = provisionConfig.autoNameWorkspaces !== 'off' && !params.customName;

    logger.debug(`Provisioning ${workspaceId}: starting AI name generation`, {
      hasPrompt: !!params.initialPrompt?.trim(),
      hasCustomName: !!params.customName,
      repoPath,
    });

    let branchSuffix: string | null = null;
    let aiTitle: string | undefined;
    let aiDescription: string | undefined;

    if (!params.initialPrompt?.trim()) {
      return { branchSuffix, aiTitle, aiDescription, cancelled: false };
    }

    const prompt = params.initialPrompt.trim();

    if (wantBranch && wantTitle) {
      try {
        const combined = await this.deps.naming.generateProvisioningNames(
          prompt,
          workspaceId,
          resolvedPresetId
        );
        if (combined) {
          branchSuffix = combined.branch;
          aiTitle = combined.title;
          aiDescription = combined.description;
          logger.debug(`Provisioning ${workspaceId}: combined naming succeeded`, {
            branch: combined.branch,
            title: combined.title,
          });
        } else {
          logger.debug(`Provisioning ${workspaceId}: combined naming returned null`);
        }
      } catch (err) {
        logger.debug(`Provisioning ${workspaceId}: combined naming failed:`, err);
      }

      if (
        !workspaceStore.workspaces.has(workspaceId) ||
        this.provisioningCancelled.has(workspaceId)
      ) {
        logger.debug(`Provisioning ${workspaceId}: cancelled after combined naming`);
        return { branchSuffix, aiTitle, aiDescription, cancelled: true };
      }

      // If combined failed but we still want a branch name, try branch-only
      if (!branchSuffix) {
        try {
          branchSuffix = await this.deps.naming.generateBranchName(
            prompt,
            workspaceId,
            resolvedPresetId
          );
          logger.debug(`Provisioning ${workspaceId}: branch-only naming result: ${branchSuffix}`);
        } catch (err) {
          logger.debug(`Provisioning ${workspaceId}: branch-only naming failed:`, err);
        }
      }
    } else if (wantBranch) {
      // Only need branch name (title disabled or customName already set)
      try {
        branchSuffix = await this.deps.naming.generateBranchName(
          prompt,
          workspaceId,
          resolvedPresetId
        );
        logger.debug(`Provisioning ${workspaceId}: branch naming result: ${branchSuffix}`);
      } catch (err) {
        logger.debug(`Provisioning ${workspaceId}: branch naming failed:`, err);
      }
    }
    // If only wantTitle (!wantBranch): skip AI here — maybeAutoName handles it later

    return { branchSuffix, aiTitle, aiDescription, cancelled: false };
  }

  /**
   * Create the worktree, retrying with auto-generated branch-name candidates
   * when the chosen name conflicts with an existing workspace or worktree.
   * Mutates `workspace` so the in-progress repoPath is persisted before the
   * next cancellation checkpoint can run cleanup.
   */
  private async createWorktreeWithConflictResolution(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    project: Project,
    initialBranchName: string,
    preserveNameOnConflict: boolean,
    shouldAutoResolve: boolean,
    worktreeStartPoint: string | undefined,
    baseBranch: string | undefined,
    repoPath: string,
    projectName: string
  ): Promise<{
    workingDirectory: string;
    resolvedBranchName: string;
    resolvedBaseBranch: string | undefined;
    createdBranch: boolean;
  }> {
    const triedBranchNames = new Set<string>();
    let branchName = initialBranchName;
    let workingDirectory: string | undefined;
    let effectiveWorktreeStartPoint = worktreeStartPoint;
    let effectiveBaseBranch = baseBranch;
    let createdBranch = false;

    for (let attempt = 1; attempt <= AUTO_BRANCH_MAX_ATTEMPTS; attempt++) {
      const existingWorkspace = findBranchConflict(params.projectId!, branchName, workspace.id);
      if (existingWorkspace) {
        if (!shouldAutoResolve) {
          throw createBranchConflictError(branchName, existingWorkspace);
        }
        branchName = createAutoBranchCandidate(
          initialBranchName,
          branchPrefix(project),
          attempt,
          preserveNameOnConflict
        );
        if (triedBranchNames.has(branchName)) continue;
        triedBranchNames.add(branchName);
        continue;
      }

      const worktreeDestination = toSafeWorktreePath(projectName, branchName);
      try {
        // Cancel cleanup may delete only a branch this attempt created.
        ({ path: workingDirectory, createdBranch } = await gitService.createWorktree(
          repoPath,
          branchName,
          worktreeDestination,
          effectiveWorktreeStartPoint,
          { fetchRemote: params.fetchRemote }
        ));
        workspace.workingDirectory = workingDirectory;
        workspace.branchName = branchName;
        workspace.baseBranch = effectiveBaseBranch;
        workspace.provisioningRepoPath = repoPath;
        workspace.provisioningBranchCreated = createdBranch;
        workspaceStore.saveWorkspaces();
        break;
      } catch (error) {
        if (!params.baseBranch) {
          const recoveredBaseBranch = await recoverMissingProjectBaseBranch(
            error,
            project,
            repoPath,
            effectiveWorktreeStartPoint
          );
          if (recoveredBaseBranch) {
            effectiveWorktreeStartPoint = recoveredBaseBranch;
            effectiveBaseBranch = recoveredBaseBranch;
            // Retry the same branch candidate; base-branch recovery is not a name conflict.
            attempt--;
            continue;
          }
        }

        const normalizedError = normalizeCreateWorktreeError(error, branchName);
        const isConflict =
          normalizedError.message.includes('already has an active worktree') ||
          normalizedError.message.includes('already open in workspace');

        if (!isConflict || !shouldAutoResolve) throw normalizedError;

        branchName = createAutoBranchCandidate(
          initialBranchName,
          branchPrefix(project),
          attempt,
          preserveNameOnConflict
        );
        if (triedBranchNames.has(branchName)) continue;
        triedBranchNames.add(branchName);
      }
    }

    if (!workingDirectory) {
      throw new Error(
        `Could not find an available branch name after ${AUTO_BRANCH_MAX_ATTEMPTS} attempts.`
      );
    }

    return {
      workingDirectory,
      resolvedBranchName: branchName,
      resolvedBaseBranch: effectiveBaseBranch,
      createdBranch,
    };
  }

  /**
   * Checkpoint after AI branch naming: returns true if the workspace was
   * deleted or provisioning was cancelled and the caller should bail. Cancel
   * is checked first so the typical "delete during provisioning" path (which
   * sets the flag *and* removes the workspace) consumes the flag instead of
   * leaking an entry in `provisioningCancelled`.
   */
  private consumeBranchNamingCheckpoint(workspaceId: string): boolean {
    if (this.provisioningCancelled.has(workspaceId)) {
      logger.debug('Provisioning: cancelled after branch naming');
      this.provisioningCancelled.delete(workspaceId);
      return true;
    }
    if (!workspaceStore.workspaces.has(workspaceId)) {
      logger.debug('Provisioning: workspace was deleted during branch naming');
      return true;
    }
    return false;
  }

  /**
   * Checkpoint after worktree creation: returns true if the caller should bail.
   * When cancelled or deleted, runs best-effort worktree cleanup so we don't
   * leave an orphan checkout on disk.
   */
  private async consumeWorktreeCheckpoint(
    workspaceId: string,
    repoPath: string,
    workingDirectory: string,
    branchName: string,
    createdBranch: boolean
  ): Promise<boolean> {
    if (
      !workspaceStore.workspaces.has(workspaceId) ||
      this.provisioningCancelled.has(workspaceId)
    ) {
      await this.cleanupCancelledProvisioning(
        workspaceId,
        repoPath,
        workingDirectory,
        branchName,
        createdBranch
      );
      return true;
    }
    return false;
  }

  /**
   * Cancellation cleanup invoked after the worktree has been created but the
   * workspace was deleted (or cancellation flagged) before we could finalise.
   * Best-effort delete of the orphan worktree; never throws.
   */
  private async cleanupCancelledProvisioning(
    workspaceId: string,
    repoPath: string,
    workingDirectory: string,
    branchName: string,
    createdBranch: boolean
  ): Promise<void> {
    try {
      await gitService.deleteWorktree(repoPath, workingDirectory, true, {
        deleteBranch: createdBranch,
        branchName,
      });
    } catch {
      // Best-effort cleanup
    }
    if (this.provisioningCancelled.has(workspaceId)) {
      logger.debug('Provisioning: cancelled after worktree creation');
      this.provisioningCancelled.delete(workspaceId);
    }
  }

  /**
   * Apply the resolved worktree + AI-generated values onto the in-memory workspace
   * and persist. Mutates `workspace`. Does not broadcast — the caller decides when
   * to surface the update to renderers.
   */
  private applyProvisionedWorkspaceState(
    workspace: Workspace,
    workingDirectory: string,
    branchName: string,
    baseBranch: string | undefined,
    prefix: string,
    aiTitle: string | undefined,
    aiDescription: string | undefined,
    params: CreateWorkspaceParams
  ): void {
    const branchSuffixForName = deriveBranchSuffixForName(branchName, prefix);

    workspace.workingDirectory = workingDirectory;
    workspace.branchName = branchName;
    workspace.baseBranch = baseBranch;
    workspace.name = branchSuffixToName(branchSuffixForName) || workspace.name;
    workspace.provisioning = false;
    workspace.provisionStatus = undefined;
    workspace.provisionError = undefined;
    workspace.provisioningRepoPath = undefined;
    // SSH provisioning clears its own ownership flags once the workspace is safely persisted.
    if (!isSshWorkspace(workspace)) workspace.provisioningBranchCreated = undefined;

    // Apply AI-generated title/description from the combined call
    if (aiTitle && !params.customName) {
      workspace.customName = aiTitle;
      workspace.customNameSource = 'generated';
      workspace.customNameGeneratedAt = Date.now();
      workspace.promptSubmitsSinceCustomNameGeneration = 0;
      if (aiDescription) {
        workspace.customDescription = aiDescription;
      }
    }

    workspaceStore.saveWorkspaces();
  }

  /**
   * Pin the active preset, resolve the launch command, then either run setup
   * steps or spawn a single terminal. Triggers separate auto-naming only when
   * the combined AI call didn't already produce a title.
   */
  private async startProvisionedTerminals(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    aiTitle: string | undefined
  ): Promise<void> {
    const activePreset = resolvePreset(params.presetId, workspace);
    workspace.presetId = activePreset?.id ?? null;
    workspace.launchModeId = resolveLaunchModeId(activePreset, params.launchModeId);
    workspace.reasoningLevelId = resolveReasoningLevelId(activePreset, params.reasoningLevelId);
    workspace.modelId = resolveModelId(activePreset, params.modelId);
    if (activePreset && !params.skipRecordUsage) {
      agentPresetService.recordPresetUsage?.(
        activePreset.id,
        params.launchModeId,
        params.reasoningLevelId,
        params.modelId
      );
    }
    const command = resolveInitialCommand(
      params,
      activePreset,
      workspace,
      await importPromptAttachments(workspace, params, activePreset)
    );

    if (params.projectId) {
      const primaryTerminal = workspaceSetupService.start(workspace, command, 'create');
      if (primaryTerminal) {
        workspaceStore.broadcastWorkspaceUpdate(workspace);
        publishCreated(
          workspace,
          aiTitle ? undefined : this.deps.naming.maybeAutoName(workspace, params)
        );
        return;
      }
    }

    const terminal = await this.deps.terminals.addTerminal(workspace.id, workspace.name, command);
    workspace.primaryTerminalId = terminal.id;

    workspaceStore.broadcastWorkspaceUpdate(workspace);
    publishCreated(
      workspace,
      aiTitle ? undefined : this.deps.naming.maybeAutoName(workspace, params)
    );
  }

  /**
   * Persist provisioning failure on the workspace and surface it. When the
   * provisioning was cancelled (workspace deleted during AI/worktree work) the
   * error is swallowed — the cancel flag is consumed and no error state is set.
   */
  async recordProvisioningError(workspaceId: string, err: unknown): Promise<void> {
    const ws = workspaceStore.workspaces.get(workspaceId);
    const wasCancelled = this.provisioningCancelled.has(workspaceId);
    if (wasCancelled) {
      this.provisioningCancelled.delete(workspaceId);
      return;
    }
    if (ws) {
      ws.provisioning = false;
      ws.provisionStatus = undefined;
      ws.provisionError = err instanceof Error ? err.message : 'Workspace setup failed';
      ws.provisioningRepoPath = undefined;
      try {
        workspaceStore.broadcastWorkspaceUpdate(ws);
      } catch (broadcastErr) {
        logger.warn('Failed to broadcast provisioning error update:', broadcastErr);
      }

      if (isSshWorkspace(ws)) {
        for (const terminal of ws.terminals) {
          ptyService.releaseTerminal(terminal.id);
        }
        ws.terminals = [];
        ws.primaryTerminalId = undefined;
        if ((await sshWorkspaceProvisioningService.recover(ws, 'failed')) === 'retain') {
          try {
            await workspaceStore.saveWorkspacesImmediateChecked();
          } catch (saveError) {
            logger.error('Failed to persist recoverable SSH workspace', saveError, {
              workspaceId,
            });
            workspaceStore.saveWorkspaces();
          }
          workspaceStore.broadcastWorkspacesChanged();
          logger.error(`Provisioning failed for workspace ${workspaceId}:`, err);
          return;
        }
        workspaceStore.workspaces.delete(workspaceId);
        this.deps.attention.workspaceDeleted(workspaceId);
        for (const remainingWorkspace of workspaceStore.workspaces.values()) {
          if ((remainingWorkspace.order ?? 0) > (ws.order ?? 0)) {
            remainingWorkspace.order = (remainingWorkspace.order ?? 0) - 1;
          }
        }
        void remoteWorkspaceObservationService.reconcile();
        try {
          await workspaceStore.saveWorkspacesImmediateChecked();
        } catch (saveError) {
          logger.error('Failed to persist removal of failed SSH workspace', saveError, {
            workspaceId,
          });
          workspaceStore.saveWorkspaces();
        }
        workspaceStore.broadcastWorkspacesChanged();
      } else {
        workspaceStore.saveWorkspaces();
      }
    }
    logger.error(`Provisioning failed for workspace ${workspaceId}:`, err);
  }

  private updateProvisionStatus(workspaceId: string, status: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !workspace.provisioning) return;
    workspace.provisionStatus = status;
    workspaceStore.saveWorkspaces();
    try {
      workspaceStore.broadcastWorkspaceUpdate(workspace);
    } catch (err) {
      logger.warn('Failed to broadcast provisioning status update:', err);
    }
  }

  /** Makes provisioning bail out at its next checkpoint, as when its workspace is deleted. */
  markCancelled(workspaceId: string): void {
    this.provisioningCancelled.add(workspaceId);
  }
}
