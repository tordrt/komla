import { Copy, FolderOpen, GitBranch } from '@phosphor-icons/react';
import React from 'react';

import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { getWorkspaceCwdIdentity } from '@/types';

import type { Workspace } from '@/types';

/** Copies the workspace's path and branch, which its details card leaves out. */
export function CopyWorkspaceSubmenu({ workspace }: { workspace: Workspace }) {
  // Its directory on its SSH host, or else on this machine.
  const path = getWorkspaceCwdIdentity(workspace);
  const branchName = workspace.isWorktree ? workspace.branchName : undefined;
  if (!path && !branchName) return null;

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Copy />
        Copy
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {path && (
          <ContextMenuItem onClick={() => window.api.copyToClipboard(path)}>
            <FolderOpen />
            Path
          </ContextMenuItem>
        )}
        {branchName && (
          <ContextMenuItem onClick={() => window.api.copyToClipboard(branchName)}>
            <GitBranch />
            Branch Name
          </ContextMenuItem>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
