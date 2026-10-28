import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Helpers for config files owned by another tool (e.g. ~/.claude.json).
 * Reads used before a write must throw on unreadable content: falling back to
 * an empty config and writing it back would erase the user's settings.
 */

/** Returns '' when the file does not exist; throws on any other read error. */
export function readUserConfigFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Returns {} for a missing or blank file; throws, naming the file, for anything but a JSON object. */
export function readUserJsonObjectFile<T extends object>(path: string): T {
  const text = readUserConfigFile(path);
  if (text.trim() === '') return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} contains invalid JSON. Fix or remove it and try again.`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object. Fix or remove it and try again.`);
  }
  return parsed as T;
}

/**
 * Writes the file in place, so symlinks, hard links, ownership and permissions
 * are kept and a read-only file fails instead of being replaced.
 */
export function writeUserConfigFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
