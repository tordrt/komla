import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject, type Page } from './electron-app';

const PLUGIN_DIR = path.join(SANDBOX_DIR, 'plugins', 'hello');
const SCREENSHOTS = process.env.PLUGINS_SCREENSHOT_DIR;

function writeScript(text: string): void {
  fs.writeFileSync(path.join(PLUGIN_DIR, 'hello.sh'), `#!/bin/sh\necho '${text}'\n`, {
    mode: 0o755,
  });
}

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'plugins/' });
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PLUGIN_DIR, 'komla-plugin.json'),
      JSON.stringify({
        id: 'hello',
        name: 'Hello',
        version: '1.0.0',
        description: 'Says hello from a script it ships.',
        contributes: {
          statusItems: [
            { id: 'greeting', label: 'Greeting', command: 'sh "$KOMLA_PLUGIN_DIR/hello.sh"' },
          ],
        },
      })
    );
    writeScript('Hello from a plugin');
    await provide();
  },
});

async function openIntegrations(window: Page): Promise<void> {
  // Settings loads lazily on first open; re-dispatch until it renders.
  await expect(async () => {
    await window.evaluate(() =>
      window.dispatchEvent(new CustomEvent('open-settings', { detail: 'integrations' }))
    );
    await expect(window.getByRole('heading', { name: 'Plugins' })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 15_000 });
}

test.describe('Plugins', () => {
  test.skip(process.platform === 'win32', 'The plugin runs a POSIX shell script');
  test.describe.configure({ timeout: 90_000 });

  test('runs a plugin once turned on, and stops it when its files change', async ({
    appWindow,
  }) => {
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click({
      timeout: 15_000,
    });
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('plugins/hello');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect
      .poll(async () => appWindow.evaluate(async () => (await window.api.getWorkspaces()).length))
      .toBe(1);

    await openIntegrations(appWindow);
    const toggle = appWindow.getByRole('switch', { name: 'Turn on Hello' });
    await expect(toggle).not.toBeChecked();
    await expect(appWindow.getByText('sh "$KOMLA_PLUGIN_DIR/hello.sh"')).toBeVisible();
    await expect(appWindow.getByText('Hello from a plugin')).toHaveCount(0);

    await toggle.click();
    await expect(appWindow.getByRole('switch', { name: 'Turn off Hello' })).toBeChecked();
    const plugins = JSON.parse(
      fs.readFileSync(path.join(SANDBOX_DIR, 'settings', 'plugins.json'), 'utf8')
    );
    expect(plugins.enabled).toEqual([{ id: 'hello', digest: expect.any(String) }]);
    if (SCREENSHOTS) {
      await appWindow
        .locator('#settings-card-plugins')
        .screenshot({ path: path.join(SCREENSHOTS, 'plugins-card-on.png') });
    }

    await appWindow.keyboard.press('Escape');
    await expect(appWindow.getByText('Hello from a plugin')).toBeVisible({ timeout: 20_000 });
    if (SCREENSHOTS) {
      // Settings fades out before it unmounts.
      await expect(appWindow.getByPlaceholder('Search settings')).toHaveCount(0);
      await appWindow.screenshot({ path: path.join(SCREENSHOTS, 'plugin-status-item.png') });
    }

    // A changed script could run anything, so the plugin stops until it's turned on again.
    writeScript('Something else');
    await expect(appWindow.getByText('Hello from a plugin')).toHaveCount(0, { timeout: 20_000 });
    await openIntegrations(appWindow);
    await expect(appWindow.getByText(/Its files changed since you turned it on/)).toBeVisible();
    if (SCREENSHOTS) {
      await appWindow
        .locator('#settings-card-plugins')
        .screenshot({ path: path.join(SCREENSHOTS, 'plugins-card-changed.png') });
    }
    await appWindow.getByRole('switch', { name: 'Turn on Hello' }).click();
    await appWindow.keyboard.press('Escape');
    await expect(appWindow.getByText('Something else')).toBeVisible({ timeout: 20_000 });
  });
});
