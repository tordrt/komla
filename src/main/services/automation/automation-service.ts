/**
 * Automations: agent tasks Komla starts in a new workspace on a schedule.
 *
 * Local automations live in this installation's store and run from a timer
 * while Komla is open. SSH automations live on their host, where a crontab
 * line runs the host's `komla automation tick` each minute, so they run while
 * no device is connected and every device that connects sees the same ones.
 * Both decide what is due with `dueAutomationOccurrence`.
 */
import {
  automationScheduleError,
  dueAutomationOccurrence,
} from '../../../shared/lib/automation-schedule';
import { createLogger } from '../../lib/logger';

import type { AutomationHostClient, AutomationHostListing } from './host-client';
import type { LocalAutomationState } from './local-store';
import type {
  Automation,
  AutomationHostReads,
  AutomationRun,
  AutomationTarget,
  AutomationTargetSnapshot,
  HostAutomation,
  SaveAutomationParams,
} from '../../../shared/types/automation';

const logger = createLogger('AutomationService');

const MINUTE_MS = 60_000;
/** How long a host's listing counts as current before showing the list reads it again. */
const HOST_REFRESH_INTERVAL_MS = 10_000;
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 32_000;

export type SshAutomation = Automation & { target: { kind: 'ssh'; hostId: string } };

export interface LocalAutomationStorage {
  read(): LocalAutomationState;
  saveAutomation(automation: Automation): Promise<void>;
  deleteAutomation(id: string): Promise<void>;
  addRun(run: AutomationRun): Promise<void>;
}

export interface AutomationRunRequest {
  trigger: AutomationRun['trigger'];
  scheduledFor?: number;
  startedAt: number;
}

export interface AutomationServiceDependencies {
  now(): number;
  newId(): string;
  local: LocalAutomationStorage;
  hosts: AutomationHostClient;
  /** The SSH hosts whose automations the list shows. */
  hostIds(): string[];
  /** The SSH hosts this installation has workspaces on, which it connects to anyway. */
  hostIdsInUse(): string[];
  /** Creates the workspace for a local automation's run. */
  launchLocal(
    automation: Automation,
    request: AutomationRunRequest
  ): Promise<{ workspaceId: string; branch?: string }>;
  /** What an SSH automation's host stores, with the workspace and agent commands compiled. */
  compileForHost(automation: SshAutomation): Promise<HostAutomation>;
  /** This installation's ids for what a host automation names, when it has them. */
  resolveHostAutomations(
    hostId: string,
    automations: HostAutomation[]
  ): Promise<Array<{ projectId?: string; presetId?: string; launchModeId?: string }>>;
  /** The Git settings of a project here that its SSH automations have compiled in. */
  projectGitSettings(projectId: string): { baseBranch?: string; branchPrefix?: string };
  /** Tells windows the automations changed. */
  changed(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameTarget(a: AutomationTarget, b: AutomationTarget): boolean {
  return a.kind === b.kind && (a.kind === 'local' || a.hostId === (b as typeof a).hostId);
}

function lastScheduledFor(runs: AutomationRun[] | undefined): number | undefined {
  let latest: number | undefined;
  for (const run of runs ?? []) {
    if (run.trigger === 'schedule' && run.scheduledFor !== undefined) {
      latest = Math.max(latest ?? run.scheduledFor, run.scheduledFor);
    }
  }
  return latest;
}

export class AutomationService {
  /** The last listing read from each host, shown again while it can't be reached. */
  private readonly hostListings = new Map<string, AutomationHostListing>();
  private readonly hostReads = new Map<
    string,
    { promise?: Promise<void>; readAt?: number; error?: string }
  >();
  /** Counts changes started and finished on each host, so a read that overlapped one is dropped. */
  private readonly hostChanges = new Map<string, number>();
  /** Per host, the projects whose automations wait to be saved with their Git settings. */
  private readonly retargets = new Map<
    string,
    { projectIds: Set<string>; running?: Promise<void> }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking: Promise<void> | undefined;

  constructor(private readonly dependencies: AutomationServiceDependencies) {}

  /**
   * Every target's automations. Hosts show what was last read from them, and
   * are read again in the background when that is stale; windows hear when
   * the read finishes. `in-use` reads only the hosts with workspaces here.
   */
  async list(
    options: { readHosts?: AutomationHostReads } = {}
  ): Promise<AutomationTargetSnapshot[]> {
    const local = this.dependencies.local.read();
    const hostIds = this.dependencies.hostIds();
    const toRead =
      options.readHosts === 'in-use' ? new Set(this.dependencies.hostIdsInUse()) : undefined;
    for (const hostId of hostIds) {
      if (toRead && !toRead.has(hostId)) continue;
      const read = this.hostReads.get(hostId);
      if (
        !read?.promise &&
        this.dependencies.now() - (read?.readAt ?? 0) > HOST_REFRESH_INTERVAL_MS
      ) {
        void this.refreshHost(hostId);
      }
    }
    const hosts = await Promise.all(hostIds.map((hostId) => this.hostSnapshot(hostId)));
    return [
      {
        target: { kind: 'local' },
        automations: [...local.automations].sort((a, b) => a.createdAt - b.createdAt),
        runs: local.runs,
        scheduler: { available: true },
        ...(local.error ? { error: local.error } : {}),
      },
      ...hosts,
    ];
  }

  /**
   * Every target's automations, with the given hosts (else every host) read
   * again first, for callers that change them. After waitMs, hosts still being
   * read show what was last read from them, as loading.
   */
  async listCurrent(
    options: { hostIds?: readonly string[]; waitMs?: number } = {}
  ): Promise<AutomationTargetSnapshot[]> {
    const reads = Promise.all(
      (options.hostIds ?? this.dependencies.hostIds()).map((hostId) => this.refreshHost(hostId))
    );
    if (options.waitMs === undefined) {
      await reads;
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        reads,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.list();
  }

  async save(params: SaveAutomationParams): Promise<Automation> {
    const name = params.name.trim();
    const prompt = params.prompt.trim();
    if (!name) throw new Error('Give the automation a name.');
    if (name.length > MAX_NAME_LENGTH) throw new Error('The name is too long.');
    if (!prompt) throw new Error('Write the prompt the agent starts with.');
    if (prompt.length > MAX_PROMPT_LENGTH) throw new Error('The prompt is too long.');
    const scheduleError = automationScheduleError(params.schedule);
    if (scheduleError) throw new Error(scheduleError);

    const previousTarget = params.previousTarget ?? params.target;
    const existing = params.id ? this.find(previousTarget, params.id) : undefined;
    const now = this.dependencies.now();
    const automation: Automation = {
      id: params.id ?? this.dependencies.newId(),
      name,
      prompt,
      projectId: params.projectId,
      target: params.target,
      ...(params.presetId ? { presetId: params.presetId } : {}),
      ...(params.launchModeId ? { launchModeId: params.launchModeId } : {}),
      ...(params.startBranch?.trim() ? { startBranch: params.startBranch.trim() } : {}),
      schedule: { cron: params.schedule.cron.trim(), timeZone: params.schedule.timeZone },
      enabled: params.enabled,
      missedRunGraceMinutes: params.missedRunGraceMinutes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.write(automation);
    if (params.id && !sameTarget(previousTarget, params.target)) {
      try {
        await this.remove(previousTarget, params.id);
      } catch (error) {
        // Left in both places, it would run twice, so it stays where it was.
        const reason = errorMessage(error);
        const undone = await this.remove(params.target, automation.id).then(
          () => true,
          () => false
        );
        this.dependencies.changed();
        throw new Error(
          undone
            ? `It wasn't moved: ${reason}`
            : `It was saved in its new place but is still in the old one, where it keeps running: ${reason}`
        );
      }
    }
    this.dependencies.changed();
    return automation;
  }

  /**
   * Saves a project's SSH automations again with its target branch and branch prefix, after they
   * changed here: hosts have them compiled in. A host that can't be read now is tried again the
   * next time it is, while Komla runs.
   */
  async retargetProject(projectId: string): Promise<void> {
    await Promise.all(
      this.dependencies.hostIds().map((hostId) => {
        const retarget = this.retargets.get(hostId) ?? { projectIds: new Set<string>() };
        retarget.projectIds.add(projectId);
        this.retargets.set(hostId, retarget);
        return this.retargetHost(hostId);
      })
    );
  }

  /** Saves a host's automations of the projects waiting for it, one save of a host at a time. */
  private retargetHost(hostId: string): Promise<void> {
    const retarget = this.retargets.get(hostId);
    if (!retarget) return Promise.resolve();
    retarget.running = (retarget.running ?? Promise.resolve()).then(async () => {
      const projectIds = [...retarget.projectIds];
      if (projectIds.length === 0) return;
      retarget.projectIds.clear();
      const changed = await this.saveRetargeted(hostId, projectIds).catch((error: unknown) => {
        logger.warn('Could not save automations with their project’s Git settings', {
          hostId,
          error: errorMessage(error),
        });
        return true;
      });
      if (changed) this.dependencies.changed();
    });
    return retarget.running;
  }

  /** Whether any automation was saved; projects wait for the next read of an unread host. */
  private async saveRetargeted(hostId: string, projectIds: string[]): Promise<boolean> {
    // Saving an old listing again could undo edits made since, so only what was just read.
    await this.refreshHost(hostId);
    const read = this.hostReads.get(hostId);
    if (!read?.readAt || read.error) {
      for (const projectId of projectIds) this.retargets.get(hostId)?.projectIds.add(projectId);
      return false;
    }
    const automations = this.hostListings.get(hostId)?.automations ?? [];
    const resolved = await this.dependencies.resolveHostAutomations(hostId, automations);
    let saved = false;
    for (const [index, automation] of automations.entries()) {
      const projectId = resolved[index]?.projectId;
      if (!projectId || !projectIds.includes(projectId)) continue;
      // Read now, so a later change that waited for this save isn't undone by an earlier one.
      const settings = this.dependencies.projectGitSettings(projectId);
      if (
        automation.project.baseBranch === settings.baseBranch &&
        automation.project.branchPrefix === settings.branchPrefix
      ) {
        continue;
      }
      const {
        baseBranch: _baseBranch,
        branchPrefix: _branchPrefix,
        ...project
      } = automation.project;
      const retargeted = {
        ...automation,
        project: {
          ...project,
          ...(settings.baseBranch ? { baseBranch: settings.baseBranch } : {}),
          ...(settings.branchPrefix ? { branchPrefix: settings.branchPrefix } : {}),
        },
      };
      const scheduler = await this.changeHost(hostId, () =>
        this.dependencies.hosts.save(hostId, retargeted)
      );
      this.rememberHostAutomation(hostId, retargeted);
      this.rememberScheduler(hostId, scheduler);
      saved = true;
    }
    return saved;
  }

  /** Turns an automation on or off without its project or agent being on this installation. */
  async setEnabled(target: AutomationTarget, id: string, enabled: boolean): Promise<void> {
    const now = this.dependencies.now();
    if (target.kind === 'local') {
      const automation = this.findLocal(id);
      await this.dependencies.local.saveAutomation({ ...automation, enabled, updatedAt: now });
    } else {
      // The host changes its own copy, so this device's older one can't undo edits made elsewhere.
      const { hostId } = target;
      const { automation, scheduler } = await this.changeHost(hostId, () =>
        this.dependencies.hosts.setEnabled(hostId, id, enabled)
      );
      this.rememberHostAutomation(hostId, automation);
      this.rememberScheduler(hostId, scheduler);
    }
    this.dependencies.changed();
  }

  async delete(target: AutomationTarget, id: string): Promise<void> {
    await this.remove(target, id);
    this.dependencies.changed();
  }

  private async remove(target: AutomationTarget, id: string): Promise<void> {
    if (target.kind === 'local') {
      await this.dependencies.local.deleteAutomation(id);
      return;
    }
    const { hostId } = target;
    const scheduler = await this.changeHost(hostId, () =>
      this.dependencies.hosts.delete(hostId, id)
    );
    const listing = this.hostListings.get(hostId);
    if (listing) {
      const runs = { ...listing.runs };
      delete runs[id];
      this.hostListings.set(hostId, {
        automations: listing.automations.filter((automation) => automation.id !== id),
        runs,
        scheduler,
      });
    }
  }

  async runNow(target: AutomationTarget, id: string): Promise<AutomationRun> {
    if (target.kind === 'local') {
      return this.startLocalRun(this.findLocal(id), 'manual');
    }
    const { hostId } = target;
    const run = await this.changeHost(hostId, () => this.dependencies.hosts.run(hostId, id));
    const listing = this.hostListings.get(target.hostId);
    if (listing) {
      listing.runs[id] = [run, ...(listing.runs[id] ?? [])];
    }
    this.dependencies.changed();
    return run;
  }

  /** Starts the timer that runs local automations, checking once a minute. */
  start(): void {
    if (this.timer) return;
    const schedule = () => {
      const now = this.dependencies.now();
      // Just after each minute starts, when scheduled times fall.
      this.timer = setTimeout(
        () => {
          void this.tick();
          schedule();
        },
        MINUTE_MS - (now % MINUTE_MS) + 1_000
      );
    };
    void this.tick();
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Starts what is due now, e.g. after the computer wakes. */
  tick(): Promise<void> {
    this.ticking ??= this.runDue().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runDue(): Promise<void> {
    for (const { id } of this.dependencies.local.read().automations) {
      // An earlier run in this tick may have taken a while, so check each one as it is now.
      const { automations, runs } = this.dependencies.local.read();
      const automation = automations.find((candidate) => candidate.id === id);
      if (!automation) continue;
      try {
        const due = dueAutomationOccurrence(
          automation,
          lastScheduledFor(runs[automation.id]),
          this.dependencies.now()
        );
        if (due.kind === 'run') {
          await this.startLocalRun(automation, 'schedule', due.scheduledFor);
        } else if (due.kind === 'missed') {
          await this.dependencies.local.addRun({
            id: this.dependencies.newId(),
            automationId: automation.id,
            trigger: 'schedule',
            scheduledFor: due.scheduledFor,
            startedAt: this.dependencies.now(),
            status: 'skipped',
            message: 'Missed: Komla was closed or the computer was asleep for longer than allowed.',
          });
          this.dependencies.changed();
        }
      } catch (error) {
        logger.warn('Could not check an automation', {
          automationId: automation.id,
          error: errorMessage(error),
        });
      }
    }
  }

  private async startLocalRun(
    automation: Automation,
    trigger: AutomationRun['trigger'],
    scheduledFor?: number
  ): Promise<AutomationRun> {
    const startedAt = this.dependencies.now();
    const base = {
      id: this.dependencies.newId(),
      automationId: automation.id,
      trigger,
      ...(scheduledFor !== undefined ? { scheduledFor } : {}),
      startedAt,
    };
    let run: AutomationRun;
    try {
      const started = await this.dependencies.launchLocal(automation, {
        trigger,
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        startedAt,
      });
      run = {
        ...base,
        status: 'started',
        workspaceId: started.workspaceId,
        ...(started.branch ? { branch: started.branch } : {}),
      };
    } catch (error) {
      run = { ...base, status: 'failed', message: errorMessage(error) };
    }
    await this.dependencies.local.addRun(run);
    this.dependencies.changed();
    return run;
  }

  private async write(automation: Automation): Promise<void> {
    if (automation.target.kind === 'local') {
      await this.dependencies.local.saveAutomation(automation);
      return;
    }
    const hostId = automation.target.hostId;
    const compiled = await this.dependencies.compileForHost(automation as SshAutomation);
    const scheduler = await this.changeHost(hostId, () =>
      this.dependencies.hosts.save(hostId, compiled)
    );
    this.rememberHostAutomation(hostId, compiled);
    this.rememberScheduler(hostId, scheduler);
  }

  private find(target: AutomationTarget, id: string): { createdAt: number } | undefined {
    return target.kind === 'local'
      ? this.dependencies.local.read().automations.find((automation) => automation.id === id)
      : this.hostListings
          .get(target.hostId)
          ?.automations.find((automation) => automation.id === id);
  }

  private findLocal(id: string): Automation {
    const automation = this.dependencies.local
      .read()
      .automations.find((candidate) => candidate.id === id);
    if (!automation) throw new Error('That automation no longer exists.');
    return automation;
  }

  /** Runs a change on a host, counted before and after so reads that overlap it are dropped. */
  private async changeHost<T>(hostId: string, change: () => Promise<T>): Promise<T> {
    const count = () => this.hostChanges.set(hostId, (this.hostChanges.get(hostId) ?? 0) + 1);
    count();
    try {
      return await change();
    } finally {
      count();
    }
  }

  private rememberHostAutomation(hostId: string, automation: HostAutomation): void {
    const listing = this.hostListings.get(hostId) ?? {
      automations: [],
      runs: {},
      scheduler: { available: true },
    };
    this.hostListings.set(hostId, {
      ...listing,
      automations: [
        ...listing.automations.filter((candidate) => candidate.id !== automation.id),
        automation,
      ],
    });
  }

  private rememberScheduler(hostId: string, scheduler: AutomationHostListing['scheduler']): void {
    const listing = this.hostListings.get(hostId);
    if (listing) this.hostListings.set(hostId, { ...listing, scheduler });
  }

  /** Reads a host's automations again, once at a time per host. */
  refreshHost(hostId: string): Promise<void> {
    const read = this.hostReads.get(hostId) ?? {};
    if (read.promise) return read.promise;
    const changes = this.hostChanges.get(hostId) ?? 0;
    const promise = this.dependencies.hosts
      .list(hostId)
      .then(
        (listing) => {
          if ((this.hostChanges.get(hostId) ?? 0) !== changes) {
            // It may predate a change made here meanwhile; the next list reads again.
            this.hostReads.set(hostId, {});
            return;
          }
          this.hostListings.set(hostId, listing);
          this.hostReads.set(hostId, { readAt: this.dependencies.now() });
          if (this.retargets.get(hostId)?.projectIds.size) void this.retargetHost(hostId);
        },
        (error: unknown) => {
          this.hostReads.set(hostId, {
            readAt: this.dependencies.now(),
            error: errorMessage(error),
          });
        }
      )
      .finally(() => this.dependencies.changed());
    this.hostReads.set(hostId, { ...read, promise });
    return promise;
  }

  private async hostSnapshot(hostId: string): Promise<AutomationTargetSnapshot> {
    const target: AutomationTarget = { kind: 'ssh', hostId };
    const read = this.hostReads.get(hostId);
    const listing = this.hostListings.get(hostId);
    const hostAutomations = [...(listing?.automations ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt
    );
    const resolved = await this.dependencies
      .resolveHostAutomations(hostId, hostAutomations)
      .catch(() => hostAutomations.map(() => ({})));
    return {
      target,
      automations: hostAutomations.map((automation, index) => ({
        id: automation.id,
        name: automation.name,
        prompt: automation.prompt,
        ...resolved[index],
        ...(automation.startBranch ? { startBranch: automation.startBranch } : {}),
        ...(automation.project.projectName ? { projectName: automation.project.projectName } : {}),
        target,
        agentName: automation.launch.agentName,
        schedule: automation.schedule,
        enabled: automation.enabled,
        missedRunGraceMinutes: automation.missedRunGraceMinutes,
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
      })),
      runs: listing?.runs ?? {},
      scheduler: listing?.scheduler ?? { available: true },
      ...(read?.promise ? { loading: true } : {}),
      ...(read?.error && !read.promise ? { error: read.error } : {}),
    };
  }
}
