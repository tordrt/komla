import { IPC } from '../../constants/ipc-channels';
import {
  ptyInputArgsSchema,
  ptyResizeArgsSchema,
  terminalClaimSizeArgsSchema,
  ptyAckArgsSchema,
  terminalSetFocusArgsSchema,
  ptyGetBufferArgsSchema,
} from '../schemas/terminal-ipc.schemas';

import { invoke, send } from './define';

import type { TerminalHostInfo } from '../../types/terminal';

export const terminalContract = {
  [IPC.PTY_INPUT]: send(ptyInputArgsSchema),
  [IPC.PTY_RESIZE]: send(ptyResizeArgsSchema),
  [IPC.TERMINAL_CLAIM_SIZE]: send(terminalClaimSizeArgsSchema),
  [IPC.PTY_ACK]: send(ptyAckArgsSchema),
  [IPC.TERMINAL_SET_FOCUS]: send(terminalSetFocusArgsSchema),
  [IPC.PTY_GET_BUFFER]: invoke(ptyGetBufferArgsSchema).returns<{
    buffer: string;
    seq: number;
    hostInfo?: TerminalHostInfo;
  }>(),
} as const;
