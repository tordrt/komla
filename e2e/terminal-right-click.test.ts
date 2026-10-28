import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject, type Page } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'right-click/' });
    await provide();
  },
});

const INPUT_LOG = path.join(SANDBOX_DIR, 'right-click-input.log');

/**
 * The terminal menu's Paste item, named for its shortcut after "Paste". Saved prompts end in a
 * "Paste" hint instead, and the item with none is "Paste Prompt".
 */
function pasteItem(appWindow: Page) {
  return appWindow.getByRole('menuitem', { name: /^Paste.*V$/ });
}

/** What the program has read so far; Ctrl+D hands cat the line typed so far. */
async function programInput(appWindow: Page, screen: ReturnType<Page['locator']>) {
  await screen.click();
  await appWindow.keyboard.press('Control+D');
  await expect
    .poll(() => fs.existsSync(INPUT_LOG) && fs.readFileSync(INPUT_LOG, 'utf8'))
    .toBeTruthy();
  return () => fs.readFileSync(INPUT_LOG, 'utf8');
}

test.describe('Terminal right-click', () => {
  test.describe.configure({ timeout: 60_000 });

  test('opens the menu without reaching a program that tracks the mouse', async ({ appWindow }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('right-click/menu');
    // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    const xterm = appWindow.locator('.xterm').filter({ visible: true }).first();
    const screen = xterm.locator('.xterm-screen');
    await expect(xterm).toBeVisible({ timeout: 10_000 });

    // A program that turns on SGR mouse reporting and logs every byte it reads. Plain cat, since
    // macOS `cat -v` holds what it writes to a file until it exits.
    await screen.click();
    await appWindow.keyboard.type(`printf '\\033[?1000h\\033[?1006h'; cat > ${INPUT_LOG}`);
    await appWindow.keyboard.press('Enter');
    await expect(appWindow.locator('.xterm.enable-mouse-events')).toBeVisible();

    await screen.click({ button: 'right' });
    await expect(pasteItem(appWindow)).toBeVisible();
    await appWindow.keyboard.press('Escape');
    await expect(pasteItem(appWindow)).toHaveCount(0);

    // Left clicks still reach the program, so its log shows reporting works.
    let read = await programInput(appWindow, screen);
    await expect.poll(read).toContain('[<0;');
    expect(read()).not.toContain('[<2;');

    await expect(async () => {
      await appWindow.evaluate(() =>
        window.dispatchEvent(new CustomEvent('open-settings', { detail: 'terminal' }))
      );
      await expect(
        appWindow.getByRole('switch', { name: 'Send right-clicks to programs' })
      ).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });
    await appWindow.getByRole('switch', { name: 'Send right-clicks to programs' }).click();
    await expect(
      appWindow.getByRole('switch', { name: 'Send right-clicks to programs' })
    ).toBeChecked();
    await appWindow.keyboard.press('Escape');
    await expect(
      appWindow.getByRole('switch', { name: 'Send right-clicks to programs' })
    ).toHaveCount(0);

    await screen.click({ button: 'right' });
    read = await programInput(appWindow, screen);
    await expect.poll(read).toContain('[<2;');
    await expect(pasteItem(appWindow)).toHaveCount(0);

    await screen.click({ button: 'right', modifiers: ['Shift'] });
    await expect(pasteItem(appWindow)).toBeVisible();
  });
});
