import { useId, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

// The three komlas from the app icon, back to front: resources/icon.svg's komla-0..2 scaled into a
// 100 box. Change both together.
const KOMLAS = [
  'M75.5 35.3C80.5 35.4 89.1 37.2 92.9 39.9C96.7 42.6 98.0 47.3 98.4 51.5C98.8 55.7 97.8 61.1 95.5 65.0C93.2 69.0 88.8 73.7 84.7 75.2C80.6 76.7 75.4 75.8 71.0 74.1C66.5 72.3 60.4 68.2 57.9 64.6C55.4 61.0 55.3 56.7 56.1 52.5C56.8 48.3 59.4 42.4 62.6 39.5C65.9 36.6 70.5 35.3 75.5 35.3Z',
  'M59.2 8.1C62.8 10.6 68.0 16.1 69.3 20.0C70.7 23.8 69.2 27.8 67.4 31.0C65.7 34.2 62.3 37.5 58.7 39.2C55.1 40.8 49.5 42.0 45.9 41.0C42.2 40.1 39.0 36.8 36.7 33.4C34.4 29.9 32.1 23.9 32.1 20.1C32.1 16.3 34.1 13.2 36.8 10.6C39.4 8.0 44.3 5.0 48.0 4.6C51.7 4.2 55.7 5.5 59.2 8.1Z',
  'M21.6 41.3C28.1 40.0 39.5 40.0 45.1 42.4C50.7 44.8 53.5 50.5 55.2 55.7C56.9 61.0 57.1 68.1 55.2 73.7C53.4 79.4 49.0 86.6 44.2 89.7C39.4 92.7 32.5 93.0 26.4 91.9C20.2 90.9 11.3 87.3 7.2 83.4C3.0 79.5 1.6 74.1 1.5 68.5C1.4 63.0 3.0 54.6 6.4 50.1C9.7 45.6 15.2 42.6 21.6 41.3Z',
];

// Wide enough to keep the three komlas apart at the 14–20 px the logo is drawn at.
const GAP = 8;

/**
 * Komla's logo: the three komlas from the app icon, without the icon's tile, in the theme's
 * accent, or Komla blue when the accent is gray. Each komla is cut out of the ones behind it with
 * a gap around it, so the gaps show whatever is underneath. The icon's specks are left out: at
 * this size they'd only be noise.
 */
export function KomlaMark({ className, style }: { className?: string; style?: CSSProperties }) {
  const id = useId();
  const maskId = (index: number) => `${id}-behind-${index}`;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={cn('text-komla', className)}
      style={style}
    >
      <defs>
        {KOMLAS.slice(0, -1).map((komla, index) => (
          <mask key={komla} id={maskId(index)}>
            <rect x="-10" y="-10" width="120" height="120" fill="white" />
            {KOMLAS.slice(index + 1).map((inFront) => (
              <path
                key={inFront}
                d={inFront}
                stroke="black"
                strokeWidth={GAP * 2}
                strokeLinejoin="round"
              />
            ))}
          </mask>
        ))}
      </defs>
      {KOMLAS.map((komla, index) => (
        <path
          key={komla}
          fill="currentColor"
          mask={index < KOMLAS.length - 1 ? `url(#${maskId(index)})` : undefined}
          d={komla}
        />
      ))}
    </svg>
  );
}
