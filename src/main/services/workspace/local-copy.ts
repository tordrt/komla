import { isSshWorkspace } from '../../../shared/types/workspace';
import { localCopyService } from '../local-copy.service';

import { workspaceStore } from './store';

export async function prepareLocalCopy(workspaceId: string): Promise<string> {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (!workspace || !isSshWorkspace(workspace)) {
    throw new Error('Local copies are only available for SSH workspaces');
  }
  return localCopyService.prepare(workspace.id, workspace.backend);
}

export async function initializeLocalCopy(workspaceId: string): Promise<string> {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (!workspace || !isSshWorkspace(workspace)) {
    throw new Error('Local copies are only available for SSH workspaces');
  }
  return localCopyService.initialize(workspace.id, workspace.backend);
}

export function requestSshLocalCopySync(workspaceId: string): void {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (
    workspace &&
    isSshWorkspace(workspace) &&
    localCopyService.hasLocalCopy(workspace.id, workspace.backend)
  ) {
    localCopyService.requestSync(workspace.id, workspace.backend);
  }
}

export function retryLocalCopySync(workspaceId: string): void {
  const workspace = workspaceStore.workspaces.get(workspaceId);
  if (!workspace || !isSshWorkspace(workspace)) {
    throw new Error('Local copies are only available for SSH workspaces');
  }
  localCopyService.requestSync(workspace.id, workspace.backend, 'retry');
}
