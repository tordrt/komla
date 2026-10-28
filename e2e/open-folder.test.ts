import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  test as base,
  expect,
  E2E_GIT_IDENTITY_ENV,
  SANDBOX_DIR,
  seedDefaultProject,
} from './electron-app';

import type { ElectronApplication, Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'open-folder/' });
    await provide();
  },
});

/** Picks `folder` in the folder picker, then chooses File → Open Folder…. */
async function openFolderFromFileMenu(electronApp: ElectronApplication, folder: string) {
  await electronApp.evaluate(({ BrowserWindow, dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    // What the File menu item sends to the focused window.
    BrowserWindow.getAllWindows()[0].webContents.send('menu:open-folder');
  }, folder);
}

async function waitForMainUi(appWindow: Page) {
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Open Folder', () => {
  test('opens a plain folder as a folder project, and opens it again without a second workspace', async ({
    electronApp,
    appWindow,
  }) => {
    const folder = path.join(SANDBOX_DIR, 'scratch-notes');
    fs.mkdirSync(folder, { recursive: true });
    await waitForMainUi(appWindow);
    const folderWorkspaces = () =>
      appWindow.evaluate(async (workingDirectory) => {
        const projects = await window.api.getProjects();
        return (await window.api.getWorkspaces())
          .filter((w) => w.workingDirectory === workingDirectory)
          .map((w) => projects.find((p) => p.id === w.projectId)?.kind ?? null);
      }, folder);

    await openFolderFromFileMenu(electronApp, folder);

    await expect.poll(folderWorkspaces).toEqual(['directory']);
    await expect(appWindow.getByRole('dialog')).toHaveCount(0);
    const header = appWindow.locator('[data-group-header]', { hasText: 'scratch-notes' });
    await expect(header.getByTitle(folder)).toBeVisible();

    await openFolderFromFileMenu(electronApp, folder);
    await appWindow.waitForTimeout(1000);
    expect(await folderWorkspaces()).toEqual(['directory']);
    // Open Recent lists the folder once main has checked it's there.
    const firstRecent = () =>
      electronApp.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()!
            .items.find((item) => item.label === 'File')!
            .submenu!.items.find((item) => item.label === 'Open Recent')!.submenu!.items[0].label
      );
    await expect.poll(firstRecent).toBe(folder);
  });

  test('opens New Workspace on the project a subfolder of its repository belongs to', async ({
    electronApp,
    appWindow,
  }) => {
    const subfolder = path.join(SANDBOX_DIR, 'seed-repo', 'packages', 'web');
    fs.mkdirSync(subfolder, { recursive: true });
    await waitForMainUi(appWindow);

    await openFolderFromFileMenu(electronApp, subfolder);

    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await expect(dialog.getByRole('button', { name: /seed-repo/ }).first()).toBeVisible();
    await expect(appWindow.getByRole('dialog', { name: /as a project\?$/ })).toHaveCount(0);
  });

  test('asks before opening a Git repository and adds it as a project in the color picked', async ({
    electronApp,
    appWindow,
  }) => {
    const repo = path.join(SANDBOX_DIR, 'side-repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      env: { ...process.env, ...E2E_GIT_IDENTITY_ENV },
    });
    await waitForMainUi(appWindow);

    await openFolderFromFileMenu(electronApp, repo);

    const question = appWindow.getByRole('dialog', { name: 'Add side-repo as a project?' });
    await expect(question).toBeVisible();
    await test.info().attach('git-repository-question', {
      body: await appWindow.screenshot(),
      contentType: 'image/png',
    });
    const addAsProject = question.getByRole('button', { name: 'Add as project' });
    await expect(addAsProject).toBeFocused();
    await appWindow.keyboard.press('Enter');

    const form = appWindow.getByRole('region', { name: 'Add project' });
    await expect(form.getByTitle(repo)).toBeVisible();
    const swatches = form.getByRole('group', { name: 'Project Color' }).getByRole('button');
    // The seeded project has no color, so the first one is free.
    await expect(swatches.first()).toHaveAttribute('aria-pressed', 'true');
    await swatches.nth(4).click();
    await expect(swatches.nth(4)).toHaveAttribute('aria-pressed', 'true');

    const formBounds = await form.boundingBox();
    const swatchBounds = await swatches.last().boundingBox();
    expect(swatchBounds!.x + swatchBounds!.width).toBeLessThanOrEqual(
      formBounds!.x + formBounds!.width
    );
    await test.info().attach('add-project-form', {
      body: await appWindow.screenshot(),
      contentType: 'image/png',
    });

    const pickedColor = await swatches
      .nth(4)
      .evaluate((swatch) => (swatch as HTMLElement).style.backgroundColor);
    const submit = form.getByRole('button', { name: 'Add Project', exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(form).toHaveCount(0);
    // Git names the repository by its real path: /private/tmp/... for /tmp/... on macOS.
    const added = await appWindow.evaluate(
      async (repositoryPath) =>
        (await window.api.getProjects()).find((p) => p.repositoryPath === repositoryPath),
      fs.realpathSync(repo)
    );
    expect(added).toMatchObject({ name: 'side-repo', kind: 'git' });
    const addedColor = await appWindow.evaluate((color) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = color;
      return probe.style.backgroundColor;
    }, added!.color);
    expect(addedColor).toBe(pickedColor);
    await expect(
      appWindow.getByRole('dialog', { name: 'Create Workspace' }).getByRole('button', {
        name: /side-repo/,
      })
    ).toBeVisible();
  });
});
