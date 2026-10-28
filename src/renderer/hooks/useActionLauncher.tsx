import { useEffect, useState } from 'react';

import { DeferredDialog } from '@/components/ui/DeferredDialog';
import { ActionInputDialog } from '@/components/workspaces/ActionInputDialog';
import { launchAction, type ActionPlace } from '@/lib/action-launch';

import type { Action } from '@/types';

/**
 * Runs Actions of the workspace at a place in it, by default a new tab, asking first for any
 * input an Action takes. Render `actionInputDialog` for that question. A Terminal replacement
 * that is declined or fails keeps the question open with what was typed.
 */
export function useActionLauncher(workspaceId: string | undefined) {
  const [actionInputDialogOpen, setActionInputDialogOpen] = useState(false);
  const [pending, setPending] = useState<{ action: Action; place: ActionPlace } | null>(null);

  // Lets the menu the Action was picked from finish closing, so it doesn't take focus back.
  useEffect(() => {
    if (pending && !actionInputDialogOpen) {
      const timer = setTimeout(() => setActionInputDialogOpen(true), 150);
      return () => clearTimeout(timer);
    }
  }, [pending, actionInputDialogOpen]);

  const runAction = (action: Action, place: ActionPlace = { kind: 'tab' }) => {
    if (!workspaceId) return;
    void launchAction({ workspaceId, action, place }).then((outcome) => {
      if (outcome === 'needs-input') setPending({ action, place });
    });
  };

  const closeInputDialog = () => {
    setActionInputDialogOpen(false);
    setPending(null);
  };

  const handleInputConfirm = async (input: string) => {
    if (!pending || !workspaceId) return;
    const { action, place } = pending;
    // A replacement can be declined, which keeps the input to try again.
    const replaces = place.kind === 'replace' || place.kind === 'replace-surface';
    if (!replaces) closeInputDialog();
    const outcome = await launchAction({ workspaceId, action, place, input });
    if (replaces && outcome !== 'not-replaced') closeInputDialog();
  };

  // Deferred: git status indicators and tab rows each hold one, mostly never opened.
  const actionInputDialog = (
    <DeferredDialog open={actionInputDialogOpen}>
      <ActionInputDialog
        open={actionInputDialogOpen}
        actionTitle={pending?.action.title || 'Quick command'}
        actionContent={pending?.action.content || ''}
        lastInput={pending?.action.lastUserInput}
        onCancel={closeInputDialog}
        onConfirm={(input) => {
          void handleInputConfirm(input);
        }}
      />
    </DeferredDialog>
  );

  return { runAction, actionInputDialog };
}
