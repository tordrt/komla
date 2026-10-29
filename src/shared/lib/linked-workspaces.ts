/** The folder in a workspace that holds a symlink to each workspace linked to it. */
export const LINKED_WORKSPACES_DIR = 'linked-workspaces';

/** Whether `filePath`, relative to a workspace, is its linked-workspaces folder or inside it. */
export function isInLinkedWorkspaces(filePath: string): boolean {
  return filePath === LINKED_WORKSPACES_DIR || filePath.startsWith(`${LINKED_WORKSPACES_DIR}/`);
}

/** Whether `filePath` names an entry right in the folder, such as the symlink to a workspace. */
export function isLinkedWorkspacesEntry(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.length === 2 && segments[0] === LINKED_WORKSPACES_DIR && segments[1] !== '';
}
