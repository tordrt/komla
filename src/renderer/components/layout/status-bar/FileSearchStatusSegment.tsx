import { MagnifyingGlass } from '@phosphor-icons/react';

import { Kbd } from '@/components/ui/kbd';
import { useCommandCenterStore } from '@/stores/command-center.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { StatusBarButton } from './StatusBarButton';

/** Opens the command center's file search for the open workspace. */
export function FileSearchStatusSegment() {
  const workspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const toggleCommandCenter = useCommandCenterStore((s) => s.toggle);
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('file.open'));
  if (!workspaceId) return null;

  return (
    <StatusBarButton
      aria-label="Search files"
      tooltip={
        <span className="flex items-center gap-2">
          Search files
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </span>
      }
      onClick={() => toggleCommandCenter('files')}
    >
      <MagnifyingGlass aria-hidden="true" className="size-3.5" />
    </StatusBarButton>
  );
}
