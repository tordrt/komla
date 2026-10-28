import { useEffect, useState } from 'react';

import { DeleteActionDialog } from '@/components/layout/settings/DeleteActionDialog';
import { useActionEditorStore } from '@/stores/action-editor.store';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';

import { ActionEditorDialog, type ActionEditorValues } from './ActionEditorDialog';

/** Renders the shared Action editor and delete confirmation for the whole window. */
export function ActionEditorHost() {
  const request = useActionEditorStore((s) => s.request);
  const openCount = useActionEditorStore((s) => s.openCount);
  const pendingDeleteId = useActionEditorStore((s) => s.pendingDeleteId);
  const closeActionEditor = useActionEditorStore((s) => s.closeActionEditor);
  const requestActionDelete = useActionEditorStore((s) => s.requestActionDelete);
  const cancelActionDelete = useActionEditorStore((s) => s.cancelActionDelete);
  const actions = useActionsStore((s) => s.actions);
  const createAction = useActionsStore((s) => s.createAction);
  const updateAction = useActionsStore((s) => s.updateAction);
  const deleteAction = useActionsStore((s) => s.deleteAction);
  const presets = useAgentPresetsStore((s) => s.presets);
  const loadPresets = useAgentPresetsStore((s) => s.loadPresets);
  const projects = useProjectsStore((s) => s.projects);
  const addToast = useToastStore((s) => s.addToast);
  const [isSaving, setIsSaving] = useState(false);

  const editingId = request?.actionId ?? null;
  const editingAction = editingId ? actions.find((a) => a.id === editingId) : undefined;
  const editingMissing = editingId !== null && !editingAction;
  const pendingDeleteAction = actions.find((a) => a.id === pendingDeleteId);

  useEffect(() => {
    if (request) void loadPresets();
  }, [request, loadPresets]);

  // The Action was deleted elsewhere (another window, the CLI) while open.
  useEffect(() => {
    if (editingMissing) closeActionEditor();
  }, [editingMissing, closeActionEditor]);

  const handleSave = async (values: ActionEditorValues) => {
    const title = values.title.trim();
    const content = values.content.trim();
    if (!title || !content) {
      addToast(
        `Quick command title and ${values.type === 'command' ? 'command' : 'content'} are required`,
        'error'
      );
      return;
    }

    const isPrompt = values.type === 'prompt';
    const presetId = isPrompt ? (values.presetId ?? null) : null;
    const launchModeId = isPrompt ? (values.launchModeId ?? null) : null;
    const sshExecutionLocation = values.type === 'command' ? values.sshExecutionLocation : null;

    setIsSaving(true);
    try {
      if (editingId) {
        await updateAction(editingId, {
          title,
          content,
          type: values.type,
          projectIds: values.projectIds,
          presetId,
          launchModeId,
          sshExecutionLocation,
          background: values.background,
        });
        addToast('Quick command updated', 'success');
      } else {
        await createAction({
          title,
          content,
          type: values.type,
          projectIds: values.projectIds.length > 0 ? values.projectIds : undefined,
          ...(presetId ? { presetId } : {}),
          ...(launchModeId ? { launchModeId } : {}),
          ...(sshExecutionLocation ? { sshExecutionLocation } : {}),
          background: values.background,
        });
        addToast('Quick command created', 'success');
      }
      closeActionEditor();
    } catch {
      addToast('Failed to save quick command', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteId) return;
    setIsSaving(true);
    try {
      await deleteAction(pendingDeleteId);
      addToast('Quick command deleted', 'success');
      if (editingId === pendingDeleteId) closeActionEditor();
      cancelActionDelete();
    } catch {
      addToast('Failed to delete quick command', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {request && !editingMissing && (
        <ActionEditorDialog
          key={openCount}
          action={editingAction ?? null}
          defaultProjectIds={request.projectIds}
          defaultAdvancedOpen={request.advancedOpen}
          presets={presets}
          projects={projects}
          isSaving={isSaving}
          onSave={(values) => void handleSave(values)}
          onClose={closeActionEditor}
          onRequestDelete={editingId ? () => requestActionDelete(editingId) : undefined}
          returnFocus={request.returnFocus}
        />
      )}
      <DeleteActionDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => !open && cancelActionDelete()}
        actionTitle={pendingDeleteAction?.title}
        onConfirm={() => void handleDelete()}
        isBusy={isSaving}
      />
    </>
  );
}
