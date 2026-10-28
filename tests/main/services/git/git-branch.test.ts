import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('GitBranchService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setup() {
    const gitExecMod = await import('../../../../src/main/services/git/git-exec');
    const gitWorktreeMod = await import('../../../../src/main/services/git/git-worktree');
    const execSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsync');
    const getCurrentBranchSpy = vi.spyOn(gitExecMod.gitExec, 'getCurrentBranch');
    const getTargetBranchSpy = vi.spyOn(gitExecMod.gitExec, 'getTargetBranch');
    const hasUncommittedChangesSpy = vi.spyOn(gitExecMod.gitExec, 'hasUncommittedChanges');
    const invalidateCacheSpy = vi.spyOn(gitExecMod.gitExec, 'invalidateCache');
    const hasRemoteTrackingBranchSpy = vi.spyOn(gitExecMod.gitExec, 'hasRemoteTrackingBranch');
    const getUnpushedCommitsSpy = vi.spyOn(gitExecMod.gitExec, 'getUnpushedCommits');
    const getCommitsBehindRemoteSpy = vi.spyOn(gitExecMod.gitExec, 'getCommitsBehindRemote');
    const execGitWithProgressSpy = vi.spyOn(gitExecMod.gitExec, 'execGitWithProgress');
    const getAheadBehindSpy = vi.spyOn(gitExecMod.gitExec, 'getAheadBehind');
    const hasRemoteSpy = vi.spyOn(gitExecMod.gitExec, 'hasRemote');
    const getMainBranchSpy = vi.spyOn(gitExecMod.gitExec, 'getMainBranch');
    const listWorktreesSpy = vi.spyOn(gitWorktreeMod.gitWorktreeService, 'listWorktrees');
    const fastForwardBranchSpy = vi.spyOn(gitWorktreeMod.gitWorktreeService, 'fastForwardBranch');
    const { gitBranchService } = await import('../../../../src/main/services/git/git-branch');
    return {
      gitBranchService,
      execSpy,
      getCurrentBranchSpy,
      getTargetBranchSpy,
      hasUncommittedChangesSpy,
      invalidateCacheSpy,
      hasRemoteTrackingBranchSpy,
      getUnpushedCommitsSpy,
      getCommitsBehindRemoteSpy,
      execGitWithProgressSpy,
      getAheadBehindSpy,
      hasRemoteSpy,
      getMainBranchSpy,
      listWorktreesSpy,
      fastForwardBranchSpy,
      gitExec: gitExecMod.gitExec,
    };
  }

  // Rebases and merges first sync a local target branch with its fetched ref.
  async function setupBranchUpdate() {
    const ctx = await setup();
    ctx.getTargetBranchSpy.mockResolvedValue('main');
    const syncBranchWithRemoteSpy = vi
      .spyOn(ctx.gitBranchService, 'syncBranchWithRemote')
      .mockResolvedValue('current');
    return { ...ctx, syncBranchWithRemoteSpy };
  }

  describe('createBranch', () => {
    it('creates a branch without start point', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitBranchService.createBranch('/repo', 'feature');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['branch', '--', 'feature']);
    });

    it('creates a branch with start point', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitBranchService.createBranch('/repo', 'feature', 'main');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'branch',
        '--no-track',
        '--',
        'feature',
        'main',
      ]);
    });
  });

  describe('fastForwardBranchToRemoteIfSafe', () => {
    async function setupFastForward() {
      const ctx = await setup();
      ctx.fastForwardBranchSpy.mockResolvedValue({ status: 'fast-forwarded' });
      return ctx;
    }

    it('fast-forwards an unchecked-out branch from its fetched remote ref', async () => {
      const { gitBranchService, execSpy, getAheadBehindSpy, fastForwardBranchSpy } =
        await setupFastForward();
      execSpy.mockResolvedValueOnce('local-sha').mockResolvedValueOnce('remote-sha');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });
      const updated = await gitBranchService.fastForwardBranchToRemoteIfSafe('/repo', 'main');

      expect(updated).toBe(true);
      expect(getAheadBehindSpy).toHaveBeenCalledWith('/repo', 'local-sha', 'remote-sha');
      expect(fastForwardBranchSpy).toHaveBeenCalledWith('/repo', 'main', 'remote-sha');
    });

    it('does not report an update when Git refuses the fast-forward', async () => {
      const { gitBranchService, execSpy, getAheadBehindSpy, fastForwardBranchSpy } =
        await setupFastForward();
      execSpy.mockResolvedValueOnce('local-sha').mockResolvedValueOnce('remote-sha');
      fastForwardBranchSpy.mockRejectedValueOnce(new Error('! [rejected] (non-fast-forward)'));
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });

      await expect(gitBranchService.syncBranchWithRemote('/repo', 'main')).resolves.toBe('blocked');
    });

    it('leaves a checked-out branch unchanged even when its tracked status is clean', async () => {
      const {
        gitBranchService,
        execSpy,
        getAheadBehindSpy,
        hasUncommittedChangesSpy,
        fastForwardBranchSpy,
      } = await setupFastForward();
      execSpy.mockResolvedValueOnce('local-sha').mockResolvedValueOnce('remote-sha');
      fastForwardBranchSpy.mockResolvedValueOnce({
        status: 'checked-out',
        worktreePath: '/repo-main',
      });
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });

      const updated = await gitBranchService.fastForwardBranchToRemoteIfSafe('/repo', 'main');

      expect(updated).toBe(false);
      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(hasUncommittedChangesSpy).not.toHaveBeenCalled();
    });

    it('leaves an ahead or diverged branch unchanged', async () => {
      const { gitBranchService, execSpy, getAheadBehindSpy, fastForwardBranchSpy } =
        await setupFastForward();
      execSpy.mockResolvedValueOnce('local-sha').mockResolvedValueOnce('remote-sha');
      getAheadBehindSpy.mockResolvedValue({ ahead: 1, behind: 2 });

      const updated = await gitBranchService.fastForwardBranchToRemoteIfSafe('/repo', 'main');

      expect(updated).toBe(false);
      expect(fastForwardBranchSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent updates for the same branch', async () => {
      const { gitBranchService, execSpy, getAheadBehindSpy } = await setupFastForward();
      let releaseRefReads!: () => void;
      const refReadsReleased = new Promise<void>((resolve) => {
        releaseRefReads = resolve;
      });
      execSpy.mockImplementation(async (_path, args) => {
        if (args[0] === 'rev-parse') {
          await refReadsReleased;
          return args.includes('refs/heads/main') ? 'local-sha' : 'remote-sha';
        }
        return '';
      });
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });

      const first = gitBranchService.fastForwardBranchToRemoteIfSafe('/repo', 'main');
      const second = gitBranchService.fastForwardBranchToRemoteIfSafe('/repo', 'main');
      releaseRefReads();

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(getAheadBehindSpy).toHaveBeenCalledTimes(1);
    });

    it('reports a branch that only origin has', async () => {
      const { gitBranchService, execSpy, getAheadBehindSpy } = await setupFastForward();
      execSpy.mockImplementation(async (_repoPath, args) => {
        if (args.includes('refs/heads/develop')) throw new Error('Needed a single revision');
        return 'remote-sha';
      });

      await expect(gitBranchService.syncBranchWithRemote('/repo', 'develop')).resolves.toBe(
        'no-local'
      );
      expect(getAheadBehindSpy).not.toHaveBeenCalled();
    });
  });

  describe('listBranches', () => {
    it('returns local branches only by default', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy.mockResolvedValue('main\nfeature\n');
      const result = await gitBranchService.listBranches('/repo');
      expect(result).toEqual([
        { name: 'main', isRemoteOnly: false },
        { name: 'feature', isRemoteOnly: false },
      ]);
    });

    it('includes remote branches when requested', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy
        .mockResolvedValueOnce('main\n')
        .mockResolvedValueOnce('origin/main\nupstream/feature\n');
      const result = await gitBranchService.listBranches('/repo', true);
      expect(result).toEqual([
        { name: 'main', isRemoteOnly: false },
        { name: 'main', isRemoteOnly: true, remoteRef: 'origin/main' },
        { name: 'feature', isRemoteOnly: true, remoteRef: 'upstream/feature' },
      ]);
    });

    it('filters out HEAD from remote branches', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy.mockResolvedValueOnce('main\n').mockResolvedValueOnce('origin/HEAD\norigin/main\n');
      const result = await gitBranchService.listBranches('/repo', true);
      expect(result).toHaveLength(2);
      expect(result[1].name).toBe('main');
    });

    it('returns empty array on error', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('not a repo'));
      const result = await gitBranchService.listBranches('/repo');
      expect(result).toEqual([]);
    });

    it('returns only local branches when remote listing fails', async () => {
      const { gitBranchService, execSpy } = await setup();
      execSpy.mockResolvedValueOnce('main\n').mockRejectedValueOnce(new Error('no remote'));
      const result = await gitBranchService.listBranches('/repo', true);
      expect(result).toEqual([{ name: 'main', isRemoteOnly: false }]);
    });
  });

  describe('switchBranch', () => {
    it('refuses to switch with uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      const result = await gitBranchService.switchBranch('/repo', 'feature');
      expect(result).toEqual({
        success: false,
        message: 'Commit or stash changes before switching branches',
      });
    });

    it('returns success if already on target branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      const result = await gitBranchService.switchBranch('/repo', 'feature');
      expect(result).toEqual({ success: true, message: 'Already on branch feature' });
    });

    it('switches branch and invalidates cache', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        execSpy,
        invalidateCacheSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('');
      const result = await gitBranchService.switchBranch('/repo', 'feature');
      expect(result).toEqual({ success: true, message: 'Switched to branch feature' });
      expect(invalidateCacheSpy).toHaveBeenCalledWith('currentBranch:/repo');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });

    it('falls back to checkout if switch fails', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy, execSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('main');
      execSpy
        .mockRejectedValueOnce(new Error('switch not supported')) // git switch
        .mockResolvedValueOnce(''); // git checkout
      const result = await gitBranchService.switchBranch('/repo', 'feature');
      expect(result.success).toBe(true);
    });
  });

  describe('deleteBranch', () => {
    it('refuses to delete main', async () => {
      const { gitBranchService } = await setup();
      const result = await gitBranchService.deleteBranch('/repo', 'main');
      expect(result).toEqual({ success: false, message: 'Cannot delete main or master branch' });
    });

    it('refuses to delete master', async () => {
      const { gitBranchService } = await setup();
      const result = await gitBranchService.deleteBranch('/repo', 'master');
      expect(result).toEqual({ success: false, message: 'Cannot delete main or master branch' });
    });

    it('refuses to delete current branch', async () => {
      const { gitBranchService, getCurrentBranchSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      const result = await gitBranchService.deleteBranch('/repo', 'feature');
      expect(result).toEqual({
        success: false,
        message: 'Cannot delete the branch you are currently on',
      });
    });

    it('deletes branch with -d flag by default', async () => {
      const { gitBranchService, getCurrentBranchSpy, execSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('');
      const result = await gitBranchService.deleteBranch('/repo', 'feature');
      expect(result).toEqual({ success: true, message: 'Deleted branch feature' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['branch', '-d', 'feature']);
    });

    it('uses -D flag when force=true', async () => {
      const { gitBranchService, getCurrentBranchSpy, execSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('');
      await gitBranchService.deleteBranch('/repo', 'feature', true);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['branch', '-D', 'feature']);
    });

    it('suggests force delete for unmerged branches', async () => {
      const { gitBranchService, getCurrentBranchSpy, execSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      execSpy.mockRejectedValue({ stderr: 'error: The branch is not fully merged' });
      const result = await gitBranchService.deleteBranch('/repo', 'feature');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not fully merged');
    });
  });

  describe('deleteRemoteBranch', () => {
    it('refuses to delete remote main', async () => {
      const { gitBranchService } = await setup();
      const result = await gitBranchService.deleteRemoteBranch('/repo', 'main');
      expect(result).toEqual({ success: false, message: 'Cannot delete main or master branch' });
    });

    it('deletes remote branch using execGitWithProgress with askpass enabled', async () => {
      const { gitBranchService, execGitWithProgressSpy } = await setup();
      execGitWithProgressSpy.mockResolvedValue('');
      const result = await gitBranchService.deleteRemoteBranch('/repo', 'feature');
      expect(result).toEqual({ success: true, message: 'Deleted remote branch feature' });
      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo',
        ['push', 'origin', '--delete', 'feature'],
        undefined,
        { enableAskpass: true }
      );
    });
  });

  describe('mergeBranch', () => {
    it('throws if not on main branch', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      await expect(gitBranchService.mergeBranch('/repo', 'other')).rejects.toThrow(
        'Must be on main branch to merge'
      );
    });

    it('merges when on main branch', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy, execSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('');
      await gitBranchService.mergeBranch('/repo', 'feature');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['merge', 'feature']);
    });

    it('invalidates the dirty-state cache when leaving a merge conflict active', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        getTargetBranchSpy,
        execSpy,
        invalidateCacheSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockRejectedValueOnce(new Error('merge failed'))
        .mockResolvedValueOnce('UU file.txt\n');

      await expect(gitBranchService.mergeBranch('/repo', 'feature')).rejects.toThrow(
        'Merge paused'
      );

      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });
  });

  describe('mergeFrom', () => {
    it('merges a non-target branch without syncing it', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, syncBranchWithRemoteSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValue("Merge made by the 'ort' strategy.");

      await gitBranchService.mergeFrom('/repo', 'feature');

      expect(syncBranchWithRemoteSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalledWith('/repo', ['merge', 'feature']);
    });

    it('merges the fetched target when the local target cannot be fast-forwarded', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, syncBranchWithRemoteSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      syncBranchWithRemoteSpy.mockResolvedValue('blocked');
      execSpy.mockResolvedValue("Merge made by the 'ort' strategy.");

      const result = await gitBranchService.mergeFrom('/repo', 'main');

      expect(result).toEqual({ success: true, message: 'Merged main successfully' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['merge', 'origin/main']);
    });

    it('refuses with uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      const result = await gitBranchService.mergeFrom('/repo', 'feature');
      expect(result).toEqual({ success: false, message: 'Commit or stash changes before merging' });
    });

    it('reports already up to date', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockResolvedValue('Already up to date.');
      const result = await gitBranchService.mergeFrom('/repo', 'feature');
      expect(result).toEqual({ success: true, message: 'Already up to date' });
    });

    it('leaves merge conflicts active and lists all unmerged file states', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, invalidateCacheSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('merge failed')) // merge
        .mockResolvedValueOnce('UU file.txt\nAU added-by-us.txt\n'); // status
      const result = await gitBranchService.mergeFrom('/repo', 'feature');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Merge paused');
      expect(result.message).toContain('file.txt');
      expect(result.message).toContain('added-by-us.txt');
      expect(result.message).not.toContain('coding agent');
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['merge', '--abort']);
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });

    it('reports when conflict inspection fails after a merge error', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, invalidateCacheSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('merge failed'))
        .mockRejectedValueOnce(new Error('cannot read index'));

      const result = await gitBranchService.mergeFrom('/repo', 'feature');

      expect(result.success).toBe(false);
      expect(result.message).toContain('could not verify whether Git left an operation active');
      expect(result.message).toContain('cannot read index');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });

    it('stashes via create/apply when stash option is true and there are changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create → SHA
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce("Merge made by the 'ort' strategy.") // merge
        .mockResolvedValueOnce(''); // stash apply <sha>
      const result = await gitBranchService.mergeFrom('/repo', 'feature', { stash: true });
      expect(result).toEqual({ success: true, message: 'Merged feature successfully' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'create']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['reset', '--hard', 'HEAD']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('reports partial success when stash apply fails after merge', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Merge made') // merge succeeds
        .mockRejectedValueOnce(new Error('conflict in stash')) // stash apply fails
        .mockResolvedValueOnce(''); // stash store (recovery)
      const result = await gitBranchService.mergeFrom('/repo', 'feature', { stash: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('saved local changes');
      expect(result.message).toContain('recovery copy');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'stash',
        'store',
        '-m',
        'komla-auto-stash-before-merge',
        'abc123',
      ]);
    });

    it('aborts merge and re-applies stash when merge fails with stash option', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // merge fails
        .mockResolvedValueOnce('') // merge --abort
        .mockResolvedValueOnce(''); // stash apply <sha>
      const result = await gitBranchService.mergeFrom('/repo', 'feature', { stash: true });
      expect(result).toEqual({
        success: false,
        message: 'Merge failed and was aborted. The branch and saved local changes were restored.',
      });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['merge', '--abort']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('does not re-apply saved changes when aborting the merge fails', async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'komla-merge-state-'));
      const mergeHeadPath = path.join(tempRoot, 'MERGE_HEAD');
      writeFileSync(mergeHeadPath, 'merge-head-sha\n');
      try {
        const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
        hasUncommittedChangesSpy.mockResolvedValue(true);
        execSpy
          .mockResolvedValueOnce('abc123\n') // stash create
          .mockResolvedValueOnce('') // reset --hard HEAD
          .mockRejectedValueOnce(new Error('conflict')) // merge fails
          .mockRejectedValueOnce(new Error('index.lock exists')) // merge --abort fails
          .mockResolvedValueOnce(mergeHeadPath) // resolve MERGE_HEAD path
          .mockResolvedValueOnce(''); // stash store (recovery)

        const result = await gitBranchService.mergeFrom('/repo', 'feature', { stash: true });

        expect(result.success).toBe(false);
        expect(result.message).toContain('could not be aborted');
        expect(result.message).toContain('recovery copy was saved in git stash');
        expect(result.message).not.toContain('safely aborted');
        expect(execSpy).not.toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('preserves saved changes when operation state cannot be inspected', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // merge fails
        .mockRejectedValueOnce(new Error('index.lock exists')) // merge --abort fails
        .mockRejectedValueOnce(new Error('cannot resolve git path')) // state probe fails
        .mockResolvedValueOnce(''); // stash store (recovery)

      const result = await gitBranchService.mergeFrom('/repo', 'feature', { stash: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('could not verify whether the merge is still active');
      expect(result.message).toContain('recovery copy was saved in git stash');
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('restores saved changes when the merge fails before starting', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('merge: missing-branch - not something we can merge'))
        .mockRejectedValueOnce(new Error('There is no merge to abort'))
        .mockResolvedValueOnce('/missing/MERGE_HEAD')
        .mockResolvedValueOnce(''); // stash apply

      const result = await gitBranchService.mergeFrom('/repo', 'missing-branch', { stash: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not something we can merge');
      expect(result.message).toContain('saved local changes were restored');
      expect(result.message).not.toContain('conflicted operation is still active');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', expect.arrayContaining(['store']));
    });
  });

  describe('rebaseOnTargetBranch', () => {
    it.each([
      ['current', 'main'],
      ['fast-forwarded', 'main'],
      ['blocked', 'origin/main'],
      ['no-local', 'origin/main'],
      ['no-remote', 'main'],
    ] as const)('rebases a %s target onto %s', async (sync, rebaseRef) => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, syncBranchWithRemoteSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      syncBranchWithRemoteSpy.mockResolvedValue(sync);
      execSpy.mockResolvedValue('Successfully rebased');

      const result = await gitBranchService.rebaseOnTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
      expect(syncBranchWithRemoteSpy).toHaveBeenCalledWith('/repo', 'main');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['rebase', rebaseRef]);
    });

    it('syncs the target before stashing local changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, execSpy, syncBranchWithRemoteSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockResolvedValueOnce(''); // stash apply

      await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });

      expect(execSpy.mock.calls[0][1]).toEqual(['stash', 'create']);
      expect(syncBranchWithRemoteSpy.mock.invocationCallOrder[0]).toBeLessThan(
        execSpy.mock.invocationCallOrder[0]
      );
    });

    it('refuses with uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      const result = await gitBranchService.rebaseOnTargetBranch('/repo');
      expect(result).toEqual({
        success: false,
        message: 'Commit or stash changes before rebasing',
      });
    });

    it('reports already up to date', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('Current branch feature is up to date.');
      const result = await gitBranchService.rebaseOnTargetBranch('/repo');
      expect(result).toEqual({ success: true, message: 'Already up to date' });
    });

    it('stashes via create/apply when stash option is true and there are changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create → SHA
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockResolvedValueOnce(''); // stash apply <sha>
      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });
      expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'create']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['reset', '--hard', 'HEAD']);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['clean', '-fd']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('skips stash when stash create returns empty (nothing to stash)', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('') // stash create → empty (nothing to stash)
        .mockResolvedValueOnce('Successfully rebased'); // rebase
      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });
      expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
    });

    it('reports that saved changes need attention when stash apply fails after rebase', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockRejectedValueOnce(new Error('conflict in stash')) // stash apply fails
        .mockResolvedValueOnce(''); // stash store (recovery)
      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('saved local changes');
      expect(result.message).toContain('recovery copy');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'stash',
        'store',
        '-m',
        'komla-auto-stash-before-rebase',
        'abc123',
      ]);
    });

    it('exposes the recovery commit when stash apply and store both fail', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockRejectedValueOnce(new Error('conflict in stash')) // stash apply fails
        .mockRejectedValueOnce(new Error('cannot lock refs/stash')); // stash store fails

      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('could not save a recovery copy in git stash');
      expect(result.message).toContain('abc123');
      expect(result.message).not.toContain('recovery copy was saved in git stash');
    });

    it('aborts rebase and re-applies stash when rebase fails with stash option', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // rebase fails
        .mockResolvedValueOnce('') // rebase --abort
        .mockResolvedValueOnce(''); // stash apply <sha>
      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('was aborted');
      expect(result.message).not.toContain('safely');
      expect(result.message).toContain('saved local changes were restored');
      expect(result.message).not.toContain('coding agent');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['rebase', '--abort']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('restores saved changes when the rebase fails before starting', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('missing-branch');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('fatal: invalid upstream missing-branch'))
        .mockRejectedValueOnce(new Error('No rebase in progress'))
        .mockResolvedValueOnce(
          '/missing/rebase-merge\n/missing/rebase-apply\n/missing/rebase-apply/applying'
        )
        .mockResolvedValueOnce(''); // stash apply

      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid upstream missing-branch');
      expect(result.message).toContain('saved local changes were restored');
      expect(result.message).not.toContain('conflicted operation is still active');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', expect.arrayContaining(['store']));
    });

    it('preserves saved changes when rebase state cannot be inspected', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // rebase fails
        .mockRejectedValueOnce(new Error('index.lock exists')) // rebase --abort fails
        .mockRejectedValueOnce(new Error('cannot resolve rebase paths'))
        .mockResolvedValueOnce(''); // stash store (recovery)

      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('could not verify whether the rebase is still active');
      expect(result.message).toContain('recovery copy was saved in git stash');
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('stores stash for recovery when both rebase and stash apply fail', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // rebase fails
        .mockResolvedValueOnce('') // rebase --abort
        .mockRejectedValueOnce(new Error('apply conflict')) // stash apply also fails
        .mockResolvedValueOnce(''); // stash store (recovery)
      const result = await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('saved local changes could not be restored');
      expect(result.message).toContain('recovery copy');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'stash',
        'store',
        '-m',
        'komla-auto-stash-before-rebase',
        'abc123',
      ]);
    });

    it('does not pass --include-untracked to stash create and leaves untracked files alone', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getTargetBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create → SHA
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockResolvedValueOnce(''); // stash apply <sha>
      await gitBranchService.rebaseOnTargetBranch('/repo', { stash: true });

      // stash create must NOT receive --include-untracked (git silently treats it as the message)
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['stash', 'create', '--include-untracked']);
      // Must not delete untracked files
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['clean', '-fd']);
      // Cleanup should be a single reset --hard, not checkout+reset
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['checkout', '--', '.']);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['reset', 'HEAD']);
    });

    it('leaves a clean-worktree rebase paused for the user or agent to resolve', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getTargetBranchSpy,
        execSpy,
        invalidateCacheSpy,
      } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy
        .mockRejectedValueOnce(new Error('conflict')) // rebase
        .mockResolvedValueOnce('UU file.txt\n'); // status
      const result = await gitBranchService.rebaseOnTargetBranch('/repo');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Rebase onto main paused');
      expect(result.message).toContain('file.txt');
      expect(result.message).toContain('continue the rebase');
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['rebase', '--abort']);
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });
  });

  describe('rebaseOnBranch', () => {
    it('refuses to rebase onto current branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      const result = await gitBranchService.rebaseOnBranch('/repo', 'feature');
      expect(result).toEqual({ success: false, message: 'Cannot rebase onto the current branch' });
    });

    it('stashes via create/apply when stash option is true and there are changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getCurrentBranchSpy.mockResolvedValue('feature');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create → SHA
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockResolvedValueOnce(''); // stash apply <sha>
      const result = await gitBranchService.rebaseOnBranch('/repo', 'main', { stash: true });
      expect(result).toEqual({ success: true, message: 'Rebased on main successfully' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'create']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['reset', '--hard', 'HEAD']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('reports that saved changes need attention when stash apply fails after rebase', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getCurrentBranchSpy.mockResolvedValue('feature');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockResolvedValueOnce('Successfully rebased') // rebase
        .mockRejectedValueOnce(new Error('conflict in stash')) // stash apply fails
        .mockResolvedValueOnce(''); // stash store (recovery)
      const result = await gitBranchService.rebaseOnBranch('/repo', 'main', { stash: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('saved local changes');
      expect(result.message).toContain('recovery copy');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'stash',
        'store',
        '-m',
        'komla-auto-stash-before-rebase',
        'abc123',
      ]);
    });

    it('aborts rebase and re-applies stash when rebase fails with stash option', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, getCurrentBranchSpy, execSpy } =
        await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      getCurrentBranchSpy.mockResolvedValue('feature');
      execSpy
        .mockResolvedValueOnce('abc123\n') // stash create
        .mockResolvedValueOnce('') // reset --hard HEAD
        .mockRejectedValueOnce(new Error('conflict')) // rebase fails
        .mockResolvedValueOnce('') // rebase --abort
        .mockResolvedValueOnce(''); // stash apply <sha>
      const result = await gitBranchService.rebaseOnBranch('/repo', 'main', { stash: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('was aborted');
      expect(result.message).not.toContain('safely');
      expect(result.message).toContain('saved local changes were restored');
      expect(result.message).not.toContain('coding agent');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['rebase', '--abort']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['stash', 'apply', 'abc123']);
    });

    it('invalidates the dirty-state cache when leaving a rebase conflict paused', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        execSpy,
        invalidateCacheSpy,
      } = await setupBranchUpdate();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      execSpy
        .mockRejectedValueOnce(new Error('conflict')) // rebase
        .mockResolvedValueOnce('UU file.txt\n'); // status

      const result = await gitBranchService.rebaseOnBranch('/repo', 'main');

      expect(result.message).toContain('Rebase onto main paused');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });
  });

  describe('getCommitsBehindTargetBranch', () => {
    it('returns 0 when on main', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      getTargetBranchSpy.mockResolvedValue('main');
      const result = await gitBranchService.getCommitsBehindTargetBranch('/repo');
      expect(result).toBe(0);
    });

    it('returns count from rev-list', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy, execSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('3');
      const result = await gitBranchService.getCommitsBehindTargetBranch('/repo');
      expect(result).toBe(3);
    });

    it('returns 0 on error', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy } = await setup();
      getCurrentBranchSpy.mockRejectedValue(new Error('fail'));
      getTargetBranchSpy.mockResolvedValue('main');
      const result = await gitBranchService.getCommitsBehindTargetBranch('/repo');
      expect(result).toBe(0);
    });
  });

  describe('getCommitsAheadTargetBranch', () => {
    it('returns 0 when on main', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('main');
      getTargetBranchSpy.mockResolvedValue('main');
      const result = await gitBranchService.getCommitsAheadTargetBranch('/repo');
      expect(result).toBe(0);
    });

    it('returns count from rev-list', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy, execSpy } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue('5');
      const result = await gitBranchService.getCommitsAheadTargetBranch('/repo');
      expect(result).toBe(5);
    });
  });

  describe('push', () => {
    it('publishes branch when no remote exists', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        hasRemoteTrackingBranchSpy,
        execGitWithProgressSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasRemoteTrackingBranchSpy.mockResolvedValue(false);
      execGitWithProgressSpy.mockResolvedValue('');
      const result = await gitBranchService.push('/repo');
      expect(result).toEqual({ success: true, message: 'Published feature to origin' });
    });

    it('reports already up to date when 0 unpushed', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        hasRemoteTrackingBranchSpy,
        getUnpushedCommitsSpy,
        getCommitsBehindRemoteSpy,
        execGitWithProgressSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      getUnpushedCommitsSpy.mockResolvedValue(0);
      getCommitsBehindRemoteSpy.mockResolvedValue(0);
      execGitWithProgressSpy.mockResolvedValue('');
      const result = await gitBranchService.push('/repo');
      expect(result).toEqual({ success: true, message: 'Already up to date' });
    });

    it('reports pushed commit count', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        hasRemoteTrackingBranchSpy,
        getUnpushedCommitsSpy,
        getCommitsBehindRemoteSpy,
        execGitWithProgressSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      getUnpushedCommitsSpy.mockResolvedValue(3);
      getCommitsBehindRemoteSpy.mockResolvedValue(0);
      execGitWithProgressSpy.mockResolvedValue('');
      const result = await gitBranchService.push('/repo');
      expect(result).toEqual({ success: true, message: 'Pushed 3 commits to origin' });
    });

    it('returns errorCode rejected for non-fast-forward push failure', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        hasRemoteTrackingBranchSpy,
        getUnpushedCommitsSpy,
        getCommitsBehindRemoteSpy,
        execGitWithProgressSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      getUnpushedCommitsSpy.mockResolvedValue(1);
      getCommitsBehindRemoteSpy.mockResolvedValue(0);
      execGitWithProgressSpy.mockRejectedValue({
        stderr:
          '! [rejected]        feature -> feature (non-fast-forward)\nerror: failed to push some refs',
      });
      const result = await gitBranchService.push('/repo');
      expect(result).toEqual({
        success: false,
        message: 'Remote has new commits',
        errorCode: 'rejected',
      });
    });

    it('returns errorCode rejected for fetch-first push failure', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        hasRemoteTrackingBranchSpy,
        getUnpushedCommitsSpy,
        getCommitsBehindRemoteSpy,
        execGitWithProgressSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      getUnpushedCommitsSpy.mockResolvedValue(1);
      getCommitsBehindRemoteSpy.mockResolvedValue(0);
      execGitWithProgressSpy.mockRejectedValue({
        stderr:
          'error: failed to push some refs\nhint: Updates were rejected because you need to fetch first',
      });
      const result = await gitBranchService.push('/repo');
      expect(result).toEqual({
        success: false,
        message: 'Remote has new commits',
        errorCode: 'rejected',
      });
    });

    it('returns generic error without errorCode for other push failures', async () => {
      const {
        gitBranchService,
        getCurrentBranchSpy,
        hasRemoteTrackingBranchSpy,
        getUnpushedCommitsSpy,
        getCommitsBehindRemoteSpy,
        execGitWithProgressSpy,
      } = await setup();
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      getUnpushedCommitsSpy.mockResolvedValue(1);
      getCommitsBehindRemoteSpy.mockResolvedValue(0);
      execGitWithProgressSpy.mockRejectedValue(new Error('Connection refused'));
      const result = await gitBranchService.push('/repo');
      expect(result).toEqual({ success: false, message: 'Connection refused' });
      expect(result).not.toHaveProperty('errorCode');
    });
  });

  describe('pull', () => {
    it('refuses with uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      const result = await gitBranchService.pull('/repo');
      expect(result).toEqual({ success: false, message: 'Commit or stash changes before pulling' });
    });

    it('refuses without remote tracking branch', async () => {
      const { gitBranchService, hasUncommittedChangesSpy, hasRemoteTrackingBranchSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(false);
      const result = await gitBranchService.pull('/repo');
      expect(result).toEqual({ success: false, message: 'No remote tracking branch configured' });
    });

    it('reports already up to date', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        hasRemoteTrackingBranchSpy,
        execGitWithProgressSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execGitWithProgressSpy.mockResolvedValue('Already up to date.');
      const result = await gitBranchService.pull('/repo');
      expect(result).toEqual({ success: true, message: 'Already up to date' });
      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo',
        ['pull', '--no-rebase', '--progress'],
        undefined,
        { enableAskpass: true }
      );
    });

    it('invalidates the dirty-state cache when leaving a pull conflict paused', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        hasRemoteTrackingBranchSpy,
        execGitWithProgressSpy,
        execSpy,
        invalidateCacheSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execGitWithProgressSpy.mockRejectedValue(new Error('Merge conflict'));
      execSpy.mockResolvedValueOnce('UU file.txt\n');

      const result = await gitBranchService.pull('/repo');

      expect(result.message).toContain('Pull paused');
      expect(result.message).toContain('complete the merge');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });
  });

  describe('pullRebase', () => {
    it('refuses to rebase with uncommitted changes', async () => {
      const { gitBranchService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);

      const result = await gitBranchService.pullRebase('/repo');

      expect(result).toEqual({
        success: false,
        message: 'Commit or stash changes before pulling',
      });
    });

    it('refuses to rebase the target branch', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        getTargetBranchSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('main');
      getTargetBranchSpy.mockResolvedValue('main');

      const result = await gitBranchService.pullRebase('/repo');

      expect(result).toEqual({
        success: false,
        message: 'Pull (rebase) is not allowed on main; use the main pull flow instead',
      });
    });

    it('runs git pull --rebase with askpass enabled for non-target branches', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        getTargetBranchSpy,
        hasRemoteTrackingBranchSpy,
        execGitWithProgressSpy,
        execSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy.mockResolvedValue('origin/feature');
      execGitWithProgressSpy.mockResolvedValue('');

      const result = await gitBranchService.pullRebase('/repo');

      expect(result).toEqual({ success: true, message: 'Rebased on remote changes' });
      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo',
        ['pull', '--rebase', '--progress'],
        undefined,
        { enableAskpass: true }
      );
    });

    it('refuses to rebase without a remote tracking branch', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        getTargetBranchSpy,
        hasRemoteTrackingBranchSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      hasRemoteTrackingBranchSpy.mockResolvedValue(false);

      const result = await gitBranchService.pullRebase('/repo');

      expect(result).toEqual({
        success: false,
        message: 'No remote tracking branch configured',
      });
    });

    it('falls back to explicit origin pull when upstream is missing but remote ref exists', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        getTargetBranchSpy,
        hasRemoteTrackingBranchSpy,
        execGitWithProgressSpy,
        execSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockResolvedValueOnce('origin/feature');
      execGitWithProgressSpy.mockResolvedValue('');

      const result = await gitBranchService.pullRebase('/repo');

      expect(result).toEqual({ success: true, message: 'Rebased on remote changes' });
      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo',
        ['pull', '--rebase', 'origin', 'feature', '--progress'],
        undefined,
        { enableAskpass: true }
      );
    });

    it('refuses to rebase when upstream and origin ref are both missing', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        getTargetBranchSpy,
        hasRemoteTrackingBranchSpy,
        execSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy.mockRejectedValue(new Error('missing remote ref'));

      const result = await gitBranchService.pullRebase('/repo');

      expect(result).toEqual({
        success: false,
        message: 'No upstream tracking branch configured',
      });
    });

    it('leaves a conflicted pull rebase active for the user or agent to resolve', async () => {
      const {
        gitBranchService,
        hasUncommittedChangesSpy,
        getCurrentBranchSpy,
        getTargetBranchSpy,
        hasRemoteTrackingBranchSpy,
        execGitWithProgressSpy,
        execSpy,
        invalidateCacheSpy,
      } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      getCurrentBranchSpy.mockResolvedValue('feature');
      getTargetBranchSpy.mockResolvedValue('main');
      hasRemoteTrackingBranchSpy.mockResolvedValue(true);
      execSpy
        .mockResolvedValueOnce('origin/feature')
        .mockResolvedValueOnce('UD deleted-by-them.ts\n');
      execGitWithProgressSpy.mockRejectedValue(new Error('Rebase conflict'));

      const result = await gitBranchService.pullRebase('/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Pull with rebase paused');
      expect(result.message).toContain('deleted-by-them.ts');
      expect(result.message).not.toContain('coding agent');
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['rebase', '--abort']);
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });
  });

  describe('mergeToTargetBranch', () => {
    it('merges the detached HEAD commit instead of resolving HEAD in the target worktree', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        listWorktreesSpy,
        fastForwardBranchSpy,
      } = await setup();
      const detachedCommit = '1234567890abcdef1234567890abcdef12345678';
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('HEAD');
      listWorktreesSpy.mockResolvedValue([]);
      fastForwardBranchSpy.mockResolvedValue({ status: 'fast-forwarded' });
      execSpy.mockImplementation(async (_repoPath, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse HEAD') return detachedCommit;
        if (command === 'rev-parse --verify origin/main') throw new Error('not found');
        if (command === 'rev-list --count HEAD..main') return '0';
        if (command === 'rev-list --count main..HEAD') return '1';
        if (command === 'rev-parse --git-common-dir') return '/repo/.git';
        return '';
      });

      const result = await gitBranchService.mergeToTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Fast-forwarded main to detached HEAD' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['rev-parse', 'HEAD']);
      expect(fastForwardBranchSpy).toHaveBeenCalledWith('/repo', 'main', detachedCommit);
    });

    it('fast-forwards a target branch no worktree has checked out without a checkout', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        listWorktreesSpy,
        fastForwardBranchSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([]);
      fastForwardBranchSpy.mockResolvedValue({ status: 'fast-forwarded' });
      execSpy.mockImplementation(async (_repoPath, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --verify origin/main') throw new Error('not found');
        if (command === 'rev-list --count feature..main') return '0';
        if (command === 'rev-list --count main..feature') return '2';
        if (command === 'rev-parse --git-common-dir') return '/repo/.git';
        return '';
      });

      const result = await gitBranchService.mergeToTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Fast-forwarded main to feature' });
      expect(fastForwardBranchSpy).toHaveBeenCalledWith('/repo', 'main', 'feature');
      const commands = execSpy.mock.calls.map((call) => call[1][0]);
      expect(commands).not.toContain('checkout');
      expect(commands).not.toContain('switch');
      expect(commands).not.toContain('merge');
      expect(commands).not.toContain('worktree');
    });

    it('merges in the target worktree if one checks the target out meanwhile', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        listWorktreesSpy,
        hasUncommittedChangesSpy,
        fastForwardBranchSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([]);
      fastForwardBranchSpy.mockResolvedValue({ status: 'checked-out', worktreePath: '/target' });
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockImplementation(async (_repoPath, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --verify origin/main') throw new Error('not found');
        if (command === 'rev-list --count feature..main') return '0';
        if (command === 'rev-list --count main..feature') return '2';
        if (command === 'rev-parse --git-common-dir') return '/repo/.git';
        return '';
      });

      const result = await gitBranchService.mergeToTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Fast-forwarded main to feature' });
      expect(execSpy).toHaveBeenCalledWith('/target', ['merge', '--ff-only', 'feature']);
    });

    it('merges in the target worktree when target branch is checked out elsewhere', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        listWorktreesSpy,
        hasUncommittedChangesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([{ path: '/target', branch: 'main', commit: 'abc123' }]);
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execSpy.mockImplementation(async (_repoPath, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --verify origin/main') throw new Error('not found');
        if (command === 'rev-list --count feature..main') return '0';
        if (command === 'rev-list --count main..feature') return '2';
        return '';
      });

      const result = await gitBranchService.mergeToTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Fast-forwarded main to feature' });
      expect(execSpy).toHaveBeenCalledWith('/target', ['merge', '--ff-only', 'feature']);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', ['merge', '--ff-only', 'feature']);
    });
  });

  describe('pushTargetBranch', () => {
    it('publishes target branch when remote branch does not yet exist', async () => {
      const { gitBranchService, getTargetBranchSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockImplementation(async (_repoPath, args) => {
        if (args.join(' ') === 'rev-parse --git-common-dir') return '/repo/.git';
        throw new Error('not found'); // rev-parse --verify origin/main
      });
      execGitWithProgressSpy.mockResolvedValue('');

      const result = await gitBranchService.pushTargetBranch('/repo');

      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo/.git',
        ['--git-dir', '/repo/.git', 'push', '-u', 'origin', 'main', '--progress'],
        undefined,
        { enableAskpass: true }
      );
      expect(result).toEqual({ success: true, message: 'Published main to origin' });
    });

    it('returns errorCode rejected for non-fast-forward push failure', async () => {
      const { gitBranchService, getTargetBranchSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockImplementation(async (_repoPath, args) => {
        if (args.join(' ') === 'rev-parse --git-common-dir') return '/repo/.git';
        if (
          args.join(' ') === '--git-dir /repo/.git rev-list --left-right --count origin/main...main'
        ) {
          return '0\t2';
        }
        return ''; // rev-parse --verify origin/main
      });
      execGitWithProgressSpy.mockRejectedValue({
        stderr: '! [rejected]        main -> main (non-fast-forward)',
      });
      const result = await gitBranchService.pushTargetBranch('/repo');
      expect(result).toEqual({
        success: false,
        message: 'Remote has new commits on main',
        errorCode: 'rejected',
      });
    });

    it('returns generic error without errorCode for other pushTargetBranch failures', async () => {
      const { gitBranchService, getTargetBranchSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockImplementation(async (_repoPath, args) => {
        if (args.join(' ') === 'rev-parse --git-common-dir') return '/repo/.git';
        if (
          args.join(' ') === '--git-dir /repo/.git rev-list --left-right --count origin/main...main'
        ) {
          return '0\t2';
        }
        return ''; // rev-parse --verify origin/main
      });
      execGitWithProgressSpy.mockRejectedValue(new Error('Permission denied'));
      const result = await gitBranchService.pushTargetBranch('/repo');
      expect(result).toEqual({ success: false, message: 'Permission denied' });
      expect(result).not.toHaveProperty('errorCode');
    });

    it('pushes from the common git dir so deleting the worktree after setup does not affect push cwd', async () => {
      const { gitBranchService, getTargetBranchSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockImplementation(async (_repoPath, args) => {
        if (args.join(' ') === 'rev-parse --git-common-dir') return '../../.git';
        if (
          args.join(' ') === '--git-dir /repo/.git rev-list --left-right --count origin/main...main'
        ) {
          return '0\t1';
        }
        return '';
      });
      execGitWithProgressSpy.mockResolvedValue('');

      const result = await gitBranchService.pushTargetBranch('/repo/worktrees/feature');

      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo/.git',
        ['--git-dir', '/repo/.git', 'push', 'origin', 'main', '--progress'],
        undefined,
        { enableAskpass: true }
      );
      expect(result).toEqual({ success: true, message: 'Pushed 1 commit to main' });
    });

    it('resolves relative origin URL before pushing from the common git dir', async () => {
      const { gitBranchService, getTargetBranchSpy, execSpy, execGitWithProgressSpy } =
        await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockImplementation(async (_repoPath, args) => {
        const command = args.join(' ');
        if (command === 'ls-remote --get-url origin') return '../remote.git';
        if (command === 'rev-parse --git-common-dir') return '../../.git';
        if (command === '--git-dir /repo/.git rev-list --left-right --count origin/main...main') {
          return '0\t1';
        }
        return '';
      });
      execGitWithProgressSpy.mockResolvedValue('');

      const result = await gitBranchService.pushTargetBranch('/repo/worktrees/feature');

      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo/.git',
        [
          '--git-dir',
          '/repo/.git',
          '-c',
          'remote.origin.url=/repo/worktrees/remote.git',
          'push',
          'origin',
          'main',
          '--progress',
        ],
        undefined,
        { enableAskpass: true }
      );
      expect(result).toEqual({ success: true, message: 'Pushed 1 commit to main' });
    });
  });

  describe('pullTargetBranch', () => {
    it('fetches then fast-forwards main when behind', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        listWorktreesSpy,
        fastForwardBranchSpy,
      } = await setup();
      fastForwardBranchSpy.mockResolvedValue({ status: 'fast-forwarded' });
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([]);
      execSpy.mockResolvedValue(''); // rev-parse, merge-base
      execGitWithProgressSpy.mockResolvedValue(''); // fetch
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 3 });
      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({ success: true, message: 'Pulled 3 commits to main' });
      // Single fetch call (no second SSH round-trip)
      expect(execGitWithProgressSpy).toHaveBeenCalledTimes(1);
      expect(execGitWithProgressSpy).toHaveBeenCalledWith(
        '/repo',
        ['fetch', 'origin', 'main', '--progress'],
        undefined,
        { enableAskpass: true }
      );
      // Fast-forward from the already-fetched ref instead of a second fetch
      expect(fastForwardBranchSpy).toHaveBeenCalledWith(
        '/repo',
        'main',
        'refs/remotes/origin/main'
      );
    });

    it('fast-forwards via merge when target branch is checked out in this worktree', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('main');
      execSpy.mockResolvedValue(''); // rev-parse, merge-base, merge --ff-only
      execGitWithProgressSpy.mockResolvedValue('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Pulled 2 commits to main' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['merge', '--ff-only', 'origin/main']);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', [
        'update-ref',
        'refs/heads/main',
        'origin/main',
      ]);
    });

    it('fast-forwards via merge in the worktree where target branch is checked out elsewhere', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(false);
      listWorktreesSpy.mockResolvedValue([
        { path: '/other/worktree', branch: 'main', commit: 'abc123' },
        { path: '/repo', branch: 'feature', commit: 'def456' },
      ]);
      execSpy.mockResolvedValue(''); // rev-parse, merge-base, merge --ff-only in other worktree
      execGitWithProgressSpy.mockResolvedValue('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Pulled 2 commits to main' });
      expect(execSpy).toHaveBeenCalledWith('/other/worktree', [
        'merge',
        '--ff-only',
        'origin/main',
      ]);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', [
        'update-ref',
        'refs/heads/main',
        'origin/main',
      ]);
    });

    it('rejects fast-forward when checked-out target worktree has uncommitted changes', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(true);
      listWorktreesSpy.mockResolvedValue([
        { path: '/other/worktree', branch: 'main', commit: 'abc123' },
        { path: '/repo', branch: 'feature', commit: 'def456' },
      ]);
      execSpy.mockResolvedValue('');
      execGitWithProgressSpy.mockResolvedValue('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({
        success: false,
        message: 'Cannot update main: uncommitted changes in /other/worktree',
      });
      expect(execSpy).not.toHaveBeenCalledWith('/other/worktree', [
        'merge',
        '--ff-only',
        'origin/main',
      ]);
      expect(execSpy).not.toHaveBeenCalledWith('/repo', [
        'update-ref',
        'refs/heads/main',
        'origin/main',
      ]);
    });

    it('returns already up to date when not behind', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      execSpy.mockResolvedValue(''); // rev-parse --verify origin/main
      execGitWithProgressSpy.mockResolvedValue(''); // fetch
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 0 });
      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({ success: true, message: 'main is already up to date' });
    });

    it('returns error when no remote tracking branch', async () => {
      const { gitBranchService, getTargetBranchSpy, execSpy } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      execSpy.mockRejectedValue(new Error('not found')); // rev-parse --verify origin/main fails
      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({ success: false, message: 'No remote tracking branch for main' });
    });

    async function setupDivergedTarget() {
      const ctx = await setup();
      ctx.getTargetBranchSpy.mockResolvedValue('main');
      ctx.getCurrentBranchSpy.mockResolvedValue('feature');
      ctx.listWorktreesSpy.mockResolvedValue([]);
      ctx.getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });
      ctx.fastForwardBranchSpy.mockResolvedValue({ status: 'fast-forwarded' });
      ctx.execSpy.mockImplementation(async (_repoPath, args) => {
        const command = args.join(' ');
        if (command.startsWith('merge-base --is-ancestor')) throw new Error('not ancestor');
        if (command === 'rev-parse --verify refs/heads/main^{commit}') return 'ours-sha';
        if (command === 'rev-parse --verify refs/remotes/origin/main^{commit}') return 'theirs-sha';
        if (command.startsWith('commit-tree')) return 'merged-sha';
        return '';
      });
      return ctx;
    }

    it('merges a diverged target without checking it out, even in a dirty workspace', async () => {
      const {
        gitBranchService,
        execSpy,
        execGitWithProgressSpy,
        hasUncommittedChangesSpy,
        fastForwardBranchSpy,
      } = await setupDivergedTarget();
      const tree = 'a'.repeat(40);
      execGitWithProgressSpy.mockImplementation(async (_repoPath, args) =>
        args[0] === 'merge-tree' ? tree : ''
      );
      hasUncommittedChangesSpy.mockResolvedValue(true);

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Merged origin/main into main' });
      expect(execGitWithProgressSpy).toHaveBeenCalledWith('/repo', [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        'ours-sha',
        'theirs-sha',
      ]);
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'commit-tree',
        tree,
        '-p',
        'ours-sha',
        '-p',
        'theirs-sha',
        '-m',
        "Merge remote-tracking branch 'origin/main'",
      ]);
      expect(fastForwardBranchSpy).toHaveBeenCalledWith('/repo', 'main', 'merged-sha');
      const commands = execSpy.mock.calls.map((call) => call[1][0]);
      expect(commands).not.toContain('checkout');
      expect(commands).not.toContain('merge');
    });

    it('leaves a diverged target unchanged when merging it would conflict', async () => {
      const { gitBranchService, execGitWithProgressSpy, fastForwardBranchSpy } =
        await setupDivergedTarget();
      execGitWithProgressSpy.mockImplementation(async (_repoPath, args) => {
        if (args[0] === 'merge-tree') throw new Error(`${'b'.repeat(40)}\nsrc/a.ts\nsrc/b.ts`);
        return '';
      });

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({
        success: false,
        message:
          'Merging origin/main into main would conflict in src/a.ts, src/b.ts. main was left unchanged; check it out to merge and resolve the conflicts.',
      });
      expect(fastForwardBranchSpy).not.toHaveBeenCalled();
    });

    it('merges in a temporary detached worktree when Git has no merge-tree --write-tree', async () => {
      const { gitBranchService, execSpy, execGitWithProgressSpy, fastForwardBranchSpy } =
        await setupDivergedTarget();
      execGitWithProgressSpy.mockImplementation(async (_repoPath, args) => {
        if (args[0] === 'merge-tree') {
          throw new Error('usage: git merge-tree <base-tree> <branch1> <branch2>');
        }
        return '';
      });
      const merge = execSpy.getMockImplementation()!;
      execSpy.mockImplementation(async (repoPath, args) =>
        args.join(' ') === 'rev-parse HEAD' ? 'temp-merge-sha' : merge(repoPath, args)
      );

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Merged origin/main into main' });
      const add = execSpy.mock.calls.find((call) => call[1][0] === 'worktree');
      expect(add?.[1]).toEqual(['worktree', 'add', '--detach', expect.any(String), 'ours-sha']);
      const tempPath = add![1][3];
      expect(execSpy).toHaveBeenCalledWith(tempPath, [
        'merge',
        '--no-edit',
        '-m',
        "Merge remote-tracking branch 'origin/main'",
        'theirs-sha',
      ]);
      expect(fastForwardBranchSpy).toHaveBeenCalledWith('/repo', 'main', 'temp-merge-sha');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['worktree', 'remove', '--force', tempPath]);
    });

    it('allows merge fallback when current worktree is dirty but target branch is checked out cleanly elsewhere', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([
        { path: '/other-worktree', branch: 'main', commit: 'abc123' },
        { path: '/repo', branch: 'feature', commit: 'def456' },
      ]);
      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor')) // merge-base --is-ancestor fails
        .mockResolvedValueOnce("Merge made by the 'ort' strategy.");
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });
      hasUncommittedChangesSpy.mockImplementation(async (path: string) => path === '/repo');

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({ success: true, message: 'Merged origin/main into main' });
      expect(execSpy).toHaveBeenCalledWith('/other-worktree', ['merge', 'origin/main']);
    });

    it('uses singular commit message for 1 commit', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([]);
      execSpy.mockResolvedValue('');
      execGitWithProgressSpy.mockResolvedValue('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });
      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({ success: true, message: 'Pulled 1 commit to main' });
    });

    it('falls back to merging in worktree when target branch is checked out elsewhere', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        getCurrentBranchSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execGitWithProgressSpy.mockResolvedValueOnce(''); // fetch origin main --progress
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });

      listWorktreesSpy.mockResolvedValue([
        { path: '/other-worktree', branch: 'main', commit: 'abc123' },
        { path: '/repo', branch: 'feature', commit: 'def456' },
      ]);

      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor')) // merge-base --is-ancestor fails
        // mergeRemoteInWorktree: merge origin/main in the target worktree
        .mockResolvedValueOnce("Merge made by the 'ort' strategy.");

      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({ success: true, message: 'Merged origin/main into main' });
      // Verify the merge ran in the correct worktree path
      expect(execSpy).toHaveBeenCalledWith('/other-worktree', ['merge', 'origin/main']);
    });

    it('returns already up to date when worktree merge finds no changes', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        getCurrentBranchSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });

      listWorktreesSpy.mockResolvedValue([{ path: '/main-wt', branch: 'main', commit: 'abc123' }]);

      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor'))
        .mockResolvedValueOnce('Already up to date.');

      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({ success: true, message: 'Already up to date' });
    });

    it('rejects merge in checked-out target worktree when that worktree has uncommitted changes', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        getCurrentBranchSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });
      listWorktreesSpy.mockResolvedValue([{ path: '/main-wt', branch: 'main', commit: 'abc123' }]);

      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor'));

      hasUncommittedChangesSpy.mockImplementation(async (path: string) => path === '/main-wt');

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({
        success: false,
        message: 'Cannot update main: uncommitted changes in /main-wt',
      });
      expect(execSpy).not.toHaveBeenCalledWith('/main-wt', ['merge', 'origin/main']);
    });

    it('fails closed when target worktree state cannot be verified before fast-forward', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([{ path: '/main-wt', branch: 'main', commit: 'abc123' }]);
      execSpy.mockResolvedValue('');
      execGitWithProgressSpy.mockResolvedValue('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });
      hasUncommittedChangesSpy.mockRejectedValue(new Error('status failed'));

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({
        success: false,
        message: 'status failed',
      });
      expect(execSpy).not.toHaveBeenCalledWith('/main-wt', ['merge', '--ff-only', 'origin/main']);
    });

    it('fails closed when target worktree state cannot be verified before merge fallback', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        getCurrentBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      listWorktreesSpy.mockResolvedValue([
        { path: '/other-worktree', branch: 'main', commit: 'abc123' },
      ]);
      execSpy.mockResolvedValueOnce('').mockRejectedValueOnce(new Error('not ancestor'));
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 2 });
      hasUncommittedChangesSpy.mockRejectedValue(new Error('status failed'));

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result).toEqual({
        success: false,
        message: 'status failed',
      });
    });

    it('returns error when merge in worktree fails', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        getCurrentBranchSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });

      listWorktreesSpy.mockResolvedValue([{ path: '/main-wt', branch: 'main', commit: 'abc123' }]);

      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor'))
        .mockRejectedValueOnce(new Error('CONFLICT (content): Merge conflict in file.txt'))
        .mockResolvedValueOnce('UU file.txt\n') // status in the other worktree
        .mockResolvedValueOnce(''); // merge --abort

      const result = await gitBranchService.pullTargetBranch('/repo');
      expect(result).toEqual({
        success: false,
        message: 'Updating main encountered conflicts outside the active workspace and was aborted.',
      });
      expect(execSpy).toHaveBeenCalledWith('/main-wt', ['merge', '--abort']);
    });

    it('reports when a conflicted hidden worktree cannot be aborted', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        getCurrentBranchSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
        invalidateCacheSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });
      listWorktreesSpy.mockResolvedValue([{ path: '/main-wt', branch: 'main', commit: 'abc123' }]);
      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor'))
        .mockRejectedValueOnce(new Error('CONFLICT (content): Merge conflict in file.txt'))
        .mockResolvedValueOnce('UU file.txt\n') // status in the other worktree
        .mockRejectedValueOnce(new Error('index.lock exists')); // merge --abort

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('could not be aborted');
      expect(result.message).toContain('/main-wt');
      expect(result.message).toContain('index.lock exists');
      expect(result.message).not.toContain('safely aborted');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/main-wt');
    });

    it('reports when conflict inspection fails in a hidden worktree', async () => {
      const {
        gitBranchService,
        getTargetBranchSpy,
        execSpy,
        getAheadBehindSpy,
        execGitWithProgressSpy,
        getCurrentBranchSpy,
        hasUncommittedChangesSpy,
        listWorktreesSpy,
        invalidateCacheSpy,
      } = await setup();
      getTargetBranchSpy.mockResolvedValue('main');
      getCurrentBranchSpy.mockResolvedValue('feature');
      hasUncommittedChangesSpy.mockResolvedValue(false);
      execGitWithProgressSpy.mockResolvedValueOnce('');
      getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 1 });
      listWorktreesSpy.mockResolvedValue([{ path: '/main-wt', branch: 'main', commit: 'abc123' }]);
      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify origin/main
        .mockRejectedValueOnce(new Error('not ancestor'))
        .mockRejectedValueOnce(new Error('merge failed'))
        .mockRejectedValueOnce(new Error('cannot read index'));

      const result = await gitBranchService.pullTargetBranch('/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('could not verify whether Git left an operation active');
      expect(result.message).toContain('/main-wt');
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/main-wt');
    });
  });

  describe('getBranchQuickStatus — getRemoteCounts paths', () => {
    /** Helper to set up common mocks for getBranchQuickStatus calls */
    function setupQuickStatusMocks(s: Awaited<ReturnType<typeof setup>>) {
      s.getCurrentBranchSpy.mockResolvedValue('feature');
      s.getTargetBranchSpy.mockResolvedValue('main');
      s.getMainBranchSpy.mockResolvedValue('main');
      s.hasRemoteSpy.mockResolvedValue(true);
      // Use argument-based routing for execGitAsync since calls happen in parallel
      s.execSpy.mockImplementation((_path: string, args: string[]) => {
        if (args.includes('--abbrev-ref')) {
          // upstream lookup: rev-parse --abbrev-ref feature@{upstream}
          return Promise.resolve('origin/feature');
        }
        // All other execGitAsync calls (rev-parse --verify, etc.) succeed
        return Promise.resolve('');
      });
      // Use argument-based routing for getAheadBehind since calls happen in parallel
      s.getAheadBehindSpy.mockResolvedValue({ ahead: 0, behind: 0 });
    }

    it('computes unpushed count when upstream tracking ref exists', async () => {
      const s = await setup();
      setupQuickStatusMocks(s);
      // upstream lookup succeeds (default mock returns 'origin/feature')
      // Route getAheadBehind by the upstream argument to return specific counts
      s.getAheadBehindSpy.mockImplementation((_path: string, _branch: string, upstream: string) => {
        if (upstream === 'origin/feature') return Promise.resolve({ ahead: 3, behind: 1 });
        return Promise.resolve({ ahead: 0, behind: 0 });
      });

      const result = await s.gitBranchService.getBranchQuickStatus('/repo');
      expect(result.hasRemote).toBe(true);
      expect(result.unpushedCommits).toBe(3);
      expect(result.behindRemote).toBe(1);
      expect(result.targetBranchHasRemote).toBe(true);
      expect(result.targetBranchAheadRemote).toBe(0);
      expect(result.targetBranchBehindRemote).toBe(0);
    });

    it('computes unpushed count when no upstream but origin/<branch> exists', async () => {
      const s = await setup();
      setupQuickStatusMocks(s);
      // Override: upstream lookup fails, but rev-parse --verify origin/feature succeeds
      s.execSpy.mockImplementation((_path: string, args: string[]) => {
        if (args.includes('--abbrev-ref')) {
          return Promise.reject(new Error('no upstream'));
        }
        return Promise.resolve('');
      });
      s.getAheadBehindSpy.mockImplementation((_path: string, _branch: string, upstream: string) => {
        if (upstream === 'origin/feature') return Promise.resolve({ ahead: 5, behind: 2 });
        return Promise.resolve({ ahead: 0, behind: 0 });
      });

      const result = await s.gitBranchService.getBranchQuickStatus('/repo');
      expect(result.hasRemote).toBe(true);
      expect(result.unpushedCommits).toBe(5);
      expect(result.behindRemote).toBe(2);
    });

    it('returns hasRemote false when no upstream and no origin/<branch>', async () => {
      const s = await setup();
      setupQuickStatusMocks(s);
      // Both upstream lookup and origin/feature verify fail
      s.execSpy.mockImplementation((_path: string, args: string[]) => {
        if (args.includes('--abbrev-ref')) {
          return Promise.reject(new Error('no upstream'));
        }
        if (args.includes('--verify') && args.some((a: string) => a.includes('origin/feature'))) {
          return Promise.reject(new Error('not found'));
        }
        return Promise.resolve('');
      });

      const result = await s.gitBranchService.getBranchQuickStatus('/repo');
      expect(result.hasRemote).toBe(false);
      expect(result.unpushedCommits).toBe(0);
      expect(result.behindRemote).toBe(0);
    });
  });

  describe('getBranchQuickStatus — remote-only target branch', () => {
    it('resolves to origin/<branch> when local target branch does not exist', async () => {
      const s = await setup();
      s.getCurrentBranchSpy.mockResolvedValue('feature');
      s.getTargetBranchSpy.mockResolvedValue('develop');
      s.getMainBranchSpy.mockResolvedValue('main');
      s.hasRemoteSpy.mockResolvedValue(true);

      s.execSpy.mockImplementation((_path: string, args: string[]) => {
        // Local "develop" does not exist
        if (args.includes('--verify') && args.includes('develop')) {
          return Promise.reject(new Error('not found'));
        }
        // origin/develop exists
        if (args.includes('--verify') && args.includes('origin/develop')) {
          return Promise.resolve('abc123');
        }
        // upstream lookup for current branch
        if (args.includes('--abbrev-ref')) {
          return Promise.reject(new Error('no upstream'));
        }
        return Promise.resolve('');
      });

      s.getAheadBehindSpy.mockImplementation((_path: string, branch: string, upstream: string) => {
        // ahead/behind target: should compare against origin/develop, not develop
        if (branch === 'feature' && upstream === 'origin/develop') {
          return Promise.resolve({ ahead: 7, behind: 2 });
        }
        return Promise.resolve({ ahead: 0, behind: 0 });
      });

      const result = await s.gitBranchService.getBranchQuickStatus('/repo');

      // Should use origin/develop as the ref for ahead/behind comparison
      expect(result.aheadTargetBranch).toBe(7);
      expect(result.behindTargetBranch).toBe(2);
      // Display name should still be "develop", not "origin/develop"
      expect(result.mainBranch).toBe('develop');
      // Remote status: local ref equals remote ref, so ahead/behind should be 0
      expect(result.targetBranchHasRemote).toBe(true);
      expect(result.targetBranchAheadRemote).toBe(0);
      expect(result.targetBranchBehindRemote).toBe(0);
    });

    it('uses the fetched target when the local target branch is strictly behind', async () => {
      const s = await setup();
      s.getCurrentBranchSpy.mockResolvedValue('feature');
      s.getTargetBranchSpy.mockResolvedValue('main');
      s.getMainBranchSpy.mockResolvedValue('main');
      s.hasRemoteSpy.mockResolvedValue(true);

      s.execSpy.mockImplementation((_path: string, args: string[]) => {
        // Local "main" exists
        if (args.includes('--verify') && args.includes('main')) {
          return Promise.resolve('abc123');
        }
        // upstream lookup
        if (args.includes('--abbrev-ref')) {
          return Promise.reject(new Error('no upstream'));
        }
        return Promise.resolve('');
      });

      s.getAheadBehindSpy.mockImplementation((_path: string, branch: string, upstream: string) => {
        if (branch === 'feature' && upstream === 'main') {
          return Promise.resolve({ ahead: 3, behind: 1 });
        }
        if (branch === 'feature' && upstream === 'origin/main') {
          return Promise.resolve({ ahead: 1, behind: 2 });
        }
        if (branch === 'main' && upstream === 'origin/main') {
          return Promise.resolve({ ahead: 0, behind: 2 });
        }
        return Promise.resolve({ ahead: 0, behind: 0 });
      });

      const result = await s.gitBranchService.getBranchQuickStatus('/repo');

      expect(result.aheadTargetBranch).toBe(1);
      expect(result.behindTargetBranch).toBe(2);
      expect(result.mainBranch).toBe('main');
      expect(result.targetBranchHasRemote).toBe(true);
      expect(result.targetBranchAheadRemote).toBe(0);
      expect(result.targetBranchBehindRemote).toBe(2);
    });

    it('keeps the local target as the comparison when it has commits missing from remote', async () => {
      const s = await setup();
      s.getCurrentBranchSpy.mockResolvedValue('feature');
      s.getTargetBranchSpy.mockResolvedValue('main');
      s.getMainBranchSpy.mockResolvedValue('main');
      s.hasRemoteSpy.mockResolvedValue(true);
      s.execSpy.mockImplementation((_path: string, args: string[]) => {
        if (args.includes('--abbrev-ref')) return Promise.reject(new Error('no upstream'));
        return Promise.resolve('abc123');
      });
      s.getAheadBehindSpy.mockImplementation((_path: string, branch: string, upstream: string) => {
        if (branch === 'feature' && upstream === 'main') {
          return Promise.resolve({ ahead: 3, behind: 1 });
        }
        if (branch === 'main' && upstream === 'origin/main') {
          return Promise.resolve({ ahead: 1, behind: 2 });
        }
        return Promise.resolve({ ahead: 9, behind: 9 });
      });

      const result = await s.gitBranchService.getBranchQuickStatus('/repo');

      expect(result.aheadTargetBranch).toBe(3);
      expect(result.behindTargetBranch).toBe(1);
      expect(result.targetBranchAheadRemote).toBe(1);
      expect(result.targetBranchBehindRemote).toBe(2);
    });
  });

  describe('Azure DevOps browser URLs', () => {
    it('builds the branch URL', async () => {
      const { gitBranchService, getCurrentBranchSpy } = await setup();
      const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');
      vi.spyOn(gitRepoService, 'getRepoWebInfo').mockResolvedValue({
        provider: 'azure-devops',
        webUrl: 'https://dev.azure.com/contoso/Project/_git/repo',
      });
      getCurrentBranchSpy.mockResolvedValue('feature/menu');

      await expect(gitBranchService.getBranchUrl('/repo')).resolves.toBe(
        'https://dev.azure.com/contoso/Project/_git/repo?version=GBfeature%2Fmenu'
      );
    });

    it('builds the create pull request URL', async () => {
      const { gitBranchService, getCurrentBranchSpy, getTargetBranchSpy } = await setup();
      const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');
      vi.spyOn(gitRepoService, 'getRepoWebInfo').mockResolvedValue({
        provider: 'azure-devops',
        webUrl: 'https://dev.azure.com/contoso/Project/_git/repo',
      });
      getCurrentBranchSpy.mockResolvedValue('feature/menu');
      getTargetBranchSpy.mockResolvedValue('main');

      await expect(gitBranchService.getCreatePrUrl('/repo')).resolves.toBe(
        'https://dev.azure.com/contoso/Project/_git/repo/pullrequestcreate?sourceRef=GBfeature%2Fmenu&targetRef=GBmain'
      );
    });
  });
});
