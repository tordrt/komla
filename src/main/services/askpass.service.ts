import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, chmodSync, existsSync, mkdirSync, statSync } from 'fs';
import { createServer, Server, Socket } from 'net';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';

import { app, BrowserWindow, ipcMain } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { askpassResponseArgsSchema } from '../ipc/validation/askpass-ipc.schemas';
import { onValidated } from '../ipc/validation/ipc-validators';
import { createLogger } from '../lib/logger';
import { opensshMarksServerPrompts, sshKeyPathFromPrompt } from '../lib/ssh-askpass-prompt';
import { sshAskpassVars } from '../lib/ssh-client';

import { askpassHelperScript } from './askpass-helper-script';

import type { AskpassRequest } from '../../shared/types';

const execFileAsync = promisify(execFile);
const logger = createLogger('AskpassService');

// Timeout for passphrase dialog (2 minutes)
const DIALOG_TIMEOUT_MS = 2 * 60 * 1000;

// Komla spawns ssh and git right after issuing a session, so a session only needs to
// outlive connecting and the dialog.
const SESSION_TTL_MS = 10 * 60 * 1000;
const SSH_COMMAND_TIMEOUT_MS = 30_000;

interface RememberedPassphrase {
  passphrase: string;
  keyPath: string;
  /** The key file's mtime and size when ssh-keygen accepted the passphrase. */
  mtimeMs: number;
  size: number;
  /** Sessions already answered with this passphrase. */
  answeredSessions: Set<string>;
}

interface IssuedSession {
  expiresAt: number;
  /** Whether the process runs the `ssh` on PATH, the one `ssh -V` checks. */
  usesPathSsh?: () => Promise<boolean>;
}

interface PendingRequest {
  prompt: string;
  canRemember: boolean;
  sockets: Socket[];
  timeoutId: NodeJS.Timeout;
  window: BrowserWindow;
}

/**
 * Service that handles SSH_ASKPASS requests from git operations.
 *
 * When a background git operation (fetch, push, pull, clone) encounters an SSH key
 * that requires a passphrase, this service:
 * 1. Provides a helper script that git spawns via SSH_ASKPASS
 * 2. Listens on a Unix socket for passphrase requests from the helper
 * 3. Shows a native dialog via IPC to the renderer
 * 4. Returns the passphrase to the helper script
 *
 * When the user asks to remember an SSH key passphrase, Komla checks it with
 * `ssh-keygen -y` and then answers later prompts for that key from memory until Komla
 * quits, checking it again when the key file changes. Only processes Komla spawned with an issued session
 * (and their children, such as git hooks) get remembered answers or share a dialog, and
 * only when the ssh they run marks prompts that come from the server.
 */
class AskpassService {
  private socketPath: string | null = null;
  private server: Server | null = null;
  private helperScriptPath: string | null = null;
  /** Platform-specific wrapper (.sh or .cmd) that invokes the .js helper via Electron's bundled Node runtime. */
  private helperWrapperPath: string | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  /** Keyed by prompt; resolves to null when ssh-keygen rejects the passphrase. */
  private rememberedPassphrases = new Map<string, Promise<RememberedPassphrase | null>>();
  private sessions = new Map<string, IssuedSession>();
  /** Single-use KOMLA_ASKPASS_SESSION tokens for ssh-keygen, mapped to the passphrase to check. */
  private verifications = new Map<string, string>();
  private sshMarksServerPrompts: Promise<boolean> | null = null;
  private isStarted = false;
  private askpassResponseListener = onValidated(
    IPC.ASKPASS_RESPONSE,
    askpassResponseArgsSchema,
    this.handleAskpassResponse.bind(this)
  );

  /**
   * Start the askpass service.
   * Creates a Unix socket and helper script for SSH_ASKPASS.
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    // Generate unique socket path
    const socketId = randomUUID();
    this.socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\komla-askpass-${socketId}`
        : join(tmpdir(), `komla-askpass-${socketId}.sock`);

    // os.tmpdir() reads $TMPDIR, which can point at a stale/missing directory
    // (e.g. backup tools that export TMPDIR=/tmp/backup.XXXXXX into the launch
    // env). Ensure it exists before writing helper scripts or binding the socket.
    mkdirSync(tmpdir(), { recursive: true });

    // Create the helper script
    this.helperScriptPath = join(tmpdir(), `komla-askpass-${socketId}.js`);
    this.createHelperScript();

    // Create and start the server
    await this.createServer();

    // Register IPC handler for responses from renderer
    ipcMain.on(IPC.ASKPASS_RESPONSE, this.askpassResponseListener);

    this.isStarted = true;
    logger.info('Askpass service started', { socketPath: this.socketPath });
  }

  /**
   * Stop the askpass service and clean up resources.
   */
  stop(): void {
    if (!this.isStarted) {
      return;
    }

    // Remove IPC handler
    ipcMain.removeListener(IPC.ASKPASS_RESPONSE, this.askpassResponseListener);

    // Clear all pending requests
    for (const id of this.pendingRequests.keys()) {
      this.resolveRequest(id, null);
    }
    this.rememberedPassphrases.clear();
    this.sessions.clear();
    this.verifications.clear();
    this.sshMarksServerPrompts = null;

    // Close the server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file (Unix only)
    if (this.socketPath && process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clean up helper scripts
    for (const path of [this.helperScriptPath, this.helperWrapperPath]) {
      if (path && existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    this.socketPath = null;
    this.helperScriptPath = null;
    this.helperWrapperPath = null;
    this.isStarted = false;

    logger.info('Askpass service stopped');
  }

  /**
   * Get the socket path for environment variable.
   */
  getSocketPath(): string | null {
    return this.socketPath;
  }

  /**
   * Get the path to use for SSH_ASKPASS.
   * Returns the platform-specific wrapper (.sh on Unix, .cmd on Windows)
   * that invokes the .js helper via ELECTRON_RUN_AS_NODE.
   */
  getHelperScriptPath(): string | null {
    return this.helperWrapperPath ?? this.helperScriptPath;
  }

  /**
   * Issue a session ID for one spawned SSH or git process, passed to it as
   * KOMLA_ASKPASS_SESSION. Only prompts that carry an issued session get remembered
   * passphrases. Pass `usesPathSsh` when the process may run another ssh than the one on
   * PATH, such as git.
   */
  issueSession(usesPathSsh?: () => Promise<boolean>): string {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    const id = randomUUID();
    this.sessions.set(id, { expiresAt: now + SESSION_TTL_MS, usesPathSsh });
    return id;
  }

  /**
   * Check if the service is running.
   */
  isRunning(): boolean {
    return this.isStarted;
  }

  /**
   * Create the helper script that git spawns via SSH_ASKPASS.
   * This script connects to our socket and relays the passphrase request.
   */
  private createHelperScript(): void {
    if (!this.helperScriptPath || !this.socketPath) {
      throw new Error('Socket path not initialized');
    }

    const helperScript = askpassHelperScript(this.socketPath);

    writeFileSync(this.helperScriptPath, helperScript, { encoding: 'utf-8' });

    // SSH_ASKPASS must point to a directly executable file. We create a
    // platform-specific wrapper that uses Electron's bundled Node runtime
    // (via ELECTRON_RUN_AS_NODE) so users don't need a separate Node install.
    const electronPath = app.isPackaged ? process.execPath : process.argv[0];
    const jsBasename = basename(this.helperScriptPath);

    if (process.platform === 'win32') {
      this.helperWrapperPath = this.helperScriptPath.replace(/\.js$/, '.cmd');
      const cmdScript = `@set ELECTRON_RUN_AS_NODE=1\r\n@"${electronPath}" "%~dp0${jsBasename}" %*\r\n`;
      writeFileSync(this.helperWrapperPath, cmdScript, { encoding: 'utf-8' });
      logger.debug('Created helper scripts (Windows)', {
        js: this.helperScriptPath,
        cmd: this.helperWrapperPath,
      });
    } else {
      this.helperWrapperPath = this.helperScriptPath.replace(/\.js$/, '.sh');
      const shScript = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electronPath}" "$(dirname "$0")/${jsBasename}" "$@"\n`;
      writeFileSync(this.helperWrapperPath, shScript, { encoding: 'utf-8' });
      chmodSync(this.helperWrapperPath, 0o700);
      logger.debug('Created helper scripts (Unix)', {
        js: this.helperScriptPath,
        sh: this.helperWrapperPath,
      });
    }
  }

  /**
   * Create the Unix socket server.
   */
  private createServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socketPath) {
        reject(new Error('Socket path not initialized'));
        return;
      }

      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        logger.error('Socket server error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Set restrictive permissions on the socket (Unix only)
        if (process.platform !== 'win32' && this.socketPath) {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            // Ignore permission errors
          }
        }
        resolve();
      });
    });
  }

  /**
   * Handle a new connection from the helper script.
   */
  private handleConnection(socket: Socket): void {
    let data = '';

    socket.on('data', (chunk) => {
      data += chunk.toString();
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex !== -1) {
        const message = data.slice(0, newlineIndex);
        data = data.slice(newlineIndex + 1);

        try {
          const { id, prompt, session } = JSON.parse(message);
          if (typeof id !== 'string' || typeof prompt !== 'string') {
            throw new Error('Malformed askpass request');
          }
          const verifying = typeof session === 'string' && this.verifications.get(session);
          if (typeof verifying === 'string') {
            this.verifications.delete(session);
            this.answer(socket, verifying);
            return;
          }
          const trustedSession =
            typeof session === 'string' && (this.sessions.get(session)?.expiresAt ?? 0) > Date.now()
              ? session
              : null;
          this.handlePassphraseRequest(id, prompt, socket, trustedSession).catch((err: unknown) => {
            logger.error('Failed to handle askpass request', err);
            this.answer(socket, null);
          });
        } catch (err) {
          logger.error('Failed to parse askpass request', err);
          socket.write(JSON.stringify({ passphrase: null }) + '\n');
          socket.end();
        }
      }
    });

    socket.on('error', (err) => {
      logger.error('Socket connection error', err);
    });

    socket.on('close', () => {
      this.dropSocket(socket);
    });
  }

  /**
   * Handle a passphrase request from the helper script.
   */
  private async handlePassphraseRequest(
    id: string,
    prompt: string,
    socket: Socket,
    session: string | null
  ): Promise<void> {
    logger.debug('Received passphrase request', { id, prompt });

    const canRemember =
      session !== null &&
      sshKeyPathFromPrompt(prompt) !== null &&
      (await this.sessionUsesPathSsh(session)) &&
      (await this.checkSshMarksServerPrompts());
    if (canRemember && session !== null) {
      const remembered = await this.rememberedPassphrase(prompt, session);
      if (remembered) {
        remembered.answeredSessions.add(session);
        this.answer(socket, remembered.passphrase);
        logger.debug('Answered passphrase request from memory', { id });
        return;
      }
    }

    // The helper gave up, or the service stopped, while Komla was checking
    if (socket.destroyed) return;
    if (!this.isStarted) {
      this.answer(socket, null);
      return;
    }

    if (canRemember) {
      // Concurrent connections that need the same key share one dialog and its deadline
      for (const pending of this.pendingRequests.values()) {
        if (pending.canRemember && pending.prompt === prompt) {
          pending.sockets.push(socket);
          return;
        }
      }
    }

    const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!window) {
      logger.warn('No windows available for passphrase dialog');
      this.answer(socket, null);
      return;
    }

    const timeoutId = setTimeout(() => {
      if (this.pendingRequests.has(id)) {
        logger.warn('Passphrase request timed out', { id });
        this.resolveRequest(id, null);
      }
    }, DIALOG_TIMEOUT_MS);
    this.pendingRequests.set(id, { prompt, canRemember, sockets: [socket], timeoutId, window });

    const request: AskpassRequest = {
      id,
      prompt,
      canRemember,
      expiresAt: Date.now() + DIALOG_TIMEOUT_MS,
    };
    window.webContents.send(IPC.ASKPASS_REQUEST, request);
    window.focus();
  }

  /**
   * Forget a helper that went away, ending its request once no helper waits for it.
   */
  private dropSocket(socket: Socket): void {
    for (const [id, pending] of this.pendingRequests) {
      const index = pending.sockets.indexOf(socket);
      if (index === -1) continue;
      pending.sockets.splice(index, 1);
      if (pending.sockets.length === 0) {
        this.resolveRequest(id, null);
      }
    }
  }

  /**
   * Whether a session's process runs the ssh on PATH, which `ssh -V` checks.
   */
  private async sessionUsesPathSsh(session: string): Promise<boolean> {
    const usesPathSsh = this.sessions.get(session)?.usesPathSsh;
    try {
      return usesPathSsh ? await usesPathSsh() : true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the ssh on PATH marks prompts that come from the server, so a key passphrase
   * prompt can be trusted to come from ssh itself. Checked once with `ssh -V`.
   */
  private checkSshMarksServerPrompts(): Promise<boolean> {
    this.sshMarksServerPrompts ??= new Promise((resolve) => {
      execFile('ssh', ['-V'], { timeout: SSH_COMMAND_TIMEOUT_MS }, (_error, stdout, stderr) => {
        resolve(opensshMarksServerPrompts(`${stdout}${stderr}`));
      });
    });
    return this.sshMarksServerPrompts;
  }

  /**
   * The remembered passphrase for a prompt. When the key file changed, or ssh asks a
   * process again (which it does after rejecting a passphrase), Komla checks it with
   * ssh-keygen again first.
   */
  private async rememberedPassphrase(
    prompt: string,
    session: string
  ): Promise<RememberedPassphrase | null> {
    const entry = this.rememberedPassphrases.get(prompt);
    const remembered = await entry;
    if (!remembered) return null;
    if (!remembered.answeredSessions.has(session) && keyFileUnchanged(remembered)) {
      return remembered;
    }
    const current = this.rememberedPassphrases.get(prompt);
    const checked =
      current === entry ? this.rememberPassphrase(prompt, remembered.passphrase) : current;
    return (await checked) ?? null;
  }

  /**
   * Remember a passphrase once `ssh-keygen -y` confirms it unlocks the key, answering
   * ssh-keygen's own prompt through a single-use token. Resolves to null, forgetting the
   * prompt's passphrase, when it doesn't.
   */
  private rememberPassphrase(
    prompt: string,
    passphrase: string
  ): Promise<RememberedPassphrase | null> {
    const keyPath = sshKeyPathFromPrompt(prompt);
    const helperPath = this.getHelperScriptPath();
    const socketPath = this.socketPath;
    if (!keyPath || !helperPath || !socketPath) {
      this.rememberedPassphrases.delete(prompt);
      return Promise.resolve(null);
    }

    const entry = (async (): Promise<RememberedPassphrase | null> => {
      const token = randomUUID();
      this.verifications.set(token, passphrase);
      try {
        const { mtimeMs, size } = statSync(keyPath);
        await execFileAsync('ssh-keygen', ['-y', '-f', keyPath], {
          env: { ...process.env, ...sshAskpassVars(helperPath, socketPath, token) },
          timeout: SSH_COMMAND_TIMEOUT_MS,
        });
        return { passphrase, keyPath, mtimeMs, size, answeredSessions: new Set() };
      } catch {
        logger.debug('ssh-keygen did not accept the passphrase; not remembering it', { keyPath });
        return null;
      } finally {
        this.verifications.delete(token);
      }
    })();
    this.rememberedPassphrases.set(prompt, entry);
    void entry.then((remembered) => {
      if (!remembered && this.rememberedPassphrases.get(prompt) === entry) {
        this.rememberedPassphrases.delete(prompt);
      }
    });
    return entry;
  }

  /**
   * Handle response from the renderer.
   */
  private handleAskpassResponse(
    _event: Electron.IpcMainEvent,
    [response]: [{ id: string; passphrase: string | null; remember?: boolean }]
  ): void {
    this.resolveRequest(response.id, response.passphrase, response.remember ?? false);
  }

  /**
   * Resolve a pending request with a passphrase (or null for cancel).
   */
  private resolveRequest(id: string, passphrase: string | null, remember = false): void {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(id);
      if (remember && passphrase && pending.canRemember) {
        void this.rememberPassphrase(pending.prompt, passphrase).then((remembered) => {
          if (!remembered && !pending.window.isDestroyed()) {
            pending.window.webContents.send(
              IPC.ASKPASS_NOT_REMEMBERED,
              sshKeyPathFromPrompt(pending.prompt)
            );
          }
        });
      }
      for (const socket of pending.sockets) {
        this.answer(socket, passphrase);
      }
      if (!pending.window.isDestroyed()) {
        pending.window.webContents.send(IPC.ASKPASS_ENDED, id);
      }
      // Never log the actual passphrase for security
      logger.debug('Resolved passphrase request', { id, provided: passphrase !== null });
    }
  }

  private answer(socket: Socket, passphrase: string | null): void {
    socket.write(JSON.stringify({ passphrase }) + '\n');
    socket.end();
  }
}

function keyFileUnchanged(remembered: RememberedPassphrase): boolean {
  try {
    const { mtimeMs, size } = statSync(remembered.keyPath);
    return mtimeMs === remembered.mtimeMs && size === remembered.size;
  } catch {
    return false;
  }
}

export const askpassService = new AskpassService();
