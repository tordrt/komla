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

const PARENT = '1'.repeat(40);
const OTHER_PARENT = '2'.repeat(40);

// `git log` output for `commitInfoLogArgs`.
function commitInfo(hash: string, parents: string[], subject: string): string {
  return [
    hash,
    hash.slice(0, 7),
    parents.join(' '),
    '1700000000',
    '',
    'John',
    'john@test.com',
    subject,
  ].join('\x1f');
}

describe('GitHistoryService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setup() {
    const gitExecMod = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsync');
    const execBufferSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsyncBuffer');
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');
    return { gitHistoryService, execSpy, execBufferSpy };
  }

  describe('getCommitGraph', () => {
    function record(fields: string[]): string {
      return fields.join('\x1f') + '\n\0';
    }

    function mockGit(
      execSpy: Awaited<ReturnType<typeof setup>>['execSpy'],
      responses: { log: string | Error; upstream?: string; head?: boolean }
    ) {
      execSpy.mockImplementation(async (_path, args) => {
        if (args.includes('log')) {
          if (responses.log instanceof Error) throw responses.log;
          return responses.log;
        }
        if (args.includes('@{upstream}')) {
          if (responses.upstream === undefined) throw new Error('no upstream configured');
          return responses.upstream;
        }
        if (args.includes('--verify')) {
          if (!responses.head) throw new Error('');
          return 'abc';
        }
        throw new Error(`unexpected git ${args.join(' ')}`);
      });
    }

    it('reads HEAD history with each commit and the refs on it', async () => {
      const { gitHistoryService, execSpy } = await setup();
      mockGit(execSpy, {
        log:
          record([
            'c2',
            'c1 m1',
            'Alice',
            '1700000002',
            'HEAD -> refs/heads/feature, refs/remotes/origin/feature, refs/remotes/origin/HEAD, refs/komla/backup',
            'Merge main\n\nBody line',
          ]) +
          record(['c1', '', 'Bob', '1700000001', 'tag: refs/tags/v1.0, refs/heads/main', 'Init']),
        upstream: 'refs/remotes/origin/feature',
      });

      const graph = await gitHistoryService.getCommitGraph('/repo', { limit: 50 });

      expect(graph).toEqual({
        commits: [
          {
            hash: 'c2',
            parentHashes: ['c1', 'm1'],
            author: 'Alice',
            timestamp: 1700000002,
            message: 'Merge main\n\nBody line',
            refs: [
              { kind: 'branch', name: 'feature' },
              { kind: 'remote', name: 'origin/feature' },
            ],
          },
          {
            hash: 'c1',
            parentHashes: [],
            author: 'Bob',
            timestamp: 1700000001,
            message: 'Init',
            refs: [
              { kind: 'tag', name: 'v1.0' },
              { kind: 'branch', name: 'main' },
            ],
          },
        ],
        hasMore: false,
        currentBranch: 'feature',
        upstream: 'origin/feature',
      });
      const logArgs = execSpy.mock.calls.find(([, args]) => args.includes('log'))![1];
      expect(logArgs).toEqual(expect.arrayContaining(['--topo-order', '-z', 'HEAD']));
    });

    it('asks for one commit more than it shows, to tell whether older ones exist', async () => {
      const { gitHistoryService, execSpy } = await setup();
      mockGit(execSpy, {
        log: ['c3', 'c2', 'c1']
          .map((hash, i) => record([hash, '', 'A', String(i), 'HEAD', 'msg']))
          .join(''),
      });

      const graph = await gitHistoryService.getCommitGraph('/repo', { limit: 2 });

      const logArgs = execSpy.mock.calls.find(([, args]) => args.includes('log'))![1];
      expect(logArgs[logArgs.indexOf('-n') + 1]).toBe('3');
      expect(graph.commits.map((commit) => commit.hash)).toEqual(['c3', 'c2']);
      expect(graph.hasMore).toBe(true);
      // Detached: HEAD names no branch.
      expect(graph.currentBranch).toBeNull();
      expect(graph.upstream).toBeNull();
    });

    it("reads older commits of a branch's history of one file, following renames", async () => {
      const { gitHistoryService, execSpy } = await setup();
      mockGit(execSpy, { log: '' });

      await gitHistoryService.getCommitGraph('/repo', {
        limit: 50,
        skip: 50,
        ref: 'feature',
        path: 'src/a.ts',
      });

      const logArgs = execSpy.mock.calls.find(([, args]) => args.includes('log'))![1];
      expect(logArgs[0]).toBe('--literal-pathspecs');
      expect(logArgs).toContain('--follow');
      expect(logArgs).not.toContain('--topo-order');
      // --follow counts --skip over every commit, so the skipped ones are read and dropped.
      expect(logArgs).not.toContain('--skip');
      expect(logArgs.slice(logArgs.indexOf('-n'))).toEqual([
        '-n',
        '101',
        'feature',
        '--',
        'src/a.ts',
      ]);
    });

    it('shows no commits on a branch that has none yet', async () => {
      const { gitHistoryService, execSpy } = await setup();
      mockGit(execSpy, { log: new Error('does not have any commits yet'), head: false });

      await expect(gitHistoryService.getCommitGraph('/repo', { limit: 50 })).resolves.toMatchObject(
        {
          commits: [],
          hasMore: false,
        }
      );
    });

    it('reports a failure when HEAD has commits', async () => {
      const { gitHistoryService, execSpy } = await setup();
      mockGit(execSpy, { log: new Error('git exploded'), head: true });

      await expect(gitHistoryService.getCommitGraph('/repo', { limit: 50 })).rejects.toThrow(
        'git exploded'
      );
    });
  });

  describe('getCommitDiff', () => {
    it('returns commit info and file changes', async () => {
      const { gitHistoryService, execSpy } = await setup();
      const info = commitInfo('abc123', [PARENT], 'Fix bug');
      execSpy
        .mockResolvedValueOnce(info) // commit info
        .mockResolvedValueOnce('10\t3\tfile.ts') // numstat
        .mockResolvedValueOnce('M\0file.ts\0'); // name-status

      const result = await gitHistoryService.getCommitDiff('/repo', 'abc123');
      expect(result.commit.hash).toBe('abc123');
      expect(result.commit.message).toBe('Fix bug');
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        path: 'file.ts',
        status: 'modified',
        additions: 10,
        deletions: 3,
      });
      expect(result.summary).toEqual({ additions: 10, deletions: 3, filesChanged: 1 });
    });

    it('handles root commit (no parents)', async () => {
      const { gitHistoryService, execSpy } = await setup();
      const info = commitInfo('abc123', [], 'Initial');
      execSpy
        .mockResolvedValueOnce(info) // commit info
        .mockResolvedValueOnce('5\t0\tfile.ts') // numstat
        .mockResolvedValueOnce('A\0file.ts\0'); // name-status

      const result = await gitHistoryService.getCommitDiff('/repo', 'abc123');
      expect(result.commit.parentHashes).toEqual([]);
      expect(result.files[0].status).toBe('added');
    });

    it('shows what a merge brought in, against its first parent', async () => {
      const { gitHistoryService, execSpy } = await setup();
      const info = commitInfo('m1', [PARENT, OTHER_PARENT], 'Merge');
      execSpy
        .mockResolvedValueOnce(info)
        .mockResolvedValueOnce('4\t0\tfrom-branch.ts')
        .mockResolvedValueOnce('A\0from-branch.ts\0');

      const result = await gitHistoryService.getCommitDiff('/repo', 'm1');

      expect(execSpy.mock.calls[1][1]).toEqual([
        'diff-tree',
        '-r',
        '-z',
        '--numstat',
        PARENT,
        'm1',
      ]);
      expect(result.files).toEqual([
        expect.objectContaining({ path: 'from-branch.ts', status: 'added', additions: 4 }),
      ]);
    });

    it('handles binary files in numstat', async () => {
      const { gitHistoryService, execSpy } = await setup();
      const info = commitInfo('abc123', [PARENT], 'Add image');
      execSpy
        .mockResolvedValueOnce(info)
        .mockResolvedValueOnce('-\t-\timage.png')
        .mockResolvedValueOnce('A\0image.png\0');

      const result = await gitHistoryService.getCommitDiff('/repo', 'abc123');
      expect(result.files[0].additions).toBe(0);
      expect(result.files[0].deletions).toBe(0);
    });

    it('handles deleted files', async () => {
      const { gitHistoryService, execSpy } = await setup();
      const info = commitInfo('abc123', [PARENT], 'Remove file');
      execSpy
        .mockResolvedValueOnce(info)
        .mockResolvedValueOnce('0\t20\told.ts')
        .mockResolvedValueOnce('D\0old.ts\0');

      const result = await gitHistoryService.getCommitDiff('/repo', 'abc123');
      expect(result.files[0].status).toBe('deleted');
      expect(result.files[0].deletions).toBe(20);
    });

    it('handles renamed files', async () => {
      const { gitHistoryService, execSpy } = await setup();
      const info = commitInfo('abc123', [PARENT], 'Rename');
      execSpy
        .mockResolvedValueOnce(info)
        .mockResolvedValueOnce('0\t0\t\0old.ts\0new.ts\0')
        .mockResolvedValueOnce('R100\0old.ts\0new.ts\0');

      const result = await gitHistoryService.getCommitDiff('/repo', 'abc123');
      expect(result.files.find((f) => f.path === 'new.ts')?.status).toBe('renamed');
    });
  });

  describe('getCommitFileDiff', () => {
    it('returns file content for a text file', async () => {
      const { gitHistoryService, execSpy, execBufferSpy } = await setup();
      execSpy
        .mockResolvedValueOnce(PARENT) // first parent
        .mockResolvedValueOnce('M\tfile.ts') // name-status
        .mockResolvedValueOnce('5\t2\tfile.ts'); // numstat
      execBufferSpy
        .mockResolvedValueOnce(Buffer.from('old content')) // show parent
        .mockResolvedValueOnce(Buffer.from('new content')); // show commit

      const result = await gitHistoryService.getCommitFileDiff('/repo', 'abc123', 'file.ts');
      expect(result.oldContent).toBe('old content');
      expect(result.newContent).toBe('new content');
      expect(result.status).toBe('modified');
      expect(result.isBinary).toBe(false);
    });

    it('returns null old content for added files', async () => {
      const { gitHistoryService, execSpy, execBufferSpy } = await setup();
      execSpy
        .mockResolvedValueOnce(PARENT)
        .mockResolvedValueOnce('A\tfile.ts')
        .mockResolvedValueOnce('5\t0\tfile.ts');
      execBufferSpy.mockResolvedValueOnce(Buffer.from('new content'));

      const result = await gitHistoryService.getCommitFileDiff('/repo', 'abc123', 'file.ts');
      expect(result.oldContent).toBeNull();
      expect(result.newContent).toBe('new content');
      expect(result.status).toBe('added');
    });

    it('returns null new content for deleted files', async () => {
      const { gitHistoryService, execSpy, execBufferSpy } = await setup();
      execSpy
        .mockResolvedValueOnce(PARENT)
        .mockResolvedValueOnce('D\tfile.ts')
        .mockResolvedValueOnce('0\t10\tfile.ts');
      execBufferSpy.mockResolvedValueOnce(Buffer.from('old content'));

      const result = await gitHistoryService.getCommitFileDiff('/repo', 'abc123', 'file.ts');
      expect(result.oldContent).toBe('old content');
      expect(result.newContent).toBeNull();
      expect(result.status).toBe('deleted');
    });

    it("compares a merge's file with the merge's first parent", async () => {
      const { gitHistoryService, execSpy, execBufferSpy } = await setup();
      execSpy
        .mockResolvedValueOnce(PARENT)
        .mockResolvedValueOnce('A\tfile.ts')
        .mockResolvedValueOnce('3\t0\tfile.ts');
      execBufferSpy.mockResolvedValueOnce(Buffer.from('content'));

      const result = await gitHistoryService.getCommitFileDiff('/repo', 'm1', 'file.ts');

      expect(execSpy.mock.calls[1][1]).toEqual([
        '--literal-pathspecs',
        'diff-tree',
        '-r',
        '-z',
        '--name-status',
        PARENT,
        'm1',
        '--',
        'file.ts',
      ]);
      expect(result).toMatchObject({ status: 'added', oldContent: null, newContent: 'content' });
    });

    it('marks binary files', async () => {
      const { gitHistoryService, execSpy } = await setup();
      execSpy
        .mockResolvedValueOnce(PARENT)
        .mockResolvedValueOnce('M\tfile.bin')
        .mockResolvedValueOnce('-\t-\tfile.bin');

      const result = await gitHistoryService.getCommitFileDiff('/repo', 'abc123', 'file.bin');
      expect(result.isBinary).toBe(true);
      expect(result.oldContent).toBeNull();
      expect(result.newContent).toBeNull();
    });

    it('handles root commit file diff', async () => {
      const { gitHistoryService, execSpy, execBufferSpy } = await setup();
      execSpy
        .mockResolvedValueOnce('') // no parent
        .mockResolvedValueOnce('A\tfile.ts')
        .mockResolvedValueOnce('3\t0\tfile.ts');
      execBufferSpy.mockResolvedValueOnce(Buffer.from('content'));

      const result = await gitHistoryService.getCommitFileDiff('/repo', 'abc123', 'file.ts');
      expect(result.status).toBe('added');
      expect(result.oldContent).toBeNull();
      expect(result.newContent).toBe('content');
    });
  });
});
