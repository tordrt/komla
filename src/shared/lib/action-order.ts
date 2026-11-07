import type { Action } from '../types/action';

/** When an Action was last run or pasted, or 0 for one never used or whose use isn't a time. */
export function actionLastUse(action: Pick<Action, 'lastUsedAt' | 'lastPastedAt'>): number {
  return Math.max(time(action.lastUsedAt), time(action.lastPastedAt));
}

// actions.json can be edited by hand, and a NaN would leave the sort in no order at all.
function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The most recently used first; the ones never used (0) after, in the order given. */
export function byRecentUse<T>(items: readonly T[], lastUse: (item: T) => number): T[] {
  // Sort is stable, so ties keep the order given.
  return [...items].sort((a, b) => lastUse(b) - lastUse(a));
}
