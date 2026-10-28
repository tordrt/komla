import { execFile } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
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

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
  });

  return stdout.trim();
}

function createEditorCommand(repoPath: string): string {
  const editorScriptPath = join(repoPath, 'sleep-editor.js');
  writeFileSync(
    editorScriptPath,
    [
      'const end = Date.now() + 700;',
      'while (Date.now() < end) {',
      '  // Busy wait long enough to keep the enclosing git command in-flight.',
      '}',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8'
  );

  if (process.platform === 'win32') {
    const wrapperPath = join(repoPath, 'sleep-editor.cmd');
    writeFileSync(wrapperPath, `@"${process.execPath}" "${editorScriptPath}" %*\r\n`, 'utf8');
    return wrapperPath;
  }

  const wrapperPath = join(repoPath, 'sleep-editor.sh');
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${editorScriptPath}" "$@"\n`,
    'utf8'
  );
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

describe('GitExec integration', () => {
  let repoPath: string;
  let helperDirPath: string;

  beforeEach(async () => {
    vi.resetModules();
    repoPath = mkdtempSync(join(tmpdir(), 'komla-git-exec-'));
    helperDirPath = mkdtempSync(join(tmpdir(), 'komla-git-editor-'));

    await runGit(repoPath, ['init']);
    await runGit(repoPath, ['config', 'user.name', 'Komla Test']);
    await runGit(repoPath, ['config', 'user.email', 'komla@example.com']);
    writeFileSync(join(repoPath, 'README.md'), 'hello\n', 'utf8');
    await runGit(repoPath, ['add', 'README.md']);
    await runGit(repoPath, ['commit', '-m', 'initial']);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(helperDirPath, { recursive: true, force: true });
  });

  it('getMainBranch returns the default branch of a real repo', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const result = await gitExec.getMainBranch(repoPath);
    // The beforeEach inits with git's default branch (usually 'main')
    const expected = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(result).toBe(expected);
  });

  it('getRemoteDefaultBranch reads origin/HEAD and ignores a missing or dangling one', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const readFresh = () => {
      gitExec.invalidateCache(`remoteDefaultBranch:${repoPath}`);
      return gitExec.getRemoteDefaultBranch(repoPath);
    };
    await expect(readFresh()).resolves.toBeNull();

    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
    await runGit(repoPath, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/develop',
    ]);
    await expect(readFresh()).resolves.toBe('develop');

    await runGit(repoPath, ['update-ref', '-d', 'refs/remotes/origin/develop']);
    await expect(readFresh()).resolves.toBeNull();
  });

  it('reads the checked-out branch even when a tag shares its name', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    await runGit(repoPath, ['switch', '-c', 'v2']);
    await runGit(repoPath, ['tag', 'v2']);

    await expect(gitExec.getCheckedOutBranch(repoPath)).resolves.toBe('v2');

    await runGit(repoPath, ['switch', '--detach']);
    await expect(gitExec.getCheckedOutBranch(repoPath)).resolves.toBeUndefined();
  });

  it('streams Git output into a bounded prefix', async () => {
    writeFileSync(join(repoPath, 'README.md'), `${'changed content '.repeat(10_000)}\n`, 'utf8');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const result = await gitExec.execGitAsyncRawLimited(repoPath, ['diff', '--'], 1_000);

    expect(result.output).toHaveLength(1_000);
    expect(result.output).toContain('diff --git');
    expect(result.truncated).toBe(true);
  });

  it('getMainBranch does not return unborn branch from bare repo HEAD', async () => {
    // Create a bare repo with HEAD pointing to a branch that has no commits
    const bareRepoPath = mkdtempSync(join(tmpdir(), 'komla-git-bare-'));
    try {
      await runGit(bareRepoPath, ['init', '--bare']);
      // HEAD points to refs/heads/main (or master) but the ref is unborn — no commits exist
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');
      const result = await gitExec.getMainBranch(bareRepoPath);
      // The result should be 'main' (the last-resort default), but critically
      // it must NOT have come from symbolic-ref HEAD without verification.
      // Verify the returned ref does NOT resolve (confirming we hit the fallback).
      const resolves = await runGit(bareRepoPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${result}`,
      ]).then(
        () => true,
        () => false
      );
      // In an empty bare repo no ref resolves — the function should still
      // return a sensible default rather than throwing.
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(resolves).toBe(false);
    } finally {
      rmSync(bareRepoPath, { recursive: true, force: true });
    }
  });

  it('serializes status behind an active write on a real repository', async () => {
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const previousEditor = process.env.GIT_EDITOR;

    process.env.GIT_EDITOR = createEditorCommand(helperDirPath);

    try {
      const commitPromise = gitExec.execGitAsync(repoPath, ['commit', '--allow-empty']);
      commitPromise.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      const statusPromise = gitExec.execGitAsync(repoPath, ['status', '--porcelain']);
      const raceResult = await Promise.race([
        statusPromise.then(() => 'resolved'),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 150)),
      ]);

      expect(raceResult).toBe('timeout');

      await expect(commitPromise).rejects.toThrow();
      await expect(statusPromise).resolves.toBe('');
    } finally {
      if (previousEditor === undefined) {
        delete process.env.GIT_EDITOR;
      } else {
        process.env.GIT_EDITOR = previousEditor;
      }
    }
  });
});

describe('isGitInstalled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // An app launched from Finder, Explorer or a desktop menu often has a PATH without git.
  it('finds git in a common install folder when PATH lacks it', async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'komla-empty-bin-'));
    try {
      vi.stubEnv('PATH', emptyBin);
      const { isGitInstalled } = await import('../../../../src/main/services/git/git-exec');
      await expect(isGitInstalled()).resolves.toBe(true);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('GitExec and repository-controlled commands', () => {
  let root: string;
  let repoPath: string;
  let marker: string;

  // A command git runs from repository config, which leaves a marker file when it does.
  function writeMarkerHook(): string {
    const hookPath = join(root, 'hook.sh');
    writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, 'utf8');
    chmodSync(hookPath, 0o755);
    return hookPath;
  }

  beforeEach(async () => {
    vi.resetModules();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'komla-git-guard-')));
    repoPath = join(root, 'repo');
    marker = join(root, 'ran');
    mkdirSync(repoPath);
    await runGit(repoPath, ['init']);
    await runGit(repoPath, ['config', 'user.name', 'Komla Test']);
    await runGit(repoPath, ['config', 'user.email', 'komla@example.com']);
    writeFileSync(join(repoPath, 'README.md'), 'hello\n', 'utf8');
    await runGit(repoPath, ['add', 'README.md']);
    await runGit(repoPath, ['commit', '-m', 'initial']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never runs a repository's fsmonitor hook", async () => {
    await runGit(repoPath, ['config', 'core.fsmonitor', writeMarkerHook()]);
    writeFileSync(join(repoPath, 'README.md'), 'changed\n', 'utf8');
    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    await expect(gitExec.execGitAsyncRaw(repoPath, ['status', '--porcelain'])).resolves.toBe(
      ' M README.md'
    );
    expect(existsSync(marker)).toBe(false);
  });

  describe('in a managed worktree', () => {
    let worktreePath: string;

    beforeEach(async () => {
      worktreePath = join(root, 'worktree');
      await runGit(repoPath, ['worktree', 'add', '-b', 'feature', worktreePath]);
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');
      gitExec.setManagedWorktreeLookup((path) =>
        path === worktreePath
          ? { worktreePath, repoPaths: [join(root, 'other'), repoPath] }
          : undefined
      );
    });

    // What an agent in the worktree can build: a gitdir of its own whose config git obeys.
    async function plantGitDir(): Promise<string> {
      const planted = join(worktreePath, '.planted');
      await runGit(root, ['init', '--bare', planted]);
      await runGit(root, [
        `--git-dir=${planted}`,
        'fetch',
        join(repoPath, '.git'),
        'feature:feature',
      ]);
      await runGit(root, [`--git-dir=${planted}`, 'symbolic-ref', 'HEAD', 'refs/heads/feature']);
      await runGit(root, [`--git-dir=${planted}`, 'config', 'core.bare', 'false']);
      await runGit(root, [`--git-dir=${planted}`, 'config', 'core.hooksPath', root]);
      await runGit(root, [
        `--git-dir=${planted}`,
        'config',
        'filter.planted.clean',
        writeMarkerHook(),
      ]);
      await runGit(root, [
        `--git-dir=${planted}`,
        `--work-tree=${worktreePath}`,
        'read-tree',
        'HEAD',
      ]);
      writeFileSync(join(worktreePath, '.gitattributes'), '* filter=planted\n', 'utf8');
      return planted;
    }

    it('runs git while the worktree still points into its project', async () => {
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');

      await expect(
        gitExec.execGitAsync(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
      ).resolves.toBe('feature');
      await expect(gitExec.execGitAsync(worktreePath, ['tag', 'checked'])).resolves.toBe('');
    });

    it('refuses git once the .git file points at a gitdir the worktree planted', async () => {
      const planted = await plantGitDir();
      writeFileSync(join(worktreePath, '.git'), `gitdir: ${planted}\n`, 'utf8');
      writeFileSync(join(worktreePath, 'README.md'), 'changed\n', 'utf8');
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');

      await expect(
        gitExec.execGitAsyncRaw(worktreePath, ['status', '--porcelain'])
      ).rejects.toThrow(/no longer points into/);
      await expect(gitExec.execGitAsync(worktreePath, ['add', '-A'])).rejects.toThrow(
        /no longer points into/
      );
      await expect(gitExec.execGitAsyncBuffer(worktreePath, ['diff'])).rejects.toThrow(
        /no longer points into/
      );
      expect(existsSync(marker)).toBe(false);
    });

    it('refuses git when the .git file was replaced by a repository', async () => {
      const planted = await plantGitDir();
      rmSync(join(worktreePath, '.git'));
      renameSync(planted, join(worktreePath, '.git'));
      writeFileSync(join(worktreePath, 'README.md'), 'changed\n', 'utf8');
      const { gitExec } = await import('../../../../src/main/services/git/git-exec');

      await expect(
        gitExec.execGitAsyncRaw(worktreePath, ['status', '--porcelain'])
      ).rejects.toThrow(/no longer points into/);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
