import { Info, NotePencil, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getActionSettingsGroups, type ActionSettingsGroup } from '@/lib/action-menu-order';
import { getProjectColor } from '@/lib/project-colors';
import { openActionEditor } from '@/stores/action-editor.store';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';

import { ActionListItem } from './ActionListItem';
import { DeleteActionDialog } from './DeleteActionDialog';
import { ProjectSetupSkillButton } from './ProjectSetupSkillButton';
import { SettingsCard } from './SettingsCard';

import type { Action } from '@/types';
import type React from 'react';

interface ActionsTabProps {
  onClose: () => void;
}

export function ActionsTab({ onClose: _onClose }: ActionsTabProps) {
  const { actions, loadActions, reorderAction, deleteAction } = useActionsStore();
  const { projects } = useProjectsStore();
  const addToast = useToastStore((s) => s.addToast);
  const { presets, loadPresets } = useAgentPresetsStore();

  const [isSavingAction, setIsSavingAction] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteActionId, setDeleteActionId] = useState<string | null>(null);

  useEffect(() => {
    void loadActions();
  }, [loadActions]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  const deleteTargetAction = useMemo(
    () => actions.find((action) => action.id === deleteActionId),
    [actions, deleteActionId]
  );

  const actionGroups = useMemo(
    () => getActionSettingsGroups(actions, projects),
    [actions, projects]
  );
  const {
    draggedActionId,
    dropTarget,
    handleActionDragStart,
    handleActionDragEnd,
    handleActionDragOver,
    handleActionDrop,
  } = useActionDragReorder({ actions, actionGroups, reorderAction, addToast });

  // Settings has no workspace to imply a project, so new Actions start global with
  // the scope choice in view.
  const handleCreateActionDraft = () => {
    openActionEditor({ actionId: null, advancedOpen: true });
  };

  const handleEditAction = (id: string) => {
    openActionEditor({ actionId: id });
  };

  const handleDeleteAction = async () => {
    if (!deleteActionId) return;

    setIsSavingAction(true);
    try {
      await deleteAction(deleteActionId);
      addToast('Quick command deleted', 'success');
      setDeleteDialogOpen(false);
      setDeleteActionId(null);
    } catch {
      addToast('Failed to delete quick command', 'error');
    } finally {
      setIsSavingAction(false);
    }
  };

  const requestDelete = (id: string) => {
    setDeleteActionId(id);
    setDeleteDialogOpen(true);
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[13px] font-medium text-muted-foreground">
              {actions.length} quick command{actions.length !== 1 ? 's' : ''}
            </h3>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                  aria-label="About Quick Commands"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs text-xs">
                Create Saved Prompts and Terminal Commands for workflows you trigger often. Saved
                Prompts are sent to the agent; Terminal Commands open a new terminal. Each quick
                command can be scoped to specific projects and bound to a preset or launch mode.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2">
            {projects.length > 0 && <ProjectSetupSkillButton />}
            {actions.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleCreateActionDraft}>
                <Plus className="mr-1.5 size-3.5" />
                New quick command
              </Button>
            )}
          </div>
        </div>

        {actions.length === 0 ? (
          <EmptyState
            className="rounded-lg border-2 border-dashed border-border/60"
            icon={<NotePencil weight="duotone" />}
            title="No quick commands yet"
            description="Quick Commands are Saved Prompts or Terminal Commands. Saved Prompts are sent to the agent; Terminal Commands open a new terminal. Create your first one to get started."
            action={
              <Button size="sm" onClick={handleCreateActionDraft}>
                <Plus className="mr-1.5 size-3.5" />
                New quick command
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            {actionGroups.map((group) => (
              <ActionGroup
                key={group.key}
                title={group.title}
                colors={group.projects.map(
                  (project) => project.color || getProjectColor(project.name)
                )}
                actions={group.actions}
                presets={presets}
                onEdit={handleEditAction}
                onDelete={requestDelete}
                deleteDisabled={isSavingAction}
                draggedActionId={draggedActionId}
                dropTarget={dropTarget}
                onDragStart={handleActionDragStart}
                onDragEnd={handleActionDragEnd}
                onDragOver={handleActionDragOver}
                onDrop={handleActionDrop}
              />
            ))}
          </div>
        )}
      </div>

      <DeleteActionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        actionTitle={deleteTargetAction?.title}
        onConfirm={() => void handleDeleteAction()}
        isBusy={isSavingAction}
      />
    </>
  );
}

interface ActionDragReorderArgs {
  actions: Action[];
  actionGroups: ActionSettingsGroup[];
  reorderAction: (id: string, newOrder: number) => Promise<void>;
  addToast: (message: string, type: 'success' | 'error') => void;
}

function useActionDragReorder({
  actions,
  actionGroups,
  reorderAction,
  addToast,
}: ActionDragReorderArgs) {
  const [dragState, setDragState] = useState<{
    draggedActionId: string | null;
    dropTarget: { id: string; position: 'before' | 'after' } | null;
  }>({
    draggedActionId: null,
    dropTarget: null,
  });
  const { draggedActionId, dropTarget } = dragState;
  // Rows only move within their own section and type, which is what they render next to.
  const sectionById = useMemo(
    () =>
      new Map(
        actionGroups.flatMap((group) =>
          group.actions.map((action) => [action.id, `${group.key}:${action.type ?? 'prompt'}`])
        )
      ),
    [actionGroups]
  );
  const sameSection = (a: string, b: string) => sectionById.get(a) === sectionById.get(b);

  const handleActionDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDragState({ draggedActionId: id, dropTarget: null });
  };

  const handleActionDragEnd = () => {
    setDragState({ draggedActionId: null, dropTarget: null });
  };

  const handleActionDragOver = (e: React.DragEvent, id: string) => {
    if (!draggedActionId || draggedActionId === id) return;
    if (!sameSection(draggedActionId, id)) {
      if (dropTarget) setDragState((state) => ({ ...state, dropTarget: null }));
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDragState((state) => ({ ...state, dropTarget: { id, position } }));
  };

  const handleActionDrop = async (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (!draggedActionId || draggedActionId === id) {
      handleActionDragEnd();
      return;
    }

    const sourceIndex = actions.findIndex((action) => action.id === draggedActionId);
    const targetIndex = actions.findIndex((action) => action.id === id);
    if (sourceIndex < 0 || targetIndex < 0) {
      handleActionDragEnd();
      return;
    }
    if (!sameSection(draggedActionId, id)) {
      handleActionDragEnd();
      return;
    }

    const position = dropTarget?.id === id ? dropTarget.position : 'before';
    let nextIndex = targetIndex + (position === 'after' ? 1 : 0);
    if (sourceIndex < nextIndex) nextIndex -= 1;

    try {
      await reorderAction(draggedActionId, nextIndex);
    } catch {
      addToast('Failed to reorder quick command', 'error');
    } finally {
      handleActionDragEnd();
    }
  };

  return {
    draggedActionId,
    dropTarget,
    handleActionDragStart,
    handleActionDragEnd,
    handleActionDragOver,
    handleActionDrop,
  };
}

interface ActionGroupProps {
  title: string;
  /** The section's project colors, in sidebar order. */
  colors: string[];
  actions: Action[];
  presets: Parameters<typeof ActionListItem>[0]['presets'];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  deleteDisabled: boolean;
  draggedActionId: string | null;
  dropTarget: { id: string; position: 'before' | 'after' } | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
}

function ActionGroup({
  title,
  colors,
  actions,
  presets,
  onEdit,
  onDelete,
  deleteDisabled,
  draggedActionId,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: ActionGroupProps) {
  return (
    <SettingsCard
      title={title}
      icon={
        colors.length > 0 && (
          <span className="flex -space-x-0.5">
            {colors.map((color, index) => (
              <span
                key={index}
                className="size-2 rounded-full ring-2 ring-background"
                style={{ backgroundColor: color }}
              />
            ))}
          </span>
        )
      }
    >
      {actions.map((action) => (
        <ActionListItem
          key={action.id}
          action={action}
          iconColor={colors.length === 1 ? colors[0] : undefined}
          presets={presets}
          onEdit={onEdit}
          onDelete={onDelete}
          deleteDisabled={deleteDisabled}
          isDragging={draggedActionId === action.id}
          dropPosition={dropTarget?.id === action.id ? dropTarget.position : null}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
        />
      ))}
    </SettingsCard>
  );
}
