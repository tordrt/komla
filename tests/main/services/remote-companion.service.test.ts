import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {},
}));

import {
  RemoteCompanionService,
  resolveRemoteCompanionTarget,
} from '../../../src/main/services/remote-companion.service';

import type { SshHost } from '../../../src/shared/types';

const host = { id: 'host-1', hostname: 'example.test' } as SshHost;

describe('RemoteCompanionService', () => {
  it('maps the supported remote operating systems and architectures', () => {
    expect(resolveRemoteCompanionTarget('Linux', 'x86_64')).toBe('x86_64-unknown-linux-musl');
    expect(resolveRemoteCompanionTarget('Linux', 'aarch64')).toBe('aarch64-unknown-linux-musl');
    expect(resolveRemoteCompanionTarget('Darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(resolveRemoteCompanionTarget('Windows_NT', 'x86_64')).toBeUndefined();
  });

  it('uploads to an immutable content-addressed path and reuses it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    let binaryPresent = false;
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes('] &&') && command.includes(' version || true')) {
        return binaryPresent ? 'installed\n' : '';
      }
      if (command.includes('temp_cli_link')) binaryPresent = true;
      return '';
    });
    const upload = vi.fn().mockResolvedValue('');
    const installed = vi.fn();
    const service = new RemoteCompanionService({
      resourceRoot: () => root,
      run,
      upload,
      installed,
    });

    const first = await service.ensureInstalled(host, '/home/dev/.komla');
    const second = await service.ensureInstalled(host, '/home/dev/.komla');

    expect(first).toBe(second);
    // Each caller that finds it tells the SSH Exec Channel, which reopens with it after a host edit.
    expect(installed.mock.calls).toEqual([
      [host, first],
      [host, first],
    ]);
    expect(first).toMatch(/^\/home\/dev\/\.komla\/helpers\/bin\/protocol-1\/[a-f0-9]{64}\/komla$/);
    expect(upload).toHaveBeenCalledOnce();
    rmSync(root, { recursive: true, force: true });
  });

  it('reinstalls a cached helper after the host runtime is invalidated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-reinstall-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    let binaryPresent = false;
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes('] &&') && command.includes(' version || true')) {
        return binaryPresent ? 'installed\n' : '';
      }
      if (command.includes('temp_cli_link')) binaryPresent = true;
      return '';
    });
    const upload = vi.fn().mockResolvedValue('');
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });

    await service.ensureInstalled(host, '/home/dev/.komla');
    binaryPresent = false;
    service.invalidateHost(host.id);
    await service.ensureInstalled(host, '/home/dev/.komla');

    expect(upload).toHaveBeenCalledTimes(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the platform it found when an upload fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-retry-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const run = vi.fn(async (_host: SshHost, command: string) =>
      command.includes('uname -s') ? 'Linux\nx86_64\n' : ''
    );
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue('');
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });

    await expect(service.ensureInstalled(host, '/home/dev/.komla')).rejects.toThrow(
      'connection reset'
    );
    await service.ensureInstalled(host, '/home/dev/.komla');

    expect(run.mock.calls.filter(([, command]) => command.includes('uname -s'))).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  // Runs the host's install script, which links the helper, in a real POSIX shell.
  it.skipIf(process.platform === 'win32')(
    'links an installed helper in the round trip that finds it',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-companion-linked-'));
      const remoteBase = join(root, 'remote');
      const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
      mkdirSync(join(artifact, '..'), { recursive: true });
      writeFileSync(artifact, 'binary');
      const run = vi.fn(async (_host: SshHost, command: string) =>
        command.includes('uname -s')
          ? 'Linux\nx86_64\n'
          : execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      );
      const upload = vi.fn().mockResolvedValue('');
      const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });

      try {
        const detected = service.detectPlatform(host);
        const installedPath = join(
          remoteBase,
          'helpers/bin/protocol-1',
          createHash('sha256').update('binary').digest('hex'),
          'komla'
        );
        mkdirSync(dirname(installedPath), { recursive: true });
        writeFileSync(installedPath, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });

        await expect(service.ensureInstalled(host, remoteBase)).resolves.toBe(installedPath);

        await expect(detected).resolves.toEqual(['Linux', 'x86_64']);
        expect(run).toHaveBeenCalledTimes(2);
        expect(upload).not.toHaveBeenCalled();
        expect(readlinkSync(join(remoteBase, 'helpers/komla'))).toBe(installedPath);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  // Runs the host's install script, which links the helper, in a real POSIX shell.
  it.skipIf(process.platform === 'win32')(
    'links a new helper in the round trip that uploads it',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-companion-uploaded-'));
      const remoteBase = join(root, 'remote');
      const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
      mkdirSync(join(artifact, '..'), { recursive: true });
      writeFileSync(artifact, '#!/bin/sh\necho 1.0.0\n');
      const run = vi.fn(async (_host: SshHost, command: string) =>
        command.includes('uname -s')
          ? 'Linux\nx86_64\n'
          : execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      );
      const upload = vi.fn(async (_host: SshHost, command: string, sourcePath: string) =>
        execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          input: readFileSync(sourcePath),
        })
      );
      const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });

      try {
        const installedPath = await service.ensureInstalled(host, remoteBase);

        expect(upload).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledTimes(2);
        expect(readlinkSync(join(remoteBase, 'helpers/komla'))).toBe(installedPath);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('knows the helper it installed without installing one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-installed-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const run = vi.fn(async (_host: SshHost, command: string) =>
      command.includes('uname -s') ? 'Linux\nx86_64\n' : ''
    );
    const upload = vi.fn().mockResolvedValue('');
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });

    expect(service.installedPath(host, '/home/dev/.komla')).toBeUndefined();
    const installed = await service.ensureInstalled(host, '/home/dev/.komla');
    await expect(service.installedPath(host, '/home/dev/.komla')).resolves.toBe(installed);
    service.invalidateHost(host.id);
    expect(service.installedPath(host, '/home/dev/.komla')).toBeUndefined();
    expect(upload).toHaveBeenCalledOnce();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when the companion artifact is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-missing-'));
    const run = vi.fn().mockResolvedValue('Linux\nx86_64\n');
    const service = new RemoteCompanionService({
      resourceRoot: () => root,
      run,
      upload: vi.fn(),
    });

    await expect(service.ensureInstalled(host, '/home/dev/.komla')).rejects.toThrow(
      `Komla Remote Companion artifact is missing for x86_64-unknown-linux-musl at ${join(
        root,
        'x86_64-unknown-linux-musl',
        'komla'
      )}`
    );
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['0', '1'])(
    'configures companion resources with diagnostics=%s and without tunnel credentials',
    async (diagnostics) => {
      vi.stubEnv('KOMLA_DIAGNOSTICS', diagnostics);
      const root = mkdtempSync(join(tmpdir(), 'komla-companion-runtime-'));
      const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
      mkdirSync(join(artifact, '..'), { recursive: true });
      writeFileSync(artifact, 'binary');
      const configs: Array<Record<string, unknown>> = [];
      const run = vi.fn(async (_host: SshHost, command: string) => {
        if (command.includes('uname -s')) return 'Linux\nx86_64\n';
        if (command.includes('] &&') && command.includes(' version || true')) return 'installed\n';
        return '';
      });
      const upload = vi.fn(async (_host: SshHost, command: string, sourcePath: string) => {
        if (command.includes('companion/')) {
          configs.push(JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>);
        }
        return '';
      });
      const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });
      const options = {
        remoteBasePath: '/home/dev/.komla',
        endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
        workspaces: [{ workspaceId: 'workspace-1', workingTree: '/repo', targetBranch: 'main' }],
      };

      await service.ensureRunning(host, { ...options, installationId: 'installation-a' });
      await service.ensureRunning(host, { ...options, installationId: 'installation-b' });

      expect(configs).toHaveLength(2);
      expect(configs[0]?.hookInbox).not.toBe(configs[1]?.hookInbox);
      expect(configs[0]?.tmuxSocket).not.toBe(configs[1]?.tmuxSocket);
      const commands = run.mock.calls.map(([, command]) => command);
      for (const config of configs) {
        expect(config).not.toHaveProperty('tokenFile');
        expect(config.hookInbox).toMatch(/\/helpers\/companion\/[a-f0-9]{16}\/inbox$/);
        expect(config.tmuxSocket).toMatch(/^komla-companion-[a-f0-9]{16}$/);
        expect(config.startupGraceSeconds).toBe(180);
        expect(config.diagnostics).toBe(diagnostics === '1');
      }
      expect(commands.join('\n')).not.toContain('data-tunnel-token');
      expect(commands.join('\n')).toContain("stable='/home/dev/.komla/helpers/komla'");
      expect(commands.join('\n')).toContain('ln -s "$versioned" "$temp_link"');
      rmSync(root, { recursive: true, force: true });
    }
  );

  it('changes the remote session identity for a binary upgrade with unchanged workspaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-upgrade-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    const identities: string[] = [];
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes(' version || true')) return 'installed\n';
      return '';
    });
    const upload = vi.fn(async (_host: SshHost, command: string) => {
      const identity = command.match(/config_hash='([^']+)'/);
      if (identity) identities.push(identity[1]);
      return '';
    });
    try {
      for (const binary of ['version one', 'version one', 'version two']) {
        writeFileSync(artifact, binary);
        const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });
        await service.ensureRunning(host, {
          remoteBasePath: '/home/dev/.komla',
          installationId: 'installation',
          endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
          workspaces: [{ workspaceId: 'workspace-1', workingTree: '/repo', targetBranch: 'main' }],
        });
      }
      expect(identities).toHaveLength(3);
      expect(identities[0]).toBe(identities[1]);
      expect(identities[2]).not.toBe(identities[1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells the CLI what is turned off without restarting the companion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-turned-off-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const writes: Array<{ config: string; runtime: string; turnedOff: unknown }> = [];
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes(' version || true')) return 'installed\n';
      return '';
    });
    const upload = vi.fn(async (_host: SshHost, command: string, localPath?: string) => {
      const config = command.match(/config_hash='([^']+)'/);
      const runtime = command.match(/runtime_hash='([^']+)'/);
      if (config && runtime && localPath) {
        const { turnedOffCommands } = JSON.parse(readFileSync(localPath, 'utf8'));
        writes.push({ config: config[1], runtime: runtime[1], turnedOff: turnedOffCommands });
      }
      return '';
    });
    const options = {
      remoteBasePath: '/home/dev/.komla',
      installationId: 'installation',
      endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
      workspaces: [{ workspaceId: 'workspace-1', workingTree: '/repo', targetBranch: 'main' }],
    };
    try {
      const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });
      await service.ensureRunning(host, options);
      await service.ensureRunning(host, {
        ...options,
        turnedOffCommands: { 'workspace.tag': '`komla tag` is turned off in Komla.' },
      });

      expect(writes).toEqual([
        { config: expect.any(String), runtime: expect.any(String), turnedOff: {} },
        {
          config: expect.not.stringMatching(writes[0].config),
          runtime: writes[0].runtime,
          turnedOff: { 'workspace.tag': '`komla tag` is turned off in Komla.' },
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses an unchanged running companion configuration without probing the host again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-session-identity-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes('] &&') && command.includes(' version || true')) return 'installed\n';
      return '';
    });
    const configs: Array<Record<string, unknown>> = [];
    const upload = vi.fn(async (_host: SshHost, command: string, sourcePath: string) => {
      if (command.includes('companion/')) {
        configs.push(JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>);
      }
      return '';
    });
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });

    const options = {
      remoteBasePath: '/home/dev/.komla',
      endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
      installationId: 'installation-a',
      workspaces: [{ workspaceId: 'workspace-1', workingTree: '/repo', targetBranch: 'main' }],
    };
    await service.ensureRunning(host, options);
    const callsAfterFirstConfiguration = run.mock.calls.length;
    await service.ensureRunning(host, options);

    // The config is written in the round trip that starts or reloads the companion.
    expect(run.mock.calls.some(([, command]) => command.includes('new-session'))).toBe(false);
    expect(upload).toHaveBeenCalledOnce();
    const lifecycleCommand = upload.mock.calls[0]![1];
    expect(lifecycleCommand).toContain('cat > "$temp_path"');
    expect(lifecycleCommand).toContain('show-options -qv -t "$session" @komla_config_hash');
    expect(lifecycleCommand).toContain('set-option -t "$session" @komla_config_hash');
    expect(lifecycleCommand).toContain('__companion');
    expect(lifecycleCommand).not.toContain('command -v tmux');
    expect(lifecycleCommand).not.toContain(' sidecar ');
    expect(lifecycleCommand).not.toContain('#{pane_start_command}');
    expect(configs).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(callsAfterFirstConfiguration);
    expect(configs[0]?.installationId).toMatch(/^[a-f0-9]{16}$/);
    expect(configs[0]).not.toHaveProperty('epoch');
    rmSync(root, { recursive: true, force: true });
  });

  it('does not rewrite managed remote terminal session context during companion startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-hook-routing-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes('] &&') && command.includes(' version || true')) return 'installed\n';
      return '';
    });
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload: vi.fn() });

    await service.ensureRunning(host, {
      remoteBasePath: '/home/dev/.komla',
      endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
      installationId: 'installation-a',
      workspaces: [{ workspaceId: 'workspace-1', workingTree: '/repo', targetBranch: 'main' }],
    });

    expect(run.mock.calls.map(([, command]) => command).join('\n')).not.toContain(
      'set-environment'
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes reconfiguration so the newest monitored workspace set wins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-serialized-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const configs: Array<Record<string, unknown>> = [];
    let releaseFirstUpload: (() => void) | undefined;
    const firstUploadBlocked = new Promise<void>((resolve) => {
      releaseFirstUpload = resolve;
    });
    let notifyFirstUploadStarted: (() => void) | undefined;
    const firstUploadStarted = new Promise<void>((resolve) => {
      notifyFirstUploadStarted = resolve;
    });
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes('] &&') && command.includes(' version || true')) return 'installed\n';
      return '';
    });
    const upload = vi.fn(async (_host: SshHost, command: string, sourcePath: string) => {
      if (!command.includes('companion/')) return '';
      configs.push(JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>);
      if (configs.length === 1) {
        notifyFirstUploadStarted?.();
        await firstUploadBlocked;
      }
      return '';
    });
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });
    const baseOptions = {
      remoteBasePath: '/home/dev/.komla',
      endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
      installationId: 'installation-a',
    };
    const workspaceA = { workspaceId: 'a', workingTree: '/repo/a', targetBranch: 'main' };
    const workspaceB = { workspaceId: 'b', workingTree: '/repo/b', targetBranch: 'main' };
    const workspaceC = { workspaceId: 'c', workingTree: '/repo/c', targetBranch: 'main' };

    const older = service.ensureRunning(host, { ...baseOptions, workspaces: [workspaceA] });
    await firstUploadStarted;
    const intermediate = service.ensureRunning(host, {
      ...baseOptions,
      workspaces: [workspaceA, workspaceB],
    });
    const newer = service.ensureRunning(host, {
      ...baseOptions,
      workspaces: [workspaceA, workspaceB, workspaceC],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(configs).toHaveLength(1);
    releaseFirstUpload?.();
    await Promise.all([older, intermediate, newer]);
    expect(configs).toHaveLength(2);
    expect(configs.at(-1)?.workspaces).toEqual([workspaceA, workspaceB, workspaceC]);
    rmSync(root, { recursive: true, force: true });
  });

  it('cancels a queued reconfiguration when the latest request matches the active state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-companion-cancel-queued-'));
    const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
    mkdirSync(join(artifact, '..'), { recursive: true });
    writeFileSync(artifact, 'binary');
    const configs: Array<Record<string, unknown>> = [];
    let releaseFirstUpload: (() => void) | undefined;
    const firstUploadBlocked = new Promise<void>((resolve) => {
      releaseFirstUpload = resolve;
    });
    let notifyFirstUploadStarted: (() => void) | undefined;
    const firstUploadStarted = new Promise<void>((resolve) => {
      notifyFirstUploadStarted = resolve;
    });
    const run = vi.fn(async (_host: SshHost, command: string) => {
      if (command.includes('uname -s')) return 'Linux\nx86_64\n';
      if (command.includes('] &&') && command.includes(' version || true')) return 'installed\n';
      return '';
    });
    const upload = vi.fn(async (_host: SshHost, command: string, sourcePath: string) => {
      if (!command.includes('companion/')) return '';
      configs.push(JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>);
      if (configs.length === 1) {
        notifyFirstUploadStarted?.();
        await firstUploadBlocked;
      }
      return '';
    });
    const service = new RemoteCompanionService({ resourceRoot: () => root, run, upload });
    const baseOptions = {
      remoteBasePath: '/home/dev/.komla',
      endpoint: 'http://127.0.0.1:62000/api/v1/ssh-workspace-status',
      installationId: 'installation-a',
    };
    const workspaceA = { workspaceId: 'a', workingTree: '/repo/a', targetBranch: 'main' };
    const workspaceB = { workspaceId: 'b', workingTree: '/repo/b', targetBranch: 'main' };
    const activeOptions = { ...baseOptions, workspaces: [workspaceA] };

    const active = service.ensureRunning(host, activeOptions);
    await firstUploadStarted;
    const superseded = service.ensureRunning(host, {
      ...baseOptions,
      workspaces: [workspaceA, workspaceB],
    });
    const latest = service.ensureRunning(host, activeOptions);

    releaseFirstUpload?.();
    await Promise.all([active, superseded, latest]);

    expect(configs).toHaveLength(1);
    expect(configs[0]?.workspaces).toEqual([workspaceA]);
    rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'reloads a running companion in place when only its monitored workspaces change',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'komla-companion-reload-'));
      const remoteBasePath = join(root, 'remote');
      const fakeBin = join(root, 'bin');
      const tmuxState = join(root, 'tmux');
      mkdirSync(fakeBin);
      mkdirSync(tmuxState);
      const artifact = join(root, 'x86_64-unknown-linux-musl', 'komla');
      mkdirSync(join(artifact, '..'), { recursive: true });
      writeFileSync(artifact, 'binary');
      // Records session lifecycle and stores tmux session options as files.
      writeFileSync(
        join(fakeBin, 'tmux'),
        [
          '#!/bin/sh',
          `state=${JSON.stringify(tmuxState)}`,
          'shift 2',
          'case "$1" in',
          '  has-session) [ -e "$state/session" ] ;;',
          '  new-session) touch "$state/session"; echo new-session >> "$state/log" ;;',
          '  kill-session) rm -f "$state/session"; echo kill-session >> "$state/log" ;;',
          '  show-options) cat "$state/$5" 2>/dev/null || true ;;',
          '  set-option) printf "%s" "$5" > "$state/$4" ;;',
          'esac',
        ].join('\n'),
        { mode: 0o755 }
      );
      const run = vi.fn(async (_host: SshHost, command: string) => {
        if (command.includes('uname -s')) return 'Linux\nx86_64\n';
        if (command.includes(' version || true')) return 'installed\n';
        return '';
      });
      const upload = vi.fn(async (_host: SshHost, command: string, sourcePath: string) => {
        try {
          return execFileSync('sh', ['-c', command], {
            input: readFileSync(sourcePath),
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
          });
        } catch (error) {
          // Like ssh, the exit code is `code`.
          throw Object.assign(error as Error, { code: (error as { status: number }).status });
        }
      });
      const workspace = (workspaceId: string) => ({
        workspaceId,
        workingTree: `/repo/${workspaceId}`,
        targetBranch: 'main',
      });
      const start = (workspaces: ReturnType<typeof workspace>[], endpointPort = 62000) =>
        new RemoteCompanionService({ resourceRoot: () => root, run, upload }).ensureRunning(host, {
          remoteBasePath,
          installationId: 'installation',
          endpoint: `http://127.0.0.1:${endpointPort}/api/v1/ssh-workspace-status`,
          workspaces,
        });
      const lifecycle = () => readFileSync(join(tmuxState, 'log'), 'utf8').trim().split('\n');
      try {
        const runtime = await start([workspace('a')]);
        const pointer = join(runtime.hookInbox, '..', 'current-config');
        const firstConfig = readFileSync(pointer, 'utf8').trim();

        await start([workspace('a'), workspace('b')]);

        expect(lifecycle()).toEqual(['new-session']);
        const reloadedConfig = readFileSync(pointer, 'utf8').trim();
        expect(reloadedConfig).not.toBe(firstConfig);
        expect(JSON.parse(readFileSync(reloadedConfig, 'utf8')).workspaces).toEqual([
          workspace('a'),
          workspace('b'),
        ]);
        // Superseded configs and the pointer's temporary file are removed.
        expect(
          readdirSync(dirname(pointer)).filter(
            (name) => name.endsWith('.json') || name.startsWith('current-config.')
          )
        ).toEqual([basename(reloadedConfig)]);

        await start([workspace('a'), workspace('b')], 62001);

        expect(lifecycle()).toEqual(['new-session', 'kill-session', 'new-session']);

        // A config it can't write leaves the running companion on its old one.
        chmodSync(dirname(pointer), 0o500);
        await expect(start([workspace('a')], 62002)).rejects.toThrow();
        chmodSync(dirname(pointer), 0o700);
        expect(lifecycle()).toEqual(['new-session', 'kill-session', 'new-session']);
        expect(run.mock.calls.some(([, command]) => command.includes('kill-session'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
