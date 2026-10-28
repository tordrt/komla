import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  mkdir: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
  writeFile: vi.fn(() => Promise.resolve()),
  readdir: vi.fn(() => Promise.resolve([])),
  readFile: vi.fn(() => Promise.resolve('')),
  ensureWorkspaceReady: vi.fn(() => Promise.resolve()),
  getRsyncTransport: vi.fn(() => ({
    remoteTarget: 'dev@example.com',
    remoteShell: "ssh '-p' '2222'",
  })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('fs', () => ({ existsSync: mocks.existsSync, readFileSync: mocks.readFileSync }));
vi.mock('fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  readdir: mocks.readdir,
  readFile: mocks.readFile,
}));
// Mirrors can contain node_modules/electron's .asar files, which only the
// shared remover deletes correctly inside Electron.
vi.mock('../../../src/main/lib/remove-path', () => ({ removePath: mocks.rm }));
vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/tmp/komla-test',
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    ensureWorkspaceReady: mocks.ensureWorkspaceReady,
    getRsyncTransport: mocks.getRsyncTransport,
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

// Local copies aren't supported on Windows, where initializeMirror refuses, so these run on
// macOS and Linux.
describe.skipIf(process.platform === 'win32')('LocalMirrorService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.execFile.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.readFileSync.mockReset();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('keeps per-request sync traces out of info diagnostics', async () => {
    vi.stubEnv('KOMLA_DIAGNOSTICS', '1');
    const finishes: Array<() => void> = [];
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() => callback(null, '', ''));
    });
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    localMirrorService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localMirrorService.requestSync('workspace-1', backend);
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
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    expect(localMirrorService.hasMirror('workspace-1', backend)).toBe(false);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('recognizes an existing copy after restart', async () => {
    const mirrorPath = '/tmp/komla-test/mirrors/Project-App/agent-local-preview';
    mocks.existsSync.mockImplementation((path) => String(path) === mirrorPath);
    mocks.readFileSync.mockImplementation((path) =>
      String(path) === `${mirrorPath}/.komla-local-mirror` ? 'workspace-1' : undefined
    );
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    expect(localMirrorService.hasMirror('workspace-1', backend)).toBe(true);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("does not sync another workspace's copy", async () => {
    mocks.existsSync.mockImplementation(
      (path) => String(path) === '/tmp/komla-test/mirrors/Project-App/agent-local-preview'
    );
    mocks.readFileSync.mockReturnValue('another-workspace');
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    expect(localMirrorService.hasMirror('workspace-1', backend)).toBe(false);
  });

  it('recognizes a copy being initialized on demand', async () => {
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    const initialization = localMirrorService.initialize('workspace-1', backend);
    expect(localMirrorService.hasMirror('workspace-1', backend)).toBe(true);
    await initialization;
  });

  it('protects files matched by project gitignore rules', async () => {
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    await localMirrorService.prepare('workspace-1', backend);

    expect(mocks.ensureWorkspaceReady).not.toHaveBeenCalled();
    expect(mocks.mkdir).toHaveBeenCalledWith(
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview',
      { recursive: true }
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview/.komla-local-mirror',
      'workspace-1',
      'utf8'
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      'rsync',
      expect.arrayContaining([
        '-s',
        '--omit-dir-times',
        '--delete-after',
        '--safe-links',
        '--exclude=/.git',
        '--exclude=/.komla-local-mirror',
        '--exclude=/.komla-files',
        '--filter=:- .gitignore',
        'dev@example.com:/home/dev/work trees/project/',
        '/tmp/komla-test/mirrors/Project-App/agent-local-preview/',
      ]),
      expect.objectContaining({ timeout: 300_000 }),
      expect.any(Function)
    );
  });

  it('does not rewrite the watched remote repository during local copy syncs', async () => {
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    await localMirrorService.prepare('workspace-1', backend);
    localMirrorService.requestSync('workspace-1', backend);
    await localMirrorService.prepare('workspace-1', backend);

    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    // Provisioning rewrites shared Git config, causing another watcher snapshot and sync.
    expect(mocks.ensureWorkspaceReady).not.toHaveBeenCalled();
    expect(localMirrorService.getSyncStatuses()).toEqual([]);
  });

  it('can initialize an empty local copy without starting a sync', async () => {
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    const mirrorPath = await localMirrorService.initialize('workspace-1', backend);

    expect(mirrorPath).toBe('/tmp/komla-test/mirrors/Project-App/agent-local-preview');
    expect(mocks.mkdir).toHaveBeenCalledWith(
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview',
      { recursive: true }
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceReady).not.toHaveBeenCalled();
  });

  it('reports one continuous busy period while a requested resync is queued', async () => {
    const finishes: Array<() => void> = [];
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() => callback(null, '', ''));
    });
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');
    const states: string[] = [];
    localMirrorService.onSyncStatus((status) => states.push(status.state));

    localMirrorService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localMirrorService.requestSync('workspace-1', backend);

    finishes[0]?.();
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    expect(states).toEqual(['syncing']);

    finishes[1]?.();
    await vi.waitFor(() => expect(states).toEqual(['syncing', 'ready']));
  });

  it('waits for a queued resync before completing preparation', async () => {
    const finishes: Array<() => void> = [];
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      finishes.push(() => callback(null, '', ''));
    });
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    localMirrorService.requestSync('workspace-1', backend);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    localMirrorService.requestSync('workspace-1', backend);
    let prepared = false;
    const preparation = localMirrorService.prepare('workspace-1', backend).then(() => {
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
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    localMirrorService.ensureInitialSync('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));

    localMirrorService.ensureInitialSync('workspace-1', backend);
    await Promise.resolve();

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('is current only while its latest sync succeeded', async () => {
    let finishSync: (error: Error | null) => void = () => undefined;
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      finishSync = (error) => callback(error, '', error?.message ?? '');
    });
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');
    expect(localMirrorService.isCurrent('workspace-1')).toBe(false);

    const first = localMirrorService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));
    expect(localMirrorService.isCurrent('workspace-1')).toBe(false);
    finishSync(null);
    await first;
    expect(localMirrorService.isCurrent('workspace-1')).toBe(true);

    const second = localMirrorService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(2));
    expect(localMirrorService.isCurrent('workspace-1')).toBe(false);
    finishSync(new Error('connection lost'));
    await expect(second).rejects.toThrow('connection lost');
    expect(localMirrorService.isCurrent('workspace-1')).toBe(false);
  });

  it('reports background sync failures and allows the initial sync to retry', async () => {
    mocks.execFile
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(new Error('connection lost'), '', 'connection lost');
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, '', '');
      });
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');
    const statuses: Array<{ state: string; message?: string }> = [];
    localMirrorService.onSyncStatus((status) => statuses.push(status));

    localMirrorService.ensureInitialSync('workspace-1', backend);
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

    localMirrorService.ensureInitialSync('workspace-1', backend);
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ workspaceId: 'workspace-1', state: 'ready' })
    );
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it.each(['rsync: invalid option -- s', 'rsync: -s: unknown option'])(
    'falls back to legacy remote-path quoting for %s',
    async (message) => {
      mocks.execFile.mockImplementation((_file, args, _options, callback) => {
        if (args.includes('-s')) {
          callback(new Error(message), '', message);
          return;
        }
        callback(null, '', '');
      });
      const { localMirrorService } =
        await import('../../../src/main/services/local-mirror.service');

      await localMirrorService.prepare('workspace-1', backend);

      expect(mocks.execFile).toHaveBeenCalledTimes(2);
      expect(mocks.execFile.mock.calls[1]?.[1]).not.toContain('-s');
      expect(mocks.execFile.mock.calls[1]?.[1]).toContain(
        "dev@example.com:'/home/dev/work trees/project/'"
      );
      expect(mocks.execFile.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ RSYNC_OLD_ARGS: '1', RSYNC_PROTECT_ARGS: '0' }),
        })
      );
    }
  );

  it('coalesces concurrent preparations for one workspace', async () => {
    let finish: (() => void) | undefined;
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      finish = () => callback(null, '', '');
    });
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    const first = localMirrorService.prepare('workspace-1', backend);
    const second = localMirrorService.prepare('workspace-1', backend);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish?.();
    await Promise.all([first, second]);

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('rejects mirror paths that escape the Komla mirror root', async () => {
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    expect(() => localMirrorService.getMirrorPath('../outside', backend)).toThrow(
      'Invalid workspace id for local copy'
    );
  });

  it('adds a numeric suffix when the readable path belongs to another mirror', async () => {
    mocks.existsSync.mockImplementation((path) =>
      String(path).endsWith('/Project-App/agent-local-preview')
    );
    mocks.readFileSync.mockImplementation(() => 'another-workspace');
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    expect(localMirrorService.getMirrorPath('3e2fc13d-71e2-424c-85cd-3ffb8b9bc86d', backend)).toBe(
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview-2'
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
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    expect(localMirrorService.getMirrorPath('workspace-1', backend)).toBe(
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview-3'
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
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    const first = localMirrorService.initialize('workspace-1', backend);
    const second = localMirrorService.initialize('workspace-1', backend);
    await vi.waitFor(() => expect(finishMkdir).toBeTypeOf('function'));
    finishMkdir?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview',
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview',
    ]);
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
  });

  it('removes a readable mirror discovered from its ownership marker after restart', async () => {
    mocks.existsSync.mockImplementation((path) =>
      String(path).endsWith('/Project-App/agent-local-preview')
    );
    mocks.readFileSync.mockReturnValue('workspace-1');
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    await localMirrorService.remove('workspace-1', backend);

    expect(mocks.rm).toHaveBeenCalledWith(
      '/tmp/komla-test/mirrors/Project-App/agent-local-preview',
      { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }
    );
  });
});

describe.runIf(process.platform === 'win32')('LocalMirrorService on Windows', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('refuses to create a local copy', async () => {
    const { localMirrorService } = await import('../../../src/main/services/local-mirror.service');

    await expect(localMirrorService.initialize('workspace-1', backend)).rejects.toThrow(
      'Local copies are not yet supported on Windows'
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
