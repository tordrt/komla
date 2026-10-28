import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

const {
  gitServiceMock,
  sshWorkspaceServiceMock,
  workspaceServiceMock,
  workspaceStatusServiceMock,
} = vi.hoisted(() => ({
  gitServiceMock: {
    getWorkingTreeDiff: vi.fn(),
    getWorkingTreeDiffAgainstBranch: vi.fn(),
    getFullFileDiff: vi.fn(),
    getFullFileDiffAgainstBranch: vi.fn(),
  },
  sshWorkspaceServiceMock: {
    getHost: vi.fn(),
    run: vi.fn(),
  },
  workspaceServiceMock: {
    get: vi.fn(),
  },
  workspaceStatusServiceMock: { read: vi.fn(), change: vi.fn() },
}));

vi.mock('../../../src/main/services/git.service', () => ({
  gitService: gitServiceMock,
}));

vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: sshWorkspaceServiceMock,
}));

vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: workspaceServiceMock,
}));

vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: workspaceStatusServiceMock,
}));

vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { get: vi.fn() },
}));

vi.mock('../../../src/main/services/managed-repo.service', () => ({
  managedRepoService: { getRemoteStatus: vi.fn() },
}));

describe('workspaceGitService', () => {
  const localWorkspace = {
    id: 'ws-local',
    workingDirectory: '/repo/worktree',
    backend: { kind: 'local' as const },
  };

  const sshWorkspace = {
    id: 'ws-ssh',
    workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/branch',
    backend: {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/branch',
      remoteRepoPath: '/home/dev/.komla/repos/app.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:example/app.git',
    },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sshWorkspaceServiceMock.getHost.mockReturnValue({ id: 'ssh-dev', name: 'SSH Dev' });
  });

  it('delegates local workspace diffs to gitService', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    gitServiceMock.getWorkingTreeDiff.mockResolvedValue({
      files: [{ path: 'a.ts', status: 'modified', staged: false, additions: 1, deletions: 0 }],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    });

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getWorkingTreeDiff('ws-local');

    expect(gitServiceMock.getWorkingTreeDiff).toHaveBeenCalledWith('/repo/worktree');
    expect(result.summary.filesChanged).toBe(1);
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('returns the cached SSH sidecar snapshot for base working tree diffs', async () => {
    const snapshot = {
      files: [{ path: 'remote.ts', status: 'modified', staged: false, additions: 2, deletions: 1 }],
      summary: { additions: 2, deletions: 1, filesChanged: 1 },
    };
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    workspaceStatusServiceMock.read.mockReturnValue(snapshot);

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getWorkingTreeDiff('ws-ssh');

    expect(result).toBe(snapshot);
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('does not query SSH while the remote workspace is provisioning', async () => {
    workspaceServiceMock.get.mockReturnValue({ ...sshWorkspace, provisioning: true });

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(workspaceGitService.getWorkingTreeDiff('ws-ssh')).resolves.toEqual({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    });
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('falls back to one-shot SSH status when no sidecar snapshot exists', async () => {
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      lastKnownGitStatus: {
        branch: { currentBranch: 'stale-branch' },
        diff: {
          files: [
            {
              path: 'stale.ts',
              status: 'modified',
              staged: false,
              additions: 1,
              deletions: 0,
            },
          ],
          summary: { additions: 1, deletions: 0, filesChanged: 1 },
        },
        updatedAt: 1234,
      },
    });
    workspaceStatusServiceMock.read.mockReturnValue(undefined);
    sshWorkspaceServiceMock.run.mockResolvedValue(
      `${Buffer.from(' M src/app.ts\0').toString('base64')}\n__KOMLA_NUMSTAT__\n${Buffer.from(
        '3\t1\tsrc/app.ts\0'
      ).toString('base64')}`
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getWorkingTreeDiff('ws-ssh');

    expect(result).toEqual({
      files: [
        { path: 'src/app.ts', status: 'modified', staged: false, additions: 3, deletions: 1 },
      ],
      summary: { additions: 3, deletions: 1, filesChanged: 1 },
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain(
      "cd '/home/dev/.komla/worktrees/app/branch'"
    );
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain('openssl base64 -A');
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain('git diff --no-index --numstat');
  });

  it('uses the original SSH rename path for the reference side', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    workspaceStatusServiceMock.read.mockReturnValue(undefined);
    sshWorkspaceServiceMock.run
      .mockResolvedValueOnce(
        `${Buffer.from('R  src/new.ts\0src/old.ts\0').toString('base64')}\n__KOMLA_NUMSTAT__\n${Buffer.from(
          '2\t1\t\0src/old.ts\0src/new.ts\0'
        ).toString('base64')}`
      )
      .mockResolvedValueOnce(
        [
          'OLD_EXISTS=1',
          'NEW_EXISTS=1',
          'BINARY=0',
          `OLD_B64=${Buffer.from('old text').toString('base64')}`,
          `NEW_B64=${Buffer.from('new text').toString('base64')}`,
          '',
        ].join('\n')
      );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    await workspaceGitService.getWorkingTreeDiff('ws-ssh');
    const result = await workspaceGitService.getFullFileDiff('ws-ssh', 'src/new.ts', false);

    expect(sshWorkspaceServiceMock.run.mock.calls[1][1]).toContain("old_file='src/old.ts'");
    expect(result).toEqual(
      expect.objectContaining({
        path: 'src/new.ts',
        oldContent: 'old text',
        newContent: 'new text',
        status: 'renamed',
      })
    );
  });

  it('reports when the SSH host has no supported diff encoder', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    workspaceStatusServiceMock.read.mockReturnValue(undefined);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=ENCODING_UNAVAILABLE\n');

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(workspaceGitService.getWorkingTreeDiff('ws-ssh')).rejects.toThrow(
      'Remote host needs base64 or openssl to view diffs'
    );
  });

  it('includes SSH untracked line counts from the workspace snapshot in branch diffs', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const unavailable = {
      path: 'unreadable.txt',
      status: 'untracked',
      staged: false,
      additions: 0,
      deletions: 0,
      lineCountsUnavailable: true,
    };
    workspaceStatusServiceMock.read.mockReturnValue({
      files: [
        { path: 'notes.txt', status: 'untracked', staged: false, additions: 91607, deletions: 0 },
        // Already present in the branch diff: retain its branch-relative counts.
        { path: 'src/app.ts', status: 'untracked', staged: false, additions: 50, deletions: 0 },
        { path: 'other.ts', status: 'modified', staged: false, additions: 10, deletions: 0 },
        unavailable,
      ],
      summary: { additions: 91667, deletions: 0, filesChanged: 4 },
    });
    sshWorkspaceServiceMock.run.mockResolvedValue(
      [
        Buffer.from('M\0src/app.ts\0').toString('base64'),
        '__KOMLA_NUMSTAT__',
        Buffer.from('3\t1\tsrc/app.ts\0').toString('base64'),
      ].join('\n')
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getWorkingTreeDiffAgainstBranch(
      'ws-ssh',
      'main',
      true
    );

    expect(result).toEqual({
      files: [
        { path: 'src/app.ts', status: 'modified', staged: false, additions: 3, deletions: 1 },
        { path: 'notes.txt', status: 'untracked', staged: false, additions: 91607, deletions: 0 },
        unavailable,
      ],
      summary: { additions: 91610, deletions: 1, filesChanged: 3 },
    });
    expect(sshWorkspaceServiceMock.run).toHaveBeenCalledTimes(1);
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain('target="origin/$branch"');
  });

  it.each([true, false])(
    'counts untracked SSH lines without a snapshot (merge base: %s)',
    async (useMergeBase) => {
      const directory = mkdtempSync(join(tmpdir(), 'komla-branch-counts-'));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: directory });
      // Windows forbids tabs in filenames; retain tab coverage on POSIX.
      const untrackedPath =
        process.platform === 'win32' ? "notes 'with spaces.txt" : "notes 'with\ttabs.txt";
      try {
        git('init', '-b', 'main');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        writeFileSync(join(directory, 'tracked.txt'), 'old\n');
        git('add', '.');
        git('commit', '-qm', 'base');
        writeFileSync(join(directory, 'tracked.txt'), 'new\n');
        writeFileSync(join(directory, untrackedPath), 'one\ntwo\nthree');
        writeFileSync(join(directory, 'empty.txt'), '');
        writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
        workspaceServiceMock.get.mockReturnValue({
          ...sshWorkspace,
          backend: { ...sshWorkspace.backend, remoteDirectory: directory },
        });
        workspaceStatusServiceMock.read.mockReturnValue(undefined);
        sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
          execFileSync('sh', ['-c', command], { encoding: 'utf8' })
        );
        const { workspaceGitService } =
          await import('../../../src/main/services/workspace-git.service');
        const result = await workspaceGitService.getWorkingTreeDiffAgainstBranch(
          'ws-ssh',
          'main',
          useMergeBase
        );
        expect(result.summary).toEqual({ additions: 4, deletions: 1, filesChanged: 4 });
        expect(result.files).toContainEqual({
          path: untrackedPath,
          status: 'untracked',
          staged: false,
          additions: 3,
          deletions: 0,
        });
      } finally {
        sshWorkspaceServiceMock.run.mockReset();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('decodes selected SSH file diff content on demand', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue(
      [
        'OLD_EXISTS=1',
        'NEW_EXISTS=1',
        'BINARY=0',
        `OLD_B64=${Buffer.from('old text').toString('base64')}`,
        `NEW_B64=${Buffer.from('new text').toString('base64')}`,
        '',
      ].join('\n')
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getFullFileDiff('ws-ssh', 'src/app.ts', false);

    expect(result).toEqual({
      path: 'src/app.ts',
      oldContent: 'old text',
      newContent: 'new text',
      status: 'modified',
      isBinary: false,
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain("file='src/app.ts'");
  });

  it.each([
    { useMergeBase: true, remoteOnly: false },
    { useMergeBase: true, remoteOnly: true },
    { useMergeBase: false, remoteOnly: false },
    { useMergeBase: false, remoteOnly: true },
  ])('fetches SSH branch diff content in one command: %j', async ({ useMergeBase, remoteOnly }) => {
    const directory = mkdtempSync(join(tmpdir(), 'komla-branch-diff-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    // Exercise shell quoting as well as local/origin target resolution.
    const branch = "target'branch";
    const filePath = "file 'with spaces.txt";
    try {
      git('init', '-b', 'feature');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(directory, filePath), 'base text\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      git('checkout', '-qb', branch);
      writeFileSync(join(directory, filePath), 'target text\n');
      git('commit', '-qam', 'target change');
      git('checkout', '-q', 'feature');
      if (remoteOnly) {
        git('update-ref', `refs/remotes/origin/${branch}`, branch);
        git('branch', '-D', branch);
      }
      writeFileSync(join(directory, filePath), 'working text\n');
      workspaceServiceMock.get.mockReturnValue({
        ...sshWorkspace,
        backend: { ...sshWorkspace.backend, remoteDirectory: directory },
      });
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
        execFileSync('sh', ['-c', command], { encoding: 'utf8' })
      );
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');
      const result = await workspaceGitService.getFullFileDiffAgainstBranch(
        'ws-ssh',
        filePath,
        branch,
        useMergeBase
      );

      expect(result).toEqual({
        path: filePath,
        oldContent: useMergeBase ? 'base text\n' : 'target text\n',
        newContent: 'working text\n',
        status: 'modified',
        isBinary: false,
      });
      expect(sshWorkspaceServiceMock.run).toHaveBeenCalledTimes(1);
    } finally {
      sshWorkspaceServiceMock.run.mockReset();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves empty content for existing sides of an SSH file diff', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue(
      ['OLD_EXISTS=1', 'NEW_EXISTS=1', 'BINARY=0', 'OLD_B64=', 'NEW_B64=', ''].join('\n')
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getFullFileDiff('ws-ssh', 'empty.txt', false);

    expect(result.oldContent).toBe('');
    expect(result.newContent).toBe('');
    expect(result.status).toBe('modified');
  });

  it('keeps missing SSH diff sides null while preserving an existing empty side', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue(
      ['OLD_EXISTS=0', 'NEW_EXISTS=1', 'BINARY=0', 'OLD_B64=', 'NEW_B64=', ''].join('\n')
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getFullFileDiff('ws-ssh', 'empty.txt', false);

    expect(result.oldContent).toBeNull();
    expect(result.newContent).toBe('');
    expect(result.status).toBe('added');
  });

  it('sizes both SSH diff sides before encoding either payload', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue(
      ['OLD_EXISTS=1', 'NEW_EXISTS=0', 'BINARY=1', 'OLD_B64=', 'NEW_B64=', ''].join('\n')
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    const result = await workspaceGitService.getFullFileDiff('ws-ssh', 'large.txt', false);
    const command = sshWorkspaceServiceMock.run.mock.calls[0][1] as string;

    expect(command).toContain('git cat-file -s "$ref:$old_file"');
    expect(command).toContain('combined_size=$((old_size + new_size))');
    expect(command.indexOf('git cat-file -s "$ref:$old_file"')).toBeLessThan(
      command.indexOf('old_b64=$(git show')
    );
    expect(command.indexOf('combined_size=$((old_size + new_size))')).toBeLessThan(
      command.indexOf('old_b64=$(git show')
    );
    expect(result).toEqual({
      path: 'large.txt',
      oldContent: null,
      newContent: null,
      status: 'deleted',
      isBinary: true,
    });
  });

  it('rejects SSH file paths that escape the workspace', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');
    await expect(workspaceGitService.getFullFileDiff('ws-ssh', '../secret', false)).rejects.toThrow(
      'escapes the workspace'
    );
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });
});
