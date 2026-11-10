import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitSyncOutcome, GitSyncResult } from '../../../../src/shared/types/git-sync';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
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

const STASH_SHA = 'abc123';
const STORED = { status: 'stored', stashSha: STASH_SHA } as const;
const STORE_FAILED = { status: 'store-failed', stashSha: STASH_SHA } as const;

const RECOVERY_STORED =
  'but your saved local changes could not be restored cleanly. Resolve the current conflicts before continuing; a recovery copy was saved in git stash.';
const RECOVERY_STORE_FAILED = `but your saved local changes could not be restored cleanly, and Git could not save a recovery copy in git stash. The temporary recovery commit is ${STASH_SHA}. Preserve and restore that commit before Git prunes it.`;
const NOT_REAPPLIED_STORED =
  'Your saved local changes were not reapplied; a recovery copy was saved in git stash.';
const NOT_REAPPLIED_STORE_FAILED = `Git also could not save a recovery copy in git stash. The temporary recovery commit is ${STASH_SHA}; preserve it before Git prunes it.`;

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

describe('git sync outcomes', () => {
  let stateRoot: string;

  beforeEach(() => {
    vi.resetModules();
    stateRoot = mkdtempSync(path.join(os.tmpdir(), 'komla-sync-outcome-'));
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function setup() {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    const execSpy = vi.spyOn(gitExec, 'execGitAsync');
    const execGitWithProgressSpy = vi.spyOn(gitExec, 'execGitWithProgress');
    const hasUncommittedChangesSpy = vi.spyOn(gitExec, 'hasUncommittedChanges');
    const getCurrentBranchSpy = vi.spyOn(gitExec, 'getCurrentBranch').mockResolvedValue('feature');
    const getTargetBranchSpy = vi.spyOn(gitExec, 'getTargetBranch').mockResolvedValue('main');
    const hasRemoteTrackingBranchSpy = vi.spyOn(gitExec, 'hasRemoteTrackingBranch');
    vi.spyOn(gitExec, 'getCheckedOutBranch').mockResolvedValue('feature');
    vi.spyOn(gitBranchService, 'syncBranchWithRemote').mockResolvedValue('current');
    return {
      gitBranchService,
      execSpy,
      execGitWithProgressSpy,
      hasUncommittedChangesSpy,
      getCurrentBranchSpy,
      getTargetBranchSpy,
      hasRemoteTrackingBranchSpy,
    };
  }

  type Service = Awaited<ReturnType<typeof setup>>['gitBranchService'];

  /** What `rev-parse --git-path` prints for an operation Git left active, or one it did not. */
  function gitPaths(operation: 'merge' | 'rebase', state: 'active' | 'inactive'): string {
    const dir = path.join(stateRoot, state);
    if (operation === 'merge') {
      const mergeHead = path.join(dir, 'MERGE_HEAD');
      if (state === 'active') {
        mkdirSync(dir, { recursive: true });
        writeFileSync(mergeHead, 'merge-head-sha\n');
      }
      return mergeHead;
    }
    const rebaseMerge = path.join(dir, 'rebase-merge');
    if (state === 'active') mkdirSync(rebaseMerge, { recursive: true });
    const rebaseApply = path.join(dir, 'rebase-apply');
    return [rebaseMerge, rebaseApply, path.join(rebaseApply, 'applying')].join('\n');
  }

  describe.each([
    {
      method: 'mergeFrom',
      operation: 'merge',
      run: (service: Service, options?: { stash?: boolean }) =>
        service.mergeFrom('/repo', 'main', options),
      name: 'Merge',
      label: 'Merge',
      blocked: 'merging',
      completed: 'Merged main',
      completion: 'complete the merge',
      upToDateOutput: 'Already up to date.',
    },
    {
      method: 'rebaseOnTargetBranch',
      operation: 'rebase',
      run: (service: Service, options?: { stash?: boolean }) =>
        service.rebaseOnTargetBranch('/repo', options),
      name: 'Rebase',
      label: 'Rebase onto main',
      blocked: 'rebasing',
      completed: 'Rebased on main',
      completion: 'continue the rebase',
      upToDateOutput: 'Current branch feature is up to date.',
    },
    {
      method: 'rebaseOnBranch',
      operation: 'rebase',
      run: (service: Service, options?: { stash?: boolean }) =>
        service.rebaseOnBranch('/repo', 'main', options),
      name: 'Rebase',
      label: 'Rebase onto main',
      blocked: 'rebasing',
      completed: 'Rebased on main',
      completion: 'continue the rebase',
      upToDateOutput: 'Current branch feature is up to date.',
    },
  ] as const)('$method', (op) => {
    const lower = op.name.toLowerCase();

    it('is blocked by uncommitted changes it was not asked to save', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);

      const result = await op.run(gitBranchService);

      expectResult(result, false, `Commit or stash changes before ${op.blocked}`, {
        kind: 'uncommitted-changes',
      });
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('completes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValueOnce('Done.');

      const result = await op.run(gitBranchService);

      expectResult(result, true, `${op.completed} successfully`, {
        kind: 'completed',
        upToDate: false,
      });
    });

    it('completes with nothing to bring in', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValueOnce(op.upToDateOutput);

      const result = await op.run(gitBranchService);

      expectResult(result, true, 'Already up to date', { kind: 'completed', upToDate: true });
    });

    it('completes and puts saved changes back', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Done.') // merge or rebase
        .mockResolvedValueOnce(''); // stash apply

      const result = await op.run(gitBranchService, { stash: true });

      expectResult(result, true, `${op.completed} successfully`, {
        kind: 'completed',
        upToDate: false,
      });
    });

    it.each([
      ['a recovery copy in git stash', true, RECOVERY_STORED, STORED],
      ['only the recovery commit', false, RECOVERY_STORE_FAILED, STORE_FAILED],
    ] as const)(
      'completes but leaves saved changes as %s',
      async (_name, stored, recoveryMessage, recovery) => {
        const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
        hasUncommittedChangesSpy.mockResolvedValue(true);
        execSpy
          .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
          .mockResolvedValueOnce('') // reset --hard HEAD
          .mockResolvedValueOnce('Done.') // merge or rebase
          .mockRejectedValueOnce(new Error('conflict in stash')); // stash apply
        if (stored) execSpy.mockResolvedValueOnce('');
        else execSpy.mockRejectedValueOnce(new Error('cannot lock refs/stash'));

        const result = await op.run(gitBranchService, { stash: true });

        expectResult(result, false, `${op.completed}, ${recoveryMessage}`, {
          kind: 'completed-unrestored',
          recovery,
        });
      }
    );

    it('leaves conflicts active when it saved no changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('conflict')) // merge or rebase
        .mockResolvedValueOnce('UU file.txt\nAU added-by-us.txt\n'); // status

      const result = await op.run(gitBranchService);

      expectResult(
        result,
        false,
        `${op.label} paused because 2 files have conflicts: file.txt, added-by-us.txt. Resolve the conflicts in this workspace, then ${op.completion}.`,
        { kind: 'conflicts', files: ['file.txt', 'added-by-us.txt'] }
      );
      expect(execSpy).not.toHaveBeenCalledWith('/repo', [op.operation, '--abort']);
    });

    it('is unverified when the workspace cannot be inspected after it failed', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('it failed')) // merge or rebase
        .mockRejectedValueOnce(new Error('cannot read index')); // status

      const result = await op.run(gitBranchService);

      expectResult(
        result,
        false,
        'it failed. Komla could not verify whether Git left an operation active in /repo: cannot read index. Inspect the workspace before continuing.',
        { kind: 'unverified' }
      );
    });

    it('fails with nothing left active', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('fatal: bad revision')) // merge or rebase
        .mockResolvedValueOnce(''); // status

      const result = await op.run(gitBranchService);

      expectResult(result, false, 'fatal: bad revision', { kind: 'failed' });
    });

    it('fails when Git cannot be asked about the workspace at all', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockRejectedValue('not an Error');

      const result = await op.run(gitBranchService);

      expectResult(result, false, `${op.name} failed`, { kind: 'failed' });
    });

    it('aborts and puts saved changes back', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // merge or rebase
        .mockResolvedValueOnce('') // --abort
        .mockResolvedValueOnce(''); // stash apply

      const result = await op.run(gitBranchService, { stash: true });

      expectResult(
        result,
        false,
        `${op.name} failed and was aborted. The branch and saved local changes were restored.`,
        { kind: 'aborted' }
      );
    });

    it.each([
      ['a recovery copy in git stash', true, RECOVERY_STORED, STORED],
      ['only the recovery commit', false, RECOVERY_STORE_FAILED, STORE_FAILED],
    ] as const)(
      'aborts but leaves saved changes as %s',
      async (_name, stored, recoveryMessage, recovery) => {
        const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
        hasUncommittedChangesSpy.mockResolvedValue(true);
        execSpy
          .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
          .mockResolvedValueOnce('') // reset --hard HEAD
          .mockRejectedValueOnce(new Error('conflict')) // merge or rebase
          .mockResolvedValueOnce('') // --abort
          .mockRejectedValueOnce(new Error('apply conflict')); // stash apply
        if (stored) execSpy.mockResolvedValueOnce('');
        else execSpy.mockRejectedValueOnce(new Error('cannot lock refs/stash'));

        const result = await op.run(gitBranchService, { stash: true });

        expectResult(result, false, `${op.name} was aborted, ${recoveryMessage}`, {
          kind: 'aborted',
          recovery,
        });
      }
    );

    it.each([
      ['a recovery copy in git stash', true, NOT_REAPPLIED_STORED, STORED],
      ['only the recovery commit', false, NOT_REAPPLIED_STORE_FAILED, STORE_FAILED],
    ] as const)(
      'stays active when the abort fails, with saved changes as %s',
      async (_name, stored, recoveryMessage, recovery) => {
        const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
        hasUncommittedChangesSpy.mockResolvedValue(true);
        execSpy
          .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
          .mockResolvedValueOnce('') // reset --hard HEAD
          .mockRejectedValueOnce(new Error('conflict')) // merge or rebase
          .mockRejectedValueOnce(new Error('index.lock exists')) // --abort
          .mockResolvedValueOnce(gitPaths(op.operation, 'active')); // rev-parse --git-path
        if (stored) execSpy.mockResolvedValueOnce('');
        else execSpy.mockRejectedValueOnce(new Error('cannot lock refs/stash'));

        const result = await op.run(gitBranchService, { stash: true });

        expectResult(
          result,
          false,
          `${op.name} encountered conflicts and could not be aborted. The conflicted operation is still active. ${recoveryMessage} Inspect the workspace, resolve or abort the operation, and restore the saved changes.`,
          { kind: 'abort-failed', operationState: 'active', recovery }
        );
        expect(execSpy).not.toHaveBeenCalledWith('/repo', ['stash', 'apply', STASH_SHA]);
      }
    );

    it('may still be active when the abort fails and its state cannot be read', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // merge or rebase
        .mockRejectedValueOnce(new Error('index.lock exists')) // --abort
        .mockRejectedValueOnce(new Error('cannot resolve git path')) // rev-parse --git-path
        .mockResolvedValueOnce(''); // stash store

      const result = await op.run(gitBranchService, { stash: true });

      expectResult(
        result,
        false,
        `${op.name} could not be aborted, and Komla could not verify whether the ${lower} is still active. ${NOT_REAPPLIED_STORED} Inspect the workspace, resolve or abort any active operation, and restore the saved changes.`,
        { kind: 'abort-failed', operationState: 'unknown', recovery: STORED }
      );
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['stash', 'apply', STASH_SHA]);
    });

    it('fails and puts saved changes back when it never started', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('fatal: bad revision')) // merge or rebase
        .mockRejectedValueOnce(new Error('nothing to abort')) // --abort
        .mockResolvedValueOnce(gitPaths(op.operation, 'inactive')) // rev-parse --git-path
        .mockResolvedValueOnce(''); // stash apply

      const result = await op.run(gitBranchService, { stash: true });

      expectResult(result, false, 'fatal: bad revision. Your saved local changes were restored.', {
        kind: 'failed',
      });
    });

    it.each([
      ['a recovery copy in git stash', true, RECOVERY_STORED, STORED],
      ['only the recovery commit', false, RECOVERY_STORE_FAILED, STORE_FAILED],
    ] as const)(
      'fails when it never started, leaving saved changes as %s',
      async (_name, stored, recoveryMessage, recovery) => {
        const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
        hasUncommittedChangesSpy.mockResolvedValue(true);
        execSpy
          .mockResolvedValueOnce(`${STASH_SHA}\n`) // stash create
          .mockResolvedValueOnce('') // reset --hard HEAD
          .mockRejectedValueOnce(new Error('fatal: bad revision')) // merge or rebase
          .mockRejectedValueOnce(new Error('nothing to abort')) // --abort
          .mockResolvedValueOnce(gitPaths(op.operation, 'inactive')) // rev-parse --git-path
          .mockRejectedValueOnce(new Error('apply conflict')); // stash apply
        if (stored) execSpy.mockResolvedValueOnce('');
        else execSpy.mockRejectedValueOnce(new Error('cannot lock refs/stash'));

        const result = await op.run(gitBranchService, { stash: true });

        expectResult(
          result,
          false,
          `fatal: bad revision. The ${lower} did not start, ${recoveryMessage}`,
          { kind: 'failed', recovery }
        );
      }
    );
  });

  describe('rebaseOnBranch', () => {
    it('is refused onto the current branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);

      const result = await gitBranchService.rebaseOnBranch('/repo', 'feature');

      expectResult(result, false, 'Cannot rebase onto the current branch', { kind: 'failed' });
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('reports uncommitted changes ahead of the current branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);

      const result = await gitBranchService.rebaseOnBranch('/repo', 'feature');

      expectResult(result, false, 'Commit or stash changes before rebasing', {
        kind: 'uncommitted-changes',
      });
    });
  });

  describe('pull', () => {
    it('is blocked by uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);

      const result = await gitBranchService.pull('/repo');

      expectResult(result, false, 'Commit or stash changes before pulling', {
        kind: 'uncommitted-changes',
      });
    });

    it('is refused without a remote tracking branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('no branch.feature.merge'))
        .mockRejectedValueOnce(new Error('no origin/feature'));

      const result = await gitBranchService.pull('/repo');

      expectResult(result, false, 'No remote tracking branch configured', { kind: 'failed' });
    });

    it.each([
      ['Already up to date.', 'Already up to date', true],
      ['Updating 1a2b3c4..5d6e7f8', 'Pulled changes successfully', false],
    ])('completes when Git prints %s', async (output, message, upToDate) => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValueOnce('refs/heads/feature');
      execGitWithProgressSpy.mockResolvedValue(output);

      const result = await gitBranchService.pull('/repo');

      expectResult(result, true, message, { kind: 'completed', upToDate });
    });

    it('leaves conflicts active', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValueOnce('refs/heads/feature').mockResolvedValueOnce('UU file.txt\n');
      execGitWithProgressSpy.mockRejectedValue(new Error('Merge conflict'));

      const result = await gitBranchService.pull('/repo');

      expectResult(
        result,
        false,
        'Pull paused because file.txt has conflicts. Resolve the conflicts in this workspace, then complete the merge.',
        { kind: 'conflicts', files: ['file.txt'] }
      );
    });

    it('is unverified when the workspace cannot be inspected after it failed', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockResolvedValueOnce('refs/heads/feature')
        .mockRejectedValueOnce(new Error('cannot read index'));
      execGitWithProgressSpy.mockRejectedValue(new Error('it failed'));

      const result = await gitBranchService.pull('/repo');

      expectResult(
        result,
        false,
        'it failed. Komla could not verify whether Git left an operation active in /repo: cannot read index. Inspect the workspace before continuing.',
        { kind: 'unverified' }
      );
    });

    it('fails with nothing left active', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValueOnce('refs/heads/feature').mockResolvedValueOnce('');
      execGitWithProgressSpy.mockRejectedValue(new Error('fatal: unable to access origin'));

      const result = await gitBranchService.pull('/repo');

      expectResult(result, false, 'fatal: unable to access origin', { kind: 'failed' });
    });
  });

  describe('pullRebase', () => {
    it('is blocked by uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(result, false, 'Commit or stash changes before pulling', {
        kind: 'uncommitted-changes',
      });
    });

    it('is refused on the target branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('main');

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(
        result,
        false,
        'Pull (rebase) is not allowed on main; use the main pull flow instead',
        { kind: 'failed' }
      );
    });

    it('is refused without a remote tracking branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, hasRemoteTrackingBranchSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(false);

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(result, false, 'No remote tracking branch configured', { kind: 'failed' });
    });

    it('is refused without an upstream or a ref on origin', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, hasRemoteTrackingBranchSpy, execSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockRejectedValueOnce(new Error('no origin/feature'));

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(result, false, 'No upstream tracking branch configured', { kind: 'failed' });
    });

    it.each([
      ['Already up to date.', 'Already up to date', true],
      ['Current branch feature is up to date.', 'Already up to date', true],
      ['Successfully rebased and updated refs/heads/feature.', 'Rebased on remote changes', false],
    ])('completes when Git prints %s', async (output, message, upToDate) => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        hasRemoteTrackingBranchSpy,
        execSpy,
        execGitWithProgressSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy.mockResolvedValueOnce('origin/feature');
      execGitWithProgressSpy.mockResolvedValue(output);

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(result, true, message, { kind: 'completed', upToDate });
    });

    it('leaves conflicts active', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        hasRemoteTrackingBranchSpy,
        execSpy,
        execGitWithProgressSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy.mockResolvedValueOnce('origin/feature').mockResolvedValueOnce('UD gone.ts\n');
      execGitWithProgressSpy.mockRejectedValue(new Error('Rebase conflict'));

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(
        result,
        false,
        'Pull with rebase paused because gone.ts has conflicts. Resolve the conflicts in this workspace, then continue the rebase.',
        { kind: 'conflicts', files: ['gone.ts'] }
      );
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['rebase', '--abort']);
    });

    it('is unverified when the workspace cannot be inspected after it failed', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        hasRemoteTrackingBranchSpy,
        execSpy,
        execGitWithProgressSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('origin/feature')
        .mockRejectedValueOnce(new Error('cannot read index'));
      execGitWithProgressSpy.mockRejectedValue(new Error('it failed'));

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(
        result,
        false,
        'it failed. Komla could not verify whether Git left an operation active in /repo: cannot read index. Inspect the workspace before continuing.',
        { kind: 'unverified' }
      );
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['rebase', '--abort']);
    });

    it('fails and clears any rebase Git left behind', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        hasRemoteTrackingBranchSpy,
        execSpy,
        execGitWithProgressSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('origin/feature')
        .mockResolvedValueOnce('') // status
        .mockRejectedValueOnce(new Error('No rebase in progress')); // rebase --abort
      execGitWithProgressSpy.mockRejectedValue(new Error('fatal: unable to access origin'));

      const result = await gitBranchService.pullRebase('/repo');

      expectResult(result, false, 'fatal: unable to access origin', { kind: 'failed' });
      expect(execSpy).toHaveBeenLastCalledWith('/repo', ['rebase', '--abort']);
    });
  });
});
