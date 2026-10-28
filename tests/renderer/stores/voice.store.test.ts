import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useVoiceStore } from '../../../src/renderer/stores/voice.store';

function resetStore(): void {
  useVoiceStore.setState(useVoiceStore.getInitialState(), true);
}

function mockApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const api = {
    voiceGetModelStatus: vi.fn().mockResolvedValue('ready'),
    voiceGetModels: vi.fn().mockResolvedValue([
      {
        id: 'model-v3',
        name: 'V3',
        description: '25 langs',
        sizeMB: 640,
        status: 'ready',
        isCurrent: true,
      },
      {
        id: 'model-v2',
        name: 'V2',
        description: 'English',
        sizeMB: 630,
        status: 'not-downloaded',
        isCurrent: false,
      },
    ]),
    voiceSelectModel: vi.fn().mockResolvedValue(undefined),
    voiceDownloadModel: vi.fn().mockResolvedValue(undefined),
    voiceDeleteModel: vi.fn().mockResolvedValue(undefined),
    voiceCancelModelDownload: vi.fn().mockResolvedValue(undefined),
    voiceTranscribe: vi.fn().mockResolvedValue('transcribed text'),
    voiceSetRecordingState: vi.fn().mockResolvedValue(undefined),
    onVoiceDownloadProgress: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  (globalThis as Record<string, unknown>).window = { api };
  return api;
}

describe('voice.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadModelStatus fetches status from API', async () => {
    await useVoiceStore.getState().loadModelStatus();
    expect(useVoiceStore.getState().modelStatus).toBe('ready');
  });

  it('loadModelStatus handles not-downloaded status', async () => {
    mockApi({ voiceGetModelStatus: vi.fn().mockResolvedValue('not-downloaded') });
    await useVoiceStore.getState().loadModelStatus();
    expect(useVoiceStore.getState().modelStatus).toBe('not-downloaded');
  });

  it('deleteModel calls API and updates status', async () => {
    const api = mockApi({
      voiceGetModels: vi.fn().mockResolvedValue([
        {
          id: 'model-v3',
          name: 'V3',
          description: '25 langs',
          sizeMB: 640,
          status: 'not-downloaded',
          isCurrent: true,
        },
      ]),
    });
    await useVoiceStore.getState().deleteModel('model-v3');
    expect(api.voiceDeleteModel).toHaveBeenCalledWith('model-v3');
    expect(useVoiceStore.getState().modelStatus).toBe('not-downloaded');
  });

  it('cancelDownload asks the main process to stop the download', async () => {
    const api = mockApi();
    await useVoiceStore.getState().cancelDownload();
    expect(api.voiceCancelModelDownload).toHaveBeenCalled();
  });

  it('transcribe sends audio and returns text', async () => {
    const audio = new Float32Array(16000);
    const result = await useVoiceStore.getState().transcribe(audio);
    expect(result).toBe('transcribed text');
  });

  it('setRecording updates recording state and notifies main process', () => {
    const api = mockApi();
    useVoiceStore.getState().setRecording(true);
    expect(useVoiceStore.getState().isRecording).toBe(true);
    expect(api.voiceSetRecordingState).toHaveBeenCalledWith(true);
    useVoiceStore.getState().setRecording(false);
    expect(useVoiceStore.getState().isRecording).toBe(false);
    expect(api.voiceSetRecordingState).toHaveBeenCalledWith(false);
  });

  it('setStarting updates pending recording state without notifying main process', () => {
    const api = mockApi();
    useVoiceStore.getState().setStarting(true);
    expect(useVoiceStore.getState().isStarting).toBe(true);
    expect(api.voiceSetRecordingState).not.toHaveBeenCalled();
    useVoiceStore.getState().setStarting(false);
    expect(useVoiceStore.getState().isStarting).toBe(false);
  });

  describe('downloadModel', () => {
    it('sets error status when download fails', async () => {
      const api = mockApi({
        voiceDownloadModel: vi.fn().mockRejectedValue(new Error('network error')),
        voiceGetModels: vi.fn().mockResolvedValue([
          {
            id: 'model-v3',
            name: 'V3',
            description: '25 langs',
            sizeMB: 640,
            status: 'not-downloaded',
            isCurrent: true,
          },
        ]),
      });

      // Pre-populate models so the optimistic update has something to work with
      await useVoiceStore.getState().loadModels();

      await useVoiceStore.getState().downloadModel('model-v3');

      const state = useVoiceStore.getState();
      // Should show error status (not not-downloaded)
      const model = state.models.find((m) => m.id === 'model-v3');
      expect(model?.status).toBe('error');
      expect(state.modelStatus).toBe('error');
      // Downloading state should be cleaned up
      expect(state.downloadingModelId).toBeNull();
      expect(state.downloadProgress).toBeNull();
      // Unsubscribe should have been called
      expect(api.onVoiceDownloadProgress).toHaveBeenCalled();
    });

    it('unsubscribes from progress before reloading models', async () => {
      const unsubscribe = vi.fn();
      const callOrder: string[] = [];

      mockApi({
        voiceDownloadModel: vi.fn().mockResolvedValue(undefined),
        onVoiceDownloadProgress: vi.fn().mockReturnValue(() => {
          callOrder.push('unsubscribe');
          unsubscribe();
        }),
        voiceGetModels: vi.fn().mockImplementation(() => {
          callOrder.push('loadModels');
          return Promise.resolve([
            {
              id: 'model-v3',
              name: 'V3',
              description: '25 langs',
              sizeMB: 640,
              status: 'ready',
              isCurrent: true,
            },
          ]);
        }),
      });

      // First loadModels call is from pre-population
      await useVoiceStore.getState().loadModels();
      callOrder.length = 0; // reset

      await useVoiceStore.getState().downloadModel('model-v3');

      // unsubscribe should happen before the post-download loadModels
      expect(callOrder[0]).toBe('unsubscribe');
      expect(callOrder[1]).toBe('loadModels');
    });

    it('reloads models after successful download', async () => {
      mockApi({
        voiceDownloadModel: vi.fn().mockResolvedValue(undefined),
        voiceGetModels: vi.fn().mockResolvedValue([
          {
            id: 'model-v3',
            name: 'V3',
            description: '25 langs',
            sizeMB: 640,
            status: 'ready',
            isCurrent: true,
          },
        ]),
      });

      await useVoiceStore.getState().loadModels();
      await useVoiceStore.getState().downloadModel('model-v3');

      const state = useVoiceStore.getState();
      expect(state.models[0].status).toBe('ready');
      expect(state.modelStatus).toBe('ready');
      expect(state.downloadingModelId).toBeNull();
    });
  });
});
