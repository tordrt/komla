import fs from 'fs';
import path from 'path';

import { PALETTES } from '../src/renderer/lib/palette-presets';
import { SANDBOX_DIR, test as base, expect, type Page, seedDefaultProject } from './electron-app';

const THEME_PATH = path.join(SANDBOX_DIR, 'settings', 'theme.json');
const KOMLA_LIGHT_BACKGROUND = PALETTES.find((palette) => palette.label === 'Komla Light')?.tokens[
  '--background'
];
if (!KOMLA_LIGHT_BACKGROUND) throw new Error('Komla Light has no --background in PALETTES');

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'theme/' });
    await provide();
  },
});

async function readServerPort(): Promise<number> {
  const portFile = path.join(SANDBOX_DIR, 'port');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (Number.isFinite(port) && port > 0) return port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('HTTP server port file never appeared');
}

async function waitForMainUi(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function openAppearanceTab(window: Page): Promise<void> {
  // Settings loads lazily on first open; re-dispatch until it renders.
  await expect(async () => {
    await window.evaluate(() =>
      window.dispatchEvent(new CustomEvent('open-settings', { detail: 'appearance' }))
    );
    await expect(window.getByRole('dialog').filter({ hasText: 'Theme' }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 15_000 });
}

test.describe('Theme live apply', () => {
  test('switching theme in Appearance settings updates the renderer DOM live', async ({
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    await openAppearanceTab(appWindow);

    const dialog = appWindow.getByRole('dialog').filter({ hasText: 'Theme' }).first();

    try {
      // Force a known starting state (Electron persists palette in userData, not
      // KOMLA_DATA_DIR, so prior tests in the suite can leak their selection).
      await dialog.getByRole('button', { name: /^Komla Dark/ }).click();
      await expect
        .poll(() =>
          appWindow.evaluate(() => document.documentElement.style.getPropertyValue('--background'))
        )
        .toBe('');

      // Click the Komla Light palette card; renderer should mutate CSS vars live.
      await dialog.getByRole('button', { name: /^Komla Light/ }).click();

      await expect
        .poll(() =>
          appWindow.evaluate(() => document.documentElement.style.getPropertyValue('--background'))
        )
        .toBe(KOMLA_LIGHT_BACKGROUND);

      // Dialog stays open — the flip happens without a remount or app restart.
      await expect(dialog).toBeVisible();
    } finally {
      // Reset to Komla Dark so we don't leak the Komla Light selection into
      // subsequent suite tests via Electron-persisted localStorage. The UI
      // path may not be available if the test failed mid-flight (dialog
      // closed, page remounted), so wipe the storage key directly as a
      // belt-and-braces fallback.
      await dialog
        .getByRole('button', { name: /^Komla Dark/ })
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await appWindow
        .evaluate(() => localStorage.removeItem('komla.palette'))
        .catch(() => undefined);
    }
  });

  test('saves the chosen theme to theme.json and applies edits to that file live', async ({
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    await openAppearanceTab(appWindow);
    const dialog = appWindow.getByRole('dialog').filter({ hasText: 'Theme' }).first();
    const readTheme = () => JSON.parse(fs.readFileSync(THEME_PATH, 'utf8'));

    try {
      await dialog.getByRole('button', { name: /^Nord/ }).click();
      await expect.poll(() => readTheme().palette).toBe('nord');

      // What an agent following the appearance skill does.
      fs.writeFileSync(
        THEME_PATH,
        JSON.stringify({
          ...readTheme(),
          palette: 'custom',
          customPalette: {
            name: 'Moss',
            mode: 'light',
            surfaces: {
              background: '#f4f7f2',
              card: '#ffffff',
              muted: '#e6ede3',
              highlight: '#dde8d8',
              border: '#c4d2bf',
            },
            terminal: { background: '#f4f7f2', foreground: '#26331f' },
          },
        })
      );

      await expect
        .poll(() => appWindow.evaluate(() => document.documentElement.className))
        .toContain('light');
      await expect(dialog.getByRole('button', { name: /^Moss/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    } finally {
      await dialog
        .getByRole('button', { name: /^Komla Dark/ })
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await appWindow
        .evaluate(() => localStorage.removeItem('komla.palette'))
        .catch(() => undefined);
    }
  });

  test("previews an agent's appearance change and saves it only once applied", async ({
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    const port = await readServerPort();
    const htmlClass = () => appWindow.evaluate(() => document.documentElement.className);
    // What `komla settings apply appearance` sends. Frost is a light theme.
    const apply = () =>
      fetch(`http://127.0.0.1:${port}/settings/appearance`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          palette: 'frost',
          accent: 'oklch(0.65 0.15 250)',
          borderRadius: 6,
        }),
      }).then((response) => response.json());
    const dialog = appWindow.getByRole('dialog').filter({ hasText: 'Review settings changes' });

    try {
      const cancelled = apply();
      await expect(dialog).toBeVisible();
      await expect.poll(htmlClass).toContain('light');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect(await cancelled).toMatchObject({ status: 'cancelled' });
      await expect.poll(htmlClass).toContain('dark');

      const applied = apply();
      await dialog.getByRole('button', { name: 'Apply changes' }).click();
      expect(await applied).toMatchObject({ status: 'applied', palette: 'frost' });
      await expect
        .poll(() => JSON.parse(fs.readFileSync(THEME_PATH, 'utf8')).palette)
        .toBe('frost');
      expect(await htmlClass()).toContain('light');
    } finally {
      await appWindow
        .evaluate(() => localStorage.removeItem('komla.palette'))
        .catch(() => undefined);
    }
  });
});
