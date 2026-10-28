// Sidebar group keys (`project:<id>`, `repo:<name>`, `dir:<path>`) the user
// collapsed. Kept per machine, like the sidebar width.
const COLLAPSED_GROUPS_STORAGE_KEY = 'komla.sidebarCollapsedGroups';

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
