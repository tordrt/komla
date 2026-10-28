/**
 * Publishing a project points origin at a new repository. An origin whose first push failed has
 * no branches, and must be replaceable or removable so the project can be published again.
 */
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const execFileAsync = promisify(execFile);
const ORIGINAL_PATH = process.env.PATH;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

vi.mock('electron', () => mockElectron());
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
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'EMAIL',
];

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    env: { ...process.env, PATH: ORIGINAL_PATH },
  });
  return stdout.trim();
}

describe('gitRepoService origin remote', () => {
  let tempDir: string;
  let repoPath: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'komla-repo-origin-'));
    const globalConfigPath = join(tempDir, 'gitconfig');
    writeFileSync(globalConfigPath, '[user]\n\tname = Ada\n\temail = ada@example.com\n');
    for (const key of INHERITED_GIT_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfigPath);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    // A new project's repository, as Komla creates it.
    repoPath = join(tempDir, 'project', '.git');
    await git(['init', '-q', '--bare', '-b', 'main', repoPath]);
    await git(['-C', repoPath, 'commit-tree', '-m', 'Initial commit', EMPTY_TREE]).then((commit) =>
      git(['-C', repoPath, 'update-ref', 'refs/heads/main', commit])
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadService() {
    const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');
    return gitRepoService;
  }

  async function originUrl(): Promise<string | null> {
    return git(['-C', repoPath, 'remote', 'get-url', 'origin']).catch(() => null);
  }

  /** A remote repository with a main branch that the project has fetched. */
  async function publishedOrigin(): Promise<string> {
    const remotePath = join(tempDir, 'remote.git');
    await git(['clone', '-q', '--bare', repoPath, remotePath]);
    await git(['-C', repoPath, 'remote', 'add', 'origin', remotePath]);
    await git(['-C', repoPath, 'fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    return remotePath;
  }

  it('adds origin to a project without one', async () => {
    const service = await loadService();

    await service.setOriginRemote(repoPath, 'https://example.com/me/new.git');

    expect(await originUrl()).toBe('https://example.com/me/new.git');
  });

  it('replaces an origin no repository answers at', async () => {
    await git(['-C', repoPath, 'remote', 'add', 'origin', join(tempDir, 'missing.git')]);
    const service = await loadService();

    await service.setOriginRemote(repoPath, 'https://example.com/me/new.git');

    expect(await originUrl()).toBe('https://example.com/me/new.git');
  });

  it('leaves an origin with branches alone', async () => {
    const remotePath = await publishedOrigin();
    const service = await loadService();

    await expect(
      service.setOriginRemote(repoPath, 'https://example.com/me/new.git')
    ).rejects.toThrow('origin already has branches');
    expect(await originUrl()).toBe(remotePath);
  });

  it('removes an origin that has no branches', async () => {
    await git(['-C', repoPath, 'remote', 'add', 'origin', join(tempDir, 'missing.git')]);
    const service = await loadService();

    await expect(service.removeOriginWithoutBranches(repoPath)).resolves.toBe(true);
    expect(await originUrl()).toBeNull();
  });

  it('keeps an origin that has branches', async () => {
    const remotePath = await publishedOrigin();
    const service = await loadService();

    await expect(service.removeOriginWithoutBranches(repoPath)).resolves.toBe(false);
    expect(await originUrl()).toBe(remotePath);
  });
});
