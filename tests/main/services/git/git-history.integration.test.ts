/**
 * A commit's message and author are whatever the repository holds, so reading them back must
 * never steer git's arguments. These run real git against scratch repositories.
 */
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommitGraphQuery } from '../../../../src/shared/types/commit-graph';

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

// Inherited from `git rebase --exec`, hooks or `git -c`, these would point git at
// another repository or inject config, so the test must not see them.
const INHERITED_GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

describe('GitHistoryService with real git', () => {
  let tempDir: string;
  let repo: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'komla-git-history-'));
    repo = join(tempDir, 'repo');
    for (const key of INHERITED_GIT_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(tempDir, 'gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Ada');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ada@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Ada');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ada@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: repo });
    return stdout.trim();
  }

  async function commit(file: string, message: string): Promise<string> {
    writeFileSync(join(repo, file), `${file}\n`);
    await git('add', file);
    await git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  }

  async function subjects(query: CommitGraphQuery): Promise<string[]> {
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');
    const graph = await gitHistoryService.getCommitGraph(repo, query);
    return graph.commits.map((c) => c.message);
  }

  it("reads a commit whose subject imitates the log's fields without handing it to git", async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    const base = await commit('a.txt', 'base');
    const victim = join(tempDir, 'victim.txt');
    const subject = ['fix', 'a', 'b', 'c', `--output=${victim}`].join('---FIELD---');
    const hash = await commit('b.txt', subject);
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');

    const diff = await gitHistoryService.getCommitDiff(repo, hash);

    expect(existsSync(victim)).toBe(false);
    expect(diff.commit).toMatchObject({ hash, parentHashes: [base], author: 'Ada' });
    expect(diff.commit.message).toBe(subject);
    expect(diff.files).toEqual([expect.objectContaining({ path: 'b.txt', status: 'added' })]);
  });

  it("pages through a file's history past commits that skip it and past a rename", async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    await commit('a.txt', 'one');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    await git('commit', '-qam', 'two');
    await git('mv', 'a.txt', 'b.txt');
    await git('commit', '-qm', 'rename');
    writeFileSync(join(repo, 'b.txt'), 'three\n');
    await git('commit', '-qam', 'three');
    await commit('other.txt', 'other');
    writeFileSync(join(repo, 'b.txt'), 'four\n');
    await git('commit', '-qam', 'four');

    expect(await subjects({ limit: 2, path: 'b.txt' })).toEqual(['four', 'three']);
    expect(await subjects({ limit: 2, skip: 2, path: 'b.txt' })).toEqual(['rename', 'two']);
    expect(await subjects({ limit: 2, skip: 4, path: 'b.txt' })).toEqual(['one']);
  });

  it('reads a signed commit while git is set to show signatures', async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    const base = await commit('a.txt', 'base');
    writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 1, 2]));
    await git('add', 'b.bin');
    const object = [
      `tree ${await git('write-tree')}`,
      `parent ${base}`,
      'author Ada <ada@example.com> 1700000000 +0000',
      'committer Ada <ada@example.com> 1700000000 +0000',
      // Git can't verify it without allowed signers, and says so on stdout.
      'gpgsig -----BEGIN SSH SIGNATURE-----',
      ' U1NIU0lH',
      ' -----END SSH SIGNATURE-----',
      '',
      'signed',
      '',
    ].join('\n');
    const hash = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo,
      input: object,
    })
      .toString()
      .trim();
    await git('update-ref', 'refs/heads/main', hash);
    await git('config', 'log.showSignature', 'true');
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');

    const diff = await gitHistoryService.getCommitDiff(repo, hash);
    expect(diff.commit).toMatchObject({ hash, parentHashes: [base], message: 'signed' });
    await expect(gitHistoryService.getCommitFileDiff(repo, hash, 'b.bin')).resolves.toMatchObject({
      status: 'added',
      isBinary: true,
    });
  });

  it('reads a file whose name is not ASCII', async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    await commit('a.txt', 'base');
    const hash = await commit('café.txt', 'cafe');
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');

    const diff = await gitHistoryService.getCommitDiff(repo, hash);
    expect(diff.files).toEqual([
      expect.objectContaining({ path: 'café.txt', status: 'added', additions: 1 }),
    ]);
    await expect(
      gitHistoryService.getCommitFileDiff(repo, hash, 'café.txt')
    ).resolves.toMatchObject({ status: 'added', newContent: expect.stringContaining('café.txt') });
  });

  it("keeps a file's surrounding whitespace and final newline on both sides of a commit", async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), '\n  one\n');
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', 'base');
    writeFileSync(join(repo, 'a.txt'), '\n  one\ntwo\n');
    await git('commit', '-qam', 'two');
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');

    await expect(
      gitHistoryService.getCommitFileDiff(repo, await git('rev-parse', 'HEAD'), 'a.txt')
    ).resolves.toMatchObject({ oldContent: '\n  one\n', newContent: '\n  one\ntwo\n' });
  });

  it("reads a commit's whole message, its author as mailmapped and its refs", async () => {
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, '.mailmap'), 'Ada Lovelace <ada@example.com>\n');
    await git('add', '.mailmap');
    const hash = await commit('a.txt', 'Add a\n\nWith a body.');
    await git('tag', 'v1');
    const { gitHistoryService } = await import('../../../../src/main/services/git/git-history');

    const { commit: info } = await gitHistoryService.getCommitDiff(repo, hash);

    expect(info).toMatchObject({ message: 'Add a\n\nWith a body.', author: 'Ada Lovelace' });
    expect(info.refs).toEqual([
      { kind: 'branch', name: 'main' },
      { kind: 'tag', name: 'v1' },
    ]);
  });
});
