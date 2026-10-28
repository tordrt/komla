import { readdir } from 'fs/promises';
import { join, relative, sep } from 'path';

/** Installed dependencies, caches and version control, which no one browses. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const SKIPPED_FILES = new Set(['.DS_Store']);

/** Enough for any folder worth browsing; past it, a home folder would take minutes. */
const DEFAULT_LIMIT = 20_000;
// Folders read at once, so a wide level doesn't take one round trip per folder.
const READS_AT_ONCE = 32;

async function readFolder(folder: string) {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The files under a folder without git, with forward slashes as `git ls-files` prints them.
 * Dotfiles count. The walk goes level by level, so at the limit the files near the top are in.
 */
export async function listFolderFiles(
  root: string,
  { limit = DEFAULT_LIMIT }: { limit?: number } = {}
): Promise<string[]> {
  const files: string[] = [];
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += READS_AT_ONCE) {
      const folders = level.slice(start, start + READS_AT_ONCE);
      const listings = await Promise.all(folders.map(readFolder));
      for (const [index, entries] of listings.entries()) {
        for (const entry of entries) {
          const path = join(folders[index], entry.name);
          if (entry.isDirectory()) {
            if (!SKIPPED_FOLDERS.has(entry.name)) next.push(path);
          } else if (!SKIPPED_FILES.has(entry.name)) {
            files.push(relative(root, path).split(sep).join('/'));
            if (files.length >= limit) return files;
          }
        }
      }
    }
    level = next;
  }
  return files;
}
