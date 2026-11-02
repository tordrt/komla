import { KOMLA_OPERATION_TYPES } from '../../../packages/sdk/src/generated';
import {
  OKLCH_CHANNELS,
  STATUS_POPOVER_THEME_COLORS,
  type StatusPopoverTheme,
} from '../../shared/types/status-items';

import { KOMLA_FONT_FACES, KOMLA_SCROLLBARS, themeStyle } from './komla-page-styles';

/*
 * What a sidebar panel's own page gets from Komla, before its own HTML: Komla's theme colors as
 * CSS variables, its fonts, and `komla`, the page's way to Komla (`komla skill integrations`
 * describes it). The page loads once and stays; data, theme changes and replies come as messages.
 */

/** Where a panel's page finds Komla's stylesheet, as `<link rel="stylesheet" href="…">`. */
export const KOMLA_STYLESHEET_PATH = '/__komla/komla.css';

// `komla`, made before the page's own scripts run, so they get the one Komla made. It keeps what
// it reads a click with from then, as the popover's script does, since a page script could
// replace them. A page can ask for anything `komla` offers, but `run` and the operations Komla asks
// the user about carry a token the page's scripts can't read, and only while the user is clicking
// or typing in the page, so a script outside text slipped into the page can't press them alone.
// Only messages from Komla's window count.
const BRIDGE_SCRIPT = `(() => {
  const target = parent;
  const post = (message) => target.postMessage(message, '*');
  const apply = Reflect.apply;
  const getter = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
  const eventTarget = getter(Event.prototype, 'target');
  const eventSource = getter(MessageEvent.prototype, 'source');
  const eventData = getter(MessageEvent.prototype, 'data');
  const preventDefault = Event.prototype.preventDefault;
  const closest = Element.prototype.closest;
  const href = getter(HTMLAnchorElement.prototype, 'href');
  const protocol = getter(HTMLAnchorElement.prototype, 'protocol');
  const activation = navigator.userActivation;
  const isActive = activation ? getter(UserActivation.prototype, 'isActive') : undefined;
  const clicking = () => isActive !== undefined && apply(isActive, activation, []);
  const token = crypto.randomUUID();
  const names = new Set(${JSON.stringify(STATUS_POPOVER_THEME_COLORS)});
  const channels = ${OKLCH_CHANNELS.toString()};
  const root = document.documentElement;
  let data;
  let error;
  let theme;
  let next = 0;
  const pending = new Map();
  const dataListeners = new Set();
  const themeListeners = new Set();
  const eventListeners = new Map();
  const call = (listener, ...args) => {
    try {
      listener(...args);
    } catch (thrown) {
      console.error(thrown);
    }
  };
  const komlaError = (failure) =>
    Object.assign(new Error(String(failure?.message ?? 'Komla could not do that.')), {
      name: 'KomlaError',
      code: String(failure?.code ?? 'OPERATION_FAILED'),
      details: failure?.details,
    });
  const ask = (message) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      post({ ...message, id, ...(clicking() && { token }) });
    });
  // The colors are a style of the bridge's own, not the root's inline style: Komla's head comes
  // before the page's \`<html>\`, whose attributes the browser keeps only where the root has none,
  // and the page's own \`style\` there, or a script's, wins. \`:root:root\` beats the head's style.
  const colors = document.createElement('style');
  (document.head ?? root).appendChild(colors);
  const applyTheme = (value) => {
    if (!value || typeof value !== 'object') return;
    theme = { scheme: value.scheme === 'light' ? 'light' : 'dark', colors: {} };
    root.dataset.theme = theme.scheme;
    const rules = [];
    for (const [name, value_] of Object.entries(value.colors ?? {})) {
      if (!names.has(name) || typeof value_ !== 'string' || !channels.test(value_)) continue;
      theme.colors[name] = value_;
      rules.push('--' + name + ': oklch(' + value_ + ');');
    }
    colors.textContent = ':root:root { ' + rules.join(' ') + ' }';
    for (const listener of themeListeners) call(listener, theme);
  };
  applyTheme(__KOMLA_THEME__);
  addEventListener('message', (event) => {
    if (apply(eventSource, event, []) !== target) return;
    const message = apply(eventData, event, []);
    if (!message || typeof message !== 'object' || typeof message.komlaPanel !== 'string') return;
    if (message.komlaPanel === 'data') {
      data = message.data;
      error = typeof message.error === 'string' ? message.error : undefined;
      for (const listener of dataListeners) call(listener, data, error);
    } else if (message.komlaPanel === 'theme') {
      applyTheme(message.theme);
    } else if (message.komlaPanel === 'event') {
      const event = message.event;
      if (!event || typeof event.type !== 'string') return;
      for (const type of [event.type, '*']) {
        for (const listener of eventListeners.get(type) ?? []) call(listener, event);
      }
    } else if (message.komlaPanel === 'reply') {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(komlaError(message.error));
    }
  });
  // One method for each Komla Operation, as @komla/sdk/client has them: komla.workspace.list().
  const operations = {};
  for (const type of ${JSON.stringify(KOMLA_OPERATION_TYPES)}) {
    const [namespace, method] = type.split('.');
    operations[namespace] ??= {};
    operations[namespace][method] = (input, options) =>
      komla.call({ ...(input ?? {}), type }, options);
  }
  for (const namespace of Object.values(operations)) Object.freeze(namespace);
  const komla = {
    ...operations,
    /** What the panel's command printed last, or its plugin's code posted: its JSON, or its text. */
    get data() { return data; },
    /** Why the panel's command failed last, while it does. */
    get error() { return error; },
    get theme() { return theme; },
    /** Calls the listener with each run's data, and with the last one at once, if any. */
    onData(listener) {
      dataListeners.add(listener);
      if (data !== undefined || error !== undefined) call(listener, data, error);
      return () => dataListeners.delete(listener);
    },
    onTheme(listener) {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    /** Follows an event in the panel's workspace, such as 'agent.done', or with '*' every one. */
    on(type, listener) {
      const listeners = eventListeners.get(String(type)) ?? new Set();
      listeners.add(listener);
      eventListeners.set(String(type), listeners);
      return () => listeners.delete(listener);
    },
    /** Sends a message to the plugin's code, and resolves to its answer. */
    send: (message) => ask({ komlaPanel: 'send', message }),
    /** Sets the badge on the panel's tab: text or a number, with a tone; null clears it. */
    setBadge: (badge) => ask({ komlaPanel: 'badge', badge: badge ?? null }),
    /** Runs the panel's command now; resolves once its data came. */
    refresh: () => ask({ komlaPanel: 'refresh' }),
    /** Runs one of the commands the panel names. Only from a click or key press in the page. */
    run: (name) =>
      clicking()
        ? ask({ komlaPanel: 'run', name: String(name) })
        : Promise.reject(komlaError({ code: 'NEEDS_USER_ACTION', message: 'komla.run works only from a click or a key press.' })),
    /** Sends a Komla Operation, as @komla/sdk/client's transport does. */
    call: (request, options) =>
      ask({ komlaPanel: 'call', request, workspace: options?.workspace }),
    /** The transport for @komla/sdk/client's createKomlaClient. */
    transport: Object.freeze({ send: (request, options) => komla.call(request, options) }),
  };
  Object.freeze(komla);
  Object.defineProperty(window, 'komla', { value: komla, enumerable: true });
  post({ komlaPanel: 'hello', token });
  addEventListener('click', (event) => {
    let link;
    try {
      link = apply(closest, apply(eventTarget, event, []), ['a[href]']);
    } catch {
      return;
    }
    if (!link) return;
    let scheme;
    try {
      scheme = apply(protocol, link, []);
    } catch {
      return;
    }
    if (scheme !== 'https:' && scheme !== 'http:') return;
    apply(preventDefault, event, []);
    if (event.isTrusted) post({ komlaPanel: 'open-link', url: apply(href, link, []), token });
  }, true);
})();`;

/**
 * What Komla puts at the start of a panel's page: its theme as CSS variables and on the root's
 * `data-theme`, its fonts, a few base styles, and `komla`. The page's own styles come later, so
 * they win.
 */
export function sidebarPanelPageHead(theme: StatusPopoverTheme | undefined): string {
  // The theme goes in as JSON, inside a script: `<` can't end the script early.
  const themeJson = JSON.stringify(theme ?? null).replace(/</g, '\\u003c');
  return `<script>${BRIDGE_SCRIPT.replace('__KOMLA_THEME__', () => themeJson)}</script>
<style>
${themeStyle(theme)}
${KOMLA_FONT_FACES}
html, body { margin: 0; background: transparent; }
body { font: 12px/1.5 'Geist', 'Komla Icons', system-ui, sans-serif; color: var(--foreground); }
a { color: var(--primary); }
${KOMLA_SCROLLBARS}
</style>`;
}

/**
 * The page with Komla's head before anything of the page's own, so `komla` is ready before any of
 * its scripts runs: after its doctype, so the page keeps standards mode, else before it all. The
 * browser puts it in the page's head, and the page is served as UTF-8, so its charset can come
 * later.
 */
export function withSidebarPanelHead(html: string, head: string): string {
  // A doctype may follow comments, and keeps standards mode only ahead of everything else.
  const doctype = /^(?:\s|<!--(?:-?>|[\s\S]*?--!?>)|<\?[^>]*>)*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}${head}${html.slice(at)}`;
}
