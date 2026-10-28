import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExecutionLocations,
  type ExecutionLocationDependencies,
} from '../../../src/main/services/execution-location/execution-location';
import { substituteVariables } from '../../../src/main/lib/workspace-launch-variables';
import { resolveLaunchVariables } from '../../../src/main/services/execution-location/launch-variables';

import type { SshHost } from '../../../src/shared/types/ssh';
import type { SshWorkspaceBackend, Workspace } from '../../../src/shared/types/workspace';

const fsControl = vi.hoisted(() => ({ realpathFails: false }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    realpathSync: (path: string) => {
      if (fsControl.realpathFails) throw new Error('realpath unavailable');
      return actual.realpathSync(path);
    },
  };
});
// substituteVariables reads the shell mode from config to detect WSL.
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}) },
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const sshBackend: SshWorkspaceBackend = {
  kind: 'ssh',
  hostId: 'ssh-dev',
  remoteDirectory: '/home/dev/work tree',
  remoteRepoPath: '/home/dev/repo.git',
  remoteProjectRoot: '/home/dev',
} as SshWorkspaceBackend;

describe('execution locations', () => {
  let root: string;
  let workspaceDir: string;
  let localCopyDir: string;
  let wslMode: boolean;

  const pty = {
    spawn: vi.fn(),
    restart: vi.fn(),
    kill: vi.fn(),
    releaseTerminal: vi.fn(),
    releaseTerminalAndWait: vi.fn(() => Promise.resolve()),
  };
  const localCopy = {
    prepare: vi.fn(() => Promise.resolve('prepared')),
    initialize: vi.fn(() => Promise.resolve('initialized')),
    ensureInitialSync: vi.fn(),
  };
  const background = {
    spawn: vi.fn<ExecutionLocationDependencies['background']['spawn']>(),
  };
  const sshHost = { id: 'ssh-dev', name: 'Dev', hostname: 'dev.example' } as SshHost;
  const hosts = { get: vi.fn((): SshHost | undefined => sshHost) };
  const ssh = {
    runStreaming: vi.fn<ExecutionLocationDependencies['ssh']['runStreaming']>(async () => 0),
    komlaCliSetup: (backend: SshWorkspaceBackend) => [
      `export KOMLA_CLI=/srv/${backend.hostId}/komla`,
    ],
  };
  const ready = { kind: 'ready' as const, state: {} as never };
  const managedSessions = {
    create: vi.fn(() => ({
      terminalId: 't',
      initialState: {} as never,
      ready: Promise.resolve(ready),
    })),
    reconnect: vi.fn(() => ready),
    replace: vi.fn(() => Promise.resolve(ready)),
    stop: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  };
  const dependencies: ExecutionLocationDependencies = {
    getLocalCopyPath: () => localCopyDir,
    prepareLocalCopy: localCopy.prepare,
    initializeLocalCopy: localCopy.initialize,
    ensureLocalCopyInitialSync: localCopy.ensureInitialSync,
    isWslMode: () => wslMode,
    windowsPathToWsl: (path) => `/mnt/wsl${path}`,
    pty,
    background,
    managedSessions,
    hosts,
    ssh,
  };
  const locations = createExecutionLocations(dependencies);
  const originalPlatform = process.platform;

  const localWorkspace = (overrides: Partial<Workspace> = {}): Workspace =>
    ({
      id: 'ws-local',
      name: 'Local',
      workingDirectory: workspaceDir,
      terminals: [],
      ...overrides,
    }) as Workspace;

  const sshWorkspace = (overrides: Partial<Workspace> = {}): Workspace =>
    localWorkspace({
      id: 'ws-ssh',
      workingDirectory: 'ssh://ssh-dev/home/dev/work tree',
      backend: sshBackend,
      ...overrides,
    });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'komla-execution-location-')));
    workspaceDir = join(root, 'workspace');
    mkdirSync(workspaceDir);
    localCopyDir = join(root, 'mirrors', 'ws-ssh');
    wslMode = false;
  });

  afterEach(() => {
    fsControl.realpathFails = false;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    rmSync(root, { recursive: true, force: true });
  });

  describe('resolve', () => {
    it('rejects a Local copy location for a local workspace', () => {
      expect(() => locations.resolve(localWorkspace(), 'local-mirror')).toThrow(
        'Local terminals require an SSH workspace'
      );
    });

    it('reports a Managed Remote Terminal Session only for SSH Workspace repository execution', () => {
      expect(locations.managesSession(localWorkspace())).toBe(false);
      expect(locations.managesSession(sshWorkspace())).toBe(true);
      expect(locations.managesSession(sshWorkspace(), 'workspace')).toBe(true);
      expect(locations.managesSession(sshWorkspace(), 'local-mirror')).toBe(false);
      expect(locations.resolve(sshWorkspace()).managesSession).toBe(true);
      expect(locations.resolve(sshWorkspace(), 'local-mirror').managesSession).toBe(false);
      expect(locations.resolve(localWorkspace()).managesSession).toBe(false);
    });
  });

  describe('Terminal execution on this computer', () => {
    const attached = (workspace: Workspace, location?: 'workspace' | 'local-mirror') => {
      const resolved = locations.resolve(workspace, location);
      if (resolved.managesSession) throw new Error('expected attached execution');
      return resolved;
    };
    const command = { command: 'npm test' };

    it('spawns a local Workspace repository Terminal in its working directory', () => {
      const releaseStartSlot = vi.fn();

      attached(localWorkspace()).spawn({
        workspaceId: 'ws-local',
        terminalId: 'term-1',
        command,
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
      });

      expect(pty.spawn).toHaveBeenCalledWith('term-1', workspaceDir, 'npm test');
      expect(releaseStartSlot).toHaveBeenCalledTimes(1);
      expect(localCopy.ensureInitialSync).not.toHaveBeenCalled();
    });

    it('releases the start slot and skips the Local copy sync when spawning fails', () => {
      pty.spawn.mockImplementationOnce(() => {
        throw new Error('invalid cwd');
      });
      const releaseStartSlot = vi.fn();

      expect(() =>
        attached(sshWorkspace(), 'local-mirror').spawn({
          workspaceId: 'ws-ssh',
          terminalId: 'term-1',
          command: { command: 'npm test' },
          keepShellOpenAfterCommand: false,
          releaseStartSlot,
        })
      ).toThrow('invalid cwd');
      expect(releaseStartSlot).toHaveBeenCalledTimes(1);
      expect(localCopy.ensureInitialSync).not.toHaveBeenCalled();
    });

    it('spawns and restarts Local copy Terminals in the Local copy, then starts its sync', () => {
      const location = attached(sshWorkspace(), 'local-mirror');
      const releaseStartSlot = vi.fn();

      location.spawn({
        workspaceId: 'ws-ssh',
        terminalId: 'term-1',
        command: { command: 'npm test' },
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
      });
      location.restart({
        workspaceId: 'ws-ssh',
        terminalId: 'term-1',
        command: { command: 'npm run dev' },
        cols: 120,
        rows: 40,
        releaseStartSlot,
      });

      expect(pty.spawn).toHaveBeenCalledWith('term-1', localCopyDir, 'npm test');
      expect(pty.restart).toHaveBeenCalledWith(
        'term-1',
        localCopyDir,
        'npm run dev',
        'ws-ssh',
        120,
        40
      );
      expect(releaseStartSlot).toHaveBeenCalledTimes(2);
      expect(localCopy.ensureInitialSync).toHaveBeenCalledTimes(2);
    });

    it('prepares a Local copy for a command and only initializes it for a shell', async () => {
      const location = attached(sshWorkspace(), 'local-mirror');

      await expect(location.prepare?.('npm test')).resolves.toBeUndefined();
      await expect(location.prepare?.('  ')).resolves.toBeUndefined();

      expect(localCopy.prepare).toHaveBeenCalledTimes(1);
      expect(localCopy.initialize).toHaveBeenCalledTimes(1);
      expect(attached(localWorkspace()).prepare).toBeUndefined();
    });

    it('stops and releases local Terminals synchronously', () => {
      const location = attached(localWorkspace());

      expect(location.stop('term-1')).toBeUndefined();
      expect(location.release('term-1')).toBeUndefined();
      expect(pty.kill).toHaveBeenCalledWith('term-1');
      expect(pty.releaseTerminal).toHaveBeenCalledWith('term-1');
    });
  });

  describe('Managed Remote Terminal Sessions', () => {
    const managed = () => {
      const resolved = locations.resolve(sshWorkspace());
      if (!resolved.managesSession) throw new Error('expected managed execution');
      return resolved;
    };
    const restartRequest = {
      workspaceId: 'ws-ssh',
      terminalId: 'term-1',
      command: { command: 'claude' },
      keepShellOpenAfterCommand: true,
      cols: 100,
      rows: 30,
      releaseStartSlot: () => undefined,
      onAuthorized: () => undefined,
    };
    const lifecycleRequest = {
      terminalId: 'term-1',
      command: 'claude',
      keepShellOpenAfterCommand: true,
      cols: 100,
      rows: 30,
      releaseStartSlot: restartRequest.releaseStartSlot,
      onAuthorized: restartRequest.onAuthorized,
    };

    it('creates a managed session for a new Terminal', () => {
      const releaseStartSlot = vi.fn();

      managed().spawn({
        workspaceId: 'ws-ssh',
        terminalId: 'term-1',
        command: { command: 'claude' },
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
      });

      expect(managedSessions.create).toHaveBeenCalledWith({
        workspaceId: 'ws-ssh',
        terminalId: 'term-1',
        command: 'claude',
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
      });
      expect(pty.spawn).not.toHaveBeenCalled();
    });

    it('reconnects or replaces the managed session', async () => {
      expect(managed().reconnect(restartRequest)).toBe(ready);
      await expect(managed().replace({ ...restartRequest, explicit: true })).resolves.toBe(ready);

      expect(managedSessions.reconnect).toHaveBeenCalledWith(lifecycleRequest);
      expect(managedSessions.replace).toHaveBeenCalledWith({ ...lifecycleRequest, explicit: true });
    });

    it('confirms that stopping and releasing reached the remote session', async () => {
      await managed().stop('term-1');
      await managed().release('term-1');

      expect(managedSessions.stop).toHaveBeenCalledWith({ terminalId: 'term-1' });
      expect(managedSessions.release).toHaveBeenCalledWith({ terminalId: 'term-1' });
      expect(pty.kill).not.toHaveBeenCalled();
    });

    it('passes through skipping remote sessions already seen to stop', async () => {
      await managed().stop('term-1', { skipTrackedAbsentSession: true });

      expect(managedSessions.stop).toHaveBeenCalledWith(
        { terminalId: 'term-1' },
        { skipTrackedAbsentSessions: true }
      );
    });

    it.each(['stop', 'release'] as const)(
      'reports that the remote agent may still be running when %s is unconfirmed',
      async (action) => {
        managedSessions[action].mockImplementationOnce(() =>
          Promise.reject(new Error('host unreachable'))
        );

        await expect(managed()[action]('term-1')).rejects.toThrow(
          'Could not confirm the remote agent stopped; it may still be running. Error: host unreachable'
        );
      }
    );
  });

  describe('workspace teardown', () => {
    const terminals = () =>
      [
        { id: 'remote-1' },
        { id: 'copy-1', executionLocation: 'local-mirror' },
        { id: 'remote-2', executionLocation: 'workspace' },
      ] as Workspace['terminals'];

    it('stops and releases every managed session of an SSH workspace', async () => {
      const workspace = sshWorkspace({ terminals: terminals() });

      await locations.stopSessions(workspace);
      await locations.releaseSessions(workspace, { skipRemoteConfirmation: true });

      expect(managedSessions.stop).toHaveBeenCalledWith({ workspaceId: 'ws-ssh' });
      expect(managedSessions.release).toHaveBeenCalledWith(
        { workspaceId: 'ws-ssh' },
        { skipRemoteConfirmation: true }
      );
      expect(pty.kill).not.toHaveBeenCalled();
      expect(pty.releaseTerminalAndWait).not.toHaveBeenCalled();
    });

    it('passes managed session failures through unchanged', async () => {
      managedSessions.stop.mockImplementationOnce(() =>
        Promise.reject(new Error('host unreachable'))
      );

      await expect(locations.stopSessions(sshWorkspace())).rejects.toThrow('host unreachable');
    });

    it('has no managed sessions to stop or release for a local workspace', async () => {
      await locations.stopSessions(localWorkspace());
      await locations.releaseSessions(localWorkspace());

      expect(managedSessions.stop).not.toHaveBeenCalled();
      expect(managedSessions.release).not.toHaveBeenCalled();
    });

    it('stops and releases only Local copy Terminals of an SSH workspace', async () => {
      const workspace = sshWorkspace({ terminals: terminals() });

      expect(locations.stopAttached(workspace).map((terminal) => terminal.id)).toEqual(['copy-1']);
      await locations.releaseAttached(workspace);

      expect(pty.kill.mock.calls).toEqual([['copy-1']]);
      expect(pty.releaseTerminalAndWait.mock.calls).toEqual([['copy-1']]);
    });

    it('stops and releases every Terminal of a local workspace', async () => {
      const workspace = localWorkspace({
        terminals: [{ id: 'term-1' }, { id: 'term-2' }] as Workspace['terminals'],
      });

      expect(locations.stopAttached(workspace)).toEqual(workspace.terminals);
      await locations.releaseAttached(workspace);

      expect(pty.kill.mock.calls).toEqual([['term-1'], ['term-2']]);
      expect(pty.releaseTerminalAndWait.mock.calls).toEqual([['term-1'], ['term-2']]);
    });
  });

  describe('SSH Workspace repository', () => {
    it('expands launch variables for the remote posix shell', () => {
      const location = locations.resolve(sshWorkspace());

      expect(location.shellFamily).toBe('posix');
      expect(location.buildCommand('codex --cd "{{workspacePath}}"')).toEqual({
        command: "codex --cd '/home/dev/work tree'",
      });
    });

    it('trusts the Antigravity working directory the remote shell reports', () => {
      expect(
        locations
          .resolve(sshWorkspace())
          .buildCommand('agy {{antigravityAutoTrustArgs}} --continue')
      ).toEqual({ command: 'agy --add-dir "$PWD" --continue' });
    });
  });

  describe('Local copy', () => {
    it('canonicalizes a not-yet-created Local copy through its existing parent', () => {
      const linkedRoot = join(root, 'linked');
      symlinkSync(root, linkedRoot);
      localCopyDir = join(linkedRoot, 'mirrors', 'ws-ssh');
      const location = locations.resolve(sshWorkspace(), 'local-mirror');

      expect(location.shellFamily).toBe('desktop');
      expect(location.buildCommand('codex --cd "{{workspacePath}}"')).toEqual({
        command: `codex --cd '${join(root, 'mirrors', 'ws-ssh')}'`,
      });
    });
  });

  describe('local Workspace repository', () => {
    const build = (
      command: string | null,
      options?: Parameters<ReturnType<typeof locations.resolve>['buildCommand']>[1],
      overrides: Partial<Workspace> = {}
    ) => locations.resolve(localWorkspace(overrides)).buildCommand(command, options);

    it('expands launch variables', () => {
      expect(build('codex --cd "{{workspacePath}}"')).toEqual({
        command: `codex --cd '${workspaceDir}'`,
      });
    });

    it('trusts the Antigravity working directory the launch shell reports', () => {
      expect(build('agy {{antigravityAutoTrustArgs}} --continue')).toEqual({
        command: 'agy --add-dir "$PWD" --continue',
      });
    });

    it('falls back to the configured path when no ancestor can be canonicalized', () => {
      fsControl.realpathFails = true;

      expect(build('cd "{{workspacePath}}"')).toEqual({
        command: `cd '${workspaceDir}'`,
      });
    });

    it('escapes the typographic quotes PowerShell ends strings at', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const branchName = 'a‘b”c$d';
      const substitute = (template: string) =>
        substituteVariables(template, { branchName }, { shellEscape: true });
      expect(substitute('git switch {{branchName}}')).toBe(`git switch 'a‘‘b”c$d'`);
      expect(substitute("git switch '{{branchName}}'")).toBe(`git switch 'a‘‘b”c$d'`);
      expect(substitute('echo "on {{branchName}}"')).toBe('echo "on a‘b`”c`$d"');
      expect(substitute("echo 'on {{branchName}}'")).toBe("echo 'on a‘‘b”c$d'");
      // Templates can open and close strings with typographic quotes too.
      expect(substitute('git switch ‘{{branchName}}’')).toBe(`git switch 'a‘‘b”c$d'`);
      expect(substitute('echo “on {{branchName}}”')).toBe('echo “on a‘b`”c`$d”');
      expect(substitute('echo ‘on {{branchName}}’')).toBe('echo ‘on a‘‘b”c$d’');
    });

    it('trusts the Antigravity working directory PowerShell reports without canonicalizing', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const workspacePath = vi.fn(() => 'C:\\resolved');

      expect(
        resolveLaunchVariables('agy {{antigravityAutoTrustArgs}}', workspacePath, 'desktop')
      ).toBe('agy --add-dir $PWD.ProviderPath');
      expect(workspacePath).not.toHaveBeenCalled();
    });

    it('uses the WSL-visible path in launch variables', () => {
      wslMode = true;

      expect(build('cd "{{workspacePath}}"')).toEqual({
        command: `cd '/mnt/wsl${workspaceDir}'`,
      });
    });

    it('runs host commands as given', () => {
      expect(build('npm install', { commandKind: 'host' })).toEqual({ command: 'npm install' });
    });

    it('opens an empty shell for host-shell', () => {
      expect(build('npm test', { commandKind: 'host-shell' })).toEqual({ command: null });
    });
  });

  describe('background runs', () => {
    const handlers = () => ({ onData: vi.fn(), onExit: vi.fn(), onError: vi.fn() });

    it('spawns in the local Workspace repository', () => {
      const run = locations
        .resolve(localWorkspace())
        .runBackground({ name: 'Lint', command: 'npm run lint', ...handlers() });

      expect(run.cancel).toBeUndefined();
      expect(background.spawn.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        ['ws-local', 'npm run lint', workspaceDir, 'Lint'],
      ]);
    });

    it('reports the local exit code', () => {
      const request = { name: 'Install', command: 'npm ci', ...handlers() };
      locations.resolve(localWorkspace()).runBackground(request);

      background.spawn.mock.calls[0][4].onData('installing');
      background.spawn.mock.calls[0][4].onExit({ exitCode: 2 });

      expect(request.onData).toHaveBeenCalledWith('installing');
      expect(request.onExit).toHaveBeenCalledWith(2);
    });

    it('spawns in the Local copy', () => {
      locations.resolve(sshWorkspace(), 'local-mirror').runBackground({
        name: 'Install',
        command: 'npm ci',
        ...handlers(),
      });

      expect(background.spawn.mock.calls[0].slice(0, 4)).toEqual([
        'ws-ssh',
        'npm ci',
        localCopyDir,
        'Install',
      ]);
    });

    it('streams a cancellable run in the SSH Workspace repository, able to run komla', async () => {
      let finish: (() => void) | undefined;
      ssh.runStreaming.mockImplementationOnce(
        (_host, _command, options) =>
          new Promise((resolve, reject) => {
            finish = () => resolve(0);
            options?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
      );
      const request = { name: 'Install', command: 'npm ci', ...handlers() };

      const run = locations.resolve(sshWorkspace()).runBackground(request);

      expect(ssh.runStreaming).toHaveBeenCalledWith(
        sshHost,
        [
          "cd '/home/dev/work tree' || exit $?",
          'export KOMLA_CLI=/srv/ssh-dev/komla',
          "export KOMLA_WORKSPACE_ID='ws-ssh'",
          'npm ci',
        ].join('\n'),
        expect.objectContaining({ workspaceId: 'ws-ssh' })
      );
      const options = ssh.runStreaming.mock.calls[0][2]!;
      options.onData!('out');
      options.onErrorData!('err');
      expect(request.onData.mock.calls).toEqual([['out'], ['err']]);
      expect(background.spawn).not.toHaveBeenCalled();

      await run.cancel!();
      expect(request.onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
      expect(request.onExit).not.toHaveBeenCalled();
      finish?.();
    });

    it('reports a successful SSH run as exit code 0', async () => {
      const request = { name: 'Install', command: 'npm ci', ...handlers() };

      await locations.resolve(sshWorkspace()).runBackground(request).cancel!();

      expect(request.onExit).toHaveBeenCalledWith(0);
    });

    it('cannot start on an unconfigured SSH host', () => {
      hosts.get.mockReturnValueOnce(undefined);

      expect(() =>
        locations
          .resolve(sshWorkspace())
          .runBackground({ name: 'Install', command: 'npm ci', ...handlers() })
      ).toThrow('SSH host ssh-dev is not configured');
    });
  });
});
