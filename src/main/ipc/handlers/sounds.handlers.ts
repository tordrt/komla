import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, extname, join } from 'path';

import { ipcMain, shell } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { getKomlaBasePath } from '../../services/paths';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm']);
const MAX_SOUND_SIZE = 1024 * 1024; // 1 MB

const EXT_TO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

function getSoundsDir(): string {
  return join(getKomlaBasePath(), 'sounds');
}

function ensureSoundsDir(): string {
  const dir = getSoundsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function registerSoundsHandlers(): void {
  ipcMain.handle(IPC.SOUNDS_LIST_CUSTOM, (): string[] => {
    const dir = getSoundsDir();
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => {
        if (!AUDIO_EXTENSIONS.has(extname(f).toLowerCase())) return false;
        try {
          const s = statSync(join(dir, f));
          return s.isFile() && s.size <= MAX_SOUND_SIZE;
        } catch {
          return false;
        }
      })
      .sort();
  });

  ipcMain.handle(IPC.SOUNDS_GET_DATA_URL, (_, filename: string): string | null => {
    // Prevent path traversal
    const safe = basename(filename);
    const ext = extname(safe).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return null;

    const filePath = join(getSoundsDir(), safe);
    if (!existsSync(filePath)) return null;

    try {
      if (statSync(filePath).size > MAX_SOUND_SIZE) return null;
    } catch {
      return null;
    }

    try {
      const mime = EXT_TO_MIME[ext] ?? 'audio/mpeg';
      const data = readFileSync(filePath).toString('base64');
      return `data:${mime};base64,${data}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.SOUNDS_OPEN_DIRECTORY, async (): Promise<void> => {
    const dir = ensureSoundsDir();
    const err = await shell.openPath(dir);
    if (err) console.warn('Failed to open sounds directory:', err);
  });
}
