import { join } from 'path';

import { utilityProcess } from 'electron';

import { sidebarPanelBadgeInputSchema } from '../../shared/ipc/schemas/sidebar-panels-ipc.schemas';
import { createLogger } from '../lib/logger';
import { MAIN_BUNDLE_DIR } from '../lib/module-path';

import { KomlaOperationError } from './komla-operation/operation';
import { sidebarPanelBadge, type SidebarPanelStates } from './sidebar-panel-states';

import type { PluginSource } from './plugins.service';
import type { KomlaEvent } from '../../shared/types/komla-events';
import type {
  PluginHostState,
  PluginHostStatus,
  PluginSettingValue,
} from '../../shared/types/plugins';
import type { SidebarPanelOperationResult } from '../../shared/types/sidebar-panels';
import type {
  FromPluginHost,
  PluginHostFailure,
  ToPluginHost,
} from '../workers/plugin-host-protocol';

const logger = createLogger('PluginHost');

/** How much of a plugin's output Settings shows. */
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE = 2000;
/** How long a page waits for the plugin's code to answer a message. */
const MESSAGE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 3000;
/** A plugin that stops this often in a row isn't started again until it changes. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** How many of a plugin's opened pages code that starts again hears of, the latest first. */
const MAX_REPLAYED_OPENS = 10;
const MAX_EXEC_TIMEOUT_MS = 600_000;
/** The most a plugin may post a page at once, as JSON. */
export const MAX_PANEL_POST_BYTES = 512 * 1024;

/** A plugin that runs and has code of its own. */
export interface HostedPlugin {
  source: PluginSource;
  version?: string;
  /** Its `main`, as an absolute path in its folder. */
  main: string;
  /** Its panels' ids in the plugin, which its code may post to and badge. */
  panels: string[];
  /** Changes whenever its files do, so a changed plugin starts again. */
  digest: string;
}

/** A plugin's process, as the host service drives it. */
export interface PluginProcess {
  postMessage(message: ToPluginHost): void;
  onMessage(listener: (message: FromPluginHost) => void): void;
  onExit(listener: (code: number) => void): void;
  /** What the process prints, in pieces as they come. */
  onOutput(listener: (text: string) => void): void;
  kill(): void;
}

export interface PluginHostDependencies {
  fork(plugin: HostedPlugin): PluginProcess;
  /** Reads and runs a Komla Operation for the plugin's code; throws a KomlaOperationError. */
  execute(request: unknown, workspaceId: string | undefined): Promise<unknown>;
  /**
   * Runs a shell command where a workspace's files are, or without one in the plugin's folder on
   * this computer; undefined while the workspace can't run commands.
   */
  exec(
    plugin: HostedPlugin,
    command: string,
    workspaceId: string | undefined,
    timeoutMs: number
  ): Promise<string> | undefined;
  states: Pick<SidebarPanelStates, 'post' | 'setBadge' | 'forget'>;
  /**
   * Where a panel's state belongs in a workspace: the workspace, or '' for every one, as without a
   * workspace or for a panel that runs on this computer.
   */
  panelScope(panelId: string, workspaceId: string | undefined): string;
  onEvent(listener: (event: KomlaEvent) => void): () => void;
  /** A plugin's settings, the user's or their defaults, secrets included. */
  settings(pluginId: string): Record<string, PluginSettingValue>;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface Running {
  plugin: HostedPlugin;
  process: PluginProcess;
  state: PluginHostState;
  error?: string;
  log: string[];
  partial: string;
  restarts: number[];
  stopping: boolean;
  restartTimer?: unknown;
  pending: Map<number, { resolve(result: SidebarPanelOperationResult): void; timer: unknown }>;
  next: number;
  /** The settings changed after `activate` carried them, so the code gets them once ready. */
  settingsStale?: boolean;
}

function failure(error: unknown): PluginHostFailure {
  if (error instanceof KomlaOperationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details && { details: error.details }),
    };
  }
  return {
    code: 'OPERATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Runs the code of the plugins that have a `main`, each in a utility process of its own (ADR
 * 0009), while they're turned on and their files are as the user saw them. It carries their Komla
 * Operations, commands, panel data and badges to Komla, and Komla's events and their panels'
 * messages to them.
 */
export class PluginHostService {
  private readonly running = new Map<string, Running>();
  /** Plugins that stopped too often, by id, with the digest they had. */
  private readonly failed = new Map<string, { digest: string; error: string; log: string[] }>();
  private readonly listeners = new Set<() => void>();
  /**
   * The panel pages windows opened last, by plugin, up to MAX_REPLAYED_OPENS each and without
   * trashed workspaces', so code that starts after one did, as after its
   * files changed, hears of it once it's ready.
   */
  private readonly opened = new Map<string, Map<string, { panel: string; workspace: string }>>();
  private stopEvents: (() => void) | undefined;

  constructor(private readonly dependencies: PluginHostDependencies) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs these plugins' code, starting new and changed ones and stopping the rest. */
  sync(plugins: HostedPlugin[]): void {
    const wanted = new Map(plugins.map((plugin) => [plugin.source.id, plugin]));
    for (const [id, running] of this.running) {
      const plugin = wanted.get(id);
      if (
        !plugin ||
        plugin.digest !== running.plugin.digest ||
        plugin.main !== running.plugin.main
      ) {
        this.stop(id);
      }
    }
    for (const id of this.opened.keys()) {
      if (!wanted.has(id)) this.opened.delete(id);
    }
    for (const [id, failed] of this.failed) {
      if (wanted.get(id)?.digest !== failed.digest) this.failed.delete(id);
    }
    for (const plugin of plugins) {
      if (!this.running.has(plugin.source.id) && !this.failed.has(plugin.source.id)) {
        this.start(plugin);
      }
    }
    if (plugins.length > 0) {
      this.stopEvents ??= this.dependencies.onEvent((event) => this.broadcast(event));
    } else {
      this.stopEvents?.();
      this.stopEvents = undefined;
    }
    this.emit();
  }

  /** Stops every plugin's code, as Komla quits. */
  stopAll(): void {
    // Deleting from a Map while iterating it visits each entry once.
    for (const id of this.running.keys()) this.stop(id);
    this.stopEvents?.();
    this.stopEvents = undefined;
  }

  /** How each plugin's code runs, for Settings, with what it printed last. */
  status(): Record<string, PluginHostStatus> {
    const status: Record<string, PluginHostStatus> = {};
    for (const [id, { error, log }] of this.failed) status[id] = { state: 'failed', error, log };
    for (const [id, running] of this.running) {
      status[id] = {
        state: running.state,
        ...(running.error && { error: running.error }),
        log: [...running.log],
      };
    }
    return status;
  }

  /** Gives a plugin's code its settings again, after the user changed them. */
  settingsChanged(pluginId: string): void {
    const running = this.running.get(pluginId);
    if (!running) return;
    if (running.state !== 'running') {
      running.settingsStale = true;
      return;
    }
    running.process.postMessage({
      type: 'settings',
      settings: this.dependencies.settings(pluginId),
    });
  }

  /** Whether a plugin has code that runs, to answer its panels' messages. */
  hosts(pluginId: string): boolean {
    return this.running.has(pluginId);
  }

  /** Sends what a panel's page sent to its plugin's code, and resolves to the code's answer. */
  sendPanelMessage(
    pluginId: string,
    panel: string,
    workspaceId: string,
    message: unknown,
    activated: boolean
  ): Promise<SidebarPanelOperationResult> {
    const running = this.running.get(pluginId);
    if (!running || running.state !== 'running') {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'PLUGIN_NOT_RUNNING',
          message: running
            ? "The plugin's code is starting."
            : "The plugin has no code running to answer the panel's messages.",
        },
      });
    }
    return new Promise((resolve) => {
      const id = ++running.next;
      const timer = this.dependencies.setTimeout(() => {
        running.pending.delete(id);
        resolve({
          ok: false,
          error: { code: 'TIMED_OUT', message: "The plugin's code didn't answer in time." },
        });
      }, MESSAGE_TIMEOUT_MS);
      running.pending.set(id, { resolve, timer });
      running.process.postMessage({
        type: 'panel-message',
        id,
        panel,
        workspace: workspaceId,
        message,
        activated,
      });
    });
  }

  /** Tells a plugin's code that a window opened one of its panels' pages. */
  panelOpened(pluginId: string, panel: string, workspaceId: string): void {
    // Kept for code that hasn't started yet too, as at Komla's start; sync forgets the opens of
    // plugins without code.
    const opened = this.opened.get(pluginId) ?? new Map();
    const key = `${panel}\0${workspaceId}`;
    // The latest last, so the oldest goes first past the limit.
    opened.delete(key);
    opened.set(key, { panel, workspace: workspaceId });
    if (opened.size > MAX_REPLAYED_OPENS) opened.delete(opened.keys().next().value!);
    this.opened.set(pluginId, opened);
    const running = this.running.get(pluginId);
    if (running?.state === 'running') {
      running.process.postMessage({ type: 'panel-open', panel, workspace: workspaceId });
    }
  }

  /** Starts the plugin's code, keeping `log`, what its code printed before it stopped, if it did. */
  private start(plugin: HostedPlugin, restarts: number[] = [], log: string[] = []): void {
    let process: PluginProcess;
    try {
      process = this.dependencies.fork(plugin);
    } catch (error) {
      const id = plugin.source.id;
      // What code that stopped posted is out of date, as when it keeps stopping.
      this.forgetPanels(plugin);
      this.failed.set(id, {
        digest: plugin.digest,
        error: `Komla couldn't start the plugin's code: ${error instanceof Error ? error.message : String(error)}`,
        log,
      });
      this.emit();
      return;
    }
    const running: Running = {
      plugin,
      process,
      state: 'starting',
      log,
      partial: '',
      restarts,
      stopping: false,
      pending: new Map(),
      next: 0,
    };
    this.running.set(plugin.source.id, running);
    process.onOutput((text) => this.keepOutput(running, text));
    process.onMessage((message) => void this.receive(running, message));
    process.onExit((code) => this.exited(running, code));
    process.postMessage({
      type: 'activate',
      main: plugin.main,
      plugin: {
        id: plugin.source.id,
        name: plugin.source.name,
        dir: plugin.source.dir,
        ...(plugin.version && { version: plugin.version }),
      },
      settings: this.dependencies.settings(plugin.source.id),
    });
  }

  private stop(id: string): void {
    const running = this.running.get(id);
    if (!running) return;
    running.stopping = true;
    this.running.delete(id);
    if (running.restartTimer !== undefined) this.dependencies.clearTimeout(running.restartTimer);
    this.settlePending(running, "The plugin's code stopped.");
    this.forgetPanels(running.plugin);
    try {
      running.process.postMessage({ type: 'deactivate' });
    } catch {
      // It's gone already.
    }
    this.dependencies.setTimeout(() => running.process.kill(), STOP_TIMEOUT_MS);
  }

  private exited(running: Running, code: number): void {
    if (running.stopping || this.running.get(running.plugin.source.id) !== running) return;
    this.settlePending(running, "The plugin's code stopped.");
    // Its last line, without a newline, may say why.
    if (running.partial) this.keepOutput(running, '\n');
    const now = this.dependencies.now();
    const restarts = [...running.restarts.filter((at) => now - at < RESTART_WINDOW_MS), now];
    const id = running.plugin.source.id;
    if (restarts.length > MAX_RESTARTS) {
      this.running.delete(id);
      this.forgetPanels(running.plugin);
      this.failed.set(id, {
        digest: running.plugin.digest,
        error:
          running.error ??
          `Its code stopped ${MAX_RESTARTS + 1} times in a minute (exit code ${code}). Komla starts it again when its files change or it's turned on again.`,
        log: running.log,
      });
      logger.warn(`Plugin ${id}'s code keeps stopping; leaving it off`, { code });
      this.emit();
      return;
    }
    running.state = 'starting';
    running.error = `Its code stopped (exit code ${code}); starting it again.`;
    this.emit();
    // Waits longer after each stop, so a plugin that fails at once doesn't spin.
    running.restartTimer = this.dependencies.setTimeout(
      () => {
        if (this.running.get(id) !== running) return;
        this.running.delete(id);
        this.start(running.plugin, restarts, running.log);
      },
      1000 * 2 ** (restarts.length - 1)
    );
  }

  private settlePending(running: Running, message: string): void {
    for (const [id, waiting] of running.pending) {
      this.dependencies.clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, error: { code: 'PLUGIN_NOT_RUNNING', message } });
      running.pending.delete(id);
    }
  }

  /** Forgets the data the plugin's code posted for its panels, once that code stops. */
  private forgetPanels(plugin: HostedPlugin): void {
    const id = plugin.source.id;
    this.dependencies.states.forget(new Set(plugin.panels.map((panel) => `${id}.${panel}`)));
  }

  private keepOutput(running: Running, text: string): void {
    const lines = (running.partial + text).split(/\r?\n/);
    running.partial = lines.pop() ?? '';
    for (const line of lines) running.log.push(line.slice(0, MAX_LOG_LINE));
    if (running.log.length > MAX_LOG_LINES)
      running.log.splice(0, running.log.length - MAX_LOG_LINES);
    if (lines.length > 0) this.emit();
  }

  private broadcast(event: KomlaEvent): void {
    if (event.type === 'workspace.trashed') {
      for (const opened of this.opened.values()) {
        for (const [key, { workspace }] of opened) {
          if (workspace === event.workspaceId) opened.delete(key);
        }
      }
    }
    for (const running of this.running.values()) {
      if (running.state === 'running') running.process.postMessage({ type: 'event', event });
    }
  }

  private reply(running: Running, id: number, result: Promise<unknown>): void {
    void result.then(
      (value) => running.process.postMessage({ type: 'reply', id, ok: true, result: value }),
      (error: unknown) =>
        running.process.postMessage({ type: 'reply', id, ok: false, error: failure(error) })
    );
  }

  private async receive(running: Running, message: FromPluginHost): Promise<void> {
    if (this.running.get(running.plugin.source.id) !== running) return;
    const { plugin } = running;
    switch (message.type) {
      case 'ready':
        running.state = 'running';
        running.error = undefined;
        if (running.settingsStale) {
          running.settingsStale = false;
          this.settingsChanged(plugin.source.id);
        }
        for (const { panel, workspace } of this.opened.get(plugin.source.id)?.values() ?? []) {
          running.process.postMessage({ type: 'panel-open', panel, workspace });
        }
        this.emit();
        return;
      case 'activate-failed': {
        // It can't do anything, so it doesn't run until it changes or is turned on again.
        const id = plugin.source.id;
        this.stop(id);
        this.failed.set(id, {
          digest: plugin.digest,
          error: `Its activate failed: ${message.message}`,
          log: running.log,
        });
        this.emit();
        return;
      }
      case 'deactivated':
        return;
      case 'call':
        this.reply(
          running,
          message.id,
          // A request Komla can't read throws at once; the code gets that as its answer.
          Promise.resolve().then(() =>
            this.dependencies.execute(message.request, stringOrUndefined(message.workspace))
          )
        );
        return;
      case 'exec': {
        const timeoutMs =
          typeof message.timeoutSeconds === 'number' && message.timeoutSeconds > 0
            ? Math.min(message.timeoutSeconds * 1000, MAX_EXEC_TIMEOUT_MS)
            : DEFAULT_EXEC_TIMEOUT_MS;
        const run = this.dependencies.exec(
          plugin,
          String(message.command),
          stringOrUndefined(message.workspace),
          timeoutMs
        );
        this.reply(
          running,
          message.id,
          run ??
            Promise.reject(
              new KomlaOperationError(
                'WORKSPACE_UNAVAILABLE',
                "The workspace can't run commands right now, as while its SSH host isn't connected.",
                503
              )
            )
        );
        return;
      }
      case 'panel-post':
        this.postPanelData(running, message);
        return;
      case 'panel-badge':
        this.setPanelBadge(running, message);
        return;
      case 'reply': {
        const waiting = running.pending.get(message.id);
        if (!waiting) return;
        running.pending.delete(message.id);
        this.dependencies.clearTimeout(waiting.timer);
        waiting.resolve(
          message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error }
        );
      }
    }
  }

  /** Gives the plugin's panel's page what its code posted, if it fits. */
  private postPanelData(
    running: Running,
    message: Extract<FromPluginHost, { type: 'panel-post' }>
  ): void {
    const panel = this.panelId(running, message.panel);
    if (!panel) return;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(message.data ?? null));
    } catch {
      this.keepOutput(running, `Komla: panel ${message.panel}'s data isn't JSON.\n`);
      return;
    }
    if (size > MAX_PANEL_POST_BYTES) {
      this.keepOutput(
        running,
        `Komla: left out panel ${message.panel}'s data, ${size} bytes of JSON, past ${MAX_PANEL_POST_BYTES}.\n`
      );
      return;
    }
    this.dependencies.states.post(
      this.dependencies.panelScope(panel, stringOrUndefined(message.workspace)),
      panel,
      { data: message.data }
    );
  }

  /** Sets the badge on the plugin's panel's tab, if it's text or a number. */
  private setPanelBadge(
    running: Running,
    message: Extract<FromPluginHost, { type: 'panel-badge' }>
  ): void {
    const panel = this.panelId(running, message.panel);
    const badge = sidebarPanelBadgeInputSchema.safeParse(message.badge);
    if (!panel) return;
    if (!badge.success) {
      this.keepOutput(running, `Komla: panel ${message.panel}'s badge isn't text or a number.\n`);
      return;
    }
    this.dependencies.states.setBadge(
      this.dependencies.panelScope(panel, stringOrUndefined(message.workspace)),
      panel,
      sidebarPanelBadge(badge.data)
    );
  }

  /** The panel's id in Komla, if the plugin has it. */
  private panelId(running: Running, panel: unknown): string | undefined {
    if (typeof panel === 'string' && running.plugin.panels.includes(panel)) {
      return `${running.plugin.source.id}.${panel}`;
    }
    this.keepOutput(running, `Komla: the plugin has no panel ${String(panel)}.\n`);
    return undefined;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** A plugin's code in an Electron utility process, with its output piped to Komla. */
export function forkPluginProcess(plugin: HostedPlugin): PluginProcess {
  const child = utilityProcess.fork(join(MAIN_BUNDLE_DIR, './workers/plugin-host.worker.js'), [], {
    serviceName: `Komla plugin ${plugin.source.name}`,
    cwd: plugin.source.dir,
    env: { ...process.env, KOMLA_PLUGIN_DIR: plugin.source.dir },
    stdio: 'pipe',
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.on('exit', listener),
    onOutput: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    kill: () => {
      child.kill();
    },
  };
}
