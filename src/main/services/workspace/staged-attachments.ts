import { randomUUID } from 'crypto';
import { constants, mkdirSync } from 'fs';
import { copyFile, mkdir, readdir, rm, stat } from 'fs/promises';
import { basename, join } from 'path';

import { app } from 'electron';

// Long enough for a draft that keeps a staged file to still find it.
const STAGED_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Files this large are taken where they are, as copying them would take a while. The apps
// that drop a file and then delete it, like the iOS Simulator, drop screenshots.
export const MAX_STAGED_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Removes what was staged over a week ago in `dir`; it runs alongside staging. */
export async function sweepStagedAttachments(dir: string, now = new Date()): Promise<void> {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(
    entries.map(async (name) => {
      const entryPath = join(dir, name);
      try {
        if (now.getTime() - (await stat(entryPath)).mtimeMs > STAGED_ATTACHMENT_MAX_AGE_MS) {
          await rm(entryPath, { recursive: true, force: true });
        }
      } catch {
        // Gone already, or not ours to remove.
      }
    })
  );
}

/**
 * Where files for the new-workspace prompt wait until its workspace exists. It lives with the
 * app's data rather than in a temp folder other users can reach, as a dropped file can be
 * anything, like a key. Earlier versions staged pasted images in the temp folder, which is
 * swept too until it empties.
 */
function stagingDir(now: Date): string {
  const dir = join(app.getPath('userData'), 'staged-attachments');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lastSweepMs === undefined || now.getTime() - lastSweepMs >= SWEEP_INTERVAL_MS) {
    lastSweepMs = now.getTime();
    void sweepStagedAttachments(dir, now);
    void sweepStagedAttachments(join(app.getPath('temp'), 'komla-clipboard-images', 'staged'), now);
  }
  return dir;
}

// Staging sweeps at most this often, as files only expire after a week.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweepMs: number | undefined;

/** Makes a folder of its own for one staged file, so the file keeps its name. */
export function newStagedAttachmentDir(now = new Date()): string {
  const dir = join(stagingDir(now), randomUUID());
  mkdirSync(dir);
  return dir;
}

/**
 * Copies files dropped on the new-workspace prompt aside, and returns the copies' paths. Some
 * apps, like the iOS Simulator, drop a temporary file that they delete soon after, well before
 * the workspace is created. A file that can't be copied, or is too large to, keeps its own
 * path, so creating the workspace says what went wrong with it.
 */
export async function stagePromptAttachments(paths: string[], now = new Date()): Promise<string[]> {
  let root: string;
  try {
    root = stagingDir(now);
  } catch {
    return paths;
  }
  return Promise.all(
    paths.map(async (sourcePath) => {
      const stats = await stat(sourcePath).catch(() => null);
      if (!stats?.isFile() || stats.size > MAX_STAGED_ATTACHMENT_BYTES) return sourcePath;
      const dir = join(root, randomUUID());
      try {
        await mkdir(dir);
        const stagedPath = join(dir, basename(sourcePath));
        // A clone where the filesystem allows, which costs nothing.
        await copyFile(sourcePath, stagedPath, constants.COPYFILE_FICLONE);
        return stagedPath;
      } catch {
        await rm(dir, { recursive: true, force: true });
        return sourcePath;
      }
    })
  );
}
