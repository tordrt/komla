import fs from 'node:fs';
import path from 'node:path';

import {
  test as base,
  E2E_GIT_IDENTITY_ENV,
  expect,
  SANDBOX_DIR,
  seedDefaultProject,
} from './electron-app';

import type { Page } from '@playwright/test';

/** A stand-in `gh` that prints `pr.json`, or says the branch has no pull request without it. */
const FAKE_GH_DIR = path.join(SANDBOX_DIR, 'fake-gh');
const PR_FILE = path.join(FAKE_GH_DIR, 'pr.json');
const CALLS_FILE = path.join(FAKE_GH_DIR, 'calls.log');
const FAKE_GH = `#!/bin/sh
printf '%s\\t%s\\n' "$PWD" "$*" >> '${CALLS_FILE}'
if [ -f '${PR_FILE}' ]; then cat '${PR_FILE}'; exit 0; fi
echo 'no pull requests found for branch "pr/status"' >&2
exit 1
`;

const checkRun = (name: string, status: string, conclusion = '') => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/app/actions/runs/1/${name}`,
});

function writePullRequest(state: string, checks: object[]): void {
  fs.writeFileSync(
    PR_FILE,
    JSON.stringify({
      number: 42,
      title: 'Add search',
      url: 'https://github.com/acme/app/pull/42',
      state,
      isDraft: false,
      headRefOid: 'a'.repeat(40),
      statusCheckRollup: checks,
    })
  );
}

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'pr/' });
    fs.mkdirSync(FAKE_GH_DIR, { recursive: true });
    fs.writeFileSync(path.join(FAKE_GH_DIR, 'gh'), FAKE_GH, { mode: 0o755 });
    // A zsh login shell would otherwise read the user's dotfiles, which can put the real gh first.
    fs.writeFileSync(path.join(FAKE_GH_DIR, '.zprofile'), '');
    await provide();
  },
});

test.use({
  appEnv: {
    ...E2E_GIT_IDENTITY_ENV,
    PATH: `${FAKE_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    ZDOTDIR: FAKE_GH_DIR,
  },
});

/** Reads the pull request again, as the window being shown does. */
async function pullRequestButtonLabel(appWindow: Page): Promise<string | null> {
  await appWindow.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const button = appWindow.getByRole('button', { name: /^Pull request:/ });
  return (await button.count()) > 0 ? button.getAttribute('aria-label') : null;
}

test.describe('Pull request status bar item', () => {
  test.skip(process.platform === 'win32', 'The fake gh is a POSIX shell script');
  test.describe.configure({ timeout: 90_000 });

  test("shows the branch's pull request and its checks as gh reports them", async ({
    appWindow,
  }) => {
    // Created from the dialog, which opens the new workspace.
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click({
      timeout: 15_000,
    });
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('pr/status');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect
      .poll(async () => appWindow.evaluate(async () => (await window.api.getWorkspaces()).length))
      .toBe(1);
    const workingDirectory = await appWindow.evaluate(
      async () => (await window.api.getWorkspaces())[0].workingDirectory
    );

    // Without a pull request, gh runs in the worktree and the item stays hidden.
    await expect.poll(() => fs.existsSync(CALLS_FILE), { timeout: 15_000 }).toBe(true);
    const [cwd, args] = fs.readFileSync(CALLS_FILE, 'utf8').trim().split('\n')[0].split('\t');
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(workingDirectory));
    expect(args).toBe('pr view --json number,title,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup');
    await expect(appWindow.getByRole('button', { name: /^Pull request:/ })).toHaveCount(0);

    writePullRequest('OPEN', [
      checkRun('lint', 'COMPLETED', 'SUCCESS'),
      checkRun('test', 'COMPLETED', 'FAILURE'),
      checkRun('build', 'IN_PROGRESS'),
    ]);
    await expect
      .poll(() => pullRequestButtonLabel(appWindow), { timeout: 20_000 })
      .toBe('Pull request: #42 Add search · CI failed');

    await appWindow.getByRole('button', { name: /^Pull request:/ }).click();
    await expect(appWindow.getByText('#42 · Open · 1 of 3 checks passed')).toBeVisible();
    await expect(appWindow.getByRole('list', { name: 'Checks' }).getByRole('listitem')).toHaveText([
      'CI / testfailed',
      'CI / buildpending',
      'CI / lintpassed',
    ]);
    await appWindow.keyboard.press('Escape');

    writePullRequest('MERGED', [checkRun('lint', 'COMPLETED', 'SUCCESS')]);
    await expect
      .poll(() => pullRequestButtonLabel(appWindow), { timeout: 20_000 })
      .toBe('Pull request: #42 Add search · Merged');
  });
});
