import { execFileSync } from 'child_process';
import path from 'path';

import { test as base, expect, seedDefaultProject, SANDBOX_DIR } from './electron-app';

const repoDir = path.join(SANDBOX_DIR, 'seed-repo');

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'branch-menu/' });
    execFileSync('git', ['branch', 'other'], { cwd: repoDir });
    await provide();
  },
});

test.describe('Branch actions menu', () => {
  test.describe.configure({ timeout: 90_000 });

  test("a branch's actions shown on the left can be reached with the pointer", async ({
    appWindow,
    electronApp,
  }) => {
    // Narrow enough that the actions have no room right of the branch list and open on its left.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(800, 700);
    });
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('branch-menu/work');
    // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
      timeout: 10_000,
    });
    const dir = await appWindow.evaluate(
      async () =>
        (await window.api.getWorkspaces()).find((w) => w.branchName === 'branch-menu/work')!
          .workingDirectory
    );

    await appWindow.getByRole('button', { name: 'branch-menu/work' }).last().click();
    await appWindow.getByRole('menuitem', { name: 'Branches', exact: true }).hover();
    const row = appWindow.getByRole('menuitem', { name: 'other', exact: true });
    const actions = appWindow
      .getByRole('menu')
      .filter({ has: appWindow.getByRole('menuitem', { name: 'Switch', exact: true }) });
    const switchItem = actions.getByRole('menuitem', { name: 'Switch', exact: true });

    // Hovering a branch doesn't open its actions, which the menu would after 100 ms; clicking
    // it does, and so do Arrow Right, Enter and Space.
    await row.hover();
    await appWindow.waitForTimeout(300);
    await expect(actions).toBeHidden();
    await appWindow.keyboard.press('ArrowRight');
    await expect(actions).toBeVisible();
    await appWindow.keyboard.press('ArrowLeft');
    await expect(actions).toBeHidden();
    await appWindow.keyboard.press('Enter');
    await expect(actions).toBeVisible();
    await appWindow.keyboard.press('ArrowLeft');
    await expect(actions).toBeHidden();
    await appWindow.keyboard.press('Space');
    await expect(actions).toBeVisible();
    await appWindow.keyboard.press('ArrowLeft');
    await expect(actions).toBeHidden();
    // A Space typed while searching the list by its letters is part of the search.
    await appWindow.keyboard.press('o');
    await appWindow.keyboard.press('Space');
    await appWindow.waitForTimeout(300);
    await expect(actions).toBeHidden();
    await row.click();
    await expect(actions).toHaveAttribute('data-side', 'left');

    // Leave the row straight for the actions, in small steps as a hand moves.
    const from = (await row.boundingBox())!;
    const to = (await switchItem.boundingBox())!;
    const y = from.y + from.height / 2;
    for (let x = from.x + from.width / 2; x > to.x + to.width / 2; x -= 4) {
      await appWindow.mouse.move(x, y);
    }
    await expect(actions).toBeVisible();
    await switchItem.click();

    await expect
      .poll(() =>
        execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim()
      )
      .toBe('other');
  });
});
