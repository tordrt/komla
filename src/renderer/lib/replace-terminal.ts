import { closeTerminalPane } from '@/lib/close-terminal-pane';
import { openBrowserPane, openNewNotePane } from '@/lib/pane-surfaces';
import { getTerminalRendererDimensions } from '@/lib/terminal-renderer-runtime';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { claimTerminal, releaseTerminal, useTerminalBusyStore } from '@/stores/terminal-busy.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isLocalTerminalExecutionLocation, isSshWorkspace } from '@/types';

import type { RestartTerminalOptions } from '@/types';
import type { PaneId } from '@/types/layout';

/** What to start in a Terminal in place of its current execution. */
export type TerminalReplacement =
  | { kind: 'agent'; name: string; presetId: string; launchModeId: string | null }
  | {
      kind: 'saved-prompt';
      name: string;
      command: string;
      presetId: string | undefined;
      launchModeId: string | null | undefined;
    }
  | {
      kind: 'terminal-command';
      name: string;
      command: string;
      commandKind: NonNullable<RestartTerminalOptions['commandKind']>;
    }
  | { kind: 'local-copy-shell' }
  /** A shell on the SSH host, in place of a Local copy terminal. */
  | { kind: 'ssh-shell' }
  | { kind: 'remote-retry'; plainShell: boolean };

export type TerminalReplacementOutcome = 'replaced' | 'declined' | 'closing' | 'failed';

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
}

export type ConfirmTerminalReplacement = (request: ConfirmRequest) => Promise<boolean>;

/**
 * Starts something new in a Terminal in place of its current execution. It asks first only when
 * that would interrupt something: an agent mid-turn, or a reconnect or start still in progress.
 */
export async function replaceTerminal(
  terminalId: string,
  replacement: TerminalReplacement,
  confirm: ConfirmTerminalReplacement
): Promise<TerminalReplacementOutcome> {
  // A closing pane is about to disappear, so there is nothing to replace.
  if (useTerminalCloseStore.getState().closingTerminalIds.has(terminalId)) return 'closing';
  const interruption = interruptionOf(terminalId);
  if (
    interruption &&
    !(await confirm(confirmRequest(replacementName(replacement), interruption)))
  ) {
    return 'declined';
  }

  // A remote retry marks the Terminal busy so the pane can show its progress. Main lets the
  // latest replacement take over one still starting, so nothing else needs to hold it.
  const claimed =
    replacement.kind === 'remote-retry' &&
    claimTerminal(terminalId, replacement.plainShell ? 'remote-shell' : 'remote-agent');
  try {
    // Pass the live xterm size so the restarted PTY is born at the right dimensions;
    // xterm's onResize only fires on a size change, so a same-size restart would never resync.
    const dimensions = getTerminalRendererDimensions(terminalId);
    const { presetId, launchModeId, options } = restartArguments(terminalId, replacement);
    try {
      await useWorkspacesStore
        .getState()
        .restartTerminal(
          terminalId,
          presetId,
          launchModeId,
          dimensions?.cols,
          dimensions?.rows,
          options
        );
    } catch (error) {
      useToastStore
        .getState()
        .addToast(
          `Couldn't start ${replacementName(replacement)} in this pane: ${(error as Error).message}`,
          'error'
        );
      return 'failed';
    }

    if (replacement.kind === 'agent') {
      void useAgentPresetsStore
        .getState()
        .setActivePreset(replacement.presetId, replacement.launchModeId);
    }
    return 'replaced';
  } finally {
    if (claimed) releaseTerminal(terminalId);
  }
}

/**
 * Opens a browser or a note in a Terminal's pane and closes the Terminal, asking first as
 * replaceTerminal does.
 */
export async function replaceTerminalWithPaneSurface(
  workspaceId: string,
  terminalId: string,
  paneId: PaneId,
  kind: 'browser' | 'note',
  confirm: ConfirmTerminalReplacement
): Promise<void> {
  const name = kind === 'browser' ? 'a browser' : 'a note';
  if (useTerminalCloseStore.getState().closingTerminalIds.has(terminalId)) return;
  const interruption = interruptionOf(terminalId);
  if (interruption && !(await confirm(confirmRequest(name, interruption)))) return;
  if (useTerminalCloseStore.getState().closingTerminalIds.has(terminalId)) return;

  // The surface opens beside the pane, then takes its place as the Terminal's pane closes.
  const placement = { kind: 'split', direction: 'vertical', paneId } as const;
  if (kind === 'browser') openBrowserPane(workspaceId, placement);
  else if (!(await openNewNotePane(workspaceId, placement))) return;
  try {
    await closeTerminalPane(terminalId);
  } catch (error) {
    console.error('Failed to close the replaced terminal:', error);
  }
}

function findTerminal(terminalId: string) {
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
    if (terminal) return { workspace, terminal };
  }
  return null;
}

// Callers await prompts and IPC first, so this reads the live stores rather than a render's value.
function interruptionOf(terminalId: string): string | null {
  const terminal = findTerminal(terminalId)?.terminal;
  if (terminal?.commandActive) {
    return 'The command in this pane is still running. Replacing it stops the command';
  }
  if (terminal?.agentActive === true) {
    return 'The agent in this pane is still working. Replacing it stops its current turn';
  }
  const busyReason = useTerminalBusyStore.getState().busyTerminals.get(terminalId);
  if (busyReason === 'reconnect') {
    return 'This pane is still reconnecting. Replacing it stops the reconnect';
  }
  if (busyReason) return 'This pane is still starting. Replacing it stops that';
  return null;
}

function runsInSshWorkspaceRepository(terminalId: string): boolean {
  const found = findTerminal(terminalId);
  return (
    !!found &&
    isSshWorkspace(found.workspace) &&
    !isLocalTerminalExecutionLocation(found.terminal.executionLocation)
  );
}

function replacementName(replacement: TerminalReplacement): string {
  switch (replacement.kind) {
    case 'local-copy-shell':
      return 'Local Terminal';
    case 'ssh-shell':
      return 'SSH Terminal';
    case 'remote-retry':
      return replacement.plainShell ? 'a remote shell' : 'a new agent session';
    default:
      return replacement.name;
  }
}

function confirmRequest(name: string, interruption: string): ConfirmRequest {
  return {
    title: `Replace with ${name}?`,
    description: `${interruption} and starts ${name} in its place.`,
    confirmLabel: 'Replace',
  };
}

// replaceSession takes over an SSH Terminal's remote session, and for an agent also moves the
// Terminal back to the Workspace repository, where agents always run. A Terminal Command
// takes the session over only when it runs there.
function restartArguments(
  terminalId: string,
  replacement: TerminalReplacement
): { presetId?: string; launchModeId?: string | null; options: RestartTerminalOptions } {
  switch (replacement.kind) {
    case 'agent':
      return {
        presetId: replacement.presetId,
        launchModeId: replacement.launchModeId,
        options: { replaceSession: true },
      };
    case 'saved-prompt':
      return {
        presetId: replacement.presetId,
        launchModeId: replacement.launchModeId,
        options: { command: replacement.command, commandKind: 'agent', replaceSession: true },
      };
    case 'terminal-command':
      return {
        options: {
          command: replacement.command,
          commandKind: replacement.commandKind,
          replaceSession: runsInSshWorkspaceRepository(terminalId),
        },
      };
    case 'local-copy-shell':
      return { options: { executionLocation: 'local-mirror' } };
    case 'ssh-shell':
      return {
        options: { plainShell: true, replaceSession: true, executionLocation: 'workspace' },
      };
    case 'remote-retry':
      return {
        options: { ...(replacement.plainShell ? { plainShell: true } : {}), replaceSession: true },
      };
  }
}
