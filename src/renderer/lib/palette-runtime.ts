import { useSyncExternalStore, type CSSProperties } from 'react';

import { useCustomizationStore } from '@/stores/customization.store';

import { isDarkColor, oklchTripletToHex } from '../../shared/lib/appearance';

import { setMonacoPalette, type MonacoWidgetColors } from './monaco-loader';
import {
  CUSTOM_PALETTE_ID,
  DEFAULT_PALETTE_ID,
  PALETTES,
  TOKEN_FALLBACKS,
  getPalette,
  paletteSurface,
  paletteTerminalTokens,
  paletteXterm,
  type Palette,
  type PaletteTokens,
} from './palette-presets';
import { updateTerminalRendererPalette } from './terminal-renderer-runtime';
import { DEFAULT_TERMINAL_THEME, configToTheme } from './terminal-theme';

import type { TerminalConfig } from '@/types';
import type { ITheme } from '@xterm/xterm';

export { oklchTripletToHex };

// theme.json holds the choice. This copy lets the window start in it before theme.json loads.
const CACHE_KEY = 'komla.palette';
const CUSTOM_CACHE_KEY = 'komla.customPalette';

const ALL_TOKEN_NAMES: (keyof PaletteTokens)[] = [
  '--background',
  '--card',
  '--popover',
  '--muted',
  '--secondary',
  '--accent',
  '--border',
  '--input',
  '--sidebar',
  '--sidebar-accent',
  '--sidebar-muted',
  '--sidebar-border',
  '--chrome',
];

let activePalette: Palette = getPalette(DEFAULT_PALETTE_ID);
let customPalette: Palette | null = null;
let cachePaused = false;
const subscribers = new Set<(id: string) => void>();

export function getActivePaletteId(): string {
  return activePalette.id;
}

export function getActivePalette(): Palette {
  return activePalette;
}

/** The custom theme from theme.json, or null to fall back to Default where it is chosen. */
export function setCustomPalette(palette: Palette | null): void {
  customPalette = palette;
}

export function resolvePalette(id: string): Palette {
  if (id === CUSTOM_PALETTE_ID) return customPalette ?? getPalette(DEFAULT_PALETTE_ID);
  return getPalette(id);
}

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether the system appearance is dark. Without a way to tell, Komla assumes it is. */
export function systemIsDark(): boolean {
  return window.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? true;
}

/** Calls the listener when the system appearance switches between dark and light. */
export function subscribeSystemAppearance(listener: () => void): () => void {
  const query = window.matchMedia?.(SYSTEM_DARK_QUERY);
  if (!query) return () => {};
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export function subscribePalette(listener: (id: string) => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function knownPaletteId(stored: string): string {
  return PALETTES.some((p) => p.id === stored) ? stored : DEFAULT_PALETTE_ID;
}

function readCachedCustomPalette(): Palette | null {
  const cached = JSON.parse(localStorage.getItem(CUSTOM_CACHE_KEY) ?? 'null') as Palette | null;
  if (
    cached?.id !== CUSTOM_PALETTE_ID ||
    (cached.mode !== 'dark' && cached.mode !== 'light') ||
    typeof cached.tokens !== 'object' ||
    typeof cached.xterm?.background !== 'string' ||
    typeof cached.monaco?.editorBackground !== 'string'
  ) {
    return null;
  }
  return cached;
}

/** The palette last applied in this browser. A cached custom theme is registered as well. */
export function readStoredPaletteId(): string {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (!stored) return DEFAULT_PALETTE_ID;
    if (stored !== CUSTOM_PALETTE_ID) return knownPaletteId(stored);
    customPalette = readCachedCustomPalette();
    return customPalette ? CUSTOM_PALETTE_ID : DEFAULT_PALETTE_ID;
  } catch {
    return DEFAULT_PALETTE_ID;
  }
}

function applyMode(palette: Palette): void {
  const root = document.documentElement;
  if (palette.mode === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.remove('dark');
    root.classList.add('light');
  }
}

function clearAllOverrides(): void {
  const root = document.documentElement;
  for (const name of ALL_TOKEN_NAMES) {
    root.style.removeProperty(name);
  }
}

function applyTokens(tokens: PaletteTokens): void {
  const root = document.documentElement;
  for (const name of ALL_TOKEN_NAMES) {
    const fallback = TOKEN_FALLBACKS[name];
    const value = tokens[name] ?? (fallback && tokens[fallback]);
    if (value === undefined) {
      root.style.removeProperty(name);
    } else {
      root.style.setProperty(name, value);
    }
  }
}

type TitleBarOverlaySurface = 'card' | 'chrome' | 'background';

// The surface under the Windows window controls: the title bar's card by default, the
// sidebar's chrome while the title bar takes it (no workspace open, the setup wizard), or
// what a full-window page that covers the title bar puts there: Settings' background, or the
// card of QuickLook's top row. Those pages sit on top, so their claims win over chrome.
const titleBarOverlayClaims: Record<TitleBarOverlaySurface, number> = {
  card: 0,
  chrome: 0,
  background: 0,
};

function titleBarOverlaySurface(): TitleBarOverlaySurface {
  if (titleBarOverlayClaims.background > 0) return 'background';
  if (titleBarOverlayClaims.card > 0) return 'card';
  if (titleBarOverlayClaims.chrome > 0) return 'chrome';
  return 'card';
}

/** Puts the Windows window controls on `surface` until the returned release is called. */
export function claimWindowsTitleBarOverlaySurface(surface: TitleBarOverlaySurface): () => void {
  titleBarOverlayClaims[surface] += 1;
  syncWindowsTitleBarOverlay();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    titleBarOverlayClaims[surface] -= 1;
    syncWindowsTitleBarOverlay();
  };
}

// On Windows the OS draws the window controls inside an overlay rectangle
// whose colors must be set from the main process via setTitleBarOverlay.
// Palette switches happen entirely in the renderer (CSS vars), so without
// this push the overlay keeps its constructor-time colors.
export function syncWindowsTitleBarOverlay(): void {
  if (window.api.platform !== 'win32') return;
  const computed = getComputedStyle(document.documentElement);
  const surfaceName = titleBarOverlaySurface();
  const surface = computed.getPropertyValue(`--${surfaceName}`);
  const surfaceFg = computed.getPropertyValue(
    surfaceName === 'card' ? '--card-foreground' : '--foreground'
  );
  const color = oklchTripletToHex(surface);
  const symbolColor = oklchTripletToHex(surfaceFg);
  if (!color || !symbolColor) return;
  window.api.setTitleBarOverlay({ color, symbolColor }).catch(() => {
    // IPC failures here are non-fatal — the overlay just keeps its prior color.
  });
}

export function applyPalette(paletteId: string): void {
  showPalette(resolvePalette(paletteId));
}

// A dark palette's editor widgets sit on its card and hover to its muted fill, as Komla Dark's do.
// Light palettes keep Komla Light's, since their editor is often their card, and so does a dark
// palette whose editor is its card, where widgets on it wouldn't show.
function paletteMonacoWidgets(palette: Palette): MonacoWidgetColors | null {
  if (palette.mode !== 'dark') return null;
  const background = oklchTripletToHex(paletteSurface(palette, '--card'));
  const hover = palette.tokens['--muted'] && oklchTripletToHex(palette.tokens['--muted']);
  if (!background || !hover) return null;
  if (background.toLowerCase() === palette.monaco.editorBackground.toLowerCase()) return null;
  return { background, hover };
}

function showPalette(palette: Palette): void {
  activePalette = palette;

  applyMode(palette);

  if (palette.id === DEFAULT_PALETTE_ID) {
    clearAllOverrides();
    setMonacoPalette(palette.mode, null, null);
  } else {
    applyTokens(palette.tokens);
    setMonacoPalette(palette.mode, palette.monaco.editorBackground, paletteMonacoWidgets(palette));
  }
  // Read from the live customization store so user-customized terminal colors
  // are preserved under palettes that don't replace them.
  updateTerminalRendererPalette(
    buildTerminalTheme(useCustomizationStore.getState().terminalConfig)
  );

  syncWindowsTitleBarOverlay();
  cacheActivePalette();

  subscribers.forEach((listener) => listener(palette.id));
}

/** Remembers the active palette so the next launch starts in it, unless caching is paused. */
export function cacheActivePalette(): void {
  if (cachePaused) return;
  try {
    if (activePalette.id === DEFAULT_PALETTE_ID) {
      localStorage.removeItem(CACHE_KEY);
    } else {
      localStorage.setItem(CACHE_KEY, activePalette.id);
    }
    if (activePalette.id === CUSTOM_PALETTE_ID) {
      localStorage.setItem(CUSTOM_CACHE_KEY, JSON.stringify(activePalette));
    } else {
      localStorage.removeItem(CUSTOM_CACHE_KEY);
    }
  } catch {
    // Ignore quota / disabled storage
  }
}

/** While paused, palettes still apply but the next launch keeps starting in the cached one. */
export function pausePaletteCache(paused: boolean): void {
  cachePaused = paused;
}

function subscribeStore(listener: () => void): () => void {
  return subscribePalette(listener);
}

function getActiveIdSnapshot(): string {
  return activePalette.id;
}

function getActiveSnapshot(): Palette {
  return activePalette;
}

export function useActivePaletteId(): string {
  return useSyncExternalStore(subscribeStore, getActiveIdSnapshot, getActiveIdSnapshot);
}

/** Unlike the id, this also changes when the custom theme is edited. */
export function useActivePalette(): Palette {
  return useSyncExternalStore(subscribeStore, getActiveSnapshot, getActiveSnapshot);
}

// Returns the terminal background hex the active palette brings, or null when the terminal uses
// the Terminal settings. TerminalView uses this to paint the wrapper DIV behind the xterm canvas
// so palette switches don't leak the customization-store's bg through padding.
export function getPaletteTerminalBackground(): string | null {
  return paletteXterm(activePalette)?.background ?? null;
}

/**
 * Terminals stay dark in light themes, so a terminal pane on its `background` there takes dark
 * surfaces and the accent or project color fitted to dark, which keeps its header and search bar
 * readable on the terminal.
 */
export function useTerminalPaneScope(background: string | undefined): {
  className?: string;
  style?: CSSProperties;
} {
  const palette = useActivePalette();
  if (palette.mode === 'dark' || background === undefined || !isDarkColor(background)) return {};
  return {
    className: 'dark',
    style: {
      ...paletteTerminalTokens(palette),
      '--primary': 'var(--dark-primary)',
      '--ring': 'var(--dark-primary)',
    } as CSSProperties,
  };
}

/** The terminal canvas color, so chrome drawn over a terminal can sit on the same surface. */
export function useTerminalBackground(): string | undefined {
  useActivePalette();
  const configured = useCustomizationStore((s) => s.terminalConfig?.colors.background);
  return getPaletteTerminalBackground() ?? configured;
}

/**
 * The color browser pages and Markdown editors sit on: the code editor's, so a Markdown file looks
 * the same in Rich and Source mode. In dark themes it's the terminal's default color too.
 */
export function useEditorSurfaceBackground(): string {
  return useActivePalette().monaco.editorBackground;
}

// The xterm theme for the Terminal settings under the active palette. TerminalView uses it on
// terminal creation and after terminalConfig hot-reloads so the canvas matches the chrome.
export function buildTerminalTheme(config: TerminalConfig | null): ITheme {
  return paletteTerminalTheme(activePalette, config);
}

/**
 * The xterm theme for the Terminal settings under a palette: its background and foreground,
 * plus a named theme's own cursor, selection and ANSI colors.
 */
export function paletteTerminalTheme(palette: Palette, config: TerminalConfig | null): ITheme {
  const theme = config ? configToTheme(config) : DEFAULT_TERMINAL_THEME;
  const xterm = paletteXterm(palette);
  if (!xterm) return theme;
  return {
    ...theme,
    background: xterm.background,
    foreground: xterm.foreground,
    cursorAccent: xterm.background,
    selectionForeground: xterm.foreground,
    ...(xterm.cursor && { cursor: xterm.cursor }),
    ...(xterm.selection && { selectionBackground: xterm.selection }),
    ...xterm.ansi,
  };
}
