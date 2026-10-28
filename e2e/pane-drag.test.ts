import { test as base, expect, seedDefaultProject } from './electron-app';

import type { Locator, Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'pane-drag/' });
    await provide();
  },
});

async function createWorkspace(appWindow: Page, branch: string) {
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branch);
  // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
    timeout: 10_000,
  });
}

async function revealGrip(appWindow: Page, pane: Locator, grip: Locator) {
  // The pane can still shift just after a tab switch or split, and the move Chromium then sends
  // hides the grip again; point at the pane's top until the grip stays shown.
  await expect(async () => {
    const box = await pane.boundingBox();
    if (!box) throw new Error('pane has no box');
    await appWindow.mouse.move(box.x + box.width / 2, box.y + 8);
    await expect(grip).toHaveCSS('opacity', '1', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

// mouse.up can hang after an HTML5 drop; the drop has landed by then.
async function release(appWindow: Page) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    appWindow.mouse.up().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 2_000);
    }),
  ]);
  clearTimeout(timer);
}

test.describe('Pane drag', () => {
  test.describe.configure({ timeout: 60_000 });

  test("drags a tab's only pane into another tab by its grip", async ({ appWindow }) => {
    await createWorkspace(appWindow, 'pane-drag/lone');

    await appWindow.getByRole('button', { name: 'New tab' }).click();
    await appWindow.getByRole('menuitem', { name: 'New terminal' }).click();
    const tabs = appWindow.locator('[data-tab-id]').filter({ visible: true });
    await expect(tabs).toHaveCount(2);

    // Back to the first tab, whose lone pane is the one to move.
    await tabs.first().getByRole('button').first().click();
    const pane = appWindow.locator('.xterm').filter({ visible: true }).first();
    await expect(pane).toBeVisible();
    const grip = appWindow.getByTestId('pane-drag-grip').filter({ visible: true });
    await revealGrip(appWindow, pane, grip);

    await grip.hover();
    await appWindow.mouse.down();
    const target = await tabs.last().boundingBox();
    if (!target) throw new Error('tab has no box');
    await appWindow.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
      steps: 10,
    });
    await release(appWindow);

    await expect(tabs).toHaveCount(1);
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(2);
  });

  test("drags a tab's only pane by the tab onto the shown tab's pane", async ({ appWindow }) => {
    await createWorkspace(appWindow, 'pane-drag/tab');

    await appWindow.getByRole('button', { name: 'New tab' }).click();
    await appWindow.getByRole('menuitem', { name: 'New terminal' }).click();
    const tabs = appWindow.locator('[data-tab-id]').filter({ visible: true });
    await expect(tabs).toHaveCount(2);

    // Show the first tab, then drag the second one in by the tab itself.
    await tabs.first().getByRole('button').first().click();
    const panes = appWindow.locator('.xterm').filter({ visible: true });
    await expect(panes).toHaveCount(1);
    const pane = await panes.first().boundingBox();
    if (!pane) throw new Error('pane has no box');

    await tabs.last().getByRole('button').first().hover();
    await appWindow.mouse.down();
    // Short of the middle, which for a tab drag still means the left edge.
    await appWindow.mouse.move(pane.x + pane.width * 0.4, pane.y + pane.height / 2, { steps: 10 });
    await release(appWindow);

    await expect(tabs).toHaveCount(1);
    await expect(panes).toHaveCount(2);
    await expect(async () => {
      const [a, b] = await Promise.all([panes.first().boundingBox(), panes.last().boundingBox()]);
      if (!a || !b) throw new Error('pane has no box');
      expect(Math.abs(a.y - b.y)).toBeLessThan(4);
    }).toPass({ timeout: 5_000 });
  });

  // A split's divider overlaps the top edge of the pane below it, where that pane's grip sits, and
  // the drag heads up out of the band the grip shows in.
  test('drags the lower pane of a split by its grip', async ({ appWindow }) => {
    await createWorkspace(appWindow, 'pane-drag/lower');
    const panes = appWindow.locator('.xterm').filter({ visible: true });

    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Down' }).click();
    await expect(panes).toHaveCount(2, { timeout: 10_000 });

    const grip = appWindow.getByTestId('pane-drag-grip').filter({ visible: true }).last();
    await revealGrip(appWindow, panes.last(), grip);

    const upper = await panes.first().boundingBox();
    if (!upper) throw new Error('pane has no box');
    // Hover checks that the grip, not the divider over its top, takes the pointer.
    await grip.hover({ timeout: 5_000 });
    await appWindow.mouse.down();
    // Onto the upper pane's right edge, which puts the two side by side.
    await appWindow.mouse.move(upper.x + upper.width * 0.9, upper.y + upper.height / 2, {
      steps: 10,
    });
    await release(appWindow);

    await expect(async () => {
      const [a, b] = await Promise.all([panes.first().boundingBox(), panes.last().boundingBox()]);
      if (!a || !b) throw new Error('pane has no box');
      expect(Math.abs(a.y - b.y)).toBeLessThan(4);
    }).toPass({ timeout: 5_000 });
  });
});
