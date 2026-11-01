// Checked by `npm run typecheck` and never imported: each @ts-expect-error fails the check if the
// contract stops rejecting that mistake.
import { IPC } from '../../shared/constants/ipc-channels';

import { handleIpc } from './validation/ipc-validators';

import type {
  IpcArgsInput,
  IpcContract,
  IpcInvokeChannel,
  IpcResult,
  TypedIpcRenderer,
} from '../../shared/ipc/contract';

declare const ipcRenderer: TypedIpcRenderer;

export function _handlersAreCheckedAgainstTheContract(): void {
  handleIpc(IPC.VOICE_REQUEST_MIC_ACCESS, () => true);
  handleIpc(IPC.VOICE_REQUEST_MIC_ACCESS, async () => true);
  handleIpc(IPC.VOICE_MODEL_SELECT, (_, [modelId]) => {
    modelId.trim();
  });

  // @ts-expect-error the result is a boolean
  handleIpc(IPC.VOICE_REQUEST_MIC_ACCESS, () => 'yes');
  // @ts-expect-error the result is a boolean, async or not
  handleIpc(IPC.VOICE_REQUEST_MIC_ACCESS, async () => 'yes');
  // @ts-expect-error a call declared void can't return a value
  handleIpc(IPC.VOICE_WARMUP, () => 42);
  handleIpc(IPC.VOICE_MODEL_SELECT, (_, [modelId]) => {
    // @ts-expect-error the argument is a string
    modelId.toFixed();
  });
  // @ts-expect-error the call takes one argument
  handleIpc(IPC.VOICE_MODEL_SELECT, (_, [_modelId, _extra]) => {});
  // @ts-expect-error not a renderer-to-main call
  handleIpc(IPC.VOICE_MODEL_DOWNLOAD_PROGRESS, () => {});
}

export async function _preloadCallsAreCheckedAgainstTheContract(): Promise<void> {
  const allowed: boolean = await ipcRenderer.invoke(IPC.VOICE_REQUEST_MIC_ACCESS);
  void allowed;
  await ipcRenderer.invoke(IPC.VOICE_MODEL_SELECT, 'model');
  await ipcRenderer.invoke(IPC.VOICE_MODEL_DELETE);
  await ipcRenderer.invoke(IPC.VOICE_MODEL_DELETE, 'model');

  // @ts-expect-error the result is a boolean, not any
  const wrongResult: string = await ipcRenderer.invoke(IPC.VOICE_REQUEST_MIC_ACCESS);
  void wrongResult;
  // @ts-expect-error the argument is a string
  await ipcRenderer.invoke(IPC.VOICE_MODEL_SELECT, 42);
  // @ts-expect-error the argument is required
  await ipcRenderer.invoke(IPC.VOICE_MODEL_SELECT);
  // @ts-expect-error the call takes one argument
  await ipcRenderer.invoke(IPC.VOICE_MODEL_SELECT, 'model', 'extra');
  // @ts-expect-error the call takes no arguments
  await ipcRenderer.invoke(IPC.VOICE_WARMUP, 'extra');
  // @ts-expect-error no such channel
  await ipcRenderer.invoke('voice:no-such-channel');
}

// A caller passes the schema's input, which a transform can change: idSchema trims, for one.
export const _callersPassTheSchemasInput: IpcArgsInput<typeof IPC.VOICE_MODEL_DELETE> = [];

type IsAny<T> = 0 extends 1 & T ? true : false;
type ChannelsWhere<T extends Record<string, boolean>> = {
  [C in keyof T]: T[C] extends true ? C : never;
}[keyof T];

/** Any channels listed here would leave a result or its arguments unchecked. */
type ChannelsWithAnyResult = ChannelsWhere<{ [C in IpcInvokeChannel]: IsAny<IpcResult<C>> }>;
type ChannelsWithAnyArgs = ChannelsWhere<{
  [C in keyof IpcContract]: IsAny<IpcArgsInput<C>>;
}>;

export const _noResultIsAny: [ChannelsWithAnyResult] extends [never]
  ? true
  : ChannelsWithAnyResult = true;
export const _noArgsAreAny: [ChannelsWithAnyArgs] extends [never] ? true : ChannelsWithAnyArgs =
  true;
