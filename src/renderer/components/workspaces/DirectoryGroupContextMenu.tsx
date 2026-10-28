import React from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { ColorSwatchGrid } from './ColorPickerSubmenu';

import type { Workspace } from '@/types';

interface DirectoryGroupContextMenuProps {
  // Directory groups always contain exactly one workspace (unlike project groups)
  workspace: Workspace;
  children: React.ReactNode;
}

export function DirectoryGroupContextMenu({ workspace, children }: DirectoryGroupContextMenuProps) {
  const { updateWorkspace } = useWorkspacesStore();

  const handleColorChange = (color: string) => {
    updateWorkspace(workspace.id, { color });
    void window.api.updateWorkspace(workspace.id, { color });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Color</ContextMenuLabel>
        <ColorSwatchGrid
          currentColor={workspace.color}
          onColorChange={handleColorChange}
          className="px-2 pb-1.5"
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
