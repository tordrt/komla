import { useCallback, useEffect, useRef, useState } from 'react';

import { startAudioCapture, type AudioCaptureHandle } from '@/lib/audio-capture';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { createLevelHistory, type LevelHistory } from '@/lib/level-history';
import { useToastStore } from '@/stores/toast.store';
import { useVoiceStore } from '@/stores/voice.store';

let recordingStartOwner: symbol | null = null;

/** Recordings stop and transcribe on their own at this length. */
export const MAX_RECORDING_SECONDS = 5 * 60;
const COUNTDOWN_SECONDS = 30;
const LEVEL_INTERVAL_MS = 50;
/** Mic levels kept for the waveform: the last 0.8 seconds. */
export const WAVEFORM_LENGTH = 16;

const MAC_MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

function showMicError(err: unknown): void {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  const toasts = useToastStore.getState();
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const isMac = window.api.platform === 'darwin';
    toasts.addToast(
      isMac
        ? 'Microphone access is blocked. Allow Komla in System Settings → Privacy & Security → Microphone.'
        : 'Microphone access is blocked.',
      'error',
      isMac
        ? {
            action: {
              label: 'Open Settings',
              onClick: () => void window.api.openExternal(MAC_MIC_SETTINGS_URL),
            },
          }
        : undefined
    );
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    toasts.addToast('No microphone found.', 'error');
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    toasts.addToast('The microphone is in use by another app or unavailable.', 'error');
  } else {
    toasts.addToast(`Couldn't start the microphone: ${ipcErrorMessage(err)}`, 'error');
  }
}

export interface UseVoiceInputOptions<T = undefined> {
  /** morePending: another transcription from this input is still running. */
  onTranscription: (text: string, target: T, info: { morePending: boolean }) => void;
  /**
   * Called when recording stops, before transcription starts. Its result is
   * passed to onTranscription, so text lands where the user was when they
   * stopped, even if focus moves while transcription runs.
   */
  captureTarget?: () => T;
  onCancel?: () => void;
}

export interface UseVoiceInputReturn {
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
  /** Recent mic levels, at most WAVEFORM_LENGTH. Updates don't re-render the hook's owner. */
  levels: LevelHistory;
  duration: number;
  /** Seconds until the recording limit, during the final countdown; otherwise null. */
  remainingSeconds: number | null;
  startRecording: () => void;
  stopAndTranscribe: () => void;
  cancelRecording: () => void;
  /** Drops the results of transcriptions still in flight. */
  cancelTranscription: () => void;
}

export function useVoiceInput<T = undefined>({
  onTranscription,
  captureTarget,
  onCancel,
}: UseVoiceInputOptions<T>): UseVoiceInputReturn {
  const { transcribe, setRecording, setStarting } = useVoiceStore();

  const [localRecording, setLocalRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [levels] = useState(() => createLevelHistory(WAVEFORM_LENGTH));
  const [duration, setDuration] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const audioCaptureRef = useRef<AudioCaptureHandle | null>(null);
  const audioLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationStartMsRef = useRef(0);
  const mountedRef = useRef(true);
  const startPendingRef = useRef(false);
  const ownerRef = useRef(Symbol('voice-input'));
  // Sequence number bumped on each new start attempt and on every cancel /
  // stop / unmount. Lets a late-resolving startAudioCapture detect that its
  // result has been superseded — important for the cancel→retry race where
  // a single boolean flag would be reset by the retry.
  const startAttemptRef = useRef(0);
  // Request IDs of transcriptions still running; a new recording can start
  // while the previous one is still transcribing.
  const pendingTranscriptionsRef = useRef(new Set<string>());
  const onTranscriptionRef = useRef(onTranscription);
  onTranscriptionRef.current = onTranscription;
  const captureTargetRef = useRef(captureTarget);
  useEffect(() => {
    captureTargetRef.current = captureTarget;
  });
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const cleanupIntervals = useCallback(() => {
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current);
      audioLevelIntervalRef.current = null;
    }
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    levels.clear();
  }, [levels]);

  const releaseStartMutex = useCallback(() => {
    if (recordingStartOwner === ownerRef.current) {
      recordingStartOwner = null;
    }
    startPendingRef.current = false;
    setStarting(false);
    if (mountedRef.current) setIsStarting(false);
  }, [setStarting]);

  const cancelRecording = useCallback(() => {
    if (audioCaptureRef.current) {
      audioCaptureRef.current.cancel();
      audioCaptureRef.current = null;
    } else if (startPendingRef.current) {
      // Mic setup may still be pending — invalidate the in-flight attempt so
      // its late-arriving capture is discarded.
      startAttemptRef.current += 1;
      releaseStartMutex();
    } else {
      return;
    }
    setLocalRecording(false);
    setRecording(false);
    cleanupIntervals();
    onCancelRef.current?.();
  }, [setRecording, cleanupIntervals, releaseStartMutex]);

  const cancelTranscription = useCallback(() => {
    for (const requestId of pendingTranscriptionsRef.current) {
      void window.api.voiceCancelTranscription(requestId);
    }
    pendingTranscriptionsRef.current.clear();
    setIsTranscribing(false);
  }, []);

  const stopAndTranscribe = useCallback(async () => {
    if (!audioCaptureRef.current) {
      // Mic setup may still be pending — invalidate the in-flight attempt so
      // its late-arriving capture is discarded.
      startAttemptRef.current += 1;
      releaseStartMutex();
      setLocalRecording(false);
      setRecording(false);
      return;
    }

    const target = captureTargetRef.current?.() as T;
    const audioBuffer = audioCaptureRef.current.stop();
    audioCaptureRef.current = null;
    setLocalRecording(false);
    setRecording(false);
    cleanupIntervals();

    if (audioBuffer.length === 0) return;

    const pending = pendingTranscriptionsRef.current;
    const transcription = crypto.randomUUID();
    pending.add(transcription);
    setIsTranscribing(true);
    try {
      const text = await transcribe(audioBuffer, transcription);
      if (!pending.delete(transcription)) return;
      if (text) {
        onTranscriptionRef.current(text, target, { morePending: pending.size > 0 });
      } else {
        useToastStore.getState().addToast('No speech detected.', 'info');
      }
    } catch (err) {
      if (!pending.delete(transcription)) return;
      console.warn('Voice transcription failed:', err);
      useToastStore.getState().addToast(`Transcription failed: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      if (mountedRef.current) setIsTranscribing(pending.size > 0);
    }
  }, [setRecording, transcribe, cleanupIntervals, releaseStartMutex]);

  const startRecording = useCallback(async () => {
    // Mutex: only one recording at a time across the whole app.
    if (recordingStartOwner || useVoiceStore.getState().isRecording) return;
    const myAttempt = (startAttemptRef.current += 1);
    recordingStartOwner = ownerRef.current;
    startPendingRef.current = true;
    setIsStarting(true);
    setStarting(true);
    setDuration(0);
    levels.clear();

    try {
      // Pre-warm the model in the background while the user records,
      // so it's ready by the time they stop and we need to transcribe.
      window.api.voiceWarmup().catch((err) => {
        console.warn('Voice model warmup failed (will retry on transcribe):', err);
      });
      // On macOS this shows the system prompt the first time; getUserMedia
      // fails if it runs before the user answers.
      const micAllowed = await window.api.voiceRequestMicAccess();
      if (!mountedRef.current || myAttempt !== startAttemptRef.current) return;
      if (!micAllowed) throw new DOMException('Microphone access denied', 'NotAllowedError');
      const capture = await startAudioCapture();
      // Stale attempt — the user cancelled, restarted, or unmounted while we
      // were waiting on getUserMedia. Discard the capture without touching
      // shared state (the latest attempt may already own the mutex).
      if (!mountedRef.current || myAttempt !== startAttemptRef.current) {
        capture.cancel();
        return;
      }
      audioCaptureRef.current = capture;
      releaseStartMutex();
      setLocalRecording(true);
      setRecording(true);
      durationStartMsRef.current = Date.now();

      audioLevelIntervalRef.current = setInterval(() => {
        if (audioCaptureRef.current) {
          levels.push(audioCaptureRef.current.getLevel());
        }
      }, LEVEL_INTERVAL_MS);

      durationIntervalRef.current = setInterval(() => {
        const elapsedMs = Date.now() - durationStartMsRef.current;
        setDuration(Math.floor(elapsedMs / 1000));
        if (elapsedMs >= MAX_RECORDING_SECONDS * 1000) {
          useToastStore
            .getState()
            .addToast(
              `Recording stopped at the ${MAX_RECORDING_SECONDS / 60}-minute limit.`,
              'info'
            );
          void stopAndTranscribe();
        }
      }, 250);
    } catch (err) {
      // Same staleness guard as the success path — a stale failure must not
      // clobber the latest attempt's state.
      if (myAttempt !== startAttemptRef.current) return;
      console.warn('Voice recording failed to start:', err);
      releaseStartMutex();
      setLocalRecording(false);
      setRecording(false);
      if (mountedRef.current) showMicError(err);
    }
  }, [setRecording, setStarting, releaseStartMutex, stopAndTranscribe, levels]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Bump the attempt counter so any in-flight startAudioCapture is treated
      // as stale when it eventually resolves.
      startAttemptRef.current += 1;
      if (startPendingRef.current) {
        if (recordingStartOwner === ownerRef.current) {
          recordingStartOwner = null;
        }
        startPendingRef.current = false;
        setStarting(false);
      }
      if (audioCaptureRef.current) {
        audioCaptureRef.current.cancel();
        audioCaptureRef.current = null;
        cleanupIntervals();
        // Only clear shared recording state if THIS instance held a live
        // capture. Multiple useVoiceInput instances coexist (ShortcutProvider
        // + a dialog) and an idle one unmounting must not clobber another
        // instance's active recording.
        setRecording(false);
      }
    };
  }, [setRecording, setStarting, cleanupIntervals]);

  return {
    isRecording: localRecording,
    isStarting,
    isTranscribing,
    levels,
    duration,
    remainingSeconds:
      localRecording && MAX_RECORDING_SECONDS - duration <= COUNTDOWN_SECONDS
        ? Math.max(0, MAX_RECORDING_SECONDS - duration)
        : null,
    startRecording,
    stopAndTranscribe,
    cancelRecording,
    cancelTranscription,
  };
}
