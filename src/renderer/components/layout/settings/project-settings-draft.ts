import { aheadPreset } from '../../../../shared/lib/project-git-defaults';

import type { SimpleAheadAction } from '../../../../shared/types';
import type {
  AgentPlacement,
  BehindTargetAction,
  Project,
  SetupStep,
  SshWorkspaceMode,
} from '@/types';

export type AheadChoice = SimpleAheadAction | 'default';

/** A project's settings page values, as edited before saving. */
export interface ProjectDraft {
  name: string;
  color: string;
  /** An image data URL, or empty for the color dot. */
  icon: string;
  /** Empty follows the app-wide prefix. */
  branchPrefix: string;
  baseBranch: string;
  // 'default' and undefined follow the app-wide git settings.
  autoPushAfterMerge: boolean | undefined;
  /** What ↑N does when the target is the default branch, and when it is another branch. */
  autoMainAction: AheadChoice;
  autoOtherAction: AheadChoice;
  autoMainActionId: string;
  autoOtherActionId: string;
  behindAction: BehindTargetAction | 'default';
  sshWorkspaceMode: SshWorkspaceMode | 'inherit';
  keepSshSettingsInSync: boolean;
  setupSteps: SetupStep[];
  agentPlacement: AgentPlacement;
  agentLayoutOrder: number;
  trashCleanupScript: string;
}

// Each group saves as a whole, and only when one of its fields changed, so saving
// setup steps or the branch prefix leaves an unconfigured commits-ahead button unconfigured.
const IDENTITY_FIELDS = ['name', 'color', 'icon'] as const;
const AHEAD_FIELDS = [
  'autoMainAction',
  'autoOtherAction',
  'autoMainActionId',
  'autoOtherActionId',
] as const;
const GIT_FIELDS = [
  'branchPrefix',
  'baseBranch',
  'autoPushAfterMerge',
  'behindAction',
  'sshWorkspaceMode',
  'keepSshSettingsInSync',
] as const;
const SETUP_FIELDS = [
  'setupSteps',
  'agentPlacement',
  'agentLayoutOrder',
  'trashCleanupScript',
] as const;

function normalizeAgentPlacement(value: string | undefined): AgentPlacement {
  if (value === 'split-right' || value === 'split-bottom') return value;
  return 'tab';
}

type AheadDraft = Pick<ProjectDraft, (typeof AHEAD_FIELDS)[number]>;

// Every stored commits-ahead setting as its two per-branch choices.
function aheadToDraft(project: Project): AheadDraft {
  const action = project.aheadTargetAction;
  if (action === 'auto') {
    return {
      autoMainAction: project.autoMainBranchAction ?? 'default',
      autoOtherAction: project.autoOtherBranchAction ?? 'default',
      autoMainActionId: project.autoMainActionId || '',
      autoOtherActionId: project.autoOtherActionId || '',
    };
  }
  if (action === 'pr' || action === 'merge' || action === 'agent-prompt' || action === 'disabled') {
    const actionId = action === 'agent-prompt' ? project.aheadTargetActionId || '' : '';
    return {
      autoMainAction: action,
      autoOtherAction: action,
      autoMainActionId: actionId,
      autoOtherActionId: actionId,
    };
  }
  if (action === 'auto-default') {
    return {
      autoMainAction: 'pr',
      autoOtherAction: 'merge',
      autoMainActionId: '',
      autoOtherActionId: '',
    };
  }
  return {
    autoMainAction: 'default',
    autoOtherAction: 'default',
    autoMainActionId: '',
    autoOtherActionId: '',
  };
}

const NO_AHEAD_FIELDS = {
  autoMainBranchAction: undefined,
  autoOtherBranchAction: undefined,
  autoMainActionId: undefined,
  autoOtherActionId: undefined,
} satisfies Partial<Project>;

// The two choices saved as the preset they match, or per branch where they differ or one
// follows the app-wide setting.
function aheadUpdates(draft: ProjectDraft): Partial<Project> {
  const main = draft.autoMainAction;
  const other = draft.autoOtherAction;
  if (main === 'default' && other === 'default') {
    return { aheadTargetAction: undefined, ...NO_AHEAD_FIELDS };
  }
  const preset = main !== 'default' && other !== 'default' ? aheadPreset(main, other) : undefined;
  if (preset) return { aheadTargetAction: preset, ...NO_AHEAD_FIELDS };
  return {
    aheadTargetAction: 'auto',
    autoMainBranchAction: main === 'default' ? undefined : main,
    autoOtherBranchAction: other === 'default' ? undefined : other,
    autoMainActionId: main === 'agent-prompt' ? draft.autoMainActionId || undefined : undefined,
    autoOtherActionId: other === 'agent-prompt' ? draft.autoOtherActionId || undefined : undefined,
  };
}

export function projectToDraft(project: Project): ProjectDraft {
  return {
    name: project.name,
    color: project.color || '',
    icon: project.icon || '',
    branchPrefix: project.defaultBranchPrefix,
    baseBranch: project.baseBranch || '',
    autoPushAfterMerge: project.autoPushAfterMerge,
    ...aheadToDraft(project),
    behindAction: project.behindTargetAction ?? 'default',
    sshWorkspaceMode: project.sshWorkspaceMode ?? 'inherit',
    keepSshSettingsInSync: !!project.keepSshSettingsInSync,
    setupSteps: project.setupSteps ? project.setupSteps.map((step) => ({ ...step })) : [],
    agentPlacement: normalizeAgentPlacement(project.agentPlacement),
    agentLayoutOrder: project.agentLayoutOrder ?? 0,
    trashCleanupScript: project.trashCleanupScript ?? '',
  };
}

function changed(
  fields: readonly (keyof ProjectDraft)[],
  draft: ProjectDraft,
  saved: ProjectDraft
): boolean {
  return fields.some((field) => JSON.stringify(draft[field]) !== JSON.stringify(saved[field]));
}

export function isDraftChanged(draft: ProjectDraft, saved: ProjectDraft): boolean {
  return changed(
    [...IDENTITY_FIELDS, ...AHEAD_FIELDS, ...GIT_FIELDS, ...SETUP_FIELDS],
    draft,
    saved
  );
}

function gitUpdates(draft: ProjectDraft): Partial<Project> {
  return {
    defaultBranchPrefix: draft.branchPrefix.trim(),
    baseBranch: draft.baseBranch.trim() || undefined,
    autoPushAfterMerge: draft.autoPushAfterMerge,
    sshWorkspaceMode: draft.sshWorkspaceMode === 'inherit' ? undefined : draft.sshWorkspaceMode,
    keepSshSettingsInSync: draft.keepSshSettingsInSync || undefined,
    behindTargetAction: draft.behindAction === 'default' ? undefined : draft.behindAction,
  };
}

/** The project updates that save `draft`, for the groups changed since `saved`. */
export function draftToUpdates(
  draft: ProjectDraft,
  saved: ProjectDraft,
  kind: Project['kind']
): Partial<Project> {
  const updates: Partial<Project> = {};
  if (changed(IDENTITY_FIELDS, draft, saved)) {
    updates.name = draft.name.trim();
    updates.color = draft.color || undefined;
    updates.icon = draft.icon || undefined;
  }
  if (kind === 'directory') return updates;
  if (changed(AHEAD_FIELDS, draft, saved)) Object.assign(updates, aheadUpdates(draft));
  if (changed(GIT_FIELDS, draft, saved)) Object.assign(updates, gitUpdates(draft));
  if (changed(SETUP_FIELDS, draft, saved)) {
    Object.assign(updates, {
      setupSteps: draft.setupSteps,
      agentPlacement: draft.agentPlacement,
      agentLayoutOrder: draft.agentLayoutOrder,
      trashCleanupScript: draft.trashCleanupScript,
    } satisfies Partial<Project>);
  }
  return updates;
}
