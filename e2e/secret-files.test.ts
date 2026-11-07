import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const SCREENSHOT_DIR = process.env.KOMLA_E2E_SCREENSHOT_DIR;
const CONTENTS = 'API_KEY=sk-e2e-secret\nDATABASE_URL=postgres://localhost/app\n';

// The project's Workspace Setup writes a Secret .env, which its repository ignores.
const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'secret-files/',
      initialFile: { name: '.gitignore', content: '.env\n' },
    });
    const file = path.join(SANDBOX_DIR, 'settings', 'projects.json');
    const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
    projects.projects[0].setupSteps = [
      {
        id: 'secret-env',
        name: 'Secret .env',
        command: '',
        placement: 'background',
        kind: 'secret-file',
        file: '.env',
        trigger: 'workspace-creation',
      },
    ];
    fs.writeFileSync(file, JSON.stringify(projects));
    await provide();
  },
});

test.describe('Secret files', () => {
  test.describe.configure({ timeout: 90_000 });

  test('keeps contents out of the project settings and writes them as a workspace is created', async ({
    appWindow,
  }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Contents typed in Workspace Setup save to this computer, not with the project.
    await appWindow.evaluate(() =>
      window.dispatchEvent(new CustomEvent('open-workspace-setup', { detail: 'e2e-project' }))
    );
    await appWindow.getByRole('button', { name: 'Add contents' }).click();
    await appWindow.getByRole('textbox', { name: 'Contents for Secret .env' }).fill(CONTENTS);
    await expect(appWindow.getByText('Sets API_KEY, DATABASE_URL')).toBeVisible();
    await appWindow.getByRole('button', { name: 'Save changes' }).click();
    await expect(appWindow.getByRole('button', { name: 'Replace' })).toBeVisible();
    await expect(appWindow.getByText('Sets API_KEY, DATABASE_URL')).toBeVisible();
    if (SCREENSHOT_DIR) {
      await appWindow
        .getByRole('article', { name: 'Setup step Secret .env' })
        .screenshot({ path: path.join(SCREENSHOT_DIR, 'secret-file-step.png') });
    }
    const settings = fs.readdirSync(path.join(SANDBOX_DIR, 'settings'));
    for (const name of settings.filter((entry) => entry.endsWith('.json'))) {
      const text = fs.readFileSync(path.join(SANDBOX_DIR, 'settings', name), 'utf8');
      // Only the Secret files file holds them, and only it, without a keychain here, in the clear.
      if (name !== 'secret-files.json') expect(text, name).not.toContain('sk-e2e-secret');
    }
    await appWindow.keyboard.press('Escape');

    const created = await appWindow.evaluate(async () =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'secret-files/new',
      })
    );
    expect(created).not.toHaveProperty('__workspaceCreateError');
    const { workingDirectory, id } = created as { workingDirectory: string; id: string };

    const env = path.join(workingDirectory, '.env');
    await expect.poll(() => fs.existsSync(env), { timeout: 15_000 }).toBe(true);
    expect(fs.readFileSync(env, 'utf8')).toBe(CONTENTS);
    if (process.platform !== 'win32') expect(fs.statSync(env).mode & 0o777).toBe(0o600);

    await expect
      .poll(async () => {
        const workspace = await appWindow.evaluate(
          async (workspaceId) => window.api.getWorkspace(workspaceId),
          id
        );
        return workspace?.setupActivities?.find((activity) => activity.stepId === 'secret-env');
      })
      .toMatchObject({ state: 'succeeded', output: 'Wrote .env.\n' });
  });
});
