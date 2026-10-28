import { openNewWorkspaceDialog } from '@/stores/dialogs.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { ASK_FOR_STATUS_ITEM, buildCustomizePrompt } from '../../shared/constants/customize-prompt';

/**
 * Opens the workspace's own agent in a tab of its own with a prompt to customize Komla; the Komla
 * CLI reaches Komla from SSH hosts and VMs too.
 */
export async function openCustomizeAgent(workspaceId: string, prompt: string): Promise<void> {
  try {
    const terminal = await useWorkspacesStore.getState().addAgentTab(workspaceId, prompt);
    const { addTab, showTabInFullPane } = useLayoutStore.getState();
    addTab(workspaceId, terminal.id);
    showTabInFullPane(terminal.id);
  } catch (err) {
    useToastStore
      .getState()
      .addToast(`Couldn’t open the agent: ${(err as Error).message}`, 'error');
  }
}

/**
 * Asks the open workspace's agent to make a status bar item, or, with no workspace open, starts
 * one from New Workspace with that prompt.
 */
export function addStatusItemWithAgent(): void {
  const prompt = buildCustomizePrompt(ASK_FOR_STATUS_ITEM);
  const workspaceId = useWorkspacesStore.getState().selectedWorkspaceId;
  if (workspaceId) void openCustomizeAgent(workspaceId, prompt);
  else openNewWorkspaceDialog({ prompt });
}
