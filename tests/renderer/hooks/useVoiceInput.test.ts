// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useVoiceInput, WAVEFORM_LENGTH } from '../../../src/renderer/hooks/useVoiceInput';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useVoiceStore } from '../../../src/renderer/stores/voice.store';

// Use vi.hoisted so mock fns are available inside the hoisted vi.mock factory
const { mockStop, mockGetLevel, mockCancel } = vi.hoisted(() => ({
  mockStop: vi.fn().mockReturnValue(new Float32Array(16000)),
  mockGetLevel: vi.fn().mockReturnValue(0.05),
  mockCancel: vi.fn(),
}));

vi.mock('../../../src/renderer/lib/audio-capture', () => ({
  startAudioCapture: vi.fn().mockResolvedValue({
    stop: mockStop,
    getLevel: mockGetLevel,
    cancel: mockCancel,
  }),
}));

function mockApi(): void {
  global.window.api = {
    voiceRequestMicAccess: vi.fn().mockResolvedValue(true),
    voiceWarmup: vi.fn().mockResolvedValue(undefined),
    voiceTranscribe: vi.fn().mockResolvedValue('hello world'),
    voiceCancelTranscription: vi.fn().mockResolvedValue(undefined),
    voiceGetModelStatus: vi.fn().mockResolvedValue('ready'),
    voiceGetModels: vi.fn().mockResolvedValue([]),
    voiceSelectModel: vi.fn(),
    voiceDownloadModel: vi.fn(),
    voiceDeleteModel: vi.fn(),
    onVoiceDownloadProgress: vi.fn().mockReturnValue(() => {}),
    voiceSetRecordingState: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.api;
}

describe('useVoiceInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockApi();
    useVoiceStore.setState(useVoiceStore.getInitialState(), true);
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts recording and sets state', async () => {
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    expect(result.current.isRecording).toBe(false);

    await act(async () => {
      result.current.startRecording();
    });

    expect(result.current.isRecording).toBe(true);
    expect(useVoiceStore.getState().isRecording).toBe(true);
  });

  it('does not start a second recording while one is active', async () => {
    const onTranscription = vi.fn();
    // Simulate another recording already active via the store
    useVoiceStore.setState({ isRecording: true });

    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    await act(async () => {
      result.current.startRecording();
    });

    // Should remain not-recording locally since the mutex blocked it
    expect(result.current.isRecording).toBe(false);
  });

  it('stops recording and calls onTranscription', async () => {
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    await act(async () => {
      result.current.startRecording();
    });

    await act(async () => {
      result.current.stopAndTranscribe();
    });

    expect(result.current.isRecording).toBe(false);
    expect(onTranscription).toHaveBeenCalledWith('hello world', undefined, { morePending: false });
  });

  it('cancels recording without transcribing', async () => {
    const onTranscription = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription, onCancel }));

    await act(async () => {
      result.current.startRecording();
    });

    act(() => {
      result.current.cancelRecording();
    });

    expect(result.current.isRecording).toBe(false);
    expect(mockCancel).toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('keeps the last 0.8 seconds of mic levels for the waveform', async () => {
    const { result } = renderHook(() => useVoiceInput({ onTranscription: vi.fn() }));
    await act(async () => {
      result.current.startRecording();
    });
    const levels = () => result.current.levels.getSnapshot();
    expect(levels()).toEqual([]);

    mockGetLevel.mockReturnValue(0.05);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(levels()).toHaveLength(5);
    expect(levels().at(-1)).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(levels()).toHaveLength(WAVEFORM_LENGTH);

    act(() => result.current.cancelRecording());
    expect(levels()).toEqual([]);
  });

  it('updates mic levels without re-rendering the component that records', async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useVoiceInput({ onTranscription: vi.fn() });
    });
    await act(async () => {
      result.current.startRecording();
    });
    const rendersWhileRecording = renders;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(renders).toBe(rendersWhileRecording);
    expect(result.current.levels.getSnapshot()).toHaveLength(4);
  });

  it('tracks recording duration', async () => {
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    await act(async () => {
      result.current.startRecording();
    });

    expect(result.current.duration).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.duration).toBe(3);
  });

  it('resets duration immediately when starting a new recording', async () => {
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    await act(async () => {
      result.current.startRecording();
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.duration).toBe(3);

    await act(async () => {
      result.current.stopAndTranscribe();
    });

    let resolveMic!: (value: unknown) => void;
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMic = resolve;
      })
    );

    act(() => {
      result.current.startRecording();
    });

    expect(result.current.isRecording).toBe(false);
    expect(result.current.duration).toBe(0);

    await act(async () => {
      resolveMic({ stop: mockStop, getLevel: mockGetLevel, cancel: mockCancel });
    });

    expect(result.current.isRecording).toBe(true);
  });

  it('cleans up on unmount while recording', async () => {
    const onTranscription = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceInput({ onTranscription }));

    await act(async () => {
      result.current.startRecording();
    });

    unmount();

    expect(mockCancel).toHaveBeenCalled();
    expect(useVoiceStore.getState().isRecording).toBe(false);
  });

  it('clears recording state on unmount during pending mic setup', async () => {
    // Make startAudioCapture hang so mic setup is still pending at unmount
    let resolveMic!: (value: unknown) => void;
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMic = resolve;
      })
    );

    const onTranscription = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceInput({ onTranscription }));

    // Start recording, but keep startAudioCapture pending so the mic is not ready yet.
    act(() => {
      result.current.startRecording();
    });
    expect(result.current.isRecording).toBe(false);
    expect(useVoiceStore.getState().isRecording).toBe(false);

    // Unmount before mic resolves
    unmount();

    // Recording state must stay cleared even though mic never resolved.
    expect(useVoiceStore.getState().isRecording).toBe(false);
    expect(useVoiceStore.getState().isStarting).toBe(false);
    // Main was never told recording started (setStarting doesn't IPC), so the
    // unmount must not spuriously notify it of a stop either.
    expect(window.api.voiceSetRecordingState).not.toHaveBeenCalled();

    // Resolve mic to avoid dangling promise
    resolveMic({ stop: mockStop, getLevel: mockGetLevel, cancel: mockCancel });
  });

  it('idle instance unmount does not clobber another instance’s active recording', async () => {
    const onTranscription = vi.fn();
    const first = renderHook(() => useVoiceInput({ onTranscription }));
    const second = renderHook(() => useVoiceInput({ onTranscription }));

    // First instance starts recording successfully.
    await act(async () => {
      first.result.current.startRecording();
    });
    expect(first.result.current.isRecording).toBe(true);
    expect(useVoiceStore.getState().isRecording).toBe(true);

    // Second instance attempts to start — blocked by the isRecording check,
    // so it never owns a capture.
    await act(async () => {
      second.result.current.startRecording();
    });
    expect(second.result.current.isRecording).toBe(false);

    // Second instance unmounts (e.g. dialog closes). It must not clear the
    // shared recording state — the first instance is still recording.
    vi.mocked(window.api.voiceSetRecordingState).mockClear();
    second.unmount();
    expect(useVoiceStore.getState().isRecording).toBe(true);
    expect(window.api.voiceSetRecordingState).not.toHaveBeenCalled();

    // First instance can still stop and transcribe normally.
    await act(async () => {
      await first.result.current.stopAndTranscribe();
    });
    expect(useVoiceStore.getState().isRecording).toBe(false);
    expect(onTranscription).toHaveBeenCalledWith('hello world', undefined, { morePending: false });
    first.unmount();
  });

  it('exposes isStarting=true while getUserMedia is pending and clears it once mic opens', async () => {
    let resolveMic!: (value: unknown) => void;
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMic = resolve;
      })
    );

    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    expect(result.current.isStarting).toBe(false);

    act(() => {
      result.current.startRecording();
    });

    // While the mic is pending, isStarting must be true so the UI can render a spinner.
    expect(result.current.isStarting).toBe(true);
    expect(result.current.isRecording).toBe(false);
    expect(useVoiceStore.getState().isStarting).toBe(true);
    expect(useVoiceStore.getState().isRecording).toBe(false);

    await act(async () => {
      resolveMic({ stop: mockStop, getLevel: mockGetLevel, cancel: mockCancel });
    });

    expect(result.current.isStarting).toBe(false);
    expect(result.current.isRecording).toBe(true);
    expect(useVoiceStore.getState().isStarting).toBe(false);
    expect(useVoiceStore.getState().isRecording).toBe(true);
  });

  it('cancelRecording during pending mic-open clears isStarting and releases the mutex', async () => {
    let resolveMicA!: (value: unknown) => void;
    const cancelA = vi.fn();
    const stopA = vi.fn().mockReturnValue(new Float32Array(16000));
    const cancelB = vi.fn();
    const stopB = vi.fn().mockReturnValue(new Float32Array(16000));
    const getLevelB = vi.fn().mockReturnValue(0.05);

    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveMicA = resolve;
        })
      )
      .mockResolvedValueOnce({ stop: stopB, getLevel: getLevelB, cancel: cancelB });

    const onTranscription = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription, onCancel }));

    // Start A — getUserMedia hangs.
    await act(async () => {
      result.current.startRecording();
    });
    expect(result.current.isStarting).toBe(true);

    // User hits Escape (or the toggle shortcut) while mic is still pending.
    act(() => {
      result.current.cancelRecording();
    });
    expect(result.current.isStarting).toBe(false);
    expect(result.current.isRecording).toBe(false);
    expect(useVoiceStore.getState().isStarting).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.cancelRecording();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Start B — second attempt. Mock resolves immediately to a distinct handle.
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.isRecording).toBe(true);

    // Late: A's getUserMedia finally resolves. The hook must treat A as stale,
    // cancel A's stream, and NOT overwrite B as the active capture.
    await act(async () => {
      resolveMicA({ stop: stopA, getLevel: vi.fn(), cancel: cancelA });
    });
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).not.toHaveBeenCalled();

    // stopAndTranscribe must drain B (the live capture), not A.
    await act(async () => {
      await result.current.stopAndTranscribe();
    });
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(stopA).not.toHaveBeenCalled();
  });

  it('a stale rejection from cancelled attempt A does not disturb live attempt B', async () => {
    let rejectMicA!: (err: unknown) => void;
    const cancelB = vi.fn();
    const stopB = vi.fn().mockReturnValue(new Float32Array(16000));
    const getLevelB = vi.fn().mockReturnValue(0.05);

    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectMicA = reject;
        })
      )
      .mockResolvedValueOnce({ stop: stopB, getLevel: getLevelB, cancel: cancelB });

    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));

    // Start A — getUserMedia hangs, will reject later.
    await act(async () => {
      result.current.startRecording();
    });
    expect(result.current.isStarting).toBe(true);

    // Cancel A while pending.
    act(() => {
      result.current.cancelRecording();
    });
    expect(result.current.isStarting).toBe(false);

    // Start B — succeeds immediately to a distinct handle.
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.isRecording).toBe(true);

    // Late: A's getUserMedia rejects (e.g. permission denied / device error).
    // The stale catch-path must not release B's mutex or clear B's state.
    await act(async () => {
      rejectMicA(new Error('permission denied'));
    });
    expect(result.current.isRecording).toBe(true);

    // stopAndTranscribe must drain B's live capture.
    await act(async () => {
      await result.current.stopAndTranscribe();
    });
    expect(stopB).toHaveBeenCalledTimes(1);
  });

  it('module-level mutex blocks a second instance from claiming the mic while the first is pending', async () => {
    // First instance's getUserMedia hangs forever.
    let resolveFirst!: (value: unknown) => void;
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      })
    );

    const onTranscription = vi.fn();
    const first = renderHook(() => useVoiceInput({ onTranscription }));
    const second = renderHook(() => useVoiceInput({ onTranscription }));

    // First claims the mutex synchronously.
    await act(async () => {
      first.result.current.startRecording();
    });
    expect(first.result.current.isStarting).toBe(true);
    expect(vi.mocked(startAudioCapture)).toHaveBeenCalledTimes(1);

    // Second's startRecording must be a no-op while the first is still pending —
    // it must NOT call startAudioCapture again.
    await act(async () => {
      second.result.current.startRecording();
    });
    expect(second.result.current.isStarting).toBe(false);
    expect(second.result.current.isRecording).toBe(false);
    expect(vi.mocked(startAudioCapture)).toHaveBeenCalledTimes(1);

    // Resolve the first capture so unmount/cancel can clean up.
    await act(async () => {
      resolveFirst({ stop: mockStop, getLevel: mockGetLevel, cancel: mockCancel });
    });
    first.unmount();
    second.unmount();
  });

  describe('feedback', () => {
    const toastMessages = () => useToastStore.getState().toasts.map((t) => [t.type, t.message]);

    async function recordAndStop(result: { current: ReturnType<typeof useVoiceInput> }) {
      await act(async () => {
        result.current.startRecording();
      });
      await act(async () => {
        result.current.stopAndTranscribe();
      });
    }

    it('shows an error toast when transcription fails', async () => {
      vi.mocked(window.api.voiceTranscribe).mockRejectedValueOnce(
        new Error("Error invoking remote method 'voice:transcribe': Error: model exploded")
      );
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput({ onTranscription }));

      await recordAndStop(result);

      expect(onTranscription).not.toHaveBeenCalled();
      expect(toastMessages()).toEqual([['error', 'Transcription failed: model exploded']]);
    });

    it('says so when no speech was detected', async () => {
      vi.mocked(window.api.voiceTranscribe).mockResolvedValueOnce('');
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput({ onTranscription }));

      await recordAndStop(result);

      expect(onTranscription).not.toHaveBeenCalled();
      expect(toastMessages()).toEqual([['info', 'No speech detected.']]);
    });

    it.each([
      ['NotAllowedError', /microphone access is blocked/i],
      ['NotFoundError', /no microphone found/i],
      ['NotReadableError', /in use by another app/i],
    ])('explains a %s from the microphone', async (name, message) => {
      const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
      vi.mocked(startAudioCapture).mockRejectedValueOnce(new DOMException('denied', name));
      const { result } = renderHook(() => useVoiceInput({ onTranscription: vi.fn() }));

      await act(async () => {
        result.current.startRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ type: 'error', message: expect.stringMatching(message) }),
      ]);
    });

    it('reports blocked access when the OS denies the microphone before capture starts', async () => {
      vi.mocked(window.api.voiceRequestMicAccess).mockResolvedValueOnce(false);
      const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
      vi.mocked(startAudioCapture).mockClear();
      const { result } = renderHook(() => useVoiceInput({ onTranscription: vi.fn() }));

      await act(async () => {
        result.current.startRecording();
      });

      expect(startAudioCapture).not.toHaveBeenCalled();
      expect(toastMessages()[0]?.[1]).toMatch(/microphone access is blocked/i);
    });
  });

  it('does not open the mic when cancelled while the OS permission prompt is up', async () => {
    let answerPrompt!: (allowed: boolean) => void;
    vi.mocked(window.api.voiceRequestMicAccess).mockReturnValueOnce(
      new Promise((resolve) => {
        answerPrompt = resolve;
      })
    );
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    vi.mocked(startAudioCapture).mockClear();
    const { result } = renderHook(() => useVoiceInput({ onTranscription: vi.fn() }));

    act(() => {
      result.current.startRecording();
    });
    act(() => {
      result.current.cancelRecording();
    });
    await act(async () => {
      answerPrompt(true);
    });

    expect(startAudioCapture).not.toHaveBeenCalled();
    expect(result.current.isStarting).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('counts down the last 30 seconds and stops at the five-minute limit', async () => {
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscription }));
    await act(async () => {
      result.current.startRecording();
    });

    act(() => {
      vi.advanceTimersByTime(260_000);
    });
    expect(result.current.remainingSeconds).toBeNull();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.remainingSeconds).toBe(25);

    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });

    expect(result.current.isRecording).toBe(false);
    expect(mockStop).toHaveBeenCalled();
    expect(onTranscription).toHaveBeenCalledWith('hello world', undefined, { morePending: false });
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Recording stopped at the 5-minute limit.'
    );
  });

  it('hands onTranscription the target captured when recording stopped', async () => {
    let focused = 'terminal-a';
    let resolveTranscription!: (text: string) => void;
    vi.mocked(window.api.voiceTranscribe).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTranscription = resolve;
      })
    );
    const onTranscription = vi.fn();
    const { result } = renderHook(() =>
      useVoiceInput({ onTranscription, captureTarget: () => focused })
    );

    await act(async () => {
      result.current.startRecording();
    });
    await act(async () => {
      result.current.stopAndTranscribe();
    });
    // The user switches terminals while transcription runs.
    focused = 'terminal-b';
    await act(async () => {
      resolveTranscription('hello world');
    });

    expect(onTranscription).toHaveBeenCalledWith('hello world', 'terminal-a', {
      morePending: false,
    });
  });

  describe('transcription state', () => {
    function deferTranscriptions(): Array<(text: string) => void> {
      const resolvers: Array<(text: string) => void> = [];
      vi.mocked(window.api.voiceTranscribe).mockImplementation(
        () => new Promise((resolve) => resolvers.push(resolve))
      );
      return resolvers;
    }

    async function record(result: { current: ReturnType<typeof useVoiceInput> }): Promise<void> {
      await act(async () => {
        result.current.startRecording();
      });
      await act(async () => {
        result.current.stopAndTranscribe();
      });
    }

    it('stays transcribing until every transcription in flight has finished', async () => {
      const resolvers = deferTranscriptions();
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput({ onTranscription }));

      await record(result);
      await record(result);
      expect(result.current.isTranscribing).toBe(true);

      await act(async () => resolvers[0]('first'));
      expect(result.current.isTranscribing).toBe(true);

      await act(async () => resolvers[1]('second'));
      expect(result.current.isTranscribing).toBe(false);
      expect(onTranscription.mock.calls.map(([text, , more]) => [text, more])).toEqual([
        ['first', { morePending: true }],
        ['second', { morePending: false }],
      ]);
    });

    it("is not shown by another instance's transcription", async () => {
      deferTranscriptions();
      const { result: a } = renderHook(() => useVoiceInput({ onTranscription: vi.fn() }));
      const { result: b } = renderHook(() => useVoiceInput({ onTranscription: vi.fn() }));

      await record(a);

      expect(a.current.isTranscribing).toBe(true);
      expect(b.current.isTranscribing).toBe(false);
    });

    it('cancelTranscription drops the pending result', async () => {
      const resolvers = deferTranscriptions();
      const onTranscription = vi.fn();
      const { result } = renderHook(() => useVoiceInput({ onTranscription }));

      await record(result);
      act(() => result.current.cancelTranscription());
      expect(result.current.isTranscribing).toBe(false);
      // The main process stops decoding it too.
      const requestId = vi.mocked(window.api.voiceTranscribe).mock.calls[0][1];
      expect(requestId).toEqual(expect.any(String));
      expect(window.api.voiceCancelTranscription).toHaveBeenCalledWith(requestId);

      await act(async () => resolvers[0]('too late'));
      expect(onTranscription).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([]);
    });
  });
});
