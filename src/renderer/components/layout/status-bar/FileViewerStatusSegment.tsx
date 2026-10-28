import { Folder, GitDiff } from '@phosphor-icons/react';

import { Kbd } from '@/components/ui/kbd';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { StatusBarButton } from './StatusBarButton';

const MODES = {
  browse: { label: 'Files', icon: Folder, shortcut: 'file.tree' },
  diff: { label: 'Diff', icon: GitDiff, shortcut: 'diff.toggle' },
} as const;

/** Opens the full-window Files or Diff viewer for the open workspace. Diff needs git. */
export function FileViewerStatusSegment({ mode }: { mode: keyof typeof MODES }) {
  const workspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
  );
  const requestFileViewerTransition = useFileViewerStore((s) => s.requestFileViewerTransition);
  const { label, icon: Icon, shortcut } = MODES[mode];
  const displayShortcut = useShortcutsStore((s) => s.getDisplayShortcut(shortcut));
  if (!workspace || (mode === 'diff' && !workspace.isWorktree)) return null;

  return (
    <StatusBarButton
      aria-label={label}
      tooltip={
        <span className="flex items-center gap-2">
          {label}
          {displayShortcut && <Kbd>{displayShortcut}</Kbd>}
        </span>
      }
      onClick={() =>
        requestFileViewerTransition({ kind: 'toggle', workspaceId: workspace.id, mode })
      }
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </StatusBarButton>
  );
}
