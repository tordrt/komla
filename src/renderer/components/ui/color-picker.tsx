import { cn } from '@/lib/utils';

// Preset accent colors in OKLCH format — neutral ink first, then ordered by hue for rainbow flow
export const ACCENT_COLORS = [
  'oklch(0.922 0 0)',
  'oklch(0.62 0.20 25)',
  'oklch(0.63 0.18 45)',
  'oklch(0.63 0.15 65)',
  'oklch(0.65 0.17 120)',
  'oklch(0.65 0.15 142)',
  'oklch(0.58 0.12 195)',
  'oklch(0.55 0.18 230)',
  'oklch(0.65 0.15 250)',
  'oklch(0.60 0.18 300)',
  'oklch(0.65 0.18 330)',
  'oklch(0.63 0.15 350)',
];

// Parse OKLCH string to extract L, C, H values
function parseOklch(color: string): { l: number; c: number; h: number } | null {
  const match = color.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!match) return null;
  return { l: parseFloat(match[1]), c: parseFloat(match[2]), h: parseFloat(match[3]) };
}

/** Fuzzy OKLCH comparison for accent colors */
export function isOklchMatch(a: string, b: string): boolean {
  const av = parseOklch(a);
  const bv = parseOklch(b);
  if (!av || !bv) return false;
  return Math.abs(av.l - bv.l) < 0.05 && Math.abs(av.c - bv.c) < 0.03 && Math.abs(av.h - bv.h) < 10;
}

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  colors: string[];
  /** Colors offered ahead of `colors`, such as an icon's */
  suggestedColors?: string[];
  /** Names each suggested swatch, followed by its color */
  suggestedLabel?: string;
  /** Custom comparison for checking if a color is selected (default: strict equality) */
  isSelected?: (candidate: string, current: string) => boolean;
  /** Whether clicking the selected color deselects it (default: false) */
  allowDeselect?: boolean;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function ColorPicker({
  value,
  onChange,
  colors,
  suggestedColors = [],
  suggestedLabel = 'Suggested color',
  isSelected,
  allowDeselect = false,
  label,
  disabled,
  className,
}: ColorPickerProps) {
  const checkSelected = isSelected ?? ((a: string, b: string) => a === b);

  const renderSwatch = (color: string, name?: string) => {
    const selected = checkSelected(color, value);

    return (
      <button
        key={color}
        type="button"
        aria-label={name}
        title={name ? color : undefined}
        aria-pressed={selected}
        disabled={disabled}
        className={cn(
          'h-6 w-6 shrink-0 rounded-full border-2 transition-transform hover:scale-110 disabled:pointer-events-none disabled:opacity-50',
          selected ? 'border-white ring-2 ring-white/20' : 'border-transparent'
        )}
        style={{ backgroundColor: color }}
        onClick={() => {
          if (selected && allowDeselect) {
            onChange('');
          } else {
            onChange(color);
          }
        }}
      />
    );
  };

  // The swatches go under the label when they don't fit beside it.
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      {label && <span className="text-sm font-medium whitespace-nowrap">{label}</span>}
      <div role="group" aria-label={label} className="flex items-center gap-1.5">
        {suggestedColors.map((color) => renderSwatch(color, `${suggestedLabel} ${color}`))}
        {suggestedColors.length > 0 && colors.length > 0 && (
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-foreground/20" />
        )}
        {colors.map((color) => renderSwatch(color))}
      </div>
    </div>
  );
}
