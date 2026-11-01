import { IPC } from '../../constants/ipc-channels';
import {
  notesScopeArgsSchema,
  noteArgsSchema,
  noteWriteArgsSchema,
  noteDeleteArgsSchema,
} from '../schemas/notes-ipc.schemas';

import { invoke } from './define';

import type { NoteSummary } from '../../types/notes';

export const notesContract = {
  [IPC.NOTES_LIST]: invoke(notesScopeArgsSchema).returns<NoteSummary[]>(),
  [IPC.NOTES_CREATE]: invoke(notesScopeArgsSchema).returns<NoteSummary>(),
  [IPC.NOTES_READ]: invoke(noteArgsSchema).returns<string>(),
  [IPC.NOTES_WRITE]: invoke(noteWriteArgsSchema).returns<void>(),
  [IPC.NOTES_TRASH]: invoke(noteArgsSchema).returns<void>(),
  [IPC.NOTES_DELETE]: invoke(noteDeleteArgsSchema).returns<boolean>(),
} as const;
