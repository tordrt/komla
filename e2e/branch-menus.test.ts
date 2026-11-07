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

const repoDir = path.join(SANDBOX_DIR, 'seed-repo');
const originDir = path.join(SANDBOX_DIR, 'origin.git');
const upstreamDir = path.join(SANDBOX_DIR, 'upstream');
const branchName = 'branch-menus/work';

const test = base.extend<{ topicCommit: string }>({
  topicCommit: async ({ seedSandbox: _seedSandbox }, provide) => {
    await provide(git(repoDir, ['rev-parse', 'origin/topic']));
  },
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'branch-menus/',
      initialFile: { name: 'README.md', content: 'seed\n' },
    });
    git(SANDBOX_DIR, ['clone', '-q', '--bare', repoDir, originDir]);
    git(repoDir, ['remote', 'add', 'origin', originDir]);
    git(repoDir, ['fetch', '-q', 'origin']);
    git(repoDir, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
    git(repoDir, ['remote', 'set-head', 'origin', 'main']);
    git(repoDir, ['branch', '-q', 'other']);
    // A branch only origin has: someone else's work, fetched but never checked out here.
    git(SANDBOX_DIR, ['clone', '-q', originDir, upstreamDir]);
    git(upstreamDir, ['switch', '-q', '-c', 'topic']);
    fs.writeFileSync(path.join(upstreamDir, 'topic.txt'), 'topic\n');
    git(upstreamDir, ['add', '--', 'topic.txt']);
    git(upstreamDir, ['commit', '-q', '-m', 'topic work']);
    git(upstreamDir, ['push', '-q', 'origin', 'topic']);
    git(repoDir, ['fetch', '-q', 'origin']);
    await provide();
  },
});

/** Creates the workspace through the dialog, so it is the one selected, and returns its folder. */
async function createWorkspace(appWindow: Page): Promise<string> {
  const newWorkspace = appWindow.getByRole('button', { name: 'New Workspace' }).first();
  await expect(newWorkspace).toBeVisible({ timeout: 15_000 });
  await newWorkspace.click();
  const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await dialog.locator('input[placeholder$="swift-fox"]').fill(branchName);
  // The sandbox seeds no agent preset, so the submit button reads "Create" rather than "Launch".
  await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
    timeout: 10_000,
  });
  return appWindow.evaluate(
    async (name) =>
      (await window.api.getWorkspaces()).find((w) => w.branchName === name)!.workingDirectory,
    branchName
  );
}

function workspaceTarget(appWindow: Page): Promise<string | null> {
  return appWindow.evaluate(
    async (name) =>
      (await window.api.getWorkspaces()).find((w) => w.branchName === name)!.baseBranch ?? null,
    branchName
  );
}

test.describe('Branch menus', () => {
  test.describe.configure({ timeout: 90_000 });

  test('merges a branch only origin has from the Remote section', async ({
    appWindow,
    topicCommit,
  }) => {
    const dir = await createWorkspace(appWindow);

    await appWindow.getByRole('button', { name: branchName }).last().click();
    await appWindow.getByRole('menuitem', { name: 'Branches', exact: true }).hover();
    await appWindow.getByRole('menuitem', { name: /^Remote \(/ }).click();
    await appWindow.getByRole('menuitem', { name: 'topic', exact: true }).click();
    await appWindow.getByRole('menuitem', { name: 'Merge', exact: true }).click();

    await expect
      .poll(() => {
        try {
          return git(dir, ['merge-base', '--is-ancestor', topicCommit, 'HEAD']) === '';
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(git(dir, ['branch', '--show-current'])).toBe(branchName);
  });

  test('picks and resets the target branch with the keyboard alone', async ({ appWindow }) => {
    await createWorkspace(appWindow);
    const trigger = appWindow.getByRole('button', { name: 'main', exact: true }).last();
    const filter = appWindow.getByPlaceholder('Filter or create branch...');

    // The pointer stays off the menu, where Create left it: as the branches load, items that move
    // under a resting pointer take the focus from the filter.
    await appWindow.mouse.move(0, 0);
    // The menu opens with its filter focused, and a filter finds remote branches though their
    // section is collapsed.
    await trigger.focus();
    await appWindow.keyboard.press('Enter');
    await expect(filter).toBeFocused();
    await appWindow.keyboard.type('top');
    await expect(appWindow.getByRole('menuitem', { name: /^topic/ })).toBeVisible();
    await appWindow.keyboard.press('ControlOrMeta+a');
    await appWindow.keyboard.type('other');
    // Arrow Down leaves the filter for the first item below it, Reset (a new workspace keeps
    // the target it started from as its own), and Arrow Up comes back.
    await appWindow.keyboard.press('ArrowDown');
    const reset = appWindow.getByRole('menuitem', { name: 'Reset to project target (main)' });
    await expect(reset).toBeFocused();
    await appWindow.keyboard.press('ArrowUp');
    await expect(filter).toBeFocused();
    await appWindow.keyboard.press('ArrowDown');
    await appWindow.keyboard.press('End');
    await expect(appWindow.getByRole('menuitem', { name: /^other/ })).toBeFocused();
    await appWindow.keyboard.press('Enter');
    await expect.poll(() => workspaceTarget(appWindow)).toBe('other');

    await appWindow.getByRole('button', { name: 'other', exact: true }).last().focus();
    await appWindow.keyboard.press('Enter');
    await expect(filter).toBeFocused();
    // The branches load as the menu opens, below Reset.
    const remote = appWindow.getByRole('menuitem', { name: /^Remote \(/ });
    await expect(remote).toBeVisible();
    await appWindow.keyboard.press('ArrowDown');
    await expect(reset).toBeFocused();
    await appWindow.keyboard.press('Enter');
    await expect.poll(() => workspaceTarget(appWindow)).toBe(null);
    // Reset leaves with the reset, and the menu hands the focus to the item after it.
    await expect(reset).toBeHidden();
    await expect(remote).toBeFocused();
    await appWindow.keyboard.press('ArrowUp');
    await expect(filter).toBeFocused();
  });
});
