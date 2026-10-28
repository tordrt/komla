import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { createMockBrowserWindow, type MockBrowserWindow } from '../../mocks/electron';

const mockEmitTerminalOscNotification = vi.hoisted(() => vi.fn());
const mockEmitTerminalTitle = vi.hoisted(() => vi.fn());
const mockEmitTerminalProgramStatus = vi.hoisted(() => vi.fn());

// Store created windows for lookup
const mockWindows: MockBrowserWindow[] = [];

// Mock electron's BrowserWindow and app
vi.mock('electron', () => {
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => mockWindows),
      fromId: vi.fn((id: number) => mockWindows.find((w) => w.id === id) ?? null),
    },
    app: {
      getPath: vi.fn(() => '/tmp/komla-test'),
      getName: vi.fn(() => 'komla'),
      getVersion: vi.fn(() => '0.0.0'),
    },
  };
});

// Mock config.service to prevent transitive imports from requiring full electron setup
vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({
      shellMode: 'native',
      wslDistro: undefined,
    })),
  },
}));

vi.mock('../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: {
    increment: vi.fn(),
    incrementAction: vi.fn(),
    incrementMcpTool: vi.fn(),
  },
}));

// Mock WSL module
vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: vi.fn(() => false),
  getWslShell: vi.fn(() => 'wsl.exe'),
  getWslShellArgs: vi.fn(() => []),
  windowsPathToWsl: vi.fn((path: string) => path),
}));

// Mock fs for shell detection and shell integration
const mockExistsSync = vi.fn();
vi.mock('fs', () => ({
  existsSync: (path: string) => mockExistsSync(path),
  readFileSync: vi.fn(() => ''),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock logger
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/lib/terminal-notification-events', () => ({
  emitTerminalOscNotification: mockEmitTerminalOscNotification,
  emitTerminalTitle: mockEmitTerminalTitle,
  emitTerminalProgramStatus: mockEmitTerminalProgramStatus,
}));

// Mock child_process.execFile for stty calls
const mockExecFile = vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) =>
  cb(null)
);
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...(args as Parameters<typeof mockExecFile>)),
}));

// Create mock IPty with proper node-pty interface
interface MockIPty {
  pid: number;
  cols: number;
  rows: number;
  process: string;
  handleFlowControl: boolean;
  ptsName: string;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  // Test helpers
  _dataCallback: ((data: string) => void) | null;
  _exitCallback: ((exitInfo: { exitCode: number; signal?: number }) => void) | null;
  _simulateData: (data: string) => void;
  _simulateExit: (exitCode: number, signal?: number) => void;
}

function createMockIPty(
  shell: string,
  options: { cols?: number; rows?: number; cwd?: string } = {}
): MockIPty {
  const pid = Math.floor(Math.random() * 100000);
  const pty: MockIPty = {
    pid,
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    process: shell,
    handleFlowControl: false,
    ptsName: `/dev/ttys${String(pid).padStart(3, '0')}`,
    _dataCallback: null,
    _exitCallback: null,
    onData: vi.fn((callback) => {
      pty._dataCallback = callback;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((callback) => {
      pty._exitCallback = callback;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      pty.cols = cols;
      pty.rows = rows;
    }),
    clear: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    _simulateData: (data: string) => {
      if (pty._dataCallback) {
        pty._dataCallback(data);
      }
    },
    _simulateExit: (exitCode: number, signal?: number) => {
      if (pty._exitCallback) {
        pty._exitCallback({ exitCode, signal });
      }
    },
  };
  return pty;
}

// Track spawned PTYs for test assertions
const spawnedPtys: MockIPty[] = [];
const mockSpawn = vi.fn(
  (
    shell: string,
    _args: string[],
    options: { cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ) => {
    const pty = createMockIPty(shell, options);
    spawnedPtys.push(pty);
    return pty;
  }
);

vi.mock('node-pty', () => ({
  spawn: mockSpawn,
}));

const ACTION_HANDOFF_SCRIPT =
  "__komla_action_handoff() { trap - INT; stty sane 2>/dev/null || true; exec '/bin/zsh' -l -o nopromptsp; }" +
  '; trap __komla_action_handoff INT';

function expectedActionStartupScript(echoedCommand: string, command: string): string {
  return `printf '\\033[2m %s\\033[0m\\n' ${echoedCommand}; ${ACTION_HANDOFF_SCRIPT}; ${command}; __komla_action_handoff`;
}

const POWERSHELL_ARGS = ['-ExecutionPolicy', 'Bypass', '-NoLogo'];

function powerShellStartupScript(args: string[]): string {
  expect(args.slice(0, -1)).toEqual([...POWERSHELL_ARGS, '-NoExit', '-Command']);
  return args.at(-1)!;
}

function expectedPowerShellStartup(echoedText: string, command: string): string {
  return `Write-Host -ForegroundColor DarkGray ' ${echoedText}'; ${command}`;
}

describe('PtyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    mockEmitTerminalOscNotification.mockClear();
    mockWindows.length = 0;
    spawnedPtys.length = 0;
    // Default: shell exists at /bin/zsh
    mockExistsSync.mockImplementation((path: string) => path === '/bin/zsh');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('spawn', () => {
    it('should spawn a PTY process with default options', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp'],
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: '/home/user',
        })
      );
    });

    it('should not pass NODE_ENV to spawned terminal environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        const spawnOptions = mockSpawn.mock.calls[0]?.[2];
        expect(spawnOptions?.env?.NODE_ENV).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('passes Komla terminal ID and hyperlink support to spawned terminal environment', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null, [], undefined, 'ws-1');

      const spawnOptions = mockSpawn.mock.calls[0]?.[2];
      expect(spawnOptions?.env?.KOMLA_TERMINAL_ID).toBe('term-1');
      expect(spawnOptions?.env?.FORCE_HYPERLINK).toBe('1');
      process.env.KOMLA_API_URL = 'http://127.0.0.1:52863';
      ptyService.spawn('term-api', '/home/user', null);
      expect(mockSpawn.mock.calls[1]?.[2]?.env?.KOMLA_API_URL).toBe(
        'http://127.0.0.1:52863/terminals/term-api'
      );
      delete process.env.KOMLA_API_URL;
      expect(spawnOptions?.env?.KOMLA_WORKSPACE_ID).toBeUndefined();
    });

    it('does not pass NODE_OPTIONS to terminals', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      const spawnOptions = mockSpawn.mock.calls[0]?.[2];
      expect(spawnOptions?.env?.NODE_OPTIONS).toBeUndefined();
    });

    it('spawns the PTY at the given dimensions when provided', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null, [], undefined, undefined, 0, 95, 42);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        expect.anything(),
        expect.objectContaining({ cols: 95, rows: 42 })
      );
    });

    it('restarts the PTY at the given dimensions when provided', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.restart('term-1', '/home/user', 'claude', 'ws-1', 95, 42);

      expect(mockSpawn.mock.calls[1]?.[2]).toMatchObject({ cols: 95, rows: 42 });
    });

    it('should throw if terminal already exists', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      expect(() => ptyService.spawn('term-1', '/home/user', null)).toThrow(
        'PTY already exists for terminal term-1'
      );
    });

    it('ignores stale exit from a replaced PTY with the same terminal ID', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      spawnedPtys[0]._simulateData('before restart');

      ptyService.restart('term-1', '/home/user', 'claude', 'ws-1');

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(ptyService.getStatus('term-1')).toBe('starting');

      spawnedPtys[0]._simulateExit(0);

      expect(ptyService.getStatus('term-1')).toBe('starting');
      expect(ptyService.getBuffer('term-1')).toEqual({ buffer: '', seq: 1 });
    });

    it('reports the replacement PTY as starting after stopping the old process', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const statuses: string[] = [];

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.onStatus((terminalId, status) => {
        if (terminalId === 'term-1') statuses.push(status);
      });

      ptyService.restart('term-1', '/home/user', 'claude', 'ws-1');

      expect(statuses).toEqual(['stopped', 'starting']);
    });

    it('ignores stale output from a replaced PTY with the same terminal ID', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1, 'ws-1');
      spawnedPtys[0]._simulateData('before restart');

      ptyService.restart('term-1', '/home/user', 'claude', 'ws-1');
      spawnedPtys[0]._simulateData('zsh:1: warning: 1 jobs SIGHUPed\r\n');

      expect(ptyService.getBuffer('term-1')).toEqual({ buffer: '', seq: 1 });
      expect(window.webContents.send).not.toHaveBeenCalledWith(
        'pty:data',
        'term-1',
        'zsh:1: warning: 1 jobs SIGHUPed\r\n',
        expect.any(Number)
      );
    });

    it('includes the current terminal host in buffer snapshots for late renderers', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      spawnedPtys[0]._simulateData('\x1b]7337;host=ssh:ssh-dev\x07agent output');

      expect(ptyService.getBuffer('term-1')).toEqual({
        buffer: 'agent output',
        seq: 1,
        hostInfo: { hostname: 'ssh:ssh-dev', isLocal: false },
      });
    });

    it('restores modes set before the snapshot cut, for renderers attaching late', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      spawnedPtys[0]._simulateData('\x1b[?2004h\x1b[?1004h');
      for (let i = 0; i < 3000; i++) {
        spawnedPtys[0]._simulateData(`\x1b[32m●\x1b[0m line ${i}\r\n`);
        vi.advanceTimersByTime(2);
      }

      const { buffer } = ptyService.getBuffer('term-1');
      expect(buffer.startsWith('\x1b[?2004h\x1b[?1004h')).toBe(true);
      expect(buffer.endsWith('line 2999\r\n')).toBe(true);
    });

    it('restores modes in a snapshot shorter than the tail, as Remote Control asks for', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      spawnedPtys[0]._simulateData('\x1b[?2004h');
      for (let i = 0; i < 3000; i++) {
        spawnedPtys[0]._simulateData(`line ${i}\r\n`);
        vi.advanceTimersByTime(2);
      }

      const { buffer } = ptyService.getBuffer('term-1', 1000);
      expect(buffer).toBe(`\x1b[?2004h${ptyService.getBuffer('term-1').buffer.slice(-1000)}`);
    });

    it('continues seq when restarting a stopped terminal with the same ID', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null, [], 1, 'ws-1');
      spawnedPtys[0]._simulateData('first');
      spawnedPtys[0]._simulateData('second');
      spawnedPtys[0]._simulateExit(0);

      expect(ptyService.getBuffer('term-1')).toEqual({ buffer: '', seq: 2 });

      ptyService.restart('term-1', '/home/user', 'claude', 'ws-1');
      spawnedPtys[1]._simulateData('after restart');

      expect(ptyService.getBuffer('term-1')).toEqual({ buffer: 'after restart', seq: 3 });
    });

    it('delivers output still held for coalescing when the terminal is killed', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const received: Array<[string, number]> = [];
      ptyService.onData((_terminalId, data, seq) => received.push([data, seq]));

      ptyService.spawn('term-1', '/home/user', null, [], 1, 'ws-1');
      spawnedPtys[0]._simulateData('first');
      spawnedPtys[0]._simulateData('last words');
      ptyService.kill('term-1');

      expect(received).toEqual([
        ['first', 1],
        ['last words', 2],
      ]);
    });

    it('resets seq after releaseTerminal when the same ID is spawned again', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null, [], 1, 'ws-1');
      spawnedPtys[0]._simulateData('first');
      spawnedPtys[0]._simulateExit(0);
      expect(ptyService.getBuffer('term-1')).toEqual({ buffer: '', seq: 1 });

      ptyService.releaseTerminal('term-1');

      ptyService.spawn('term-1', '/home/user', null, [], 1, 'ws-1');
      spawnedPtys[1]._simulateData('after release');

      expect(ptyService.getBuffer('term-1')).toEqual({ buffer: 'after release', seq: 1 });
    });

    it('waits for native exit before completing permanent terminal release', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      const releasePromise = ptyService.releaseTerminalAndWait('term-1');
      let resolved = false;
      void releasePromise.then(() => {
        resolved = true;
      });

      expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(resolved).toBe(false);

      spawnedPtys[0]._simulateExit(0);
      await releasePromise;
      expect(resolved).toBe(true);
    });

    it('waits for a previously stopped PTY to exit before completing permanent release', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.kill('term-1');
      const releasePromise = ptyService.releaseTerminalAndWait('term-1');
      let resolved = false;
      void releasePromise.then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      spawnedPtys[0]._simulateExit(0);
      await releasePromise;
      expect(resolved).toBe(true);
    });

    it('waits for the replacement PTY when a stale pre-restart exit arrives', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.restart('term-1', '/home/user', 'claude');
      const releasePromise = ptyService.releaseTerminalAndWait('term-1');
      let resolved = false;
      void releasePromise.then(() => {
        resolved = true;
      });

      spawnedPtys[0]._simulateExit(0);
      await Promise.resolve();
      expect(resolved).toBe(false);

      spawnedPtys[1]._simulateExit(0);
      await releasePromise;
      expect(resolved).toBe(true);
    });

    it('broadcasts terminal reset before respawning a PTY', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1, 'ws-1');
      ptyService.restart('term-1', '/home/user', 'claude', 'ws-1');

      expect(window.webContents.send).toHaveBeenCalledWith('terminal:reset', 'term-1');
      expect(mockSpawn).toHaveBeenLastCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript("'claude'", 'claude')],
        expect.objectContaining({
          cwd: '/home/user',
          env: expect.objectContaining({
            KOMLA_TERMINAL_ID: 'term-1',
          }),
        })
      );
      expect(mockSpawn.mock.calls.at(-1)?.[2]?.env?.KOMLA_WORKSPACE_ID).toBeUndefined();
    });

    it('drops xterm focus reports written during the restart startup window', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.restart('term-1', '/home/user', 'codex', 'ws-1');

      ptyService.write('term-1', '\x1b[I');

      expect(spawnedPtys[1].write).not.toHaveBeenCalled();
    });

    it('preserves non-focus input written during the restart startup window', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.restart('term-1', '/home/user', 'codex', 'ws-1');

      ptyService.write('term-1', '\x1b[Ihello');

      expect(spawnedPtys[1].write).toHaveBeenCalledWith('hello');
    });

    it('allows focus reports after the restart startup window expires', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.restart('term-1', '/home/user', 'codex', 'ws-1');

      vi.advanceTimersByTime(5000);
      ptyService.write('term-1', '\x1b[I');

      expect(spawnedPtys[1].write).toHaveBeenCalledWith('\x1b[I');
    });

    it('should pass command via spawn args on non-Windows (shell -c)', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // On non-Windows, command is passed via -ilc, not written to stdin
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript("'claude'", 'claude')],
        expect.objectContaining({ cwd: '/home/user' })
      );
      // No stdin write should happen
      spawnedPtys[0]._simulateData('$ ');
      vi.advanceTimersByTime(150);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('echoes the real startup command in the default startup mode', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'echo-command'
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript("'ssh user@host'", 'ssh user@host')],
        expect.objectContaining({ cwd: '/home/user' })
      );
    });

    it('starts an SSH launch without the local startup files when asked', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker',
        false
      );
      ptyService.restart(
        'term-1',
        '/home/user',
        'ssh user@host',
        undefined,
        undefined,
        undefined,
        'wait-for-marker',
        false
      );

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      for (const call of mockSpawn.mock.calls) {
        expect(call).toEqual([
          '/bin/sh',
          ['-c', 'ssh user@host'],
          expect.objectContaining({ cwd: '/home/user' }),
        ]);
      }
    });

    it('keeps SSH startup quiet and starting until the remote-ready marker arrives', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker'
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', `${ACTION_HANDOFF_SCRIPT}; ssh user@host; __komla_action_handoff`],
        expect.objectContaining({ cwd: '/home/user' })
      );

      vi.advanceTimersByTime(300);
      expect(ptyService.getStatus('term-1')).toBe('starting');

      spawnedPtys[0]._simulateData('SSH warning before remote startup\r\n');
      expect(ptyService.getStatus('term-1')).toBe('starting');

      spawnedPtys[0]._simulateData('\x1b]7337;remote-ready\x07remote shell ready');
      vi.advanceTimersByTime(2);
      expect(ptyService.getStatus('term-1')).toBe('running');
      expect(ptyService.getBuffer('term-1')).toEqual({
        buffer: 'SSH warning before remote startup\r\nremote shell ready',
        seq: 2,
      });
    });

    it('reports when an optimistic reconnect creates a replacement Managed Remote Terminal Session', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const replacementListener = vi.fn();
      ptyService.onManagedRemoteTerminalSessionReplaced(replacementListener);

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker'
      );
      spawnedPtys[0]._simulateData(
        '\x1b]7337;managed-remote-terminal-session-replaced\x07\x1b]7337;remote-ready\x07remote shell ready'
      );

      expect(replacementListener).toHaveBeenCalledWith('term-1');
      expect(ptyService.getBuffer('term-1')).toEqual({
        buffer: 'remote shell ready',
        seq: 1,
      });
    });

    it('reports and strips SSH terminal pool assignment markers', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const assignmentListener = vi.fn();
      ptyService.onSshTerminalPoolAssignment(assignmentListener);

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker'
      );
      spawnedPtys[0]._simulateData(
        '\x1b]7337;ssh-terminal-pool=12\x07\x1b]7337;remote-ready\x07remote shell ready'
      );

      expect(assignmentListener).toHaveBeenCalledWith('term-1', {
        kind: 'pooled',
        poolIndex: 12,
      });
      expect(ptyService.getBuffer('term-1')).toEqual({
        buffer: 'remote shell ready',
        seq: 1,
      });
    });

    it('reports every SSH terminal pool assignment from one output chunk in order', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const assignmentListener = vi.fn();
      ptyService.onSshTerminalPoolAssignment(assignmentListener);

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker'
      );
      spawnedPtys[0]._simulateData(
        '\x1b]7337;ssh-terminal-pool=0\x07' +
          '\x1b]7337;ssh-terminal-pool=1\x07' +
          '\x1b]7337;ssh-terminal-pool=2\x07remote shell ready'
      );

      expect(assignmentListener.mock.calls).toEqual([
        ['term-1', { kind: 'pooled', poolIndex: 0 }],
        ['term-1', { kind: 'pooled', poolIndex: 1 }],
        ['term-1', { kind: 'pooled', poolIndex: 2 }],
      ]);
      expect(ptyService.getBuffer('term-1')).toEqual({
        buffer: 'remote shell ready',
        seq: 1,
      });
    });

    it('reports a standalone SSH terminal assignment without exposing its marker', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const assignmentListener = vi.fn();
      ptyService.onSshTerminalPoolAssignment(assignmentListener);

      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh user@host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker'
      );
      spawnedPtys[0]._simulateData('\x1b]7337;ssh-terminal-pool=standalone\x07remote shell ready');

      expect(assignmentListener).toHaveBeenCalledWith('term-1', { kind: 'standalone' });
      expect(ptyService.getBuffer('term-1')).toEqual({
        buffer: 'remote shell ready',
        seq: 1,
      });
    });

    it.each(['', '-1', '16', '01', '1.5', 'invalid'])(
      'strips and ignores invalid SSH terminal pool assignment %s',
      async (poolAssignment) => {
        const { ptyService } = await import('../../../src/main/services/pty.service');
        const assignmentListener = vi.fn();
        ptyService.onSshTerminalPoolAssignment(assignmentListener);

        ptyService.spawn(
          'term-1',
          '/home/user',
          'ssh user@host',
          [],
          undefined,
          undefined,
          0,
          undefined,
          undefined,
          'wait-for-marker'
        );
        spawnedPtys[0]._simulateData(
          `\x1b]7337;ssh-terminal-pool=${poolAssignment}\x07remote shell ready`
        );

        expect(assignmentListener).not.toHaveBeenCalled();
        expect(ptyService.getBuffer('term-1')).toEqual({
          buffer: 'remote shell ready',
          seq: 1,
        });
      }
    );

    it('keeps remote startup quiet and starting past the local native Windows prompt', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn(
          'term-1',
          '/home/user',
          'ssh user@host',
          [],
          undefined,
          undefined,
          0,
          undefined,
          undefined,
          'wait-for-marker'
        );

        expect(powerShellStartupScript(mockSpawn.mock.calls[0][1])).toBe('ssh user@host');

        spawnedPtys[0]._simulateData('PS> ');
        vi.advanceTimersByTime(150);
        expect(spawnedPtys[0].write).not.toHaveBeenCalled();
        expect(ptyService.getStatus('term-1')).toBe('starting');

        spawnedPtys[0]._simulateData('\x1b]7337;remote-ready\x07remote shell ready');
        expect(ptyService.getStatus('term-1')).toBe('running');
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('keeps remote startup starting past the local WSL prompt', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { isWslMode } = await import('../../../src/main/lib/wsl');
        vi.mocked(isWslMode).mockReturnValue(true);
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn(
          'term-1',
          '/home/user',
          'ssh user@host',
          [],
          undefined,
          undefined,
          0,
          undefined,
          undefined,
          'wait-for-marker'
        );

        spawnedPtys[0]._simulateData('$ ');
        expect(ptyService.getStatus('term-1')).toBe('starting');

        vi.advanceTimersByTime(150);
        expect(spawnedPtys[0].write).toHaveBeenCalledTimes(1);
        expect(ptyService.getStatus('term-1')).toBe('starting');

        const echoedLauncher = spawnedPtys[0].write.mock.calls[0]?.[0] as string;
        spawnedPtys[0]._simulateData(echoedLauncher);
        expect(ptyService.getStatus('term-1')).toBe('starting');

        spawnedPtys[0]._simulateData('\x1b]7337;remote-ready\x07remote shell ready');
        vi.advanceTimersByTime(2);
        expect(ptyService.getStatus('term-1')).toBe('running');
      } finally {
        const { isWslMode } = await import('../../../src/main/lib/wsl');
        vi.mocked(isWslMode).mockReturnValue(false);
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('should pass command with quoted arguments via spawn args', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude', ['Fix the bug in auth']);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        [
          '-ilc',
          expectedActionStartupScript(
            '\'claude "Fix the bug in auth"\'',
            'claude "Fix the bug in auth"'
          ),
        ],
        expect.objectContaining({ cwd: '/home/user' })
      );
    });

    it('should not quote simple flag arguments in spawn args', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude', ['--continue']);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript("'claude --continue'", 'claude --continue')],
        expect.objectContaining({ cwd: '/home/user' })
      );
    });

    it('should escape double quotes in arguments in spawn args', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude', ['Fix the "auth" bug']);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        [
          '-ilc',
          expectedActionStartupScript(
            '\'claude "Fix the \\"auth\\" bug"\'',
            'claude "Fix the \\"auth\\" bug"'
          ),
        ],
        expect.objectContaining({ cwd: '/home/user' })
      );
    });

    it('should POSIX-quote single quotes in the echoed command', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      // Argument contains a single quote — the echo prefix runs through
      // shellQuotePosix, which must escape ' as '"'"' to stay valid inside
      // the outer single-quoted literal.
      ptyService.spawn('term-1', '/home/user', 'claude', ["it's broken"]);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript(`'claude "it'"'"'s broken"'`, `claude "it's broken"`)],
        expect.objectContaining({ cwd: '/home/user' })
      );
    });

    it('should pass shell metacharacters through unchanged via POSIX single-quoting', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      // `$`, backticks, and backslashes have no special meaning inside POSIX
      // single quotes, so the echo payload should preserve them literally.
      ptyService.spawn('term-1', '/home/user', 'claude', ['$foo `bar` \\baz']);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        [
          '-ilc',
          expectedActionStartupScript(
            `'claude "$foo \`bar\` \\baz"'`,
            `claude "$foo \`bar\` \\baz"`
          ),
        ],
        expect.objectContaining({ cwd: '/home/user' })
      );
    });

    it.each([
      {
        name: 'runs the startup command from PowerShell arguments instead of typing it',
        command: 'claude',
        args: ['Fix the $auth bug'],
        expected: expectedPowerShellStartup(
          "claude ''Fix the $auth bug''",
          "claude 'Fix the $auth bug'"
        ),
      },
      {
        name: 'escapes single quotes in PowerShell by doubling them',
        command: 'claude',
        args: ["Fix the user's bug"],
        expected: expectedPowerShellStartup(
          "claude ''Fix the user''''s bug''",
          "claude 'Fix the user''s bug'"
        ),
      },
      {
        name: 'escapes an argument that is only a single quote on Windows',
        command: 'claude',
        args: ["'"],
        expected: expectedPowerShellStartup("claude ''''''''", "claude ''''"),
      },
      {
        name: 'doubles typographic single quotes in PowerShell arguments',
        command: 'claude',
        args: ['Fix the user’s bug'],
        expected: expectedPowerShellStartup(
          "claude ''Fix the user’’’’s bug''",
          "claude 'Fix the user’’s bug'"
        ),
      },
      {
        name: 'doubles typographic single quotes in the echoed PowerShell command',
        command: 'claude "Fix the user’s bug"',
        args: [],
        expected: expectedPowerShellStartup(
          'claude "Fix the user’’s bug"',
          'claude "Fix the user’s bug"'
        ),
      },
      {
        name: 'runs a 10,000-character prompt from PowerShell arguments',
        command: `claude "${'x'.repeat(10_000)}"`,
        args: [],
        expected: expectedPowerShellStartup(
          `claude "${'x'.repeat(10_000)}"`,
          `claude "${'x'.repeat(10_000)}"`
        ),
      },
    ])('$name', async ({ command, args, expected }) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', 'C:\\Users\\test', command, args);

        expect(mockSpawn.mock.calls[0][0]).toBe('powershell.exe');
        expect(powerShellStartupScript(mockSpawn.mock.calls[0][1])).toBe(expected);
        spawnedPtys[0]._simulateData('PS> ');
        vi.advanceTimersByTime(5000);
        expect(spawnedPtys[0].write).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('drops the echo for a startup command too long to repeat on a Windows command line', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        const command = `claude "${'x'.repeat(20_000)}"`;

        ptyService.spawn('term-1', 'C:\\Users\\test', command);

        expect(powerShellStartupScript(mockSpawn.mock.calls[0][1])).toBe(command);
        spawnedPtys[0]._simulateData('PS> ');
        vi.advanceTimersByTime(5000);
        expect(spawnedPtys[0].write).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('types a startup command too long for a Windows command line into PowerShell', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        const command = `claude "${'x'.repeat(33_000)}"`;

        ptyService.spawn('term-1', 'C:\\Users\\test', command);

        expect(mockSpawn.mock.calls[0][1]).toEqual(POWERSHELL_ARGS);
        spawnedPtys[0]._simulateData('PS> ');
        vi.advanceTimersByTime(150);
        expect(spawnedPtys[0].write).toHaveBeenCalledWith(`${command}\r`);
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    describe("Komla's ConPTY", () => {
      async function spawnOnWindows(windowsUseConptyDll: boolean | undefined) {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
          vi.resetModules();
          const { configService } = await import('../../../src/main/services/config.service');
          vi.mocked(configService.get).mockReturnValue({
            shellMode: 'powershell',
            windowsUseConptyDll,
          } as never);
          const { ptyService } = await import('../../../src/main/services/pty.service');
          mockWindows.push(createMockBrowserWindow({ id: 42 }));
          ptyService.spawn('term-1', 'C:\\Users\\test', null, [], 42);
          return ptyService;
        } finally {
          Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
          });
        }
      }

      const rendererOutput = () =>
        mockWindows[mockWindows.length - 1].webContents.send.mock.calls
          .filter((call) => call[0] === 'pty:data')
          .map((call) => call[2])
          .join('');

      it('uses the inbox ConPTY once turned off', async () => {
        await spawnOnWindows(false);

        expect(mockSpawn).toHaveBeenCalledOnce();
        expect(mockSpawn.mock.calls[0][2]).not.toHaveProperty('useConptyDll');
      });

      it("spawns with node-pty's bundled conpty.dll unless turned off", async () => {
        await spawnOnWindows(undefined);

        expect(mockSpawn).toHaveBeenCalledOnce();
        expect(mockSpawn.mock.calls[0][2]).toMatchObject({
          useConptyDll: true,
          cwd: 'C:\\Users\\test',
        });
      });

      it('falls back to the inbox ConPTY for good once the bundled one fails to load', async () => {
        mockSpawn.mockImplementationOnce(() => {
          throw new Error('Cannot find conpty.dll at C:\\Komla\\conpty\\conpty.dll');
        });

        const ptyService = await spawnOnWindows(true);
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
          ptyService.spawn('term-2', 'C:\\Users\\test', null);
        } finally {
          Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
          });
        }

        expect(mockSpawn).toHaveBeenCalledTimes(3);
        expect(mockSpawn.mock.calls[1][2]).not.toHaveProperty('useConptyDll');
        expect(mockSpawn.mock.calls[2][2]).not.toHaveProperty('useConptyDll');
        expect(spawnedPtys).toHaveLength(2);
      });

      it('rethrows a spawn error that is not the bundled ConPTY failing to load', async () => {
        mockSpawn.mockImplementationOnce(() => {
          throw new Error('Cannot create process, error code: 2');
        });

        await expect(spawnOnWindows(true)).rejects.toThrow('Cannot create process');
        expect(mockSpawn).toHaveBeenCalledOnce();
      });

      it('answers the device attributes query the bundled ConPTY sends as it starts', async () => {
        await spawnOnWindows(true);
        spawnedPtys[0]._simulateData('\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h');
        vi.advanceTimersByTime(2);

        // Unanswered, it holds the terminal for about 3 s; xterm answers only while a view is
        // attached, so it doesn't see the query to answer it twice.
        expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x1b[?1;2c');
        expect(rendererOutput()).toBe('\x1b[1t\x1b[?1004h\x1b[?9001h');

        // A program's own query is xterm's to answer, after the program's OSC 7501 answer.
        spawnedPtys[0].write.mockClear();
        spawnedPtys[0]._simulateData('PS C:\\Users\\test> \x1b[c');
        vi.advanceTimersByTime(20);
        expect(spawnedPtys[0].write).not.toHaveBeenCalled();
        expect(rendererOutput()).toContain('PS C:\\Users\\test> \x1b[c');
      });

      it('finds the startup query in a later read, until the shell prints', async () => {
        await spawnOnWindows(true);
        spawnedPtys[0]._simulateData('\x1b[1t');
        vi.advanceTimersByTime(20);
        spawnedPtys[0]._simulateData('\x1b[c\x1b[?1004h');
        vi.advanceTimersByTime(20);

        expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x1b[?1;2c');
        expect(rendererOutput()).toBe('\x1b[1t\x1b[?1004h');
      });

      it('stops looking for the startup query once the shell prints', async () => {
        await spawnOnWindows(true);
        spawnedPtys[0]._simulateData('PS> ');
        vi.advanceTimersByTime(20);
        spawnedPtys[0]._simulateData('\x1b[c');
        vi.advanceTimersByTime(20);

        expect(spawnedPtys[0].write).not.toHaveBeenCalledWith('\x1b[?1;2c');
      });

      it("leaves device attributes queries to xterm with Windows' own ConPTY", async () => {
        await spawnOnWindows(false);
        spawnedPtys[0]._simulateData('\x1b[c');
        vi.advanceTimersByTime(2);

        expect(spawnedPtys[0].write).not.toHaveBeenCalledWith('\x1b[?1;2c');
        expect(rendererOutput()).toBe('\x1b[c');
      });

      it('answers a program asking whether the terminal takes its statuses', async () => {
        await spawnOnWindows(true);
        spawnedPtys[0]._simulateData('\x1b]7501;?\x07');
        vi.advanceTimersByTime(2);

        expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x1b]7501;?\x1b\\');
      });

      it("leaves the query unanswered once it falls back to Windows' own ConPTY", async () => {
        mockSpawn.mockImplementationOnce(() => {
          throw new Error('Cannot find conpty.dll at C:\\Komla\\conpty\\conpty.dll');
        });
        await spawnOnWindows(true);
        spawnedPtys[0]._simulateData('\x1b]7501;?\x07');
        vi.advanceTimersByTime(2);

        expect(spawnedPtys[0].write).not.toHaveBeenCalledWith('\x1b]7501;?\x1b\\');
      });

      it('ignores the setting off Windows', async () => {
        vi.resetModules();
        const { configService } = await import('../../../src/main/services/config.service');
        vi.mocked(configService.get).mockReturnValue({ windowsUseConptyDll: true } as never);
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn.mock.calls[0][2]).not.toHaveProperty('useConptyDll');
      });
    });

    it('should use Unix double-quote escaping in WSL mode', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { isWslMode } = await import('../../../src/main/lib/wsl');
        vi.mocked(isWslMode).mockReturnValue(true);

        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', 'claude', ['Fix the $auth bug']);

        spawnedPtys[0]._simulateData('$ ');
        vi.advanceTimersByTime(150);
        expect(spawnedPtys[0].write).toHaveBeenCalledWith(
          'cd \'/home/user\' && claude "Fix the $auth bug"\r'
        );
      } finally {
        // Restore isWslMode mock to default (vi.clearAllMocks doesn't reset mockReturnValue)
        const { isWslMode } = await import('../../../src/main/lib/wsl');
        vi.mocked(isWslMode).mockReturnValue(false);
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('should cd into translated WSL cwd before showing an interactive shell', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const wslModule = await import('../../../src/main/lib/wsl');
        vi.mocked(wslModule.isWslMode).mockReturnValue(true);
        vi.mocked(wslModule.windowsPathToWsl).mockReturnValue('/mnt/c/Users/test/project');

        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', 'C:\\Users\\test\\project', null);

        spawnedPtys[0]._simulateData('$ ');
        vi.advanceTimersByTime(150);
        expect(spawnedPtys[0].write).toHaveBeenCalledWith("cd '/mnt/c/Users/test/project'\r");
      } finally {
        const wslModule = await import('../../../src/main/lib/wsl');
        vi.mocked(wslModule.isWslMode).mockReturnValue(false);
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('should associate terminal with window when windowId provided', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 42);

      // Simulate data to trigger IPC send
      vi.advanceTimersByTime(300); // Status transitions to running
      spawnedPtys[0]._simulateData('hello');

      expect(window.webContents.send).toHaveBeenCalledWith('pty:data', 'term-1', 'hello', 1);
    });

    it('should transition to "running" status after 300ms', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      expect(ptyService.getStatus('term-1')).toBe('starting');

      vi.advanceTimersByTime(300);
      expect(ptyService.getStatus('term-1')).toBe('running');
    });

    it('should broadcast status change to all windows', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window1 = createMockBrowserWindow({ id: 1 });
      const window2 = createMockBrowserWindow({ id: 2 });
      mockWindows.push(window1, window2);

      ptyService.spawn('term-1', '/home/user', null);
      vi.advanceTimersByTime(300); // Trigger status transition

      expect(window1.webContents.send).toHaveBeenCalledWith(
        'terminal:status-change',
        'term-1',
        'running'
      );
      expect(window2.webContents.send).toHaveBeenCalledWith(
        'terminal:status-change',
        'term-1',
        'running'
      );
    });
  });

  describe('shell detection', () => {
    it('should use SHELL env variable if it exists', async () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = '/usr/local/bin/fish';
      mockExistsSync.mockImplementation(
        (path: string) => path === '/usr/local/bin/fish' || path === '/bin/zsh'
      );

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn).toHaveBeenCalledWith(
          '/usr/local/bin/fish',
          ['-l'],
          expect.objectContaining({})
        );
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it('should fallback to /bin/zsh if SHELL not found', async () => {
      const originalShell = process.env.SHELL;
      delete process.env.SHELL;
      mockExistsSync.mockImplementation((path: string) => path === '/bin/zsh');

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn).toHaveBeenCalledWith(
          '/bin/zsh',
          ['-l', '-o', 'nopromptsp'],
          expect.objectContaining({})
        );
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it('should fallback to /bin/bash if zsh not found', async () => {
      const originalShell = process.env.SHELL;
      delete process.env.SHELL;
      mockExistsSync.mockImplementation((path: string) => path === '/bin/bash');

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn).toHaveBeenCalledWith('/bin/bash', ['-l'], expect.objectContaining({}));
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it('should fallback to /bin/sh as last resort', async () => {
      const originalShell = process.env.SHELL;
      delete process.env.SHELL;
      mockExistsSync.mockReturnValue(false); // No shells exist

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn).toHaveBeenCalledWith('/bin/sh', ['-l'], expect.objectContaining({}));
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it('should skip SHELL env var if file does not exist on disk', async () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = '/usr/local/bin/fish';
      mockExistsSync.mockImplementation(
        (path: string) => path !== '/usr/local/bin/fish' && path === '/bin/zsh'
      );

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn).toHaveBeenCalledWith(
          '/bin/zsh',
          ['-l', '-o', 'nopromptsp'],
          expect.objectContaining({})
        );
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it('should use powershell.exe with PowerShell flags on Windows', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');
        ptyService.spawn('term-1', '/home/user', null);

        expect(mockSpawn).toHaveBeenCalledWith(
          'powershell.exe',
          ['-ExecutionPolicy', 'Bypass', '-NoLogo'],
          expect.objectContaining({})
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });
  });

  describe('handleOutput', () => {
    it('should send data to owning window', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('terminal output');

      expect(window.webContents.send).toHaveBeenCalledWith(
        'pty:data',
        'term-1',
        'terminal output',
        1
      );
    });

    it('sends a lone chunk at once and merges output that follows within 2 ms', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);
      const listened: Array<[string, number]> = [];
      ptyService.onData((_terminalId, data, seq) => listened.push([data, seq]));
      const dataSends = () =>
        window.webContents.send.mock.calls.filter((call) => call[0] === 'pty:data');

      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('echo');
      expect(dataSends()).toEqual([['pty:data', 'term-1', 'echo', 1]]);

      spawnedPtys[0]._simulateData('a');
      spawnedPtys[0]._simulateData('b');
      expect(dataSends()).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(dataSends().at(-1)).toEqual(['pty:data', 'term-1', 'ab', 2]);

      // A window with nothing held closes the hold, so the next chunk goes out at once.
      vi.advanceTimersByTime(2);
      spawnedPtys[0]._simulateData('next');
      expect(dataSends().at(-1)).toEqual(['pty:data', 'term-1', 'next', 3]);
      expect(listened).toEqual([
        ['echo', 1],
        ['ab', 2],
        ['next', 3],
      ]);
    });

    it('sends held output before the exit event', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('first');
      spawnedPtys[0]._simulateData('last words');
      spawnedPtys[0]._simulateExit(0);

      const events = window.webContents.send.mock.calls
        .filter((call) => call[0] === 'pty:data' || call[0] === 'terminal:exit')
        .map((call) => [call[0], call[2]]);
      expect(events).toEqual([
        ['pty:data', 'first'],
        ['pty:data', 'last words'],
        ['terminal:exit', 0],
      ]);
    });

    it('should transition to "running" on first output if still "starting"', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      expect(ptyService.getStatus('term-1')).toBe('starting');

      spawnedPtys[0]._simulateData('prompt');
      expect(ptyService.getStatus('term-1')).toBe('running');
    });

    it('should broadcast to all windows if no target window', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window1 = createMockBrowserWindow({ id: 1 });
      const window2 = createMockBrowserWindow({ id: 2 });
      mockWindows.push(window1, window2);

      ptyService.spawn('term-1', '/home/user', null); // No windowId
      spawnedPtys[0]._simulateData('hello');

      expect(window1.webContents.send).toHaveBeenCalledWith('pty:data', 'term-1', 'hello', 1);
      expect(window2.webContents.send).toHaveBeenCalledWith('pty:data', 'term-1', 'hello', 1);
    });

    it('should fallback to broadcast if target window is destroyed', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const destroyedWindow = createMockBrowserWindow({ id: 42 });
      destroyedWindow.isDestroyed = vi.fn(() => true);
      const aliveWindow = createMockBrowserWindow({ id: 43 });
      mockWindows.push(destroyedWindow, aliveWindow);

      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('hello');

      // Should not send to destroyed window, but send to alive window
      expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
      expect(aliveWindow.webContents.send).toHaveBeenCalledWith('pty:data', 'term-1', 'hello', 1);
    });

    it('should limit output buffer to 2000 characters', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      // Send a large chunk of data
      const largeData = 'x'.repeat(3000);
      spawnedPtys[0]._simulateData(largeData);

      // We can't directly check the buffer, but the service should not crash
      // and should continue to work
      expect(ptyService.isRunning('term-1')).toBe(true);
    });

    it('joins a host-OSC split across two chunks and strips it from the stream', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 42);

      // Deliberately split the OSC mid-hostname.
      spawnedPtys[0]._simulateData('before\x1b]7337;host=komla-v');
      spawnedPtys[0]._simulateData('m\x07after');
      vi.advanceTimersByTime(2);

      // Host-change event fires exactly once with the rejoined hostname.
      const hostCalls = window.webContents.send.mock.calls.filter(
        (c) => c[0] === 'terminal:host-changed'
      );
      expect(hostCalls).toHaveLength(1);
      expect(hostCalls[0][2]).toBe('komla-vm');

      // The OSC escape bytes never appear in any pty:data payload.
      const dataCalls = window.webContents.send.mock.calls.filter((c) => c[0] === 'pty:data');
      const joined = dataCalls.map((c) => c[2] as string).join('');
      expect(joined).not.toContain('\x1b]7337');
      expect(joined).toContain('before');
      expect(joined).toContain('after');
    });

    it('reassembles title OSC chunks, preserves display output, and retires the title generation on exit', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('before\x1b]2;⠋ pro');
      expect(mockEmitTerminalTitle).not.toHaveBeenCalled();
      spawnedPtys[0]._simulateData('ject\x07after');
      vi.advanceTimersByTime(2);
      expect(mockEmitTerminalTitle).toHaveBeenCalledWith('term-1', '⠋ project');
      const output = window.webContents.send.mock.calls
        .filter((call) => call[0] === 'pty:data')
        .map((call) => call[2])
        .join('');
      expect(output).toBe('before\x1b]2;⠋ project\x07after');
      spawnedPtys[0]._simulateExit(0);
      expect(mockEmitTerminalTitle).toHaveBeenLastCalledWith('term-1', null);
    });

    it('reassembles the program statuses Codex writes, and leaves them in the output', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('a\x1b]7501;state=work');
      expect(mockEmitTerminalProgramStatus).not.toHaveBeenCalled();
      spawnedPtys[0]._simulateData('ing:app=codex\x1b\\b');
      vi.advanceTimersByTime(2);
      expect(mockEmitTerminalProgramStatus).toHaveBeenCalledWith('term-1', {
        app: 'codex',
        state: 'working',
      });
      const output = window.webContents.send.mock.calls
        .filter((call) => call[0] === 'pty:data')
        .map((call) => call[2])
        .join('');
      expect(output).toBe('a\x1b]7501;state=working:app=codex\x1b\\b');
    });

    it("answers a program's status query before xterm can answer its device attributes query", async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      // Claude Code asks both at once, and ignores a status answer that comes after the DA1 one.
      spawnedPtys[0]._simulateData('\x1b[>0q\x1b]7501;?\x07\x1b[c');
      vi.advanceTimersByTime(2);

      const answer = spawnedPtys[0].write.mock.calls.findIndex(
        (call) => call[0] === '\x1b]7501;?\x1b\\'
      );
      const forwarded = window.webContents.send.mock.calls.findIndex(
        (call) => call[0] === 'pty:data'
      );
      expect(answer).toBeGreaterThanOrEqual(0);
      expect(forwarded).toBeGreaterThanOrEqual(0);
      expect(spawnedPtys[0].write.mock.invocationCallOrder[answer]).toBeLessThan(
        window.webContents.send.mock.invocationCallOrder[forwarded]
      );
    });

    it('tells a program that asks that it takes its statuses, as Claude Code asks before reporting', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      mockWindows.push(createMockBrowserWindow({ id: 42 }));
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('\x1b]7501;?\x1b\\\x1b[c');
      vi.advanceTimersByTime(2);

      expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x1b]7501;?\x1b\\');
    });

    it("leaves the query unanswered with Windows' own ConPTY, which drops the answer", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const { configService } = await import('../../../src/main/services/config.service');
        vi.mocked(configService.get).mockReturnValue({
          shellMode: 'powershell',
          windowsUseConptyDll: false,
        } as never);
        const { ptyService } = await import('../../../src/main/services/pty.service');
        mockWindows.push(createMockBrowserWindow({ id: 42 }));
        ptyService.spawn('term-1', 'C:\\Users\\user', null, [], 42);
        spawnedPtys[0]._simulateData('\x1b]7501;?\x1b\\');
        vi.advanceTimersByTime(2);

        expect(spawnedPtys[0].write).not.toHaveBeenCalledWith('\x1b]7501;?\x1b\\');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it("doesn't count a record of the program's own, such as a subagent's, as the program reporting", async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      mockWindows.push(createMockBrowserWindow({ id: 42 }));
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0].process = 'claude';
      spawnedPtys[0]._simulateData('\x1b]7501;state=working:app=claude-code:id=a1\x1b\\');
      vi.advanceTimersByTime(2);

      spawnedPtys[0].process = 'bash';
      ptyService.write('term-1', '\r');
      vi.advanceTimersByTime(1000);

      expect(mockEmitTerminalProgramStatus).not.toHaveBeenCalledWith('term-1', { state: 'clear' });
    });

    it('reports a program that was killed before it could clear its status gone', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      mockWindows.push(createMockBrowserWindow({ id: 42 }));
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      const shell = spawnedPtys[0].process;
      spawnedPtys[0].process = 'codex';
      spawnedPtys[0]._simulateData('\x1b]7501;state=working:app=codex\x1b\\');
      vi.advanceTimersByTime(2);

      // Its Enter reaches Codex, which is still in the foreground.
      ptyService.write('term-1', '\r');
      vi.advanceTimersByTime(1000);

      expect(mockEmitTerminalProgramStatus).not.toHaveBeenCalledWith('term-1', { state: 'clear' });

      // Killed, Codex left the shell in the foreground.
      spawnedPtys[0].process = shell;
      ptyService.write('term-1', '\x03');
      vi.advanceTimersByTime(1000);

      expect(mockEmitTerminalProgramStatus).toHaveBeenLastCalledWith('term-1', { state: 'clear' });
    });

    it('emits kitty OSC 99 continuation notifications once complete', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 42 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 42);
      spawnedPtys[0]._simulateData('before\x1b]99;i=1:d=0;Agent\x1b\\');
      spawnedPtys[0]._simulateData('\x1b]99;i=1:p=body;Finished\x1b\\after');
      vi.advanceTimersByTime(2);

      expect(mockEmitTerminalOscNotification).toHaveBeenCalledTimes(1);
      expect(mockEmitTerminalOscNotification).toHaveBeenCalledWith({
        terminalId: 'term-1',
        title: 'Agent',
        message: 'Finished',
      });

      const dataCalls = window.webContents.send.mock.calls.filter((c) => c[0] === 'pty:data');
      const joined = dataCalls.map((c) => c[2] as string).join('');
      expect(joined).toBe('beforeafter');
    });
  });

  describe('handleExit', () => {
    it('tells exit listeners the exit code and the last output', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      mockWindows.push(createMockBrowserWindow({ id: 1 }));
      const listener = vi.fn();
      ptyService.onExit(listener);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);
      spawnedPtys[0]._simulateData('ssh: connect to host devbox port 22: No route to host\r\n');
      spawnedPtys[0]._simulateExit(255);

      expect(listener).toHaveBeenCalledWith('term-1', {
        exitCode: 255,
        output: expect.stringContaining('No route to host'),
      });
    });

    it('should send error event on non-zero exit code', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);

      spawnedPtys[0]._simulateExit(1);

      expect(window.webContents.send).toHaveBeenCalledWith(
        'terminal:error',
        'term-1',
        'Process exited with code 1'
      );
    });

    it('should send the native terminal exit code only to the owning window', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const owner = createMockBrowserWindow({ id: 1 });
      const otherWindow = createMockBrowserWindow({ id: 2 });
      mockWindows.push(owner, otherWindow);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);

      spawnedPtys[0]._simulateExit(0);

      expect(owner.webContents.send).toHaveBeenCalledWith('terminal:exit', 'term-1', 0, undefined);
      expect(otherWindow.webContents.send).not.toHaveBeenCalledWith(
        'terminal:exit',
        'term-1',
        0,
        undefined
      );
    });

    it('should send the native terminal exit signal to the owning window', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const owner = createMockBrowserWindow({ id: 1 });
      mockWindows.push(owner);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);

      spawnedPtys[0]._simulateExit(0, 9);

      expect(owner.webContents.send).toHaveBeenCalledWith('terminal:exit', 'term-1', 0, 9);
    });

    it('should not send error event on zero exit code', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);

      spawnedPtys[0]._simulateExit(0);

      const errorCalls = window.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'terminal:error'
      );
      expect(errorCalls).toHaveLength(0);
    });

    it('should clean up internal state on exit', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      vi.advanceTimersByTime(300);

      spawnedPtys[0]._simulateExit(0);

      expect(ptyService.getStatus('term-1')).toBeNull();
      expect(ptyService.isRunning('term-1')).toBe(false);
    });

    it('should clear startup timeout if process exits before timeout fires', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1);

      // Process is in 'starting' state, no output yet
      expect(ptyService.getStatus('term-1')).toBe('starting');

      // Process exits immediately (before 300ms timeout or any output)
      spawnedPtys[0]._simulateExit(0);

      // Clear mock calls before advancing time
      window.webContents.send.mockClear();

      // Advance past the 300ms startup timeout
      vi.advanceTimersByTime(300);

      // The timeout should have been cleared, so no additional status changes should occur
      // (no broadcast of 'running' status after process already exited and cleaned up)
      const statusChangeCalls = window.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'terminal:status-change' && call[2] === 'running'
      );
      expect(statusChangeCalls).toHaveLength(0);
    });
  });

  describe('write', () => {
    it('should write data to PTY process', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.write('term-1', 'ls -la\n');

      expect(spawnedPtys[0].write).toHaveBeenCalledWith('ls -la\n');
    });

    it('should not throw when PTY write reports EAGAIN', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      const error = new Error('write EAGAIN') as NodeJS.ErrnoException;
      error.code = 'EAGAIN';
      spawnedPtys[0].write.mockImplementationOnce(() => {
        throw error;
      });

      expect(() => ptyService.write('term-1', 'ls -la\n')).not.toThrow();
    });

    it('should not throw when pending command write reports EAGAIN', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', 'claude');
        const error = new Error('write EAGAIN') as NodeJS.ErrnoException;
        error.code = 'EAGAIN';
        spawnedPtys[0].write.mockImplementationOnce(() => {
          throw error;
        });

        spawnedPtys[0]._simulateData('PS> ');

        expect(() => vi.advanceTimersByTime(150)).not.toThrow();
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('should retry pending command write after EAGAIN', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { isWslMode } = await import('../../../src/main/lib/wsl');
        vi.mocked(isWslMode).mockReturnValue(true);
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', 'claude');
        const error = new Error('write EAGAIN') as NodeJS.ErrnoException;
        error.code = 'EAGAIN';
        spawnedPtys[0].write.mockImplementationOnce(() => {
          throw error;
        });

        spawnedPtys[0]._simulateData('$ ');
        vi.advanceTimersByTime(150);
        expect(spawnedPtys[0].write).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(100);
        expect(spawnedPtys[0].write).toHaveBeenCalledTimes(2);
        expect(spawnedPtys[0].write).toHaveBeenLastCalledWith(
          expect.stringMatching(/ && claude\r$/)
        );
      } finally {
        const { isWslMode } = await import('../../../src/main/lib/wsl');
        vi.mocked(isWslMode).mockReturnValue(false);
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('should silently ignore write for nonexistent terminal', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      // Should not throw - matches behavior of resize()
      expect(() => ptyService.write('nonexistent', 'data')).not.toThrow();
    });

    it('should re-enable isig via stty when Ctrl-C is sent (Unix)', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', null);
        mockExecFile.mockClear();

        ptyService.write('term-1', '\x03');

        expect(mockExecFile).toHaveBeenCalledWith(
          'stty',
          ['-f', spawnedPtys[0].ptsName, 'isig'],
          expect.any(Function)
        );
        expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x03');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should forward Ctrl-C to an SSH terminal without changing its local PTY signal mode', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn(
          'term-1',
          '/home/user',
          'ssh remote-host',
          [],
          undefined,
          undefined,
          0,
          undefined,
          undefined,
          'wait-for-marker'
        );
        mockExecFile.mockClear();

        ptyService.write('term-1', '\x03');

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x03');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should notify abort listeners when Ctrl-C is forwarded to an SSH terminal', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const abortListener = vi.fn();
      ptyService.onAbort(abortListener);
      ptyService.spawn(
        'term-1',
        '/home/user',
        'ssh remote-host',
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'wait-for-marker'
      );

      ptyService.write('term-1', '\x03');

      expect(abortListener).toHaveBeenCalledWith('term-1', false);
    });

    it('notifies abort listeners of an Escape over a working title only once the title stops spinning', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const abortListener = vi.fn();
      ptyService.onAbort(abortListener);
      ptyService.spawn('term-1', '/home/user');

      spawnedPtys[0]._simulateData('\x1b]0;◐ Running tests\x07');
      ptyService.write('term-1', '\x1b');
      expect(abortListener).not.toHaveBeenCalled();
      spawnedPtys[0]._simulateData('\x1b]0;✳ Running tests\x07');
      vi.advanceTimersByTime(2);
      expect(abortListener).toHaveBeenCalledWith('term-1', true);
    });

    it('notifies answer-key listeners of Enter, Ctrl-C, Ctrl-D and Escape, not other input', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const answerKeyListener = vi.fn();
      ptyService.onAnswerKey(answerKeyListener);
      ptyService.spawn('term-1', '/home/user');

      ptyService.write('term-1', 'y');
      ptyService.write('term-1', '\x1b[B');
      expect(answerKeyListener).not.toHaveBeenCalled();

      for (const key of ['\r', '\x03', '\x04', '\x1b']) ptyService.write('term-1', key);
      expect(answerKeyListener).toHaveBeenCalledTimes(4);
      expect(answerKeyListener).toHaveBeenCalledWith('term-1');
    });

    it('should not call stty on Windows', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', null);
        mockExecFile.mockClear();

        ptyService.write('term-1', '\x03');

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(spawnedPtys[0].write).toHaveBeenCalledWith('\x03');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should not call stty for normal input', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', null);
        mockExecFile.mockClear();

        ptyService.write('term-1', 'ls -la\n');

        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  describe('resize', () => {
    it('should resize PTY process', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.resize('term-1', 200, 50);

      expect(spawnedPtys[0].resize).toHaveBeenCalledWith(200, 50);
    });

    it('should apply the latest pre-spawn resize when the terminal is created', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.resize('term-1', 100, 40);
      ptyService.resize('term-1', 90, 35);
      ptyService.spawn('term-1', '/home/user', null);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp'],
        expect.objectContaining({ cols: 90, rows: 35 })
      );
    });

    it('should discard a pending resize when the terminal is released', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.resize('term-1', 100, 40);
      ptyService.releaseTerminal('term-1');
      ptyService.spawn('term-1', '/home/user', null);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp'],
        expect.objectContaining({ cols: 120, rows: 30 })
      );
    });

    it('gives an attached remote presentation exclusive size authority', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.resize('term-1', 140, 40);
      const authority = ptyService.acquireSizeAuthority('term-1', 48, 18);
      ptyService.resize('term-1', 160, 50);
      authority.resize(52, 20);

      expect(spawnedPtys[0].resize.mock.calls).toEqual([
        [140, 40],
        [48, 18],
        [52, 20],
      ]);

      authority.release();
      expect(spawnedPtys[0].resize).toHaveBeenLastCalledWith(160, 50);
    });

    it('lets the desktop take the size back until the remote presentation resizes again', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.resize('term-1', 140, 40);
      const onDesktopSize = vi.fn();
      const authority = ptyService.acquireSizeAuthority('term-1', 48, 18);
      authority.onDesktopSize(onDesktopSize);
      ptyService.claimLocalSize('term-1');
      ptyService.claimLocalSize('term-1');
      ptyService.resize('term-1', 160, 50);
      authority.resize(52, 20);
      ptyService.resize('term-1', 170, 50);

      expect(spawnedPtys[0].resize.mock.calls).toEqual([
        [140, 40],
        [48, 18],
        [140, 40],
        [160, 50],
        [52, 20],
      ]);
      expect(onDesktopSize.mock.calls).toEqual([
        [140, 40],
        [160, 50],
      ]);

      authority.release();
      expect(spawnedPtys[0].resize).toHaveBeenLastCalledWith(170, 50);
    });

    it("reports the desktop's size while the desktop has the size back", async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.resize('term-1', 140, 40);
      const authority = ptyService.acquireSizeAuthority('term-1', 48, 18);
      expect(authority.desktopSize()).toBeNull();
      ptyService.claimLocalSize('term-1');
      expect(authority.desktopSize()).toEqual({ cols: 140, rows: 40 });
      ptyService.resize('term-1', 160, 50);
      expect(authority.desktopSize()).toEqual({ cols: 160, rows: 50 });
      authority.resize(52, 20);
      expect(authority.desktopSize()).toBeNull();
      ptyService.claimLocalSize('term-1');
      authority.release();
      expect(authority.desktopSize()).toBeNull();
    });

    it('spawns at the desktop size while the desktop holds a lease it took back', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.resize('term-1', 140, 40);
      ptyService.acquireSizeAuthority('term-1', 48, 18);
      ptyService.claimLocalSize('term-1');
      ptyService.spawn('term-1', '/home/user', null);

      expect(mockSpawn).toHaveBeenLastCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp'],
        expect.objectContaining({ cols: 140, rows: 40 })
      );
    });

    it('restores the desktop size after a lease taken before the PTY spawned', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      const authority = ptyService.acquireSizeAuthority('term-1', 48, 18);
      ptyService.spawn('term-1', '/home/user', null, [], undefined, undefined, 0, 140, 40);

      expect(mockSpawn).toHaveBeenLastCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp'],
        expect.objectContaining({ cols: 48, rows: 18 })
      );
      authority.release();
      expect(spawnedPtys[0].resize).toHaveBeenLastCalledWith(140, 40);
    });

    it('ignores stale authority handles after release', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      const authority = ptyService.acquireSizeAuthority('term-1', 48, 18);
      authority.release();
      spawnedPtys[0].resize.mockClear();

      authority.resize(10, 5);
      expect(spawnedPtys[0].resize).not.toHaveBeenCalled();
    });
  });

  describe('terminal presentation', () => {
    it('does not track terminal output until remote presentation tracking is enabled', async () => {
      vi.useRealTimers();
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      spawnedPtys[0]._simulateData('before remote start');
      expect(() => ptyService.getPresentationSnapshot('term-1')).toThrow(
        'terminal presentation not found'
      );

      ptyService.enableTerminalPresentationTracking();
      const snapshot = await ptyService.getPresentationSnapshot('term-1');
      expect(snapshot.buffer).toContain('before remote start');

      ptyService.disableTerminalPresentationTracking();
      expect(() => ptyService.getPresentationSnapshot('term-1')).toThrow(
        'terminal presentation not found'
      );
    });

    it('parses output only for terminals a remote device has read', async () => {
      vi.useRealTimers();
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const { TerminalPresentation } = await import('../../../src/main/lib/terminal-presentation');
      const write = vi.spyOn(TerminalPresentation.prototype, 'write');

      ptyService.enableTerminalPresentationTracking();
      ptyService.spawn('term-1', '/home/user', null);
      ptyService.spawn('term-2', '/home/user', null);
      spawnedPtys[0]._simulateData('one');
      spawnedPtys[1]._simulateData('two');
      expect(write).not.toHaveBeenCalled();

      const snapshot = await ptyService.getPresentationSnapshot('term-1');
      expect(snapshot.buffer).toContain('one');
      write.mockClear();
      spawnedPtys[0]._simulateData('more');
      spawnedPtys[1]._simulateData('more');
      expect(write).toHaveBeenCalledOnce();
    });

    it('returns parsed screen state with dimensions, sequence, and generation', async () => {
      vi.useRealTimers();
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.enableTerminalPresentationTracking();
      ptyService.spawn('term-1', '/home/user', null, [], undefined, undefined, 4);
      spawnedPtys[0]._simulateData('\x1b[32mready\x1b[0m');

      const snapshot = await ptyService.getPresentationSnapshot('term-1');
      expect(snapshot).toMatchObject({
        cols: 120,
        rows: 30,
        generation: 1,
        seq: 5,
      });
      expect(snapshot.buffer).toContain('ready');
    });

    it('presents a terminal without a running PTY as an empty screen', async () => {
      vi.useRealTimers();
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.enableTerminalPresentationTracking();
      ptyService.resize('term-1', 100, 40);
      await expect(ptyService.getPresentationSnapshot('term-1')).resolves.toEqual({
        buffer: '',
        cols: 100,
        rows: 40,
        generation: 0,
        seq: 0,
      });

      ptyService.spawn('term-1', '/home/user', null);
      spawnedPtys[0]._simulateData('done');
      spawnedPtys[0]._simulateExit(0);
      expect(ptyService.getPresentationMetadata('term-1')).toEqual({
        cols: 100,
        rows: 40,
        generation: 1,
        seq: 1,
      });
    });

    it('announces every new PTY generation, including the first, to reset listeners', async () => {
      vi.useRealTimers();
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const generations: number[] = [];
      ptyService.onReset((terminalId) =>
        generations.push(ptyService.getPresentationMetadata(terminalId).generation)
      );

      ptyService.enableTerminalPresentationTracking();
      ptyService.spawn('term-1', '/home/user', null);
      ptyService.restart('term-1', '/home/user', null);

      expect(generations).toEqual([1, 2]);
    });

    it('advances the presentation generation when a PTY restarts', async () => {
      vi.useRealTimers();
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.enableTerminalPresentationTracking();
      ptyService.spawn('term-1', '/home/user', null);
      const first = await ptyService.getPresentationSnapshot('term-1');
      ptyService.restart('term-1', '/home/user', null);
      const second = await ptyService.getPresentationSnapshot('term-1');

      expect(second.generation).toBe(first.generation + 1);
      expect(second.buffer).not.toContain('ready');
    });
  });

  describe('kill', () => {
    it('should kill PTY process and clean up state', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      vi.advanceTimersByTime(300);

      ptyService.kill('term-1');

      expect(spawnedPtys[0].kill).toHaveBeenCalled();
      expect(ptyService.getStatus('term-1')).toBeNull();
    });

    it('should broadcast stopped status before killing', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);
      window.webContents.send.mockClear();

      ptyService.kill('term-1');

      expect(window.webContents.send).toHaveBeenCalledWith(
        'terminal:status-change',
        'term-1',
        'stopped'
      );
    });

    it('should silently ignore kill for nonexistent terminal', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      // Should not throw
      expect(() => ptyService.kill('nonexistent')).not.toThrow();
    });
  });

  describe('getStatus', () => {
    it('should return null for nonexistent terminal', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      expect(ptyService.getStatus('nonexistent')).toBeNull();
    });
  });

  describe('isRunning', () => {
    it('should return true when terminal is running', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      vi.advanceTimersByTime(300); // Transition to running

      expect(ptyService.isRunning('term-1')).toBe(true);
    });

    it('should return false when terminal is starting', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      expect(ptyService.isRunning('term-1')).toBe(false);
    });

    it('should return false for nonexistent terminal', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      expect(ptyService.isRunning('nonexistent')).toBe(false);
    });
  });

  describe('killAll', () => {
    it('should not report shutdown-triggered exits as user terminal exits', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window = createMockBrowserWindow({ id: 1 });
      mockWindows.push(window);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      const killPromise = ptyService.killAll();

      spawnedPtys[0]._simulateExit(0);
      await killPromise;

      expect(window.webContents.send).not.toHaveBeenCalledWith(
        'terminal:exit',
        'term-1',
        0,
        undefined
      );
    });

    it('should stay pending until every PTY emits its exit event', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);
      ptyService.spawn('term-2', '/home/user', null);
      ptyService.spawn('term-3', '/home/user', null);

      const killPromise = ptyService.killAll();
      let resolved = false;
      void killPromise.then(() => {
        resolved = true;
      });

      expect(spawnedPtys[0].kill).toHaveBeenCalled();
      expect(spawnedPtys[1].kill).toHaveBeenCalled();
      expect(spawnedPtys[2].kill).toHaveBeenCalled();

      // Microtask flush: if killAll() returned an already-resolved promise,
      // `resolved` would flip true here.
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);

      spawnedPtys[0]._simulateExit(0);
      spawnedPtys[1]._simulateExit(0);
      await Promise.resolve();
      await Promise.resolve();
      // Still waiting on term-3.
      expect(resolved).toBe(false);

      spawnedPtys[2]._simulateExit(0);
      await killPromise;
      expect(resolved).toBe(true);

      expect(ptyService.getStatus('term-1')).toBeNull();
      expect(ptyService.getStatus('term-2')).toBeNull();
      expect(ptyService.getStatus('term-3')).toBeNull();
    });

    // SIGKILL escalation is POSIX-only — node-pty's Windows backend rejects
    // signal arguments and the default kill() already force-terminates.
    it.skipIf(process.platform === 'win32')(
      'should escalate SIGHUP to SIGKILL after the grace period',
      async () => {
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', null);

        const killPromise = ptyService.killAll();
        let resolved = false;
        void killPromise.then(() => {
          resolved = true;
        });

        // Initial SIGHUP fires synchronously (default signal — pty.kill() called
        // with no args).
        expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1);
        expect(spawnedPtys[0].kill).toHaveBeenLastCalledWith();

        // Just before the SIGHUP→SIGKILL boundary: still pending, still no escalation.
        await vi.advanceTimersByTimeAsync(999);
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1);

        // Cross the boundary — SIGKILL is sent, but we keep waiting for the exit.
        await vi.advanceTimersByTimeAsync(1);
        expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(2);
        expect(spawnedPtys[0].kill).toHaveBeenLastCalledWith('SIGKILL');
        await Promise.resolve();
        expect(resolved).toBe(false);

        // SIGKILL's own grace window expires — give up and resolve.
        await vi.advanceTimersByTimeAsync(250);
        await killPromise;
        expect(resolved).toBe(true);
      }
    );

    it.skipIf(process.platform === 'win32')(
      'should resolve immediately when the exit arrives during SIGKILL grace',
      async () => {
        const { ptyService } = await import('../../../src/main/services/pty.service');

        ptyService.spawn('term-1', '/home/user', null);

        const killPromise = ptyService.killAll();
        let resolved = false;
        void killPromise.then(() => {
          resolved = true;
        });

        // Cross the SIGHUP grace boundary so SIGKILL escalation fires.
        await vi.advanceTimersByTimeAsync(1000);
        expect(spawnedPtys[0].kill).toHaveBeenLastCalledWith('SIGKILL');
        await Promise.resolve();
        expect(resolved).toBe(false);

        // The kernel finally delivers the exit during the SIGKILL grace window.
        spawnedPtys[0]._simulateExit(137);
        await killPromise;
        expect(resolved).toBe(true);
      }
    );

    it('should release the shutdown waiter even if the process entry was already removed', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      const killPromise = ptyService.killAll();
      let resolved = false;
      void killPromise.then(() => {
        resolved = true;
      });

      // Simulate a concurrent user-facing kill(terminalId) racing the shutdown:
      // it removes the process entry synchronously, so the later native exit
      // event finds nothing in `this.processes`.
      ptyService.kill('term-1');

      await Promise.resolve();
      expect(resolved).toBe(false);

      spawnedPtys[0]._simulateExit(0);
      await killPromise;
      expect(resolved).toBe(true);
    });
  });

  describe('flow control', () => {
    // Each paused PTY's program is running unless a test ends it.
    let kill: MockInstance<typeof process.kill>;
    beforeEach(() => {
      kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    });
    afterEach(() => kill.mockRestore());

    async function spawnReportedTerminal() {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      mockWindows.push(createMockBrowserWindow({ id: 42 }));
      ptyService.spawn('term-1', '/home/user', null, [], 42);
      const pty = spawnedPtys[0];
      const output = (chars: number): void => {
        pty._simulateData('x'.repeat(chars));
        vi.advanceTimersByTime(2);
      };
      output(10);
      ptyService.acknowledgeOutput('term-1', 10);
      return { ptyService, pty, output };
    }

    it('pauses the PTY while the renderer is behind and resumes once it catches up', async () => {
      const { ptyService, pty, output } = await spawnReportedTerminal();

      output(300_000);
      output(300_000);
      expect(pty.pause).toHaveBeenCalledOnce();

      ptyService.acknowledgeOutput('term-1', 400_000);
      expect(pty.resume).not.toHaveBeenCalled();
      ptyService.acknowledgeOutput('term-1', 100_000);
      expect(pty.resume).toHaveBeenCalledOnce();
    });

    it('never pauses a terminal no renderer has attached to or reported on', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      ptyService.spawn('term-1', '/home/user', null);
      // Remote Control reads snapshots too; that is not a renderer attaching.
      ptyService.getBuffer('term-1');

      spawnedPtys[0]._simulateData('x'.repeat(1_000_000));
      vi.advanceTimersByTime(2);

      expect(spawnedPtys[0].pause).not.toHaveBeenCalled();
    });

    it('pauses from the start once a renderer attaches, counting only output sent since', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      ptyService.spawn('term-1', '/home/user', null);
      const pty = spawnedPtys[0];
      pty._simulateData('x'.repeat(400_000));
      vi.advanceTimersByTime(2);

      ptyService.attachRenderer('term-1');
      pty._simulateData('x'.repeat(400_000));
      vi.advanceTimersByTime(2);
      expect(pty.pause).not.toHaveBeenCalled();
      pty._simulateData('x'.repeat(200_000));
      vi.advanceTimersByTime(2);
      expect(pty.pause).toHaveBeenCalledOnce();

      // Another renderer attaching (a window move or reload) starts the count over.
      ptyService.attachRenderer('term-1');
      expect(pty.resume).toHaveBeenCalledOnce();
    });

    it('resumes when the renderer stops reporting, but waits while it makes progress', async () => {
      const { ptyService, pty, output } = await spawnReportedTerminal();
      output(600_000);

      vi.advanceTimersByTime(1500);
      ptyService.acknowledgeOutput('term-1', 100_000);
      vi.advanceTimersByTime(1500);
      expect(pty.resume).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(pty.resume).toHaveBeenCalledOnce();

      output(600_000);
      expect(pty.pause).toHaveBeenCalledOnce();
    });

    it("resumes once the program exits, before node-pty drops the output it hasn't read", async () => {
      const { pty, output } = await spawnReportedTerminal();
      output(600_000);
      vi.advanceTimersByTime(100);
      expect(pty.resume).not.toHaveBeenCalled();

      // node-pty destroys the socket 200 ms after the program exits, read or not.
      kill.mockImplementation((pid) => {
        if (pid === pty.pid) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        return true;
      });
      vi.advanceTimersByTime(100);
      expect(pty.resume).toHaveBeenCalledOnce();
    });

    it('stops pausing once shutdown starts, so programs can finish writing as they exit', async () => {
      const { ptyService, pty, output } = await spawnReportedTerminal();
      output(600_000);
      expect(pty.pause).toHaveBeenCalledOnce();

      const killed = ptyService.killAll();
      expect(pty.resume).toHaveBeenCalledOnce();
      // A report the renderer sent before shutdown doesn't turn pausing back on.
      ptyService.acknowledgeOutput('term-1', 10);
      output(600_000);
      expect(pty.pause).toHaveBeenCalledOnce();

      pty._simulateExit(0);
      await killed;
    });

    it('never pauses on Windows, where closing a paused ConPTY can hang the main process', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        vi.resetModules();
        const { pty, output } = await spawnReportedTerminal();
        output(600_000);
        expect(pty.pause).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });
  });

  describe('setTerminalWindow', () => {
    it('should update window association for terminal', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const window1 = createMockBrowserWindow({ id: 1 });
      const window2 = createMockBrowserWindow({ id: 2 });
      mockWindows.push(window1, window2);

      ptyService.spawn('term-1', '/home/user', null, [], 1);
      vi.advanceTimersByTime(300);
      window1.webContents.send.mockClear();
      window2.webContents.send.mockClear();

      // Move terminal to window 2
      ptyService.setTerminalWindow('term-1', 2);

      // Simulate data - should now go to window 2
      spawnedPtys[0]._simulateData('new window data');

      expect(window2.webContents.send).toHaveBeenCalledWith(
        'pty:data',
        'term-1',
        'new window data',
        1
      );
      // Window 1 should not receive data
      expect(window1.webContents.send).not.toHaveBeenCalledWith(
        'pty:data',
        'term-1',
        'new window data',
        1
      );
    });
  });

  describe('edge cases', () => {
    it('should skip sending to destroyed windows when broadcasting', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');
      const destroyedWindow = createMockBrowserWindow({ id: 1 });
      destroyedWindow.isDestroyed = vi.fn(() => true);
      const aliveWindow = createMockBrowserWindow({ id: 2 });
      mockWindows.push(destroyedWindow, aliveWindow);

      ptyService.spawn('term-1', '/home/user', null);
      vi.advanceTimersByTime(300); // Triggers status broadcast

      // Only alive window should receive status change
      expect(aliveWindow.webContents.send).toHaveBeenCalledWith(
        'terminal:status-change',
        'term-1',
        'running'
      );
      expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should handle output after process marked for status transition', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', null);

      // Process is in "starting" state, simulate output before timeout
      spawnedPtys[0]._simulateData('early output');

      // Should transition to running on first output
      expect(ptyService.getStatus('term-1')).toBe('running');

      // Advance timer past the 300ms mark - should not change status again
      vi.advanceTimersByTime(300);
      expect(ptyService.getStatus('term-1')).toBe('running');
    });

    it('should not write command to stdin on non-Windows (uses spawn args)', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // On non-Windows, command is passed via -ilc spawn args, not stdin
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript("'claude'", 'claude')],
        expect.objectContaining({})
      );

      // No stdin write should happen, even after output and timeouts
      spawnedPtys[0]._simulateData('$ ');
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('should not write command via fallback if process exits naturally before shell output', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // Process exits before any shell output
      spawnedPtys[0]._simulateExit(0);

      // Fallback fires — command should not be written since process already exited
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('should not write command via fallback if process was killed', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // Kill the terminal before any output or fallback
      ptyService.kill('term-1');

      // Fallback fires — should not write since process is gone
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('should pass command via spawn args even if startup timeout fires first', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // Command is in spawn args, not stdin
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-ilc', expectedActionStartupScript("'claude'", 'claude')],
        expect.objectContaining({})
      );

      // Startup timeout fires (300ms), transitioning status to 'running'
      vi.advanceTimersByTime(300);
      expect(ptyService.getStatus('term-1')).toBe('running');

      // No stdin write should happen
      spawnedPtys[0]._simulateData('$ ');
      vi.advanceTimersByTime(150);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('should not write to stdin with multiple outputs on non-Windows', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // Multiple outputs — no stdin write since command is in spawn args
      spawnedPtys[0]._simulateData('$ ');
      spawnedPtys[0]._simulateData('more output');
      vi.advanceTimersByTime(150);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('should not write to stdin during output bursts on non-Windows', async () => {
      const { ptyService } = await import('../../../src/main/services/pty.service');

      ptyService.spawn('term-1', '/home/user', 'claude');

      // Simulate shell initialization output burst — command is in spawn args
      spawnedPtys[0]._simulateData('loading .zshrc');
      vi.advanceTimersByTime(50);
      spawnedPtys[0]._simulateData('setting up prompt');
      vi.advanceTimersByTime(50);
      spawnedPtys[0]._simulateData('% ');
      vi.advanceTimersByTime(150);

      // No stdin write — command was passed via -ilc
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });
  });
});
