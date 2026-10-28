/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { VoiceRecordingIndicator } from '../../../../src/renderer/components/workspaces/VoiceRecordingIndicator';
import { createLevelHistory } from '../../../../src/renderer/lib/level-history';
import { useVoiceStore } from '../../../../src/renderer/stores/voice.store';

type Props = ComponentProps<typeof VoiceRecordingIndicator>;

function renderIndicator(overrides: Partial<Props> = {}) {
  const props: Props = {
    isRecording: false,
    isStarting: false,
    isTranscribing: false,
    levels: createLevelHistory(16),
    duration: 0,
    remainingSeconds: null,
    onStartRecording: vi.fn(),
    onStopRecording: vi.fn(),
    onCancelRecording: vi.fn(),
    onCancelTranscription: vi.fn(),
    onNavigateToSettings: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <VoiceRecordingIndicator {...props} />
    </TooltipProvider>
  );
  return props;
}

describe('VoiceRecordingIndicator', () => {
  beforeEach(() => {
    useVoiceStore.setState({ modelStatus: 'ready' });
  });

  it('starts dictating when the mic is clicked', () => {
    const props = renderIndicator();

    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));

    expect(props.onStartRecording).toHaveBeenCalled();
  });

  it('finishes or cancels a recording', () => {
    const props = renderIndicator({ isRecording: true, duration: 3 });

    expect(screen.getByText('0:03')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }));

    expect(props.onStopRecording).toHaveBeenCalled();
    expect(props.onCancelRecording).toHaveBeenCalled();
  });

  it('points to Settings while no model is downloaded', () => {
    useVoiceStore.setState({ modelStatus: 'not-downloaded' });
    renderIndicator();

    expect(screen.getByRole('button', { name: 'Voice input unavailable' })).toBeInTheDocument();
  });
});
