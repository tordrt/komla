import { agentSettingsContract } from './agent-settings.contract';
import { agentsMenuBarContract } from './agents-menu-bar.contract';
import { appContract } from './app.contract';
import { askpassContract } from './askpass.contract';
import { automationContract } from './automation.contract';
import { configContract } from './config.contract';
import { customizationContract } from './customization.contract';
import { devPreviewContract } from './dev-preview.contract';
import { diagnosticsContract } from './diagnostics.contract';
import { licenseContract } from './license.contract';
import { notesContract } from './notes.contract';
import { pluginsContract } from './plugins.contract';
import { projectContract } from './project.contract';
import { remoteControlContract } from './remote-control.contract';
import { settingsContract } from './settings.contract';
import { shellContract } from './shell.contract';
import { soundsContract } from './sounds.contract';
import { statusItemsContract } from './status-items.contract';
import { telemetryContract } from './telemetry.contract';
import { terminalContract } from './terminal.contract';
import { toastOverlayContract } from './toast-overlay.contract';
import { voiceContract } from './voice.contract';
import { windowContract } from './window.contract';

import type { IpcInvokeDefinition } from './define';
import type { IpcChannel } from '../../constants/ipc-channels';
import type { IpcRenderer } from 'electron';
import type { z } from 'zod';

/**
 * Every renderer-to-main channel: its name, argument schema and result type, in one entry.
 * `handleIpc` and `onIpc` in main and the preload's `ipcRenderer` are all typed from it.
 *
 * The preload may only import this with `import type`. It's sandboxed, and zod isn't bundled into
 * it, so importing a schema at runtime would stop the preload loading at all.
 */
export const ipcContract = {
  ...projectContract,
  ...configContract,
  ...windowContract,
  ...askpassContract,
  ...diagnosticsContract,
  ...remoteControlContract,
  ...appContract,
  ...agentSettingsContract,
  ...customizationContract,
  ...devPreviewContract,
  ...agentsMenuBarContract,
  ...licenseContract,
  ...shellContract,
  ...automationContract,
  ...statusItemsContract,
  ...settingsContract,
  ...toastOverlayContract,
  ...terminalContract,
  ...pluginsContract,
  ...notesContract,
  ...soundsContract,
  ...telemetryContract,
  ...voiceContract,
};

export type IpcContract = typeof ipcContract;

type ChannelsOfKind<TKind extends string> = {
  [C in keyof IpcContract]: IpcContract[C] extends { kind: TKind } ? C : never;
}[keyof IpcContract];

export type IpcInvokeChannel = ChannelsOfKind<'invoke'>;
export type IpcSendChannel = ChannelsOfKind<'send'>;
export type IpcSyncChannel = ChannelsOfKind<'sync'>;

/** What a caller passes: the schema's input, before defaults and transforms such as trimming. */
export type IpcArgsInput<C extends keyof IpcContract> =
  z.input<IpcContract[C]['args']> extends infer TArgs extends unknown[] ? TArgs : never;
/** What a handler receives: the schema's output. */
export type IpcArgs<C extends keyof IpcContract> =
  z.output<IpcContract[C]['args']> extends infer TArgs extends unknown[] ? TArgs : never;
export type IpcResult<C extends IpcInvokeChannel> =
  IpcContract[C] extends IpcInvokeDefinition<infer _TArgs, infer TResult> ? TResult : never;

/** The fallback for channels not in the contract yet, removed once they all are. */
type UnmigratedChannel = Exclude<IpcChannel, keyof IpcContract>;

/** Electron's `ipcRenderer`, with its calls checked against the contract. */
export interface TypedIpcRenderer extends Omit<IpcRenderer, 'invoke' | 'send' | 'sendSync'> {
  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcArgsInput<C>): Promise<IpcResult<C>>;
  invoke(channel: UnmigratedChannel, ...args: any[]): Promise<any>;
  send<C extends IpcSendChannel | IpcSyncChannel>(channel: C, ...args: IpcArgsInput<C>): void;
  send(channel: UnmigratedChannel, ...args: any[]): void;
  sendSync<C extends IpcSyncChannel>(channel: C, ...args: IpcArgsInput<C>): unknown;
  sendSync(channel: UnmigratedChannel, ...args: any[]): unknown;
}
