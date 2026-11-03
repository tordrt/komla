import { openNewWorkspaceDialog } from '@/stores/dialogs.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  ASK_FOR_PANEL,
  ASK_FOR_STATUS_ITEM,
  buildCustomizePrompt,
} from '../../shared/constants/customize-prompt';

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

/** Asks the open workspace's agent, or, with no workspace open, one from New Workspace. */
function customizeWithAgent(prompt: string): void {
  const workspaceId = useWorkspacesStore.getState().selectedWorkspaceId;
  if (workspaceId) void openCustomizeAgent(workspaceId, prompt);
  else openNewWorkspaceDialog({ prompt });
}

/** Has an agent make a status bar item. */
export function addStatusItemWithAgent(): void {
  customizeWithAgent(buildCustomizePrompt(ASK_FOR_STATUS_ITEM));
}

/** Has an agent make a sidebar panel, or a plugin with one. */
export function addPanelWithAgent(): void {
  customizeWithAgent(buildCustomizePrompt(ASK_FOR_PANEL));
}
