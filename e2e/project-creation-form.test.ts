import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  test as base,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
  _electron,
} from '@playwright/test';

import {
  E2E_GIT_IDENTITY_ENV,
  ELECTRON_ARGS,
  e2eSandboxDir,
  firstRendererWindow,
} from './electron-app';

const SANDBOX_DIR = e2eSandboxDir('komla-e2e-pcf');

interface Fixtures {
  electronApp: ElectronApplication;
  appWindow: Page;
  seedRepoPath: string;
}

const test = base.extend<Fixtures>({
  seedRepoPath: async ({}, provide) => {
    const repoDir = path.join(SANDBOX_DIR, 'seed-repo');
    await provide(repoDir);
  },
  electronApp: [
    async ({}, provide) => {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });

      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'config.json'),
        JSON.stringify({ agentSetupComplete: true, usageTelemetryConsentAnswered: true })
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
              id: 'e2e-seed',
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
          ...E2E_GIT_IDENTITY_ENV,
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
        win.setSize(1280, 900);
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

async function openProjectsSettings(appWindow: Page): Promise<void> {
  // Settings loads lazily on first open; re-dispatch until it renders.
  await expect(async () => {
    await appWindow.evaluate(() => {
      window.dispatchEvent(new CustomEvent('open-settings', { detail: 'projects' }));
    });
    await expect(appWindow.getByRole('button', { name: 'Add Project' })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 15_000 });
}

function projectCreationForm(appWindow: Page): Locator {
  return appWindow.getByRole('region', { name: 'Add project' }).first();
}

test.describe('ProjectCreationForm', () => {
  test.describe.configure({ timeout: 60_000 });

  test('renders all three creation modes with correct primary-button labels', async ({
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    await openProjectsSettings(appWindow);
    await appWindow.getByRole('button', { name: 'Add Project' }).click();

    // Default: local existing repo → primary button reads "Add Project"
    const formPanel = projectCreationForm(appWindow);
    await expect(formPanel).toBeVisible();
    await expect(formPanel.getByText('Project source')).toHaveCount(0);
    await expect(formPanel.getByText('Pick folder')).toHaveCount(0);
    await expect(formPanel.getByText('Folder', { exact: true })).toHaveCount(0);
    await expect(
      formPanel.getByRole('button', { name: /^Add Project$/, exact: true }).last()
    ).toBeVisible();

    // Switch to "new empty repo" via the inline link → label becomes "Create & Add Project"
    await formPanel.getByRole('button', { name: 'Create empty repo' }).click();
    await expect(formPanel.getByLabel('Project Name')).toBeVisible();
    await expect(formPanel.getByRole('button', { name: 'Create & Add Project' })).toBeVisible();

    // Back to existing repo
    await formPanel.getByRole('button', { name: 'Or use an existing repo' }).click();
    await expect(formPanel.getByRole('button', { name: 'Browse for folder' })).toBeVisible();

    // Switch to remote clone → label becomes "Clone & Add Project"
    await formPanel.getByRole('button', { name: 'Clone from remote' }).click();
    await expect(formPanel.getByLabel('Repository URL')).toBeVisible();
    await expect(formPanel.getByRole('button', { name: 'Clone & Add Project' })).toBeVisible();
  });

  test('SSH/HTTPS toggle converts the remote URL format', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await openProjectsSettings(appWindow);
    await appWindow.getByRole('button', { name: 'Add Project' }).click();

    const formPanel = projectCreationForm(appWindow);
    await formPanel.getByRole('button', { name: 'Clone from remote' }).click();

    const urlInput = formPanel.getByLabel('Repository URL');
    await urlInput.fill('git@github.com:acme/widgets.git');

    // Flip to HTTPS — the URL should convert
    await formPanel.getByRole('radio', { name: 'HTTPS', exact: true }).click();
    await expect(urlInput).toHaveValue('https://github.com/acme/widgets.git');

    // Flip back to SSH — URL converts the other way
    await formPanel.getByRole('radio', { name: 'SSH', exact: true }).click();
    await expect(urlInput).toHaveValue('git@github.com:acme/widgets.git');
  });

  test('surfaces validation errors for each creation mode', async ({ appWindow }) => {
    await waitForMainUi(appWindow);
    await openProjectsSettings(appWindow);
    await appWindow.getByRole('button', { name: 'Add Project' }).click();

    const formPanel = projectCreationForm(appWindow);

    // Submit stays disabled until each mode's required input is filled.
    await expect(
      formPanel.getByRole('button', { name: /^Add Project$/, exact: true }).last()
    ).toBeDisabled();

    await formPanel.getByRole('button', { name: 'Create empty repo' }).click();
    await expect(formPanel.getByRole('button', { name: 'Create & Add Project' })).toBeDisabled();

    await formPanel.getByRole('button', { name: 'Clone from remote' }).click();
    await expect(formPanel.getByRole('button', { name: 'Clone & Add Project' })).toBeDisabled();

    // Remote with invalid URL
    await formPanel.getByLabel('Repository URL').fill('ftp://nope');
    await formPanel.getByRole('button', { name: 'Clone & Add Project' }).click();
    await expect(formPanel.getByText('Enter a valid Git URL (https:// or git@)')).toBeVisible();
  });

  test('advanced settings toggle exposes branch prefix and behind-action fields', async ({
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    await openProjectsSettings(appWindow);
    await appWindow.getByRole('button', { name: 'Add Project' }).click();

    const formPanel = projectCreationForm(appWindow);

    // Git advanced fields are available once the source is a git-backed project.
    await formPanel.getByRole('button', { name: 'Create empty repo' }).click();

    // Collapsed by default
    await expect(formPanel.getByLabel('Branch Prefix')).toHaveCount(0);

    await formPanel.getByRole('button', { name: 'Advanced settings' }).click();
    await expect(formPanel.getByLabel('Branch Prefix')).toBeVisible();

    // The three behind-action options should be reachable
    const select = formPanel.getByRole('combobox');
    await expect(select).toBeVisible();
    await select.selectOption('rebase');
    await expect(
      formPanel.getByText(/rebases the current branch on top of the target branch/i)
    ).toBeVisible();
    await select.selectOption('merge');
    await expect(
      formPanel.getByText(/merges the target branch into the current branch/i)
    ).toBeVisible();
  });

  test('keeps the inline project form within the New Workspace dialog', async ({
    electronApp,
    appWindow,
  }) => {
    await waitForMainUi(appWindow);
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();

    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.getByRole('button', { name: /seed-repo/i }).click();
    await appWindow.getByRole('menuitem', { name: /add new project/i }).click();

    const inlineForm = dialog.getByRole('heading', { name: 'Add New Project' }).locator('../..');
    const selectedProjectPath =
      '/Users/example/.komla/repos/a-project-with-a-long-name-that-must-not-expand-the-dialog/.git';
    await electronApp.evaluate(({ dialog: electronDialog }) => {
      electronDialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [
          '/Users/example/.komla/repos/a-project-with-a-long-name-that-must-not-expand-the-dialog/.git',
        ],
      });
    });
    await inlineForm.getByRole('button', { name: 'Browse for folder' }).click();
    const selectedPath = inlineForm.getByTitle(selectedProjectPath);
    await expect(selectedPath).toBeVisible();

    const dialogBounds = await dialog.boundingBox();
    const formBounds = await inlineForm.boundingBox();
    const folderRowBounds = await selectedPath.locator('..').boundingBox();

    expect(dialogBounds).not.toBeNull();
    expect(formBounds).not.toBeNull();
    expect(folderRowBounds).not.toBeNull();
    expect(formBounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x);
    expect(formBounds!.x + formBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width
    );
    expect(folderRowBounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x);
    expect(folderRowBounds!.x + folderRowBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width
    );
  });

  test('successfully adds a project from a local existing repo', async ({
    electronApp,
    appWindow,
    seedRepoPath,
  }) => {
    await waitForMainUi(appWindow);

    // Create a second on-disk repo we can add via the form
    const secondRepo = path.join(path.dirname(seedRepoPath), 'second-repo');
    fs.mkdirSync(secondRepo, { recursive: true });
    execSync('git init -b main && git commit --allow-empty -m "init"', {
      cwd: secondRepo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'E2E',
        GIT_AUTHOR_EMAIL: 'e2e@test.local',
        GIT_COMMITTER_NAME: 'E2E',
        GIT_COMMITTER_EMAIL: 'e2e@test.local',
      },
    });

    await openProjectsSettings(appWindow);
    const before = await appWindow.evaluate(async () => (await window.api.getProjects()).length);

    await appWindow.getByRole('button', { name: 'Add Project' }).click();

    const formPanel = projectCreationForm(appWindow);

    await electronApp.evaluate(({ dialog }, repositoryPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repositoryPath] });
    }, secondRepo);
    await formPanel.getByRole('button', { name: 'Browse for folder' }).click();

    // Wait for the origin-remote check to settle (the button stays disabled while checking)
    const submit = formPanel.getByRole('button', { name: /^Add Project$/, exact: true }).last();
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();

    await expect
      .poll(async () => appWindow.evaluate(async () => (await window.api.getProjects()).length))
      .toBe(before + 1);
  });
});
