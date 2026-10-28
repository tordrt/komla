/**
 * File system mocks for testing services that interact with the filesystem.
 *
 * Provides both simple mock functions and a virtual filesystem for more complex scenarios.
 *
 * Usage (simple):
 * ```ts
 * import { mockFs, createMockedFs } from '../../mocks/fs'
 *
 * vi.mock('fs', () => mockFs())
 * const mocked = createMockedFs()
 * mocked.existsSync.mockReturnValue(true)
 * ```
 *
 * Usage (virtual filesystem):
 * ```ts
 * import { createVirtualFs } from '../../mocks/fs'
 *
 * const vfs = createVirtualFs({
 *   '/home/.komla/config.json': JSON.stringify({ theme: 'dark' })
 * })
 * vi.mock('fs', () => vfs.mock)
 * ```
 */

import { vi } from 'vitest';

/**
 * Create basic fs mock functions.
 * Returns mocked functions that can be configured per-test.
 */
export function mockFs(): MockFsModule {
  return {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({
      isFile: () => true,
      isDirectory: () => false,
      size: 0,
      mtime: new Date(),
    })),
    readdirSync: vi.fn(() => []),
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    // Low-level file operations for atomic writes
    openSync: vi.fn(() => 42), // Return a mock file descriptor
    closeSync: vi.fn(),
    fsyncSync: vi.fn(),
    // Promises API (partial)
    promises: {
      readFile: vi.fn(() => Promise.resolve('')),
      writeFile: vi.fn(() => Promise.resolve()),
      readdir: vi.fn(() => Promise.resolve([])),
      mkdir: vi.fn(() => Promise.resolve()),
      rm: vi.fn(() => Promise.resolve()),
      stat: vi.fn(() =>
        Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(),
        })
      ),
      access: vi.fn(() => Promise.resolve()),
      rename: vi.fn(() => Promise.resolve()),
      copyFile: vi.fn(() => Promise.resolve()),
      unlink: vi.fn(() => Promise.resolve()),
      open: vi.fn(() =>
        Promise.resolve({
          writeFile: vi.fn(() => Promise.resolve()),
          sync: vi.fn(() => Promise.resolve()),
          close: vi.fn(() => Promise.resolve()),
        })
      ),
    },
  };
}

export interface MockFsModule {
  existsSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
  renameSync: ReturnType<typeof vi.fn>;
  copyFileSync: ReturnType<typeof vi.fn>;
  cpSync: ReturnType<typeof vi.fn>;
  unlinkSync: ReturnType<typeof vi.fn>;
  statSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
  accessSync: ReturnType<typeof vi.fn>;
  chmodSync: ReturnType<typeof vi.fn>;
  // Low-level file operations for atomic writes
  openSync: ReturnType<typeof vi.fn>;
  closeSync: ReturnType<typeof vi.fn>;
  fsyncSync: ReturnType<typeof vi.fn>;
  promises: {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    access: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  };
}

/**
 * Get typed access to mocked fs functions.
 * Call after vi.mock('fs', () => mockFs())
 */
export function createMockedFs(): MockedFsFunctions {
  // These are imported after mocking, so we need to get them dynamically

  const fs = require('fs');
  return {
    existsSync: vi.mocked(fs.existsSync),
    readFileSync: vi.mocked(fs.readFileSync),
    writeFileSync: vi.mocked(fs.writeFileSync),
    mkdirSync: vi.mocked(fs.mkdirSync),
    rmSync: vi.mocked(fs.rmSync),
    renameSync: vi.mocked(fs.renameSync),
    copyFileSync: vi.mocked(fs.copyFileSync),
    unlinkSync: vi.mocked(fs.unlinkSync),
    statSync: vi.mocked(fs.statSync),
    readdirSync: vi.mocked(fs.readdirSync),
  };
}

export interface MockedFsFunctions {
  existsSync: ReturnType<typeof vi.mocked<typeof import('fs').existsSync>>;
  readFileSync: ReturnType<typeof vi.mocked<typeof import('fs').readFileSync>>;
  writeFileSync: ReturnType<typeof vi.mocked<typeof import('fs').writeFileSync>>;
  mkdirSync: ReturnType<typeof vi.mocked<typeof import('fs').mkdirSync>>;
  rmSync: ReturnType<typeof vi.mocked<typeof import('fs').rmSync>>;
  renameSync: ReturnType<typeof vi.mocked<typeof import('fs').renameSync>>;
  copyFileSync: ReturnType<typeof vi.mocked<typeof import('fs').copyFileSync>>;
  unlinkSync: ReturnType<typeof vi.mocked<typeof import('fs').unlinkSync>>;
  statSync: ReturnType<typeof vi.mocked<typeof import('fs').statSync>>;
  readdirSync: ReturnType<typeof vi.mocked<typeof import('fs').readdirSync>>;
}

/**
 * Virtual filesystem for more realistic testing.
 * Simulates file existence, reading, and writing in memory.
 */
export function createVirtualFs(
  initialFiles: Record<string, string | Buffer> = {}
): VirtualFilesystem {
  const files = new Map<string, string | Buffer>();
  const directories = new Set<string>();
  const fdToPath = new Map<number, string>();
  let nextFd = 42;

  // Initialize with provided files
  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, content);
    // Add parent directories
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join('/'));
    }
  }

  const existsSync = vi.fn((path: string) => {
    return files.has(path) || directories.has(path);
  });

  const readFileSync = vi.fn((path: string, encoding?: BufferEncoding) => {
    const content = files.get(path);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }
    if (encoding === 'utf-8' || encoding === 'utf8') {
      return content.toString();
    }
    return content;
  });

  const writeFileSync = vi.fn((pathOrFd: string | number, data: string | Buffer) => {
    const path = typeof pathOrFd === 'number' ? fdToPath.get(pathOrFd) : pathOrFd;
    if (!path) {
      const error = new Error(`EBADF: bad file descriptor, write`);
      (error as NodeJS.ErrnoException).code = 'EBADF';
      throw error;
    }

    files.set(path, data);
    // Add parent directories
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join('/'));
    }
  });

  const mkdirSync = vi.fn((path: string) => {
    directories.add(path);
  });

  const rmSync = vi.fn((path: string) => {
    files.delete(path);
    directories.delete(path);
  });

  const unlinkSync = vi.fn((path: string) => {
    if (!files.has(path)) {
      const error = new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }
    files.delete(path);
  });

  const renameSync = vi.fn((oldPath: string, newPath: string) => {
    const content = files.get(oldPath);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }
    files.delete(oldPath);
    files.set(newPath, content);
  });

  const copyFileSync = vi.fn((src: string, dest: string) => {
    const content = files.get(src);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file or directory, copyfile '${src}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }
    files.set(dest, content);
  });

  const readdirSync = vi.fn((dirPath: string) => {
    const entries: string[] = [];
    const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';

    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix)) {
        const relativePath = filePath.slice(prefix.length);
        const firstSegment = relativePath.split('/')[0];
        if (firstSegment && !entries.includes(firstSegment)) {
          entries.push(firstSegment);
        }
      }
    }

    for (const dir of directories) {
      if (dir.startsWith(prefix)) {
        const relativePath = dir.slice(prefix.length);
        const firstSegment = relativePath.split('/')[0];
        if (firstSegment && !entries.includes(firstSegment)) {
          entries.push(firstSegment);
        }
      }
    }

    return entries;
  });

  const statSync = vi.fn((path: string) => {
    if (files.has(path)) {
      const content = files.get(path)!;
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: typeof content === 'string' ? content.length : content.length,
        mtime: new Date(),
      };
    }
    if (directories.has(path)) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
        mtime: new Date(),
      };
    }
    const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    throw error;
  });

  // Low-level file operations for atomic writes
  const openSync = vi.fn((path: string, flags?: string) => {
    if (flags?.includes('w')) {
      files.set(path, '');
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join('/'));
      }
    }
    const fd = nextFd++;
    fdToPath.set(fd, path);
    return fd;
  });
  const closeSync = vi.fn((fd: number) => {
    fdToPath.delete(fd);
  });
  const fsyncSync = vi.fn();

  const mock: MockFsModule = {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    renameSync,
    copyFileSync,
    cpSync: vi.fn(),
    unlinkSync,
    statSync,
    readdirSync,
    accessSync: vi.fn((path: string) => {
      if (!files.has(path) && !directories.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, access '${path}'`);
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
    }),
    chmodSync: vi.fn(),
    openSync,
    closeSync,
    fsyncSync,
    promises: {
      readFile: vi.fn((path: string, encoding?: BufferEncoding) =>
        Promise.resolve(readFileSync(path, encoding))
      ),
      writeFile: vi.fn((path: string, data: string | Buffer) => {
        writeFileSync(path, data);
        return Promise.resolve();
      }),
      readdir: vi.fn((path: string) => Promise.resolve(readdirSync(path))),
      mkdir: vi.fn((path: string) => {
        mkdirSync(path);
        return Promise.resolve();
      }),
      rm: vi.fn((path: string) => {
        rmSync(path);
        return Promise.resolve();
      }),
      stat: vi.fn((path: string) => Promise.resolve(statSync(path))),
      access: vi.fn((path: string) => {
        if (!files.has(path) && !directories.has(path)) {
          return Promise.reject(
            Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), {
              code: 'ENOENT',
            })
          );
        }
        return Promise.resolve();
      }),
      rename: vi.fn((oldPath: string, newPath: string) => {
        renameSync(oldPath, newPath);
        return Promise.resolve();
      }),
      copyFile: vi.fn((src: string, dest: string) => {
        copyFileSync(src, dest);
        return Promise.resolve();
      }),
      unlink: vi.fn((path: string) => {
        unlinkSync(path);
        return Promise.resolve();
      }),
      open: vi.fn((path: string, flags?: string) => {
        if (flags?.includes('w')) {
          files.set(path, '');
          const parts = path.split('/');
          for (let i = 1; i < parts.length; i++) {
            directories.add(parts.slice(0, i).join('/'));
          }
        }
        return Promise.resolve({
          writeFile: vi.fn((data: string | Buffer) => {
            files.set(path, data);
            return Promise.resolve();
          }),
          sync: vi.fn(() => Promise.resolve()),
          close: vi.fn(() => Promise.resolve()),
        });
      }),
    },
  };

  return {
    mock,
    // Utilities for test assertions
    getFile: (path: string) => files.get(path),
    hasFile: (path: string) => files.has(path),
    hasDirectory: (path: string) => directories.has(path),
    setFile: (path: string, content: string | Buffer) => files.set(path, content),
    deleteFile: (path: string) => files.delete(path),
    clear: () => {
      files.clear();
      directories.clear();
      fdToPath.clear();
      nextFd = 42;
    },
    getAllFiles: () => new Map(files),
    getAllDirectories: () => new Set(directories),
  };
}

export interface VirtualFilesystem {
  mock: MockFsModule;
  getFile: (path: string) => string | Buffer | undefined;
  hasFile: (path: string) => boolean;
  hasDirectory: (path: string) => boolean;
  setFile: (path: string, content: string | Buffer) => void;
  deleteFile: (path: string) => boolean;
  clear: () => void;
  getAllFiles: () => Map<string, string | Buffer>;
  getAllDirectories: () => Set<string>;
}
