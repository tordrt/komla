import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

import type { Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'scratch/' });
    await provide();
  },
});

// KOMLA_DATA_DIR is the sandbox, so scratch folders go here.
const SCRATCH_ROOT = path.join(SANDBOX_DIR, 'scratch');

async function newScratchWorkspace(appWindow: Page) {
  // A window without workspaces starts with the sidebar collapsed.
  await appWindow.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 15_000 });
  await appWindow.getByRole('button', { name: 'Quick create' }).click();
  await appWindow.getByRole('menuitem', { name: 'New Scratch Workspace' }).click();
  await expect
    .poll(async () =>
      appWindow.evaluate(async () => (await window.api.getWorkspaces()).filter((w) => w.scratch))
    )
    .toHaveLength(1);
  const [workspace] = await appWindow.evaluate(async () =>
    (await window.api.getWorkspaces()).filter((w) => w.scratch)
  );
  return workspace;
}

async function deleteFromCard(appWindow: Page, title: string, description: RegExp) {
  await appWindow.getByText(title, { exact: true }).first().click({ button: 'right' });
  await appWindow.getByRole('menuitem', { name: 'Delete Permanently...' }).click();
  const dialog = appWindow.getByRole('dialog');
  await expect(dialog).toContainText(description);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(appWindow.getByText(title, { exact: true })).toHaveCount(0, { timeout: 5_000 });
}

test.describe('Scratch workspace', () => {
  test('starts in a folder of its own and deletes the folder with it', async ({ appWindow }) => {
    const workspace = await newScratchWorkspace(appWindow);

    expect(path.dirname(workspace.workingDirectory)).toBe(SCRATCH_ROOT);
    expect(workspace.projectId).toBeNull();
    expect(fs.statSync(workspace.workingDirectory).isDirectory()).toBe(true);
    await expect(appWindow.getByText('Scratch', { exact: true })).toBeVisible();
    fs.writeFileSync(path.join(workspace.workingDirectory, 'notes.md'), '# Draft');

    await deleteFromCard(appWindow, workspace.name, /folder and everything in it/);

    await expect.poll(() => fs.existsSync(workspace.workingDirectory)).toBe(false);
    expect(fs.existsSync(SCRATCH_ROOT)).toBe(true);
  });

  test('keeps its folder once the user keeps it', async ({ appWindow }) => {
    const workspace = await newScratchWorkspace(appWindow);
    fs.writeFileSync(path.join(workspace.workingDirectory, 'notes.md'), '# Keep me');

    await appWindow.getByText(workspace.name, { exact: true }).first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Keep Folder' }).click();
    await expect
      .poll(async () =>
        appWindow.evaluate(
          async (id) => (await window.api.getWorkspaces()).find((w) => w.id === id),
          workspace.id
        )
      )
      .toMatchObject({ scratch: undefined, projectId: expect.any(String) });

    await deleteFromCard(appWindow, workspace.name, /will NOT be deleted/);

    expect(fs.readFileSync(path.join(workspace.workingDirectory, 'notes.md'), 'utf8')).toBe(
      '# Keep me'
    );
  });
});
