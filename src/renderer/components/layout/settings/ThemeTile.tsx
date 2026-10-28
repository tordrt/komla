import { Check } from '@phosphor-icons/react';

import { paletteSurface, type Palette, type PreviewToken } from '@/lib/palette-presets';
import { cn } from '@/lib/utils';

import { MODE_TEXT } from '../../../../shared/lib/appearance';

import type { ITheme } from '@xterm/xterm';

interface ThemeTileProps {
  palette: Palette;
  /** The accent as an "oklch(L C H)" color, fitted to the palette's mode. */
  accent: string;
  terminal: ITheme;
  isActive: boolean;
  onSelect: () => void;
}

/** A theme to choose, shown as a small Komla window in the theme's colors. */
export function ThemeTile({ palette, accent, terminal, isActive, onSelect }: ThemeTileProps) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
        isActive ? 'bg-primary/10 ring-1 ring-primary/60' : 'hover:bg-accent/50'
      )}
    >
      <ThemePreview palette={palette} accent={accent} terminal={terminal} />
      <span className="flex items-center justify-between gap-1 px-0.5">
        <span className="truncate text-[13px] text-foreground">{palette.label}</span>
        {isActive && <Check className="size-3.5 shrink-0 text-primary" weight="bold" />}
      </span>
    </button>
  );
}

type PreviewColor =
  | 'foreground'
  | 'cursor'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

// Each row is [ANSI color, width] pairs, read like a prompt and some command output.
const TERMINAL_LINES: Array<Array<[PreviewColor, string]>> = [
  [
    ['green', '10%'],
    ['foreground', '45%'],
  ],
  [
    ['blue', '30%'],
    ['foreground', '25%'],
  ],
  [
    ['yellow', '18%'],
    ['magenta', '24%'],
    ['red', '12%'],
  ],
  [
    ['cyan', '22%'],
    ['cursor', '6%'],
  ],
];

function ThemePreview({
  palette,
  accent,
  terminal,
}: Omit<ThemeTileProps, 'isActive' | 'onSelect'>) {
  const surface = (token: PreviewToken) => `oklch(${paletteSurface(palette, token)})`;
  const text = `oklch(${MODE_TEXT[palette.mode].foreground})`;
  const border = surface('--border');

  return (
    <div
      aria-hidden
      className="flex h-18 overflow-hidden rounded-md border border-border/60"
      style={{ backgroundColor: surface('--chrome') }}
    >
      <div className="flex w-[36%] flex-col gap-1 p-1 pt-3.5">
        <div
          className="flex items-center gap-1 rounded-sm px-1 py-0.5"
          style={{ backgroundColor: surface('--sidebar-accent') }}
        >
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
          <span className="h-1 flex-1 rounded-full opacity-80" style={{ backgroundColor: text }} />
        </div>
        {['70%', '55%'].map((width) => (
          <div key={width} className="flex items-center gap-1 px-1 py-0.5">
            <span
              className="size-1.5 shrink-0 rounded-full opacity-30"
              style={{ backgroundColor: text }}
            />
            <span
              className="h-1 rounded-full opacity-30"
              style={{ backgroundColor: text, width }}
            />
          </div>
        ))}
      </div>
      {/* The work area card, with rounded left corners like the window's. */}
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-[6px]"
        style={{ backgroundColor: surface('--card'), borderLeft: `1px solid ${border}` }}
      >
        <div className="h-2.5 shrink-0" style={{ borderBottom: `1px solid ${border}` }} />
        <div
          className="flex flex-1 flex-col gap-1.5 p-1.5"
          style={{ backgroundColor: terminal.background }}
        >
          {TERMINAL_LINES.map((line, index) => (
            <div key={index} className="flex h-1 gap-1">
              {line.map(([color, width]) => (
                <span
                  key={color}
                  className="rounded-full"
                  style={{ backgroundColor: terminal[color], width }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
