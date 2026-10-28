import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  test as base,
  expect,
  type ElectronApplication,
  type Page,
  _electron,
} from '@playwright/test';

import { ELECTRON_ARGS, firstRendererWindow, SANDBOX_DIR } from './electron-app';

interface CriticalFixtures {
  electronApp: ElectronApplication;
  appWindow: Page;
}

const test = base.extend<CriticalFixtures>({
  electronApp: [
    async ({}, provide) => {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });

      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'config.json'),
        JSON.stringify({
          agentSetupComplete: true,
          usageTelemetryConsentAnswered: true,
        })
      );

      const repoDir = path.join(SANDBOX_DIR, 'seed-repo');
      fs.mkdirSync(repoDir, { recursive: true });
      execSync('git init -b main && git commit --allow-empty -m "init"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'E2E',
          GIT_AUTHOR_EMAIL: 'e2e@test.local',
          GIT_COMMITTER_NAME: 'E2E',
          GIT_COMMITTER_EMAIL: 'e2e@test.local',
        },
      });

      fs.mkdirSync(path.join(SANDBOX_DIR, 'settings'), { recursive: true });
      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'settings', 'projects.json'),
        JSON.stringify({
          _version: 1,
          projects: [
            {
              id: 'e2e-project',
              name: 'seed-repo',
              repositoryPath: repoDir,
              defaultBranchPrefix: 'test/',
              createdAt: Date.now(),
              order: 0,
              managed: false,
            },
          ],
        })
      );

      const app = await _electron.launch({
        args: ELECTRON_ARGS,
        env: {
          ...process.env,
          KOMLA_DATA_DIR: SANDBOX_DIR,
          NODE_ENV: 'test',
        },
      });

      await provide(app);
      await app.close();
    },
    { scope: 'test' },
  ],

  appWindow: [
    async ({ electronApp }, provide) => {
      const window = await firstRendererWindow(electronApp);
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(1280, 820);
      });
      await provide(window);
    },
    { scope: 'test' },
  ],
});

async function waitForMainUi(appWindow: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await appWindow.waitForTimeout(250);
    const setupDialog = appWindow.getByRole('dialog').filter({ hasText: 'Setup' }).first();
    if (await setupDialog.isVisible().catch(() => false)) {
      const doneButton = setupDialog.getByRole('button', { name: 'Done' });
      if (await doneButton.isVisible().catch(() => false)) {
        await doneButton.click();
      }
    }
  }
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function createWorktreeWorkspace(appWindow: Page, branchName: string): Promise<void> {
  const beforeCount = await appWindow.evaluate(
    async () => (await window.api.getWorkspaces()).length
  );
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await expect(dialog).toBeVisible();

  const branchInput = dialog.locator('input[placeholder$="swift-fox"]');
  await branchInput.fill(branchName);
  // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();

  await expect
    .poll(
      async () => await appWindow.evaluate(async () => (await window.api.getWorkspaces()).length)
    )
    .toBe(beforeCount + 1);
}

function sidebarBranchLocator(appWindow: Page, branchName: string) {
  return appWindow
    .locator('.sidebar-surface .workspace-card-hover')
    .filter({ hasText: branchName })
    .first();
}

test.describe('Critical Workflows', () => {
  test.describe.configure({ timeout: 60_000 });

  test('moves a workspace to a new window and back to window 1', async ({
    electronApp,
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    await createWorktreeWorkspace(appWindow, 'test/critical-move');

    // "Move to New Window" lives on the project group header, not the workspace card.
    await appWindow
      .locator('.sidebar-surface')
      .getByRole('button', { name: 'seed-repo' })
      .first()
      .click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Move to New Window' }).click();

    await expect.poll(async () => (await electronApp.windows()).length).toBe(2);

    const windows = await electronApp.windows();
    const newWindow = windows.find((w) => w !== appWindow);
    if (!newWindow) throw new Error('Expected second window after moving workspace');

    await expect(sidebarBranchLocator(newWindow, 'test/critical-move')).toBeVisible();
    await expect(sidebarBranchLocator(appWindow, 'test/critical-move')).toHaveCount(0);

    // The submenu can close while the pointer travels into it in the second window; retry the
    // whole menu interaction rather than a single hover.
    await expect(async () => {
      await newWindow.keyboard.press('Escape');
      await sidebarBranchLocator(newWindow, 'test/critical-move').click({ button: 'right' });
      await newWindow.getByRole('menuitem', { name: 'More' }).click();
      await newWindow.getByRole('menuitem', { name: 'Move to Window 1' }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    await expect(sidebarBranchLocator(appWindow, 'test/critical-move')).toBeVisible();
    await expect(sidebarBranchLocator(newWindow, 'test/critical-move')).toHaveCount(0);
  });

  test('creates a worktree workspace and shows it in the sidebar', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await createWorktreeWorkspace(appWindow, 'test/e2e-create');

    // Workspace appears in sidebar
    await expect(sidebarBranchLocator(appWindow, 'test/e2e-create')).toBeVisible();

    // Click the workspace to select it
    await sidebarBranchLocator(appWindow, 'test/e2e-create').click();

    // A terminal pane should be visible in the main content area
    await expect(appWindow.locator('.xterm').first()).toBeVisible({ timeout: 10_000 });
  });

  test('deletes a workspace via context menu', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await createWorktreeWorkspace(appWindow, 'test/e2e-delete');

    await expect(sidebarBranchLocator(appWindow, 'test/e2e-delete')).toBeVisible();

    // Right-click and delete
    await sidebarBranchLocator(appWindow, 'test/e2e-delete').click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Delete Permanently...' }).click();

    // Confirm deletion dialog
    const dialog = appWindow.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    // Workspace should be gone from sidebar
    await expect(sidebarBranchLocator(appWindow, 'test/e2e-delete')).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test('splits a terminal pane horizontally and vertically', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await createWorktreeWorkspace(appWindow, 'test/e2e-split');

    await sidebarBranchLocator(appWindow, 'test/e2e-split').click();
    await expect(appWindow.locator('.xterm').first()).toBeVisible({ timeout: 10_000 });

    const baseline = await appWindow.locator('.xterm').count();
    // Terminals of other tabs stay mounted but hidden.
    const panes = appWindow.locator('.xterm').filter({ visible: true });

    // Panes have no headers by default; the terminal's context menu splits it.
    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Right' }).click();
    await expect(appWindow.locator('.xterm')).toHaveCount(baseline + 1, { timeout: 10_000 });

    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Down' }).click();
    await expect(appWindow.locator('.xterm')).toHaveCount(baseline + 2, { timeout: 10_000 });
  });

  // Regression: closing a pane whose removal causes the root split to collapse
  // (root identity flips from the outer split to a surviving inner split) used
  // to leave the layout broken. See PaneRenderer keying fix.
  test('closes a pane in a nested split without breaking the layout', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await createWorktreeWorkspace(appWindow, 'test/e2e-close-nested');

    await sidebarBranchLocator(appWindow, 'test/e2e-close-nested').click();
    await expect(appWindow.locator('.xterm').first()).toBeVisible({ timeout: 10_000 });

    const baseline = await appWindow.locator('.xterm').count();
    // Terminals of other tabs stay mounted but hidden.
    const panes = appWindow.locator('.xterm').filter({ visible: true });

    // Build outer(inner(A_top, A_bot), B): split right on A, then split A down.
    // Panes have no headers by default; each terminal's context menu splits and closes it.
    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Right' }).click();
    await expect(appWindow.locator('.xterm')).toHaveCount(baseline + 1, { timeout: 10_000 });

    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Down' }).click();
    await expect(appWindow.locator('.xterm')).toHaveCount(baseline + 2, { timeout: 10_000 });

    // Close B (the rightmost pane). Removing it collapses the outer split so
    // the inner [A_top, A_bot] split becomes the root — the exact structural
    // case the keying fix protects.
    await panes.last().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Close Pane' }).click();

    // Two terminals remain and both are still rendered (not blank / zero-size).
    await expect(appWindow.locator('.xterm')).toHaveCount(baseline + 1, { timeout: 10_000 });
    const remaining = appWindow.locator('.xterm');
    await expect(remaining.nth(0)).toBeVisible();
    await expect(remaining.nth(1)).toBeVisible();
    for (const i of [0, 1]) {
      const box = await remaining.nth(i).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.height ?? 0).toBeGreaterThan(0);
    }
  });

  test('adds and closes a terminal tab', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await createWorktreeWorkspace(appWindow, 'test/e2e-tabs');

    // Click workspace to make sure it's active
    await sidebarBranchLocator(appWindow, 'test/e2e-tabs').click();
    await expect(appWindow.locator('.xterm').first()).toBeVisible({ timeout: 10_000 });

    // Open a terminal from the "New tab" menu
    await appWindow.getByRole('button', { name: 'New tab' }).click();
    await appWindow.getByRole('menuitem', { name: /New terminal/ }).click();

    // Wait for the second tab to appear
    await appWindow.waitForTimeout(1000);

    // Get all tab close buttons (X buttons inside tabs)
    const closeBtns = appWindow.locator('[class*="group/tab"] button');
    const count = await closeBtns.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Close the last tab
    await closeBtns.last().click();

    // Should be back to fewer close buttons
    await expect(closeBtns).toHaveCount(count - 1, { timeout: 5_000 });
  });
});
