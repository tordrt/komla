import type { AheadTargetAction, GitDefaults, Project, SimpleAheadAction } from '../types/project';

type ProjectGitSettings = Pick<
  Project,
  | 'defaultBranchPrefix'
  | 'aheadTargetAction'
  | 'autoMainBranchAction'
  | 'autoOtherBranchAction'
  | 'autoMainActionId'
  | 'autoOtherActionId'
  | 'autoPushAfterMerge'
  | 'behindTargetAction'
>;

/**
 * The preset that a pair of per-branch ↑N choices matches, if any. PR-or-fast-forward is
 * 'auto-default', which still fast-forwards the default branch of a repository without origin.
 */
export function aheadPreset(
  main: SimpleAheadAction,
  other: SimpleAheadAction
): AheadTargetAction | undefined {
  if (main === 'pr' && other === 'merge') return 'auto-default';
  if (main === other && main !== 'agent-prompt') return main;
  return undefined;
}

/** The prefix new workspace branches in `project` start with. */
export function resolveBranchPrefix(
  project: Pick<Project, 'defaultBranchPrefix'> | undefined | null,
  defaults: GitDefaults | undefined
): string {
  return project?.defaultBranchPrefix || defaults?.branchPrefix || '';
}

/**
 * `project` with the app-wide git defaults in place of the settings it leaves unset.
 * `repo.hasOriginRemote` is false once the repository is known to have no origin.
 */
export function withGitDefaults<T extends ProjectGitSettings>(
  project: T,
  defaults: GitDefaults | undefined,
  repo: { hasOriginRemote?: boolean } = {}
): T {
  const resolved: T = {
    ...project,
    defaultBranchPrefix: resolveBranchPrefix(project, defaults),
    autoPushAfterMerge: project.autoPushAfterMerge ?? defaults?.autoPushAfterMerge ?? true,
    behindTargetAction: project.behindTargetAction ?? defaults?.behindTargetAction ?? 'auto',
  };
  // An app-wide quick command for the default branch is a PR flow, which needs origin: like an
  // app-wide PR page, it fast-forwards a repository without one.
  const main =
    repo.hasOriginRemote === false && defaults?.aheadMainAction === 'agent-prompt'
      ? 'merge'
      : defaults?.aheadMainAction;
  const mainActionId = main === 'agent-prompt' ? defaults?.aheadMainActionId : undefined;
  const other = defaults?.aheadOtherAction;
  if (project.aheadTargetAction === undefined) {
    if (!main || !other) return { ...resolved, aheadTargetAction: 'unconfigured' };
    const preset = aheadPreset(main, other);
    return preset
      ? { ...resolved, aheadTargetAction: preset }
      : {
          ...resolved,
          aheadTargetAction: 'auto',
          autoMainBranchAction: main,
          autoOtherBranchAction: other,
          autoMainActionId: mainActionId,
          autoOtherActionId: defaults.aheadOtherActionId,
        };
  }
  if (project.aheadTargetAction === 'auto') {
    // A choice taken from the app-wide setting brings its quick command along.
    return {
      ...resolved,
      autoMainBranchAction: project.autoMainBranchAction ?? main,
      autoOtherBranchAction: project.autoOtherBranchAction ?? other,
      autoMainActionId: project.autoMainBranchAction ? project.autoMainActionId : mainActionId,
      autoOtherActionId: project.autoOtherBranchAction
        ? project.autoOtherActionId
        : defaults?.aheadOtherActionId,
    };
  }
  return resolved;
}
