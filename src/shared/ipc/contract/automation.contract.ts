import { IPC } from '../../constants/ipc-channels';
import {
  automationListArgsSchema,
  automationSaveArgsSchema,
  automationSetEnabledArgsSchema,
  automationDeleteArgsSchema,
  automationRunNowArgsSchema,
} from '../schemas/automation-ipc.schemas';

import { invoke } from './define';

import type { Automation, AutomationRun, AutomationTargetSnapshot } from '../../types/automation';

export const automationContract = {
  [IPC.AUTOMATION_LIST]: invoke(automationListArgsSchema).returns<AutomationTargetSnapshot[]>(),
  [IPC.AUTOMATION_SAVE]: invoke(automationSaveArgsSchema).returns<Automation>(),
  [IPC.AUTOMATION_SET_ENABLED]: invoke(automationSetEnabledArgsSchema).returns<void>(),
  [IPC.AUTOMATION_DELETE]: invoke(automationDeleteArgsSchema).returns<void>(),
  [IPC.AUTOMATION_RUN_NOW]: invoke(automationRunNowArgsSchema).returns<AutomationRun>(),
} as const;
