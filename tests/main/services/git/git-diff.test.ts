import { join } from 'path';

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
    existsSync: vi.fn(() => true),
  };
});
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(() => Promise.resolve([])),
  stat: vi.fn(() => Promise.resolve({ size: 1024 })),
}));

describe('GitDiffService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  async function setup() {
    const { execFile } = (await import('child_process')) as unknown as {
      execFile: ReturnType<typeof vi.fn>;
    };
    const fs = (await import('fs')) as unknown as { existsSync: ReturnType<typeof vi.fn> };
    const gitExecMod = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsync');
    const execRawSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsyncRaw');
    const execBufferSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsyncBuffer');
    const isGitRepoSpy = vi.spyOn(gitExecMod.gitExec, 'isGitRepo');
    const { gitDiffService } = await import('../../../../src/main/services/git/git-diff');
    return {
      gitDiffService,
      execSpy,
      execRawSpy,
      execBufferSpy,
      execFile,
      existsSync: fs.existsSync,
      isGitRepoSpy,
    };
  }

  describe('getChangedFiles', () => {
    it('returns empty array when worktree does not exist', async () => {
      const { gitDiffService, existsSync } = await setup();
      existsSync.mockReturnValue(false);
      const result = await gitDiffService.getChangedFiles('/nonexistent');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty status output', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (typeof _opts === 'function') {
            _opts(null, { stdout: '' });
          } else if (cb) {
            cb(null, { stdout: '' });
          }
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      expect(result).toEqual([]);
    });

    it('coalesces staged and unstaged into single aggregate entries', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'M  staged.ts\0 M unstaged.ts\0MM both.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      // All entries are aggregate HEAD→WT with staged=false
      expect(result.find((f) => f.path === 'staged.ts')).toEqual(
        expect.objectContaining({ status: 'modified', staged: false })
      );
      expect(result.find((f) => f.path === 'unstaged.ts')).toEqual(
        expect.objectContaining({ status: 'modified', staged: false })
      );
      // MM produces a single entry, not two
      const bothEntries = result.filter((f) => f.path === 'both.ts');
      expect(bothEntries).toHaveLength(1);
      expect(bothEntries[0].status).toBe('modified');
      expect(bothEntries[0].staged).toBe(false);
    });

    it('parses untracked files', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: '?? newfile.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      expect(result).toEqual([
        { path: 'newfile.ts', status: 'untracked', staged: false, additions: 0, deletions: 0 },
      ]);
    });

    it('filters Komla-imported files from status output', async () => {
      const { gitDiffService, execRawSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execRawSpy.mockResolvedValue('?? .komla-files/report.pdf\0?? src/real.ts\0');

      const result = await gitDiffService.getChangedFiles('/repo');

      expect(result).toEqual([
        { path: 'src/real.ts', status: 'untracked', staged: false, additions: 0, deletions: 0 },
      ]);
    });

    it('parses added and deleted files', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'A  added.ts\0D  deleted.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      expect(result.find((f) => f.path === 'added.ts')?.status).toBe('added');
      expect(result.find((f) => f.path === 'deleted.ts')?.status).toBe('deleted');
    });

    it('parses renamed files', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'R  new.ts\0old.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
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

    it('uses execGitAsyncRaw so unstaged porcelain entries keep their leading space', async () => {
      const { gitDiffService, execRawSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execRawSpy.mockResolvedValue(' M unstaged.ts\0');

      const result = await gitDiffService.getChangedFiles('/repo');

      expect(execRawSpy).toHaveBeenCalledWith('/repo', ['status', '--porcelain', '-unormal', '-z']);
      expect(result).toEqual([
        { path: 'unstaged.ts', status: 'modified', staged: false, additions: 0, deletions: 0 },
      ]);
    });

    it('AM produces a single "added" entry (aggregate HEAD→WT)', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'AM newfile.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({ path: 'newfile.ts', status: 'added', staged: false })
      );
    });

    it('AD produces no entry (no net change from HEAD)', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'AD phantom.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      expect(result).toHaveLength(0);
    });

    it('MD produces a single "deleted" entry', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'MD gone.ts\0' });
        }
      );
      const result = await gitDiffService.getChangedFiles('/repo');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({ path: 'gone.ts', status: 'deleted', staged: false })
      );
    });

    it('collapses deleted + recreated same-path entries into a single modified entry', async () => {
      const { gitDiffService, execFile, existsSync } = await setup();
      existsSync.mockImplementation(
        (path?: string) => path === join('/repo', 'replaced.ts') || path === '/repo'
      );
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'D  replaced.ts\0?? replaced.ts\0' });
        }
      );

      const result = await gitDiffService.getChangedFiles('/repo');

      expect(result).toEqual([
        expect.objectContaining({ path: 'replaced.ts', status: 'modified', staged: false }),
      ]);
    });
  });

  describe('getFullFileDiff (aggregate HEAD→WT)', () => {
    it('MM file: old=HEAD, new=working-tree, status=modified', async () => {
      const { gitDiffService, execFile, existsSync, execSpy, execBufferSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      // git status shows MM
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'MM both.ts\0' });
        }
      );

      execBufferSpy.mockImplementation((_cwd: string, args: string[]) => {
        // git show HEAD:both.ts → HEAD content
        if (args[0] === 'show' && args[1] === 'HEAD:both.ts') {
          return Promise.resolve(Buffer.from('head content'));
        }
        return Promise.reject(new Error('unexpected git show'));
      });
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        // git diff --numstat (binary check)
        if (args[0] === 'diff' && args[1] === '--numstat') {
          return Promise.resolve('1\t1\tboth.ts');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue('working tree content');

      const result = await gitDiffService.getFullFileDiff('/repo', 'both.ts');
      expect(result.status).toBe('modified');
      expect(result.oldContent).toBe('head content');
      expect(result.newContent).toBe('working tree content');
    });

    it('AM file: old=null, new=working-tree, status=added', async () => {
      const { gitDiffService, execFile, existsSync, execSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      // git status shows AM
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'AM newfile.ts\0' });
        }
      );

      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        // git show HEAD:newfile.ts fails (not in HEAD)
        if (args[0] === 'show' && args[1] === 'HEAD:newfile.ts') {
          return Promise.reject(new Error('not in HEAD'));
        }
        // git diff --numstat (binary check)
        if (args[0] === 'diff' && args[1] === '--numstat') {
          return Promise.resolve('');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue('new file content');

      const result = await gitDiffService.getFullFileDiff('/repo', 'newfile.ts');
      expect(result.status).toBe('added');
      expect(result.oldContent).toBeNull();
      expect(result.newContent).toBe('new file content');
    });

    it('staged param is ignored — always shows HEAD→WT', async () => {
      const { gitDiffService, execFile, existsSync, execSpy, execBufferSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'M  staged.ts\0' });
        }
      );

      execBufferSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'show' && args[1] === 'HEAD:staged.ts') {
          return Promise.resolve(Buffer.from('head content'));
        }
        return Promise.reject(new Error('unexpected git show'));
      });
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'diff' && args[1] === '--numstat') {
          return Promise.resolve('1\t1\tstaged.ts');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue('working tree content');

      // Even with staged=true, should show HEAD→WT, not HEAD→index
      const result = await gitDiffService.getFullFileDiff('/repo', 'staged.ts', true);
      expect(result.oldContent).toBe('head content');
      expect(result.newContent).toBe('working tree content');
      // Should NOT have fetched index content (git show :staged.ts)
      expect(execBufferSpy).not.toHaveBeenCalledWith('/repo', ['show', ':staged.ts']);
    });

    it('deleted + recreated same-path file diffs as modified against HEAD', async () => {
      const { gitDiffService, execFile, existsSync, execSpy, execBufferSpy } = await setup();
      existsSync.mockImplementation(
        (path?: string) => path === join('/repo', 'replaced.ts') || path === '/repo'
      );
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'D  replaced.ts\0?? replaced.ts\0' });
        }
      );

      execBufferSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'show' && args[1] === 'HEAD:replaced.ts') {
          return Promise.resolve(Buffer.from('old content'));
        }
        return Promise.reject(new Error('unexpected git show'));
      });
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'diff' && args[1] === '--numstat') {
          return Promise.resolve('1\t1\treplaced.ts');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue('new content');

      const result = await gitDiffService.getFullFileDiff('/repo', 'replaced.ts');

      expect(result.status).toBe('modified');
      expect(result.oldContent).toBe('old content');
      expect(result.newContent).toBe('new content');
    });

    it('returns quiet missing content for a stale selected file that is no longer changed or on disk', async () => {
      const { gitDiffService, execFile, existsSync, execSpy, execBufferSpy } = await setup();
      existsSync.mockImplementation((path?: string) => path === '/repo');

      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: '' });
        }
      );

      const result = await gitDiffService.getFullFileDiff('/repo', 'missing.ts');

      expect(result).toEqual({
        path: 'missing.ts',
        oldContent: null,
        newContent: null,
        status: 'deleted',
        isBinary: false,
      });
      expect(execBufferSpy).not.toHaveBeenCalledWith('/repo', ['show', 'HEAD:missing.ts']);
    });
  });

  describe('getWorkingTreeDiff', () => {
    it('keeps per-file stats aligned for deleted + recreated same-path files', async () => {
      const { gitDiffService, execFile, existsSync, execSpy } = await setup();
      existsSync.mockImplementation(
        (path?: string) => path === join('/repo', 'replaced.ts') || path === '/repo'
      );
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, {
            stdout: _args.includes('ls-files')
              ? 'replaced.ts\0'
              : 'D  replaced.ts\0?? replaced.ts\0',
          });
        }
      );

      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'diff' && args[1] === 'HEAD' && args[2] === '--numstat') {
          return Promise.resolve('0\t1\treplaced.ts');
        }
        if (args[0] === 'diff' && args[1] === 'HEAD') {
          return Promise.resolve(
            'diff --git a/replaced.ts b/replaced.ts\n--- a/replaced.ts\n+++ /dev/null\n'
          );
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue(Buffer.from('new line 1\nnew line 2\n'));

      const result = await gitDiffService.getWorkingTreeDiff('/repo');

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'replaced.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        }),
      ]);
      expect(result.summary).toEqual({ additions: 2, deletions: 1, filesChanged: 1 });
    });
  });

  describe('getDiffSummary', () => {
    it('returns additions and deletions', async () => {
      const { gitDiffService, execFile, existsSync, execSpy } = await setup();
      existsSync.mockReturnValue(true);
      // Mock getChangedFilesWithSummary pipeline
      // 1. git status --porcelain
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: ' M file.ts\0' });
        }
      );
      // 2. git diff HEAD --numstat
      execSpy.mockResolvedValue('5\t2\tfile.ts');
      const result = await gitDiffService.getDiffSummary('/repo');
      expect(result.additions).toBe(5);
      expect(result.deletions).toBe(2);
    });

    it('keeps summary stats aligned for deleted + recreated same-path files', async () => {
      const { gitDiffService, execFile, existsSync, execSpy } = await setup();
      existsSync.mockImplementation(
        (path?: string) => path === join('/repo', 'replaced.ts') || path === '/repo'
      );
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: 'D  replaced.ts\0?? replaced.ts\0' });
        }
      );

      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'diff' && args[1] === 'HEAD' && args[2] === '--numstat') {
          return Promise.resolve('0\t1\treplaced.ts');
        }
        if (args[0] === 'ls-files') {
          return Promise.resolve('replaced.ts');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue(Buffer.from('new line 1\nnew line 2\n'));

      const result = await gitDiffService.getChangedFilesWithSummary('/repo');

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'replaced.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        }),
      ]);
      expect(result.summary).toEqual({ additions: 2, deletions: 1, filesChanged: 1 });
    });

    it('does not count untracked media files as added lines', async () => {
      const { gitDiffService, execFile, existsSync, execSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile, stat } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
      };

      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: '?? demo.mp4\0?? notes.ts\0' });
        }
      );

      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] === 'diff' && args[1] === 'HEAD' && args[2] === '--numstat') {
          return Promise.resolve('');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue(Buffer.from('one\ntwo\n'));

      const result = await gitDiffService.getChangedFilesWithSummary('/repo');

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'demo.mp4',
          status: 'untracked',
          additions: 0,
          deletions: 0,
        }),
        expect.objectContaining({
          path: 'notes.ts',
          status: 'untracked',
          additions: 2,
          deletions: 0,
        }),
      ]);
      expect(result.summary).toEqual({ additions: 2, deletions: 0, filesChanged: 2 });
      expect(stat).toHaveBeenCalledTimes(1);
      expect(readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('getActivityFingerprint', () => {
    it('includes per-file diff stats in the fingerprint', async () => {
      const { gitDiffService, execFile, existsSync, execSpy } = await setup();
      existsSync.mockReturnValue(true);
      execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback?.(null, { stdout: ' M file.ts\0?? new.ts\0' });
        }
      );
      execSpy.mockResolvedValue('3\t1\tfile.ts');

      const result = await gitDiffService.getActivityFingerprint('/repo');
      expect(result).toBe('modified:false:file.ts:3:1\nuntracked:false:new.ts:0:0');
    });
  });

  describe('getWorkingTreeDiffAgainstBranch', () => {
    it('returns each changed path only once', async () => {
      const { gitDiffService, existsSync, execSpy, execRawSpy } = await setup();
      existsSync.mockReturnValue(true);

      execRawSpy.mockResolvedValue('');
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] !== 'diff') return Promise.resolve('');
        if (args[2] === '--numstat') {
          return Promise.resolve('3\t1\tinternal/db/sqlite_extractor.go\0');
        }
        if (args[2] === '--name-status') {
          return Promise.resolve(
            'M\0internal/db/sqlite_extractor.go\0M\0internal/db/sqlite_extractor.go\0'
          );
        }
        if (args[2] === '--stat') {
          return Promise.resolve(' 1 file changed, 3 insertions(+), 1 deletion(-)');
        }
        return Promise.resolve('');
      });

      const result = await gitDiffService.getWorkingTreeDiffAgainstBranch('/repo', 'main');

      expect(result.files.map((file) => file.path)).toEqual(['internal/db/sqlite_extractor.go']);
      expect(result.summary.filesChanged).toBe(1);
    });

    it('uses --stat totals and adds untracked file additions to the summary', async () => {
      const { gitDiffService, existsSync, execSpy, execRawSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      execRawSpy.mockResolvedValue('untracked.ts\0');
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] !== 'diff') return Promise.resolve('');
        if (args[2] === '--numstat') return Promise.resolve('3\t1\ttracked.ts\0');
        if (args[2] === '--name-status') return Promise.resolve('M\0tracked.ts\0');
        if (args[2] === '--stat') {
          return Promise.resolve(' 1 file changed, 3 insertions(+), 1 deletion(-)');
        }
        return Promise.resolve('diff --git a/tracked.ts b/tracked.ts\n');
      });
      readFile.mockResolvedValue(Buffer.from('hello\nworld\n', 'utf-8'));

      const result = await gitDiffService.getWorkingTreeDiffAgainstBranch('/repo', 'main');

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'tracked.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
        }),
        expect.objectContaining({
          path: 'untracked.ts',
          status: 'untracked',
          additions: 2,
          deletions: 0,
        }),
      ]);
      // stat totals (3+,1-) + untracked additions (2) folded into summary
      expect(result.summary).toEqual({ additions: 5, deletions: 1, filesChanged: 2 });
    });

    it('estimates untracked line count from byte size for files above the read cap', async () => {
      const { gitDiffService, existsSync, execSpy, execRawSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile, stat } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
      };

      execRawSpy.mockResolvedValue('huge.log\0');
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[2] === '--numstat') return Promise.resolve('');
        if (args[2] === '--name-status') return Promise.resolve('');
        if (args[2] === '--stat') return Promise.resolve('');
        return Promise.resolve('');
      });
      const hugeBytes = 50 * 1024 * 1024;
      stat.mockResolvedValue({ size: hugeBytes });

      const result = await gitDiffService.getWorkingTreeDiffAgainstBranch('/repo', 'main');

      expect(readFile).not.toHaveBeenCalled();
      const untracked = result.files.find((f) => f.path === 'huge.log');
      expect(untracked?.additions).toBe(Math.ceil(hugeBytes / 80));
    });

    it('does not count untracked media files as added lines against a branch', async () => {
      const { gitDiffService, existsSync, execSpy, execRawSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile, stat } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
      };

      execRawSpy.mockResolvedValue('demo.mp4\0notes.ts\0');
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] !== 'diff') return Promise.resolve('');
        if (args[2] === '--numstat') return Promise.resolve('');
        if (args[2] === '--name-status') return Promise.resolve('');
        if (args[2] === '--stat') return Promise.resolve('');
        return Promise.resolve('');
      });
      readFile.mockResolvedValue(Buffer.from('one\ntwo\n'));

      const result = await gitDiffService.getWorkingTreeDiffAgainstBranch('/repo', 'main');

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'demo.mp4',
          status: 'untracked',
          additions: 0,
          deletions: 0,
        }),
        expect.objectContaining({
          path: 'notes.ts',
          status: 'untracked',
          additions: 2,
          deletions: 0,
        }),
      ]);
      expect(result.summary).toEqual({ additions: 2, deletions: 0, filesChanged: 2 });
      expect(stat).toHaveBeenCalledTimes(1);
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('filters Komla-imported files from branch comparison diffs', async () => {
      const { gitDiffService, existsSync, execSpy, execRawSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      execRawSpy.mockResolvedValue('.komla-files/report.pdf\0notes.ts\0');
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] !== 'diff') return Promise.resolve('');
        if (args[2] === '--numstat') return Promise.resolve('1\t0\t.komla-files/old.txt\0');
        if (args[2] === '--name-status') return Promise.resolve('M\0.komla-files/old.txt\0');
        if (args[2] === '--stat') return Promise.resolve(' 1 file changed, 1 insertion(+)');
        return Promise.resolve('');
      });
      readFile.mockResolvedValue(Buffer.from('note\n'));

      const result = await gitDiffService.getWorkingTreeDiffAgainstBranch('/repo', 'main');

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'notes.ts',
          status: 'untracked',
          additions: 1,
          deletions: 0,
        }),
      ]);
    });

    it('falls back to summing per-file totals when --stat rejects', async () => {
      const { gitDiffService, existsSync, execSpy, execRawSpy } = await setup();
      existsSync.mockReturnValue(true);

      execRawSpy.mockResolvedValue('');
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        if (args[0] !== 'diff') return Promise.resolve('');
        if (args[2] === '--numstat') return Promise.resolve('3\t1\ttracked.ts\0');
        if (args[2] === '--name-status') return Promise.resolve('M\0tracked.ts\0');
        if (args[2] === '--stat') return Promise.reject(new Error('stat failed'));
        return Promise.resolve('');
      });

      const result = await gitDiffService.getWorkingTreeDiffAgainstBranch('/repo', 'main');

      expect(result.summary).toEqual({ additions: 3, deletions: 1, filesChanged: 1 });
    });
  });

  describe('getFullFileDiffAgainstBranch', () => {
    it('treats empty-string output from git show as existing in branch (status=modified, not added)', async () => {
      const { gitDiffService, existsSync, execSpy, execBufferSpy } = await setup();
      existsSync.mockReturnValue(true);
      const { readFile } = (await import('fs/promises')) as unknown as {
        readFile: ReturnType<typeof vi.fn>;
      };

      // File exists in branch but is empty
      execBufferSpy.mockImplementation((_cwd: string, args: string[]) =>
        args[0] === 'show' && args[1] === 'main:empty.ts'
          ? Promise.resolve(Buffer.from(''))
          : Promise.reject(new Error('unexpected git show'))
      );
      execSpy.mockImplementation((_cwd: string, args: string[]) => {
        // isFileBinary: non-binary numstat entry
        if (args[0] === 'diff' && args[1] === '--numstat') {
          return Promise.resolve('1\t0\tempty.ts');
        }
        return Promise.resolve('');
      });
      readFile.mockResolvedValue('now has content\n');

      const result = await gitDiffService.getFullFileDiffAgainstBranch('/repo', 'empty.ts', 'main');

      expect(result.status).toBe('modified');
      expect(result.oldContent).toBe('');
      expect(result.newContent).toBe('now has content\n');
      expect(result.isBinary).toBe(false);
    });
  });
});
