/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ActivitySpinner } from '../../../../src/renderer/components/workspaces/activity-spinners';
import {
  AgentStateIcon,
  WorkingAgentsGlyph,
} from '../../../../src/renderer/components/workspaces/agent-state';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';

import type { AppConfig } from '../../../../src/renderer/types';

const choose = (activitySpinner: string | undefined) =>
  useConfigStore.setState({ config: { activitySpinner } as AppConfig });

// Arc's track is a circle; the rays are lines; Braille's six dots are circles too.
const shape = (container: HTMLElement) => ({
  circles: container.querySelectorAll('circle').length,
  lines: container.querySelectorAll('line').length,
});

describe('activity spinner', () => {
  afterEach(() => {
    choose(undefined);
  });

  it('draws Arc by default, and for a style it does not know', () => {
    choose(undefined);
    const { container, rerender } = render(<ActivitySpinner className="size-3" />);
    expect(shape(container)).toEqual({ circles: 1, lines: 0 });
    expect(container.querySelector('svg')).toHaveClass('animate-spin', 'size-3');

    choose('sparkle');
    rerender(<ActivitySpinner className="size-3" />);
    expect(shape(container)).toEqual({ circles: 1, lines: 0 });
  });

  it('draws the style chosen in Settings', () => {
    choose('rays');
    const { container } = render(<ActivitySpinner />);
    expect(shape(container)).toEqual({ circles: 0, lines: 8 });

    act(() => choose('braille'));
    expect(shape(container)).toEqual({ circles: 6, lines: 0 });
  });

  it('draws the chosen style on workspace cards too', () => {
    choose('rays');
    render(<WorkingAgentsGlyph count={1} />);
    const box = screen.getByRole('status', { name: 'Agent processing' });

    expect(shape(box)).toEqual({ circles: 0, lines: 8 });
  });

  it('draws Still as a dashed circle that does not move', () => {
    choose('still');
    const { container } = render(<ActivitySpinner className="size-3" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveClass('size-3');
    expect(svg).not.toHaveClass('animate-spin');
    expect(container.querySelector('[style*="animation"]')).toBeNull();
  });

  it('keeps a still state icon still whatever style Settings picked', () => {
    choose('rays');
    const { container: still } = render(<AgentStateIcon state="working" still />);
    const { container: spinning } = render(<AgentStateIcon state="working" />);

    expect(still.querySelector('svg')).not.toHaveClass('animate-spin');
    expect(shape(still).lines).toBe(0);
    expect(shape(spinning)).toEqual({ circles: 0, lines: 8 });
  });
});
