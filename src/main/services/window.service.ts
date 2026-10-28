import { randomUUID } from 'crypto';
import { join } from 'path';

import { is } from '@electron-toolkit/utils';
import { BrowserWindow, dialog, nativeTheme, shell } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { describeUnsavedFiles } from '../../shared/lib/unsaved-files';
import { MAIN_BUNDLE_DIR } from '../lib/module-path';
import { interceptPaneCloseShortcut } from '../lib/pane-close-shortcut';

import { configService } from './config.service';
import { errorReportingService } from './error-reporting.service';
import { ptyService } from './pty.service';
import { shortcutsService } from './shortcuts.service';

// Set by the release script so e2e runs don't pop windows up over the desktop.
// A window that is never shown paints about once a second, which stalls tests, so
// it is shown without focus, transparent and click-through instead, and covering
// it doesn't throttle it either. It also can't take focus, so keys typed after
// Cmd-Tab or a focus() call don't land in an invisible app. Linux keeps both off:
// it has no window opacity, transparency set at show there drops the window to
// the same slow paint rate, and an unfocusable window stays on top everywhere.
// Test runs only, so a shipped app can't be left without a visible window.
const HIDE_WINDOWS = process.env.NODE_ENV === 'test' && process.env.KOMLA_E2E_HIDE_WINDOWS === '1';
const HIDE_FROM_SCREEN = HIDE_WINDOWS && process.platform !== 'linux';

// Electron saves this window's size, position and maximized or full-screen
// state and restores them on the next launch. A name can belong to one live
// window at a time, so only one window has it; the others open at the default size.
// Not in test runs: e2e tests share one Electron profile, so a test would open
// in the window the previous one left.
const PERSISTED_WINDOW_NAME = 'main';
const PERSISTS_WINDOW_STATE = process.env.NODE_ENV !== 'test';

// The Windows caption buttons stop a pixel above the 40px title bar's bottom, so the top row's
// bottom border runs under them instead of breaking off where they start.
export const TITLE_BAR_OVERLAY_HEIGHT_PX = 39;

export interface WindowInfo {
  id: string;
  displayNumber: number;
}

class WindowService {
  private windows: Map<string, BrowserWindow> = new Map();
  private mainWindowId: string | null = null;
  private displayNumbers: Map<string, number> = new Map();
  private nextDisplayNumber = 1;
  private readyWindows: Set<string> = new Set();
  private pendingMessages: Map<string, Array<{ channel: string; args: unknown[] }>> = new Map();
  private messagesForNextWindow: Array<{ channel: string; args: unknown[] }> = [];
  private focusedTerminals: Map<number, string> = new Map();
  // The files each window has unsaved edits to, as its renderer last reported.
  private unsavedFiles: Map<string, string[]> = new Map();
  // The workspace each window shows, as its renderer last reported; null for none in particular.
  private shownWorkspaces: Map<string, string | null> = new Map();
  private quitConfirmed = false;
  private persistedWindowId: string | null = null;

  createWindow(): { window: BrowserWindow; windowId: string } {
    const windowId = randomUUID();
    const persistsState = PERSISTS_WINDOW_STATE && this.persistedWindowId === null;

    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      ...(persistsState && { name: PERSISTED_WINDOW_NAME, windowStatePersistence: true }),
      minWidth: 380,
      minHeight: 300,
      show: false,
      ...(HIDE_FROM_SCREEN && { focusable: false }),
      // Avoid Electron's default white background flashing through when the
      // renderer hasn't painted (cold start, reload, or shutdown teardown).
      // Matches the cold-start titleBarOverlay palette below.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#262a2f' : '#fafafa',
      autoHideMenuBar: true,
      ...(process.platform !== 'darwin' && {
        icon: is.dev
          ? join(MAIN_BUNDLE_DIR, '../../resources/icon.png')
          : join(process.resourcesPath, 'icon.png'),
      }),
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...(process.platform === 'darwin' && {
        trafficLightPosition: { x: 15, y: 12 },
      }),
      ...(process.platform === 'win32' && {
        titleBarOverlay: {
          height: TITLE_BAR_OVERLAY_HEIGHT_PX,
          // Cold-start fallback: match the default palette's --card / --card-foreground
          // from globals.css (OKLCH → hex). The renderer overrides these via
          // WINDOW_SET_TITLE_BAR_OVERLAY once applyPalette() runs.
          color: nativeTheme.shouldUseDarkColors ? '#262a2f' : '#fafafa',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#fafafa' : '#0a0a0a',
        },
      }),
      webPreferences: {
        preload: join(MAIN_BUNDLE_DIR, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        plugins: true,
        ...(HIDE_WINDOWS && { backgroundThrottling: false }),
      },
    });

    // Grant microphone (audio) access for voice transcription — deny camera/video.
    // Grant local-fonts so the terminal font picker can enumerate installed fonts.
    window.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        callback(types.includes('audio') && !types.includes('video'));
        return;
      }
      if (permission === 'local-fonts') {
        callback(true);
        return;
      }
      callback(false);
    });

    window.webContents.session.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      if (permission === 'media') {
        const type = (details as { mediaType?: string }).mediaType;
        return type === 'audio';
      }
      if (permission === 'local-fonts') {
        return true;
      }
      return false;
    });

    window.on('ready-to-show', () => {
      // Apply saved zoom level from config
      const zoomLevel = configService.get().zoomLevel ?? 0;
      window.webContents.setZoomLevel(zoomLevel);
      if (HIDE_WINDOWS) {
        window.showInactive();
        if (HIDE_FROM_SCREEN) window.setOpacity(0);
        window.setIgnoreMouseEvents(true);
      } else {
        window.show();
      }
    });

    window.webContents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url);
      return { action: 'deny' };
    });

    // Handle shortcuts Electron consumes before they can reach the renderer.
    window.webContents.on('before-input-event', (event, input) => {
      const paneCloseShortcut = shortcutsService.getShortcut('pane.close');
      if (interceptPaneCloseShortcut(event, input, paneCloseShortcut, window.webContents)) return;

      const focusedTerminalId = this.focusedTerminals.get(window.webContents.id);
      if (
        process.platform === 'darwin' &&
        focusedTerminalId &&
        input.type === 'keyDown' &&
        input.key.toLowerCase() === 'r' &&
        input.control &&
        !input.meta &&
        !input.alt &&
        !input.shift
      ) {
        event.preventDefault();
        ptyService.write(focusedTerminalId, '\x12');
      }
    });

    // Load the renderer with windowId as query parameter
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?windowId=${windowId}`);
    } else {
      void window.loadFile(join(MAIN_BUNDLE_DIR, '../renderer/index.html'), {
        query: { windowId },
      });
    }

    // Reset readiness when the renderer reloads or crashes so a fresh handshake is required.
    // Not on did-start-loading: iframes (status item popovers, browser previews) fire it too,
    // and leave the renderer as it was.
    window.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.readyWindows.delete(windowId);
      this.unsavedFiles.delete(windowId);
      this.shownWorkspaces.delete(windowId);
      this.focusedTerminals.delete(window.webContents.id);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.readyWindows.delete(windowId);
      this.focusedTerminals.delete(window.webContents.id);
      if (details.reason === 'clean-exit') return;
      const error = new Error(
        `Renderer process gone: ${details.reason} (exitCode ${details.exitCode})`
      );
      void errorReportingService.report(error, 'processGone', {
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });

    this.windows.set(windowId, window);
    if (persistsState) this.persistedWindowId = windowId;
    this.displayNumbers.set(windowId, this.nextDisplayNumber++);
    const webContentsId = window.webContents.id;

    // Set as main window if first window
    if (this.mainWindowId === null) {
      this.mainWindowId = windowId;
    }

    // Its workspaces move to another window or stop, without the unsaved edits.
    window.on('close', (event) => {
      const names = this.unsavedFiles.get(windowId);
      if (this.quitConfirmed || !names) return;
      if (!confirmDiscard(names, window)) event.preventDefault();
    });

    window.on('closed', () => {
      this.windows.delete(windowId);
      if (this.persistedWindowId === windowId) this.persistedWindowId = null;
      this.unsavedFiles.delete(windowId);
      this.shownWorkspaces.delete(windowId);
      this.displayNumbers.delete(windowId);
      this.readyWindows.delete(windowId);
      this.pendingMessages.delete(windowId);
      this.focusedTerminals.delete(webContentsId);
      // Reassign orphaned workspaces so they become visible in remaining windows
      this.onWindowClosed?.(windowId);
      // Broadcast updated window list to remaining windows
      this.broadcastWindowList();
    });

    // Broadcast maximize state changes to renderer (for Linux custom controls)
    window.on('maximize', () => {
      window.webContents.send(IPC.WINDOW_MAXIMIZED_CHANGE, true);
    });
    window.on('unmaximize', () => {
      window.webContents.send(IPC.WINDOW_MAXIMIZED_CHANGE, false);
    });
    window.on('enter-full-screen', () => {
      window.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGE, true);
    });
    window.on('leave-full-screen', () => {
      window.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGE, false);
    });

    // Broadcast updated window list to all windows
    this.broadcastWindowList();

    return { window, windowId };
  }

  setUnsavedFiles(windowId: string, names: string[]): void {
    if (names.length > 0) this.unsavedFiles.set(windowId, names);
    else this.unsavedFiles.delete(windowId);
  }

  setShownWorkspace(windowId: string, workspaceId: string | null): void {
    if (this.shownWorkspaces.get(windowId) === workspaceId) return;
    this.shownWorkspaces.set(windowId, workspaceId);
    this.onWorkspaceShown?.(workspaceId);
  }

  /**
   * Whether every window on screen shows some other single workspace. A window that hasn't
   * reported yet counts as showing them all.
   */
  isWorkspaceOffScreen(workspaceId: string): boolean {
    for (const [windowId, window] of this.windows) {
      if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) continue;
      const shown = this.shownWorkspaces.get(windowId);
      if (shown === undefined || shown === null || shown === workspaceId) return false;
    }
    return true;
  }

  /** Asks before quitting throws away unsaved edits. Returns whether to quit. */
  confirmQuit(): boolean {
    const names = [...this.unsavedFiles.values()].flat();
    if (names.length > 0 && !confirmDiscard(names)) return false;
    this.quitConfirmed = true;
    return true;
  }

  getWindowId(webContentsId: number): string | undefined {
    for (const [windowId, window] of this.windows.entries()) {
      if (window.webContents.id === webContentsId) {
        return windowId;
      }
    }
    return undefined;
  }

  getWindow(windowId: string): BrowserWindow | undefined {
    return this.windows.get(windowId);
  }

  /**
   * Brings the window forward and selects the workspace there, with the terminal's pane when
   * given. False when the window is gone.
   */
  showWorkspace(windowId: string, workspaceId: string, terminalId?: string): boolean {
    const window = this.windows.get(windowId);
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.sendWhenReady(windowId, IPC.WORKSPACE_SELECT, workspaceId, terminalId);
    return true;
  }

  setTerminalFocus(webContentsId: number, terminalId: string, focused: boolean): void {
    if (!this.getWindowId(webContentsId)) return;

    if (focused) {
      this.focusedTerminals.set(webContentsId, terminalId);
    } else if (this.focusedTerminals.get(webContentsId) === terminalId) {
      this.focusedTerminals.delete(webContentsId);
    }
  }

  // Callback set by main process to handle orphaned workspaces on window close
  onWindowClosed: ((windowId: string) => void) | null = null;
  // Callback set by main process when a window starts showing a workspace, or all of them (null)
  onWorkspaceShown: ((workspaceId: string | null) => void) | null = null;

  getAllWindowIds(): string[] {
    return Array.from(this.windows.keys());
  }

  getMainWindowId(): string | null {
    // If main window was closed, elect first available
    if (this.mainWindowId && !this.windows.has(this.mainWindowId)) {
      this.mainWindowId = this.windows.keys().next().value ?? null;
    }
    return this.mainWindowId;
  }

  getAllWindows_info(): WindowInfo[] {
    const result: WindowInfo[] = [];
    for (const id of this.windows.keys()) {
      result.push({ id, displayNumber: this.displayNumbers.get(id) ?? 0 });
    }
    return result;
  }

  getAllWindows(): BrowserWindow[] {
    return Array.from(this.windows.values());
  }

  updateTitleBarOverlay(isDark: boolean): void {
    if (process.platform !== 'win32') return;
    // Default-palette --card / --card-foreground from globals.css (OKLCH → hex).
    // The renderer is the source of truth post-startup via
    // WINDOW_SET_TITLE_BAR_OVERLAY; this path is the cold-start / theme.json
    // fallback.
    const color = isDark ? '#262a2f' : '#fafafa';
    const symbolColor = isDark ? '#fafafa' : '#0a0a0a';
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT_PX });
      }
    }
  }

  broadcastWindowList(): void {
    // Queue for renderers that haven't signaled ready yet so a freshly created
    // window receives the list before any messages that depend on it (e.g.
    // WORKSPACE_MOVED_HERE) trigger UI that reads availableWindows.
    this.broadcastWhenReady(IPC.WINDOW_LIST_UPDATED, this.getAllWindows_info());
  }

  broadcastToAll(channel: string, ...args: unknown[]): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, ...args);
      }
    }
  }

  /**
   * Mark a window's renderer as ready (event listeners mounted).
   * Flushes any messages that were queued before the renderer was ready.
   */
  markRendererReady(windowId: string): void {
    this.readyWindows.add(windowId);
    const forAnyWindow = this.messagesForNextWindow.splice(0);
    if (forAnyWindow.length > 0) {
      this.pendingMessages.set(windowId, [
        ...(this.pendingMessages.get(windowId) ?? []),
        ...forAnyWindow,
      ]);
    }
    const pending = this.pendingMessages.get(windowId);
    if (pending) {
      const window = this.windows.get(windowId);
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        for (const { channel, args } of pending) {
          window.webContents.send(channel, ...args);
        }
      }
      this.pendingMessages.delete(windowId);
    }
  }

  /**
   * Send a message to a window, queuing it if the renderer isn't ready yet.
   */
  sendWhenReady(windowId: string, channel: string, ...args: unknown[]): void {
    const window = this.windows.get(windowId);
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;

    if (this.readyWindows.has(windowId)) {
      window.webContents.send(channel, ...args);
    } else {
      let queue = this.pendingMessages.get(windowId);
      if (!queue) {
        queue = [];
        this.pendingMessages.set(windowId, queue);
      }
      queue.push({ channel, args });
    }
  }

  /**
   * Send a message to the window, or else the main window, or else the next window whose renderer
   * gets ready, as when every window is closed on macOS.
   */
  sendToWindowOrNext(
    windowId: string | null | undefined,
    channel: string,
    ...args: unknown[]
  ): void {
    const target = windowId && this.windows.has(windowId) ? windowId : this.getMainWindowId();
    if (target) this.sendWhenReady(target, channel, ...args);
    else this.messagesForNextWindow.push({ channel, args });
  }

  /**
   * Broadcast a message to all windows, queuing for any that aren't ready yet.
   */
  broadcastWhenReady(channel: string, ...args: unknown[]): void {
    for (const windowId of this.windows.keys()) {
      this.sendWhenReady(windowId, channel, ...args);
    }
  }

  setZoomLevelAll(level: number): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.webContents.setZoomLevel(level);
      }
    }
  }
}

function confirmDiscard(names: string[], window?: BrowserWindow): boolean {
  const options: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    title: 'Unsaved Changes',
    message: describeUnsavedFiles(names),
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  };
  const choice = window
    ? dialog.showMessageBoxSync(window, options)
    : dialog.showMessageBoxSync(options);
  return choice === 0;
}

export const windowService = new WindowService();
