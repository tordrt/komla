/**
 * A project's bare clone records the remote's default branch as `origin/HEAD`, the way a
 * normal clone does, so tools that compare against `origin/HEAD` work in its workspaces.
 * `git clone --bare` never writes it. These run real git against scratch repositories.
 */
import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

const execFileAsync = promisify(execFile);

const { komlaBase, warn } = vi.hoisted(() => ({ komlaBase: { path: '' }, warn: vi.fn() }));

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })),
}));
vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
  },
}));
vi.mock('../../../src/main/services/paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getKomlaBasePath: () => komlaBase.path,
}));

describe('a managed bare clone records origin/HEAD', () => {
  let tempDir: string;
  let upstream: string;

  beforeEach(async () => {
    vi.resetModules();
    warn.mockClear();
    tempDir = mkdtempSync(join(tmpdir(), 'komla-origin-head-'));
    komlaBase.path = join(tempDir, 'komla');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(tempDir, 'gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Ada');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ada@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Ada');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ada@example.com');

    // The remote's default branch is `trunk`; `main` is just another branch, so a
    // guess of `main` can't pass.
    upstream = join(tempDir, 'upstream');
    await git(tempDir, 'init', '-q', '-b', 'trunk', upstream);
    await git(upstream, 'commit', '-q', '--allow-empty', '-m', 'first');
    await git(upstream, 'branch', 'main');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  }

  async function originHead(repo: string): Promise<string | null> {
    try {
      return await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD');
    } catch {
      return null;
    }
  }

  async function loadService() {
    const { managedRepoService } = await import('../../../src/main/services/managed-repo.service');
    return managedRepoService;
  }

  it('points origin/HEAD at the default branch of a remote it was cloned from', async () => {
    const service = await loadService();

    const repo = await service.createManagedRepoFromRemote(upstream, 'from-remote');

    expect(await originHead(repo)).toBe('refs/remotes/origin/trunk');
    expect(await git(repo, 'rev-parse', 'origin/HEAD')).toBe(
      await git(upstream, 'rev-parse', 'trunk')
    );
    // So new workspaces start from the remote's default, not the other branch named main.
    const { gitService } = await import('../../../src/main/services/git.service');
    expect(await gitService.getMainBranch(repo)).toBe('trunk');
  });

  it('leaves origin/HEAD unset for an empty remote, and still creates the project', async () => {
    const empty = join(tempDir, 'empty.git');
    await git(tempDir, 'init', '-q', '--bare', '-b', 'trunk', empty);
    const service = await loadService();

    const repo = await service.createManagedRepoFromRemote(empty, 'empty-remote');

    expect(await originHead(repo)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('copies origin/HEAD from a local repository, whatever branch it has checked out', async () => {
    const source = join(tempDir, 'source');
    await git(tempDir, 'clone', '-q', upstream, source);
    await git(source, 'switch', '-q', '-c', 'feature');
    const service = await loadService();

    const repo = await service.createManagedRepo(source, 'from-local');

    expect(await originHead(repo)).toBe('refs/remotes/origin/trunk');
  });

  // As the source does: a new workspace starts from origin's copy of the default branch.
  it('copies origin/HEAD even when the local repository has no branch of that name', async () => {
    const source = join(tempDir, 'source');
    await git(tempDir, 'clone', '-q', upstream, source);
    await git(source, 'remote', 'set-head', 'origin', 'main');
    const service = await loadService();

    const repo = await service.createManagedRepo(source, 'no-local-default');

    expect(await originHead(repo)).toBe('refs/remotes/origin/main');
  });

  it('leaves origin/HEAD unset when the local repository records a branch origin lacks', async () => {
    const source = join(tempDir, 'source');
    await git(tempDir, 'clone', '-q', upstream, source);
    await git(source, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    const service = await loadService();

    const repo = await service.createManagedRepo(source, 'dangling-origin-head');

    expect(await originHead(repo)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves origin/HEAD unset when the local repository does not record one', async () => {
    const source = join(tempDir, 'source');
    await git(tempDir, 'clone', '-q', upstream, source);
    await git(source, 'remote', 'set-head', 'origin', '--delete');
    const service = await loadService();

    const repo = await service.createManagedRepo(source, 'no-origin-head');

    expect(await git(repo, 'rev-parse', 'origin/trunk')).toBeTruthy();
    expect(await originHead(repo)).toBeNull();
  });

  it('leaves origin/HEAD unset when the local repository has no remote', async () => {
    const service = await loadService();

    const repo = await service.createManagedRepo(upstream, 'no-remote');

    expect(await originHead(repo)).toBeNull();
  });

  it('counts commits a fetch brings in once, not again for origin/HEAD', async () => {
    const service = await loadService();
    const repo = await service.createManagedRepoFromRemote(upstream, 'fetch-count');
    for (const message of ['second', 'third']) {
      await git(upstream, 'commit', '-q', '--allow-empty', '-m', message);
    }
    const { gitService } = await import('../../../src/main/services/git.service');

    const result = await gitService.fetchFromRemote(repo);

    expect(result).toEqual({ success: true, message: '2 new commits (1 ref updated)' });
  });
});
