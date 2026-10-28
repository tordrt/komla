import { stat } from 'fs/promises';
import { resolve } from 'path';

import { app } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { isSamePath } from '../lib/same-path';

import { configService } from './config.service';
import { windowService } from './window.service';

const MAX_RECENT_FOLDERS = 10;
// A folder on a network drive that went away can take a minute to fail.
const CHECK_TIMEOUT_MS = 2_000;

const listeners = new Set<() => void>();
// The recent folders that were there when last checked. Folders that aren't stay in the list, as
// one on an unplugged drive comes back.
let available: string[] = [];
let checks = 0;

function isFolder(folder: string): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), CHECK_TIMEOUT_MS);
    void stat(folder)
      .then(
        (stats) => stats.isDirectory(),
        () => false
      )
      .then((isDirectory) => {
        clearTimeout(timer);
        done(isDirectory);
      });
  });
}

/** Folders opened with Open Folder, newest first, that were there when last checked. */
export function getRecentFolders(): string[] {
  return available;
}

/** Checks which recent folders are there, for Open Recent and the window without workspaces. */
export async function refreshRecentFolders(): Promise<string[]> {
  const check = ++checks;
  const folders = configService.get().recentFolders ?? [];
  const there = await Promise.all(folders.map(isFolder));
  const found = folders.filter((_, index) => there[index]);
  // A check that started later knows the newer list.
  if (check === checks && found.join('\0') !== available.join('\0')) {
    available = found;
    for (const listener of listeners) listener();
  }
  return found;
}

function saveRecentFolders(recentFolders: string[]): void {
  const config = configService.update({ recentFolders });
  windowService.broadcastToAll(IPC.CONFIG_CHANGED, config);
  void refreshRecentFolders();
}

/** Puts a folder first in Open Recent, and in the Dock's recent items on macOS. */
export function recordOpenedFolder(path: string): void {
  const folder = resolve(path);
  const others = (configService.get().recentFolders ?? []).filter(
    (recent) => !isSamePath(recent, folder)
  );
  saveRecentFolders([folder, ...others].slice(0, MAX_RECENT_FOLDERS));
  if (process.platform === 'darwin') app.addRecentDocument(folder);
}

export function clearRecentFolders(): void {
  saveRecentFolders([]);
  if (process.platform === 'darwin') app.clearRecentDocuments();
}

/** Calls `listener` whenever the list changes, as the File menu's Open Recent does. */
export function onRecentFoldersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
