/**
 * Node-pty mocks for testing terminal/PTY-related services.
 *
 * Usage:
 * ```ts
 * import { mockNodePty, createPtyController } from '../../mocks/node-pty'
 *
 * vi.mock('node-pty', () => mockNodePty())
 *
 * // Or with controller for fine-grained control:
 * const ptyCtrl = createPtyController()
 * vi.mock('node-pty', () => ptyCtrl.mock)
 *
 * // Later in test:
 * ptyCtrl.simulateData(terminalId, 'Hello, World!')
 * ptyCtrl.simulateExit(terminalId, 0)
 * ```
 */

import { EventEmitter } from 'events';

import { vi } from 'vitest';

/**
 * Mock IPty instance that simulates a pseudo-terminal.
 */
export interface MockIPty extends EventEmitter {
  pid: number;
  cols: number;
  rows: number;
  process: string;
  handleFlowControl: boolean;

  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;

  // Test utilities
  _id: string;
  _cwd: string;
  _command: string | null;
  _killed: boolean;
}

/**
 * Create a mock IPty instance.
 */
export function createMockIPty(
  id: string,
  shell: string,
  _args: string[],
  options: { cwd?: string; cols?: number; rows?: number } = {}
): MockIPty {
  const pty = new EventEmitter() as MockIPty;

  pty.pid = Math.floor(Math.random() * 100000);
  pty.cols = options.cols || 80;
  pty.rows = options.rows || 24;
  pty.process = shell;
  pty.handleFlowControl = false;

  pty._id = id;
  pty._cwd = options.cwd || process.cwd();
  pty._command = null;
  pty._killed = false;
  (pty as unknown as { ptsName: string }).ptsName = `/dev/ttys${String(pty.pid).padStart(3, '0')}`;

  pty.write = vi.fn((data: string) => {
    // Simulate echo if not killed
    if (!pty._killed) {
      pty.emit('data', data);
    }
  });

  pty.resize = vi.fn((cols: number, rows: number) => {
    pty.cols = cols;
    pty.rows = rows;
  });

  pty.clear = vi.fn();
  pty.pause = vi.fn();
  pty.resume = vi.fn();

  pty.kill = vi.fn((signal?: string) => {
    pty._killed = true;
    pty.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal || 'SIGTERM');
  });

  return pty;
}

/**
 * Controller for managing multiple mock PTY instances.
 */
export interface PtyController {
  mock: MockNodePtyModule;
  spawn: ReturnType<typeof vi.fn>;
  getPty: (id: string) => MockIPty | undefined;
  getAll: () => Map<string, MockIPty>;
  simulateData: (id: string, data: string) => void;
  simulateExit: (id: string, exitCode: number, signal?: string) => void;
  clear: () => void;
}

/**
 * Create a PTY controller for managing mock terminals.
 */
export function createPtyController(): PtyController {
  const ptys = new Map<string, MockIPty>();
  let idCounter = 0;

  const spawn = vi.fn((shell: string, args: string[] = [], options: SpawnOptions = {}) => {
    const id = `pty-${idCounter++}`;
    const pty = createMockIPty(id, shell, args, options);
    ptys.set(id, pty);

    // Also store by pid for lookup
    ptys.set(`pid-${pty.pid}`, pty);

    return pty;
  });

  return {
    mock: {
      spawn,
      // node-pty also exports these but they're rarely used in tests
      native: undefined,
      ITerminal: undefined,
    },
    spawn,
    getPty: (id: string) => ptys.get(id),
    getAll: () => new Map(ptys),
    simulateData: (id: string, data: string) => {
      const pty = ptys.get(id);
      if (pty) {
        pty.emit('data', data);
      }
    },
    simulateExit: (id: string, exitCode: number, signal?: string) => {
      const pty = ptys.get(id);
      if (pty) {
        pty._killed = true;
        pty.emit('exit', exitCode, signal || null);
      }
    },
    clear: () => ptys.clear(),
  };
}

interface SpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  encoding?: string;
  handleFlowControl?: boolean;
  conptyInheritCursor?: boolean;
}

export interface MockNodePtyModule {
  spawn: ReturnType<typeof vi.fn>;
  native: unknown;
  ITerminal: unknown;
}

/**
 * Create basic node-pty mock module.
 */
export function mockNodePty(): MockNodePtyModule {
  return createPtyController().mock;
}
