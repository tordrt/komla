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

const SCREENSHOT_DIR = process.env.KOMLA_E2E_SCREENSHOT_DIR;

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    const { projectId } = seedDefaultProject({ branchPrefix: 'sidebar-default-panel/' });
    const configPath = path.join(SANDBOX_DIR, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
        defaultFileTreeOpen: true,
        // The user dragged the Checks panel to the front of the project's tabs.
        projectSidebarTabs: { [projectId]: ['panel:checks', 'diff', 'files'] },
      })
    );
    const settings = path.join(SANDBOX_DIR, 'settings');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(
      path.join(settings, 'sidebar-panels.json'),
      JSON.stringify({
        _version: 1,
        panels: [{ id: 'checks', title: 'Checks', command: "printf 'All checks passed'" }],
      })
    );
    await provide();
  },
});

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

function checksPanel(window: Page) {
  return window.locator('[data-sidebar-panel="checks"]').filter({ visible: true });
}

test.describe('Default sidebar panel', () => {
  test.describe.configure({ timeout: 120_000 });

  test("opens new workspaces on the project's first tab, and keeps each one's view across a restart", async ({
    seedSandbox: _seedSandbox,
  }) => {
    {
      const { app, window } = await launchApp();
      try {
        await showSidebar(window);
        await createWorkspace(window, 'on-checks');
        await expect(checksPanel(window)).toContainText('All checks passed', { timeout: 15_000 });
        if (SCREENSHOT_DIR) {
          await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'new-workspace.png') });
        }

        await createWorkspace(window, 'on-files');
        await expect(checksPanel(window)).toContainText('All checks passed', { timeout: 15_000 });
        await window
          .getByLabel('File panel view')
          .getByRole('button', { name: 'Files', exact: true })
          .click();
        await expect(checksPanel(window)).toHaveCount(0);
      } finally {
        await app.close();
      }
    }

    const { app, window } = await launchApp();
    try {
      await showSidebar(window);
      // Stopped workspaces are hidden, so restart both from the offer.
      await window.getByRole('button', { name: 'Restart all' }).click({ timeout: 15_000 });

      await selectWorkspace(window, 'on-checks');
      await expect(checksPanel(window)).toContainText('All checks passed', { timeout: 15_000 });

      await selectWorkspace(window, 'on-files');
      await expect(checksPanel(window)).toHaveCount(0);
      // Only the Files view has this.
      await expect(window.getByRole('button', { name: 'Show ignored files' })).toBeVisible({
        timeout: 15_000,
      });
      if (SCREENSHOT_DIR) {
        await window.screenshot({ path: path.join(SCREENSHOT_DIR, 'restarted-on-files.png') });
      }
    } finally {
      await app.close();
    }
  });
});
