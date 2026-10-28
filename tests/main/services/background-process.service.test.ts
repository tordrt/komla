import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock IPty interface matching node-pty
interface MockIPty {
  pid: number;
  cols: number;
  rows: number;
  process: string;
  handleFlowControl: boolean;
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

const spawnedPtys: MockIPty[] = [];
let pidCounter = 1000;

function createMockIPty(): MockIPty {
  const pty: MockIPty = {
    pid: pidCounter++,
    cols: 120,
    rows: 30,
    process: '/bin/zsh',
    handleFlowControl: false,
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
    resize: vi.fn(),
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
  spawnedPtys.push(pty);
  return pty;
}

const mockPtySpawn = vi.fn(() => createMockIPty());
const mockGetShell = vi.hoisted(() => vi.fn(() => '/bin/zsh'));

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
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

// Mock shell utilities
vi.mock('../../../src/main/lib/shell', () => ({
  getShell: mockGetShell,
  getShellArgs: () => ['-l'],
  buildTerminalEnv: () => ({
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Komla',
  }),
}));

// Mock config.service to avoid transitive dependency on paths -> electron app
vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: () => ({}),
  },
}));

// Mock child_process for Windows taskkill test
const mockChildProcessSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: mockChildProcessSpawn,
}));

describe('BackgroundProcessService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    spawnedPtys.length = 0;
    pidCounter = 1000;
    mockGetShell.mockReturnValue('/bin/zsh');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('spawn', () => {
    it('should spawn a PTY with login shell and terminal env', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      expect(mockPtySpawn).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: '/path/to/cwd',
        })
      );
    });

    it('should write command on first shell output', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // Command not sent immediately
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();

      // After shell emits output (prompt), command is debounced (150ms)
      spawnedPtys[0]._simulateData('$ ');
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);
      expect(spawnedPtys[0].write).toHaveBeenCalledWith('npm run dev; exit $?\r');
    });

    it('runs PowerShell commands from arguments with a numeric success exit code', async () => {
      mockGetShell.mockReturnValue('powershell.exe');
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm install', 'C:\\repo', 'install');

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-l',
          '-Command',
          '$global:LASTEXITCODE = $null; npm install; $komlaSetupSucceeded = $?; $komlaSetupExitCode = $LASTEXITCODE; if ($null -eq $komlaSetupExitCode) { $komlaSetupExitCode = if ($komlaSetupSucceeded) { 0 } else { 1 } }; exit $komlaSetupExitCode',
        ],
        expect.objectContaining({ cwd: 'C:\\repo' })
      );
      spawnedPtys[0]._simulateData('PS C:\\repo> ');
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('types a PowerShell command too long for a Windows command line', async () => {
      mockGetShell.mockReturnValue('powershell.exe');
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');
      const command = `npm run build -- ${'x'.repeat(33_000)}`;

      backgroundProcessService.spawn('workspace-1', command, 'C:\\repo', 'build');

      expect(mockPtySpawn).toHaveBeenCalledWith('powershell.exe', ['-l'], expect.anything());
      spawnedPtys[0]._simulateData('PS C:\\repo> ');
      vi.advanceTimersByTime(150);
      expect(spawnedPtys[0].write).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\$global:LASTEXITCODE = \$null; npm run build -- x+; .*exit \$komlaSetupExitCode\r$/
        )
      );
    });

    it('should track the spawned process', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      expect(backgroundProcessService.getProcessCount()).toBe(1);
      expect(backgroundProcessService.getProcessesForWorkspace('workspace-1')).toHaveLength(1);
    });

    it('should track multiple processes for the same workspace', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-1', 'npm run watch', '/path/to/cwd', 'watcher');

      expect(backgroundProcessService.getProcessCount()).toBe(2);
      expect(backgroundProcessService.getProcessesForWorkspace('workspace-1')).toHaveLength(2);
    });

    it('should track processes for different workspaces separately', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-2', 'npm run dev', '/path/to/cwd', 'dev server');

      expect(backgroundProcessService.getProcessCount()).toBe(2);
      expect(backgroundProcessService.getProcessesForWorkspace('workspace-1')).toHaveLength(1);
      expect(backgroundProcessService.getProcessesForWorkspace('workspace-2')).toHaveLength(1);
    });

    it('should not write command if process exits before shell output', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // Simulate exit before any shell output
      spawnedPtys[0]._simulateExit(1);

      // Even if shell output arrives after exit, command should not be written
      spawnedPtys[0]._simulateData('$ ');

      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('should write command after fallback timeout if shell never emits output', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // No shell output — command not written yet
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();

      // After fallback timeout (5000ms), command should be written
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).toHaveBeenCalledWith('npm run dev; exit $?\r');
    });

    it('should not double-write command when fallback fires after shell output', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // Shell output starts the debounce timer
      spawnedPtys[0]._simulateData('$ ');
      vi.advanceTimersByTime(150); // Settle timer fires, command written
      expect(spawnedPtys[0].write).toHaveBeenCalledTimes(1);

      // Fallback timeout fires later — should not write again
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).toHaveBeenCalledTimes(1);
    });

    it('should clear fallback timeout on natural exit', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // Process exits before shell output or fallback
      spawnedPtys[0]._simulateExit(0);

      // Fallback fires — command should not be written since process already exited
      vi.advanceTimersByTime(5000);
      expect(spawnedPtys[0].write).not.toHaveBeenCalled();
    });

    it('streams output and exit status to lifecycle callbacks', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');
      const onData = vi.fn();
      const onExit = vi.fn();

      backgroundProcessService.spawn('workspace-1', 'npm install', '/path/to/cwd', 'install', {
        onData,
        onExit,
      });
      spawnedPtys[0]._simulateData('installing\r\n');
      spawnedPtys[0]._simulateExit(7, 0);

      expect(onData).toHaveBeenCalledWith('installing\r\n');
      expect(onExit).toHaveBeenCalledWith({ exitCode: 7, signal: 0 });
    });
  });

  describe('auto-removal on natural exit', () => {
    it('should remove process from tracking when it exits naturally', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      expect(backgroundProcessService.getProcessCount()).toBe(1);

      // Simulate natural exit
      spawnedPtys[0]._simulateExit(0);

      expect(backgroundProcessService.getProcessCount()).toBe(0);
    });

    it('should only remove the specific process that exited', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-1', 'npm run watch', '/path/to/cwd', 'watcher');
      expect(backgroundProcessService.getProcessCount()).toBe(2);

      // First process exits
      spawnedPtys[0]._simulateExit(0);

      expect(backgroundProcessService.getProcessCount()).toBe(1);
      expect(backgroundProcessService.getProcessesForWorkspace('workspace-1')).toHaveLength(1);
    });
  });

  describe('killForWorkspace', () => {
    it('should kill all processes for a workspace', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-1', 'npm run watch', '/path/to/cwd', 'watcher');

      backgroundProcessService.killForWorkspace('workspace-1');

      expect(spawnedPtys[0].kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawnedPtys[1].kill).toHaveBeenCalledWith('SIGTERM');
      expect(backgroundProcessService.getProcessCount()).toBe(0);
    });

    it('should not affect processes from other workspaces', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-2', 'npm run dev', '/path/to/cwd', 'dev server');

      backgroundProcessService.killForWorkspace('workspace-1');

      expect(spawnedPtys[0].kill).toHaveBeenCalled();
      expect(spawnedPtys[1].kill).not.toHaveBeenCalled();
      expect(backgroundProcessService.getProcessCount()).toBe(1);
      expect(backgroundProcessService.getProcessesForWorkspace('workspace-2')).toHaveLength(1);
    });

    it('should handle non-existent workspace gracefully', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      // Should not throw
      expect(() => backgroundProcessService.killForWorkspace('non-existent')).not.toThrow();
    });

    it('should send SIGKILL after timeout if process does not exit', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      backgroundProcessService.killForWorkspace('workspace-1');

      expect(spawnedPtys[0].kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past the graceful shutdown timeout (3000ms)
      vi.advanceTimersByTime(3000);

      // Should have attempted SIGKILL since process didn't exit
      expect(spawnedPtys[0].kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should use taskkill on Windows', async () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        const { backgroundProcessService } =
          await import('../../../src/main/services/background-process.service');

        backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
        backgroundProcessService.killForWorkspace('workspace-1');

        expect(mockChildProcessSpawn).toHaveBeenCalledWith(
          'taskkill',
          ['/F', '/T', '/PID', '1000'],
          { stdio: 'ignore' }
        );
      } finally {
        platformSpy.mockRestore();
      }
    });
  });

  describe('killAll', () => {
    it('should kill all tracked processes across all workspaces', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-2', 'npm run dev', '/path/to/cwd', 'dev server');
      backgroundProcessService.spawn('workspace-3', 'npm run dev', '/path/to/cwd', 'dev server');

      backgroundProcessService.killAll();

      expect(spawnedPtys[0].kill).toHaveBeenCalled();
      expect(spawnedPtys[1].kill).toHaveBeenCalled();
      expect(spawnedPtys[2].kill).toHaveBeenCalled();
      expect(backgroundProcessService.getProcessCount()).toBe(0);
    });

    it('should handle empty process list gracefully', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      // Should not throw
      expect(() => backgroundProcessService.killAll()).not.toThrow();
    });
  });

  describe('process without PID', () => {
    it('should handle process without PID gracefully', async () => {
      // Create a process that has no PID (edge case)
      mockPtySpawn.mockImplementationOnce(() => {
        const pty = createMockIPty();
        (pty as MockIPty & { pid: undefined }).pid = undefined as unknown as number;
        return pty;
      });

      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // Should not throw when trying to kill
      expect(() => backgroundProcessService.killForWorkspace('workspace-1')).not.toThrow();
    });
  });

  describe('already exited process', () => {
    it('should not attempt to kill naturally exited processes', async () => {
      const { backgroundProcessService } =
        await import('../../../src/main/services/background-process.service');

      backgroundProcessService.spawn('workspace-1', 'npm run dev', '/path/to/cwd', 'dev server');

      // Process exits naturally
      spawnedPtys[0]._simulateExit(0);

      // Process should have been removed from tracking
      expect(backgroundProcessService.getProcessCount()).toBe(0);

      // killForWorkspace should be a no-op
      spawnedPtys[0].kill.mockClear();
      backgroundProcessService.killForWorkspace('workspace-1');
      expect(spawnedPtys[0].kill).not.toHaveBeenCalled();
    });
  });
});
