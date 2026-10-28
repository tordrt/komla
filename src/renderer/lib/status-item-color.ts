import type { StatusItemThemeColor } from '../../shared/types/status-items';
import type { CSSProperties } from 'react';

const THEME_COLOR_CLASS: Record<StatusItemThemeColor, string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
  info: 'text-info',
  muted: 'text-muted-foreground',
  foreground: 'text-foreground',
};

/** A status item color as its class, so a theme color follows the theme; a hex color as it is. */
export function statusItemColorProps(color: string | undefined): {
  className?: string;
  style?: CSSProperties;
} {
  if (!color) return {};
  if (color in THEME_COLOR_CLASS) {
    return { className: THEME_COLOR_CLASS[color as StatusItemThemeColor] };
  }
  return color.startsWith('#') ? { style: { color } } : {};
}
