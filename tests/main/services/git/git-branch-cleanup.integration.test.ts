import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));
vi.mock('../../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
  },
}));

// The host's shell is this computer's, so the SSH runner's scripts run against real git.
vi.mock('../../../../src/main/services/ssh-workspace.service', async () => {
  const { spawn } = await import('child_process');
  return {
    sshWorkspaceService: {
      getHost: (id: string) => ({ id }),
      runWithInput: (_host: unknown, command: string, input: string) =>
        new Promise<string>((resolve, reject) => {
          const shell = spawn('sh', ['-c', command]);
          let output = '';
          shell.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
          shell.on('error', reject);
          shell.on('close', (code) =>
            code === 0 ? resolve(output) : reject(new Error(`sh exited with ${code}`))
          );
          shell.stdin.end(input);
        }),
    },
  };
});
vi.mock('../../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: {},
}));

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, encoding: 'utf-8' });
  return stdout.trim();
}

describe.each(['local', 'ssh'] as const)('GitBranchCleanupService integration (%s)', (mode) => {
  let repoPath: string;
  let tempPaths: string[];

  async function commitFile(file: string, content: string, message: string): Promise<string> {
    writeFileSync(join(repoPath, file), content);
    await runGit(repoPath, ['add', file]);
    await runGit(repoPath, ['commit', '-m', message]);
    return runGit(repoPath, ['rev-parse', 'HEAD']);
  }

  /** A branch off main with one commit per file, leaving main checked out. */
  async function branchWithCommits(branch: string, files: string[]): Promise<string> {
    await runGit(repoPath, ['switch', '-c', branch, 'main']);
    for (const file of files) await commitFile(file, `${file} on ${branch}\n`, `add ${file}`);
    await runGit(repoPath, ['switch', 'main']);
    return runGit(repoPath, ['rev-parse', branch]);
  }

  /** The service on a repository at a path, through this suite's way of running git. */
  async function loadService() {
    const { gitBranchCleanupService, localGitBatchRunner } =
      await import('../../../../src/main/services/git/git-branch-cleanup');
    const { sshWorkspaceGit } = await import('../../../../src/main/services/workspace-git/ssh-git');
    const repo = (path: string) =>
      mode === 'local' ? localGitBatchRunner(path) : sshWorkspaceGit.gitBatchRunner('host-1', path);
    return {
      listLeftoverBranches: async (
        path: string,
        targetBranch: string,
        keep: ReadonlySet<string>,
        options?: { skipBranchesOnOrigin?: boolean }
      ) =>
        (
          await gitBranchCleanupService.listLeftoverBranches(
            repo(path),
            targetBranch,
            keep,
            options
          )
        ).branches,
      deleteBranches: (
        path: string,
        branches: Array<{ name: string; commit: string }>,
        keep: ReadonlySet<string>
      ) => gitBranchCleanupService.deleteBranches(repo(path), branches, keep),
      /** As workspace cleanup checks one: read in the worktree, landed in the repository. */
      checkWorktree: async (path: string, targetBranch: string) => {
        const { commit, uncommittedChanges } = await gitBranchCleanupService.readWorktree(
          repo(path)
        );
        const [landed] = await gitBranchCleanupService.findLandedCommits(
          repo(repoPath),
          targetBranch,
          [commit]
        );
        return { landed, uncommittedChanges };
      },
    };
  }

  async function listLanded(keep: string[] = []): Promise<Record<string, boolean>> {
    const service = await loadService();
    const branches = await service.listLeftoverBranches(repoPath, 'main', new Set(keep));
    return Object.fromEntries(branches.map((branch) => [branch.name, branch.landed]));
  }

  beforeEach(async () => {
    vi.resetModules();
    tempPaths = [];
    repoPath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-'));
    tempPaths.push(repoPath);
    await runGit(repoPath, ['init', '--initial-branch=main']);
    await runGit(repoPath, ['config', 'user.name', 'Komla Test']);
    await runGit(repoPath, ['config', 'user.email', 'komla@example.com']);
    await runGit(repoPath, ['config', 'core.autocrlf', 'false']);
    await commitFile('readme.txt', 'base\n', 'initial');
  });

  afterEach(() => {
    for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
  });

  it('marks merged, rebased and squash-merged branches as landed, and unmerged ones not', async () => {
    await branchWithCommits('merged', ['merged.txt']);
    await runGit(repoPath, ['merge', '--no-ff', '-m', 'merge', 'merged']);

    const rebased = await branchWithCommits('rebased', ['rebased-1.txt', 'rebased-2.txt']);
    await commitFile('other.txt', 'main moved on\n', 'main moves on');
    await runGit(repoPath, ['cherry-pick', `${rebased}~1`, rebased]);

    await branchWithCommits('squashed', ['squashed-1.txt', 'squashed-2.txt']);
    await runGit(repoPath, ['merge', '--squash', 'squashed']);
    await runGit(repoPath, ['commit', '-m', 'squash merge']);
    await commitFile('after.txt', 'main moved on again\n', 'main moves on again');

    await branchWithCommits('unmerged', ['unmerged.txt']);
    // Partly squash-merged: one of its two changes is missing from main.
    await branchWithCommits('partly', ['partly-1.txt', 'partly-2.txt']);
    await runGit(repoPath, ['cherry-pick', 'partly~1']);

    await expect(listLanded()).resolves.toEqual({
      merged: true,
      rebased: true,
      squashed: true,
      unmerged: false,
      partly: false,
    });
  });

  it('counts a branch as landed when only origin has the merge', async () => {
    const originPath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-origin-'));
    tempPaths.push(originPath);
    await runGit(originPath, ['init', '--bare', '--initial-branch=main']);
    await runGit(repoPath, ['remote', 'add', 'origin', originPath]);
    await runGit(repoPath, ['push', '--quiet', 'origin', 'main']);
    await branchWithCommits('feature', ['feature.txt']);

    // The pull request merges on origin; the local main never pulls it.
    await runGit(repoPath, ['switch', '--detach', 'main']);
    await runGit(repoPath, ['merge', '--squash', 'feature']);
    await runGit(repoPath, ['commit', '-m', 'squash merge on origin']);
    await runGit(repoPath, ['push', '--quiet', 'origin', 'HEAD:main']);
    await runGit(repoPath, ['fetch', '--quiet', 'origin']);
    await runGit(repoPath, ['switch', 'main']);

    await expect(listLanded()).resolves.toEqual({ feature: true });
  });

  it('checks without writing to the repository, whatever the diff config says', async () => {
    await branchWithCommits('squashed', ['one.txt', 'two.txt']);
    await runGit(repoPath, ['merge', '--squash', 'squashed']);
    await runGit(repoPath, ['commit', '-m', 'squash merge']);
    await branchWithCommits('unmerged', ['unmerged.txt']);
    await runGit(repoPath, ['config', 'color.ui', 'always']);
    await runGit(repoPath, ['config', 'diff.noprefix', 'true']);
    const objectsBefore = await runGit(repoPath, ['count-objects']);

    await expect(listLanded()).resolves.toEqual({ squashed: true, unmerged: false });
    expect(await runGit(repoPath, ['count-objects'])).toBe(objectsBefore);
  });

  it("doesn't count a change the target had before the branch split off and then reverted", async () => {
    // An older branch makes the check read the target's history from before the change.
    await branchWithCommits('older', ['older.txt']);
    const change = await commitFile('change.txt', 'change\n', 'add change');
    await runGit(repoPath, ['revert', '--no-edit', 'HEAD']);
    await runGit(repoPath, ['switch', '-c', 'redo', 'main']);
    await runGit(repoPath, ['cherry-pick', change]);
    await runGit(repoPath, ['switch', 'main']);

    await expect(listLanded()).resolves.toEqual({ redo: false, older: false });
  });

  it('leaves out branches origin also has when asked, as for a bare clone', async () => {
    const originPath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-origin-'));
    tempPaths.push(originPath);
    await runGit(originPath, ['init', '--bare', '--initial-branch=main']);
    await runGit(repoPath, ['remote', 'add', 'origin', originPath]);
    await branchWithCommits('teammate', ['teammate.txt']);
    await branchWithCommits('mine', ['mine.txt']);
    await runGit(repoPath, ['push', '--quiet', 'origin', 'main', 'teammate']);
    const service = await loadService();

    const branches = await service.listLeftoverBranches(repoPath, 'main', new Set(), {
      skipBranchesOnOrigin: true,
    });

    expect(branches.map((branch) => branch.name)).toEqual(['mine']);
    await expect(listLanded()).resolves.toEqual({ teammate: false, mine: false });
  });

  it("doesn't mistake a different change to the same binary file for the branch's", async () => {
    await commitFile('image.bin', '\0base\0', 'add image');
    await branchWithCommits('image', []);
    await runGit(repoPath, ['switch', 'image']);
    await commitFile('image.bin', '\0from the branch\0', 'change image');
    await runGit(repoPath, ['switch', 'main']);
    await commitFile('image.bin', '\0from main\0', 'change image differently');

    await expect(listLanded()).resolves.toEqual({ image: false });
  });

  it('counts a change and its revert as landed', async () => {
    await branchWithCommits('reverted', ['oops.txt']);
    await runGit(repoPath, ['switch', 'reverted']);
    await runGit(repoPath, ['revert', '--no-edit', 'HEAD']);
    await runGit(repoPath, ['switch', 'main']);

    await expect(listLanded()).resolves.toEqual({ reverted: true });
  });

  it("doesn't count a branch as landed while a merge commit on it adds its own change", async () => {
    await branchWithCommits('evil-merge', ['feature.txt']);
    await commitFile('main.txt', 'main moved on\n', 'main moves on');
    await runGit(repoPath, ['switch', 'evil-merge']);
    await runGit(repoPath, ['merge', '--no-commit', 'main']);
    writeFileSync(join(repoPath, 'extra.txt'), 'only in the merge\n');
    await runGit(repoPath, ['add', 'extra.txt']);
    await runGit(repoPath, ['commit', '--no-edit']);
    await runGit(repoPath, ['switch', 'main']);
    await runGit(repoPath, ['cherry-pick', 'evil-merge^1']);

    await expect(listLanded()).resolves.toEqual({ 'evil-merge': false });
  });

  it('leaves out the target, kept branches and branches checked out in a worktree', async () => {
    await branchWithCommits('kept', ['kept.txt']);
    await branchWithCommits('in-worktree', ['in-worktree.txt']);
    await branchWithCommits('leftover', ['leftover.txt']);
    const worktreePath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-wt-'));
    tempPaths.push(worktreePath);
    rmSync(worktreePath, { recursive: true });
    await runGit(repoPath, ['worktree', 'add', worktreePath, 'in-worktree']);

    await expect(listLanded(['kept'])).resolves.toEqual({ leftover: false });
  });

  it('lists names with slashes, newest commit first, with the commit to restore from', async () => {
    await runGit(repoPath, ['switch', '-c', 'feature/older', 'main']);
    writeFileSync(join(repoPath, 'older.txt'), 'older\n');
    await runGit(repoPath, ['add', 'older.txt']);
    await execFileAsync('git', ['commit', '-m', 'older subject'], {
      cwd: repoPath,
      env: { ...process.env, GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' },
    });
    const olderCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['switch', 'main']);
    await branchWithCommits('feature/newer', ['newer.txt']);

    const service = await loadService();
    const branches = await service.listLeftoverBranches(repoPath, 'main', new Set());

    expect(branches.map((branch) => branch.name)).toEqual(['feature/newer', 'feature/older']);
    expect(branches[1]).toEqual({
      name: 'feature/older',
      commit: olderCommit,
      subject: 'older subject',
      lastCommitAt: Date.parse('2001-01-01T00:00:00Z'),
      landed: false,
    });
  });

  it('treats branch names that differ only in case from a kept one as kept', async () => {
    const commit = await branchWithCommits('Feature', ['feature.txt']);

    await expect(listLanded(['feature'])).resolves.toEqual({});
    const service = await loadService();
    await expect(
      service.deleteBranches(repoPath, [{ name: 'Feature', commit }], new Set(['feature']))
    ).resolves.toEqual({
      deleted: [],
      failed: [{ name: 'Feature', message: 'The branch is in use.' }],
    });
  });

  it("leaves a bare repository's HEAD branch alone, which git itself would delete", async () => {
    const barePath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-bare-'));
    tempPaths.push(barePath);
    await branchWithCommits('develop', ['develop.txt']);
    await execFileAsync('git', ['clone', '--quiet', '--bare', repoPath, barePath]);
    await runGit(barePath, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    const commit = await runGit(barePath, ['rev-parse', 'develop']);
    const service = await loadService();

    await expect(service.listLeftoverBranches(barePath, 'main', new Set())).resolves.toEqual([]);
    await expect(
      service.deleteBranches(barePath, [{ name: 'develop', commit }], new Set())
    ).resolves.toEqual({
      deleted: [],
      failed: [{ name: 'develop', message: 'The branch is in use.' }],
    });
  });

  it('deletes only exact branch names, not revisions that resolve to one', async () => {
    const commit = await branchWithCommits('feature', ['feature.txt']);
    const service = await loadService();

    const result = await service.deleteBranches(
      repoPath,
      [
        { name: 'feature~0', commit },
        { name: 'feature^{commit}', commit },
      ],
      new Set()
    );

    expect(result.deleted).toEqual([]);
    expect(result.failed.map((failure) => failure.message)).toEqual([
      'The branch no longer exists.',
      'The branch no longer exists.',
    ]);
    expect(await runGit(repoPath, ['rev-parse', 'feature'])).toBe(commit);
  });

  it('deletes listed branches, but not moved, kept, missing or checked-out ones', async () => {
    const leftover = await branchWithCommits('leftover', ['leftover.txt']);
    await runGit(repoPath, ['config', 'branch.leftover.remote', 'origin']);
    const moved = await branchWithCommits('moved', ['moved.txt']);
    const kept = await branchWithCommits('kept', ['kept.txt']);
    const checkedOut = await branchWithCommits('checked-out', ['checked-out.txt']);
    await runGit(repoPath, ['switch', 'moved']);
    await commitFile('moved-again.txt', 'more\n', 'more work');
    await runGit(repoPath, ['switch', 'main']);
    const worktreePath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-wt-'));
    tempPaths.push(worktreePath);
    rmSync(worktreePath, { recursive: true });
    await runGit(repoPath, ['worktree', 'add', worktreePath, 'checked-out']);

    const service = await loadService();
    const result = await service.deleteBranches(
      repoPath,
      [
        { name: 'leftover', commit: leftover },
        { name: 'moved', commit: moved },
        { name: 'kept', commit: kept },
        { name: 'missing', commit: leftover },
        { name: 'checked-out', commit: checkedOut },
      ],
      new Set(['kept'])
    );

    expect(result.deleted).toEqual(['leftover']);
    expect(result.failed.map((failure) => failure.name)).toEqual([
      'moved',
      'kept',
      'missing',
      'checked-out',
    ]);
    expect(result.failed.map((failure) => failure.message)).toEqual([
      'The branch has new commits.',
      'The branch is in use.',
      'The branch no longer exists.',
      'The branch is in use.',
    ]);
    const remaining = await runGit(repoPath, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    expect(remaining.split('\n').sort()).toEqual(['checked-out', 'kept', 'main', 'moved']);
    await expect(
      runGit(repoPath, ['config', '--get-regexp', '^branch\\.leftover\\.'])
    ).rejects.toThrow();
  });

  describe('checkWorktree', () => {
    async function addWorktree(branch: string): Promise<string> {
      const worktreePath = mkdtempSync(join(tmpdir(), 'komla-branch-cleanup-wt-'));
      tempPaths.push(worktreePath);
      rmSync(worktreePath, { recursive: true });
      await runGit(repoPath, ['worktree', 'add', worktreePath, branch]);
      return worktreePath;
    }

    it('counts a worktree as landed once its changes are in the target, squashed or not', async () => {
      await branchWithCommits('squashed', ['one.txt', 'two.txt']);
      await branchWithCommits('unmerged', ['three.txt']);
      await branchWithCommits('fresh', []);
      await runGit(repoPath, ['merge', '--squash', 'squashed']);
      await runGit(repoPath, ['commit', '-m', 'squash merge']);
      const service = await loadService();

      await expect(service.checkWorktree(await addWorktree('squashed'), 'main')).resolves.toEqual({
        landed: true,
        uncommittedChanges: false,
      });
      await expect(service.checkWorktree(await addWorktree('unmerged'), 'main')).resolves.toEqual({
        landed: false,
        uncommittedChanges: false,
      });
      await expect(service.checkWorktree(await addWorktree('fresh'), 'main')).resolves.toEqual({
        landed: true,
        uncommittedChanges: false,
      });
    });

    it('tells uncommitted changes apart, untracked files included', async () => {
      await branchWithCommits('edited', []);
      await branchWithCommits('untracked', []);
      const edited = await addWorktree('edited');
      const untracked = await addWorktree('untracked');
      writeFileSync(join(edited, 'readme.txt'), 'edited\n');
      writeFileSync(join(untracked, 'new.txt'), 'new\n');
      const service = await loadService();

      await expect(service.checkWorktree(edited, 'main')).resolves.toEqual({
        landed: true,
        uncommittedChanges: true,
      });
      await expect(service.checkWorktree(untracked, 'main')).resolves.toEqual({
        landed: true,
        uncommittedChanges: true,
      });
    });

    it('fails when the worktree is gone', async () => {
      await branchWithCommits('gone', []);
      const worktreePath = await addWorktree('gone');
      rmSync(worktreePath, { recursive: true, force: true });
      const service = await loadService();

      await expect(service.checkWorktree(worktreePath, 'main')).rejects.toThrow();
    });
  });
});
