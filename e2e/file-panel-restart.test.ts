import path from 'path';

import { test as base, expect, launchApp, seedDefaultProject, type Page } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'file-panel-restart/' });
    await provide();
  },
});

const SCREENSHOT_DIR = process.env.KOMLA_E2E_SCREENSHOT_DIR;

async function showSidebar(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  const expand = window.getByRole('button', { name: 'Expand sidebar' });
  if (await expand.isVisible()) await expand.click();
}

async function createWorkspace(window: Page, branch: string): Promise<void> {
  await window.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = window.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branch);
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(window.getByRole('button', { name: 'Toggle file panel' })).toBeVisible({
    timeout: 20_000,
  });
}

/** Picks a workspace by its branch, as its title can change to its terminal's. */
async function selectWorkspace(window: Page, branch: string): Promise<void> {
  await window
    .getByRole('button', { name: /^Workspace details for / })
    .filter({ hasText: branch })
    .click({ timeout: 15_000 });
}

function filePanel(window: Page) {
  return window.getByRole('separator', { name: 'Resize file tree panel' });
}

test.describe('File panel across a restart', () => {
  test.describe.configure({ timeout: 120_000 });

  test('comes back as each workspace left it', async ({ seedSandbox: _seedSandbox }) => {
    {
      const { app, window } = await launchApp();
      try {
        await showSidebar(window);
        // New workspaces start with the file panel closed.
        await createWorkspace(window, 'left-closed');
        await expect(filePanel(window)).toBeHidden();
        await createWorkspace(window, 'left-open');
        await expect(filePanel(window)).toBeHidden();
        await window.getByRole('button', { name: 'Toggle file panel' }).click();
        await expect(filePanel(window)).toBeVisible();
      } finally {
        await app.close();
      }
    }

    const { app, window } = await launchApp();
    try {
      await showSidebar(window);
      // Stopped workspaces are hidden, so restart both from the offer.
      await window.getByRole('button', { name: 'Restart all' }).click({ timeout: 15_000 });
      await selectWorkspace(window, 'left-open');
      await expect(filePanel(window)).toBeVisible({ timeout: 15_000 });
      if (SCREENSHOT_DIR) {
        await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'left-open.png') });
      }

      await selectWorkspace(window, 'left-closed');
      await expect(filePanel(window)).toBeHidden();
      if (SCREENSHOT_DIR) {
        await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'left-closed.png') });
      }
    } finally {
      await app.close();
    }
  });
});
