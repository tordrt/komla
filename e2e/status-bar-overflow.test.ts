import fs from 'fs';
import path from 'path';

import { test as base, expect, seedDefaultProject, SANDBOX_DIR } from './electron-app';

import type { Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'status-bar-overflow/' });
    const configPath = path.join(SANDBOX_DIR, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        // The workspace's tools too, so a narrow window can't fit every item.
        statusBarShownItems: ['file-search', 'file-viewer', 'diff-viewer', 'notes', 'commit-graph'],
      })
    );
    await provide();
  },
});

/** Whether everything in the bar shows whole, inside the bar: nothing it shows is cut off. */
async function barContentsFit(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-status-bar]')!;
    const sides = [...bar.children] as HTMLElement[];
    return sides.every((side) => {
      const box = side.getBoundingClientRect();
      return [...side.querySelectorAll<HTMLElement>('button')]
        .filter((button) => button.getClientRects().length > 0 && !button.closest('[inert]'))
        .every((button) => {
          const { left, right } = button.getBoundingClientRect();
          return left >= box.left - 0.5 && right <= box.right + 0.5;
        });
    });
  });
}

test.describe('Status bar overflow', () => {
  test.describe.configure({ timeout: 90_000 });

  test('items that do not fit go behind a more button, and come back with room', async ({
    appWindow,
    electronApp,
  }) => {
    const resize = (width: number) =>
      electronApp.evaluate(
        ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 700),
        width
      );
    const bar = appWindow.getByTestId('status-bar');
    const more = bar.getByRole('button', { name: /^\d+ more items?$/ });

    await resize(1600);
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('status-bar-overflow/work');
    // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(bar.getByRole('button', { name: 'Commit graph' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(more).toHaveCount(0);
    expect(await barContentsFit(appWindow)).toBe(true);

    await resize(460);
    await expect(more).toBeVisible();
    expect(await barContentsFit(appWindow)).toBe(true);
    await appWindow.screenshot({ path: test.info().outputPath('narrow.png') });

    // The menu holds the items the bar has no room for, and they work there.
    await more.click();
    const menu = appWindow.getByRole('dialog', {
      name: 'More status bar items',
    });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button').first()).toBeVisible();
    await appWindow.screenshot({ path: test.info().outputPath('menu.png') });
    // An item's own menu opens from it, and using it leaves the overflow menu open.
    await menu.getByRole('button', { name: /main/ }).click();
    const filter = appWindow.getByPlaceholder('Filter or create branch...');
    await expect(filter).toBeVisible();
    await filter.fill('ma');
    await expect(menu).toBeVisible();
    await appWindow.screenshot({ path: test.info().outputPath('item-menu.png') });
    await appWindow.keyboard.press('Escape');
    await expect(filter).toBeHidden();
    await expect(menu).toBeVisible();
    // Focus goes back to the item, whose tooltip Escape closes before the menu, as in the bar.
    const tooltip = appWindow.getByRole('tooltip', { name: /^Target branch/ });
    await expect(tooltip).toBeVisible();
    await appWindow.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await appWindow.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await resize(1600);
    await expect(more).toHaveCount(0);
    expect(await barContentsFit(appWindow)).toBe(true);
  });
});
