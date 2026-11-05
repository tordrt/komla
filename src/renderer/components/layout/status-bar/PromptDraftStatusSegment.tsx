import { ChatText } from '@phosphor-icons/react';

import { Kbd } from '@/components/ui/kbd';
import { closePromptDraft, openPromptDraft } from '@/lib/prompt-draft';
import { selectPromptDraftWorkspace, usePromptDraftStore } from '@/stores/prompt-draft.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { StatusBarButton } from './StatusBarButton';

/**
 * Shows or hides the prompt draft: the one the window shows, as its shortcut opens, which is the
 * open workspace's.
 */
export function PromptDraftStatusSegment() {
  const hasWorkspace = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.id === s.selectedWorkspaceId)
  );
  const workspaceId = usePromptDraftStore(selectPromptDraftWorkspace);
  const open = usePromptDraftStore((s) => !!workspaceId && !!s.openByWorkspace[workspaceId]);
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('promptDraft.toggle'));
  if (!hasWorkspace || !workspaceId) return null;

  return (
    <StatusBarButton
      aria-label="Prompt draft"
      aria-expanded={open}
      data-state={open ? 'open' : 'closed'}
      tooltip={
        <span className="flex items-center gap-2">
          Draft a prompt while you look at files
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </span>
      }
      // Leaves focus where it is, such as in a terminal, for the draft to give back once it closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (open ? closePromptDraft(workspaceId) : openPromptDraft(workspaceId))}
    >
      <ChatText aria-hidden="true" className="size-3.5" />
    </StatusBarButton>
  );
}
