import { execFile } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: { isRunning: () => false },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: { getHost: (id: string) => ({ id }), run },
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: {},
}));

import { sshWorkspaceGit } from '../../../src/main/services/workspace-git/ssh-git';

const execFileAsync = promisify(execFile);

/** The host's shell, here this computer's, after a login profile that prints a greeting. */
async function hostShell(
  _host: unknown,
  command: string,
  path = process.env.PATH
): Promise<string> {
  const { stdout } = await execFileAsync('sh', ['-c', `echo 'Welcome back'; ${command}`], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', PATH: path },
  });
  return stdout;
}

/** A PATH with just the commands the script needs, like a minimal image without ps. */
async function pathWithoutPs(root: string): Promise<string> {
  const bin = join(root, 'bin-without-ps');
  mkdirSync(bin);
  for (const name of ['awk', 'cat', 'git', 'sh', 'sleep']) {
    const { stdout } = await execFileAsync('sh', ['-c', `command -v ${name}`]);
    symlinkSync(stdout.trim(), join(bin, name));
  }
  return bin;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
  });
}

describe('sshWorkspaceGit.fetchOriginWithoutPrompts', () => {
  let root: string;
  let origin: string;
  let clone: string;
  let elsewhere: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'komla-ssh-background-fetch-'));
    origin = join(root, 'origin.git');
    clone = join(root, 'clone');
    elsewhere = join(root, 'elsewhere');
    await git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
    await git(root, 'clone', '--quiet', origin, elsewhere);
    await git(elsewhere, 'commit', '--quiet', '--allow-empty', '-m', 'first');
    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main');
    await git(root, 'clone', '--quiet', origin, clone);
    run
      .mockReset()
      .mockImplementation((host: unknown, command: string) => hostShell(host, command));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches without prompts, and tells whether origin moved', async () => {
    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      false
    );
    expect(run).toHaveBeenCalledWith({ id: 'host-1' }, expect.any(String), {
      timeout: 30_000,
      purpose: { kind: 'background' },
      prompt: false,
    });

    await git(elsewhere, 'commit', '--quiet', '--allow-empty', '-m', 'pushed elsewhere');
    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main');
    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      true
    );

    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:feature');
    await git(clone, 'fetch', '--quiet', 'origin');
    await git(elsewhere, 'push', '--quiet', 'origin', '--delete', 'feature');
    // A pruned branch is a move too.
    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      true
    );
  });

  it('skips a clone without origin', async () => {
    await git(clone, 'remote', 'remove', 'origin');

    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      false
    );
  });

  it.for([{ ps: true }, { ps: false }])(
    'stops a fetch that takes too long, along with the ssh git started (ps: $ps)',
    async ({ ps }, { skip }) => {
      if (!ps) {
        // Without ps the script reads parent ids from /proc, which only Linux hosts have.
        skip(!existsSync('/proc'), 'no /proc on this platform');
        const path = await pathWithoutPs(root);
        run.mockImplementation((host: unknown, command: string) => hostShell(host, command, path));
      }
      const fakeSsh = join(root, 'fake-ssh');
      const pidFile = join(root, 'ssh.pid');
      writeFileSync(fakeSsh, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
      chmodSync(fakeSsh, 0o755);
      await git(clone, 'config', 'core.sshCommand', fakeSsh);
      await git(clone, 'remote', 'set-url', 'origin', 'ssh://git.example.invalid/repo.git');

      const startedAt = Date.now();
      await expect(
        sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 1_000)
      ).rejects.toThrow();

      expect(Date.now() - startedAt).toBeLessThan(10_000);
      const sshPid = Number(readFileSync(pidFile, 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(sshPid, 0)).toThrow(), { timeout: 5_000 });
    }
  );

  it('fails when the fetch fails', async () => {
    await git(clone, 'remote', 'set-url', 'origin', join(root, 'missing.git'));

    await expect(
      sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)
    ).rejects.toThrow();
  });
});
