import { isSshWorkspace } from '../../../shared/types/workspace';
import { localMirrorService } from '../local-mirror.service';

import { workspaceStore } from './store';

export async function prepareLocalMirror(workspaceId: string): Promise<string> {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (!workspace || !isSshWorkspace(workspace)) {
    throw new Error('Local copies are only available for SSH workspaces');
  }
  return localMirrorService.prepare(workspace.id, workspace.backend);
}

export async function initializeLocalMirror(workspaceId: string): Promise<string> {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (!workspace || !isSshWorkspace(workspace)) {
    throw new Error('Local copies are only available for SSH workspaces');
  }
  return localMirrorService.initialize(workspace.id, workspace.backend);
}

export function requestSshLocalMirrorSync(workspaceId: string): void {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (
    workspace &&
    isSshWorkspace(workspace) &&
    localMirrorService.hasMirror(workspace.id, workspace.backend)
  ) {
    localMirrorService.requestSync(workspace.id, workspace.backend);
  }
}

export function retryLocalMirrorSync(workspaceId: string): void {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (!workspace || !isSshWorkspace(workspace)) {
    throw new Error('Local copies are only available for SSH workspaces');
  }
  localMirrorService.requestSync(workspace.id, workspace.backend, 'retry');
}
