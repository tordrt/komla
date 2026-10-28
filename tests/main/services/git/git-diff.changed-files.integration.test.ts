/**
 * The changed-files list of a local workspace comes from `git status` and `git diff
 * --numstat`, and the comparison against a branch from `git diff <branch>`, locally and
 * over SSH. These run real git (the SSH scripts in a local shell) so renames, copies and
 * names git would quote reach the list as the paths on disk.
 */
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../../../../src/shared/types/workspace';

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
vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    getHost: vi.fn(() => ({ id: 'local-shell' })),
    run: vi.fn(
      async (_host: unknown, script: string) => (await execFileAsync('sh', ['-c', script])).stdout
    ),
  },
}));
vi.mock('../../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: { read: vi.fn(() => undefined) },
}));

describe('gitDiffService changed files', () => {
  let repoPath: string;

  const git = (...args: string[]) => execFileAsync('git', args, { cwd: repoPath });

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    repoPath = mkdtempSync(join(tmpdir(), 'komla-changed-files-'));
    // A global diff.renames or status.renames would change what git reports.
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(repoPath, '.no-global-gitconfig'));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const gitDiff = async () =>
    (await import('../../../../src/main/services/git/git-diff')).gitDiffService;
  const sshWorkspace = () =>
    ({
      id: 'ssh',
      workingDirectory: repoPath,
      backend: { kind: 'ssh', hostId: 'local-shell', remoteDirectory: repoPath },
    }) as Workspace;

  // The file list, the diff view and the branch comparison each build the list with
  // their own git calls. Comparing against `main`, the commit HEAD is on, shows the
  // same changes as the working tree.
  const workingTreeListings = {
    getChangedFilesWithSummary: async () => (await gitDiff()).getChangedFilesWithSummary(repoPath),
    getWorkingTreeDiff: async () => (await gitDiff()).getWorkingTreeDiff(repoPath),
  };
  const listings = {
    ...workingTreeListings,
    getWorkingTreeDiffAgainstBranch: async () =>
      (await gitDiff()).getWorkingTreeDiffAgainstBranch(repoPath, 'main'),
    'SSH getWorkingTreeDiffAgainstBranch': async () => {
      const { sshWorkspaceDiff } =
        await import('../../../../src/main/services/workspace-git/ssh-diff');
      return sshWorkspaceDiff.getWorkingTreeDiffAgainstBranch(sshWorkspace(), 'main', false);
    },
  };
  const fileDiffs = {
    getFullFileDiff: async (filePath: string) =>
      (await gitDiff()).getFullFileDiff(repoPath, filePath),
    // The branch view opens files from the comparison it just listed.
    getFullFileDiffAgainstBranch: async (filePath: string) => {
      const service = await gitDiff();
      await service.getWorkingTreeDiffAgainstBranch(repoPath, 'main');
      return service.getFullFileDiffAgainstBranch(repoPath, filePath, 'main');
    },
  };
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `${index + 1}\n`).join('');
  const commitAll = async () => {
    await git('add', '.');
    await git('commit', '-q', '-m', 'commit');
  };

  it.each(Object.keys(listings))('%s lists a staged rename under its new path', async (listing) => {
    writeFileSync(join(repoPath, 'old.ts'), 'one\ntwo\nthree\nfour\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    await git('mv', 'old.ts', 'new.ts');
    writeFileSync(join(repoPath, 'new.ts'), 'one\ntwo\nthree\nfour\nfive\n');

    const { files, summary } = await listings[listing as keyof typeof listings]();

    expect(files).toEqual([
      expect.objectContaining({
        path: 'new.ts',
        originalPath: 'old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 0,
      }),
    ]);
    expect(summary).toEqual({ additions: 1, deletions: 0, filesChanged: 1 });
  });

  it.each(Object.keys(fileDiffs))(
    "%s diffs a renamed file against its previous path's content",
    async (fileDiff) => {
      writeFileSync(join(repoPath, 'old.ts'), 'one\ntwo\n');
      await git('add', '.');
      await git('commit', '-q', '-m', 'init');
      await git('mv', 'old.ts', 'new.ts');
      writeFileSync(join(repoPath, 'new.ts'), 'one\ntwo\nthree\n');

      const diff = await fileDiffs[fileDiff as keyof typeof fileDiffs]('new.ts');

      expect(diff).toMatchObject({
        path: 'new.ts',
        status: 'renamed',
        oldContent: 'one\ntwo\n',
        newContent: 'one\ntwo\nthree\n',
      });
    }
  );

  it.each(Object.keys(fileDiffs))(
    "%s keeps the committed content's surrounding whitespace and final newline",
    async (fileDiff) => {
      writeFileSync(join(repoPath, 'a.ts'), '\n  one\ntwo\n');
      await commitAll();
      writeFileSync(join(repoPath, 'a.ts'), '\n  one\ntwo\nthree\n');

      const diff = await fileDiffs[fileDiff as keyof typeof fileDiffs]('a.ts');

      expect(diff).toMatchObject({
        status: 'modified',
        oldContent: '\n  one\ntwo\n',
        newContent: '\n  one\ntwo\nthree\n',
      });
    }
  );

  it.each(Object.keys(listings))(
    '%s keeps names git would quote as they are on disk',
    async (listing) => {
      writeFileSync(join(repoPath, 'café.md'), 'a\n');
      writeFileSync(join(repoPath, 'say "hi".md'), 'a\n');
      await git('add', '.');
      await git('commit', '-q', '-m', 'init');
      writeFileSync(join(repoPath, 'café.md'), 'a\nb\n');
      writeFileSync(join(repoPath, 'say "hi".md'), 'a\nb\n');
      writeFileSync(join(repoPath, 'naïve.txt'), 'new\n');

      const { files, summary } = await listings[listing as keyof typeof listings]();

      expect(files.map(({ path, status, additions }) => ({ path, status, additions }))).toEqual(
        expect.arrayContaining([
          { path: 'café.md', status: 'modified', additions: 1 },
          { path: 'say "hi".md', status: 'modified', additions: 1 },
          { path: 'naïve.txt', status: 'untracked', additions: 1 },
        ])
      );
      expect(files).toHaveLength(3);
      expect(summary).toEqual({ additions: 3, deletions: 0, filesChanged: 3 });
    }
  );

  it.each(Object.keys(workingTreeListings))(
    '%s counts lines for the files git status lists',
    async (listing) => {
      writeFileSync(join(repoPath, 'a.txt'), lines(50));
      await commitAll();
      // Against the working tree alone, git would pair these two as a rename.
      writeFileSync(join(repoPath, 'b.txt'), `${lines(50)}x\n`);
      await git('add', 'b.txt');
      rmSync(join(repoPath, 'a.txt'));

      const { files, summary } =
        await workingTreeListings[listing as keyof typeof workingTreeListings]();

      expect(
        files.map(({ path, status, additions, deletions }) => ({
          path,
          status,
          additions,
          deletions,
        }))
      ).toEqual(
        expect.arrayContaining([
          { path: 'b.txt', status: 'added', additions: 51, deletions: 0 },
          { path: 'a.txt', status: 'deleted', additions: 0, deletions: 50 },
        ])
      );
      expect(files).toHaveLength(2);
      expect(summary).toEqual({ additions: 51, deletions: 50, filesChanged: 2 });
    }
  );

  it.each(Object.keys(listings))(
    '%s lists a rename whose new file is gone as its previous path deleted',
    async (listing) => {
      writeFileSync(join(repoPath, 'a.txt'), lines(3));
      await commitAll();
      await git('mv', 'a.txt', 'b.txt');
      rmSync(join(repoPath, 'b.txt'));

      const { files, summary } = await listings[listing as keyof typeof listings]();

      expect(files).toEqual([
        expect.objectContaining({ path: 'a.txt', status: 'deleted', additions: 0, deletions: 3 }),
      ]);
      expect(files[0]).not.toHaveProperty('originalPath');
      expect(summary).toEqual({ additions: 0, deletions: 3, filesChanged: 1 });
    }
  );

  it.each(Object.keys(listings))('%s lists a copy as an added file', async (listing) => {
    await git('config', 'diff.renames', 'copies');
    await git('config', 'status.renames', 'copies');
    writeFileSync(join(repoPath, 'src.ts'), lines(20));
    await commitAll();
    writeFileSync(join(repoPath, 'dst.ts'), `${lines(20)}extra\n`);
    writeFileSync(join(repoPath, 'src.ts'), lines(21));
    await git('add', '.');

    const { files, summary } = await listings[listing as keyof typeof listings]();

    expect(
      files.map(({ path, status, additions, originalPath }) => ({
        path,
        status,
        additions,
        originalPath,
      }))
    ).toEqual(
      expect.arrayContaining([
        { path: 'dst.ts', status: 'added', additions: 21, originalPath: undefined },
        { path: 'src.ts', status: 'modified', additions: 1, originalPath: undefined },
      ])
    );
    expect(files).toHaveLength(2);
    expect(summary).toEqual({ additions: 22, deletions: 0, filesChanged: 2 });
  });

  it.each(Object.keys(listings))(
    '%s lists a rename git sees only in the working tree',
    async (listing) => {
      writeFileSync(join(repoPath, 'old.ts'), lines(10));
      await commitAll();
      // `git add -N` gives git the new path without staging it, so status reports ' R'.
      rmSync(join(repoPath, 'old.ts'));
      writeFileSync(join(repoPath, 'new.ts'), lines(11));
      await git('add', '-N', 'new.ts');

      const { files, summary } = await listings[listing as keyof typeof listings]();

      expect(files).toEqual([
        expect.objectContaining({
          path: 'new.ts',
          originalPath: 'old.ts',
          status: 'renamed',
          additions: 1,
          deletions: 0,
        }),
      ]);
      expect(summary).toEqual({ additions: 1, deletions: 0, filesChanged: 1 });
    }
  );

  it.each(Object.keys(listings))(
    '%s lists a file added with git add -N as added',
    async (listing) => {
      writeFileSync(join(repoPath, 'old.ts'), lines(1));
      await commitAll();
      writeFileSync(join(repoPath, 'new.ts'), lines(3));
      await git('add', '-N', 'new.ts');

      const { files } = await listings[listing as keyof typeof listings]();

      expect(files).toEqual([
        expect.objectContaining({ path: 'new.ts', status: 'added', additions: 3, deletions: 0 }),
      ]);
    }
  );

  it.each(Object.keys(workingTreeListings))(
    '%s counts a rename git no longer pairs as a rewrite of its previous path',
    async (listing) => {
      writeFileSync(join(repoPath, 'b.txt'), lines(50));
      await commitAll();
      await git('mv', 'b.txt', 'c.txt');
      // Too little is left for `git diff -M` to pair c.txt with b.txt, though status
      // still reports the staged rename.
      writeFileSync(join(repoPath, 'c.txt'), lines(201).replaceAll('\n', 'x\n'));

      const { files, summary } =
        await workingTreeListings[listing as keyof typeof workingTreeListings]();

      expect(files).toEqual([
        expect.objectContaining({
          path: 'c.txt',
          originalPath: 'b.txt',
          status: 'renamed',
          additions: 201,
          deletions: 50,
        }),
      ]);
      expect(summary).toEqual({ additions: 201, deletions: 50, filesChanged: 1 });
    }
  );

  it('reads line counts with one git diff while a rename is staged', async () => {
    writeFileSync(join(repoPath, 'old.ts'), lines(10));
    await commitAll();
    await git('mv', 'old.ts', 'new.ts');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExec, 'execGitAsync');

    await (await gitDiff()).getChangedFilesWithSummary(repoPath);

    expect(execSpy.mock.calls.filter(([, args]) => args[0] === 'diff')).toHaveLength(1);
  });
});
