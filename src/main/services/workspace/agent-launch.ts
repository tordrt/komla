import { stat } from 'fs/promises';
import { basename } from 'path';

import {
  buildProjectSetupPrompt,
  isProjectSetupPrompt,
} from '../../../shared/constants/project-setup-prompt';
import { isSshWorkspace } from '../../../shared/types/workspace';
import { publishHookEvent } from '../../lib/hook-events';
import { agentPresetService } from '../agent-preset.service';
import { workspaceFileService } from '../workspace-file.service';

import type { AgentPreset, CreateWorkspaceParams, Workspace } from '../../../shared/types';

// How long workspace.created hooks wait for a new workspace's name before running without it.
const CREATED_HOOK_NAMING_WAIT_MS = 15_000;

export function resolvePreset(presetId?: string | null, workspace?: Workspace) {
  const id = presetId ?? workspace?.presetId;
  if (id) {
    const preset = agentPresetService.get?.(id);
    if (preset) return preset;
  }
  return agentPresetService.getFirstActive?.() ?? agentPresetService.getActive();
}

export function resolveLaunchModeId(
  preset: AgentPreset | null | undefined,
  launchModeId?: string | null
): string | null {
  return launchModeId && preset?.launchModes.some((mode) => mode.id === launchModeId)
    ? launchModeId
    : null;
}

export function resolveReasoningLevelId(
  preset: AgentPreset | null | undefined,
  reasoningLevelId?: string | null
): string | null {
  return reasoningLevelId && preset?.reasoningLevels?.some((level) => level.id === reasoningLevelId)
    ? reasoningLevelId
    : null;
}

export function resolveModelId(
  preset: AgentPreset | null | undefined,
  modelId?: string | null
): string | null {
  return modelId && preset?.models?.some((model) => model.id === modelId) ? modelId : null;
}

/**
 * Resolve the spawn command for an agent tab from a preset + optional
 * launchMode + optional prompt. The non-obvious bit: when `launchModeId`
 * is supplied but doesn't match any mode on the preset (stale id from a
 * removed launch mode), we silently fall through to the no-mode path
 * rather than failing — the launch still produces a usable terminal.
 */
export function resolveAgentCommand(
  preset: ReturnType<typeof resolvePreset> | null,
  prompt: string | undefined,
  launchModeId: string | undefined,
  shellFamily?: 'posix',
  reasoningLevelId?: string | null,
  extraArguments?: string,
  modelId?: string | null
): string | null {
  if (!preset) return null;
  const resolve = (text: string | undefined) =>
    agentPresetService.resolvePresetCommand(
      preset,
      text ? 'prompt' : 'open',
      launchModeId,
      text,
      shellFamily,
      reasoningLevelId,
      extraArguments,
      modelId
    );
  // An agent that can't start with a prompt still opens.
  return resolve(prompt) || (prompt && resolve(undefined)) || null;
}

/**
 * Resolve the first terminal's command from initialCommand / preset /
 * launch mode / initialPrompt. initialCommand always wins; otherwise the
 * preset's launch mode (when matched) drives, falling back to the prompt
 * command, then the openCommand. Attachment references follow the prompt.
 */
export function resolveInitialCommand(
  params: CreateWorkspaceParams,
  activePreset: AgentPreset | null | undefined,
  workspace: Workspace,
  attachmentRefs: string[] = []
): string | null {
  if (params.initialCommand) return params.initialCommand;
  if (!activePreset) return null;
  const prompt =
    isSshWorkspace(workspace) && isProjectSetupPrompt(params.initialPrompt)
      ? buildProjectSetupPrompt()
      : params.initialPrompt;
  const initialPrompt =
    attachmentRefs.length > 0
      ? [prompt?.trim(), attachmentRefs.join(' ')].filter(Boolean).join('\n\n')
      : prompt;
  return resolveAgentCommand(
    activePreset,
    initialPrompt,
    params.launchModeId,
    isSshWorkspace(workspace) ? 'posix' : undefined,
    workspace.reasoningLevelId,
    params.extraArguments,
    workspace.modelId
  );
}

/**
 * Copies the files pasted into the new-workspace prompt into the workspace's
 * `.komla-files/`, on its SSH host for a remote one, and returns their `@path`
 * references. A file that can't be copied fails the launch rather than
 * starting the agent without it.
 */
export async function importPromptAttachments(
  workspace: Workspace,
  params: CreateWorkspaceParams,
  activePreset: AgentPreset | null | undefined
): Promise<string[]> {
  if (!activePreset || params.initialCommand || !params.attachments?.length) return [];
  return Promise.all(
    params.attachments.map(async (sourcePath) => {
      try {
        return `@${await workspaceFileService.importExternalFileInto(workspace, sourcePath)}`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Couldn't attach ${basename(sourcePath)}: ${reason}`, { cause: err });
      }
    })
  );
}

/**
 * Fails a launch whose attachments have gone missing before anything is created,
 * so the dialog keeps them for a retry instead of leaving a half-made workspace.
 */
export async function assertPromptAttachmentsExist(params: CreateWorkspaceParams): Promise<void> {
  if (params.initialCommand || !params.attachments?.length) return;
  await Promise.all(
    params.attachments.map(async (sourcePath) => {
      let reason: string | undefined;
      try {
        if (!(await stat(sourcePath)).isFile()) reason = 'it isn’t a file';
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        reason = code === 'ENOENT' ? 'it no longer exists' : (err as Error).message;
      }
      if (reason) throw new Error(`Couldn't attach ${basename(sourcePath)}: ${reason}`);
    })
  );
}

/**
 * Tells hooks a workspace was created once its terminals have started and it has its name, so
 * they see the title the sidebar shows; naming that takes too long doesn't hold them back.
 */
export function publishCreated(workspace: Workspace, naming: Promise<void> | undefined): void {
  const publish = () => publishHookEvent({ event: 'workspace.created', workspaceId: workspace.id });
  if (!naming) {
    publish();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  void Promise.race([
    naming,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CREATED_HOOK_NAMING_WAIT_MS);
    }),
  ]).then(() => {
    clearTimeout(timer);
    publish();
  });
}
