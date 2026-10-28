/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/monaco-loader', () => ({
  setMonacoPalette: vi.fn(),
}));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  updateTerminalRendererPalette: vi.fn(),
}));

import {
  applyPalette,
  getActivePalette,
  oklchTripletToHex,
  readStoredPaletteId,
  resolvePalette,
  setCustomPalette,
} from '../../../src/renderer/lib/palette-runtime';
import { applyAccent, readStoredAccent } from '../../../src/renderer/lib/primary-color';
import { hexToOklchValues } from '../../../src/renderer/lib/project-colors';
import {
  buildCustomPalette,
  endAppearancePreview,
  previewAppearance,
  syncPaletteFromTheme,
} from '../../../src/renderer/lib/theme-palette';
import { useCustomizationStore } from '../../../src/renderer/stores/customization.store';
import { MODE_TEXT } from '../../../src/shared/lib/appearance';

import type { ThemeConfig } from '../../../src/renderer/types';

const skill = readFileSync('resources/skills/komla-appearance-instructions.md', 'utf8');
const example = JSON.parse(skill.match(/```json\n([\s\S]*?)```/)![1]).customPalette;

function theme(overrides: Partial<ThemeConfig> = {}): ThemeConfig {
  return {
    mode: 'dark',
    palette: 'default',
    followSystem: false,
    lightPalette: 'frost',
    colors: { accent: 'oklch(0.65 0.15 250)' },
    typography: { fontFamily: 'Inter', fontSize: 14, borderRadius: 6 },
    ...overrides,
  };
}

function withSurface(key: string, value: string) {
  return { ...example, surfaces: { ...example.surfaces, [key]: value } };
}

describe('buildCustomPalette', () => {
  it('accepts the example in the appearance skill', () => {
    const { palette, problems } = buildCustomPalette(example);

    expect(problems).toEqual([]);
    expect(palette).toMatchObject({
      id: 'custom',
      label: 'Moss',
      mode: 'dark',
      xterm: {
        background: '#0f1410',
        foreground: '#c8d8c0',
        cursor: '#8fd18a',
        selection: '#2a362d',
        ansi: { green: '#8fd18a', brightGreen: '#b5e8a8' },
      },
      monaco: { editorBackground: '#0f1410' },
    });
    expect(palette?.tokens['--accent']).toBe(hexToOklchValues('#2a362d'));
    expect(palette?.tokens['--popover']).toBe(hexToOklchValues('#1c251e'));
  });

  it('defaults the popover to the card color and the label to Custom', () => {
    const { popover: _popover, ...surfaces } = example.surfaces;
    const { palette } = buildCustomPalette({ ...example, name: ' ', surfaces });

    expect(palette?.label).toBe('Custom');
    expect(palette?.tokens['--popover']).toBe(palette?.tokens['--card']);
  });

  it('uses the sidebar color given', () => {
    const { palette } = buildCustomPalette(withSurface('sidebar', '#0b0f0c'));

    expect(palette?.tokens['--chrome']).toBe(hexToOklchValues('#0b0f0c'));
  });

  it('defaults the sidebar to the background when it is a step off the card', () => {
    const { sidebar: _sidebar, ...surfaces } = example.surfaces;
    const { palette } = buildCustomPalette({ ...example, surfaces });

    expect(palette?.tokens['--chrome']).toBe(hexToOklchValues(example.surfaces.background));
  });

  it('defaults the sidebar to a shade under the card when the background matches it', () => {
    const { sidebar: _sidebar, ...surfaces } = example.surfaces;
    const { palette } = buildCustomPalette({
      ...example,
      surfaces: { ...surfaces, background: surfaces.card },
    });
    const lightness = (token: '--chrome' | '--card') =>
      Number(palette!.tokens[token]!.split(' ')[0]);

    expect(lightness('--card') - lightness('--chrome')).toBeCloseTo(0.03, 2);
  });

  it('keeps the sidebar on the card when nothing off it keeps secondary text readable', () => {
    const { palette } = buildCustomPalette({
      ...example,
      mode: 'light',
      surfaces: {
        background: '#e4e4e4',
        card: '#e4e4e4',
        muted: '#e0e0e0',
        highlight: '#dddddd',
        border: '#cccccc',
      },
    });

    expect(palette?.tokens['--chrome']).toBe(palette?.tokens['--card']);
  });

  it('rejects a sidebar color text would be hard to read on', () => {
    const { problems } = buildCustomPalette(withSurface('sidebar', '#a0a0a0'));

    expect(problems).toEqual([
      expect.stringMatching(/^Text on surfaces\.sidebar .*Make surfaces\.sidebar darker\.$/),
      expect.stringMatching(/^Secondary text on surfaces\.sidebar .*darker\.$/),
    ]);
  });

  it('rejects a value that is not an object', () => {
    for (const config of [null, 'nord', [example]]) {
      expect(buildCustomPalette(config).problems).toEqual(['customPalette must be an object.']);
    }
  });

  it('lists every field to fix', () => {
    const { palette, problems } = buildCustomPalette({
      mode: 'dim',
      surfaces: { background: 'black', card: '#18201a', muted: '#222c24', border: '#3a4a3e' },
      terminal: { background: '#0f1410', foreground: '#fff', ansi: { orange: '#ff8800' } },
    });

    expect(palette).toBeNull();
    expect(problems).toEqual([
      'customPalette.mode must be "dark" or "light".',
      'customPalette.surfaces.background must be a 6-digit hex color like "#1e1e2e".',
      'customPalette.surfaces.highlight must be a 6-digit hex color like "#1e1e2e".',
      'customPalette.terminal.foreground must be a 6-digit hex color like "#1e1e2e".',
      expect.stringMatching(/^customPalette\.terminal\.ansi\.orange isn't a terminal color\./),
    ]);
  });

  it('rejects a dark theme whose text would be hard to read', () => {
    const { palette, problems } = buildCustomPalette(withSurface('card', '#a0a0a0'));

    expect(palette).toBeNull();
    expect(problems).toEqual([
      expect.stringMatching(
        /^Text on surfaces\.card has 2\.\d:1 contrast.*Make surfaces\.card darker\.$/
      ),
      expect.stringMatching(/^Secondary text on surfaces\.card .*darker\.$/),
    ]);
  });

  it('rejects a light theme with a surface too dark for its text', () => {
    const { problems } = buildCustomPalette({
      ...example,
      mode: 'light',
      surfaces: {
        ...example.surfaces,
        background: '#5a5a5a',
        card: '#ffffff',
        popover: '#ffffff',
        sidebar: '#f4f4f4',
      },
    });

    expect(problems).toEqual([
      expect.stringMatching(/^Text on surfaces\.background .*Make surfaces\.background lighter\.$/),
    ]);
  });

  it('rejects terminal text that blends into its background', () => {
    const { problems } = buildCustomPalette({
      ...example,
      terminal: { background: '#0f1410', foreground: '#3a4a3e' },
    });

    expect(problems).toEqual([
      expect.stringMatching(/^terminal\.foreground on terminal\.background has /),
    ]);
  });
});

describe('appearance skill', () => {
  it('leaves the built-in themes to the list `komla settings get appearance` returns', () => {
    expect(skill).toContain('the built-in `themes`');
    expect(skill).not.toMatch(/Built-in (dark|light) themes:/);
  });

  it('gives the text colors Komla checks against, matching globals.css', () => {
    const css = readFileSync('src/renderer/styles/globals.css', 'utf8');
    const block = (selector: string) => css.slice(css.indexOf(`${selector} {`));
    const cssValue = (selector: string, token: string) =>
      block(selector).match(new RegExp(`--${token}: ([^;]+);`))![1];

    for (const [mode, selector] of [
      ['dark', '.dark'],
      ['light', ':root'],
    ] as const) {
      expect(MODE_TEXT[mode].foreground).toBe(cssValue(selector, 'foreground'));
      expect(MODE_TEXT[mode].mutedForeground).toBe(cssValue(selector, 'muted-foreground'));
      expect(skill).toContain(oklchTripletToHex(MODE_TEXT[mode].foreground)!);
      expect(skill).toContain(oklchTripletToHex(MODE_TEXT[mode].mutedForeground)!);
    }
  });
});

describe('syncPaletteFromTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    window.api = {
      platform: 'darwin',
    } as unknown as typeof window.api;
    setCustomPalette(null);
    applyPalette('default');
  });

  it('applies the palette chosen in theme.json', () => {
    syncPaletteFromTheme(theme({ palette: 'nord' }));

    expect(getActivePalette().id).toBe('nord');
    expect(localStorage.getItem('komla.palette')).toBe('nord');
  });

  it('applies a custom theme and follows edits to it', () => {
    syncPaletteFromTheme(theme({ palette: 'custom', customPalette: example }));
    expect(getActivePalette().label).toBe('Moss');

    syncPaletteFromTheme(
      theme({ palette: 'custom', customPalette: withSurface('card', '#1d261f') })
    );
    expect(getActivePalette().tokens['--card']).toBe(hexToOklchValues('#1d261f'));
    expect(document.documentElement.style.getPropertyValue('--card')).toBe(
      hexToOklchValues('#1d261f')
    );
  });

  it('keeps the last custom theme that worked when an edit has problems', () => {
    syncPaletteFromTheme(theme({ palette: 'custom', customPalette: example }));
    const working = getActivePalette();

    syncPaletteFromTheme(
      theme({ palette: 'custom', customPalette: withSurface('card', '#8a8a8a') })
    );

    expect(getActivePalette()).toBe(working);
  });

  it('falls back to Default when the custom theme is removed or never worked', () => {
    syncPaletteFromTheme(theme({ palette: 'custom', customPalette: example }));
    syncPaletteFromTheme(theme({ palette: 'custom' }));
    expect(getActivePalette().id).toBe('default');

    syncPaletteFromTheme(
      theme({ palette: 'custom', customPalette: withSurface('card', '#8a8a8a') })
    );
    expect(getActivePalette().id).toBe('default');
  });

  it('starts in the cached custom theme before theme.json loads', () => {
    syncPaletteFromTheme(theme({ palette: 'custom', customPalette: example }));
    setCustomPalette(null);

    expect(readStoredPaletteId()).toBe('custom');
    expect(resolvePalette('custom').label).toBe('Moss');
  });
});

describe('following the system appearance', () => {
  const following = theme({ palette: 'nord', followSystem: true, lightPalette: 'github-light' });

  function systemIs(appearance: 'dark' | 'light') {
    window.matchMedia = vi.fn(() => ({
      matches: appearance === 'dark',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    localStorage.clear();
    window.api = { platform: 'darwin', getTheme: vi.fn() } as unknown as typeof window.api;
    setCustomPalette(null);
    applyPalette('default');
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('shows the light theme while the system is light and the dark one while it is dark', () => {
    systemIs('light');
    syncPaletteFromTheme(following);
    expect(getActivePalette().id).toBe('github-light');

    systemIs('dark');
    syncPaletteFromTheme(following);
    expect(getActivePalette().id).toBe('nord');
  });

  it('keeps the theme whatever the system appearance unless following it', () => {
    systemIs('light');
    syncPaletteFromTheme({ ...following, followSystem: false });

    expect(getActivePalette().id).toBe('nord');
  });

  it('previews a proposed theme even when the system shows the other appearance', async () => {
    systemIs('light');
    useCustomizationStore.setState({ theme: following });

    previewAppearance({ palette: 'dracula', accent: 'oklch(0.74 0.15 302)', borderRadius: 6 });
    syncPaletteFromTheme(useCustomizationStore.getState().theme!);
    expect(getActivePalette().id).toBe('dracula');

    vi.mocked(window.api.getTheme).mockResolvedValue(following);
    await endAppearancePreview();
    syncPaletteFromTheme(useCustomizationStore.getState().theme!);
    expect(getActivePalette().id).toBe('github-light');
  });
});

describe('appearance preview', () => {
  const saved = theme({ palette: 'nord' });
  const proposed = { palette: 'frost', accent: 'oklch(0.5 0.15 145)', borderRadius: 8 };

  // What the app does whenever the shown theme changes.
  function showStoreTheme(): void {
    const shown = useCustomizationStore.getState().theme!;
    syncPaletteFromTheme(shown);
    applyAccent(shown.colors.accent, getActivePalette().mode);
  }

  beforeEach(() => {
    localStorage.clear();
    window.api = { platform: 'darwin', getTheme: vi.fn() } as unknown as typeof window.api;
    setCustomPalette(null);
    useCustomizationStore.setState({ theme: saved });
    showStoreTheme();
  });

  it('keeps the saved appearance for the next launch while previewing', async () => {
    previewAppearance(proposed);
    showStoreTheme();

    expect(getActivePalette().id).toBe('frost');
    expect(readStoredPaletteId()).toBe('nord');
    expect(readStoredAccent()).toBe(saved.colors.accent);

    vi.mocked(window.api.getTheme).mockResolvedValue(saved);
    await endAppearancePreview();
    showStoreTheme();

    expect(getActivePalette().id).toBe('nord');
    expect(readStoredPaletteId()).toBe('nord');
  });

  it('starts the next launch in an applied preview', async () => {
    previewAppearance(proposed);
    showStoreTheme();

    vi.mocked(window.api.getTheme).mockResolvedValue(
      theme({ palette: 'frost', colors: { accent: proposed.accent } })
    );
    await endAppearancePreview();
    showStoreTheme();

    expect(readStoredPaletteId()).toBe('frost');
    expect(readStoredAccent()).toBe(proposed.accent);
  });
});
