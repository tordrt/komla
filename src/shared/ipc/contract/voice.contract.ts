import { IPC } from '../../constants/ipc-channels';
import {
  voiceModelIdArgsSchema,
  voiceModelDeleteArgsSchema,
  voiceTranscribeArgsSchema,
  voiceTranscribeCancelArgsSchema,
  voiceRecordingStateArgsSchema,
} from '../schemas/voice-ipc.schemas';

import { invoke } from './define';

export const voiceContract = {
  [IPC.VOICE_MODEL_STATUS]: invoke().returns<string>(),
  [IPC.VOICE_MODELS_LIST]: invoke().returns<
    Array<{
      id: string;
      name: string;
      description: string;
      sizeMB: number;
      runtimeMemoryMB: string;
      status: string;
      isCurrent: boolean;
    }>
  >(),
  [IPC.VOICE_MODEL_SELECT]: invoke(voiceModelIdArgsSchema).returns<void>(),
  [IPC.VOICE_MODEL_DOWNLOAD]: invoke(voiceModelIdArgsSchema).returns<void>(),
  [IPC.VOICE_MODEL_DOWNLOAD_CANCEL]: invoke().returns<void>(),
  [IPC.VOICE_MODEL_DELETE]: invoke(voiceModelDeleteArgsSchema).returns<void>(),
  [IPC.VOICE_WARMUP]: invoke().returns<void>(),
  [IPC.VOICE_TRANSCRIBE]: invoke(voiceTranscribeArgsSchema).returns<string>(),
  [IPC.VOICE_TRANSCRIBE_CANCEL]: invoke(voiceTranscribeCancelArgsSchema).returns<void>(),
  [IPC.VOICE_RECORDING_STATE]: invoke(voiceRecordingStateArgsSchema).returns<void>(),
  [IPC.VOICE_REQUEST_MIC_ACCESS]: invoke().returns<boolean>(),
} as const;
