// Sidebar group keys (`project:<id>`, `repo:<name>`, `dir:<path>`, `none:<workspace id>`, `all`,
// SCRATCH_GROUP_KEY, or PINNED_GROUP_KEY for the Pinned shelf) the user collapsed. Kept per
// machine, like the sidebar width.
const COLLAPSED_GROUPS_STORAGE_KEY = 'komla.sidebarCollapsedGroups';

/** The Pinned shelf's key, which collapses with the groups; no group key starts with `shelf:`. */
export const PINNED_GROUP_KEY = 'shelf:pinned';

/** The group every Scratch workspace is in. */
export const SCRATCH_GROUP_KEY = 'scratch';

export function readStoredCollapsedGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]'
    );
    return new Set(
      Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
    );
  } catch {
    return new Set();
  }
}

export function storeCollapsedGroups(groupKeys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(groupKeys))
    );
  } catch {
    // Storage unavailable — groups just start expanded after a restart.
  }
}
