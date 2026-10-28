/**
 * Tests for GitExec per-path read-write lock.
 * Each path (worktree or bare repo) gets its own lock — different worktrees
 * run concurrently even if they share a bare repo.
 * Only conservative read-only git commands (diff, log, show, etc.) run concurrently
 * within the same path. Write commands (checkout, commit, merge, etc.) are exclusive.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { promisify } from 'util';

// Create the mock execFile with proper promisify support so that
// `promisify(execFile)` returns `{ stdout, stderr }` like Node's real execFile.
const mockExecFile = vi.fn();
(mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
  file: string,
  args?: string[],
  options?: Record<string, unknown>
): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    mockExecFile(
      file,
      args,
      options,
      (
        err: (Error & { stdout?: string; stderr?: string }) | null,
        stdout: string,
        stderr: string
      ) => {
        if (err) {
          err.stdout = stdout || '';
          err.stderr = stderr || '';
          reject(err);
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '' });
        }
      }
    );
  });
};

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  spawn: vi.fn(),
}));
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

/**
 * Configure the execFile mock.
 * - `onCommand`: called for commands with resolve/reject controls
 */
function setupMock(options: {
  onCommand?: (
    args: string[],
    resolve: (stdout: string) => void,
    reject: (err: Error) => void
  ) => void;
  onCommandWithOpts?: (
    args: string[],
    opts: Record<string, unknown>,
    resolve: (stdout: string) => void,
    reject: (err: Error) => void
  ) => void;
}) {
  const { onCommand, onCommandWithOpts } = options;

  mockExecFile.mockImplementation(
    (
      _file: string,
      args: string[],
      opts: Record<string, unknown> | null,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (onCommandWithOpts) {
        onCommandWithOpts(
          args,
          opts ?? {},
          (stdout) => cb(null, stdout + '\n', ''),
          (err) => cb(err, '', err.message)
        );
      } else if (onCommand) {
        onCommand(
          args,
          (stdout) => cb(null, stdout + '\n', ''),
          (err) => cb(err, '', err.message)
        );
      } else {
        setImmediate(() => cb(null, '\n', ''));
      }
      return {};
    }
  );
}

describe('GitExec operation queue', () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
  });

  it('serializes concurrent operations on the same repo path', async () => {
    const executionOrder: string[] = [];
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        executionOrder.push(`start:${id}`);
        resolvers.set(id, () => {
          executionOrder.push(`end:${id}`);
          resolve(id);
        });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo', ['op-a']);
    const p2 = gitExec.execGitAsync('/repo', ['op-b']);

    // Wait for first op to start
    await vi.waitFor(() => expect(resolvers.has('op-a')).toBe(true));

    // op-a started, op-b should NOT have started yet (serialized behind op-a)
    expect(executionOrder).toContain('start:op-a');
    expect(executionOrder).not.toContain('start:op-b');

    // Complete op-a → op-b should start
    resolvers.get('op-a')!();
    await vi.waitFor(() => expect(resolvers.has('op-b')).toBe(true));
    resolvers.get('op-b')!();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('op-a');
    expect(r2).toBe('op-b');
    expect(executionOrder).toEqual(['start:op-a', 'end:op-a', 'start:op-b', 'end:op-b']);
  });

  it('holds one write lock across a Git command sequence', async () => {
    const executionOrder: string[] = [];
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        executionOrder.push(`start:${id}`);
        resolvers.set(id, () => {
          executionOrder.push(`end:${id}`);
          resolve(id);
        });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');
    const sequence = gitExec.execGitWriteSequence('/repo', [
      ['add', '--all'],
      ['commit', '-m', 'Commit changes'],
    ]);
    await vi.waitFor(() => expect(resolvers.has('add')).toBe(true));
    const restore = gitExec.execGitAsync('/repo', ['restore', 'file.txt']);

    resolvers.get('add')!();
    await vi.waitFor(() => expect(resolvers.has('commit')).toBe(true));
    expect(executionOrder).not.toContain('start:restore');

    resolvers.get('commit')!();
    await vi.waitFor(() => expect(resolvers.has('restore')).toBe(true));
    resolvers.get('restore')!();

    await expect(sequence).resolves.toEqual(['add', 'commit']);
    await restore;
    expect(executionOrder).toEqual([
      'start:add',
      'end:add',
      'start:commit',
      'end:commit',
      'start:restore',
      'end:restore',
    ]);
  });

  it('runs operations on different paths concurrently', async () => {
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        resolvers.set(id, () => resolve(id));
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo-a', ['op-a']);
    const p2 = gitExec.execGitAsync('/repo-b', ['op-b']);

    // Both should start since they target different paths
    await vi.waitFor(() => {
      expect(resolvers.has('op-a')).toBe(true);
      expect(resolvers.has('op-b')).toBe(true);
    });

    resolvers.get('op-a')!();
    resolvers.get('op-b')!();
    await Promise.all([p1, p2]);
  });

  it('continues the queue after a failed operation', async () => {
    const resolvers = new Map<
      string,
      { resolve: (v: string) => void; reject: (e: Error) => void }
    >();

    setupMock({
      onCommand: (args, resolve, reject) => {
        resolvers.set(args[0], { resolve, reject });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo', ['op-fail']);
    p1.catch(() => {}); // prevent unhandled rejection before assertion attaches
    const p2 = gitExec.execGitAsync('/repo', ['op-ok']);

    await vi.waitFor(() => expect(resolvers.has('op-fail')).toBe(true));
    resolvers.get('op-fail')!.reject(new Error('simulated failure'));

    // Second operation should still run despite the first failing
    await vi.waitFor(() => expect(resolvers.has('op-ok')).toBe(true));
    resolvers.get('op-ok')!.resolve('success');

    await expect(p1).rejects.toThrow('simulated failure');
    expect(await p2).toBe('success');
  });

  it('runs conservative read-only commands concurrently on the same path', async () => {
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        resolvers.set(id, () => resolve(id));
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo', ['diff']);
    const p2 = gitExec.execGitAsync('/repo', ['log', '--oneline']);

    // Both should start concurrently since they're in the safe-read allowlist
    await vi.waitFor(() => {
      expect(resolvers.has('diff')).toBe(true);
      expect(resolvers.has('log')).toBe(true);
    });

    resolvers.get('diff')!();
    resolvers.get('log')!();
    await Promise.all([p1, p2]);
  });

  it('write waits for active safe readers to complete', async () => {
    const executionOrder: string[] = [];
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        executionOrder.push(`start:${id}`);
        resolvers.set(id, () => {
          executionOrder.push(`end:${id}`);
          resolve(id);
        });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    // Start a read
    const p1 = gitExec.execGitAsync('/repo', ['diff']);
    await vi.waitFor(() => expect(resolvers.has('diff')).toBe(true));

    // Enqueue a write — should wait for the read to finish
    const p2 = gitExec.execGitAsync('/repo', ['checkout', 'main']);

    // Give microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(executionOrder).not.toContain('start:checkout');

    // Complete the read → write should start
    resolvers.get('diff')!();
    await vi.waitFor(() => expect(resolvers.has('checkout')).toBe(true));
    resolvers.get('checkout')!();

    await Promise.all([p1, p2]);
    expect(executionOrder).toEqual(['start:diff', 'end:diff', 'start:checkout', 'end:checkout']);
  });

  it('status runs concurrently with other safe reads on the same path', async () => {
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        resolvers.set(id, () => resolve(id));
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo', ['diff']);
    const p2 = gitExec.execGitAsync('/repo', ['status', '--porcelain']);

    // Both should start concurrently — status is in the safe-read allowlist
    await vi.waitFor(() => {
      expect(resolvers.has('diff')).toBe(true);
      expect(resolvers.has('status')).toBe(true);
    });

    resolvers.get('diff')!();
    resolvers.get('status')!();
    await Promise.all([p1, p2]);
  });

  it('status waits for a pending write to complete', async () => {
    const executionOrder: string[] = [];
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        executionOrder.push(`start:${id}`);
        resolvers.set(id, () => {
          executionOrder.push(`end:${id}`);
          resolve(id);
        });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    // Start a write
    const p1 = gitExec.execGitAsync('/repo', ['commit', '-m', 'test']);
    await vi.waitFor(() => expect(resolvers.has('commit')).toBe(true));

    // Enqueue status — it should wait for the write
    const p2 = gitExec.execGitAsync('/repo', ['status']);

    await new Promise((r) => setTimeout(r, 50));
    expect(executionOrder).not.toContain('start:status');

    // Complete the write → status should start
    resolvers.get('commit')!();
    await vi.waitFor(() => expect(resolvers.has('status')).toBe(true));
    resolvers.get('status')!();

    await Promise.all([p1, p2]);
    expect(executionOrder).toEqual(['start:commit', 'end:commit', 'start:status', 'end:status']);
  });

  it('execGitAsyncRaw status calls wait for a pending write', async () => {
    const executionOrder: string[] = [];
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        executionOrder.push(`start:${id}`);
        resolvers.set(id, () => {
          executionOrder.push(`end:${id}`);
          resolve(args.join(' '));
        });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo', ['commit', '-m', 'test']);
    await vi.waitFor(() => expect(resolvers.has('commit')).toBe(true));

    const p2 = gitExec.execGitAsyncRaw('/repo', ['status', '--porcelain', '-unormal']);

    await new Promise((r) => setTimeout(r, 50));
    expect(executionOrder).not.toContain('start:status');

    resolvers.get('commit')!();
    await vi.waitFor(() => expect(resolvers.has('status')).toBe(true));
    resolvers.get('status')!();

    await expect(p2).resolves.toBe('status --porcelain -unormal');
    await p1;
    expect(executionOrder).toEqual(['start:commit', 'end:commit', 'start:status', 'end:status']);
  });

  it('push stays serialized behind active safe readers', async () => {
    const executionOrder: string[] = [];
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        executionOrder.push(`start:${id}`);
        resolvers.set(id, () => {
          executionOrder.push(`end:${id}`);
          resolve(id);
        });
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    const p1 = gitExec.execGitAsync('/repo', ['diff']);
    await vi.waitFor(() => expect(resolvers.has('diff')).toBe(true));

    const p2 = gitExec.execGitAsync('/repo', ['push', 'origin', 'feature']);

    await new Promise((r) => setTimeout(r, 50));
    expect(executionOrder).not.toContain('start:push');

    resolvers.get('diff')!();
    await vi.waitFor(() => expect(resolvers.has('push')).toBe(true));
    resolvers.get('push')!();

    await Promise.all([p1, p2]);
    expect(executionOrder).toEqual(['start:diff', 'end:diff', 'start:push', 'end:push']);
  });

  it('sets GIT_OPTIONAL_LOCKS=0 for read-only commands via execGitAsync', async () => {
    const capturedEnvs = new Map<string, Record<string, unknown>>();

    setupMock({
      onCommandWithOpts: (args, opts, resolve) => {
        capturedEnvs.set(args[0], opts);
        resolve('ok');
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    await gitExec.execGitAsync('/repo', ['status', '--porcelain']);
    await gitExec.execGitAsync('/repo', ['diff']);
    await gitExec.execGitAsync('/repo', ['log', '--oneline']);

    for (const cmd of ['status', 'diff', 'log']) {
      const opts = capturedEnvs.get(cmd)!;
      const env = opts.env as Record<string, string>;
      expect(env).toBeDefined();
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    }
  });

  it('sets GIT_OPTIONAL_LOCKS=0 for read-only commands via execGitAsyncRaw', async () => {
    const capturedEnvs = new Map<string, Record<string, unknown>>();

    setupMock({
      onCommandWithOpts: (args, opts, resolve) => {
        capturedEnvs.set(args[0], opts);
        resolve('ok');
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    await gitExec.execGitAsyncRaw('/repo', ['status', '--porcelain', '-unormal']);

    const opts = capturedEnvs.get('status')!;
    const env = opts.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('sets GIT_OPTIONAL_LOCKS=0 for read-only commands via execGitAsyncBuffer', async () => {
    const capturedEnvs = new Map<string, Record<string, unknown>>();

    setupMock({
      onCommandWithOpts: (args, opts, resolve) => {
        capturedEnvs.set(args[0], opts);
        resolve('ok');
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    await gitExec.execGitAsyncBuffer('/repo', ['diff', '--raw']);

    const opts = capturedEnvs.get('diff')!;
    const env = opts.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('does not set GIT_OPTIONAL_LOCKS for write commands', async () => {
    const capturedEnvs = new Map<string, Record<string, unknown>>();

    setupMock({
      onCommandWithOpts: (args, opts, resolve) => {
        capturedEnvs.set(args[0], opts);
        resolve('ok');
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    await gitExec.execGitAsync('/repo', ['commit', '-m', 'test']);
    await gitExec.execGitAsync('/repo', ['checkout', 'main']);
    await gitExec.execGitAsync('/repo', ['push', 'origin', 'feature']);

    for (const cmd of ['commit', 'checkout', 'push']) {
      const opts = capturedEnvs.get(cmd)!;
      const env = opts.env as Record<string, string>;
      expect(env).toBeDefined();
      expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined();
    }
  });

  it('preserves process.env when setting GIT_OPTIONAL_LOCKS', async () => {
    let capturedEnv: Record<string, string> | undefined;

    setupMock({
      onCommandWithOpts: (_args, opts, resolve) => {
        capturedEnv = opts.env as Record<string, string>;
        resolve('ok');
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    await gitExec.execGitAsync('/repo', ['status']);

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.GIT_OPTIONAL_LOCKS).toBe('0');
    // process.env should be spread into the env object (HOME exists on all platforms)
    expect(capturedEnv!.HOME ?? capturedEnv!.USERPROFILE).toBeDefined();
  });

  it('multiple safe reads proceed after a write completes', async () => {
    const resolvers = new Map<string, () => void>();

    setupMock({
      onCommand: (args, resolve) => {
        const id = args[0];
        resolvers.set(id, () => resolve(id));
      },
    });

    const { gitExec } = await import('../../../../src/main/services/git/git-exec');

    // Start a write
    const p1 = gitExec.execGitAsync('/repo', ['commit', '-m', 'test']);
    await vi.waitFor(() => expect(resolvers.has('commit')).toBe(true));

    // Enqueue multiple safe reads behind the write
    const p2 = gitExec.execGitAsync('/repo', ['show', 'HEAD:README.md']);
    const p3 = gitExec.execGitAsync('/repo', ['log', '--oneline']);
    const p4 = gitExec.execGitAsync('/repo', ['diff']);

    // Complete the write → all reads should start concurrently
    resolvers.get('commit')!();
    await vi.waitFor(() => {
      expect(resolvers.has('show')).toBe(true);
      expect(resolvers.has('log')).toBe(true);
      expect(resolvers.has('diff')).toBe(true);
    });

    resolvers.get('show')!();
    resolvers.get('log')!();
    resolvers.get('diff')!();
    await Promise.all([p1, p2, p3, p4]);
  });
});
