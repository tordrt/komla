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
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, rm: vi.fn(() => Promise.resolve()) };
});

describe('GitWorktreeService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setup() {
    const loggerMod = await import('../../../../src/main/lib/logger');
    const createLoggerMock = vi.mocked(loggerMod.createLogger);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    createLoggerMock.mockReturnValue(logger);
    const gitExecMod = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsync');
    const execWithProgressSpy = vi.spyOn(gitExecMod.gitExec, 'execGitWithProgress');
    const getMainBranchSpy = vi.spyOn(gitExecMod.gitExec, 'getMainBranch');
    const hasRemoteSpy = vi.spyOn(gitExecMod.gitExec, 'hasRemote');
    const fs = (await import('fs')) as unknown as {
      existsSync: ReturnType<typeof vi.fn>;
      rmSync: ReturnType<typeof vi.fn>;
      mkdirSync: ReturnType<typeof vi.fn>;
    };
    const { rm } = (await import('fs/promises')) as unknown as { rm: ReturnType<typeof vi.fn> };
    const { gitWorktreeService } = await import('../../../../src/main/services/git/git-worktree');
    const fastForwardBranchSpy = vi
      .spyOn(gitWorktreeService, 'fastForwardBranch')
      .mockResolvedValue({ status: 'fast-forwarded' });
    return {
      gitWorktreeService,
      fastForwardBranchSpy,
      execSpy,
      execWithProgressSpy,
      getMainBranchSpy,
      hasRemoteSpy,
      logger,
      ...fs,
      rm,
    };
  }

  describe('fastForwardBranch', () => {
    async function setupFastForward() {
      const ctx = await setup();
      ctx.fastForwardBranchSpy.mockRestore();
      return ctx;
    }

    it('fast-forwards through a fetch from the repository itself', async () => {
      const { gitWorktreeService, execSpy } = await setupFastForward();
      execSpy
        .mockResolvedValueOnce('worktree /repo\nHEAD abc\nbranch refs/heads/feature\n')
        .mockResolvedValueOnce('new-sha')
        .mockResolvedValueOnce('');

      await expect(
        gitWorktreeService.fastForwardBranch('/repo', 'main', 'refs/remotes/origin/main')
      ).resolves.toEqual({ status: 'fast-forwarded' });
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'rev-parse',
        '--verify',
        'refs/remotes/origin/main^{commit}',
      ]);
      expect(execSpy).toHaveBeenLastCalledWith('/repo', [
        '-c',
        'maintenance.auto=false',
        '-c',
        'gc.auto=0',
        'fetch',
        '--no-write-fetch-head',
        '--no-tags',
        '--no-prune',
        '--no-recurse-submodules',
        '.',
        'new-sha:refs/heads/main',
      ]);
    });

    it('fetches without --no-write-fetch-head on Git before 2.29', async () => {
      const { gitWorktreeService, execSpy } = await setupFastForward();
      execSpy
        .mockResolvedValueOnce('worktree /repo\nHEAD abc\nbranch refs/heads/feature\n')
        .mockResolvedValueOnce('new-sha')
        .mockRejectedValueOnce(new Error("error: unknown option `no-write-fetch-head'"))
        .mockResolvedValueOnce('');

      await expect(
        gitWorktreeService.fastForwardBranch('/repo', 'main', 'refs/remotes/origin/main')
      ).resolves.toEqual({ status: 'fast-forwarded' });
      expect(execSpy.mock.calls.at(-1)?.[1]).not.toContain('--no-write-fetch-head');
      expect(execSpy.mock.calls.at(-1)?.[1]).toContain('new-sha:refs/heads/main');
    });

    it('reports the worktree that has the branch checked out without moving it', async () => {
      const { gitWorktreeService, execSpy } = await setupFastForward();
      execSpy.mockResolvedValueOnce('worktree /checkout\nHEAD abc\nbranch refs/heads/main\n');

      await expect(
        gitWorktreeService.fastForwardBranch('/repo', 'main', 'refs/remotes/origin/main')
      ).resolves.toEqual({ status: 'checked-out', worktreePath: '/checkout' });
      expect(execSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('createWorktree', () => {
    it('throws if worktree path already exists', async () => {
      const { gitWorktreeService, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      await expect(gitWorktreeService.createWorktree('/repo', 'feature')).rejects.toThrow(
        'Worktree already exists'
      );
    });

    it('creates worktree for existing local branch (no remote)', async () => {
      const { gitWorktreeService, existsSync, execSpy, hasRemoteSpy } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse --verify refs/heads/feature (branch exists)
        .mockResolvedValueOnce(''); // worktree add
      hasRemoteSpy.mockResolvedValue(false);

      const created = await gitWorktreeService.createWorktree('/repo', 'feature');
      expect(created.path).toContain('feature');
      expect(created.createdBranch).toBe(false);
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'rev-parse',
        '--verify',
        'refs/heads/feature',
      ]);
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        expect.stringContaining('feature'),
        'feature',
      ]);
    });

    it('fast-forwards local branch to remote before creating worktree', async () => {
      const {
        gitWorktreeService,
        existsSync,
        execSpy,
        execWithProgressSpy,
        hasRemoteSpy,
        fastForwardBranchSpy,
      } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockResolvedValueOnce('') // show-ref (remote branch exists)
        .mockResolvedValueOnce('') // merge-base --is-ancestor (can fast-forward)
        .mockResolvedValueOnce('') // worktree add
        .mockResolvedValueOnce('') // config remote
        .mockResolvedValueOnce(''); // config merge
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'merge-base',
        '--is-ancestor',
        'refs/heads/feature',
        'refs/remotes/origin/feature',
      ]);
      expect(fastForwardBranchSpy).toHaveBeenCalledWith(
        '/repo',
        'feature',
        'refs/remotes/origin/feature'
      );
    });

    it('skips fast-forward when local has diverged from remote', async () => {
      const {
        gitWorktreeService,
        existsSync,
        execSpy,
        execWithProgressSpy,
        hasRemoteSpy,
        fastForwardBranchSpy,
      } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockResolvedValueOnce('') // show-ref (remote branch exists)
        .mockRejectedValueOnce(new Error('not ancestor')) // merge-base (diverged)
        .mockResolvedValueOnce('') // worktree add (uses local as-is)
        .mockResolvedValueOnce('') // config remote
        .mockResolvedValueOnce(''); // config merge
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');
      expect(fastForwardBranchSpy).not.toHaveBeenCalled();
      // Should still create worktree from local branch
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        expect.stringContaining('feature'),
        'feature',
      ]);
    });

    it('creates new branch when branch does not exist', async () => {
      const { gitWorktreeService, existsSync, execSpy, getMainBranchSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (branch doesn't exist)
        .mockResolvedValueOnce('abc123') // rev-list --all --max-count=1
        .mockResolvedValueOnce(''); // worktree add -b
      getMainBranchSpy.mockResolvedValue('main');
      hasRemoteSpy.mockResolvedValue(false);

      await expect(gitWorktreeService.createWorktree('/repo', 'new-feature')).resolves.toEqual({
        path: expect.stringContaining('new-feature'),
        createdBranch: true,
      });
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '-b',
        'new-feature',
        expect.any(String),
        'main',
      ]);
    });

    it('uses custom base branch for new branch', async () => {
      const { gitWorktreeService, existsSync, execSpy, hasRemoteSpy } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce('abc123')
        .mockResolvedValueOnce('');
      hasRemoteSpy.mockResolvedValue(false);

      await gitWorktreeService.createWorktree('/repo', 'new-feature', undefined, 'develop');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '-b',
        'new-feature',
        expect.any(String),
        'develop',
      ]);
    });

    it('does not track the remote start point when branching from origin', async () => {
      const { gitWorktreeService, existsSync, execSpy, hasRemoteSpy } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce('abc123')
        .mockResolvedValueOnce('');
      hasRemoteSpy.mockResolvedValue(false);

      await gitWorktreeService.createWorktree('/repo', 'new-feature', undefined, 'origin/main');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'new-feature',
        expect.any(String),
        'origin/main',
      ]);
    });

    it('creates an orphan worktree when the repository has no commits yet', async () => {
      const { gitWorktreeService, existsSync, execSpy, getMainBranchSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (branch doesn't exist)
        .mockResolvedValueOnce('') // rev-list --all --max-count=1 (no commits)
        .mockResolvedValueOnce('false') // rev-parse --is-bare-repository
        .mockResolvedValueOnce('main') // symbolic-ref --short HEAD
        .mockResolvedValueOnce(''); // worktree add -b, with Git inferring orphan mode
      getMainBranchSpy.mockResolvedValue('main');
      hasRemoteSpy.mockResolvedValue(false);

      await gitWorktreeService.createWorktree('/repo', 'new-feature');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['rev-list', '--all', '--max-count=1']);
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '-b',
        'new-feature',
        expect.any(String),
      ]);
      expect(getMainBranchSpy).not.toHaveBeenCalled();
    });

    it('rejects an empty-repo worktree that would duplicate the checked-out unborn branch', async () => {
      const { gitWorktreeService, existsSync, execSpy, getMainBranchSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (branch doesn't exist)
        .mockResolvedValueOnce('') // rev-list --all --max-count=1 (no commits)
        .mockResolvedValueOnce('false') // rev-parse --is-bare-repository
        .mockResolvedValueOnce('main'); // symbolic-ref --short HEAD
      getMainBranchSpy.mockResolvedValue('main');
      hasRemoteSpy.mockResolvedValue(false);

      await expect(gitWorktreeService.createWorktree('/repo', 'main')).rejects.toThrow(
        'Cannot create worktree for branch "main" because this repository has no commits yet and that branch is already checked out.'
      );
      expect(execSpy).not.toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '-b',
        'main',
        expect.any(String),
      ]);
      expect(getMainBranchSpy).not.toHaveBeenCalled();
    });

    it('preserves invalid-reference errors when the repository has commits', async () => {
      const { gitWorktreeService, existsSync, execSpy, getMainBranchSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (branch doesn't exist)
        .mockResolvedValueOnce('abc123') // rev-list --all --max-count=1
        .mockRejectedValueOnce(new Error('fatal: invalid reference: main')) // worktree add -b
        .mockResolvedValueOnce('abc123'); // rev-list --all --max-count=1
      getMainBranchSpy.mockResolvedValue('main');
      hasRemoteSpy.mockResolvedValue(false);

      await expect(gitWorktreeService.createWorktree('/repo', 'new-feature')).rejects.toThrow(
        'fatal: invalid reference: main'
      );
    });

    it('creates worktree from remote branch when branch exists on origin but not locally', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (no local branch)
        .mockResolvedValueOnce('') // show-ref pre-check (remote tracking ref exists from picker fetch)
        .mockResolvedValueOnce('') // worktree add -b ... origin/feature
        .mockResolvedValueOnce('') // config remote
        .mockResolvedValueOnce(''); // config merge
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');
      // Without fetchRemote, no network fetch should happen
      expect(execWithProgressSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '-b',
        'feature',
        expect.any(String),
        'origin/feature',
      ]);
    });

    it('fetches from remote when fetchRemote is true and tracking ref exists', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (no local branch)
        .mockResolvedValueOnce('') // show-ref pre-check (remote tracking ref exists)
        .mockResolvedValueOnce('') // worktree add -b ... origin/feature
        .mockResolvedValueOnce('') // config remote
        .mockResolvedValueOnce(''); // config merge
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch origin
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature', undefined, undefined, {
        fetchRemote: true,
      });
      expect(execWithProgressSpy).toHaveBeenCalledWith(
        '/repo',
        ['fetch', 'origin', '+refs/heads/feature:refs/remotes/origin/feature'],
        undefined,
        { enableAskpass: true }
      );
    });

    it('falls back to baseBranch when branch does not exist locally or on remote', async () => {
      const {
        gitWorktreeService,
        existsSync,
        execSpy,
        execWithProgressSpy,
        getMainBranchSpy,
        hasRemoteSpy,
      } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockRejectedValueOnce(new Error('not found')) // rev-parse (no local branch)
        .mockRejectedValueOnce(new Error('not found')) // show-ref (no remote tracking ref)
        .mockResolvedValueOnce('abc123') // rev-list --all --max-count=1
        .mockResolvedValueOnce('') // worktree add -b ... main
        .mockRejectedValueOnce(new Error('not found')); // show-ref in upstream tracking
      // No fetch mock needed — fetch is skipped when no tracking ref exists
      getMainBranchSpy.mockResolvedValue('main');
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'new-feature');
      // Should NOT fetch — no remote tracking ref means branch is brand-new
      expect(execWithProgressSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'worktree',
        'add',
        '-b',
        'new-feature',
        expect.any(String),
        'main',
      ]);
    });

    it('uses custom destination path', async () => {
      const { gitWorktreeService, existsSync, execSpy, hasRemoteSpy } = await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // branch exists
        .mockResolvedValueOnce(''); // worktree add
      hasRemoteSpy.mockResolvedValue(false);

      const { path } = await gitWorktreeService.createWorktree('/repo', 'feature', '/custom/path');
      expect(path).toBe('/custom/path');
    });

    it('replaces slashes in branch name for default path', async () => {
      const { gitWorktreeService, existsSync, execSpy, hasRemoteSpy } = await setup();
      existsSync.mockReturnValue(false);
      execSpy.mockResolvedValueOnce('').mockResolvedValueOnce('');
      hasRemoteSpy.mockResolvedValue(false);

      const { path } = await gitWorktreeService.createWorktree('/repo', 'feature/sub');
      expect(path).toContain('feature-sub');
    });

    it('sets up upstream tracking when origin has the branch', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockResolvedValueOnce('') // show-ref (remote exists, confirmedRemoteBranch = true)
        .mockResolvedValueOnce('') // merge-base --is-ancestor
        .mockResolvedValueOnce('') // worktree add
        .mockResolvedValueOnce('') // config branch.feature.remote
        .mockResolvedValueOnce(''); // config branch.feature.merge
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');
      expect(execSpy).toHaveBeenCalledWith(expect.any(String), [
        'config',
        'branch.feature.remote',
        'origin',
      ]);
      expect(execSpy).toHaveBeenCalledWith(expect.any(String), [
        'config',
        'branch.feature.merge',
        'refs/heads/feature',
      ]);
    });

    it('sets up upstream tracking for slash-separated branch names', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockResolvedValueOnce('') // show-ref (remote exists)
        .mockResolvedValueOnce('') // merge-base
        .mockResolvedValueOnce('') // worktree add
        .mockResolvedValueOnce('') // config branch.feature/sub.remote
        .mockResolvedValueOnce(''); // config branch.feature/sub.merge
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature/sub');

      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'show-ref',
        '--verify',
        '--quiet',
        'refs/remotes/origin/feature/sub',
      ]);
      expect(execSpy).toHaveBeenCalledWith(expect.any(String), [
        'config',
        'branch.feature/sub.remote',
        'origin',
      ]);
      expect(execSpy).toHaveBeenCalledWith(expect.any(String), [
        'config',
        'branch.feature/sub.merge',
        'refs/heads/feature/sub',
      ]);
    });

    it('skips upstream tracking when branch is local-only', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockRejectedValueOnce(new Error('not found')) // show-ref (no remote tracking ref)
        .mockResolvedValueOnce('') // worktree add
        .mockRejectedValueOnce(new Error('not found')); // show-ref in upstream tracking
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'local-only');
      // Should NOT fetch — no remote tracking ref
      expect(execWithProgressSpy).not.toHaveBeenCalled();
      const configCalls = execSpy.mock.calls.filter((c) => c[1]?.[0] === 'config');
      expect(configCalls).toHaveLength(0);
    });

    it('does not match nested remote branch names when setting upstream tracking', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockRejectedValueOnce(new Error('not found')) // show-ref (no exact remote match)
        .mockResolvedValueOnce('') // worktree add
        .mockRejectedValueOnce(new Error('not found')); // show-ref in upstream tracking
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');
      // Should NOT fetch — no remote tracking ref
      expect(execWithProgressSpy).not.toHaveBeenCalled();
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'show-ref',
        '--verify',
        '--quiet',
        'refs/remotes/origin/feature',
      ]);
      const configCalls = execSpy.mock.calls.filter((c) => c[1]?.[0] === 'config');
      expect(configCalls).toHaveLength(0);
    });

    it('logs when upstream config fails after finding the remote branch', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy, logger } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockResolvedValueOnce('') // show-ref (remote exists)
        .mockResolvedValueOnce('') // merge-base
        .mockResolvedValueOnce('') // worktree add
        .mockRejectedValueOnce(new Error('config failed')); // config branch.feature.remote
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');

      expect(logger.warn).toHaveBeenCalledWith('Failed to set upstream tracking', {
        branchName: 'feature',
        error: 'config failed',
      });
    });

    it('rolls back partial upstream config when merge config fails', async () => {
      const { gitWorktreeService, existsSync, execSpy, execWithProgressSpy, hasRemoteSpy, logger } =
        await setup();
      existsSync.mockReturnValue(false);
      execSpy
        .mockResolvedValueOnce('') // rev-parse (local branch exists)
        .mockResolvedValueOnce('') // show-ref (remote exists)
        .mockResolvedValueOnce('') // merge-base
        .mockResolvedValueOnce('') // worktree add
        .mockResolvedValueOnce('') // config branch.feature.remote
        .mockRejectedValueOnce(new Error('merge config failed')) // config branch.feature.merge
        .mockResolvedValueOnce(''); // config --unset-all branch.feature.remote
      execWithProgressSpy.mockResolvedValueOnce(''); // fetch
      hasRemoteSpy.mockResolvedValue(true);

      await gitWorktreeService.createWorktree('/repo', 'feature');

      expect(execSpy).toHaveBeenCalledWith(expect.any(String), [
        'config',
        '--unset-all',
        'branch.feature.remote',
      ]);
      expect(logger.warn).toHaveBeenCalledWith('Failed to set upstream tracking', {
        branchName: 'feature',
        error: 'merge config failed',
      });
    });
  });

  describe('deleteWorktree', () => {
    it('checks for uncommitted changes by default', async () => {
      const { gitWorktreeService, execSpy, existsSync } = await setup();
      execSpy.mockResolvedValueOnce('M file.ts'); // status --porcelain
      existsSync.mockReturnValue(true);

      await expect(gitWorktreeService.deleteWorktree('/repo', '/wt')).rejects.toThrow(
        'uncommitted changes'
      );
    });

    it('skips uncommitted check when force=true', async () => {
      const { gitWorktreeService, execSpy, existsSync } = await setup();
      execSpy.mockResolvedValue(''); // worktree remove --force
      existsSync.mockReturnValue(false); // no cleanup needed

      await gitWorktreeService.deleteWorktree('/repo', '/wt', true);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['worktree', 'remove', '--force', '/wt']);
    });

    it('cleans up directory if still exists after git removal', async () => {
      const { gitWorktreeService, execSpy, existsSync, rm } = await setup();
      execSpy
        .mockResolvedValueOnce('') // status (clean)
        .mockResolvedValueOnce(''); // worktree remove
      existsSync.mockReturnValue(true); // dir still exists

      await gitWorktreeService.deleteWorktree('/repo', '/wt');
      expect(rm).toHaveBeenCalledWith('/wt', { recursive: true, force: true });
    });

    it('asks fs.rm to retry the folder on Windows, where it can stay in use for seconds', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const { gitWorktreeService, execSpy, existsSync, rm } = await setup();
        execSpy.mockResolvedValue('');
        existsSync.mockReturnValue(true);

        await gitWorktreeService.deleteWorktree('/repo', '/wt', true);

        // fs.rm waits retryDelay * n before try n, retrying EBUSY, EPERM and ENOTEMPTY.
        const { maxRetries = 0, retryDelay = 100 } = rm.mock.calls[0][1];
        const totalWaitMs = (retryDelay * maxRetries * (maxRetries + 1)) / 2;
        expect(totalWaitMs).toBeGreaterThanOrEqual(5000);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('continues if directory cleanup throws after the path disappears', async () => {
      const { gitWorktreeService, execSpy, existsSync, rm, logger } = await setup();
      execSpy
        .mockResolvedValueOnce('') // status (clean)
        .mockResolvedValueOnce(''); // worktree remove
      existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      rm.mockRejectedValueOnce(new Error('EPERM: operation not permitted'));

      await gitWorktreeService.deleteWorktree('/repo', '/wt');

      expect(logger.warn).toHaveBeenCalledWith(
        'Worktree directory cleanup reported an error after path disappeared',
        {
          worktreePath: '/wt',
          error: 'EPERM: operation not permitted',
        }
      );
    });

    it('throws if directory cleanup fails and the path still exists', async () => {
      const { gitWorktreeService, execSpy, existsSync, rm } = await setup();
      execSpy
        .mockResolvedValueOnce('') // status (clean)
        .mockResolvedValueOnce(''); // worktree remove
      existsSync.mockReturnValue(true);
      rm.mockRejectedValueOnce(new Error('EPERM: operation not permitted'));

      await expect(gitWorktreeService.deleteWorktree('/repo', '/wt')).rejects.toThrow(
        'EPERM: operation not permitted'
      );
    });

    it('prunes worktree refs when git remove fails', async () => {
      const { gitWorktreeService, execSpy, existsSync } = await setup();
      execSpy
        .mockResolvedValueOnce('') // status (clean)
        .mockRejectedValueOnce(new Error('remove failed')) // worktree remove
        .mockResolvedValueOnce(''); // worktree prune
      existsSync.mockReturnValue(false);

      await gitWorktreeService.deleteWorktree('/repo', '/wt');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['worktree', 'prune']);
    });

    it('deletes branch when requested', async () => {
      const { gitWorktreeService, execSpy, existsSync } = await setup();
      execSpy
        .mockResolvedValueOnce('') // status (clean)
        .mockResolvedValueOnce('') // worktree remove
        .mockResolvedValueOnce(''); // branch -D
      existsSync.mockReturnValue(false);

      await gitWorktreeService.deleteWorktree('/repo', '/wt', false, {
        deleteBranch: true,
        branchName: 'feature',
      });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['branch', '-D', 'feature']);
    });

    it('does not delete main branch', async () => {
      const { gitWorktreeService, execSpy, existsSync } = await setup();
      execSpy
        .mockResolvedValueOnce('') // status
        .mockResolvedValueOnce(''); // worktree remove
      existsSync.mockReturnValue(false);

      await gitWorktreeService.deleteWorktree('/repo', '/wt', false, {
        deleteBranch: true,
        branchName: 'main',
      });
      // Should NOT have called branch -D main
      const branchDeleteCalls = execSpy.mock.calls.filter(
        (c) => c[1]?.[0] === 'branch' && c[1]?.[1] === '-D'
      );
      expect(branchDeleteCalls).toHaveLength(0);
    });
  });

  describe('listWorktrees', () => {
    it('parses porcelain output', async () => {
      const { gitWorktreeService, execSpy } = await setup();
      execSpy.mockResolvedValue(
        [
          'worktree /repo',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /repo/.worktrees/feature',
          'HEAD def456',
          'branch refs/heads/feature',
          '',
        ].join('\n')
      );

      const result = await gitWorktreeService.listWorktrees('/repo');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: '/repo', branch: 'main', commit: 'abc123' });
      expect(result[1]).toEqual({
        path: '/repo/.worktrees/feature',
        branch: 'feature',
        commit: 'def456',
      });
    });

    it('skips entries without branch (detached HEAD)', async () => {
      const { gitWorktreeService, execSpy } = await setup();
      execSpy.mockResolvedValue(
        [
          'worktree /repo',
          'HEAD abc123',
          'detached',
          '',
          'worktree /repo/.worktrees/feature',
          'HEAD def456',
          'branch refs/heads/feature',
          '',
        ].join('\n')
      );
      const result = await gitWorktreeService.listWorktrees('/repo');
      expect(result).toHaveLength(1);
      expect(result[0].branch).toBe('feature');
    });

    it('returns empty array for empty output', async () => {
      const { gitWorktreeService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      const result = await gitWorktreeService.listWorktrees('/repo');
      expect(result).toEqual([]);
    });
  });
});
