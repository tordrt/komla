/**
 * The file tree lists a git workspace with `git ls-files`. These run real git so the
 * listing keeps file names git would otherwise quote or the output trimming would cut.
 */
import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
];

describe('gitRepoService.listFiles', () => {
  let repoPath: string;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of INHERITED_GIT_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    repoPath = mkdtempSync(join(tmpdir(), 'komla-list-files-'));
    await execFileAsync('git', ['init', '-q'], { cwd: repoPath });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('keeps non-ASCII names and leading spaces as they are on disk', async () => {
    mkdirSync(join(repoPath, 'docs'));
    mkdirSync(join(repoPath, 'logs'));
    writeFileSync(join(repoPath, ' lead.txt'), '');
    writeFileSync(join(repoPath, 'docs', 'café.md'), '');
    writeFileSync(join(repoPath, 'logs', 'é.log'), '');
    writeFileSync(join(repoPath, '.gitignore'), 'logs/\n');
    await execFileAsync('git', ['add', 'docs'], { cwd: repoPath });
    const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');

    const result = await gitRepoService.listFiles(repoPath, true);

    expect([...result.files].sort()).toEqual([' lead.txt', '.gitignore', 'docs/café.md']);
    expect(result.gitIgnoredFiles).toEqual(['logs/é.log']);
  });
});
