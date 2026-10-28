import { monitorEventLoopDelay } from 'perf_hooks';
import { getHeapStatistics } from 'v8';

import { app, ipcMain } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { createLogger } from '../lib/logger';

import { backgroundProcessService } from './background-process.service';
import { ptyService } from './pty.service';
import { windowService } from './window.service';
import { workspaceService } from './workspace.service';
import { worktreeWatcherService } from './worktree-watcher.service';

const logger = createLogger('DiagnosticsService');

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const RSS_GROWTH_WARN_MB = 250;
const HEAP_GROWTH_WARN_MB = 150;
const EVENT_LOOP_P95_WARN_MS = 250;
const OUTPUT_BUFFER_WARN_MB = 20;

interface MainMemorySample {
  rss: number;
  heapUsed: number;
}

interface RendererStats {
  terminalCacheSize: number;
  parkedTerminalCount: number;
  activeWebglContexts: number;
  timestamp: number;
}

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function toMs(ns: number): number {
  return Math.round((ns / 1_000_000) * 10) / 10;
}

export function shouldEnableDiagnostics(explicitValue?: string): boolean {
  const normalized = (explicitValue || '').trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

class DiagnosticsService {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private lastMainMemory: MainMemorySample | null = null;
  private readonly rendererStatsByWebContents = new Map<number, RendererStats>();
  private readonly rendererStatsHandler = (event: Electron.IpcMainEvent, stats: RendererStats) => {
    if (
      typeof stats?.terminalCacheSize !== 'number' ||
      typeof stats?.parkedTerminalCount !== 'number' ||
      typeof stats?.activeWebglContexts !== 'number' ||
      typeof stats?.timestamp !== 'number'
    ) {
      return;
    }
    this.rendererStatsByWebContents.set(event.sender.id, stats);
  };

  start(): void {
    if (this.intervalId) {
      return;
    }

    if (!this.isEnabled()) {
      logger.debug('Diagnostics disabled (set KOMLA_DIAGNOSTICS=1 to force-enable)');
      return;
    }

    // Listen for renderer-side diagnostics reports
    ipcMain.on(IPC.DIAGNOSTICS_RENDERER_STATS, this.rendererStatsHandler);

    const intervalMs = this.getIntervalMs();
    this.eventLoopDelay.enable();
    this.logSnapshot('startup');

    this.intervalId = setInterval(() => {
      this.logSnapshot('interval');
    }, intervalMs);

    logger.info('Diagnostics started', { intervalMs });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    ipcMain.removeListener(IPC.DIAGNOSTICS_RENDERER_STATS, this.rendererStatsHandler);
    this.eventLoopDelay.disable();
    this.lastMainMemory = null;
    this.rendererStatsByWebContents.clear();
  }

  private isEnabled(): boolean {
    return shouldEnableDiagnostics(process.env.KOMLA_DIAGNOSTICS);
  }

  private getIntervalMs(): number {
    const parsed = Number.parseInt(process.env.KOMLA_DIAGNOSTICS_INTERVAL_MS || '', 10);
    if (Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS) {
      return parsed;
    }

    return DEFAULT_INTERVAL_MS;
  }

  private logSnapshot(reason: 'startup' | 'interval'): void {
    const memory = process.memoryUsage();
    const heapStats = getHeapStatistics();
    const pty = ptyService.getDiagnostics();
    const watcher = worktreeWatcherService.getDiagnostics();
    const workspace = workspaceService.getDiagnostics();

    const loopP95Ms = toMs(this.eventLoopDelay.percentile(95));
    const loopMaxMs = toMs(this.eventLoopDelay.max);
    this.eventLoopDelay.reset();

    const appMetrics = app.getAppMetrics();
    let rendererCount = 0;
    let rendererWorkingSetMb = 0;
    let totalCpuPercent = 0;

    const topProcesses = appMetrics
      .map((metric) => {
        const workingSetKb = metric.memory?.workingSetSize || 0;
        const cpuPercent = metric.cpu?.percentCPUUsage || 0;
        totalCpuPercent += cpuPercent;

        if (metric.type === 'Tab') {
          rendererCount++;
          rendererWorkingSetMb += workingSetKb / 1024;
        }

        return {
          pid: metric.pid,
          type: metric.type,
          cpuPercent: Math.round(cpuPercent * 10) / 10,
          workingSetMb: Math.round((workingSetKb / 1024) * 10) / 10,
        };
      })
      .sort((a, b) => b.workingSetMb - a.workingSetMb)
      .slice(0, 3);

    const liveRendererStats = Array.from(this.rendererStatsByWebContents.entries())
      .filter(([webContentsId]) => windowService.getWindowId(webContentsId) !== undefined)
      .map(([, stats]) => stats);

    const rendererSnapshot =
      liveRendererStats.length > 0
        ? {
            windowCount: liveRendererStats.length,
            terminalCacheSize: liveRendererStats.reduce(
              (total, stats) => total + stats.terminalCacheSize,
              0
            ),
            parkedTerminalCount: liveRendererStats.reduce(
              (total, stats) => total + stats.parkedTerminalCount,
              0
            ),
            activeWebglContexts: liveRendererStats.reduce(
              (total, stats) => total + stats.activeWebglContexts,
              0
            ),
            staleSec: Math.max(
              ...liveRendererStats.map((stats) => Math.round((Date.now() - stats.timestamp) / 1000))
            ),
          }
        : null;

    const snapshot = {
      reason,
      uptimeSec: Math.round(process.uptime()),
      main: {
        rssMb: toMb(memory.rss),
        heapUsedMb: toMb(memory.heapUsed),
        heapTotalMb: toMb(memory.heapTotal),
        heapLimitMb: toMb(heapStats.heap_size_limit),
        externalMb: toMb(memory.external),
        arrayBuffersMb: toMb(memory.arrayBuffers),
      },
      eventLoop: {
        p95Ms: loopP95Ms,
        maxMs: loopMaxMs,
      },
      electron: {
        processCount: appMetrics.length,
        rendererCount,
        rendererWorkingSetMb: Math.round(rendererWorkingSetMb * 10) / 10,
        totalCpuPercent: Math.round(totalCpuPercent * 10) / 10,
        topProcesses,
      },
      appState: {
        windowCount: windowService.getAllWindowIds().length,
        workspaces: workspace,
        pty,
        watchers: watcher,
        backgroundProcesses: {
          processCount: backgroundProcessService.getProcessCount(),
          workspaceCount: backgroundProcessService.getWorkspaceCount(),
        },
      },
      renderer: rendererSnapshot,
    };

    logger.info('Performance snapshot', snapshot);

    if (this.lastMainMemory) {
      const rssGrowthMb = toMb(memory.rss - this.lastMainMemory.rss);
      const heapGrowthMb = toMb(memory.heapUsed - this.lastMainMemory.heapUsed);

      if (rssGrowthMb >= RSS_GROWTH_WARN_MB || heapGrowthMb >= HEAP_GROWTH_WARN_MB) {
        logger.warn('Potential memory growth detected', {
          rssGrowthMb,
          heapGrowthMb,
          currentRssMb: snapshot.main.rssMb,
          currentHeapUsedMb: snapshot.main.heapUsedMb,
        });
      }
    }

    if (snapshot.eventLoop.p95Ms >= EVENT_LOOP_P95_WARN_MS) {
      logger.warn('Event loop lag is high', {
        p95Ms: snapshot.eventLoop.p95Ms,
        maxMs: snapshot.eventLoop.maxMs,
      });
    }

    if (snapshot.appState.pty.outputBufferBytes / (1024 * 1024) >= OUTPUT_BUFFER_WARN_MB) {
      logger.warn('PTY output buffers are large', {
        outputBufferMb: toMb(snapshot.appState.pty.outputBufferBytes),
      });
    }

    this.lastMainMemory = {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
    };
  }
}

export const diagnosticsService = new DiagnosticsService();
