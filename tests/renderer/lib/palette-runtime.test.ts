/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/monaco-loader', () => ({
  setMonacoPalette: vi.fn(),
}));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  updateTerminalRendererPalette: vi.fn(),
}));

import { setMonacoPalette } from '../../../src/renderer/lib/monaco-loader';
import { getPalette } from '../../../src/renderer/lib/palette-presets';
import {
  applyPalette,
  buildTerminalTheme,
  claimWindowsTitleBarOverlaySurface,
  oklchTripletToHex,
  readStoredPaletteId,
  setCustomPalette,
  subscribeSystemAppearance,
  useEditorSurfaceBackground,
  useTerminalPaneScope,
} from '../../../src/renderer/lib/palette-runtime';
import { updateTerminalRendererPalette } from '../../../src/renderer/lib/terminal-renderer-runtime';
import { configToTheme } from '../../../src/renderer/lib/terminal-theme';
import { buildCustomPalette } from '../../../src/renderer/lib/theme-palette';
import { useCustomizationStore } from '../../../src/renderer/stores/customization.store';

import type { TerminalConfig } from '../../../src/renderer/types';

const terminalConfig = {
  colors: {
    background: '#000001',
    foreground: '#eeeeee',
    cursor: '#ff00ff',
    selection: '#333333',
    ansi: {
      black: '#010101',
      red: '#aa0000',
      green: '#00aa00',
      yellow: '#aaaa00',
      blue: '#0000aa',
      magenta: '#aa00aa',
      cyan: '#00aaaa',
      white: '#aaaaaa',
      brightBlack: '#555555',
      brightRed: '#ff5555',
      brightGreen: '#55ff55',
      brightYellow: '#ffff55',
      brightBlue: '#5555ff',
      brightMagenta: '#ff55ff',
      brightCyan: '#55ffff',
      brightWhite: '#ffffff',
    },
  },
} as TerminalConfig;

// A custom theme that sets only the terminal background and foreground.
const withoutTerminalColors = buildCustomPalette({
  mode: 'dark',
  surfaces: {
    background: '#0f1410',
    card: '#18201a',
    muted: '#222c24',
    highlight: '#2a362d',
    border: '#3a4a3e',
  },
  terminal: { background: '#0f1410', foreground: '#c8d8c0' },
}).palette!;

describe('palette runtime', () => {
  beforeEach(() => {
    window.api = { platform: 'darwin' } as typeof window.api;
    localStorage.clear();
    useCustomizationStore.setState({ terminalConfig });
    vi.mocked(updateTerminalRendererPalette).mockClear();
    applyPalette('default');
  });

  it('uses the Terminal settings unchanged on the default palette', () => {
    expect(buildTerminalTheme(terminalConfig)).toEqual(configToTheme(terminalConfig));
  });

  it("keeps the Terminal settings' ANSI colors under a custom theme without its own", () => {
    setCustomPalette(withoutTerminalColors);
    applyPalette('custom');
    const theme = buildTerminalTheme(terminalConfig);

    expect(theme.background).toBe('#0f1410');
    expect(theme.red).toBe('#aa0000');
    expect(theme.cursor).toBe('#ff00ff');
  });

  it("applies a named theme's cursor, selection and ANSI colors", () => {
    applyPalette('dracula');
    const theme = buildTerminalTheme(terminalConfig);

    expect(theme).toMatchObject({
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      selectionForeground: '#f8f8f2',
      red: '#ff5555',
      brightWhite: '#ffffff',
    });
  });

  const lastMonacoWidgets = () => vi.mocked(setMonacoPalette).mock.lastCall?.[2];

  it("puts a dark theme's editor widgets on its card, hovering to its muted fill", () => {
    applyPalette('dracula');
    const dracula = getPalette('dracula');

    expect(setMonacoPalette).toHaveBeenLastCalledWith('dark', dracula.monaco.editorBackground, {
      background: oklchTripletToHex(dracula.tokens['--card']!),
      hover: oklchTripletToHex(dracula.tokens['--muted']!),
    });
  });

  it("keeps Komla Dark's and the light themes' own editor widgets", () => {
    applyPalette('frost');
    expect(lastMonacoWidgets()).toBeNull();

    applyPalette('dracula');
    applyPalette('default');
    expect(setMonacoPalette).toHaveBeenLastCalledWith('dark', null, null);
  });

  it("keeps the mode's own editor widgets for a dark theme whose editor is its card", () => {
    const dracula = getPalette('dracula');
    setCustomPalette({
      ...dracula,
      id: 'custom',
      monaco: { editorBackground: oklchTripletToHex(dracula.tokens['--card']!)! },
    });
    applyPalette('custom');

    expect(lastMonacoWidgets()).toBeNull();
  });

  it("gives a light theme its dark sibling's terminal", () => {
    applyPalette('catppuccin-latte');

    expect(buildTerminalTheme(terminalConfig)).toMatchObject({
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      red: '#f38ba8',
    });
  });

  it("gives Komla Light Ghostty's terminal, keeping the Terminal settings' other colors", () => {
    applyPalette('frost');

    expect(buildTerminalTheme(terminalConfig)).toEqual({
      ...configToTheme(terminalConfig),
      background: '#282c34',
      foreground: '#ffffff',
      cursorAccent: '#282c34',
      selectionForeground: '#ffffff',
    });
  });

  it("restores the Terminal settings' colors on live terminals when leaving a named theme", () => {
    applyPalette('dracula');
    applyPalette('default');

    expect(vi.mocked(updateTerminalRendererPalette).mock.lastCall?.[0]).toMatchObject({
      red: '#aa0000',
      cursor: '#ff00ff',
      selectionBackground: '#333333',
    });
  });

  it("keeps a custom theme's sidebar on its card, accent and border colors", () => {
    const root = document.documentElement.style;
    setCustomPalette(withoutTerminalColors);
    applyPalette('custom');
    const { tokens } = withoutTerminalColors;

    expect(root.getPropertyValue('--sidebar')).toBe(tokens['--card']);
    expect(root.getPropertyValue('--sidebar-accent')).toBe(tokens['--accent']);
    expect(root.getPropertyValue('--sidebar-border')).toBe(tokens['--border']);

    applyPalette('dracula');
    expect(root.getPropertyValue('--sidebar')).toBe(getPalette('dracula').tokens['--sidebar']);

    applyPalette('frost');
    expect(root.getPropertyValue('--sidebar')).toBe(getPalette('frost').tokens['--sidebar']);

    applyPalette('default');
    expect(root.getPropertyValue('--sidebar')).toBe('');
  });

  describe('terminal panes', () => {
    const scope = (background: string) =>
      renderHook(() => useTerminalPaneScope(background)).result.current;

    it('stay as they are in a dark theme', () => {
      applyPalette('dracula');
      expect(scope('#282a36')).toEqual({});
    });

    it("take the dark sibling's surfaces and the accent or project color fitted to dark", () => {
      applyPalette('github-light');
      const { className, style } = scope('#0d1117');

      expect(className).toBe('dark');
      expect(style).toMatchObject({
        '--card': getPalette('github-dark').tokens['--card'],
        '--primary': 'var(--dark-primary)',
        '--ring': 'var(--dark-primary)',
      });
    });

    it("take Komla Light's own surfaces for its softer terminal", () => {
      applyPalette('frost');
      const { className, style } = scope('#282c34');

      expect(className).toBe('dark');
      expect(style).toMatchObject({ '--card': getPalette('frost').terminalTokens?.['--card'] });
    });

    it('stay light under a custom light theme with a light terminal', () => {
      setCustomPalette(
        buildCustomPalette({
          mode: 'light',
          surfaces: {
            background: '#ffffff',
            card: '#fafafa',
            muted: '#f0f0f0',
            highlight: '#e8e8e8',
            border: '#dddddd',
          },
          terminal: { background: '#ffffff', foreground: '#222222' },
        }).palette!
      );
      applyPalette('custom');

      expect(scope('#ffffff')).toEqual({});
    });
  });

  describe('browser pages and Markdown editors', () => {
    const background = () => renderHook(() => useEditorSurfaceBackground()).result.current;

    it("sit on the code editor's color in Komla Dark, whatever the Terminal settings say", () => {
      expect(background()).toBe('#13171b');
    });

    it("sit on a dark theme's code editor color", () => {
      applyPalette('dracula');
      expect(background()).toBe('#282a36');
    });

    it("sit on the code editor's color in a light theme, whose terminals stay dark", () => {
      applyPalette('frost');
      expect(background()).toBe('#f6f6f8');
    });
  });

  it('calls back when the system appearance switches, until unsubscribed', () => {
    const query = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia;
    const listener = vi.fn();

    const unsubscribe = subscribeSystemAppearance(listener);
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(query.addEventListener).toHaveBeenCalledWith('change', listener);

    unsubscribe();
    expect(query.removeEventListener).toHaveBeenCalledWith('change', listener);
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('falls back to Default for a cached id that is no palette', () => {
    localStorage.setItem('komla.palette', 'nord');
    expect(readStoredPaletteId()).toBe('nord');

    localStorage.setItem('komla.palette', 'unknown');
    expect(readStoredPaletteId()).toBe('default');
  });

  describe('Windows window controls', () => {
    const surfaces = { card: '0.2 0 0', chrome: '0.15 0 0', background: '0.1 0 0' };
    const setTitleBarOverlay = vi.fn().mockResolvedValue(undefined);
    const overlayColor = () => setTitleBarOverlay.mock.lastCall?.[0].color;
    let releases: (() => void)[] = [];
    const claim = (surface: Parameters<typeof claimWindowsTitleBarOverlaySurface>[0]) => {
      const release = claimWindowsTitleBarOverlaySurface(surface);
      releases.push(release);
      return release;
    };

    beforeEach(() => {
      const root = document.documentElement;
      for (const [name, value] of Object.entries(surfaces))
        root.style.setProperty(`--${name}`, value);
      root.style.setProperty('--foreground', '0.9 0 0');
      root.style.setProperty('--card-foreground', '0.9 0 0');
      setTitleBarOverlay.mockClear();
      window.api = { platform: 'win32', setTitleBarOverlay } as unknown as typeof window.api;
    });

    afterEach(() => {
      releases.forEach((release) => release());
      releases = [];
    });

    it('takes the chrome while no workspace is open', () => {
      const release = claim('chrome');
      expect(overlayColor()).toBe(oklchTripletToHex(surfaces.chrome));

      release();
      expect(overlayColor()).toBe(oklchTripletToHex(surfaces.card));
    });

    it('goes back to the chrome when Settings closes over the empty page', () => {
      claim('chrome');
      const releaseSettings = claim('background');
      expect(overlayColor()).toBe(oklchTripletToHex(surfaces.background));

      releaseSettings();
      expect(overlayColor()).toBe(oklchTripletToHex(surfaces.chrome));
    });

    it("keeps a card page's card over the empty page", () => {
      claim('chrome');
      const releasePage = claim('card');
      expect(overlayColor()).toBe(oklchTripletToHex(surfaces.card));

      releasePage();
      expect(overlayColor()).toBe(oklchTripletToHex(surfaces.chrome));
    });
  });
});
