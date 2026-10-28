/**
 * Child process mocks for testing services that spawn subprocesses.
 * Used primarily by GitService and other command-execution code.
 *
 * Usage:
 * ```ts
 * import { mockChildProcess, createExecMock } from '../../mocks/child-process'
 *
 * vi.mock('child_process', () => mockChildProcess())
 *
 * // Configure exec to return specific output:
 * const exec = createExecMock()
 * exec.mockCommand('git status', { stdout: 'On branch main' })
 * ```
 */

import { EventEmitter } from 'events';
import { promisify } from 'util';

import { vi } from 'vitest';

/**
 * Result type for exec/execSync commands.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  error?: Error & { code?: number; killed?: boolean };
}

/**
 * Configuration for a mocked command.
 */
export interface MockedCommand {
  stdout?: string;
  stderr?: string;
  error?: Error | string;
  exitCode?: number;
  delay?: number;
}

/**
 * Create an exec mock that can be configured with expected command outputs.
 */
export function createExecMock(): ExecMockController {
  const commands = new Map<string | RegExp, MockedCommand>();
  let defaultResponse: MockedCommand = { stdout: '', stderr: '' };

  const findMatch = (command: string): MockedCommand | undefined => {
    // Try exact match first
    if (commands.has(command)) {
      return commands.get(command);
    }

    // Try regex matches
    for (const [pattern, response] of commands) {
      if (pattern instanceof RegExp && pattern.test(command)) {
        return response;
      }
    }

    return undefined;
  };

  const exec = vi.fn(
    (
      command: string,
      options: unknown,
      callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      // Handle case where options is the callback
      const cb =
        typeof options === 'function'
          ? (options as (error: Error | null, result: { stdout: string; stderr: string }) => void)
          : callback;

      const response = findMatch(command) || defaultResponse;

      const executeCallback = () => {
        if (response.error) {
          const error =
            typeof response.error === 'string' ? new Error(response.error) : response.error;
          (error as Error & { code?: number }).code = response.exitCode || 1;
          cb?.(error, { stdout: response.stdout || '', stderr: response.stderr || '' });
        } else {
          cb?.(null, {
            stdout: response.stdout || '',
            stderr: response.stderr || '',
          });
        }
      };

      if (response.delay) {
        setTimeout(executeCallback, response.delay);
      } else {
        // Use setImmediate to simulate async behavior
        setImmediate(executeCallback);
      }

      // Return a mock ChildProcess
      const proc = new EventEmitter();
      (proc as typeof proc & { pid: number }).pid = Math.floor(Math.random() * 10000);
      return proc;
    }
  );

  const execSync = vi.fn((command: string) => {
    const response = findMatch(command) || defaultResponse;

    if (response.error) {
      const error = typeof response.error === 'string' ? new Error(response.error) : response.error;
      (error as Error & { code?: number }).code = response.exitCode || 1;
      throw error;
    }

    return response.stdout || '';
  });

  return {
    exec,
    execSync,
    mockCommand: (pattern: string | RegExp, response: MockedCommand) => {
      commands.set(pattern, response);
    },
    mockDefault: (response: MockedCommand) => {
      defaultResponse = response;
    },
    clearMocks: () => {
      commands.clear();
      defaultResponse = { stdout: '', stderr: '' };
    },
    getCallCount: () => exec.mock.calls.length,
    getLastCommand: () => {
      const calls = exec.mock.calls;
      return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
    },
    getAllCommands: () => exec.mock.calls.map((call) => call[0]),
  };
}

export interface ExecMockController {
  exec: ReturnType<typeof vi.fn>;
  execSync: ReturnType<typeof vi.fn>;
  mockCommand: (pattern: string | RegExp, response: MockedCommand) => void;
  mockDefault: (response: MockedCommand) => void;
  clearMocks: () => void;
  getCallCount: () => number;
  getLastCommand: () => string | undefined;
  getAllCommands: () => string[];
}

/**
 * Create an execFile mock that can be configured with expected command outputs.
 * Pattern matching joins file + args into a string: `${file} ${args.join(' ')}` so
 * existing regex patterns still work (e.g., /git rev-parse --verify feature-branch/).
 */
export function createExecFileMock(): ExecFileMockController {
  const commands = new Map<string | RegExp, MockedCommand>();
  let defaultResponse: MockedCommand = { stdout: '', stderr: '' };

  const findMatch = (command: string): MockedCommand | undefined => {
    // Try exact match first
    if (commands.has(command)) {
      return commands.get(command);
    }

    // Try regex matches
    for (const [pattern, response] of commands) {
      if (pattern instanceof RegExp && pattern.test(command)) {
        return response;
      }
    }

    return undefined;
  };

  const execFile = vi.fn(
    (
      file: string,
      args?: string[] | unknown,
      options?: unknown,
      callback?: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      // Handle overloaded signatures: execFile(file, args, callback) or execFile(file, args, options, callback)
      let actualArgs: string[] = [];
      let cb: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

      if (Array.isArray(args)) {
        actualArgs = args;
        if (typeof options === 'function') {
          cb = options as (error: Error | null, stdout: string, stderr: string) => void;
        } else {
          cb = callback;
        }
      } else if (typeof args === 'function') {
        cb = args as unknown as (error: Error | null, stdout: string, stderr: string) => void;
      }

      // Build the command string for pattern matching
      const command = actualArgs.length > 0 ? `${file} ${actualArgs.join(' ')}` : file;
      const response = findMatch(command) || defaultResponse;

      const executeCallback = () => {
        if (response.error) {
          const error =
            typeof response.error === 'string' ? new Error(response.error) : response.error;
          (error as Error & { code?: number }).code = response.exitCode || 1;
          // execFile callback: (error, stdout, stderr) — but promisify wraps into { stdout, stderr }
          // Node's promisify(execFile) expects the callback to receive (error, stdout, stderr)
          cb?.(error, response.stdout || '', response.stderr || '');
        } else {
          cb?.(null, response.stdout || '', response.stderr || '');
        }
      };

      if (response.delay) {
        setTimeout(executeCallback, response.delay);
      } else {
        setImmediate(executeCallback);
      }

      // Return a mock ChildProcess
      const proc = new EventEmitter();
      (proc as typeof proc & { pid: number }).pid = Math.floor(Math.random() * 10000);
      return proc;
    }
  );

  // Add custom promisify so `promisify(execFile)` returns { stdout, stderr } like Node's real execFile
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args?: string[] | unknown,
    options?: unknown
  ): Promise<{ stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
      execFile(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          const enriched = error as Error & { stdout?: string; stderr?: string };
          enriched.stdout = stdout;
          enriched.stderr = stderr;
          reject(enriched);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };

  return {
    execFile,
    mockCommand: (pattern: string | RegExp, response: MockedCommand) => {
      commands.set(pattern, response);
    },
    mockDefault: (response: MockedCommand) => {
      defaultResponse = response;
    },
    clearMocks: () => {
      commands.clear();
      defaultResponse = { stdout: '', stderr: '' };
    },
    getCallCount: () => execFile.mock.calls.length,
    getLastCommand: () => {
      const calls = execFile.mock.calls;
      if (calls.length === 0) return undefined;
      const lastCall = calls[calls.length - 1];
      const file = lastCall[0] as string;
      const args = Array.isArray(lastCall[1]) ? (lastCall[1] as string[]) : [];
      return args.length > 0 ? `${file} ${args.join(' ')}` : file;
    },
    getAllCommands: () =>
      execFile.mock.calls.map((call) => {
        const file = call[0] as string;
        const args = Array.isArray(call[1]) ? (call[1] as string[]) : [];
        return args.length > 0 ? `${file} ${args.join(' ')}` : file;
      }),
  };
}

export interface ExecFileMockController {
  execFile: ReturnType<typeof vi.fn>;
  mockCommand: (pattern: string | RegExp, response: MockedCommand) => void;
  mockDefault: (response: MockedCommand) => void;
  clearMocks: () => void;
  getCallCount: () => number;
  getLastCommand: () => string | undefined;
  getAllCommands: () => string[];
}

/**
 * Create a spawn mock for testing code that uses spawn().
 */
export function createSpawnMock(): SpawnMockController {
  const processes = new Map<number, MockChildProcess>();
  let pidCounter = 1000;

  const spawn = vi.fn((command: string, args: string[] = [], _options?: unknown) => {
    const pid = pidCounter++;
    const proc = new EventEmitter() as MockChildProcess;

    proc.pid = pid;
    proc.stdin = new EventEmitter() as MockChildProcess['stdin'];
    proc.stdin.write = vi.fn();
    proc.stdin.end = vi.fn();

    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    proc.kill = vi.fn(() => {
      proc.emit('exit', 0, null);
      return true;
    });

    // Store for test control
    proc._command = command;
    proc._args = args;
    processes.set(pid, proc);

    return proc;
  });

  return {
    spawn,
    getProcess: (pid: number) => processes.get(pid),
    getLatestProcess: () => {
      const pids = Array.from(processes.keys());
      return pids.length > 0 ? processes.get(pids[pids.length - 1]) : undefined;
    },
    simulateOutput: (pid: number, stream: 'stdout' | 'stderr', data: string) => {
      const proc = processes.get(pid);
      proc?.[stream].emit('data', Buffer.from(data));
    },
    simulateExit: (pid: number, code: number, signal?: string) => {
      const proc = processes.get(pid);
      proc?.emit('exit', code, signal || null);
      proc?.emit('close', code, signal || null);
    },
    simulateError: (pid: number, error: Error) => {
      const proc = processes.get(pid);
      proc?.emit('error', error);
    },
    clearProcesses: () => processes.clear(),
  };
}

export interface MockChildProcess extends EventEmitter {
  pid: number;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  _command: string;
  _args: string[];
}

export interface SpawnMockController {
  spawn: ReturnType<typeof vi.fn>;
  getProcess: (pid: number) => MockChildProcess | undefined;
  getLatestProcess: () => MockChildProcess | undefined;
  simulateOutput: (pid: number, stream: 'stdout' | 'stderr', data: string) => void;
  simulateExit: (pid: number, code: number, signal?: string) => void;
  simulateError: (pid: number, error: Error) => void;
  clearProcesses: () => void;
}

/**
 * Create complete child_process mock module.
 */
export function mockChildProcess(
  execController?: ExecMockController,
  spawnController?: SpawnMockController,
  execFileController?: ExecFileMockController
): MockChildProcessModule {
  const execCtrl = execController || createExecMock();
  const spawnCtrl = spawnController || createSpawnMock();
  const execFileCtrl = execFileController || createExecFileMock();

  return {
    exec: execCtrl.exec,
    execSync: execCtrl.execSync,
    spawn: spawnCtrl.spawn,
    spawnSync: vi.fn(() => ({
      pid: Math.floor(Math.random() * 10000),
      output: [null, Buffer.from(''), Buffer.from('')],
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      status: 0,
      signal: null,
    })),
    fork: vi.fn(),
    execFile: execFileCtrl.execFile,
    execFileSync: vi.fn(),
  };
}

export interface MockChildProcessModule {
  exec: ReturnType<typeof vi.fn>;
  execSync: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  spawnSync: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  execFile: ReturnType<typeof vi.fn>;
  execFileSync: ReturnType<typeof vi.fn>;
}
