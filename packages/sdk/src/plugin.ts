/**
 * What a plugin's code and its panels' pages get from Komla, as types only: Komla hands them the
 * objects. A plugin's `main` runs in a process of its own and is called as `activate(komla)`, with
 * a client that may call every operation the user leaves on. A panel's page runs in a sandbox and
 * gets `window.komla`, which may change only what its panel declares.
 */
import type { KomlaCallOptions, KomlaClient } from './client.js';
import type {
  KomlaCapability,
  KomlaEvent,
  KomlaEventType,
  KomlaOperationRequest,
} from './generated.js';

/** A short mark on a panel's tab, such as a count: text or a number, or null for none. */
export type KomlaPanelBadge =
  | null
  | number
  | string
  | { text: string | number; tone?: 'success' | 'warning' | 'error' | 'info' };

/** Which workspace something is for; without one, every workspace's. */
export interface KomlaWorkspaceOptions {
  workspace?: string;
}

export interface KomlaExecOptions extends KomlaWorkspaceOptions {
  /** How long the command may run, 30 when left out. */
  timeoutSeconds?: number;
}

/** The plugin's sidebar panels, by the ids its komla-plugin.json gives them. */
export interface KomlaPluginPanels {
  /**
   * Gives a panel's page data, which it gets from `komla.onData` as if its command printed it, in
   * one workspace or every one. Komla keeps the last for pages that open later.
   */
  post(panel: string, data: unknown, options?: KomlaWorkspaceOptions): void;
  /** Sets or, with null, clears the badge on a panel's tab, in one workspace or every one. */
  setBadge(panel: string, badge: KomlaPanelBadge, options?: KomlaWorkspaceOptions): void;
  /**
   * Answers what a panel's page sends with `komla.send`. What the handler returns, or the promise
   * resolves to, is the page's reply; what it throws, the page's error. The message comes from a
   * page that shows outside text, so check it as input from anyone, and do what reaches past the
   * page, such as launching an agent, only when `activated`: the user was clicking or typing in
   * the page as it sent it.
   */
  onMessage(
    panel: string,
    handler: (message: unknown, from: { workspace: string; activated: boolean }) => unknown
  ): () => void;
  /** Follows a panel's page opening in a window, as to post it fresh data. */
  onOpen(panel: string, handler: (from: { workspace: string }) => void): () => void;
}

/** What `activate` gets. */
export type KomlaPlugin = KomlaClient<KomlaCapability> & {
  readonly plugin: { id: string; name: string; version?: string; dir: string };
  /** Follows an event, or with '*' every event, in every workspace. */
  on(type: KomlaEventType | '*', listener: (event: KomlaEvent) => void): () => void;
  /**
   * Runs a shell command where the workspace's files are, on its SSH host for an SSH workspace,
   * or without a workspace, in the plugin's folder on this computer, and resolves to what it
   * printed. It fails with a KomlaError: `COMMAND_FAILED`, whose message is the last line the
   * command printed as an error, with `details.timedOut` when it ran out of time;
   * `WORKSPACE_NOT_FOUND` for a workspace Komla doesn't have; or `WORKSPACE_UNAVAILABLE` while
   * the workspace can't run commands.
   */
  exec(command: string, options?: KomlaExecOptions): Promise<string>;
  readonly panels: KomlaPluginPanels;
};

/** A plugin's `main`: `export function activate(komla) { … }`, and optionally `deactivate`. */
export interface KomlaPluginModule {
  activate(komla: KomlaPlugin): void | Promise<void>;
  /** Runs before Komla stops the plugin, as when it's turned off; Komla waits 2 seconds. */
  deactivate?(): void | Promise<void>;
}

/** The theme a page gets: each color as OKLCH channels, also as CSS variables like `--primary`. */
export interface KomlaPanelTheme {
  scheme: 'light' | 'dark';
  colors: Record<string, string>;
}

/**
 * `window.komla` in a sidebar panel's page. Its methods for Komla Operations, such as
 * `komla.workspace.list()`, check what the panel declares, as a client that declared C does, and
 * Komla asks the user before the risky ones, from a click only.
 */
export type KomlaPanelPage<C extends KomlaCapability = never> = KomlaClient<C> & {
  /** What the panel's command printed last, or its plugin's code posted: JSON, or text. */
  readonly data: unknown;
  /** Why the panel's command failed last, while it does. */
  readonly error: string | undefined;
  readonly theme: KomlaPanelTheme | undefined;
  onData(listener: (data: unknown, error?: string) => void): () => void;
  onTheme(listener: (theme: KomlaPanelTheme) => void): () => void;
  /** Follows an event in the panel's workspace, or with '*' every event; without `message`. */
  on(type: KomlaEventType | '*', listener: (event: KomlaEvent) => void): () => void;
  /** Runs the panel's command now; resolves once its data came. */
  refresh(): Promise<void>;
  /** Runs one of the commands the panel names. Only from a click or key press in the page. */
  run(name: string): Promise<void>;
  /** Sends a message to the plugin's code, which answers it with `komla.panels.onMessage`. */
  send(message: unknown): Promise<unknown>;
  /** Sets or, with null, clears the badge on the panel's tab. */
  setBadge(badge: KomlaPanelBadge): Promise<void>;
  /** Sends a Komla Operation as it is, for code that builds requests itself. */
  call(request: KomlaOperationRequest, options?: KomlaCallOptions): Promise<unknown>;
  /** The transport for `createKomlaClient`, for a page that bundles @komla/sdk/client. */
  readonly transport: {
    send(request: KomlaOperationRequest, options: KomlaCallOptions): Promise<unknown>;
  };
};
