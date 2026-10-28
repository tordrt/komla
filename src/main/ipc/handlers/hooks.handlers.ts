import { IPC } from '../../../shared/constants/ipc-channels';
import { onHookNotice } from '../../services/hooks.service';
import { windowService } from '../../services/window.service';

export function registerHooksHandlers(): void {
  // A notice about hooks.json can come before the window shows, as when the file is broken at launch.
  onHookNotice((message) => windowService.broadcastWhenReady(IPC.HOOK_NOTICE, message));
}
