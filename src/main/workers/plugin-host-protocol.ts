/*
 * The messages between Komla's main process and a plugin's process, the plugin host (ADR 0009).
 * Types only, so neither side bundles the other's code.
 */
import type { KomlaEvent } from '../../shared/types/komla-events';
import type { PluginSettingValue } from '../../shared/types/plugins';

export interface PluginHostFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type PluginHostReply =
  | { type: 'reply'; id: number; ok: true; result?: unknown }
  | { type: 'reply'; id: number; ok: false; error: PluginHostFailure };

/** What Komla sends a plugin's process. */
export type ToPluginHost =
  | {
      type: 'activate';
      /** The plugin's `main`, as an absolute path. */
      main: string;
      plugin: { id: string; name: string; version?: string; dir: string };
      /** Its settings' values, the user's or their defaults, secrets included. */
      settings: Record<string, PluginSettingValue>;
    }
  | { type: 'settings'; settings: Record<string, PluginSettingValue> }
  | { type: 'deactivate' }
  | { type: 'event'; event: KomlaEvent }
  | {
      type: 'panel-message';
      id: number;
      panel: string;
      workspace: string;
      message: unknown;
      /** The user was clicking or typing in the page as it sent the message. */
      activated: boolean;
    }
  | { type: 'panel-open'; panel: string; workspace: string }
  | PluginHostReply;

/** What a plugin's process sends Komla. */
export type FromPluginHost =
  | { type: 'ready' }
  | { type: 'activate-failed'; message: string }
  | { type: 'deactivated' }
  | { type: 'call'; id: number; request: unknown; workspace?: string }
  | { type: 'exec'; id: number; command: string; workspace?: string; timeoutSeconds?: number }
  | { type: 'panel-post'; panel: string; workspace?: string; data: unknown }
  | { type: 'panel-badge'; panel: string; workspace?: string; badge: unknown }
  | PluginHostReply;
