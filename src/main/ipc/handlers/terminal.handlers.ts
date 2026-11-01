import { IPC } from '../../../shared/constants/ipc-channels';
import { ptyService, type PtyBufferSnapshot } from '../../services/pty.service';
import { windowService } from '../../services/window.service';
import { handleIpc, onIpc } from '../validation/ipc-validators';

export function registerTerminalHandlers(): void {
  onIpc(IPC.PTY_INPUT, (_, [terminalId, data]): void => {
    ptyService.write(terminalId, data);
  });

  onIpc(IPC.PTY_RESIZE, (_, [terminalId, cols, rows]): void => {
    ptyService.resize(terminalId, cols, rows);
  });

  onIpc(IPC.TERMINAL_CLAIM_SIZE, (_, [terminalId]): void => {
    ptyService.claimLocalSize(terminalId);
  });

  onIpc(IPC.PTY_ACK, (_, [terminalId, chars]): void => {
    ptyService.acknowledgeOutput(terminalId, chars);
  });

  onIpc(IPC.TERMINAL_SET_FOCUS, (event, [terminalId, focused]): void => {
    windowService.setTerminalFocus(event.sender.id, terminalId, focused);
  });

  handleIpc(IPC.PTY_GET_BUFFER, (_, [terminalId]): PtyBufferSnapshot => {
    ptyService.attachRenderer(terminalId);
    return ptyService.getBuffer(terminalId);
  });
}
