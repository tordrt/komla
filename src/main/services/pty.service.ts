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
import {
  exitWaiters,
  isCurrent,
  liveHolds,
  nextPtyPhase,
  reportedStatus,
  type LiveHolds,
  type PendingCommand,
  type PtyEvent,
  type PtyPhase,
  type PtyStartupMode,
} from '../lib/pty-phase';
import { buildTerminalEnv, getShell, getShellArgs } from '../lib/shell';
import { addToShellHistoryCommand } from '../lib/shell-history';
import { isZshShell } from '../lib/shell-kind';
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
import { terminalText, type TerminalText } from '../lib/terminal-text';
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
/** How long `komla send` waits after pasting before it presses Enter. */
const SUBMIT_AFTER_PASTE_MS = 100;
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

// A shell that draws its prompt at a size its view doesn't have draws it again when the view's
// size arrives, and bash then leaves part of the first prompt above the second. So a program
// spawned without a current size is held stopped until the next size arrives, or until this
// long has passed for a terminal no view shows.
const SIZE_WAIT_MS = 1000;

export type { TerminalStatus };

interface PtyProcess {
  pty: pty.IPty;
  terminalId: string;
  lastOutput: string;
  /** Written only by PtyService.advance(). */
  phase: PtyPhase;
  windowId: number | null; // Track which window owns this terminal
  startupMode: PtyStartupMode;
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
  // PTYs in the 'exiting' phase: their terminals let go of them, and node-pty hasn't reported
  // their exit yet. Kept in step with the phase by advance().
  private exitingProcesses: Set<PtyProcess> = new Set();
  // Set by killAll(): programs may still be writing as they exit, so a renderer's report no longer
  // turns pausing on, for a PTY spawned after it too.
  private shuttingDown = false;
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

  /** (Re)starts the wait before typing in a live PTY's startup command. */
  private schedulePendingCommandWrite(proc: PtyProcess, delayMs: number): void {
    const holds = liveHolds(proc.phase);
    const command = holds?.command;
    if (!holds || !command) return;
    if (command.timer) clearTimeout(command.timer);
    // Leaving the live phases clears the timer, so it fires only while the command is pending.
    command.timer = setTimeout(() => {
      command.timer = null;
      this.flushPendingCommand(proc, holds, command);
    }, delayMs);
  }

  private flushPendingCommand(proc: PtyProcess, holds: LiveHolds, command: PendingCommand): void {
    if (this.writeToPty(proc, `${command.text}\r`)) {
      holds.command = null;
      return;
    }

    command.attempts += 1;
    if (command.attempts >= MAX_PENDING_COMMAND_WRITE_ATTEMPTS) {
      logger.error('Dropping pending command after repeated PTY write failures', {
        terminalId: proc.terminalId,
        attempts: command.attempts,
      });
      holds.command = null;
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
    cols?: number,
    rows?: number,
    startupMode: PtyStartupMode = 'echo-command',
    localLoginShell = true,
    addToHistory = false
  ): void {
    this.refuseWhileQuitting();
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
    const isZsh = isZshShell(shell);
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
      // Up arrow in the shell the command hands over to brings the command back, as if typed.
      const historyCommand = addToHistory ? addToShellHistoryCommand(shell, startupCommand) : null;
      const parts = [
        echoCommand,
        historyCommand,
        handoffFunction,
        'trap __komla_action_handoff INT',
      ].filter((part): part is string => part !== null);
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

    const { initialSize, sized } = this.takeSpawnSize(terminalId, cols, rows);
    const spawnOptions = {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd,
      env,
    };
    const { ptyProcess, bundledConpty } = spawnPty(spawnShell, spawnArgs, spawnOptions, terminalId);

    const starting: Extract<PtyPhase, { kind: 'starting' }> = {
      kind: 'starting',
      startupTimer: null,
      holds: {
        sizeWait: null,
        command: pendingCommand ? { text: pendingCommand, timer: null, attempts: 0 } : null,
      },
    };
    const processInfo: PtyProcess = {
      pty: ptyProcess,
      terminalId,
      lastOutput: '',
      phase: starting,
      windowId: windowId ?? null,
      startupMode,
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
    this.holdUntilSized(processInfo, starting.holds, sized);

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
      this.handleExit(processInfo, exitCode, signal);
    });

    // Local shells may be silent after startup, so do not leave their loading
    // state up indefinitely. SSH waits for the remote launcher marker so local
    // prompts and command echoes cannot finish the connection handoff.
    if (startupMode === 'echo-command') {
      // Leaving 'starting' clears it, so it fires only while the PTY is still starting.
      starting.startupTimer = setTimeout(() => {
        starting.startupTimer = null;
        this.advance(processInfo, { kind: 'ready', signal: 'startup-timeout' });
      }, STARTUP_TIMEOUT_MS);
    }

    // Fallback for typed commands: write the pending command if the shell never emits output
    this.schedulePendingCommandWrite(processInfo, SHELL_READY_FALLBACK_MS);
  }

  /**
   * The size a terminal's PTY starts at: a remote presentation's, a size the desktop sent before
   * the spawn, the caller's, or the desktop's last one for this terminal, else the fallback. Only
   * the first three count as current; a PTY started at another waits for its view's size.
   */
  private takeSpawnSize(
    terminalId: string,
    cols: number | undefined,
    rows: number | undefined
  ): { initialSize: { cols: number; rows: number }; sized: boolean } {
    const pendingSize = this.pendingSizes.get(terminalId);
    this.pendingSizes.delete(terminalId);
    const givenSize = cols && rows ? { cols, rows } : undefined;
    const currentSize = pendingSize ?? givenSize;
    const localSize = currentSize ??
      this.localTerminalSizes.get(terminalId) ?? { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };
    this.localTerminalSizes.set(terminalId, localSize);
    const remoteSize = this.remoteSize(terminalId);
    return {
      initialSize: remoteSize ?? localSize,
      sized: Boolean(remoteSize ?? currentSize),
    };
  }

  /** Stops an unsized terminal's program until it has a size; Windows has no signal for it. */
  private holdUntilSized(processInfo: PtyProcess, holds: LiveHolds, sized: boolean): void {
    if (sized || process.platform === 'win32') return;
    processInfo.pty.kill('SIGSTOP');
    holds.sizeWait = setTimeout(() => this.endSizeWait(processInfo), SIZE_WAIT_MS);
  }

  /** Lets a program held by holdUntilSized() run, now that its terminal has a size. */
  private endSizeWait(processInfo: PtyProcess): void {
    const holds = liveHolds(processInfo.phase);
    if (!holds?.sizeWait) return;
    clearTimeout(holds.sizeWait);
    holds.sizeWait = null;
    processInfo.pty.kill('SIGCONT');
  }

  private queueOutput(process: PtyProcess, data: string): void {
    if (process.outputWindowTimer) {
      process.heldOutput += data;
      return;
    }
    this.handleOutput(process, data);
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
    this.handleOutput(process, data);
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

  private handleOutput(process: PtyProcess, data: string): void {
    // A PTY its terminal let go of, such as one a replacement killed, prints nothing to it.
    if (!isCurrent(process.phase)) return;
    const { terminalId } = process;

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

    this.advance(process, { kind: 'ready', signal: 'output' });

    // Debounce the pending command write: wait for shell output to settle so
    // the line editor has time to switch from canonical mode (MAX_CANON = 1024
    // byte limit) to raw mode (no limit).  Each new output event resets the
    // timer, so the command is only written after a quiet period.
    this.schedulePendingCommandWrite(process, PENDING_COMMAND_SETTLE_MS);

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
    if (remoteReady) this.advance(process, { kind: 'ready', signal: 'remote-ready' });
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

  private handleExit(proc: PtyProcess, exitCode: number, signal?: number): void {
    const previous = proc.phase;
    // A shutdown that still waits for this exit reports none of its own. Once it stops waiting,
    // as when the kill failed, the exit is reported like any other.
    const awaitedByShutdown = previous.kind === 'shutting-down' && previous.exitWaiters.size > 0;
    const { terminalId } = proc;
    // The error and exit go out while the terminal still has the PTY, reading 'stopped'.
    const reportExit = (): void => {
      if (exitCode !== 0) {
        const message = `Process exited with code ${exitCode}`;
        this.sendToRenderer(IPC.TERMINAL_ERROR, terminalId, message);
        for (const listener of this.errorListeners) {
          listener(terminalId, message);
        }
      }
      if (!awaitedByShutdown) {
        this.sendToRenderer(IPC.TERMINAL_EXIT, terminalId, exitCode, signal);
      }
    };
    // A PTY its terminal already let go of ends quietly.
    if (!this.advance(proc, { kind: 'exit' }, reportExit) || !isCurrent(previous)) return;

    const exit: PtyExit = {
      exitCode,
      output: this.outputBuffers.get(terminalId)?.toString(EXIT_OUTPUT_CHARS) ?? '',
    };
    this.forgetPty(proc, { keepFocusSuppression: false });

    for (const listener of this.exitListeners) {
      listener(terminalId, exit);
    }
  }

  /**
   * The only writer of a PTY's phase. It ends what the phase it leaves was running, keeps
   * `processes` and `exitingProcesses` in step, and reports the terminal's new status while
   * getStatus() still reads it. `beforeLetGo` reports more while it still does, once the PTY is
   * leaving its terminal.
   */
  private advance(proc: PtyProcess, event: PtyEvent, beforeLetGo?: () => void): boolean {
    const previous = proc.phase;
    const next = nextPtyPhase(previous, event, proc.startupMode);
    if (!next) return false;
    this.leavePhase(proc, previous, next);
    proc.phase = next;

    if (next.kind === 'exiting') this.exitingProcesses.add(proc);
    else this.exitingProcesses.delete(proc);
    if (!isCurrent(previous)) return true;
    const status = reportedStatus(next);
    if (status !== reportedStatus(previous)) this.reportStatus(proc.terminalId, status);
    if (isCurrent(next)) return true;
    beforeLetGo?.();
    this.processes.delete(proc.terminalId);
    return true;
  }

  /** Ends the timers and waits of a phase a PTY leaves that the next phase doesn't carry. */
  private leavePhase(proc: PtyProcess, previous: PtyPhase, next: PtyPhase): void {
    if (previous.kind === 'starting' && previous.startupTimer) {
      clearTimeout(previous.startupTimer);
    }

    const holds = liveHolds(previous);
    if (holds && !liveHolds(next)) {
      if (holds.command?.timer) clearTimeout(holds.command.timer);
      if (holds.sizeWait) {
        clearTimeout(holds.sizeWait);
        // A stopped program wouldn't act on its kill's SIGHUP. Once it has exited, its PID is
        // free again, so nothing may signal it.
        if (next.kind !== 'exited') proc.pty.kill('SIGCONT');
      }
    }

    if (next.kind === 'shutting-down' && previous.kind !== 'shutting-down') {
      // Never pause again: the program may still be writing as it exits.
      this.resetFlowControl(proc, false);
    } else if (isCurrent(previous) && !isCurrent(next)) {
      // node-pty reports a killed program's exit only once it has read the closed socket.
      this.resumeOutput(proc);
    }

    if (next.kind === 'exited') {
      // Each waiter removes itself as it runs, which a Set's iteration allows.
      for (const waiter of exitWaiters(previous) ?? []) waiter();
    }
  }

  /** Drops what a terminal kept for the PTY it no longer has; its seq carries on into the next. */
  private forgetPty(proc: PtyProcess, options: { keepFocusSuppression: boolean }): void {
    const { terminalId } = proc;
    this.terminalLastSeq.set(terminalId, proc.seq);
    this.outputBuffers.delete(terminalId);
    this.terminalPresentations.get(terminalId)?.dispose();
    this.terminalPresentations.delete(terminalId);
    this.terminalToWindow.delete(terminalId);
    if (!options.keepFocusSuppression) this.terminalFocusReportSuppressUntil.delete(terminalId);
    this.terminalOscNotificationStates.delete(terminalId);
    this.emitTitle(terminalId, null);
  }

  private reportStatus(terminalId: string, status: TerminalStatus): void {
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
      if (!isCurrent(proc.phase) || proc.statusReporter === null) return;
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
    this.endSizeWait(process);
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
    const size = this.screenSize(terminalId, process);
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

  /** The size the terminal's program lays its screen out for: a phone's, the pane's, or the PTY's. */
  private screenSize(terminalId: string, process: PtyProcess): { cols: number; rows: number } {
    return (
      this.remoteSize(terminalId) ??
      this.localTerminalSizes.get(terminalId) ?? { cols: process.pty.cols, rows: process.pty.rows }
    );
  }

  kill(terminalId: string): void {
    const process = this.processes.get(terminalId);
    if (!process) return;
    this.terminateProcess(process, true);
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
    this.releaseTerminal(terminalId);
    const exiting = [...this.exitingProcesses].filter((proc) => proc.terminalId === terminalId);
    await Promise.all(exiting.map((proc) => this.waitForExit(proc, 'release').exited));
  }

  /**
   * Waits for node-pty to report the exit of a PTY that was killed. A program that ignores the
   * kill gets SIGKILL after SHUTDOWN_EXIT_TIMEOUT_MS, except on Windows, where node-pty takes no
   * signal and its kill already terminates the program. SHUTDOWN_FORCE_KILL_GRACE_MS later the
   * wait gives up. `stopWaiting` gives up at once.
   */
  private waitForExit(
    proc: PtyProcess,
    waitingFor: 'shutdown' | 'release'
  ): { exited: Promise<void>; stopWaiting: () => void } {
    const waiters = exitWaiters(proc.phase);
    if (!waiters) return { exited: Promise.resolve(), stopWaiting: () => {} };
    const { terminalId } = proc;
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    const giveUp = (): void => {
      logger.warn(
        'PTY exit event never arrived, abandoning wait. What follows may race a pending TSFN.',
        { terminalId, waitingFor }
      );
      stopWaiting();
      // Once the last wait on a PTY its terminal let go of gives up, it counts as gone, so no
      // later wait starts over on it. Other waits keep their own escalation until then.
      if (waiters.size === 0) this.advance(proc, { kind: 'abandon' });
    };
    const escalate = (): void => {
      if (process.platform !== 'win32') {
        logger.warn('PTY did not exit after its kill, escalating to SIGKILL', {
          terminalId,
          waitingFor,
        });
        try {
          proc.pty.kill('SIGKILL');
        } catch (err) {
          logger.warn('SIGKILL escalation failed', { terminalId, waitingFor, error: String(err) });
        }
      } else {
        logger.warn('PTY did not exit after its kill on Windows, waiting on grace window', {
          terminalId,
          waitingFor,
        });
      }
      timer = setTimeout(giveUp, SHUTDOWN_FORCE_KILL_GRACE_MS);
    };
    let timer = setTimeout(escalate, SHUTDOWN_EXIT_TIMEOUT_MS);

    // leavePhase() calls it once the PTY exits; giveUp() and the caller when the wait ends early.
    const stopWaiting = (): void => {
      clearTimeout(timer);
      waiters.delete(stopWaiting);
      resolveExited();
    };
    waiters.add(stopWaiting);
    return { exited, stopWaiting };
  }

  restart(
    terminalId: string,
    cwd: string,
    command: string | null,
    workspaceId?: string,
    cols?: number,
    rows?: number,
    startupMode: PtyStartupMode = 'echo-command',
    localLoginShell = true,
    addToHistory = false
  ): void {
    this.refuseWhileQuitting();
    const process = this.processes.get(terminalId);
    const windowId = process?.windowId ?? this.terminalToWindow.get(terminalId);
    const initialSeq = process?.seq ?? this.terminalLastSeq.get(terminalId) ?? 0;
    this.terminalFocusReportSuppressUntil.set(
      terminalId,
      Date.now() + RESTART_FOCUS_REPORT_SUPPRESS_MS
    );

    if (process) {
      this.terminateProcess(process, false);
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
      localLoginShell,
      addToHistory
    );
    // Its terminal last reported 'stopped', so a replacement reports its reset and new status.
    this.broadcastToAll(IPC.TERMINAL_RESET, terminalId);
    this.reportStatus(terminalId, 'starting');
  }

  /** kill() and Terminal replacement: the terminal lets go of its PTY at once, and kills it. */
  private terminateProcess(proc: PtyProcess, notifyExitListeners: boolean): void {
    // Output still held for coalescing is the program's last; deliver it while it is still the
    // terminal's PTY.
    if (proc.outputWindowTimer) {
      clearTimeout(proc.outputWindowTimer);
      proc.outputWindowTimer = null;
    }
    this.flushHeldOutput(proc);
    this.advance(proc, { kind: 'kill' });
    // A replacement keeps dropping the focus reports a restart can send.
    this.forgetPty(proc, { keepFocusSuppression: !notifyExitListeners });
    // An exit node-pty reports from inside kill() finds the PTY exiting, so it ends quietly.
    proc.pty.kill();

    if (notifyExitListeners) {
      for (const listener of this.exitListeners) {
        listener(proc.terminalId);
      }
    }
  }

  /**
   * What the running terminal shows as plain text, parsed from its retained output at its size,
   * with up to `history` lines above the screen; undefined when it isn't running here.
   */
  async readText(terminalId: string, history: number): Promise<TerminalText | undefined> {
    const process = this.processes.get(terminalId);
    if (!process) return undefined;
    const output = this.outputBuffers.get(terminalId)?.toString() ?? '';
    return terminalText(output, this.screenSize(terminalId, process), history);
  }

  /**
   * Types text into the terminal and presses Enter, as a person would. Bracketed as one paste
   * when the program asked for that, and Enter follows a moment later, since an agent's input
   * may take a paste's final Enter as a newline.
   */
  async submit(terminalId: string, text: string, bracketed: boolean): Promise<void> {
    // Without a paste, each line goes as typed: Enter is a carriage return.
    this.write(terminalId, bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\n/g, '\r'));
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_AFTER_PASTE_MS));
    this.write(terminalId, '\r');
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
    return process ? reportedStatus(process.phase) : null;
  }

  isRunning(terminalId: string): boolean {
    const process = this.processes.get(terminalId);
    return process !== undefined && reportedStatus(process.phase) === 'running';
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
   * close; here each PTY moves to 'shutting-down' and stays its terminal's, so
   * `handleExit()` can run normally when the real exit lands. PTYs already
   * exiting are waited for too, since their exit event is just as pending.
   */
  /**
   * A window closing at quit can still ask for a terminal once killAll() ran. Nothing would kill
   * that PTY, and node-pty's thread waiting for its exit would keep Komla from exiting.
   */
  private refuseWhileQuitting(): void {
    if (this.shuttingDown) throw new Error('Komla is quitting, so it starts no terminal');
  }

  killAll(): Promise<void> {
    this.shuttingDown = true;
    const exits: Promise<void>[] = [];
    for (const proc of this.processes.values()) {
      this.advance(proc, { kind: 'shutdown' });
      const { exited, stopWaiting } = this.waitForExit(proc, 'shutdown');
      exits.push(exited);
      try {
        proc.pty.kill();
      } catch (err) {
        logger.warn('PTY kill failed during shutdown', {
          terminalId: proc.terminalId,
          error: String(err),
        });
        stopWaiting();
      }
    }
    // PTYs kill() or a replacement already let go of are children whose exit is still pending.
    for (const proc of this.exitingProcesses) {
      exits.push(this.waitForExit(proc, 'shutdown').exited);
    }
    return Promise.all(exits).then(() => undefined);
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
      const status = reportedStatus(process.phase);
      if (status === 'starting') startingCount++;
      else if (status === 'running') runningCount++;
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
