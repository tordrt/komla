import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runWithInput } = vi.hoisted(() => ({ runWithInput: vi.fn() }));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: { isRunning: () => false },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: { getHost: (id: string) => ({ id }), runWithInput },
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: {},
}));

import { shellQuotePosix } from '../../../src/shared/lib/shell-quote';
import { sshWorkspaceGit } from '../../../src/main/services/workspace-git/ssh-git';

/** The host's shell, here this computer's, after a login profile that prints a greeting. */
function hostShell(_host: unknown, command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = spawn('sh', ['-c', `echo 'Welcome back'; ${command}`]);
    let output = '';
    shell.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    shell.on('error', reject);
    shell.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`sh exited with ${code}`))
    );
    // A command that never reads its input, such as `git init`, may exit before the write.
    shell.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    shell.stdin.end(input);
  });
}

describe('sshWorkspaceGit.gitBatchRunner', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'komla-ssh-git-batch-'));
    runWithInput.mockReset().mockImplementation(hostShell);
    // Quoted, as the batch script quotes it, so a Windows path keeps its backslashes.
    await hostShell(null, `git init --quiet ${shellQuotePosix(repoPath)}`, '');
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns each command's output, or its errors, past what the login profile prints", async () => {
    const repo = sshWorkspaceGit.gitBatchRunner('host-1', repoPath);
    const odd = `it's "quoted" $HOME\nand on two lines`;

    const results = await repo.run([
      { args: ['rev-parse', '--sq-quote', odd] },
      { args: ['rev-parse', '--verify', 'no-such-branch'] },
      { args: ['rev-parse', '--is-bare-repository'] },
    ]);

    expect(results[0]).toEqual({ ok: true, output: `'it'\\''s "quoted" $HOME\nand on two lines'` });
    expect(results[1]).toEqual({ ok: false, error: expect.stringContaining('fatal') });
    expect(results[2]).toEqual({ ok: true, output: 'false' });
  });

  it('runs a serial batch as one script, and splits others into a few that run at once', async () => {
    const repo = sshWorkspaceGit.gitBatchRunner('host-1', repoPath);
    const commands = Array.from({ length: 12 }, () => ({ args: ['rev-parse', '--git-dir'] }));

    await repo.run(commands, { serial: true });
    expect(runWithInput).toHaveBeenCalledTimes(1);

    runWithInput.mockClear();
    const results = await repo.run(commands);
    expect(runWithInput).toHaveBeenCalledTimes(6);
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.ok && result.output === '.git')).toBe(true);
  });

  it('fails when the host stops before every command ran', async () => {
    runWithInput.mockResolvedValue('Welcome back\n');
    const repo = sshWorkspaceGit.gitBatchRunner('host-1', repoPath);

    await expect(repo.run([{ args: ['status'] }])).rejects.toThrow('Welcome back');
  });
});
