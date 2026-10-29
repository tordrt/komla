import { LINKED_WORKSPACES_DIR } from '../../shared/lib/linked-workspaces';

/** Komla's own folders in a workspace, which the Remote Companion doesn't watch. */
export const MANAGED_FILE_ROOTS = ['.komla-files', LINKED_WORKSPACES_DIR] as const;

/** Whether `filePath` is one of `paths` or inside one of them. */
export function isSameOrInside(filePath: string, paths: readonly string[]): boolean {
  return paths.some((path) => filePath === path || filePath.startsWith(`${path}/`));
}
