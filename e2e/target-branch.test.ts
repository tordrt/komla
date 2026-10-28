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

function commitFile(cwd: string, name: string, content: string): string {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ['add', '--', name]);
  git(cwd, ['commit', '-m', `edit ${name}`]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

const repoDir = path.join(SANDBOX_DIR, 'seed-repo');
const originDir = path.join(SANDBOX_DIR, 'origin.git');
const upstreamDir = path.join(SANDBOX_DIR, 'upstream');

/** Gives origin's main a commit the project doesn't have yet, and fetches it. */
function advanceOrigin(name: string, content: string): string {
  const commit = commitFile(upstreamDir, name, content);
  git(upstreamDir, ['push', '-q', 'origin', 'main']);
  git(repoDir, ['fetch', '-q', 'origin']);
  return commit;
}

/** Gives the project's own main a commit, wherever main is checked out (or nowhere). */
function commitOnLocalMain(name: string, content: string): string {
  if (git(repoDir, ['branch', '--show-current']) === 'main')
    return commitFile(repoDir, name, content);
  const scratch = path.join(SANDBOX_DIR, 'local-main');
  git(repoDir, ['worktree', 'add', '-q', scratch, 'main']);
  const commit = commitFile(scratch, name, content);
  git(repoDir, ['worktree', 'remove', scratch]);
  return commit;
}

async function createWorkspace(
  appWindow: Page,
  branchName: string,
  extra: { startFromOrigin?: boolean } = {}
): Promise<{ id: string; dir: string }> {
  const created = await appWindow.evaluate(
    async ({ name, options }) =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: name,
        useExactBranchName: true,
        ...options,
      }),
    { name: branchName, options: extra }
  );
  expect(created).not.toHaveProperty('__workspaceCreateError');
  let workspace: { id: string; dir: string } | undefined;
  await expect
    .poll(async () => {
      const state = await appWindow.evaluate(async (name) => {
        const ws = (await window.api.getWorkspaces()).find((w) => w.branchName === name);
        return ws
          ? {
              id: ws.id,
              dir: ws.workingDirectory,
              provisioning: ws.provisioning ?? false,
              provisionError: ws.provisionError ?? null,
            }
          : null;
      }, branchName);
      if (state && !state.provisioning && !state.provisionError) {
        workspace = { id: state.id, dir: state.dir };
      }
      return state && { provisioning: state.provisioning, provisionError: state.provisionError };
    })
    .toEqual({ provisioning: false, provisionError: null });
  return workspace!;
}

function callGit(
  appWindow: Page,
  method: 'mergeToTargetBranch' | 'mergeTargetBranchFromRemote' | 'pullTargetBranch',
  dir: string
): Promise<{ success: boolean; message: string }> {
  return appWindow.evaluate(({ method, dir }) => window.api[method](dir), { method, dir });
}

const test = base.extend<{ parkProject: boolean }>({
  parkProject: [false, { option: true }],
  seedSandbox: async ({ cleanSandbox: _cleanSandbox, parkProject }, provide) => {
    seedDefaultProject({
      branchPrefix: 'target-branch/',
      initialFile: { name: 'README.md', content: 'seed\n' },
    });
    git(SANDBOX_DIR, ['clone', '-q', '--bare', repoDir, originDir]);
    git(repoDir, ['remote', 'add', 'origin', originDir]);
    git(repoDir, ['fetch', '-q', 'origin']);
    git(repoDir, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
    git(repoDir, ['remote', 'set-head', 'origin', 'main']);
    git(SANDBOX_DIR, ['clone', '-q', originDir, upstreamDir]);
    // With the project folder on another branch, no worktree has main checked out, so Komla
    // moves it without a checkout.
    if (parkProject) git(repoDir, ['switch', '-q', '-c', 'parked']);
    await provide();
  },
});

for (const parkProject of [false, true]) {
  test.describe(`Target branch, project folder on ${parkProject ? 'another branch' : 'main'}`, () => {
    test.use({ parkProject });
    test.describe.configure({ timeout: 90_000 });

    test('merges a workspace into a target that is behind origin', async ({ appWindow }) => {
      const remote = advanceOrigin('remote.txt', 'remote\n');
      const ws = await createWorkspace(appWindow, 'target-branch/ship', { startFromOrigin: true });
      expect(git(ws.dir, ['merge-base', '--is-ancestor', remote, 'HEAD'])).toBe('');
      const work = commitFile(ws.dir, 'feature.txt', 'feature\n');

      const result = await callGit(appWindow, 'mergeToTargetBranch', ws.dir);

      expect(result).toMatchObject({ success: true });
      expect(git(repoDir, ['rev-parse', 'main'])).toBe(work);
      expect(git(ws.dir, ['branch', '--show-current'])).toBe('target-branch/ship');
      if (!parkProject) {
        expect(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf8')).toBe('feature\n');
        expect(git(repoDir, ['status', '--porcelain'])).toBe('');
      }
    });

    test('merges origin into a diverged target without switching the workspace', async ({
      appWindow,
    }) => {
      const ws = await createWorkspace(appWindow, 'target-branch/sync');
      const local = commitOnLocalMain('local.txt', 'local\n');
      const remote = advanceOrigin('remote.txt', 'remote\n');

      const result = await callGit(appWindow, 'mergeTargetBranchFromRemote', ws.dir);

      expect(result).toMatchObject({ success: true });
      expect(
        git(repoDir, ['rev-list', '--parents', '-n', '1', 'main']).split(' ').slice(1)
      ).toEqual([local, remote]);
      expect(git(ws.dir, ['branch', '--show-current'])).toBe('target-branch/sync');
      // Switching away and back would leave the same end state, but not the same HEAD history.
      expect(git(ws.dir, ['reflog', '--format=%gs', 'HEAD'])).not.toContain('checkout: moving');
      expect(git(repoDir, ['branch', '--show-current'])).toBe(parkProject ? 'parked' : 'main');
      expect(git(repoDir, ['status', '--porcelain'])).toBe('');
    });

    test('leaves a conflicting diverged target unchanged', async ({ appWindow }) => {
      const ws = await createWorkspace(appWindow, 'target-branch/conflict');
      const local = commitOnLocalMain('README.md', 'local\n');
      advanceOrigin('README.md', 'remote\n');

      const result = await callGit(appWindow, 'mergeTargetBranchFromRemote', ws.dir);

      expect(result.success).toBe(false);
      // Only the checkout-free merge names the files; a merge in the project folder is aborted.
      expect(result.message).toContain(parkProject ? 'README.md' : 'was aborted');
      expect(git(repoDir, ['rev-parse', 'main'])).toBe(local);
      expect(git(repoDir, ['status', '--porcelain'])).toBe('');
      expect(fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD'))).toBe(false);
    });

    test('pulls the target from origin', async ({ appWindow }) => {
      const ws = await createWorkspace(appWindow, 'target-branch/pull');
      const remote = advanceOrigin('remote.txt', 'remote\n');

      const result = await callGit(appWindow, 'pullTargetBranch', ws.dir);

      expect(result).toMatchObject({ success: true });
      expect(git(repoDir, ['rev-parse', 'main'])).toBe(remote);
      expect(git(ws.dir, ['branch', '--show-current'])).toBe('target-branch/pull');
    });

    test("cleans up git's record of a workspace whose folder was removed", async ({
      appWindow,
    }) => {
      const ws = await createWorkspace(appWindow, 'target-branch/gone');
      fs.rmSync(ws.dir, { recursive: true, force: true });

      await appWindow.evaluate((id) => window.api.deleteWorkspace(id, true, true), ws.id);

      expect(git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(ws.dir);
      expect(git(repoDir, ['branch', '--list', 'target-branch/gone'])).toBe('');
    });
  });
}

test.describe('Target branch, project folder parked elsewhere', () => {
  test.use({ parkProject: true });
  test.describe.configure({ timeout: 90_000 });

  test('never deletes the target branch with a workspace opened on it', async ({ appWindow }) => {
    const ws = await createWorkspace(appWindow, 'main');

    await appWindow.evaluate((id) => window.api.deleteWorkspace(id, true, true), ws.id);

    expect(git(repoDir, ['branch', '--list', 'main'])).toContain('main');
    expect(git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(ws.dir);
  });
});
