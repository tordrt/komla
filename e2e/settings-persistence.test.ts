import fs from 'fs';
import path from 'path';

import {
  test as base,
  expect,
  launchApp,
  SANDBOX_DIR,
  seedDefaultProject,
  type Page,
} from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({});
    await provide();
  },
});

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

test.describe('Settings persistence', () => {
  test.describe.configure({ timeout: 90_000 });

  test('zoom level survives an app restart', async ({ seedSandbox: _seedSandbox }) => {
    // First launch: change zoom from 0 (Default, 100%) to 1 (120%) via the UI.
    {
      const { app, window } = await launchApp();
      try {
        await waitForMainUi(window);
        await openAppearanceTab(window);

        // The terminal font picker above it also has a "Default" option.
        const zoomSelect = window
          .getByRole('combobox')
          .filter({ hasText: 'Default (100%)' })
          .first();
        await expect(zoomSelect).toBeVisible();
        await zoomSelect.selectOption('1');

        // Wait for the config write to land on disk.
        await expect
          .poll(() => {
            const raw = fs.readFileSync(path.join(SANDBOX_DIR, 'config.json'), 'utf8');
            return JSON.parse(raw).zoomLevel;
          })
          .toBe(1);
      } finally {
        await app.close();
      }
    }

    // Second launch: same sandbox, expect Appearance to reflect zoomLevel 1.
    {
      const { app, window } = await launchApp();
      try {
        await waitForMainUi(window);
        await openAppearanceTab(window);
        const zoomSelectAfter = window
          .getByRole('combobox')
          .filter({ hasText: 'Default (100%)' })
          .first();
        await expect(zoomSelectAfter).toBeVisible();
        await expect(zoomSelectAfter).toHaveValue('1');
      } finally {
        await app.close();
      }
    }
  });
});
