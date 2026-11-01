import { sanitizeBranchSuffix } from '../../../shared/lib/random-names';
import { createLogger } from '../../lib/logger';
import { configService } from '../config.service';
import { utilityInferenceService } from '../utility-inference.service';

import {
  buildPromptSubmitRenameContext,
  compactPromptSubmits,
  normalizePromptSubmit,
  truncateReplyForStorage,
} from './prompt-submits';
import { workspaceStore } from './store';

import type { CreateWorkspaceParams, Workspace } from '../../../shared/types';
import type { WorkspaceCustomNameSource } from '../../../shared/types/workspace';

const logger = createLogger('WorkspaceService');

const MAX_UTILITY_TITLE_LENGTH = 50;

const AUTO_RENAME_PROMPT_SUBMIT_THRESHOLD = 20;

const AUTO_RENAME_MIN_INTERVAL_MS = 10 * 60 * 1000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Names workspaces and branches from prompts through utility inference, and what naming needs recorded. */
export class WorkspaceNaming {
  private autoNamingControllers: Map<string, AbortController> = new Map();
  private branchNamingControllers: Map<string, AbortController> = new Map();
  private provisioningControllers: Map<string, AbortController> = new Map();

  recordPromptSubmit(workspaceId: string, prompt: string, terminalId?: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) return;
    const normalized = normalizePromptSubmit(prompt);
    if (!normalized) return;
    const isFirstPromptSubmit = !workspace.promptSubmits || workspace.promptSubmits.length === 0;
    const previousPrompt = workspace.promptSubmits?.[workspace.promptSubmits.length - 1]?.prompt;
    if (previousPrompt === normalized) return;

    const promptSubmits = compactPromptSubmits([
      ...(workspace.promptSubmits ?? []),
      { prompt: normalized, submittedAt: Date.now(), ...(terminalId && { terminalId }) },
    ]);

    workspace.promptSubmits = promptSubmits;
    if (
      workspace.customNameSource === 'generated' ||
      workspace.autoNaming ||
      this.autoNamingControllers.has(workspace.id)
    ) {
      workspace.promptSubmitsSinceCustomNameGeneration =
        (workspace.promptSubmitsSinceCustomNameGeneration ?? 0) + 1;
    }
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspaceUpdate(workspace);

    if (
      isFirstPromptSubmit &&
      !workspace.customName &&
      !workspace.autoNaming &&
      !this.autoNamingControllers.has(workspace.id)
    ) {
      this.generateWorkspaceName(workspace.id, normalized, workspace.presetId).catch((err) =>
        logger.debug('Auto-naming from prompt-submit failed:', err)
      );
    } else if (this.shouldRegenerateGeneratedWorkspaceName(workspace)) {
      const promptContext = buildPromptSubmitRenameContext(workspace);
      if (!promptContext) return;
      this.generateWorkspaceName(workspace.id, promptContext, workspace.presetId, {
        replaceCustomName: true,
        replaceCustomNameSource: 'generated',
      }).catch((err) => logger.debug('Auto-renaming from prompt-submit drift failed:', err));
    }
  }

  /**
   * Keeps an agent's final reply with the latest prompt sent in its Terminal, so labeling sees what
   * the prompt was about. Without a prompt there, the reply answers none Komla recorded.
   */
  recordAgentReply(workspaceId: string, reply: string, terminalId?: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    const promptSubmits = workspace?.promptSubmits;
    const normalized = truncateReplyForStorage(reply.trim().replace(/\r\n|\r/g, '\n'));
    if (!workspace || !promptSubmits || !normalized) return;
    const index = promptSubmits.findLastIndex((entry) => entry.terminalId === terminalId);
    // A later reply to the same prompt, such as one after background work, replaces the earlier one.
    if (index === -1 || promptSubmits[index].reply === normalized) return;

    workspace.promptSubmits = compactPromptSubmits(
      promptSubmits.map((entry, i) => (i === index ? { ...entry, reply: normalized } : entry))
    );
    workspaceStore.saveWorkspaces();
  }

  private shouldRegenerateGeneratedWorkspaceName(workspace: Workspace): boolean {
    if (workspace.customNameSource !== 'generated') return false;
    if (!workspace.customName) return false;
    if (workspace.autoNaming || this.autoNamingControllers.has(workspace.id)) return false;

    const submitsSinceGeneration = workspace.promptSubmitsSinceCustomNameGeneration ?? 0;
    if (submitsSinceGeneration < AUTO_RENAME_PROMPT_SUBMIT_THRESHOLD) return false;

    const generatedAt = workspace.customNameGeneratedAt;
    if (!generatedAt) return false;

    return Date.now() - generatedAt >= AUTO_RENAME_MIN_INTERVAL_MS;
  }

  private normalizeUtilityTitle(title: string): string | null {
    const normalized = title.trim().slice(0, MAX_UTILITY_TITLE_LENGTH);
    const capitalized = normalized.replace(/^\p{Ll}/u, (match) => match.toUpperCase());
    return capitalized || null;
  }

  async regenerateWorkspaceName(workspaceId: string): Promise<Workspace> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (workspace.autoNaming) return workspace;

    const promptContext = buildPromptSubmitRenameContext(workspace);
    if (!promptContext) {
      throw new Error('No recorded prompts for this workspace');
    }

    try {
      await this.generateWorkspaceName(workspaceId, promptContext, workspace.presetId, {
        ignoreAutoNameSetting: true,
        throwOnFailure: true,
        replaceCustomName: true,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }

    const updated = workspaceStore.workspaces.get(workspaceId);
    if (!updated) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    return updated;
  }

  /** Apply an auto-generated name to a workspace if it still exists. Returns true if applied. */
  private applyAutoName(
    workspaceId: string,
    name: string,
    description?: string,
    options: {
      replaceCustomName?: boolean;
      replaceCustomNameSource?: WorkspaceCustomNameSource;
      promptSubmitsAtRequestStart?: number;
    } = {}
  ): boolean {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      logger.debug('Auto-naming: workspace no longer exists');
      return false;
    }
    if (workspace.customName && !options.replaceCustomName) {
      logger.debug('Auto-naming: workspace already has a custom name, skipping');
      workspace.autoNaming = false;
      workspaceStore.broadcastWorkspaceUpdate(workspace);
      return false;
    }
    if (
      options.replaceCustomNameSource &&
      workspace.customNameSource !== options.replaceCustomNameSource
    ) {
      logger.debug('Auto-naming: workspace custom name source changed, skipping');
      workspace.autoNaming = false;
      workspaceStore.broadcastWorkspaceUpdate(workspace);
      return false;
    }

    const normalizedName = this.normalizeUtilityTitle(name);
    if (!normalizedName) {
      logger.warn('Auto-naming: generated title normalized to empty value');
      workspace.autoNaming = false;
      workspaceStore.broadcastWorkspaceUpdate(workspace);
      return false;
    }

    workspace.customName = normalizedName;
    workspace.customNameSource = 'generated';
    workspace.customNameGeneratedAt = Date.now();
    workspace.promptSubmitsSinceCustomNameGeneration =
      options.promptSubmitsAtRequestStart === undefined
        ? 0
        : Math.max(
            0,
            (workspace.promptSubmitsSinceCustomNameGeneration ?? 0) -
              options.promptSubmitsAtRequestStart
          );
    if (description) {
      workspace.customDescription = description;
    } else if (options.replaceCustomName) {
      workspace.customDescription = undefined;
    }
    workspace.autoNaming = false;
    workspaceStore.saveWorkspaces();

    logger.info(`Auto-named workspace ${workspaceId}: "${normalizedName}"`);

    workspaceStore.broadcastWorkspaceUpdate(workspace);
    return true;
  }

  /** Clear the auto-naming flag on a workspace (e.g. on failure). */
  private clearAutoNaming(workspaceId: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (workspace && workspace.autoNaming) {
      workspace.autoNaming = false;
      workspaceStore.broadcastWorkspaceUpdate(workspace);
    }
  }

  private async generateWorkspaceName(
    workspaceId: string,
    initialPrompt: string,
    _presetId?: string | null,
    options: {
      ignoreAutoNameSetting?: boolean;
      replaceCustomName?: boolean;
      replaceCustomNameSource?: WorkspaceCustomNameSource;
      throwOnFailure?: boolean;
    } = {}
  ): Promise<void> {
    const config = configService.get();
    if (config.autoNameWorkspaces === 'off' && !options.ignoreAutoNameSetting) {
      logger.debug('Auto-naming skipped: disabled in settings');
      return;
    }
    // Only a request someone made says why it can't run; automatic naming just skips.
    if (!options.throwOnFailure && !utilityInferenceService.isAvailable()) {
      logger.debug('Auto-naming skipped: no AI helper available in this build');
      return;
    }

    const controller = new AbortController();
    try {
      logger.info(`Auto-naming workspace ${workspaceId}: using utility inference`);

      // Signal to the renderer that auto-naming is in progress
      const workspace = workspaceStore.workspaces.get(workspaceId);
      const promptSubmitsAtRequestStart = workspace?.promptSubmitsSinceCustomNameGeneration ?? 0;
      if (workspace) {
        workspace.autoNaming = true;
        workspaceStore.broadcastWorkspaceUpdate(workspace);
      }

      this.autoNamingControllers.set(workspaceId, controller);

      const result = await utilityInferenceService.labelWorkspace(initialPrompt, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!result.title) {
        logger.debug(`Auto-naming skipped for workspace ${workspaceId}: insufficient context`);
        this.clearAutoNaming(workspaceId);
        if (options.throwOnFailure) {
          throw new Error('Utility inference returned no workspace title');
        }
        return;
      }
      const applied = this.applyAutoName(
        workspaceId,
        result.title,
        result.description ?? undefined,
        { ...options, promptSubmitsAtRequestStart }
      );
      if (!applied && options.throwOnFailure) {
        throw new Error('Unable to apply generated workspace title');
      }
    } catch (err) {
      if (this.autoNamingControllers.get(workspaceId) === controller) {
        this.clearAutoNaming(workspaceId);
      }
      if (isAbortError(err)) {
        logger.debug(`Auto-naming aborted for workspace ${workspaceId}`);
        if (options.throwOnFailure) {
          throw err;
        }
        return;
      }
      logger.warn('Auto-naming failed:', err);
      if (options.throwOnFailure) {
        throw err;
      }
    } finally {
      if (this.autoNamingControllers.get(workspaceId) === controller) {
        this.autoNamingControllers.delete(workspaceId);
      }
    }
  }

  /**
   * Combined AI call: generate workspace title, description, AND branch name in one shot.
   * Used during deferred provisioning to avoid two separate AI calls.
   */
  async generateProvisioningNames(
    promptText: string,
    provisioningWorkspaceId?: string,
    _presetId?: string | null
  ): Promise<{ title: string; description?: string; branch: string } | null> {
    if (!utilityInferenceService.isAvailable()) return null;
    const requestId = provisioningWorkspaceId ?? `provision-${Date.now()}`;
    const controller = new AbortController();
    this.provisioningControllers.set(requestId, controller);

    try {
      logger.info('Generating workspace title + branch name with utility inference');

      const result = await utilityInferenceService.labelWorkspaceAndBranch(promptText, {
        signal: controller.signal,
      });
      if (!result.title) {
        logger.debug('Combined naming: title is null (insufficient context)', {
          provisioningWorkspaceId,
        });
        return null;
      }
      const title = this.normalizeUtilityTitle(result.title);
      if (!title) {
        logger.warn('Combined naming returned an invalid title', {
          title: result.title,
          provisioningWorkspaceId,
        });
        return null;
      }
      if (!result.branchName) {
        logger.debug('Combined naming: branchName is null (insufficient context)', {
          provisioningWorkspaceId,
        });
        return null;
      }
      const branch = sanitizeBranchSuffix(result.branchName);
      if (branch.length < 3) {
        logger.warn('Combined naming returned an invalid branch suffix', {
          branchName: result.branchName,
          sanitizedBranch: branch,
          provisioningWorkspaceId,
        });
        return null;
      }

      return {
        title,
        description: result.description ?? undefined,
        branch,
      };
    } catch (err) {
      if (isAbortError(err)) {
        logger.debug(
          `Combined naming aborted for workspace ${provisioningWorkspaceId ?? 'unknown'}`
        );
        return null;
      }
      logger.debug(`Combined naming failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (this.provisioningControllers.get(requestId) === controller) {
        this.provisioningControllers.delete(requestId);
      }
    }
  }

  /** Generate an AI-powered branch name suffix from a prompt. Returns the sanitized suffix or null on failure. */
  async generateBranchName(
    promptText: string,
    provisioningWorkspaceId?: string,
    _presetId?: string | null
  ): Promise<string | null> {
    if (!utilityInferenceService.isAvailable()) return null;
    const requestId = `branch-${Date.now()}-${Math.random()}`;
    const controller = new AbortController();
    this.branchNamingControllers.set(requestId, controller);
    if (provisioningWorkspaceId) {
      this.provisioningControllers.set(provisioningWorkspaceId, controller);
    }

    try {
      logger.info('Generating branch name with utility inference');

      const result = await utilityInferenceService.nameBranch(promptText, {
        signal: controller.signal,
      });
      if (!result.branchName) {
        logger.debug('Branch naming returned null: insufficient context');
        return null;
      }
      const branchName = sanitizeBranchSuffix(result.branchName);
      if (branchName.length < 3) {
        logger.warn('Branch naming returned an invalid branch suffix', {
          branchName: result.branchName,
          sanitizedBranch: branchName,
          provisioningWorkspaceId,
        });
        return null;
      }

      logger.info(`Generated branch name: "${branchName}"`);
      return branchName;
    } catch (err) {
      if (isAbortError(err)) {
        logger.debug(`Branch naming aborted for workspace ${provisioningWorkspaceId ?? 'manual'}`);
        return null;
      }
      logger.debug(`Branch naming failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (this.branchNamingControllers.get(requestId) === controller) {
        this.branchNamingControllers.delete(requestId);
      }
      if (
        provisioningWorkspaceId &&
        this.provisioningControllers.get(provisioningWorkspaceId) === controller
      ) {
        this.provisioningControllers.delete(provisioningWorkspaceId);
      }
    }
  }

  /** Cancel an in-flight branch naming request. */
  cancelBranchNaming(): void {
    for (const [requestId, controller] of this.branchNamingControllers) {
      controller.abort();
      this.branchNamingControllers.delete(requestId);
    }
  }

  /** Names the workspace from its prompt in the background; resolves once that has finished. */
  maybeAutoName(workspace: Workspace, params: CreateWorkspaceParams): Promise<void> | undefined {
    if (params.initialPrompt && !params.customName) {
      return this.generateWorkspaceName(workspace.id, params.initialPrompt, workspace.presetId)
        .then(() => {})
        .catch((err) => logger.debug('Auto-naming failed:', err));
    }
    return undefined;
  }

  /** Stops naming a workspace from its prompts, so a late result can't apply. */
  abortAutoNaming(workspaceId: string): void {
    const autoNamingController = this.autoNamingControllers.get(workspaceId);
    if (autoNamingController) {
      autoNamingController.abort();
      this.autoNamingControllers.delete(workspaceId);
    }
  }

  /** Stops naming a workspace still being provisioned. */
  abortProvisioningNaming(workspaceId: string): void {
    const provisioningController = this.provisioningControllers.get(workspaceId);
    if (provisioningController) {
      provisioningController.abort();
      this.provisioningControllers.delete(workspaceId);
    }
  }
}
