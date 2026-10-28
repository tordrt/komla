import * as React from 'react';

import { cn } from '@/lib/utils';

const SPINNER_SIZES = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-6',
} as const;

/** The angle of each of the eight rays, with the leading ray first. */
const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * Eight rays that fade behind the leading one, for a working agent. Turn it with `animate-spin`:
 * the trail follows a clockwise turn.
 */
export const ActivityRays = React.forwardRef<SVGSVGElement, React.SVGProps<SVGSVGElement>>(
  (props, ref) => (
    <svg
      ref={ref}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={24}
      strokeLinecap="round"
      {...props}
    >
      {RAY_ANGLES.map((angle, index) => (
        <line
          key={angle}
          x1={128}
          y1={24}
          x2={128}
          y2={76}
          transform={`rotate(${angle} 128 128)`}
          opacity={1 - ((RAY_ANGLES.length - index) % RAY_ANGLES.length) * 0.11}
        />
      ))}
    </svg>
  )
);
ActivityRays.displayName = 'ActivityRays';

interface SpinnerProps {
  size?: keyof typeof SPINNER_SIZES;
  /** Announced to assistive tech. Omit when nearby text already says what is loading. */
  label?: string;
  className?: string;
}

/** A quarter arc turning on a faint ring, for anything loading. */
export const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ size = 'md', label, className }, ref) => {
    const a11yProps = label
      ? { role: 'status', 'aria-label': label }
      : { 'aria-hidden': true as const };
    return (
      <svg
        ref={ref}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        className={cn('shrink-0 animate-spin', SPINNER_SIZES[size], className)}
        {...a11yProps}
      >
        <circle cx={12} cy={12} r={9} opacity={0.25} />
        <path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" />
      </svg>
    );
  }
);
Spinner.displayName = 'Spinner';
