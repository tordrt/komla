/**
 * Project creation runs real git. It must find git where the rest of Komla does
 * (common install folders, not only PATH) and report git's own error message.
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

describe('gitRepoService project creation', () => {
  let tempDir: string;
  let globalConfigPath: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'komla-repo-create-'));
    globalConfigPath = join(tempDir, 'gitconfig');
    writeFileSync(globalConfigPath, '[user]\n\tname = Ada\n\temail = ada@example.com\n');
    for (const key of INHERITED_GIT_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfigPath);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadService() {
    const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');
    return gitRepoService;
  }

  // An app launched from Finder, Explorer or a desktop menu often has a PATH without git.
  function hideGitFromPath(): void {
    vi.stubEnv('PATH', join(tempDir, 'empty-bin'));
  }

  it('creates a new repository when git is installed but not on PATH', async () => {
    const service = await loadService();
    const repoPath = join(tempDir, 'repos', 'helloo', '.git');

    hideGitFromPath();
    await service.initBareRepo(repoPath);

    expect(await git(['-C', repoPath, 'log', '--format=%an <%ae> %s', 'main'])).toBe(
      'Ada <ada@example.com> Initial commit'
    );
    expect(await git(['-C', repoPath, 'symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  });

  it("reports git's own message when creating a repository fails", async () => {
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n');
    const service = await loadService();

    const error = await service
      .initBareRepo(join(tempDir, 'repos', 'helloo', '.git'))
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/^Author identity unknown/);
    expect(error!.message).not.toContain('Command failed');
  });

  it('copies an existing repository when git is installed but not on PATH', async () => {
    const sourcePath = join(tempDir, 'source');
    await git(['init', '-q', '-b', 'main', sourcePath]);
    await git(['-C', sourcePath, 'commit', '-q', '--allow-empty', '-m', 'first']);
    const service = await loadService();
    const clonePath = join(tempDir, 'repos', 'source', '.git');

    hideGitFromPath();
    await service.cloneBare(sourcePath, clonePath);

    expect(await git(['-C', clonePath, 'log', '--format=%s', 'main'])).toBe('first');
  });

  it('clones a URL that starts with a dash as a URL, not an option', async () => {
    // Clones run in the destination's parent, so this relative URL names the repository there.
    const sourcePath = join(tempDir, 'repos', '-app');
    await git(['init', '-q', '-b', 'main', sourcePath]);
    await git(['-C', sourcePath, 'commit', '-q', '--allow-empty', '-m', 'first']);
    const service = await loadService();

    await service.cloneFromRemote('-app', join(tempDir, 'repos', 'app'));
    await service.cloneBareFromRemote('-app', join(tempDir, 'repos', 'app.git'));

    expect(await git(['-C', join(tempDir, 'repos', 'app'), 'log', '--format=%s'])).toBe('first');
    expect(await git(['-C', join(tempDir, 'repos', 'app.git'), 'log', '--format=%s'])).toBe(
      'first'
    );
  });
});
