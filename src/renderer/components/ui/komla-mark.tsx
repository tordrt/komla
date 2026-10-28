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

/** One komla, the lumpy potato dumpling the logo is made of, in the same color as the logo. */
export function Komla({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="255 265 510 510"
      aria-hidden="true"
      className={cn('text-komla', className)}
      style={style}
    >
      <path
        fill="currentColor"
        d="M491.8 285.4C549.9 286.2 648.3 306.5 692.3 337.5C736.2 368.6 750.5 423.4 755.6 471.7C760.6 519.9 748.8 581.6 722.5 627.1C696.1 672.5 644.8 727.1 597.6 744.5C550.5 761.9 491.0 751.7 439.6 731.3C388.3 711.0 318.1 663.9 289.5 622.5C260.8 581.2 258.7 531.6 267.8 483.3C276.8 435.1 306.5 366.1 343.8 333.1C381.1 300.1 433.8 284.7 491.8 285.4Z"
      />
      {/* The grated specks: a darker shade of the body colour. */}
      <g fill="black" fillOpacity={0.2}>
        <path d="M431.4 585.5C437.0 585.4 444.8 590.0 447.3 593.4C449.8 596.9 449.4 602.2 446.3 606.3C443.2 610.4 435.0 617.5 428.5 618.1C421.9 618.7 409.3 613.8 406.9 609.8C404.4 605.9 409.5 598.4 413.6 594.3C417.7 590.3 425.8 585.7 431.4 585.5Z" />
        <path d="M589.7 437.7C594.5 437.5 601.0 440.2 604.2 443.5C607.3 446.8 611.3 454.4 608.7 457.5C606.1 460.5 594.4 461.6 588.4 461.6C582.3 461.6 574.6 460.1 572.4 457.4C570.2 454.6 572.2 448.3 575.0 445.0C577.9 441.8 584.8 438.0 589.7 437.7Z" />
        <path d="M560.4 631.5C563.8 631.3 567.5 633.0 569.9 635.3C572.3 637.6 576.4 643.0 574.8 645.5C573.2 648.1 564.3 651.0 560.2 650.6C556.2 650.3 552.3 645.6 550.5 643.3C548.7 641.0 547.9 638.7 549.6 636.7C551.2 634.8 557.0 631.7 560.4 631.5Z" />
        <path d="M399.0 443.5C402.0 443.5 407.9 444.8 409.6 446.4C411.3 448.1 410.7 451.0 409.1 453.3C407.5 455.6 402.8 460.4 400.0 460.3C397.1 460.2 393.2 455.1 391.8 452.7C390.4 450.3 390.2 447.6 391.4 446.1C392.6 444.5 396.0 443.4 399.0 443.5Z" />
        <path d="M639.1 546.2C643.0 546.3 648.6 552.1 650.6 555.1C652.6 558.2 652.8 561.9 651.2 564.6C649.5 567.2 645.6 570.8 640.9 571.0C636.3 571.1 625.6 568.0 623.4 565.3C621.1 562.5 625.0 557.7 627.6 554.5C630.2 551.4 635.3 546.1 639.1 546.2Z" />
        <path d="M505.3 511.9C508.1 511.6 513.7 514.4 514.8 516.2C516.0 518.0 513.8 520.7 512.2 522.5C510.6 524.3 507.6 526.7 505.2 526.8C502.8 527.0 498.8 524.8 497.6 523.3C496.4 521.8 496.8 519.5 498.1 517.6C499.3 515.7 502.5 512.1 505.3 511.9Z" />
      </g>
    </svg>
  );
}
