import { execFile } from 'child_process';
import { unlinkSync, writeFileSync, existsSync } from 'fs';
import { createServer, Server, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { beforeAll, describe, it, expect, afterEach } from 'vitest';

import { askpassHelperScript } from '../../../src/main/services/askpass-helper-script';

/**
 * Integration tests for the askpass helper script.
 *
 * These tests verify that the real generated .js helper script and .sh wrapper
 * actually work end-to-end: connecting to a real Unix socket, exchanging
 * JSON messages, and writing the passphrase to stdout.
 *
 * Unlike the unit tests (which mock fs/net/electron), these spawn real
 * processes and use real sockets.
 */

interface TestContext {
  server: Server | null;
  socketPath: string;
  jsPath: string;
}

let unixSocketListenSupported = process.platform === 'win32';

function createTestContext(): TestContext {
  const id = Math.random().toString(36).slice(2);
  // Like askpass.service: Windows has no Unix domain sockets, so the server uses a named pipe.
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\komla-askpass-test-${id}`
      : join(tmpdir(), `komla-askpass-test-${id}.sock`);
  const jsPath = join(tmpdir(), `komla-askpass-test-${id}.js`);
  return { server: null, socketPath, jsPath };
}

function cleanup(ctx?: TestContext): void {
  if (!ctx) {
    return;
  }

  if (ctx.server) {
    ctx.server.close();
    ctx.server = null;
  }
  for (const p of [ctx.socketPath, ctx.jsPath]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function startServer(ctx: TestContext, onConnection: (socket: Socket) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.server = createServer(onConnection);
    ctx.server.on('error', reject);
    ctx.server.listen(ctx.socketPath, resolve);
  });
}

async function detectUnixSocketListenSupport(): Promise<boolean> {
  if (process.platform === 'win32') {
    return true;
  }

  const probePath = join(
    tmpdir(),
    `komla-askpass-probe-${Math.random().toString(36).slice(2)}.sock`
  );

  return await new Promise<boolean>((resolve) => {
    const server = createServer();

    server.once('error', () => resolve(false));
    server.listen(probePath, () => {
      server.close(() => {
        if (existsSync(probePath)) {
          try {
            unlinkSync(probePath);
          } catch {
            /* ignore */
          }
        }
        resolve(true);
      });
    });
  });
}

function runHelper(
  scriptPath: string,
  args: string[] = [],
  timeoutMs = 15000,
  env?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(scriptPath, args, { timeout: timeoutMs, env }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error
          ? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ETIMEDOUT'
            ? 124
            : ((error.code as number) ?? 1)
          : 0,
      });
    });
  });
}

describe('Askpass helper script integration', () => {
  let ctx: TestContext | undefined;

  beforeAll(async () => {
    unixSocketListenSupported = await detectUnixSocketListenSupport();
  });

  afterEach(() => {
    cleanup(ctx);
    ctx = undefined;
  });

  it('returns passphrase via socket when server responds', async () => {
    if (!unixSocketListenSupported) {
      return;
    }

    ctx = createTestContext();
    let receivedRequest: { id?: string; prompt?: string } = {};

    let resolveRequestReceived: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequestReceived = resolve;
    });

    await startServer(ctx, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        const newlineIndex = data.indexOf('\n');
        if (newlineIndex !== -1) {
          receivedRequest = JSON.parse(data.slice(0, newlineIndex));
          socket.write(JSON.stringify({ passphrase: 'my-secret-phrase' }) + '\n');
          socket.end();
          resolveRequestReceived?.();
        }
      });
    });

    // Write and execute the .js helper directly with node
    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    const result = await runHelper(
      process.execPath, // use current Node binary
      [ctx.jsPath, 'Enter passphrase for key /home/user/.ssh/id_rsa:']
    );

    await requestReceived;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('my-secret-phrase');
    expect(receivedRequest).toHaveProperty('id');
    expect(receivedRequest.prompt).toBe('Enter passphrase for key /home/user/.ssh/id_rsa:');
  });

  it('gives up once the process that ran it exits', async () => {
    if (!unixSocketListenSupported || process.platform === 'win32') {
      return;
    }

    ctx = createTestContext();
    let helperGone: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      helperGone = resolve;
    });
    // The helper sends its request after noting its parent, so the parent exits only once it
    // arrives. Exiting after a fixed delay lost the race on a loaded machine.
    const requested = `${ctx.jsPath}.requested`;
    await startServer(ctx, (socket) => {
      socket.once('data', () => writeFileSync(requested, ''));
      socket.resume();
      socket.on('close', () => helperGone());
    });
    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    // Like ssh killed while its helper waits: the parent exits and Komla never answers
    await runHelper('/bin/sh', [
      '-c',
      `"${process.execPath}" "${ctx.jsPath}" 'Password: ' >/dev/null 2>&1 & ` +
        `while [ ! -e "${requested}" ]; do sleep 0.05; done`,
    ]);
    unlinkSync(requested);

    await gone;
  });

  it('reports the askpass session from its environment', async () => {
    if (!unixSocketListenSupported) {
      return;
    }

    ctx = createTestContext();
    let receivedRequest: { session?: string | null } = {};

    await startServer(ctx, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          receivedRequest = JSON.parse(data.slice(0, data.indexOf('\n')));
          socket.write(JSON.stringify({ passphrase: 'test' }) + '\n');
          socket.end();
        }
      });
    });

    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    await runHelper(process.execPath, [ctx.jsPath], 15000, {
      ...process.env,
      KOMLA_ASKPASS_SESSION: 'session-1',
    });

    expect(receivedRequest.session).toBe('session-1');
  });

  it('exits with code 1 when server returns null passphrase (user cancelled)', async () => {
    if (!unixSocketListenSupported) {
      return;
    }

    ctx = createTestContext();

    await startServer(ctx, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          socket.write(JSON.stringify({ passphrase: null }) + '\n');
          socket.end();
        }
      });
    });

    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    const result = await runHelper(process.execPath, [ctx.jsPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('exits with code 1 when socket server is not reachable', async () => {
    ctx = createTestContext();
    // Don't start a server — socket path doesn't exist

    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    const result = await runHelper(process.execPath, [ctx.jsPath]);

    expect(result.exitCode).toBe(1);
  });

  it('uses default prompt when no argument is provided', async () => {
    if (!unixSocketListenSupported) {
      return;
    }

    ctx = createTestContext();
    let receivedPrompt = '';

    await startServer(ctx, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          const request = JSON.parse(data.slice(0, data.indexOf('\n')));
          receivedPrompt = request.prompt;
          socket.write(JSON.stringify({ passphrase: 'test' }) + '\n');
          socket.end();
        }
      });
    });

    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    await runHelper(process.execPath, [ctx.jsPath]);

    expect(receivedPrompt).toBe('Enter passphrase:');
  });

  it('handles passphrases with special characters', async () => {
    if (!unixSocketListenSupported) {
      return;
    }

    ctx = createTestContext();
    const specialPassphrase = 'p@$$w0rd "with" \'quotes\' & <special> chars! 🔑';

    await startServer(ctx, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          socket.write(JSON.stringify({ passphrase: specialPassphrase }) + '\n');
          socket.end();
        }
      });
    });

    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    const result = await runHelper(process.execPath, [ctx.jsPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(specialPassphrase);
  });

  it('exits with code 1 when server sends invalid JSON', async () => {
    if (!unixSocketListenSupported) {
      return;
    }

    ctx = createTestContext();

    await startServer(ctx, (socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          socket.write('not valid json\n');
          socket.end();
        }
      });
    });

    writeFileSync(ctx.jsPath, askpassHelperScript(ctx.socketPath), 'utf-8');

    const result = await runHelper(process.execPath, [ctx.jsPath]);

    expect(result.exitCode).toBe(1);
  });
});
