import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: {},
}));
vi.mock('../../../src/main/services/pty.service', () => ({
  ptyService: {},
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: {},
}));
vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: {},
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({})),
  },
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: {
    list: vi.fn(() => []),
  },
}));
vi.mock('../../../src/main/services/action.service', () => ({
  actionService: {},
}));
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: {},
}));
vi.mock('../../../src/main/services/voice-transcription.service', () => ({
  voiceTranscriptionService: {
    getStatus: vi.fn(() => 'not-downloaded'),
    transcribe: vi.fn(),
  },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    getMainWindowId: vi.fn(() => null),
    broadcastWhenReady: vi.fn(),
  },
}));

import { RemoteControlSessionService } from '../../../src/main/services/remote-control-session.service';
import { publishRemoteWorkspaceChange } from '../../../src/main/services/remote-workspace-events';
import {
  parseRemoteAppFrame,
  RemoteWorkspaceSummarySchema,
} from '../../../packages/remote-protocol/src/app/frames';
import { IPC } from '../../../src/shared/constants/ipc-channels';

import { BrowserWindow } from 'electron';
import type { DecodedMessage } from '@komla/remote-protocol';
import {
  decodeBinaryAppFrame,
  encodeBinaryTerminalInput,
  encodeBinaryTerminalOutput,
  encodedJsonBytes,
  FrameTooLargeError,
  MAX_BINARY_BODY_BYTES,
  MAX_ENCRYPTED_BODY_BYTES,
  MAX_FRAME_CHARS,
} from '@komla/remote-protocol';
import { getProjectColor, projectColorHex } from '../../../src/shared/lib/project-color';
import type { TerminalStatus, Workspace, CreateWorkspaceParams } from '../../../src/shared/types';

class FakePeer {
  sent: unknown[] = [];
  buffered = 0;
  binary = false;
  private messageHandlers: Array<(msg: DecodedMessage) => void> = [];
  private closeHandlers: Array<() => void> = [];

  onMessage(cb: (msg: DecodedMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  async sendEncryptedJson(value: unknown): Promise<void> {
    // Like the real Peer, refuse what the phone would end the session over.
    const bytes = encodedJsonBytes(value);
    if (bytes > MAX_ENCRYPTED_BODY_BYTES) {
      throw new FrameTooLargeError(bytes, MAX_ENCRYPTED_BODY_BYTES);
    }
    this.sent.push(value);
  }

  async sendEncryptedBinary(bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.maxBodyBytes()) {
      throw new FrameTooLargeError(bytes.length, this.maxBodyBytes());
    }
    // Recorded decoded, next to the JSON frames, so tests read one ordered list.
    this.sent.push({ binary: decodeBinaryAppFrame(bytes) });
  }

  usesBinaryFrames(): boolean {
    return this.binary;
  }

  maxBodyBytes(): number {
    return this.binary ? MAX_BINARY_BODY_BYTES : MAX_ENCRYPTED_BODY_BYTES;
  }

  emitBinary(data: Uint8Array): void {
    for (const handler of this.messageHandlers) {
      handler({ kind: 'binary', data });
    }
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  emitJson(data: unknown): void {
    for (const handler of this.messageHandlers) {
      handler({ kind: 'json', data });
    }
  }

  emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

const sessions: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  vi.useRealTimers();
});

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: 'Workspace',
    workingDirectory: '/tmp/w1',
    isWorktree: true,
    projectId: 'p1',
    terminals: [{ id: 't1', name: 'Workspace', status: 'running', createdAt: 1 }],
    primaryTerminalId: 't1',
    windowId: null,
    categoryId: null,
    createdAt: 1,
    lastActivityAt: 1,
    order: 0,
    status: 'active',
    ...overrides,
  };
}

function makeFixture({
  device,
  ...output
}: {
  outputBatchMs?: number;
  outputDrainPollMs?: number;
  sizeLeaseLingerMs?: number;
  device?: { credentialId: string };
} = {}) {
  const workspace = makeWorkspace();
  const secondWorkspace = makeWorkspace({
    id: 'w2',
    name: 'Second workspace',
    workingDirectory: '/tmp/w2',
    branchName: 'feature/second',
    terminals: [{ id: 't2', name: 'Second workspace', status: 'running', createdAt: 2 }],
    primaryTerminalId: 't2',
  });
  let dataListener: ((terminalId: string, data: string, seq: number) => void) | null = null;
  let statusListener: ((terminalId: string, status: TerminalStatus) => void) | null = null;
  let resetListener: ((terminalId: string) => void) | null = null;
  let exitListener: ((terminalId: string) => void) | null = null;
  const presentationMetadata = new Map([
    ['t1', { cols: 120, rows: 30, generation: 1, seq: 7 }],
    ['t2', { cols: 120, rows: 30, generation: 1, seq: 7 }],
  ]);
  const authorities: Array<{
    resize: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    onDesktopSize: ReturnType<typeof vi.fn>;
    desktopSize: ReturnType<typeof vi.fn>;
    /** Stands in for the desktop taking the size back, at this size. */
    desktopTakes: (cols: number, rows: number) => void;
  }> = [];
  const resize = vi.fn();
  const pty = {
    enableTerminalPresentationTracking: vi.fn(),
    disableTerminalPresentationTracking: vi.fn(),
    getPresentationSnapshot: vi.fn(async (terminalId: string) => ({
      buffer: 'hello',
      ...(presentationMetadata.get(terminalId) ?? {
        cols: 120,
        rows: 30,
        generation: 1,
        seq: 7,
      }),
    })),
    getOutputSince: vi.fn(
      (_terminalId: string, _generation: number, _seq: number) =>
        null as Array<{ data: string; seq: number }> | null
    ),
    getPresentationMetadata: vi.fn(
      (terminalId: string) =>
        presentationMetadata.get(terminalId) ?? {
          cols: 120,
          rows: 30,
          generation: 1,
          seq: 7,
        }
    ),
    getStatus: vi.fn(() => 'running' as TerminalStatus),
    getHostInfo: vi.fn((terminalId: string) =>
      terminalId === 't1'
        ? { hostname: 'build.internal', isLocal: false }
        : undefined
    ),
    write: vi.fn(),
    resize,
    acquireSizeAuthority: vi.fn((terminalId: string, cols: number, rows: number) => {
      resize(terminalId, cols, rows);
      let desktopSizeListener: ((cols: number, rows: number) => void) | null = null;
      let desktopSize: { cols: number; rows: number } | null = null;
      const authority = {
        resize: vi.fn((nextCols: number, nextRows: number) => {
          desktopSize = null;
          resize(terminalId, nextCols, nextRows);
        }),
        release: vi.fn(),
        onDesktopSize: vi.fn((listener: ((cols: number, rows: number) => void) | null) => {
          desktopSizeListener = listener;
        }),
        desktopSize: vi.fn(() => desktopSize),
        desktopTakes: (cols: number, rows: number) => {
          desktopSize = { cols, rows };
          desktopSizeListener?.(cols, rows);
        },
      };
      authorities.push(authority);
      presentationMetadata.set(terminalId, {
        ...(presentationMetadata.get(terminalId) ?? { generation: 1, seq: 7 }),
        cols,
        rows,
      });
      return authority;
    }),
    onData: vi.fn((listener: (terminalId: string, data: string, seq: number) => void) => {
      dataListener = listener;
      return () => {
        dataListener = null;
      };
    }),
    onStatus: vi.fn((listener: (terminalId: string, status: TerminalStatus) => void) => {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    }),
    onReset: vi.fn((listener: (terminalId: string) => void) => {
      resetListener = listener;
      return () => {
        resetListener = null;
      };
    }),
    onExit: vi.fn((listener: (terminalId: string) => void) => {
      exitListener = listener;
      return () => {
        exitListener = null;
      };
    }),
  };
  const workspaces = {
    list: vi.fn(() => [workspace, secondWorkspace]),
    get: vi.fn((id: string) =>
      id === workspace.id ? workspace : id === secondWorkspace.id ? secondWorkspace : undefined
    ),
    create: vi.fn(async (params: CreateWorkspaceParams) =>
      makeWorkspace({
        id: 'w3',
        name: params.name ?? 'New workspace',
        branchName: params.branchName,
        projectId: params.projectId,
        primaryTerminalId: 't3',
        terminals: [
          { id: 't3', name: params.name ?? 'New workspace', status: 'starting', createdAt: 3 },
        ],
      })
    ),
    restartWithCleanup: vi.fn(async (workspaceId: string) => {
      const target =
        workspaceId === workspace.id
          ? workspace
          : workspaceId === secondWorkspace.id
            ? secondWorkspace
            : undefined;
      if (!target) throw new Error('workspace not found');
      target.status = 'active';
      target.terminals = [{ id: 't-started', name: target.name, status: 'starting', createdAt: 4 }];
      target.primaryTerminalId = 't-started';
      return target.terminals[0];
    }),
    stop: vi.fn(async (workspaceId: string) => {
      const target =
        workspaceId === workspace.id
          ? workspace
          : workspaceId === secondWorkspace.id
            ? secondWorkspace
            : undefined;
      if (!target) throw new Error('workspace not found');
      for (const terminal of target.terminals) {
        terminal.status = 'stopped';
      }
    }),
    regenerateWorkspaceName: vi.fn(async (workspaceId: string) => {
      const target =
        workspaceId === workspace.id
          ? workspace
          : workspaceId === secondWorkspace.id
            ? secondWorkspace
            : undefined;
      if (!target) throw new Error('workspace not found');
      target.customName = 'Regenerated title';
      return target;
    }),
    addTerminalWithPreparation: vi.fn(async (workspaceId: string, name?: string) => {
      const target = workspaceId === workspace.id ? workspace : secondWorkspace;
      const terminal = {
        id: `t${target.terminals.length + 1}`,
        name: name ?? 'Terminal',
        status: 'starting' as const,
        createdAt: 5,
      };
      target.terminals.push(terminal);
      return terminal;
    }),
    addAgentTab: vi.fn(async (workspaceId: string, _prompt?: string) => {
      const target = workspaceId === workspace.id ? workspace : secondWorkspace;
      const terminal = {
        id: `t${target.terminals.length + 1}`,
        name: 'Agent',
        status: 'starting' as const,
        createdAt: 5,
      };
      target.terminals.push(terminal);
      return terminal;
    }),
    removeTerminal: vi.fn(async (workspaceId: string, terminalId: string) => {
      const target = workspaceId === workspace.id ? workspace : secondWorkspace;
      target.terminals = target.terminals.filter((terminal) => terminal.id !== terminalId);
    }),
    attention: { viewedRemotely: vi.fn() },
  };
  const projects = {
    get: vi.fn((id: string) =>
      id === 'p1'
        ? {
            id: 'p1',
            name: 'Komla',
            repositoryPath: '/repo/komla',
            defaultBranchPrefix: '',
            createdAt: 1,
            order: 0,
            managed: true,
            color: 'hsl(200, 75%, 50%)',
          }
        : undefined
    ),
    list: vi.fn(() => [
      {
        id: 'p1',
        name: 'Komla',
        repositoryPath: '/repo/komla',
        defaultBranchPrefix: '',
        createdAt: 1,
        order: 0,
        managed: true,
        color: 'hsl(200, 75%, 50%)',
      },
    ]),
  };
  const agentPresets = {
    get: vi.fn((id: string) =>
      id === 'preset-1'
        ? {
            id: 'preset-1',
            name: 'Codex',
            openCommand: 'codex',
            continueCommand: 'codex resume --last',
            promptCommand: 'codex {{prompt}}',
            launchModes: [{ id: 'mode-1', name: 'Full auto', command: 'codex --full-auto' }],
            isBuiltin: true,
          }
        : undefined
    ),
    getActivePresets: vi.fn(() => [
      { presetId: 'preset-1', lastUsedAt: 1, lastLaunchModeId: 'mode-1' },
    ]),
  };
  const git = {
    getBranchQuickStatus: vi.fn(async () => ({
      aheadTargetBranch: 2,
      behindTargetBranch: 1,
    })),
    getChangedFilesWithSummary: vi.fn(async () => ({
      summary: { additions: 10, deletions: 3, filesChanged: 2 },
    })),
  };
  const windows = {
    getMainWindowId: vi.fn(() => 'main-window'),
    broadcastWhenReady: vi.fn(),
  };
  const voice = {
    getStatus: vi.fn(() => 'ready' as string),
    warmup: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => 'transcribed text'),
  };
  const config = {
    get: vi.fn(() => ({
      defaultLaunchModeId: 'mode-1',
    })),
  };
  const actions = {
    list: vi.fn(() => [
      { id: 'command-action', title: 'Run tests', content: 'npm test', type: 'command' as const },
      {
        id: 'prompt-action',
        title: 'Investigate',
        content: 'Investigate {{user_input}} against {{target_branch}}',
      },
    ]),
    get: vi.fn((id: string) =>
      id === 'command-action'
        ? { id, title: 'Run tests', content: 'npm test', type: 'command' as const }
        : id === 'prompt-action'
          ? {
              id,
              title: 'Investigate',
              content: 'Investigate {{user_input}} against {{target_branch}}',
            }
          : undefined
    ),
    recordUsage: vi.fn(),
  };
  const sshHosts = {
    list: vi.fn(() => [
      {
        id: 'ssh-1',
        name: 'Build server',
        hostname: 'build.internal',
        basePath: '~/.komla',
      },
    ]),
  };
  let hostsListener: (() => void) | undefined;
  const hostAccess = {
    phoneHosts: vi.fn(() => [
      {
        id: 'ssh-1',
        name: 'Build server',
        url: 'wss://build.tail1.ts.net:48123/remote/ws',
        fingerprint: 'f'.repeat(64),
      },
    ]),
    onChange: vi.fn((listener: () => void) => {
      hostsListener = listener;
      return () => {
        hostsListener = undefined;
      };
    }),
  };
  const service = new RemoteControlSessionService({
    workspaces,
    projects,
    agentPresets,
    pty,
    git,
    windows,
    voice,
    config,
    sshHosts,
    actions,
    hostAccess,
    outputBatchMs: 0,
    ...output,
  });
  const peer = new FakePeer();
  const session = service.attachPeer(peer, device);
  sessions.push(session);
  return {
    peer,
    session,
    service,
    pty,
    workspaces,
    projects,
    agentPresets,
    git,
    windows,
    voice,
    config,
    sshHosts,
    actions,
    hostAccess,
    emitHostsChanged: () => hostsListener?.(),
    workspace,
    secondWorkspace,
    authorities,
    presentationMetadata,
    emitData: (terminalId = 't1', data = '!', seq = 8) => dataListener?.(terminalId, data, seq),
    emitStatus: (terminalId = 't1', status: TerminalStatus = 'stopped') =>
      statusListener?.(terminalId, status),
    emitReset: (terminalId = 't1') => resetListener?.(terminalId),
    emitExit: (terminalId = 't1') => exitListener?.(terminalId),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RemoteControlSessionService', () => {
  it('lists workspace summaries', async () => {
    const { peer } = makeFixture();

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspaces',
      requestId: 'r1',
    });
    expect((peer.sent[0] as { workspaces: unknown[] }).workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'w1',
          primaryTerminalId: 't1',
          projectName: 'Komla',
          projectColor: '#209fdf',
          terminals: [
            expect.objectContaining({ environment: { kind: 'ssh', name: 'build.internal' } }),
          ],
        }),
        expect.objectContaining({
          id: 'w2',
          branchName: 'feature/second',
          lastActivityAt: 1,
          git: {
            additions: 10,
            deletions: 3,
            aheadTargetBranch: 2,
            behindTargetBranch: 1,
          },
        }),
      ])
    );
  });

  it('names workspaces as the sidebar does and adds what the desktop search matches', async () => {
    const { peer, workspace, secondWorkspace } = makeFixture();
    workspace.terminals[0]!.dynamicTitle = 'Fixing the login flow';
    workspace.customDescription = '  Ask once\n per host ';
    workspace.promptSubmits = [
      { prompt: 'first', submittedAt: 1 },
      { prompt: `make it ${'x'.repeat(600)}`, submittedAt: 2 },
    ];
    secondWorkspace.customName = 'Renamed';
    secondWorkspace.terminals[0]!.dynamicTitle = 'Agent title';

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const [first, second] = (peer.sent[0] as { workspaces: unknown[] }).workspaces.map((item) =>
      RemoteWorkspaceSummarySchema.parse(item)
    );
    expect(first).toMatchObject({
      name: 'Fixing the login flow',
      description: 'Ask once per host',
    });
    expect(first!.lastPrompt).toHaveLength(512);
    expect(first!.lastPrompt).toMatch(/^make it x+\.\.\.$/);
    expect(second).toMatchObject({ name: 'Renamed' });
    expect(second).not.toHaveProperty('description');
    expect(second).not.toHaveProperty('lastPrompt');
  });

  it('lists the SSH hosts the phone may open directly and pushes changes', async () => {
    const { peer, hostAccess, emitHostsChanged, session } = makeFixture();

    peer.emitJson({ type: 'app:hosts:list', requestId: 'h1' });
    await flush();
    emitHostsChanged();
    await flush();

    expect(peer.sent).toEqual([
      {
        type: 'app:hosts',
        requestId: 'h1',
        hosts: [
          {
            id: 'ssh-1',
            name: 'Build server',
            url: 'wss://build.tail1.ts.net:48123/remote/ws',
            fingerprint: 'f'.repeat(64),
          },
        ],
      },
      expect.objectContaining({ type: 'app:hosts', requestId: 'push' }),
    ]);
    session.dispose();
    hostAccess.phoneHosts.mockClear();
    emitHostsChanged();
    expect(hostAccess.phoneHosts).not.toHaveBeenCalled();
  });

  it('pushes workspace summaries when the app workspace state changes', async () => {
    vi.useFakeTimers();
    const { peer } = makeFixture();

    publishRemoteWorkspaceChange();
    await vi.advanceTimersByTimeAsync(100);

    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspaces',
      requestId: 'push',
    });
    expect((peer.sent[0] as { workspaces: unknown[] }).workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'w1' })])
    );
  });

  it("keeps this computer's own terminals from devices while access to it is off", async () => {
    const { peer, config, workspaces, secondWorkspace } = makeFixture();
    config.get.mockReturnValue({
      defaultLaunchModeId: 'mode-1',
      directRemoteLocalAccess: false,
    });
    secondWorkspace.backend = {
      kind: 'ssh',
      hostId: 'ssh-1',
      remoteDirectory: '/srv/w2',
      remoteRepoPath: '/srv/repo',
      remoteProjectRoot: '/srv',
      gitUrl: 'git@example.com:repo.git',
    };
    secondWorkspace.terminals.push({
      id: 't-mirror',
      name: 'Local copy',
      status: 'running',
      createdAt: 3,
      executionLocation: 'local-mirror',
    });

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    peer.emitJson({ type: 'app:launch-options:get', requestId: 'r2' });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r3', workspaceId: 'w1' });
    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r4',
      workspaceId: 'w2',
      terminalId: 't-mirror',
    });
    peer.emitJson({ type: 'app:workspace:start', requestId: 'r5', workspaceId: 'w1' });
    peer.emitJson({
      type: 'app:workspace:create',
      requestId: 'r6',
      projectId: 'p1',
      environment: { kind: 'local' },
    });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspaces',
      workspaces: [{ id: 'w2', terminals: [{ id: 't2' }] }],
    });
    expect(peer.sent[1]).toMatchObject({
      environments: [{ kind: 'ssh', id: 'ssh-1', name: 'Build server' }],
    });
    expect(peer.sent.slice(2)).toEqual([
      expect.objectContaining({ type: 'app:error', requestId: 'r3', code: 'not-found' }),
      expect.objectContaining({ type: 'app:error', requestId: 'r4', code: 'not-found' }),
      expect.objectContaining({ type: 'app:error', requestId: 'r5', code: 'not-found' }),
      expect.objectContaining({ type: 'app:error', requestId: 'r6', code: 'unsupported' }),
    ]);
    expect(workspaces.restartWithCleanup).not.toHaveBeenCalled();
    expect(workspaces.create).not.toHaveBeenCalled();
  });

  it("lets go of this computer's terminals when access to it is turned off", async () => {
    vi.useFakeTimers();
    const { peer, config, pty, authorities } = makeFixture();
    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      cols: 80,
      rows: 24,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.sent[0]).toMatchObject({ type: 'app:terminal:attached' });

    config.get.mockReturnValue({ directRemoteLocalAccess: false });
    publishRemoteWorkspaceChange();
    await vi.advanceTimersByTimeAsync(100);
    peer.emitJson({ type: 'app:terminal:input', terminalId: 't1', data: 'ls\r' });
    await vi.advanceTimersByTimeAsync(0);

    expect(peer.sent).toContainEqual(
      expect.objectContaining({ type: 'app:workspaces', requestId: 'push', workspaces: [] })
    );
    expect(peer.sent.at(-1)).toMatchObject({ type: 'app:error', code: 'not-attached' });
    expect(pty.write).not.toHaveBeenCalled();
    expect(authorities[0]?.release).toHaveBeenCalled();
  });

  it("doesn't attach a terminal that access went from while its backlog was sent", async () => {
    vi.useFakeTimers();
    const { peer, config, pty, authorities, emitData } = makeFixture();
    const blocked = new Map<string, () => void>();
    vi.spyOn(peer, 'sendEncryptedJson').mockImplementation((value: unknown) => {
      peer.sent.push(value);
      const frame = value as { type?: string; seq?: number };
      const key =
        frame.type === 'app:terminal:attached'
          ? 'attached'
          : frame.type === 'app:terminal:data' && frame.seq === 8
            ? 'backlog'
            : undefined;
      if (!key) return Promise.resolve();
      return new Promise<void>((resolve) => blocked.set(key, resolve));
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await vi.advanceTimersByTimeAsync(0);
    emitData('t1', 'backlog', 8);
    blocked.get('attached')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(blocked.has('backlog')).toBe(true);
    config.get.mockReturnValue({ directRemoteLocalAccess: false });
    publishRemoteWorkspaceChange();
    await vi.advanceTimersByTimeAsync(100);
    blocked.get('backlog')?.();
    await vi.advanceTimersByTimeAsync(0);
    peer.emitJson({ type: 'app:terminal:input', terminalId: 't1', data: 'ls\r' });
    await vi.advanceTimersByTimeAsync(0);

    expect(peer.sent.at(-1)).toMatchObject({ type: 'app:error', code: 'not-attached' });
    expect(pty.write).not.toHaveBeenCalled();
    expect(authorities[0]?.release).toHaveBeenCalled();
  });

  it('refuses Actions that would run in the Local copy while access to this computer is off', async () => {
    const { peer, config, workspaces, secondWorkspace } = makeFixture();
    config.get.mockReturnValue({
      directRemoteLocalAccess: false,
      defaultSshWorkspaceMode: 'local-mirror-actions',
    });
    secondWorkspace.backend = {
      kind: 'ssh',
      hostId: 'ssh-1',
      remoteDirectory: '/srv/w2',
      remoteRepoPath: '/srv/repo',
      remoteProjectRoot: '/srv',
      gitUrl: 'git@example.com:repo.git',
    };

    peer.emitJson({
      type: 'app:terminal:create',
      requestId: 'r1',
      workspaceId: 'w2',
      source: { kind: 'action', actionId: 'command-action' },
    });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:error',
      requestId: 'r1',
      code: 'terminal-create-failed',
      message: expect.stringContaining('Local copy'),
    });
    expect(workspaces.addTerminalWithPreparation).not.toHaveBeenCalled();
  });

  it("shows a hidden Local copy shell's attention as the visible terminals' instead", async () => {
    const { peer, config, secondWorkspace } = makeFixture();
    config.get.mockReturnValue({ directRemoteLocalAccess: false });
    secondWorkspace.backend = {
      kind: 'ssh',
      hostId: 'ssh-1',
      remoteDirectory: '/srv/w2',
      remoteRepoPath: '/srv/repo',
      remoteProjectRoot: '/srv',
      gitUrl: 'git@example.com:repo.git',
    };
    const done = {
      kind: 'turn-complete' as const,
      source: 'codex',
      updatedAt: 1,
      terminalId: 't2',
    };
    secondWorkspace.terminals[0]!.attention = done;
    secondWorkspace.terminals.push({
      id: 't-mirror',
      name: 'Local copy',
      status: 'running',
      createdAt: 3,
      executionLocation: 'local-mirror',
      attention: {
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 2,
        message: 'Approve rm -rf build',
        terminalId: 't-mirror',
      },
    });
    secondWorkspace.attention = secondWorkspace.terminals[1]!.attention;
    secondWorkspace.needsAttention = true;

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const [summary] = (peer.sent[0] as { workspaces: Array<Record<string, unknown>> }).workspaces;
    expect(summary).toMatchObject({
      id: 'w2',
      needsAttention: true,
      attention: { kind: 'turn-complete', terminalId: 't2' },
    });
    expect(JSON.stringify(summary)).not.toContain('Approve rm -rf build');
  });

  it('lists launch options for remote workspace creation', async () => {
    const { peer } = makeFixture();

    peer.emitJson({ type: 'app:launch-options:get', requestId: 'r1' });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:launch-options',
      requestId: 'r1',
      defaultLaunchModeId: 'mode-1',
      // In hex, which the phone's color dots read.
      projects: [{ id: 'p1', name: 'Komla', color: '#209fdf' }],
      presets: [
        {
          id: 'preset-1',
          name: 'Codex',
          lastLaunchModeId: 'mode-1',
          launchModes: [{ id: 'mode-1', name: 'Full auto' }],
        },
      ],
      environments: [
        { kind: 'local', name: 'This computer' },
        { kind: 'ssh', id: 'ssh-1', name: 'Build server' },
      ],
      actions: [
        { id: 'command-action', title: 'Run tests', type: 'command' },
        { id: 'prompt-action', title: 'Investigate', type: 'prompt', requiresInput: true },
      ],
    });
  });

  it('gives a project without a saved color the one the desktop derives from its name', async () => {
    const { peer, projects } = makeFixture();
    projects.list.mockReturnValue([
      {
        id: 'p2',
        name: 'landing',
        repositoryPath: '/repo/landing',
        defaultBranchPrefix: '',
        createdAt: 1,
        order: 1,
        managed: true,
      },
    ] as never);

    peer.emitJson({ type: 'app:launch-options:get', requestId: 'r1' });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      projects: [{ id: 'p2', color: projectColorHex(getProjectColor('landing'), 'landing') }],
    });
  });

  it('creates shell, agent, and action terminals and closes the current terminal', async () => {
    const { peer, workspaces, actions } = makeFixture();

    peer.emitJson({
      type: 'app:terminal:create',
      requestId: 'r1',
      workspaceId: 'w1',
      source: { kind: 'shell' },
    });
    peer.emitJson({
      type: 'app:terminal:create',
      requestId: 'r2',
      workspaceId: 'w1',
      source: { kind: 'agent', presetId: 'preset-1', launchModeId: 'mode-1', prompt: 'Review' },
    });
    peer.emitJson({
      type: 'app:terminal:create',
      requestId: 'r3',
      workspaceId: 'w1',
      source: { kind: 'action', actionId: 'prompt-action', userInput: 'login' },
    });
    peer.emitJson({
      type: 'app:terminal:create',
      requestId: 'r4',
      workspaceId: 'w1',
      source: { kind: 'action', actionId: 'command-action' },
    });
    await flush();

    expect(workspaces.addTerminalWithPreparation).toHaveBeenCalledWith(
      'w1',
      undefined,
      null,
      'tab'
    );
    expect(workspaces.addAgentTab).toHaveBeenCalledWith('w1', 'Review', 'mode-1', 'preset-1');
    expect(workspaces.addAgentTab).toHaveBeenCalledWith(
      'w1',
      'Investigate login against main',
      undefined,
      undefined
    );
    expect(actions.recordUsage).toHaveBeenCalledWith('prompt-action', 'login');
    expect(workspaces.addTerminalWithPreparation).toHaveBeenCalledWith(
      'w1',
      'Run tests',
      'npm test',
      'tab',
      'host'
    );
    expect(actions.recordUsage).toHaveBeenCalledWith('command-action', undefined);

    peer.emitJson({
      type: 'app:terminal:close',
      requestId: 'r5',
      workspaceId: 'w1',
      terminalId: 't1',
    });
    await flush();
    expect(workspaces.removeTerminal).toHaveBeenCalledWith('w1', 't1');
    expect(peer.sent).toContainEqual(
      expect.objectContaining({ type: 'app:terminal:closed', requestId: 'r5', terminalId: 't1' })
    );
  });

  it('lists provisioning workspace summaries with empty working directories', async () => {
    const { peer, workspace } = makeFixture();
    workspace.provisioning = true;
    workspace.workingDirectory = '';

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspaces',
    });
    expect((peer.sent[0] as { workspaces: unknown[] }).workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'w1', provisioning: true, workingDirectory: '' }),
      ])
    );
    expect(
      RemoteWorkspaceSummarySchema.safeParse(
        (peer.sent[0] as { workspaces: unknown[] }).workspaces[0]
      ).success
    ).toBe(true);
  });

  it('includes attention badges and active-agent state in workspace summaries', async () => {
    const { peer, workspace } = makeFixture();
    workspace.agentActive = true;
    workspace.needsAttention = true;
    workspace.attention = {
      kind: 'input-required',
      source: 'claude-code',
      updatedAt: 123,
      message: 'Approve command',
      terminalId: 't1',
    };
    workspace.terminals[0]!.agentActive = true;
    workspace.terminals[0]!.attention = workspace.attention;

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    expect((peer.sent[0] as { workspaces: unknown[] }).workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'w1',
          agentActive: true,
          needsAttention: true,
          attention: expect.objectContaining({
            kind: 'input-required',
            message: 'Approve command',
            terminalId: 't1',
          }),
          terminals: [
            expect.objectContaining({
              id: 't1',
              agentActive: true,
              attention: expect.objectContaining({ kind: 'input-required' }),
            }),
          ],
        }),
      ])
    );
  });

  it('leaves out a done the user saw on screen', async () => {
    const { peer, workspace } = makeFixture();
    workspace.terminals[0]!.attention = {
      kind: 'turn-complete',
      source: 'codex',
      updatedAt: 123,
      terminalId: 't1',
      seen: true,
    };

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const summary = (peer.sent[0] as { workspaces: Array<{ terminals: object[] }> }).workspaces[0]!;
    expect(summary.terminals[0]).not.toHaveProperty('attention');
  });

  it('serializes custom attention through the bounded v1 remote shape', async () => {
    const { peer, workspace } = makeFixture();
    workspace.needsAttention = true;
    workspace.attention = {
      kind: 'generic',
      source: 'custom-hook',
      updatedAt: 123,
      title: 'Review ready',
      body: 'x'.repeat(64 * 1024),
      color: 'oklch(62% 0.2 285)',
      terminalId: 't1',
    };
    workspace.terminals[0]!.attention = workspace.attention;

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const summary = (peer.sent[0] as { workspaces: Array<Record<string, unknown>> }).workspaces[0]!;
    const remoteAttention = summary.attention as Record<string, unknown>;
    const terminalAttention = (
      summary.terminals as Array<{ attention?: Record<string, unknown> }>
    )[0]!.attention;

    expect(remoteAttention).toMatchObject({
      kind: 'generic',
      source: 'komla:custom-title:custom-hook',
      updatedAt: 123,
      terminalId: 't1',
    });
    expect(remoteAttention).not.toHaveProperty('title');
    expect(remoteAttention).not.toHaveProperty('body');
    expect(remoteAttention).not.toHaveProperty('color');
    expect(remoteAttention.message).toBe('Review ready');
    expect(terminalAttention).toEqual(remoteAttention);
    expect(RemoteWorkspaceSummarySchema.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(peer.sent[0])).not.toContain('x'.repeat(100));
  });

  it('bounds lifecycle message detail in remote workspace summaries', async () => {
    const { peer, workspace } = makeFixture();
    workspace.attention = {
      kind: 'turn-complete',
      source: 'custom-hook',
      updatedAt: 123,
      message: 'x'.repeat(64 * 1024),
      terminalId: 't1',
    };
    workspace.terminals[0]!.attention = workspace.attention;

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const summary = (peer.sent[0] as { workspaces: Array<Record<string, unknown>> }).workspaces[0]!;
    const remoteAttention = summary.attention as Record<string, unknown>;

    expect((remoteAttention.message as string).length).toBe(2 * 1024);
    expect(remoteAttention.message).toMatch(/\.\.\.$/);
    expect(RemoteWorkspaceSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('escapes custom-title source markers on lifecycle attention', async () => {
    const { peer, workspace } = makeFixture();
    workspace.attention = {
      kind: 'error',
      source: 'komla:custom-title:user-hook',
      updatedAt: 123,
      message: 'Lifecycle detail',
      terminalId: 't1',
    };
    workspace.terminals[0]!.attention = workspace.attention;

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const summary = (peer.sent[0] as { workspaces: Array<Record<string, unknown>> }).workspaces[0]!;
    const remoteAttention = summary.attention as Record<string, unknown>;

    expect(remoteAttention.source).not.toMatch(/^komla:custom-title:/);
    expect(remoteAttention.message).toBe('Lifecycle detail');
    expect(RemoteWorkspaceSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('attaches the primary terminal and forwards terminal events', async () => {
    const { peer, workspaces, emitData, emitStatus } = makeFixture();

    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      cols: 120,
      rows: 34,
    });
    await flush();
    emitData();
    emitStatus();
    await flush();

    expect(peer.sent).toEqual([
      {
        type: 'app:terminal:attached',
        requestId: 'r1',
        snapshot: {
          workspaceId: 'w1',
          terminalId: 't1',
          status: 'running',
          seq: 7,
          generation: 1,
          cols: 120,
          rows: 34,
          chunkCount: 1,
        },
      },
      {
        type: 'app:terminal:snapshot-chunk',
        requestId: 'r1',
        terminalId: 't1',
        generation: 1,
        index: 0,
        data: 'hello',
      },
      {
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        data: '!',
        seq: 8,
        generation: 1,
      },
      {
        type: 'app:terminal:status',
        workspaceId: 'w1',
        terminalId: 't1',
        status: 'stopped',
      },
    ]);
    expect(workspaces.attention.viewedRemotely).toHaveBeenCalledWith('w1', 't1');
  });

  it('handles terminal stream send failures after disconnects', async () => {
    const { peer, emitData, emitStatus } = makeFixture();

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();

    vi.spyOn(peer, 'sendEncryptedJson').mockRejectedValue(new Error('peer closed before send'));

    expect(() => {
      emitData('t1', 'after close', 8);
      emitStatus('t1', 'stopped');
    }).not.toThrow();
    await flush();

    expect(peer.sendEncryptedJson).toHaveBeenCalledTimes(2);
  });

  it('buffers terminal output until the attach snapshot is delivered', async () => {
    const { peer, emitData } = makeFixture();
    let releaseAttach: (() => void) | null = null;
    vi.spyOn(peer, 'sendEncryptedJson').mockImplementation((value: unknown) => {
      peer.sent.push(value);
      if ((value as { type?: string }).type === 'app:terminal:attached') {
        return new Promise<void>((resolve) => {
          releaseAttach = resolve;
        });
      }
      return Promise.resolve();
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    emitData('t1', 'during attach', 8);
    await flush();

    expect(peer.sent).toEqual([
      expect.objectContaining({
        type: 'app:terminal:attached',
        requestId: 'r1',
      }),
    ]);

    releaseAttach?.();
    await flush();

    expect(peer.sent).toEqual([
      expect.objectContaining({
        type: 'app:terminal:attached',
        requestId: 'r1',
      }),
      expect.objectContaining({
        type: 'app:terminal:snapshot-chunk',
        requestId: 'r1',
        data: 'hello',
      }),
      {
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        data: 'during attach',
        seq: 8,
        generation: 1,
      },
    ]);
  });

  it('keeps live output ordered behind the complete attach backlog', async () => {
    const { peer, emitData } = makeFixture();
    let releaseAttach: (() => void) | null = null;
    let releaseFirstPendingFrame: (() => void) | null = null;
    vi.spyOn(peer, 'sendEncryptedJson').mockImplementation((value: unknown) => {
      peer.sent.push(value);
      const frame = value as { type?: string; seq?: number };
      if (frame.type === 'app:terminal:attached') {
        return new Promise<void>((resolve) => {
          releaseAttach = resolve;
        });
      }
      if (frame.type === 'app:terminal:data' && frame.seq === 8) {
        return new Promise<void>((resolve) => {
          releaseFirstPendingFrame = resolve;
        });
      }
      return Promise.resolve();
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    emitData('t1', 'pending 1', 8);
    emitData('t1', 'pending 2', 9);
    releaseAttach?.();
    await flush();

    emitData('t1', 'live during flush', 10);
    await flush();
    releaseFirstPendingFrame?.();
    await flush();

    const dataFrames = peer.sent.filter(
      (frame): frame is { type: string; seq: number } =>
        (frame as { type?: string }).type === 'app:terminal:data'
    );
    expect(dataFrames.map((frame) => frame.seq)).toEqual([8, 9, 10]);
  });

  it('forwards a PTY reset that occurs while the attach snapshot is being delivered', async () => {
    const { peer, presentationMetadata, emitReset, emitData } = makeFixture();
    let releaseAttach: (() => void) | null = null;
    vi.spyOn(peer, 'sendEncryptedJson').mockImplementation((value: unknown) => {
      peer.sent.push(value);
      if ((value as { type?: string }).type === 'app:terminal:attached') {
        return new Promise<void>((resolve) => {
          releaseAttach = resolve;
        });
      }
      return Promise.resolve();
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    presentationMetadata.set('t1', { cols: 120, rows: 30, generation: 2, seq: 7 });
    emitReset('t1');
    emitData('t1', 'after restart', 8);
    releaseAttach?.();
    await flush();

    expect(peer.sent).toEqual([
      expect.objectContaining({
        type: 'app:terminal:attached',
        snapshot: expect.objectContaining({ generation: 1 }),
      }),
      expect.objectContaining({
        type: 'app:terminal:snapshot-chunk',
        generation: 1,
      }),
      {
        type: 'app:terminal:reset',
        workspaceId: 'w1',
        terminalId: 't1',
        cols: 120,
        rows: 30,
        generation: 2,
        seq: 7,
      },
      {
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        data: 'after restart',
        seq: 8,
        generation: 2,
      },
    ]);
  });

  it('attaches a terminal whose PTY has not started and streams it once it does', async () => {
    const { peer, pty, workspace, presentationMetadata, emitReset, emitData } = makeFixture();
    workspace.terminals[0].status = 'starting';
    pty.getStatus.mockReturnValue(null as unknown as TerminalStatus);
    presentationMetadata.set('t1', { cols: 120, rows: 30, generation: 0, seq: 0 });
    pty.getPresentationSnapshot.mockResolvedValueOnce({
      buffer: '',
      cols: 120,
      rows: 30,
      generation: 0,
      seq: 0,
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    presentationMetadata.set('t1', { cols: 120, rows: 30, generation: 1, seq: 0 });
    emitReset('t1');
    emitData('t1', 'started', 1);
    await flush();

    expect(peer.sent.map((frame) => parseRemoteAppFrame(frame))).toEqual([
      expect.objectContaining({
        type: 'app:terminal:attached',
        snapshot: expect.objectContaining({ status: 'starting', generation: 0, chunkCount: 1 }),
      }),
      expect.objectContaining({ type: 'app:terminal:snapshot-chunk', generation: 0, data: '' }),
      expect.objectContaining({ type: 'app:terminal:reset', generation: 1, seq: 0 }),
      expect.objectContaining({ type: 'app:terminal:data', generation: 1, data: 'started' }),
    ]);
  });

  it('forwards output that arrives while the trailing attach reset is being sent', async () => {
    const { peer, presentationMetadata, emitReset, emitData } = makeFixture();
    const blocked = new Map<string, () => void>();
    const blockOn = (key: string) =>
      new Promise<void>((resolve) => {
        blocked.set(key, resolve);
      });
    vi.spyOn(peer, 'sendEncryptedJson').mockImplementation((value: unknown) => {
      peer.sent.push(value);
      const frame = value as { type?: string; seq?: number };
      if (frame.type === 'app:terminal:attached') return blockOn('attached');
      if (frame.type === 'app:terminal:data' && frame.seq === 8) return blockOn('last-pending');
      if (frame.type === 'app:terminal:reset') return blockOn('reset');
      return Promise.resolve();
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    emitData('t1', 'before restart', 8);
    blocked.get('attached')?.();
    await flush();
    // The PTY restarts while the last backlog frame is still being sent...
    presentationMetadata.set('t1', { cols: 120, rows: 30, generation: 2, seq: 8 });
    emitReset('t1');
    blocked.get('last-pending')?.();
    await flush();
    // ...and the new generation prints while that reset is being sent.
    emitData('t1', 'after restart', 9);
    blocked.get('reset')?.();
    await flush();

    expect(
      peer.sent
        .filter((frame) => (frame as { type?: string }).type !== 'app:terminal:snapshot-chunk')
        .map((frame) => {
          const { type, generation, seq } = frame as {
            type: string;
            generation?: number;
            seq?: number;
          };
          return { type, generation, seq };
        })
    ).toEqual([
      { type: 'app:terminal:attached', generation: undefined, seq: undefined },
      { type: 'app:terminal:data', generation: 1, seq: 8 },
      { type: 'app:terminal:reset', generation: 2, seq: 8 },
      { type: 'app:terminal:data', generation: 2, seq: 9 },
    ]);
  });

  it('sends output after a quiet spell at once and batches the output that follows it', async () => {
    const { peer, emitData } = makeFixture({ outputBatchMs: 20 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;
    const sentData = () => peer.sent.map((frame) => (frame as { data: string }).data);

    emitData('t1', 'a', 8);
    expect(sentData()).toEqual(['a']);
    emitData('t1', 'b', 9);
    emitData('t1', 'c', 10);
    expect(sentData()).toEqual(['a']);
    await wait(60);
    expect(sentData()).toEqual(['a', 'bc']);

    emitData('t1', 'd', 11);
    expect(sentData()).toEqual(['a', 'bc', 'd']);
  });

  it('starts a new data frame before a batch outgrows one frame', async () => {
    const { peer, emitData } = makeFixture({ outputBatchMs: 20 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;

    emitData('t1', 'x'.repeat(30_000), 8);
    emitData('t1', 'y'.repeat(30_000), 9);
    await wait(40);

    expect(
      peer.sent.map((frame) => {
        const { data, seq } = frame as { data: string; seq: number };
        return { chars: data.length, seq };
      })
    ).toEqual([
      { chars: 30_000, seq: 8 },
      { chars: 30_000, seq: 9 },
    ]);
  });

  it('sends terminal output as binary once the phone agreed to binary frames', async () => {
    const { peer, emitData } = makeFixture();
    peer.binary = true;
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;

    emitData('t1', '\x1b[32mok\x1b[0m', 8);
    emitData('t1', 'x'.repeat(70_000), 9);
    await flush();

    expect(peer.sent).toEqual([
      {
        binary: {
          type: 'app:terminal:data',
          terminalId: 't1',
          generation: 1,
          seq: 8,
          data: '\x1b[32mok\x1b[0m',
        },
      },
      { binary: expect.objectContaining({ seq: 9, more: true }) },
      { binary: expect.objectContaining({ seq: 9 }) },
    ]);
    const pieces = peer.sent.slice(1) as Array<{ binary: { data: string } }>;
    expect(pieces.map((frame) => frame.binary.data).join('')).toBe('x'.repeat(70_000));
  });

  it('takes typed input as a binary payload and refuses output from the phone', async () => {
    const { peer, pty } = makeFixture();
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;

    peer.emitBinary(encodeBinaryTerminalInput({ terminalId: 't1', data: 'ls\r' }));
    peer.emitBinary(
      encodeBinaryTerminalOutput({ terminalId: 't1', generation: 1, seq: 1, data: 'x' })
    );
    peer.emitBinary(new Uint8Array([9, 9, 9]));
    await flush();

    expect(pty.write).toHaveBeenCalledWith('t1', 'ls\r');
    expect(peer.sent).toEqual([
      expect.objectContaining({ type: 'app:error', code: 'bad-frame' }),
      expect.objectContaining({ type: 'app:error', code: 'bad-frame' }),
    ]);
  });

  it('splits multibyte output that would not fit one frame into continuation frames', async () => {
    const { peer, emitData } = makeFixture({ outputBatchMs: 20 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;

    // 24 Ki characters, as the old character cap allowed, but about 72 KB of UTF-8.
    const burst = '漢字'.repeat(12 * 1024);
    emitData('t1', burst, 8);
    emitData('t1', 'tail', 9);
    await wait(40);

    const frames = peer.sent as Array<{ data: string; seq: number; more?: true }>;
    expect(frames.map(({ seq, more }) => ({ seq, more }))).toEqual([
      { seq: 8, more: true },
      { seq: 8, more: undefined },
      { seq: 9, more: undefined },
    ]);
    expect(frames.map((frame) => frame.data).join('')).toBe(`${burst}tail`);
    for (const frame of frames) {
      expect(parseRemoteAppFrame(frame)).not.toBeNull();
      expect(encodedJsonBytes(frame)).toBeLessThanOrEqual(MAX_ENCRYPTED_BODY_BYTES);
    }
  });

  it('splits oversized output that arrives while the attach snapshot is sent', async () => {
    const { peer, pty, emitData } = makeFixture();
    let releaseSnapshot!: () => void;
    pty.getPresentationSnapshot.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (releaseSnapshot = resolve));
      return { buffer: 'hello', cols: 120, rows: 30, generation: 1, seq: 7 };
    });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    const burst = '\x1b'.repeat(16 * 1024);
    emitData('t1', burst, 8);
    releaseSnapshot();
    await flush();

    const data = (peer.sent as Array<{ type: string; data: string; more?: true }>).filter(
      (frame) => frame.type === 'app:terminal:data'
    );
    expect(data.length).toBeGreaterThan(1);
    expect(data.map((frame) => frame.data).join('')).toBe(burst);
    expect(data.at(-1)?.more).toBeUndefined();
    for (const frame of data.slice(0, -1)) expect(frame.more).toBe(true);
  });

  it('sends a workspace list too large for one frame in pages', async () => {
    const { peer, workspaces } = makeFixture();
    const many = Array.from({ length: 120 }, (_, index) =>
      makeWorkspace({
        id: `w-${index}`,
        name: `漢字 workspace ${index} `.repeat(10),
        workingDirectory: `/tmp/${'deep/'.repeat(40)}${index}`,
        terminals: [],
        primaryTerminalId: undefined,
      })
    );
    workspaces.list.mockReturnValue(many);

    peer.emitJson({ type: 'app:workspaces:list', requestId: 'r1' });
    await flush();

    const pages = peer.sent as Array<{ requestId: string; workspaces: unknown[]; more?: true }>;
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.more)).toEqual([...pages.slice(1).map(() => true), undefined]);
    expect(pages.every((page) => page.requestId === 'r1')).toBe(true);
    expect(pages.flatMap((page) => page.workspaces).map((w) => (w as { id: string }).id)).toEqual(
      many.map((workspace) => workspace.id)
    );
    for (const page of pages) {
      expect(parseRemoteAppFrame(page)).not.toBeNull();
      expect(encodedJsonBytes(page)).toBeLessThanOrEqual(MAX_ENCRYPTED_BODY_BYTES);
    }
  });

  it('skips ahead to the current screen once a phone that fell behind catches up', async () => {
    const { peer, pty, emitData } = makeFixture({ outputDrainPollMs: 10 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;

    // The connection can't keep up, so this output is not queued behind it.
    peer.buffered = 10 * 1024 * 1024;
    emitData('t1', 'missed 1', 8);
    emitData('t1', 'missed 2', 9);
    await wait(30);
    expect(peer.sent).toEqual([]);

    pty.getPresentationSnapshot.mockResolvedValueOnce({
      buffer: 'current screen',
      cols: 120,
      rows: 30,
      generation: 1,
      seq: 9,
    });
    peer.buffered = 0;
    await wait(40);
    emitData('t1', 'live', 10);
    await wait(10);

    // The phone writes data above the reset's seq, so the screen fills the
    // seq just below where live output resumes.
    expect(peer.sent).toEqual([
      {
        type: 'app:terminal:reset',
        workspaceId: 'w1',
        terminalId: 't1',
        generation: 1,
        seq: 8,
        cols: 120,
        rows: 30,
      },
      {
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        data: 'current screen',
        seq: 9,
        generation: 1,
      },
      {
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        data: 'live',
        seq: 10,
        generation: 1,
      },
    ]);
    expect(pty.getPresentationSnapshot).toHaveBeenLastCalledWith('t1', { scrollback: 0 });
  });

  it('sends the whole current screen when it takes more frames than the seqs below it', async () => {
    const { peer, pty, emitData } = makeFixture({ outputDrainPollMs: 10 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;
    peer.buffered = 10 * 1024 * 1024;
    emitData('t1', 'missed', 1);
    await wait(30);

    const screen = `${'a'.repeat(60 * 1024)}tail`;
    pty.getPresentationSnapshot.mockResolvedValueOnce({
      buffer: screen,
      cols: 120,
      rows: 30,
      generation: 1,
      seq: 1,
    });
    peer.buffered = 0;
    await wait(40);

    const [reset, ...data] = peer.sent as Array<{ type: string; data: string; seq: number }>;
    expect(reset).toMatchObject({ type: 'app:terminal:reset', seq: 0 });
    expect(data.length).toBeGreaterThan(1);
    expect(data.map((frame) => frame.data).join('')).toBe(screen);
    // One read split across frames: they share its seq, and all but the last say more follows.
    expect(data.map((frame) => [frame.seq, 'more' in frame])).toEqual(
      data.map((_, index) => [1, index < data.length - 1])
    );
    for (const frame of peer.sent) expect(parseRemoteAppFrame(frame)).not.toBeNull();
  });

  it('forwards output that arrives while the current screen is being read', async () => {
    const { peer, pty, emitData } = makeFixture({ outputDrainPollMs: 10 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.buffered = 10 * 1024 * 1024;
    emitData('t1', 'missed', 8);
    await wait(30);
    peer.sent.length = 0;

    let resolveScreen: (
      screen: Awaited<ReturnType<typeof pty.getPresentationSnapshot>>
    ) => void = () => {};
    pty.getPresentationSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => (resolveScreen = resolve))
    );
    peer.buffered = 0;
    await wait(40);
    emitData('t1', 'already on screen', 9);
    emitData('t1', 'after the screen', 10);
    resolveScreen({ buffer: 'screen', cols: 120, rows: 30, generation: 1, seq: 9 });
    await wait(10);

    expect(
      peer.sent.map((frame) => {
        const { type, data, seq } = frame as { type: string; data?: string; seq: number };
        return { type, data, seq };
      })
    ).toEqual([
      { type: 'app:terminal:reset', data: undefined, seq: 8 },
      { type: 'app:terminal:data', data: 'screen', seq: 9 },
      { type: 'app:terminal:data', data: 'after the screen', seq: 10 },
    ]);
  });

  it('chunks large terminal attach snapshots below the encrypted frame budget', async () => {
    const { peer, pty } = makeFixture();
    const largeBuffer = `${'a'.repeat(60 * 1024)}tail`;
    pty.getPresentationSnapshot.mockResolvedValueOnce({
      buffer: largeBuffer,
      seq: 7,
      generation: 1,
      cols: 120,
      rows: 30,
    });

    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
    });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:terminal:attached',
      snapshot: { seq: 7, chunkCount: 3 },
    });
    const chunks = peer.sent.slice(1) as Array<{ data: string }>;
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.data).join('')).toBe(largeBuffer);
    // The browser drops any frame its schema rejects, so every chunk must parse.
    for (const chunk of chunks) {
      expect(parseRemoteAppFrame(chunk)).toMatchObject({ type: 'app:terminal:snapshot-chunk' });
    }
  });

  it('bounds multibyte and escaped snapshot chunks by encrypted wire size', async () => {
    const { peer, pty } = makeFixture();
    const largeBuffer = `${'界😀\u0000'.repeat(12 * 1024)}tail`;
    pty.getPresentationSnapshot.mockResolvedValueOnce({
      buffer: largeBuffer,
      seq: 7,
      generation: 1,
      cols: 120,
      rows: 30,
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();

    const chunks = peer.sent.slice(1) as Array<{ data: string }>;
    expect(chunks.map((chunk) => chunk.data).join('')).toBe(largeBuffer);
    for (const frame of chunks) {
      const plaintextBytes = new TextEncoder().encode(JSON.stringify(frame)).length + 1;
      const ciphertextChars = 4 * Math.ceil((plaintextBytes + 16) / 3);
      const wireFrame = JSON.stringify({
        type: 'e2e:enc',
        seq: 0xffffffff,
        nonce: 'A'.repeat(16),
        ciphertext: 'A'.repeat(ciphertextChars),
      });
      expect(wireFrame.length).toBeLessThanOrEqual(MAX_FRAME_CHARS);
    }
  });

  it('resizes the terminal to the remote viewport before reading the attach snapshot', async () => {
    const { peer, pty } = makeFixture();

    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      cols: 120,
      rows: 34,
    });
    await flush();

    expect(pty.resize).toHaveBeenCalledWith('t1', 120, 34);
    expect(pty.resize.mock.invocationCallOrder[0]).toBeLessThan(
      pty.getPresentationSnapshot.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('replaces the active terminal attachment when switching terminals', async () => {
    const { peer, pty, emitData } = makeFixture();

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w2' });
    await flush();

    peer.sent = [];
    emitData('t1', 'old', 9);
    emitData('t2', 'new', 10);
    await flush();

    expect(peer.sent).toEqual([
      {
        type: 'app:terminal:data',
        workspaceId: 'w2',
        terminalId: 't2',
        data: 'new',
        seq: 10,
        generation: 1,
      },
    ]);

    peer.emitJson({ type: 'app:terminal:input', terminalId: 't1', data: 'stale\r' });
    peer.emitJson({ type: 'app:terminal:input', terminalId: 't2', data: 'active\r' });
    await flush();

    expect(pty.write).toHaveBeenCalledTimes(1);
    expect(pty.write).toHaveBeenCalledWith('t2', 'active\r');
    expect(peer.sent[1]).toMatchObject({ type: 'app:error', code: 'not-attached' });
  });

  it('serializes rapid terminal attachment changes', async () => {
    const { peer, emitData } = makeFixture();
    let releaseFirst!: () => void;
    const firstSendBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalSend = peer.sendEncryptedJson.bind(peer);
    vi.spyOn(peer, 'sendEncryptedJson').mockImplementation(async (value) => {
      await originalSend(value);
      if ((value as { requestId?: string }).requestId === 'r1') await firstSendBlocked;
    });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w2' });
    releaseFirst();
    await flush();
    await flush();

    peer.sent = [];
    emitData('t1', 'old', 9);
    emitData('t2', 'new', 10);
    await flush();

    expect(peer.sent).toEqual([
      {
        type: 'app:terminal:data',
        workspaceId: 'w2',
        terminalId: 't2',
        data: 'new',
        seq: 10,
        generation: 1,
      },
    ]);
  });

  it('rejects explicit unknown terminal IDs instead of falling back', async () => {
    const { peer, pty } = makeFixture();

    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      terminalId: 'stale-terminal',
    });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:error',
      requestId: 'r1',
      code: 'not-found',
    });
    expect(pty.getPresentationSnapshot).not.toHaveBeenCalled();
  });

  it('only allows input after terminal attach', async () => {
    const { peer, pty } = makeFixture();

    peer.emitJson({ type: 'app:terminal:input', terminalId: 't1', data: 'ls\r' });
    await flush();
    expect(pty.write).not.toHaveBeenCalled();
    expect(peer.sent[0]).toMatchObject({ type: 'app:error', code: 'not-attached' });

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitJson({ type: 'app:terminal:input', terminalId: 't1', data: 'ls\r' });
    await flush();
    expect(pty.write).toHaveBeenCalledWith('t1', 'ls\r');
  });

  it('releases remote size authority when the browser detaches or disconnects', async () => {
    const { peer, session, authorities } = makeFixture();

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    const firstAuthority = authorities[0];
    peer.emitJson({ type: 'app:terminal:detach', terminalId: 't1' });
    await flush();
    expect(firstAuthority.release).toHaveBeenCalledTimes(1);

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w1' });
    await flush();
    const secondAuthority = authorities[1];
    session.dispose();
    expect(secondAuthority.release).toHaveBeenCalledTimes(1);
  });

  it('sends a reconnecting phone only the output it missed, keeping the terminal size', async () => {
    const { peer, pty, emitData } = makeFixture();
    pty.getOutputSince.mockReturnValue([
      { data: 'missed 1', seq: 8 },
      { data: 'missed 2', seq: 9 },
    ]);

    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      terminalId: 't1',
      cols: 50,
      rows: 20,
      resume: { generation: 1, seq: 7 },
    });
    await flush();
    emitData('t1', 'live', 10);
    await flush();

    expect(pty.getOutputSince).toHaveBeenCalledWith('t1', 1, 7);
    expect(pty.getPresentationSnapshot).not.toHaveBeenCalled();
    // The phone resizes afterwards if its screen changed; replayed output keeps its layout.
    expect(pty.acquireSizeAuthority).toHaveBeenCalledWith('t1', 120, 30);
    expect(peer.sent).toEqual([
      {
        type: 'app:terminal:attached',
        requestId: 'r1',
        resumed: true,
        snapshot: {
          workspaceId: 'w1',
          terminalId: 't1',
          status: 'running',
          seq: 7,
          generation: 1,
          cols: 120,
          rows: 30,
          chunkCount: 0,
        },
      },
      expect.objectContaining({ type: 'app:terminal:data', data: 'missed 1', seq: 8 }),
      expect.objectContaining({ type: 'app:terminal:data', data: 'missed 2', seq: 9 }),
      expect.objectContaining({ type: 'app:terminal:data', data: 'live', seq: 10 }),
    ]);
    for (const frame of peer.sent) expect(parseRemoteAppFrame(frame)).not.toBeNull();
  });

  it('sends a snapshot when the output a phone missed is no longer kept', async () => {
    const { peer, pty } = makeFixture();

    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      resume: { generation: 1, seq: 2 },
    });
    await flush();

    expect(pty.getPresentationSnapshot).toHaveBeenCalled();
    expect(peer.sent[0]).toMatchObject({ type: 'app:terminal:attached', snapshot: { seq: 7 } });
    expect(peer.sent[0]).not.toHaveProperty('resumed');
  });

  it("keeps a disconnected phone's size lease for its reconnect, then lets it go", async () => {
    const device = { credentialId: 'phone' };
    const { peer, pty, service, authorities } = makeFixture({ sizeLeaseLingerMs: 40, device });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();

    peer.emitClose();
    const reconnected = new FakePeer();
    sessions.push(service.attachPeer(reconnected, device));
    reconnected.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w1' });
    await flush();

    // No second lease, so the desktop never flips back to its own size and redraws twice.
    expect(pty.acquireSizeAuthority).toHaveBeenCalledTimes(1);
    expect(authorities[0]!.release).not.toHaveBeenCalled();
    reconnected.emitClose();
    await wait(60);
    expect(authorities[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease a drop mid-attach left for the reconnect working', async () => {
    const device = { credentialId: 'phone' };
    const { peer, pty, service, authorities } = makeFixture({ sizeLeaseLingerMs: 60_000, device });
    // The connection drops while the attach is being sent, so the send fails.
    peer.sendEncryptedJson = async () => {
      peer.emitClose();
      throw new Error('peer closed before send');
    };
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    expect(authorities[0]!.release).not.toHaveBeenCalled();

    const reconnected = new FakePeer();
    sessions.push(service.attachPeer(reconnected, device));
    reconnected.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w1' });
    await flush();
    expect(pty.acquireSizeAuthority).toHaveBeenCalledTimes(1);
    expect(authorities[0]!.release).not.toHaveBeenCalled();
  });

  it('tells the phone when the desktop takes the size and when its resize takes it back', async () => {
    const { peer, authorities } = makeFixture();
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;
    const size = (owner: 'desktop' | 'remote', cols: number, rows: number) => ({
      type: 'app:terminal:size',
      workspaceId: 'w1',
      terminalId: 't1',
      owner,
      cols,
      rows,
    });

    authorities[0]!.desktopTakes(140, 40);
    // The desktop window reports the size it was given once more.
    authorities[0]!.desktopTakes(140, 40);
    authorities[0]!.desktopTakes(160, 50);
    peer.emitJson({ type: 'app:terminal:resize', terminalId: 't1', cols: 50, rows: 20 });
    peer.emitJson({ type: 'app:terminal:resize', terminalId: 't1', cols: 52, rows: 20 });
    await flush();

    expect(authorities[0]!.resize.mock.calls).toEqual([
      [50, 20],
      [52, 20],
    ]);
    expect(peer.sent).toEqual([
      size('desktop', 140, 40),
      size('desktop', 160, 50),
      size('remote', 50, 20),
    ]);
    for (const frame of peer.sent) expect(parseRemoteAppFrame(frame)).not.toBeNull();
  });

  it('sends output from before the desktop took the size ahead of saying so', async () => {
    const { peer, emitData, authorities } = makeFixture({ outputBatchMs: 20 });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent.length = 0;

    emitData('t1', 'a', 8);
    emitData('t1', 'b', 9);
    authorities[0]!.desktopTakes(140, 40);
    await flush();

    expect(peer.sent).toEqual([
      expect.objectContaining({ type: 'app:terminal:data', data: 'a' }),
      expect.objectContaining({ type: 'app:terminal:data', data: 'b' }),
      expect.objectContaining({ type: 'app:terminal:size', owner: 'desktop' }),
    ]);
  });

  it('tells the phone once attached when the desktop took the size during the attach', async () => {
    const { peer, pty, authorities } = makeFixture();
    let releaseSnapshot!: () => void;
    pty.getPresentationSnapshot.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (releaseSnapshot = resolve));
      return { buffer: 'hello', cols: 140, rows: 40, generation: 1, seq: 7 };
    });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    authorities[0]!.desktopTakes(140, 40);
    releaseSnapshot();
    await flush();

    expect(peer.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      'app:terminal:attached',
      'app:terminal:snapshot-chunk',
      'app:terminal:size',
    ]);
    expect(peer.sent[2]).toMatchObject({ owner: 'desktop', cols: 140, rows: 40 });
  });

  it('tells a reconnected phone, not the dropped connection, when the desktop takes the size', async () => {
    const device = { credentialId: 'phone' };
    const { peer, service, authorities } = makeFixture({ sizeLeaseLingerMs: 60_000, device });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitClose();
    peer.sent.length = 0;

    authorities[0]!.desktopTakes(140, 40);
    const reconnected = new FakePeer();
    sessions.push(service.attachPeer(reconnected, device));
    reconnected.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w1' });
    await flush();
    reconnected.sent.length = 0;
    authorities[0]!.desktopTakes(150, 45);
    await flush();

    expect(peer.sent).toEqual([]);
    expect(reconnected.sent).toEqual([
      expect.objectContaining({ type: 'app:terminal:size', owner: 'desktop', cols: 150 }),
    ]);
  });

  it('leaves the size with the desktop when it took it while the phone was away', async () => {
    const device = { credentialId: 'phone' };
    const { peer, service, authorities } = makeFixture({ sizeLeaseLingerMs: 60_000, device });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitClose();

    authorities[0]!.desktopTakes(140, 40);
    const reconnected = new FakePeer();
    sessions.push(service.attachPeer(reconnected, device));
    reconnected.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r2',
      workspaceId: 'w1',
      cols: 50,
      rows: 20,
    });
    await flush();

    expect(authorities[0]!.resize).not.toHaveBeenCalled();
    expect(reconnected.sent.at(-1)).toMatchObject({
      type: 'app:terminal:size',
      owner: 'desktop',
      cols: 140,
      rows: 40,
    });
  });

  it('releases a lingering size lease when another device attaches that terminal', async () => {
    const { peer, pty, service, authorities } = makeFixture({
      sizeLeaseLingerMs: 60_000,
      device: { credentialId: 'phone' },
    });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitClose();

    const tablet = new FakePeer();
    sessions.push(service.attachPeer(tablet, { credentialId: 'tablet' }));
    tablet.emitJson({ type: 'app:terminal:attach', requestId: 'r2', workspaceId: 'w1' });
    await flush();

    expect(authorities[0]!.release).toHaveBeenCalledTimes(1);
    expect(pty.acquireSizeAuthority).toHaveBeenCalledTimes(2);
    service.disableTerminalPresentationTracking();
    expect(authorities[1]!.release).not.toHaveBeenCalled();
  });

  it("releases a dropped phone's lingering size lease when the phone is removed", async () => {
    const { peer, service, authorities } = makeFixture({
      sizeLeaseLingerMs: 60_000,
      device: { credentialId: 'phone' },
    });
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitClose();
    expect(authorities[0]!.release).not.toHaveBeenCalled();

    service.releaseDeviceLeases('tablet');
    expect(authorities[0]!.release).not.toHaveBeenCalled();
    service.releaseDeviceLeases('phone');
    expect(authorities[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('gives up the terminal size when the phone stops its workspace', async () => {
    const { peer, workspaces, authorities } = makeFixture();
    peer.emitJson({
      type: 'app:terminal:attach',
      requestId: 'r1',
      workspaceId: 'w1',
      cols: 40,
      rows: 20,
    });
    await flush();

    peer.emitJson({ type: 'app:workspace:stop', requestId: 'r2', workspaceId: 'w1' });
    await flush();

    expect(workspaces.stop).toHaveBeenCalledWith('w1');
    expect(authorities[0]!.release).toHaveBeenCalledTimes(1);
  });

  it("leaves the screens of terminals the phone hasn't opened unread when they restart", async () => {
    const { peer, pty, emitReset } = makeFixture();
    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    pty.getPresentationMetadata.mockClear();

    emitReset('t2');

    expect(pty.getPresentationMetadata).not.toHaveBeenCalled();
  });

  it('forwards PTY resets as a new authoritative presentation generation', async () => {
    const { peer, presentationMetadata, emitReset } = makeFixture();

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent = [];
    presentationMetadata.set('t1', { cols: 48, rows: 18, generation: 2, seq: 7 });
    emitReset('t1');
    await flush();

    expect(peer.sent).toEqual([
      {
        type: 'app:terminal:reset',
        workspaceId: 'w1',
        terminalId: 't1',
        cols: 48,
        rows: 18,
        generation: 2,
        seq: 7,
      },
    ]);
  });

  it('preserves the terminal attachment across the stopped/reset sequence of a restart', async () => {
    const { peer, presentationMetadata, emitStatus, emitReset, emitData, emitExit, authorities } =
      makeFixture();

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.sent = [];

    emitStatus('t1', 'stopped');
    presentationMetadata.set('t1', { cols: 120, rows: 30, generation: 2, seq: 7 });
    emitReset('t1');
    emitData('t1', 'restarted', 8);
    await flush();

    expect(peer.sent).toEqual([
      expect.objectContaining({ type: 'app:terminal:status', status: 'stopped' }),
      expect.objectContaining({ type: 'app:terminal:reset', generation: 2 }),
      expect.objectContaining({
        type: 'app:terminal:data',
        data: 'restarted',
        generation: 2,
      }),
    ]);
    expect(authorities[0].release).not.toHaveBeenCalled();

    emitExit('t1');
    expect(authorities[0].release).toHaveBeenCalledTimes(1);
  });

  it('reports voice availability from the transcription model status', async () => {
    const { peer, voice } = makeFixture();

    voice.getStatus.mockReturnValue('ready');
    peer.emitJson({ type: 'app:voice:status', requestId: 'r1' });
    await flush();
    expect(peer.sent.at(-1)).toMatchObject({
      type: 'app:voice:availability',
      requestId: 'r1',
      available: true,
    });
    expect(voice.warmup).toHaveBeenCalledTimes(1);

    voice.getStatus.mockReturnValue('not-downloaded');
    peer.emitJson({ type: 'app:voice:status', requestId: 'r2' });
    await flush();
    expect(peer.sent.at(-1)).toMatchObject({
      type: 'app:voice:availability',
      requestId: 'r2',
      available: false,
    });
    expect(voice.warmup).toHaveBeenCalledTimes(1);
  });

  it('transcribes voice audio and writes the text to the attached terminal', async () => {
    const { peer, pty, voice } = makeFixture();
    // 16 little-endian Int16 samples (8 bytes) → base64.
    const pcm = new Int16Array([0, 16384, -16384, 32767]);
    const audio = Buffer.from(pcm.buffer).toString('base64');

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitJson({
      type: 'app:voice:transcribe',
      requestId: 'r2',
      terminalId: 't1',
      audio,
      seq: 0,
      final: true,
      enter: false,
    });
    await flush();

    expect(voice.transcribe).toHaveBeenCalledTimes(1);
    const samples = voice.transcribe.mock.calls[0][0] as Float32Array;
    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples.length).toBe(4);
    expect(samples[1]).toBeCloseTo(0.5, 2);
    expect(pty.write).toHaveBeenCalledWith('t1', 'transcribed text');
  });

  it('returns prompt voice transcription without requiring an attached terminal', async () => {
    const { peer, pty, voice } = makeFixture();
    const audio = Buffer.from(new Int16Array([0, 16384]).buffer).toString('base64');

    peer.emitJson({
      type: 'app:voice:transcribe',
      requestId: 'r1',
      purpose: 'prompt',
      audio,
      seq: 0,
      final: true,
      enter: false,
    });
    await flush();

    expect(voice.transcribe).toHaveBeenCalledTimes(1);
    expect(pty.write).not.toHaveBeenCalled();
    expect(peer.sent.at(-1)).toEqual({
      type: 'app:voice:transcribed',
      requestId: 'r1',
      text: 'transcribed text',
    });
  });

  it('reassembles chunked voice audio and appends a carriage return when enter is set', async () => {
    const { peer, pty, voice } = makeFixture();
    const chunkA = Buffer.from(new Int16Array([0, 16384]).buffer).toString('base64');
    const chunkB = Buffer.from(new Int16Array([-16384, 32767]).buffer).toString('base64');

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    peer.emitJson({
      type: 'app:voice:transcribe',
      requestId: 'r2',
      terminalId: 't1',
      audio: chunkA,
      seq: 0,
      final: false,
      enter: true,
    });
    await flush();
    expect(voice.transcribe).not.toHaveBeenCalled(); // waits for the final chunk
    peer.emitJson({
      type: 'app:voice:transcribe',
      requestId: 'r2',
      terminalId: 't1',
      audio: chunkB,
      seq: 1,
      final: true,
      enter: true,
    });
    await flush();

    expect(voice.transcribe).toHaveBeenCalledTimes(1);
    const samples = voice.transcribe.mock.calls[0][0] as Float32Array;
    expect(samples.length).toBe(4);
    expect(samples[1]).toBeCloseTo(0.5, 2);
    expect(samples[3]).toBeCloseTo(1, 2);
    expect(pty.write).toHaveBeenCalledWith('t1', 'transcribed text\r');
  });

  it('rejects an out-of-order voice chunk', async () => {
    const { peer, pty, voice } = makeFixture();
    const audio = Buffer.from(new Int16Array([1, 2]).buffer).toString('base64');

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'r1', workspaceId: 'w1' });
    await flush();
    // seq 1 with no preceding seq 0 → no buffer to append to.
    peer.emitJson({
      type: 'app:voice:transcribe',
      requestId: 'r2',
      terminalId: 't1',
      audio,
      seq: 1,
      final: true,
      enter: false,
    });
    await flush();

    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
    expect(peer.sent.at(-1)).toMatchObject({ type: 'app:error', code: 'bad-frame' });
  });

  it('rejects voice transcription for an unattached terminal', async () => {
    const { peer, pty, voice } = makeFixture();
    const audio = Buffer.from(new Int16Array([1, 2]).buffer).toString('base64');

    peer.emitJson({
      type: 'app:voice:transcribe',
      requestId: 'r1',
      terminalId: 't1',
      audio,
      seq: 0,
      final: true,
      enter: false,
    });
    await flush();

    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
    expect(peer.sent.at(-1)).toMatchObject({ type: 'app:error', code: 'not-attached' });
  });

  it('creates only project-backed worktree workspaces', async () => {
    const { peer, workspaces, windows } = makeFixture();
    const window = createMockBrowserWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

    peer.emitJson({ type: 'app:workspace:create', requestId: 'r1', name: 'Remote' });
    await flush();
    expect(workspaces.create).not.toHaveBeenCalled();
    expect(peer.sent[0]).toMatchObject({ type: 'app:error', code: 'unsupported' });

    peer.emitJson({
      type: 'app:workspace:create',
      requestId: 'r2',
      projectId: 'p1',
      name: 'Remote',
      branchName: 'remote-test',
      presetId: 'preset-1',
      launchModeId: 'mode-1',
      environment: { kind: 'ssh', hostId: 'ssh-1' },
    });
    await flush();
    expect(workspaces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'worktree',
        projectId: 'p1',
        windowId: 'main-window',
        branchName: 'remote-test',
        presetId: 'preset-1',
        launchModeId: 'mode-1',
        environment: { kind: 'ssh', hostId: 'ssh-1' },
      })
    );
    expect(peer.sent[1]).toMatchObject({ type: 'app:workspace:created', requestId: 'r2' });
    expect(peer.sent[2]).toMatchObject({ type: 'app:workspaces', requestId: 'r2' });
    expect(windows.broadcastWhenReady).toHaveBeenCalledWith(
      IPC.WORKSPACE_CREATED,
      expect.objectContaining({ id: 'w3' })
    );
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.WORKSPACES_CHANGED);
  });

  it('creates protocol-valid provisioning workspace summaries', async () => {
    const { peer, workspaces } = makeFixture();
    workspaces.create.mockResolvedValueOnce(
      makeWorkspace({
        id: 'w2',
        name: 'Remote',
        workingDirectory: '',
        provisioning: true,
        primaryTerminalId: undefined,
        terminals: [],
      })
    );

    peer.emitJson({
      type: 'app:workspace:create',
      requestId: 'r1',
      projectId: 'p1',
      name: 'Remote',
    });
    await flush();

    expect(workspaces.create).toHaveBeenCalledWith(
      expect.objectContaining({ deferBranchNaming: true })
    );
    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspace:created',
      workspace: { id: 'w2', workingDirectory: '', provisioning: true },
    });
    expect(
      RemoteWorkspaceSummarySchema.safeParse((peer.sent[0] as { workspace: unknown }).workspace)
        .success
    ).toBe(true);
  });

  it('starts stopped workspaces for remote selection', async () => {
    const { peer, workspaces, workspace } = makeFixture();
    const window = createMockBrowserWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);
    workspace.status = 'trashed';
    workspace.terminals = [];
    workspace.primaryTerminalId = undefined;

    peer.emitJson({
      type: 'app:workspace:start',
      requestId: 'r1',
      workspaceId: 'w1',
    });
    await flush();

    expect(workspaces.restartWithCleanup).toHaveBeenCalledWith('w1');
    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspace:started',
      requestId: 'r1',
      workspace: {
        id: 'w1',
        status: 'active',
        primaryTerminalId: 't-started',
        terminals: [{ id: 't-started', status: 'starting' }],
      },
    });
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.WORKSPACES_CHANGED);
  });

  it('names the request when a frame handler throws', async () => {
    const { peer, workspaces } = makeFixture();
    workspaces.create.mockRejectedValueOnce(new Error('WORKSPACE_LIMIT:Free plan is limited'));

    peer.emitJson({
      type: 'app:workspace:create',
      requestId: 'r1',
      projectId: 'p1',
      name: 'Remote',
    });
    await flush();

    expect(peer.sent.at(-1)).toMatchObject({
      type: 'app:error',
      requestId: 'r1',
      code: 'internal',
      message: 'WORKSPACE_LIMIT:Free plan is limited',
    });
  });

  it('reports cleanup-aware restart failures to remote callers', async () => {
    const { peer, workspaces } = makeFixture();
    workspaces.restartWithCleanup.mockRejectedValueOnce(new Error('remote setup failed'));

    peer.emitJson({
      type: 'app:workspace:start',
      requestId: 'r1',
      workspaceId: 'w1',
    });
    await flush();

    expect(peer.sent[0]).toMatchObject({
      type: 'app:error',
      requestId: 'r1',
      code: 'start-failed',
      message: 'remote setup failed',
    });
    expect(peer.sent).toHaveLength(1);
  });

  it('stops workspaces from the remote menu', async () => {
    const { peer, pty, workspaces, workspace } = makeFixture();
    const window = createMockBrowserWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

    peer.emitJson({ type: 'app:terminal:attach', requestId: 'attach-1', workspaceId: 'w1' });
    await flush();
    peer.sent = [];

    peer.emitJson({
      type: 'app:workspace:stop',
      requestId: 'r1',
      workspaceId: 'w1',
    });
    await flush();

    expect(workspaces.stop).toHaveBeenCalledWith('w1');
    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspace:stopped',
      requestId: 'r1',
      workspace: {
        id: 'w1',
        terminals: [{ id: 't1', status: 'stopped' }],
      },
    });
    expect(workspace.terminals[0]?.status).toBe('stopped');
    expect(peer.sent[1]).toMatchObject({ type: 'app:workspaces', requestId: 'r1' });
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.WORKSPACES_CHANGED);

    peer.sent = [];
    peer.emitJson({ type: 'app:terminal:input', terminalId: 't1', data: 'stale\r' });
    await flush();
    expect(pty.write).not.toHaveBeenCalledWith('t1', 'stale\r');
    expect(peer.sent[0]).toMatchObject({ type: 'app:error', code: 'not-attached' });
  });

  it('regenerates workspace titles from the remote menu', async () => {
    const { peer, workspaces } = makeFixture();
    const window = createMockBrowserWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window]);

    peer.emitJson({
      type: 'app:workspace:title:regenerate',
      requestId: 'r1',
      workspaceId: 'w1',
    });
    await flush();

    expect(workspaces.regenerateWorkspaceName).toHaveBeenCalledWith('w1');
    expect(peer.sent[0]).toMatchObject({
      type: 'app:workspace:title:regenerated',
      requestId: 'r1',
      workspace: { id: 'w1', name: 'Regenerated title' },
    });
    expect(peer.sent[1]).toMatchObject({ type: 'app:workspaces', requestId: 'r1' });
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.WORKSPACES_CHANGED);
  });
});
