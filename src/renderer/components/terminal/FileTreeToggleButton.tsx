import { SidebarSimple } from '@phosphor-icons/react';

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { IconButton } from '@/components/ui/icon-button';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';

/** Toggles the workspace's file tree; its context menu sets whether new workspaces show it. */
export function FileTreeToggleButton({ workspaceId }: { workspaceId: string | null }) {
  const toggleInlineFileTree = useFileViewerStore((s) => s.toggleInlineFileTree);
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('inline.file.tree'));
  const openByDefault = useConfigStore((s) => s.config?.defaultFileTreeOpen === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <IconButton
          label="Toggle file panel"
          shortcut={shortcut}
          onClick={() => workspaceId && toggleInlineFileTree(workspaceId)}
          className="rounded-md hover:bg-muted/60"
        >
          <SidebarSimple className="size-3.5" style={{ transform: 'scaleX(-1)' }} />
        </IconButton>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuCheckboxItem
          checked={openByDefault}
          onCheckedChange={(checked) => updateConfig({ defaultFileTreeOpen: checked })}
        >
          Show by default in new workspaces
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
