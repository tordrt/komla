import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rsync: vi.fn(),
  children: [] as Array<{
    stdout: { emit: (event: string, chunk: string) => void; destroy: () => void };
    stderr: { destroy: () => void };
    kill: () => void;
  }>,
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  mkdir: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
  writeFile: vi.fn(() => Promise.resolve()),
  readdir: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  readFile: vi.fn((): Promise<string> => Promise.resolve('')),
  rmdir: vi.fn(() => Promise.resolve()),
  mkdtemp: vi.fn((prefix: string) => Promise.resolve(`${prefix}abc123`)),
  rmTemp: vi.fn(() => Promise.resolve()),
  // Outside a Git work tree, Git lists nothing.
  run: vi.fn((): Promise<string> => Promise.resolve('')),
  getHost: vi.fn(() => ({ id: 'ssh-dev' })),
  ensureWorkspaceReady: vi.fn(() => Promise.resolve()),
  getRsyncTransport: vi.fn(() => ({
    remoteTarget: 'dev@example.com',
    remoteShell: "ssh '-p' '2222'",
  })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Each spawned rsync reports its outcome through `mocks.rsync`'s callback, and can write more
// output before then through `mocks.children`.
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const spawn = (file: string, args: string[], options: unknown) => {
    const stream = () =>
      Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      kill: vi.fn(),
    });
    mocks.children.push(child);
    mocks.rsync(
      file,
      args,
      options,
      (
        error: (Error & { code?: string; exitCode?: number }) | null,
        stdout: string,
        stderr: string
      ) => {
        // Listeners attach after spawn returns, and a real child can't report before then.
        queueMicrotask(() => {
          if (error?.code === 'ENOENT') {
            child.emit('error', error);
            return;
          }
          if (stdout) child.stdout.emit('data', stdout);
          if (stderr) child.stderr.emit('data', stderr);
          child.emit('close', error ? (error.exitCode ?? 1) : 0, null);
        });
      }
    );
    return child;
  };
  return { spawn };
});
vi.mock('fs', () => ({ existsSync: mocks.existsSync, readFileSync: mocks.readFileSync }));
vi.mock('fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  readdir: mocks.readdir,
  readFile: mocks.readFile,
  rmdir: mocks.rmdir,
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rmTemp,
}));
// Local copies can contain node_modules/electron's .asar files, which only the
// shared remover deletes correctly inside Electron.
vi.mock('../../../src/main/lib/remove-path', () => ({ removePath: mocks.rm }));
vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/tmp/komla-test',
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    ensureWorkspaceReady: mocks.ensureWorkspaceReady,
    getRsyncTransport: mocks.getRsyncTransport,
    getHost: mocks.getHost,
    run: mocks.run,
  },
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => mocks.logger,
}));

const backend = {
  kind: 'ssh' as const,
  hostId: 'ssh-dev',
  remoteDirectory: '/home/dev/work trees/project',
  remoteRepoPath: '/home/dev/repos/project.git',
  remoteProjectRoot: '/home/dev/work trees',
  gitUrl: 'git@example.com:project.git',
  projectName: 'Project App',
  branchName: 'agent/local-preview',
};

const LOCAL_COPIES = '/tmp/komla-test/local-copies';

function directory(name: string) {
  return { name, isDirectory: () => true };
}

/** Lays out local-copies/<project>/<branch> folders, each with the owner its marker names. */
function layOut(folders: Record<string, string | undefined>): void {
  const children = new Map<string, Array<{ name: string; isDirectory: () => boolean }>>();
  for (const path of Object.keys(folders)) {
    const [project, branch] = path.split('/');
    children.set(LOCAL_COPIES, [
      ...(children.get(LOCAL_COPIES) ?? []).filter((entry) => entry.name !== project),
      directory(project!),
    ]);
    const projectPath = `${LOCAL_COPIES}/${project}`;
    children.set(projectPath, [...(children.get(projectPath) ?? []), directory(branch!)]);
  }
  mocks.readdir.mockImplementation(async (path: unknown) => {
    const entries = children.get(String(path));
    if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return entries;
  });
  mocks.readFile.mockImplementation(async (path: unknown) => {
    const owner =
      folders[
        String(path)
          .slice(LOCAL_COPIES.length + 1)
          .replace(/\/\.komla-local-copy$/, '')
      ];
    if (owner === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return `${owner}\n`;
  });
}

// Local copies aren't supported on Windows, where initializeLocalCopy refuses, so these run on
// macOS and Linux.
describe.skipIf(process.platform === 'win32')('LocalCopyService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.rsync.mockReset();
    mocks.children.length = 0;
    mocks.existsSync.mockReturnValue(false);
    mocks.readFileSync.mockReset();
    mocks.readdir.mockReset().mockResolvedValue([]);
    mocks.readFile.mockReset().mockResolvedValue('');
    mocks.rm.mockReset().mockResolvedValue(undefined);
    mocks.run.mockReset().mockResolvedValue('');
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('keeps per-request sync traces out of info diagnostics', async () => {
    vi.stubEnv('KOMLA_DIAGNOSTICS', '1');
    const finishes: Array<() => void> = [];
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() => callback(null, '', ''));
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    localCopyService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localCopyService.requestSync('workspace-1', backend);
    finishes[0]?.();
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[1]?.();
    await vi.waitFor(() =>
      expect(mocks.logger.debug).toHaveBeenCalledWith(
        'local copy sync finished',
        expect.objectContaining({ followupQueued: false })
      )
    );

    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      'local copy sync requested',
      expect.objectContaining({ action: 'queue-followup' })
    );
  });

  it('does not create a copy when checking whether remote changes should sync', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    expect(localCopyService.hasLocalCopy('workspace-1', backend)).toBe(false);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.rsync).not.toHaveBeenCalled();
  });

  it('recognizes an existing copy after restart', async () => {
    const localCopyPath = '/tmp/komla-test/local-copies/Project-App/agent-local-preview';
    mocks.existsSync.mockImplementation((path) => String(path) === localCopyPath);
    mocks.readFileSync.mockImplementation((path) =>
      String(path) === `${localCopyPath}/.komla-local-copy` ? 'workspace-1' : undefined
    );
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    expect(localCopyService.hasLocalCopy('workspace-1', backend)).toBe(true);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.rsync).not.toHaveBeenCalled();
  });

  it("does not sync another workspace's copy", async () => {
    mocks.existsSync.mockImplementation(
      (path) => String(path) === '/tmp/komla-test/local-copies/Project-App/agent-local-preview'
    );
    mocks.readFileSync.mockReturnValue('another-workspace');
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    expect(localCopyService.hasLocalCopy('workspace-1', backend)).toBe(false);
  });

  it('recognizes a copy being initialized on demand', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    const initialization = localCopyService.initialize('workspace-1', backend);
    expect(localCopyService.hasLocalCopy('workspace-1', backend)).toBe(true);
    await initialization;
  });

  it('protects files matched by project gitignore rules', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.ensureWorkspaceReady).not.toHaveBeenCalled();
    expect(mocks.mkdir).toHaveBeenCalledWith(
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview',
      { recursive: true }
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview/.komla-local-copy',
      'workspace-1',
      'utf8'
    );
    expect(mocks.rsync).toHaveBeenCalledWith(
      'rsync',
      expect.arrayContaining([
        '-s',
        '--omit-dir-times',
        '--delete-after',
        '--safe-links',
        '--exclude=/.git',
        '--exclude=/.komla-local-copy',
        '--exclude=/.komla-files',
        '--filter=:- .gitignore',
        'dev@example.com:/home/dev/work trees/project/',
        '/tmp/komla-test/local-copies/Project-App/agent-local-preview/',
      ]),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('includes what Git keeps although .gitignore matches it, ahead of the .gitignore filter', async () => {
    // A login shell can print before the command does.
    mocks.run.mockResolvedValue(
      [
        'Welcome!\nkomla-git-paths\n',
        '.gitignore\x001\x00deps/\x00deps/x/file\x00',
        '.gitignore\x004\x00!/tmp/pids/.keep\x00tmp/pids/.keep\x00',
        '\x00\x00\x00\x00',
        '.gitignore\x001\x00deps/\x00deps\x00',
        '.gitignore\x001\x00deps/\x00deps/x\x00',
      ].join('')
    );
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.getHost).toHaveBeenCalledWith('ssh-dev');
    expect(mocks.run).toHaveBeenCalledWith(
      { id: 'ssh-dev' },
      expect.stringContaining("cd '/home/dev/work trees/project' || exit 1")
    );
    const ruleDir = await (mocks.mkdtemp.mock.results[0]?.value as Promise<string>);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `${ruleDir}/include`,
      '/deps/\n/deps/x/\n/deps/x/file\n/tmp/\n/tmp/pids/\n/tmp/pids/.keep\n',
      'utf8'
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `${ruleDir}/exclude`,
      '/deps/*\n/deps/x/*\n',
      'utf8'
    );
    const args = mocks.rsync.mock.calls[0]?.[1] as string[];
    const include = args.indexOf(`--include-from=${ruleDir}/include`);
    const exclude = args.indexOf(`--exclude-from=${ruleDir}/exclude`);
    expect(include).toBeGreaterThan(args.indexOf('--exclude=/.komla-files'));
    expect(exclude).toBeGreaterThan(include);
    expect(args.indexOf('--filter=:- .gitignore')).toBeGreaterThan(exclude);
    expect(mocks.rmTemp).toHaveBeenCalledWith(ruleDir, { recursive: true, force: true });
  });

  it('writes no rule files when Git keeps nothing that .gitignore matches', async () => {
    mocks.run.mockResolvedValue('komla-git-paths\n\0\0\0\0');
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    const args = mocks.rsync.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--filter=:- .gitignore');
    expect(args.some((arg) => /^--(include|exclude)-from=/.test(arg))).toBe(false);
  });

  it('removes the rule files when the sync fails', async () => {
    mocks.run.mockResolvedValue('komla-git-paths\n.gitignore\x001\x00*.key\x00master.key\x00');
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error('failed'), { exitCode: 23 }), '', 'rsync error');
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await expect(localCopyService.prepare('workspace-1', backend)).rejects.toThrow(
      'Failed to update local copy'
    );
    expect(mocks.rmTemp).toHaveBeenCalledTimes(1);
  });

  it("syncs with the .gitignore filter alone when Git can't say which ignored files it keeps", async () => {
    mocks.run.mockRejectedValue(new Error('ssh: connection reset'));
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);

    const args = mocks.rsync.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--filter=:- .gitignore');
    expect(args.some((arg) => /^--(include|exclude)-from=/.test(arg))).toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not ask Git which ignored files it keeps'),
      expect.objectContaining({ workspaceId: 'workspace-1', error: 'ssh: connection reset' })
    );
  });

  it('stops a sync that is still running after five minutes', async () => {
    vi.useFakeTimers();
    try {
      mocks.rsync.mockImplementation(() => undefined);
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      localCopyService.requestSync('workspace-1', backend);
      await vi.advanceTimersByTimeAsync(0);
      const child = mocks.children[0];

      await vi.advanceTimersByTimeAsync(299_999);
      expect(child?.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(child?.kill).toHaveBeenCalled();
      expect(child?.stdout.destroy).toHaveBeenCalled();
      expect(child?.stderr.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rewrite the watched remote repository during local copy syncs', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);
    localCopyService.requestSync('workspace-1', backend);
    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.rsync).toHaveBeenCalledTimes(2);
    // Provisioning rewrites shared Git config, causing another watcher snapshot and sync.
    expect(mocks.ensureWorkspaceReady).not.toHaveBeenCalled();
    expect(localCopyService.getSyncStatuses()).toEqual([]);
  });

  it('can initialize an empty local copy without starting a sync', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    const localCopyPath = await localCopyService.initialize('workspace-1', backend);

    expect(localCopyPath).toBe('/tmp/komla-test/local-copies/Project-App/agent-local-preview');
    expect(mocks.mkdir).toHaveBeenCalledWith(
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview',
      { recursive: true }
    );
    expect(mocks.rsync).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceReady).not.toHaveBeenCalled();
  });

  it('reports one continuous busy period while a requested resync is queued', async () => {
    const finishes: Array<() => void> = [];
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() => callback(null, '', ''));
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');
    const states: string[] = [];
    localCopyService.onSyncStatus((status) => states.push(status.state));

    localCopyService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localCopyService.requestSync('workspace-1', backend);

    finishes[0]?.();
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    expect(states).toEqual(['syncing']);

    finishes[1]?.();
    await vi.waitFor(() => expect(states).toEqual(['syncing', 'ready']));
  });

  it('waits for a queued resync before completing preparation', async () => {
    const finishes: Array<() => void> = [];
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() => callback(null, '', ''));
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    localCopyService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localCopyService.requestSync('workspace-1', backend);
    let prepared = false;
    const preparation = localCopyService.prepare('workspace-1', backend).then(() => {
      prepared = true;
    });

    finishes[0]?.();
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    expect(prepared).toBe(false);

    finishes[1]?.();
    await preparation;
    expect(prepared).toBe(true);
  });

  it('runs only one initial sync across repeated local copy activations', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    localCopyService.ensureInitialSync('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.rsync).toHaveBeenCalledTimes(1));

    localCopyService.ensureInitialSync('workspace-1', backend);
    await Promise.resolve();

    expect(mocks.rsync).toHaveBeenCalledTimes(1);
  });

  it('is current only while its latest sync succeeded', async () => {
    let finishSync: (error: Error | null) => void = () => undefined;
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finishSync = (error) => callback(error, '', error?.message ?? '');
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');
    expect(localCopyService.isCurrent('workspace-1')).toBe(false);

    const first = localCopyService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.rsync).toHaveBeenCalledTimes(1));
    expect(localCopyService.isCurrent('workspace-1')).toBe(false);
    finishSync(null);
    await first;
    expect(localCopyService.isCurrent('workspace-1')).toBe(true);

    const second = localCopyService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.rsync).toHaveBeenCalledTimes(2));
    expect(localCopyService.isCurrent('workspace-1')).toBe(false);
    finishSync(new Error('connection lost'));
    await expect(second).rejects.toThrow('connection lost');
    expect(localCopyService.isCurrent('workspace-1')).toBe(false);
  });

  it('reports background sync failures and allows the initial sync to retry', async () => {
    mocks.rsync
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(new Error('connection lost'), '', 'connection lost');
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, '', '');
      });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');
    const statuses: Array<{ state: string; message?: string }> = [];
    localCopyService.onSyncStatus((status) => statuses.push(status));

    localCopyService.ensureInitialSync('workspace-1', backend);
    await vi.waitFor(() =>
      expect(statuses).toEqual([
        { workspaceId: 'workspace-1', state: 'syncing' },
        expect.objectContaining({
          workspaceId: 'workspace-1',
          state: 'error',
          message: expect.stringContaining('connection lost'),
        }),
      ])
    );

    localCopyService.ensureInitialSync('workspace-1', backend);
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ workspaceId: 'workspace-1', state: 'ready' })
    );
    expect(mocks.rsync).toHaveBeenCalledTimes(2);
  });

  it.each(['rsync: invalid option -- s', 'rsync: -s: unknown option'])(
    'falls back to legacy remote-path quoting for %s',
    async (message) => {
      mocks.rsync.mockImplementation((_file, args, _options, callback) => {
        if (args.includes('-s')) {
          callback(new Error(message), '', message);
          return;
        }
        callback(null, '', '');
      });
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      await localCopyService.prepare('workspace-1', backend);

      expect(mocks.rsync).toHaveBeenCalledTimes(2);
      expect(mocks.rsync.mock.calls[1]?.[1]).not.toContain('-s');
      expect(mocks.rsync.mock.calls[1]?.[1]).toContain(
        "dev@example.com:'/home/dev/work trees/project/'"
      );
      expect(mocks.rsync.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ RSYNC_OLD_ARGS: '1', RSYNC_PROTECT_ARGS: '0' }),
        })
      );
    }
  );

  it('asks rsync for overall progress and reports each new percent', async () => {
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      callback(
        null,
        '\r      3,000,000  12%    9.17MB/s    0:00:00 (xfr#1, to-chk=38/40)' +
          '\r      3,000,000  12%    9.17MB/s    0:00:00 (xfr#1, to-chk=38/40)' +
          '\r     24,000,000  99%    7.90MB/s    0:00:02 (xfr#8, to-chk=0/40)\r',
        ''
      );
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');
    const statuses: unknown[] = [];
    localCopyService.onSyncStatus((status) => statuses.push(status));

    await localCopyService.prepare('workspace-1', backend);
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ workspaceId: 'workspace-1', state: 'ready' })
    );

    expect(mocks.rsync.mock.calls[0]?.[1]).toContain('--info=progress2');
    expect(statuses).toEqual([
      { workspaceId: 'workspace-1', state: 'syncing' },
      { workspaceId: 'workspace-1', state: 'syncing', percent: 12 },
      { workspaceId: 'workspace-1', state: 'syncing', percent: 100 },
      { workspaceId: 'workspace-1', state: 'ready' },
    ]);
  });

  it('gives a window that opens during a sync its current percent', async () => {
    let finish: (() => void) | undefined;
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finish = () => callback(null, '', '');
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    const sync = localCopyService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.children).toHaveLength(1));
    mocks.children[0]?.stdout.emit('data', '\r      3,000,000  12%    9.17MB/s    0:00:00  ');

    expect(localCopyService.getSyncStatuses()).toEqual([
      { workspaceId: 'workspace-1', state: 'syncing', percent: 12 },
    ]);
    finish?.();
    await sync;
  });

  it('starts over from no percent when a queued sync follows', async () => {
    const finishes: Array<() => void> = [];
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() =>
        callback(null, '\r      3,000,000  12%    9.17MB/s    0:00:00  \r', '')
      );
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');
    const statuses: unknown[] = [];
    localCopyService.onSyncStatus((status) => statuses.push(status));

    localCopyService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localCopyService.requestSync('workspace-1', backend);
    finishes[0]?.();
    await vi.waitFor(() => expect(finishes).toHaveLength(2));

    expect(statuses).toEqual([
      { workspaceId: 'workspace-1', state: 'syncing' },
      { workspaceId: 'workspace-1', state: 'syncing', percent: 12 },
      { workspaceId: 'workspace-1', state: 'syncing' },
    ]);
    finishes[1]?.();
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ workspaceId: 'workspace-1', state: 'ready' })
    );
  });

  // Dropping --info=progress2 keeps Local copies working on the rsync that macOS ships.
  it('falls back to per-file progress when rsync rejects overall progress', async () => {
    const rejection = "rsync: unrecognized option `--info=progress2'";
    mocks.rsync.mockImplementation((_file, args, _options, callback) => {
      if (args.includes('--info=progress2')) {
        callback(new Error(rejection), '', rejection);
        return;
      }
      callback(
        null,
        '     3 100%  1MB/s  0:00:00 (xfer#1, to-check=38/40)\n' +
          '     3 100%  1MB/s  0:00:00 (xfer#2, to-check=20/40)\n',
        ''
      );
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');
    const statuses: unknown[] = [];
    localCopyService.onSyncStatus((status) => statuses.push(status));

    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.rsync).toHaveBeenCalledTimes(2);
    expect(mocks.rsync.mock.calls[1]?.[1]).toContain('--progress');
    expect(mocks.rsync.mock.calls[1]?.[1]).toContain('-s');
    await vi.waitFor(() =>
      expect(statuses).toContainEqual({
        workspaceId: 'workspace-1',
        state: 'syncing',
        percent: 50,
      })
    );
  });

  it('still syncs, without a percent, on an rsync with no progress options at all', async () => {
    mocks.rsync.mockImplementation((_file, args, _options, callback) => {
      if (args.includes('--info=progress2')) {
        const message = "rsync: unrecognized option '--info=progress2'";
        callback(new Error(message), '', message);
      } else if (args.includes('--progress')) {
        const message = "rsync: unrecognized option '--progress'";
        callback(new Error(message), '', message);
      } else {
        callback(null, '', '');
      }
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.rsync).toHaveBeenCalledTimes(3);
    expect(mocks.rsync.mock.calls[2]?.[1]).not.toContain('--progress');
    expect(mocks.rsync.mock.calls[2]?.[1]).not.toContain('--info=progress2');
  });

  // The rsync on macOS rejects -s and --info=progress2 alike, one at a time.
  it('drops both -s and overall progress for an old rsync', async () => {
    mocks.rsync.mockImplementation((_file, args, _options, callback) => {
      const rejected = args.includes('-s')
        ? 'rsync: -s: unknown option'
        : args.includes('--info=progress2')
          ? 'rsync: --info=progress2: unknown option'
          : undefined;
      if (rejected) callback(new Error(rejected), '', rejected);
      else callback(null, '', '');
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.prepare('workspace-1', backend);

    expect(mocks.rsync).toHaveBeenCalledTimes(3);
    const last = mocks.rsync.mock.calls[2];
    expect(last?.[1]).toContain('--progress');
    expect(last?.[1]).toContain("dev@example.com:'/home/dev/work trees/project/'");
    expect(last?.[2]).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ RSYNC_OLD_ARGS: '1' }) })
    );
  });

  it('does not repeat a transfer that failed partway, whatever its errors mention', async () => {
    const message = 'rsync: send_files failed to open "docs/option/info.md": Permission denied';
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error(message), { exitCode: 23 }), '', message);
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await expect(localCopyService.prepare('workspace-1', backend)).rejects.toThrow(
      'Permission denied'
    );

    expect(mocks.rsync).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure that has nothing to do with its options', async () => {
    const message = 'ssh: connect to host example.com port 22: Connection refused';
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error(message), '', message);
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await expect(localCopyService.prepare('workspace-1', backend)).rejects.toThrow(
      'Connection refused'
    );

    expect(mocks.rsync).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent preparations for one workspace', async () => {
    let finish: (() => void) | undefined;
    mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
      finish = () => callback(null, '', '');
    });
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    const first = localCopyService.prepare('workspace-1', backend);
    const second = localCopyService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish?.();
    await Promise.all([first, second]);

    expect(mocks.rsync).toHaveBeenCalledTimes(1);
  });

  it('rejects paths that escape the folder of Local copies', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    expect(() => localCopyService.getLocalCopyPath('../outside', backend)).toThrow(
      'Invalid workspace id for local copy'
    );
  });

  it('adds a numeric suffix when the readable path belongs to another local copy', async () => {
    mocks.existsSync.mockImplementation((path) =>
      String(path).endsWith('/Project-App/agent-local-preview')
    );
    mocks.readFileSync.mockImplementation(() => 'another-workspace');
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    expect(localCopyService.getLocalCopyPath('3e2fc13d-71e2-424c-85cd-3ffb8b9bc86d', backend)).toBe(
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview-2'
    );
  });

  it('reuses its owned numeric path when an earlier collision slot becomes free', async () => {
    mocks.existsSync.mockImplementation((path) => {
      const value = String(path);
      return (
        value.endsWith('/Project-App/agent-local-preview') ||
        value.endsWith('/Project-App/agent-local-preview-3')
      );
    });
    mocks.readFileSync.mockImplementation((path) =>
      String(path).includes('agent-local-preview-3') ? 'workspace-1' : 'another-workspace'
    );
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    expect(localCopyService.getLocalCopyPath('workspace-1', backend)).toBe(
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview-3'
    );
  });

  it('serializes concurrent initialization', async () => {
    let finishMkdir: (() => void) | undefined;
    mocks.mkdir.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishMkdir = resolve;
        })
    );
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    const first = localCopyService.initialize('workspace-1', backend);
    const second = localCopyService.initialize('workspace-1', backend);
    await vi.waitFor(() => expect(finishMkdir).toBeTypeOf('function'));
    finishMkdir?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview',
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview',
    ]);
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
  });

  it('removes a readable local copy discovered from its ownership marker after restart', async () => {
    mocks.existsSync.mockImplementation((path) =>
      String(path).endsWith('/Project-App/agent-local-preview')
    );
    mocks.readFileSync.mockReturnValue('workspace-1');
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await localCopyService.remove('workspace-1', backend);

    expect(mocks.rm).toHaveBeenCalledWith(
      '/tmp/komla-test/local-copies/Project-App/agent-local-preview',
      { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }
    );
  });
  describe('removeLeftovers', () => {
    it('removes copies whose workspace is not kept, and leaves folders it did not make', async () => {
      layOut({
        'Project-App/kept': 'workspace-kept',
        'Project-App/gone': 'workspace-gone',
        'Project-App/unowned': undefined,
        'Other/gone': 'workspace-other-gone',
      });
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      await localCopyService.removeLeftovers((workspaceId) => workspaceId === 'workspace-kept');

      expect(mocks.rm.mock.calls.map(([path]) => path)).toEqual([
        `${LOCAL_COPIES}/Project-App/gone`,
        `${LOCAL_COPIES}/Other/gone`,
      ]);
      expect(mocks.rm).toHaveBeenCalledWith(`${LOCAL_COPIES}/Project-App/gone`, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      // A project folder goes once it is empty; rmdir refuses one that isn't.
      expect(mocks.rmdir).toHaveBeenCalledWith(`${LOCAL_COPIES}/Other`);
    });

    it('leaves a copy whose marker does not name a workspace', async () => {
      layOut({ 'Project-App/odd': '../outside' });
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      await localCopyService.removeLeftovers(() => false);

      expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('does nothing before any local copy exists', async () => {
      mocks.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      await expect(localCopyService.removeLeftovers(() => false)).resolves.toBeUndefined();
      expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('goes on with the rest when one copy cannot be removed', async () => {
      layOut({ 'Project-App/locked': 'workspace-1', 'Project-App/free': 'workspace-2' });
      mocks.rm.mockRejectedValueOnce(new Error('EBUSY'));
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      await localCopyService.removeLeftovers(() => false);

      expect(mocks.rm.mock.calls.map(([path]) => path)).toEqual([
        `${LOCAL_COPIES}/Project-App/locked`,
        `${LOCAL_COPIES}/Project-App/free`,
      ]);
      expect(mocks.logger.warn).toHaveBeenCalled();
    });

    it('leaves a copy being made or synced', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let finish: (() => void) | undefined;
      mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
        finish = () => callback(null, '', '');
      });
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      const preparing = localCopyService.prepare('workspace-1', backend);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await localCopyService.removeLeftovers(() => false);
      finish?.();
      await preparing;

      expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('stops before the next copy once asked to', async () => {
      layOut({ 'Project-App/first': 'workspace-1', 'Project-App/second': 'workspace-2' });
      let stopped = false;
      mocks.rm.mockImplementationOnce(async () => {
        stopped = true;
      });
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');

      await localCopyService.removeLeftovers(
        () => false,
        () => stopped
      );

      expect(mocks.rm.mock.calls.map(([path]) => path)).toEqual([`${LOCAL_COPIES}/Project-App/first`]);
    });

    it("forgets a removed copy's last sync failure", async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
        callback(new Error('host unreachable'), '', '');
      });
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');
      await localCopyService.prepare('workspace-1', backend).catch(() => undefined);
      expect(localCopyService.getSyncStatuses()).toEqual([
        expect.objectContaining({ workspaceId: 'workspace-1', state: 'error' }),
      ]);

      const listener = vi.fn();
      localCopyService.onSyncStatus(listener);

      await localCopyService.removeLeftovers(() => false);

      expect(localCopyService.getSyncStatuses()).toEqual([]);
      expect(listener).toHaveBeenCalledWith({ workspaceId: 'workspace-1', state: 'ready' });
    });

    it('keeps the status of a sync that started while its leftover folder was removed', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let finishRemoval: (() => void) | undefined;
      mocks.rm.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoval = resolve;
          })
      );
      let finishSync: (() => void) | undefined;
      mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
        finishSync = () => callback(null, '', '');
      });
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');

      const sweeping = localCopyService.removeLeftovers(() => false);
      await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'));
      const preparing = localCopyService.prepare('workspace-1', backend);
      finishRemoval?.();
      await sweeping;

      expect(localCopyService.getSyncStatuses()).toEqual([
        { workspaceId: 'workspace-1', state: 'syncing' },
      ]);
      await vi.waitFor(() => expect(finishSync).toBeTypeOf('function'));
      finishSync?.();
      await preparing;
    });

    it('leaves a copy a deletion is removing', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let finishRemoval: (() => void) | undefined;
      mocks.rm.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoval = resolve;
          })
      );
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');

      const deleting = localCopyService.remove('workspace-1', backend);
      await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'));
      await localCopyService.removeLeftovers(() => false);
      finishRemoval?.();
      await deleting;

      expect(mocks.rm).toHaveBeenCalledTimes(1);
    });

    it('leaves a copy until every deletion removing it has finished', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      const finishes: Array<() => void> = [];
      const removal = () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve);
        });
      mocks.rm.mockImplementationOnce(removal).mockImplementationOnce(removal);
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');

      const first = localCopyService.remove('workspace-1', backend);
      const second = localCopyService.remove('workspace-1', backend);
      await vi.waitFor(() => expect(finishes).toHaveLength(2));
      finishes[0]?.();
      await first;
      await localCopyService.removeLeftovers(() => false);
      finishes[1]?.();
      await second;

      expect(mocks.rm).toHaveBeenCalledTimes(2);
    });

    it('syncs a restored copy again when its first sync after the removal failed', async () => {
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');
      await localCopyService.prepare('workspace-1', backend);
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let finishRemoval: (() => void) | undefined;
      mocks.rm.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoval = resolve;
          })
      );
      mocks.rsync.mockImplementation((_file, _args, _options, callback) => {
        callback(new Error('host unreachable'), '', '');
      });

      const sweeping = localCopyService.removeLeftovers(() => false);
      await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'));
      const preparing = localCopyService.prepare('workspace-1', backend).catch(() => undefined);
      finishRemoval?.();
      await Promise.all([sweeping, preparing]);
      mocks.rsync.mockClear();

      localCopyService.ensureInitialSync('workspace-1', backend);

      await vi.waitFor(() => expect(mocks.rsync).toHaveBeenCalled());
    });

    it('removes nothing once stopped while reading an owner marker', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let stopped = false;
      mocks.readFile.mockImplementationOnce(async () => {
        stopped = true;
        return 'workspace-1';
      });
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');

      await localCopyService.removeLeftovers(
        () => false,
        () => stopped
      );

      expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('removes a copy for a deletion only after a removal of its leftover folder', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let finishRemoval: (() => void) | undefined;
      mocks.rm.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoval = resolve;
          })
      );
      const { localCopyService } = await import('../../../src/main/services/local-copy.service');

      const sweeping = localCopyService.removeLeftovers(() => false);
      await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'));
      const deleting = localCopyService.remove('workspace-1', backend);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mocks.rm).toHaveBeenCalledTimes(1);

      finishRemoval?.();
      await Promise.all([sweeping, deleting]);
      expect(mocks.rm).toHaveBeenCalledTimes(2);
    });

    it('makes a copy only after a removal of its leftover folder has finished', async () => {
      layOut({ 'Project-App/agent-local-preview': 'workspace-1' });
      let finishRemoval: (() => void) | undefined;
      mocks.rm.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRemoval = resolve;
          })
      );
      const { localCopyService } =
        await import('../../../src/main/services/local-copy.service');

      const removing = localCopyService.removeLeftovers(() => false);
      await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'));
      const initializing = localCopyService.initialize('workspace-1', backend);
      await Promise.resolve();
      expect(mocks.mkdir).not.toHaveBeenCalled();

      finishRemoval?.();
      await Promise.all([removing, initializing]);
      expect(mocks.mkdir).toHaveBeenCalledWith(`${LOCAL_COPIES}/Project-App/agent-local-preview`, {
        recursive: true,
      });
    });
  });
});

describe.runIf(process.platform === 'win32')('LocalCopyService on Windows', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('refuses to create a local copy', async () => {
    const { localCopyService } = await import('../../../src/main/services/local-copy.service');

    await expect(localCopyService.initialize('workspace-1', backend)).rejects.toThrow(
      'Local copies are not yet supported on Windows'
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
