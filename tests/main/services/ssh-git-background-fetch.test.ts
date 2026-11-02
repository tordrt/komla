import { execFile } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

/**
 * A PATH holding a sleep that starts counting once `pidFile` is written, so the fetch's
 * watchdog can't stop git before git has started the fake ssh, however busy the computer is.
 */
async function pathWithSleepAfter(root: string, pidFile: string, path: string): Promise<string> {
  const bin = join(root, 'bin-with-sleep-after-ssh');
  mkdirSync(bin);
  const { stdout } = await execFileAsync('sh', ['-c', 'command -v sleep']);
  const sleep = stdout.trim();
  writeFileSync(
    join(bin, 'sleep'),
    `#!/bin/sh\nwhile [ ! -s '${pidFile}' ]; do '${sleep}' 0.05; done\nexec '${sleep}' "$@"\n`
  );
  chmodSync(join(bin, 'sleep'), 0o755);
  return `${bin}:${path}`;
}

/** The branches the clone's marker says were fetched, and when, in seconds. */
function fetchedBranches(clone: string): Array<[number, string]> {
  return readFileSync(join(`${clone}.komla`, '.origin-fetched-at'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [seconds, branch] = line.split(' ');
      return [Number(seconds), branch];
    });
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

  it("records when it fetched every origin branch, by the host's clock", async () => {
    const fetchedAt = join(`${clone}.komla`, '.origin-fetched-at');

    await sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000);

    const [[seconds, branch]] = fetchedBranches(clone);
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(60);
    expect(branch).toBe('*');
    expect(existsSync(join(`${clone}.komla`, '.setup-lock')), 'lock left behind').toBe(false);

    // A fetch of just some branches keeps the record of the fetch of every branch.
    await sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000, ['main']);
    expect(fetchedBranches(clone).map(([, name]) => name)).toEqual(['main', '*']);

    // A clone fetching just some branches might not have the one a workspace starts from.
    rmSync(fetchedAt);
    await git(clone, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    await sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000);
    expect(existsSync(fetchedAt)).toBe(false);
  });

  it('fetches and prunes just the branches asked for, and records them', async () => {
    const remoteBranches = async () =>
      (
        await execFileAsync('git', ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes'], {
          cwd: clone,
        })
      ).stdout
        .trim()
        .split('\n');
    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:feature', 'HEAD:other');
    await git(clone, 'fetch', '--quiet', 'origin');
    await git(elsewhere, 'commit', '--quiet', '--allow-empty', '-m', 'pushed elsewhere');
    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:unused');
    await git(elsewhere, 'push', '--quiet', 'origin', '--delete', 'feature', 'other');

    await expect(
      sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000, ['main', 'feature'])
    ).resolves.toBe(true);

    // origin/other is left as it was: only a fetch of every branch prunes it.
    expect(await remoteBranches()).toEqual(['HEAD', 'main', 'other']);
    expect(fetchedBranches(clone).map(([, name]) => name)).toEqual(['main', 'feature']);
  });

  it('leaves a clone a workspace is being set up in alone, and takes over a stale lock', async () => {
    const lock = join(`${clone}.komla`, '.setup-lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    await git(elsewhere, 'commit', '--quiet', '--allow-empty', '-m', 'pushed elsewhere');
    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main');

    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      false
    );
    expect(existsSync(lock), "another setup's lock removed").toBe(true);

    // Left by a setup that was killed.
    const { stdout: deadPid } = await execFileAsync('sh', ['-c', 'echo $$']);
    writeFileSync(join(lock, 'pid'), deadPid);
    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      true
    );
    expect(existsSync(lock), 'lock left behind').toBe(false);

    // Without an owner yet, as a setup that has just taken it leaves it.
    mkdirSync(lock);
    await git(elsewhere, 'commit', '--quiet', '--allow-empty', '-m', 'pushed again');
    await git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main');
    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      false
    );
    expect(existsSync(lock), "another setup's lock removed").toBe(true);
  });

  it('skips a clone without origin', async () => {
    await git(clone, 'remote', 'remove', 'origin');

    await expect(sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 20_000)).resolves.toBe(
      false
    );
  });

  // Checks the fake ssh script's process id, which a Windows shell's $$ is not.
  it.skipIf(process.platform === 'win32').for([{ ps: true }, { ps: false }])(
    'stops a fetch that takes too long, along with the ssh git started (ps: $ps)',
    async ({ ps }, { skip }) => {
      // Without ps the script reads parent ids from /proc, which only Linux hosts have.
      if (!ps) skip(!existsSync('/proc'), 'no /proc on this platform');
      const fakeSsh = join(root, 'fake-ssh');
      const pidFile = join(root, 'ssh.pid');
      writeFileSync(fakeSsh, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
      chmodSync(fakeSsh, 0o755);
      await git(clone, 'config', 'core.sshCommand', fakeSsh);
      await git(clone, 'remote', 'set-url', 'origin', 'ssh://git.example.invalid/repo.git');
      const path = await pathWithSleepAfter(
        root,
        pidFile,
        ps ? process.env.PATH! : await pathWithoutPs(root)
      );
      run.mockImplementation((host: unknown, command: string) => hostShell(host, command, path));

      await expect(
        sshWorkspaceGit.fetchOriginWithoutPrompts('host-1', clone, 1_000)
      ).rejects.toThrow();

      expect(existsSync(pidFile), 'git never started ssh').toBe(true);
      // Stopped soon after ssh started, however long git took to start it.
      expect(Date.now() - statSync(pidFile).mtimeMs).toBeLessThan(10_000);
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
