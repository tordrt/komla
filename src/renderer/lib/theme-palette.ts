// Applies the palette chosen in theme.json, including a custom theme defined there.
// Users and agents edit theme.json by hand, so a custom theme is checked before it is used.

import { useCustomizationStore } from '@/stores/customization.store';

import {
  MIN_TEXT_CONTRAST,
  MODE_TEXT,
  contrastRatio,
  customPaletteProblems,
  isDarkColor,
  oklchTripletToHex,
  shownTheme,
} from '../../shared/lib/appearance';

import { CUSTOM_PALETTE_ID, surfaces, type Palette } from './palette-presets';
import {
  applyPalette,
  cacheActivePalette,
  getActivePalette,
  pausePaletteCache,
  resolvePalette,
  setCustomPalette,
  syncWindowsTitleBarOverlay,
  systemIsDark,
} from './palette-runtime';
import { pauseAccentCache } from './primary-color';
import { hexToOklchValues } from './project-colors';

import type { AppearanceSettings, CustomPaletteConfig, ThemeConfig } from '@/types';

/**
 * The sidebar color for a custom theme that leaves it out: the background where it is a visible
 * step off the card, or else a shade under the card, so the work area card stands out. Either
 * one only while text stays readable on it; otherwise the card itself.
 */
export function defaultSidebarColor(
  mode: CustomPaletteConfig['mode'],
  colors: CustomPaletteConfig['surfaces']
): string {
  const text = oklchTripletToHex(MODE_TEXT[mode].foreground)!;
  const mutedText = oklchTripletToHex(MODE_TEXT[mode].mutedForeground)!;
  const readable = (hex: string) =>
    contrastRatio(text, hex) >= MIN_TEXT_CONTRAST &&
    contrastRatio(mutedText, hex) >= MIN_TEXT_CONTRAST;
  const [cardLightness, chroma, hue] = hexToOklchValues(colors.card)!.split(' ').map(Number);
  const backgroundLightness = Number(hexToOklchValues(colors.background)!.split(' ')[0]);
  if (Math.abs(backgroundLightness - cardLightness) >= 0.02 && readable(colors.background)) {
    return colors.background;
  }
  const shade = oklchTripletToHex(`${Math.max(0, cardLightness - 0.03)} ${chroma} ${hue}`)!;
  return readable(shade) ? shade : colors.card;
}

export type CustomPaletteResult =
  | { palette: Palette; problems: [] }
  | { palette: null; problems: string[] };

/** Checks theme.json's customPalette and turns it into a palette, or lists what to fix. */
export function buildCustomPalette(config: unknown): CustomPaletteResult {
  const problems = customPaletteProblems(config);
  if (problems.length > 0) return { palette: null, problems };

  const { mode, name, surfaces: colors, terminal } = config as CustomPaletteConfig;
  // The editor keeps the mode's syntax colors, so a light theme's dark terminal can't back it.
  const terminalFitsMode = isDarkColor(terminal.background) === (mode === 'dark');
  return {
    palette: {
      id: CUSTOM_PALETTE_ID,
      label: name?.trim() || 'Custom',
      mode,
      tokens: surfaces({
        ...colors,
        accent: colors.highlight,
        sidebar: colors.sidebar ?? defaultSidebarColor(mode, colors),
      }),
      xterm: {
        background: terminal.background,
        foreground: terminal.foreground,
        cursor: terminal.cursor,
        selection: terminal.selection,
        ansi: terminal.ansi,
      },
      monaco: { editorBackground: terminalFitsMode ? terminal.background : colors.card },
    },
    problems: [],
  };
}

/**
 * Applies theme.json's palette, or its light palette while it follows a light system appearance.
 * A custom theme with problems is skipped and the last one that worked stays in use, so saving a
 * half-edited file doesn't break the window.
 */
export function syncPaletteFromTheme(theme: ThemeConfig): void {
  if (theme.customPalette === undefined) {
    setCustomPalette(null);
  } else {
    const { palette } = buildCustomPalette(theme.customPalette);
    if (palette) setCustomPalette(palette);
  }

  const wanted = resolvePalette(shownTheme(theme, systemIsDark()).palette);
  if (JSON.stringify(wanted) !== JSON.stringify(getActivePalette())) {
    applyPalette(wanted.id);
  } else {
    // A theme.json change resets the Windows title bar from the main process.
    syncWindowsTitleBarOverlay();
    // An applied preview is already showing but isn't cached yet.
    cacheActivePalette();
  }
}

let stopPreview: (() => void) | null = null;

function withAppearance(theme: ThemeConfig, settings: AppearanceSettings): ThemeConfig {
  const { customPalette: _saved, ...rest } = theme;
  return {
    ...rest,
    palette: settings.palette,
    // The proposed theme shows whatever the system appearance, while the user decides.
    followSystem: false,
    ...(settings.customPalette && { customPalette: settings.customPalette }),
    colors: { ...rest.colors, accent: settings.accent },
    typography: { ...rest.typography, borderRadius: settings.borderRadius },
  };
}

/** Shows appearance settings an agent proposed, without saving them, while the user decides. */
export function previewAppearance(settings: AppearanceSettings): void {
  stopPreview?.();
  // A reload before the user decides should start in the saved appearance, not the preview.
  pausePaletteCache(true);
  pauseAccentCache(true);
  let shown: ThemeConfig | null = null;
  const show = (theme: ThemeConfig | null) => {
    if (!theme || theme === shown) return;
    shown = withAppearance(theme, settings);
    useCustomizationStore.setState({ theme: shown });
  };
  show(useCustomizationStore.getState().theme);
  // theme.json can load or change while the user decides; keep the preview on top of it.
  stopPreview = useCustomizationStore.subscribe((state) => show(state.theme));
}

/**
 * Shows the saved appearance again. After the user applies a preview, the main process has
 * already saved it, so this shows the applied settings.
 */
export async function endAppearancePreview(): Promise<void> {
  stopPreview?.();
  stopPreview = null;
  // Resume before waiting, so the next prompt's preview can pause caching again.
  pausePaletteCache(false);
  pauseAccentCache(false);
  const theme = await window.api.getTheme();
  useCustomizationStore.setState({ theme });
}
