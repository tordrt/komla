/** The recent projects, most recent first, after a workspace is created in `projectId`. */
export function withRecentProject(
  recentProjectIds: readonly string[],
  projectId: string
): string[] {
  return [projectId, ...recentProjectIds.filter((id) => id !== projectId)];
}

/** Saved recent project ids, keeping only distinct strings. */
export function normalizeRecentProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
}

/** Projects by last use, most recent first; projects never used keep their order after them. */
export function orderByRecentUse<T extends { id: string }>(
  projects: readonly T[],
  recentProjectIds: readonly string[]
): T[] {
  const ranks = new Map(recentProjectIds.map((id, index) => [id, index]));
  const rank = (project: T) => ranks.get(project.id) ?? recentProjectIds.length;
  // Array sort is stable, so projects never used keep their order.
  return [...projects].sort((a, b) => rank(a) - rank(b));
}
