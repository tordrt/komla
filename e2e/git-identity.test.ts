import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR } from './electron-app';

const GLOBAL_GIT_CONFIG = path.join(SANDBOX_DIR, 'gitconfig');
// A scratch global config, and nothing inherited (identity, or GIT_DIR from a hook or
// `git rebase --exec`) that could supply a name or point git at another repository.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: GLOBAL_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  EMAIL: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_CONFIG_COUNT: undefined,
};

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    // useConfigOnly stops git guessing from the OS, like a fresh Windows install.
    fs.writeFileSync(GLOBAL_GIT_CONFIG, '[user]\n\tuseConfigOnly = true\n');
    await provide();
  },
});

test.use({ appEnv: GIT_ENV });

test('asks for a git name and email when creating the first project', async ({
  appWindow,
}, testInfo) => {
  await expect(appWindow.getByText('Add Your First Project')).toBeVisible();
  const form = appWindow.getByRole('region', { name: 'Add project' });
  await form.getByRole('button', { name: 'Create empty repo' }).click();
  await form.getByLabel('Project Name').fill('helloo');

  const identity = form.getByRole('group', { name: 'Git identity' });
  await expect(identity).toBeVisible();
  const submit = form.getByRole('button', { name: 'Create & Add Project' });
  await expect(submit).toBeDisabled();
  await identity.getByLabel('Your name').fill('Ada Lovelace');
  await identity.getByLabel('Your email').fill('ada@example.com');
  await appWindow.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('git-identity-prompt.png'),
  });
  await submit.click();

  await expect
    .poll(async () =>
      appWindow.evaluate(async () => (await window.api.getProjects()).map((p) => p.name))
    )
    .toEqual(['helloo']);
  const config = fs.readFileSync(GLOBAL_GIT_CONFIG, 'utf8');
  expect(config).toContain('name = Ada Lovelace');
  expect(config).toContain('email = ada@example.com');
  const repoPath = path.join(SANDBOX_DIR, 'repos', 'helloo', '.git');
  const author = execFileSync('git', ['-C', repoPath, 'log', '-1', '--format=%an <%ae>', 'main'], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  });
  expect(author.trim()).toBe('Ada Lovelace <ada@example.com>');
});
