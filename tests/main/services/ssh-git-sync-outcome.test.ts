import { execFileSync, spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitSyncOutcome, GitSyncResult } from '../../../src/shared/types/git-sync';
import type { SshWorkspaceBackend } from '../../../src/shared/types/workspace';

const { run, ensureInstalled } = vi.hoisted(() => ({ run: vi.fn(), ensureInstalled: vi.fn() }));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: { isRunning: () => false },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: { getHost: (id: string) => ({ id }), run },
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: { ensureInstalled },
}));

import { sshWorkspaceGit } from '../../../src/main/services/workspace-git/ssh-git';

// The scripts run in a real POSIX shell standing in for the SSH host, and Windows has none.
const itWithPosixShell = it.skipIf(process.platform === 'win32');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Komla Test',
  GIT_AUTHOR_EMAIL: 'komla@example.com',
  GIT_COMMITTER_NAME: 'Komla Test',
  GIT_COMMITTER_EMAIL: 'komla@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** The result every caller had before the outcome, and the outcome beside it. */
function expectResult(
  result: GitSyncResult,
  success: boolean,
  message: string,
  outcome: GitSyncOutcome
): void {
  expect({ success: result.success, message: result.message }).toEqual({ success, message });
  expect(result.outcome).toEqual(outcome);
}

const BACKEND: SshWorkspaceBackend = {
  kind: 'ssh',
  hostId: 'host-1',
  remoteDirectory: '/home/dev/.komla/worktrees/app/feature',
  remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
  remoteProjectRoot: '/home/dev/.komla/worktrees/app',
  gitUrl: '',
  projectName: 'app',
  branchName: 'feature',
  baseBranch: 'main',
};

describe('sshWorkspaceGit sync outcomes', () => {
  beforeEach(() => {
    run.mockReset();
    ensureInstalled.mockReset().mockRejectedValue(new Error('No companion on this host'));
  });

  describe.each([
    {
      method: 'mergeFrom',
      sync: () => sshWorkspaceGit.mergeFrom(BACKEND, 'main', { stash: true }),
      fallback: 'Merge failed',
    },
    {
      method: 'rebaseOnBranch',
      sync: () => sshWorkspaceGit.rebaseOnBranch(BACKEND, 'main', { stash: true }),
      fallback: 'Rebase failed',
    },
    { method: 'pull', sync: () => sshWorkspaceGit.pull(BACKEND), fallback: 'Pull failed' },
  ])('$method maps the status its script prints', ({ sync, fallback }) => {
    it.each<[string, boolean, string, GitSyncOutcome]>([
      ['status=success\nmessage=Done\n', true, 'Done', { kind: 'completed', upToDate: false }],
      [
        'status=success\nstash=\nmessage=Done\n',
        true,
        'Done',
        { kind: 'completed', upToDate: false },
      ],
      [
        'status=up-to-date\nstash=\nmessage=Already up to date\n',
        true,
        'Already up to date',
        { kind: 'completed', upToDate: true },
      ],
      [
        'status=success\nstash=abc123\nmessage=Done, but stash could not be re-applied cleanly - resolve conflicts manually\n',
        true,
        'Done, but stash could not be re-applied cleanly - resolve conflicts manually',
        { kind: 'completed-unrestored', recovery: { status: 'stored', stashSha: 'abc123' } },
      ],
      [
        'status=uncommitted\nmessage=Commit or stash changes before merging\n',
        false,
        'Commit or stash changes before merging',
        { kind: 'uncommitted-changes' },
      ],
      [
        'status=aborted\nstash=\nmessage=It was aborted.\n',
        false,
        'It was aborted.',
        { kind: 'aborted' },
      ],
      [
        'status=aborted\nstash=abc123\nmessage=It was aborted. Kept in git stash.\n',
        false,
        'It was aborted. Kept in git stash.',
        { kind: 'aborted', recovery: { status: 'stored', stashSha: 'abc123' } },
      ],
      [
        'status=abort-failed\nstash=abc123\nmessage=It is still active.\n',
        false,
        'It is still active.',
        {
          kind: 'abort-failed',
          operationState: 'active',
          recovery: { status: 'stored', stashSha: 'abc123' },
        },
      ],
      [
        'status=abort-failed\nstash=\nmessage=It is still active.\n',
        false,
        'It is still active.',
        { kind: 'abort-failed', operationState: 'active' },
      ],
      [
        'status=failed\nstash=\nmessage=fatal: bad revision\n',
        false,
        'fatal: bad revision',
        { kind: 'failed' },
      ],
      [
        'status=failed\nstash=abc123\nmessage=fatal: bad revision Kept in git stash.\n',
        false,
        'fatal: bad revision Kept in git stash.',
        { kind: 'failed', recovery: { status: 'stored', stashSha: 'abc123' } },
      ],
      // A script that ended without a status says nothing about what it left behind.
      ['', false, fallback, { kind: 'unverified' }],
    ])('%j', async (output, success, message, outcome) => {
      run.mockResolvedValue(output);

      expectResult(await sync(), success, message, outcome);
    });

    it('is unverified when the host does not answer', async () => {
      run.mockRejectedValue(new Error('Connection closed'));

      expectResult(await sync(), false, 'Connection closed', { kind: 'unverified' });
    });
  });

  it('reads the files a pull left in conflict', async () => {
    run.mockResolvedValue('status=conflicted\nmessage=a.txt\nb.txt\n');

    expectResult(
      await sshWorkspaceGit.pull(BACKEND),
      false,
      'Pull paused because 2 files have conflicts: a.txt, b.txt. Resolve the conflicts in this workspace, then complete the merge.',
      { kind: 'conflicts', files: ['a.txt', 'b.txt'] }
    );
  });

  describe('on a host', () => {
    let root: string;
    let repoPath: string;
    let backend: SshWorkspaceBackend;
    let hostPath: string | undefined;

    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, ...GIT_ENV },
      }).trim();

    function commit(file: string, content: string, message: string): void {
      writeFileSync(join(repoPath, file), content);
      git('add', file);
      git('commit', '--quiet', '-m', message);
    }

    /** The host's shell, here this computer's. */
    function hostShell(_host: unknown, command: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const shell = spawn('sh', ['-c', command], {
          env: { ...process.env, ...GIT_ENV, ...(hostPath ? { PATH: hostPath } : {}) },
        });
        let output = '';
        let errors = '';
        shell.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
        shell.stderr.on('data', (data: Buffer) => (errors += data.toString('utf8')));
        shell.on('error', reject);
        shell.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
      });
    }

    /** Puts a `git` ahead on the host's PATH that fails to abort the operation. */
    function failAborts(operation: 'merge' | 'rebase'): void {
      const binPath = join(root, 'bin');
      const gitPath = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      mkdirSync(binPath);
      writeFileSync(
        join(binPath, 'git'),
        `#!/bin/sh\nif [ "$1" = ${operation} ] && [ "$2" = --abort ]; then exit 1; fi\nexec ${gitPath} "$@"\n`
      );
      chmodSync(join(binPath, 'git'), 0o755);
      hostPath = `${binPath}${delimiter}${process.env.PATH}`;
    }

    /** `main` and `feature` each change shared.txt, so bringing one into the other conflicts. */
    function divergeOnSharedFile(): void {
      commit('shared.txt', 'feature\n', 'feature change');
      git('switch', '--quiet', 'main');
      commit('shared.txt', 'main\n', 'main change');
      git('switch', '--quiet', 'feature');
    }

    /** Only `main` changes shared.txt, so `feature` takes it cleanly. */
    function advanceMain(): void {
      commit('feature.txt', 'feature\n', 'feature change');
      git('switch', '--quiet', 'main');
      commit('shared.txt', 'main\n', 'main change');
      git('switch', '--quiet', 'feature');
    }

    const savedStashSha = () => git('rev-parse', 'refs/stash');

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'komla-ssh-git-sync-outcome-'));
      repoPath = join(root, 'repo');
      mkdirSync(repoPath);
      hostPath = undefined;
      git('init', '--quiet', '--initial-branch=main');
      commit('shared.txt', 'base\n', 'base');
      git('switch', '--quiet', '-c', 'feature');
      run.mockImplementation(hostShell);
      backend = { ...BACKEND, remoteDirectory: repoPath, remoteRepoPath: repoPath };
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    describe.each([
      {
        method: 'mergeFrom',
        operation: 'merge',
        sync: (options?: { stash?: boolean }) =>
          sshWorkspaceGit.mergeFrom(backend, 'main', options),
        blocked: 'merging',
        completed: 'Merged main successfully',
        conflicted: 'Merge from main encountered conflicts in shared.txt',
        aborted: 'The merge was aborted.',
        stillActive:
          'Git could not abort the merge. The merge is still active; resolve or abort it manually.',
      },
      {
        method: 'rebaseOnBranch',
        operation: 'rebase',
        sync: (options?: { stash?: boolean }) =>
          sshWorkspaceGit.rebaseOnBranch(backend, 'main', options),
        blocked: 'rebasing',
        completed: 'Rebased on main successfully',
        conflicted: 'Rebase onto main encountered conflicts in shared.txt',
        aborted: 'The rebase was aborted.',
        stillActive:
          'Git could not abort the rebase. The rebase is still active; resolve or abort it manually.',
      },
    ] as const)('$method', (op) => {
      itWithPosixShell('is blocked by uncommitted changes it was not asked to save', async () => {
        advanceMain();
        writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted\n');

        expectResult(await op.sync(), false, `Commit or stash changes before ${op.blocked}`, {
          kind: 'uncommitted-changes',
        });
      });

      itWithPosixShell('completes and puts saved changes back', async () => {
        advanceMain();
        writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted\n');

        expectResult(await op.sync({ stash: true }), true, op.completed, {
          kind: 'completed',
          upToDate: false,
        });
        expect(existsSync(join(repoPath, 'dirty.txt'))).toBe(true);
        expect(git('stash', 'list')).toBe('');
      });

      itWithPosixShell('completes with nothing to bring in', async () => {
        expectResult(await op.sync(), true, 'Already up to date', {
          kind: 'completed',
          upToDate: true,
        });
      });

      itWithPosixShell('completes but keeps saved changes it cannot put back', async () => {
        advanceMain();
        writeFileSync(join(repoPath, 'shared.txt'), 'uncommitted\n');

        const result = await op.sync({ stash: true });

        expectResult(
          result,
          true,
          `${op.completed}, but stash could not be re-applied cleanly - resolve conflicts manually`,
          {
            kind: 'completed-unrestored',
            recovery: { status: 'stored', stashSha: savedStashSha() },
          }
        );
      });

      itWithPosixShell('aborts on conflicts', async () => {
        divergeOnSharedFile();

        expectResult(await op.sync(), false, `${op.conflicted}. ${op.aborted}`, {
          kind: 'aborted',
        });
        expect(git('status', '--porcelain')).toBe('');
      });

      itWithPosixShell('aborts on conflicts and puts saved changes back', async () => {
        divergeOnSharedFile();
        writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted\n');

        expectResult(await op.sync({ stash: true }), false, `${op.conflicted}. ${op.aborted}`, {
          kind: 'aborted',
        });
        expect(existsSync(join(repoPath, 'dirty.txt'))).toBe(true);
      });

      itWithPosixShell('stays active, with saved changes kept, when the abort fails', async () => {
        divergeOnSharedFile();
        writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted\n');
        failAborts(op.operation);

        const result = await op.sync({ stash: true });

        expectResult(result, false, `${op.conflicted}, and ${op.stillActive}`, {
          kind: 'abort-failed',
          operationState: 'active',
          recovery: { status: 'stored', stashSha: savedStashSha() },
        });
        expect(existsSync(join(repoPath, 'dirty.txt'))).toBe(false);
      });

      itWithPosixShell('fails with nothing left active', async () => {
        const result = await (op.method === 'mergeFrom'
          ? sshWorkspaceGit.mergeFrom(backend, 'missing')
          : sshWorkspaceGit.rebaseOnBranch(backend, 'missing'));

        expect(result.success).toBe(false);
        expect(result.message).toContain('missing');
        expect(result.outcome).toEqual({ kind: 'failed' });
      });
    });

    itWithPosixShell('refuses to rebase onto the current branch', async () => {
      expectResult(
        await sshWorkspaceGit.rebaseOnBranch(backend, 'feature'),
        false,
        'Cannot rebase onto the current branch',
        { kind: 'failed' }
      );
    });

    describe('pull', () => {
      let originPath: string;

      /** Publishes `feature`, then gives origin's copy a commit this workspace lacks. */
      function advanceOrigin(file: string): void {
        originPath = join(root, 'origin.git');
        execFileSync('git', ['clone', '--quiet', '--bare', repoPath, originPath], {
          stdio: 'pipe',
        });
        git('remote', 'add', 'origin', originPath);
        git('fetch', '--quiet', 'origin');
        const otherPath = join(root, 'other');
        execFileSync('git', ['clone', '--quiet', '--branch', 'feature', originPath, otherPath], {
          stdio: 'pipe',
        });
        const other = (...args: string[]) =>
          execFileSync('git', ['-C', otherPath, ...args], {
            stdio: 'pipe',
            env: { ...process.env, ...GIT_ENV },
          });
        writeFileSync(join(otherPath, file), 'origin\n');
        other('add', file);
        other('commit', '--quiet', '-m', 'origin change');
        other('push', '--quiet', 'origin', 'feature');
      }

      itWithPosixShell('is blocked by uncommitted changes', async () => {
        writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted\n');

        expectResult(
          await sshWorkspaceGit.pull(backend),
          false,
          'Commit or stash changes before pulling',
          { kind: 'uncommitted-changes' }
        );
      });

      itWithPosixShell('is refused without a branch on origin', async () => {
        expectResult(
          await sshWorkspaceGit.pull(backend),
          false,
          'No remote tracking branch configured',
          { kind: 'failed' }
        );
      });

      itWithPosixShell('completes', async () => {
        advanceOrigin('origin.txt');

        expectResult(await sshWorkspaceGit.pull(backend), true, 'Pulled from origin', {
          kind: 'completed',
          upToDate: false,
        });
        expectResult(await sshWorkspaceGit.pull(backend), true, 'Already up to date', {
          kind: 'completed',
          upToDate: true,
        });
      });

      itWithPosixShell('leaves conflicts active', async () => {
        advanceOrigin('shared.txt');
        commit('shared.txt', 'feature\n', 'feature change');

        expectResult(
          await sshWorkspaceGit.pull(backend),
          false,
          'Pull paused because shared.txt has conflicts. Resolve the conflicts in this workspace, then complete the merge.',
          { kind: 'conflicts', files: ['shared.txt'] }
        );
        expect(git('status', '--porcelain')).toContain('UU shared.txt');
      });
    });
  });
});
