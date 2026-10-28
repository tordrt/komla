import { EventEmitter } from 'events';
import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sshHeartbeatLeaseCommand } from '../../../src/main/lib/ssh-heartbeat-lease';

const {
  mockSpawn,
  mockExecFile,
  mockControlCommand,
  mockCreateServer,
  mockCreateConnection,
  mockGetHost,
  mockRemoteKomlaDataPort,
  mockAskpassService,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFile: vi.fn(),
  mockControlCommand: vi.fn(),
  mockCreateServer: vi.fn(),
  mockCreateConnection: vi.fn(),
  mockGetHost: vi.fn(),
  mockRemoteKomlaDataPort: vi.fn(() => 62042),
  mockAskpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
  },
}));

// `ssh -O` commands to a tunnel's master go to their own mock, so tests that answer `ssh -G`
// calls in order don't see them.
vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: (file: string, args: string[], ...rest: unknown[]) =>
    args.includes('-O')
      ? mockControlCommand(file, args, ...rest)
      : mockExecFile(file, args, ...rest),
}));

vi.mock('net', () => ({
  createServer: mockCreateServer,
  createConnection: mockCreateConnection,
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: mockAskpassService,
}));

vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  remoteKomlaDataPort: mockRemoteKomlaDataPort,
  sshWorkspaceService: {
    getHost: mockGetHost,
  },
}));

interface MockChild extends EventEmitter {
  stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, signal ?? null);
    return true;
  });
  return child;
}

function markKomlaDataTunnelReady(child: MockChild): void {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('__KOMLA_DATA_TUNNEL_READY__\n'));
  });
}

function markConfiguredForwardReady(child: MockChild, ports = [15432, 16379]): void {
  queueMicrotask(() => {
    child.stdout.emit(
      'data',
      Buffer.from(
        `${ports.map((port) => `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`).join('\n')}\n__KOMLA_PORT_FORWARDS_READY__\n`
      )
    );
  });
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return address.port;
}

function requestGateway(
  port: number,
  hostId?: string,
  path = '/api/v1/health'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers: hostId ? { 'X-Komla-Ssh-Host-Id': hostId } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function requestGatewayWithAgent(
  port: number,
  path: string,
  agent: HttpAgent,
  body?: Buffer
): Promise<{ status: number; body: string; connection: string | undefined; socket: object }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        agent,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Length': body.length } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            connection: response.headers.connection,
            socket: response.socket,
          })
        );
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

function mockAllocatedPort(port: number): void {
  mockAllocatedPorts([port]);
}

function mockAllocatedPorts(ports: number[]): void {
  let index = 0;
  mockCreateServer.mockImplementation(() => {
    const server = new EventEmitter() as EventEmitter & {
      listen: ReturnType<typeof vi.fn>;
      address: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    server.listen = vi.fn((_port: number, _host: string, callback: () => void) => {
      callback();
      return server;
    });
    server.address = vi.fn(() => ({
      port: ports[Math.min(index++, ports.length - 1)],
      address: '127.0.0.1',
      family: 'IPv4',
    }));
    server.close = vi.fn((callback: (error?: Error) => void) => callback());
    return server;
  });
}

/** The forwards changed through tunnels' masters, as [command, ...-L specs]. */
function controlCommands(): string[][] {
  return mockControlCommand.mock.calls.map((call) => {
    const args = call[1] as string[];
    const specs = args.filter((_arg, index) => args[index - 1] === '-L');
    return [args[args.indexOf('-O') + 1]!, ...specs];
  });
}

function mockLocalPortReady(): void {
  mockCreateConnection.mockImplementation(() => {
    const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    socket.destroy = vi.fn();
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
}

function mockEffectiveSshEndpoint(hostname: string, port: number): void {
  mockExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, `hostname ${hostname}\nport ${port}\naddressfamily any\n`, '');
    }
  );
}

describe('sshPortForwardService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAllocatedPort(53127);
    mockLocalPortReady();
    mockControlCommand.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => callback(null, '', '')
    );
    mockEffectiveSshEndpoint('devbox.example.com', 2222);
    mockRemoteKomlaDataPort.mockReturnValue(62042);
    mockGetHost.mockReturnValue({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      user: 'me',
      port: 2222,
      identityFile: '/home/me/.ssh/id_ed25519',
      basePath: '~/.komla',
      forwardAgent: true,
      extraSshArgs: ['-J', 'bastion'],
    });
  });

  afterEach(async () => {
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    await sshPortForwardService.dispose();
  });

  it('starts an SSH local forward that resolves localhost on the remote host', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const result = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    expect(result).toMatchObject({
      workspaceId: 'ws-1',
      localUrl: 'http://127.0.0.1:53127',
      localPort: 53127,
      remotePort: 3000,
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o',
        'ControlMaster=yes',
        '-o',
        'ControlPersist=no',
        '-o',
        'IgnoreUnknown=StdinNull,ForkAfterAuthentication,SessionType',
        '-o',
        'RemoteCommand=none',
        '-o',
        'StdinNull=no',
        '-o',
        'ForkAfterAuthentication=no',
        '-o',
        'SessionType=default',
        '-p',
        '2222',
        '-i',
        '/home/me/.ssh/id_ed25519',
        '-J',
        'bastion',
        '-S',
        expect.stringMatching(/komla-ssh-/),
        '-T',
        '-L',
        '127.0.0.1:53127:localhost:3000',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        'me@devbox.example.com',
        'exec cat >/dev/null',
      ],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'pipe'] })
    );
  });

  it('forwards a virtual desktop VNC port in its own tunnel, which previews leave running', async () => {
    mockAllocatedPorts([5901, 3000]);
    const vncTunnel = createMockChild();
    mockSpawn.mockReturnValueOnce(vncTunnel).mockReturnValueOnce(createMockChild());
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const localPort = await sshPortForwardService.startVncForward('ssh-devbox', 5901);
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });
    await sshPortForwardService.stopPreviewForward('ws-1');

    expect(localPort).toBe(5901);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['-L', '127.0.0.1:5901:localhost:5901'])
    );
    expect(mockSpawn.mock.calls[1]?.[1]).not.toContain('127.0.0.1:5901:localhost:5901');
    expect(vncTunnel.kill).not.toHaveBeenCalled();
    await expect(sshPortForwardService.startVncForward('ssh-devbox', 5901)).resolves.toBe(5901);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('restarts the VNC forward after the host is edited to point elsewhere', async () => {
    mockAllocatedPort(5901);
    const oldTunnel = createMockChild();
    mockSpawn.mockReturnValueOnce(oldTunnel).mockReturnValueOnce(createMockChild());
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startVncForward('ssh-devbox', 5901);
    mockGetHost.mockReturnValue({ ...mockGetHost(), hostname: 'new-devbox.example.com' });
    await sshPortForwardService.startVncForward('ssh-devbox', 5901);

    expect(oldTunnel.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1]?.[1]).toContain('me@new-devbox.example.com');
  });

  it("stops the VNC forward with the host's other port forwards", async () => {
    mockAllocatedPort(5901);
    const vncTunnel = createMockChild();
    mockSpawn.mockReturnValue(vncTunnel);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startVncForward('ssh-devbox', 5901);
    await sshPortForwardService.stopHostPortForwards('ssh-devbox');

    expect(vncTunnel.kill).toHaveBeenCalled();
  });

  it("keeps a VNC forward per desktop and closes those to the host's stopped desktops", async () => {
    mockAllocatedPorts([5903, 5904, 5905]);
    const tunnels = [createMockChild(), createMockChild(), createMockChild()];
    for (const tunnel of tunnels) mockSpawn.mockReturnValueOnce(tunnel);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startVncForward('ssh-devbox', 5903);
    await expect(
      sshPortForwardService.startVncForward('ssh-devbox', 5904, [5903, 5904])
    ).resolves.toBe(5904);
    expect(tunnels[0]!.kill).not.toHaveBeenCalled();
    await expect(
      sshPortForwardService.startVncForward('ssh-devbox', 5905, [5904, 5905])
    ).resolves.toBe(5905);

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(tunnels[0]!.kill).toHaveBeenCalled();
    expect(tunnels[1]!.kill).not.toHaveBeenCalled();
    await expect(sshPortForwardService.startVncForward('ssh-devbox', 5904)).resolves.toBe(5904);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    await sshPortForwardService.stopHostPortForwards('ssh-devbox');
    expect(tunnels[1]!.kill).toHaveBeenCalled();
    expect(tunnels[2]!.kill).toHaveBeenCalled();
  });

  it('prefers the remote port for the local preview when it is available', async () => {
    mockAllocatedPort(3000);
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const result = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    const allocationServer = mockCreateServer.mock.results[0]?.value;
    expect(allocationServer.listen).toHaveBeenCalledWith(3000, '127.0.0.1', expect.any(Function));
    expect(result).toMatchObject({
      localUrl: 'http://127.0.0.1:3000',
      localPort: 3000,
      remotePort: 3000,
    });
  });

  it('falls back to an ephemeral local port when the remote port is busy locally', async () => {
    mockCreateServer.mockImplementationOnce(() => {
      const server = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        address: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      server.listen = vi.fn(() => {
        queueMicrotask(() => server.emit('error', new Error('EADDRINUSE')));
        return server;
      });
      server.address = vi.fn(() => null);
      server.close = vi.fn();
      return server;
    });
    mockAllocatedPort(53127);
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const result = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    const preferredServer = mockCreateServer.mock.results[0]?.value;
    const fallbackServer = mockCreateServer.mock.results[1]?.value;
    expect(preferredServer.listen).toHaveBeenCalledWith(3000, '127.0.0.1', expect.any(Function));
    expect(fallbackServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
    expect(result).toMatchObject({
      localUrl: 'http://127.0.0.1:53127',
      localPort: 53127,
      remotePort: 3000,
    });
  });

  it.each([
    ['ControlPath option', ['-o', 'ControlPath=/tmp/shared-ssh-control']],
    ['control socket flag', ['-S', '/tmp/shared-ssh-control']],
  ])('disables multiplexing after a user-provided %s', async (_label, extraSshArgs) => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    mockGetHost.mockReturnValue({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      user: 'me',
      basePath: '~/.komla',
      extraSshArgs,
    });
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    const sshArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(sshArgs).toEqual(expect.arrayContaining(extraSshArgs));
    const overrideIndex = sshArgs.lastIndexOf('-S');
    expect(sshArgs[overrideIndex + 1]).toBe('none');
    expect(overrideIndex).toBeGreaterThan(sshArgs.indexOf(extraSshArgs.at(-1)!));
  });

  it('keeps the parent lease active when SSH options disable stdin or remote commands', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    mockGetHost.mockReturnValue({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      basePath: '~/.komla',
      extraSshArgs: [
        '-n',
        '-f',
        '-N',
        '-vvn',
        '-o',
        'StdinNull=yes',
        '-oForkAfterAuthentication=yes',
        '-o',
        'SessionType=none',
        '-o',
        'RemoteCommand=uptime',
      ],
    });
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    const sshArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(sshArgs.slice(4, 14)).toEqual([
      '-o',
      'IgnoreUnknown=StdinNull,ForkAfterAuthentication,SessionType',
      '-o',
      'RemoteCommand=none',
      '-o',
      'StdinNull=no',
      '-o',
      'ForkAfterAuthentication=no',
      '-o',
      'SessionType=default',
    ]);
    expect(sshArgs).toContain('-vv');
    expect(sshArgs).not.toContain('-n');
    expect(sshArgs).not.toContain('-f');
    expect(sshArgs).not.toContain('-N');
    expect(sshArgs.indexOf('RemoteCommand=none')).toBeLessThan(
      sshArgs.indexOf('RemoteCommand=uptime')
    );
  });

  it('preserves HTTPS in the local forwarded URL', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const result = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-https',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 443,
      scheme: 'https',
    });

    expect(result.localUrl).toBe('https://127.0.0.1:53127');
  });

  it('reuses a matching preview forward owned by the main process', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const request = {
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh' as const,
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    };

    const first = await sshPortForwardService.startPreviewForward(request);
    const second = await sshPortForwardService.startPreviewForward(request);

    expect(second).toEqual(first);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a remote preview endpoint already forwarded by another workspace', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 3000,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: { ...backend, remoteDirectory: '/remote/worktree-2' },
        remotePort: 3000,
      })
    ).rejects.toThrow(
      'Remote port 3000 on this SSH host is already forwarded by another workspace'
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rejects a remote preview endpoint forwarded through an equivalent SSH host record', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: 'devbox.example.com',
      user: 'me',
      port: 2222,
      basePath: '~/.komla',
    }));
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox-1',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).rejects.toThrow(
      'Remote port 3000 on this SSH host is already forwarded by another workspace'
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('allows identical SSH records when probes resolve to different endpoints', async () => {
    mockAllocatedPorts([53127, 53128]);
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    mockSpawn.mockReturnValueOnce(firstChild).mockReturnValue(secondChild);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: 'preview',
      user: 'me',
      port: 22,
      basePath: '~/.komla',
    }));
    let probeCount = 0;
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        probeCount += 1;
        const hostname = probeCount === 1 ? 'worker-one.internal' : 'worker-two.internal';
        callback(null, `hostname ${hostname}\nport 22\naddressfamily any\n`, '');
      }
    );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox-1',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 3000,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          ...backend,
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
        },
        remotePort: 3000,
      })
    ).resolves.toMatchObject({ workspaceId: 'ws-2', remotePort: 3000 });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('allows the same hostname when SSH resolves the records to different ports', async () => {
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    mockSpawn.mockReturnValue(firstChild);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: 'devbox.example.com',
      user: 'me',
      basePath: '~/.komla',
      extraSshArgs: [`-oPort=${hostId === 'ssh-devbox-1' ? 2201 : 2202}`],
    }));
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    mockEffectiveSshEndpoint('devbox.example.com', 2201);

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox-1',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });
    mockSpawn.mockReturnValue(secondChild);
    mockEffectiveSshEndpoint('devbox.example.com', 2202);

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).resolves.toMatchObject({ workspaceId: 'ws-2', remotePort: 3000 });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('allows scoped IPv6 destinations whose interface names differ by case', async () => {
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    mockSpawn.mockReturnValue(firstChild);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: hostId === 'ssh-devbox-1' ? 'fe80::1%ETH0' : 'fe80::1%eth0',
      user: 'me',
      port: 22,
      basePath: '~/.komla',
    }));
    mockExecFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const hostname = args.at(-2)?.split('@').at(-1) ?? '';
        callback(null, `hostname ${hostname}\nport 22\naddressfamily inet6\n`, '');
      }
    );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox-1',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });
    mockSpawn.mockReturnValue(secondChild);

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).resolves.toMatchObject({ workspaceId: 'ws-2', remotePort: 3000 });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('rejects equivalent endpoints selected by command-sensitive SSH configuration', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: hostId === 'ssh-devbox-1' ? 'preview-one' : 'preview-two',
      user: 'me',
      basePath: '~/.komla',
    }));
    mockExecFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const hasLeaseCommand = args.at(-1) === 'exec cat >/dev/null';
        const target = args.at(hasLeaseCommand ? -2 : -1) ?? '';
        const hostname = hasLeaseCommand
          ? 'shared.internal'
          : target.includes('preview-one')
            ? 'preview-one'
            : 'preview-two';
        callback(null, `hostname ${hostname}\nport 22\naddressfamily any\n`, '');
      }
    );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox-1',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).rejects.toThrow(
      'Remote port 3000 on this SSH host is already forwarded by another workspace'
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate endpoint when one SSH alias probe fails', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: hostId === 'ssh-devbox-1' ? 'preview-one' : 'preview-two',
      user: 'me',
      port: 2222,
      basePath: '~/.komla',
    }));
    let probeCount = 0;
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        probeCount += 1;
        if (probeCount === 1) {
          callback(null, 'hostname shared.internal\nport 2222\naddressfamily any\n', '');
        } else {
          callback(new Error('SSH configuration probe timed out'), '', '');
        }
      }
    );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox-1',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).rejects.toThrow(
      'Remote port 3000 on this SSH host is already forwarded by another workspace'
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('allows proxy routes that use different original hosts and remote users', async () => {
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    mockSpawn.mockReturnValue(firstChild);
    mockGetHost.mockImplementation((hostId: string) => {
      const first = hostId === 'ssh-devbox-1';
      return {
        id: hostId,
        name: hostId,
        hostname: first ? 'preview-one' : 'preview-two',
        user: first ? 'alice' : 'bob',
        basePath: '~/.komla',
        extraSshArgs: ['-oProxyCommand=route --alias %n --user %r'],
      };
    });
    mockExecFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const user = args.at(-2)?.startsWith('alice@') ? 'alice' : 'bob';
        callback(
          null,
          `hostname shared.internal\nport 22\nuser ${user}\naddressfamily any\nproxycommand route --alias %n --user %r\n`,
          ''
        );
      }
    );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox-1',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });
    mockSpawn.mockReturnValue(secondChild);

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-2',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).resolves.toMatchObject({ workspaceId: 'ws-2', remotePort: 3000 });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid remote ports before spawning ssh', async () => {
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox',
          remoteDirectory: '/remote/worktree',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 0,
      })
    ).rejects.toThrow('remotePort must be an integer between 1 and 65535');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('kills the tracked process when stopping a forward', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    await sshPortForwardService.stopPreviewForward('ws-1');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('serializes a stop behind an in-flight preview start', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
    mockCreateConnection.mockImplementation(() => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: ReturnType<typeof vi.fn>;
      };
      socket.destroy = vi.fn();
      sockets.push(socket);
      return socket;
    });
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const starting = sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    const stopping = sshPortForwardService.stopPreviewForward('ws-1');
    expect(child.kill).not.toHaveBeenCalled();
    sockets[0]?.emit('connect');
    await starting;
    await stopping;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('aggregates preview forwards for the same host into one SSH process', async () => {
    mockAllocatedPorts([53127, 53128]);
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree-1',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-2',
      tabId: 'tab-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree-2',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 5173,
    });

    // The second forward joins the running tunnel through its master.
    expect(child.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(controlCommands()).toEqual([['forward', '127.0.0.1:53128:localhost:5173']]);
    const masterArgs = mockSpawn.mock.calls[0]![1] as string[];
    const controlPath = masterArgs[masterArgs.indexOf('-S') + 1];
    expect(mockControlCommand).toHaveBeenCalledWith(
      'ssh',
      [
        '-S',
        controlPath,
        '-O',
        'forward',
        '-L',
        '127.0.0.1:53128:localhost:5173',
        'me@devbox.example.com',
      ],
      expect.anything(),
      expect.any(Function)
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o',
        'ControlMaster=yes',
        '-o',
        'ControlPersist=no',
        '-o',
        'IgnoreUnknown=StdinNull,ForkAfterAuthentication,SessionType',
        '-o',
        'RemoteCommand=none',
        '-o',
        'StdinNull=no',
        '-o',
        'ForkAfterAuthentication=no',
        '-o',
        'SessionType=default',
        '-p',
        '2222',
        '-i',
        '/home/me/.ssh/id_ed25519',
        '-J',
        'bastion',
        '-S',
        controlPath,
        '-T',
        '-L',
        '127.0.0.1:53127:localhost:3000',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        'me@devbox.example.com',
        'exec cat >/dev/null',
      ],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'pipe'] })
    );
  });

  it('keeps a preview forward per browser tab, so showing another tab moves none', async () => {
    mockAllocatedPorts([53127, 53128]);
    const firstChild = createMockChild();
    mockSpawn.mockReturnValue(firstChild);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    const first = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 6081,
    });
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-2',
      backend,
      remotePort: 6082,
    });
    const shownAgain = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 6081,
    });

    expect(shownAgain).toEqual(first);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(controlCommands()).toEqual([['forward', '127.0.0.1:53128:localhost:6082']]);

    await sshPortForwardService.stopPreviewForward('ws-1', 'tab-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(controlCommands().at(-1)).toEqual(['cancel', '127.0.0.1:53127:localhost:6081']);
  });

  it('cancels every forward a workspace gives up with one control command', async () => {
    mockAllocatedPorts([53127, 53128, 53129]);
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };
    for (const [workspaceId, tabId, remotePort] of [
      ['ws-1', 'tab-1', 3000],
      ['ws-1', 'tab-2', 5173],
      ['ws-2', 'tab-1', 8080],
    ] as const) {
      await sshPortForwardService.startPreviewForward({ workspaceId, tabId, backend, remotePort });
    }
    mockControlCommand.mockClear();

    await sshPortForwardService.stopPreviewForward('ws-1');

    expect(child.kill).not.toHaveBeenCalled();
    expect(controlCommands()).toEqual([
      ['cancel', '127.0.0.1:53127:localhost:3000', '127.0.0.1:53128:localhost:5173'],
    ]);
  });

  describe('starts a new preview tunnel with every forward', () => {
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };
    const forwards = (call: unknown[]) =>
      (call[1] as string[]).filter((arg) => arg.includes(':localhost:'));

    async function startTwoForwards(): Promise<{ first: MockChild; second: MockChild }> {
      mockAllocatedPorts([53127, 53128]);
      const first = createMockChild();
      const second = createMockChild();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');
      await sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend,
        remotePort: 3000,
      });
      await sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-2',
        backend,
        remotePort: 5173,
      });
      return { first, second };
    }

    it("when the tunnel's master refuses the change", async () => {
      mockControlCommand.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(new Error('exit 255'), '', 'Control socket connect: No such file')
      );

      const { first } = await startTwoForwards();

      expect(controlCommands()).toEqual([['forward', '127.0.0.1:53128:localhost:5173']]);
      expect(first.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(forwards(mockSpawn.mock.calls[1]!)).toEqual([
        '127.0.0.1:53127:localhost:3000',
        '127.0.0.1:53128:localhost:5173',
      ]);
    });

    it('when the host was edited since the tunnel started', async () => {
      mockAllocatedPorts([53127, 53128]);
      const first = createMockChild();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(createMockChild());
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');
      await sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend,
        remotePort: 3000,
      });
      mockGetHost.mockReturnValue({
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox-2.example.com',
        user: 'me',
        basePath: '~/.komla',
      });

      await sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-2',
        backend,
        remotePort: 5173,
      });

      expect(mockControlCommand).not.toHaveBeenCalled();
      expect(first.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockSpawn.mock.calls[1]![1]).toContain('me@devbox-2.example.com');
    });

    it('when the ssh config now sends the host elsewhere', async () => {
      mockAllocatedPorts([53127, 53128]);
      const first = createMockChild();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(createMockChild());
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');
      await sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend,
        remotePort: 3000,
      });
      mockEffectiveSshEndpoint('devbox-3.example.com', 22);

      await sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-2',
        backend,
        remotePort: 5173,
      });

      expect(mockControlCommand).not.toHaveBeenCalled();
      expect(first.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('when the host sets its own control socket', async () => {
      mockGetHost.mockReturnValue({
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        user: 'me',
        basePath: '~/.komla',
        extraSshArgs: ['-o', 'ControlPath=~/.ssh/cm-%C'],
      });

      const { first } = await startTwoForwards();

      expect(mockControlCommand).not.toHaveBeenCalled();
      expect(first.kill).toHaveBeenCalledWith('SIGTERM');
      const args = mockSpawn.mock.calls[1]![1] as string[];
      expect(args[args.indexOf('-S') + 1]).toBe('none');
      expect(args).not.toContain('ControlMaster=yes');
    });
  });

  it('opens a link in the default browser through a forward the host already has to its port', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    const tabForward = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 3000,
    });
    const sameWorkspace = await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-1',
      backend,
      remotePort: 3000,
    });
    const otherWorkspace = await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-2',
      backend: { ...backend, remoteDirectory: '/remote/worktree-2' },
      remotePort: 3000,
    });

    expect(sameWorkspace).toEqual({ ...tabForward, started: false });
    expect(otherWorkspace).toEqual({ ...tabForward, started: false });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("gives a link's forward up to another workspace that forwards its port", async () => {
    mockAllocatedPorts([53127, 53128]);
    mockSpawn.mockImplementation(() => createMockChild());
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    const linkForward = await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-1',
      backend,
      remotePort: 3000,
    });
    const tabForward = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-2',
      tabId: 'tab-1',
      backend: { ...backend, remoteDirectory: '/remote/worktree-2' },
      remotePort: 3000,
    });

    const forwards = (call: unknown[]) =>
      (call[1] as string[]).filter((arg) => arg.includes(':localhost:'));
    expect(forwards(mockSpawn.mock.calls[0]!)).toEqual(['127.0.0.1:53127:localhost:3000']);
    expect(controlCommands()).toEqual([
      ['cancel', '127.0.0.1:53127:localhost:3000'],
      ['forward', '127.0.0.1:53128:localhost:3000'],
    ]);
    expect(linkForward).toMatchObject({ localPort: 53127, started: true });
    expect(tabForward.localPort).toBe(53128);
    // The link in the first workspace opens through that forward now.
    await expect(
      sshPortForwardService.startLinkForward({ workspaceId: 'ws-1', backend, remotePort: 3000 })
    ).resolves.toEqual({ ...tabForward, started: false });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("keeps a link's forward when a start that would take its port fails", async () => {
    mockAllocatedPorts([53127, 53128, 53129]);
    mockSpawn.mockImplementation(() => createMockChild());
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };
    await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-1',
      backend,
      remotePort: 3000,
    });
    // Forwards the port too, so another workspace can't take it.
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 3000,
    });
    const spawned = mockSpawn.mock.calls.length;

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-2',
        tabId: 'tab-1',
        backend: { ...backend, remoteDirectory: '/remote/worktree-2' },
        remotePort: 3000,
      })
    ).rejects.toThrow('already forwarded by another workspace');

    expect(sshPortForwardService.listForwardedPorts().map((port) => port.kind)).toEqual([
      'link',
      'browser-tab',
    ]);
    expect(mockSpawn).toHaveBeenCalledTimes(spawned);
  });

  it("opens a link through another workspace's forward after the host's tunnel dropped", async () => {
    const dropped = createMockChild();
    const restarted = createMockChild();
    mockSpawn.mockReturnValueOnce(dropped).mockReturnValueOnce(restarted);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree-2',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };
    const tabForward = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-2',
      tabId: 'tab-1',
      backend,
      remotePort: 3000,
    });
    dropped.exitCode = 255;
    dropped.emit('exit', 255, null);
    expect(sshPortForwardService.listForwardedPorts()[0]?.state).toBe('stopped');

    await expect(
      sshPortForwardService.startLinkForward({
        workspaceId: 'ws-1',
        backend: { ...backend, remoteDirectory: '/remote/worktree-1' },
        remotePort: 3000,
      })
    ).resolves.toEqual({ ...tabForward, started: false });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(sshPortForwardService.listForwardedPorts()[0]?.state).toBe('connected');
  });

  it('gives a link a local port no other server holds on [::1], where browsers look first', async () => {
    const busyOnIpv6 = 3000;
    const ports = [3000, 53127];
    let addressIndex = 0;
    mockCreateServer.mockImplementation(() => {
      const server = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        address: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      server.listen = vi.fn((port: number, host: string, callback: () => void) => {
        if (host === '::1' && port === busyOnIpv6) {
          queueMicrotask(() =>
            server.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))
          );
        } else {
          callback();
        }
        return server;
      });
      server.address = vi.fn(() => ({ port: ports[Math.min(addressIndex++, ports.length - 1)] }));
      server.close = vi.fn((callback: (error?: Error) => void) => callback());
      return server;
    });
    mockSpawn.mockImplementation(() => createMockChild());
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const forward = await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-1',
      backend: {
        kind: 'ssh' as const,
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
      },
      remotePort: 3000,
    });

    expect(forward.localPort).toBe(53127);
  });

  it("stops a link's own forward, and no other", async () => {
    mockAllocatedPorts([53127, 53128]);
    mockSpawn.mockImplementation(() => createMockChild());
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };
    const tabForward = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 6081,
    });
    const linkForward = await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-1',
      backend,
      remotePort: 6082,
    });

    await sshPortForwardService.stopLinkForward('ws-1', tabForward.id);
    await sshPortForwardService.stopLinkForward('ws-2', linkForward.id);
    expect(controlCommands()).toEqual([['forward', '127.0.0.1:53128:localhost:6082']]);

    await sshPortForwardService.stopLinkForward('ws-1', linkForward.id);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(controlCommands().at(-1)).toEqual(['cancel', '127.0.0.1:53128:localhost:6082']);
  });

  it('lists the ports it forwards for each host, by what each is for', async () => {
    mockAllocatedPorts([53127, 53128, 53129]);
    const desktopChild = createMockChild();
    const savedChild = createMockChild();
    const komlaChild = createMockChild();
    mockSpawn
      .mockReturnValueOnce(createMockChild())
      .mockReturnValueOnce(desktopChild)
      .mockReturnValueOnce(savedChild)
      .mockReturnValueOnce(komlaChild);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/remote/worktree',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    const tabForward = await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend,
      remotePort: 6081,
    });
    const linkForward = await sshPortForwardService.startLinkForward({
      workspaceId: 'ws-1',
      backend,
      remotePort: 6082,
    });
    await sshPortForwardService.startVncForward('ssh-devbox', 5901, [5901]);
    const saving = sshPortForwardService.reconcileHostPortForwards({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      basePath: '~/.komla',
      portForwards: [
        { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
        { id: 'redis', name: 'Redis', localPort: 6379, remotePort: 16379, enabled: false },
      ],
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(3));
    markConfiguredForwardReady(savedChild, [15432]);
    await saving;
    const connecting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(4));
    markKomlaDataTunnelReady(komlaChild);
    await connecting;

    expect(sshPortForwardService.listForwardedPorts()).toEqual([
      {
        id: tabForward.id,
        hostId: 'ssh-devbox',
        kind: 'browser-tab',
        direction: 'remote-to-local',
        localPort: 53127,
        remotePort: 6081,
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        state: 'connected',
      },
      {
        id: linkForward.id,
        hostId: 'ssh-devbox',
        kind: 'link',
        direction: 'remote-to-local',
        localPort: 53128,
        remotePort: 6082,
        workspaceId: 'ws-1',
        state: 'connected',
      },
      {
        id: 'desktop:ssh-devbox:5901',
        hostId: 'ssh-devbox',
        kind: 'desktop',
        direction: 'remote-to-local',
        localPort: 53129,
        remotePort: 5901,
      },
      {
        id: 'saved:ssh-devbox:postgres',
        hostId: 'ssh-devbox',
        kind: 'saved',
        direction: 'local-to-remote',
        localPort: 5432,
        remotePort: 15432,
        name: 'PostgreSQL',
        state: 'connected',
      },
      {
        id: 'komla:ssh-devbox',
        hostId: 'ssh-devbox',
        kind: 'komla',
        direction: 'local-to-remote',
        localPort: expect.any(Number),
        remotePort: 62042,
      },
    ]);

    await sshPortForwardService.stopDesktopForward('ssh-devbox', 5901);

    expect(desktopChild.kill).toHaveBeenCalled();
    expect(sshPortForwardService.listForwardedPorts().map((port) => port.kind)).toEqual([
      'browser-tab',
      'link',
      'saved',
      'komla',
    ]);
  });

  it('refreshes existing endpoint identities when rebuilding a shared preview tunnel', async () => {
    mockAllocatedPorts([53127, 53128, 53129]);
    const firstChild = createMockChild();
    const rebuiltChild = createMockChild();
    const conflictingChild = createMockChild();
    mockSpawn
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(rebuiltChild)
      .mockReturnValue(conflictingChild);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: hostId === 'ssh-devbox-1' ? 'preview-one' : 'preview-two',
      user: 'me',
      basePath: '~/.komla',
    }));
    mockExecFile
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, 'hostname old.internal\nport 22\naddressfamily any\n', '')
      )
      .mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, 'hostname current.internal\nport 22\naddressfamily any\n', '')
      );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const firstBackend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox-1',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: firstBackend,
      remotePort: 3000,
    });
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-2',
      tabId: 'tab-1',
      backend: { ...firstBackend, remoteDirectory: '/remote/worktree-2' },
      remotePort: 5173,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-3',
        tabId: 'tab-1',
        backend: {
          ...firstBackend,
          hostId: 'ssh-devbox-2',
          remoteDirectory: '/remote/worktree-3',
        },
        remotePort: 3000,
      })
    ).rejects.toThrow(
      'Remote port 3000 on this SSH host is already forwarded by another workspace'
    );
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('rejects rebuilding a shared tunnel when an existing forward would migrate into a conflict', async () => {
    mockAllocatedPorts([53127, 53128, 53129]);
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    const replacementChild = createMockChild();
    mockSpawn
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValue(replacementChild);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: hostId === 'ssh-devbox-1' ? 'preview-one' : 'preview-two',
      user: 'me',
      basePath: '~/.komla',
    }));
    mockExecFile
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, 'hostname old.internal\nport 22\naddressfamily any\n', '')
      )
      .mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, 'hostname current.internal\nport 22\naddressfamily any\n', '')
      );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const firstBackend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox-1',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: firstBackend,
      remotePort: 3000,
    });
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-2',
      tabId: 'tab-1',
      backend: {
        ...firstBackend,
        hostId: 'ssh-devbox-2',
        remoteDirectory: '/remote/worktree-2',
      },
      remotePort: 3000,
    });

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-3',
        tabId: 'tab-1',
        backend: { ...firstBackend, remoteDirectory: '/remote/worktree-3' },
        remotePort: 5173,
      })
    ).rejects.toThrow(
      'Remote port 3000 on this SSH host is already forwarded by another workspace'
    );
    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(secondChild.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend: firstBackend,
        remotePort: 5173,
      })
    ).resolves.toMatchObject({ workspaceId: 'ws-1', remotePort: 5173 });
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(secondChild.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('removes a forward when the remaining tunnel cannot migrate without a conflict', async () => {
    mockAllocatedPorts([53127, 53128, 53129]);
    const firstChild = createMockChild();
    const otherHostChild = createMockChild();
    mockSpawn.mockReturnValueOnce(firstChild).mockReturnValue(otherHostChild);
    mockGetHost.mockImplementation((hostId: string) => ({
      id: hostId,
      name: hostId,
      hostname: hostId === 'ssh-devbox-1' ? 'preview-one' : 'preview-two',
      user: 'me',
      basePath: '~/.komla',
    }));
    const oldEndpoint = 'hostname old.internal\nport 22\naddressfamily any\n';
    const currentEndpoint = 'hostname current.internal\nport 22\naddressfamily any\n';
    mockExecFile
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, oldEndpoint, '')
      )
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, oldEndpoint, '')
      )
      .mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => callback(null, currentEndpoint, '')
      );
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const firstBackend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox-1',
      remoteDirectory: '/remote/worktree-1',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
    };

    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-1',
      tabId: 'tab-1',
      backend: firstBackend,
      remotePort: 3000,
    });
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-to-stop',
      tabId: 'tab-1',
      backend: { ...firstBackend, remoteDirectory: '/remote/worktree-2' },
      remotePort: 5173,
    });
    await sshPortForwardService.startPreviewForward({
      workspaceId: 'ws-2',
      tabId: 'tab-1',
      backend: {
        ...firstBackend,
        hostId: 'ssh-devbox-2',
        remoteDirectory: '/remote/worktree-3',
      },
      remotePort: 3000,
    });

    await expect(sshPortForwardService.stopPreviewForward('ws-to-stop')).resolves.toBeUndefined();
    await expect(sshPortForwardService.stopPreviewForward('ws-to-stop')).resolves.toBeUndefined();
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(otherHostChild.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('runs configured services as loopback-only forwards in both directions', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const host = {
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      user: 'me',
      port: 2222,
      identityFile: '/home/me/.ssh/id_ed25519',
      basePath: '~/.komla',
      extraSshArgs: [
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ExitOnForwardFailure=no',
        '-J',
        'bastion',
      ],
      portForwards: [
        { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
        { id: 'redis', name: 'Redis', localPort: 6379, remotePort: 16379, enabled: true },
        {
          id: 'remote-api',
          name: 'Remote API',
          direction: 'remote-to-local' as const,
          localPort: 8080,
          remotePort: 3000,
          enabled: true,
        },
      ],
    };

    const starting = sshPortForwardService.reconcileHostPortForwards(host);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    expect(sshPortForwardService.getHostPortForwardStatus(host.id).state).toBe('connecting');
    markConfiguredForwardReady(child);
    await starting;

    expect(sshPortForwardService.getHostPortForwardStatus(host.id)).toEqual({
      hostId: host.id,
      state: 'connected',
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o',
        'ClearAllForwardings=no',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'IgnoreUnknown=StdinNull,ForkAfterAuthentication,SessionType',
        '-o',
        'RemoteCommand=none',
        '-o',
        'StdinNull=no',
        '-o',
        'ForkAfterAuthentication=no',
        '-o',
        'SessionType=default',
        '-p',
        '2222',
        '-i',
        '/home/me/.ssh/id_ed25519',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ExitOnForwardFailure=no',
        '-J',
        'bastion',
        '-S',
        'none',
        '-T',
        '-R',
        '127.0.0.1:15432:127.0.0.1:5432',
        '-R',
        '127.0.0.1:16379:127.0.0.1:6379',
        '-L',
        '127.0.0.1:8080:127.0.0.1:3000',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        'me@devbox.example.com',
        expect.stringContaining("printf '__KOMLA_PORT_FORWARDS_READY__\\n'"),
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );

    await sshPortForwardService.reconcileHostPortForwards({
      ...host,
      portForwards: host.portForwards.map((forward) => ({ ...forward, enabled: false })),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sshPortForwardService.getHostPortForwardStatus(host.id).state).toBe('stopped');
  });

  it('sends configured forward lease heartbeats', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');

      const starting = sshPortForwardService.reconcileHostPortForwards({
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        basePath: '~/.komla',
        portForwards: [
          { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      markConfiguredForwardReady(child, [15432]);
      await starting;

      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.stdin.write).toHaveBeenCalledExactlyOnceWith('\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips remote listener probing for local-only configured forwards', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const starting = sshPortForwardService.reconcileHostPortForwards({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      basePath: '~/.komla',
      portForwards: [
        {
          id: 'remote-api',
          name: 'Remote API',
          direction: 'remote-to-local',
          localPort: 8080,
          remotePort: 3000,
          enabled: true,
        },
      ],
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());

    const sshArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toBe(
      `printf '__KOMLA_PORT_FORWARDS_READY__\\n'; ${sshHeartbeatLeaseCommand()}`
    );
    expect(sshArgs.at(-1)).not.toContain('command -v ss');

    child.stdout.emit('data', Buffer.from('__KOMLA_PORT_FORWARDS_READY__\n'));
    await starting;

    expect(sshPortForwardService.getHostPortForwardStatus('ssh-devbox')).toEqual({
      hostId: 'ssh-devbox',
      state: 'connected',
    });
  });

  it.each([
    [
      'a wildcard listener',
      'LISTEN 0 128 0.0.0.0:15432 0.0.0.0:*\n__KOMLA_PORT_FORWARDS_READY__\n',
      'not loopback-only',
    ],
    ['a missing listener', '__KOMLA_PORT_FORWARDS_READY__\n', 'Could not verify'],
  ])('rejects configured forwards with %s', async (_case, readyOutput, expectedError) => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const starting = sshPortForwardService.reconcileHostPortForwards({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      basePath: '~/.komla',
      portForwards: [
        { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
      ],
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    child.stdout.emit('data', Buffer.from(readyOutput));
    await starting;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sshPortForwardService.getHostPortForwardStatus('ssh-devbox')).toMatchObject({
      state: 'error',
      error: expect.stringContaining(expectedError),
    });
  });

  it('does not start a configured forward while disposal waits for reconciliation', async () => {
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount++;
      if (spawnCount === 2) {
        markConfiguredForwardReady(secondChild, [25432]);
        return secondChild;
      }
      return firstChild;
    });
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const host = {
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      basePath: '~/.komla',
      portForwards: [
        { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
      ],
    };

    const initialStart = sshPortForwardService.reconcileHostPortForwards(host);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    markConfiguredForwardReady(firstChild);
    await initialStart;

    firstChild.kill.mockImplementation(() => true);
    const reconciliation = sshPortForwardService.reconcileHostPortForwards({
      ...host,
      portForwards: [{ ...host.portForwards[0], remotePort: 25432 }],
    });
    await vi.waitFor(() => expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM'));

    const disposal = sshPortForwardService.dispose();
    firstChild.exitCode = 0;
    firstChild.emit('exit', 0, 'SIGTERM');
    await Promise.all([reconciliation, disposal]);

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(secondChild.kill).not.toHaveBeenCalled();
  });

  it('does not allow new SSH tunnels after disposal begins', async () => {
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    await sshPortForwardService.dispose();

    await expect(
      sshPortForwardService.startPreviewForward({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox',
          remoteDirectory: '/remote/worktree',
          remoteRepoPath: '/remote/repo.git',
          remoteProjectRoot: '/remote',
        },
        remotePort: 3000,
      })
    ).rejects.toThrow('SSH port forward service is shutting down');
    expect(() =>
      sshPortForwardService.reconcileHostPortForwards({
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        basePath: '~/.komla',
      })
    ).toThrow('SSH port forward service is shutting down');
    expect(() => sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183)).toThrow(
      'SSH port forward service is shutting down'
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('surfaces configured reverse-forward failures and schedules recovery', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const starting = sshPortForwardService.reconcileHostPortForwards({
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: 'devbox.example.com',
      basePath: '~/.komla',
      portForwards: [
        { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
      ],
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    child.stderr.emit('data', Buffer.from('remote port forwarding failed for listen port 15432'));
    child.emit('exit', 255, null);
    await starting;

    expect(sshPortForwardService.getHostPortForwardStatus('ssh-devbox')).toMatchObject({
      hostId: 'ssh-devbox',
      state: 'error',
      error: expect.stringContaining('remote port forwarding failed'),
    });
  });

  it('reports a connection once when repeated ensures reuse the same data tunnel', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');
    const onConnected = vi.fn();
    const first = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183, onConnected);
    const second = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183, onConnected);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    markKomlaDataTunnelReady(child);
    await Promise.all([first, second]);
    await sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183, onConnected);

    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('starts one host-scoped Komla data reverse tunnel', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const first = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    const second = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    markKomlaDataTunnelReady(child);
    await Promise.all([first, second]);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining([
        '-p',
        '2222',
        '-i',
        '/home/me/.ssh/id_ed25519',
        '-J',
        'bastion',
        '-T',
        '-R',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        'me@devbox.example.com',
        `printf '__KOMLA_DATA_TUNNEL_READY__\\n'; ${sshHeartbeatLeaseCommand()}`,
      ]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
    const reverseForward = (mockSpawn.mock.calls[0][1] as string[]).find((arg) =>
      arg.startsWith('127.0.0.1:62042:127.0.0.1:')
    );
    expect(reverseForward).toMatch(/^127\.0\.0\.1:62042:127\.0\.0\.1:\d+$/);
    expect(reverseForward).not.toBe('127.0.0.1:62042:127.0.0.1:54183');
  });

  it('sends Komla data tunnel lease heartbeats until SSH exits', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');

      const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
      await vi.advanceTimersByTimeAsync(0);
      markKomlaDataTunnelReady(child);
      await starting;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.stdin.write).toHaveBeenCalledTimes(2);
      expect(child.stdin.write).toHaveBeenCalledWith('\n');

      await sshPortForwardService.stopKomlaDataTunnel('ssh-devbox');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.stdin.write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resolve a Komla data tunnel until SSH confirms the reverse forward', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    let resolved = false;
    const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    markKomlaDataTunnelReady(child);
    await starting;
    expect(resolved).toBe(true);
  });

  it('restarts a Komla data tunnel after an unexpected exit', async () => {
    vi.useFakeTimers();
    try {
      const firstChild = createMockChild();
      const retryChild = createMockChild();
      mockSpawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(retryChild);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');

      const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      markKomlaDataTunnelReady(firstChild);
      await starting;

      firstChild.stderr.emit('data', Buffer.from('connection reset by peer'));
      firstChild.exitCode = 255;
      firstChild.emit('exit', 255, null);

      await vi.advanceTimersByTimeAsync(999);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      markKomlaDataTunnelReady(retryChild);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a recovered data tunnel to the latest listener after reusing the connection', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      const retryChild = createMockChild();
      mockSpawn.mockReturnValueOnce(child).mockReturnValueOnce(retryChild);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');
      const initialListener = vi.fn();
      const latestListener = vi.fn();
      const starting = sshPortForwardService.ensureKomlaDataTunnel(
        'ssh-devbox',
        54183,
        initialListener
      );
      await vi.advanceTimersByTimeAsync(0);
      markKomlaDataTunnelReady(child);
      await starting;
      await sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183, latestListener);
      expect(initialListener).toHaveBeenCalledOnce();
      expect(latestListener).not.toHaveBeenCalled();

      child.exitCode = 255;
      child.emit('exit', 255, null);
      await vi.advanceTimersByTimeAsync(1_000);
      markKomlaDataTunnelReady(retryChild);
      await vi.advanceTimersByTimeAsync(0);
      expect(latestListener).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a successful automatic Komla data tunnel retry', async () => {
    vi.useFakeTimers();
    try {
      const failedChild = createMockChild();
      const retryChild = createMockChild();
      mockSpawn.mockReturnValueOnce(failedChild).mockReturnValueOnce(retryChild);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');
      const onConnected = vi.fn();

      const starting = sshPortForwardService.ensureKomlaDataTunnel(
        'ssh-devbox',
        54183,
        onConnected
      );
      await vi.advanceTimersByTimeAsync(0);
      failedChild.stderr.emit('data', Buffer.from('connection refused'));
      failedChild.exitCode = 255;
      failedChild.emit('exit', 255, null);
      await expect(starting).rejects.toThrow('connection refused');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      markKomlaDataTunnelReady(retryChild);
      await vi.advanceTimersByTimeAsync(0);

      expect(onConnected).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending Komla data tunnel restart when the host becomes inactive', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');

      const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
      await vi.advanceTimersByTimeAsync(0);
      markKomlaDataTunnelReady(child);
      await starting;
      child.exitCode = 255;
      child.emit('exit', 255, null);

      sshPortForwardService.stopKomlaDataTunnelsExcept(new Set());
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and removes a Komla data tunnel when SSH exits before readiness', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    child.stderr.emit('data', Buffer.from('remote port forwarding failed'));
    child.exitCode = 255;
    child.emit('exit', 255, null);

    await expect(starting).rejects.toThrow('remote port forwarding failed');

    const retryChild = createMockChild();
    mockSpawn.mockReturnValue(retryChild);
    const retry = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    markKomlaDataTunnelReady(retryChild);
    await retry;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a queued Komla data tunnel after the host is stopped', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const first = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    const second = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));

    sshPortForwardService.stopKomlaDataTunnelsExcept(new Set());

    await expect(results).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('stops Komla data tunnels for inactive hosts', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    markKomlaDataTunnelReady(child);
    await starting;
    sshPortForwardService.stopKomlaDataTunnelsExcept(new Set());

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('can restart a Komla data tunnel after stopping that host tunnel', async () => {
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    mockSpawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    const firstStart = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    markKomlaDataTunnelReady(firstChild);
    await firstStart;

    await sshPortForwardService.stopKomlaDataTunnel('ssh-devbox');
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');

    const secondStart = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', 54183);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    markKomlaDataTunnelReady(secondChild);
    await secondStart;

    expect(secondChild.kill).not.toHaveBeenCalled();
  });

  it('forwards gateway requests with the configured SSH host identity', async () => {
    let upstreamRequests = 0;
    let upstreamHostId: string | undefined;
    const upstream = createHttpServer((request, response) => {
      upstreamRequests++;
      upstreamHostId = request.headers['x-komla-ssh-host-id'] as string | undefined;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    const upstreamPort = await listen(upstream);
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    try {
      const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', upstreamPort);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      markKomlaDataTunnelReady(child);
      await starting;

      const reverseForward = (mockSpawn.mock.calls[0][1] as string[]).find((arg) =>
        arg.startsWith('127.0.0.1:62042:127.0.0.1:')
      );
      const gatewayPort = Number(reverseForward?.split(':').at(-1));

      await expect(requestGateway(gatewayPort, 'spoofed-host')).resolves.toEqual({
        status: 200,
        body: '{"ok":true}',
      });
      expect(upstreamRequests).toBe(1);
      expect(upstreamHostId).toBe('ssh-devbox');
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('forwards only the routes the remote Komla helper uses', async () => {
    const upstreamPaths: string[] = [];
    const upstream = createHttpServer((request, response) => {
      upstreamPaths.push(request.url ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    const upstreamPort = await listen(upstream);
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    try {
      const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', upstreamPort);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      markKomlaDataTunnelReady(child);
      await starting;

      const reverseForward = (mockSpawn.mock.calls[0][1] as string[]).find((arg) =>
        arg.startsWith('127.0.0.1:62042:127.0.0.1:')
      );
      const gatewayPort = Number(reverseForward?.split(':').at(-1));

      const allowed = [
        '/api/v1/health',
        '/api/v1/notify',
        '/api/v1/ssh-workspace-status',
        '/api/v1/mcp',
        '/terminals/terminal-1/api/v1/commands?cwd=%2Frepo',
        '/terminals/terminal-1/api/v1/cli/mcp',
        '/terminals/terminal-1/settings/actions?scope=current-project',
        '/terminals/terminal-1/api/v1/settings/workspace-setup',
        '/skills/komla-project-setup-instructions.md',
      ];
      for (const path of allowed) {
        await expect(requestGateway(gatewayPort, undefined, path)).resolves.toMatchObject({
          status: 200,
        });
      }
      const blocked = [
        '/api/v1/workspace',
        '/api/workspace',
        '/terminals/terminal-1/api/v1/workspace',
        '/validate-settings',
        '/skills/../api/v1/workspace',
        '/terminals/%E0%A4%A/api/v1/notify',
      ];
      for (const path of blocked) {
        await expect(requestGateway(gatewayPort, undefined, path)).resolves.toMatchObject({
          status: 404,
        });
      }
      expect(upstreamPaths).toEqual(allowed);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('keeps the host-scoped gateway connection reusable across MCP requests', async () => {
    const upstream = createHttpServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ path: request.url }));
    });
    const upstreamPort = await listen(upstream);
    const child = createMockChild();
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    mockSpawn.mockReturnValue(child);
    const { sshPortForwardService } =
      await import('../../../src/main/services/ssh-port-forward.service');

    try {
      const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', upstreamPort);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      markKomlaDataTunnelReady(child);
      await starting;

      const reverseForward = (mockSpawn.mock.calls[0][1] as string[]).find((arg) =>
        arg.startsWith('127.0.0.1:62042:127.0.0.1:')
      );
      const gatewayPort = Number(reverseForward?.split(':').at(-1));

      const initialize = await requestGatewayWithAgent(
        gatewayPort,
        '/api/v1/mcp?message=initialize',
        agent
      );
      const initialized = await requestGatewayWithAgent(
        gatewayPort,
        '/api/v1/mcp?message=initialized',
        agent
      );

      expect(initialize).toMatchObject({
        status: 200,
        body: '{"path":"/api/v1/mcp?message=initialize"}',
      });
      expect(initialized).toMatchObject({
        status: 200,
        body: '{"path":"/api/v1/mcp?message=initialized"}',
      });
      expect(initialize.connection).not.toBe('close');
      expect(initialized.socket).toBe(initialize.socket);
    } finally {
      agent.destroy();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it.each([0, 1024 * 1024])(
    'closes the host-scoped gateway connection when the upstream request fails (%i byte body)',
    async (bodySize) => {
      const unavailableUpstream = createHttpServer();
      const unavailablePort = await listen(unavailableUpstream);
      await new Promise<void>((resolve) => unavailableUpstream.close(() => resolve()));
      const child = createMockChild();
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      mockSpawn.mockReturnValue(child);
      const { sshPortForwardService } =
        await import('../../../src/main/services/ssh-port-forward.service');

      try {
        const starting = sshPortForwardService.ensureKomlaDataTunnel('ssh-devbox', unavailablePort);
        await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
        markKomlaDataTunnelReady(child);
        await starting;

        const reverseForward = (mockSpawn.mock.calls[0][1] as string[]).find((arg) =>
          arg.startsWith('127.0.0.1:62042:127.0.0.1:')
        );
        const gatewayPort = Number(reverseForward?.split(':').at(-1));

        const response = await requestGatewayWithAgent(
          gatewayPort,
          '/api/v1/mcp',
          agent,
          Buffer.alloc(bodySize)
        ).catch((error: NodeJS.ErrnoException) => {
          // A server closing during an upload may reset the socket before the
          // client receives its response, depending on the platform's buffering.
          if (bodySize === 0) throw error;
          expect(['EPIPE', 'ECONNRESET']).toContain(error.code);
          return null;
        });

        if (response) {
          expect(response).toMatchObject({
            status: 502,
            body: '{"error":"Komla data service unavailable"}',
            connection: 'close',
          });
        }
        await vi.waitFor(() => {
          expect(Object.values(agent.sockets).flat()).toHaveLength(0);
          expect(Object.values(agent.freeSockets).flat()).toHaveLength(0);
        });
      } finally {
        agent.destroy();
      }
    }
  );
});
