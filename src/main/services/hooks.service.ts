import { homedir } from 'os';
import { join } from 'path';

import { z } from 'zod';

import { HOOK_EVENTS, type HookEventDetails } from '../../shared/types/hooks';
import { STATUS_ITEM_ID_PATTERN } from '../../shared/types/status-items';
import { hasWorkspaceFiles } from '../../shared/types/workspace';
import { onHookEvent } from '../lib/hook-events';
import { createLogger } from '../lib/logger';
import { parseSettingsFile, readSettingsFile } from '../lib/settings-file';

import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';
import {
  canRunWorkspaceCommands,
  runLocalCommand,
  runWorkspaceCommand,
  workspaceProjectKeys,
  WorkspaceCommandError,
} from './workspace-command';
import { workspaceService } from './workspace.service';

import type { Workspace } from '../../shared/types/workspace';

const logger = createLogger('HooksService');

const MAX_HOOKS = 50;
const HOOKS_VERSION = 1;
const DEFAULT_CONTENT = JSON.stringify({ _version: HOOKS_VERSION, hooks: [] }, null, 2);
const MAX_FAILURE_MESSAGE = 300;
/** An agent's last answer can be long; an environment variable that large fails to start. */
const MAX_AGENT_MESSAGE = 4000;
/** How often Komla looks for interval hooks that are due. */
export const INTERVAL_TICK_MS = 5000;
/** Interval runs at once, so a hook for every workspace doesn't start them all together. */
export const MAX_PARALLEL_INTERVAL_RUNS = 4;

// The descriptions are what `komla settings schema hooks` tells agents.
const hookSchema = z
  .object({
    id: z
      .string()
      .regex(
        STATUS_ITEM_ID_PATTERN,
        'ids are up to 40 letters, digits, dots, dashes and underscores'
      )
      .meta({ description: 'Unique in the file.' }),
    event: z.enum(HOOK_EVENTS).meta({
      description:
        "When it runs: `agent.done` when an agent finishes its turn, `agent.needs-input` when it asks for permission or an answer, `agent.error` when it reports an error, `agent.prompt` when a prompt is sent to it, `workspace.created` once a new workspace's terminals have started and it has its name (its setup steps may still be running), `workspace.trashed` when a workspace moves to the Trash, or `interval` on a timer.",
    }),
    command: z.string().trim().min(1).max(16_000).meta({
      description:
        "Runs in the user's shell, which has the `komla` CLI. Its output is discarded, and its own notifications set off no hooks. It gets `KOMLA_EVENT` and `KOMLA_HOOK_ID`; when it runs for a workspace also `KOMLA_WORKSPACE_ID`, `KOMLA_WORKSPACE_NAME`, `KOMLA_BRANCH` and `KOMLA_PROJECT`, and for agent events `KOMLA_TERMINAL_ID`, `KOMLA_AGENT` (such as `claude-code`) and `KOMLA_MESSAGE` (the agent's last answer, what it asks for, or the prompt, up to 4,000 characters), when Komla has them.",
    }),
    intervalSeconds: z.number().int().min(10).max(86_400).optional().meta({
      description:
        "How often an `interval` hook runs; only those take it, and they need it. Komla also runs them when it starts and after hooks.json changes, a few at a time, and doesn't start a run that's still going again.",
    }),
    runOn: z.enum(['workspace', 'local']).optional().meta({
      description:
        "`workspace`, the default, runs it in the workspace's folder or on its SSH host; an `interval` hook then runs in every workspace outside the Trash. `local` runs it on this computer in the home folder: once per interval for an `interval` hook, which then takes no `projects`, or for an event even while the workspace's SSH host is away.",
    }),
    timeoutSeconds: z.number().int().min(1).max(3600).default(60).meta({
      description: 'How long it may run before Komla stops it and everything it started.',
    }),
    projects: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .meta({ description: 'Project names or ids to run it in; every workspace when left out.' }),
  })
  .strict()
  .refine((hook) => (hook.event === 'interval') === (hook.intervalSeconds !== undefined), {
    message: 'interval hooks need intervalSeconds, which only they take',
  })
  .refine((hook) => !(hook.event === 'interval' && hook.runOn === 'local' && hook.projects), {
    message: 'an interval hook that runs on this computer runs once, for no project',
  });

export const hooksFileSchema = z
  .object({
    _version: z.number().int().optional().meta({ description: "The file's format, 1." }),
    hooks: z
      .array(hookSchema)
      .max(MAX_HOOKS)
      .refine((hooks) => new Set(hooks.map((hook) => hook.id)).size === hooks.length, {
        message: 'each hook needs its own id',
      }),
  })
  .strict()
  .meta({
    description:
      "Commands Komla runs when something happens in a workspace, or on a timer. Apply the whole file: keep every hook the user didn't ask to change. While a hook still runs for a terminal, that terminal's next event doesn't start it again; when one fails in a workspace, Komla says why once, until it succeeds there again.",
  });

type Hook = z.infer<typeof hookSchema>;

/** Reads hooks.json; a problem names what is wrong with the file instead. */
export function parseHooksFile(content: string): { hooks: Hook[]; problem?: string } {
  const parsed = parseSettingsFile('hooks.json', content, hooksFileSchema);
  return 'problem' in parsed ? { hooks: [], problem: parsed.problem } : parsed.value;
}

export interface HooksDependencies {
  readFile(): string | undefined;
  getWorkspace(id: string): Workspace | undefined;
  listWorkspaces(): Workspace[];
  /** Names of the workspace's project, its id and name, that `projects` can match. */
  getProjectKeys(workspace: Workspace): string[];
  /** False while the workspace can't run commands, as when its SSH host is not connected. */
  canRun(workspace: Workspace): boolean;
  /** Runs the command where the workspace's files are; rejects with a WorkspaceCommandError. */
  run(
    workspace: Workspace,
    command: string,
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<void>;
  /** Runs the command in the home folder on this computer. */
  runLocal(command: string, env: Record<string, string>, timeoutMs: number): Promise<void>;
  now(): number;
  /** Tells the user, as a hook failing or hooks.json being unreadable. */
  notify(message: string): void;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** What a hook runs for: an event, or its interval coming round. */
type HookRun = Omit<HookEventDetails, 'workspaceId' | 'event'> & { event: Hook['event'] };

/**
 * The commands users and agents define in hooks.json, which Komla runs when something happens in
 * a workspace, such as an agent finishing, or on an interval, in each workspace or once on this
 * computer. A failing hook is reported once until it succeeds again.
 */
export class HooksService {
  private hooks: Hook[] = [];
  private reportedProblem: string | undefined;
  private readonly running = new Set<string>();
  private readonly failing = new Set<string>();
  /** When each interval hook last started, per workspace ('' on this computer). */
  private readonly intervalStarts = new Map<string, number>();
  private intervalRuns = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly dependencies: HooksDependencies) {}

  /** Runs interval hooks as they come due, until stopped. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDueIntervals(), INTERVAL_TICK_MS);
    this.runDueIntervals();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the file again, as after it changed on disk. */
  reload(): void {
    let content: string | undefined;
    try {
      content = this.dependencies.readFile();
    } catch (error) {
      logger.warn('Could not read hooks.json', error);
      content = undefined;
    }
    const parsed = content === undefined ? { hooks: [] } : parseHooksFile(content);
    this.hooks = parsed.hooks;
    if (parsed.problem) logger.warn(parsed.problem);
    if (parsed.problem && parsed.problem !== this.reportedProblem) {
      this.dependencies.notify(`${parsed.problem}. Its hooks don't run until it's fixed.`);
    }
    this.reportedProblem = parsed.problem;
    this.failing.clear();
    // Edited hooks run again soon, as status items do.
    this.intervalStarts.clear();
    if (this.timer) this.runDueIntervals();
  }

  /** Starts the interval hooks whose time has come, a few at a time. */
  runDueIntervals(): void {
    const now = this.dependencies.now();
    for (const hook of this.hooks) {
      if (hook.event !== 'interval' || hook.intervalSeconds === undefined) continue;
      const targets = hook.runOn === 'local' ? [undefined] : this.intervalWorkspaces(hook);
      for (const workspace of targets) {
        if (this.intervalRuns >= MAX_PARALLEL_INTERVAL_RUNS) return;
        const key = `${hook.id}\0${workspace?.id ?? ''}`;
        const last = this.intervalStarts.get(key);
        if (last !== undefined && now - last < hook.intervalSeconds * 1000) continue;
        if (this.running.has(this.runKey(hook, workspace))) continue;
        this.intervalStarts.set(key, now);
        this.intervalRuns++;
        void this.runHook(hook, workspace, { event: 'interval' }).finally(() => {
          this.intervalRuns--;
        });
      }
    }
  }

  private intervalWorkspaces(hook: Hook): Workspace[] {
    return this.dependencies.listWorkspaces().filter(
      (workspace) =>
        workspace.status !== 'trashed' &&
        // Until its folder exists, a run there could only fail.
        hasWorkspaceFiles(workspace) &&
        this.matchesProjects(hook, workspace) &&
        this.dependencies.canRun(workspace)
    );
  }

  private matchesProjects(hook: Hook, workspace: Workspace): boolean {
    if (!hook.projects) return true;
    const keys = this.dependencies.getProjectKeys(workspace);
    return hook.projects.some((name) => keys.includes(name));
  }

  /** Runs the hooks for an event; it resolves once they have all finished. */
  async fire(details: HookEventDetails): Promise<void> {
    const workspace = this.dependencies.getWorkspace(details.workspaceId);
    if (!workspace) return;
    const hooks = this.hooks.filter(
      (hook) =>
        hook.event === details.event &&
        this.matchesProjects(hook, workspace) &&
        // A hook on this computer runs while the workspace's SSH host is away.
        (hook.runOn === 'local' || this.dependencies.canRun(workspace))
    );
    await Promise.all(hooks.map((hook) => this.runHook(hook, workspace, details)));
  }

  private runKey(hook: Hook, workspace: Workspace | undefined, terminalId?: string): string {
    return `${hook.id}\0${workspace?.id ?? ''}\0${terminalId ?? ''}`;
  }

  private async runHook(
    hook: Hook,
    workspace: Workspace | undefined,
    details: HookRun
  ): Promise<void> {
    // An agent that finishes again while its last hook still runs doesn't start a second run.
    const key = this.runKey(hook, workspace, details.terminalId);
    if (this.running.has(key)) {
      logger.debug(`Skipping hook ${hook.id}: its last run for this terminal is still going`);
      return;
    }
    this.running.add(key);
    // A hook can fail in one workspace while it works in another, so each is reported on its own.
    const failingKey = `${hook.id}\0${workspace?.id ?? ''}`;
    const env = this.environment(hook, workspace, details);
    const timeoutMs = hook.timeoutSeconds * 1000;
    try {
      if (hook.runOn === 'local' || !workspace) {
        await this.dependencies.runLocal(hook.command, env, timeoutMs);
      } else {
        await this.dependencies.run(workspace, hook.command, env, timeoutMs);
      }
      this.failing.delete(failingKey);
    } catch (error) {
      const reason =
        error instanceof WorkspaceCommandError && error.timedOut
          ? `timed out after ${hook.timeoutSeconds} seconds`
          : truncate(error instanceof Error ? error.message : String(error), MAX_FAILURE_MESSAGE);
      logger.warn(`Hook ${hook.id} failed on ${details.event}: ${reason}`);
      // An interval hook failing in many workspaces at once is reported once.
      const reported =
        this.failing.has(failingKey) ||
        (hook.event === 'interval' &&
          [...this.failing].some((other) => other.startsWith(`${hook.id}\0`)));
      this.failing.add(failingKey);
      if (!reported) {
        this.dependencies.notify(`Hook "${hook.id}" in hooks.json failed: ${reason}`);
      }
    } finally {
      this.running.delete(key);
    }
  }

  private environment(
    hook: Hook,
    workspace: Workspace | undefined,
    details: HookRun
  ): Record<string, string> {
    // `komla notify` sends a hook's notifications as the hook's, which run no hooks.
    const own = { KOMLA_EVENT: details.event, KOMLA_HOOK_ID: hook.id };
    if (!workspace) return own;
    const project = this.dependencies
      .getProjectKeys(workspace)
      .find((key) => key !== workspace.projectId);
    return {
      ...own,
      KOMLA_WORKSPACE_ID: workspace.id,
      // The title the sidebar shows, as the user or Komla named it.
      KOMLA_WORKSPACE_NAME: workspace.customName || workspace.name,
      ...(workspace.branchName && { KOMLA_BRANCH: workspace.branchName }),
      ...(project && { KOMLA_PROJECT: project }),
      ...(details.terminalId && { KOMLA_TERMINAL_ID: details.terminalId }),
      ...(details.agent && { KOMLA_AGENT: details.agent }),
      ...(details.message && { KOMLA_MESSAGE: truncate(details.message, MAX_AGENT_MESSAGE) }),
    };
  }
}

const hooksPath = join(getKomlaBasePath(), 'settings', 'hooks.json');
let notifyListener: ((message: string) => void) | undefined;

/** Where hook failures are shown; the IPC handlers send them to Komla's windows. */
export function onHookNotice(listener: (message: string) => void): void {
  notifyListener = listener;
}

export const hooksService = new HooksService({
  readFile: () => readSettingsFile(hooksPath, DEFAULT_CONTENT),
  getWorkspace: (id) => workspaceService.get(id),
  listWorkspaces: () => workspaceService.list(),
  getProjectKeys: workspaceProjectKeys,
  canRun: canRunWorkspaceCommands,
  run: async (workspace, command, env, timeoutMs) => {
    await runWorkspaceCommand(workspace, command, { env, timeoutMs });
  },
  runLocal: async (command, env, timeoutMs) => {
    await runLocalCommand(homedir(), command, { env, timeoutMs });
  },
  now: Date.now,
  notify: (message) => notifyListener?.(message),
});

let watcher: FileWatcher | null = null;
let stopFollowingEvents: (() => void) | null = null;

/** Runs hooks on their events, following changes to hooks.json so edits apply without a restart. */
export async function watchHooks(): Promise<void> {
  if (watcher) return;
  hooksService.reload();
  stopFollowingEvents = onHookEvent((details) => void hooksService.fire(details));
  watcher = new FileWatcher(hooksPath, () => hooksService.reload());
  await watcher.start();
}

/** Starts interval hooks; call once the `komla` CLI is installed and Komla is listening for it. */
export function startHookIntervals(): void {
  hooksService.start();
}

export async function stopWatchingHooks(): Promise<void> {
  stopFollowingEvents?.();
  stopFollowingEvents = null;
  hooksService.stop();
  await watcher?.stop();
  watcher = null;
}
