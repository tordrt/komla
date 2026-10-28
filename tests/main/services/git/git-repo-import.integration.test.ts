/**
 * Files dropped or pasted into a terminal are copied into the workspace's `.komla-files/`.
 * These run real git and a real filesystem, so they show git ignoring the copies wherever
 * the workspace sits in its repository, and that no copy lands outside the workspace.
 */
import { execFile } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
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

describe('gitRepoService.importExternalFile', () => {
  let rootPath: string;
  let repoPath: string;
  let sourcePath: string;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of INHERITED_GIT_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    rootPath = mkdtempSync(join(tmpdir(), 'komla-import-'));
    repoPath = join(rootPath, 'repo');
    mkdirSync(repoPath);
    await execFileAsync('git', ['init', '-q'], { cwd: repoPath });
    sourcePath = join(rootPath, 'report.pdf');
    writeFileSync(sourcePath, 'pdf');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(rootPath, { recursive: true, force: true });
  });

  async function loadService() {
    const { gitRepoService } = await import('../../../../src/main/services/git/git-repo');
    return gitRepoService;
  }

  async function gitStatus(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall'], { cwd });
    return stdout;
  }

  it('copies the file into .komla-files and keeps it out of git status', async () => {
    const service = await loadService();

    await expect(service.importExternalFile(repoPath, sourcePath)).resolves.toBe(
      '.komla-files/report.pdf'
    );

    expect(readFileSync(join(repoPath, '.komla-files', 'report.pdf'), 'utf-8')).toBe('pdf');
    expect(await gitStatus(repoPath)).toBe('');
  });

  it('keeps imports out of git status when the workspace is a subfolder of a repo', async () => {
    const folderPath = join(repoPath, 'notes');
    mkdirSync(folderPath);
    const service = await loadService();

    await service.importExternalFile(folderPath, sourcePath);

    expect(existsSync(join(folderPath, '.komla-files', 'report.pdf'))).toBe(true);
    expect(await gitStatus(repoPath)).toBe('');
  });

  it('adds a suffix instead of overwriting an earlier import', async () => {
    const service = await loadService();

    await service.importExternalFile(repoPath, sourcePath);
    await expect(service.importExternalFile(repoPath, sourcePath)).resolves.toBe(
      '.komla-files/report-2.pdf'
    );
  });

  it('lists imports in the file tree without the folder’s own ignore file', async () => {
    const service = await loadService();
    await service.importExternalFile(repoPath, sourcePath);

    const result = await service.listFiles(repoPath, true);

    expect(result.files).toEqual(['.komla-files/report.pdf']);
    expect(result.gitIgnoredFiles).toEqual([]);
  });

  it('lists imports in a folder workspace without the folder’s own ignore file', async () => {
    const folderPath = join(rootPath, 'folder');
    mkdirSync(folderPath);
    const service = await loadService();
    await service.importExternalFile(folderPath, sourcePath);

    const result = await service.listFiles(folderPath, true);

    expect(result.files).toEqual(['.komla-files/report.pdf']);
  });

  it('moves an earlier import named .gitignore aside for the folder’s own', async () => {
    mkdirSync(join(repoPath, '.komla-files'));
    writeFileSync(join(repoPath, '.komla-files', '.gitignore'), 'dist/\n');
    const service = await loadService();

    await service.importExternalFile(repoPath, sourcePath);

    expect(readFileSync(join(repoPath, '.komla-files', '.gitignore'), 'utf-8')).toBe('*\n');
    expect(readFileSync(join(repoPath, '.komla-files', '.gitignore-2'), 'utf-8')).toBe('dist/\n');
    expect(await gitStatus(repoPath)).toBe('');
    expect((await service.listFiles(repoPath)).files.sort()).toEqual([
      '.komla-files/.gitignore-2',
      '.komla-files/report.pdf',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a .komla-files symlink instead of copying through it',
    async () => {
      const outsidePath = join(rootPath, 'outside');
      mkdirSync(outsidePath);
      symlinkSync(outsidePath, join(repoPath, '.komla-files'));
      const service = await loadService();

      await expect(service.importExternalFile(repoPath, sourcePath)).rejects.toThrow(/symlink/);
      expect(readdirSync(outsidePath)).toEqual([]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'does not write through a symlink waiting at the imported name',
    async () => {
      const outsidePath = join(rootPath, 'outside');
      mkdirSync(outsidePath);
      mkdirSync(join(repoPath, '.komla-files'));
      symlinkSync(join(outsidePath, 'report.pdf'), join(repoPath, '.komla-files', 'report.pdf'));
      const service = await loadService();

      await expect(service.importExternalFile(repoPath, sourcePath)).resolves.toBe(
        '.komla-files/report-2.pdf'
      );
      expect(readdirSync(outsidePath)).toEqual([]);
    }
  );
});
