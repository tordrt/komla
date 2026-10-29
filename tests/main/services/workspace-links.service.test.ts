import { execFile } from 'node:child_process';
import {
  existsSync as realExistsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as realReadFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';
import { toVirtualPath } from '../../mocks/fs';

vi.mock('electron', () => mockElectron());

// In-memory fs that supports regular files, directories, and symlinks. The
// real workspace-links service uses fs/promises for all I/O plus existsSync
// from 'fs' — both must read the same store, so we mock both modules.
interface MemFs {
  files: Map<string, string>;
  dirs: Set<string>;
  links: Map<string, string>; // linkPath -> target
}

const fsState: MemFs = {
  files: new Map(),
  dirs: new Set(),
  links: new Map(),
};
const execFileAsync = promisify(execFile);

function ensureParentDirs(p: string): void {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) {
    fsState.dirs.add(parts.slice(0, i).join('/'));
  }
}

function entryExists(p: string): boolean {
  return fsState.files.has(p) || fsState.dirs.has(p) || fsState.links.has(p);
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      const target = fsState.links.get(p);
      if (target) return entryExists(target);
      return entryExists(p);
    },
    // The git exclude helper reads and writes synchronously. Tests on a real temp dir keep the
    // real calls; the rest use the in-memory store.
    readFileSync: (rawPath: string, ...rest: unknown[]) => {
      if (rawPath.startsWith(tmpdir())) return (actual.readFileSync as Function)(rawPath, ...rest);
      const p = toVirtualPath(rawPath);
      if (fsState.files.has(p)) return fsState.files.get(p)!;
      const err = new Error(`${fsState.dirs.has(p) ? 'EISDIR' : 'ENOENT'}: ${p}`);
      (err as NodeJS.ErrnoException).code = fsState.dirs.has(p) ? 'EISDIR' : 'ENOENT';
      throw err;
    },
    writeFileSync: (rawPath: string, ...rest: unknown[]) => {
      if (rawPath.startsWith(tmpdir())) return (actual.writeFileSync as Function)(rawPath, ...rest);
      const p = toVirtualPath(rawPath);
      fsState.files.set(p, rest[0] as string);
      ensureParentDirs(p);
    },
    mkdirSync: (rawPath: string, ...rest: unknown[]) => {
      if (rawPath.startsWith(tmpdir())) return (actual.mkdirSync as Function)(rawPath, ...rest);
      const p = toVirtualPath(rawPath);
      fsState.dirs.add(p);
      ensureParentDirs(p);
    },
  };
});

vi.mock('fs/promises', () => {
  return {
    mkdir: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      fsState.dirs.add(p);
      ensureParentDirs(p);
    }),
    readFile: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      if (fsState.files.has(p)) return fsState.files.get(p)!;
      const err = new Error(`ENOENT: ${p}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }),
    lstat: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      const isDir = fsState.dirs.has(p);
      const isFile = fsState.files.has(p);
      const isLink = fsState.links.has(p);
      if (!isDir && !isFile && !isLink) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return {
        isDirectory: () => isDir,
        isFile: () => isFile,
        isSymbolicLink: () => isLink,
      };
    }),
    stat: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      const isDir = fsState.dirs.has(p);
      const isFile = fsState.files.has(p);
      const isLink = fsState.links.has(p);
      if (!isDir && !isFile && !isLink) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return {
        isDirectory: () => isDir,
        isFile: () => isFile,
        isSymbolicLink: () => isLink,
      };
    }),
    readdir: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      if (fsState.files.has(p)) {
        const err = new Error(`ENOTDIR: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOTDIR';
        throw err;
      }
      if (!fsState.dirs.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      const prefix = p.endsWith('/') ? p : p + '/';
      const seen = new Set<string>();
      for (const k of [...fsState.files.keys(), ...fsState.links.keys(), ...fsState.dirs]) {
        if (!k.startsWith(prefix)) continue;
        const rel = k.slice(prefix.length).split('/')[0];
        if (rel) seen.add(rel);
      }
      return Array.from(seen);
    }),
    readlink: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      if (fsState.links.has(p)) return fsState.links.get(p)!;
      const err = new Error(`EINVAL: ${p}`);
      (err as NodeJS.ErrnoException).code = 'EINVAL';
      throw err;
    }),
    rm: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      // Recursive delete: drop the path and anything under it.
      const prefix = p.endsWith('/') ? p : p + '/';
      fsState.files.delete(p);
      fsState.dirs.delete(p);
      fsState.links.delete(p);
      for (const k of [...fsState.files.keys()]) {
        if (k.startsWith(prefix)) fsState.files.delete(k);
      }
      for (const k of [...fsState.dirs]) {
        if (k.startsWith(prefix)) fsState.dirs.delete(k);
      }
      for (const k of [...fsState.links.keys()]) {
        if (k.startsWith(prefix)) fsState.links.delete(k);
      }
    }),
    rmdir: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      // Non-recursive: fail if directory has any children.
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const k of [...fsState.files.keys(), ...fsState.links.keys(), ...fsState.dirs]) {
        if (k === p) continue;
        if (k.startsWith(prefix)) {
          const err = new Error(`ENOTEMPTY: ${p}`);
          (err as NodeJS.ErrnoException).code = 'ENOTEMPTY';
          throw err;
        }
      }
      if (!fsState.dirs.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      fsState.dirs.delete(p);
    }),
    symlink: vi.fn(async (target: string, rawLinkPath: string) => {
      const linkPath = toVirtualPath(rawLinkPath);
      fsState.links.set(linkPath, target);
      ensureParentDirs(linkPath);
    }),
    unlink: vi.fn(async (rawPath: string) => {
      const p = toVirtualPath(rawPath);
      if (fsState.links.has(p)) {
        fsState.links.delete(p);
        return;
      }
      if (fsState.files.has(p)) {
        fsState.files.delete(p);
        return;
      }
      const err = new Error(`ENOENT: ${p}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async (rawPath: string, data: string) => {
      const p = toVirtualPath(rawPath);
      fsState.files.set(p, data);
      ensureParentDirs(p);
    }),
  };
});

// Stub workspace.service to avoid pulling in the entire main process. Tests
// drive the in-memory `workspaces` map and assert the links service reads it
// via get() and writes back via update().
type StubWorkspace = {
  id: string;
  name: string;
  customName?: string;
  workingDirectory: string;
  projectId?: string;
  repoName?: string;
  branchName?: string;
  linkedWorkspaceIds?: string[];
  backend?:
    | { kind: 'local' }
    | {
        kind: 'ssh';
        hostId: string;
        remoteDirectory: string;
        remoteRepoPath: string;
        remoteProjectRoot: string;
        gitUrl: string;
      };
};

const workspacesMap = new Map<string, StubWorkspace>();
const projectsMap = new Map<string, { id: string; name: string }>();
const deletingWorkspaceIds = new Set<string>();
let replaceWorkspaceOnUpdate = false;
const mockSshRun = vi.hoisted(() => vi.fn(async () => ''));
const mockSaveWorkspacesImmediate = vi.hoisted(() => vi.fn(async () => {}));
let mockPersistenceTransaction: Promise<void> = Promise.resolve();

async function withMockPersistenceTransaction<T>(
  transaction: (save: () => Promise<void>) => Promise<T>
): Promise<T> {
  const predecessor = mockPersistenceTransaction;
  let release!: () => void;
  mockPersistenceTransaction = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await transaction(mockSaveWorkspacesImmediate);
  } finally {
    release();
  }
}

vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    getHost: (hostId: string) => ({ id: hostId, name: hostId }),
    run: mockSshRun,
  },
}));

vi.mock('../../../src/main/services/project.service', () => {
  return {
    projectService: {
      get: (id: string) => projectsMap.get(id),
    },
  };
});

vi.mock('../../../src/main/services/workspace.service', () => {
  return {
    workspaceService: {
      get: (id: string) => workspacesMap.get(id),
      isDeleting: (id: string) => deletingWorkspaceIds.has(id),
      list: () => Array.from(workspacesMap.values()),
      update: (id: string, updates: Partial<StubWorkspace>) => {
        const ws = workspacesMap.get(id);
        if (!ws) throw new Error(`Workspace ${id} not found`);
        if (replaceWorkspaceOnUpdate) {
          const next = { ...ws, ...updates };
          workspacesMap.set(id, next);
          return next;
        }
        Object.assign(ws, updates);
        return ws;
      },
      saveWorkspacesImmediate: mockSaveWorkspacesImmediate,
      saveWorkspacesImmediateChecked: mockSaveWorkspacesImmediate,
      withPersistenceTransaction: withMockPersistenceTransaction,
    },
  };
});

function makeWorkspace(
  id: string,
  name: string,
  dir: string,
  meta: {
    projectId?: string;
    repoName?: string;
    branchName?: string;
    linkedWorkspaceIds?: string[];
  } = {}
): StubWorkspace {
  const ws: StubWorkspace = { id, name, workingDirectory: dir, ...meta };
  workspacesMap.set(id, ws);
  fsState.dirs.add(dir);
  return ws;
}

function makeSshWorkspace(
  id: string,
  name: string,
  hostId: string,
  remoteDirectory: string,
  meta: {
    projectId?: string;
    repoName?: string;
    branchName?: string;
    linkedWorkspaceIds?: string[];
  } = {}
): StubWorkspace {
  const workspace: StubWorkspace = {
    id,
    name,
    workingDirectory: `ssh://${hostId}${remoteDirectory}`,
    ...meta,
    backend: {
      kind: 'ssh',
      hostId,
      remoteDirectory,
      remoteRepoPath: `/komla/repos/${id}.git`,
      remoteProjectRoot: '/komla/worktrees/project',
      gitUrl: `git@example.com:${id}.git`,
    },
  };
  workspacesMap.set(id, workspace);
  return workspace;
}

describe('WorkspaceLinksService', () => {
  let service: typeof import('../../../src/main/services/workspace-links.service');
  const linkedWorkspacesExclude = '/linked-workspaces/*';

  beforeEach(async () => {
    fsState.files.clear();
    fsState.dirs.clear();
    fsState.links.clear();
    workspacesMap.clear();
    projectsMap.clear();
    deletingWorkspaceIds.clear();
    replaceWorkspaceOnUpdate = false;
    mockPersistenceTransaction = Promise.resolve();
    mockSshRun.mockReset();
    mockSshRun.mockResolvedValue('KOMLA_LINK_CREATED 1 1\n');
    mockSaveWorkspacesImmediate.mockClear();
    vi.resetModules();
    service = await import('../../../src/main/services/workspace-links.service');
  });

  it('creates bidirectional link with folder and symlinks', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { repoName: 'komla', branchName: 'feat-a' });
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'komla', branchName: 'feat-b' });

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.links.get('/work/a/linked-workspaces/komla-feat-b')).toBe('/work/b');
    expect(fsState.links.get('/work/b/linked-workspaces/komla-feat-a')).toBe('/work/a');

    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('creates bidirectional links remotely for SSH workspaces on the same host', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      repoName: 'komla',
      branchName: 'feat-a',
    });
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      repoName: 'komla',
      branchName: 'feat-b',
    });

    await service.workspaceLinksService.link('a', ['b']);

    expect(mockSshRun).toHaveBeenCalledOnce();
    const command = mockSshRun.mock.calls[0][1];
    expect(command).toContain("owner_a='/work/a'");
    expect(command).toContain("owner_b='/work/b'");
    expect(command).toContain("name_ab='komla-feat-b'");
    expect(command).toContain("name_ba='komla-feat-a'");
    expect(command).toContain('ln -s');
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('waits for SSH link metadata to be saved immediately', async () => {
    let finishSave: (() => void) | undefined;
    mockSaveWorkspacesImmediate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');

    let linkResolved = false;
    const linkPromise = service.workspaceLinksService.link('a', ['b']).then(() => {
      linkResolved = true;
    });
    await vi.waitFor(() => expect(mockSaveWorkspacesImmediate).toHaveBeenCalledOnce());

    expect(linkResolved).toBe(false);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
    finishSave?.();
    await linkPromise;
  });

  it('rolls back an SSH link when its metadata cannot be saved', async () => {
    const saveError = new Error('disk full');
    mockSaveWorkspacesImmediate.mockRejectedValueOnce(saveError);
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');

    await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toBe(saveError);

    expect(mockSshRun).toHaveBeenCalledTimes(2);
    expect(mockSshRun.mock.calls[0][1]).toContain('ensure_link');
    expect(mockSshRun.mock.calls[1][1]).toContain('unlink_matching');
    expect(workspacesMap.get('a')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds ?? []).toEqual([]);
  });

  it('preserves pre-existing remote links when redundant link metadata cannot be saved', async () => {
    const saveError = new Error('disk full');
    mockSshRun.mockResolvedValueOnce('KOMLA_LINK_CREATED 0 0\n');
    mockSaveWorkspacesImmediate.mockRejectedValueOnce(saveError);
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      linkedWorkspaceIds: ['b'],
    });
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });

    await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toBe(saveError);

    expect(mockSshRun).toHaveBeenCalledOnce();
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('rolls back a remote link when a peer is deleted during creation', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');
    mockSshRun.mockImplementationOnce(async () => {
      workspacesMap.delete('b');
      return 'KOMLA_LINK_CREATED 1 1\n';
    });

    await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toThrow(
      'Workspace b not found'
    );

    expect(mockSshRun).toHaveBeenCalledTimes(2);
    expect(mockSshRun.mock.calls[1][1]).toContain('unlink_matching');
    expect(workspacesMap.get('a')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(mockSaveWorkspacesImmediate).not.toHaveBeenCalled();
  });

  it('rolls back a remote link when deletion starts during creation', async () => {
    let finishRemoteLink: ((output: string) => void) | undefined;
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');
    mockSshRun.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishRemoteLink = resolve;
        })
    );

    const linkPromise = service.workspaceLinksService.link('a', ['b']);
    await vi.waitFor(() => expect(finishRemoteLink).toBeTypeOf('function'));
    deletingWorkspaceIds.add('a');
    finishRemoteLink?.('KOMLA_LINK_CREATED 1 1\n');

    await expect(linkPromise).rejects.toThrow('Workspace a is being deleted');
    expect(mockSshRun).toHaveBeenCalledTimes(2);
    expect(mockSshRun.mock.calls[1][1]).toContain('unlink_matching');
    expect(workspacesMap.get('a')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(mockSaveWorkspacesImmediate).not.toHaveBeenCalled();
  });

  it('preserves a concurrent SSH link when another link rolls back', async () => {
    const saveError = new Error('disk full');
    let rejectFirstSave: ((error: Error) => void) | undefined;
    mockSaveWorkspacesImmediate.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstSave = reject;
        })
    );
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');
    makeSshWorkspace('c', 'workspace-c', 'host-1', '/work/c');

    const failedLink = service.workspaceLinksService.link('a', ['b']);
    await vi.waitFor(() => expect(mockSaveWorkspacesImmediate).toHaveBeenCalledOnce());
    const successfulLink = service.workspaceLinksService.link('a', ['c']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectFirstSave?.(saveError);

    await expect(failedLink).rejects.toBe(saveError);
    await successfulLink;

    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['c']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(workspacesMap.get('c')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('does not persist a failed SSH link through a concurrent disjoint save', async () => {
    const saveError = new Error('disk full');
    let rejectFirstSave: ((error: Error) => void) | undefined;
    const savedSnapshots: Record<string, string[]>[] = [];
    const snapshotLinks = () =>
      Object.fromEntries(
        [...workspacesMap].map(([id, workspace]) => [id, [...(workspace.linkedWorkspaceIds ?? [])]])
      );
    mockSaveWorkspacesImmediate
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            savedSnapshots.push(snapshotLinks());
            rejectFirstSave = reject;
          })
      )
      .mockImplementationOnce(async () => {
        savedSnapshots.push(snapshotLinks());
      });
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');
    makeSshWorkspace('c', 'workspace-c', 'host-1', '/work/c');
    makeSshWorkspace('d', 'workspace-d', 'host-1', '/work/d');

    const failedLink = service.workspaceLinksService.link('a', ['b']);
    const failedLinkResult = expect(failedLink).rejects.toBe(saveError);
    await vi.waitFor(() => expect(mockSaveWorkspacesImmediate).toHaveBeenCalledOnce());
    const successfulLink = service.workspaceLinksService.link('c', ['d']);
    await vi.waitFor(() => expect(mockSshRun).toHaveBeenCalledTimes(2));
    rejectFirstSave?.(saveError);

    await failedLinkResult;
    await successfulLink;

    expect(savedSnapshots).toHaveLength(2);
    expect(savedSnapshots[1]).toEqual({ a: [], b: [], c: ['d'], d: ['c'] });
  });

  it.runIf(process.platform !== 'win32')(
    'executes the remote link and unlink transactions with POSIX shell',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-links-'));
      const pathA = joinPath(tempPath, 'workspace a');
      const pathB = joinPath(tempPath, 'workspace b');
      mkdirSync(pathA);
      mkdirSync(pathB);
      await execFileAsync('git', ['init', '-q', pathA]);
      await execFileAsync('git', ['init', '-q', pathB]);
      mockSshRun.mockImplementation(async (_host, command) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
        return stdout;
      });
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA, {
        repoName: 'komla',
        branchName: 'feat-a',
      });
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB, {
        repoName: 'komla',
        branchName: 'feat-b',
      });

      try {
        await service.workspaceLinksService.link('a', ['b']);

        const linkAB = joinPath(pathA, 'linked-workspaces', 'komla-feat-b');
        const linkBA = joinPath(pathB, 'linked-workspaces', 'komla-feat-a');
        expect(readlinkSync(linkAB)).toBe(pathB);
        expect(readlinkSync(linkBA)).toBe(pathA);
        expect(realReadFileSync(joinPath(pathA, '.git', 'info', 'exclude'), 'utf8')).toContain(
          linkedWorkspacesExclude
        );

        await service.workspaceLinksService.unlink('a', 'b');

        expect(realExistsSync(linkAB)).toBe(false);
        expect(realExistsSync(linkBA)).toBe(false);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'propagates remote symlink removal failures without clearing link metadata',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-links-remove-failure-'));
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      mkdirSync(pathA);
      mkdirSync(pathB);
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA, {
        repoName: 'komla',
        branchName: 'feat-a',
        linkedWorkspaceIds: ['b'],
      });
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB, {
        repoName: 'komla',
        branchName: 'feat-b',
        linkedWorkspaceIds: ['a'],
      });
      const linkAB = joinPath(pathA, 'linked-workspaces', 'komla-feat-b');
      const linkBA = joinPath(pathB, 'linked-workspaces', 'komla-feat-a');
      mkdirSync(joinPath(pathA, 'linked-workspaces'));
      mkdirSync(joinPath(pathB, 'linked-workspaces'));
      symlinkSync(pathB, linkAB);
      symlinkSync(pathA, linkBA);
      mockSshRun.mockImplementationOnce(async (_host, command) => {
        await execFileAsync('/bin/sh', ['-c', `rm() { return 17; }\n${command}`]);
        return '';
      });

      try {
        await expect(service.workspaceLinksService.unlink('a', 'b')).rejects.toThrow();

        expect(readlinkSync(linkAB)).toBe(pathB);
        expect(readlinkSync(linkBA)).toBe(pathA);
        expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'preserves an existing remote exclude rule without a final newline',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-links-exclude-'));
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      mkdirSync(pathA);
      mkdirSync(pathB);
      await execFileAsync('git', ['init', '-q', pathA]);
      await execFileAsync('git', ['init', '-q', pathB]);
      const excludePath = joinPath(pathA, '.git', 'info', 'exclude');
      writeFileSync(excludePath, 'existing-rule', 'utf8');
      mockSshRun.mockImplementation(async (_host, command) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
        return stdout;
      });
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA);
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB);

      try {
        await service.workspaceLinksService.link('a', ['b']);

        expect(realReadFileSync(excludePath, 'utf8')).toMatch(/^existing-rule\n# Added by Komla:/);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects remote link creation through a symlinked link directory',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-links-directory-symlink-'));
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      const externalPath = joinPath(tempPath, 'external');
      mkdirSync(pathA);
      mkdirSync(pathB);
      mkdirSync(externalPath);
      symlinkSync(externalPath, joinPath(pathA, 'linked-workspaces'), 'dir');
      mockSshRun.mockImplementation(async (_host, command) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
        return stdout;
      });
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA);
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB);

      try {
        await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toThrow();

        expect(realExistsSync(joinPath(externalPath, 'workspace-b'))).toBe(false);
        expect(workspacesMap.get('a')?.linkedWorkspaceIds ?? []).toEqual([]);
        expect(workspacesMap.get('b')?.linkedWorkspaceIds ?? []).toEqual([]);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects remote unlink through a symlinked link directory',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-unlink-directory-symlink-'));
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      const externalPath = joinPath(tempPath, 'external');
      const externalLink = joinPath(externalPath, 'workspace-b');
      mkdirSync(pathA);
      mkdirSync(pathB);
      mkdirSync(externalPath);
      symlinkSync(pathB, externalLink);
      symlinkSync(externalPath, joinPath(pathA, 'linked-workspaces'), 'dir');
      mockSshRun.mockImplementation(async (_host, command) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
        return stdout;
      });
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA, {
        linkedWorkspaceIds: ['b'],
      });
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB, {
        linkedWorkspaceIds: ['a'],
      });

      try {
        await expect(service.workspaceLinksService.unlink('a', 'b')).rejects.toThrow();

        expect(readlinkSync(externalLink)).toBe(pathB);
        expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects stale remote cleanup through a symlinked link directory',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-cleanup-directory-symlink-'));
      const workspacePath = joinPath(tempPath, 'workspace');
      const externalPath = joinPath(tempPath, 'external');
      const externalLink = joinPath(externalPath, 'dangling');
      mkdirSync(workspacePath);
      mkdirSync(externalPath);
      symlinkSync('/missing-peer', externalLink);
      symlinkSync(externalPath, joinPath(workspacePath, 'linked-workspaces'), 'dir');
      mockSshRun.mockImplementation(async (_host, command) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
        return stdout;
      });
      makeSshWorkspace('b', 'workspace-b', 'host-1', workspacePath, {
        linkedWorkspaceIds: ['missing'],
      });

      try {
        await expect(service.workspaceLinksService.unlink('missing', 'b')).rejects.toThrow();

        expect(readlinkSync(externalLink)).toBe('/missing-peer');
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['missing']);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'propagates stale remote symlink removal failures without clearing metadata',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-stale-cleanup-failure-'));
      const workspacePath = joinPath(tempPath, 'workspace');
      const linksPath = joinPath(workspacePath, 'linked-workspaces');
      const staleLink = joinPath(linksPath, 'missing');
      mkdirSync(workspacePath);
      mkdirSync(linksPath);
      symlinkSync('/missing-peer', staleLink);
      mockSshRun.mockImplementationOnce(async (_host, command) => {
        await execFileAsync('/bin/sh', ['-c', `rm() { return 17; }\n${command}`]);
        return '';
      });
      makeSshWorkspace('b', 'workspace-b', 'host-1', workspacePath, {
        linkedWorkspaceIds: ['missing'],
      });

      try {
        await expect(service.workspaceLinksService.unlink('missing', 'b')).rejects.toThrow();

        expect(readlinkSync(staleLink)).toBe('/missing-peer');
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['missing']);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'restores the first remote symlink when removing the reverse link fails',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-links-partial-unlink-'));
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      mkdirSync(pathA);
      mkdirSync(pathB);
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA, {
        repoName: 'komla',
        branchName: 'feat-a',
        linkedWorkspaceIds: ['b'],
      });
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB, {
        repoName: 'komla',
        branchName: 'feat-b',
        linkedWorkspaceIds: ['a'],
      });
      const linkAB = joinPath(pathA, 'linked-workspaces', 'komla-feat-b');
      const linkBA = joinPath(pathB, 'linked-workspaces', 'komla-feat-a');
      mkdirSync(joinPath(pathA, 'linked-workspaces'));
      mkdirSync(joinPath(pathB, 'linked-workspaces'));
      symlinkSync(pathB, linkAB);
      symlinkSync(pathA, linkBA);
      mockSshRun.mockImplementationOnce(async (_host, command) => {
        await execFileAsync('/bin/sh', [
          '-c',
          `rm_calls=0\nrm() { rm_calls=$((rm_calls + 1)); [ "$rm_calls" -ne 2 ] || return 17; command rm "$@"; }\n${command}`,
        ]);
        return '';
      });

      try {
        await expect(service.workspaceLinksService.unlink('a', 'b')).rejects.toThrow();

        expect(readlinkSync(linkAB)).toBe(pathB);
        expect(readlinkSync(linkBA)).toBe(pathA);
        expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it('rejects SSH links across hosts and mixed local/SSH links', async () => {
    makeSshWorkspace('ssh-a', 'ssh-a', 'host-1', '/work/a');
    makeSshWorkspace('ssh-b', 'ssh-b', 'host-2', '/work/b');
    makeWorkspace('local', 'local', '/work/local');

    await expect(service.workspaceLinksService.link('ssh-a', ['ssh-b'])).rejects.toThrow(
      'same SSH host'
    );
    await expect(service.workspaceLinksService.link('ssh-a', ['local'])).rejects.toThrow(
      'SSH workspaces can only be linked to other SSH workspaces'
    );
    await expect(service.workspaceLinksService.link('local', ['ssh-a'])).rejects.toThrow(
      'Local workspaces can only be linked to other local workspaces'
    );
    expect(mockSshRun).not.toHaveBeenCalled();
  });

  it('unlinks SSH workspaces remotely and updates both records', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      repoName: 'komla',
      branchName: 'feat-a',
      linkedWorkspaceIds: ['b'],
    });
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      repoName: 'komla',
      branchName: 'feat-b',
      linkedWorkspaceIds: ['a'],
    });

    await service.workspaceLinksService.unlink('a', 'b');

    expect(mockSshRun).toHaveBeenCalledOnce();
    const command = mockSshRun.mock.calls[0][1];
    expect(command).toContain("owner_a='/work/a'");
    expect(command).toContain("owner_b='/work/b'");
    expect(command).toContain('unlink_matching');
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
  });

  it('waits for SSH unlink metadata to be saved immediately', async () => {
    let finishSave: (() => void) | undefined;
    mockSaveWorkspacesImmediate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      linkedWorkspaceIds: ['b'],
    });
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });

    let unlinkResolved = false;
    const unlinkPromise = service.workspaceLinksService.unlink('a', 'b').then(() => {
      unlinkResolved = true;
    });
    await vi.waitFor(() => expect(mockSaveWorkspacesImmediate).toHaveBeenCalledOnce());

    expect(unlinkResolved).toBe(false);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
    finishSave?.();
    await unlinkPromise;
  });

  it('restores an SSH link when unlink metadata cannot be saved', async () => {
    const saveError = new Error('disk full');
    mockSaveWorkspacesImmediate.mockRejectedValueOnce(saveError);
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      linkedWorkspaceIds: ['b'],
    });
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });

    await expect(service.workspaceLinksService.unlink('a', 'b')).rejects.toBe(saveError);

    expect(mockSshRun).toHaveBeenCalledTimes(2);
    expect(mockSshRun.mock.calls[0][1]).toContain('unlink_matching');
    expect(mockSshRun.mock.calls[1][1]).toContain('ensure_link');
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('unlinkAll clears one-sided SSH link metadata during remote fallback cleanup', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });

    await service.workspaceLinksService.unlinkAll('a');

    expect(mockSshRun).toHaveBeenCalledOnce();
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
  });

  it('unlinkAll waits for one-sided SSH metadata to be saved immediately', async () => {
    let finishSave: (() => void) | undefined;
    mockSaveWorkspacesImmediate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });

    let unlinkResolved = false;
    const unlinkPromise = service.workspaceLinksService.unlinkAll('a').then(() => {
      unlinkResolved = true;
    });
    await vi.waitFor(() => expect(mockSaveWorkspacesImmediate).toHaveBeenCalledOnce());

    expect(unlinkResolved).toBe(false);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
    finishSave?.();
    await unlinkPromise;
  });

  it('unlinkAll clears one-sided SSH link metadata when remote fallback cleanup fails', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });
    mockSshRun.mockRejectedValueOnce(new Error('SSH connection lost'));

    await expect(service.workspaceLinksService.unlinkAll('a')).rejects.toThrow(
      'SSH connection lost'
    );

    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
  });

  it('preserves one-sided SSH cleanup when a concurrent owner link rolls back', async () => {
    const saveError = new Error('disk full');
    let rejectLinkSave: ((error: Error) => void) | undefined;
    mockSaveWorkspacesImmediate.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLinkSave = reject;
        })
    );
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });
    makeSshWorkspace('c', 'workspace-c', 'host-1', '/work/c');

    const failedLink = service.workspaceLinksService.link('b', ['c']);
    const failedLinkResult = expect(failedLink).rejects.toBe(saveError);
    await vi.waitFor(() => expect(mockSaveWorkspacesImmediate).toHaveBeenCalledOnce());
    const cleanup = service.workspaceLinksService.unlinkAll('a');
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectLinkSave?.(saveError);

    await failedLinkResult;
    await cleanup;

    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
    expect(workspacesMap.get('c')?.linkedWorkspaceIds ?? []).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects remote fallback cleanup through a symlinked link directory',
    async () => {
      const tempPath = mkdtempSync(
        joinPath(tmpdir(), 'komla-ssh-fallback-cleanup-directory-symlink-')
      );
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      const externalPath = joinPath(tempPath, 'external');
      const externalLink = joinPath(externalPath, 'workspace-a');
      mkdirSync(pathA);
      mkdirSync(pathB);
      mkdirSync(externalPath);
      symlinkSync(pathA, externalLink);
      symlinkSync(externalPath, joinPath(pathB, 'linked-workspaces'), 'dir');
      mockSshRun.mockImplementation(async (_host, command) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
        return stdout;
      });
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA);
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB, {
        linkedWorkspaceIds: ['a'],
      });

      try {
        await expect(service.workspaceLinksService.unlinkAll('a')).rejects.toThrow();

        expect(readlinkSync(externalLink)).toBe(pathA);
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'unlinkAll propagates remote fallback removal failures',
    async () => {
      const tempPath = mkdtempSync(joinPath(tmpdir(), 'komla-ssh-links-cleanup-failure-'));
      const pathA = joinPath(tempPath, 'workspace-a');
      const pathB = joinPath(tempPath, 'workspace-b');
      const linksB = joinPath(pathB, 'linked-workspaces');
      const linkBA = joinPath(linksB, 'workspace-a');
      mkdirSync(pathA);
      mkdirSync(pathB);
      mkdirSync(linksB);
      symlinkSync(pathA, linkBA);
      makeSshWorkspace('a', 'workspace-a', 'host-1', pathA);
      makeSshWorkspace('b', 'workspace-b', 'host-1', pathB, {
        linkedWorkspaceIds: ['a'],
      });
      mockSshRun.mockImplementationOnce(async (_host, command) => {
        await execFileAsync('/bin/sh', ['-c', `rm() { return 17; }\n${command}`]);
        return '';
      });

      try {
        await expect(service.workspaceLinksService.unlinkAll('a')).rejects.toThrow();

        expect(readlinkSync(linkBA)).toBe(pathA);
        expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
      } finally {
        rmSync(tempPath, { recursive: true, force: true });
      }
    }
  );

  it('does not persist SSH link metadata when remote creation fails', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b');
    mockSshRun.mockRejectedValueOnce(new Error('remote symlink failed'));

    await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toThrow(
      'remote symlink failed'
    );

    expect(workspacesMap.get('a')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds ?? []).toEqual([]);
  });

  it('preserves SSH link metadata during local disk reconciliation', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      linkedWorkspaceIds: ['b'],
    });
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', {
      linkedWorkspaceIds: ['a'],
    });

    const changed = await service.workspaceLinksService.reconcileAllFromDisk();

    expect(changed).toBe(false);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
    expect(mockSshRun).not.toHaveBeenCalled();
  });

  it('prunes missing SSH peers during local disk reconciliation', async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a', {
      linkedWorkspaceIds: ['missing'],
    });

    const changed = await service.workspaceLinksService.reconcileAllFromDisk();

    expect(changed).toBe(true);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual([]);
    expect(mockSshRun).not.toHaveBeenCalled();
  });

  it('writes linked-workspaces to .git/info/exclude when .git exists', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    fsState.dirs.add('/work/a/.git');
    fsState.dirs.add('/work/b/.git');
    fsState.files.set('/work/a/.git/info/exclude', '# existing\n');

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.files.get('/work/a/.git/info/exclude')).toContain(linkedWorkspacesExclude);
    expect(fsState.files.get('/work/a/.git/info/exclude')).toMatch(/^# existing\n/);
    expect(fsState.files.get('/work/b/.git/info/exclude')).toContain(linkedWorkspacesExclude);
  });

  it("writes a worktree's exclude to the shared gitdir, the only one git reads", async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    fsState.files.set('/work/a/.git', 'gitdir: /repo/.git/worktrees/a\n');
    fsState.files.set('/repo/.git/worktrees/a/commondir', '../..\n');
    fsState.dirs.add('/work/b/.git');

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.files.get('/repo/.git/info/exclude')).toContain(linkedWorkspacesExclude);
    expect(fsState.files.has('/repo/.git/worktrees/a/info/exclude')).toBe(false);
    expect(fsState.files.get('/work/a/.git')).toBe('gitdir: /repo/.git/worktrees/a\n');
  });

  it('writes exclude to the gitdir a .git file names when it shares no common dir', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    fsState.files.set('/work/a/.git', 'gitdir: /repo/.git/modules/a\n');
    fsState.dirs.add('/work/b/.git');

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.files.get('/repo/.git/modules/a/info/exclude')).toContain(
      linkedWorkspacesExclude
    );
  });

  it('does not duplicate the exclude entry on re-link', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    fsState.dirs.add('/work/a/.git');
    fsState.dirs.add('/work/b/.git');

    await service.workspaceLinksService.link('a', ['b']);
    const firstWrite = fsState.files.get('/work/a/.git/info/exclude');

    await service.workspaceLinksService.unlink('a', 'b');
    await service.workspaceLinksService.link('a', ['b']);
    const secondWrite = fsState.files.get('/work/a/.git/info/exclude');

    expect(secondWrite).toBe(firstWrite);
    const occurrences = (secondWrite ?? '').match(/\/linked-workspaces\/\*/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it('unlink removes both symlinks and updates linkedWorkspaceIds bidirectionally', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { repoName: 'komla', branchName: 'feat-a' });
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'komla', branchName: 'feat-b' });

    await service.workspaceLinksService.link('a', ['b']);
    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.links.has('/work/a/linked-workspaces/komla-feat-b')).toBe(false);
    expect(fsState.links.has('/work/b/linked-workspaces/komla-feat-a')).toBe(false);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
  });

  it('removes the linked-workspaces folder when its last link is unlinked', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');

    await service.workspaceLinksService.link('a', ['b']);
    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.dirs.has('/work/a/linked-workspaces')).toBe(false);
  });

  it('keeps folder when other links remain', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { repoName: 'komla', branchName: 'feat-a' });
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'komla', branchName: 'feat-b' });
    makeWorkspace('c', 'workspace-c', '/work/c', { repoName: 'komla', branchName: 'feat-c' });

    await service.workspaceLinksService.link('a', ['b', 'c']);
    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.dirs.has('/work/a/linked-workspaces')).toBe(true);
    expect(fsState.links.has('/work/a/linked-workspaces/komla-feat-c')).toBe(true);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['c']);
  });

  it('linking to multiple peers makes pairs (B and C are not linked to each other)', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    makeWorkspace('c', 'workspace-c', '/work/c');

    await service.workspaceLinksService.link('a', ['b', 'c']);

    expect(workspacesMap.get('a')?.linkedWorkspaceIds?.sort()).toEqual(['b', 'c']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
    expect(workspacesMap.get('c')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('preserves prior origin links when one link call adds multiple peers from snapshots', async () => {
    replaceWorkspaceOnUpdate = true;
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    makeWorkspace('c', 'workspace-c', '/work/c');

    await service.workspaceLinksService.link('a', ['b', 'c']);

    expect(workspacesMap.get('a')?.linkedWorkspaceIds?.sort()).toEqual(['b', 'c']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
    expect(workspacesMap.get('c')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('unlinkAll removes all peer links and folder', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    makeWorkspace('c', 'workspace-c', '/work/c');

    await service.workspaceLinksService.link('a', ['b', 'c']);
    await service.workspaceLinksService.unlinkAll('a');

    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual([]);
    expect(workspacesMap.get('c')?.linkedWorkspaceIds).toEqual([]);
    expect(fsState.dirs.has('/work/a/linked-workspaces')).toBe(false);
    expect(fsState.dirs.has('/work/b/linked-workspaces')).toBe(false);
    expect(fsState.dirs.has('/work/c/linked-workspaces')).toBe(false);
  });

  it('unlinkAll removes old peer symlinks even when metadata is missing', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');
    fsState.dirs.add('/work/b/linked-workspaces');
    fsState.links.set('/work/b/linked-workspaces/old-a-link', '/work/a');

    await service.workspaceLinksService.unlinkAll('a');

    expect(fsState.links.has('/work/b/linked-workspaces/old-a-link')).toBe(false);
    expect(fsState.dirs.has('/work/b/linked-workspaces')).toBe(false);
  });

  it("unlinking a peer with a colliding slug does not delete the other peer's link", async () => {
    // Two peers (b and c) hash to the same slug. b grabs `shared-feat`; c
    // falls back to `shared-feat-<id>`. Unlinking c must not match b's path.
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'shared', branchName: 'feat' });
    makeWorkspace('c', 'workspace-c', '/work/c', { repoName: 'shared', branchName: 'feat' });

    await service.workspaceLinksService.link('a', ['b']);
    await service.workspaceLinksService.link('a', ['c']);

    expect(fsState.links.get('/work/a/linked-workspaces/shared-feat')).toBe('/work/b');
    const cLinkKey = [...fsState.links.keys()].find(
      (k) =>
        k.startsWith('/work/a/linked-workspaces/shared-feat-') &&
        k !== '/work/a/linked-workspaces/shared-feat'
    );
    expect(cLinkKey).toBeDefined();
    expect(fsState.links.get(cLinkKey!)).toBe('/work/c');

    await service.workspaceLinksService.unlink('a', 'c');

    // b's link must survive; c's must be gone
    expect(fsState.links.get('/work/a/linked-workspaces/shared-feat')).toBe('/work/b');
    expect(cLinkKey && fsState.links.has(cLinkKey)).toBe(false);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
  });

  it('lists where each linked workspace is, by the symlink that points at it', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'shared', branchName: 'feat' });
    makeWorkspace('c', 'workspace-c', '/work/c', { repoName: 'shared', branchName: 'feat' });
    await service.workspaceLinksService.link('a', ['b', 'c']);

    const paths = await service.workspaceLinksService.listLinkPaths('a');

    expect(paths).toEqual([
      { workspaceId: 'b', path: 'linked-workspaces/shared-feat' },
      { workspaceId: 'c', path: expect.stringMatching(/^linked-workspaces\/shared-feat-/) },
    ]);
    expect(await service.workspaceLinksService.listLinkPaths('b')).toEqual([
      { workspaceId: 'a', path: 'linked-workspaces/a' },
    ]);
  });

  it("lists an SSH workspace's links from the symlinks on its host", async () => {
    makeSshWorkspace('a', 'workspace-a', 'host-1', '/work/a');
    makeSshWorkspace('b', 'workspace-b', 'host-1', '/work/b', { linkedWorkspaceIds: ['a'] });
    makeSshWorkspace('c', 'workspace-c', 'host-1', '/work/c', { linkedWorkspaceIds: ['a'] });
    workspacesMap.get('a')!.linkedWorkspaceIds = ['b', 'c'];
    mockSshRun.mockResolvedValueOnce('komla-b\t/work/b\nstray\t/elsewhere\n');

    const paths = await service.workspaceLinksService.listLinkPaths('a');

    expect(mockSshRun.mock.calls[0][1]).toContain("folder='/work/a/linked-workspaces'");
    // c has no symlink, as after a link that failed on the host.
    expect(paths).toEqual([{ workspaceId: 'b', path: 'linked-workspaces/komla-b' }]);
  });

  it('re-linking the same peer is idempotent and does not duplicate symlinks', async () => {
    // Calling link a→b twice (e.g. user retries after a partial failure) must
    // not leave both `foo` and `foo-<id>` pointing at the same peer.
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'komla', branchName: 'feat-b' });

    await service.workspaceLinksService.link('a', ['b']);
    await service.workspaceLinksService.link('a', ['b']);

    const aLinks = [...fsState.links.keys()].filter((k) =>
      k.startsWith('/work/a/linked-workspaces/')
    );
    expect(aLinks).toEqual(['/work/a/linked-workspaces/komla-feat-b']);
    const bLinks = [...fsState.links.keys()].filter((k) =>
      k.startsWith('/work/b/linked-workspaces/')
    );
    expect(bLinks).toHaveLength(1);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual(['b']);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds).toEqual(['a']);
  });

  it('preserves user content in linked-workspaces/ when removing the last link', async () => {
    // The folder lives in the user's working directory. If they (or an agent)
    // drop a notes file inside, unlinking the last peer must not nuke it.
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');

    await service.workspaceLinksService.link('a', ['b']);
    fsState.files.set('/work/a/linked-workspaces/notes.md', 'user content');
    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.files.get('/work/a/linked-workspaces/notes.md')).toBe('user content');
    expect(fsState.dirs.has('/work/a/linked-workspaces')).toBe(true);
    expect(fsState.links.has('/work/a/linked-workspaces/b')).toBe(false);
  });

  it("does not clobber another peer's link when the fallback path collides", async () => {
    // C's canonical name 'foo-12345678' happens to equal B's
    // `<base>-<id-prefix>` fallback. Linking B with the candidate `foo`
    // already taken must NOT overwrite C's link — it must throw instead.
    makeWorkspace('a', 'workspace-a', '/work/a');
    // C: repoName='foo', branchName='12345678' → canonical = 'foo-12345678'.
    makeWorkspace('c', 'workspace-c', '/work/c', { repoName: 'foo', branchName: '12345678' });
    // B: id prefix '12345678', repoName='foo', no branch → base='foo',
    // fallback = 'foo-12345678' (same as C's canonical).
    workspacesMap.set('12345678-aaaa', {
      id: '12345678-aaaa',
      name: 'workspace-b',
      workingDirectory: '/work/b',
      repoName: 'foo',
    });
    fsState.dirs.add('/work/b');

    // Link c first — c takes its canonical 'foo-12345678'.
    await service.workspaceLinksService.link('a', ['c']);
    expect(fsState.links.get('/work/a/linked-workspaces/foo-12345678')).toBe('/work/c');

    // Place a foreign file at B's candidate path 'foo' so resolvePeerLinkPath
    // is forced into the fallback branch.
    fsState.files.set('/work/a/linked-workspaces/foo', 'foreign');

    // Linking B must throw rather than overwrite C's link.
    await expect(service.workspaceLinksService.link('a', ['12345678-aaaa'])).rejects.toThrow(
      /Cannot allocate link path/
    );
    // C's link must be intact; foreign file must be intact.
    expect(fsState.links.get('/work/a/linked-workspaces/foo-12345678')).toBe('/work/c');
    expect(fsState.files.get('/work/a/linked-workspaces/foo')).toBe('foreign');
  });

  it('preserves a foreign symlink in linked-workspaces/ when removing the last link', async () => {
    // Symlinks pointing at unrelated, non-komla directories must survive
    // cleanup — only komla-owned and broken symlinks get swept.
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');

    await service.workspaceLinksService.link('a', ['b']);
    fsState.dirs.add('/some/external/dir');
    fsState.links.set('/work/a/linked-workspaces/external', '/some/external/dir');
    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.links.get('/work/a/linked-workspaces/external')).toBe('/some/external/dir');
    expect(fsState.dirs.has('/work/a/linked-workspaces')).toBe(true);
  });

  it('does not delete a pre-existing valid A→B link when B→A creation fails', async () => {
    // After a partial-success retry, A→B already exists. If B→A fails again,
    // rollback must NOT touch A→B (it wasn't created in this call).
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b');

    // Seed A→B as if a prior call already succeeded.
    fsState.dirs.add('/work/a/linked-workspaces');
    fsState.dirs.add('/work/b/linked-workspaces');
    fsState.links.set('/work/a/linked-workspaces/b', '/work/b');

    const fs = await import('fs/promises');
    const realSymlink = fs.symlink as ReturnType<typeof vi.fn>;
    realSymlink.mockImplementationOnce(async () => {
      throw new Error('EPERM on B→A');
    });

    await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toThrow('EPERM on B→A');
    // A→B must survive — rollback only undoes work done in this call.
    expect(fsState.links.get('/work/a/linked-workspaces/b')).toBe('/work/b');
  });

  it('createPair rolls back the first symlink if the second fails', async () => {
    // Simulate the second symlink failing (e.g. EPERM on b's filesystem). We
    // must not leave a one-sided symlink that reconcile would later turn into
    // broken bidirectional metadata.
    makeWorkspace('a', 'workspace-a', '/work/a', { repoName: 'komla', branchName: 'feat-a' });
    makeWorkspace('b', 'workspace-b', '/work/b', { repoName: 'komla', branchName: 'feat-b' });

    const fs = await import('fs/promises');
    const realSymlink = fs.symlink as ReturnType<typeof vi.fn>;
    let callCount = 0;
    realSymlink.mockImplementationOnce(async (target: string, linkPath: string) => {
      fsState.links.set(linkPath, target);
      callCount++;
    });
    realSymlink.mockImplementationOnce(async () => {
      callCount++;
      throw new Error('EPERM');
    });

    await expect(service.workspaceLinksService.link('a', ['b'])).rejects.toThrow('EPERM');
    expect(callCount).toBe(2);
    // First symlink must have been rolled back; metadata must remain empty.
    expect(fsState.links.has('/work/a/linked-workspaces/komla-feat-b')).toBe(false);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds ?? []).toEqual([]);
    expect(workspacesMap.get('b')?.linkedWorkspaceIds ?? []).toEqual([]);
  });

  it('slugify prefixes Windows-reserved device names so the entry remains creatable', async () => {
    // Branch name `con` would slugify to `con` — invalid on Windows.
    expect(service.__testing.slugify('CON')).toBe('_con');
    expect(service.__testing.slugify('nul')).toBe('_nul');
    expect(service.__testing.slugify('com1.txt')).toBe('_com1.txt');
    expect(service.__testing.slugify('feat-foo')).toBe('feat-foo');
  });

  it('removes broken legacy symlinks by path instead of following the target', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', {
      linkedWorkspaceIds: ['b'],
    });
    makeWorkspace('b', 'workspace-b', '/work/missing-target', {
      branchName: 'missing-target',
      linkedWorkspaceIds: ['a'],
    });
    fsState.dirs.delete('/work/missing-target');
    fsState.dirs.add('/work/a/linked-workspaces');
    fsState.links.set('/work/a/linked-workspaces/missing-target', '/work/missing-target');

    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.links.has('/work/a/linked-workspaces/missing-target')).toBe(false);
  });

  it('reconciles linkedWorkspaceIds from existing symlink folders', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { linkedWorkspaceIds: ['b'] });
    makeWorkspace('b', 'workspace-b', '/work/b');
    makeWorkspace('c', 'workspace-c', '/work/c');
    makeWorkspace('d', 'workspace-d', '/work/d');
    fsState.dirs.add('/work/a/linked-workspaces');
    fsState.links.set('/work/a/linked-workspaces/b-link', '/work/b');
    fsState.links.set('/work/a/linked-workspaces/c-link', '/work/c');
    fsState.links.set('/work/a/linked-workspaces/d-link', '/work/d');

    const changed = await service.workspaceLinksService.reconcileAllFromDisk();

    expect(changed).toBe(true);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds?.sort()).toEqual(['b', 'c', 'd']);
  });

  it('heals missing .git/info/exclude entry on reconcile for pre-existing folders', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { linkedWorkspaceIds: ['b'] });
    makeWorkspace('b', 'workspace-b', '/work/b', { linkedWorkspaceIds: ['a'] });
    fsState.dirs.add('/work/a/.git');
    fsState.dirs.add('/work/b/.git');
    fsState.dirs.add('/work/a/linked-workspaces');
    fsState.dirs.add('/work/b/linked-workspaces');
    fsState.links.set('/work/a/linked-workspaces/b-link', '/work/b');
    fsState.links.set('/work/b/linked-workspaces/a-link', '/work/a');
    // Pre-existing folders created before the exclude logic — info/exclude missing the line.
    fsState.files.set('/work/a/.git/info/exclude', '# existing\n');

    await service.workspaceLinksService.reconcileAllFromDisk();

    expect(fsState.files.get('/work/a/.git/info/exclude')).toContain(linkedWorkspacesExclude);
    expect(fsState.files.get('/work/b/.git/info/exclude')).toContain(linkedWorkspacesExclude);

    // Idempotent: second reconcile must not duplicate the line.
    const before = fsState.files.get('/work/a/.git/info/exclude');
    await service.workspaceLinksService.reconcileAllFromDisk();
    expect(fsState.files.get('/work/a/.git/info/exclude')).toBe(before);
  });

  it('treats a non-directory linked-workspaces path as no links during reconciliation', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { linkedWorkspaceIds: ['b'] });
    makeWorkspace('b', 'workspace-b', '/work/b');
    fsState.files.set('/work/a/linked-workspaces', 'not a directory');

    const changed = await service.workspaceLinksService.reconcileAllFromDisk();

    expect(changed).toBe(true);
    expect(workspacesMap.get('a')?.linkedWorkspaceIds).toEqual([]);
  });

  it('slugifies repo + branch into a path-safe folder name', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a', { repoName: 'komla', branchName: 'feat-a' });
    makeWorkspace('b', 'workspace-b', '/work/b', {
      repoName: 'My Repo',
      branchName: 'feat/foo:bar baz',
    });

    await service.workspaceLinksService.link('a', ['b']);

    const aLinks = [...fsState.links.keys()].filter((k) =>
      k.startsWith('/work/a/linked-workspaces/')
    );
    expect(aLinks).toHaveLength(1);
    const linkBasename = aLinks[0].slice('/work/a/linked-workspaces/'.length);
    expect(linkBasename).toBe('my-repo-feat-foo-bar-baz');
    expect(linkBasename).not.toMatch(/[/:\s]/);
  });

  it('uses repoName as the project-name prefix for link folder names', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b', {
      projectId: 'project-b',
      repoName: 'Cool Trout',
      branchName: 'feat/foo',
    });

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.links.get('/work/a/linked-workspaces/cool-trout-feat-foo')).toBe('/work/b');
  });

  it('uses project name from projectId when repoName is missing', async () => {
    projectsMap.set('project-b', { id: 'project-b', name: 'Cool Trout' });
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/b', {
      projectId: 'project-b',
      branchName: 'feat/foo',
    });

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.links.get('/work/a/linked-workspaces/cool-trout-feat-foo')).toBe('/work/b');
  });

  it('removes legacy branch-only symlinks after project-name resolution exists', async () => {
    projectsMap.set('project-b', { id: 'project-b', name: 'Cool Trout' });
    makeWorkspace('a', 'workspace-a', '/work/a', {
      linkedWorkspaceIds: ['b'],
    });
    makeWorkspace('b', 'workspace-b', '/work/b', {
      projectId: 'project-b',
      branchName: 'feat/foo',
      linkedWorkspaceIds: ['a'],
    });
    fsState.dirs.add('/work/a/linked-workspaces');
    fsState.links.set('/work/a/linked-workspaces/feat-foo', '/work/b');

    await service.workspaceLinksService.unlink('a', 'b');

    expect(fsState.links.has('/work/a/linked-workspaces/feat-foo')).toBe(false);
  });

  it('falls back to working-dir basename when repo + branch are missing', async () => {
    makeWorkspace('a', 'workspace-a', '/work/a');
    makeWorkspace('b', 'workspace-b', '/work/some-dir-name');

    await service.workspaceLinksService.link('a', ['b']);

    expect(fsState.links.get('/work/a/linked-workspaces/some-dir-name')).toBe(
      '/work/some-dir-name'
    );
  });
});
