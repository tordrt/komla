import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  createDevPreviewServiceDetector,
  type DevPreviewServiceDetectorDeps,
} from '../../../../src/main/services/dev-preview-services/detector';

import type { ListeningPortSnapshot } from '../../../../src/main/services/dev-preview-services/listening-ports';
import type { RemoteListeningPortSnapshot } from '../../../../src/main/services/dev-preview-services/remote-listening-ports';
import type { Terminal } from '../../../../src/shared/types';

const sshBackend = { kind: 'ssh', hostId: 'host-1' } as NonNullable<
  ReturnType<DevPreviewServiceDetectorDeps['getWorkspace']>
>['backend'];

function terminal(id: string, executionLocation?: Terminal['executionLocation']): Terminal {
  return { id, name: id, status: 'running', createdAt: 0, executionLocation };
}

const snapshot: ListeningPortSnapshot = {
  processes: [
    { pid: 50, ppid: 1, name: 'Komla' },
    { pid: 100, ppid: 50, name: 'zsh' },
    { pid: 101, ppid: 100, name: 'node' },
    { pid: 200, ppid: 50, name: 'zsh' },
    { pid: 201, ppid: 200, name: 'python3' },
    { pid: 300, ppid: 1, name: 'postgres' },
  ],
  listeners: [
    { pid: 101, address: '::1', port: 5173 },
    { pid: 101, address: '127.0.0.1', port: 5173 },
    { pid: 101, address: '192.168.1.5', port: 9000 },
    { pid: 201, address: '0.0.0.0', port: 8000 },
    { pid: 300, address: '127.0.0.1', port: 5432 },
  ],
};

const remoteSnapshot: RemoteListeningPortSnapshot = {
  panePids: new Map([
    ['komla-remote-a', [500]],
    ['komla-elsewhere', [600]],
  ]),
  processes: [
    { pid: 500, ppid: 400, name: 'bash' },
    { pid: 501, ppid: 500, name: 'node' },
    { pid: 502, ppid: 500, name: 'redis-server' },
    { pid: 600, ppid: 400, name: 'bash' },
    { pid: 601, ppid: 600, name: 'python3' },
  ],
  listeners: [
    { pid: 501, address: '127.0.0.1', port: 3000 },
    { pid: 502, address: '127.0.0.1', port: 6379 },
    { pid: 601, address: '0.0.0.0', port: 8000 },
  ],
  listeningPorts: new Set([22, 3000, 6379, 8000]),
  listenersListed: true,
};

let workspace: ReturnType<DevPreviewServiceDetectorDeps['getWorkspace']>;
let clock = 0;
const pids: Record<string, number> = { 'terminal-a': 100, 'terminal-b': 200 };
const deps = {
  getWorkspace: vi.fn(() => workspace),
  getTerminalPid: vi.fn((terminalId: string) => pids[terminalId]),
  getBackgroundPids: vi.fn((_workspaceId: string): number[] => []),
  komlaPid: 50,
  collectListeningPorts: vi.fn(async () => snapshot),
  probeHttpScheme: vi.fn(
    async (port: number) => (port === 5173 || port === 8765 ? 'http' : null) as 'http' | null
  ),
  isLoopbackPortOpen: vi.fn(async (port: number) => port === 3000),
  collectRemoteListeningPorts: vi.fn(async (_hostId: string) => remoteSnapshot),
  probeRemoteHttpSchemes: vi.fn(
    async (_hostId: string, ports: number[]) =>
      new Map(ports.map((port) => [port, port === 6379 ? null : 'http'] as const))
  ),
  now: () => clock,
};

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  workspace = { terminals: [terminal('terminal-a'), terminal('terminal-b')] };
});

describe('createDevPreviewServiceDetector', () => {
  it('lists loopback-reachable ports by the terminal whose process tree owns them', async () => {
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [])).resolves.toEqual({
      services: [
        {
          port: 5173,
          scheme: 'http',
          pid: 101,
          processName: 'node',
          terminalId: 'terminal-a',
          executionLocation: 'workspace',
        },
        {
          port: 8000,
          scheme: null,
          pid: 201,
          processName: 'python3',
          terminalId: 'terminal-b',
          executionLocation: 'workspace',
        },
      ],
      otherServers: [],
      openPorts: [],
      remoteOpenPorts: null,
    });
    expect(deps.collectListeningPorts).toHaveBeenCalledTimes(1);
    expect(deps.collectRemoteListeningPorts).not.toHaveBeenCalled();
    expect(deps.probeHttpScheme).toHaveBeenCalledTimes(2);
  });

  it('reports which requested ports are open, counting detected services as open', async () => {
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', [4000, 5173, 3000, 3000]);

    expect(result.openPorts).toEqual([3000, 5173]);
    expect(deps.isLoopbackPortOpen).toHaveBeenCalledTimes(2);
  });

  it('lists Local copy ports on this machine and remote terminal ports on the SSH host', async () => {
    workspace = {
      backend: sshBackend,
      terminals: [terminal('remote-a'), terminal('terminal-b', 'local-mirror')],
    };
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', [8000], [4000, 8000]);

    expect(deps.collectRemoteListeningPorts).toHaveBeenCalledWith('host-1');
    expect(deps.probeRemoteHttpSchemes).toHaveBeenCalledWith('host-1', [3000, 6379]);
    expect(result).toEqual({
      services: [
        expect.objectContaining({
          port: 8000,
          terminalId: 'terminal-b',
          executionLocation: 'local-mirror',
        }),
        {
          port: 3000,
          scheme: 'http',
          pid: 501,
          processName: 'node',
          terminalId: 'remote-a',
          executionLocation: 'workspace',
        },
        {
          port: 6379,
          scheme: null,
          pid: 502,
          processName: 'redis-server',
          terminalId: 'remote-a',
          executionLocation: 'workspace',
        },
      ],
      otherServers: [],
      openPorts: [8000],
      // 8000 also listens on the host, but in a tmux session of another workspace.
      remoteOpenPorts: [8000],
    });
  });

  it("counts an SSH host's own ports as open only while this user's processes listen on them", async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    clock = 1_000;
    const detector = createDevPreviewServiceDetector(deps);

    // Port 22 listens on the host, but in a process of another user, which ss doesn't name.
    await expect(detector.detect('ws-1', [], [], [22, 3000, 5901])).resolves.toMatchObject({
      ownOpenPorts: [3000],
      checkedAt: 1_000,
    });
  });

  it("counts this computer's own ports as open while its loopback listeners hold them", async () => {
    clock = 2_000;
    const detector = createDevPreviewServiceDetector(deps);

    // Port 9000 listens only on the LAN address.
    await expect(detector.detect('ws-1', [], [], [5432, 9000, 5901])).resolves.toMatchObject({
      ownOpenPorts: [5432],
      checkedAt: 2_000,
    });
  });

  it("can't tell which own ports are open on an SSH host with neither ss nor lsof", async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.collectRemoteListeningPorts.mockResolvedValueOnce({
      ...remoteSnapshot,
      listeners: [],
      listeningPorts: null,
      listenersListed: false,
    });
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [], [], [5901])).resolves.toMatchObject({
      ownOpenPorts: null,
    });
  });

  it("can't tell which own ports are open when the SSH host can't be read", async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.collectRemoteListeningPorts.mockRejectedValueOnce(new Error('unreachable'));
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [], [], [5901])).resolves.toMatchObject({
      ownOpenPorts: null,
    });
  });

  it('neither lists nor probes the other ports of a terminal serving a printed URL', async () => {
    deps.collectListeningPorts.mockResolvedValueOnce({
      ...snapshot,
      listeners: [...snapshot.listeners, { pid: 101, address: '127.0.0.1', port: 9229 }],
    });
    const detector = createDevPreviewServiceDetector(deps);

    const local = await detector.detect('ws-1', [5173]);

    expect(local.services.map(({ port }) => port)).toEqual([5173, 8000]);
    expect(deps.probeHttpScheme.mock.calls.map(([port]) => port).sort()).toEqual([5173, 8000]);

    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    const remote = await detector.detect('ws-1', [], [3000]);

    expect(remote.services.map(({ port }) => port)).toEqual([3000]);
    expect(deps.probeRemoteHttpSchemes).toHaveBeenCalledWith('host-1', [3000]);
  });

  it("lists the ports of the workspace's background runs, which have no terminal", async () => {
    deps.getBackgroundPids.mockReturnValueOnce([700]);
    deps.collectListeningPorts.mockResolvedValueOnce({
      processes: [
        ...snapshot.processes,
        { pid: 700, ppid: 50, name: 'zsh' },
        { pid: 701, ppid: 700, name: 'node' },
      ],
      listeners: [...snapshot.listeners, { pid: 701, address: '127.0.0.1', port: 4321 }],
    });
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', []);

    expect(deps.getBackgroundPids).toHaveBeenCalledWith('ws-1');
    expect(result.services).toContainEqual({
      port: 4321,
      scheme: null,
      pid: 701,
      processName: 'node',
      executionLocation: 'workspace',
    });
  });

  it("lists an SSH workspace's background runs on its Local copy", async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.getBackgroundPids.mockReturnValueOnce([200]);
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', []);

    expect(result.services).toContainEqual({
      port: 8000,
      scheme: null,
      pid: 201,
      processName: 'python3',
      executionLocation: 'local-mirror',
    });
  });

  it('lists HTTP servers outside Komla on this machine', async () => {
    deps.collectListeningPorts.mockResolvedValueOnce({
      processes: [
        { pid: 40, ppid: 1, name: 'node' }, // the dev tool running Komla from source
        { ...snapshot.processes[0], ppid: 40 },
        ...snapshot.processes.slice(1),
        { pid: 900, ppid: 1, name: 'python3' },
        { pid: 901, ppid: 1, name: 'java' },
        { pid: 902, ppid: 1, name: 'Code Helper' },
        { pid: 903, ppid: 1, name: 'node' },
        { pid: 904, ppid: 1, name: 'sqlservr' },
      ],
      listeners: [
        ...snapshot.listeners,
        { pid: 40, address: '127.0.0.1', port: 5175 },
        { pid: 900, address: '127.0.0.1', port: 8765 },
        { pid: 900, address: '::1', port: 8765 },
        { pid: 901, address: '0.0.0.0', port: 4000 },
        { pid: 902, address: '127.0.0.1', port: 52123 },
        // A daemon that inherited a terminal's socket.
        { pid: 903, address: '127.0.0.1', port: 5173 },
        { pid: 903, address: '192.168.1.5', port: 9100 },
        { pid: 904, address: '0.0.0.0', port: 1433 },
      ],
    });
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', []);

    expect(result.otherServers).toEqual([
      { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
    ]);
    // 4000 answered no HTTP, and Postgres and SQL Server log every probe.
    expect(deps.probeHttpScheme.mock.calls.map(([port]) => port).sort()).toEqual([
      4000, 5173, 8000, 8765,
    ]);
  });

  it('lists a server that took the PID of the exited process that started Komla', async () => {
    deps.collectListeningPorts.mockResolvedValueOnce({
      processes: [
        // Windows keeps an exited parent's PID on Komla, such as the installer's.
        { pid: 40, ppid: 1, name: 'python', startedAt: 5_000 },
        { ...snapshot.processes[0], ppid: 40, startedAt: 1_000 },
        ...snapshot.processes.slice(1),
      ],
      listeners: [...snapshot.listeners, { pid: 40, address: '127.0.0.1', port: 8765 }],
    });
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', []);

    expect(result.otherServers).toEqual([
      { port: 8765, scheme: 'http', processName: 'python', executionLocation: 'workspace' },
    ]);
  });

  it('lists HTTP servers outside Komla on the SSH host, even with no terminal there', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('terminal-b', 'local-mirror')] };
    deps.collectRemoteListeningPorts.mockResolvedValueOnce({
      ...remoteSnapshot,
      processes: [
        ...remoteSnapshot.processes,
        { pid: 700, ppid: 1, name: 'python3' },
        { pid: 701, ppid: 1, name: 'sshd' },
        { pid: 702, ppid: 701, name: 'sshd-session' }, // OpenSSH 9.8 and later
      ],
      listeners: [
        ...remoteSnapshot.listeners,
        { pid: 700, address: '127.0.0.1', port: 8765 },
        { pid: 701, address: '127.0.0.1', port: 22999 },
        { pid: 702, address: '127.0.0.1', port: 23000 },
      ],
    });
    const detector = createDevPreviewServiceDetector(deps);

    const result = await detector.detect('ws-1', [3000], []);

    // Every managed tmux pane belongs to Komla, including other workspaces' panes.
    expect(deps.probeRemoteHttpSchemes).toHaveBeenCalledWith('host-1', [8765]);
    expect(result.otherServers).toEqual([
      { port: 8765, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
    ]);
    // Servers outside Komla on this machine are not offered in an SSH workspace.
    expect(result.services.map(({ port }) => port)).toEqual([8000]);
    expect(result.openPorts).toEqual([3000]);
  });

  it('checks local ports without waiting for the SSH host', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    let answerHost: (snapshot: RemoteListeningPortSnapshot) => void = () => {};
    deps.collectRemoteListeningPorts.mockReturnValueOnce(
      new Promise((resolve) => {
        answerHost = resolve;
      })
    );
    const detector = createDevPreviewServiceDetector(deps);

    const result = detector.detect('ws-1', [3000], [3000]);

    await vi.waitFor(() => expect(deps.isLoopbackPortOpen).toHaveBeenCalledWith(3000));
    answerHost(remoteSnapshot);
    await expect(result).resolves.toMatchObject({ openPorts: [3000], remoteOpenPorts: [3000] });
  });

  it('offers remote ports the probe could not check as HTTP', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.probeRemoteHttpSchemes.mockResolvedValueOnce(new Map([[6379, null]]));
    const detector = createDevPreviewServiceDetector(deps);

    const { services } = await detector.detect('ws-1', [], []);

    expect(services.map(({ port, scheme }) => ({ port, scheme }))).toEqual([
      { port: 3000, scheme: 'http' },
      { port: 6379, scheme: null },
    ]);
  });

  it('offers remote ports as HTTP when the probe fails', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.probeRemoteHttpSchemes.mockRejectedValueOnce(new Error('connection reset'));
    const detector = createDevPreviewServiceDetector(deps);

    const { services } = await detector.detect('ws-1', [], []);

    expect(services.map(({ port, scheme }) => ({ port, scheme }))).toEqual([
      { port: 3000, scheme: 'http' },
      { port: 6379, scheme: 'http' },
    ]);
  });

  it('leaves remote ports unchecked when the SSH host cannot be read', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.collectRemoteListeningPorts.mockRejectedValueOnce(new Error('timed out'));
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [], [3000])).resolves.toEqual({
      services: [],
      otherServers: [],
      openPorts: [],
      remoteOpenPorts: null,
    });
  });

  it('leaves remote ports unchecked when the host has no tool to list listeners', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.collectRemoteListeningPorts.mockResolvedValueOnce({
      ...remoteSnapshot,
      listeners: [],
      listeningPorts: null,
      listenersListed: false,
    });
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [], [3000])).resolves.toEqual({
      services: [],
      otherServers: [],
      openPorts: [],
      remoteOpenPorts: null,
    });
    expect(deps.probeRemoteHttpSchemes).not.toHaveBeenCalled();
  });

  it('skips listing local processes in an SSH workspace without local terminals', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [3000])).resolves.toMatchObject({ openPorts: [3000] });
    expect(deps.collectListeningPorts).not.toHaveBeenCalled();
  });

  it('still checks requested ports when listing processes fails', async () => {
    deps.collectListeningPorts.mockRejectedValueOnce(new Error('lsof missing'));
    const detector = createDevPreviewServiceDetector(deps);

    await expect(detector.detect('ws-1', [3000])).resolves.toEqual({
      services: [],
      otherServers: [],
      openPorts: [3000],
      remoteOpenPorts: null,
    });
  });

  it('probes each listening process once while it keeps its port', async () => {
    const detector = createDevPreviewServiceDetector(deps);

    await detector.detect('ws-1', []);
    clock = 5_000;
    await detector.detect('ws-1', []);
    expect(deps.probeHttpScheme.mock.calls).toEqual([[5173], [8000]]);

    deps.collectListeningPorts.mockResolvedValueOnce({
      processes: [...snapshot.processes, { pid: 102, ppid: 100, name: 'node' }],
      listeners: [
        { pid: 102, address: '127.0.0.1', port: 5173 },
        { pid: 201, address: '0.0.0.0', port: 8000 },
      ],
    });
    clock = 10_000;
    const { services } = await detector.detect('ws-1', []);

    expect(deps.probeHttpScheme.mock.calls).toEqual([[5173], [8000], [5173]]);
    expect(services.map(({ port, scheme }) => ({ port, scheme }))).toEqual([
      { port: 5173, scheme: 'http' },
      { port: 8000, scheme: null },
    ]);
  });

  it('probes each remote listener once and asks again about ports it could not check', async () => {
    workspace = { backend: sshBackend, terminals: [terminal('remote-a')] };
    deps.probeRemoteHttpSchemes.mockRejectedValueOnce(new Error('connection reset'));
    const detector = createDevPreviewServiceDetector(deps);

    await detector.detect('ws-1', [], []);
    clock = 5_000;
    await detector.detect('ws-1', [], []);
    clock = 10_000;
    const { services } = await detector.detect('ws-1', [], []);

    expect(deps.probeRemoteHttpSchemes.mock.calls).toEqual([
      ['host-1', [3000, 6379]],
      ['host-1', [3000, 6379]],
    ]);
    expect(services.map(({ port, scheme }) => ({ port, scheme }))).toEqual([
      { port: 3000, scheme: 'http' },
      { port: 6379, scheme: null },
    ]);
  });

  it('answers repeated requests from the last scan for a second', async () => {
    const detector = createDevPreviewServiceDetector(deps);

    const first = detector.detect('ws-1', [3000]);
    expect(detector.detect('ws-1', [3000])).toBe(first);
    await first;
    clock = 999;
    expect(detector.detect('ws-1', [3000])).toBe(first);
    expect(detector.detect('ws-1', [4000])).not.toBe(first);
    expect(detector.detect('ws-1', [3000], [3000])).not.toBe(first);
    clock = 1_000;
    expect(detector.detect('ws-1', [3000])).not.toBe(first);
    expect(deps.collectListeningPorts).toHaveBeenCalledTimes(4);
  });
});
