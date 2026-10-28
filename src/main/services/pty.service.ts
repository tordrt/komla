import { execFile } from 'child_process';

import { BrowserWindow } from 'electron';
import * as pty from 'node-pty';

import { IPC } from '../../shared/constants/ipc-channels';
import { buildTerminalApiUrl } from '../../shared/lib/komla-api-url';
import { shellQuotePosix, shellQuotePowerShell } from '../../shared/lib/shell-quote';
import {
  countTerminalProgramStatusQueries,
  createTerminalOscNotificationState,
  extractTerminalOscNotifications,
  extractTerminalProgramStatuses,
  extractTerminalTitles,
  stripTerminalFocusReports,
  TERMINAL_PROGRAM_STATUS_REPLY,
} from '../../shared/lib/terminal-escape';
import { EscapeInterrupts } from '../lib/escape-interrupt';
import { extractHostOsc, isLocalHost, splitPendingOsc } from '../lib/host-osc';
import { createLogger } from '../lib/logger';
import { powerShellCommandArgs } from '../lib/powershell-native-arguments';
import { buildTerminalEnv, getShell, getShellArgs } from '../lib/shell';
import {
  extractManagedRemoteTerminalSessionReplacedOsc,
  extractRemoteReadyOsc,
  extractSshTerminalPoolAssignmentOsc,
} from '../lib/terminal-control';
import {
  emitTerminalOscNotification,
  emitTerminalProgramStatus,
  emitTerminalTitle,
} from '../lib/terminal-notification-events';
import {
  TerminalPresentation,
  type TerminalOutputChunk,
  type TerminalPresentationMetadata,
  type TerminalPresentationSnapshot,
  type TerminalPresentationSnapshotOptions,
} from '../lib/terminal-presentation';
import { TerminalReplayTail } from '../lib/terminal-replay-tail';
import { isWslMode, windowsPathToWsl } from '../lib/wsl';

import { configService } from './config.service';

import type { TerminalOscNotificationState } from '../../shared/lib/terminal-escape';
import type { TerminalHostInfo, TerminalStatus } from '../../shared/types';
import type { SshTerminalPoolAssignment } from '../lib/terminal-control';

const logger = createLogger('PtyService');

// Fallback timeout to mark the terminal as "running" when no output is received.
const STARTUP_TIMEOUT_MS = 300;
// Characters of recent output kept per terminal for renderer snapshots (getBuffer).
const OUTPUT_BUFFER_LIMIT = 50000;
// node-pty delivers every read on its own event-loop turn, so a flood arrives as tens of
// thousands of chunks a second. A chunk goes out at once unless another went out within this
// window; then it is held until the window closes, so a flood costs one send per window.
const OUTPUT_COALESCE_MS = 2;
// The renderer reports the output xterm has parsed (pty:ack). A PTY more than HIGH characters
// ahead of it is paused, so its program blocks as it would on a slow terminal, until the
// renderer is back under LOW. Pausing starts once a renderer attaches or reports, and a
// renderer that makes no progress for STALL_MS is treated as gone.
const FLOW_CONTROL_HIGH_CHARS = 512 * 1024;
const FLOW_CONTROL_LOW_CHARS = 128 * 1024;
const FLOW_CONTROL_STALL_MS = 2000;
// node-pty destroys a PTY's socket 200 ms after its program exits, read or not, so a paused PTY
// checks this often whether its program is still running.
const FLOW_CONTROL_EXIT_POLL_MS = 50;
// Not on Windows: kill() closes the ConPTY synchronously, and while the output pipe is full,
// conhost can block writing its last frame and hang the main process.
const FLOW_CONTROL_PAUSES = process.platform !== 'win32';

// Delay after last shell output before writing the pending command.  The shell
// starts in canonical mode (TTY line-edit buffer limited to MAX_CANON — 1024
// bytes on macOS).  Long commands written in canonical mode get silently
// truncated, breaking quoting.  We wait for output to settle so the shell's
// line editor (ZLE/readline) has time to activate and switch to raw mode where
// there is no buffer limit.
const PENDING_COMMAND_SETTLE_MS = 150;
const PENDING_COMMAND_WRITE_RETRY_MS = 100;
const MAX_PENDING_COMMAND_WRITE_ATTEMPTS = 5;

// Fallback timeout for writing the startup command when the shell never emits
// output via onData (e.g. a minimal shell with no prompt).
const SHELL_READY_FALLBACK_MS = 5000;

// Fallback PTY dimensions used only when the caller doesn't know the real
// terminal size yet. Callers that have a mounted xterm view should always pass
// its actual cols/rows so the child process (and any TUI it launches) renders
// correctly from the first frame.
const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 30;

export type { TerminalStatus };

type PtyStartupMode = 'echo-command' | 'wait-for-marker';

interface PtyProcess {
  pty: pty.IPty;
  terminalId: string;
  lastOutput: string;
  status: TerminalStatus;
  windowId: number | null; // Track which window owns this terminal
  startupTimeoutId: NodeJS.Timeout | null; // Track startup timeout for race condition prevention
  startupMode: PtyStartupMode;
  pendingCommand: string | null; // Command to write once shell emits first output (ready)
  pendingCommandTimeoutId: NodeJS.Timeout | null; // Fallback timeout for pendingCommand
  pendingCommandWriteAttempts: number;
  // Monotonic chunk counter. Incremented before each PTY_DATA broadcast so the
  // renderer can dedupe the buffer-snapshot replay against the live stream.
  seq: number;
  lastHostname: string | null; // Last hostname reported by a host OSC.
  // Unterminated OSC prefix carried from the previous onData chunk. PTY output
  // isn't message-framed, so an OSC 7337 can straddle a chunk boundary; we
  // hold the tail here until the terminator arrives on a later chunk.
  oscCarry: string;
  // Output held until the coalescing window opened by the last send closes.
  heldOutput: string;
  outputWindowTimer: NodeJS.Timeout | null;
  // Flow control; see FLOW_CONTROL_HIGH_CHARS. The stall timer and exit poll run only while paused.
  flowControlArmed: boolean;
  unackedChars: number;
  flowStallTimer: NodeJS.Timeout | null;
  flowExitPollTimer: NodeJS.Timeout | null;
  // The foreground process as a program began reporting its status (OSC 7501). The program
  // reports clear as it quits, but not when it is killed.
  statusReporter: string | null;
  // Whether a program asking to report its status (OSC 7501) gets the answer, as Claude Code,
  // Antigravity and Pi ask before reporting. Windows' own ConPTY passes the question out but drops
  // the answer on its way in (Windows 11 24H2), so only the bundled one answers there.
  answersStatusQueries: boolean;
  // The bundled ConPTY asks for device attributes before the shell prints anything, and holds the
  // terminal for about 3 s until it hears back. xterm answers only while a view is attached, so
  // the first output's query is answered here.
  answersConptyStartupQuery: boolean;
}

/** How a terminal's process ended by itself, unlike one Komla killed. */
export interface PtyExit {
  exitCode: number;
  /** The end of what it printed, e.g. an error just before it exited. */
  output: string;
}

/** Enough of the output for the last lines a process printed before exiting. */
const EXIT_OUTPUT_CHARS = 2000;

export interface PtyBufferSnapshot {
  buffer: string;
  seq: number;
  hostInfo?: TerminalHostInfo;
}

/** How long after a keystroke a killed program's shell has taken the foreground. */
const STATUS_REPORTER_CHECK_MS = 500;

/** The name of the PTY's foreground process, or '' where it can't be read. */
function foregroundProcess(ptyProcess: pty.IPty): string {
  try {
    return ptyProcess.process;
  } catch {
    return '';
  }
}

function isProgramRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface TerminalSizeAuthority {
  /** Also takes the size back after the desktop claimed it. */
  resize(cols: number, rows: number): void;
  release(): void;
  /**
   * Hears each size the PTY takes from the desktop while the desktop has the size back. A lease
   * handed on to a reconnect gets its new holder's listener.
   */
  onDesktopSize(listener: ((cols: number, rows: number) => void) | null): void;
  /** The desktop's size while the desktop has the size back, else null. */
  desktopSize(): { cols: number; rows: number } | null;
}

interface ActiveSizeAuthority {
  token: symbol;
  size: { cols: number; rows: number };
  /** The desktop took the size back; the PTY follows the desktop until the holder resizes. */
  yielded: boolean;
  onDesktopSize: ((cols: number, rows: number) => void) | null;
}

function buildStartupCommand(cwd: string, command: string | null, args: string[]): string | null {
  let interactiveCommand: string | null = null;
  if (command) {
    interactiveCommand = command;
    if (args.length > 0) {
      // Use PowerShell-style quoting on Windows (non-WSL), Unix-style otherwise.
      // WSL runs through wsl.exe into a bash shell, so it needs Unix quoting.
      // Note: assumes PowerShell as the Windows shell (default in Windows Terminal
      // and VS Code). cmd.exe is not supported — single quotes are literal there.
      const usePowerShellQuoting = process.platform === 'win32' && !isWslMode();
      const quotedArgs = args.map((arg) => {
        // If arg is a simple flag like --continue, don't quote
        if (arg.startsWith('-') && !arg.includes(' ')) {
          return arg;
        }
        if (usePowerShellQuoting) {
          // PowerShell: single quotes prevent all variable interpolation.
          return shellQuotePowerShell(arg);
        }
        // Unix shells: double-quote with escaped inner double quotes
        return `"${arg.replace(/"/g, '\\"')}"`;
      });
      interactiveCommand = `${command} ${quotedArgs.join(' ')}`;
    }
  }

  if (!isWslMode()) {
    return interactiveCommand;
  }

  const translatedCwd = windowsPathToWsl(cwd);
  const startupSteps = [`cd ${shellQuotePosix(translatedCwd)}`];
  if (interactiveCommand) {
    startupSteps.push(interactiveCommand);
  }
  return startupSteps.join(' && ');
}

/**
 * PowerShell arguments that run the startup command and then stay open, the
 * counterpart of POSIX `-ilc`. Returns null when the command line would exceed
 * the Windows limit.
 */
function buildPowerShellStartupArgs(
  shell: string,
  shellArgs: string[],
  startupCommand: string,
  startupMode: PtyStartupMode
): string[] | null {
  const noExitArgs = [...shellArgs, '-NoExit'];
  if (startupMode === 'echo-command') {
    // The POSIX echo, in a console color because Windows PowerShell 5.1 may not
    // interpret escape sequences before its first prompt.
    const echoCommand = `Write-Host -ForegroundColor DarkGray ${shellQuotePowerShell(`\uf120 ${startupCommand}`)}`;
    const echoedArgs = powerShellCommandArgs(
      shell,
      noExitArgs,
      `${echoCommand}; ${startupCommand}`
    );
    if (echoedArgs) return echoedArgs;
  }
  // The echo repeats the whole command, so a long command starts without it.
  return powerShellCommandArgs(shell, noExitArgs, startupCommand);
}

// The inbox ConPTY redraws its own copy of the screen, so lines a program scrolls out of a
// scroll region (Codex's inline history) never reach the scrollback. node-pty's bundled
// conpty.dll passes the output through. It's experimental there, so it's opt-in, and a
// DLL that can't load falls back to the inbox ConPTY rather than leaving no terminal.
// node-pty throws these before it starts OpenConsole's reader or opens the input pipe,
// so nothing is left to clean up; any later error is the spawn's own and is rethrown.
const BUNDLED_CONPTY_LOAD_ERROR = /conpty\.dll|Cannot launch conpty/;
// What xterm answers to a device attributes query (DA1): a VT100 with advanced video.
const CONPTY_DEVICE_ATTRIBUTES_REPLY = '\x1b[?1;2c';
let bundledConptyUnavailable = false;

/** Spawns the PTY, and says whether it got node-pty's bundled ConPTY on Windows. */
function spawnPty(
  shell: string,
  args: string[],
  options: pty.IWindowsPtyForkOptions,
  terminalId: string
): { ptyProcess: pty.IPty; bundledConpty: boolean } {
  if (
    process.platform !== 'win32' ||
    bundledConptyUnavailable ||
    configService.get().windowsUseConptyDll === false
  ) {
    return { ptyProcess: pty.spawn(shell, args, options), bundledConpty: false };
  }
  try {
    return {
      ptyProcess: pty.spawn(shell, args, { ...options, useConptyDll: true }),
      bundledConpty: true,
    };
  } catch (error) {
    if (!BUNDLED_CONPTY_LOAD_ERROR.test(String(error))) throw error;
    bundledConptyUnavailable = true;
    logger.warn('Bundled ConPTY failed to load, using the Windows one', { terminalId, error });
    return { ptyProcess: pty.spawn(shell, args, options), bundledConpty: false };
  }
}

// On shutdown we wait this long for each PTY's native exit event to land
// before escalating SIGHUP → SIGKILL. The real risk we're avoiding is racing
// node-pty's exit ThreadSafeFunction against Node's Environment::CleanupHandles()
// — if the TSFN fires after teardown begins, Napi::Function::Call into the
// dying JS env throws and aborts the process. macOS shell-group teardown is
// usually sub-10ms; 1000ms is generous.
const SHUTDOWN_EXIT_TIMEOUT_MS = 1000;
// Additional grace after SIGKILL escalation. SIGKILL is uncatchable so the
// child should die immediately and the native exit event should arrive
// promptly; we just need enough time for the reap + TSFN to flow through.
const SHUTDOWN_FORCE_KILL_GRACE_MS = 250;
const RESTART_FOCUS_REPORT_SUPPRESS_MS = 5000;

class PtyService {
  private processes: Map<string, PtyProcess> = new Map();
  private pendingSizes: Map<string, { cols: number; rows: number }> = new Map();
  private outputBuffers: Map<string, TerminalReplayTail> = new Map();
  private terminalLastSeq: Map<string, number> = new Map();
  private terminalPresentations: Map<string, TerminalPresentation> = new Map();
  private terminalGenerations: Map<string, number> = new Map();
  private terminalPresentationTrackingEnabled = false;
  private localTerminalSizes: Map<string, { cols: number; rows: number }> = new Map();
  private terminalSizeAuthorities: Map<string, ActiveSizeAuthority> = new Map();
  private terminalToWindow: Map<string, number> = new Map(); // terminalId -> windowId
  private terminalFocusReportSuppressUntil: Map<string, number> = new Map();
  private terminalOscNotificationStates: Map<string, TerminalOscNotificationState> = new Map();
  private abortListeners: Array<(terminalId: string, confirmed: boolean) => void> = [];
  private answerKeyListeners: Array<(terminalId: string) => void> = [];
  private exitListeners: Array<(terminalId: string, exit?: PtyExit) => void> = [];
  private managedRemoteTerminalSessionReplacedListeners: Array<(terminalId: string) => void> = [];
  private sshTerminalPoolAssignmentListeners: Array<
    (terminalId: string, assignment: SshTerminalPoolAssignment) => void
  > = [];
  private dataListeners: Array<(terminalId: string, data: string, seq: number) => void> = [];
  private statusListeners: Array<(terminalId: string, status: TerminalStatus) => void> = [];
  private resetListeners: Array<(terminalId: string) => void> = [];
  private errorListeners: Array<(terminalId: string, message: string) => void> = [];
  // PTYs removed from `processes` by kill()/restart() may not have delivered
  // their native exit event yet. Keep their concrete instances until they do.
  private exitingProcesses: Set<PtyProcess> = new Set();
  // Resolvers waiting for a specific terminal's native exit event during
  // shutdown. Populated by killAll(), drained by handleExit().
  private shutdownExitResolvers: Map<string, () => void> = new Map();
  // Set by killAll(): programs may still be writing as they exit, so nothing pauses again.
  private shuttingDown = false;
  // Workspace deletion must not remove a terminal's cwd until node-pty has
  // observed the native process exit. These resolvers are separate from the
  // shutdown waiters because releaseTerminal() retains its immediate API.
  private releaseExitResolvers: Map<PtyProcess, () => void> = new Map();
  private escapeInterrupts = new EscapeInterrupts((terminalId, confirmed) =>
    this.notifyAbort(terminalId, confirmed)
  );

  /** null ends the PTY generation. */
  private emitTitle(terminalId: string, title: string | null): void {
    this.escapeInterrupts.title(terminalId, title);
    emitTerminalTitle(terminalId, title);
  }

  private notifyAbort(terminalId: string, confirmed = false): void {
    for (const listener of this.abortListeners) {
      listener(terminalId, confirmed);
    }
  }

  private writeToPty(proc: PtyProcess, data: string): boolean {
    try {
      proc.pty.write(data);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = (err as NodeJS.ErrnoException).code;
      const logContext = {
        terminalId: proc.terminalId,
        code,
        message: err.message,
      };

      if (code === 'EAGAIN') {
        logger.warn('PTY write temporarily unavailable', logContext);
      } else {
        logger.error('PTY write failed', logContext);
      }

      return false;
    }
  }

  private schedulePendingCommandWrite(proc: PtyProcess, delayMs: number): void {
    proc.pendingCommandTimeoutId = setTimeout(() => {
      const currentProc = this.processes.get(proc.terminalId);
      if (!currentProc || !currentProc.pendingCommand) return;

      currentProc.pendingCommandTimeoutId = null;
      this.flushPendingCommand(currentProc);
    }, delayMs);
  }

  private flushPendingCommand(proc: PtyProcess): void {
    if (!proc.pendingCommand) return;

    const wrote = this.writeToPty(proc, `${proc.pendingCommand}\r`);
    if (wrote) {
      proc.pendingCommand = null;
      proc.pendingCommandWriteAttempts = 0;
      proc.pendingCommandTimeoutId = null;
      return;
    }

    proc.pendingCommandWriteAttempts += 1;
    if (proc.pendingCommandWriteAttempts >= MAX_PENDING_COMMAND_WRITE_ATTEMPTS) {
      logger.error('Dropping pending command after repeated PTY write failures', {
        terminalId: proc.terminalId,
        attempts: proc.pendingCommandWriteAttempts,
      });
      proc.pendingCommand = null;
      proc.pendingCommandTimeoutId = null;
      return;
    }

    this.schedulePendingCommandWrite(proc, PENDING_COMMAND_WRITE_RETRY_MS);
  }

  /**
   * Register a callback that fires when a user sends an abort signal (Ctrl-C, Esc) to a terminal.
   * `confirmed` is set when the agent's title showed it stop.
   */
  onAbort(listener: (terminalId: string, confirmed: boolean) => void): void {
    this.abortListeners.push(listener);
  }

  /**
   * Register a callback that fires when a user sends a key that answers or cancels a prompt
   * (Enter, Ctrl-C, Ctrl-D, Esc) to a terminal.
   */
  onAnswerKey(listener: (terminalId: string) => void): void {
    this.answerKeyListeners.push(listener);
  }

  /** Register a callback that fires when a terminal process exits, with how it ended by itself. */
  onExit(listener: (terminalId: string, exit?: PtyExit) => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((candidate) => candidate !== listener);
    };
  }

  onManagedRemoteTerminalSessionReplaced(listener: (terminalId: string) => void): void {
    this.managedRemoteTerminalSessionReplacedListeners.push(listener);
  }

  onSshTerminalPoolAssignment(
    listener: (terminalId: string, assignment: SshTerminalPoolAssignment) => void
  ): void {
    this.sshTerminalPoolAssignmentListeners.push(listener);
  }

  onData(listener: (terminalId: string, data: string, seq: number) => void): () => void {
    this.dataListeners.push(listener);
    return () => {
      this.dataListeners = this.dataListeners.filter((candidate) => candidate !== listener);
    };
  }

  onStatus(listener: (terminalId: string, status: TerminalStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter((candidate) => candidate !== listener);
    };
  }

  onReset(listener: (terminalId: string) => void): () => void {
    this.resetListeners.push(listener);
    return () => {
      this.resetListeners = this.resetListeners.filter((candidate) => candidate !== listener);
    };
  }

  onError(listener: (terminalId: string, message: string) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((candidate) => candidate !== listener);
    };
  }

  spawn(
    terminalId: string,
    cwd: string,
    command: string | null,
    args: string[] = [],
    windowId?: number,
    _workspaceId?: string,
    initialSeq = 0,
    cols = DEFAULT_PTY_COLS,
    rows = DEFAULT_PTY_ROWS,
    startupMode: PtyStartupMode = 'echo-command',
    localLoginShell = true
  ): void {
    if (this.processes.has(terminalId)) {
      throw new Error(`PTY already exists for terminal ${terminalId}`);
    }

    const shell = getShell();
    const shellArgs = getShellArgs(configService.get().wslDistro);
    const startupCommand = buildStartupCommand(cwd, command, args);

    // When there's a startup command on non-Windows, spawn the shell with -c to
    // execute it directly.  This avoids the timing race that garbles the prompt
    // when writing to stdin after the shell starts.  After the command exits,
    // `exec $SHELL` drops the user back into a fresh interactive shell.
    const isZsh = shell.endsWith('/zsh') || shell.endsWith('/zsh5');
    let spawnShell = shell;
    let spawnArgs = shellArgs;
    let pendingCommand: string | null = null;
    if (startupCommand && process.platform !== 'win32' && !localLoginShell) {
      // The caller needs nothing from the user's startup files, so skip their cost.
      spawnShell = '/bin/sh';
      spawnArgs = ['-c', startupCommand];
    } else if (startupCommand && process.platform !== 'win32') {
      // Use -ilc (interactive + login + command) so .zshrc/.bashrc are loaded
      // and PATH/nvm/etc. are available for the startup command.
      // After command exits, exec into a login shell; suppress zsh PROMPT_SP
      const execArgs = isZsh ? '-l -o nopromptsp' : '-l';
      // Echo local startup commands because the shell does not print commands
      // passed via -c. Remote connections stay behind the renderer's loading
      // state until their first real output instead.
      const echoCommand =
        startupMode === 'echo-command'
          ? `printf '\\033[2m %s\\033[0m\\n' ${shellQuotePosix(startupCommand)}`
          : null;
      const handoffCommand = [
        'trap - INT',
        'stty sane 2>/dev/null || true',
        `exec ${shellQuotePosix(shell)} ${execArgs}`,
      ].join('; ');
      const handoffFunction = `__komla_action_handoff() { ${handoffCommand}; }`;
      const parts = [echoCommand, handoffFunction, 'trap __komla_action_handoff INT'].filter(
        (part): part is string => part !== null
      );
      parts.push(startupCommand);
      // Ctrl-C can terminate a foreground startup command before it restores
      // tty flags (echo/canonical/isig). Reset them before handing the PTY to
      // the normal shell so action-launched dev servers don't leave a broken
      // prompt behind.
      parts.push('__komla_action_handoff');
      spawnArgs = ['-ilc', parts.join('; ')];
    } else if (startupCommand && !isWslMode()) {
      // Native Windows: PowerShell runs the command from its arguments, and
      // -NoExit leaves the user in the shell afterwards. A command too long
      // for a Windows command line is typed in instead.
      const powerShellArgs = buildPowerShellStartupArgs(
        shell,
        shellArgs,
        startupCommand,
        startupMode
      );
      if (powerShellArgs) spawnArgs = powerShellArgs;
      else pendingCommand = startupCommand;
    } else {
      pendingCommand = startupCommand;
    }

    logger.debug('Spawning PTY', { shell: spawnShell, spawnArgs, cwd, terminalId });

    const env = buildTerminalEnv();
    env.KOMLA_TERMINAL_ID = terminalId;
    // Asks CLIs such as Claude Code to mark file paths as OSC 8 hyperlinks, which stay
    // clickable when wrapped. Only Komla's terminals render them, so setup steps don't get it.
    env.FORCE_HYPERLINK = '1';
    if (env.KOMLA_API_URL) {
      env.KOMLA_API_URL = buildTerminalApiUrl(env.KOMLA_API_URL, terminalId);
    }

    const pendingSize = this.pendingSizes.get(terminalId);
    this.pendingSizes.delete(terminalId);
    const localSize = pendingSize ?? { cols, rows };
    this.localTerminalSizes.set(terminalId, localSize);
    const initialSize = this.remoteSize(terminalId) ?? localSize;
    const spawnOptions = {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd,
      env,
    };
    const { ptyProcess, bundledConpty } = spawnPty(spawnShell, spawnArgs, spawnOptions, terminalId);

    const processInfo: PtyProcess = {
      pty: ptyProcess,
      terminalId,
      lastOutput: '',
      status: 'starting',
      windowId: windowId ?? null,
      startupTimeoutId: null,
      startupMode,
      pendingCommand,
      pendingCommandTimeoutId: null,
      pendingCommandWriteAttempts: 0,
      seq: initialSeq,
      lastHostname: null,
      oscCarry: '',
      heldOutput: '',
      outputWindowTimer: null,
      flowControlArmed: false,
      unackedChars: 0,
      flowStallTimer: null,
      flowExitPollTimer: null,
      statusReporter: null,
      answersStatusQueries: process.platform !== 'win32' || bundledConpty,
      answersConptyStartupQuery: bundledConpty,
    };

    this.processes.set(terminalId, processInfo);
    this.outputBuffers.set(terminalId, new TerminalReplayTail(OUTPUT_BUFFER_LIMIT));
    this.terminalPresentations.get(terminalId)?.dispose();
    this.terminalPresentations.delete(terminalId);
    const generation = (this.terminalGenerations.get(terminalId) ?? 0) + 1;
    this.terminalGenerations.set(terminalId, generation);
    for (const listener of this.resetListeners) {
      listener(terminalId);
    }

    // Track window association
    if (windowId !== undefined) {
      this.terminalToWindow.set(terminalId, windowId);
    }

    ptyProcess.onData((data) => {
      this.queueOutput(processInfo, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.flushHeldOutput(processInfo);
      this.handleExit(terminalId, exitCode, signal, processInfo);
    });

    // Local shells may be silent after startup, so do not leave their loading
    // state up indefinitely. SSH waits for the remote launcher marker so local
    // prompts and command echoes cannot finish the connection handoff.
    if (startupMode === 'echo-command') {
      processInfo.startupTimeoutId = setTimeout(() => {
        processInfo.startupTimeoutId = null;
        if (processInfo.status === 'starting') {
          this.updateStatus(terminalId, 'running');
        }
      }, STARTUP_TIMEOUT_MS);
    }

    // Fallback for typed commands: write the pending command if the shell never emits output
    if (pendingCommand) {
      this.schedulePendingCommandWrite(processInfo, SHELL_READY_FALLBACK_MS);
    }
  }

  private queueOutput(process: PtyProcess, data: string): void {
    if (process.outputWindowTimer) {
      process.heldOutput += data;
      return;
    }
    this.handleOutput(process.terminalId, data, process);
    this.openOutputWindow(process);
  }

  private openOutputWindow(process: PtyProcess): void {
    process.outputWindowTimer = setTimeout(() => {
      process.outputWindowTimer = null;
      if (!process.heldOutput) return;
      this.flushHeldOutput(process);
      this.openOutputWindow(process);
    }, OUTPUT_COALESCE_MS);
  }

  private flushHeldOutput(process: PtyProcess): void {
    const data = process.heldOutput;
    if (!data) return;
    process.heldOutput = '';
    this.handleOutput(process.terminalId, data, process);
  }

  /**
   * Answers the bundled ConPTY's device attributes query, which leads its first output, and takes
   * it out so xterm doesn't answer it too. Later queries are a program's, such as Claude Code's,
   * which xterm answers after the program's OSC 7501 answer.
   */
  private answerConptyStartupQuery(process: PtyProcess, data: string): string {
    // oxlint-disable-next-line no-control-regex -- intentional: matches ESC
    const query = /^((?:\x1b\[[\d;?]*[A-Za-z])*?)\x1b\[0?c/.exec(data);
    if (!query) {
      // A read can end before the query; it comes ahead of anything the shell prints.
      // oxlint-disable-next-line no-control-regex -- intentional: matches ESC
      if (!/^(?:\x1b\[[\d;?]*[A-Za-z])*$/.test(data)) process.answersConptyStartupQuery = false;
      return data;
    }
    process.answersConptyStartupQuery = false;
    this.writeToPty(process, CONPTY_DEVICE_ATTRIBUTES_REPLY);
    return query[1] + data.slice(query[0].length);
  }

  private handleOutput(terminalId: string, data: string, expectedProcess?: PtyProcess): void {
    const process = this.processes.get(terminalId);
    if (!process) return;
    if (expectedProcess && process !== expectedProcess) return;

    // Rejoin any OSC prefix held from the previous chunk, then peel off the
    // new trailing unterminated OSC (if any) to carry into the next chunk.
    // This keeps OSC 7337 detection correct even when node-pty splits a
    // `printf '\x1b]7337;host=…\x07'` across two onData callbacks.
    const combined = process.oscCarry + data;
    const { ready: received, carry } = splitPendingOsc(combined);
    process.oscCarry = carry;

    const ready =
      process.answersConptyStartupQuery && received.length > 0
        ? this.answerConptyStartupQuery(process, received)
        : received;
    if (ready.length === 0) return;
    // Every OSC handler below needs an OSC introducer; skip their scans for plain output.
    data = ready.includes('\x1b]') ? this.extractControlOsc(terminalId, process, ready) : ready;
    if (data.length === 0) return;

    // Update output buffer (keep for potential future use)
    let buffer = this.outputBuffers.get(terminalId);
    if (!buffer) {
      buffer = new TerminalReplayTail(OUTPUT_BUFFER_LIMIT);
      this.outputBuffers.set(terminalId, buffer);
    }
    buffer.append(data);

    if (process.status === 'starting' && process.startupMode === 'echo-command') {
      // Clear the fallback timeout to prevent duplicate status updates
      if (process.startupTimeoutId) {
        clearTimeout(process.startupTimeoutId);
        process.startupTimeoutId = null;
      }
      this.updateStatus(terminalId, 'running');
    }

    // Debounce the pending command write: wait for shell output to settle so
    // the line editor has time to switch from canonical mode (MAX_CANON = 1024
    // byte limit) to raw mode (no limit).  Each new output event resets the
    // timer, so the command is only written after a quiet period.
    if (process.pendingCommand) {
      if (process.pendingCommandTimeoutId) {
        clearTimeout(process.pendingCommandTimeoutId);
      }
      this.schedulePendingCommandWrite(process, PENDING_COMMAND_SETTLE_MS);
    }

    // Send data to renderer (targeted to owning window).  Bump seq first so the
    // snapshot returned by getBuffer (which already includes this chunk) can be
    // deduped against the live broadcast on the renderer side.
    process.seq++;
    this.terminalLastSeq.set(terminalId, process.seq);
    this.terminalPresentations.get(terminalId)?.write(data, process.seq);
    this.sendToRenderer(IPC.PTY_DATA, terminalId, data, process.seq);
    this.trackUnackedOutput(process, data.length);
    for (const listener of this.dataListeners) {
      listener(terminalId, data, process.seq);
    }
  }

  /** A renderer is attaching: output sent before now no longer counts, and pausing starts. */
  attachRenderer(terminalId: string): void {
    const process = this.processes.get(terminalId);
    if (process) this.resetFlowControl(process, true);
  }

  /** Records a renderer's report that xterm has parsed `chars` more characters of output. */
  acknowledgeOutput(terminalId: string, chars: number): void {
    const process = this.processes.get(terminalId);
    if (!process) return;
    if (!this.shuttingDown) process.flowControlArmed = true;
    process.unackedChars = Math.max(0, process.unackedChars - chars);
    if (!process.flowStallTimer) return;
    if (process.unackedChars < FLOW_CONTROL_LOW_CHARS) this.resumeOutput(process);
    else this.watchFlowStall(process);
  }

  private trackUnackedOutput(process: PtyProcess, chars: number): void {
    if (!process.flowControlArmed || !FLOW_CONTROL_PAUSES) return;
    process.unackedChars += chars;
    if (process.flowStallTimer || process.unackedChars <= FLOW_CONTROL_HIGH_CHARS) return;
    process.pty.pause();
    this.watchFlowStall(process);
    process.flowExitPollTimer = setInterval(() => {
      if (!isProgramRunning(process.pty.pid)) this.resumeOutput(process);
    }, FLOW_CONTROL_EXIT_POLL_MS);
  }

  private watchFlowStall(process: PtyProcess): void {
    if (process.flowStallTimer) clearTimeout(process.flowStallTimer);
    process.flowStallTimer = setTimeout(
      () => this.resetFlowControl(process, false),
      FLOW_CONTROL_STALL_MS
    );
  }

  /** Forgets unreported output and resumes; `armed` says whether a renderer is attached. */
  private resetFlowControl(process: PtyProcess, armed: boolean): void {
    process.flowControlArmed = armed;
    process.unackedChars = 0;
    this.resumeOutput(process);
  }

  private resumeOutput(process: PtyProcess): void {
    if (!process.flowStallTimer) return;
    clearTimeout(process.flowStallTimer);
    process.flowStallTimer = null;
    if (process.flowExitPollTimer) clearInterval(process.flowExitPollTimer);
    process.flowExitPollTimer = null;
    process.pty.resume();
  }

  /** Handle Komla control, title and notification OSC sequences; returns the remaining output. */
  private extractControlOsc(terminalId: string, process: PtyProcess, ready: string): string {
    const { assignments, cleaned: poolAssignmentCleaned } =
      extractSshTerminalPoolAssignmentOsc(ready);
    for (const assignment of assignments) {
      for (const listener of this.sshTerminalPoolAssignmentListeners) {
        listener(terminalId, assignment);
      }
    }
    const { replaced, cleaned: replacementCleaned } =
      extractManagedRemoteTerminalSessionReplacedOsc(poolAssignmentCleaned);
    if (replaced) {
      this.emitTitle(terminalId, null);
      for (const listener of this.managedRemoteTerminalSessionReplacedListeners) {
        listener(terminalId);
      }
    }
    const { remoteReady, cleaned: readinessCleaned } = extractRemoteReadyOsc(replacementCleaned);
    if (remoteReady && process.status === 'starting' && process.startupMode === 'wait-for-marker') {
      this.updateStatus(terminalId, 'running');
    }
    if (readinessCleaned.length === 0) return '';

    // Pull host-hostname OSC markers out of the stream before anyone else
    // sees them — we don't want xterm.js logging them as unknown OSC and we
    // don't want them leaking into the renderer's output buffer.
    const { hostname, cleaned } = extractHostOsc(readinessCleaned);
    if (hostname !== null && hostname !== process.lastHostname) {
      process.lastHostname = hostname;
      this.sendToRenderer(IPC.TERMINAL_HOST_CHANGED, terminalId, hostname, isLocalHost(hostname));
    }
    if (cleaned.length === 0) return '';

    for (const title of extractTerminalTitles(cleaned)) this.emitTitle(terminalId, title);
    if (process.answersStatusQueries && countTerminalProgramStatusQueries(cleaned) > 0) {
      this.writeToPty(process, TERMINAL_PROGRAM_STATUS_REPLY);
    }
    for (const status of extractTerminalProgramStatuses(cleaned)) {
      // A record of the program's own, such as a subagent's, says nothing of the program.
      if (status.id === undefined) {
        process.statusReporter =
          status.state === 'clear'
            ? null
            : (process.statusReporter ?? foregroundProcess(process.pty));
      }
      emitTerminalProgramStatus(terminalId, status);
    }

    const notificationState =
      this.terminalOscNotificationStates.get(terminalId) ?? createTerminalOscNotificationState();
    this.terminalOscNotificationStates.set(terminalId, notificationState);
    const { notifications, cleaned: notificationCleaned } = extractTerminalOscNotifications(
      cleaned,
      notificationState
    );
    for (const notification of notifications) {
      emitTerminalOscNotification({ terminalId, ...notification });
    }
    return notificationCleaned;
  }

  private handleExit(
    terminalId: string,
    exitCode: number,
    signal?: number,
    expectedProcess?: PtyProcess
  ): void {
    // Drain the shutdown resolver first, before any early-return: a concurrent
    // user-facing kill(terminalId) may have already removed the process entry,
    // and we still need to release the shutdown waiter when the native exit
    // lands rather than wait for the timeout fallback.
    const resolver = this.shutdownExitResolvers.get(terminalId);
    const isShutdownExit = resolver !== undefined;
    if (resolver) {
      this.shutdownExitResolvers.delete(terminalId);
      resolver();
    }
    if (expectedProcess) {
      this.exitingProcesses.delete(expectedProcess);
      const releaseResolver = this.releaseExitResolvers.get(expectedProcess);
      if (releaseResolver) {
        this.releaseExitResolvers.delete(expectedProcess);
        releaseResolver();
      }
    }

    const process = this.processes.get(terminalId);
    if (!process) return;
    if (expectedProcess && process !== expectedProcess) return;

    // Clear pending timeouts (prevents leak if exit happens before timeouts fire)
    if (process.startupTimeoutId) {
      clearTimeout(process.startupTimeoutId);
      process.startupTimeoutId = null;
    }
    if (process.pendingCommandTimeoutId) {
      clearTimeout(process.pendingCommandTimeoutId);
      process.pendingCommandTimeoutId = null;
    }
    this.resumeOutput(process);

    this.updateStatus(terminalId, 'stopped');

    if (exitCode !== 0) {
      const message = `Process exited with code ${exitCode}`;
      this.sendToRenderer(IPC.TERMINAL_ERROR, terminalId, message);
      for (const listener of this.errorListeners) {
        listener(terminalId, message);
      }
    }

    if (!isShutdownExit) {
      this.sendToRenderer(IPC.TERMINAL_EXIT, terminalId, exitCode, signal);
    }
    this.processes.delete(terminalId);
    this.terminalLastSeq.set(terminalId, process.seq);
    const exit: PtyExit = {
      exitCode,
      output: this.outputBuffers.get(terminalId)?.toString(EXIT_OUTPUT_CHARS) ?? '',
    };
    this.outputBuffers.delete(terminalId);
    this.terminalPresentations.get(terminalId)?.dispose();
    this.terminalPresentations.delete(terminalId);
    this.terminalToWindow.delete(terminalId);
    this.terminalFocusReportSuppressUntil.delete(terminalId);
    this.terminalOscNotificationStates.delete(terminalId);
    this.emitTitle(terminalId, null);

    for (const listener of this.exitListeners) {
      listener(terminalId, exit);
    }
  }

  private updateStatus(terminalId: string, status: TerminalStatus): void {
    const process = this.processes.get(terminalId);
    if (process) {
      process.status = status;
    }

    // Status changes broadcast to all windows since workspaces can be viewed from any window
    this.broadcastToAll(IPC.TERMINAL_STATUS_CHANGE, terminalId, status);
    for (const listener of this.statusListeners) {
      listener(terminalId, status);
    }
  }

  // Broadcast to all windows (for events that need global visibility)
  private broadcastToAll(channel: string, ...args: unknown[]): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    }
  }

  private sendToRenderer(channel: string, terminalId: string, ...args: unknown[]): void {
    // Try to send to specific window first
    const targetWindowId = this.terminalToWindow.get(terminalId);
    if (targetWindowId !== undefined) {
      const targetWindow = BrowserWindow.fromId(targetWindowId);
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send(channel, terminalId, ...args);
        return;
      }
    }

    // Fallback: broadcast to all windows (for status changes that need global visibility)
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, terminalId, ...args);
      }
    }
  }

  // Update window association for a terminal
  setTerminalWindow(terminalId: string, windowId: number): void {
    this.terminalToWindow.set(terminalId, windowId);
    const process = this.processes.get(terminalId);
    if (process) {
      process.windowId = windowId;
    }
  }

  write(terminalId: string, data: string): void {
    const proc = this.processes.get(terminalId);
    if (!proc) {
      logger.debug('Ignoring write to non-existent terminal', { terminalId });
      return;
    }

    const suppressFocusReportsUntil = this.terminalFocusReportSuppressUntil.get(terminalId) ?? 0;
    if (Date.now() < suppressFocusReportsUntil) {
      data = stripTerminalFocusReports(data);
      if (!data) return;
    } else if (suppressFocusReportsUntil > 0) {
      this.terminalFocusReportSuppressUntil.delete(terminalId);
    }

    // When the user sends Ctrl-C to a local terminal, re-enable isig on the
    // PTY device first. Raw-mode programs (coding agents, TUIs) can exit
    // without restoring the TTY, leaving Ctrl-C to echo ^C forever. Remote
    // transports must stay in raw mode so the byte reaches SSH instead
    // of generating SIGINT for the local transport process.
    if (
      process.platform !== 'win32' &&
      proc.startupMode === 'echo-command' &&
      data.includes('\x03')
    ) {
      this.ensureIsig(proc);
    }

    // Notify listeners on abort signals (Ctrl-C, Ctrl-D, Esc)
    if (data.includes('\x03') || data.includes('\x04')) {
      this.notifyAbort(terminalId);
    } else if (data === '\x1b') {
      this.escapeInterrupts.escape(terminalId);
    }
    const submits = data.includes('\r') || data.includes('\x03') || data.includes('\x04');
    if (proc.statusReporter !== null && submits) {
      this.checkStatusReporter(terminalId, proc);
    }
    if (submits || data === '\x1b') {
      for (const listener of this.answerKeyListeners) listener(terminalId);
    }

    this.writeToPty(proc, data);
  }

  /**
   * A program that reports its status may have been killed, leaving the shell to the user's
   * keystroke. Its status is then cleared as it would have cleared it. Where the foreground
   * process doesn't change, as through SSH or on Windows, it stays.
   */
  private checkStatusReporter(terminalId: string, proc: PtyProcess): void {
    setTimeout(() => {
      if (this.processes.get(terminalId) !== proc || proc.statusReporter === null) return;
      if (foregroundProcess(proc.pty) === proc.statusReporter) return;
      proc.statusReporter = null;
      emitTerminalProgramStatus(terminalId, { state: 'clear' });
    }, STATUS_REPORTER_CHECK_MS);
  }

  /**
   * Re-enable the isig terminal flag on the PTY device so that signal
   * characters (Ctrl-C → SIGINT, Ctrl-Z → SIGTSTP) work correctly.
   */
  private ensureIsig(proc: PtyProcess): void {
    const ptsName = (proc.pty as unknown as { ptsName: string }).ptsName;
    if (!ptsName) return;
    const flag = process.platform === 'darwin' ? '-f' : '-F';
    execFile('stty', [flag, ptsName, 'isig'], (err) => {
      if (err) {
        logger.debug('Failed to re-enable isig on PTY', { error: err.message });
      }
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const size = { cols, rows };
    this.localTerminalSizes.set(terminalId, size);
    if (!this.processes.has(terminalId)) this.pendingSizes.set(terminalId, size);
    const authority = this.terminalSizeAuthorities.get(terminalId);
    if (authority && !authority.yielded) {
      this.broadcastSizeAuthority(terminalId, true, authority.size);
      return;
    }
    this.applyTerminalSize(terminalId, size);
    authority?.onDesktopSize?.(cols, rows);
  }

  /**
   * Someone typed or clicked in the terminal on the desktop: a remote lease on it gives the PTY
   * back the desktop's size until its holder resizes again.
   */
  claimLocalSize(terminalId: string): void {
    const authority = this.terminalSizeAuthorities.get(terminalId);
    if (!authority || authority.yielded) return;
    authority.yielded = true;
    const localSize = this.desktopSize(terminalId, authority);
    this.applyTerminalSize(terminalId, localSize);
    this.broadcastSizeAuthority(terminalId, false, localSize);
    authority.onDesktopSize?.(localSize.cols, localSize.rows);
  }

  private desktopSize(
    terminalId: string,
    authority: ActiveSizeAuthority
  ): { cols: number; rows: number } {
    const process = this.processes.get(terminalId);
    return (
      this.localTerminalSizes.get(terminalId) ??
      (process ? { cols: process.pty.cols, rows: process.pty.rows } : authority.size)
    );
  }

  /** The size a remote lease currently holds the terminal at, unless the desktop took it back. */
  private remoteSize(terminalId: string): { cols: number; rows: number } | undefined {
    const authority = this.terminalSizeAuthorities.get(terminalId);
    return authority && !authority.yielded ? authority.size : undefined;
  }

  acquireSizeAuthority(terminalId: string, cols: number, rows: number): TerminalSizeAuthority {
    if (this.terminalSizeAuthorities.has(terminalId)) {
      throw new Error(`terminal size authority already acquired for ${terminalId}`);
    }
    const token = Symbol(terminalId);
    const active: ActiveSizeAuthority = {
      token,
      size: { cols, rows },
      yielded: false,
      onDesktopSize: null,
    };
    this.terminalSizeAuthorities.set(terminalId, active);
    this.applyTerminalSize(terminalId, active.size);
    this.broadcastSizeAuthority(terminalId, true, active.size);
    let released = false;
    return {
      resize: (nextCols, nextRows) => {
        if (released || this.terminalSizeAuthorities.get(terminalId)?.token !== token) return;
        active.size = { cols: nextCols, rows: nextRows };
        active.yielded = false;
        this.applyTerminalSize(terminalId, active.size);
        this.broadcastSizeAuthority(terminalId, true, active.size);
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.terminalSizeAuthorities.get(terminalId)?.token !== token) return;
        this.terminalSizeAuthorities.delete(terminalId);
        const localSize = this.localTerminalSizes.get(terminalId);
        if (localSize) {
          this.applyTerminalSize(terminalId, localSize);
          this.broadcastSizeAuthority(terminalId, false, localSize);
        }
      },
      onDesktopSize: (listener) => {
        active.onDesktopSize = listener;
      },
      desktopSize: () => {
        if (released || !active.yielded) return null;
        return this.desktopSize(terminalId, active);
      },
    };
  }

  private applyTerminalSize(terminalId: string, size: { cols: number; rows: number }): void {
    // spawn() reads a held lease itself; pendingSizes keeps only desktop sizes.
    const process = this.processes.get(terminalId);
    if (!process) return;
    process.pty.resize(size.cols, size.rows);
    this.terminalPresentations.get(terminalId)?.resize(size.cols, size.rows);
  }

  private broadcastSizeAuthority(
    terminalId: string,
    remoteOwned: boolean,
    size: { cols: number; rows: number }
  ): void {
    this.broadcastToAll(IPC.TERMINAL_SIZE_AUTHORITY, terminalId, remoteOwned, size.cols, size.rows);
  }

  /** Remote devices may read terminals; each one's output is parsed from the first read. */
  enableTerminalPresentationTracking(): void {
    this.terminalPresentationTrackingEnabled = true;
  }

  disableTerminalPresentationTracking(): void {
    if (!this.terminalPresentationTrackingEnabled) return;
    this.terminalPresentationTrackingEnabled = false;
    for (const presentation of this.terminalPresentations.values()) presentation.dispose();
    this.terminalPresentations.clear();
  }

  /**
   * The running terminal's parsed screen, started from its retained output the first time a
   * remote device reads it, so terminals no device opens are never parsed twice.
   */
  private presentation(terminalId: string): TerminalPresentation | undefined {
    const existing = this.terminalPresentations.get(terminalId);
    if (existing || !this.terminalPresentationTrackingEnabled) return existing;
    const process = this.processes.get(terminalId);
    if (!process) return undefined;
    const size = this.remoteSize(terminalId) ??
      this.localTerminalSizes.get(terminalId) ?? {
        cols: process.pty.cols,
        rows: process.pty.rows,
      };
    const presentation = new TerminalPresentation({
      cols: size.cols,
      rows: size.rows,
      generation: this.terminalGenerations.get(terminalId) ?? 1,
      seq: process.seq,
    });
    const retainedOutput = this.outputBuffers.get(terminalId);
    if (retainedOutput) presentation.write(retainedOutput.toString(), process.seq);
    this.terminalPresentations.set(terminalId, presentation);
    return presentation;
  }

  kill(terminalId: string): void {
    const process = this.processes.get(terminalId);
    if (!process) return;
    this.terminateProcess(terminalId, process, true);
  }

  /**
   * Permanently tear down a terminal: kill its process (if running) and drop
   * the retained seq counter. Unlike kill(), which keeps the seq so a stopped
   * terminal can resume it on restart, this must only be used when the
   * terminal is gone for good.
   */
  releaseTerminal(terminalId: string): void {
    this.kill(terminalId);
    this.pendingSizes.delete(terminalId);
    this.terminalLastSeq.delete(terminalId);
    this.terminalPresentations.get(terminalId)?.dispose();
    this.terminalPresentations.delete(terminalId);
    this.terminalGenerations.delete(terminalId);
    this.localTerminalSizes.delete(terminalId);
    this.terminalSizeAuthorities.delete(terminalId);
  }

  /**
   * Permanently tear down a terminal and wait for node-pty's native exit
   * event. This is required before deleting the terminal's working directory.
   */
  async releaseTerminalAndWait(terminalId: string): Promise<void> {
    const proc = this.processes.get(terminalId);
    const processesToWaitFor = [...this.exitingProcesses].filter(
      (exitingProcess) => exitingProcess.terminalId === terminalId
    );
    if (proc) processesToWaitFor.push(proc);

    const exitPromises = processesToWaitFor.map(
      (processToWaitFor) =>
        new Promise<void>((resolve) => {
          let escalateTimer: NodeJS.Timeout | null = null;
          let abandonTimer: NodeJS.Timeout | null = null;

          const finalize = (): void => {
            if (escalateTimer) clearTimeout(escalateTimer);
            if (abandonTimer) clearTimeout(abandonTimer);
            this.exitingProcesses.delete(processToWaitFor);
            if (this.releaseExitResolvers.get(processToWaitFor) === finalize) {
              this.releaseExitResolvers.delete(processToWaitFor);
            }
            resolve();
          };

          this.releaseExitResolvers.set(processToWaitFor, finalize);
          escalateTimer = setTimeout(() => {
            escalateTimer = null;
            if (process.platform !== 'win32') {
              logger.warn('PTY did not exit before workspace deletion, escalating to SIGKILL', {
                terminalId,
              });
              try {
                processToWaitFor.pty.kill('SIGKILL');
              } catch (err) {
                logger.warn('SIGKILL escalation failed before workspace deletion', {
                  terminalId,
                  error: String(err),
                });
              }
            }

            abandonTimer = setTimeout(() => {
              abandonTimer = null;
              logger.warn('PTY exit event never arrived before workspace deletion; continuing', {
                terminalId,
              });
              finalize();
            }, SHUTDOWN_FORCE_KILL_GRACE_MS);
          }, SHUTDOWN_EXIT_TIMEOUT_MS);
        })
    );

    this.releaseTerminal(terminalId);
    await Promise.all(exitPromises);
  }

  restart(
    terminalId: string,
    cwd: string,
    command: string | null,
    workspaceId?: string,
    cols?: number,
    rows?: number,
    startupMode: PtyStartupMode = 'echo-command',
    localLoginShell = true
  ): void {
    const process = this.processes.get(terminalId);
    const windowId = process?.windowId ?? this.terminalToWindow.get(terminalId);
    const initialSeq = process?.seq ?? this.terminalLastSeq.get(terminalId) ?? 0;
    this.terminalFocusReportSuppressUntil.set(
      terminalId,
      Date.now() + RESTART_FOCUS_REPORT_SUPPRESS_MS
    );

    if (process) {
      this.terminateProcess(terminalId, process, false);
    } else {
      this.outputBuffers.delete(terminalId);
      this.terminalOscNotificationStates.delete(terminalId);
      this.emitTitle(terminalId, null);
    }

    this.spawn(
      terminalId,
      cwd,
      command,
      [],
      windowId ?? undefined,
      workspaceId,
      initialSeq,
      cols,
      rows,
      startupMode,
      localLoginShell
    );
    this.broadcastToAll(IPC.TERMINAL_RESET, terminalId);
    this.updateStatus(terminalId, 'starting');
  }

  private terminateProcess(
    terminalId: string,
    process: PtyProcess,
    notifyExitListeners: boolean
  ): void {
    // Clear pending timeouts before cleanup
    if (process.startupTimeoutId) {
      clearTimeout(process.startupTimeoutId);
      process.startupTimeoutId = null;
    }
    if (process.pendingCommandTimeoutId) {
      clearTimeout(process.pendingCommandTimeoutId);
      process.pendingCommandTimeoutId = null;
    }
    // Output still held for coalescing is the program's last; deliver it while the bookkeeping
    // that routes it is still there.
    if (process.outputWindowTimer) {
      clearTimeout(process.outputWindowTimer);
      process.outputWindowTimer = null;
    }
    this.flushHeldOutput(process);
    // node-pty reports the exit only once it has read the closed socket.
    this.resumeOutput(process);
    // Remove bookkeeping before kill so a synchronous native onExit cannot
    // tear down a replacement spawned under the same terminal ID.
    this.updateStatus(terminalId, 'stopped');
    this.terminalLastSeq.set(terminalId, process.seq);
    this.processes.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    this.terminalPresentations.get(terminalId)?.dispose();
    this.terminalPresentations.delete(terminalId);
    this.terminalToWindow.delete(terminalId);
    this.terminalOscNotificationStates.delete(terminalId);
    this.emitTitle(terminalId, null);
    if (notifyExitListeners) {
      this.terminalFocusReportSuppressUntil.delete(terminalId);
    }
    this.exitingProcesses.add(process);
    process.pty.kill();

    if (notifyExitListeners) {
      for (const listener of this.exitListeners) {
        listener(terminalId);
      }
    }
  }

  getBuffer(terminalId: string, maxChars?: number): PtyBufferSnapshot {
    const process = this.processes.get(terminalId);
    const hostname = process?.lastHostname;
    return {
      buffer: this.outputBuffers.get(terminalId)?.toString(maxChars) ?? '',
      seq: process?.seq ?? this.terminalLastSeq.get(terminalId) ?? 0,
      ...(hostname
        ? {
            hostInfo: { hostname, isLocal: isLocalHost(hostname) },
          }
        : {}),
    };
  }

  getHostInfo(terminalId: string): TerminalHostInfo | undefined {
    return this.getBuffer(terminalId).hostInfo;
  }

  getPresentationSnapshot(
    terminalId: string,
    options?: TerminalPresentationSnapshotOptions
  ): Promise<TerminalPresentationSnapshot> {
    const presentation = this.presentation(terminalId);
    if (!presentation) {
      return Promise.resolve({ buffer: '', ...this.getPresentationMetadata(terminalId) });
    }
    return presentation.snapshot(options);
  }

  /** Output of this generation after `seq`, or null if a snapshot is needed instead. */
  getOutputSince(
    terminalId: string,
    generation: number,
    seq: number
  ): TerminalOutputChunk[] | null {
    const presentation = this.presentation(terminalId);
    if (!presentation || presentation.metadata().generation !== generation) return null;
    return presentation.outputSince(seq);
  }

  getPresentationGeneration(terminalId: string): number {
    return this.terminalGenerations.get(terminalId) ?? 0;
  }

  getPresentationMetadata(terminalId: string): TerminalPresentationMetadata {
    const presentation = this.presentation(terminalId);
    if (presentation) return presentation.metadata();
    if (!this.terminalPresentationTrackingEnabled) {
      throw new Error(`terminal presentation not found for ${terminalId}`);
    }
    // No running PTY: an empty screen until its next spawn starts a new
    // generation and notifies reset listeners. Generation 0 means never spawned.
    const size = this.remoteSize(terminalId) ??
      this.localTerminalSizes.get(terminalId) ??
      this.pendingSizes.get(terminalId) ?? { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };
    return {
      ...size,
      generation: this.terminalGenerations.get(terminalId) ?? 0,
      seq: this.terminalLastSeq.get(terminalId) ?? 0,
    };
  }

  getStatus(terminalId: string): TerminalStatus | null {
    const process = this.processes.get(terminalId);
    return process?.status || null;
  }

  isRunning(terminalId: string): boolean {
    const process = this.processes.get(terminalId);
    return process?.status === 'running';
  }

  /** PID of the terminal's shell, the root of every process started in it. */
  getPid(terminalId: string): number | undefined {
    return this.processes.get(terminalId)?.pty.pid;
  }

  /**
   * Kill every PTY and wait for each child's native exit event to be delivered
   * before resolving. Use this on app shutdown — racing pty.kill() against
   * app.quit() lets node-pty's exit ThreadSafeFunction fire during Node's
   * Environment cleanup, which throws and aborts.
   *
   * Per-terminal `kill()` keeps its existing immediate semantics for user-driven
   * close; this method does not delete from `this.processes` synchronously, so
   * `handleExit()` can run normally when the real exit lands.
   */
  killAll(): Promise<void> {
    this.shuttingDown = true;
    const promises: Promise<void>[] = [];
    for (const [terminalId, proc] of this.processes) {
      if (proc.startupTimeoutId) {
        clearTimeout(proc.startupTimeoutId);
        proc.startupTimeoutId = null;
      }
      if (proc.pendingCommandTimeoutId) {
        clearTimeout(proc.pendingCommandTimeoutId);
        proc.pendingCommandTimeoutId = null;
      }
      // Never pause again: the program may still be writing as it exits.
      this.resetFlowControl(proc, false);

      const exitPromise = new Promise<void>((resolve) => {
        let escalateTimer: NodeJS.Timeout | null = null;
        let abandonTimer: NodeJS.Timeout | null = null;

        const finalize = (): void => {
          if (escalateTimer) clearTimeout(escalateTimer);
          if (abandonTimer) clearTimeout(abandonTimer);
          this.shutdownExitResolvers.delete(terminalId);
          resolve();
        };

        this.shutdownExitResolvers.set(terminalId, finalize);

        // Stage 1: SIGHUP didn't reap the child within the grace period.
        // Escalate to SIGKILL (POSIX only — node-pty's Windows backend rejects
        // any signal argument, and its default kill() already calls
        // TerminateProcess so escalation has nothing to add). Then give the
        // kernel one more short window to deliver the native exit event
        // before we give up.
        escalateTimer = setTimeout(() => {
          escalateTimer = null;
          if (process.platform !== 'win32') {
            logger.warn('PTY did not exit after SIGHUP, escalating to SIGKILL', {
              terminalId,
            });
            try {
              proc.pty.kill('SIGKILL');
            } catch (err) {
              logger.warn('SIGKILL escalation failed', {
                terminalId,
                error: String(err),
              });
            }
          } else {
            logger.warn('PTY did not exit after kill on Windows, waiting on grace window', {
              terminalId,
            });
          }

          abandonTimer = setTimeout(() => {
            abandonTimer = null;
            logger.warn(
              'PTY exit event never arrived — abandoning wait. Subsequent app teardown may race a pending TSFN.',
              { terminalId }
            );
            finalize();
          }, SHUTDOWN_FORCE_KILL_GRACE_MS);
        }, SHUTDOWN_EXIT_TIMEOUT_MS);
      });
      promises.push(exitPromise);

      try {
        proc.pty.kill();
      } catch (err) {
        logger.warn('PTY kill failed during shutdown', {
          terminalId,
          error: String(err),
        });
        const resolver = this.shutdownExitResolvers.get(terminalId);
        if (resolver) {
          resolver();
        }
      }
    }
    return Promise.all(promises).then(() => undefined);
  }

  getDiagnostics(): {
    processCount: number;
    startingCount: number;
    runningCount: number;
    stoppedCount: number;
    outputBufferBytes: number;
    terminalWindowBindings: number;
  } {
    let startingCount = 0;
    let runningCount = 0;
    let stoppedCount = 0;
    for (const process of this.processes.values()) {
      if (process.status === 'starting') startingCount++;
      else if (process.status === 'running') runningCount++;
      else stoppedCount++;
    }

    let outputBufferBytes = 0;
    for (const buffer of this.outputBuffers.values()) {
      outputBufferBytes += Buffer.byteLength(buffer.toString(), 'utf-8');
    }

    return {
      processCount: this.processes.size,
      startingCount,
      runningCount,
      stoppedCount,
      outputBufferBytes,
      terminalWindowBindings: this.terminalToWindow.size,
    };
  }
}

export const ptyService = new PtyService();
