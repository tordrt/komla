import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  ACTION_SSH_EXECUTION_LOCATIONS,
  SETUP_DESTINATIONS,
  SETUP_STEP_PLACEMENTS,
  SETUP_TRIGGERS,
} from '../../../shared/types';
import {
  agentPlacementSchema,
  aheadTargetActionSchema,
  behindTargetActionSchema,
  projectIconSchema,
  simpleAheadActionSchema,
} from '../../ipc/validation/config-ipc.schemas';
import { idSchema } from '../../ipc/validation/primitives';
import { gitRemoteIdentity } from '../../lib/git-remote-identity';
import { withSortedKeys } from '../ssh-workspace-sync/workspace-manifest';

import type { Action, AgentPreset, Project, SetupStep } from '../../../shared/types';
import type {
  SshProjectManifest,
  SshProjectManifestAgent,
  SshProjectManifestQuickCommand,
  SshProjectSettingsPart,
} from '../../../shared/types/ssh-project-manifest';

export const SSH_PROJECT_MANIFEST_DIRECTORY = 'projects';
export const MAX_SSH_PROJECT_MANIFEST_BYTES = 256 * 1024;

const MANIFEST_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isSshProjectManifestId(value: string): boolean {
  return MANIFEST_ID_PATTERN.test(value);
}

/** The id of a repository's Project manifest, the same for each of its clone URLs. */
export function sshProjectManifestId(gitUrl: string): string {
  return createHash('sha256').update(gitRemoteIdentity(gitUrl)).digest('hex').slice(0, 32);
}

const name = z.string().max(256);
const agentSchema = z
  .object({ agentName: name.optional(), launchModeName: name.optional() })
  .strip();
const command = z.string().max(64 * 1024);

const manifestSchema = z.object({
  schema: z.literal(1),
  gitUrl: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(256),
  color: z.string().max(64).optional(),
  icon: projectIconSchema.optional(),
  workspaceSetup: z.object({
    setupSteps: z
      .array(
        z
          .object({
            id: idSchema,
            name,
            command,
            placement: z.enum(SETUP_STEP_PLACEMENTS),
            actionId: idSchema.optional(),
            agent: agentSchema.optional(),
            destination: z.enum(SETUP_DESTINATIONS).optional(),
            trigger: z.enum(SETUP_TRIGGERS).optional(),
          })
          .strip()
      )
      .max(64),
    agentPlacement: agentPlacementSchema,
    agentLayoutOrder: z.number().int(),
    trashCleanupScript: command,
  }),
  quickCommands: z
    .array(
      z
        .object({
          id: idSchema,
          title: z.string().trim().min(1).max(256),
          content: z
            .string()
            .trim()
            .min(1)
            .max(64 * 1024),
          type: z.enum(['prompt', 'command']),
          agent: agentSchema.optional(),
          sshExecutionLocation: z.enum(ACTION_SSH_EXECUTION_LOCATIONS).optional(),
          background: z.boolean().optional(),
        })
        .strip()
    )
    .max(256),
  settings: z
    .object({
      defaultBranchPrefix: z.string().max(256),
      baseBranch: z.string().max(256).optional(),
      aheadTargetAction: aheadTargetActionSchema.optional(),
      autoPushAfterMerge: z.boolean().optional(),
      aheadTargetActionId: idSchema.optional(),
      behindTargetAction: behindTargetActionSchema.optional(),
      autoMainBranchAction: simpleAheadActionSchema.optional(),
      autoOtherBranchAction: simpleAheadActionSchema.optional(),
      autoMainActionId: idSchema.optional(),
      autoOtherActionId: idSchema.optional(),
      // Where Terminal Commands run, here or on the host, is this computer's own choice, so
      // `sshWorkspaceMode` isn't copied; older manifests' is dropped.
    })
    .strip(),
  updatedAt: z.number().finite(),
  writtenBy: z.string().max(128).optional(),
});

/** Reads a Project manifest from a host, which is untrusted; undefined when it isn't valid. */
export function parseSshProjectManifest(text: string): SshProjectManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = manifestSchema.safeParse(value);
  return parsed.success ? withoutUndefined(parsed.data) : undefined;
}

/** The agent a preset id and launch mode id name, so another installation can find its own. */
function agentByName(
  presets: readonly AgentPreset[],
  presetId: string | undefined,
  launchModeId: string | undefined
): SshProjectManifestAgent | undefined {
  const preset = presetId ? presets.find((candidate) => candidate.id === presetId) : undefined;
  if (!preset) return undefined;
  const mode = launchModeId
    ? preset.launchModes.find((candidate) => candidate.id === launchModeId)
    : undefined;
  return {
    agentName: preset.name,
    ...(mode ? { launchModeName: mode.name } : {}),
  };
}

/** This installation's ids for an agent named in a manifest; none when it has no such agent. */
export function agentIds(
  presets: readonly AgentPreset[],
  agent: SshProjectManifestAgent | undefined
): { presetId?: string; launchModeId?: string } {
  const preset = agent?.agentName
    ? presets.find((candidate) => candidate.name === agent.agentName)
    : undefined;
  if (!preset) return {};
  const mode = agent?.launchModeName
    ? preset.launchModes.find((candidate) => candidate.name === agent.launchModeName)
    : undefined;
  return { presetId: preset.id, ...(mode ? { launchModeId: mode.id } : {}) };
}

/** The Quick Commands a project's manifest carries: its own, and others its settings start. */
function projectQuickCommands(project: Project, actions: readonly Action[]): Action[] {
  const referenced = startedQuickCommandIds(project.setupSteps ?? [], project);
  return actions.filter(
    (action) => action.projectIds?.includes(project.id) || referenced.has(action.id)
  );
}

/** The Quick Commands a project's setup steps and branch settings start. */
function startedQuickCommandIds(
  setupSteps: ReadonlyArray<{ actionId?: string }>,
  settings: Pick<Project, 'aheadTargetActionId' | 'autoMainActionId' | 'autoOtherActionId'>
): Set<string> {
  return new Set(
    [
      ...setupSteps.map((step) => step.actionId),
      settings.aheadTargetActionId,
      settings.autoMainActionId,
      settings.autoOtherActionId,
    ].filter((id): id is string => !!id)
  );
}

/** Describes a project's settings for other installations, with agents by name. */
export function buildSshProjectManifest(
  project: Project,
  gitUrl: string,
  actions: readonly Action[],
  presets: readonly AgentPreset[],
  updatedAt: number,
  writtenBy?: string
): SshProjectManifest {
  const quickCommands = projectQuickCommands(project, actions).map(
    (action): SshProjectManifestQuickCommand => {
      const agent = agentByName(presets, action.presetId, action.launchModeId);
      return {
        id: action.id,
        title: action.title,
        content: action.content,
        type: action.type ?? 'prompt',
        ...(agent ? { agent } : {}),
        ...(action.sshExecutionLocation
          ? { sshExecutionLocation: action.sshExecutionLocation }
          : {}),
        ...(action.background ? { background: true } : {}),
      };
    }
  );
  return withoutUndefined({
    schema: 1,
    gitUrl,
    name: project.name,
    color: project.color,
    icon: project.icon,
    workspaceSetup: {
      setupSteps: (project.setupSteps ?? []).map(({ agent, actionId, ...step }) => {
        const named = agent && agentByName(presets, agent.presetId, agent.launchModeId);
        return {
          ...step,
          // A Quick Command step whose command was never picked saves an empty id.
          ...(actionId ? { actionId } : {}),
          destination: step.destination ?? 'workspace-repository',
          trigger: step.trigger ?? 'every-workspace-start',
          // An agent step without a preset starts the workspace's own agent.
          ...(agent ? { agent: named ?? {} } : {}),
        };
      }),
      agentPlacement: project.agentPlacement ?? 'tab',
      agentLayoutOrder: project.agentLayoutOrder ?? 0,
      trashCleanupScript: project.trashCleanupScript ?? '',
    },
    quickCommands,
    settings: {
      defaultBranchPrefix: project.defaultBranchPrefix,
      baseBranch: project.baseBranch,
      aheadTargetAction: project.aheadTargetAction,
      autoPushAfterMerge: project.autoPushAfterMerge,
      aheadTargetActionId: project.aheadTargetActionId || undefined,
      behindTargetAction: project.behindTargetAction,
      autoMainBranchAction: project.autoMainBranchAction,
      autoOtherBranchAction: project.autoOtherBranchAction,
      autoMainActionId: project.autoMainActionId || undefined,
      autoOtherActionId: project.autoOtherActionId || undefined,
    },
    updatedAt,
    writtenBy,
  }) as SshProjectManifest;
}

/**
 * Identifies a manifest's content, ignoring who wrote it and when, and the
 * clone URL, whose form differs between installations.
 */
export function sshProjectManifestContentKey(manifest: SshProjectManifest): string {
  return JSON.stringify(
    withSortedKeys({
      ...manifest,
      gitUrl: undefined,
      updatedAt: 0,
      writtenBy: undefined,
    })
  );
}

/** Identifies each part of a manifest's content. A project's name goes with its appearance. */
export function sshProjectManifestPartKeys(
  manifest: SshProjectManifest
): Record<SshProjectSettingsPart, string> {
  const key = (value: unknown) =>
    createHash('sha256')
      .update(JSON.stringify(withSortedKeys(value)))
      .digest('hex');
  return {
    appearance: key({
      name: manifest.name,
      color: manifest.color,
      icon: manifest.icon,
    }),
    workspaceSetup: key(manifest.workspaceSetup),
    quickCommands: key(manifest.quickCommands),
    settings: key(manifest.settings),
  };
}

/**
 * `base` with the chosen parts, and who wrote it and when, taken from `from`.
 * A Quick Command its setup steps or settings start that its Quick Commands
 * lack comes from either side, so the manifest has each it refers to, unless
 * `removedFromBase`: one removed from `base` stays removed.
 */
export function withSshProjectManifestParts(
  base: SshProjectManifest,
  from: SshProjectManifest,
  parts: readonly SshProjectSettingsPart[],
  removedFromBase: readonly string[] = []
): SshProjectManifest {
  const merged: SshProjectManifest = {
    ...base,
    gitUrl: from.gitUrl,
    updatedAt: from.updatedAt,
    writtenBy: from.writtenBy,
  };
  for (const part of parts) {
    if (part === 'appearance') {
      Object.assign(merged, { name: from.name, color: from.color, icon: from.icon });
    } else {
      Object.assign(merged, { [part]: from[part] });
    }
  }
  const started = startedQuickCommandIds(merged.workspaceSetup.setupSteps, merged.settings);
  const included = new Set(merged.quickCommands.map((entry) => entry.id));
  const removed = new Set(removedFromBase);
  const additions: SshProjectManifestQuickCommand[] = [];
  for (const entry of [...from.quickCommands, ...base.quickCommands]) {
    if (!started.has(entry.id) || included.has(entry.id) || removed.has(entry.id)) continue;
    included.add(entry.id);
    additions.push(entry);
  }
  if (additions.length > 0) merged.quickCommands = [...merged.quickCommands, ...additions];
  return withoutUndefined(merged);
}

/**
 * A manifest as another installation would read it, with its text, or no
 * text when it would be rejected, e.g. for being too large to publish.
 */
export function publishableSshProjectManifest(manifest: SshProjectManifest): {
  manifest: SshProjectManifest;
  text?: string;
} {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const read =
    Buffer.byteLength(text) <= MAX_SSH_PROJECT_MANIFEST_BYTES
      ? parseSshProjectManifest(text)
      : undefined;
  return read ? { manifest: read, text } : { manifest };
}

/**
 * The parts of `host` that copying would change in this installation's
 * project, described by `local`; every part a new project would take without one.
 * A host without an icon leaves the one here alone. `removedCommands` are
 * Quick Commands here that copying would remove.
 */
export function differingParts(
  host: SshProjectManifest,
  local: SshProjectManifest | undefined,
  removedCommands: readonly string[] = []
): SshProjectSettingsPart[] {
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(withSortedKeys(a)) === JSON.stringify(withSortedKeys(b));
  const parts: SshProjectSettingsPart[] = [];
  if (
    !local ||
    (host.icon !== undefined && host.icon !== local.icon) ||
    (host.color !== undefined && host.color !== local.color)
  ) {
    parts.push('appearance');
  }
  const hasSetup =
    host.workspaceSetup.setupSteps.length > 0 || host.workspaceSetup.trashCleanupScript !== '';
  if (local ? !same(host.workspaceSetup, local.workspaceSetup) : hasSetup) {
    parts.push('workspaceSetup');
  }
  if (
    local
      ? !commandsContained(host, local) || removedCommands.length > 0
      : host.quickCommands.length > 0
  ) {
    parts.push('quickCommands');
  }
  if (!local || !same(host.settings, local.settings)) parts.push('settings');
  return parts;
}

/** Copying adds and updates Quick Commands, and removes only ones removed on the host. */
function commandsContained(host: SshProjectManifest, local: SshProjectManifest): boolean {
  const here = new Map(local.quickCommands.map((entry) => [entry.id, entry]));
  return host.quickCommands.every(
    (entry) =>
      JSON.stringify(withSortedKeys(entry)) === JSON.stringify(withSortedKeys(here.get(entry.id)))
  );
}

/** A setup step as this installation stores it, with its agent's ids here. */
export function localSetupStep(
  step: SshProjectManifest['workspaceSetup']['setupSteps'][number],
  presets: readonly AgentPreset[]
): SetupStep {
  const { agent, ...rest } = step;
  return { ...rest, ...(agent ? { agent: agentIds(presets, agent) } : {}) };
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
