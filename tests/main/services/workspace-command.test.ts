import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => '/mock/.komla' }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}) },
}));
vi.mock('../../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../../src/main/services/ssh-host.service', () => ({ sshHostService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {},
  joinRemote: (...parts: string[]) => parts.join('/'),
  remoteKomlaDataPort: () => 4242,
}));

import {
  remoteWorkspaceScript,
  runLocalWorkspaceCommand,
} from '../../../src/main/services/workspace-command';

import type { SshWorkspaceBackend, Workspace } from '../../../src/shared/types';

const execFileAsync = promisify(execFile);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid: number): Promise<void> {
  await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 5000 });
}

describe.skipIf(process.platform === 'win32')('workspace commands', () => {
  let directory: string;
  const workspace = () => ({ id: 'ws-1', workingDirectory: directory }) as Workspace;

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const makeDirectory = () => {
    directory = mkdtempSync(join(tmpdir(), 'komla-workspace-command-'));
  };

  it("runs in the workspace's folder with the given environment", async () => {
    makeDirectory();
    await runLocalWorkspaceCommand(workspace(), 'echo "$KOMLA_EVENT" > out.txt; echo noise', {
      env: { KOMLA_EVENT: 'agent.done' },
      timeoutMs: 5000,
    });
    expect(readFileSync(join(directory, 'out.txt'), 'utf8')).toBe('agent.done\n');
  });

  it('keeps standard output up to its limit when asked to', async () => {
    makeDirectory();
    await expect(
      runLocalWorkspaceCommand(workspace(), 'printf "%s" abcdefghij', {
        timeoutMs: 5000,
        maxOutput: 4,
      })
    ).resolves.toBe('abcd');
  });

  it('finds the komla CLI on PATH even when a login profile sets PATH again', async () => {
    makeDirectory();
    const cli = join(directory, 'bin', 'komla');
    mkdirSync(dirname(cli));
    writeFileSync(cli, '#!/bin/sh\necho "fake komla $*"\n', { mode: 0o755 });
    await runLocalWorkspaceCommand(workspace(), 'komla status set x > out.txt', {
      env: { KOMLA_CLI: cli },
      timeoutMs: 5000,
    });
    expect(readFileSync(join(directory, 'out.txt'), 'utf8')).toBe('fake komla status set x\n');
  });

  it('fails with the last line of its error output', async () => {
    makeDirectory();
    await expect(
      runLocalWorkspaceCommand(workspace(), 'echo first >&2; echo "say: not found" >&2; exit 3', {
        timeoutMs: 5000,
      })
    ).rejects.toThrow('say: not found');
  });

  it('stops everything a command started when it runs past its timeout', async () => {
    makeDirectory();
    await expect(
      runLocalWorkspaceCommand(workspace(), 'sleep 30 & echo $! > child.pid; wait', {
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ timedOut: true });
    await waitUntilStopped(Number(readFileSync(join(directory, 'child.pid'), 'utf8')));
  });

  it('ends when its shell exits, even while something it started holds its output open', async () => {
    makeDirectory();
    const started = Date.now();
    await runLocalWorkspaceCommand(workspace(), 'sleep 30 >&2 & echo $! > child.pid', {
      timeoutMs: 10_000,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    process.kill(Number(readFileSync(join(directory, 'child.pid'), 'utf8')));
  });

  describe('on an SSH host', () => {
    const backend = () =>
      ({
        kind: 'ssh',
        hostId: 'host-1',
        remoteDirectory: directory,
        remoteProjectRoot: '/srv/komla/projects/demo',
      }) as SshWorkspaceBackend;
    // The host runs the script in a login shell; plain sh stands in for it here.
    const runScript = (command: string, timeoutSeconds: number, keepOutput = false) =>
      execFileAsync(
        'sh',
        [
          '-c',
          remoteWorkspaceScript(
            backend(),
            command,
            { KOMLA_EVENT: 'agent.done' },
            timeoutSeconds,
            keepOutput
          ),
        ],
        { timeout: 20_000 }
      );

    it('runs in the workspace folder with its environment, the helpers and the tunnel', async () => {
      makeDirectory();
      const { stdout } = await runScript(
        'printf "%s|%s|%s|%s" "$PWD" "$KOMLA_EVENT" "$KOMLA_API_URL" "${PATH%%:*}"',
        5,
        true
      );
      expect(stdout).toBe(`${directory}|agent.done|http://127.0.0.1:4242|/srv/komla/helpers`);
    });

    it('passes on how the command exited and discards output unless asked to keep it', async () => {
      makeDirectory();
      await expect(runScript('echo hidden; exit 3', 5)).rejects.toMatchObject({
        code: 3,
        stdout: '',
      });
    });

    it('stops everything the command started when its timeout passes', async () => {
      makeDirectory();
      const started = Date.now();
      await expect(runScript('sleep 30 & echo $! > child.pid; wait', 1)).rejects.toMatchObject({
        code: 143,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      await waitUntilStopped(Number(readFileSync(join(directory, 'child.pid'), 'utf8')));
    });
  });
});
