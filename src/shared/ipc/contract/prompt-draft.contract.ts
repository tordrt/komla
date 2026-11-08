import { IPC } from '../../constants/ipc-channels';
import {
  promptDraftContextArgsSchema,
  promptDraftNoteSavedArgsSchema,
  promptDraftPopOutArgsSchema,
  promptDraftReferenceArgsSchema,
  promptDraftWindowCloseArgsSchema,
  promptDraftWindowDraftArgsSchema,
  promptDraftWindowSaveAsNoteArgsSchema,
} from '../schemas/prompt-draft-ipc.schemas';

import { invoke, send } from './define';

import type { PromptDraftWindowStatus } from '../../types';

export const promptDraftContract = {
  // From Komla's windows.
  [IPC.PROMPT_DRAFT_POP_OUT]: send(promptDraftPopOutArgsSchema),
  [IPC.PROMPT_DRAFT_SHOW]: send(),
  [IPC.PROMPT_DRAFT_HIDE]: send(),
  [IPC.PROMPT_DRAFT_STATUS_REQUEST]: invoke().returns<PromptDraftWindowStatus>(),
  [IPC.PROMPT_DRAFT_CONTEXT]: send(promptDraftContextArgsSchema),
  [IPC.PROMPT_DRAFT_REFERENCE]: send(promptDraftReferenceArgsSchema),
  [IPC.PROMPT_DRAFT_NOTE_SAVED]: send(promptDraftNoteSavedArgsSchema),
  // From the popped-out draft's page.
  [IPC.PROMPT_DRAFT_WINDOW_STATE_REQUEST]: send(),
  [IPC.PROMPT_DRAFT_WINDOW_READY]: send(),
  [IPC.PROMPT_DRAFT_WINDOW_TEXT]: send(promptDraftWindowDraftArgsSchema),
  [IPC.PROMPT_DRAFT_WINDOW_REQUEST_REFERENCE]: send(),
  [IPC.PROMPT_DRAFT_WINDOW_SAVE_AS_NOTE]: send(promptDraftWindowSaveAsNoteArgsSchema),
  [IPC.PROMPT_DRAFT_WINDOW_CLOSE]: send(promptDraftWindowCloseArgsSchema),
  [IPC.PROMPT_DRAFT_WINDOW_POP_IN]: send(promptDraftWindowDraftArgsSchema),
} as const;
