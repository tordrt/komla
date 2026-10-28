import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

import { writeFileAtomicSync } from '../lib/atomic-write';
import { getBuildDistribution } from '../lib/build-info';
import { createLogger } from '../lib/logger';
import { telemetryDisabledByEnv } from '../lib/telemetry-env';

import { agentPresetService } from './agent-preset.service';
import { configService } from './config.service';
import { licenseService } from './license.service';
import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { getTelemetryCohortDimensions, telemetryAgentName } from './telemetry-dimensions';
import { workspaceService } from './workspace.service';

import type { UtilityProviderId } from '../../shared/types';
import type { BuildDistribution } from '../lib/build-info';

const logger = createLogger('MetricsCollector');

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const METRICS_FILENAME = 'metrics-today.json';

// --- Types ---

interface SnapshotAccumulator {
  sum: number;
  count: number;
}

export type CounterKey = 'workspacesCreated' | 'agentTabsCreated';

export type UtilityRequestErrorReason =
  | 'timeout'
  | 'aborted'
  | 'upstream_error'
  | 'invalid_response'
  | 'network_error'
  | 'other';

export interface UtilityRequestTelemetryProps {
  provider: UtilityProviderId;
  success: boolean;
  errorReason?: UtilityRequestErrorReason;
}

/** Daily-aggregated utility AI inference counts, grouped by provider and failure reason. */
export interface UtilityRequestMetrics {
  managed: number;
  custom: number;
  failuresByReason: Record<UtilityRequestErrorReason, number>;
}

interface WorkspaceStateSnapshot {
  stoppedWorkspaces: number;
  archivedWorkspaces: number;
  totalWorkspaces: number;
}

interface MetricsState {
  date: string; // YYYY-MM-DD
  runningWorkspaces: SnapshotAccumulator;
  workspaceState?: WorkspaceStateSnapshot; // captured at flush time, persisted for retries
  counters: {
    workspacesCreated: number;
    agentTabsCreated: number;
    actionsUsed: number;
    promptActionsUsed: number;
    terminalActionsUsed: number;
  };
  utilityRequests: UtilityRequestMetrics;
}

export interface UsageSummaryPayload {
  schemaVersion: 2;
  version: string;
  platform: string;
  arch: string;
  distribution: BuildDistribution;
  terminalShell: 'native' | 'powershell' | 'wsl';
  distinctId: string;
  agent: string;
  isLicensed: boolean;
  licenseCohort: 'free' | 'paid_monthly' | 'paid_yearly' | 'paid_lifetime';
  licenseType?: 'monthly' | 'yearly' | 'lifetime';

  // Snapshot (daily average, sampled every 5 min)
  runningWorkspacesAvg: number;

  // Point-in-time workspace state (captured at flush)
  stoppedWorkspaces: number;
  /** Workspaces in the Trash; the telemetry field keeps the name it had before the Trash. */
  archivedWorkspaces: number;
  totalWorkspaces: number;

  // Counters
  workspacesCreated: number;
  agentTabsCreated: number;
  actionsUsed: number;
  promptActionsUsed: number;
  terminalActionsUsed: number;

  // Project adoption
  projectsConfigured: number;
  projectsWithWorkspaceSetup: number;

  // Utility AI inference requests
  utilityRequests: UtilityRequestMetrics;
}

// --- Helpers ---

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

function freshAccumulator(): SnapshotAccumulator {
  return { sum: 0, count: 0 };
}

function freshUtilityRequests(): UtilityRequestMetrics {
  return {
    managed: 0,
    custom: 0,
    failuresByReason: {
      timeout: 0,
      aborted: 0,
      upstream_error: 0,
      invalid_response: 0,
      network_error: 0,
      other: 0,
    },
  };
}

function freshState(): MetricsState {
  return {
    date: todayDateString(),
    runningWorkspaces: freshAccumulator(),
    counters: {
      workspacesCreated: 0,
      agentTabsCreated: 0,
      actionsUsed: 0,
      promptActionsUsed: 0,
      terminalActionsUsed: 0,
    },
    utilityRequests: freshUtilityRequests(),
  };
}

function computeAvg(acc: SnapshotAccumulator): number {
  return acc.count > 0 ? Math.round(acc.sum / acc.count) : 0;
}

function normalizeWorkspaceState(raw: unknown): WorkspaceStateSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const state = raw as Record<string, unknown>;
  return {
    stoppedWorkspaces: typeof state.stoppedWorkspaces === 'number' ? state.stoppedWorkspaces : 0,
    archivedWorkspaces: typeof state.archivedWorkspaces === 'number' ? state.archivedWorkspaces : 0,
    totalWorkspaces: typeof state.totalWorkspaces === 'number' ? state.totalWorkspaces : 0,
  };
}

function normalizeUtilityRequests(raw: unknown): UtilityRequestMetrics {
  const metrics = freshUtilityRequests();
  if (!raw || typeof raw !== 'object') return metrics;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.managed === 'number') metrics.managed = obj.managed;
  if (typeof obj.custom === 'number') metrics.custom = obj.custom;
  const reasons = obj.failuresByReason;
  if (reasons && typeof reasons === 'object') {
    const rawReasons = reasons as Record<string, unknown>;
    for (const key of Object.keys(metrics.failuresByReason) as UtilityRequestErrorReason[]) {
      if (typeof rawReasons[key] === 'number') {
        metrics.failuresByReason[key] = rawReasons[key];
      }
    }
  }
  return metrics;
}

function getTerminalShellTelemetryValue(): UsageSummaryPayload['terminalShell'] {
  if (process.platform !== 'win32') {
    return 'native';
  }

  return configService.get().shellMode === 'wsl' ? 'wsl' : 'powershell';
}

// --- Service ---

class MetricsCollectorService {
  private state: MetricsState | null = freshState();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private metricsFilePath: string;
  private pendingFlush = false; // true after flush() until confirmFlush()

  constructor() {
    this.metricsFilePath = join(getKomlaBasePath(), METRICS_FILENAME);
  }

  start(): void {
    if (!app.isPackaged) {
      logger.debug('Skipping metrics collection in dev mode');
      return;
    }

    // Guard against double-start
    if (this.snapshotTimer) return;

    if (!this.isUsageTelemetryEnabled()) {
      this.discard();
      this.snapshotTimer = setInterval(() => {
        this.takeSnapshot();
        if (!this.pendingFlush) {
          this.persistToDisk();
        }
      }, SNAPSHOT_INTERVAL_MS);
      logger.info('Metrics collector started');
      return;
    }

    this.loadFromDisk();
    this.takeSnapshot(); // initial snapshot
    this.snapshotTimer = setInterval(() => {
      this.takeSnapshot();
      // Don't overwrite the disk file while a flushed report is pending upload —
      // the on-disk state is the retry source if the upload fails.
      if (!this.pendingFlush) {
        this.persistToDisk();
      }
    }, SNAPSHOT_INTERVAL_MS);

    logger.info('Metrics collector started');
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    // Only persist if there's no pending flush — otherwise the disk file
    // still holds the previous period's unsent data that we don't want to overwrite.
    if (!this.pendingFlush) {
      this.persistToDisk();
    }
  }

  // --- Counter API ---

  private isUsageTelemetryEnabled(): boolean {
    return !telemetryDisabledByEnv() && configService.get().usageTelemetryEnabled === true;
  }

  private ensureState(): MetricsState {
    if (!this.state) {
      this.state = freshState();
    }
    return this.state;
  }

  increment(counter: CounterKey): void {
    if (!this.isUsageTelemetryEnabled()) return;
    this.ensureState().counters[counter]++;
  }

  incrementAction(type: 'prompt' | 'command'): void {
    if (!this.isUsageTelemetryEnabled()) return;
    const state = this.ensureState();
    state.counters.actionsUsed++;
    if (type === 'prompt') {
      state.counters.promptActionsUsed++;
    } else {
      state.counters.terminalActionsUsed++;
    }
  }

  recordUtilityRequest(props: UtilityRequestTelemetryProps): void {
    if (!this.isUsageTelemetryEnabled()) return;
    const metrics = this.ensureState().utilityRequests;
    if (props.provider === 'custom') {
      metrics.custom++;
    } else {
      metrics.managed++;
    }
    if (!props.success) {
      metrics.failuresByReason[props.errorReason ?? 'other']++;
    }
  }

  // --- Flush (called by telemetryService at heartbeat time) ---

  async flush(): Promise<UsageSummaryPayload> {
    let snapshotState: MetricsState;

    if (this.pendingFlush) {
      // A previous period's data is still on disk awaiting upload (e.g. app
      // restarted next day before upload succeeded). Load and send that first.
      snapshotState = this.loadStateFromDisk() ?? this.ensureState();
    } else {
      // Normal flush: capture the current in-memory state with a final snapshot.
      snapshotState = this.ensureState();
      this.sampleCurrentValues(snapshotState);
    }

    const activePreset = agentPresetService.getActive();
    const projects = projectService.list();
    const cohortDimensions = getTelemetryCohortDimensions();
    // For pending retries, use the persisted workspace state; otherwise snapshot live values
    const wsState: WorkspaceStateSnapshot =
      snapshotState.workspaceState ??
      (() => {
        const diag = workspaceService.getDiagnostics();
        return {
          stoppedWorkspaces: diag.stoppedWorkspaceCount,
          archivedWorkspaces: diag.trashedWorkspaceCount,
          totalWorkspaces: diag.workspaceCount,
        };
      })();

    // Persist workspace state into the metrics state so it's included in the disk file for retries
    snapshotState.workspaceState = wsState;

    const payload: UsageSummaryPayload = {
      schemaVersion: 2,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      distribution: getBuildDistribution(),
      terminalShell: getTerminalShellTelemetryValue(),
      distinctId: configService.getTelemetryDistinctId(),
      agent: telemetryAgentName(activePreset),
      isLicensed: licenseService.getStatus().isLicensed,
      ...cohortDimensions,

      runningWorkspacesAvg: computeAvg(snapshotState.runningWorkspaces),

      stoppedWorkspaces: wsState.stoppedWorkspaces,
      archivedWorkspaces: wsState.archivedWorkspaces,
      totalWorkspaces: wsState.totalWorkspaces,

      workspacesCreated: snapshotState.counters.workspacesCreated,
      agentTabsCreated: snapshotState.counters.agentTabsCreated,
      actionsUsed: snapshotState.counters.actionsUsed,
      promptActionsUsed: snapshotState.counters.promptActionsUsed,
      terminalActionsUsed: snapshotState.counters.terminalActionsUsed,

      projectsConfigured: projects.length,
      projectsWithWorkspaceSetup: projects.filter(
        (project) => (project.setupSteps?.length ?? 0) > 0
      ).length,

      utilityRequests: snapshotState.utilityRequests,
    };

    // Persist the state (including workspaceState) to disk before resetting,
    // so a failed upload can be retried with the correct workspace snapshot.
    if (!this.pendingFlush) {
      this.persistToDisk();
      this.state = freshState();
    }
    this.pendingFlush = true;

    return payload;
  }

  /** Called after a successful usage upload to clean up the persisted file. */
  confirmFlush(): void {
    this.pendingFlush = false;
    this.deleteDiskFile();
  }

  /** Drop any current or pending usage state without uploading it. */
  discard(): void {
    this.state = null;
    this.pendingFlush = false;
    this.deleteDiskFile();
  }

  // --- Snapshot sampling ---

  private takeSnapshot(): void {
    if (!this.isUsageTelemetryEnabled()) return;

    const state = this.ensureState();
    const today = todayDateString();
    if (state.date !== today) {
      // Day rolled over but we haven't flushed yet — don't reset here.
      // The hourly heartbeat will call flush() which captures the previous
      // day's data into the payload, then resets state for the new day.
      // Sampling into stale-day state would be misleading, so skip.
      return;
    }

    this.sampleCurrentValues(state);
  }

  /** Sample live service values into the given state's accumulators. */
  private sampleCurrentValues(state: MetricsState): void {
    const acc = state.runningWorkspaces;
    acc.sum += workspaceService.getRunningWorkspaceCount();
    acc.count++;
  }

  // --- Disk persistence ---

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.metricsFilePath)) return;

      const raw = JSON.parse(readFileSync(this.metricsFilePath, 'utf-8'));
      if (raw.date !== todayDateString()) {
        // Previous day's data still on disk — mark as pending flush so the
        // next heartbeat sends it before we start fresh. Don't delete it.
        this.pendingFlush = true;
        logger.info('Found previous-day metrics on disk, marking as pending flush');
        return;
      }

      // Restore state, being defensive about missing fields
      const state = this.ensureState();
      state.date = raw.date;

      if (raw.runningWorkspaces) {
        state.runningWorkspaces = {
          sum: raw.runningWorkspaces.sum ?? 0,
          count: raw.runningWorkspaces.count ?? 0,
        };
      }

      state.workspaceState = normalizeWorkspaceState(raw.workspaceState);

      if (raw.counters) {
        for (const key of Object.keys(state.counters) as (keyof MetricsState['counters'])[]) {
          if (typeof raw.counters[key] === 'number') {
            state.counters[key] = raw.counters[key];
          }
        }
      }

      state.utilityRequests = normalizeUtilityRequests(raw.utilityRequests);

      logger.info('Resumed metrics from disk');
    } catch (error) {
      logger.warn('Failed to load metrics from disk, starting fresh', { error: String(error) });
      this.state = freshState();
    }
  }

  /** Load raw state from disk file (for pending flush retry). Returns null on failure. */
  private loadStateFromDisk(): MetricsState | null {
    try {
      if (!existsSync(this.metricsFilePath)) return null;
      const raw = JSON.parse(readFileSync(this.metricsFilePath, 'utf-8'));
      const state = freshState();
      state.date = raw.date ?? state.date;
      if (raw.runningWorkspaces) {
        state.runningWorkspaces = {
          sum: raw.runningWorkspaces.sum ?? 0,
          count: raw.runningWorkspaces.count ?? 0,
        };
      }
      state.workspaceState = normalizeWorkspaceState(raw.workspaceState);
      if (raw.counters) {
        for (const key of Object.keys(state.counters) as (keyof MetricsState['counters'])[]) {
          if (typeof raw.counters[key] === 'number') {
            state.counters[key] = raw.counters[key];
          }
        }
      }
      state.utilityRequests = normalizeUtilityRequests(raw.utilityRequests);
      return state;
    } catch {
      return null;
    }
  }

  private persistToDisk(): void {
    try {
      if (!this.state || !this.isUsageTelemetryEnabled()) return;
      writeFileAtomicSync(this.metricsFilePath, JSON.stringify(this.state));
    } catch (error) {
      logger.warn('Failed to persist metrics to disk', { error: String(error) });
    }
  }

  private deleteDiskFile(): void {
    try {
      if (existsSync(this.metricsFilePath)) {
        unlinkSync(this.metricsFilePath);
      }
    } catch {
      // Ignore — file may already be gone
    }
  }
}

export const metricsCollectorService = new MetricsCollectorService();
