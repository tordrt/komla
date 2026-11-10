import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { generateBranchSuffix } from '../../../shared/lib/random-names';
import { deleteReleasingOpenCodeLocation } from '../../lib/opencode-service';
import { removePathInChild } from '../../lib/remove-path';
import { isSamePath } from '../../lib/same-path';
import { getKomlaBasePath } from '../paths';

import type { CreateWorkspaceParams, Workspace } from '../../../shared/types';

const NAME_ATTEMPTS = 20;

/** The folder that holds every Scratch workspace's folder. */
export function scratchRoot(): string {
  return join(getKomlaBasePath(), 'scratch');
}

/** A Scratch workspace makes its own folder, so it names no folder, project or SSH host. */
export function assertScratchParams(params: CreateWorkspaceParams): void {
  if (!params.scratch) return;
  if (
    params.mode !== 'directory' ||
    params.directoryPath ||
    params.projectId ||
    params.location?.kind === 'ssh'
  ) {
    throw new Error(
      'A scratch workspace makes its own folder on this computer, outside any project'
    );
  }
}

export interface ScratchFolder {
  path: string;
  /** Its name, like "swift-fox". */
  suffix: string;
}

/** Makes an empty folder for a new Scratch workspace, named like "swift-fox". */
export function createScratchFolder(): ScratchFolder {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const suffix = attempt < NAME_ATTEMPTS / 2 ? generateBranchSuffix() : uniqueSuffix();
    const path = join(root, suffix);
    if (existsSync(path)) continue;
    try {
      // Not recursive, so a folder made meanwhile fails instead of being shared.
      mkdirSync(path);
      return { path, suffix };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not make a folder for the scratch workspace.');
}

function uniqueSuffix(): string {
  return `${generateBranchSuffix()}-${Date.now().toString(36)}`;
}

/** Whether `path` is a folder Komla made for a Scratch workspace, directly in the scratch root. */
export function isScratchFolder(path: string): boolean {
  if (!path) return false;
  const folder = resolve(path);
  return isSamePath(dirname(folder), scratchRoot()) && !isSamePath(folder, scratchRoot());
}

/**
 * Deletes a Scratch workspace's folder. Leaves any other folder alone, even one a Scratch
 * workspace somehow points at, since the user's own folders are never Komla's to delete.
 */
export async function removeScratchFolder(workspace: Workspace): Promise<void> {
  if (!workspace.scratch) return;
  await removeScratchFolderAt(workspace.workingDirectory);
}

/** Deletes `folder` and everything in it, when it's a scratch folder; leaves any other alone. */
export async function removeScratchFolderAt(folder: string): Promise<void> {
  if (!isScratchFolder(folder)) return;
  // In a child process: an agent's node_modules can be big, and main answers the renderer
  // meanwhile; nor does Electron's fs there take an .asar file for a folder.
  await deleteReleasingOpenCodeLocation(folder, () => removePathInChild(folder));
}
