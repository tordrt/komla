import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { automationService } from '../../services/automation.service';
import {
  automationDeleteArgsSchema,
  automationListArgsSchema,
  automationRunNowArgsSchema,
  automationSaveArgsSchema,
  automationSetEnabledArgsSchema,
} from '../validation/automation-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

import type {
  Automation,
  AutomationRun,
  AutomationTargetSnapshot,
} from '../../../shared/types/automation';

export function registerAutomationHandlers(): void {
  ipcMain.handle(
    IPC.AUTOMATION_LIST,
    handleValidated(
      IPC.AUTOMATION_LIST,
      automationListArgsSchema,
      async (_, [options]): Promise<AutomationTargetSnapshot[]> => automationService.list(options)
    )
  );

  ipcMain.handle(
    IPC.AUTOMATION_SAVE,
    handleValidated(
      IPC.AUTOMATION_SAVE,
      automationSaveArgsSchema,
      async (_, [params]): Promise<Automation> => automationService.save(params)
    )
  );

  ipcMain.handle(
    IPC.AUTOMATION_SET_ENABLED,
    handleValidated(
      IPC.AUTOMATION_SET_ENABLED,
      automationSetEnabledArgsSchema,
      async (_, [target, id, enabled]): Promise<void> =>
        automationService.setEnabled(target, id, enabled)
    )
  );

  ipcMain.handle(
    IPC.AUTOMATION_DELETE,
    handleValidated(
      IPC.AUTOMATION_DELETE,
      automationDeleteArgsSchema,
      async (_, [target, id]): Promise<void> => automationService.delete(target, id)
    )
  );

  ipcMain.handle(
    IPC.AUTOMATION_RUN_NOW,
    handleValidated(
      IPC.AUTOMATION_RUN_NOW,
      automationRunNowArgsSchema,
      async (_, [target, id]): Promise<AutomationRun> => automationService.runNow(target, id)
    )
  );
}
