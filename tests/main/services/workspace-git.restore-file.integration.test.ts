/**
 * Rolling back a file the changed-files list shows as renamed. These run real git through
 * both workspace adapters; the SSH adapter's remote scripts run in a local shell.
 */
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../../../src/shared/types/workspace';

const execFileAsync = promisify(execFile);

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));
vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
  },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    getHost: vi.fn(() => ({ id: 'local-shell' })),
    run: vi.fn(
      async (_host: unknown, script: string) => (await execFileAsync('sh', ['-c', script])).stdout
    ),
  },
}));
vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: { read: vi.fn(() => undefined) },
}));

describe('workspace rollback of a renamed file', () => {
  let repoPath: string;

  const git = (...args: string[]) => execFileAsync('git', args, { cwd: repoPath });

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    repoPath = mkdtempSync(join(tmpdir(), 'komla-restore-file-'));
    // A global diff.renames or status.renames would change what git reports.
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(repoPath, '.no-global-gitconfig'));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    writeFileSync(join(repoPath, 'old.ts'), 'one\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const restoreFile = async (
    adapter: string,
    filePath: string,
    status: string,
    oldPath?: string
  ) => {
    if (adapter === 'local') {
      const { localWorkspaceRepositoryAdapter } =
        await import('../../../src/main/services/workspace-git/local-repository.adapter');
      return localWorkspaceRepositoryAdapter.restoreFile(
        { id: 'local', workingDirectory: repoPath } as Workspace,
        filePath,
        status,
        oldPath
      );
    }
    const { sshWorkspaceRepositoryAdapter } =
      await import('../../../src/main/services/workspace-git/ssh-repository.adapter');
    return sshWorkspaceRepositoryAdapter.restoreFile(
      {
        id: 'ssh',
        workingDirectory: repoPath,
        backend: { kind: 'ssh', hostId: 'local-shell', remoteDirectory: repoPath },
      } as Workspace,
      filePath,
      status,
      oldPath
    );
  };

  it.each(['local', 'ssh'])('%s restores a staged rename to its previous path', async (adapter) => {
    await git('mv', 'old.ts', 'new.ts');
    writeFileSync(join(repoPath, 'new.ts'), 'one\ntwo\n');

    // The changes list the UI rolls back from names where new.ts came from.
    await restoreFile(adapter, 'new.ts', 'renamed', 'old.ts');

    expect(readFileSync(join(repoPath, 'old.ts'), 'utf-8')).toBe('one\n');
    expect(existsSync(join(repoPath, 'new.ts'))).toBe(false);
    expect((await git('status', '--porcelain')).stdout).toBe('');
  });

  it.each(['local', 'ssh'])(
    '%s restores a rename git sees only in the working tree',
    async (adapter) => {
      rmSync(join(repoPath, 'old.ts'));
      writeFileSync(join(repoPath, 'new.ts'), 'one\n');
      await git('add', '-N', 'new.ts');

      await restoreFile(adapter, 'new.ts', 'renamed', 'old.ts');

      expect(readFileSync(join(repoPath, 'old.ts'), 'utf-8')).toBe('one\n');
      expect(existsSync(join(repoPath, 'new.ts'))).toBe(false);
      expect((await git('status', '--porcelain')).stdout).toBe('');
    }
  );

  it.each(['local', 'ssh'])(
    '%s rolls back a file a commit renamed to its committed content',
    async (adapter) => {
      await git('mv', 'old.ts', 'new.ts');
      await git('commit', '-q', '-m', 'rename');
      writeFileSync(join(repoPath, 'new.ts'), 'changed\n');

      // The branch comparison lists new.ts as renamed, but the working tree holds no rename.
      await restoreFile(adapter, 'new.ts', 'renamed');

      expect(readFileSync(join(repoPath, 'new.ts'), 'utf-8')).toBe('one\n');
      expect((await git('status', '--porcelain')).stdout).toBe('');
    }
  );

  it.each(['local', 'ssh'])(
    '%s rolls back a renamed path that looks like a glob without touching what it matches',
    async (adapter) => {
      mkdirSync(join(repoPath, 'app', 'i'), { recursive: true });
      writeFileSync(join(repoPath, 'app', 'i', 'page.tsx'), 'i\n');
      await git('add', '.');
      await git('commit', '-q', '-m', 'page');
      writeFileSync(join(repoPath, 'app', 'i', 'page.tsx'), 'i edited\n');
      mkdirSync(join(repoPath, 'app', '[id]'));
      await git('mv', 'old.ts', 'app/[id]/page.tsx');

      // Without its previous path, app/[id]/page.tsx isn't in HEAD; as a glob it would
      // match app/i/page.tsx.
      await restoreFile(adapter, 'app/[id]/page.tsx', 'renamed').catch(() => {});

      expect(readFileSync(join(repoPath, 'app', 'i', 'page.tsx'), 'utf-8')).toBe('i edited\n');
    }
  );

  it.each(['local', 'ssh'])(
    '%s leaves a previous path that is back on disk alone',
    async (adapter) => {
      // The list the UI read still had new.ts renamed from old.ts, but old.ts is back with
      // edits and new.ts is a new file.
      writeFileSync(join(repoPath, 'old.ts'), 'one\nedited\n');
      writeFileSync(join(repoPath, 'new.ts'), 'new\n');

      await expect(restoreFile(adapter, 'new.ts', 'renamed', 'old.ts')).rejects.toThrow();

      expect(readFileSync(join(repoPath, 'old.ts'), 'utf-8')).toBe('one\nedited\n');
      expect(readFileSync(join(repoPath, 'new.ts'), 'utf-8')).toBe('new\n');
    }
  );
});
