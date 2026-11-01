import { z } from 'zod';

/** What every channel's arguments parse to: a tuple, or a union of tuples. */
export type IpcArgsSchema = z.ZodType<unknown[]>;

const noArgsSchema = z.tuple([]);
type NoArgsSchema = typeof noArgsSchema;

/** A call the renderer awaits: `ipcRenderer.invoke` to `handleIpc`. */
export interface IpcInvokeDefinition<TArgs extends IpcArgsSchema, TResult> {
  readonly kind: 'invoke';
  readonly args: TArgs;
  /** Compile-time only: results aren't validated, and nothing sets this at runtime. */
  readonly __result?: TResult;
}

/** A message the renderer doesn't wait on: `ipcRenderer.send` to `onIpc`. */
export interface IpcSendDefinition<TArgs extends IpcArgsSchema> {
  readonly kind: 'send';
  readonly args: TArgs;
}

/**
 * A message the renderer may also block on: `ipcRenderer.send` or `sendSync` to `onIpcSync`.
 * Its own kind because a blocked renderer stays frozen until main answers, even for a bad payload.
 */
export interface IpcSyncDefinition<TArgs extends IpcArgsSchema> {
  readonly kind: 'sync';
  readonly args: TArgs;
}

export type IpcDefinition =
  | IpcInvokeDefinition<IpcArgsSchema, unknown>
  | IpcSendDefinition<IpcArgsSchema>
  | IpcSyncDefinition<IpcArgsSchema>;

/** `invoke(argsSchema).returns<Result>()`; leave the schema out of a call that takes no arguments. */
export function invoke(): {
  returns<TResult = void>(): IpcInvokeDefinition<NoArgsSchema, TResult>;
};
export function invoke<TArgs extends IpcArgsSchema>(
  args: TArgs
): {
  returns<TResult = void>(): IpcInvokeDefinition<TArgs, TResult>;
};
export function invoke(args: IpcArgsSchema = noArgsSchema): {
  returns<TResult>(): IpcInvokeDefinition<IpcArgsSchema, TResult>;
} {
  return { returns: () => ({ kind: 'invoke', args }) };
}

export function send(): IpcSendDefinition<NoArgsSchema>;
export function send<TArgs extends IpcArgsSchema>(args: TArgs): IpcSendDefinition<TArgs>;
export function send(args: IpcArgsSchema = noArgsSchema): IpcSendDefinition<IpcArgsSchema> {
  return { kind: 'send', args };
}

export function sync<TArgs extends IpcArgsSchema>(args: TArgs): IpcSyncDefinition<TArgs> {
  return { kind: 'sync', args };
}
