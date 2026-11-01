import { IPC } from '../../../shared/constants/ipc-channels';
import { automationService } from '../../services/automation.service';
import { handleIpc } from '../validation/ipc-validators';

import type {
  Automation,
  AutomationRun,
  AutomationTargetSnapshot,
} from '../../../shared/types/automation';

export function registerAutomationHandlers(): void {
  handleIpc(IPC.AUTOMATION_LIST, async (_, [options]): Promise<AutomationTargetSnapshot[]> =>
    automationService.list(options)
  );

  handleIpc(IPC.AUTOMATION_SAVE, async (_, [params]): Promise<Automation> =>
    automationService.save(params)
  );

  handleIpc(IPC.AUTOMATION_SET_ENABLED, async (_, [target, id, enabled]): Promise<void> =>
    automationService.setEnabled(target, id, enabled)
  );

  handleIpc(IPC.AUTOMATION_DELETE, async (_, [target, id]): Promise<void> =>
    automationService.delete(target, id)
  );

  handleIpc(IPC.AUTOMATION_RUN_NOW, async (_, [target, id]): Promise<AutomationRun> =>
    automationService.runNow(target, id)
  );
}
