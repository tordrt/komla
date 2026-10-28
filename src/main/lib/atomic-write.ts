import { randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { mkdir, rename, unlink, stat, readdir, open } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * On Windows, fsync can fail with EPERM when antivirus software (e.g. Windows Defender)
 * is scanning the file. Since the data has already been written, we can safely ignore
 * this error — fsync is a durability optimization, not a correctness requirement.
 */
function isWindowsFsyncError(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EPERM'
  );
}

/**
 * Atomically write a file using write-to-temp + rename pattern.
 * This prevents data corruption if the app crashes during a write.
 *
 * Pattern:
 * 1. Write to {path}.{random}.tmp
 * 2. fsync to flush to disk
 * 3. rename temp → target (atomic on POSIX/NTFS)
 * 4. On error, delete temp file
 */
export function writeFileAtomicSync(
  filePath: string,
  data: string,
  mode?: number,
  beforeCommit?: () => void
): void {
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    // Ensure parent directory exists in case it was deleted while app is running
    mkdirSync(dirname(filePath), { recursive: true });

    // Open temp file once and write through the same fd to avoid reopen races
    const fd = mode === undefined ? openSync(tempPath, 'w') : openSync(tempPath, 'w', mode);
    try {
      writeFileSync(fd, data, 'utf-8');
      fsyncSync(fd);
    } catch (fsyncError) {
      if (!isWindowsFsyncError(fsyncError)) {
        throw fsyncError;
      }
    } finally {
      closeSync(fd);
    }

    // Revalidate guarded replacements after the potentially slow write/fsync and
    // immediately before the atomic rename.
    beforeCommit?.();

    // Atomic rename
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Async version of atomic file write.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  mode?: number
): Promise<void> {
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    // Ensure parent directory exists in case it was deleted while app is running
    await mkdir(dirname(filePath), { recursive: true });

    // Open temp file once and write through the same handle to avoid reopen races
    const handle = mode === undefined ? await open(tempPath, 'w') : await open(tempPath, 'w', mode);
    try {
      await handle.writeFile(data, 'utf-8');
      await handle.sync();
    } catch (fsyncError) {
      if (!isWindowsFsyncError(fsyncError)) {
        throw fsyncError;
      }
    } finally {
      await handle.close();
    }

    // Atomic rename
    await rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors (file may not exist)
    }
    throw error;
  }
}

/**
 * Clean up orphaned .tmp files from a directory tree.
 * Call this on app startup to remove any temp files left from crashes.
 */
export function cleanupTmpFilesRecursive(directory: string): void {
  if (!existsSync(directory)) {
    return;
  }

  try {
    const entries = readdirSync(directory);

    for (const entry of entries) {
      const fullPath = join(directory, entry);

      try {
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
          // Recurse into subdirectories
          cleanupTmpFilesRecursive(fullPath);
        } else if (stats.isFile() && entry.endsWith('.tmp')) {
          // Delete orphaned .tmp files
          try {
            unlinkSync(fullPath);
          } catch {
            // Ignore deletion errors (file may be in use)
          }
        }
      } catch {
        // Ignore stat errors (file may have been deleted)
      }
    }
  } catch {
    // Ignore readdir errors
  }
}

/**
 * Async version of cleanup for .tmp files.
 */
export async function cleanupTmpFilesRecursiveAsync(directory: string): Promise<void> {
  try {
    await stat(directory);
  } catch {
    return; // Directory doesn't exist
  }

  try {
    const entries = await readdir(directory);

    for (const entry of entries) {
      const fullPath = join(directory, entry);

      try {
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          // Recurse into subdirectories
          await cleanupTmpFilesRecursiveAsync(fullPath);
        } else if (stats.isFile() && entry.endsWith('.tmp')) {
          // Delete orphaned .tmp files
          try {
            await unlink(fullPath);
          } catch {
            // Ignore deletion errors (file may be in use)
          }
        }
      } catch {
        // Ignore stat errors (file may have been deleted)
      }
    }
  } catch {
    // Ignore readdir errors
  }
}
