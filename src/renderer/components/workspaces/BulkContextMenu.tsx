import {
  AppWindow,
  EnvelopeSimple,
  Link,
  LinkBreak,
  PushPin,
  PushPinSlash,
  Square,
  Trash,
  XCircle,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { waitsForNotification } from '@/lib/snooze';
import { getSelectionLinkChange } from '@/lib/workspace-links';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { canStop } from '@/types';

import { BulkDeleteDialog } from './BulkDeleteDialog';
import { BulkTrashDialog, needsBulkTrashConfirmation } from './BulkTrashDialog';
import { CustomSnoozeDialog, SnoozeSubmenu } from './SnoozeMenu';
import { TagSubmenu } from './WorkspaceTagMenu';

export function BulkContextMenuContent() {
  const {
    workspaces,
    selectedWorkspaceIds,
    stopSelectedWorkspaces,
    trashSelectedWorkspaces,
    deleteSelectedWorkspaces,
    markSelectedUnread,
    togglePinSelected,
    snoozeSelected,
    moveSelectedToWindow,
  } = useWorkspacesStore();
  const { availableWindows, windowId: currentWindowId } = useWindowStore();

  const [bulkTrashDialogOpen, setBulkTrashDialogOpen] = useState(false);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);

  const selectedCount = selectedWorkspaceIds.size;
  const selectedWorkspaces = workspaces.filter((w) => selectedWorkspaceIds.has(w.id));
  const runningCount = selectedWorkspaces.filter(canStop).length;
  const trashableWorkspaces = selectedWorkspaces.filter((w) => w.status !== 'trashed');

  const allPinned = selectedWorkspaces.length > 0 && selectedWorkspaces.every((w) => w.pinned);
  const sharedTag = selectedWorkspaces.every((w) => w.tag === selectedWorkspaces[0]?.tag)
    ? selectedWorkspaces[0]?.tag
    : undefined;
  const hasActiveSelected = selectedWorkspaces.some((w) => w.status === 'active');
  const otherWindows = availableWindows.filter((w) => w.id !== currentWindowId);
  return (
    <>
      <ContextMenuContent>
        {runningCount > 0 && (
          <ContextMenuItem onClick={() => void stopSelectedWorkspaces()}>
            <Square />
            Stop ({runningCount})
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={togglePinSelected}>
          {allPinned ? <PushPinSlash /> : <PushPin />}
          {allPinned ? 'Unpin' : 'Pin'} ({selectedCount})
        </ContextMenuItem>
        <SnoozeSubmenu
          untilNotified={
            selectedWorkspaces.length > 0 && selectedWorkspaces.every(waitsForNotification)
          }
          onSnooze={snoozeSelected}
          onCustom={() => setCustomSnoozeOpen(true)}
        />
        <ContextMenuItem onClick={markSelectedUnread}>
          <EnvelopeSimple />
          Mark as Unread ({selectedCount})
        </ContextMenuItem>
        <TagSubmenu
          workspaceIds={selectedWorkspaces.map((w) => w.id)}
          currentTag={sharedTag}
          anyTagged={selectedWorkspaces.some((w) => !!w.tag)}
        />
        <LinkSelectedMenuItem />
        {hasActiveSelected && otherWindows.length === 1 ? (
          <ContextMenuItem onClick={() => void moveSelectedToWindow(otherWindows[0].id)}>
            <AppWindow />
            Move to Window {otherWindows[0].displayNumber}
          </ContextMenuItem>
        ) : hasActiveSelected && otherWindows.length > 1 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <AppWindow />
              Move to Window
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {otherWindows.map((targetWindow) => (
                <ContextMenuItem
                  key={targetWindow.id}
                  onClick={() => void moveSelectedToWindow(targetWindow.id)}
                >
                  Window {targetWindow.displayNumber}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        <ContextMenuItem
          onClick={() => {
            if (needsBulkTrashConfirmation(trashableWorkspaces.length)) {
              setBulkTrashDialogOpen(true);
            } else {
              void trashSelectedWorkspaces();
            }
          }}
        >
          <Trash />
          Move to Trash ({selectedCount})
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setBulkDeleteDialogOpen(true)} variant="destructive">
          <XCircle />
          Delete Permanently ({selectedCount})
        </ContextMenuItem>
      </ContextMenuContent>

      <BulkTrashDialog
        open={bulkTrashDialogOpen}
        onOpenChange={setBulkTrashDialogOpen}
        workspaces={trashableWorkspaces}
        onConfirm={() => void trashSelectedWorkspaces()}
      />
      <CustomSnoozeDialog
        open={customSnoozeOpen}
        onOpenChange={setCustomSnoozeOpen}
        onSnooze={(until) => {
          snoozeSelected(until);
          setCustomSnoozeOpen(false);
        }}
      />
      <BulkDeleteDialog
        open={bulkDeleteDialogOpen}
        onOpenChange={setBulkDeleteDialogOpen}
        workspaces={selectedWorkspaces}
        onConfirm={(deleteBranch) => void deleteSelectedWorkspaces(true, deleteBranch)}
      />
    </>
  );
}

/** Its own component, so the pair check runs only while the menu is open, not on every card. */
function LinkSelectedMenuItem() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectedWorkspaceIds = useWorkspacesStore((s) => s.selectedWorkspaceIds);
  const toggleLinkSelected = useWorkspacesStore((s) => s.toggleLinkSelected);
  const change = useMemo(
    () => getSelectionLinkChange(workspaces, selectedWorkspaceIds),
    [workspaces, selectedWorkspaceIds]
  );
  if (!change) return null;
  return (
    <ContextMenuItem onClick={() => void toggleLinkSelected()}>
      {change.unlink ? <LinkBreak /> : <Link />}
      {change.unlink ? 'Unlink' : 'Link'} ({change.workspaceCount})
    </ContextMenuItem>
  );
}
