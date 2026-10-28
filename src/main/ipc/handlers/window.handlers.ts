import { ipcMain, BrowserWindow, dialog } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { customizationService } from '../../services/customization.service';
import { localMirrorService } from '../../services/local-mirror.service';
import { ptyService } from '../../services/pty.service';
import { TITLE_BAR_OVERLAY_HEIGHT_PX, windowService } from '../../services/window.service';
import { workspaceService } from '../../services/workspace.service';
import { handleValidated, onValidated } from '../validation/ipc-validators';
import {
  focusWorkspaceWindowArgsSchema,
  moveWorkspaceToWindowArgsSchema,
  setPaneSurfaceWorkspacesArgsSchema,
  setShownWorkspaceArgsSchema,
  setTitleBarOverlayArgsSchema,
  setUnsavedFilesArgsSchema,
} from '../validation/window-ipc.schemas';

export function registerWindowHandlers(): void {
  ipcMain.handle(IPC.WINDOW_CREATE, async (): Promise<string> => {
    const { windowId } = windowService.createWindow();
    customizationService.syncTitleBarOverlay();
    return windowId;
  });

  ipcMain.handle(IPC.WINDOW_GET_ALL_IDS, async () => {
    return windowService.getAllWindows_info();
  });

  // Renderer signals that its event listeners are mounted and ready to receive messages
  ipcMain.on(IPC.WINDOW_RENDERER_READY, (event) => {
    const windowId = windowService.getWindowId(event.sender.id);
    if (windowId) {
      windowService.markRendererReady(windowId);
    }
    for (const status of localMirrorService.getSyncStatuses()) {
      event.sender.send(IPC.WORKSPACE_LOCAL_MIRROR_SYNC_STATUS, status);
    }
  });

  // The workspaces this window shows a browser or note pane of, which keeps them running
  ipcMain.on(
    IPC.WORKSPACE_SET_PANE_SURFACE_WORKSPACES,
    onValidated(
      IPC.WORKSPACE_SET_PANE_SURFACE_WORKSPACES,
      setPaneSurfaceWorkspacesArgsSchema,
      (event, [workspaceIds]) => {
        const windowId = windowService.getWindowId(event.sender.id);
        if (windowId) workspaceService.setPaneSurfaceWorkspaces(windowId, workspaceIds);
      }
    )
  );

  // The files this window has unsaved edits to, which closing it or quitting asks about first
  ipcMain.on(
    IPC.WINDOW_SET_UNSAVED_FILES,
    onValidated(IPC.WINDOW_SET_UNSAVED_FILES, setUnsavedFilesArgsSchema, (event, [names]) => {
      const windowId = windowService.getWindowId(event.sender.id);
      if (windowId) windowService.setUnsavedFiles(windowId, names);
    })
  );

  // The workspace this window shows, whose git status refreshes faster than the others'
  ipcMain.on(
    IPC.WINDOW_SET_SHOWN_WORKSPACE,
    onValidated(IPC.WINDOW_SET_SHOWN_WORKSPACE, setShownWorkspaceArgsSchema, (event, [id]) => {
      const windowId = windowService.getWindowId(event.sender.id);
      if (windowId) windowService.setShownWorkspace(windowId, id);
    })
  );

  // Move workspace to another window
  ipcMain.handle(
    IPC.WORKSPACE_MOVE_TO_WINDOW,
    handleValidated(
      IPC.WORKSPACE_MOVE_TO_WINDOW,
      moveWorkspaceToWindowArgsSchema,
      async (_, [workspaceId, windowId, layoutData]): Promise<void> => {
        moveWorkspaceToWindow(workspaceId, windowId, layoutData);
      }
    )
  );

  // Bring forward the window a workspace belongs to and select it there, on a terminal if given.
  // Resolves false when no open window shows it, so the caller can open or restore it itself.
  ipcMain.handle(
    IPC.WORKSPACE_FOCUS_WINDOW,
    handleValidated(
      IPC.WORKSPACE_FOCUS_WINDOW,
      focusWorkspaceWindowArgsSchema,
      async (_, [workspaceId, terminalId]): Promise<boolean> => {
        // The Trash keeps windowId, though no window shows the workspace then.
        const workspace = workspaceService.get(workspaceId);
        const windowId = workspace?.status === 'active' ? workspace.windowId : null;
        return !!windowId && windowService.showWorkspace(windowId, workspaceId, terminalId);
      }
    )
  );

  // Window control handlers (for Linux custom controls)
  ipcMain.handle(IPC.WINDOW_MINIMIZE, async (event): Promise<void> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.minimize();
  });

  ipcMain.handle(IPC.WINDOW_MAXIMIZE, async (event): Promise<void> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    }
  });

  ipcMain.handle(IPC.WINDOW_CLOSE, async (event): Promise<void> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.close();
  });

  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, async (event): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isMaximized() ?? false;
  });

  ipcMain.handle(IPC.WINDOW_IS_FULLSCREEN, async (event): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isFullScreen() ?? false;
  });

  ipcMain.handle(
    IPC.WINDOW_SET_TITLE_BAR_OVERLAY,
    handleValidated(
      IPC.WINDOW_SET_TITLE_BAR_OVERLAY,
      setTitleBarOverlayArgsSchema,
      async (event, [{ color, symbolColor }]): Promise<void> => {
        if (process.platform !== 'win32') return;
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) return;
        window.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT_PX });
      }
    )
  );

  ipcMain.handle(
    IPC.DIALOG_SHOW_MESSAGE_BOX,
    async (
      event,
      options: {
        type?: 'none' | 'info' | 'error' | 'question' | 'warning';
        title?: string;
        message: string;
        detail?: string;
        buttons?: string[];
        defaultId?: number;
        cancelId?: number;
      }
    ): Promise<number> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const messageBoxOptions: Electron.MessageBoxOptions = {
        type: options.type ?? 'info',
        title: options.title,
        message: options.message,
        detail: options.detail,
        buttons: options.buttons,
        defaultId: options.defaultId,
        cancelId: options.cancelId,
      };
      const result = window
        ? await dialog.showMessageBox(window, messageBoxOptions)
        : await dialog.showMessageBox(messageBoxOptions);
      return result.response;
    }
  );
}

/** Moves the workspace to the window, with the layout its old window had, if any. */
export function moveWorkspaceToWindow(
  workspaceId: string,
  windowId: string | null,
  layoutData?: unknown
): void {
  workspaceService.moveWorkspaceToWindow(workspaceId, windowId);

  // Update PTY window associations for the workspace's terminals
  const workspace = workspaceService.get(workspaceId);
  if (workspace && windowId) {
    const targetBrowserWindow = windowService.getWindow(windowId);
    if (targetBrowserWindow) {
      for (const terminal of workspace.terminals) {
        ptyService.setTerminalWindow(terminal.id, targetBrowserWindow.id);
      }
    }
  }

  // Broadcast to all windows
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.WORKSPACE_WINDOW_CHANGED, workspaceId, windowId);
  }

  // Tell the target window to apply layout and select this workspace.
  // sendWhenReady queues the message if the renderer hasn't signalled ready yet.
  if (windowId) {
    windowService.sendWhenReady(
      windowId,
      IPC.WORKSPACE_MOVED_HERE,
      workspaceId,
      layoutData ?? null
    );
  }
}
