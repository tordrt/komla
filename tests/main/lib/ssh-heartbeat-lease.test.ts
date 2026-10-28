import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keepSshLeaseAlive,
  sshHeartbeatLeaseCommand,
} from '../../../src/main/lib/ssh-heartbeat-lease';

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/** Resolves once every holder of the session's stdout has exited, as sshd waits for. */
function stdoutClosedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

it('keeps the lease script free of quotes and backslashes', () => {
  const script = sshHeartbeatLeaseCommand().replace(/^exec sh -c '(.*)'$/, '$1');

  expect(script).not.toBe(sshHeartbeatLeaseCommand());
  expect(script).not.toMatch(/['\\]/);
});

// The lease identifies its sshd parent by process name, which a copied shell
// takes from its file name on Linux. `/bin/sh` is dash on Debian but bash on
// RHEL and macOS, and bash reaps and signals background jobs differently.
const SHELLS = ['/bin/sh', '/bin/bash'].filter((path) => existsSync(path));

describe.runIf(process.platform === 'linux').concurrent.each(SHELLS)(
  'sshHeartbeatLeaseCommand as %s',
  (shellPath) => {
    /** Runs the lease the way sshd does: sshd → login shell → remote command. */
    async function startLease(
      onTestFinished: (fn: () => Promise<void>) => void,
      parentName: string,
      timeoutSeconds: number
    ): Promise<ChildProcess> {
      const dir = await mkdtemp(join(tmpdir(), 'komla-ssh-lease-'));
      mkdirSync(join(dir, 'bin'));
      symlinkSync(shellPath, join(dir, 'bin', 'sh'));
      const parent = join(dir, parentName);
      copyFileSync('/bin/sh', parent);
      const child = spawn(
        parent,
        ['-c', 'sh -c "$1"; exit $?', parentName, sshHeartbeatLeaseCommand(timeoutSeconds)],
        {
          env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      onTestFinished(async () => {
        // EOF ends a lease whose parent is already gone.
        child.stdin?.destroy();
        child.kill('SIGKILL');
        await rm(dir, { recursive: true, force: true });
      });
      return child;
    }

    it('ends its sshd session when heartbeats stop', async ({ expect, onTestFinished }) => {
      const sshd = await startLease(onTestFinished, 'sshd-session', 1);

      await expect(exitOf(sshd)).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    });

    it('keeps its sshd session while heartbeats arrive', async ({ expect, onTestFinished }) => {
      const sshd = await startLease(onTestFinished, 'sshd-session', 2);

      for (let i = 0; i < 12; i++) {
        await delay(250);
        sshd.stdin?.write('\n');
      }
      expect(sshd.exitCode).toBeNull();
      expect(sshd.signalCode).toBeNull();

      sshd.stdin?.end();
      await expect(exitOf(sshd)).resolves.toEqual({ code: 0, signal: null });
    });

    it('exits without signaling when Komla closes the lease', async ({
      expect,
      onTestFinished,
    }) => {
      const sshd = await startLease(onTestFinished, 'sshd-session', 2);
      let stderr = '';
      sshd.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

      sshd.stdin?.end();

      await expect(exitOf(sshd)).resolves.toEqual({ code: 0, signal: null });
      expect(stderr).toBe('');
    });

    it('releases the session output right after a heartbeat burst and close', async ({
      expect,
      onTestFinished,
    }) => {
      const sshd = await startLease(onTestFinished, 'sshd-session', 30);
      await delay(100);

      // Heartbeats queued during a network stall arrive together.
      sshd.stdin?.end('\n'.repeat(200));

      await expect(stdoutClosedWithin(sshd, 2_000)).resolves.toBe(true);
    });

    it('never signals a parent that is not sshd', async ({ expect, onTestFinished }) => {
      const shell = await startLease(onTestFinished, 'bash', 1);

      await delay(1_500);
      expect(shell.exitCode).toBeNull();
      expect(shell.signalCode).toBeNull();

      shell.stdin?.write('\n');
      shell.stdin?.end();
      await expect(exitOf(shell)).resolves.toEqual({ code: 0, signal: null });
    });
  }
);

describe('keepSshLeaseAlive', () => {
  function createChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> };
    };
    child.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn() });
    return child;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a heartbeat to the lease every interval until ssh exits', () => {
    const child = createChild();
    keepSshLeaseAlive(child as unknown as ChildProcess, 30_000);

    vi.advanceTimersByTime(29_999);
    expect(child.stdin.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.stdin.write).toHaveBeenCalledExactlyOnceWith('\n');
    vi.advanceTimersByTime(30_000);
    expect(child.stdin.write).toHaveBeenCalledTimes(2);

    child.emit('exit', 255, null);
    vi.advanceTimersByTime(90_000);
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
  });

  it('absorbs write errors after ssh is gone', () => {
    const child = createChild();
    keepSshLeaseAlive(child as unknown as ChildProcess, 30_000);

    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
  });
});
