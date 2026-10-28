import { execFileSync, spawn } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SshWorkspaceBackend } from '../../../src/shared/types/workspace';

const { run, ensureInstalled } = vi.hoisted(() => ({ run: vi.fn(), ensureInstalled: vi.fn() }));

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
  remoteCompanionService: { ensureInstalled },
}));

import { sshWorkspaceGit } from '../../../src/main/services/workspace-git/ssh-git';

/** The host's shell, here this computer's. */
function hostShell(_host: unknown, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = spawn('sh', ['-c', command]);
    let output = '';
    let errors = '';
    shell.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    shell.stderr.on('data', (data: Buffer) => (errors += data.toString('utf8')));
    shell.on('error', reject);
    shell.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
  });
}

describe('sshWorkspaceGit.createBranch', () => {
  let repoPath: string;
  let backend: SshWorkspaceBackend;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'komla-ssh-git-create-branch-'));
    git('init', '--quiet', '--initial-branch=main');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'a'
    );
    git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'b'
    );
    git('switch', '--quiet', '-c', 'feature');
    run.mockReset().mockImplementation(hostShell);
    ensureInstalled.mockReset().mockRejectedValue(new Error('No companion on this host'));
    backend = {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory: repoPath,
      remoteRepoPath: repoPath,
      remoteProjectRoot: repoPath,
      gitUrl: '',
    };
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('creates the branch at HEAD without switching to it', async () => {
    await sshWorkspaceGit.createBranch(backend, 'topic');

    expect(git('rev-parse', 'topic')).toBe(git('rev-parse', 'HEAD'));
    expect(git('branch', '--show-current')).toBe('feature');
  });

  it("starts from origin's branch when the host has no local one, without tracking it", async () => {
    await sshWorkspaceGit.createBranch(backend, 'release', 'develop');

    expect(git('rev-parse', 'release')).toBe(git('rev-parse', 'origin/develop'));
    expect(() => git('config', 'branch.release.merge')).toThrow();
  });

  it('prefers a local start point over origin', async () => {
    await sshWorkspaceGit.createBranch(backend, 'release', 'main');

    expect(git('rev-parse', 'release')).toBe(git('rev-parse', 'main'));
  });

  it("starts from origin's branch when the host's own is behind it", async () => {
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('update-ref', 'refs/heads/main', 'main~1');

    await sshWorkspaceGit.createBranch(backend, 'release', 'main');

    expect(git('rev-parse', 'release')).toBe(git('rev-parse', 'origin/main'));
  });

  it('starts from the ref the companion names for the target', async () => {
    const companion = join(repoPath, 'companion');
    writeFileSync(companion, '#!/bin/sh\necho origin/develop\n');
    chmodSync(companion, 0o755);
    ensureInstalled.mockResolvedValue(companion);

    await sshWorkspaceGit.createBranch(backend, 'release', 'main');

    expect(git('rev-parse', 'release')).toBe(git('rev-parse', 'origin/develop'));
  });

  it("creates nothing when the workspace's folder is gone from the host", async () => {
    const missing = { ...backend, remoteDirectory: join(repoPath, 'missing') };
    // A login directory that is itself a repository must not get the branch.
    run.mockImplementation((host: unknown, command: string) =>
      hostShell(host, `cd ${repoPath}\n${command}`)
    );

    await expect(sshWorkspaceGit.createBranch(missing, 'topic')).rejects.toThrow();

    expect(git('branch', '--list', 'topic')).toBe('');
  });

  it("reports git's reason when the branch cannot be created", async () => {
    await expect(sshWorkspaceGit.createBranch(backend, 'main')).rejects.toThrow(/already exists/);
    await expect(sshWorkspaceGit.createBranch(backend, '-d')).rejects.toThrow(
      /not a valid branch name/
    );
  });
});
