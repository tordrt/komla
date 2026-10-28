import type { Action, Project } from '@/types';

export interface ActionMenuGroup {
  type: 'command' | 'prompt';
  label: string;
  actions: Action[];
}

/** The Actions available in a project, the project's own before global ones within each
 *  type, matching the sections Settings → Actions reorders them in. */
export function getActionMenuGroups(
  actions: Action[],
  projectId: string | null | undefined
): ActionMenuGroup[] {
  const scoped = actions.filter((action) =>
    Boolean(projectId && action.projectIds?.includes(projectId))
  );
  const global = actions.filter((action) => !action.projectIds?.length);
  const commands: Action[] = [];
  const prompts: Action[] = [];

  for (const action of [...scoped, ...global]) {
    if (action.type === 'command') {
      commands.push(action);
    } else {
      prompts.push(action);
    }
  }

  return [
    ...(commands.length > 0
      ? [{ type: 'command' as const, label: 'Terminal Commands', actions: commands }]
      : []),
    ...(prompts.length > 0
      ? [{ type: 'prompt' as const, label: 'Saved Prompts', actions: prompts }]
      : []),
  ];
}

export interface ActionSettingsGroup {
  /** The scope the group's Actions share: their known project ids, `all` or `removed`. */
  key: string;
  title: string;
  /** The scope's projects that still exist, in sidebar order. */
  projects: ScopeProject[];
  actions: Action[];
}

type ScopeProject = Pick<Project, 'id' | 'name' | 'color' | 'order'>;

/** Settings → Actions sections: All projects, then each project scope in sidebar order
 *  (a multi-project scope follows its first project), then Actions whose projects are all
 *  gone. Terminal Commands come before Saved Prompts, each in configured order. */
export function getActionSettingsGroups(
  actions: Action[],
  projects: ScopeProject[]
): ActionSettingsGroup[] {
  const sorted = [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const projectIndex = new Map(sorted.map((project, index) => [project.id, index]));
  const groups = new Map<string, ActionSettingsGroup & { rank: number[] }>();
  const ordered = [
    ...actions.filter((action) => action.type === 'command'),
    ...actions.filter((action) => action.type !== 'command'),
  ];

  for (const action of ordered) {
    const scope = getActionScope(action, sorted, projectIndex);
    const group = groups.get(scope.key) ?? { ...scope, actions: [] };
    groups.set(scope.key, group);
    group.actions.push(action);
  }

  return [...groups.values()]
    .sort((a, b) => compareRanks(a.rank, b.rank))
    .map(({ rank: _rank, ...group }) => group);
}

function getActionScope(
  action: Action,
  projects: ScopeProject[],
  projectIndex: Map<string, number>
): Omit<ActionSettingsGroup, 'actions'> & { rank: number[] } {
  if (!action.projectIds?.length) {
    return { key: 'all', title: 'All projects', projects: [], rank: [-1] };
  }
  const known = [...new Set(action.projectIds.flatMap((id) => projectIndex.get(id) ?? []))].sort(
    (a, b) => a - b
  );
  if (known.length === 0) {
    return { key: 'removed', title: 'Removed projects', projects: [], rank: [Infinity] };
  }
  const scoped = known.map((index) => projects[index]);
  return {
    key: scoped.map((project) => project.id).join(','),
    title: scoped.map((project) => project.name).join(', '),
    projects: scoped,
    rank: known,
  };
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Keeps the Actions whose title or content contains every word of `query`. */
export function filterActionMenuGroups(
  groups: ActionMenuGroup[],
  query: string
): ActionMenuGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter((action) => {
        const text = `${action.title}\n${action.content}`.toLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.actions.length > 0);
}

/** The Action a workspace's run button repeats: its default while still shown, else the
 *  most recently used one shown, else the first. */
export function getDefaultAction(
  groups: ActionMenuGroup[],
  defaultActionId?: string
): Action | null {
  const shown = groups.flatMap((group) => group.actions);
  const picked = defaultActionId && shown.find((action) => action.id === defaultActionId);
  if (picked) return picked;
  let lastUsed: Action | null = null;
  for (const action of shown) {
    if (action.lastUsedAt && action.lastUsedAt > (lastUsed?.lastUsedAt ?? 0)) lastUsed = action;
  }
  return lastUsed ?? shown[0] ?? null;
}

/** What an Action runs, on one line. A saved prompt's leading Markdown heading usually
 *  repeats the title, so its preview starts after it. */
export function getActionPreview(action: Pick<Action, 'type' | 'content'>): string {
  if (action.type === 'command') return action.content;
  const lines = action.content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines.length > 1 && /^#{1,6}\s/.test(lines[0]) ? lines.slice(1) : lines;
  return body.map((line) => line.replace(/^#{1,6}\s+/, '')).join(' ');
}
