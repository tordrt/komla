import { createLogger } from '../../lib/logger';

import type { SshRunPurpose } from './policy';
import type { SshHost } from '../../../shared/types';
import type { ChildProcessWithoutNullStreams } from 'child_process';

const logger = createLogger('SshExecChannel');

// Frames as the companion's `__exec-channel` reads and writes them (ADR 0003): a big-endian u32
// length of the rest, a kind byte, a big-endian u32 request id and the payload. An EXEC payload
// is a big-endian u32 length of the command, the command and the bytes for its stdin.
const EXEC_CHANNEL_PROTOCOL_VERSION = 1;
const READY = 0;
const EXEC = 1;
const CANCEL = 2;
const STDOUT = 16;
const STDERR = 17;
const EXIT = 18;
const HEADER_BYTES = 5;
// The companion's limits: it reads requests up to 16 MiB and sends output in 64 KiB chunks.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_REPLY_BYTES = HEADER_BYTES + 64 * 1024;
const OPEN_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;
// Like the interactive connection, a channel nobody used for this long closes.
export const EXEC_CHANNEL_IDLE_MS = 10 * 60_000;
// A channel that failed to open isn't tried again for a while, so a host that can't run one
// doesn't pay for a failed start on every command.
export const EXEC_CHANNEL_RETRY_MS = 60_000;
// A lane whose shared connection is down tries again soon; its next plain command opens it.
export const EXEC_CHANNEL_CONNECTION_RETRY_MS = 5_000;
// Node's code for output past maxBuffer, which host status tells apart from a timeout.
const OUTPUT_LIMIT_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** The channel could not take the command, so it never reached the host. */
export class ExecChannelUnavailableError extends Error {
  constructor(message = 'The SSH exec channel is not open') {
    super(message);
    this.name = 'ExecChannelUnavailableError';
  }
}

/** The channel sent something that isn't the protocol, so another channel would do no better. */
class ExecChannelProtocolError extends Error {}

export interface ExecChannelRunOptions {
  timeout: number;
  maxBuffer: number;
  /** The command as `execFile` would name it in an error. */
  label: string;
  /** The command's stdin; it reads nothing without one. */
  input?: string;
}

interface PendingCommand {
  label: string;
  maxBuffer: number;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  timer: NodeJS.Timeout;
  resolve: (stdout: string) => void;
  reject: (error: Error) => void;
}

function frame(kind: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(4 + HEADER_BYTES);
  header.writeUInt32BE(HEADER_BYTES + payload.length, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32BE(id, 5);
  return Buffer.concat([header, payload]);
}

/**
 * Fails like `execFile` through `promisify` does, so host status, timeouts and output limits treat
 * a command the same whichever way it ran.
 */
function commandError(
  pending: PendingCommand,
  fields: { code: number | string | null; killed: boolean; signal: NodeJS.Signals | null },
  message?: string
): Error {
  const stdout = Buffer.concat(pending.stdout).toString('utf8');
  const stderr = Buffer.concat(pending.stderr).toString('utf8');
  const error =
    message === undefined
      ? new Error(`Command failed: ${pending.label}\n${stderr}`)
      : new RangeError(message);
  return Object.assign(error, fields, { cmd: pending.label, stdout, stderr });
}

/**
 * One `__exec-channel` process on an SSH host, reached through the ssh process that started it.
 * Commands run side by side; each answers once with its output or an `execFile`-shaped error.
 */
export class SshExecChannel {
  readonly opened: Promise<void>;
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 1;
  private state: 'opening' | 'open' | 'closed' = 'opening';
  private retiring = false;
  private unread: Buffer = Buffer.alloc(0);
  private sshErrors = '';
  private markOpened!: () => void;
  private failOpen!: (error: Error) => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onClose: (error: Error, wasOpen: boolean) => void = () => undefined
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      this.markOpened = resolve;
      this.failOpen = reject;
    });
    // Nobody may wait for it, and a failed open is reported where it is awaited.
    this.opened.catch(() => undefined);
    const openTimer = setTimeout(() => {
      this.closeWith(new Error('The SSH exec channel did not start in time'));
    }, OPEN_TIMEOUT_MS);
    void this.opened.then(
      () => clearTimeout(openTimer),
      () => clearTimeout(openTimer)
    );
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.sshErrors = (this.sshErrors + chunk.toString('utf8')).slice(-4096);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => this.closeWith(error));
    child.once('close', () => this.closeWith(new Error('The SSH exec channel closed')));
  }

  get open(): boolean {
    return this.state === 'open';
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  run(command: string, options: ExecChannelRunOptions): Promise<string> {
    if (this.state !== 'open' || this.retiring || !this.child.stdin.writable) {
      return Promise.reject(new ExecChannelUnavailableError());
    }
    const commandBytes = Buffer.from(command, 'utf8');
    const input = Buffer.from(options.input ?? '', 'utf8');
    if (4 + commandBytes.length + input.length > MAX_REQUEST_BYTES) {
      return Promise.reject(new ExecChannelUnavailableError('The command is too large'));
    }
    const commandLength = Buffer.alloc(4);
    commandLength.writeUInt32BE(commandBytes.length);
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const pending: PendingCommand = {
        label: options.label,
        maxBuffer: options.maxBuffer,
        stdout: [],
        stderr: [],
        stdoutBytes: 0,
        stderrBytes: 0,
        timer: setTimeout(() => {
          this.finish(id, commandError(pending, { code: null, killed: true, signal: 'SIGTERM' }));
          this.cancel(id);
        }, options.timeout),
        resolve,
        reject,
      };
      this.pending.set(id, pending);
      this.child.stdin.write(frame(EXEC, id, Buffer.concat([commandLength, commandBytes, input])));
    });
  }

  /** Takes no more commands and closes once the ones it runs finished. */
  retire(): void {
    this.retiring = true;
    if (!this.busy) this.close();
  }

  /** Lets the host stop its commands and the ssh process exit, then makes sure it did. */
  close(): void {
    if (this.state === 'closed') return;
    this.child.stdin.end();
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    }, CLOSE_GRACE_MS).unref();
  }

  private cancel(id: number): void {
    if (this.state === 'open') this.child.stdin.write(frame(CANCEL, id));
  }

  private finish(id: number, result: Error | string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (typeof result === 'string') pending.resolve(result);
    else pending.reject(result);
    if (this.retiring && !this.busy) this.close();
  }

  private receive(chunk: Buffer): void {
    this.unread = this.unread.length === 0 ? chunk : Buffer.concat([this.unread, chunk]);
    while (this.unread.length >= 4) {
      const length = this.unread.readUInt32BE(0);
      if (length < HEADER_BYTES || length > MAX_REPLY_BYTES) {
        this.failProtocol(`The SSH exec channel sent a frame of ${length} bytes`);
        return;
      }
      if (this.unread.length < 4 + length) return;
      const kind = this.unread.readUInt8(4);
      const id = this.unread.readUInt32BE(5);
      const payload = this.unread.subarray(4 + HEADER_BYTES, 4 + length);
      this.unread = this.unread.subarray(4 + length);
      this.handle(kind, id, payload);
      if (this.state === 'closed') return;
    }
  }

  private handle(kind: number, id: number, payload: Buffer): void {
    if (kind === READY) {
      const version = payload.length >= 4 ? payload.readUInt32BE(0) : undefined;
      if (this.state !== 'opening') return;
      if (version !== EXEC_CHANNEL_PROTOCOL_VERSION) {
        this.failProtocol(`The SSH exec channel speaks protocol ${version ?? 'unknown'}`);
        return;
      }
      this.state = 'open';
      this.markOpened();
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    if (kind === STDOUT || kind === STDERR) {
      this.receiveOutput(id, pending, kind === STDOUT ? 'stdout' : 'stderr', payload);
    } else if (kind === EXIT) {
      if (payload.length !== 4) {
        this.failProtocol(`The SSH exec channel sent an exit status of ${payload.length} bytes`);
        return;
      }
      const code = payload.readInt32BE(0);
      this.finish(
        id,
        code === 0
          ? Buffer.concat(pending.stdout).toString('utf8')
          : commandError(pending, { code, killed: false, signal: null })
      );
    }
  }

  private receiveOutput(
    id: number,
    pending: PendingCommand,
    stream: 'stdout' | 'stderr',
    payload: Buffer
  ): void {
    // Copied, so a kept chunk doesn't hold on to the whole read buffer.
    pending[stream].push(Buffer.from(payload));
    if (stream === 'stdout') pending.stdoutBytes += payload.length;
    else pending.stderrBytes += payload.length;
    if (pending.stdoutBytes > pending.maxBuffer || pending.stderrBytes > pending.maxBuffer) {
      this.finish(
        id,
        commandError(
          pending,
          { code: OUTPUT_LIMIT_CODE, killed: false, signal: null },
          `${stream} maxBuffer length exceeded`
        )
      );
      this.cancel(id);
    }
  }

  private failProtocol(message: string): void {
    this.closeWith(new ExecChannelProtocolError(message));
    this.child.kill();
  }

  /**
   * Commands already sent may have run, so they fail as a dropped ssh connection does, with
   * ssh's exit code 255, instead of running again some other way.
   */
  private closeWith(error: Error): void {
    if (this.state === 'closed') return;
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    // ssh's own errors tell why it couldn't open, such as a login that needs a passphrase.
    Object.assign(error, { stderr: this.sshErrors });
    this.failOpen(error);
    const lastSshError = this.sshErrors.trim().split('\n').pop()?.trim();
    for (const [id, pending] of this.pending) {
      pending.stderr.push(Buffer.from(`${lastSshError || error.message}\n`));
      this.finish(id, commandError(pending, { code: 255, killed: false, signal: null }));
    }
    if (!wasOpen) {
      logger.debug('SSH exec channel did not open', { error, sshError: lastSshError });
    }
    this.onClose(error, wasOpen);
  }
}

/** Commands for each SSH connection lane take that lane's channel. */
export type ExecChannelLane = SshRunPurpose['kind'];

export interface ExecChannelStarter {
  /** Starts a lane's channel over its shared connection, or nothing when it can't now. */
  start(
    host: SshHost,
    executable: string,
    lane: ExecChannelLane
  ): Promise<ChildProcessWithoutNullStreams | undefined>;
  /** A channel didn't open; the error carries ssh's stderr. */
  failedToOpen(host: SshHost, error: Error): void;
}

interface Lane {
  channel?: SshExecChannel;
  starting: boolean;
  idleTimer?: NodeJS.Timeout;
  retryAt: number;
}

interface HostEntry {
  connectionKey: string;
  executable: string;
  lanes: Map<ExecChannelLane, Lane>;
}

/**
 * The SSH Exec Channels of each host whose companion is installed, one per connection lane, so
 * interactive commands don't wait behind background transfers. A command takes its lane's
 * channel only once it is open; until then, and whenever it can't, it runs as its own ssh exec.
 */
export class SshExecChannels {
  private readonly entries = new Map<string, HostEntry>();

  constructor(
    private readonly starter: ExecChannelStarter,
    private readonly enabled = process.env.KOMLA_SSH_EXEC_CHANNEL !== '0'
  ) {}

  /** Notes the companion executable on a host, which runs its channels, and opens one. */
  use(host: SshHost, connectionKey: string, executable: string): void {
    if (!this.enabled) return;
    const entry = this.entries.get(host.id);
    // Any companion this app installed runs a channel, so one from another base path will do.
    if (entry?.connectionKey === connectionKey) return;
    if (entry) this.forget(host.id);
    this.entries.set(host.id, { connectionKey, executable, lanes: new Map() });
    this.get(host, connectionKey, 'background');
  }

  /** The lane's open channel, if any. Asking opens one when none is open or opening. */
  get(host: SshHost, connectionKey: string, laneKind: ExecChannelLane): SshExecChannel | undefined {
    const entry = this.entries.get(host.id);
    if (!entry) return undefined;
    if (entry.connectionKey !== connectionKey) {
      // The host changed; its companion is found again before a channel uses it.
      this.forget(host.id);
      return undefined;
    }
    let lane = entry.lanes.get(laneKind);
    if (!lane) {
      lane = { starting: false, retryAt: 0 };
      entry.lanes.set(laneKind, lane);
    }
    if (lane.channel?.open) {
      this.keepAlive(lane);
      return lane.channel;
    }
    if (!lane.channel && !lane.starting && Date.now() >= lane.retryAt) {
      void this.openChannel(host, entry, laneKind, lane);
    }
    return undefined;
  }

  /** Lets the host's channels finish the commands they run, then closes them. */
  forget(hostId: string): void {
    const entry = this.entries.get(hostId);
    if (!entry) return;
    this.entries.delete(hostId);
    for (const lane of entry.lanes.values()) {
      clearTimeout(lane.idleTimer);
      lane.channel?.retire();
    }
  }

  private async openChannel(
    host: SshHost,
    entry: HostEntry,
    laneKind: ExecChannelLane,
    lane: Lane
  ): Promise<void> {
    lane.starting = true;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = await this.starter.start(host, entry.executable, laneKind);
    } catch (error) {
      lane.retryAt = Date.now() + EXEC_CHANNEL_RETRY_MS;
      logger.debug('Could not start an SSH exec channel', { hostId: host.id, error });
      return;
    } finally {
      lane.starting = false;
    }
    if (!child) {
      lane.retryAt = Date.now() + EXEC_CHANNEL_CONNECTION_RETRY_MS;
      return;
    }
    if (this.entries.get(host.id) !== entry) {
      new SshExecChannel(child).close();
      return;
    }
    const channel: SshExecChannel = new SshExecChannel(child, (error, wasOpen) => {
      if (lane.channel !== channel) return;
      lane.channel = undefined;
      clearTimeout(lane.idleTimer);
      if (error instanceof ExecChannelProtocolError) {
        lane.retryAt = Number.POSITIVE_INFINITY;
      } else if (!wasOpen) {
        lane.retryAt = Date.now() + EXEC_CHANNEL_RETRY_MS;
        this.starter.failedToOpen(host, error);
      }
    });
    lane.channel = channel;
    channel.opened.then(
      () => {
        logger.info('Opened an SSH exec channel', { hostId: host.id, lane: laneKind });
        this.keepAlive(lane);
      },
      (error: unknown) => {
        logger.info('Running SSH commands without an exec channel for now', {
          hostId: host.id,
          lane: laneKind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
  }

  private keepAlive(lane: Lane): void {
    clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      const channel = lane.channel;
      if (!channel) return;
      if (channel.busy) this.keepAlive(lane);
      else channel.close();
    }, EXEC_CHANNEL_IDLE_MS);
    lane.idleTimer.unref();
  }
}
