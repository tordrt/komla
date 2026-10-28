import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
  utilityProcess: {
    fork: vi.fn(() => new MockWorker()),
  },
}));

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
    pipe: vi.fn(),
  })),
}));

// Mock the transcriber utility process — each test gets a fresh mock via beforeEach
let workerMessageHandler: ((msg: unknown) => void) | null = null;
let workerExitHandler: ((code: number) => void) | null = null;
const mockWorkerPostMessage = vi.fn();
const mockWorkerKill = vi.fn().mockReturnValue(true);
const mockWorkers: MockWorker[] = [];

// An EventEmitter like the real UtilityProcess, so an unhandled 'error' throws.
class MockWorker extends EventEmitter {
  postMessage = mockWorkerPostMessage;
  kill = mockWorkerKill;
  messageHandler = (msg: unknown) => this.emit('message', msg);
  exitHandler = (code: number) => this.emit('exit', code);
  constructor() {
    super();
    mockWorkers.push(this);
    workerMessageHandler = this.messageHandler;
    workerExitHandler = this.exitHandler;
  }
}

// One second of audible tone; silent buffers are skipped before decoding.
function speechClip(seconds = 1): Float32Array {
  const samples = new Float32Array(16000 * seconds);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.1 * Math.sin(i / 10);
  return samples;
}

const mockExistsSync = vi.mocked(existsSync);

describe('VoiceTranscriptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    workerMessageHandler = null;
    workerExitHandler = null;
    mockWorkers.length = 0;
  });

  describe('getStatus', () => {
    it('should return not-downloaded when model files do not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      expect(voiceTranscriptionService.getStatus()).toBe('not-downloaded');
    });

    it('should return ready when model files exist', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      expect(voiceTranscriptionService.getStatus()).toBe('ready');
    });
  });

  describe('deleteModel', () => {
    it('should delete the model directory and update status', async () => {
      mockExistsSync.mockReturnValue(true);
      const mockRmSync = vi.mocked(rmSync);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // After rmSync, files no longer exist
      mockExistsSync.mockReturnValue(false);
      voiceTranscriptionService.deleteModel();

      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('parakeet-tdt-0.6b-v3-int8'),
        { recursive: true, force: true }
      );
      expect(voiceTranscriptionService.getStatus()).toBe('not-downloaded');
    });
  });

  describe('transcribe', () => {
    it('should spawn worker, load model, and return transcription', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const audio = speechClip();

      // Simulate worker responses for load and transcribe
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        // Respond asynchronously like a real worker would
        setTimeout(() => {
          if (workerMessageHandler) {
            if (msg.type === 'load') {
              workerMessageHandler({ type: 'loaded', id: msg.id });
            } else if (msg.type === 'transcribe') {
              workerMessageHandler({ type: 'transcribed', id: msg.id, text: 'hello world' });
            }
          }
        }, 0);
      });

      const result = await voiceTranscriptionService.transcribe(audio);

      expect(result).toBe('hello world');
      // Should have sent a load message and then a transcribe message
      expect(mockWorkerPostMessage).toHaveBeenCalledTimes(2);
      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'load',
          modelType: 'nemo_transducer',
        })
      );
      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'transcribe', samples: audio })
      );
    });

    it('runs the recognizer in a utility process so a native abort cannot take down main', async () => {
      mockExistsSync.mockReturnValue(true);
      const { utilityProcess } = await import('electron');
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      (mockWorkerPostMessage as Mock).mockImplementation(() => {});

      void voiceTranscriptionService.warmup();

      expect(utilityProcess.fork).toHaveBeenCalledWith(
        expect.stringMatching(/workers[\\/]voice-transcription\.worker\.js$/),
        [],
        expect.objectContaining({ serviceName: 'Komla Voice Transcription' })
      );
    });

    it('returns an empty transcript for silent audio without loading the model', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      await expect(voiceTranscriptionService.transcribe(new Float32Array(16000))).resolves.toBe('');
      await expect(voiceTranscriptionService.transcribe(speechClip(0.3))).resolves.toBe('');
      expect(mockWorkerPostMessage).not.toHaveBeenCalled();
    });

    it('drops a transcript that is only a filler sound', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        setTimeout(() => {
          if (msg.type === 'load') workerMessageHandler?.({ type: 'loaded', id: msg.id });
          else workerMessageHandler?.({ type: 'transcribed', id: msg.id, text: 'Mm.' });
        }, 0);
      });

      await expect(voiceTranscriptionService.transcribe(speechClip())).resolves.toBe('');
    });
  });

  describe('warmup', () => {
    it('should pre-load the model in the worker when status is ready', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        setTimeout(() => {
          if (workerMessageHandler && msg.type === 'load') {
            workerMessageHandler({ type: 'loaded', id: msg.id });
          }
        }, 0);
      });

      await voiceTranscriptionService.warmup();

      expect(mockWorkerPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'load' }));
    });

    it('should not load if model is not downloaded', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      await voiceTranscriptionService.warmup();

      expect(mockWorkerPostMessage).not.toHaveBeenCalled();
    });

    it('should skip if already warmed up', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        setTimeout(() => {
          if (workerMessageHandler && msg.type === 'load') {
            workerMessageHandler({ type: 'loaded', id: msg.id });
          }
        }, 0);
      });

      await voiceTranscriptionService.warmup();
      await voiceTranscriptionService.warmup();

      // Only one load message — second warmup is a no-op
      const loadCalls = (mockWorkerPostMessage as Mock).mock.calls.filter(
        (args: [{ type: string }]) => args[0].type === 'load'
      );
      expect(loadCalls).toHaveLength(1);
    });
  });

  describe('concurrent warmup and transcribe', () => {
    it('should only send one load request when warmup and transcribe race', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const audio = speechClip();

      // Delay the load response so both warmup and transcribe are in-flight
      const pendingLoads: { id: number }[] = [];
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (msg.type === 'load') {
          pendingLoads.push({ id: msg.id });
        } else if (msg.type === 'transcribe') {
          setTimeout(() => {
            if (workerMessageHandler) {
              workerMessageHandler({ type: 'transcribed', id: msg.id, text: 'result' });
            }
          }, 0);
        }
      });

      // Start both concurrently
      const warmupPromise = voiceTranscriptionService.warmup();
      const transcribePromise = voiceTranscriptionService.transcribe(audio);

      // Resolve the single load request
      await new Promise((r) => setTimeout(r, 0));
      expect(pendingLoads).toHaveLength(1);
      workerMessageHandler!({ type: 'loaded', id: pendingLoads[0].id });

      await warmupPromise;
      const result = await transcribePromise;

      expect(result).toBe('result');
      // Only one load message should have been sent
      const loadCalls = (mockWorkerPostMessage as Mock).mock.calls.filter(
        (args: [{ type: string }]) => args[0].type === 'load'
      );
      expect(loadCalls).toHaveLength(1);
    });
  });

  describe('worker crash recovery', () => {
    it('should reject pending requests when worker exits unexpectedly', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // Don't respond to load — leave the request pending
      (mockWorkerPostMessage as Mock).mockImplementation(() => {});

      const warmupPromise = voiceTranscriptionService.warmup();

      // Simulate worker crash
      await new Promise((r) => setTimeout(r, 0));
      workerExitHandler!(1);

      // Warmup should not throw (it catches and logs)
      await warmupPromise;
    });

    it('should reject pending transcription when the transcriber process dies', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const audio = speechClip();

      // Respond to load, but not to transcribe
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (msg.type === 'load') {
          setTimeout(() => {
            workerMessageHandler!({ type: 'loaded', id: msg.id });
          }, 0);
        }
        // transcribe is left pending
      });

      const transcribePromise = voiceTranscriptionService.transcribe(audio);

      // Wait for load to complete, then crash while transcribe is pending
      await new Promise((r) => setTimeout(r, 10));
      workerExitHandler!(134);

      await expect(transcribePromise).rejects.toThrow(
        'The transcriber stopped unexpectedly (exit code 134)'
      );
    });

    it('should respawn worker for next transcription after crash', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // First: load successfully, then crash
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        setTimeout(() => {
          if (workerMessageHandler) {
            if (msg.type === 'load') {
              workerMessageHandler({ type: 'loaded', id: msg.id });
            } else if (msg.type === 'transcribe') {
              workerMessageHandler({ type: 'transcribed', id: msg.id, text: 'first' });
            }
          }
        }, 0);
      });

      const first = await voiceTranscriptionService.transcribe(speechClip());
      expect(first).toBe('first');

      // Simulate crash via exit
      workerExitHandler!(1);

      // Next transcription should respawn and work
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        setTimeout(() => {
          if (workerMessageHandler) {
            if (msg.type === 'load') {
              workerMessageHandler({ type: 'loaded', id: msg.id });
            } else if (msg.type === 'transcribe') {
              workerMessageHandler({ type: 'transcribed', id: msg.id, text: 'second' });
            }
          }
        }, 0);
      });

      const second = await voiceTranscriptionService.transcribe(speechClip());
      expect(second).toBe('second');
    });

    it('should ignore stale exit from an unloaded worker after a new worker starts', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      (mockWorkerPostMessage as Mock).mockImplementation(function (
        this: MockWorker,
        msg: { type: string; id: number }
      ) {
        const worker = this;
        setTimeout(() => {
          if (msg.type === 'load') {
            worker.messageHandler?.({ type: 'loaded', id: msg.id });
          } else if (msg.type === 'transcribe') {
            worker.messageHandler?.({ type: 'transcribed', id: msg.id, text: 'ok' });
          }
        }, 0);
      });

      await expect(voiceTranscriptionService.transcribe(speechClip())).resolves.toBe('ok');
      expect(mockWorkers).toHaveLength(1);

      voiceTranscriptionService.unloadModel();
      const nextTranscription = voiceTranscriptionService.transcribe(speechClip());
      // The old process may still be decoding; a second recognizer beside it
      // would double the memory use.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockWorkers).toHaveLength(1);

      mockWorkers[0].exitHandler(0);

      await expect(nextTranscription).resolves.toBe('ok');
      expect(mockWorkers).toHaveLength(2);
    });
  });

  describe('unloading', () => {
    it('survives a fatal error in the transcriber', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (msg.type === 'load') {
          setTimeout(() => workerMessageHandler?.({ type: 'loaded', id: msg.id }), 0);
        }
      });
      await voiceTranscriptionService.warmup();

      // Electron emits 'error' on a fatal V8 error; an EventEmitter without
      // a listener would throw it in the main process.
      expect(() => mockWorkers[0].emit('error', 'FatalError', 'v8::Heap', '{}')).not.toThrow();
    });

    it('asks the transcriber to exit and only kills it if it does not', async () => {
      vi.useFakeTimers();
      try {
        mockExistsSync.mockReturnValue(true);
        const { voiceTranscriptionService } =
          await import('../../../src/main/services/voice-transcription.service');
        (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
          if (msg.type === 'load') {
            setTimeout(() => workerMessageHandler?.({ type: 'loaded', id: msg.id }), 0);
          }
        });
        const warmup = voiceTranscriptionService.warmup();
        await vi.advanceTimersByTimeAsync(0);
        await warmup;

        voiceTranscriptionService.unloadModel();

        // Electron reports kill() as a crashed child process, so a clean
        // unload must not use it.
        expect(mockWorkerPostMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'unload' })
        );
        expect(mockWorkerKill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockWorkerKill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('cancelling a transcription', () => {
    function answerLoads(): void {
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (msg.type === 'load') {
          setTimeout(() => workerMessageHandler?.({ type: 'loaded', id: msg.id }), 0);
        }
      });
    }
    const posted = (type: string) =>
      (mockWorkerPostMessage as Mock).mock.calls.map(([msg]) => msg).filter((m) => m.type === type);

    it('tells the transcriber to stop decoding it', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      answerLoads();

      const transcription = voiceTranscriptionService.transcribe(speechClip(), 'request-1');
      await vi.waitFor(() => expect(posted('transcribe')).toHaveLength(1));
      const transcribeId = posted('transcribe')[0].id;

      voiceTranscriptionService.cancelTranscription('request-1');

      expect(posted('cancel')).toEqual([expect.objectContaining({ transcribeId })]);
      workerMessageHandler?.({ type: 'transcribed', id: transcribeId, text: '' });
      await expect(transcription).resolves.toBe('');
    });

    it('never starts one cancelled while the model loads', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');
      answerLoads();

      const transcription = voiceTranscriptionService.transcribe(speechClip(), 'request-2');
      voiceTranscriptionService.cancelTranscription('request-2');

      await expect(transcription).resolves.toBe('');
      expect(posted('transcribe')).toEqual([]);
    });
  });

  describe('idle unload during recording', () => {
    it('should unload after the short default idle timeout', async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (!workerMessageHandler) return;
        if (msg.type === 'load') {
          workerMessageHandler({ type: 'loaded', id: msg.id });
        } else if (msg.type === 'transcribe') {
          workerMessageHandler({ type: 'transcribed', id: msg.id, text: 'hello' });
        }
      });

      await voiceTranscriptionService.transcribe(speechClip());

      vi.advanceTimersByTime(10_000);

      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      vi.useRealTimers();
      voiceTranscriptionService.unloadModel();
    });

    it('should not unload the model while transcription is in flight', async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      let pendingLoadId: number | null = null;
      let pendingTranscribeId: number | null = null;
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (!workerMessageHandler) return;
        if (msg.type === 'load') {
          pendingLoadId = msg.id;
        } else if (msg.type === 'transcribe') {
          pendingTranscribeId = msg.id;
        }
      });

      const transcribePromise = voiceTranscriptionService.transcribe(speechClip());
      await Promise.resolve();
      expect(pendingLoadId).not.toBeNull();
      workerMessageHandler!({ type: 'loaded', id: pendingLoadId! });
      await vi.waitFor(() => {
        expect(pendingTranscribeId).not.toBeNull();
      });

      vi.advanceTimersByTime(10_000 + 1_000);
      expect(mockWorkerPostMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      workerMessageHandler!({ type: 'transcribed', id: pendingTranscribeId!, text: 'hello' });
      await expect(transcribePromise).resolves.toBe('hello');

      vi.advanceTimersByTime(10_000);
      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      vi.useRealTimers();
      voiceTranscriptionService.unloadModel();
    });

    it('should not unload the model while another transcription is in flight', async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      let pendingLoadId: number | null = null;
      const pendingTranscribeIds: number[] = [];
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (!workerMessageHandler) return;
        if (msg.type === 'load') {
          pendingLoadId = msg.id;
        } else if (msg.type === 'transcribe') {
          pendingTranscribeIds.push(msg.id);
        }
      });

      const firstTranscribe = voiceTranscriptionService.transcribe(speechClip());
      const secondTranscribe = voiceTranscriptionService.transcribe(speechClip());
      await Promise.resolve();
      expect(pendingLoadId).not.toBeNull();
      workerMessageHandler!({ type: 'loaded', id: pendingLoadId! });
      await vi.waitFor(() => {
        expect(pendingTranscribeIds).toHaveLength(2);
      });

      workerMessageHandler!({ type: 'transcribed', id: pendingTranscribeIds[0], text: 'first' });
      await expect(firstTranscribe).resolves.toBe('first');

      vi.advanceTimersByTime(10_000 + 1_000);
      expect(mockWorkerPostMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      workerMessageHandler!({ type: 'transcribed', id: pendingTranscribeIds[1], text: 'second' });
      await expect(secondTranscribe).resolves.toBe('second');

      vi.advanceTimersByTime(10_000);
      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      vi.useRealTimers();
      voiceTranscriptionService.unloadModel();
    });

    it('should restore idle unload after a transcription error', async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      let pendingLoadId: number | null = null;
      let pendingTranscribeId: number | null = null;
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (!workerMessageHandler) return;
        if (msg.type === 'load') {
          pendingLoadId = msg.id;
        } else if (msg.type === 'transcribe') {
          pendingTranscribeId = msg.id;
        }
      });

      const transcribePromise = voiceTranscriptionService.transcribe(speechClip());
      await Promise.resolve();
      expect(pendingLoadId).not.toBeNull();
      workerMessageHandler!({ type: 'loaded', id: pendingLoadId! });
      await vi.waitFor(() => {
        expect(pendingTranscribeId).not.toBeNull();
      });

      workerMessageHandler!({ type: 'error', id: pendingTranscribeId!, message: 'decode failed' });
      await expect(transcribePromise).rejects.toThrow('decode failed');

      vi.advanceTimersByTime(10_000);
      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      vi.useRealTimers();
      voiceTranscriptionService.unloadModel();
    });

    it('should not unload the model while recording is active', async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // Respond to worker messages synchronously (no setTimeout) since fake
      // timers are active and we control time advancement ourselves.
      (mockWorkerPostMessage as Mock).mockImplementation((msg: { type: string; id: number }) => {
        if (workerMessageHandler) {
          if (msg.type === 'load') {
            workerMessageHandler({ type: 'loaded', id: msg.id });
          } else if (msg.type === 'transcribe') {
            workerMessageHandler({ type: 'transcribed', id: msg.id, text: 'hello' });
          } else if (msg.type === 'unload') {
            // The real transcriber exits when told to unload.
            mockWorkers.at(-1)!.exitHandler(0);
          }
        }
      });

      // Transcribe to load the worker and start idle timer
      const audio = speechClip();
      await voiceTranscriptionService.transcribe(audio);

      // Worker was spawned once (one load message sent)
      const loadCallsBefore = (mockWorkerPostMessage as Mock).mock.calls.filter(
        (args: [{ type: string }]) => args[0].type === 'load'
      );
      expect(loadCallsBefore).toHaveLength(1);

      // Start recording — should suppress idle unload
      voiceTranscriptionService.setRecordingState(true);

      // Advance well past the idle timeout
      vi.advanceTimersByTime(60_000 + 1_000);

      // Worker should still be alive — transcribe should not need to reload
      await voiceTranscriptionService.transcribe(audio);
      const loadCallsDuring = (mockWorkerPostMessage as Mock).mock.calls.filter(
        (args: [{ type: string }]) => args[0].type === 'load'
      );
      expect(loadCallsDuring).toHaveLength(1); // still just the initial load

      // Stop recording — idle timer should start now
      voiceTranscriptionService.setRecordingState(false);

      // Advance past the idle timeout — worker should be terminated
      vi.advanceTimersByTime(10_000 + 1_000);

      // terminate should have been called
      expect(mockWorkerPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unload' })
      );

      // Next transcribe should respawn and reload
      await voiceTranscriptionService.transcribe(audio);
      const loadCallsAfter = (mockWorkerPostMessage as Mock).mock.calls.filter(
        (args: [{ type: string }]) => args[0].type === 'load'
      );
      expect(loadCallsAfter).toHaveLength(2); // initial + reload after unload

      vi.useRealTimers();
      voiceTranscriptionService.unloadModel();
    });
  });

  describe('getAvailableModels', () => {
    it('should return all available models', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const models = voiceTranscriptionService.getAvailableModels();
      expect(models).toHaveLength(3);
      expect(models[0].id).toBe('parakeet-tdt-0.6b-v3-int8');
      expect(models[1].id).toBe('parakeet-tdt-0.6b-v2-int8');
      expect(models[2].id).toBe('parakeet-tdt-ctc-110m-int8');
    });

    it('should list verified model URLs', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const models = voiceTranscriptionService.getAvailableModels();
      expect(models[0].urls).toEqual([
        'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.gz',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
      ]);
      expect(models[1].urls).toEqual([
        'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.gz',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
      ]);
      expect(models[2].urls).toEqual([
        'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.gz',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
      ]);
    });
  });

  describe('extractTarArchive strip-components detection', () => {
    it('should use gzip tar flags and strip-components=1 for archives without ./ prefix', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // Mock execFile: first call lists archive, second extracts
      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) {
            if (args.includes('-tzf') || args.includes('-tf')) {
              cb(null, { stdout: 'model-dir/\nmodel-dir/file.onnx\n', stderr: '' });
            } else {
              cb(null, { stdout: '', stderr: '' });
            }
          }
        }
      );

      // Access private method via any cast for testing
      await (voiceTranscriptionService as any).extractTarArchive('/tmp/test.tar.gz', '/tmp/dest');

      // The extract call should use --strip-components=1
      const extractCall = mockExecFile.mock.calls.find(
        (call: unknown[]) =>
          !(call[1] as string[]).includes('-tzf') && !(call[1] as string[]).includes('-tf')
      );
      expect(extractCall).toBeDefined();
      expect(extractCall![1]).toContain('-xzf');
      expect(extractCall![1]).toContain('--strip-components=1');
    });

    it('should use bzip2 tar flags and strip-components=2 for archives with ./ prefix', async () => {
      mockExistsSync.mockReturnValue(true);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) {
            if (args.includes('-tjf') || args.includes('-tf')) {
              cb(null, { stdout: './model-dir/\n./model-dir/file.onnx\n', stderr: '' });
            } else {
              cb(null, { stdout: '', stderr: '' });
            }
          }
        }
      );

      await (voiceTranscriptionService as any).extractTarArchive('/tmp/test.tar.bz2', '/tmp/dest');

      const extractCall = mockExecFile.mock.calls.find(
        (call: unknown[]) =>
          !(call[1] as string[]).includes('-tjf') && !(call[1] as string[]).includes('-tf')
      );
      expect(extractCall).toBeDefined();
      expect(extractCall![1]).toContain('-xjf');
      expect(extractCall![1]).toContain('--strip-components=2');
    });
  });

  describe('post-extraction verification', () => {
    it('removes stale temporary download directories on startup', async () => {
      vi.mocked(readdirSync).mockImplementation((path) => {
        if (String(path).endsWith('/models')) {
          return [
            '.parakeet-tdt-ctc-110m-int8.download-123-456',
            'parakeet-tdt-ctc-110m-int8.old-123-456',
            'parakeet-tdt-ctc-110m-int8',
            '.unrelated.download-123-456',
            'unrelated.old-123-456',
          ] as any;
        }
        return [] as any;
      });

      await import('../../../src/main/services/voice-transcription.service');

      expect(vi.mocked(rmSync)).toHaveBeenCalledWith(
        expect.stringContaining('.parakeet-tdt-ctc-110m-int8.download-123-456'),
        { recursive: true, force: true }
      );
      expect(vi.mocked(rmSync)).toHaveBeenCalledWith(
        expect.stringContaining('parakeet-tdt-ctc-110m-int8.old-123-456'),
        { recursive: true, force: true }
      );
      expect(vi.mocked(rmSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('.unrelated.download-123-456'),
        expect.anything()
      );
      expect(vi.mocked(rmSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('unrelated.old-123-456'),
        expect.anything()
      );
    });

    it('should throw when expected model files are missing after extraction', async () => {
      // Start with files not existing so download proceeds
      mockExistsSync.mockReturnValue(false);
      const mockReaddirSync = vi.mocked(readdirSync);

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // Mock fetch for the download
      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => '3' },
          body: { getReader: () => mockReader },
        })
      );

      // Mock createWriteStream
      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

      // Mock tar extraction (succeeds but files are missing)
      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );

      // After extraction, readdirSync shows wrong files, existsSync still false for expected files
      mockReaddirSync.mockReturnValue(['wrong-file.txt'] as any);

      await expect(
        voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8')
      ).rejects.toThrow('Model files missing after extraction');

      vi.unstubAllGlobals();
    });

    it('extracts into a temporary directory before publishing the model', async () => {
      mockExistsSync.mockImplementation((path) => {
        const pathString = String(path);
        return (
          pathString.includes('.download-') &&
          (pathString.endsWith('model.int8.onnx') || pathString.endsWith('tokens.txt'))
        );
      });
      vi.mocked(readdirSync).mockReturnValue(['model.int8.onnx', 'tokens.txt'] as any);

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => '3' },
          body: { getReader: () => mockReader },
        })
      );

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );

      await voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');

      const mockRenameSync = vi.mocked(renameSync);
      const finalDir = mockRenameSync.mock.calls[0][1] as string;
      const tempDir = mockRenameSync.mock.calls[0][0] as string;
      expect(tempDir).toContain('.download-');
      expect(finalDir).toContain('parakeet-tdt-ctc-110m-int8');
      expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(tempDir, { recursive: true });
      expect(mockExecFile.mock.calls.at(-1)?.[1]).toContain('-C');
      expect(mockExecFile.mock.calls.at(-1)?.[1]).toContain(tempDir);

      vi.unstubAllGlobals();
    });

    it('downloads from the Komla-hosted model URL first', async () => {
      mockExistsSync.mockImplementation((path) => {
        const pathString = String(path);
        return (
          pathString.includes('.download-') &&
          (pathString.endsWith('model.int8.onnx') || pathString.endsWith('tokens.txt'))
        );
      });
      vi.mocked(readdirSync).mockImplementation((path) => {
        if (String(path).endsWith('/models')) return [] as any;
        return ['model.int8.onnx', 'tokens.txt'] as any;
      });

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => '3' },
        body: { getReader: () => mockReader },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);
      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );

      await voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.gz',
        expect.any(Object)
      );

      vi.unstubAllGlobals();
    });

    it('falls back to GitHub when the Komla-hosted model URL fails', async () => {
      mockExistsSync.mockImplementation((path) => {
        const pathString = String(path);
        return (
          pathString.includes('.download-') &&
          (pathString.endsWith('model.int8.onnx') || pathString.endsWith('tokens.txt'))
        );
      });
      vi.mocked(readdirSync).mockImplementation((path) => {
        if (String(path).endsWith('/models')) return [] as any;
        return ['model.int8.onnx', 'tokens.txt'] as any;
      });

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => '3' },
          body: { getReader: () => mockReader },
        });
      vi.stubGlobal('fetch', mockFetch);

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);
      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );

      await voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://downloads.getbaton.dev/models/voice/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.gz'
      );
      expect(mockFetch.mock.calls[1][0]).toBe(
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2'
      );

      vi.unstubAllGlobals();
    });

    it('returns the in-flight promise when the same model download is requested twice', async () => {
      mockExistsSync.mockImplementation((path) => {
        const pathString = String(path);
        return (
          pathString.includes('.download-') &&
          (pathString.endsWith('model.int8.onnx') || pathString.endsWith('tokens.txt'))
        );
      });
      vi.mocked(readdirSync).mockReturnValue(['model.int8.onnx', 'tokens.txt'] as any);

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValue({ done: true, value: undefined }),
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => '3' },
        body: { getReader: () => mockReader },
      });
      vi.stubGlobal('fetch', mockFetch);

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );

      const first = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');
      const second = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      await Promise.all([first, second]);

      vi.unstubAllGlobals();
    });

    it('rejects a different model while another download is in flight', async () => {
      mockExistsSync.mockImplementation((path) => {
        const pathString = String(path);
        return (
          pathString.includes('.download-') &&
          (pathString.endsWith('model.int8.onnx') || pathString.endsWith('tokens.txt'))
        );
      });
      vi.mocked(readdirSync).mockImplementation((path) => {
        if (String(path).endsWith('/models')) return [] as any;
        return ['model.int8.onnx', 'tokens.txt'] as any;
      });

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      let resolveRead: ((value: { done: boolean; value?: Uint8Array }) => void) | null = null;
      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockImplementationOnce(
            () =>
              new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                resolveRead = resolve;
              })
          )
          .mockResolvedValue({ done: true, value: undefined }),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => '3' },
          body: { getReader: () => mockReader },
        })
      );

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);
      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );

      const first = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');

      await vi.waitFor(() => {
        expect(resolveRead).toBeTypeOf('function');
      });

      await expect(
        voiceTranscriptionService.downloadModel('parakeet-tdt-0.6b-v2-int8')
      ).rejects.toThrow(
        'Cannot download parakeet-tdt-0.6b-v2-int8: parakeet-tdt-ctc-110m-int8 is already downloading'
      );

      resolveRead?.({ done: true });
      await first;

      vi.unstubAllGlobals();
    });

    it('cleans up only the temporary directory when a download is aborted', async () => {
      mockExistsSync.mockReturnValue(false);

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockRejectedValue(abortError),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => '3' },
          body: { getReader: () => mockReader },
        })
      );

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
        once: vi.fn((event: string, handler: () => void) => {
          if (event === 'close') queueMicrotask(handler);
        }),
        destroy: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

      await voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');

      const removedDirs = vi
        .mocked(rmSync)
        .mock.calls.map((call) => String(call[0]))
        .filter((path) => path.includes('parakeet-tdt-ctc-110m-int8'));
      expect(removedDirs).toEqual(
        expect.arrayContaining([expect.stringContaining('.download-')])
      );
      expect(removedDirs).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/models\/parakeet-tdt-ctc-110m-int8$/)])
      );

      vi.unstubAllGlobals();
    });

    describe('download failures', () => {
      // A body reader that delivers one chunk, then waits until the fetch is aborted.
      function hangingFetch() {
        return vi.fn((_url: string, init: { signal: AbortSignal }) => {
          let delivered = false;
          return Promise.resolve({
            ok: true,
            headers: { get: () => '1000' },
            body: {
              getReader: () => ({
                cancel: () => Promise.resolve(),
                read: () => {
                  if (!delivered) {
                    delivered = true;
                    return Promise.resolve({ done: false, value: new Uint8Array(10) });
                  }
                  return new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => {
                      const err = new Error('aborted');
                      err.name = 'AbortError';
                      reject(err);
                    });
                  });
                },
              }),
            },
          });
        });
      }

      async function mockStream(overrides: Record<string, unknown> = {}) {
        const { createWriteStream } = await import('fs');
        const closeHandlers: Array<() => void> = [];
        const stream = {
          write: vi.fn().mockReturnValue(true),
          end: vi.fn((cb: () => void) => cb()),
          on: vi.fn(),
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'close') closeHandlers.push(handler);
          }),
          // Like fs.WriteStream, the file closes a little after destroy().
          destroy: vi.fn(() => queueMicrotask(() => closeHandlers.forEach((close) => close()))),
          ...overrides,
        };
        vi.mocked(createWriteStream).mockReturnValue(stream as any);
        return stream;
      }

      it('rejects instead of crashing when the archive cannot be written', async () => {
        mockExistsSync.mockReturnValue(false);
        const { voiceTranscriptionService } =
          await import('../../../src/main/services/voice-transcription.service');
        vi.stubGlobal('fetch', hangingFetch());
        const errorHandlers: Array<(err: Error) => void> = [];
        await mockStream({
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') errorHandlers.push(handler);
          }),
          // Disk full: the write fails and 'drain' never comes.
          write: vi.fn(() => {
            const err = Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            });
            queueMicrotask(() => errorHandlers.forEach((handler) => handler(err)));
            return false;
          }),
        });

        await expect(
          voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8')
        ).rejects.toThrow('ENOSPC');
        expect(errorHandlers.length).toBeGreaterThan(0);
        expect(vi.mocked(rmSync)).toHaveBeenCalledWith(expect.stringContaining('.download-'), {
          recursive: true,
          force: true,
        });
        vi.unstubAllGlobals();
      });

      it('fails with a clear error when the download stalls', async () => {
        vi.useFakeTimers();
        try {
          mockExistsSync.mockReturnValue(false);
          const { voiceTranscriptionService } =
            await import('../../../src/main/services/voice-transcription.service');
          vi.stubGlobal('fetch', hangingFetch());
          await mockStream();

          const download = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');
          const outcome = expect(download).rejects.toThrow(/stalled/i);
          await vi.advanceTimersByTimeAsync(30_000);
          await outcome;
        } finally {
          vi.useRealTimers();
          vi.unstubAllGlobals();
        }
      });

      it('tries the next source when one does not answer', async () => {
        vi.useFakeTimers();
        try {
          mockExistsSync.mockReturnValue(false);
          const { voiceTranscriptionService } =
            await import('../../../src/main/services/voice-transcription.service');
          const hanging = hangingFetch();
          const fetchMock = vi
            .fn()
            // No response headers at all until aborted.
            .mockImplementationOnce(
              (_url: string, init: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) =>
                  init.signal.addEventListener('abort', () => reject(init.signal.reason))
                )
            )
            .mockImplementation(hanging);
          vi.stubGlobal('fetch', fetchMock);
          await mockStream();

          const download = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');
          const outcome = expect(download).rejects.toThrow(/stalled/i);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(fetchMock.mock.calls[1][0]).toContain('github.com');
          await vi.advanceTimersByTimeAsync(30_000);
          await outcome;
        } finally {
          vi.useRealTimers();
          vi.unstubAllGlobals();
        }
      });

      it('deletes the partial archive only after it is closed', async () => {
        mockExistsSync.mockReturnValue(false);
        const { voiceTranscriptionService } =
          await import('../../../src/main/services/voice-transcription.service');
        vi.stubGlobal('fetch', hangingFetch());
        let close: () => void = () => {};
        const stream = await mockStream({ destroy: vi.fn() });
        stream.once.mockImplementation((event: string, handler: () => void) => {
          if (event === 'close') close = handler;
        });

        const download = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const removals = () =>
          vi.mocked(rmSync).mock.calls.filter(([path]) => String(path).includes('.download-'))
            .length;
        const removalsBefore = removals();
        voiceTranscriptionService.cancelDownload();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Windows can't delete a file that is still open.
        expect(stream.destroy).toHaveBeenCalled();
        expect(removals()).toBe(removalsBefore);
        close();
        await expect(download).resolves.toBeUndefined();
        expect(removals()).toBe(removalsBefore + 1);
        vi.unstubAllGlobals();
      });

      it('resolves without publishing when the user cancels', async () => {
        mockExistsSync.mockReturnValue(false);
        const { voiceTranscriptionService } =
          await import('../../../src/main/services/voice-transcription.service');
        vi.stubGlobal('fetch', hangingFetch());
        await mockStream();

        const download = voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8');
        await new Promise((resolve) => setTimeout(resolve, 0));
        voiceTranscriptionService.cancelDownload();

        await expect(download).resolves.toBeUndefined();
        expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
        expect(voiceTranscriptionService.getStatusForModel('parakeet-tdt-ctc-110m-int8')).toBe(
          'not-downloaded'
        );
        vi.unstubAllGlobals();
      });
    });

    it('moves an existing model aside and restores it if publishing fails', async () => {
      mockExistsSync.mockImplementation((path) => {
        const pathString = String(path);
        if (pathString.endsWith('/models/parakeet-tdt-ctc-110m-int8')) return true;
        return (
          pathString.includes('.download-') &&
          (pathString.endsWith('model.int8.onnx') || pathString.endsWith('tokens.txt'))
        );
      });
      vi.mocked(readdirSync).mockImplementation((path) => {
        if (String(path).endsWith('/models')) return [] as any;
        return ['model.int8.onnx', 'tokens.txt'] as any;
      });

      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const mockReader = {
        cancel: vi.fn().mockResolvedValue(undefined),
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => '3' },
          body: { getReader: () => mockReader },
        })
      );

      const { createWriteStream } = await import('fs');
      const mockStream = {
        write: vi.fn().mockReturnValue(true),
        end: vi.fn((cb: () => void) => cb()),
        on: vi.fn(),
      };
      vi.mocked(createWriteStream).mockReturnValue(mockStream as any);

      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          opts: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (cb) cb(null, { stdout: 'dir/\n', stderr: '' });
        }
      );
      vi.mocked(renameSync)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error('rename failed');
        })
        .mockImplementationOnce(() => undefined);

      await expect(
        voiceTranscriptionService.downloadModel('parakeet-tdt-ctc-110m-int8')
      ).rejects.toThrow('rename failed');

      const renameCalls = vi.mocked(renameSync).mock.calls;
      const modelDir = renameCalls[0][0] as string;
      const backupDir = renameCalls[0][1] as string;
      expect(modelDir).toMatch(/models\/parakeet-tdt-ctc-110m-int8$/);
      expect(backupDir).toContain('.old-');
      expect(renameCalls[1]).toEqual([expect.stringContaining('.download-'), modelDir]);
      expect(renameCalls[2]).toEqual([backupDir, modelDir]);

      vi.unstubAllGlobals();
    });
  });

  describe('selectModel', () => {
    it('should change the current model and update config', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      // Default current model is the first one
      expect(voiceTranscriptionService.getCurrentModelId()).toBe('parakeet-tdt-0.6b-v3-int8');

      voiceTranscriptionService.selectModel('parakeet-tdt-ctc-110m-int8');

      expect(voiceTranscriptionService.getCurrentModelId()).toBe('parakeet-tdt-ctc-110m-int8');
    });

    it('should throw for unknown model ID', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      expect(() => voiceTranscriptionService.selectModel('nonexistent')).toThrow('Unknown model');
    });
  });

  describe('getModelsWithStatus', () => {
    it('should mark the current model with isCurrent', async () => {
      mockExistsSync.mockReturnValue(false);
      const { voiceTranscriptionService } =
        await import('../../../src/main/services/voice-transcription.service');

      const models = voiceTranscriptionService.getModelsWithStatus();
      const current = models.find((m) => m.isCurrent);
      expect(current).toBeDefined();
      expect(current!.id).toBe('parakeet-tdt-0.6b-v3-int8');

      // After selecting a different model
      voiceTranscriptionService.selectModel('parakeet-tdt-ctc-110m-int8');
      const models2 = voiceTranscriptionService.getModelsWithStatus();
      const current2 = models2.find((m) => m.isCurrent);
      expect(current2!.id).toBe('parakeet-tdt-ctc-110m-int8');
    });
  });
});
