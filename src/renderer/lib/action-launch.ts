import {
  ACTION_TARGET_BRANCH_TOKEN,
  actionNeedsInjection,
  injectActionContext,
} from '@/lib/action-injection';
import { resolveDefaultLaunchTarget, resolveLaunchablePresets } from '@/lib/agent-launch';
import { runBackgroundAction } from '@/lib/background-action';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { closePaneSurface, confirmClosingPaneSurfaces } from '@/lib/pane-surfaces';
import { replaceTerminal, type ConfirmTerminalReplacement } from '@/lib/replace-terminal';
import { pasteIntoTerminalRenderer } from '@/lib/terminal-renderer-runtime';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshCommandExecutionLocationStore } from '@/stores/ssh-command-execution-location.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import {
  isLocalTerminalExecutionLocation,
  isSshWorkspace,
  resolveWorkspaceTargetBranch,
} from '@/types';
import { substituteCommandVars } from '@/utils/template-vars';

import type { Action, ActionSshExecutionLocation, Project, Terminal, Workspace } from '@/types';
import type { PaneId } from '@/types/layout';

/** Where in its workspace an Action launches. */
export type ActionPlace =
  // `setsDefault: false` leaves the workspace's run button as it was. A Saved Prompt's tab comes
  // to the front; a Terminal Command's opens behind the others unless `front`.
  | { kind: 'tab'; setsDefault?: boolean; front?: boolean }
  | {
      kind: 'split';
      paneId: PaneId;
      /**
       * The Terminal in that pane, whose location a Terminal Command split off it takes. None
       * when the pane shows a browser, a note or a file.
       */
      terminalId?: string;
      tabId: string | null;
      direction: 'vertical' | 'horizontal';
    }
  | { kind: 'replace'; terminalId: string; confirm: ConfirmTerminalReplacement }
  // Opens beside a browser, note or file pane, then closes it. Unsaved edits there are asked
  // about before the launch.
  | { kind: 'replace-surface'; surfaceId: string; paneId: PaneId; tabId: string | null }
  | { kind: 'type'; terminalId: string };

export interface ActionLaunchRequest {
  workspaceId: string;
  action: Action;
  place: ActionPlace;
  /** The answer to the Action's `{{user_input}}`, once it has been asked. */
  input?: string;
}

/**
 * - `needs-input`: the Action asks for input and none was given. Ask, then launch again with it.
 * - `not-replaced`: a Terminal replacement was declined or failed, so the user may try again.
 * - `failed`: nothing started, and the user has been told why where there is something to say.
 */
export type ActionLaunchOutcome = 'launched' | 'needs-input' | 'not-replaced' | 'failed';

/**
 * Runs an Action at a place in its workspace. It fills in the Action's launch context, picks
 * the agent a Saved Prompt starts, and remembers the Action as the place's default once any
 * input it asks for is given: one typed into a Terminal as Paste Prompt's, any other as the
 * workspace's run button's, since those all start something new.
 */
export async function launchAction(request: ActionLaunchRequest): Promise<ActionLaunchOutcome> {
  const { action, place, input } = request;
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === request.workspaceId);
  if (!workspace) return 'failed';
  if (input === undefined && actionNeedsInjection(action.content)) return 'needs-input';

  const workspaces = useWorkspacesStore.getState();
  if (place.kind === 'type') workspaces.setPaneDefaultAction(workspace.id, action.id);
  else if (place.kind !== 'tab' || place.setsDefault !== false) {
    workspaces.setDefaultAction(workspace.id, action.id);
  }

  const text = resolveActionText(action, workspace, input);
  let outcome: ActionLaunchOutcome;
  try {
    // A background Terminal Command runs without a Terminal wherever it's launched; typed, it's
    // only text.
    if (action.type === 'command' && action.background && place.kind !== 'type') {
      outcome = (await runBackgroundAction(workspace, action, text)) ? 'launched' : 'failed';
    } else {
      outcome = await launchAtPlace(workspace, action, text, place);
    }
  } catch (error) {
    console.error('Failed to run quick command:', error);
    useToastStore.getState().addToast('Failed to run quick command', 'error');
    return 'failed';
  }

  if (outcome === 'launched') {
    try {
      await useActionsStore.getState().recordActionUsage(action.id, input, place.kind === 'type');
    } catch (error) {
      console.error('Failed to record action usage:', error);
    }
  }
  return outcome;
}

async function launchAtPlace(
  workspace: Workspace,
  action: Action,
  text: string,
  place: ActionPlace
): Promise<ActionLaunchOutcome> {
  switch (place.kind) {
    case 'tab':
      return launchInTab(workspace, action, text, place);
    case 'split':
      return launchInSplit(workspace, action, text, place);
    case 'replace':
      return launchInPlace(workspace, action, text, place);
    case 'replace-surface': {
      const { paneId, tabId, surfaceId } = place;
      // Asked here, once any input is given, as a background command never gets here to close it.
      if (!(await confirmClosingPaneSurfaces([surfaceId]))) return 'not-replaced';
      const split = { kind: 'split', paneId, tabId, direction: 'vertical' } as const;
      const outcome = await launchInSplit(workspace, action, text, split);
      if (outcome === 'launched') closePaneSurface(workspace.id, surfaceId);
      return outcome;
    }
    case 'type':
      return pasteIntoTerminalRenderer(place.terminalId, text) ? 'launched' : 'failed';
  }
}

/**
 * The text an Action runs in a workspace: its launch context filled in, the workspace's own
 * values before the user's input, so braces typed into the input stay as typed.
 */
export function resolveActionText(action: Action, workspace: Workspace, input?: string): string {
  const project = workspace.projectId
    ? useProjectsStore.getState().projects.find((p) => p.id === workspace.projectId)
    : undefined;
  const content = substituteCommandVars(action.content, {
    worktreePath: workspace.workingDirectory,
    branchName: workspace.branchName || '',
    projectName: project?.name || '',
  });
  const targetBranch = content.includes(ACTION_TARGET_BRANCH_TOKEN)
    ? resolveTargetBranch(workspace, project)
    : undefined;
  return injectActionContext(content, { userInput: input, targetBranch });
}

function resolveTargetBranch(workspace: Workspace, project: Project | undefined): string {
  const gitStatus = useGitStatusStore.getState().getStatus(workspace.id);
  return (
    resolveWorkspaceTargetBranch(workspace, project?.baseBranch, gitStatus?.status?.mainBranch) ||
    'main'
  );
}

// A Saved Prompt without an agent of its own starts the agent a new agent tab would.
function resolvePromptTarget(
  action: Action,
  workspace: Workspace
): { presetId: string | undefined; launchModeId: string | null | undefined } {
  const { presets, activePresets } = useAgentPresetsStore.getState();
  const defaultTarget = resolveDefaultLaunchTarget(
    workspace,
    resolveLaunchablePresets(presets, activePresets),
    activePresets,
    useConfigStore.getState().config?.defaultLaunchModeId ?? null
  );
  return {
    presetId: action.presetId ?? defaultTarget?.presetId,
    launchModeId:
      action.launchModeId ?? (action.presetId ? undefined : defaultTarget?.launchModeId),
  };
}

function toastNoPromptAgent(): void {
  useToastStore.getState().addToast('No agent preset configured for prompt commands', 'error');
}

/**
 * Starts a Terminal Command in a tab of the workspace just created for it. False when it didn't
 * start: the user cancelled, or was told the workspace exists without it, with a Retry that
 * starts it there again instead of creating another workspace.
 */
export async function startCommandInCreatedWorkspace(
  workspace: Workspace,
  action: Action
): Promise<boolean> {
  let terminal: Terminal | null;
  try {
    terminal = await useWorkspacesStore
      .getState()
      .addTerminalCommand(
        workspace.id,
        action.title,
        resolveActionText(action, workspace),
        'tab',
        action.sshExecutionLocation
      );
  } catch (error) {
    console.error('Failed to start command in its new workspace:', error);
    useToastStore
      .getState()
      .addToast(
        `Created workspace "${workspace.name}", but "${action.title}" couldn’t start: ${ipcErrorMessage(error)}`,
        'error',
        {
          action: {
            label: 'Retry',
            onClick: () => void startCommandInCreatedWorkspace(workspace, action),
          },
        }
      );
    return false;
  }
  if (!terminal) return false;
  useLayoutStore.getState().showTabInFullPane(terminal.id);
  return true;
}

function toastStartFailed(error: unknown): void {
  useToastStore
    .getState()
    .addToast(`Failed to create terminal: ${(error as Error).message}`, 'error');
}

// Adds a terminal's tab to its workspace, which need not be the one on screen. A workspace whose
// tabs aren't laid out yet gets its first terminal's tab first, as selecting it would.
function openTab(workspaceId: string, terminalId: string, show: boolean): void {
  const layout = useLayoutStore.getState();
  const first = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId)?.terminals[0];
  if (!layout.tabsByWorkspace[workspaceId]?.length && first && first.id !== terminalId) {
    layout.initializeWorkspaceLayout(workspaceId, first.id);
  }
  layout.addTab(workspaceId, terminalId);
  if (show) {
    useLayoutStore.setState((state) => ({
      activeTabByWorkspace: { ...state.activeTabByWorkspace, [workspaceId]: terminalId },
    }));
  }
}

async function launchInTab(
  workspace: Workspace,
  action: Action,
  text: string,
  place: Extract<ActionPlace, { kind: 'tab' }>
): Promise<ActionLaunchOutcome> {
  const workspaces = useWorkspacesStore.getState();
  if (action.type === 'command') {
    try {
      const terminal = await workspaces.addTerminalCommand(
        workspace.id,
        action.title,
        text,
        undefined,
        action.sshExecutionLocation
      );
      if (!terminal) return 'failed';
      openTab(workspace.id, terminal.id, place.front === true);
      return 'launched';
    } catch (error) {
      toastStartFailed(error);
      return 'failed';
    }
  }

  const terminal = await startSavedPrompt(workspace, action, text);
  if (!terminal) return 'failed';
  openTab(workspace.id, terminal.id, true);
  return 'launched';
}

// Starts a Saved Prompt in an agent tab of its own, which leaves the workspace's agent and the
// last agent used as they were: running a Saved Prompt doesn't pick the agent for new tabs.
async function startSavedPrompt(
  workspace: Workspace,
  action: Action,
  text: string
): Promise<Terminal | null> {
  const promptTarget = resolvePromptTarget(action, workspace);
  const command = promptTarget.presetId
    ? await window.api.buildPromptCommand(
        text,
        promptTarget.presetId,
        promptTarget.launchModeId ?? undefined
      )
    : null;
  if (!command) {
    toastNoPromptAgent();
    return null;
  }
  try {
    return await useWorkspacesStore
      .getState()
      .addAgentTab(
        workspace.id,
        text,
        promptTarget.launchModeId ?? undefined,
        promptTarget.presetId,
        { keepWorkspaceAgent: true }
      );
  } catch (error) {
    toastStartFailed(error);
    return null;
  }
}

// Where a Terminal in an SSH workspace runs: on the host, or in its Local copy.
function sshTerminalLocation(
  workspace: Workspace,
  terminalId: string | undefined
): ActionSshExecutionLocation | undefined {
  if (!terminalId || !isSshWorkspace(workspace)) return undefined;
  const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
  return isLocalTerminalExecutionLocation(terminal?.executionLocation) ? 'local-mirror' : 'remote';
}

async function launchInSplit(
  workspace: Workspace,
  action: Action,
  text: string,
  place: Extract<ActionPlace, { kind: 'split' }>
): Promise<ActionLaunchOutcome> {
  const workspaces = useWorkspacesStore.getState();
  const layout = useLayoutStore.getState();
  const target = { workspaceId: workspace.id, tabId: place.tabId, paneId: place.paneId };
  if (action.type === 'command') {
    // Like a replacement, it runs where the pane runs, unless it names a location of its own.
    const sshExecutionLocation =
      action.sshExecutionLocation ?? sshTerminalLocation(workspace, place.terminalId);
    layout.setFocusedPane(place.paneId);
    try {
      const terminal = await workspaces.addTerminalCommand(
        workspace.id,
        action.title,
        text,
        undefined,
        sshExecutionLocation
      );
      if (!terminal) return 'failed';
      layout.splitPane(place.direction, terminal.id, target);
      return 'launched';
    } catch (error) {
      toastStartFailed(error);
      return 'failed';
    }
  }

  layout.setFocusedPane(place.paneId);
  const terminal = await startSavedPrompt(workspace, action, text);
  if (!terminal) return 'failed';
  layout.splitPane(place.direction, terminal.id, target);
  return 'launched';
}

async function launchInPlace(
  workspace: Workspace,
  action: Action,
  text: string,
  place: Extract<ActionPlace, { kind: 'replace' }>
): Promise<ActionLaunchOutcome> {
  if (action.type === 'command') {
    // A command runs where this Terminal runs, unless it names a location of its own.
    const currentLocation = sshTerminalLocation(workspace, place.terminalId) ?? 'workspace';
    const location = action.sshExecutionLocation
      ? await useSshCommandExecutionLocationStore
          .getState()
          .requestExecutionLocation(workspace, action.sshExecutionLocation)
      : currentLocation;
    if (!location) return 'failed';

    // A command bound for the other side of an SSH workspace, remote or its Local copy, can't
    // take this Terminal's place, so it opens in a tab of its own.
    if (location !== currentLocation) {
      try {
        const newTerminal = await useWorkspacesStore
          .getState()
          .addTerminal(workspace.id, action.title, text, undefined, 'host', location);
        openTab(workspace.id, newTerminal.id, true);
        useToastStore
          .getState()
          .addToast(
            `${action.title} runs ${location === 'local-mirror' ? 'in the Local copy' : 'on the SSH host'}, so it opened in a new tab`,
            'info'
          );
        return 'launched';
      } catch (error) {
        toastStartFailed(error);
        return 'failed';
      }
    }

    const outcome = await replaceTerminal(
      place.terminalId,
      {
        kind: 'terminal-command',
        name: action.title,
        command: text,
        commandKind: 'host',
      },
      place.confirm
    );
    return outcome === 'replaced' ? 'launched' : 'not-replaced';
  }

  const promptTarget = resolvePromptTarget(action, workspace);
  const command = await window.api.buildPromptCommand(
    text,
    promptTarget.presetId,
    promptTarget.launchModeId ?? undefined
  );
  if (!command) {
    toastNoPromptAgent();
    return 'failed';
  }
  const outcome = await replaceTerminal(
    place.terminalId,
    {
      kind: 'saved-prompt',
      name: action.title,
      command,
      presetId: promptTarget.presetId,
      launchModeId: promptTarget.launchModeId,
    },
    place.confirm
  );
  return outcome === 'replaced' ? 'launched' : 'not-replaced';
}
