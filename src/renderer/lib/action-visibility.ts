import type { Action } from '@/types';

export function isActionAvailableForProject(
  action: Pick<Action, 'projectIds'> | undefined,
  projectId?: string | null
): boolean {
  if (!action) return false;
  return !action.projectIds?.length || (!!projectId && action.projectIds.includes(projectId));
}

export function findActionForProject(
  actions: Action[],
  actionId: string | undefined,
  projectId?: string | null
): Action | undefined {
  if (!actionId) return undefined;
  const action = actions.find((candidate) => candidate.id === actionId);
  return isActionAvailableForProject(action, projectId) ? action : undefined;
}

/** Komla's built-in quick command that has an agent draft the pull request, if it's visible. */
export function findPrDraftAction(
  actions: Action[],
  projectId?: string | null
): Action | undefined {
  return actions.find(
    (action) =>
      action.title === 'Create PR draft with gh' && isActionAvailableForProject(action, projectId)
  );
}

/** The project's Action a status bar item names, by id or by title. */
export function findStatusItemAction(
  actions: Action[],
  name: string,
  projectId?: string | null
): Action | undefined {
  const available = actions.filter((action) => isActionAvailableForProject(action, projectId));
  const title = name.trim().toLowerCase();
  return (
    available.find((action) => action.id === name) ??
    available.find((action) => action.title.trim().toLowerCase() === title)
  );
}
