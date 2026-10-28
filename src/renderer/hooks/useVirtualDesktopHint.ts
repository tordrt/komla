import { useEffect } from 'react';

import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isLocalTerminalExecutionLocation, isSshWorkspace } from '@/types';

import type { Workspace } from '@/types';

const DISMISSED_STORAGE_KEY = 'komla:virtual-desktop-hint-dismissed';
// Kept across restarts: an SSH terminal reattaching to tmux redraws an error already hinted at.
const HINTED_STORAGE_KEY = 'komla:virtual-desktop-hint-workspaces';
// Old workspaces drop off the list rather than grow it forever.
const MAX_HINTED_WORKSPACES = 200;

// What GUI toolkits print when they find no X display, in order: Electron and Chromium; Xlib, GTK
// and glxinfo; Qt and Tk; Firefox and Tk; Java AWT; and winit (Tauri, Slint).
const DISPLAY_ERRORS = [
  /Missing X server or \$DISPLAY/,
  /(?:can(?:no|')t|unable to|failed to) open display/i,
  /(?:could not|couldn't) connect to display/i,
  /no \$?DISPLAY environment variable/,
  /No X11 DISPLAY variable was set/,
  /XOpenDisplayFailed/,
];
// Every error above names the display, so other output skips the full check.
const MAY_NAME_DISPLAY = /display/i;
// Long enough to hold an error split across output chunks.
const TAIL_LENGTH = 120;
// Agent TUIs may move the cursor right over a space rather than print it.
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD = /\x1b\[\d*C/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, 'dismissed');
  } catch {
    // Without storage the hint can't be remembered either way.
  }
}

function readHintedWorkspaceIds(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(HINTED_STORAGE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function storeHintedWorkspaceIds(workspaceIds: string[]): void {
  try {
    window.localStorage.setItem(
      HINTED_STORAGE_KEY,
      JSON.stringify(workspaceIds.slice(-MAX_HINTED_WORKSPACES))
    );
  } catch {
    // The in-memory list still keeps the hint to once per workspace until a restart.
  }
}

/** Each terminal that runs on an SSH host, where an app has no display of its own, by workspace. */
function sshHostTerminals(workspaces: Workspace[]): Map<string, string> {
  const workspaceIdByTerminalId = new Map<string, string>();
  for (const workspace of workspaces) {
    if (!isSshWorkspace(workspace)) continue;
    for (const terminal of workspace.terminals) {
      if (!isLocalTerminalExecutionLocation(terminal.executionLocation)) {
        workspaceIdByTerminalId.set(terminal.id, workspace.id);
      }
    }
  }
  return workspaceIdByTerminalId;
}

/**
 * Points at `komla desktop run` when a GUI app in an SSH workspace's terminal fails for want of a
 * display, once per workspace until "Don't show again". It doesn't depend on Project Setup or an
 * agent knowing the command. Should be called once in the app root.
 */
export function useVirtualDesktopHint(): void {
  useEffect(() => {
    const tails = new Map<string, string>();
    const hintedWorkspaceIds = readHintedWorkspaceIds();
    let workspaceIdByTerminalId = sshHostTerminals(useWorkspacesStore.getState().workspaces);

    const unsubscribeWorkspaces = useWorkspacesStore.subscribe((state, previous) => {
      if (state.workspaces === previous.workspaces) return;
      workspaceIdByTerminalId = sshHostTerminals(state.workspaces);
      for (const terminalId of tails.keys()) {
        if (!workspaceIdByTerminalId.has(terminalId)) tails.delete(terminalId);
      }
    });

    const unsubscribePtyData = window.api.onPtyData((terminalId, data) => {
      // Local output never gets the hint, so it skips all of the work below.
      const workspaceId = workspaceIdByTerminalId.get(terminalId);
      if (!workspaceId) return;

      const output = (tails.get(terminalId) ?? '') + data;
      tails.set(terminalId, output.slice(-TAIL_LENGTH));
      if (!MAY_NAME_DISPLAY.test(output)) return;

      const text = output.replace(CURSOR_FORWARD, ' ').replace(ESCAPE_SEQUENCE, '');
      if (!DISPLAY_ERRORS.some((pattern) => pattern.test(text))) return;
      // The same error is often printed more than once.
      tails.delete(terminalId);

      if (hintedWorkspaceIds.includes(workspaceId) || isDismissed()) return;
      hintedWorkspaceIds.push(workspaceId);
      storeHintedWorkspaceIds(hintedWorkspaceIds);
      // It stays until closed: one that times out in a background window is never seen.
      useToastStore
        .getState()
        .addToast(
          'This app found no display on the SSH host. Run it with “komla desktop run -- <command>” to see its windows in a VNC app or Komla’s browser.',
          'info',
          { action: { label: 'Don’t show again', onClick: dismiss }, dismissOnTimeout: false }
        );
    });

    return () => {
      unsubscribeWorkspaces();
      unsubscribePtyData();
    };
  }, []);
}
