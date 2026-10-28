import { useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';

import type { LevelHistory } from '@/lib/level-history';

const MIN_HEIGHT_PX = 2;
const MAX_HEIGHT_PX = 16;
// Speech RMS spans roughly -50 dB (quiet) to -15 dB (loud), so scale in dB.
const FLOOR_DB = -55;
const RANGE_DB = 40;

function barHeight(level: number): number {
  const db = 20 * Math.log10(Math.max(level, 1e-6));
  const loudness = Math.min(Math.max((db - FLOOR_DB) / RANGE_DB, 0), 1);
  return MIN_HEIGHT_PX + loudness * (MAX_HEIGHT_PX - MIN_HEIGHT_PX);
}

/** A scrolling waveform of recent mic levels, newest on the right, in the current text color. */
export function VoiceWaveform({
  levels,
  bars,
  className,
}: {
  levels: LevelHistory;
  bars: number;
  className?: string;
}) {
  const recent = useSyncExternalStore(levels.subscribe, levels.getSnapshot).slice(-bars);
  const padded = [...Array<number>(bars - recent.length).fill(0), ...recent];
  return (
    <span className={cn('flex h-4 items-center gap-[2px]', className)} aria-hidden>
      {padded.map((level, index) => (
        <span
          // Bars are positions in a fixed-length window, not items with identity.
          key={index}
          data-bar
          className="w-[2px] rounded-full bg-current"
          style={{
            height: `${barHeight(level)}px`,
            // Older bars fade out toward the left.
            opacity: 0.35 + (0.65 * index) / Math.max(bars - 1, 1),
          }}
        />
      ))}
    </span>
  );
}
