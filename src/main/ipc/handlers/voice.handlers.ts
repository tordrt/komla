import { systemPreferences } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { voiceTranscriptionService } from '../../services/voice-transcription.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

// The download reports every network chunk; a few updates a second are plenty.
const PROGRESS_BROADCAST_INTERVAL_MS = 250;

export function registerVoiceHandlers(): void {
  handleIpc(IPC.VOICE_MODEL_STATUS, () => {
    return voiceTranscriptionService.getStatus();
  });

  handleIpc(IPC.VOICE_MODELS_LIST, () => {
    return voiceTranscriptionService.getModelsWithStatus();
  });

  handleIpc(IPC.VOICE_MODEL_SELECT, (_, [modelId]) => {
    voiceTranscriptionService.selectModel(modelId);
  });

  handleIpc(IPC.VOICE_MODEL_DOWNLOAD, async (_, [modelId]) => {
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

  handleIpc(IPC.VOICE_MODEL_DOWNLOAD_CANCEL, () => {
    voiceTranscriptionService.cancelDownload();
  });

  handleIpc(IPC.VOICE_MODEL_DELETE, (_, [modelId]) => {
    voiceTranscriptionService.deleteModel(modelId);
  });

  handleIpc(IPC.VOICE_WARMUP, async () => {
    await voiceTranscriptionService.warmup();
  });

  handleIpc(IPC.VOICE_TRANSCRIBE, (_, [{ samples, requestId }]) =>
    voiceTranscriptionService.transcribe(new Float32Array(samples), requestId)
  );

  handleIpc(IPC.VOICE_TRANSCRIBE_CANCEL, (_, [requestId]) => {
    voiceTranscriptionService.cancelTranscription(requestId);
  });

  handleIpc(IPC.VOICE_RECORDING_STATE, (_, [active]) => {
    voiceTranscriptionService.setRecordingState(active);
  });

  handleIpc(IPC.VOICE_REQUEST_MIC_ACCESS, async () => {
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
