import { memo, type CSSProperties } from 'react';

import { Komla } from '@/components/ui/komla-mark';

// Scattered around the centered content, mostly beside it; in a narrow window a few drift in
// behind it, faint enough to read through. Negative delays start every komla part-way through
// its float, so they don't all set off together.
const komlas = [
  { left: '4%', top: '8%', size: 84, tilt: -18, duration: 13, delay: -2 },
  { left: '17%', top: '30%', size: 44, tilt: 24, duration: 10, delay: -7 },
  { left: '6%', top: '56%', size: 120, tilt: 8, duration: 16, delay: -11 },
  { left: '19%', top: '82%', size: 60, tilt: -32, duration: 12, delay: -4 },
  { left: '2%', top: '88%', size: 36, tilt: 40, duration: 9, delay: -6 },
  { left: '24%', top: '6%', size: 32, tilt: 60, duration: 11, delay: -9 },
  { left: '82%', top: '5%', size: 100, tilt: 14, duration: 15, delay: -5 },
  { left: '72%', top: '22%', size: 40, tilt: -44, duration: 10, delay: -1 },
  { left: '88%', top: '38%', size: 56, tilt: 30, duration: 12, delay: -8 },
  { left: '76%', top: '62%', size: 132, tilt: -10, duration: 17, delay: -3 },
  { left: '91%', top: '80%', size: 48, tilt: 52, duration: 11, delay: -10 },
  { left: '70%', top: '88%', size: 30, tilt: -60, duration: 9, delay: -5 },
];

/** Komlas from the logo floating behind the setup wizard and the empty main window. */
export const KomlaBackdrop = memo(function KomlaBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {komlas.map((komla) => (
        <Komla
          key={`${komla.left} ${komla.top}`}
          className="komla-float absolute"
          style={
            {
              left: komla.left,
              top: komla.top,
              width: komla.size,
              height: komla.size,
              '--komla-tilt': `${komla.tilt}deg`,
              animationDuration: `${komla.duration}s`,
              animationDelay: `${komla.delay}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
});
