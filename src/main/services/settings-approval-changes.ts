import type { WorkspaceSetupState } from './project.service';
import type { Action, AgentPreset, Project, SetupStep } from '../../shared/types';
import type { SettingsApprovalChange } from '../../shared/types/settings-approval';

/** An Action's settings, without what Komla records about its use. */
export function actionConfig(action: Action): Action {
  return {
    id: action.id,
    title: action.title,
    content: action.content,
    ...(action.type && action.type !== 'prompt' ? { type: action.type } : {}),
    ...(action.projectIds?.length ? { projectIds: [...action.projectIds] } : {}),
    ...(action.presetId ? { presetId: action.presetId } : {}),
    ...(action.launchModeId ? { launchModeId: action.launchModeId } : {}),
    ...(action.sshExecutionLocation ? { sshExecutionLocation: action.sshExecutionLocation } : {}),
    ...(action.background ? { background: true } : {}),
  };
}

/** A project's Workspace Setup, with its defaults filled in. */
export function workspaceSetup(project: Project): WorkspaceSetupState {
  return {
    setupSteps: (project.setupSteps ?? []).map((step) => ({
      ...step,
      ...(step.agent ? { agent: { ...step.agent } } : {}),
    })),
    agentPlacement: project.agentPlacement ?? 'tab',
    agentLayoutOrder: project.agentLayoutOrder ?? 0,
    trashCleanupScript: project.trashCleanupScript ?? '',
  };
}

/** The Quick Commands `after` adds, edits and deletes relative to `before`. */
export function describeActionChanges(
  before: Action[],
  after: Action[],
  presets: readonly AgentPreset[]
): SettingsApprovalChange[] {
  const beforeMap = new Map(before.map((action) => [action.id, action]));
  const afterMap = new Map(after.map((action) => [action.id, action]));
  const changes: SettingsApprovalChange[] = [];
  for (const action of after) {
    const previous = beforeMap.get(action.id);
    if (!previous) changes.push(describeAction('add', action, presets));
    else if (JSON.stringify(actionConfig(previous)) !== JSON.stringify(actionConfig(action))) {
      changes.push(describeAction('edit', action, presets));
    }
  }
  for (const action of before)
    if (!afterMap.has(action.id)) changes.push(describeAction('delete', action, presets));
  return changes;
}

function describeAction(
  operation: 'add' | 'edit' | 'delete',
  action: Action,
  presets: readonly AgentPreset[]
): SettingsApprovalChange {
  const preset = action.presetId
    ? presets.find((candidate) => candidate.id === action.presetId)
    : undefined;
  const launchMode = action.launchModeId
    ? preset?.launchModes.find((candidate) => candidate.id === action.launchModeId)
    : undefined;
  const details: SettingsApprovalChange['details'] = [
    { label: 'Type', value: action.type === 'command' ? 'Command' : 'Prompt' },
  ];
  if (preset) details.push({ label: 'Preset', value: preset.name });
  if (launchMode) details.push({ label: 'Launch mode', value: launchMode.name });
  if (action.sshExecutionLocation) {
    details.push({
      label: 'SSH workspaces',
      value:
        action.sshExecutionLocation === 'remote'
          ? 'Runs on the remote machine'
          : 'Runs in the Local copy on this computer',
    });
  }
  if (action.background) {
    details.push({ label: 'Runs', value: 'In the background, with a notification when done' });
  }
  return {
    operation,
    kind: 'action',
    title: action.title,
    contentLabel: action.type === 'command' ? 'Command' : 'Prompt',
    content: action.content,
    details,
  };
}

/** The Workspace Setup changes from `before` to `after`, with the Quick Commands steps start in `actions`. */
export function describeSetupChanges(
  before: WorkspaceSetupState,
  after: WorkspaceSetupState,
  actions: readonly Action[]
): SettingsApprovalChange[] {
  const changes: SettingsApprovalChange[] = [];
  const beforeSteps = new Map(before.setupSteps.map((step) => [step.id, step]));
  const afterSteps = new Map(after.setupSteps.map((step) => [step.id, step]));
  for (const step of after.setupSteps) {
    const previous = beforeSteps.get(step.id);
    if (!previous) changes.push(describeSetupStep('add', step, actions));
    else if (JSON.stringify(previous) !== JSON.stringify(step)) {
      changes.push(describeSetupStep('edit', step, actions));
    }
  }
  for (const step of before.setupSteps) {
    if (!afterSteps.has(step.id)) changes.push(describeSetupStep('delete', step, actions));
  }
  if (
    before.agentPlacement !== after.agentPlacement ||
    before.agentLayoutOrder !== after.agentLayoutOrder
  )
    changes.push({
      operation: 'change',
      kind: 'agent-placement',
      title: 'Agent placement',
      details: [
        { label: 'Placement', value: setupPlacementLabel(after.agentPlacement) },
        { label: 'Layout order', value: String(after.agentLayoutOrder) },
      ],
    });
  if (before.trashCleanupScript !== after.trashCleanupScript)
    changes.push({
      operation: 'change',
      kind: 'trash-cleanup',
      title: 'Trash cleanup',
      contentLabel: 'Script',
      content: after.trashCleanupScript || 'Disabled',
      details: [],
    });
  return changes;
}

function describeSetupStep(
  operation: 'add' | 'edit' | 'delete',
  step: SetupStep,
  actions: readonly Action[]
): SettingsApprovalChange {
  const action = step.actionId
    ? actions.find((candidate) => candidate.id === step.actionId)
    : undefined;
  const details: SettingsApprovalChange['details'] = [
    { label: 'Show in', value: setupPlacementLabel(step.placement) },
    { label: 'Run in', value: setupDestinationLabel(step.destination) },
    { label: 'Run on', value: setupTriggerLabel(step.trigger) },
  ];
  if (step.actionId)
    details.push({ label: 'Quick command', value: action?.title ?? step.actionId });
  if (step.agent?.presetId) details.push({ label: 'Preset', value: step.agent.presetId });
  if (step.agent?.launchModeId)
    details.push({ label: 'Launch mode', value: step.agent.launchModeId });
  return {
    operation,
    kind: 'setup-step',
    title: step.name,
    contentLabel: action?.type === 'command' ? 'Command' : action ? 'Prompt' : 'Command',
    content: action ? action.content : step.command || undefined,
    details,
  };
}

function setupPlacementLabel(
  placement: SetupStep['placement'] | WorkspaceSetupState['agentPlacement']
): string {
  switch (placement) {
    case 'background':
      return 'Background';
    case 'split-right':
      return 'Split right';
    case 'split-bottom':
      return 'Split bottom';
    default:
      return 'Tab';
  }
}

function setupDestinationLabel(destination: SetupStep['destination']): string {
  switch (destination) {
    case 'local-workspace-repository':
      return 'Local workspace repository';
    case 'ssh-workspace-repository':
      return 'SSH workspace repository';
    case 'ssh-local-copy':
      return 'SSH Local copy';
    default:
      return 'Workspace repository';
  }
}

function setupTriggerLabel(trigger: SetupStep['trigger']): string {
  if (trigger === 'workspace-creation') return 'Workspace creation';
  return trigger === 'workspace-stop' ? 'Workspace stop' : 'Every workspace start';
}

const AHEAD_ACTION_LABELS: Record<string, string> = {
  'auto-default': 'Create PR for the default branch, merge others',
  auto: 'By target branch',
  unconfigured: 'Ask',
  merge: 'Merge',
  pr: 'Create PR',
  disabled: 'Off',
  'agent-prompt': 'Saved Prompt',
};

const BEHIND_ACTION_LABELS: Record<string, string> = {
  auto: 'Rebase or merge',
  rebase: 'Rebase',
  merge: 'Merge',
};

/** A project's branch and merge settings that `after` changes, as one change listing each. */
export function describeBranchSettingsChanges(
  before: Project,
  after: Project,
  actions: readonly Action[]
): SettingsApprovalChange[] {
  const command = (id: string | undefined) =>
    id ? (actions.find((action) => action.id === id)?.title ?? id) : 'None';
  const choice = (labels: Record<string, string>, value: string | undefined) =>
    value ? (labels[value] ?? value) : 'Default';
  const fields: Array<[string, (project: Project) => string]> = [
    ['Branch prefix', (project) => project.defaultBranchPrefix || 'Default'],
    ['Target branch', (project) => project.baseBranch || 'Default branch'],
    ['Commits ahead', (project) => choice(AHEAD_ACTION_LABELS, project.aheadTargetAction)],
    [
      'Commits ahead of the default branch',
      (project) => choice(AHEAD_ACTION_LABELS, project.autoMainBranchAction),
    ],
    [
      'Commits ahead of other branches',
      (project) => choice(AHEAD_ACTION_LABELS, project.autoOtherBranchAction),
    ],
    ['Saved Prompt for commits ahead', (project) => command(project.aheadTargetActionId)],
    ['Saved Prompt for the default branch', (project) => command(project.autoMainActionId)],
    ['Saved Prompt for other branches', (project) => command(project.autoOtherActionId)],
    [
      'Push after merging',
      (project) =>
        project.autoPushAfterMerge === undefined
          ? 'Default'
          : project.autoPushAfterMerge
            ? 'Yes'
            : 'No',
    ],
    ['Commits behind', (project) => choice(BEHIND_ACTION_LABELS, project.behindTargetAction)],
  ];
  const details = fields.flatMap(([label, value]) => {
    const previous = value(before);
    const next = value(after);
    return previous === next ? [] : [{ label, value: next, previous }];
  });
  if (details.length === 0) return [];
  return [
    {
      operation: 'change',
      kind: 'project-setting',
      title: 'Branch and merge settings',
      details,
    },
  ];
}
