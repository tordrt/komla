import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockFs = {
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
};
vi.mock('fs', () => mockFs);

const mockGitService = {
  getRemoteUrl: vi.fn(),
  cloneBare: vi.fn(),
  cloneBareFromRemote: vi.fn(),
  removeRemote: vi.fn(),
  addRemote: vi.fn(),
  fetchAllBranches: vi.fn(),
  pushToRemote: vi.fn(),
  hasRemote: vi.fn(),
  getAheadBehind: vi.fn(),
  isBareRepo: vi.fn(),
  getRemoteUrlByName: vi.fn(),
};
vi.mock('../../../src/main/services/git.service', () => ({ gitService: mockGitService }));

const mockGitExec = {
  execGitAsync: vi.fn(),
};
vi.mock('../../../src/main/services/git/git-exec', () => ({ gitExec: mockGitExec }));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

describe('ManagedRepoService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockFs.existsSync.mockReturnValue(false);
    mockGitService.getRemoteUrl.mockResolvedValue('git@github.com:org/repo.git');
    mockGitService.cloneBare.mockResolvedValue(undefined);
    mockGitService.cloneBareFromRemote.mockResolvedValue(undefined);
    mockGitService.removeRemote.mockResolvedValue(undefined);
    mockGitService.addRemote.mockResolvedValue(undefined);
    mockGitService.fetchAllBranches.mockResolvedValue(undefined);
    mockGitService.pushToRemote.mockResolvedValue(undefined);
    mockGitService.hasRemote.mockResolvedValue(true);
    mockGitService.getAheadBehind.mockResolvedValue({ ahead: 2, behind: 1 });
    mockGitService.isBareRepo.mockResolvedValue(true);
    mockGitService.getRemoteUrlByName.mockResolvedValue('git@github.com:org/repo.git');
    mockGitExec.execGitAsync.mockResolvedValue('');
  });

  it('creates a managed repo and rewires origin when source has a remote', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    const repoPath = await managedRepoService.createManagedRepo('/src/repo', 'my project');

    expect(repoPath).toBe('/mock/home/.komla/repos/my-project/.git');
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock/home/.komla/repos/my-project', {
      recursive: true,
    });
    expect(mockGitService.cloneBare).toHaveBeenCalledWith(
      '/src/repo',
      '/mock/home/.komla/repos/my-project/.git'
    );
    expect(mockGitService.removeRemote).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/my-project/.git',
      'origin'
    );
    expect(mockGitService.addRemote).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/my-project/.git',
      'origin',
      'git@github.com:org/repo.git'
    );
  });

  it('removes origin without adding a new one when source repo has no remote', async () => {
    mockGitService.getRemoteUrl.mockRejectedValue(new Error('no origin'));
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    await managedRepoService.createManagedRepo('/src/repo', 'no-remote');

    expect(mockGitService.removeRemote).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/no-remote/.git',
      'origin'
    );
    expect(mockGitService.addRemote).not.toHaveBeenCalled();
  });

  it('copies remote-tracking refs from source repo when origin exists', async () => {
    mockGitExec.execGitAsync.mockImplementation(async (_path: string, args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return 'refs/remotes/origin/main abc123\nrefs/remotes/origin/dev def456\n';
      }
      return '';
    });
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    await managedRepoService.createManagedRepo('/src/repo', 'with-refs');

    expect(mockGitExec.execGitAsync).toHaveBeenCalledWith('/src/repo', [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/remotes/origin/',
    ]);
    expect(mockGitExec.execGitAsync).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/with-refs/.git',
      ['update-ref', 'refs/remotes/origin/main', 'abc123']
    );
    expect(mockGitExec.execGitAsync).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/with-refs/.git',
      ['update-ref', 'refs/remotes/origin/dev', 'def456']
    );
  });

  it('skips refs/remotes/origin/HEAD when copying remote-tracking refs', async () => {
    mockGitExec.execGitAsync.mockImplementation(async (_path: string, args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return 'refs/remotes/origin/HEAD abc123\nrefs/remotes/origin/main def456\n';
      }
      return '';
    });
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    await managedRepoService.createManagedRepo('/src/repo', 'skip-head');

    // Should NOT copy HEAD
    expect(mockGitExec.execGitAsync).not.toHaveBeenCalledWith(expect.any(String), [
      'update-ref',
      'refs/remotes/origin/HEAD',
      'abc123',
    ]);
    // Should copy main
    expect(mockGitExec.execGitAsync).toHaveBeenCalledWith(
      '/mock/home/.komla/repos/skip-head/.git',
      ['update-ref', 'refs/remotes/origin/main', 'def456']
    );
  });

  it('does not copy refs when source has no remote', async () => {
    mockGitService.getRemoteUrl.mockRejectedValue(new Error('no origin'));
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    await managedRepoService.createManagedRepo('/src/repo', 'no-refs');

    expect(mockGitExec.execGitAsync).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['for-each-ref'])
    );
  });

  it('deletes the parent project folder when deleting a managed repo', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');
    mockFs.existsSync.mockReturnValue(true);

    await managedRepoService.deleteManagedRepo('/mock/home/.komla/repos/proj-a/.git');

    expect(mockFs.rmSync).toHaveBeenCalledWith('/mock/home/.komla/repos/proj-a', {
      recursive: true,
      force: true,
    });
  });

  it('returns zeroed remote status when origin remote does not exist', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');
    mockGitService.hasRemote.mockResolvedValue(false);

    const status = await managedRepoService.getRemoteStatus('/managed/repo.git', 'main');

    expect(status).toEqual({ hasRemote: false, ahead: 0, behind: 0, lastFetched: null });
    expect(mockGitService.getAheadBehind).not.toHaveBeenCalled();
  });

  it('returns null origin URL when repo is not bare', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');
    mockGitService.isBareRepo.mockResolvedValue(false);

    const origin = await managedRepoService.getOriginUrl('/managed/repo.git');

    expect(origin).toBeNull();
    expect(mockGitService.hasRemote).not.toHaveBeenCalled();
  });

  it('creates a managed repo directly from a remote URL', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');
    const onProgress = vi.fn();

    const repoPath = await managedRepoService.createManagedRepoFromRemote(
      'https://github.com/org/remote.git',
      'remote-project',
      onProgress
    );

    expect(repoPath).toBe('/mock/home/.komla/repos/remote-project/.git');
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock/home/.komla/repos/remote-project', {
      recursive: true,
    });
    expect(mockGitService.cloneBareFromRemote).toHaveBeenCalledWith(
      'https://github.com/org/remote.git',
      '/mock/home/.komla/repos/remote-project/.git',
      onProgress
    );
  });

  it('fetches from origin', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    const result = await managedRepoService.fetch('/managed/repo.git');

    expect(mockGitService.fetchAllBranches).toHaveBeenCalledWith('/managed/repo.git', 'origin');
    expect(result).toEqual({ success: true, message: 'Fetched from remote' });
  });

  it('pushes to origin', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');

    const result = await managedRepoService.push('/managed/repo.git', 'main');

    expect(mockGitService.pushToRemote).toHaveBeenCalledWith('/managed/repo.git', 'origin', 'main');
    expect(result).toEqual({ success: true, message: 'Pushed main to remote' });
  });

  it('checks existence of managed repo', async () => {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');
    mockFs.existsSync.mockReturnValue(true);
    mockGitService.isBareRepo.mockResolvedValue(true);

    const exists = await managedRepoService.exists('/managed/repo.git');

    expect(exists).toBe(true);
    expect(mockFs.existsSync).toHaveBeenCalledWith('/managed/repo.git');
    expect(mockGitService.isBareRepo).toHaveBeenCalledWith('/managed/repo.git');
  });

  describe('getProjectFolderPath collision detection', () => {
    it('returns different paths for project names that sanitize identically', async () => {
      // "my-project" and "my@project" both sanitize to "my-project"
      vi.resetModules();
      const { managedRepoService } =
        await import('../../../src/main/services/managed-repo.service');

      // First call for "my-project" — directory doesn't exist yet
      mockFs.existsSync.mockReturnValue(false);
      const path1 = managedRepoService.getProjectFolderPath('my-project');

      // Now simulate that directory exists with a .project-name marker for "my-project"
      const markerPath = path1 + '/.project-name';
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p === path1) return true;
        if (p === markerPath) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue('my-project');

      // Second call with different original name should detect collision
      const path2 = managedRepoService.getProjectFolderPath('my@project');
      expect(path2).not.toBe(path1);
    });

    it('returns same path for same project name on repeated calls', async () => {
      vi.resetModules();
      const { managedRepoService } =
        await import('../../../src/main/services/managed-repo.service');

      mockFs.existsSync.mockReturnValue(false);
      const path1 = managedRepoService.getProjectFolderPath('my-project');
      const path2 = managedRepoService.getProjectFolderPath('my-project');
      expect(path1).toBe(path2);
    });

    it('reuses a folder without a marker, such as one left by an interrupted create', async () => {
      const { managedRepoService } =
        await import('../../../src/main/services/managed-repo.service');

      mockFs.existsSync.mockImplementation(
        (p: string) => p === '/mock/home/.komla/repos/my-project'
      );
      expect(managedRepoService.getProjectFolderPath('my-project')).toBe(
        '/mock/home/.komla/repos/my-project'
      );
    });
  });
});
