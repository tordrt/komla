import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { promisify } from 'util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXEC_CHANNEL_CONNECTION_RETRY_MS,
  EXEC_CHANNEL_IDLE_MS,
  EXEC_CHANNEL_RETRY_MS,
  ExecChannelUnavailableError,
  SshExecChannel,
  SshExecChannels,
} from '../../../src/main/services/ssh-connection/exec-channel';
import {
  isSshConnectionFailure,
  isSshTimeout,
} from '../../../src/main/services/ssh-host-status.service';

import type { ChildProcessWithoutNullStreams } from 'child_process';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const READY = 0;
const EXEC = 1;
const CANCEL = 2;
const STDOUT = 16;
const STDERR = 17;
const EXIT = 18;

function frame(kind: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32BE(5 + payload.length, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32BE(id, 5);
  return Buffer.concat([header, payload]);
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

/** The ssh process with `__exec-channel` behind it, played by the test. */
class FakeChannelProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly requests: Array<{ kind: number; id: number; payload: Buffer }> = [];
  readonly kill = vi.fn(() => {
    this.exit();
    return true;
  });
  private unread = Buffer.alloc(0);

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.unread = Buffer.concat([this.unread, chunk]);
      while (this.unread.length >= 4 && this.unread.length >= 4 + this.unread.readUInt32BE(0)) {
        const length = this.unread.readUInt32BE(0);
        this.requests.push({
          kind: this.unread.readUInt8(4),
          id: this.unread.readUInt32BE(5),
          payload: Buffer.from(this.unread.subarray(9, 4 + length)),
        });
        this.unread = this.unread.subarray(4 + length);
      }
    });
    // The host's channel exits when the desktop closes its input.
    this.stdin.on('finish', () => this.exit());
  }

  get process(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  ready(version = 1): void {
    this.stdout.write(frame(READY, 0, int32(version)));
  }

  reply(id: number, reply: { stdout?: string; stderr?: string; code?: number }): void {
    if (reply.stdout) this.stdout.write(frame(STDOUT, id, Buffer.from(reply.stdout)));
    if (reply.stderr) this.stdout.write(frame(STDERR, id, Buffer.from(reply.stderr)));
    this.stdout.write(frame(EXIT, id, int32(reply.code ?? 0)));
  }

  exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 255;
    this.emit('close', 255, null);
  }

  /** The commands it was sent, with their input. */
  execRequests(): Array<{ command: string; input: string }> {
    return this.requests
      .filter((request) => request.kind === EXEC)
      .map(({ payload }) => {
        const length = payload.readUInt32BE(0);
        return {
          command: payload.subarray(4, 4 + length).toString('utf8'),
          input: payload.subarray(4 + length).toString('utf8'),
        };
      });
  }

  execs(): string[] {
    return this.execRequests().map((request) => request.command);
  }
}

const options = { timeout: 10_000, maxBuffer: 1024, label: 'ssh dev@host sh -lc true' };

async function openChannel(): Promise<{ child: FakeChannelProcess; channel: SshExecChannel }> {
  const child = new FakeChannelProcess();
  const channel = new SshExecChannel(child.process);
  child.ready();
  await channel.opened;
  return { child, channel };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const errorFields = (error: unknown) => {
  const { message, code, killed, signal, cmd, stdout, stderr } = error as Record<string, unknown>;
  return { message, code, killed, signal, cmd, stdout, stderr };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SshExecChannel', () => {
  it('runs a command and answers with its output', async () => {
    const { child, channel } = await openChannel();
    const result = channel.run('git status --porcelain', options);
    await flush();
    expect(child.execs()).toEqual(['git status --porcelain']);
    child.reply(1, { stdout: ' M file\n' });
    await expect(result).resolves.toBe(' M file\n');
  });

  it('turns away commands until the host says it is ready, without sending them', async () => {
    const child = new FakeChannelProcess();
    const channel = new SshExecChannel(child.process);
    await expect(channel.run('true', options)).rejects.toBeInstanceOf(ExecChannelUnavailableError);
    await flush();
    expect(child.requests).toEqual([]);
  });

  it('fails a command that exits non-zero exactly as execFile does', async () => {
    const command = 'printf out; printf err >&2; exit 3';
    const viaExecFile = await promisify(execFile)('sh', ['-c', command]).catch((e: unknown) => e);
    const { child, channel } = await openChannel();
    const result = channel.run(command, { ...options, label: `sh -c ${command}` });
    await flush();
    child.reply(1, { stdout: 'out', stderr: 'err', code: 3 });
    const viaChannel = await result.catch((e: unknown) => e);
    expect(errorFields(viaChannel)).toEqual(errorFields(viaExecFile));
    expect(isSshConnectionFailure(viaChannel)).toBe(false);
  });

  it('stops a command at its timeout and fails it exactly as execFile does', async () => {
    const viaExecFile = await promisify(execFile)('sh', ['-c', 'sleep 5'], { timeout: 50 }).catch(
      (e: unknown) => e
    );
    const { child, channel } = await openChannel();
    vi.useFakeTimers();
    const result = channel.run('sleep 5', { ...options, timeout: 50, label: 'sh -c sleep 5' });
    const failed = result.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    const viaChannel = await failed;
    expect(errorFields(viaChannel)).toEqual(errorFields(viaExecFile));
    expect(isSshTimeout(viaChannel)).toBe(true);
    vi.useRealTimers();
    await flush();
    expect(child.requests.at(-1)).toMatchObject({ kind: CANCEL, id: 1 });
  });

  it('stops a command whose output outgrows the buffer, which is no timeout', async () => {
    const { child, channel } = await openChannel();
    const result = channel.run('cat big', options);
    await flush();
    child.stdout.write(frame(STDOUT, 1, Buffer.alloc(1025, 'x')));
    const error = await result.catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: 'stdout maxBuffer length exceeded',
    });
    expect(isSshTimeout(error)).toBe(false);
    await flush();
    expect(child.requests.at(-1)).toMatchObject({ kind: CANCEL, id: 1 });
  });

  it('answers commands in the order they finish, from frames split and joined anyhow', async () => {
    const { child, channel } = await openChannel();
    const slow = channel.run('slow', options);
    const fast = channel.run('fast', options);
    await flush();
    const bytes = Buffer.concat([
      frame(STDOUT, 2, Buffer.from('fast')),
      frame(EXIT, 2, int32(0)),
      frame(STDOUT, 1, Buffer.from('slow')),
      frame(EXIT, 1, int32(0)),
    ]);
    // Byte by byte, then everything at once, must parse alike.
    for (const byte of bytes.subarray(0, 20)) child.stdout.write(Buffer.from([byte]));
    child.stdout.write(bytes.subarray(20));
    await expect(fast).resolves.toBe('fast');
    await expect(slow).resolves.toBe('slow');
  });

  it("fails commands it already sent as a dropped ssh does, naming ssh's error", async () => {
    const { child, channel } = await openChannel();
    const result = channel.run('git commit', options);
    await flush();
    child.stderr.write('Connection to host closed by remote host.\n');
    await flush();
    child.exit();
    const error = await result.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ExecChannelUnavailableError);
    expect(error).toMatchObject({
      code: 255,
      stderr: 'Connection to host closed by remote host.\n',
    });
    expect(isSshConnectionFailure(error)).toBe(true);
    await expect(channel.run('true', options)).rejects.toBeInstanceOf(ExecChannelUnavailableError);
  });

  it('refuses a channel that speaks another protocol', async () => {
    const child = new FakeChannelProcess();
    const channel = new SshExecChannel(child.process);
    child.ready(2);
    await expect(channel.opened).rejects.toThrow('protocol 2');
    expect(child.kill).toHaveBeenCalled();
  });

  it('sends a command its input, and leaves one too large to the plain exec', async () => {
    const { child, channel } = await openChannel();
    const result = channel.run('cat > file', { ...options, input: 'contents' });
    await flush();
    expect(child.execRequests()).toEqual([{ command: 'cat > file', input: 'contents' }]);
    child.reply(1, {});
    await expect(result).resolves.toBe('');

    const tooLarge = channel.run('cat > file', { ...options, input: 'x'.repeat(16 * 1024 * 1024) });
    await expect(tooLarge).rejects.toBeInstanceOf(ExecChannelUnavailableError);
    expect(child.execRequests()).toHaveLength(1);
  });

  it('closes on bytes that are no frame, such as a login banner, before reading them all', async () => {
    const child = new FakeChannelProcess();
    const channel = new SshExecChannel(child.process);
    child.stdout.write('Welcome to the build host!\n');
    await expect(channel.opened).rejects.toThrow('frame of');
    expect(child.kill).toHaveBeenCalled();
  });

  it('fails its commands when the host sends an exit status that is too short', async () => {
    const { child, channel } = await openChannel();
    const result = channel.run('true', options);
    await flush();
    child.stdout.write(frame(EXIT, 1, Buffer.from([0])));
    await expect(result).rejects.toMatchObject({ code: 255 });
    expect(child.kill).toHaveBeenCalled();
  });

  it('finishes the commands it runs once retired, then closes, taking no new ones', async () => {
    const { child, channel } = await openChannel();
    const running = channel.run('git fetch', options);
    await flush();
    channel.retire();
    await expect(channel.run('git status', options)).rejects.toBeInstanceOf(
      ExecChannelUnavailableError
    );
    expect(child.exitCode).toBeNull();
    child.reply(1, { stdout: 'fetched' });
    await expect(running).resolves.toBe('fetched');
    await flush();
    expect(child.exitCode).not.toBeNull();
    expect(child.execs()).toEqual(['git fetch']);
  });
});

describe('SshExecChannels', () => {
  const host = { id: 'host-1', name: 'Host', hostname: 'host', basePath: '~/.komla' };

  function channels(enabled = true) {
    const children: FakeChannelProcess[] = [];
    const start = vi.fn(async (_host: unknown, _executable: string, _lane: string) => {
      const child = new FakeChannelProcess();
      children.push(child);
      return child.process;
    });
    const failedToOpen = vi.fn();
    return {
      children,
      start,
      failedToOpen,
      registry: new SshExecChannels({ start, failedToOpen }, enabled),
    };
  }

  it('hands out a channel only once it is open, opening one per host', async () => {
    const { children, start, registry } = channels();
    registry.use(host, 'key', '/base/helpers/bin/komla');
    expect(registry.get(host, 'key', 'background')).toBeUndefined();
    registry.use(host, 'key', '/other/base/komla');
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(host, '/base/helpers/bin/komla', 'background');
    children[0].ready();
    await flush();
    expect(registry.get(host, 'key', 'background')?.open).toBe(true);
  });

  it('gives interactive commands their own channel', async () => {
    const { children, start, registry } = channels();
    registry.use(host, 'key', '/komla');
    await flush();
    children[0].ready();
    await flush();
    expect(registry.get(host, 'key', 'interactive')).toBeUndefined();
    await flush();
    expect(start).toHaveBeenLastCalledWith(host, '/komla', 'interactive');
    children[1].ready();
    await flush();
    const interactive = registry.get(host, 'key', 'interactive');
    expect(interactive?.open).toBe(true);
    expect(interactive).not.toBe(registry.get(host, 'key', 'background'));
  });

  it('never opens one when turned off', async () => {
    const { start, registry } = channels(false);
    registry.use(host, 'key', '/komla');
    await flush();
    expect(registry.get(host, 'key', 'background')).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it('closes the channel of a host whose connection changed until its companion is found again', async () => {
    const { children, start, registry } = channels();
    registry.use(host, 'key', '/komla');
    await flush();
    children[0].ready();
    await flush();
    expect(registry.get(host, 'edited-key', 'background')).toBeUndefined();
    await flush();
    expect(children[0].exitCode).not.toBeNull();
    expect(registry.get(host, 'edited-key', 'background')).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets a forgotten host finish the commands its channel runs', async () => {
    const { children, registry } = channels();
    registry.use(host, 'key', '/komla');
    await flush();
    children[0].ready();
    await flush();
    const running = registry.get(host, 'key', 'background')!.run('git fetch', options);
    await flush();
    registry.forget(host.id);
    expect(children[0].exitCode).toBeNull();
    children[0].reply(1, {});
    await expect(running).resolves.toBe('');
    await flush();
    expect(children[0].exitCode).not.toBeNull();
  });

  it('waits before trying again after a channel failed to open, and says why it failed', async () => {
    vi.useFakeTimers();
    const { children, start, failedToOpen, registry } = channels();
    registry.use(host, 'key', '/komla');
    await vi.advanceTimersByTimeAsync(0);
    children[0].stderr.write('dev@host: Permission denied (publickey).\n');
    await vi.advanceTimersByTimeAsync(0);
    children[0].exit();
    await vi.advanceTimersByTimeAsync(0);
    expect(failedToOpen).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ stderr: 'dev@host: Permission denied (publickey).\n' })
    );
    registry.get(host, 'key', 'background');
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EXEC_CHANNEL_RETRY_MS);
    registry.get(host, 'key', 'background');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('tries again soon when the connection to share was not up yet', async () => {
    vi.useFakeTimers();
    const { start, registry } = channels();
    start.mockResolvedValueOnce(undefined as never);
    registry.use(host, 'key', '/komla');
    await vi.advanceTimersByTimeAsync(0);
    registry.get(host, 'key', 'background');
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EXEC_CHANNEL_CONNECTION_RETRY_MS);
    registry.get(host, 'key', 'background');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stops trying a host whose channel speaks no protocol it knows', async () => {
    vi.useFakeTimers();
    const { children, start, registry } = channels();
    registry.use(host, 'key', '/komla');
    await vi.advanceTimersByTimeAsync(0);
    children[0].stdout.write('Welcome to the build host!\n');
    await vi.advanceTimersByTimeAsync(EXEC_CHANNEL_RETRY_MS * 10);
    registry.get(host, 'key', 'background');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('opens a new channel on the next command after an open one closed', async () => {
    const { children, start, registry } = channels();
    registry.use(host, 'key', '/komla');
    await flush();
    children[0].ready();
    await flush();
    children[0].exit();
    expect(registry.get(host, 'key', 'background')).toBeUndefined();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('closes a channel nobody used for a while, but not while a command runs', async () => {
    vi.useFakeTimers();
    const { children, registry } = channels();
    registry.use(host, 'key', '/komla');
    await vi.advanceTimersByTimeAsync(0);
    children[0].ready();
    await vi.advanceTimersByTimeAsync(0);
    const channel = registry.get(host, 'key', 'background');
    const running = channel?.run('sleep 1000', { ...options, timeout: 2 * EXEC_CHANNEL_IDLE_MS });
    await vi.advanceTimersByTimeAsync(EXEC_CHANNEL_IDLE_MS);
    expect(children[0].exitCode).toBeNull();
    children[0].reply(1, {});
    await running;
    await vi.advanceTimersByTimeAsync(EXEC_CHANNEL_IDLE_MS);
    expect(children[0].exitCode).not.toBeNull();
  });
});
