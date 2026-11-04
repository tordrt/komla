// A plugin's code, in an Electron utility process of its own (ADR 0009): a plugin that crashes or
// keeps busy can't freeze Komla or reach a window. It loads the plugin's `main`, a JavaScript or
// TypeScript module, without a build step, and calls its `activate` with `komla`.
import { pathToFileURL } from 'url';

import {
  createKomlaClient,
  KOMLA_CAPABILITIES,
  KomlaError,
  type KomlaTransport,
} from '../../../packages/sdk/src/client';

import type { FromPluginHost, ToPluginHost } from './plugin-host-protocol';
import type {
  KomlaPlugin,
  KomlaPluginModule,
  KomlaPluginPanels,
  KomlaPluginSettings,
  KomlaPluginSettingValue,
} from '../../../packages/sdk/src/plugin';
import type { KomlaEvent } from '../../shared/types/komla-events';

const DEACTIVATE_MS = 2000;

const port = process.parentPort;
const post = (message: FromPluginHost) => port.postMessage(message);

let next = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

/** Asks Komla, and resolves to its answer or throws a KomlaError with Komla's code. */
type Question = Extract<FromPluginHost, { type: 'call' | 'exec' | 'set-settings' }>;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function ask(message: WithoutId<Question>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    post({ ...message, id });
  });
}

const eventListeners = new Map<string, Set<(event: KomlaEvent) => void>>();
const messageHandlers = new Map<
  string,
  (message: unknown, from: { workspace: string; activated: boolean }) => unknown
>();
const openHandlers = new Map<string, Set<(from: { workspace: string }) => void>>();
let plugin: KomlaPluginModule | undefined;
let settings: Readonly<Record<string, KomlaPluginSettingValue>> = Object.freeze({});
const settingsListeners = new Set<(settings: Record<string, KomlaPluginSettingValue>) => void>();

function report(error: unknown): void {
  console.error(error);
}

function safely<A extends unknown[]>(listener: (...args: A) => unknown, ...args: A): void {
  try {
    const result = listener(...args);
    if (result instanceof Promise) result.catch(report);
  } catch (error) {
    report(error);
  }
}

function getSettings(): Record<string, KomlaPluginSettingValue>;
function getSettings(id: string): KomlaPluginSettingValue | undefined;
function getSettings(
  id?: string
): Record<string, KomlaPluginSettingValue> | KomlaPluginSettingValue | undefined {
  return id === undefined ? { ...settings } : settings[id];
}

const pluginSettings: KomlaPluginSettings = Object.freeze({
  get: getSettings,
  set: async (changes: Record<string, KomlaPluginSettingValue | null>) => {
    await ask({ type: 'set-settings', changes });
  },
  onChange: (listener: (settings: Record<string, KomlaPluginSettingValue>) => void) => {
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  },
});

function makeKomla(info: Extract<ToPluginHost, { type: 'activate' }>['plugin']): KomlaPlugin {
  const transport: KomlaTransport = {
    send: (request, options) => ask({ type: 'call', request, workspace: options.workspace }),
  };
  // Plugin code is trusted as the plugin's commands are (ADR 0008), so it declares every
  // capability; Komla still refuses what the user turned off.
  const client = createKomlaClient({
    transport,
    capabilities: KOMLA_CAPABILITIES.map(({ id }) => id),
  });
  const panels: KomlaPluginPanels = {
    post: (panel, data, options) =>
      post({ type: 'panel-post', panel: String(panel), workspace: options?.workspace, data }),
    onMessage: (panel, handler) => {
      messageHandlers.set(String(panel), handler);
      return () => {
        if (messageHandlers.get(String(panel)) === handler) messageHandlers.delete(String(panel));
      };
    },
    onOpen: (panel, handler) => {
      const handlers = openHandlers.get(String(panel)) ?? new Set();
      handlers.add(handler);
      openHandlers.set(String(panel), handlers);
      return () => handlers.delete(handler);
    },
  };
  return Object.freeze({
    ...client,
    plugin: Object.freeze({ ...info }),
    on: (type, listener) => {
      const listeners = eventListeners.get(type) ?? new Set();
      listeners.add(listener);
      eventListeners.set(type, listeners);
      return () => listeners.delete(listener);
    },
    exec: async (command, options) =>
      String(
        await ask({
          type: 'exec',
          command: String(command),
          workspace: options?.workspace,
          timeoutSeconds: options?.timeoutSeconds,
        })
      ),
    panels: Object.freeze(panels),
    settings: pluginSettings,
  });
}

async function activate(message: Extract<ToPluginHost, { type: 'activate' }>): Promise<void> {
  settings = Object.freeze({ ...message.settings });
  try {
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(message.main).href)) as {
      activate?: KomlaPluginModule['activate'];
      deactivate?: KomlaPluginModule['deactivate'];
      default?: Partial<KomlaPluginModule> | KomlaPluginModule['activate'];
    };
    const fallback = loaded.default;
    const start =
      loaded.activate ??
      (typeof fallback === 'function' ? fallback : fallback?.activate?.bind(fallback));
    if (typeof start !== 'function') {
      throw new Error(`${message.main} exports no activate function`);
    }
    plugin = {
      activate: start,
      deactivate:
        loaded.deactivate ??
        (typeof fallback === 'object' ? fallback?.deactivate?.bind(fallback) : undefined),
    };
    await start(makeKomla(message.plugin));
    post({ type: 'ready' });
  } catch (error) {
    report(error);
    post({
      type: 'activate-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function deactivate(): Promise<void> {
  try {
    await Promise.race([
      plugin?.deactivate?.(),
      new Promise((resolve) => setTimeout(resolve, DEACTIVATE_MS)),
    ]);
  } catch (error) {
    report(error);
  }
  post({ type: 'deactivated' });
}

async function answerPanel(
  message: Extract<ToPluginHost, { type: 'panel-message' }>
): Promise<void> {
  const handler = messageHandlers.get(message.panel);
  if (!handler) {
    post({
      type: 'reply',
      id: message.id,
      ok: false,
      error: {
        code: 'NO_HANDLER',
        message: `The plugin's code doesn't answer the panel ${message.panel}'s messages.`,
      },
    });
    return;
  }
  try {
    const result = await handler(message.message, {
      workspace: message.workspace,
      activated: message.activated,
    });
    post({ type: 'reply', id: message.id, ok: true, result });
  } catch (error) {
    post({
      type: 'reply',
      id: message.id,
      ok: false,
      error: {
        code: error instanceof KomlaError ? error.code : 'PLUGIN_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

port.on('message', ({ data }: { data: ToPluginHost }) => {
  switch (data.type) {
    case 'activate':
      void activate(data);
      return;
    case 'deactivate':
      void deactivate();
      return;
    case 'event':
      for (const type of [data.event.type, '*']) {
        for (const listener of eventListeners.get(type) ?? []) safely(listener, data.event);
      }
      return;
    case 'panel-message':
      void answerPanel(data);
      return;
    case 'settings':
      settings = Object.freeze({ ...data.settings });
      for (const listener of settingsListeners) safely(listener, { ...settings });
      return;
    case 'panel-open':
      for (const handler of openHandlers.get(data.panel) ?? []) {
        safely(handler, { workspace: data.workspace });
      }
      return;
    case 'reply': {
      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      if (data.ok) waiting.resolve(data.result);
      else {
        waiting.reject(
          new KomlaError(data.error.code, data.error.message, undefined, data.error.details)
        );
      }
    }
  }
});

process.on('unhandledRejection', report);
