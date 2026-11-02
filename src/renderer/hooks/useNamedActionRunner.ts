import { useActionLauncher } from '@/hooks/useActionLauncher';
import { findStatusItemAction } from '@/lib/action-visibility';
import { useActionsStore } from '@/stores/actions.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

/**
 * Runs one of the workspace's project's Quick Commands by its title, as a status item or a sidebar
 * panel names it, with the dialog for one that asks for input. `source` names the file or plugin
 * that names it, for the error when the project has none by that name.
 */
export function useNamedActionRunner(workspaceId: string | null) {
  const projectId = useWorkspacesStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workspaceId)?.projectId
  );
  const { runAction, actionInputDialog } = useActionLauncher(workspaceId ?? '');

  // Actions load with the tab bar; reading them again finds one added since.
  const runNamedAction = async (name: string, source: string) => {
    const store = useActionsStore.getState();
    let action = findStatusItemAction(store.actions, name, projectId);
    if (!action) {
      await store.loadActions();
      action = findStatusItemAction(useActionsStore.getState().actions, name, projectId);
    }
    if (action) runAction(action);
    else {
      useToastStore
        .getState()
        .addToast(`This project has no quick command named “${name}”. Check ${source}.`, 'error');
    }
  };

  return { runNamedAction, actionInputDialog };
}
