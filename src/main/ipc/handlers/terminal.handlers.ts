import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { ptyService, type PtyBufferSnapshot } from '../../services/pty.service';
import { windowService } from '../../services/window.service';
import { handleValidated, onValidated } from '../validation/ipc-validators';
import {
  ptyAckArgsSchema,
  ptyGetBufferArgsSchema,
  ptyInputArgsSchema,
  ptyResizeArgsSchema,
  terminalClaimSizeArgsSchema,
  terminalSetFocusArgsSchema,
} from '../validation/terminal-ipc.schemas';

export function registerTerminalHandlers(): void {
  ipcMain.on(
    IPC.PTY_INPUT,
    onValidated(IPC.PTY_INPUT, ptyInputArgsSchema, (_, [terminalId, data]): void => {
      ptyService.write(terminalId, data);
    })
  );

  ipcMain.on(
    IPC.PTY_RESIZE,
    onValidated(IPC.PTY_RESIZE, ptyResizeArgsSchema, (_, [terminalId, cols, rows]): void => {
      ptyService.resize(terminalId, cols, rows);
    })
  );

  ipcMain.on(
    IPC.TERMINAL_CLAIM_SIZE,
    onValidated(IPC.TERMINAL_CLAIM_SIZE, terminalClaimSizeArgsSchema, (_, [terminalId]): void => {
      ptyService.claimLocalSize(terminalId);
    })
  );

  ipcMain.on(
    IPC.PTY_ACK,
    onValidated(IPC.PTY_ACK, ptyAckArgsSchema, (_, [terminalId, chars]): void => {
      ptyService.acknowledgeOutput(terminalId, chars);
    })
  );

  ipcMain.on(
    IPC.TERMINAL_SET_FOCUS,
    onValidated(
      IPC.TERMINAL_SET_FOCUS,
      terminalSetFocusArgsSchema,
      (event, [terminalId, focused]): void => {
        windowService.setTerminalFocus(event.sender.id, terminalId, focused);
      }
    )
  );

  ipcMain.handle(
    IPC.PTY_GET_BUFFER,
    handleValidated(
      IPC.PTY_GET_BUFFER,
      ptyGetBufferArgsSchema,
      (_, [terminalId]): PtyBufferSnapshot => {
        ptyService.attachRenderer(terminalId);
        return ptyService.getBuffer(terminalId);
      }
    )
  );
}
