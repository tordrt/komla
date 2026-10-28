import { app, BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { isUserAway } from '../../lib/user-presence';

import type { TerminalAttentionWindows } from './terminal-attention';
import type { WorkspaceAttentionEvent } from '../../../shared/types/workspace';

// Workspaces load before the app is ready; the badge then shows the last count once it is.
let countWhenReady: number | undefined;

const attentionListeners = new Set<(event: WorkspaceAttentionEvent) => void>();

/** Hears every attention a Terminal raises, as windows do; remote control pushes it to phones. */
export function onAttentionRaised(listener: (event: WorkspaceAttentionEvent) => void): () => void {
  attentionListeners.add(listener);
  return () => attentionListeners.delete(listener);
}

function showBadge(count: number): void {
  if (process.platform === 'darwin') {
    app.dock?.setBadge(count > 0 ? count.toString() : '');
  } else if (process.platform === 'win32') {
    const windows = BrowserWindow.getAllWindows();
    const target = windows.find((w) => w.isFocused()) ?? windows[0];
    if (target) {
      target.flashFrame(count > 0);
    }
  } else if (process.platform === 'linux') {
    app.setBadgeCount(count);
  }
}

/** Shows Terminal Attention State in Komla's windows and on the dock or taskbar. */
export const electronAttentionWindows: TerminalAttentionWindows = {
  attentionRaised(event) {
    const windows = BrowserWindow.getAllWindows();
    const delivered = { ...event, userAway: isUserAway() };
    for (const window of windows) {
      window.webContents.send(IPC.WORKSPACE_NEEDS_ATTENTION, delivered);
    }
    for (const listener of attentionListeners) listener(event);
  },

  badge(count) {
    if (app.isReady()) {
      countWhenReady = undefined;
      showBadge(count);
      return;
    }
    if (countWhenReady === undefined) {
      void app.whenReady().then(() => {
        if (countWhenReady === undefined) return;
        showBadge(countWhenReady);
        countWhenReady = undefined;
      });
    }
    countWhenReady = count;
  },
};
