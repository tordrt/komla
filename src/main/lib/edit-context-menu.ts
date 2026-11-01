import { Menu } from 'electron';

import type { BrowserWindow } from 'electron';

/**
 * Gives plain text fields the menu a browser would. Electron shows none of its own, and this event
 * only fires for right-clicks no renderer menu has claimed, as Monaco and the app's menus do.
 */
export function attachEditContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, { isEditable, editFlags }) => {
    if (!isEditable) return;
    Menu.buildFromTemplate([
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ]).popup({ window });
  });
}
