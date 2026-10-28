import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app, ipcMain } from 'electron';

// Mock logger before importing anything else
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock dependencies before importing the service
vi.mock('perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => ({
    enable: vi.fn(),
    disable: vi.fn(),
    percentile: vi.fn(() => 10_000_000), // 10ms in ns
    max: vi.fn(() => 50_000_000), // 50ms in ns
    reset: vi.fn(),
  })),
}));

vi.mock('v8', () => ({
  getHeapStatistics: vi.fn(() => ({
    heap_size_limit: 2 * 1024 * 1024 * 1024, // 2GB
  })),
}));

vi.mock('electron', () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
    isPackaged: vi.fn(() => false),
    getAppPath: vi.fn(() => '/mock/app/path'),
    getPath: vi.fn(() => '/mock/path'),
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
  },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/pty.service', () => ({
  ptyService: {
    getDiagnostics: vi.fn(() => ({
      processCount: 2,
      totalOutputBytes: 1024,
      outputBufferBytes: 0,
    })),
  },
}));

vi.mock('../../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: {
    getDiagnostics: vi.fn(() => ({
      watcherCount: 1,
      activeWatcherCount: 1,
    })),
  },
}));

vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: {
    getDiagnostics: vi.fn(() => ({
      workspaceCount: 2,
      openWorkspaceCount: 1,
    })),
  },
}));

vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    getAllWindowIds: vi.fn(() => [1, 2]),
    getWindowId: vi.fn(() => 'window-1'),
  },
}));

vi.mock('../../../src/main/services/background-process.service', () => ({
  backgroundProcessService: {
    getProcessCount: vi.fn(() => 0),
    getWorkspaceCount: vi.fn(() => 0),
  },
}));

// Mock process.memoryUsage and process.uptime
const originalMemoryUsage = process.memoryUsage;
const originalUptime = process.uptime;
const originalEnv = process.env;

describe('DiagnosticsService', () => {
  let diagnosticsService: any;
  let shouldEnableDiagnostics: typeof import('../../../src/main/services/diagnostics.service').shouldEnableDiagnostics;

  beforeEach(async () => {
    vi.useFakeTimers();
    process.memoryUsage = vi.fn(() => ({
      rss: 100 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 60 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    })) as any;
    process.uptime = vi.fn(() => 123);

    // Reset env — diagnostics are opt-in, so enable by default for tests
    process.env = { ...originalEnv };
    delete process.env.KOMLA_DIAGNOSTICS_INTERVAL_MS;
    process.env.NODE_ENV = 'development';
    process.env.KOMLA_DIAGNOSTICS = '1';

    const mod = await import('../../../src/main/services/diagnostics.service');
    diagnosticsService = mod.diagnosticsService;
    shouldEnableDiagnostics = mod.shouldEnableDiagnostics;

    const { windowService } = await import('../../../src/main/services/window.service');
    vi.mocked(windowService.getWindowId).mockReturnValue('window-1');

    // Mock app.getAppMetrics
    vi.mocked(app.getAppMetrics).mockReturnValue([
      { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 50000 } },
      { pid: 101, type: 'Tab', cpu: { percentCPUUsage: 10 }, memory: { workingSetSize: 100000 } },
    ] as any);
    vi.mocked(app.isPackaged).mockReturnValue(false);

    // Reset logger mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    diagnosticsService.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.memoryUsage = originalMemoryUsage;
    process.uptime = originalUptime;
    process.env = originalEnv;
  });

  it('should not start without explicit opt-in', () => {
    delete process.env.KOMLA_DIAGNOSTICS;
    diagnosticsService.start();
    expect(diagnosticsService['intervalId']).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Diagnostics disabled (set KOMLA_DIAGNOSTICS=1 to force-enable)'
    );
  });

  it('should start and log snapshot when explicitly enabled', () => {
    process.env.KOMLA_DIAGNOSTICS = '1';
    const logSpy = vi.spyOn(diagnosticsService['eventLoopDelay'], 'enable');
    diagnosticsService.start();
    expect(logSpy).toHaveBeenCalled();
    expect(diagnosticsService['intervalId']).not.toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith('Performance snapshot', expect.any(Object));
  });

  it('should not start if already running', () => {
    diagnosticsService.start();
    const intervalId = diagnosticsService['intervalId'];
    diagnosticsService.start();
    expect(diagnosticsService['intervalId']).toBe(intervalId);
  });

  it('should not start if disabled in non-dev packaged app', () => {
    delete process.env.KOMLA_DIAGNOSTICS;
    process.env.NODE_ENV = 'production';
    vi.mocked(app.isPackaged).mockReturnValue(true);

    diagnosticsService.start();
    expect(diagnosticsService['intervalId']).toBeNull();
  });

  it('should not enable diagnostics without explicit opt-in', () => {
    expect(shouldEnableDiagnostics(undefined)).toBe(false);
    expect(shouldEnableDiagnostics('')).toBe(false);
  });

  it.each(['0', 'false', 'off', 'no', 'False', ' OFF ', ' No '])(
    'should treat KOMLA_DIAGNOSTICS=%s as disabled',
    (value) => {
      expect(shouldEnableDiagnostics(value)).toBe(false);
    }
  );

  it.each(['1', 'true', 'yes', 'on'])('should treat KOMLA_DIAGNOSTICS=%s as enabled', (value) => {
    expect(shouldEnableDiagnostics(value)).toBe(true);
  });

  it('should start if KOMLA_DIAGNOSTICS=1 even in production', () => {
    process.env.NODE_ENV = 'production';
    vi.mocked(app.isPackaged).mockReturnValue(true);
    process.env.KOMLA_DIAGNOSTICS = '1';

    diagnosticsService.start();
    expect(diagnosticsService['intervalId']).not.toBeNull();
  });

  it('should log snapshots at intervals', () => {
    diagnosticsService.start();
    vi.clearAllMocks();

    // Advance time by 30s (default interval)
    vi.advanceTimersByTime(30_000);

    expect(process.memoryUsage).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Performance snapshot',
      expect.objectContaining({
        reason: 'interval',
      })
    );
  });

  it('should use custom interval from env', () => {
    process.env.KOMLA_DIAGNOSTICS_INTERVAL_MS = '10000';
    diagnosticsService.start();
    vi.clearAllMocks();

    vi.advanceTimersByTime(10_000);
    expect(process.memoryUsage).toHaveBeenCalled();
  });

  it('should enforce minimum interval', () => {
    process.env.KOMLA_DIAGNOSTICS_INTERVAL_MS = '1000'; // Less than 5s minimum
    diagnosticsService.start();
    vi.clearAllMocks();

    vi.advanceTimersByTime(1000);
    expect(process.memoryUsage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(29_000); // Reaching 30s total (default)
    expect(process.memoryUsage).toHaveBeenCalled();
  });

  it('should detect memory growth and log warnings', async () => {
    diagnosticsService.start(); // First snapshot

    // Increase memory for next snapshot
    vi.mocked(process.memoryUsage).mockReturnValue({
      rss: 400 * 1024 * 1024, // 300MB growth (warn threshold 250MB)
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 60 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    } as any);

    vi.advanceTimersByTime(30_000);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Potential memory growth detected',
      expect.objectContaining({
        rssGrowthMb: 300,
      })
    );
  });

  it('should warn when event loop lag is high', () => {
    // Mock high event loop lag (ns to ms)
    vi.mocked(diagnosticsService['eventLoopDelay'].percentile).mockReturnValue(300_000_000); // 300ms

    diagnosticsService.start();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Event loop lag is high',
      expect.objectContaining({
        p95Ms: 300,
      })
    );
  });

  it('should warn when PTY buffers are large', async () => {
    const { ptyService } = await import('../../../src/main/services/pty.service');

    vi.mocked(ptyService.getDiagnostics).mockReturnValue({
      processCount: 1,
      totalOutputBytes: 100 * 1024 * 1024,
      outputBufferBytes: 21 * 1024 * 1024, // > 20MB threshold
    } as any);

    diagnosticsService.start();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'PTY output buffers are large',
      expect.objectContaining({
        outputBufferMb: 21,
      })
    );
  });

  it('should stop and clear intervals and remove IPC listener', () => {
    diagnosticsService.start();
    expect(diagnosticsService['intervalId']).not.toBeNull();

    diagnosticsService.stop();
    expect(diagnosticsService['intervalId']).toBeNull();
    expect(diagnosticsService['lastMainMemory']).toBeNull();
    expect(diagnosticsService['rendererStatsByWebContents'].size).toBe(0);
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'diagnostics:renderer-stats',
      expect.any(Function)
    );
  });

  it('should aggregate renderer stats across live windows in snapshot', async () => {
    diagnosticsService.start();
    const { windowService } = await import('../../../src/main/services/window.service');
    vi.mocked(windowService.getWindowId).mockImplementation((webContentsId: number) =>
      webContentsId === 10 || webContentsId === 20 ? `window-${webContentsId}` : undefined
    );

    diagnosticsService['rendererStatsHandler']({ sender: { id: 10 } } as any, {
      terminalCacheSize: 5,
      parkedTerminalCount: 3,
      activeWebglContexts: 2,
      timestamp: Date.now(),
    });
    diagnosticsService['rendererStatsHandler']({ sender: { id: 20 } } as any, {
      terminalCacheSize: 7,
      parkedTerminalCount: 1,
      activeWebglContexts: 4,
      timestamp: Date.now() - 2_000,
    });

    vi.clearAllMocks();
    vi.advanceTimersByTime(30_000);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Performance snapshot',
      expect.objectContaining({
        renderer: expect.objectContaining({
          windowCount: 2,
          terminalCacheSize: 12,
          parkedTerminalCount: 4,
          activeWebglContexts: 6,
          staleSec: 32,
        }),
      })
    );
  });

  it('should exclude renderer stats from closed windows', async () => {
    diagnosticsService.start();
    const { windowService } = await import('../../../src/main/services/window.service');
    vi.mocked(windowService.getWindowId).mockImplementation((webContentsId: number) =>
      webContentsId === 10 ? 'window-10' : undefined
    );

    diagnosticsService['rendererStatsHandler']({ sender: { id: 10 } } as any, {
      terminalCacheSize: 5,
      parkedTerminalCount: 3,
      activeWebglContexts: 2,
      timestamp: Date.now(),
    });
    diagnosticsService['rendererStatsHandler']({ sender: { id: 20 } } as any, {
      terminalCacheSize: 7,
      parkedTerminalCount: 1,
      activeWebglContexts: 4,
      timestamp: Date.now(),
    });

    vi.clearAllMocks();
    vi.advanceTimersByTime(30_000);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Performance snapshot',
      expect.objectContaining({
        renderer: expect.objectContaining({
          windowCount: 1,
          terminalCacheSize: 5,
          parkedTerminalCount: 3,
          activeWebglContexts: 2,
        }),
      })
    );
  });

  it('should include null renderer stats when no report received', () => {
    diagnosticsService.start();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Performance snapshot',
      expect.objectContaining({
        renderer: null,
      })
    );
  });

  it('should ignore malformed renderer stats', () => {
    diagnosticsService.start();

    // Simulate the IPC handler receiving malformed data
    const handler = diagnosticsService['rendererStatsHandler'];

    // Missing fields
    handler({} as any, { terminalCacheSize: 'not a number' } as any);
    expect(diagnosticsService['rendererStatsByWebContents'].size).toBe(0);

    // Null payload
    handler({} as any, null as any);
    expect(diagnosticsService['rendererStatsByWebContents'].size).toBe(0);

    // Valid payload should be accepted
    const validStats = {
      terminalCacheSize: 5,
      parkedTerminalCount: 3,
      activeWebglContexts: 2,
      timestamp: Date.now(),
    };
    handler({ sender: { id: 10 } } as any, validStats);
    expect(diagnosticsService['rendererStatsByWebContents'].get(10)).toEqual(validStats);
  });
});
