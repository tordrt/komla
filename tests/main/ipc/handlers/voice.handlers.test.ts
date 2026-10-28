import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockVoiceService = {
  getStatus: vi.fn(() => 'ready'),
  getStatusForModel: vi.fn(() => 'downloading'),
  getAvailableModels: vi.fn(() => [
    { id: 'model-a', name: 'A', sizeMB: 640, description: '', files: {} },
  ]),
  getModelsWithStatus: vi.fn(() => [
    { id: 'model-a', name: 'A', sizeMB: 640, status: 'ready', isCurrent: true },
  ]),
  selectModel: vi.fn(),
  downloadModel: vi.fn(),
  deleteModel: vi.fn(),
  cancelDownload: vi.fn(),
  cancelTranscription: vi.fn(),
  warmup: vi.fn(),
  transcribe: vi.fn(),
  setRecordingState: vi.fn(),
};

const mockWindowService = {
  broadcastToAll: vi.fn(),
};

vi.mock('../../../../src/main/services/voice-transcription.service', () => ({
  voiceTranscriptionService: mockVoiceService,
}));

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: mockWindowService,
}));

describe('voice IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockVoiceService.getStatus.mockReturnValue('ready');
    mockVoiceService.getStatusForModel.mockReturnValue('downloading');
    mockVoiceService.getAvailableModels.mockReturnValue([
      { id: 'model-a', name: 'A', sizeMB: 640, description: '', files: {} },
    ]);
    mockVoiceService.downloadModel.mockResolvedValue(undefined);
    mockVoiceService.transcribe.mockResolvedValue('hello world');
    mockVoiceService.warmup.mockResolvedValue(undefined);
  });

  async function setup() {
    const { registerVoiceHandlers } =
      await import('../../../../src/main/ipc/handlers/voice.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerVoiceHandlers();
    return { ipcMain };
  }

  describe('voice:model-download', () => {
    it('broadcasts progress with correct MB values during download', async () => {
      mockVoiceService.getStatusForModel.mockReturnValue('downloading');
      mockVoiceService.downloadModel.mockImplementation(
        async (
          _id: string,
          onProgress?: (bytes: number, total: number) => void,
          _onStatus?: (status: string) => void
        ) => {
          onProgress?.(50 * 1024 * 1024, 640 * 1024 * 1024);
        }
      );

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      // Progress broadcast during download
      expect(mockWindowService.broadcastToAll).toHaveBeenCalledWith(
        'voice:model-download-progress',
        expect.objectContaining({
          percent: expect.any(Number),
          downloadedMB: 50,
          totalMB: 640,
          status: 'downloading',
        })
      );
    });

    it('falls back to model sizeMB when Content-Length is 0', async () => {
      mockVoiceService.getStatusForModel.mockReturnValue('downloading');
      mockVoiceService.downloadModel.mockImplementation(
        async (
          _id: string,
          onProgress?: (bytes: number, total: number) => void,
          _onStatus?: (status: string) => void
        ) => {
          // totalBytes = 0 simulates missing Content-Length
          onProgress?.(320 * 1024 * 1024, 0);
        }
      );

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      expect(mockWindowService.broadcastToAll).toHaveBeenCalledWith(
        'voice:model-download-progress',
        expect.objectContaining({
          totalMB: 640, // falls back to model.sizeMB
          percent: 50,
        })
      );
    });

    it('broadcasts extracting phase via onStatusChange callback', async () => {
      mockVoiceService.downloadModel.mockImplementation(
        async (
          _id: string,
          _onProgress?: (bytes: number, total: number) => void,
          onStatusChange?: (status: string) => void
        ) => {
          onStatusChange?.('extracting');
        }
      );

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      expect(mockWindowService.broadcastToAll).toHaveBeenCalledWith(
        'voice:model-download-progress',
        expect.objectContaining({
          percent: 100,
          status: 'extracting',
        })
      );
    });

    it('auto-selects model when no model is currently ready', async () => {
      mockVoiceService.getStatus.mockReturnValue('not-downloaded');
      mockVoiceService.getStatusForModel.mockReturnValue('ready');

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      expect(mockVoiceService.selectModel).toHaveBeenCalledWith('model-a');
    });

    it('does not auto-select a model whose download was cancelled', async () => {
      mockVoiceService.getStatus.mockReturnValue('not-downloaded');
      mockVoiceService.getStatusForModel.mockReturnValue('not-downloaded');

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      expect(mockVoiceService.selectModel).not.toHaveBeenCalled();
    });

    it('throttles progress broadcasts to a few per second', async () => {
      mockVoiceService.downloadModel.mockImplementation(
        async (_id: string, onProgress?: (bytes: number, total: number) => void) => {
          for (let i = 1; i <= 1000; i++) onProgress?.(i * 65536, 1000 * 65536);
        }
      );

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      // First chunk plus the final status event, not one per chunk.
      expect(mockWindowService.broadcastToAll.mock.calls.length).toBeLessThan(5);
    });

    it('does not auto-select model when a model is already ready', async () => {
      mockVoiceService.getStatus.mockReturnValue('ready');

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      expect(mockVoiceService.selectModel).not.toHaveBeenCalled();
    });

    it('sends final progress event with current model status', async () => {
      mockVoiceService.getStatusForModel.mockReturnValue('ready');

      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download', 'model-a');

      // Last broadcastToAll call should be the final status event
      const calls = mockWindowService.broadcastToAll.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('voice:model-download-progress');
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          percent: 100,
          status: 'ready',
        })
      );
    });

    it('propagates download errors to the caller', async () => {
      mockVoiceService.downloadModel.mockRejectedValue(new Error('network error'));

      const { ipcMain } = await setup();
      await expect(ipcMain._invoke('voice:model-download', 'model-a')).rejects.toThrow(
        'network error'
      );
    });
  });

  describe('voice:model-download-cancel', () => {
    it('cancels the in-flight download', async () => {
      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-download-cancel');

      expect(mockVoiceService.cancelDownload).toHaveBeenCalled();
    });
  });

  describe('voice:model-status', () => {
    it('returns current model status', async () => {
      mockVoiceService.getStatus.mockReturnValue('not-downloaded');
      const { ipcMain } = await setup();
      const result = await ipcMain._invoke('voice:model-status');
      expect(result).toBe('not-downloaded');
    });
  });

  describe('voice:models-list', () => {
    it('returns models with status', async () => {
      const { ipcMain } = await setup();
      const result = await ipcMain._invoke('voice:models-list');
      expect(result).toEqual([
        { id: 'model-a', name: 'A', sizeMB: 640, status: 'ready', isCurrent: true },
      ]);
    });
  });

  describe('voice:model-select', () => {
    it('delegates to service', async () => {
      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-select', 'model-a');
      expect(mockVoiceService.selectModel).toHaveBeenCalledWith('model-a');
    });
  });

  describe('voice:model-delete', () => {
    it('delegates to service', async () => {
      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:model-delete', 'model-a');
      expect(mockVoiceService.deleteModel).toHaveBeenCalledWith('model-a');
    });
  });

  describe('voice:transcribe', () => {
    it('returns transcription text', async () => {
      const { ipcMain } = await setup();
      const audio = new Float32Array(16000);
      const result = await ipcMain._invoke('voice:transcribe', audio);
      expect(result).toBe('hello world');
      expect(mockVoiceService.transcribe).toHaveBeenCalledWith(audio, undefined);
    });

    it('passes the request ID along so the renderer can cancel it', async () => {
      const { ipcMain } = await setup();
      const audio = new Float32Array([0.5]);
      await ipcMain._invoke('voice:transcribe', { samples: audio.buffer, requestId: 'r1' });
      await ipcMain._invoke('voice:transcribe-cancel', 'r1');
      await ipcMain._invoke('voice:transcribe-cancel', 42);

      expect(mockVoiceService.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), 'r1');
      expect(mockVoiceService.cancelTranscription).toHaveBeenCalledTimes(1);
      expect(mockVoiceService.cancelTranscription).toHaveBeenCalledWith('r1');
    });

    it('re-wraps deserialized Float32Array from IPC', async () => {
      const { ipcMain } = await setup();
      // Simulate Electron IPC deserializing Float32Array as a plain object
      const fakeArray = { 0: 0.5, 1: -0.3, 2: 0.1 };
      await ipcMain._invoke('voice:transcribe', fakeArray);

      const passedArg = mockVoiceService.transcribe.mock.calls[0][0];
      expect(passedArg).toBeInstanceOf(Float32Array);
      expect(passedArg[0]).toBeCloseTo(0.5);
      expect(passedArg[1]).toBeCloseTo(-0.3);
    });

    it('re-wraps ArrayBuffer sample payloads without object conversion', async () => {
      const { ipcMain } = await setup();
      const audio = new Float32Array([0.5, -0.3, 0.1]);
      await ipcMain._invoke('voice:transcribe', { samples: audio.buffer });

      const passedArg = mockVoiceService.transcribe.mock.calls[0][0];
      expect(passedArg).toBeInstanceOf(Float32Array);
      expect(Array.from(passedArg)).toEqual([0.5, -0.30000001192092896, 0.10000000149011612]);
    });
  });

  describe('voice:recording-state', () => {
    it('delegates to service', async () => {
      const { ipcMain } = await setup();
      await ipcMain._invoke('voice:recording-state', true);
      expect(mockVoiceService.setRecordingState).toHaveBeenCalledWith(true);
    });
  });
});
