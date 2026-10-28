import { execFile, spawn } from 'child_process';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { promisify } from 'util';

import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { createLogger } from '../lib/logger';
import { applySshAskpassEnv, buildSshEnv, needsSshPrompt, sshTarget } from '../lib/ssh-client';

import { askpassService } from './askpass.service';
import { ExecChannelUnavailableError, SshExecChannels } from './ssh-connection/exec-channel';
import {
  SSH_CONTROL_PERSIST_SECONDS,
  isSshMultiplexedSessionFailure,
  sshArgs,
  sshControlArgs,
  sshControlPath,
  sshOptionArgs,
} from './ssh-connection/policy';
import { SshTerminalPool } from './ssh-connection/terminal-pool';
import { isSshTimeout, sshHostStatusService } from './ssh-host-status.service';

import type { SshHost, SshHostStatus } from '../../shared/types';
import type { SshTerminalPoolAssignment } from '../lib/terminal-control';
import type { ExecChannelLane } from './ssh-connection/exec-channel';
import type { SshConnectionPurpose, SshRunPurpose } from './ssh-connection/policy';
import type { ChildProcessWithoutNullStreams } from 'child_process';

const execFileAsync = promisify(execFile);
const logger = createLogger('SshConnectionService');
const SSH_TIMEOUT_MS = 120_000;
const SSH_QUEUE_TIMEOUT_MS = 30_000;
const SSH_MAX_BUFFER = 10 * 1024 * 1024;
const SSH_MAX_CONCURRENT_RUNS = 4;
const SSH_MAX_CONCURRENT_BACKGROUND_RUNS = SSH_MAX_CONCURRENT_RUNS - 1;
// Long enough for a slow login, short enough that Check answers soon.
const SSH_HOST_CHECK_TIMEOUT_MS = 15_000;
// `ssh -G` only reads the config, though a `Match exec` there runs a command.
const SSH_CONFIG_CHECK_TIMEOUT_MS = 10_000;
// A terminal waits this long for a host that doesn't answer, instead of the minutes TCP gives up
// after when the network drops its packets. Git's ssh waits as long.
const SSH_TERMINAL_CONNECT_TIMEOUT_SECONDS = 15;

const BACKGROUND_PURPOSE = { kind: 'background' } as const;
const INTERACTIVE_PURPOSE = { kind: 'interactive' } as const;
const FIRST_TERMINAL_PURPOSE = { kind: 'terminal', poolIndex: 0 } as const;

/** Prints the options ssh would connect to a host with, without connecting. */
function sshConfigArgs(host: SshHost): string[] {
  return [...sshOptionArgs(host), '-G', sshTarget(host)];
}

export interface SshRunOptions {
  purpose?: SshRunPurpose;
  timeout?: number;
  /**
   * False keeps ssh from asking for a password, passphrase or new host key, for reads nobody
   * asked for; one that needs them fails instead. True by default.
   */
  prompt?: boolean;
}

export interface SshInputRunOptions {
  purpose?: SshRunPurpose;
  timeout?: number;
  multiplex?: boolean;
}

export interface SshStreamingRunOptions {
  signal?: AbortSignal;
  onData?: (data: string) => void;
  onErrorData?: (data: string) => void;
  workspaceId?: string;
}

export interface SshRsyncTransport {
  remoteTarget: string;
  remoteShell: string;
}

/** What `ssh -G` shows ssh connects to a host with. */
interface SshConfigFacts {
  forwardsAgent: boolean;
  /** The host's arguments or ~/.ssh/config set ConnectTimeout, which an -o would override. */
  setsConnectTimeout: boolean;
}

interface RunSlots {
  active: number;
  activeBackground: number;
  interactiveWaiters: Array<() => void>;
  backgroundWaiters: Array<() => void>;
}

class SshConnectionService {
  private runSlots = new Map<string, RunSlots>();
  private terminalPool = new SshTerminalPool();
  private readonly hostChecks = new Map<string, Promise<SshHostStatus | undefined>>();
  private readonly warmUps = new Map<string, Promise<void>>();
  private readonly sshConfigs = new Map<string, SshConfigFacts>();
  private readonly sshConfigChecks = new Map<string, Promise<SshConfigFacts | undefined>>();
  // Hosts whose login asked for something, which a warm-up can only turn away.
  private readonly promptingHosts = new Set<string>();
  private readonly execChannels = new SshExecChannels({
    start: (host, executable, lane) => this.startExecChannel(host, executable, lane),
    failedToOpen: (host, error) => {
      // A channel starts in batch mode, so it never asks; trying again would only fail to log in.
      if (needsSshPrompt(error)) this.promptingHosts.add(JSON.stringify(sshConfigArgs(host)));
    },
  });

  /** Whether Komla already holds a background connection to `host`. Never logs in. */
  async hasOpenConnection(host: SshHost): Promise<boolean> {
    const controlPath = sshControlPath(host, BACKGROUND_PURPOSE);
    if (!controlPath) return false;
    try {
      await execFileAsync(
        'ssh',
        ['-o', `ControlPath=${controlPath}`, '-O', 'check', sshTarget(host)],
        {
          timeout: 5_000,
          env: buildSshEnv(askpassService),
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  getRsyncTransport(host: SshHost): SshRsyncTransport {
    const args = sshOptionArgs(host);
    const controlPath = sshControlPath(host, BACKGROUND_PURPOSE);
    if (controlPath) {
      args.push(...sshControlArgs(controlPath, true, SSH_CONTROL_PERSIST_SECONDS));
    }
    const hostname = host.hostname.includes(':') ? `[${host.hostname}]` : host.hostname;
    return {
      remoteTarget: host.user ? `${host.user}@${hostname}` : hostname,
      remoteShell: ['ssh', ...args].map(shellQuotePosix).join(' '),
    };
  }

  async run(
    host: SshHost,
    remoteCommand: string,
    timeoutOrOptions: number | SshRunOptions = SSH_TIMEOUT_MS
  ): Promise<string> {
    const options =
      typeof timeoutOrOptions === 'number'
        ? { timeout: timeoutOrOptions, purpose: BACKGROUND_PURPOSE }
        : {
            timeout: timeoutOrOptions.timeout ?? SSH_TIMEOUT_MS,
            purpose: timeoutOrOptions.purpose ?? BACKGROUND_PURPOSE,
            prompt: timeoutOrOptions.prompt,
          };
    const prompt = options.prompt !== false;
    const release = await this.acquireRunSlot(host, options.purpose);
    try {
      return await this.tracked(
        host,
        this.runNow(host, remoteCommand, options.timeout, options.purpose, prompt),
        prompt
      );
    } finally {
      release();
    }
  }

  runStreaming(
    host: SshHost,
    remoteCommand: string,
    options: SshStreamingRunOptions = {}
  ): Promise<number> {
    return this.tracked(host, this.runStreamingWithRetry(host, remoteCommand, options));
  }

  private async runStreamingWithRetry(
    host: SshHost,
    remoteCommand: string,
    options: SshStreamingRunOptions
  ): Promise<number> {
    const purpose: SshConnectionPurpose = options.workspaceId
      ? { kind: 'workspace-stream', workspaceId: options.workspaceId }
      : BACKGROUND_PURPOSE;
    const release = await this.acquireRunSlot(host, BACKGROUND_PURPOSE, options.signal);
    try {
      options.signal?.throwIfAborted();
      const shellCommand = `sh -lc ${shellQuotePosix(remoteCommand)}`;
      const run = this.runStreamingNow(host, shellCommand, options, purpose, true);
      // A streaming Setup process may be long-lived; only hold the shared slot while launching it.
      release();
      try {
        return await run;
      } catch (error) {
        if (!sshControlPath(host, purpose) || !isSshMultiplexedSessionFailure(error)) throw error;
        logger.debug('retrying streaming SSH command without multiplexing', {
          hostId: host.id,
          purpose: purpose.kind,
        });
        return await this.runStreamingNow(host, shellCommand, options, purpose, false);
      }
    } finally {
      release();
    }
  }

  async runWithFileInput(
    host: SshHost,
    remoteCommand: string,
    sourcePath: string,
    options: SshInputRunOptions = {}
  ): Promise<string> {
    return await this.tracked(
      host,
      this.runWithInputSource(host, remoteCommand, () => createReadStream(sourcePath), options)
    );
  }

  runWithInput(
    host: SshHost,
    remoteCommand: string,
    input: string,
    options: SshInputRunOptions = {}
  ): Promise<string> {
    return this.tracked(host, this.runWithStringInput(host, remoteCommand, input, options));
  }

  private async runWithStringInput(
    host: SshHost,
    remoteCommand: string,
    input: string,
    options: SshInputRunOptions
  ): Promise<string> {
    const purpose = options.purpose ?? BACKGROUND_PURPOSE;
    const multiplex = options.multiplex ?? true;
    const release = await this.acquireRunSlot(host, purpose);
    const shellCommand = `sh -lc ${shellQuotePosix(remoteCommand)}`;
    try {
      const viaChannel = multiplex
        ? await this.runThroughExecChannel(
            host,
            remoteCommand,
            purpose,
            options.timeout ?? SSH_TIMEOUT_MS,
            input
          )
        : undefined;
      if (viaChannel !== undefined) return viaChannel;
      try {
        return await this.runStringInputNow(
          host,
          shellCommand,
          input,
          purpose,
          multiplex,
          options.timeout
        );
      } catch (error) {
        if (
          !multiplex ||
          !sshControlPath(host, purpose) ||
          !isSshMultiplexedSessionFailure(error)
        ) {
          throw error;
        }
        logger.debug('retrying SSH string-input command without multiplexing', {
          hostId: host.id,
          purpose: purpose.kind,
        });
        return await this.runStringInputNow(
          host,
          shellCommand,
          input,
          purpose,
          false,
          options.timeout
        );
      }
    } finally {
      release();
    }
  }

  buildTerminalCommand(
    host: SshHost,
    terminalId: string,
    remoteCommand: string,
    reconnect: boolean
  ): string {
    // Until a check answers, the config may set a timeout, which this would override.
    const setsConnectTimeout =
      this.sshConfigs.get(JSON.stringify(sshConfigArgs(host)))?.setsConnectTimeout ?? true;
    return this.terminalPool.buildCommand(
      host,
      terminalId,
      remoteCommand,
      reconnect,
      this.terminalAskpassEnv(),
      setsConnectTimeout ? [] : ['-o', `ConnectTimeout=${SSH_TERMINAL_CONNECT_TIMEOUT_SECONDS}`]
    );
  }

  /**
   * Opens the connections workspace setup and the first terminal run on before they need them,
   * so they skip the handshake. When ssh forwards the agent, the first terminal opens its own
   * from the local shell, which decides the agent it forwards.
   */
  warmConnections(host: SshHost): void {
    void Promise.resolve()
      .then(() => {
        this.warmConnection(host, INTERACTIVE_PURPOSE);
        return this.checkSshConfig(host);
      })
      .then((config) => {
        if (!this.forwardsAgentWith(host, config)) {
          this.warmConnection(host, FIRST_TERMINAL_PURPOSE);
        }
      })
      .catch((error: unknown) =>
        logger.debug('Could not open an SSH connection ahead of time', { hostId: host.id, error })
      );
  }

  /**
   * Whether ssh forwards the local agent to a host, through the toggle, extra arguments or
   * ~/.ssh/config. Answers from the last check and starts another; until one has answered, it
   * assumes ssh does.
   */
  forwardsAgent(host: SshHost): boolean {
    void this.checkSshConfig(host);
    return this.forwardsAgentWith(host, this.sshConfigs.get(JSON.stringify(sshConfigArgs(host))));
  }

  /** Reads the options ssh connects to a host with ahead of its first terminal. */
  readConfig(host: SshHost): void {
    void this.checkSshConfig(host);
  }

  // Windows terminals start in the local shell whatever the config says.
  private forwardsAgentWith(host: SshHost, config: SshConfigFacts | undefined): boolean {
    return host.forwardAgent || process.platform === 'win32' || (config?.forwardsAgent ?? true);
  }

  private checkSshConfig(host: SshHost): Promise<SshConfigFacts | undefined> {
    const args = sshConfigArgs(host);
    const key = JSON.stringify(args);
    const running = this.sshConfigChecks.get(key);
    if (running) return running;
    const check = execFileAsync('ssh', args, { timeout: SSH_CONFIG_CHECK_TIMEOUT_MS })
      .then(
        ({ stdout }) => {
          const config = {
            forwardsAgent: !/^forwardagent no\r?$/m.test(stdout),
            setsConnectTimeout: !/^connecttimeout none\r?$/m.test(stdout),
          };
          this.sshConfigs.set(key, config);
          return config;
        },
        () => {
          // An earlier answer may no longer hold, so assume the safe one until a check succeeds.
          this.sshConfigs.delete(key);
          return undefined;
        }
      )
      .finally(() => this.sshConfigChecks.delete(key));
    this.sshConfigChecks.set(key, check);
    return check;
  }

  /**
   * Does nothing where connections aren't shared, for a host whose login asked for something, or
   * while one is open or opening.
   */
  private warmConnection(host: SshHost, purpose: SshConnectionPurpose): void {
    const hostKey = JSON.stringify(sshConfigArgs(host));
    const controlPath = sshControlPath(host, purpose);
    if (!controlPath || this.warmUps.has(controlPath) || this.promptingHosts.has(hostKey)) return;
    // Batch mode leaves a password, one-time code or new host key to the command that needs the
    // connection, so warming up never adds a dialog. It doesn't reach the ssh a ProxyJump starts,
    // which the environment keeps from asking.
    const options = {
      timeout: SSH_TIMEOUT_MS,
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
    };
    const target = sshTarget(host);
    const warmUp = execFileAsync(
      'ssh',
      [...sshOptionArgs(host), ...sshControlArgs(controlPath, false, 0), '-O', 'check', target],
      options
    )
      .catch(() =>
        execFileAsync('ssh', ['-o', 'BatchMode=yes', ...sshArgs(host, 'true', purpose)], options)
      )
      .then(
        () => undefined,
        (error: unknown) => {
          // Trying again would only add a failed login to the host's log on every create.
          if (needsSshPrompt(error)) {
            this.promptingHosts.add(hostKey);
          }
          logger.debug('Could not open an SSH connection ahead of time', {
            hostId: host.id,
            purpose: purpose.kind,
            error,
          });
        }
      )
      .finally(() => this.warmUps.delete(controlPath));
    this.warmUps.set(controlPath, warmUp);
  }

  // Send the terminal's ssh prompts to Komla's dialog like other SSH connections, so a
  // remembered passphrase answers them. SSH_ASKPASS_REQUIRE=force needs no DISPLAY,
  // which would break X11 forwarding. Windows terminals keep prompting in the terminal.
  private terminalAskpassEnv(): NodeJS.ProcessEnv {
    const askpassEnv: NodeJS.ProcessEnv = {};
    if (process.platform !== 'win32' && applySshAskpassEnv(askpassEnv, askpassService)) {
      delete askpassEnv.DISPLAY;
    }
    return askpassEnv;
  }

  recordTerminalPoolAssignment(terminalId: string, assignment: SshTerminalPoolAssignment): void {
    this.terminalPool.recordAssignment(terminalId, assignment);
  }

  releaseTerminalPoolAssignment(terminalId: string): void {
    this.terminalPool.releaseAssignment(terminalId);
  }

  /**
   * Notes whether the host answered, for the status bar. A run that couldn't ask for a password
   * learns nothing about the host from needing one.
   */
  private async tracked<T>(host: SshHost, run: Promise<T>, prompt = true): Promise<T> {
    try {
      const result = await run;
      sshHostStatusService.reached(host.id);
      return result;
    } catch (error) {
      if (!prompt && needsSshPrompt(error)) throw error;
      // A slow command and a host that doesn't answer both time out; a quick command tells them
      // apart.
      if (isSshTimeout(error)) void this.checkHost(host);
      else sshHostStatusService.failed(host.id, error);
      throw error;
    }
  }

  /** Runs a quick command on the host to learn whether it answers, for the status bar. */
  checkHost(host: SshHost): Promise<SshHostStatus | undefined> {
    const pending = this.hostChecks.get(host.id);
    if (pending) return pending;
    const check = (async () => {
      try {
        const release = await this.acquireRunSlot(host, INTERACTIVE_PURPOSE);
        try {
          await this.runNow(host, 'true', SSH_HOST_CHECK_TIMEOUT_MS, INTERACTIVE_PURPOSE);
          sshHostStatusService.reached(host.id);
        } finally {
          release();
        }
      } catch (error) {
        sshHostStatusService.failed(host.id, error);
      }
      return sshHostStatusService.get(host.id);
    })().finally(() => this.hostChecks.delete(host.id));
    this.hostChecks.set(host.id, check);
    return check;
  }

  private hostConnectionKey(host: SshHost): string {
    return JSON.stringify([
      host.hostname,
      host.user,
      host.port,
      host.identityFile,
      host.extraSshArgs,
    ]);
  }

  private async acquireRunSlot(
    host: SshHost,
    purpose: SshRunPurpose,
    signal?: AbortSignal
  ): Promise<() => void> {
    signal?.throwIfAborted();
    const connectionKey = this.hostConnectionKey(host);
    let slots = this.runSlots.get(connectionKey);
    if (!slots) {
      slots = {
        active: 0,
        activeBackground: 0,
        interactiveWaiters: [],
        backgroundWaiters: [],
      };
      this.runSlots.set(connectionKey, slots);
    }
    const interactive = purpose.kind === 'interactive';
    const canStart =
      slots.active < SSH_MAX_CONCURRENT_RUNS &&
      (interactive || slots.activeBackground < SSH_MAX_CONCURRENT_BACKGROUND_RUNS);
    if (canStart) {
      slots.active += 1;
      if (!interactive) slots.activeBackground += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiters = interactive ? slots.interactiveWaiters : slots.backgroundWaiters;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        const start = () => {
          cleanup();
          resolve();
        };
        const fail = (error: unknown) => {
          const index = waiters.indexOf(start);
          if (index < 0) return;
          waiters.splice(index, 1);
          cleanup();
          reject(error);
        };
        const abort = () => fail(signal?.reason);
        const timer = setTimeout(
          () =>
            fail(
              new Error(
                'Timed out waiting for an SSH command slot. The command was not started; try again.'
              )
            ),
          SSH_QUEUE_TIMEOUT_MS
        );
        waiters.push(start);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      slots.active -= 1;
      if (!interactive) slots.activeBackground -= 1;

      const interactiveWaiter = slots.interactiveWaiters.shift();
      if (interactiveWaiter && slots.active < SSH_MAX_CONCURRENT_RUNS) {
        slots.active += 1;
        interactiveWaiter();
      } else if (
        slots.backgroundWaiters.length > 0 &&
        slots.active < SSH_MAX_CONCURRENT_RUNS &&
        slots.activeBackground < SSH_MAX_CONCURRENT_BACKGROUND_RUNS
      ) {
        slots.active += 1;
        slots.activeBackground += 1;
        slots.backgroundWaiters.shift()?.();
      }
      if (
        slots.active === 0 &&
        slots.interactiveWaiters.length === 0 &&
        slots.backgroundWaiters.length === 0
      ) {
        this.runSlots.delete(connectionKey);
      }
    };
  }

  /**
   * Runs later commands on the host through the SSH Exec Channel this companion executable
   * starts (ADR 0003), once it is open.
   */
  useExecChannel(host: SshHost, executable: string): void {
    this.execChannels.use(host, this.hostConnectionKey(host), executable);
  }

  forgetExecChannel(hostId: string): void {
    this.execChannels.forget(hostId);
  }

  /**
   * Rides the lane's shared connection once a command opened it, so it never logs in itself.
   * Where ssh can't share connections it opens its own, in batch mode, unless logging in to the
   * host asks for something.
   */
  private async startExecChannel(
    host: SshHost,
    executable: string,
    lane: ExecChannelLane
  ): Promise<ChildProcessWithoutNullStreams | undefined> {
    const purpose = lane === 'interactive' ? INTERACTIVE_PURPOSE : BACKGROUND_PURPOSE;
    const controlPath = sshControlPath(host, purpose);
    const env = { ...process.env, SSH_ASKPASS_REQUIRE: 'never' };
    if (controlPath) {
      try {
        await execFileAsync(
          'ssh',
          [
            ...sshOptionArgs(host),
            ...sshControlArgs(controlPath, false, 0),
            '-O',
            'check',
            sshTarget(host),
          ],
          { timeout: SSH_CONFIG_CHECK_TIMEOUT_MS, env }
        );
      } catch {
        return undefined;
      }
    } else if (this.promptingHosts.has(JSON.stringify(sshConfigArgs(host)))) {
      return undefined;
    }
    const remoteCommand = `${shellQuotePosix(executable)} __exec-channel`;
    const batch = ['-o', 'BatchMode=yes', ...(controlPath ? ['-o', 'ControlMaster=no'] : [])];
    return spawn('ssh', [...batch, ...sshArgs(host, remoteCommand, purpose)], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** The command's output through the lane's SSH Exec Channel, or nothing when none took it. */
  private async runThroughExecChannel(
    host: SshHost,
    remoteCommand: string,
    purpose: SshRunPurpose,
    timeout: number,
    input?: string
  ): Promise<string | undefined> {
    const channel = this.execChannels.get(host, this.hostConnectionKey(host), purpose.kind);
    if (!channel) return undefined;
    try {
      return await channel.run(remoteCommand, {
        timeout,
        maxBuffer: SSH_MAX_BUFFER,
        label: `ssh ${sshTarget(host)} sh -lc ${shellQuotePosix(remoteCommand)}`,
        input,
      });
    } catch (error) {
      if (error instanceof ExecChannelUnavailableError) return undefined;
      throw error;
    }
  }

  private async runNow(
    host: SshHost,
    remoteCommand: string,
    timeout: number,
    purpose: SshRunPurpose,
    prompt = true
  ): Promise<string> {
    const shellCommand = `sh -lc ${shellQuotePosix(remoteCommand)}`;
    const viaChannel = await this.runThroughExecChannel(host, remoteCommand, purpose, timeout);
    if (viaChannel !== undefined) return viaChannel;
    const options = {
      timeout,
      maxBuffer: SSH_MAX_BUFFER,
      // As when warming up, the environment also keeps a ProxyJump's ssh from asking.
      env: prompt
        ? buildSshEnv(askpassService)
        : { ...process.env, SSH_ASKPASS_REQUIRE: 'never' as const },
    };
    const batch = prompt ? [] : ['-o', 'BatchMode=yes'];
    try {
      const { stdout } = await execFileAsync(
        'ssh',
        [...batch, ...sshArgs(host, shellCommand, purpose)],
        options
      );
      return stdout;
    } catch (error) {
      if (!sshControlPath(host, purpose) || !isSshMultiplexedSessionFailure(error)) throw error;
      logger.debug('retrying SSH command without multiplexing', {
        hostId: host.id,
        purpose: purpose.kind,
      });
      const args = [...batch, ...this.standaloneArgs(host, shellCommand, purpose)];
      const { stdout } = await execFileAsync('ssh', args, options);
      return stdout;
    }
  }

  private runStreamingNow(
    host: SshHost,
    shellCommand: string,
    options: SshStreamingRunOptions,
    purpose: SshConnectionPurpose,
    multiplex: boolean
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const args = multiplex
        ? sshArgs(host, shellCommand, purpose)
        : this.standaloneArgs(host, shellCommand, purpose);
      const child = spawn('ssh', args, {
        env: buildSshEnv(askpassService),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const abort = () => child.kill('SIGTERM');
      if (options.signal?.aborted) abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (data: string) => options.onData?.(data));
      child.stderr?.on('data', (data: string) => {
        stderr = (stderr + data).slice(-8192);
        options.onErrorData?.(data);
      });
      child.once('error', (error) => {
        options.signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (code, signal) => {
        options.signal?.removeEventListener('abort', abort);
        if (options.signal?.aborted) {
          reject(Object.assign(new Error('SSH Setup step was stopped'), { name: 'AbortError' }));
        } else if (code === 0) {
          resolve(0);
        } else {
          reject(
            Object.assign(
              new Error(
                `SSH command exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
              ),
              { code, stderr }
            )
          );
        }
      });
    });
  }

  private async runWithInputSource(
    host: SshHost,
    remoteCommand: string,
    createInput: () => Readable,
    options: SshInputRunOptions
  ): Promise<string> {
    const purpose = options.purpose ?? BACKGROUND_PURPOSE;
    const release = await this.acquireRunSlot(host, purpose);
    const shellCommand = `sh -lc ${shellQuotePosix(remoteCommand)}`;
    try {
      try {
        return await this.runInputNow(
          host,
          shellCommand,
          createInput,
          purpose,
          true,
          options.timeout
        );
      } catch (error) {
        if (!sshControlPath(host, purpose) || !isSshMultiplexedSessionFailure(error)) throw error;
        logger.debug('retrying SSH input command without multiplexing', {
          hostId: host.id,
          purpose: purpose.kind,
        });
        return await this.runInputNow(
          host,
          shellCommand,
          createInput,
          purpose,
          false,
          options.timeout
        );
      }
    } finally {
      release();
    }
  }

  private runInputNow(
    host: SshHost,
    shellCommand: string,
    createInput: () => Readable,
    purpose: SshRunPurpose,
    multiplex: boolean,
    timeout = SSH_TIMEOUT_MS
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const input = createInput();
      const finish = (error?: Error | null, stdout = ''): void => {
        if (settled) return;
        settled = true;
        input.destroy();
        if (error) reject(error);
        else resolve(stdout);
      };
      const args = multiplex
        ? sshArgs(host, shellCommand, purpose)
        : this.standaloneArgs(host, shellCommand, purpose);
      const child = execFile(
        'ssh',
        args,
        {
          timeout,
          maxBuffer: SSH_MAX_BUFFER,
          env: buildSshEnv(askpassService),
          encoding: 'utf8',
        },
        (error, stdout) => finish(error, stdout)
      );
      input.on('error', (error) => {
        child.kill();
        finish(error);
      });
      child.stdin?.on('error', () => undefined);
      if (!child.stdin) {
        input.destroy();
        child.kill();
        finish(new Error('Could not open SSH input stream'));
        return;
      }
      input.pipe(child.stdin);
    });
  }

  private runStringInputNow(
    host: SshHost,
    shellCommand: string,
    input: string,
    purpose: SshRunPurpose,
    multiplex: boolean,
    timeout = SSH_TIMEOUT_MS
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = multiplex
        ? sshArgs(host, shellCommand, purpose)
        : this.standaloneArgs(host, shellCommand, purpose);
      const child = execFile(
        'ssh',
        args,
        {
          timeout,
          maxBuffer: SSH_MAX_BUFFER,
          env: buildSshEnv(askpassService),
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve(stdout ?? '');
        }
      );
      child.stdin?.on('error', () => undefined);
      if (!child.stdin) {
        child.kill();
        reject(new Error('Could not open SSH input stream'));
        return;
      }
      child.stdin.end(input);
    });
  }

  private standaloneArgs(
    host: SshHost,
    shellCommand: string,
    purpose: SshConnectionPurpose
  ): string[] {
    const args = sshArgs(host, undefined, purpose, { multiplex: false });
    args.splice(args.length - 1, 0, '-o', 'ControlPath=none');
    args.push(shellCommand);
    return args;
  }
}

export const sshConnectionService = new SshConnectionService();

export type { SshRunPurpose } from './ssh-connection/policy';
