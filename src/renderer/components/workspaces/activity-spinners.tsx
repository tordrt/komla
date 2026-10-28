// The working spinner's styles, chosen in Settings > Appearance. Each but Still animates itself
// and fills its box in currentColor; the keyframes are in globals.css.

import { CircleDashed } from '@phosphor-icons/react';
import { type ComponentType, type CSSProperties, type ReactNode } from 'react';

import { ActivityRays } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import {
  ACTIVITY_SPINNER_STYLES,
  DEFAULT_ACTIVITY_SPINNER,
  type ActivitySpinnerStyle,
} from '../../../shared/lib/activity-spinner';

export interface ActivityGlyphProps {
  className?: string;
}

export type ActivityGlyph = ComponentType<ActivityGlyphProps>;

/** An SVG glyph on a 24-unit grid, marked so reduced motion stills it. */
function GlyphSvg({
  className,
  style,
  children,
}: ActivityGlyphProps & { style?: CSSProperties; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      className={cn('activity-glyph shrink-0', className)}
      style={style}
    >
      {children}
    </svg>
  );
}

/** A part inside an SVG glyph, animated about its own center. */
function partAnimation(animation: string, delay = 0): CSSProperties {
  return {
    animation,
    animationDelay: `${delay}s`,
    transformBox: 'fill-box',
    transformOrigin: 'center',
  };
}

function Rays({ className }: ActivityGlyphProps) {
  return (
    <ActivityRays
      aria-hidden="true"
      className={cn('activity-glyph shrink-0 animate-spin will-change-transform', className)}
    />
  );
}

function Arc({ className }: ActivityGlyphProps) {
  return (
    <GlyphSvg className={cn('animate-spin will-change-transform', className)}>
      <circle cx={12} cy={12} r={9} strokeWidth={3} opacity={0.2} />
      <path d="M12 3a9 9 0 0 1 0 18" strokeWidth={3} strokeLinecap="round" />
    </GlyphSvg>
  );
}

function Dots({ className }: ActivityGlyphProps) {
  return (
    <GlyphSvg className={className}>
      {[4, 12, 20].map((cx, index) => (
        <circle
          key={cx}
          cx={cx}
          cy={12}
          r={3}
          fill="currentColor"
          stroke="none"
          style={partAnimation('activity-fade 1.2s ease-in-out infinite', index * 0.16)}
        />
      ))}
    </GlyphSvg>
  );
}

function Pulse({ className }: ActivityGlyphProps) {
  return (
    <GlyphSvg className={className}>
      <circle
        cx={12}
        cy={12}
        r={7}
        fill="currentColor"
        stroke="none"
        style={partAnimation('activity-breathe 1.4s ease-in-out infinite')}
      />
    </GlyphSvg>
  );
}

function Bars({ className }: ActivityGlyphProps) {
  return (
    <GlyphSvg className={className}>
      {[5, 12, 19].map((x, index) => (
        <line
          key={x}
          x1={x}
          y1={5}
          x2={x}
          y2={19}
          strokeWidth={3.5}
          strokeLinecap="round"
          style={partAnimation('activity-bar 0.9s ease-in-out infinite', index * 0.15)}
        />
      ))}
    </GlyphSvg>
  );
}

// The braille frames terminal spinners turn through (cli-spinners' "dots"), drawn as dots so
// they don't depend on a font having braille. Each dot steps through its own keyframes, which
// start on the first frame's pattern.
const BRAILLE_DOTS: ReadonlyArray<{ cx: number; cy: number; opacity: number }> = [
  { cx: 8, cy: 5, opacity: 1 },
  { cx: 8, cy: 12, opacity: 1 },
  { cx: 8, cy: 19, opacity: 0.18 },
  { cx: 16, cy: 5, opacity: 1 },
  { cx: 16, cy: 12, opacity: 0.18 },
  { cx: 16, cy: 19, opacity: 0.18 },
];

function Braille({ className }: ActivityGlyphProps) {
  return (
    <GlyphSvg className={className}>
      {BRAILLE_DOTS.map(({ cx, cy, opacity }, index) => (
        <circle
          key={index}
          cx={cx}
          cy={cy}
          r={2.6}
          fill="currentColor"
          stroke="none"
          opacity={opacity}
          style={{ animation: `activity-braille-${index + 1} 0.8s step-end infinite` }}
        />
      ))}
    </GlyphSvg>
  );
}

/**
 * A dashed circle that doesn't move, as in the menu bar: it reads as in progress, where a still
 * spinner would look stuck.
 */
export function StillActivityGlyph({ className }: ActivityGlyphProps) {
  return <CircleDashed aria-hidden="true" weight="bold" className={cn('shrink-0', className)} />;
}

const SPINNERS: Record<ActivitySpinnerStyle, { name: string; glyph: ActivityGlyph }> = {
  arc: { name: 'Arc', glyph: Arc },
  rays: { name: 'Rays', glyph: Rays },
  dots: { name: 'Dots', glyph: Dots },
  pulse: { name: 'Pulse', glyph: Pulse },
  bars: { name: 'Bars', glyph: Bars },
  braille: { name: 'Braille', glyph: Braille },
  still: { name: 'Still', glyph: StillActivityGlyph },
};

export const ACTIVITY_SPINNERS: ReadonlyArray<{
  style: ActivitySpinnerStyle;
  name: string;
  glyph: ActivityGlyph;
}> = ACTIVITY_SPINNER_STYLES.map((style) => ({ style, ...SPINNERS[style] }));

function glyphFor(style: string | undefined): ActivityGlyph {
  const chosen = ACTIVITY_SPINNER_STYLES.find((known) => known === style);
  return SPINNERS[chosen ?? DEFAULT_ACTIVITY_SPINNER].glyph;
}

/** The working spinner's glyph, in the style chosen in Settings. */
export function useActivityGlyph(): ActivityGlyph {
  return glyphFor(useConfigStore((state) => state.config?.activitySpinner));
}

/** The working spinner, in the chosen style. */
export function ActivitySpinner({ className }: ActivityGlyphProps) {
  const Glyph = useActivityGlyph();
  // oxlint-disable-next-line react/static-components -- one of the fixed spinner glyphs
  return <Glyph className={className} />;
}
