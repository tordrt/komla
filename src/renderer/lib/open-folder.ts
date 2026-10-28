import { openWorkspace } from '@/lib/open-workspace';
import { openNewWorkspaceDialog } from '@/stores/dialogs.store';
import { useOpenFolderStore } from '@/stores/open-folder.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { handleCreateError } from '@/utils/workspace-error';

import type { Project } from '@/types';

// False when the folder didn't open, so it isn't remembered as opened.
type Opened = boolean | void;

export interface OpenFolderHandlers {
  /** The folder, or the repository it is in, is already a project. */
  onProject: (project: Project) => Opened | Promise<Opened>;
  /** The root of a Git repository to add as a project, as asked. */
  onAddProject: (repoRoot: string) => void;
  /** A folder that opens as a workspace of its own, without a project. */
  onFolder: (path: string) => Opened | Promise<Opened>;
}

const NO_MATCH = { project: null, repoRoot: null };

/** Picks a folder and hands it to the matching handler, as {@link routeFolder} does. */
export async function pickFolder(handlers: OpenFolderHandlers): Promise<void> {
  const path = await window.api.selectAnyDirectory();
  if (!path) return;
  await routeFolder(path, handlers);
}

/**
 * Hands a folder to the matching handler. A folder in a Git repository that isn't a project
 * yet asks first whether to add the repository, since a plain folder gets no worktrees.
 */
export async function routeFolder(path: string, handlers: OpenFolderHandlers): Promise<void> {
  // Asked after the picker closes, so a project added meanwhile, even in another window, counts.
  const { project, repoRoot } = await window.api.findProjectForFolder(path).catch(() => NO_MATCH);
  if (project) {
    if ((await handlers.onProject(project)) !== false) rememberOpenedFolder(path);
    return;
  }

  const choice = repoRoot
    ? await useOpenFolderStore.getState().askHowToOpenGitRepo(path, repoRoot)
    : 'folder';
  if (!choice) return;
  if (choice === 'project') {
    rememberOpenedFolder(path);
    return handlers.onAddProject(repoRoot!);
  }
  if ((await handlers.onFolder(path)) !== false) rememberOpenedFolder(path);
}

// Open Recent lists it, so it's opened the same way again.
function rememberOpenedFolder(path: string): void {
  void window.api.recordOpenedFolder(path).catch(() => {});
}

/**
 * Creates a workspace in a folder project, or in a folder, which main puts in its project.
 * False when it couldn't, which it has told the user.
 */
export async function createFolderWorkspace(
  params: { directoryPath: string } | { projectId: string }
): Promise<boolean> {
  try {
    await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', ...params });
    return true;
  } catch (err) {
    handleCreateError(err, () => void createFolderWorkspace(params));
    return false;
  }
}

/**
 * Shows the folder project's open workspace instead of adding another, preferring this
 * window's and then the one used last. A folder without one gets a new workspace.
 */
async function reopenFolderProject(project: Project): Promise<boolean> {
  const currentWindowId = useWindowStore.getState().windowId;
  const [open] = useWorkspacesStore
    .getState()
    .workspaces.filter((w) => w.projectId === project.id && w.status === 'active')
    .sort(
      (a, b) =>
        Number(b.windowId === currentWindowId) - Number(a.windowId === currentWindowId) ||
        (b.lastActivityAt || b.createdAt) - (a.lastActivityAt || a.createdAt)
    );
  if (!open) return createFolderWorkspace({ projectId: project.id });
  await openWorkspace(open, currentWindowId);
  return true;
}

const OPEN_FOLDER_HANDLERS: OpenFolderHandlers = {
  onProject: (project) =>
    project.kind === 'directory'
      ? reopenFolderProject(project)
      : openNewWorkspaceDialog({ prefill: { projectId: project.id } }),
  onAddProject: (repoRoot) => openNewWorkspaceDialog({ prefill: { addProjectPath: repoRoot } }),
  onFolder: (directoryPath) => createFolderWorkspace({ directoryPath }),
};

function workspacesLoaded(): Promise<void> {
  if (useWorkspacesStore.getState().hasLoaded) return Promise.resolve();
  return new Promise((loaded) => {
    const stop = useWorkspacesStore.subscribe((state) => {
      if (!state.hasLoaded) return;
      stop();
      loaded();
    });
  });
}

let opening: Promise<void> = Promise.resolve();

/**
 * Opens folders one at a time, once the workspaces have loaded, so a folder handed over at
 * startup or twice in a row finds the workspace it already has instead of adding another.
 */
function openInTurn(path: string): Promise<void> {
  const turn = opening.then(workspacesLoaded).then(() => routeFolder(path, OPEN_FOLDER_HANDLERS));
  opening = turn.catch(() => {});
  return turn;
}

let pickingFolder: Promise<void> | null = null;

/**
 * Open Folder outside New Workspace: from the File menu, its shortcut or Quick Create, or
 * with `path` for a folder given another way, such as a recent or dropped one. While the
 * picker is still picking or creating, another Open Folder joins it instead of starting
 * over; folders given each open, as when several are handed over at once.
 */
export function openFolder(path?: string): Promise<void> {
  if (path) return openInTurn(path);
  pickingFolder ??= window.api
    .selectAnyDirectory()
    .then((picked) => (picked ? openInTurn(picked) : undefined))
    .finally(() => {
      pickingFolder = null;
    });
  return pickingFolder;
}
