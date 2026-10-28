/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { VoiceInputOverlay } from '../../../src/renderer/components/VoiceInputOverlay';
import { createLevelHistory } from '../../../src/renderer/lib/level-history';

type Props = ComponentProps<typeof VoiceInputOverlay>;

function overlay(overrides: Partial<Props> = {}) {
  return (
    <VoiceInputOverlay
      isRecording={false}
      isStarting={false}
      isTranscribing={false}
      levels={createLevelHistory(16)}
      duration={0}
      remainingSeconds={null}
      onStop={vi.fn()}
      onCancel={vi.fn()}
      onCancelTranscription={vi.fn()}
      {...overrides}
    />
  );
}

describe('VoiceInputOverlay', () => {
  it('is hidden while idle', () => {
    const { container } = render(overlay());

    expect(container.firstChild).toBeNull();
  });

  it('shows a spinner while microphone startup is pending', () => {
    render(overlay({ isStarting: true }));

    expect(screen.getByLabelText('Preparing microphone')).toBeInTheDocument();
    expect(screen.queryByText('Preparing microphone...')).not.toBeInTheDocument();
  });

  it('shows elapsed time, then the time left near the recording limit', () => {
    const { rerender } = render(overlay({ isRecording: true, duration: 65 }));
    expect(screen.getByText('1:05')).toBeInTheDocument();

    rerender(overlay({ isRecording: true, duration: 281, remainingSeconds: 19 }));
    expect(screen.getByText('0:19 left')).toBeInTheDocument();
  });

  it('finishes with a Done button and cancels with ×', () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    render(overlay({ isRecording: true, onStop, onCancel }));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }));

    expect(onStop).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows the recording controls while an earlier dictation is still transcribing', () => {
    render(overlay({ isRecording: true, isTranscribing: true }));

    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByText(/Transcribing/)).not.toBeInTheDocument();
  });

  it('can cancel a transcription', () => {
    const onCancelTranscription = vi.fn();
    render(overlay({ isTranscribing: true, onCancelTranscription }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel transcription' }));

    expect(onCancelTranscription).toHaveBeenCalled();
  });
});
