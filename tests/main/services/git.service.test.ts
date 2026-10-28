/**
 * Tests for GitService - handles all git operations including worktree creation,
 * branch management, diffs, and status queries.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockElectron } from '../../mocks/electron';
import { createVirtualFs } from '../../mocks/fs';
import {
  createExecMock,
  createExecFileMock,
  createSpawnMock,
  mockChildProcess,
} from '../../mocks/child-process';

// Set up mocks before any imports
vi.mock('electron', () => mockElectron());

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

// Mock fs/promises separately since GitService imports it dynamically
vi.mock('fs/promises', () => ({
  readFile: vi.fn((path: string) => {
    const content = vfs.getFile(path);
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
    }
    return Promise.resolve(content.toString());
  }),
  readdir: vi.fn((path: string) => {
    // Return entries for the virtual fs
    const entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
    const prefix = path.endsWith('/') ? path : path + '/';
    const seen = new Set<string>();

    for (const filePath of vfs.getAllFiles().keys()) {
      if (filePath.startsWith(prefix)) {
        const relativePath = filePath.slice(prefix.length);
        const firstSegment = relativePath.split('/')[0];
        if (firstSegment && !seen.has(firstSegment)) {
          seen.add(firstSegment);
          const isDir = relativePath.includes('/');
          entries.push({
            name: firstSegment,
            isDirectory: () => isDir,
            isFile: () => !isDir,
          });
        }
      }
    }
    return Promise.resolve(entries);
  }),
  rm: vi.fn((path: string) => {
    for (const filePath of vfs.getAllFiles().keys()) {
      if (filePath === path || filePath.startsWith(path + '/')) {
        vfs.deleteFile(filePath);
      }
    }
    return Promise.resolve();
  }),
}));

const execMock = createExecMock();
const execFileMock = createExecFileMock();
const spawnMock = createSpawnMock();
vi.mock('child_process', () => mockChildProcess(execMock, spawnMock, execFileMock));

describe('GitService', () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.clearMocks();
    execFileMock.clearMocks();
    spawnMock.clearProcesses();
    vfs.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isGitRepo', () => {
    it.each([
      { response: { stdout: '.git' }, expected: true },
      { response: { error: 'fatal: not a git repository', exitCode: 128 }, expected: false },
    ])('returns $expected when rev-parse answers $response', async ({ response, expected }) => {
      execFileMock.mockCommand(/git rev-parse --git-dir/, response);

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.isGitRepo('/path/to/repo');

      expect(result).toBe(expected);
    });
  });

  describe('getRepoRoot', () => {
    it('should return repository root path', async () => {
      execFileMock.mockCommand(/git rev-parse --show-toplevel/, {
        stdout: '/home/user/myrepo',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getRepoRoot('/home/user/myrepo/src');

      expect(result).toBe('/home/user/myrepo');
    });

    it('should throw error when not in a git repository', async () => {
      execFileMock.mockCommand(/git rev-parse --show-toplevel/, {
        error: 'fatal: not a git repository',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');

      await expect(gitService.getRepoRoot('/not/a/repo')).rejects.toThrow();
    });
  });

  describe('getCurrentBranch', () => {
    it('should return feature branch name', async () => {
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, {
        stdout: 'feature/my-feature',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCurrentBranch('/path/to/repo');

      expect(result).toBe('feature/my-feature');
    });

    it('should handle detached HEAD state', async () => {
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'HEAD' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCurrentBranch('/path/to/repo');

      expect(result).toBe('HEAD');
    });

    it('should cache result for performance', async () => {
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'main' });

      const { gitService } = await import('../../../src/main/services/git.service');

      // First call
      const result1 = await gitService.getCurrentBranch('/path/to/repo');
      // Second call should use cache
      const result2 = await gitService.getCurrentBranch('/path/to/repo');

      expect(result1).toBe('main');
      expect(result2).toBe('main');
      // 1 call for the actual command. Second getCurrentBranch uses cache.
      expect(execFileMock.getCallCount()).toBe(1);
    });
  });

  describe('getMainBranch', () => {
    it('should return main when main branch exists', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, { stdout: 'abc123' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('main');
    });

    it('should return master when main does not exist but master does', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/master/, { stdout: 'abc123' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('master');
    });

    it('should detect default branch from origin/HEAD when neither main nor master exists', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/master/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git symbolic-ref refs\/remotes\/origin\/HEAD/, {
        stdout: 'refs/remotes/origin/develop',
      });
      // The remote tracking ref must actually resolve
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/develop/, {
        stdout: 'abc123',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('develop');
    });

    it('prefers origin/HEAD over a local main', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git symbolic-ref refs\/remotes\/origin\/HEAD/, {
        stdout: 'refs/remotes/origin/develop',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/develop/, {
        stdout: 'abc123',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('develop');
    });

    it('should skip origin/HEAD when remote tracking ref is dangling', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/master/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      // origin/HEAD resolves to a symbolic name, but the tracking ref is dangling
      execFileMock.mockCommand(/git symbolic-ref refs\/remotes\/origin\/HEAD/, {
        stdout: 'refs/remotes/origin/develop',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/develop/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      // Falls through to HEAD
      execFileMock.mockCommand(/git symbolic-ref HEAD/, {
        stdout: 'refs/heads/trunk',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/trunk/, { stdout: 'abc123' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('trunk');
    });

    it('should fall back to HEAD branch when no origin/HEAD exists', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/master/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git symbolic-ref refs\/remotes\/origin\/HEAD/, {
        error: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
        exitCode: 1,
      });
      execFileMock.mockCommand(/git symbolic-ref HEAD/, {
        stdout: 'refs/heads/trunk',
      });
      // The HEAD branch must actually resolve to a commit
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/trunk/, { stdout: 'abc123' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('trunk');
    });

    it('should default to main when HEAD points to unborn branch', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/master/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git symbolic-ref refs\/remotes\/origin\/HEAD/, {
        error: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
        exitCode: 1,
      });
      // HEAD says 'trunk' but the ref has no commits (unborn branch)
      execFileMock.mockCommand(/git symbolic-ref HEAD/, {
        stdout: 'refs/heads/trunk',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/trunk/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      // 'trunk' didn't resolve — falls through to the last-resort default
      expect(result).toBe('main');
    });

    it('should default to main when all detection methods fail', async () => {
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/master/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git symbolic-ref refs\/remotes\/origin\/HEAD/, {
        error: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
        exitCode: 1,
      });
      execFileMock.mockCommand(/git symbolic-ref HEAD/, {
        error: 'fatal: ref HEAD is not a symbolic ref',
        exitCode: 1,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getMainBranch('/path/to/repo');

      expect(result).toBe('main');
    });
  });

  describe('createWorktree', () => {
    it('should create worktree with new branch', async () => {
      vfs.setFile('/repo/.git/HEAD', 'ref: refs/heads/main');
      // Branch does not exist
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/feature-branch/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      // No remote — skip remote branch check
      execFileMock.mockCommand(/git remote get-url origin/, {
        error: 'fatal: No such remote',
        exitCode: 2,
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git worktree add -b feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.createWorktree(
        '/repo',
        'feature-branch',
        '/worktrees/feature-branch'
      );

      expect(result.path).toBe('/worktrees/feature-branch');
    });

    it('should create worktree with existing branch', async () => {
      // Branch exists
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/existing-branch/, {
        stdout: 'abc123',
      });
      // No remote — skip fetch and fast-forward
      execFileMock.mockCommand(/git remote get-url origin/, {
        error: 'fatal: No such remote',
        exitCode: 2,
      });
      execFileMock.mockCommand(/git worktree add \/worktrees\/existing-branch existing-branch/, {
        stdout: '',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.createWorktree(
        '/repo',
        'existing-branch',
        '/worktrees/existing-branch'
      );

      expect(result.path).toBe('/worktrees/existing-branch');
    });

    it('should throw error when worktree path already exists', async () => {
      // Need to mock existsSync to return true for the worktree path
      const mockExistsSync = vfs.mock.existsSync as ReturnType<typeof vi.fn>;
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/worktrees/feature-branch') return true;
        return vfs.hasFile(path) || vfs.hasDirectory(path);
      });

      const { gitService } = await import('../../../src/main/services/git.service');

      await expect(
        gitService.createWorktree('/repo', 'feature-branch', '/worktrees/feature-branch')
      ).rejects.toThrow('Worktree already exists');
    });

    it('should use base branch when creating new branch', async () => {
      // Branch does not exist
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/new-feature/, {
        error: 'fatal',
        exitCode: 128,
      });
      // No remote — skip remote branch check
      execFileMock.mockCommand(/git remote get-url origin/, {
        error: 'fatal: No such remote',
        exitCode: 2,
      });
      execFileMock.mockCommand(/git worktree add -b new-feature \/worktrees\/new-feature develop/, {
        stdout: '',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.createWorktree(
        '/repo',
        'new-feature',
        '/worktrees/new-feature',
        'develop'
      );

      expect(result.path).toBe('/worktrees/new-feature');
    });

    it('should replace slashes in branch names', async () => {
      // Branch does not exist
      execFileMock.mockCommand(/git rev-parse --verify refs\/heads\/feature\/my-branch/, {
        error: 'fatal',
        exitCode: 128,
      });
      // No remote — skip remote branch check
      execFileMock.mockCommand(/git remote get-url origin/, {
        error: 'fatal: No such remote',
        exitCode: 2,
      });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git worktree add -b feature\/my-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      // Default destination path should use safe branch name
      const result = await gitService.createWorktree('/repo', 'feature/my-branch');

      expect(result.path).toBe('/repo/.worktrees/feature-my-branch');
    });
  });

  describe('deleteWorktree', () => {
    it('should delete worktree successfully', async () => {
      vfs.setFile('/worktrees/feature-branch/file.txt', 'content');
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git worktree remove/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.deleteWorktree('/repo', '/worktrees/feature-branch');

      expect(vfs.hasFile('/worktrees/feature-branch/file.txt')).toBe(false);
    });

    it('should throw error when worktree has uncommitted changes without force', async () => {
      vfs.setFile('/worktrees/feature-branch/file.txt', 'content');
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });

      const { gitService } = await import('../../../src/main/services/git.service');

      await expect(
        gitService.deleteWorktree('/repo', '/worktrees/feature-branch', false)
      ).rejects.toThrow('uncommitted changes');
    });

    it('should delete worktree with force flag even with uncommitted changes', async () => {
      vfs.setFile('/worktrees/feature-branch/file.txt', 'content');
      execFileMock.mockCommand(/git worktree remove --force/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.deleteWorktree('/repo', '/worktrees/feature-branch', true);

      expect(vfs.hasFile('/worktrees/feature-branch/file.txt')).toBe(false);
    });

    it('should delete branch when requested', async () => {
      vfs.setFile('/worktrees/feature-branch/file.txt', 'content');
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git worktree remove/, { stdout: '' });
      execFileMock.mockCommand(/git branch -D feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.deleteWorktree('/repo', '/worktrees/feature-branch', false, {
        deleteBranch: true,
        branchName: 'feature-branch',
      });

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('branch -D feature-branch'))).toBe(true);
    });

    it('should not delete main or master branches', async () => {
      vfs.setFile('/worktrees/main/file.txt', 'content');
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git worktree remove/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.deleteWorktree('/repo', '/worktrees/main', false, {
        deleteBranch: true,
        branchName: 'main',
      });

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('branch -D main'))).toBe(false);
    });
  });

  describe('listWorktrees', () => {
    it('should parse worktree list output', async () => {
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout: `worktree /path/to/repo
HEAD abc1234567890
branch refs/heads/main

worktree /path/to/worktree1
HEAD def5678901234
branch refs/heads/feature/branch`,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listWorktrees('/path/to/repo');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: '/path/to/repo',
        commit: 'abc1234567890',
        branch: 'main',
      });
      expect(result[1]).toEqual({
        path: '/path/to/worktree1',
        commit: 'def5678901234',
        branch: 'feature/branch',
      });
    });

    it('should return empty array for empty output', async () => {
      execFileMock.mockCommand(/git worktree list --porcelain/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listWorktrees('/path/to/repo');

      expect(result).toEqual([]);
    });
  });

  describe('hasUncommittedChanges', () => {
    it.each([
      { status: 'M src/index.ts', expected: true },
      { status: '', expected: false },
    ])('returns $expected for status $status', async ({ status, expected }) => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: status });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.hasUncommittedChanges('/path/to/repo');

      expect(result).toBe(expected);
    });
  });

  describe('getChangedFiles', () => {
    beforeEach(() => {
      // Register worktree path as existing directory so existsSync check passes
      vfs.mock.writeFileSync('/path/to/repo/.git', '');
    });

    // The list aggregates staged and unstaged changes, so `staged` is always false.
    it.each([
      { line: ' M src/index.ts', path: 'src/index.ts', status: 'modified' },
      { line: 'M  src/index.ts', path: 'src/index.ts', status: 'modified' },
      { line: '?? newfile.ts', path: 'newfile.ts', status: 'untracked' },
      { line: 'A  src/new.ts', path: 'src/new.ts', status: 'added' },
      { line: ' D src/old.ts', path: 'src/old.ts', status: 'deleted' },
      // A malformed line falls back to a modified file.
      { line: '   weird-file.ts', path: 'weird-file.ts', status: 'modified' },
    ])('parses "$line" as $status', async ({ line, path, status }) => {
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: line });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getChangedFiles('/path/to/repo');

      expect(result).toEqual([{ path, status, staged: false, additions: 0, deletions: 0 }]);
    });

    it('should parse renamed files', async () => {
      execFileMock.mockCommand(/git status --porcelain -unormal/, {
        stdout: 'R  new.ts\0old.ts\0',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getChangedFiles('/path/to/repo');

      expect(result).toEqual([
        {
          path: 'new.ts',
          originalPath: 'old.ts',
          status: 'renamed',
          staged: false,
          additions: 0,
          deletions: 0,
        },
      ]);
    });

    it('should handle multiple files with different statuses', async () => {
      execFileMock.mockCommand(/git status --porcelain -unormal/, {
        stdout: 'M  staged.ts\0 M unstaged.ts\0A  added.ts\0?? untracked.ts\0',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getChangedFiles('/path/to/repo');

      expect(result).toHaveLength(4);
    });

    it('should return empty array for clean working directory', async () => {
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getChangedFiles('/path/to/repo');

      expect(result).toEqual([]);
    });
    it('should parse large status output deterministically', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => ` M src/file-${i}.ts\0`).join('');
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: lines });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getChangedFiles('/path/to/repo');

      expect(result).toHaveLength(500);
      expect(result[0]).toEqual({
        path: 'src/file-0.ts',
        status: 'modified',
        staged: false,
        additions: 0,
        deletions: 0,
      });
      expect(result[499].path).toBe('src/file-499.ts');
    });
  });

  describe('listBranches', () => {
    it('should list local branches sorted by recent commit', async () => {
      execFileMock.mockCommand(/git branch --sort=-committerdate --format/, {
        stdout: 'main\nfeature-a\nfeature-b',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listBranches('/path/to/repo');

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ name: 'main', isRemoteOnly: false });
      expect(result[1]).toEqual({ name: 'feature-a', isRemoteOnly: false });
    });

    it('should include remote branches when requested', async () => {
      execFileMock.mockCommand(/git branch --sort=-committerdate --format/, {
        stdout: 'main\nfeature-a',
      });
      execFileMock.mockCommand(/git branch -r --sort=-committerdate --format/, {
        stdout: 'origin/main\norigin/remote-only',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listBranches('/path/to/repo', true);

      expect(result).toHaveLength(4);
      expect(result.some((b) => b.name === 'remote-only' && b.isRemoteOnly)).toBe(true);
    });

    it('should return empty array when no branches exist', async () => {
      execFileMock.mockCommand(/git branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listBranches('/path/to/repo');

      expect(result).toEqual([]);
    });

    it('should filter out HEAD pointer from remote branches', async () => {
      execFileMock.mockCommand(/git branch --sort=-committerdate --format/, {
        stdout: 'main',
      });
      execFileMock.mockCommand(/git branch -r --sort=-committerdate --format/, {
        stdout: 'origin/HEAD\norigin/main\norigin/feature',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listBranches('/path/to/repo', true);

      expect(result.some((b) => b.name === 'HEAD')).toBe(false);
    });

    it('should fall back to local branches when remote listing fails', async () => {
      execFileMock.mockCommand(/git branch --sort=-committerdate --format/, {
        stdout: 'main\nfeature-a',
      });
      execFileMock.mockCommand(/git branch -r --sort=-committerdate --format/, {
        error: 'fatal: bad revision',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listBranches('/path/to/repo', true);

      expect(result).toEqual([
        { name: 'main', isRemoteOnly: false },
        { name: 'feature-a', isRemoteOnly: false },
      ]);
    });
  });

  describe('getFullFileDiff', () => {
    beforeEach(() => {
      // Register worktree path as existing directory so existsSync check passes
      vfs.mock.writeFileSync('/repo/.git', '');
    });

    it('should return diff content for modified file', async () => {
      vfs.setFile('/repo/src/index.ts', 'new content');
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: ' M src/index.ts' });
      execFileMock.mockCommand(/git diff --numstat HEAD -- src\/index\.ts/, {
        stdout: '5\t3\tsrc/index.ts',
      });
      execFileMock.mockCommand(/git show HEAD:src\/index\.ts/, { stdout: 'old content' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getFullFileDiff('/repo', 'src/index.ts');

      expect(result.path).toBe('src/index.ts');
      expect(result.oldContent).toBe('old content');
      expect(result.newContent).toBe('new content');
      expect(result.status).toBe('modified');
      expect(result.isBinary).toBe(false);
    });

    it('should handle untracked files', async () => {
      vfs.setFile('/repo/newfile.ts', 'new file content');
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: '?? newfile.ts' });
      execFileMock.mockCommand(/git diff --numstat HEAD -- newfile\.ts/, {
        error: 'not tracked',
        exitCode: 1,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getFullFileDiff('/repo', 'newfile.ts');

      expect(result.oldContent).toBeNull();
      expect(result.newContent).toBe('new file content');
      expect(result.status).toBe('untracked');
    });

    it('should detect binary files', async () => {
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: ' M image.png' });
      execFileMock.mockCommand(/git diff --numstat HEAD -- image\.png/, {
        stdout: '-\t-\timage.png',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getFullFileDiff('/repo', 'image.png');

      expect(result.isBinary).toBe(true);
      expect(result.oldContent).toBeNull();
      expect(result.newContent).toBeNull();
    });

    it('should handle deleted files', async () => {
      execFileMock.mockCommand(/git status --porcelain -unormal/, { stdout: ' D deleted.ts' });
      execFileMock.mockCommand(/git diff --numstat HEAD -- deleted\.ts/, {
        stdout: '0\t10\tdeleted.ts',
      });
      execFileMock.mockCommand(/git show HEAD:deleted\.ts/, { stdout: 'deleted content' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getFullFileDiff('/repo', 'deleted.ts');

      expect(result.oldContent).toBe('deleted content');
      expect(result.newContent).toBeNull();
      expect(result.status).toBe('deleted');
    });
  });

  describe('getRepoName', () => {
    it.each([
      {
        response: { stdout: 'https://github.com/user/my-repo.git' },
        repoPath: '/path/to/repo',
        expected: 'my-repo',
      },
      {
        response: { stdout: 'git@github.com:user/my-repo.git' },
        repoPath: '/path/to/repo',
        expected: 'my-repo',
      },
      // Without a remote, the folder name is the repo name.
      {
        response: { error: 'fatal: No such remote', exitCode: 2 },
        repoPath: '/path/to/my-local-repo',
        expected: 'my-local-repo',
      },
    ])('returns $expected for remote $response', async ({ response, repoPath, expected }) => {
      execFileMock.mockCommand(/git remote get-url origin/, response);

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getRepoName(repoPath);

      expect(result).toBe(expected);
    });
  });

  describe('getRemoteUrl', () => {
    it('should return remote origin URL', async () => {
      execFileMock.mockCommand(/git remote get-url origin/, {
        stdout: 'https://github.com/user/repo.git',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getRemoteUrl('/path/to/repo');

      expect(result).toBe('https://github.com/user/repo.git');
    });

    it('should return null when no remote exists', async () => {
      execFileMock.mockCommand(/git remote get-url origin/, {
        error: 'fatal: No such remote',
        exitCode: 2,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getRemoteUrl('/path/to/repo');

      expect(result).toBeNull();
    });
  });

  describe('getRepoWebInfo', () => {
    it.each([
      {
        remote: 'https://github.com/user/repo.git',
        provider: 'github',
        webUrl: 'https://github.com/user/repo',
      },
      {
        remote: 'git@github.com:user/repo.git',
        provider: 'github',
        webUrl: 'https://github.com/user/repo',
      },
      {
        remote: 'https://gitlab.com/user/repo.git',
        provider: 'gitlab',
        webUrl: 'https://gitlab.com/user/repo',
      },
      {
        remote: 'https://bitbucket.org/user/repo.git',
        provider: 'bitbucket',
        webUrl: 'https://bitbucket.org/user/repo',
      },
      {
        remote: 'https://custom-git.company.com/user/repo.git',
        provider: 'unknown',
        webUrl: 'https://custom-git.company.com/user/repo',
      },
    ])('detects $provider from $remote', async ({ remote, provider, webUrl }) => {
      execFileMock.mockCommand(/git remote get-url origin/, { stdout: remote });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getRepoWebInfo('/path/to/repo');

      expect(result).toMatchObject({ provider, webUrl });
    });
  });

  describe('switchBranch', () => {
    it('should switch to target branch', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'main' });
      execFileMock.mockCommand(/git switch feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.switchBranch('/path/to/repo', 'feature-branch');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Switched to branch feature-branch');
    });

    it('should return success when already on target branch', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'main' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.switchBranch('/path/to/repo', 'main');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Already on branch main');
    });

    it('should fail when there are uncommitted changes', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.switchBranch('/path/to/repo', 'feature-branch');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Commit or stash');
    });

    it('should fall back to checkout for older git versions', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'main' });
      execFileMock.mockCommand(/git switch feature-branch/, {
        error: 'git: switch is not a git command',
        exitCode: 1,
      });
      execFileMock.mockCommand(/git checkout feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.switchBranch('/path/to/repo', 'feature-branch');

      expect(result.success).toBe(true);
    });
  });

  describe('push', () => {
    it('should push to remote successfully', async () => {
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git config --get branch\.feature-branch\.remote/, {
        stdout: 'origin',
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref feature-branch@\{upstream\}/, {
        stdout: 'origin/feature-branch',
      });
      execFileMock.mockCommand(/git rev-list --count origin\/feature-branch\.\.feature-branch/, {
        stdout: '2',
      });

      const { gitService } = await import('../../../src/main/services/git.service');

      // Start the push
      const pushPromise = gitService.push('/path/to/repo');

      await vi.waitFor(() => {
        expect(spawnMock.spawn).toHaveBeenCalled();
      });

      // Simulate successful push
      const proc = spawnMock.getLatestProcess();
      expect(proc).toBeDefined();
      proc!.stdout.emit('data', 'Everything up-to-date');
      proc!.emit('close', 0);

      const result = await pushPromise;

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 commits');
    });

    it('should publish branch when no remote tracking exists', async () => {
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'new-branch' });
      execFileMock.mockCommand(/git config --get branch\.new-branch\.remote/, {
        error: 'not found',
        exitCode: 1,
      });
      // Fallback check for remote ref also fails
      execFileMock.mockCommand(/git rev-parse --verify origin\/new-branch/, {
        error: 'not found',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');

      const pushPromise = gitService.push('/path/to/repo');

      await vi.waitFor(() => {
        expect(spawnMock.spawn).toHaveBeenCalled();
      });

      const proc = spawnMock.getLatestProcess();
      expect(proc).toBeDefined();
      proc!.emit('close', 0);

      const result = await pushPromise;

      expect(result.success).toBe(true);
      expect(result.message).toContain('Published');
    });

    it('should surface stderr when push fails', async () => {
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git config --get branch\.feature-branch\.remote/, {
        stdout: 'origin',
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref feature-branch@\{upstream\}/, {
        stdout: 'origin/feature-branch',
      });
      execFileMock.mockCommand(/git rev-list --count origin\/feature-branch\.\.feature-branch/, {
        stdout: '1',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const pushPromise = gitService.push('/path/to/repo');

      await vi.waitFor(() => {
        expect(spawnMock.spawn).toHaveBeenCalled();
      });

      const proc = spawnMock.getLatestProcess();
      expect(proc).toBeDefined();
      proc!.stderr.emit('data', 'fatal: authentication failed');
      proc!.emit('close', 1);

      const result = await pushPromise;
      expect(result.success).toBe(false);
      expect(result.message).toContain('authentication failed');
    });
  });

  describe('pull', () => {
    it('should fail when there are uncommitted changes', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.pull('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Commit or stash');
    });

    it('should fail when no remote tracking branch exists', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'local-branch' });
      execFileMock.mockCommand(/git config --get branch\.local-branch\.remote/, {
        error: 'not found',
        exitCode: 1,
      });
      // Fallback check for remote ref also fails
      execFileMock.mockCommand(/git rev-parse --verify origin\/local-branch/, {
        error: 'not found',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.pull('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('No remote tracking branch');
    });

    it('should pull successfully when tracking branch exists via remote ref fallback', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'topic' });
      execFileMock.mockCommand(/git config --get branch\.topic\.remote/, {
        error: 'not found',
        exitCode: 1,
      });
      execFileMock.mockCommand(/git rev-parse --verify origin\/topic/, {
        stdout: 'abc123',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const pullPromise = gitService.pull('/path/to/repo');

      await vi.waitFor(() => {
        expect(spawnMock.spawn).toHaveBeenCalled();
      });

      const proc = spawnMock.getLatestProcess();
      expect(proc).toBeDefined();
      proc!.stdout.emit('data', 'From origin\nAlready up to date.');
      proc!.emit('close', 0);

      const result = await pullPromise;
      expect(result.success).toBe(true);
      expect(result.message).toBe('Already up to date');
    });

    it('should parse pull conflicts from status output after failure', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git config --get branch\.feature-branch\.remote/, {
        stdout: 'origin',
      });

      const baseImpl = execFileMock.execFile.getMockImplementation();
      let statusCalls = 0;
      execFileMock.execFile.mockImplementation(
        (file: string, args?: string[] | unknown, opts?: unknown, cb?: unknown) => {
          let actualArgs: string[] = [];
          let callback: ((e: Error | null, stdout: string, stderr: string) => void) | undefined;
          if (Array.isArray(args)) {
            actualArgs = args;
            if (typeof opts === 'function') {
              callback = opts as (e: Error | null, stdout: string, stderr: string) => void;
            } else {
              callback = cb as (e: Error | null, stdout: string, stderr: string) => void;
            }
          }
          const cmd = `${file} ${actualArgs.join(' ')}`;
          if (cmd.includes('git status --porcelain')) {
            statusCalls++;
            const stdout = statusCalls === 1 ? '' : 'UU conflicted.ts';
            setImmediate(() => callback?.(null, stdout, ''));
            return { pid: 1 };
          }
          return baseImpl ? baseImpl(file, args, opts, cb) : ({ pid: 1 } as { pid: number });
        }
      );

      const { gitService } = await import('../../../src/main/services/git.service');
      try {
        const pullPromise = gitService.pull('/path/to/repo');

        await vi.waitFor(() => {
          expect(spawnMock.spawn).toHaveBeenCalled();
        });

        const proc = spawnMock.getLatestProcess();
        expect(proc).toBeDefined();
        proc!.stderr.emit('data', 'fatal: not possible to fast-forward, aborting.');
        proc!.emit('close', 1);

        const result = await pullPromise;
        expect(result.success).toBe(false);
        expect(result.message).toContain('Pull paused');
        expect(result.message).toContain('conflicted.ts');
        expect(result.message).not.toContain('coding agent');
      } finally {
        if (baseImpl) {
          execFileMock.execFile.mockImplementation(baseImpl);
        }
      }
    });
  });

  describe('rebaseOnTargetBranch', () => {
    it('should rebase on main branch successfully', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rebase main/, { stdout: 'Successfully rebased' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.rebaseOnTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Rebased on main');
    });

    it('should fail when there are uncommitted changes', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.rebaseOnTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Commit or stash');
    });

    it('should return up to date when already rebased', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rebase main/, {
        stdout: 'Current branch feature is up to date.',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.rebaseOnTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toContain('up to date');
    });

    it('should leave rebase conflicts active with agent-ready context', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rebase main/, {
        error: 'CONFLICT (content): Merge conflict in src/conflict.ts',
        exitCode: 1,
      });

      const baseImpl = execFileMock.execFile.getMockImplementation();
      let statusCalls = 0;
      execFileMock.execFile.mockImplementation(
        (file: string, args?: string[] | unknown, opts?: unknown, cb?: unknown) => {
          let actualArgs: string[] = [];
          let callback: ((e: Error | null, stdout: string, stderr: string) => void) | undefined;
          if (Array.isArray(args)) {
            actualArgs = args;
            if (typeof opts === 'function') {
              callback = opts as (e: Error | null, stdout: string, stderr: string) => void;
            } else {
              callback = cb as (e: Error | null, stdout: string, stderr: string) => void;
            }
          }
          const cmd = `${file} ${actualArgs.join(' ')}`;
          if (cmd.includes('git status --porcelain')) {
            statusCalls++;
            const stdout = statusCalls === 1 ? '' : 'UU src/conflict.ts';
            setImmediate(() => callback?.(null, stdout, ''));
            return { pid: 1 };
          }
          return baseImpl ? baseImpl(file, args, opts, cb) : ({ pid: 1 } as { pid: number });
        }
      );
      execFileMock.mockCommand(/git rebase --abort/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      try {
        const result = await gitService.rebaseOnTargetBranch('/path/to/repo');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Rebase onto main paused');
        expect(result.message).toContain('src/conflict.ts');
        expect(result.message).not.toContain('coding agent');
        const commands = execFileMock.getAllCommands();
        expect(commands.some((cmd: string) => cmd.includes('git rebase --abort'))).toBe(false);
      } finally {
        if (baseImpl) {
          execFileMock.execFile.mockImplementation(baseImpl);
        }
      }
    });

    it('should surface rebase error when no conflict markers are present', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rebase main/, {
        error: 'fatal: invalid upstream main',
        exitCode: 1,
      });
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.rebaseOnTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid upstream');
    });
  });

  describe('mergeToTargetBranch', () => {
    // syncTargetBranchForMerge uses execGitWithProgress (spawn) for the fetch.
    // Auto-complete spawned git processes so tests don't hang.
    let originalSpawnImpl: ReturnType<typeof spawnMock.spawn.getMockImplementation>;
    beforeEach(() => {
      originalSpawnImpl = spawnMock.spawn.getMockImplementation();
      spawnMock.spawn.mockImplementation(
        (command: string, args: string[] = [], options?: unknown) => {
          const proc = originalSpawnImpl!(command, args, options);
          setImmediate(() => proc.emit('close', 0));
          return proc;
        }
      );
    });
    afterEach(() => {
      if (originalSpawnImpl) spawnMock.spawn.mockImplementation(originalSpawnImpl);
    });

    it('should merge branch to main successfully', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      execFileMock.mockCommand(/git checkout main/, { stdout: '' });
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, { stdout: '' });
      execFileMock.mockCommand(/git checkout feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Fast-forwarded main to feature-branch');
    });

    it('should fail when branch is behind main', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '5' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'Branch is 5 commits behind main — update your branch from main first'
      );
    });

    it('should fail when already on main branch', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'main' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Already on the main branch');
    });

    it('should merge via worktree when target branch is already checked out elsewhere', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      // Checkout fails because main is in another worktree
      execFileMock.mockCommand(/git checkout main/, {
        error: "fatal: 'main' is already checked out at '/other/worktree'",
        exitCode: 1,
      });
      // listWorktrees returns the worktree that has main
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout:
          'worktree /other/worktree\nHEAD abc123\nbranch refs/heads/main\n\nworktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      // Merge runs in the other worktree
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Fast-forwarded main to feature-branch');
    });
    it('should fail when ff-only merge in worktree fails', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      // main is checked out in another worktree
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout:
          'worktree /other/worktree\nHEAD abc123\nbranch refs/heads/main\n\nworktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      // No remote tracking ref — skip sync
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      // ff-only merge fails in the target worktree
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, {
        error: 'fatal: Not possible to fast-forward, aborting.',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Not possible to fast-forward');
    });

    it('should fail when target worktree has uncommitted changes', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      // main is checked out in another worktree
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout:
          'worktree /other/worktree\nHEAD abc123\nbranch refs/heads/main\n\nworktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      // No remote tracking ref — skip sync
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      // Target worktree is dirty
      execFileMock.mockCommand(/git status --porcelain/, { stdout: ' M dirty-file.ts' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('uncommitted changes');
    });

    it('should fail when rev-list comparison fails during sync', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout: 'worktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, { stdout: 'origin123' });

      // rev-list fails (e.g. corrupt ref)
      execFileMock.mockCommand(/git rev-list --left-right --count refs\/remotes\/origin\/main\.\.\.refs\/heads\/main/, {
        error: 'fatal: bad object main',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('bad object');
    });

    it('should fetch target branch when not checked out elsewhere', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      // No worktree has main checked out
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout: 'worktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, { stdout: 'origin123' });

      execFileMock.mockCommand(/git rev-list --left-right --count refs\/remotes\/origin\/main\.\.\.refs\/heads\/main/, {
        stdout: '0\t0',
      });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      execFileMock.mockCommand(/git checkout main/, { stdout: '' });
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, { stdout: '' });
      execFileMock.mockCommand(/git checkout feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(spawnMock.spawn).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['fetch', 'origin', 'main']),
        expect.anything()
      );
    });

    it('should fast-forward target worktree from origin when checked out elsewhere', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      // main is checked out in another worktree
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout:
          'worktree /other/worktree\nHEAD abc123\nbranch refs/heads/main\n\nworktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, { stdout: 'origin123' });

      execFileMock.mockCommand(/git rev-list --left-right --count refs\/remotes\/origin\/main\.\.\.refs\/heads\/main/, {
        stdout: '1\t0',
      });
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git merge --ff-only origin\/main/, { stdout: '' });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      // Should NOT attempt checkout since target is already found in another worktree
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      const commands = execFileMock.getAllCommands();
      expect(commands).toEqual(
        expect.arrayContaining([expect.stringMatching(/git.*merge --ff-only origin\/main/)])
      );
      // Should NOT attempt to checkout main in current worktree
      const checkoutIdx = commands.findIndex((c: string) => /checkout main/.test(c));
      expect(checkoutIdx).toBe(-1);
    });

    it('should proceed with local state when fetch fails', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout: 'worktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, { stdout: 'origin123' });
      // Override spawn to simulate fetch failure (SSH, network, etc.)
      spawnMock.spawn.mockImplementation(
        (command: string, args: string[] = [], options?: unknown) => {
          const proc = originalSpawnImpl!(command, args, options);
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from('fatal: unable to access remote'));
            proc.emit('close', 128);
          });
          return proc;
        }
      );
      // After fetch fails, merge should proceed with local state
      execFileMock.mockCommand(/git rev-list --left-right --count/, { stdout: '0\t0' });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '2' });
      execFileMock.mockCommand(/git checkout main/, { stdout: '' });
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, { stdout: '' });
      execFileMock.mockCommand(/git checkout feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Fast-forwarded main to feature-branch');
    });

    it('should fail when local target branch has diverged from remote', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      // main is checked out in another worktree
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout:
          'worktree /other/worktree\nHEAD abc123\nbranch refs/heads/main\n\nworktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, { stdout: 'origin123' });

      execFileMock.mockCommand(/git rev-list --left-right --count refs\/remotes\/origin\/main\.\.\.refs\/heads\/main/, {
        stdout: '1\t1',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(false);
      expect(result.message).toContain('has diverged from origin/main');
      const commands = execFileMock.getAllCommands();
      expect(commands).not.toEqual(expect.arrayContaining([expect.stringMatching(/update-ref/)]));
      expect(commands).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/merge --ff-only feature-branch/)])
      );
    });

    it('should skip sync when target branch has no remote tracking ref', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout: 'worktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      // No remote tracking ref for main
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, {
        error: 'fatal: Needed a single revision',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });
      execFileMock.mockCommand(/git checkout main/, { stdout: '' });
      execFileMock.mockCommand(/git merge --ff-only feature-branch/, { stdout: '' });
      execFileMock.mockCommand(/git checkout feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      expect(spawnMock.spawn).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['fetch']),
        expect.anything()
      );
    });

    it('should update local target ref from origin when target branch is not checked out elsewhere', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout: 'worktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main/, { stdout: 'origin123' });

      execFileMock.mockCommand(/git rev-list --left-right --count refs\/remotes\/origin\/main\.\.\.refs\/heads\/main/, {
        stdout: '1\t0',
      });
      execFileMock.mockCommand(/git rev-parse --verify refs\/remotes\/origin\/main\^\{commit\}/, {
        stdout: 'origin123',
      });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '0' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeToTargetBranch('/path/to/repo');

      expect(result.success).toBe(true);
      const commands = execFileMock.getAllCommands();
      expect(commands).toEqual(
        expect.arrayContaining([expect.stringMatching(/fetch .* \. origin123:refs\/heads\/main/)])
      );
      expect(commands).not.toEqual(expect.arrayContaining([expect.stringMatching(/git checkout/)]));
    });
  });

  describe('mergeTargetBranchFromRemote', () => {
    it('should merge origin/main into main where main is checked out, from a non-main branch', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git worktree list --porcelain/, {
        stdout:
          'worktree /path/to/repo\nHEAD def456\nbranch refs/heads/feature-branch\n\nworktree /path/to/main\nHEAD abc123\nbranch refs/heads/main',
      });
      execFileMock.mockCommand(/git merge origin\/main/, {
        stdout: 'Merge made by the ort strategy.',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeTargetBranchFromRemote('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Merged origin/main into main');
      expect(execFileMock.getAllCommands()).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/git checkout/)])
      );
    });

    it('should not fail early on dirty selected workspace when merging main from remote', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });
      execFileMock.mockCommand(/git checkout main/, { stdout: '' });
      execFileMock.mockCommand(/git merge origin\/main/, { stdout: 'Already up to date.' });
      execFileMock.mockCommand(/git checkout feature-branch/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeTargetBranchFromRemote('/path/to/repo');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Already up to date');
      expect(execFileMock.getAllCommands()).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/git status --porcelain/)])
      );
    });
  });

  describe('isBareRepo', () => {
    it.each([
      { answer: 'true', expected: true },
      { answer: 'false', expected: false },
    ])('returns $expected when git answers $answer', async ({ answer, expected }) => {
      execFileMock.mockCommand(/git rev-parse --is-bare-repository/, { stdout: answer });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.isBareRepo('/path/to/repo');

      expect(result).toBe(expected);
    });
  });

  describe('cloneBare', () => {
    it('should create a bare clone', async () => {
      execFileMock.mockCommand(/git clone --bare/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.cloneBare('/source/repo', '/dest/repo.git');

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('clone --bare'))).toBe(true);
    });

    it('should throw error on clone failure', async () => {
      execFileMock.mockCommand(/git clone --bare/, {
        error: 'fatal: repository not found',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');

      await expect(gitService.cloneBare('/source/repo', '/dest/repo.git')).rejects.toThrow();
    });
  });

  describe('fetchFromRemote', () => {
    it('should fetch all branches successfully', async () => {
      execFileMock.mockCommand(
        /git for-each-ref --format=%\(refname\) %\(objectname\) refs\/remotes\//,
        {
          stdout: '',
        }
      );

      const { gitService } = await import('../../../src/main/services/git.service');

      const fetchPromise = gitService.fetchFromRemote('/path/to/repo');

      await vi.waitFor(() => {
        expect(spawnMock.spawn).toHaveBeenCalled();
      });

      const proc = spawnMock.getLatestProcess();
      expect(proc).toBeDefined();
      proc!.emit('close', 0);

      const result = await fetchPromise;

      expect(result.success).toBe(true);
    });

    it('should ignore malformed refs and invalidate branch caches after fetch', async () => {
      execFileMock.mockCommand('git rev-parse --abbrev-ref HEAD', { stdout: 'main' });
      execFileMock.mockCommand('git rev-parse --verify refs/heads/main', { stdout: 'abc123' });

      const beforeRefs = `refs/remotes/origin/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
malformed ref line`;
      const afterRefs = `refs/remotes/origin/main bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
also-malformed`;
      let refCalls = 0;
      const baseImpl = execFileMock.execFile.getMockImplementation();
      execFileMock.execFile.mockImplementation(
        (file: string, args?: string[] | unknown, opts?: unknown, cb?: unknown) => {
          let actualArgs: string[] = [];
          let callback: ((e: Error | null, stdout: string, stderr: string) => void) | undefined;
          if (Array.isArray(args)) {
            actualArgs = args;
            if (typeof opts === 'function') {
              callback = opts as (e: Error | null, stdout: string, stderr: string) => void;
            } else {
              callback = cb as (e: Error | null, stdout: string, stderr: string) => void;
            }
          }
          const cmd = `${file} ${actualArgs.join(' ')}`;
          if (cmd.includes('git for-each-ref --format=%(refname) %(objectname) refs/remotes/')) {
            refCalls++;
            const stdout = refCalls === 1 ? beforeRefs : afterRefs;
            setImmediate(() => callback?.(null, stdout, ''));
            return { pid: 1 };
          }
          return baseImpl ? baseImpl(file, args, opts, cb) : ({ pid: 1 } as { pid: number });
        }
      );
      execFileMock.mockCommand(/git rev-list --count a{40}\.\.b{40}/, { stdout: '3' });

      const { gitService } = await import('../../../src/main/services/git.service');
      try {
        // Prime cache values that fetchFromRemote should invalidate
        expect(await gitService.getCurrentBranch('/path/to/repo')).toBe('main');
        expect(await gitService.getMainBranch('/path/to/repo')).toBe('main');

        // Change branch resolver output to ensure we observe invalidation
        execFileMock.mockCommand('git rev-parse --abbrev-ref HEAD', { stdout: 'feature-updated' });
        execFileMock.mockCommand('git rev-parse --verify refs/heads/main', {
          error: 'fatal: Needed a single revision',
          exitCode: 128,
        });
        execFileMock.mockCommand('git rev-parse --verify refs/heads/master', { stdout: 'def456' });

        const fetchPromise = gitService.fetchFromRemote('/path/to/repo');

        await vi.waitFor(() => {
          expect(spawnMock.spawn).toHaveBeenCalled();
        });

        const proc = spawnMock.getLatestProcess();
        expect(proc).toBeDefined();
        proc!.emit('close', 0);

        const result = await fetchPromise;
        expect(result.success).toBe(true);
        expect(result.message).toContain('3 new commits');

        // If caches were not invalidated, these would still return the original cached values.
        expect(await gitService.getCurrentBranch('/path/to/repo')).toBe('feature-updated');
        expect(await gitService.getMainBranch('/path/to/repo')).toBe('master');
      } finally {
        if (baseImpl) {
          execFileMock.execFile.mockImplementation(baseImpl);
        }
      }
    });
  });

  describe('restoreFile', () => {
    it('should restore modified file from HEAD', async () => {
      execFileMock.mockCommand(/git checkout HEAD -- src\/index\.ts/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.restoreFile('/repo', 'src/index.ts', 'modified');

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('checkout HEAD'))).toBe(true);
    });

    it('should delete untracked file', async () => {
      vfs.setFile('/repo/newfile.ts', 'content');

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.restoreFile('/repo', 'newfile.ts', 'untracked');

      expect(vfs.hasFile('/repo/newfile.ts')).toBe(false);
    });

    it('should invalidate hasUncommittedChanges cache after restore', async () => {
      execFileMock.mockCommand('git status --porcelain', { stdout: 'M src/index.ts' });
      execFileMock.mockCommand(/git checkout HEAD -- src\/index\.ts/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      expect(await gitService.hasUncommittedChanges('/repo')).toBe(true);

      // Update status response and restore the file; restoreFile should invalidate cache.
      execFileMock.mockCommand('git status --porcelain', { stdout: '' });
      await gitService.restoreFile('/repo', 'src/index.ts', 'modified');

      expect(await gitService.hasUncommittedChanges('/repo')).toBe(false);
    });

    it('should fall back to manual delete when git rm fails for added files', async () => {
      vfs.setFile('/repo/src/new.ts', 'content');
      execFileMock.mockCommand(/git rm -f -- :\(literal\)src\/new\.ts/, {
        error: 'fatal: pathspec did not match any files',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.restoreFile('/repo', 'src/new.ts', 'added');

      expect(vfs.hasFile('/repo/src/new.ts')).toBe(false);
    });
  });

  describe('listFiles', () => {
    it('should list files using git ls-files for git repos', async () => {
      // Ensure worktree path exists in VFS so listFiles doesn't bail early
      vfs.mock.writeFileSync('/path/to/repo/.git', '');
      execFileMock.mockCommand(/git rev-parse --git-dir/, { stdout: '.git' });
      execFileMock.mockCommand(/git ls-files -z --cached --others --exclude-standard/, {
        stdout: 'src/index.ts\0src/utils.ts\0package.json\0',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listFiles('/path/to/repo');

      expect(result.files).toHaveLength(3);
      expect(result.files).toContain('src/index.ts');
    });

    it('should include git-ignored files when requested', async () => {
      // Ensure worktree path exists in VFS so listFiles doesn't bail early
      vfs.mock.writeFileSync('/path/to/repo/.git', '');
      execFileMock.mockCommand(/git rev-parse --git-dir/, { stdout: '.git' });
      execFileMock.mockCommand(/git ls-files -z --cached --others --exclude-standard/, {
        stdout: 'src/index.ts',
      });
      execFileMock.mockCommand(/git ls-files -z --others --ignored --exclude-standard/, {
        stdout: 'node_modules/lib.js\0.env\0',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.listFiles('/path/to/repo', true);

      expect(result.files).toContain('src/index.ts');
      expect(result.gitIgnoredFiles).toContain('.env');
    });
  });

  describe('getCommitsBehindTargetBranch', () => {
    it('should return number of commits behind main', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-list --count feature-branch\.\.main/, { stdout: '5' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCommitsBehindTargetBranch('/path/to/repo');

      expect(result).toBe(5);
    });

    it('should return 0 when on main branch', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'main' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCommitsBehindTargetBranch('/path/to/repo');

      expect(result).toBe(0);
    });
  });

  describe('getCommitsAheadTargetBranch', () => {
    it('should return number of commits ahead of main', async () => {
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-list --count main\.\.feature-branch/, { stdout: '3' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCommitsAheadTargetBranch('/path/to/repo');

      expect(result).toBe(3);
    });
  });

  describe('getAheadBehind', () => {
    it('should return ahead/behind counts', async () => {
      execFileMock.mockCommand(/git rev-list --left-right --count main\.\.\.feature/, {
        stdout: '2\t5',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getAheadBehind('/repo', 'feature', 'main');

      expect(result.ahead).toBe(5);
      expect(result.behind).toBe(2);
    });

    it('should return zeros on error', async () => {
      execFileMock.mockCommand(/git rev-list --left-right --count/, {
        error: 'fatal',
        exitCode: 1,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getAheadBehind('/repo', 'nonexistent', 'main');

      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
    });

    it('should handle malformed non-numeric output safely', async () => {
      execFileMock.mockCommand(/git rev-list --left-right --count main\.\.\.feature/, {
        stdout: 'not-a-number\tstill-not-a-number',
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getAheadBehind('/repo', 'feature', 'main');

      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
    });
  });

  describe('initRepo', () => {
    it('should initialize a new git repository', async () => {
      execFileMock.mockCommand(/git init/, { stdout: 'Initialized empty Git repository' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.initRepo('/path/to/new/repo');

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('git init'))).toBe(true);
    });
  });

  describe('addRemote', () => {
    it('should add a remote to repository', async () => {
      execFileMock.mockCommand(/git remote add -- origin/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.addRemote('/repo', 'origin', 'https://github.com/user/repo.git');

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('remote add -- origin'))).toBe(true);
    });
  });

  describe('removeRemote', () => {
    it('should remove a remote from repository', async () => {
      execFileMock.mockCommand(/git remote remove origin/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.removeRemote('/repo', 'origin');

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('remote remove origin'))).toBe(true);
    });

    it('should not throw when remote does not exist', async () => {
      execFileMock.mockCommand(/git remote remove nonexistent/, {
        error: 'fatal: No such remote',
        exitCode: 2,
      });

      const { gitService } = await import('../../../src/main/services/git.service');

      // Should not throw
      await gitService.removeRemote('/repo', 'nonexistent');
    });
  });

  describe('hasRemote', () => {
    it.each([
      {
        remote: 'origin',
        response: { stdout: 'https://github.com/user/repo.git' },
        expected: true,
      },
      {
        remote: 'nonexistent',
        response: { error: 'fatal: No such remote', exitCode: 2 },
        expected: false,
      },
    ])('returns $expected for $remote', async ({ remote, response, expected }) => {
      execFileMock.mockCommand(new RegExp(`git remote get-url ${remote}`), response);

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.hasRemote('/repo', remote);

      expect(result).toBe(expected);
    });
  });

  describe('getBranchUrl', () => {
    it.each([
      {
        remote: 'https://github.com/user/repo.git',
        branch: 'feature-branch',
        expected: 'https://github.com/user/repo/tree/feature-branch',
      },
      {
        remote: 'https://gitlab.com/user/repo.git',
        branch: 'main',
        expected: 'https://gitlab.com/user/repo/-/tree/main',
      },
    ])('returns $expected', async ({ remote, branch, expected }) => {
      execFileMock.mockCommand(/git remote get-url origin/, { stdout: remote });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: branch });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getBranchUrl('/repo');

      expect(result).toBe(expected);
    });

    it('should encode branch names with special characters', async () => {
      execFileMock.mockCommand(/git remote get-url origin/, {
        stdout: 'https://github.com/user/repo.git',
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature/my branch' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getBranchUrl('/repo');

      expect(result).toContain('feature%2Fmy%20branch');
    });
  });

  describe('getCreatePrUrl', () => {
    it('should return GitHub PR creation URL', async () => {
      execFileMock.mockCommand(/git remote get-url origin/, {
        stdout: 'https://github.com/user/repo.git',
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCreatePrUrl('/repo');

      expect(result).toBe('https://github.com/user/repo/compare/main...feature-branch?expand=1');
    });

    it('should return GitLab MR creation URL', async () => {
      execFileMock.mockCommand(/git remote get-url origin/, {
        stdout: 'https://gitlab.com/user/repo.git',
      });
      execFileMock.mockCommand(/git rev-parse --abbrev-ref HEAD/, { stdout: 'feature-branch' });
      execFileMock.mockCommand(/git rev-parse --verify main/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git rev-parse --verify master/, {
        error: 'fatal',
        exitCode: 128,
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.getCreatePrUrl('/repo');

      expect(result).toContain('merge_requests/new');
      expect(result).toContain('source_branch]=feature-branch');
    });
  });

  describe('mergeFrom', () => {
    it('should merge branch successfully', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: '' });
      execFileMock.mockCommand(/git merge main/, { stdout: 'Merge made by fast-forward' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeFrom('/repo', 'main');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Merged main');
    });

    it('should fail when there are uncommitted changes', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeFrom('/repo', 'main');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Commit or stash');
    });

    it('should stash and merge when stash option is true and there are changes', async () => {
      execFileMock.mockCommand(/git status --porcelain/, { stdout: 'M file.txt' });
      execFileMock.mockCommand(/git stash create/, { stdout: 'abc123' });
      execFileMock.mockCommand(/git reset --hard HEAD/, { stdout: '' });
      execFileMock.mockCommand(/git merge main/, { stdout: 'Merge made by fast-forward' });
      execFileMock.mockCommand(/git stash apply abc123/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.mergeFrom('/repo', 'main', { stash: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Merged main');
    });

    it('should detect merge conflicts', async () => {
      // First status check - clean
      let statusCallCount = 0;
      execFileMock.mockCommand(/git status --porcelain/, {
        stdout: '',
      });
      // Override execFile to handle the two different status calls
      const baseImpl = execFileMock.execFile.getMockImplementation();
      execFileMock.execFile.mockImplementation(
        (file: string, args?: string[] | unknown, opts?: unknown, cb?: unknown) => {
          // Resolve callback from overloaded args
          let actualArgs: string[] = [];
          let callback: ((e: Error | null, stdout: string, stderr: string) => void) | undefined;
          if (Array.isArray(args)) {
            actualArgs = args;
            if (typeof opts === 'function') {
              callback = opts as (e: Error | null, stdout: string, stderr: string) => void;
            } else {
              callback = cb as (e: Error | null, stdout: string, stderr: string) => void;
            }
          }
          const cmd = `${file} ${actualArgs.join(' ')}`;

          if (cmd.includes('git status --porcelain')) {
            statusCallCount++;
            if (statusCallCount === 1) {
              // First call - clean status for pre-merge check
              setImmediate(() => callback?.(null, '', ''));
            } else {
              // Second call - conflict status after merge
              setImmediate(() => callback?.(null, 'UU conflicted.txt', ''));
            }
            return { pid: 1 };
          }
          if (cmd.includes('git merge main')) {
            const error = Object.assign(new Error('CONFLICT'), { code: 1 });
            setImmediate(() => callback?.(error, '', 'CONFLICT'));
            return { pid: 1 };
          }
          return baseImpl ? baseImpl(file, args, opts, cb) : ({ pid: 1 } as { pid: number });
        }
      );

      const { gitService } = await import('../../../src/main/services/git.service');
      try {
        const result = await gitService.mergeFrom('/repo', 'main');

        expect(result.success).toBe(false);
        expect(result.message.toLowerCase()).toContain('conflict');
      } finally {
        if (baseImpl) {
          execFileMock.execFile.mockImplementation(baseImpl);
        }
      }
    });
  });

  describe('fileExists', () => {
    it('should return true when file exists', async () => {
      vfs.setFile('/repo/src/index.ts', 'content');

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.fileExists('/repo', 'src/index.ts');

      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.fileExists('/repo', 'nonexistent.ts');

      expect(result).toBe(false);
    });
  });

  describe('deleteFile', () => {
    it('should restore deleted files from HEAD', async () => {
      execFileMock.mockCommand(/git checkout HEAD -- src\/gone\.ts/, { stdout: '' });

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.deleteFile('/repo', 'src/gone.ts', 'deleted');

      const commands = execFileMock.getAllCommands();
      expect(commands.some((cmd: string) => cmd.includes('git checkout HEAD -- src/gone.ts'))).toBe(
        true
      );
    });
  });

  describe('writeFile', () => {
    it('should write content to file', async () => {
      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.writeFile('/repo', 'new-file.ts', 'const x = 1;');

      expect(vfs.getFile('/repo/new-file.ts')?.toString()).toBe('const x = 1;');
    });

    it('should propagate write failures', async () => {
      (vfs.mock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { gitService } = await import('../../../src/main/services/git.service');
      await expect(gitService.writeFile('/repo', 'new-file.ts', 'x')).rejects.toThrow('EACCES');
    });
  });

  describe('copyFile', () => {
    it('should copy file to destination', async () => {
      vfs.setFile('/repo/src/original.ts', 'original content');

      const { gitService } = await import('../../../src/main/services/git.service');
      await gitService.copyFile('/repo', 'src/original.ts', 'src/copy.ts');

      expect(vfs.getFile('/repo/src/copy.ts')?.toString()).toBe('original content');
    });

    it('should propagate copy failures', async () => {
      const { gitService } = await import('../../../src/main/services/git.service');
      await expect(gitService.copyFile('/repo', 'src/missing.ts', 'src/copy.ts')).rejects.toThrow(
        'ENOENT'
      );
    });
  });

  describe('readFileContent', () => {
    it('should read file content', async () => {
      vfs.setFile('/repo/src/index.ts', 'file content');

      const { gitService } = await import('../../../src/main/services/git.service');
      const result = await gitService.readFileContent('/repo', 'src/index.ts');

      expect(result).toBe('file content');
    });

    it('should reject when the file cannot be read', async () => {
      const { gitService } = await import('../../../src/main/services/git.service');
      await expect(gitService.readFileContent('/repo', 'src/missing.ts')).rejects.toThrow('ENOENT');
    });
  });
});
