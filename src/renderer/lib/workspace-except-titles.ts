import { useRef } from 'react';

import type { Workspace } from '@/types';

/** The fields a terminal's title sets, which agents change with every frame of their spinner. */
const WORKSPACE_TITLE_KEY = 'lastDynamicTitle';
const TERMINAL_TITLE_KEY = 'dynamicTitle';

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

// Runs in selectors on each store update, so it walks both objects' keys without collecting them.
// A key missing from one object counts as undefined, so it matches a key set to undefined.
function sameExcept(a: object, b: object, ignoredKey: string, terminals = false): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key in left) {
    if (key === ignoredKey || !hasOwn(left, key)) continue;
    if (terminals && key === 'terminals') {
      if (!sameTerminalsExceptTitles(left.terminals, right.terminals)) return false;
    } else if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  for (const key in right) {
    if (key === ignoredKey || !hasOwn(right, key) || hasOwn(left, key)) continue;
    if (right[key] !== undefined) return false;
  }
  return true;
}

function sameTerminalsExceptTitles(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every(
    (terminal, index) =>
      terminal === b[index] ||
      (!!terminal && !!b[index] && sameExcept(terminal, b[index], TERMINAL_TITLE_KEY))
  );
}

/** Whether two snapshots of a workspace differ in nothing but their terminals' titles. */
export function sameWorkspaceExceptTitles(
  a: Workspace | null | undefined,
  b: Workspace | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameExcept(a, b, WORKSPACE_TITLE_KEY, true);
}

/** Whether two lists of workspaces differ in nothing but their terminals' titles. */
export function sameWorkspacesExceptTitles(
  a: readonly Workspace[] | null | undefined,
  b: readonly Workspace[] | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((workspace, index) => sameWorkspaceExceptTitles(workspace, b[index]));
}

function useCachedSelector<S, T>(
  selector: (state: S) => T,
  same: (a: T, b: T) => boolean
): (state: S) => T {
  const previous = useRef<{ value: T } | null>(null);
  return (state) => {
    const next = selector(state);
    if (previous.current && same(previous.current.value, next)) return previous.current.value;
    previous.current = { value: next };
    return next;
  };
}

/**
 * Like `useShallow`, for a selector of one workspace: the result keeps its identity while only
 * terminal titles change. For components that don't show titles, which would otherwise re-render
 * with each spinner frame of a working agent. The workspace it returns can hold stale titles.
 */
export function useWorkspaceExceptTitles<S>(
  selector: (state: S) => Workspace | undefined
): (state: S) => Workspace | undefined {
  return useCachedSelector(selector, sameWorkspaceExceptTitles);
}

/** {@link useWorkspaceExceptTitles}, for a selector of a list of workspaces. */
export function useWorkspacesExceptTitles<S>(
  selector: (state: S) => Workspace[]
): (state: S) => Workspace[] {
  return useCachedSelector(selector, sameWorkspacesExceptTitles);
}
