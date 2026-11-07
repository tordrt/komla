import { test as base, expect, seedDefaultProject } from './electron-app';

import type { Locator, Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'reorder/' });
    await provide();
  },
});

// Each new workspace goes to the top, so the sidebar lists them gamma, beta, alpha.
async function createWorkspaces(appWindow: Page) {
  for (const name of ['alpha', 'beta', 'gamma']) {
    const button = appWindow.getByRole('button', { name: 'New Workspace' }).first();
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill(`reorder/${name}`);
    // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(dialog).toBeHidden();
  }
  await expect
    .poll(() => cardNames(appWindow), { timeout: 30_000 })
    .toEqual(['gamma', 'beta', 'alpha']);
}

function cards(appWindow: Page): Locator {
  return appWindow.locator('[data-drag-workspace-id]');
}

async function cardNames(appWindow: Page): Promise<string[]> {
  return appWindow.evaluate(async () => {
    const workspaces = await window.api.getWorkspaces();
    const names = new Map(workspaces.map((w) => [w.id, w.branchName?.replace('reorder/', '')]));
    return Array.from(document.querySelectorAll('[data-drag-workspace-id]'), (card) =>
      String(names.get(card.getAttribute('data-drag-workspace-id') ?? ''))
    );
  });
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('card has no box');
  return b;
}

// mouse.up can hang after an HTML5 drop; the drop has landed by then. Moving the mouse after
// lets the drag finish, or closing the app straight after it can hang under xvfb.
async function release(appWindow: Page) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    appWindow.mouse.up().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 2_000);
    }),
  ]);
  clearTimeout(timer);
  await appWindow.mouse.move(1, 1);
}

async function startDrag(appWindow: Page, card: Locator) {
  const from = await box(card);
  await appWindow.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await appWindow.mouse.down();
  await appWindow.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 4, { steps: 2 });
}

test.describe('Sidebar reorder', () => {
  test.describe.configure({ timeout: 90_000 });

  test('drops a workspace released in the gap between two cards', async ({ appWindow }) => {
    await createWorkspaces(appWindow);
    const [gamma, beta, alpha] = [0, 1, 2].map((i) => cards(appWindow).nth(i));

    await startDrag(appWindow, gamma);
    const above = await box(beta);
    const below = await box(alpha);
    const gapY = (above.y + above.height + below.y) / 2;
    await appWindow.mouse.move(above.x + above.width / 2, gapY, { steps: 10 });
    await release(appWindow);

    await expect.poll(() => cardNames(appWindow)).toEqual(['beta', 'gamma', 'alpha']);
  });

  test('drops above a card when released over its upper half', async ({ appWindow }) => {
    await createWorkspaces(appWindow);
    const [, beta, alpha] = [0, 1, 2].map((i) => cards(appWindow).nth(i));

    await startDrag(appWindow, alpha);
    const target = await box(beta);
    await appWindow.mouse.move(target.x + target.width / 2, target.y + target.height * 0.4, {
      steps: 10,
    });
    await release(appWindow);

    await expect.poll(() => cardNames(appWindow)).toEqual(['gamma', 'alpha', 'beta']);
  });

  test('leaves a workspace dragged back over itself where it was', async ({ appWindow }) => {
    await createWorkspaces(appWindow);
    const [gamma, beta] = [0, 1].map((i) => cards(appWindow).nth(i));

    await startDrag(appWindow, gamma);
    const past = await box(beta);
    await appWindow.mouse.move(past.x + past.width / 2, past.y + past.height * 0.9, { steps: 10 });
    // Straight back in one move, as a quick flick does, not over the top of beta on the way.
    const home = await box(gamma);
    await appWindow.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await release(appWindow);

    // Give a stray reorder time to land before checking nothing moved.
    await appWindow.waitForTimeout(500);
    await expect(cardNames(appWindow)).resolves.toEqual(['gamma', 'beta', 'alpha']);
  });
});
