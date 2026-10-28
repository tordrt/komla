import { canLinkPair } from '@/lib/workspace-links';

import type { Workspace } from '@/types';

export function getLinkWorkspacePeers(
  allWorkspaces: Workspace[],
  workspaceId: string,
  initialLinkedIds: Set<string>
): Workspace[] {
  const origin = allWorkspaces.find((workspace) => workspace.id === workspaceId);
  if (!origin || origin.provisioning) return [];
  return allWorkspaces.filter((w) => {
    if (w.id === workspaceId) return false;
    if (initialLinkedIds.has(w.id)) return true;
    return canLinkPair(origin, w);
  });
}
