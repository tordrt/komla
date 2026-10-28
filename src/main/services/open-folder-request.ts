import { statSync } from 'fs';
import { resolve } from 'path';

import { app, BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { isSamePath } from '../lib/same-path';

import { windowService } from './window.service';

let openWindow: (() => string) | undefined;

/** How a folder handed over while Komla has no window gets one, as on macOS with all closed. */
export function setFolderWindowOpener(open: () => string): void {
  openWindow = open;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders on the command line that started Komla, as in `Komla ~/notes`, relative ones from
 * `workingDirectory`. `argv[0]` is the executable; run as `electron <app>` in development, the
 * app's own folder `appPath` is an argument too. Flags and files are left out.
 */
export function foldersInCommandLine(
  argv: readonly string[],
  workingDirectory: string,
  appPath: string
): string[] {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => resolve(workingDirectory, arg))
    .filter((path) => !isSamePath(path, appPath) && isFolder(path));
}

/**
 * Opens a folder handed to Komla from outside, such as with `komla open` or on the command line,
 * as Open Folder opens a picked one. It opens in `windowId`, else the focused window, else the
 * main one, else a new one; before Komla is ready, in the first window. False for a path that
 * isn't a folder.
 */
export function requestOpenFolder(path: string, windowId?: string | null): boolean {
  if (!isFolder(path)) return false;
  const open = (id: string | null | undefined) =>
    id && windowService.getWindow(id) ? id : undefined;
  const focused = BrowserWindow.getFocusedWindow();
  let target =
    open(windowId) ??
    open(focused ? windowService.getWindowId(focused.webContents.id) : undefined) ??
    windowService.getMainWindowId() ??
    undefined;
  if (!target && app.isReady() && openWindow) target = openWindow();
  windowService.sendToWindowOrNext(target, IPC.MENU_OPEN_FOLDER, path);
  const window = target ? windowService.getWindow(target) : undefined;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  return true;
}
