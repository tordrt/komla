/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VoiceWaveform } from '../../../src/renderer/components/VoiceWaveform';
import { createLevelHistory } from '../../../src/renderer/lib/level-history';

function history(levels: number[]) {
  const result = createLevelHistory(levels.length);
  levels.forEach(result.push);
  return result;
}

const heights = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-bar]')).map((bar) =>
    parseFloat(bar.style.height)
  );

describe('VoiceWaveform', () => {
  it('draws the newest level on the right and pads the start while the history fills', () => {
    const { container } = render(<VoiceWaveform levels={history([0.001, 0.05])} bars={6} />);

    const bars = heights(container);
    expect(bars).toHaveLength(6);
    expect(new Set(bars.slice(0, 5)).size).toBe(1); // silence and padding look alike
    expect(bars[5]).toBeGreaterThan(bars[0]);
  });

  it('shows quiet speech clearly and loud speech at full height', () => {
    const { container } = render(
      <VoiceWaveform levels={history([0, 0.005, 0.03, 0.3])} bars={4} />
    );

    const [silent, quiet, normal, loud] = heights(container);
    expect(quiet).toBeGreaterThan(silent);
    expect(normal).toBeGreaterThan(quiet);
    expect(loud).toBeGreaterThan(normal);
  });

  it('redraws as new levels arrive', () => {
    const levels = history([0, 0, 0]);
    const { container } = render(<VoiceWaveform levels={levels} bars={3} />);
    const before = heights(container);

    act(() => levels.push(0.3));

    expect(heights(container)[2]).toBeGreaterThan(before[2]);
  });
});
