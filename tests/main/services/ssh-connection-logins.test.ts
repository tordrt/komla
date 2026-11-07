import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.fn();
const warn = vi.fn();
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ info, warn, debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: () => false,
  windowsPathToWsl: (value: string) => value,
}));

// A stand-in for fs.watch, so the tests don't depend on how many watches the machine has left.
type Watch = { directory: string; emit: (filename: string) => void; watcher: EventEmitter };
const watches: Watch[] = [];
const watchFailures: Error[] = [];
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: (directory: string, listener: (event: string, filename: string) => void) => {
      const failure = watchFailures.shift();
      if (failure) throw failure;
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
      watches.push({ directory, emit: (filename) => listener('rename', filename), watcher });
      return watcher;
    },
  };
});

const LOGIN = 'Logging in to an SSH host';

describe('SSH login log', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync('/tmp/komla-ssh-logins-');
    info.mockReset();
    warn.mockReset();
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('logs a command’s login only when no shared connection is open for it to join', async () => {
    const { logSshLoginUnlessShared } =
      await import('../../../src/main/services/ssh-connection/logins');
    const socket = join(directory, 'background');
    const source = { hostId: 'devbox', connection: 'background' };

    // Each of several commands that start together before the connection opens logs in.
    logSshLoginUnlessShared(socket, source);
    logSshLoginUnlessShared(socket, source);
    writeFileSync(socket, '');
    logSshLoginUnlessShared(socket, source);

    expect(info.mock.calls).toEqual([
      [LOGIN, source],
      [LOGIN, source],
    ]);
  });

  it('logs which terminal connection logged in when it opens', async () => {
    const { watchSshTerminalLogins } =
      await import('../../../src/main/services/ssh-connection/logins');
    const socket = join(directory, 'a1b2c3');
    const source = { hostId: 'devbox', connection: 'terminal 2' };
    watchSshTerminalLogins(socket, source);
    watchSshTerminalLogins(socket, source);
    // join() normalizes separators, so on Windows the watched folder isn't spelled like `directory`.
    const watched = watches.filter((watch) => watch.directory === dirname(socket));
    expect(watched).toHaveLength(1);
    const { emit } = watched[0];

    // ssh binds a temporary name first, which names no connection.
    writeFileSync(`${socket}.Xy12`, '');
    emit('a1b2c3.Xy12');
    writeFileSync(socket, '');
    emit('a1b2c3');
    emit('a1b2c3');
    rmSync(`${socket}.Xy12`);
    emit('a1b2c3.Xy12');
    expect(info.mock.calls).toEqual([[LOGIN, source]]);

    // The connection closed, and a later terminal logged in again.
    rmSync(socket);
    emit('a1b2c3');
    writeFileSync(socket, '');
    emit('a1b2c3');
    expect(info.mock.calls).toEqual([
      [LOGIN, source],
      [LOGIN, source],
    ]);
  });

  it('warns when it can’t watch for terminals’ logins, and tries again for the next', async () => {
    const { watchSshTerminalLogins } =
      await import('../../../src/main/services/ssh-connection/logins');
    const source = { hostId: 'devbox', connection: 'terminal 0' };
    const socket = join(directory, 'first');
    const watchesOfFolder = () => watches.filter((watch) => watch.directory === dirname(socket));
    watchFailures.push(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

    watchSshTerminalLogins(socket, source);
    expect(warn).toHaveBeenCalledWith("Could not log terminals' SSH logins", expect.anything());
    watchSshTerminalLogins(socket, source);
    const watched = watchesOfFolder();
    expect(watched).toHaveLength(1);

    watched[0].watcher.emit('error', new Error('gone'));
    expect(warn).toHaveBeenCalledWith("Stopped logging terminals' SSH logins", expect.anything());
    watchSshTerminalLogins(socket, source);
    expect(watchesOfFolder()).toHaveLength(2);
  });

  it('logs a terminal that every shared connection refused, which logs in by itself', async () => {
    const { SshTerminalPool } =
      await import('../../../src/main/services/ssh-connection/terminal-pool');
    const pool = new SshTerminalPool();
    const host = { id: 'devbox', name: 'Devbox', hostname: 'devbox.example.com', user: 'dev' };

    pool.buildCommand(host, 'terminal-1', 'tmux attach', false);
    pool.recordAssignment('terminal-1', { kind: 'standalone' });
    pool.recordAssignment('terminal-1', { kind: 'standalone' });

    expect(info.mock.calls).toEqual([
      [LOGIN, { hostId: 'devbox', connection: 'terminal (not shared)' }],
    ]);
  });
});
