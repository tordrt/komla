/**
 * Project creation asks for a git name and email when git cannot resolve one
 * (a fresh install, common on Windows). These run real git against a scratch
 * global config.
 */
import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'EMAIL',
];

describe('gitIdentityService', () => {
  let tempDir: string;
  let globalConfigPath: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'komla-git-identity-'));
    globalConfigPath = join(tempDir, 'gitconfig');
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
    const { gitIdentityService } = await import('../../../../src/main/services/git/git-identity');
    return gitIdentityService;
  }

  it('reports that git cannot commit when it has no identity', async () => {
    // useConfigOnly stops git guessing from the OS, like a host without a mail domain.
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n');
    const service = await loadService();

    await expect(service.getStatus()).resolves.toEqual({ canCommit: false });
  });

  it('returns the configured half of a partial identity for prefilling', async () => {
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n\tname = Ada\n');
    const service = await loadService();

    await expect(service.getStatus()).resolves.toEqual({ canCommit: false, userName: 'Ada' });
  });

  it('reports that git can commit when the identity comes from the environment', async () => {
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Env Ada');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'env@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Env Ada');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'env@example.com');
    const service = await loadService();

    await expect(service.getStatus()).resolves.toEqual({ canCommit: true });
  });

  it('saves the identity to the global git config so commits work', async () => {
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n');
    const service = await loadService();

    await service.setGlobal('Ada Lovelace', 'ada@example.com');

    await expect(service.getStatus()).resolves.toEqual({
      canCommit: true,
      userName: 'Ada Lovelace',
      userEmail: 'ada@example.com',
    });
    expect(readFileSync(globalConfigPath, 'utf8')).toContain('email = ada@example.com');
    const repoPath = join(tempDir, 'repo');
    await execFileAsync('git', ['init', '-q', repoPath]);
    await execFileAsync('git', ['-C', repoPath, 'commit', '-q', '--allow-empty', '-m', 'first']);
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'log',
      '-1',
      '--format=%an <%ae>',
    ]);
    expect(stdout.trim()).toBe('Ada Lovelace <ada@example.com>');
  });

  it("reports git's reason when it still can't use the saved name", async () => {
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n');
    const service = await loadService();

    // git strips quotes and semicolons from the ends of a name, leaving nothing.
    await expect(service.setGlobal(';', 'ada@example.com')).rejects.toThrow(
      'name consists only of disallowed characters'
    );
  });

  it('prefills a name that comes from an included config file', async () => {
    const includedPath = join(tempDir, 'identity.gitconfig');
    writeFileSync(includedPath, '[user]\n\tname = Ada\n');
    // A backslash starts an escape in git config, so a Windows path goes in with forward slashes.
    const includeValue = includedPath.replace(/\\/g, '/');
    writeFileSync(
      globalConfigPath,
      `[user]\n\tuseConfigOnly = true\n[include]\n\tpath = ${includeValue}\n`
    );
    const service = await loadService();

    await expect(service.getStatus()).resolves.toEqual({ canCommit: false, userName: 'Ada' });
  });

  it('ignores a repository around the temp folder', async () => {
    // e.g. Windows' temp folder under a home folder someone ran `git init` in
    writeFileSync(globalConfigPath, '[user]\n\tuseConfigOnly = true\n');
    const homePath = join(tempDir, 'home');
    await execFileAsync('git', ['init', '-q', homePath]);
    await execFileAsync('git', ['-C', homePath, 'config', 'user.name', 'Repo Ada']);
    await execFileAsync('git', ['-C', homePath, 'config', 'user.email', 'repo@example.com']);
    const tempPath = join(homePath, 'AppData', 'Local', 'Temp');
    mkdirSync(tempPath, { recursive: true });
    vi.stubEnv('TMPDIR', tempPath);
    const service = await loadService();

    await expect(service.getStatus()).resolves.toEqual({ canCommit: false });
  });
});
