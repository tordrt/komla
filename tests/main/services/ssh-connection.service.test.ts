import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { askpassMock, execFileMock, spawnMock } = vi.hoisted(() => ({
  askpassMock: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(() => null),
    getSocketPath: vi.fn(() => null),
    issueSession: vi.fn(() => 'session-1'),
  },
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: askpassMock,
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: vi.fn(() => false),
  windowsPathToWsl: vi.fn((value: string) => value),
}));

const HOLD_COMMAND = 'cat';
const isConnectionHold = (args: string[]) => args.at(-1) === HOLD_COMMAND;

/** The ssh process of a connection hold, which stays up until it is told to exit. */
function fakeHold() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
}

/** The ssh commands run other than a connection hold's `ssh -O check`. */
const nonHoldCommands = () =>
  execFileMock.mock.calls.filter(([, args]) => !(args as string[]).includes('check'));

/** The ssh processes started other than connection holds. */
const nonHoldSpawns = () =>
  spawnMock.mock.calls.filter(([, args]) => !isConnectionHold(args as string[]));

const originalPlatform = process.platform;
const host = {
  id: 'ssh-connection-test',
  name: 'SSH connection test',
  hostname: 'connection.example.com',
  user: 'dev',
};

describe('sshConnectionService', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execFileMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeHold());
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it.each(['background', 'interactive'] as const)(
    'expires queued %s commands without launching them later',
    async (kind) => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      vi.useFakeTimers();
      const callbacks: Array<(error: Error | null, stdout?: string) => void> = [];
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        // A connection hold's check, after a command succeeded.
        if (args.includes('-O')) return callback(null, { stdout: '', stderr: '' });
        const stdin = new PassThrough();
        stdin.resume();
        callbacks.push(callback);
        return { stdin, kill: vi.fn() };
      });
      const count = kind === 'background' ? 3 : 4;
      const active = Array.from({ length: count }, () =>
        sshConnectionService.runWithInput(host, 'cat', 'input', { purpose: { kind } })
      );
      await vi.advanceTimersByTimeAsync(0);
      const queued = sshConnectionService.runWithInput(host, 'must-not-run', '', {
        purpose: { kind },
      });
      const rejected = expect(queued).rejects.toThrow('Timed out waiting for an SSH command slot');
      await vi.advanceTimersByTimeAsync(30_000);
      // Release after the deadline: an expired mutation must never run later.
      callbacks.forEach((callback) => callback(null, 'done'));
      await Promise.all(active);
      await rejected;
      expect(nonHoldCommands()).toHaveLength(count);
      const next = sshConnectionService.runWithInput(host, 'next', '');
      await vi.advanceTimersByTimeAsync(0);
      callbacks.at(-1)?.(null, 'next');
      await expect(next).resolves.toBe('next');
    }
  );

  it('opens the setup and first terminal connections ahead of time without prompting', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
    const warmHost = { ...host, id: 'ssh-connection-warm', hostname: 'warm.example.com' };
    const calls: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    execFileMock.mockImplementation(
      (_file, args: string[], options: { env?: NodeJS.ProcessEnv }, callback) => {
        calls.push(args);
        if (!args.includes('-G')) envs.push(options.env ?? {});
        callback(args.includes('-O') ? new Error('Control socket connect: No such file') : null, {
          stdout: args.includes('-G') ? 'user dev\nforwardagent no\n' : '',
          stderr: '',
        });
        return { stdin: new PassThrough(), kill: vi.fn() };
      }
    );

    sshConnectionService.warmConnections(warmHost);
    sshConnectionService.warmConnections(warmHost);

    const masters = () => calls.filter((args) => args.at(-1) === 'true');
    await vi.waitFor(() => expect(masters()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const interactivePath = `ControlPath=${sshControlPath(warmHost, { kind: 'interactive' })}`;
    const terminalPath = `ControlPath=${sshControlPath(warmHost, { kind: 'terminal', poolIndex: 0 })}`;
    expect(masters().find((args) => args.includes(interactivePath))).toEqual(
      expect.arrayContaining(['ControlMaster=auto', 'ControlPersist=600'])
    );
    expect(masters().find((args) => args.includes(terminalPath))).toEqual(
      expect.arrayContaining(['ControlMaster=auto', 'ControlPersist=60'])
    );
    for (const args of masters()) {
      expect(args.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
      expect(args.slice(-2)).toEqual(['dev@warm.example.com', 'true']);
    }
    expect(masters()).toHaveLength(2);
    expect(calls.filter((args) => args.includes('check'))).toHaveLength(2);
    // Batch mode doesn't reach the ssh a ProxyJump starts, which reads only the environment.
    expect(envs).toHaveLength(4);
    for (const env of envs) expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
  });

  it.each([
    {
      outcome: 'stops',
      reason: 'asked for a password',
      id: 'password',
      stderr: 'dev@password.example.com: Permission denied (publickey,password).',
    },
    {
      outcome: 'stops',
      reason: 'showed a new host key',
      id: 'new-key',
      stderr: 'Host key verification failed.',
    },
    {
      outcome: 'keeps',
      reason: 'was unreachable',
      id: 'unreachable',
      stderr: 'ssh: connect to host unreachable.example.com port 22: Network is unreachable',
    },
  ])(
    '$outcome opening connections ahead of time for a host that $reason',
    async ({ outcome, id, stderr }) => {
      const retries = outcome === 'keeps' ? 2 : 0;
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const refusedHost = { ...host, id: `ssh-connection-${id}`, hostname: `${id}.example.com` };
      const calls: string[][] = [];
      const pendingLogins: Array<() => void> = [];
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        calls.push(args);
        const refuse = () =>
          callback(Object.assign(new Error('Command failed'), { stderr }), { stdout: '', stderr });
        if (args.includes('-G')) callback(null, { stdout: 'forwardagent no\n', stderr: '' });
        // Logins take longer than the config check, so both are under way before either fails.
        else if (args.at(-1) === 'true') pendingLogins.push(refuse);
        else refuse();
        return { stdin: new PassThrough(), kill: vi.fn() };
      });
      const masters = () => calls.filter((args) => args.at(-1) === 'true');

      sshConnectionService.warmConnections(refusedHost);
      await vi.waitFor(() => expect(masters()).toHaveLength(2));
      pendingLogins.splice(0).forEach((refuse) => refuse());
      await new Promise((resolve) => setTimeout(resolve, 0));
      sshConnectionService.warmConnections(refusedHost);
      await vi.waitFor(() => expect(masters()).toHaveLength(2 + retries));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(masters()).toHaveLength(2 + retries);
    }
  );

  it('lets workspace creation go on when no connection directory can be made', async () => {
    vi.resetModules();
    // os.tmpdir() reads TMPDIR on macOS and Linux, and TEMP or TMP on Windows.
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
      vi.stubEnv(name, '/nonexistent-komla-control-root');
    }
    try {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const brokenHost = { ...host, id: 'ssh-connection-no-dir', hostname: 'no-dir.example.com' };

      expect(() => sshConnectionService.warmConnections(brokenHost)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves the first terminal connection to the local shell when ssh config forwards the agent', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
    const forwardingHost = {
      ...host,
      id: 'ssh-connection-forwarding',
      hostname: 'forwarding.example.com',
    };
    const calls: string[][] = [];
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      calls.push(args);
      callback(args.includes('-O') ? new Error('Control socket connect: No such file') : null, {
        stdout: args.includes('-G') ? 'forwardagent yes\n' : '',
        stderr: '',
      });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    sshConnectionService.warmConnections(forwardingHost);

    const masters = () => calls.filter((args) => args.at(-1) === 'true');
    await vi.waitFor(() => expect(masters()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(masters()).toHaveLength(1);
    expect(masters()[0]).toContain(
      `ControlPath=${sshControlPath(forwardingHost, { kind: 'interactive' })}`
    );
    expect(sshConnectionService.forwardsAgent(forwardingHost)).toBe(true);
  });

  it('leaves open connections alone', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const openHost = { ...host, id: 'ssh-connection-open', hostname: 'open.example.com' };
    const calls: string[][] = [];
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      calls.push(args);
      callback(null, { stdout: args.includes('-G') ? 'forwardagent no\n' : '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    sshConnectionService.warmConnections(openHost);

    await vi.waitFor(() => expect(calls.filter((args) => args.includes('check'))).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((args) => args.at(-1) === 'true')).toEqual([]);
  });

  it('opens nothing ahead of time where connections are not shared', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const unsharedHost = {
      ...host,
      id: 'ssh-connection-unshared',
      hostname: 'unshared.example.com',
      extraSshArgs: ['-o', 'ControlMaster=no'],
    };
    const calls: string[][] = [];
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      calls.push(args);
      callback(null, { stdout: args.includes('-G') ? 'forwardagent no\n' : '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    sshConnectionService.warmConnections(unsharedHost);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([expect.arrayContaining(['-G', 'dev@unshared.example.com'])]);
  });

  it('starts terminals outside the local shell once ssh -G shows no agent forwarding', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const plainHost = { ...host, id: 'ssh-connection-plain', hostname: 'plain.example.com' };
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      callback(null, { stdout: args.includes('-G') ? 'forwardagent no\n' : '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    expect(sshConnectionService.forwardsAgent(plainHost)).toBe(true);
    await vi.waitFor(() => expect(sshConnectionService.forwardsAgent(plainHost)).toBe(false));
    expect(sshConnectionService.forwardsAgent({ ...plainHost, forwardAgent: true })).toBe(true);
  });

  it('assumes the agent is forwarded again once ssh -G fails', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const changedHost = { ...host, id: 'ssh-connection-changed', hostname: 'changed.example.com' };
    let configError: Error | null = null;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(configError, { stdout: 'forwardagent no\n', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    await vi.waitFor(() => expect(sshConnectionService.forwardsAgent(changedHost)).toBe(false));
    configError = new Error('Match exec timed out');
    await vi.waitFor(() => expect(sshConnectionService.forwardsAgent(changedHost)).toBe(true));
  });

  it('opens nothing ahead of time on Windows, where terminals start in the local shell anyway', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const windowsHost = { ...host, id: 'ssh-connection-windows', hostname: 'windows.example.com' };
    const calls: string[][] = [];
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      calls.push(args);
      callback(null, { stdout: args.includes('-G') ? 'forwardagent no\n' : '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    expect(sshConnectionService.forwardsAgent(windowsHost)).toBe(true);
    sshConnectionService.warmConnections(windowsHost);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.every((args) => args.includes('-G'))).toBe(true);
    expect(sshConnectionService.forwardsAgent(windowsHost)).toBe(true);
  });

  it('gives terminals a connect timeout once ssh -G shows the config sets none', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const timeoutHost = { ...host, id: 'ssh-connection-timeout', hostname: 'timeout.example.com' };
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      callback(null, {
        stdout: args.includes('-G') ? 'forwardagent no\nconnecttimeout none\n' : '',
        stderr: '',
      });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    // Until ssh -G answers, the config may set one, which an -o would override.
    expect(
      sshConnectionService.buildTerminalCommand(timeoutHost, 'timeout-1', 'true', false)
    ).not.toContain('ConnectTimeout');
    sshConnectionService.readConfig(timeoutHost);
    await vi.waitFor(() =>
      expect(
        sshConnectionService.buildTerminalCommand(timeoutHost, 'timeout-2', 'true', false)
      ).toContain('ConnectTimeout=15')
    );
  });

  it('leaves the connect timeout to ~/.ssh/config when it sets one', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const slowHost = { ...host, id: 'ssh-connection-slow', hostname: 'slow.example.com' };
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      callback(null, {
        stdout: args.includes('-G') ? 'forwardagent no\nconnecttimeout 60\n' : '',
        stderr: '',
      });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    sshConnectionService.readConfig(slowHost);
    await vi.waitFor(() => expect(sshConnectionService.forwardsAgent(slowHost)).toBe(false));
    expect(
      sshConnectionService.buildTerminalCommand(slowHost, 'slow-1', 'true', false)
    ).not.toContain('ConnectTimeout');
  });

  it('leaves the connect timeout to the host’s own ssh arguments', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const argsHost = {
      ...host,
      id: 'ssh-connection-args-timeout',
      hostname: 'args-timeout.example.com',
      extraSshArgs: ['-o', 'ConnectTimeout=5'],
    };
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      callback(null, {
        stdout: args.includes('-G') ? 'forwardagent no\nconnecttimeout 5\n' : '',
        stderr: '',
      });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    sshConnectionService.readConfig(argsHost);
    await vi.waitFor(() => expect(sshConnectionService.forwardsAgent(argsHost)).toBe(false));
    const command = sshConnectionService.buildTerminalCommand(argsHost, 'args-1', 'true', false);
    expect(command).toContain('ConnectTimeout=5');
    expect(command).not.toContain('ConnectTimeout=15');
  });

  it('records whether the host answered each command, for the status bar', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshHostStatusService } =
      await import('../../../src/main/services/ssh-host-status.service');
    const results = [
      Object.assign(new Error('Command failed'), {
        code: 255,
        stderr: 'ssh: connect to host connection.example.com port 22: Connection refused\n',
      }),
      Object.assign(new Error('Command failed'), {
        code: 1,
        stderr: 'fatal: not a git repository\n',
      }),
    ];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(results.shift() ?? null, { stdout: 'ok', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });
    const status = () => sshHostStatusService.list().find((entry) => entry.hostId === host.id);

    await expect(sshConnectionService.run(host, 'true')).rejects.toThrow();
    expect(status()).toMatchObject({
      state: 'unreachable',
      message: 'ssh: connect to host connection.example.com port 22: Connection refused',
    });

    // The remote command failed, so ssh got there.
    await expect(sshConnectionService.run(host, 'git status')).rejects.toThrow();
    expect(status()).toMatchObject({ state: 'connected' });
  });

  it('runs nothing on a host the user disconnected from, and keeps what it last saw', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshHostStatusService } =
      await import('../../../src/main/services/ssh-host-status.service');
    const { markSshHostDisconnected } =
      await import('../../../src/main/services/ssh-host-disconnection');
    const disconnected = { ...host, id: 'ssh-disconnected', name: 'Away' };
    sshHostStatusService.reached(disconnected.id);
    markSshHostDisconnected(disconnected.id, true);
    try {
      const refused = 'Disconnected from Away. Connect to it to use it again.';
      await expect(sshConnectionService.run(disconnected, 'true')).rejects.toThrow(refused);
      await expect(sshConnectionService.runWithInput(disconnected, 'cat', 'x')).rejects.toThrow(
        refused
      );
      await expect(
        sshConnectionService.runWithFileInput(disconnected, 'cat', '/dev/null')
      ).rejects.toThrow(refused);
      await expect(sshConnectionService.runStreaming(disconnected, 'true')).rejects.toThrow(
        refused
      );
      expect(() => sshConnectionService.getRsyncTransport(disconnected)).toThrow(refused);
      await expect(sshConnectionService.hasOpenConnection(disconnected)).resolves.toBe(false);
      sshConnectionService.warmConnections(disconnected);
      await expect(sshConnectionService.checkHost(disconnected)).resolves.toMatchObject({
        state: 'connected',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(execFileMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(sshHostStatusService.get(disconnected.id)).toMatchObject({ state: 'connected' });
    } finally {
      markSshHostDisconnected(disconnected.id, false);
    }
  });

  it('runs none of the commands still waiting for a slot when the user disconnects', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { markSshHostDisconnected } =
      await import('../../../src/main/services/ssh-host-disconnection');
    const { sshHostStatusService } =
      await import('../../../src/main/services/ssh-host-status.service');
    const queuedHost = { ...host, id: 'ssh-disconnect-queued', hostname: 'queued.example.com' };
    const callbacks: Array<(error: Error | null, stdout?: string) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      callbacks.push(callback);
      return { stdin, kill: vi.fn() };
    });
    const active = Array.from({ length: 3 }, () =>
      sshConnectionService.runWithInput(queuedHost, 'cat', 'input')
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      queueMicrotask(() => callback(null, 'ran'));
      return { stdin, kill: vi.fn() };
    });
    const queued = [
      sshConnectionService.run(queuedHost, 'must-not-run'),
      sshConnectionService.runWithInput(queuedHost, 'must-not-run', ''),
      sshConnectionService.runStreaming(queuedHost, 'must-not-run'),
    ];
    markSshHostDisconnected(queuedHost.id, true);
    try {
      callbacks.forEach((callback) => callback(null, 'done'));
      await Promise.all(active);
      for (const run of queued) {
        await expect(run).rejects.toThrow('Disconnected from SSH connection test');
      }
      expect(execFileMock).toHaveBeenCalledTimes(3);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(sshHostStatusService.get(queuedHost.id)).toMatchObject({ state: 'connected' });
    } finally {
      markSshHostDisconnected(queuedHost.id, false);
    }
  });

  it.each([
    ['while disconnected', false],
    ['after connecting again', true],
  ])(
    'keeps what it last saw of a host when disconnecting cuts off a command, which fails %s',
    async (_name, reconnect) => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const { sshHostStatusService } =
        await import('../../../src/main/services/ssh-host-status.service');
      const { markSshHostDisconnected } =
        await import('../../../src/main/services/ssh-host-disconnection');
      const cutHost = {
        ...host,
        id: `ssh-disconnect-cut-${reconnect}`,
        hostname: 'cut.example.com',
      };
      sshHostStatusService.reached(cutHost.id);
      let finish!: (error: Error | null, stdout?: string) => void;
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        const stdin = new PassThrough();
        stdin.resume();
        finish = callback;
        return { stdin, kill: vi.fn() };
      });
      const running = sshConnectionService.runWithInput(cutHost, 'cat', 'input');
      await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled());
      markSshHostDisconnected(cutHost.id, true);
      if (reconnect) markSshHostDisconnected(cutHost.id, false);
      try {
        finish(Object.assign(new Error('Connection closed by remote host'), { code: 255 }));
        await expect(running).rejects.toThrow('Disconnected from SSH connection test');
        expect(sshHostStatusService.get(cutHost.id)).toMatchObject({ state: 'connected' });
      } finally {
        markSshHostDisconnected(cutHost.id, false);
      }
    }
  );

  it('closes the shared connections a host has open, and asks only the local ssh holding them', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });
    const background = sshControlPath(host, { kind: 'background' })!;
    const stream = sshControlPath(host, { kind: 'workspace-stream', workspaceId: 'ws-1' })!;
    writeFileSync(background, '');
    writeFileSync(stream, '');
    try {
      await sshConnectionService.closeConnections(host, ['ws-1', 'ws-2']);
    } finally {
      rmSync(background, { force: true });
      rmSync(stream, { force: true });
    }

    expect(execFileMock.mock.calls.map(([file, args]) => [file, ...(args as string[])])).toEqual([
      ['ssh', '-o', `ControlPath=${background}`, '-O', 'exit', 'dev@connection.example.com'],
      ['ssh', '-o', `ControlPath=${stream}`, '-O', 'exit', 'dev@connection.example.com'],
    ]);
  });

  it('fails with ssh’s own error rather than the command when ssh cannot connect', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const stderr = 'ssh: connect to host connection.example.com port 22: Operation timed out\n';
    const failures = [
      Object.assign(
        new Error(`Command failed: ssh dev@connection.example.com sh -lc '…'\n${stderr}`),
        {
          code: 255,
          stderr,
        }
      ),
      Object.assign(new Error("Command failed: ssh dev@connection.example.com sh -lc 'false'\n"), {
        code: 1,
        stderr: '',
      }),
    ];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(failures.shift() ?? null, { stdout: '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    const connectionFailure = await sshConnectionService.run(host, 'true').catch((e) => e);
    expect(connectionFailure.message).toBe(
      'ssh: connect to host connection.example.com port 22: Operation timed out'
    );
    // Callers still tell failures apart by what ssh printed and its exit code.
    expect(connectionFailure).toMatchObject({ code: 255, stderr });

    // A remote command that failed keeps its own error.
    await expect(sshConnectionService.run(host, 'false')).rejects.toThrow(
      "Command failed: ssh dev@connection.example.com sh -lc 'false'"
    );
  });

  it('says why ssh couldn’t connect when sending a file, whose error comes without stderr', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const directory = mkdtempSync(join(tmpdir(), 'komla-ssh-connection-failure-'));
    const sourcePath = join(directory, 'upload.txt');
    writeFileSync(sourcePath, 'upload');
    const stderr = 'ssh: connect to host connection.example.com port 22: Connection refused\n';
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      // Like Node's execFile, the callback's error has no stderr of its own.
      stdin.on('end', () =>
        callback(
          Object.assign(new Error(`Command failed: ssh dev@connection.example.com …\n${stderr}`), {
            code: 255,
          }),
          '',
          stderr
        )
      );
      return { stdin, kill: vi.fn() };
    });

    try {
      const failure = await sshConnectionService
        .runWithFileInput(host, 'cat >upload', sourcePath)
        .catch((error) => error);
      expect(failure.message).toBe(
        'ssh: connect to host connection.example.com port 22: Connection refused'
      );
      expect(failure).toMatchObject({ code: 255, stderr });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('says a command timed out rather than repeating it', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const timedOutHost = { ...host, id: 'ssh-connection-timed-out' };
    const commands: string[] = [];
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      commands.push(args[args.length - 1]);
      callback(
        Object.assign(new Error("Command failed: ssh dev@connection.example.com sh -lc 'slow'\n"), {
          killed: true,
          code: null,
          signal: 'SIGTERM',
          stderr: '',
        }),
        { stdout: '', stderr: '' }
      );
      return { stdin: new PassThrough(), kill: vi.fn() };
    });

    const failure = await sshConnectionService.run(timedOutHost, 'slow').catch((error) => error);
    expect(failure.message).toBe('The command on dev@connection.example.com timed out.');
    expect(failure).toMatchObject({ killed: true, code: null });
    // Let the check the timeout started finish before the next test.
    await vi.waitFor(() => expect(commands).toContain("sh -lc 'true'"));
    await sshConnectionService.checkHost(timedOutHost);
  });

  it("runs without prompting when asked, and doesn't call a host that wants a password unreachable", async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshHostStatusService } =
      await import('../../../src/main/services/ssh-host-status.service');
    const quietHost = { ...host, id: 'ssh-connection-quiet', hostname: 'quiet.example.com' };
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    execFileMock.mockImplementation(
      (_file, args: string[], options: { env?: NodeJS.ProcessEnv }, callback) => {
        calls.push({ args, env: options.env ?? {} });
        callback(
          Object.assign(new Error('Command failed'), {
            code: 255,
            stderr: 'dev@quiet.example.com: Permission denied (publickey,password).\n',
          }),
          { stdout: '', stderr: '' }
        );
        return { stdin: new PassThrough(), kill: vi.fn() };
      }
    );

    await expect(
      sshConnectionService.run(quietHost, 'true', {
        purpose: { kind: 'interactive' },
        prompt: false,
      })
    ).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
    for (const { args, env } of calls) {
      expect(args.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
      expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
    }
    expect(sshHostStatusService.get(quietHost.id)).toBeUndefined();

    // One that could have asked was turned away.
    await expect(sshConnectionService.run(quietHost, 'true')).rejects.toThrow();
    expect(calls.at(-1)?.args).not.toContain('BatchMode=yes');
    expect(sshHostStatusService.get(quietHost.id)).toMatchObject({ state: 'unreachable' });
  });

  it('runs a quick command after a timeout to tell a slow command from a host that is down', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const { sshHostStatusService } =
      await import('../../../src/main/services/ssh-host-status.service');
    const timedOut = () => Object.assign(new Error('Command failed'), { killed: true, code: null });
    const commands: string[] = [];
    let hostAnswers = true;
    execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
      const command = args[args.length - 1];
      // A connection hold's check, after a command succeeded.
      if (args.includes('-O')) return callback(null, { stdout: '', stderr: '' });
      commands.push(command);
      const quick = command === "sh -lc 'true'";
      callback(quick && hostAnswers ? null : timedOut(), { stdout: '', stderr: '' });
      return { stdin: new PassThrough(), kill: vi.fn() };
    });
    const status = () => sshHostStatusService.get(host.id);

    await expect(sshConnectionService.run(host, 'slow-build')).rejects.toThrow();
    await vi.waitFor(() => expect(status()).toMatchObject({ state: 'connected' }));
    expect(commands).toEqual(["sh -lc 'slow-build'", "sh -lc 'true'"]);

    hostAnswers = false;
    await expect(sshConnectionService.checkHost(host)).resolves.toMatchObject({
      state: 'unreachable',
      message: 'Timed out',
    });
  });

  it('applies admission control to input-bearing commands', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'komla-ssh-connection-input-'));
    const sourcePath = join(directory, 'upload.txt');
    writeFileSync(sourcePath, 'upload');
    const callbacks: Array<(error: Error | null, stdout?: string) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      callbacks.push(callback);
      return { stdin, kill: vi.fn() };
    });

    try {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const runs = Array.from({ length: 5 }, (_, index) =>
        sshConnectionService.runWithFileInput(host, `cat >upload-${index}`, sourcePath, {
          purpose: { kind: 'interactive' },
        })
      );

      await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4));
      expect(execFileMock.mock.calls[0][2].timeout).toBe(120_000);
      callbacks[0]?.(null, 'first');
      await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(5));
      callbacks.slice(1).forEach((callback, index) => callback(null, `result-${index}`));

      await expect(Promise.all(runs)).resolves.toEqual([
        'first',
        'result-0',
        'result-1',
        'result-2',
        'result-3',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels queued Setup immediately and keeps the interactive slot available', async () => {
    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const callbacks: Array<(error: Error | null, stdout?: string) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      callbacks.push(callback);
      return { stdin, kill: vi.fn() };
    });
    const active = Array.from({ length: 3 }, () =>
      sshConnectionService.runWithInput(host, 'background', '')
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));
    const controller = new AbortController();
    const setup = sshConnectionService.runStreaming(host, 'must-not-start', {
      signal: controller.signal,
    });
    const rejected = expect(setup).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;

    const interactive = sshConnectionService.runWithInput(host, 'user-action', '', {
      purpose: { kind: 'interactive' },
    });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4));
    callbacks.forEach((callback) => callback(null, 'done'));
    await Promise.all([...active, interactive]);
    expect(nonHoldSpawns()).toHaveLength(0);
  });

  it('reopens file input when retrying a refused multiplexed session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'komla-ssh-connection-retry-'));
    const sourcePath = join(directory, 'upload.txt');
    writeFileSync(sourcePath, 'upload');
    const receivedInputs: string[] = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const callIndex = execFileMock.mock.calls.length - 1;
      const chunks: Buffer[] = [];
      const stdin = new PassThrough();
      stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stdin.on('end', () => {
        receivedInputs.push(Buffer.concat(chunks).toString('utf8'));
        if (callIndex === 0) {
          // Like Node's execFile, the error has no stderr of its own; it comes as an argument.
          callback(
            new Error('SSH failed'),
            '',
            'mux_client_request_session: session request failed: Session open refused by peer'
          );
        } else {
          callback(null, 'uploaded');
        }
      });
      return { stdin, kill: vi.fn() };
    });

    try {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      await expect(
        sshConnectionService.runWithFileInput(host, 'cat >upload', sourcePath, {
          purpose: { kind: 'interactive' },
        })
      ).resolves.toBe('uploaded');

      expect(receivedInputs).toEqual(['upload', 'upload']);
      const firstArgs = execFileMock.mock.calls[0][1] as string[];
      const retryArgs = execFileMock.mock.calls[1][1] as string[];
      expect(firstArgs).toContain('ControlPersist=600');
      expect(retryArgs).toContain('ControlPath=none');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('applies admission control to string-input commands', async () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      callbacks.push(callback);
      return { stdin, kill: vi.fn() };
    });

    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    const runs = Array.from({ length: 5 }, (_, index) =>
      sshConnectionService.runWithInput(host, `cat >config-${index}`, `config-${index}`, {
        purpose: { kind: 'interactive' },
      })
    );

    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4));
    callbacks[0]?.(null);
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(5));
    callbacks.slice(1).forEach((callback) => callback(null));

    await Promise.all(runs);
  });

  it('resends string input when retrying a refused multiplexed session', async () => {
    const receivedInputs: string[] = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const callIndex = execFileMock.mock.calls.length - 1;
      const chunks: Buffer[] = [];
      const stdin = new PassThrough();
      stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stdin.on('end', () => {
        receivedInputs.push(Buffer.concat(chunks).toString('utf8'));
        if (callIndex === 0) {
          callback(
            new Error('SSH failed'),
            '',
            'mux_client_request_session: session request failed: Session open refused by peer'
          );
        } else {
          callback(null);
        }
      });
      return { stdin, kill: vi.fn() };
    });

    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    await expect(
      sshConnectionService.runWithInput(host, 'cat >config', 'configuration', {
        purpose: { kind: 'interactive' },
      })
    ).resolves.toBe('');

    expect(receivedInputs).toEqual(['configuration', 'configuration']);
    const firstArgs = execFileMock.mock.calls[0][1] as string[];
    const retryArgs = execFileMock.mock.calls[1][1] as string[];
    expect(firstArgs).toContain('ControlPersist=600');
    expect(retryArgs).toContain('ControlPath=none');
  });

  it.each([
    '__KOMLA_SSH_BRANCH_ALREADY_EXISTS__',
    '__KOMLA_SSH_WORKTREE_PATH_CONFLICT__',
    'Permission denied (publickey).',
  ])('preserves stderr from failed string-input commands: %s', async (stderr) => {
    const error = Object.assign(new Error('SSH failed'), { code: 1 });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.resume();
      stdin.on('end', () => callback(error, 'setup progress\n', stderr));
      return { stdin, kill: vi.fn() };
    });

    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    await expect(
      sshConnectionService.runWithInput(host, 'sh -s', 'setup script', {
        multiplex: false,
        purpose: { kind: 'interactive' },
      })
    ).rejects.toMatchObject({ code: 1, stdout: 'setup progress\n', stderr });
  });

  it('returns output from standalone string-input commands without creating a control master', async () => {
    const receivedInputs: string[] = [];
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      const chunks: Buffer[] = [];
      const stdin = new PassThrough();
      stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stdin.on('end', () => {
        receivedInputs.push(Buffer.concat(chunks).toString('utf8'));
        callback(null, 'setup complete\n');
      });
      return { stdin, kill: vi.fn() };
    });

    const { sshConnectionService } =
      await import('../../../src/main/services/ssh-connection.service');
    await expect(
      sshConnectionService.runWithInput(host, 'sh -s', 'setup script', {
        multiplex: false,
        purpose: { kind: 'interactive' },
      })
    ).resolves.toBe('setup complete\n');

    expect(receivedInputs).toEqual(['setup script']);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain('ControlPath=none');
    expect(args).not.toContain('ControlMaster=auto');
    expect(args.at(-1)).toBe("sh -lc 'sh -s'");
  });

  describe('holding shared connections open', () => {
    let hostCount = 0;
    /** A host of its own, since the service keeps the connections it holds across tests. */
    const freshHost = (overrides: Record<string, unknown> = {}) => ({
      ...host,
      id: `ssh-connection-hold-${++hostCount}`,
      hostname: `hold-${hostCount}.example.com`,
      ...overrides,
    });
    const holds = () =>
      spawnMock.mock.results
        .filter((_result, index) => isConnectionHold(spawnMock.mock.calls[index][1] as string[]))
        .map((result) => result.value as ReturnType<typeof fakeHold>);
    const holdArgs = () =>
      spawnMock.mock.calls
        .map(([, args]) => args as string[])
        .filter((args) => isConnectionHold(args));
    const checks = () =>
      execFileMock.mock.calls.filter(([, args]) => (args as string[]).includes('check'));
    /** Lets a hold that is starting get past its `ssh -O check`. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** Answers commands with `ran`, and `ssh -O check` as `connectionOpen` says. */
    function answer(connectionOpen = true) {
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        if (args.includes('-O')) {
          callback(connectionOpen ? null : new Error('Control socket connect: No such file'), {
            stdout: '',
            stderr: '',
          });
          return undefined;
        }
        callback(null, { stdout: 'ran', stderr: '' });
        return { stdin: new PassThrough(), kill: vi.fn() };
      });
    }

    beforeEach(() => answer());

    it('joins each lane’s open shared connection after a command used it, and never logs in itself', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
      const held = freshHost({ forwardAgent: true });
      const backgroundPath = sshControlPath(held, { kind: 'background' });

      await sshConnectionService.run(held, 'git status');
      await sshConnectionService.run(held, 'git status');
      await settle();
      await sshConnectionService.runWithInput(held, 'cat > file', 'saved');
      await settle();
      expect(holdArgs()).toHaveLength(1);
      await sshConnectionService.run(held, 'cat file', { purpose: { kind: 'interactive' } });
      await vi.waitFor(() => expect(holdArgs()).toHaveLength(2));

      const target = `dev@${held.hostname}`;
      // The proxy alone keeps it from logging in, with nothing to check first.
      expect(checks()).toHaveLength(0);
      expect(holdArgs()[0]).toEqual([
        // Should the connection be closed, ssh would log in itself; this stops it.
        '-o',
        'ProxyCommand=false',
        '-o',
        'BatchMode=yes',
        '-A',
        ...holdArgs()[0].slice(5, -5),
        // An idle session needs neither, whatever the host's own arguments ask for.
        '-a',
        '-x',
        '-T',
        target,
        HOLD_COMMAND,
      ]);
      expect(holdArgs()[0]).toEqual(
        expect.arrayContaining(['ControlMaster=no', `ControlPath=${backgroundPath}`])
      );
      expect(holdArgs()[0]).not.toContain('ControlPersist=60');
      expect(holdArgs()[1]).toEqual(
        expect.arrayContaining([`ControlPath=${sshControlPath(held, { kind: 'interactive' })}`])
      );
      const env = spawnMock.mock.calls.find(([, args]) => isConnectionHold(args as string[]))?.[2]
        ?.env as NodeJS.ProcessEnv;
      expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
    });

    it('holds the interactive connection a host check used, and the one a file upload used', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
      const checked = freshHost();
      const directory = mkdtempSync(join(tmpdir(), 'komla-ssh-connection-hold-'));
      const sourcePath = join(directory, 'upload.txt');
      writeFileSync(sourcePath, 'upload');
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        if (args.includes('-O')) {
          callback(null, { stdout: '', stderr: '' });
          return undefined;
        }
        const stdin = new PassThrough();
        stdin.resume();
        if (args.at(-1)?.includes('upload')) stdin.on('end', () => callback(null, 'uploaded'));
        else callback(null, { stdout: '', stderr: '' });
        return { stdin, kill: vi.fn() };
      });

      try {
        await sshConnectionService.checkHost(checked);
        await sshConnectionService.runWithFileInput(checked, 'cat >upload', sourcePath);
        await vi.waitFor(() => expect(holdArgs()).toHaveLength(2));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }

      expect(holdArgs()).toEqual([
        expect.arrayContaining([`ControlPath=${sshControlPath(checked, { kind: 'interactive' })}`]),
        expect.arrayContaining([`ControlPath=${sshControlPath(checked, { kind: 'background' })}`]),
      ]);
    });

    it.each([['-J', 'bastion.example.com'], ['-AJ', 'bastion.example.com'], ['-Jbastion']])(
      'leaves out the proxy for a host that jumps with %s, which takes none',
      async (...extraSshArgs) => {
        const { sshConnectionService } =
          await import('../../../src/main/services/ssh-connection.service');
        const jumping = freshHost({ extraSshArgs });

        await sshConnectionService.run(jumping, 'git status');
        await vi.waitFor(() => expect(holdArgs()).toHaveLength(1));

        expect(holdArgs()[0]).not.toContain('ProxyCommand=false');
        expect(holdArgs()[0].slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
        // So it joins only a connection `ssh -O check` shows open.
        expect(checks()).toHaveLength(1);
      }
    );

    it.each([
      ['-lJane'],
      ['-i', '-Jkey'],
      ['-o', 'ProxyJump=bastion.example.com'],
      ['-oProxyJump=x'],
    ])(
      'keeps the proxy for a host whose arguments %s only look like -J',
      async (...extraSshArgs) => {
        const { sshConnectionService } =
          await import('../../../src/main/services/ssh-connection.service');

        await sshConnectionService.run(freshHost({ extraSshArgs }), 'git status');
        await vi.waitFor(() => expect(holdArgs()).toHaveLength(1));

        expect(holdArgs()[0].slice(0, 2)).toEqual(['-o', 'ProxyCommand=false']);
      }
    );

    it('holds the connection a command ran on even when the command failed', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(Object.assign(new Error('Command failed'), { code: 1, stderr: '' }), {
          stdout: '',
          stderr: '',
        });
        return undefined;
      });

      await expect(sshConnectionService.run(freshHost(), 'test -d missing')).rejects.toThrow();

      await vi.waitFor(() => expect(holdArgs()).toHaveLength(1));
    });

    it('holds the interactive connection it opened ahead of time', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
      const warmed = freshHost();
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        callback(args.includes('-O') ? new Error('Control socket connect: No such file') : null, {
          stdout: args.includes('-G') ? 'user dev\nforwardagent yes\n' : '',
          stderr: '',
        });
        return undefined;
      });

      sshConnectionService.warmConnections(warmed);

      await vi.waitFor(() => expect(holdArgs()).toHaveLength(1));
      expect(holdArgs()[0]).toEqual(
        expect.arrayContaining([`ControlPath=${sshControlPath(warmed, { kind: 'interactive' })}`])
      );
    });

    it('closes a held connection that stopped answering after the computer woke', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
      const dead = freshHost();
      const alive = freshHost();
      await sshConnectionService.run(dead, 'ls');
      await sshConnectionService.run(alive, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(2));
      const deadPath = sshControlPath(dead, { kind: 'background' });
      const probes: string[][] = [];
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        if (args.at(-1) === 'true') {
          probes.push(args);
          const timedOut = args.includes(`ControlPath=${deadPath}`);
          callback(
            timedOut
              ? Object.assign(new Error('Command failed'), { killed: true, code: null })
              : null,
            { stdout: '', stderr: '' }
          );
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return undefined;
      });
      execFileMock.mockClear();

      await sshConnectionService.checkHeldConnections();

      // Earlier tests' hosts are still held as well.
      const ours = probes.filter((args) =>
        [dead.hostname, alive.hostname].some((hostname) => args.includes(`dev@${hostname}`))
      );
      expect(ours).toHaveLength(2);
      // A probe never logs in either.
      for (const probe of ours) expect(probe.slice(0, 2)).toEqual(['-o', 'ProxyCommand=false']);
      expect(
        execFileMock.mock.calls.filter(([, args]) => (args as string[]).includes('exit'))
      ).toEqual([
        [
          'ssh',
          ['-o', `ControlPath=${deadPath}`, '-O', 'exit', `dev@${dead.hostname}`],
          expect.anything(),
          expect.any(Function),
        ],
      ]);
    });

    it('holds nothing while the connection it would join is closed, so it never logs in', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const closed = freshHost({ extraSshArgs: ['-J', 'bastion.example.com'] });
      answer(false);

      await sshConnectionService.run(closed, 'git status');
      await vi.waitFor(() => expect(checks()).toHaveLength(1));
      await settle();
      await sshConnectionService.run(closed, 'git status');
      await settle();

      expect(spawnMock).not.toHaveBeenCalled();
      // Not checked again on every command.
      expect(checks()).toHaveLength(1);
    });

    it('holds nothing where connections are not shared, for a command run on its own, or after a failure', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');

      await sshConnectionService.run(freshHost({ extraSshArgs: ['-o', 'ControlPath=none'] }), 'ls');
      await sshConnectionService.runWithInput(freshHost(), 'cat', 'x', { multiplex: false });
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      await sshConnectionService.run(freshHost(), 'ls');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(Object.assign(new Error('Command failed'), { code: 255, stderr: '' }), {
          stdout: '',
          stderr: '',
        });
        return { stdin: new PassThrough(), kill: vi.fn() };
      });
      await expect(sshConnectionService.run(freshHost(), 'ls')).rejects.toThrow();
      await settle();

      expect(checks()).toHaveLength(0);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('lets go of a connection the host refused a session on, for ten minutes', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const crowded = freshHost();
      vi.useFakeTimers({ toFake: ['Date'] });
      await sshConnectionService.run(crowded, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(1));
      let refuse = true;
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        if (refuse && !args.includes('ControlPath=none')) {
          refuse = false;
          callback(
            Object.assign(new Error('Command failed'), {
              code: 255,
              stderr:
                'mux_client_request_session: session request failed: Session open refused by peer',
            }),
            { stdout: '', stderr: '' }
          );
          return undefined;
        }
        callback(null, { stdout: 'ran', stderr: '' });
        return undefined;
      });

      // Ran on its own after the refusal, which holds nothing either.
      await expect(sshConnectionService.run(crowded, 'ls')).resolves.toBe('ran');
      expect(holds()[0].stdin.writableEnded).toBe(true);
      holds()[0].emit('exit', 0, null);
      vi.setSystemTime(Date.now() + 9 * 60_000);
      await sshConnectionService.run(crowded, 'ls');
      await settle();
      expect(holds()).toHaveLength(1);

      vi.setSystemTime(Date.now() + 60_000);
      await sshConnectionService.run(crowded, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(2));
    });

    it('lets go of the background connection when a streaming command was refused a session on it', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const streaming = freshHost();
      await sshConnectionService.run(streaming, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(1));
      spawnMock.mockImplementation((_file, args: string[]) => {
        if (isConnectionHold(args)) return fakeHold();
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(),
        });
        const refused = !args.includes('ControlPath=none');
        setImmediate(() => {
          if (refused) child.stderr.write('Session open refused by peer\n');
          setImmediate(() => child.emit('close', refused ? 255 : 0, null));
        });
        return child;
      });

      await expect(sshConnectionService.runStreaming(streaming, 'setup')).resolves.toBe(0);

      expect(holds()[0].stdin.writableEnded).toBe(true);
    });

    it('waits as long after the host refused the hold its session, or refused one before any hold', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const refusing = freshHost();
      const early = freshHost();
      vi.useFakeTimers({ toFake: ['Date'] });
      await sshConnectionService.run(refusing, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(1));
      holds()[0].stderr.write(
        'mux_client_request_session: session request failed: Session open refused by peer\n'
      );
      await settle();
      holds()[0].emit('exit', 255, null);
      let refuse = true;
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        const refused = refuse && !args.includes('ControlPath=none');
        if (refused) refuse = false;
        callback(
          refused
            ? Object.assign(new Error('Command failed'), {
                code: 255,
                stderr: 'Session open refused by peer',
              })
            : null,
          { stdout: 'ran', stderr: '' }
        );
        return undefined;
      });
      await sshConnectionService.run(early, 'ls');

      vi.setSystemTime(Date.now() + 5 * 60_000);
      await sshConnectionService.run(refusing, 'ls');
      await sshConnectionService.run(early, 'ls');
      await settle();
      expect(holds()).toHaveLength(1);
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await sshConnectionService.run(refusing, 'ls');
      await sshConnectionService.run(early, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(3));
    });

    it('holds the connection again once it dropped, but not on every command when it cannot join', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const dropping = freshHost();
      vi.useFakeTimers({ toFake: ['Date'] });

      await sshConnectionService.run(dropping, 'git status');
      await vi.waitFor(() => expect(holds()).toHaveLength(1));
      vi.setSystemTime(Date.now() + 60 * 60_000);
      holds()[0].emit('exit', 255, null);
      await sshConnectionService.run(dropping, 'git status');
      await vi.waitFor(() => expect(holds()).toHaveLength(2));

      // It ended at once: the connection it would join had closed.
      holds()[1].emit('exit', 255, null);
      await sshConnectionService.run(dropping, 'git status');
      await settle();
      expect(holds()).toHaveLength(2);
      vi.setSystemTime(Date.now() + 60_000);
      await sshConnectionService.run(dropping, 'git status');
      await vi.waitFor(() => expect(holds()).toHaveLength(3));
    });

    it('lets go of what it holds when the user disconnects, or the host is edited or removed', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const disconnected = freshHost();
      const forgotten = freshHost();
      const edited = freshHost();
      await sshConnectionService.run(disconnected, 'ls');
      await sshConnectionService.run(forgotten, 'ls');
      await sshConnectionService.run(edited, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(3));
      const [disconnectedHold, forgottenHold, editedHold] = holds();

      await sshConnectionService.closeConnections(disconnected);
      sshConnectionService.forgetHostConnections(forgotten.id);
      // Agent forwarding is part of the connection, though not of the host's address.
      await sshConnectionService.run({ ...edited, forwardAgent: true }, 'ls');
      await vi.waitFor(() => expect(holds()).toHaveLength(4));

      // Its stdin closing ends the remote command, and the session with it.
      expect(disconnectedHold.stdin.writableEnded).toBe(true);
      expect(forgottenHold.stdin.writableEnded).toBe(true);
      expect(editedHold.stdin.writableEnded).toBe(true);
      expect(holds()[3].stdin.writableEnded).toBe(false);
    });

    it('holds nothing for a host forgotten while a command on it still ran', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const removed = freshHost();
      let finish!: () => void;
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        if (args.includes('-O')) callback(null, { stdout: '', stderr: '' });
        else finish = () => callback(null, { stdout: 'ran', stderr: '' });
        return undefined;
      });

      const running = sshConnectionService.run(removed, 'git fetch');
      await vi.waitFor(() => expect(finish).toBeDefined());
      sshConnectionService.forgetHostConnections(removed.id);
      finish();
      await running;
      await settle();

      expect(checks()).toHaveLength(0);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('through an exec channel', () => {
    const channelHost = { ...host, id: 'ssh-connection-channel', hostname: 'channel.example.com' };

    /** The ssh process with `__exec-channel` behind it: answers EXEC frames with `reply`. */
    function fakeChannel(
      reply: (command: string, input: string) => { stdout?: string; code: number }
    ) {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null,
        kill: vi.fn(),
      });
      const send = (kind: number, id: number, payload: Buffer) => {
        const header = Buffer.alloc(9);
        header.writeUInt32BE(5 + payload.length, 0);
        header.writeUInt8(kind, 4);
        header.writeUInt32BE(id, 5);
        child.stdout.write(Buffer.concat([header, payload]));
      };
      const int32 = (value: number) => {
        const buffer = Buffer.alloc(4);
        buffer.writeInt32BE(value);
        return buffer;
      };
      child.stdin.on('data', (chunk: Buffer) => {
        const id = chunk.readUInt32BE(5);
        const commandEnd = 13 + chunk.readUInt32BE(9);
        const { stdout, code } = reply(
          chunk.subarray(13, commandEnd).toString('utf8'),
          chunk.subarray(commandEnd).toString('utf8')
        );
        if (stdout) send(16, id, Buffer.from(stdout));
        send(18, id, int32(code));
      });
      return { child, ready: () => send(0, 0, int32(1)) };
    }

    /**
     * Answers each `__exec-channel` ssh with the next of `children`, the last again once they run
     * out, and a connection hold with a process that stays up.
     */
    function spawnChannels(...children: unknown[]) {
      spawnMock.mockImplementation((_file, args: string[]) =>
        isConnectionHold(args) ? fakeHold() : children.length > 1 ? children.shift() : children[0]
      );
    }

    const channelSpawns = () =>
      spawnMock.mock.calls.filter(([, args]) =>
        ((args as string[]).at(-1) ?? '').endsWith('__exec-channel')
      );

    /** Answers commands as their own ssh exec, and `ssh -O check` as `masterUp` says. */
    function plainExec(masterUp = true) {
      execFileMock.mockImplementation((_file, args: string[], _options, callback) => {
        if (args.includes('-O')) {
          callback(masterUp ? null : new Error('Control socket connect: No such file'), {
            stdout: '',
            stderr: '',
          });
          return undefined;
        }
        callback(null, { stdout: 'exec ran', stderr: '' });
        return { stdin: new PassThrough(), kill: vi.fn() };
      });
    }

    const commandExecs = () =>
      execFileMock.mock.calls.filter(([, args]) => !(args as string[]).includes('-O'));

    afterEach(async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      sshConnectionService.forgetHostConnections(channelHost.id);
    });

    it('runs commands through it once it is open, and as their own ssh exec until then', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const channel = fakeChannel((command) => ({ stdout: `channel ran ${command}`, code: 0 }));
      spawnChannels(channel.child);
      plainExec();

      sshConnectionService.useExecChannel(channelHost, '/base/helpers/bin/komla');
      await vi.waitFor(() => expect(channelSpawns()).toHaveLength(1));
      const args = channelSpawns()[0][1] as string[];
      // It joins the connection a command opened, and never logs in itself.
      expect(args.slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '-o', 'ControlMaster=no']);
      expect(args.at(-1)).toBe("'/base/helpers/bin/komla' __exec-channel");
      await expect(sshConnectionService.run(channelHost, 'git status')).resolves.toBe('exec ran');

      channel.ready();
      await vi.waitFor(async () =>
        expect(await sshConnectionService.run(channelHost, 'git status')).toBe(
          'channel ran git status'
        )
      );
      expect(commandExecs()).toHaveLength(1);
    });

    it('saves a file through it with its contents as input', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const inputs: string[] = [];
      const channel = fakeChannel((_command, input) => {
        inputs.push(input);
        return { stdout: 'saved', code: 0 };
      });
      spawnChannels(channel.child);
      plainExec();
      sshConnectionService.useExecChannel(channelHost, '/komla');
      await vi.waitFor(() => expect(channelSpawns()).toHaveLength(1));
      channel.ready();
      await new Promise((resolve) => setImmediate(resolve));

      await expect(
        sshConnectionService.runWithInput(channelHost, 'cat > file', 'contents')
      ).resolves.toBe('saved');
      expect(inputs).toEqual(['contents']);
      expect(commandExecs()).toHaveLength(0);
    });

    it('gives interactive commands a channel of their own, over their own connection', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const background = fakeChannel(() => ({ stdout: 'background', code: 0 }));
      const interactive = fakeChannel(() => ({ stdout: 'interactive', code: 0 }));
      spawnChannels(background.child, interactive.child);
      plainExec();
      sshConnectionService.useExecChannel(channelHost, '/komla');
      await vi.waitFor(() => expect(channelSpawns()).toHaveLength(1));
      background.ready();
      const read = { purpose: { kind: 'interactive' as const } };

      await expect(sshConnectionService.run(channelHost, 'cat file', read)).resolves.toBe(
        'exec ran'
      );
      await vi.waitFor(() => expect(channelSpawns()).toHaveLength(2));
      interactive.ready();
      await vi.waitFor(async () =>
        expect(await sshConnectionService.run(channelHost, 'cat file', read)).toBe('interactive')
      );
      const controlPath = (call: unknown[]) => {
        const args = call[1] as string[];
        return args.find((arg) => arg.startsWith('ControlPath='));
      };
      expect(controlPath(channelSpawns()[1])).toBeDefined();
      expect(controlPath(channelSpawns()[1])).not.toBe(controlPath(channelSpawns()[0]));
    });

    it('opens none while the connection it would share is down', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      plainExec(false);
      sshConnectionService.useExecChannel(channelHost, '/komla');
      await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));

      await expect(sshConnectionService.run(channelHost, 'git status')).resolves.toBe('exec ran');
      expect(channelSpawns()).toHaveLength(0);
    });

    it('stops logging in a channel of its own on a host whose login asks for something', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const unshared = {
        ...channelHost,
        id: 'ssh-connection-unshared',
        extraSshArgs: ['-o', 'ControlPath=none'],
      };
      const refused = fakeChannel(() => ({ code: 0 }));
      spawnChannels(refused.child);
      plainExec();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        sshConnectionService.useExecChannel(unshared, '/komla');
        await vi.waitFor(() => expect(channelSpawns()).toHaveLength(1));
        refused.child.stderr.write('dev@channel.example.com: Permission denied (publickey).\n');
        await new Promise((resolve) => setImmediate(resolve));
        refused.child.emit('close', 255, null);
        await new Promise((resolve) => setImmediate(resolve));

        vi.setSystemTime(Date.now() + 10 * 60_000);
        await sshConnectionService.run(unshared, 'git status');
        await new Promise((resolve) => setImmediate(resolve));
        expect(channelSpawns()).toHaveLength(1);
      } finally {
        sshConnectionService.forgetHostConnections(unshared.id);
      }
    });

    it('fails a command the channel lost without running it again some other way', async () => {
      const { sshConnectionService } =
        await import('../../../src/main/services/ssh-connection.service');
      const channel = fakeChannel(() => {
        channel.child.emit('close', 255, null);
        return { code: 0 };
      });
      spawnChannels(channel.child);
      plainExec();
      sshConnectionService.useExecChannel(channelHost, '/komla');
      await vi.waitFor(() => expect(channelSpawns()).toHaveLength(1));
      channel.ready();
      await new Promise((resolve) => setImmediate(resolve));

      await expect(sshConnectionService.run(channelHost, 'git commit')).rejects.toMatchObject({
        code: 255,
      });
      expect(commandExecs()).toHaveLength(0);
    });
  });

  // Runs the terminal command in a real POSIX shell.
  it.skipIf(process.platform === 'win32')(
    "sends a terminal's ssh prompts to Komla's dialog",
    async () => {
      askpassMock.isRunning.mockReturnValue(true);
      askpassMock.getHelperScriptPath.mockReturnValue('/tmp/komla-askpass.sh' as never);
      askpassMock.getSocketPath.mockReturnValue('/tmp/komla-askpass.sock' as never);
      const bin = mkdtempSync(join(tmpdir(), 'komla-ssh-terminal-test-'));
      writeFileSync(
        join(bin, 'ssh'),
        '#!/bin/sh\necho "$SSH_ASKPASS|$SSH_ASKPASS_REQUIRE|$KOMLA_ASKPASS_SOCKET|$KOMLA_ASKPASS_SESSION|${DISPLAY-none}"\n',
        { mode: 0o755 }
      );
      try {
        const { sshConnectionService } =
          await import('../../../src/main/services/ssh-connection.service');
        const { execFileSync } =
          await vi.importActual<typeof import('child_process')>('child_process');

        for (const terminalId of ['terminal-1', 'terminal-2', 'terminal-3']) {
          const command = sshConnectionService.buildTerminalCommand(
            host,
            terminalId,
            'tmux',
            false
          );
          const output = execFileSync('/bin/sh', ['-c', command], {
            encoding: 'utf8',
            env: { PATH: `${bin}:${process.env.PATH}` },
          });
          expect(output).toContain(
            '/tmp/komla-askpass.sh|force|/tmp/komla-askpass.sock|session-1|none'
          );
        }

        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(
          sshConnectionService.buildTerminalCommand(host, 'terminal-4', 'tmux', false)
        ).not.toContain('SSH_ASKPASS');
      } finally {
        rmSync(bin, { recursive: true, force: true });
        askpassMock.isRunning.mockReturnValue(false);
        askpassMock.getHelperScriptPath.mockReturnValue(null);
        askpassMock.getSocketPath.mockReturnValue(null);
      }
    }
  );
});
