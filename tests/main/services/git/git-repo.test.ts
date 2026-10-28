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
    rmSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
    renameSync: vi.fn(),
  };
});
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(() => Promise.resolve([])),
  lstat: vi.fn(() =>
    Promise.resolve({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => true })
  ),
  stat: vi.fn(() =>
    Promise.resolve({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false })
  ),
}));

describe('GitRepoService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function setup() {
    const gitExecMod = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsync');
    const rawExecSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsyncRaw');
    const isGitRepoSpy = vi.spyOn(gitExecMod.gitExec, 'isGitRepo');
    const hasUncommittedChangesSpy = vi.spyOn(gitExecMod.gitExec, 'hasUncommittedChanges');
    const invalidateCacheSpy = vi.spyOn(gitExecMod.gitExec, 'invalidateCache');
    const execGitWithProgressSpy = vi.spyOn(gitExecMod.gitExec, 'execGitWithProgress');
    const { execFile } = (await import('child_process')) as unknown as {
      execFile: ReturnType<typeof vi.fn>;
    };
    const { spawn } = (await import('child_process')) as unknown as {
      spawn: ReturnType<typeof vi.fn>;
    };
    const fs = (await import('fs')) as unknown as {
      copyFileSync: ReturnType<typeof vi.fn>;
      existsSync: ReturnType<typeof vi.fn>;
      mkdirSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
      writeFileSync: ReturnType<typeof vi.fn>;
    };
    const fsPromises = (await import('fs/promises')) as unknown as {
      lstat: ReturnType<typeof vi.fn>;
      readFile: ReturnType<typeof vi.fn>;
      readdir: ReturnType<typeof vi.fn>;
      stat: ReturnType<typeof vi.fn>;
    };
    const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');
    return {
      gitRepoService,
      execSpy,
      rawExecSpy,
      isGitRepoSpy,
      hasUncommittedChangesSpy,
      invalidateCacheSpy,
      execGitWithProgressSpy,
      execFile,
      spawn,
      copyFileSync: fs.copyFileSync,
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      lstat: fsPromises.lstat,
      readFile: fsPromises.readFile,
      readdir: fsPromises.readdir,
      stat: fsPromises.stat,
    };
  }

  describe('getRepoWebInfo', () => {
    it('returns unknown for no remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('no remote'));
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result).toEqual({ provider: 'unknown', webUrl: null });
    });

    it('detects GitHub SSH URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('git@github.com:user/repo.git');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result.provider).toBe('github');
      expect(result.webUrl).toBe('https://github.com/user/repo');
    });

    it('detects GitHub HTTPS URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://github.com/user/repo.git');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result.provider).toBe('github');
      expect(result.webUrl).toBe('https://github.com/user/repo');
    });

    it('detects GitLab URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('git@gitlab.com:user/repo.git');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result.provider).toBe('gitlab');
      expect(result.webUrl).toBe('https://gitlab.com/user/repo');
    });

    it('detects Bitbucket URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('git@bitbucket.org:user/repo.git');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result.provider).toBe('bitbucket');
      expect(result.webUrl).toBe('https://bitbucket.org/user/repo');
    });

    it('normalizes Azure DevOps HTTPS URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://contoso@dev.azure.com/contoso/MyProject/_git/my-repo');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result).toEqual({
        provider: 'azure-devops',
        webUrl: 'https://dev.azure.com/contoso/MyProject/_git/my-repo',
      });
    });

    it('normalizes Azure DevOps SSH URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('git@ssh.dev.azure.com:v3/contoso/MyProject/my-repo');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result).toEqual({
        provider: 'azure-devops',
        webUrl: 'https://dev.azure.com/contoso/MyProject/_git/my-repo',
      });
    });

    it('detects legacy Azure DevOps URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://contoso.visualstudio.com/MyProject/_git/my-repo');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result).toEqual({
        provider: 'azure-devops',
        webUrl: 'https://contoso.visualstudio.com/MyProject/_git/my-repo',
      });
    });

    it('leaves out a user and token stored in an HTTPS remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://oauth2:glpat-secret@gitlab.com/acme/web.git');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result).toEqual({ provider: 'gitlab', webUrl: 'https://gitlab.com/acme/web' });
    });

    it('handles HTTPS URL without .git suffix', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://github.com/user/repo');
      const result = await gitRepoService.getRepoWebInfo('/repo');
      expect(result.webUrl).toBe('https://github.com/user/repo');
    });
  });

  describe('getRepoName', () => {
    it('extracts name from HTTPS URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://github.com/user/my-repo.git');
      const result = await gitRepoService.getRepoName('/some/path/my-repo');
      expect(result).toBe('my-repo');
    });

    it('extracts name from SSH URL', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('git@github.com:user/my-repo.git');
      const result = await gitRepoService.getRepoName('/some/path/my-repo');
      expect(result).toBe('my-repo');
    });

    it('falls back to folder name when no remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('no remote'));
      const result = await gitRepoService.getRepoName('/some/path/my-folder');
      expect(result).toBe('my-folder');
    });

    it('uses the parent folder name for bare repositories named repo.git', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockImplementation(async (_path, args) => {
        if (args[0] === 'remote') throw new Error('no remote');
        if (args[0] === 'rev-parse') return 'true';
        throw new Error(`Unexpected git command: ${args.join(' ')}`);
      });

      const first = await gitRepoService.getRepoName('/projects/alpha/repo.git');
      const second = await gitRepoService.getRepoName('/projects/beta/repo.git');

      expect(first).toBe('alpha');
      expect(second).toBe('beta');
    });
  });

  describe('isBareRepo', () => {
    it('returns true for bare repos', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('true');
      const result = await gitRepoService.isBareRepo('/repo.git');
      expect(result).toBe(true);
    });

    it('returns false for non-bare repos', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('false');
      const result = await gitRepoService.isBareRepo('/repo');
      expect(result).toBe(false);
    });

    it('returns false on error', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('not a repo'));
      const result = await gitRepoService.isBareRepo('/not-a-repo');
      expect(result).toBe(false);
    });
  });

  describe('getRemoteUrl', () => {
    it('returns null when no remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('no remote'));
      const result = await gitRepoService.getRemoteUrl('/repo');
      expect(result).toBeNull();
    });
  });

  describe('getRemoteUrlByName', () => {
    it('returns remote URL for specific remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('https://github.com/upstream/repo.git');
      const result = await gitRepoService.getRemoteUrlByName('/repo', 'upstream');
      expect(result).toBe('https://github.com/upstream/repo.git');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['remote', 'get-url', 'upstream']);
    });

    it('returns null on error', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('not found'));
      const result = await gitRepoService.getRemoteUrlByName('/repo', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('addRemote', () => {
    it('adds remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitRepoService.addRemote('/repo', 'origin', 'https://github.com/user/repo.git');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'remote',
        'add',
        '--',
        'origin',
        'https://github.com/user/repo.git',
      ]);
    });
  });

  describe('removeRemote', () => {
    it('removes remote', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitRepoService.removeRemote('/repo', 'origin');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['remote', 'remove', 'origin']);
    });

    it('ignores error when remote does not exist', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockRejectedValue(new Error('not found'));
      await expect(gitRepoService.removeRemote('/repo', 'nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('initRepo', () => {
    it('initializes a git repository', async () => {
      const { gitRepoService, execSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      execSpy.mockResolvedValue('');
      await gitRepoService.initRepo('/new-repo');
      expect(execSpy).toHaveBeenCalledWith('/new-repo', ['init']);
    });
  });

  describe('listIgnoredDirectories', () => {
    it('lists the directories git ignores whole, without single files', async () => {
      const { gitRepoService } = await setup();
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');
      const listing = vi.spyOn(gitExec, 'execGitAsyncRawLimited').mockResolvedValue({
        output: 'a.log\0dist/\0packages/app/node_modules/\0',
        truncated: false,
      });

      await expect(gitRepoService.listIgnoredDirectories('/repo')).resolves.toEqual([
        'dist',
        'packages/app/node_modules',
      ]);
      expect(listing).toHaveBeenCalledWith(
        '/repo',
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        expect.any(Number)
      );
    });

    it('drops the cut entry of a truncated listing, which could name a parent directory', async () => {
      const { gitRepoService } = await setup();
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');
      vi.spyOn(gitExec, 'execGitAsyncRawLimited').mockResolvedValue({
        output: 'dist/\0packages/',
        truncated: true,
      });

      await expect(gitRepoService.listIgnoredDirectories('/repo')).resolves.toEqual(['dist']);
    });
  });

  describe('listFiles', () => {
    it('uses git ls-files for git repos', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy.mockResolvedValue('file1.ts\0file2.ts\0');
      const result = await gitRepoService.listFiles('/repo');
      expect(result.files).toEqual(['file1.ts', 'file2.ts']);
    });

    it('returns empty arrays when directory does not exist', async () => {
      const { gitRepoService, existsSync } = await setup();
      existsSync.mockReturnValue(false);
      const result = await gitRepoService.listFiles('/nonexistent');
      expect(result).toEqual({ files: [], gitIgnoredFiles: [], emptyDirs: [] });
    });

    it('includes git-ignored files when requested', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy
        .mockResolvedValueOnce('file1.ts\0') // ls-files
        .mockResolvedValueOnce('node_modules/x.js\0'); // ls-files --ignored
      const result = await gitRepoService.listFiles('/repo', true);
      expect(result.files).toEqual(['file1.ts']);
      expect(result.gitIgnoredFiles).toEqual(['node_modules/x.js']);
    });

    it('keeps Komla-imported files browsable when git excludes them', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync, readdir } = await setup();
      existsSync.mockImplementation(
        (path: string) => path === '/repo' || path === '/repo/.komla-files'
      );
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy
        .mockResolvedValueOnce('src/main.ts\0')
        .mockResolvedValueOnce('.komla-files/report.pdf\0node_modules/x.js\0');
      readdir.mockResolvedValueOnce([
        { name: 'report.pdf', isDirectory: () => false },
        { name: '.env', isDirectory: () => false },
      ]);

      const result = await gitRepoService.listFiles('/repo', true);

      expect(result.files).toEqual(['src/main.ts', '.komla-files/report.pdf', '.komla-files/.env']);
      expect(result.gitIgnoredFiles).toEqual(['node_modules/x.js']);
    });

    it('does not mark linked workspace peer files as ignored', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy
        .mockResolvedValueOnce('src/main.ts\0')
        .mockResolvedValueOnce('node_modules/x.js\0linked-workspaces/peer\0');

      const result = await gitRepoService.listFiles('/repo', true);

      expect(result.gitIgnoredFiles).toEqual(['node_modules/x.js']);
      expect(result.gitIgnoredFiles).not.toContain('linked-workspaces/peer/peer/src/index.ts');
    });

    it('expands linked-workspaces/<peer> symlink entries into peer contents', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy
        // host's ls-files: contains a single entry for the linked peer symlink
        .mockResolvedValueOnce('src/main.ts\0linked-workspaces/peer\0')
        // peer's isGitRepo + ls-files: peer is also a git repo with two files
        .mockResolvedValueOnce('peer/src/index.ts\0peer/README.md\0');
      const result = await gitRepoService.listFiles('/repo');
      expect(result.files).toContain('src/main.ts');
      expect(result.files).toContain('linked-workspaces/peer/peer/src/index.ts');
      expect(result.files).toContain('linked-workspaces/peer/peer/README.md');
      // Bare peer entry should be replaced, not retained as a file
      expect(result.files).not.toContain('linked-workspaces/peer');
    });

    it('expands ignored linked-workspaces symlinks discovered from disk', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      const fsPromises = (await import('fs/promises')) as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
      };
      existsSync.mockImplementation(
        (path: string) => path === '/repo' || path === '/repo/linked-workspaces'
      );
      fsPromises.readdir.mockResolvedValueOnce(['peer', 'notes.md']);
      fsPromises.lstat.mockImplementation(async (path: string) => ({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => path === '/repo/linked-workspaces/peer',
      }));
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy
        // Host ls-files does not include linked-workspaces because it is
        // ignored in .git/info/exclude.
        .mockResolvedValueOnce('src/main.ts\0')
        .mockResolvedValueOnce('peer/src/index.ts\0');

      const result = await gitRepoService.listFiles('/repo');

      expect(result.files).toContain('src/main.ts');
      expect(result.files).toContain('linked-workspaces/peer/peer/src/index.ts');
      expect(result.files).not.toContain('linked-workspaces/peer');
      expect(result.files).not.toContain('linked-workspaces/notes.md');
    });

    it("skips a peer's own linked-workspaces children to avoid recursion", async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy
        .mockResolvedValueOnce('linked-workspaces/peer\0')
        .mockResolvedValueOnce('a.ts\0linked-workspaces/other\0');
      const result = await gitRepoService.listFiles('/repo');
      expect(result.files).toEqual(['linked-workspaces/peer/a.ts']);
    });

    it('drops broken linked-workspaces symlink entries', async () => {
      const { gitRepoService, isGitRepoSpy, rawExecSpy, existsSync } = await setup();
      const fsPromises = (await import('fs/promises')) as unknown as {
        stat: ReturnType<typeof vi.fn>;
      };
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(true);
      rawExecSpy.mockResolvedValueOnce('src/main.ts\0linked-workspaces/missing-peer\0');
      fsPromises.stat.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await gitRepoService.listFiles('/repo');

      expect(result.files).toEqual(['src/main.ts']);
    });

    it('expands linked-workspaces symlinks for non-git directories', async () => {
      const { gitRepoService, isGitRepoSpy, existsSync } = await setup();
      const fsPromises = (await import('fs/promises')) as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
      };
      existsSync.mockImplementation(
        (path: string) => path === '/repo' || path === '/repo/linked-workspaces'
      );
      isGitRepoSpy.mockResolvedValue(false);
      fsPromises.readdir.mockImplementation(
        async (path: string, options?: { withFileTypes?: boolean }) => {
          if (options?.withFileTypes) {
            if (path === '/repo') {
              return [
                { name: 'src', isDirectory: () => true },
                { name: 'linked-workspaces', isDirectory: () => true },
              ];
            }
            if (path === '/repo/src') {
              return [{ name: 'main.ts', isDirectory: () => false }];
            }
            if (path === '/repo/linked-workspaces') {
              return [{ name: 'peer', isDirectory: () => false }];
            }
            if (path === '/repo/linked-workspaces/peer') {
              return [{ name: 'README.md', isDirectory: () => false }];
            }
          }
          if (path === '/repo/linked-workspaces') return ['peer'];
          return [];
        }
      );
      fsPromises.lstat.mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => true,
      });

      const result = await gitRepoService.listFiles('/repo');

      expect(result.files).toContain('src/main.ts');
      expect(result.files).toContain('linked-workspaces/peer/README.md');
      expect(result.files).not.toContain('linked-workspaces/peer');
    });

    it('skips unreadable directories when listing non-git directories', async () => {
      const { gitRepoService, isGitRepoSpy, existsSync } = await setup();
      const fsPromises = (await import('fs/promises')) as unknown as {
        readdir: ReturnType<typeof vi.fn>;
      };
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(false);
      fsPromises.readdir.mockImplementation(async (path: string) => {
        if (path === '/repo') {
          return [
            { name: 'README.md', isDirectory: () => false },
            { name: 'Movies', isDirectory: () => true },
          ];
        }
        if (path === '/repo/Movies') {
          return [{ name: 'TV', isDirectory: () => true }];
        }
        if (path === '/repo/Movies/TV') {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return [];
      });

      const result = await gitRepoService.listFiles('/repo');

      expect(result.files).toEqual(['README.md']);
      expect(result.gitIgnoredFiles).toEqual([]);
      expect(result.emptyDirs).toEqual([]);
    });

    it('lists non-git directories and Komla files with forward slashes on Windows', async () => {
      const { win32 } = await vi.importActual<typeof import('path')>('path');
      vi.doMock('path', () => ({ ...win32, default: win32 }));
      const { gitRepoService, isGitRepoSpy, existsSync, readdir } = await setup();
      existsSync.mockReturnValue(true);
      isGitRepoSpy.mockResolvedValue(false);
      readdir.mockImplementation(async (path: string) => {
        if (path === 'C:\\repo') {
          return [
            { name: 'README.md', isDirectory: () => false },
            { name: 'src', isDirectory: () => true },
          ];
        }
        if (path === 'C:\\repo\\src') {
          return [{ name: 'lib', isDirectory: () => true }];
        }
        if (path === 'C:\\repo\\src\\lib') {
          return [{ name: 'index.ts', isDirectory: () => false }];
        }
        if (path === 'C:\\repo\\.komla-files') {
          return [{ name: 'shots', isDirectory: () => true }];
        }
        if (path === 'C:\\repo\\.komla-files\\shots') {
          return [{ name: 'a.png', isDirectory: () => false }];
        }
        return [];
      });

      try {
        const result = await gitRepoService.listFiles('C:\\repo');

        expect(result.files).toEqual(['README.md', 'src/lib/index.ts', '.komla-files/shots/a.png']);
      } finally {
        vi.doUnmock('path');
      }
    });
  });

  describe('restoreFile', () => {
    it('checks out from HEAD for modified files', async () => {
      const { gitRepoService, execSpy, invalidateCacheSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitRepoService.restoreFile('/repo', 'file.ts', 'modified');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'checkout',
        'HEAD',
        '--',
        ':(literal)file.ts',
      ]);
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });

    it('checks out from HEAD for deleted files', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitRepoService.restoreFile('/repo', 'file.ts', 'deleted');
      expect(execSpy).toHaveBeenCalledWith('/repo', [
        'checkout',
        'HEAD',
        '--',
        ':(literal)file.ts',
      ]);
    });

    it('removes staged added files', async () => {
      const { gitRepoService, execSpy } = await setup();
      execSpy.mockResolvedValue('');
      await gitRepoService.restoreFile('/repo', 'file.ts', 'added');
      expect(execSpy).toHaveBeenCalledWith('/repo', ['rm', '-f', '--', ':(literal)file.ts']);
    });
  });

  describe('discardAllChanges', () => {
    it('returns no changes message when clean', async () => {
      const { gitRepoService, hasUncommittedChangesSpy } = await setup();
      hasUncommittedChangesSpy.mockResolvedValue(false);
      const result = await gitRepoService.discardAllChanges('/repo');
      expect(result).toEqual({ success: true, message: 'No changes to discard' });
    });

    it('resets and cleans working directory', async () => {
      const { gitRepoService, hasUncommittedChangesSpy, execSpy, invalidateCacheSpy } =
        await setup();
      hasUncommittedChangesSpy.mockResolvedValue(true);
      execSpy.mockResolvedValue('');
      const result = await gitRepoService.discardAllChanges('/repo');
      expect(result).toEqual({ success: true, message: 'Discarded all changes' });
      expect(execSpy).toHaveBeenCalledWith('/repo', ['reset', '--hard', 'HEAD']);
      expect(execSpy).toHaveBeenCalledWith('/repo', ['clean', '-fd']);
      expect(invalidateCacheSpy).toHaveBeenCalledWith('hasUncommittedChanges:/repo');
    });
  });

  describe('validateRemoteUrl', () => {
    it('returns valid for successful ls-remote', async () => {
      const { gitRepoService, spawn } = await setup();
      const mockProc = {
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      spawn.mockReturnValue(mockProc);

      const promise = gitRepoService.validateRemoteUrl('https://github.com/user/repo.git');

      // Simulate process close with code 0
      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close'
      )?.[1] as Function;
      closeHandler(0);

      const result = await promise;
      expect(result).toEqual({ valid: true });
    });

    it('returns invalid for failed ls-remote', async () => {
      const { gitRepoService, spawn } = await setup();
      const mockProc = {
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      spawn.mockReturnValue(mockProc);

      const promise = gitRepoService.validateRemoteUrl('https://github.com/user/nonexistent.git');

      // Simulate stderr data then close
      const dataHandler = mockProc.stderr.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'data'
      )?.[1] as Function;
      dataHandler(Buffer.from('not found'));
      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close'
      )?.[1] as Function;
      closeHandler(1);

      const result = await promise;
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Repository not found');
    });

    it('returns invalid with auth error message', async () => {
      const { gitRepoService, spawn } = await setup();
      const mockProc = {
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      spawn.mockReturnValue(mockProc);

      const promise = gitRepoService.validateRemoteUrl('https://github.com/private/repo.git');

      const dataHandler = mockProc.stderr.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'data'
      )?.[1] as Function;
      dataHandler(Buffer.from('could not read Username'));
      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close'
      )?.[1] as Function;
      closeHandler(1);

      const result = await promise;
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Authentication');
    });

    it('handles process error', async () => {
      const { gitRepoService, spawn } = await setup();
      const mockProc = {
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      spawn.mockReturnValue(mockProc);

      const promise = gitRepoService.validateRemoteUrl('invalid');

      const errorHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'error'
      )?.[1] as Function;
      errorHandler(new Error('spawn failed'));

      const result = await promise;
      expect(result.valid).toBe(false);
      expect(result.error).toBe('spawn failed');
    });
  });

  describe('getFileMetadata', () => {
    it('returns a stable disk token source without reading file content', async () => {
      const { gitRepoService, readFile, stat } = await setup();
      stat.mockResolvedValue({ size: 1234, mtimeMs: 5678 });

      const result = await gitRepoService.getFileMetadata('/repo', 'document.pdf');

      expect(stat).toHaveBeenCalledWith('/repo/document.pdf');
      expect(readFile).not.toHaveBeenCalled();
      expect(result).toEqual({ size: 1234, mtimeMs: 5678 });
    });
  });

  describe('readMediaFileContent', () => {
    it('reads audio files as base64 with mime type and kind', async () => {
      const { gitRepoService, readFile, stat } = await setup();
      stat.mockResolvedValue({ size: 10, mtimeMs: 123 });
      readFile.mockResolvedValue(Buffer.from('audio-data'));

      const result = await gitRepoService.readMediaFileContent('/repo', 'sound.mp3');

      expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]repo[\\/]sound\.mp3$/));
      expect(result).toEqual({
        data: Buffer.from('audio-data').toString('base64'),
        mimeType: 'audio/mpeg',
        kind: 'audio',
      });
    });

    it('reads video files as base64 with mime type and kind', async () => {
      const { gitRepoService, readFile, stat } = await setup();
      stat.mockResolvedValue({ size: 10, mtimeMs: 123 });
      readFile.mockResolvedValue(Buffer.from('video-data'));

      const result = await gitRepoService.readMediaFileContent('/repo', 'clip.webm');

      expect(result).toEqual({
        data: Buffer.from('video-data').toString('base64'),
        mimeType: 'video/webm',
        kind: 'video',
      });
    });

    it('rejects non-media files', async () => {
      const { gitRepoService } = await setup();

      await expect(gitRepoService.readMediaFileContent('/repo', 'notes.txt')).rejects.toThrow(
        'Not a media file'
      );
    });

    it('rejects media files larger than the IPC cap', async () => {
      const { gitRepoService, readFile, stat } = await setup();
      stat.mockResolvedValue({ size: 50 * 1024 * 1024 + 1, mtimeMs: 123 });

      await expect(gitRepoService.readMediaFileContent('/repo', 'clip.mp4')).rejects.toThrow(
        'Media file too large'
      );
      expect(readFile).not.toHaveBeenCalled();
    });

    it('returns media metadata without reading file content', async () => {
      const { gitRepoService, readFile, stat } = await setup();
      stat.mockResolvedValue({ size: 1234, mtimeMs: 5678 });

      const result = await gitRepoService.getMediaFileMetadata('/repo', 'clip.mkv');

      expect(readFile).not.toHaveBeenCalled();
      expect(result).toEqual({
        mimeType: 'video/x-matroska',
        kind: 'video',
        size: 1234,
        mtimeMs: 5678,
      });
    });
  });
});
