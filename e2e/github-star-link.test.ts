import { KOMLA_GITHUB_URL } from '../src/shared/constants/komla-github';
import { test as base, expect, seedDefaultProject } from './electron-app';

import type { ElectronApplication } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'github-star-link/' });
    await provide();
  },
});

/** Records the URLs Komla asks the OS to open, instead of opening a browser. */
async function recordOpenedUrls(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { e2eOpenedUrls?: string[] }).e2eOpenedUrls = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () =>
    electronApp.evaluate(() => (globalThis as { e2eOpenedUrls?: string[] }).e2eOpenedUrls);
}

test.describe('Komla on GitHub', () => {
  test.describe.configure({ timeout: 60_000 });

  test('Tips links to the GitHub repository', async ({ appWindow, electronApp }, testInfo) => {
    const openedUrls = await recordOpenedUrls(electronApp);
    await appWindow.getByRole('button', { name: 'Tips' }).click();
    const starLink = appWindow.getByRole('button', { name: /Enjoying Komla\?/ });
    await starLink.scrollIntoViewIfNeeded();
    await appWindow.screenshot({ animations: 'disabled', path: testInfo.outputPath('tips.png') });

    await starLink.click();

    await expect.poll(openedUrls).toEqual([KOMLA_GITHUB_URL]);
    await expect(starLink).toHaveCount(0);
  });

  test('the settings menu links to the GitHub repository', async ({
    appWindow,
    electronApp,
  }, testInfo) => {
    const openedUrls = await recordOpenedUrls(electronApp);
    await appWindow.locator('[data-tips-home="settings menu"]').filter({ visible: true }).click();
    const item = appWindow.getByRole('menuitem', { name: 'Star on GitHub' });
    await expect(item).toBeVisible();
    await appWindow.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('settings-menu.png'),
    });

    await item.click();

    await expect.poll(openedUrls).toEqual([KOMLA_GITHUB_URL]);
  });

  test('Feedback links to the GitHub repository for building it yourself', async ({
    appWindow,
    electronApp,
  }, testInfo) => {
    const openedUrls = await recordOpenedUrls(electronApp);
    await appWindow.locator('[data-tips-home="settings menu"]').filter({ visible: true }).click();
    await appWindow.getByRole('menuitem', { name: 'Feedback' }).click();
    await expect(appWindow.getByText('Rather build it yourself?')).toBeVisible();
    await appWindow.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('feedback-build-it-yourself.png'),
    });

    await appWindow.getByRole('button', { name: 'Open a pull request' }).click();

    await expect.poll(openedUrls).toEqual([KOMLA_GITHUB_URL]);
    await expect(appWindow.getByText('Send feedback')).toHaveCount(0);
  });

  test('says so when the browser does not open', async ({ appWindow, electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error('No browser to open it in');
      };
    });
    await appWindow.locator('[data-tips-home="settings menu"]').filter({ visible: true }).click();
    await appWindow.getByRole('menuitem', { name: 'Star on GitHub' }).click();

    await expect(
      appWindow.getByText(`Couldn't open ${KOMLA_GITHUB_URL}: No browser to open it in`)
    ).toBeVisible();
  });
});
