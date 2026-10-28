import { ipcMain, systemPreferences } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { voiceTranscriptionService } from '../../services/voice-transcription.service';
import { windowService } from '../../services/window.service';

type VoiceTranscribePayload =
  | Float32Array
  | ArrayBuffer
  | { samples: ArrayBuffer | Float32Array; requestId?: string }
  | Record<string, number>;

// The download reports every network chunk; a few updates a second are plenty.
const PROGRESS_BROADCAST_INTERVAL_MS = 250;

function coerceVoiceSamples(payload: VoiceTranscribePayload): Float32Array {
  if (payload instanceof Float32Array) return payload;
  if (payload instanceof ArrayBuffer) return new Float32Array(payload);
  if ('samples' in payload && typeof payload.samples !== 'number') {
    const { samples } = payload;
    return samples instanceof Float32Array ? samples : new Float32Array(samples);
  }
  // Backward compatibility for older preload payloads deserialized as plain objects.
  return new Float32Array(Object.values(payload));
}

export function registerVoiceHandlers(): void {
  ipcMain.handle(IPC.VOICE_MODEL_STATUS, () => {
    return voiceTranscriptionService.getStatus();
  });

  ipcMain.handle(IPC.VOICE_MODELS_LIST, () => {
    return voiceTranscriptionService.getModelsWithStatus();
  });

  ipcMain.handle(IPC.VOICE_MODEL_SELECT, (_, modelId: string) => {
    voiceTranscriptionService.selectModel(modelId);
  });

  ipcMain.handle(IPC.VOICE_MODEL_DOWNLOAD, async (_, modelId: string) => {
    const model = voiceTranscriptionService.getAvailableModels().find((m) => m.id === modelId);
    const estimatedTotalMB = model?.sizeMB ?? 0;
    let lastBroadcastAt = 0;

    await voiceTranscriptionService.downloadModel(
      modelId,
      (bytesDownloaded, totalBytes) => {
        const now = Date.now();
        if (now - lastBroadcastAt < PROGRESS_BROADCAST_INTERVAL_MS) return;
        lastBroadcastAt = now;
        const downloadedMB = bytesDownloaded / (1024 * 1024);
        // GitHub releases may not send Content-Length, fall back to model's estimated size
        const totalMB = totalBytes > 0 ? totalBytes / (1024 * 1024) : estimatedTotalMB;
        const percent = totalMB > 0 ? (downloadedMB / totalMB) * 100 : 0;
        const status = voiceTranscriptionService.getStatusForModel(modelId);

        windowService.broadcastToAll(IPC.VOICE_MODEL_DOWNLOAD_PROGRESS, {
          percent: Math.min(percent, 100),
          downloadedMB: Math.round(downloadedMB * 10) / 10,
          totalMB: Math.round(totalMB * 10) / 10,
          status,
        });
      },
      (status) => {
        // Broadcast phase transitions (e.g. downloading → extracting)
        windowService.broadcastToAll(IPC.VOICE_MODEL_DOWNLOAD_PROGRESS, {
          percent: 100,
          downloadedMB: 0,
          totalMB: 0,
          status,
        });
      }
    );

    // Auto-select this model if no model is currently ready. A cancelled
    // download also resolves, so check that this one actually finished.
    if (
      voiceTranscriptionService.getStatus() !== 'ready' &&
      voiceTranscriptionService.getStatusForModel(modelId) === 'ready'
    ) {
      voiceTranscriptionService.selectModel(modelId);
    }

    // Send one final progress event so UI picks up status change after extraction
    windowService.broadcastToAll(IPC.VOICE_MODEL_DOWNLOAD_PROGRESS, {
      percent: 100,
      downloadedMB: 0,
      totalMB: 0,
      status: voiceTranscriptionService.getStatusForModel(modelId),
    });
  });

  ipcMain.handle(IPC.VOICE_MODEL_DOWNLOAD_CANCEL, () => {
    voiceTranscriptionService.cancelDownload();
  });

  ipcMain.handle(IPC.VOICE_MODEL_DELETE, (_, modelId?: string) => {
    voiceTranscriptionService.deleteModel(modelId);
  });

  ipcMain.handle(IPC.VOICE_WARMUP, async () => {
    await voiceTranscriptionService.warmup();
  });

  ipcMain.handle(IPC.VOICE_TRANSCRIBE, async (_, payload: VoiceTranscribePayload) => {
    const samples = coerceVoiceSamples(payload);
    const requestId =
      'requestId' in payload && typeof payload.requestId === 'string'
        ? payload.requestId
        : undefined;
    return voiceTranscriptionService.transcribe(samples, requestId);
  });

  ipcMain.handle(IPC.VOICE_TRANSCRIBE_CANCEL, (_, requestId: unknown) => {
    if (typeof requestId === 'string') voiceTranscriptionService.cancelTranscription(requestId);
  });

  ipcMain.handle(IPC.VOICE_RECORDING_STATE, (_, active: boolean) => {
    voiceTranscriptionService.setRecordingState(active);
  });

  ipcMain.handle(IPC.VOICE_REQUEST_MIC_ACCESS, async () => {
    if (process.platform !== 'darwin') return true;

    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    if (status === 'not-determined') {
      return systemPreferences.askForMediaAccess('microphone');
    }
    // 'denied' or 'restricted' — in dev mode macOS may not show the app
    // in Privacy settings. Let getUserMedia attempt it anyway; Chromium's
    // own permission flow may still work.
    return true;
  });
}
