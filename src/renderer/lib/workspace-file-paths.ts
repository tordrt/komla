import { LINKED_WORKSPACES_DIR } from '../../shared/lib/linked-workspaces';

/** Where a workspace's imported files are: those dropped, pasted or attached to a prompt. */
export const KOMLA_FILES_DIR = '.komla-files';

/** Komla's own folders in a workspace, which the Remote Companion doesn't watch. */
export const MANAGED_FILE_ROOTS = [KOMLA_FILES_DIR, LINKED_WORKSPACES_DIR] as const;

/** Whether `filePath` is one of `paths` or inside one of them. */
export function isSameOrInside(filePath: string, paths: readonly string[]): boolean {
  return paths.some((path) => filePath === path || filePath.startsWith(`${path}/`));
}

/** Whether `filePath`, relative to a workspace, is its imported files' folder or inside it. */
export function isImportedFilePath(filePath: string): boolean {
  return isSameOrInside(filePath, [KOMLA_FILES_DIR]);
}
