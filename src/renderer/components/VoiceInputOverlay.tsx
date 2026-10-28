import { Check, X } from '@phosphor-icons/react';

import { RecordingDuration } from '@/components/RecordingDuration';
import { Spinner } from '@/components/ui/spinner';
import { VoiceWaveform } from '@/components/VoiceWaveform';
import { WAVEFORM_LENGTH } from '@/hooks/useVoiceInput';
import { useShortcutsStore } from '@/stores/shortcuts.store';

import type { LevelHistory } from '@/lib/level-history';

interface VoiceInputOverlayProps {
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
  levels: LevelHistory;
  duration: number;
  remainingSeconds: number | null;
  onStop: () => void;
  onCancel: () => void;
  onCancelTranscription: () => void;
}

export function VoiceInputOverlay({
  isRecording,
  isStarting,
  isTranscribing,
  levels,
  duration,
  remainingSeconds,
  onStop,
  onCancel,
  onCancelTranscription,
}: VoiceInputOverlayProps) {
  const voiceShortcut = useShortcutsStore((s) => s.getDisplayShortcut('voice.record'));
  if (!isStarting && !isRecording && !isTranscribing) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(1.5rem_+_var(--status-bar-height,0px))] z-50 flex justify-center"
      data-native-overlay="voice-input"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border/50 bg-background/90 px-4 py-2 shadow-lg backdrop-blur-md">
        {isStarting ? (
          <span className="flex items-center justify-center text-muted-foreground">
            <Spinner size="md" label="Preparing microphone" />
          </span>
        ) : !isRecording ? (
          <>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="md" />
              Transcribing...
            </span>
            <button
              type="button"
              onClick={onCancelTranscription}
              className="flex items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted"
              aria-label="Cancel transcription"
            >
              <X className="size-4" weight="bold" />
            </button>
          </>
        ) : (
          <>
            <VoiceWaveform levels={levels} bars={WAVEFORM_LENGTH} className="text-error" />
            <RecordingDuration
              duration={duration}
              remainingSeconds={remainingSeconds}
              className="text-sm text-muted-foreground"
            />
            <button
              type="button"
              onClick={onStop}
              className="flex items-center justify-center rounded-full p-1 text-foreground transition-colors hover:bg-muted"
              aria-label="Done"
              title={voiceShortcut ? `Done (${voiceShortcut})` : 'Done'}
            >
              <Check className="size-4" weight="bold" />
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted"
              aria-label="Cancel recording"
              title="Cancel (Esc)"
            >
              <X className="size-4" weight="bold" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
