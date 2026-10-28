import { create } from 'zustand';

type ModelStatus = 'unknown' | 'not-downloaded' | 'downloading' | 'extracting' | 'ready' | 'error';

interface DownloadProgress {
  percent: number;
  downloadedMB: number;
  totalMB: number;
}

interface VoiceModel {
  id: string;
  name: string;
  description: string;
  sizeMB: number;
  runtimeMemoryMB: string;
  status: ModelStatus;
  isCurrent: boolean;
}

interface VoiceState {
  modelStatus: ModelStatus;
  models: VoiceModel[];
  downloadingModelId: string | null;
  downloadProgress: DownloadProgress | null;
  isRecording: boolean;
  isStarting: boolean;

  loadModelStatus: () => Promise<void>;
  loadModels: () => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
  downloadModel: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  cancelDownload: () => Promise<void>;
  transcribe: (audio: Float32Array, requestId?: string) => Promise<string>;
  setRecording: (recording: boolean) => void;
  setStarting: (starting: boolean) => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  modelStatus: 'unknown',
  models: [],
  downloadingModelId: null,
  downloadProgress: null,
  isRecording: false,
  isStarting: false,

  loadModelStatus: async () => {
    const status = await window.api.voiceGetModelStatus();
    set({ modelStatus: status as ModelStatus });
  },

  loadModels: async () => {
    const models = await window.api.voiceGetModels();
    const currentModel = models.find((m) => m.isCurrent);
    set({
      models: models as VoiceModel[],
      modelStatus: (currentModel?.status as ModelStatus) ?? 'unknown',
    });
  },

  selectModel: async (modelId: string) => {
    await window.api.voiceSelectModel(modelId);
    // Reload models to get updated isCurrent and status
    await get().loadModels();
  },

  downloadModel: async (modelId: string) => {
    set({ downloadingModelId: modelId, downloadProgress: null });

    // Update the specific model's status optimistically
    set((state) => ({
      models: state.models.map((m) =>
        m.id === modelId ? { ...m, status: 'downloading' as ModelStatus } : m
      ),
      modelStatus:
        state.models.find((m) => m.isCurrent)?.id === modelId ? 'downloading' : state.modelStatus,
    }));

    const unsubscribe = window.api.onVoiceDownloadProgress((progress) => {
      const update: Partial<VoiceState> = { downloadProgress: progress };
      if ('status' in progress && progress.status) {
        const status = progress.status as ModelStatus;
        // Update the downloading model's status
        const { models, downloadingModelId } = get();
        update.models = models.map((m) => (m.id === downloadingModelId ? { ...m, status } : m));
        // If this is the current model, update the top-level status too
        const currentModel = models.find((m) => m.isCurrent);
        if (currentModel?.id === downloadingModelId) {
          update.modelStatus = status;
        }
      }
      set(update);
    });

    let failed = false;
    try {
      await window.api.voiceDownloadModel(modelId);
    } catch {
      failed = true;
    } finally {
      // Unsubscribe FIRST so no late progress events overwrite the reload
      unsubscribe();
      set({ downloadingModelId: null, downloadProgress: null });
      // Always reload authoritative state from the service
      try {
        await get().loadModels();
      } catch {
        /* ignore reload errors */
      }
      // Surface error state so the UI shows Retry instead of Download
      if (failed) {
        set((state) => ({
          models: state.models.map((m) =>
            m.id === modelId ? { ...m, status: 'error' as ModelStatus } : m
          ),
          modelStatus:
            state.models.find((m) => m.isCurrent)?.id === modelId ? 'error' : state.modelStatus,
        }));
      }
    }
  },

  deleteModel: async (modelId: string) => {
    await window.api.voiceDeleteModel(modelId);
    // Reload full state from service
    await get().loadModels();
  },

  // The pending downloadModel call then resolves and reloads model state.
  cancelDownload: () => window.api.voiceCancelModelDownload(),

  transcribe: (audio: Float32Array, requestId?: string) =>
    window.api.voiceTranscribe(audio, requestId),

  setRecording: (recording: boolean) => {
    set({ isRecording: recording });
    void window.api.voiceSetRecordingState(recording);
  },

  setStarting: (starting: boolean) => {
    set({ isStarting: starting });
  },
}));
