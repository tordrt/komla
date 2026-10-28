import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { test as base, expect, seedDefaultProject, SANDBOX_DIR } from './electron-app';

import type { Page } from '@playwright/test';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@test.local',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@test.local',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

function commitFile(cwd: string, name: string): void {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`);
  git(cwd, ['add', '--', name]);
  git(cwd, ['commit', '-m', `add ${name}`]);
}

const repoDir = path.join(SANDBOX_DIR, 'seed-repo');

/** Through the dialog, which puts the workspace in this window's sidebar. */
async function createWorkspace(appWindow: Page, branchName: string): Promise<string> {
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branchName);
  // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(dialog).toBeHidden();
  let dir = '';
  await expect
    .poll(async () => {
      const ws = await appWindow.evaluate(
        async (name) => (await window.api.getWorkspaces()).find((w) => w.branchName === name),
        branchName
      );
      dir = ws && !ws.provisioning && !ws.provisionError ? ws.workingDirectory : '';
      return dir !== '';
    })
    .toBe(true);
  return dir;
}

function statusOf(appWindow: Page, branchName: string) {
  return appWindow.evaluate(
    async (name) => (await window.api.getWorkspaces()).find((w) => w.branchName === name)?.status,
    branchName
  );
}

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'workspace-cleanup/',
      initialFile: { name: 'README.md', content: 'seed\n' },
    });
    await provide();
  },
});

test.describe('Workspace cleanup', () => {
  test.describe.configure({ timeout: 90_000 });

  test('trashes workspaces with nothing to lose, but not ones in use', async ({
    appWindow,
  }) => {
    const mergedDir = await createWorkspace(appWindow, 'workspace-cleanup/merged');
    const wipDir = await createWorkspace(appWindow, 'workspace-cleanup/wip');
    commitFile(mergedDir, 'merged.txt');
    commitFile(wipDir, 'wip.txt');
    git(repoDir, ['merge', '--squash', 'workspace-cleanup/merged']);
    git(repoDir, ['commit', '-m', 'squash merge']);

    await appWindow
      .locator('.sidebar-surface')
      .getByRole('button', { name: 'seed-repo' })
      .first()
      .click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Clean Up Workspaces...' }).click();

    const dialog = appWindow.getByRole('dialog', { name: 'Clean up workspaces' });
    const landed = dialog.getByRole('region', { name: 'Already in main' });
    await expect(landed.getByRole('checkbox', { name: /workspace-cleanup\/merged/ })).toBeChecked({
      timeout: 15_000,
    });
    // In use, with a commit main doesn't have: not offered.
    await expect(dialog.getByText('workspace-cleanup/wip')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Move 1 workspace to Trash' }).click();

    await expect(dialog).toBeHidden();
    await expect.poll(() => statusOf(appWindow, 'workspace-cleanup/merged')).toBe('trashed');
    expect(await statusOf(appWindow, 'workspace-cleanup/wip')).toBe('active');
  });
});
