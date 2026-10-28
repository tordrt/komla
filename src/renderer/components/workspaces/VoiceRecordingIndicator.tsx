import { Check, Microphone, X } from '@phosphor-icons/react';
import { useState } from 'react';

import { RecordingDuration } from '@/components/RecordingDuration';
import { IconButton } from '@/components/ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { VoiceWaveform } from '@/components/VoiceWaveform';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useVoiceStore } from '@/stores/voice.store';

import type { LevelHistory } from '@/lib/level-history';

// The dialog header is narrow: show the last 0.6 seconds.
const WAVEFORM_BARS = 12;

interface VoiceRecordingIndicatorProps {
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
  levels: LevelHistory;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onCancelTranscription: () => void;
  onNavigateToSettings: () => void;
  duration: number; // seconds
  remainingSeconds: number | null;
}

export function VoiceRecordingIndicator({
  isRecording,
  isStarting,
  isTranscribing,
  levels,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onCancelTranscription,
  onNavigateToSettings,
  duration,
  remainingSeconds,
}: VoiceRecordingIndicatorProps) {
  const modelStatus = useVoiceStore((s) => s.modelStatus);
  const voiceShortcut = useShortcutsStore((s) => s.getDisplayShortcut('voice.record'));
  const [downloadPopoverOpen, setDownloadPopoverOpen] = useState(false);

  const modelNotReady =
    modelStatus === 'not-downloaded' ||
    modelStatus === 'unknown' ||
    modelStatus === 'downloading' ||
    modelStatus === 'extracting' ||
    modelStatus === 'error';

  // State: model not ready — show mic icon, popover on click to prompt download
  if (modelNotReady) {
    return (
      <Popover open={downloadPopoverOpen} onOpenChange={setDownloadPopoverOpen}>
        <PopoverTrigger asChild>
          <IconButton
            label="Voice input unavailable"
            className="size-auto p-0.5 text-muted-foreground/40 hover:bg-border/50 hover:text-muted-foreground"
            aria-haspopup="dialog"
          >
            <Microphone className="size-3.5" />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="w-56 p-3">
          <p className="text-xs text-muted-foreground">
            Voice input requires downloading a transcription model.
          </p>
          <button
            type="button"
            className="mt-2 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            onClick={() => {
              setDownloadPopoverOpen(false);
              onNavigateToSettings();
            }}
          >
            Download in Settings
          </button>
        </PopoverContent>
      </Popover>
    );
  }

  // State: mic opening — getUserMedia is in flight, don't speak yet
  if (isStarting) {
    return (
      <span className="flex items-center justify-center p-0.5 text-muted-foreground/60">
        <Spinner size="sm" label="Preparing microphone" />
      </span>
    );
  }

  // State: recording
  if (isRecording) {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <VoiceWaveform levels={levels} bars={WAVEFORM_BARS} className="text-error" />
        <RecordingDuration duration={duration} remainingSeconds={remainingSeconds} />
        <IconButton
          label="Done"
          shortcut={voiceShortcut}
          onClick={onStopRecording}
          className="size-auto p-0.5 text-foreground hover:bg-muted hover:text-foreground"
        >
          <Check className="size-3.5" weight="bold" />
        </IconButton>
        <IconButton
          label="Cancel recording"
          shortcut="Esc"
          onClick={onCancelRecording}
          className="size-auto p-0.5 text-muted-foreground hover:bg-muted hover:text-muted-foreground"
        >
          <X className="size-3.5" weight="bold" />
        </IconButton>
      </span>
    );
  }

  // State: transcribing
  if (isTranscribing) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner size="sm" />
        Transcribing...
        <IconButton
          label="Cancel transcription"
          onClick={onCancelTranscription}
          className="size-auto p-0.5 text-muted-foreground hover:bg-muted hover:text-muted-foreground"
        >
          <X className="size-3.5" weight="bold" />
        </IconButton>
      </span>
    );
  }

  return (
    <IconButton
      label="Dictate"
      shortcut={voiceShortcut}
      onClick={onStartRecording}
      className="size-auto p-0.5 text-muted-foreground/60 hover:bg-border/50 hover:text-muted-foreground"
    >
      <Microphone className="size-3.5" />
    </IconButton>
  );
}
