import { isSshWorkspace, type Workspace } from '@/types';

/** Whether `peer` can be linked to `origin`: same backend (and SSH host), active and ready. */
export function canLinkPair(origin: Workspace, peer: Workspace): boolean {
  if (isSshWorkspace(origin)) {
    if (!isSshWorkspace(peer) || peer.backend.hostId !== origin.backend.hostId) return false;
  } else if (isSshWorkspace(peer)) {
    return false;
  }
  return peer.status === 'active' && !peer.provisioning && Boolean(peer.workingDirectory);
}

export interface SelectionLinkChange {
  unlink: boolean;
  pairs: [Workspace, Workspace][];
  /** Workspaces that gain or lose a link. */
  workspaceCount: number;
}

/**
 * What linking a selection would do: link every workspace in it to each other one it can link
 * to, or, once every such pair is linked, unlink them all. Null when no pair can be linked.
 */
export function getSelectionLinkChange(
  allWorkspaces: Workspace[],
  selectedIds: Set<string>
): SelectionLinkChange | null {
  const selected = allWorkspaces.filter((w) => selectedIds.has(w.id));
  const missing: [Workspace, Workspace][] = [];
  const linked: [Workspace, Workspace][] = [];
  for (let i = 0; i < selected.length; i++) {
    const a = selected[i];
    for (let j = i + 1; j < selected.length; j++) {
      const b = selected[j];
      if (a.linkedWorkspaceIds?.includes(b.id)) linked.push([a, b]);
      else if (canLinkPair(a, b) && canLinkPair(b, a)) missing.push([a, b]);
    }
  }
  const unlink = missing.length === 0;
  const pairs = unlink ? linked : missing;
  if (pairs.length === 0) return null;
  return { unlink, pairs, workspaceCount: new Set(pairs.flat().map((w) => w.id)).size };
}
