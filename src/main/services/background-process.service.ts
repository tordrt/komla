import { spawn as cpSpawn } from 'child_process';

import * as pty from 'node-pty';

import { createLogger } from '../lib/logger';
import { powerShellCommandArgs } from '../lib/powershell-native-arguments';
import { buildTerminalEnv, getShell, getShellArgs } from '../lib/shell';

import { configService } from './config.service';

const logger = createLogger('BackgroundProcessService');

interface TrackedProcess {
  pty: pty.IPty;
  workspaceId: string;
  name: string;
  exited: boolean;
  pendingCommandTimeoutId: NodeJS.Timeout | null;
}

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3000;

// Delay after last shell output before writing the pending command (see
// pty.service.ts for the full rationale: canonical mode MAX_CANON truncation).
const PENDING_COMMAND_SETTLE_MS = 150;

// Fallback timeout for writing the startup command when the shell never emits
// output via onData (e.g. a minimal shell with no prompt).
const SHELL_READY_FALLBACK_MS = 5000;

export interface BackgroundProcessCallbacks {
  onData?: (data: string) => void;
  onExit?: (event: { exitCode: number; signal?: number }) => void;
}

class BackgroundProcessService {
  private processes: Map<string, TrackedProcess[]> = new Map();

  /**
   * Spawn a background process using a real PTY (same shell, env, and login
   * shell flags as visible terminals) and track it for cleanup.
   *
   * The command should be self-terminating — the shell exits automatically when
   * the command finishes. Do not use this for long-running/interactive processes
   * that never exit on their own (e.g. `tail -f`, watch loops); those belong
   * in a visible terminal pane instead.
   */
  spawn(
    workspaceId: string,
    command: string,
    cwd: string,
    name: string,
    callbacks?: BackgroundProcessCallbacks
  ): pty.IPty {
    const shell = getShell();
    const shellArgs = getShellArgs(configService.get().wslDistro);
    const isPowerShell = /(?:^|[/\\])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell);
    const completionCommand = isPowerShell
      ? `$global:LASTEXITCODE = $null; ${command}; $komlaSetupSucceeded = $?; $komlaSetupExitCode = $LASTEXITCODE; if ($null -eq $komlaSetupExitCode) { $komlaSetupExitCode = if ($komlaSetupSucceeded) { 0 } else { 1 } }; exit $komlaSetupExitCode`
      : `${command}; exit $?`;
    // PowerShell runs the command from its arguments when they fit on a Windows
    // command line. Other shells and longer commands get it typed in.
    const commandArgs = isPowerShell
      ? powerShellCommandArgs(shell, shellArgs, completionCommand)
      : null;

    const env = buildTerminalEnv();

    const ptyProcess = pty.spawn(shell, commandArgs ?? shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    });

    const tracked: TrackedProcess = {
      pty: ptyProcess,
      workspaceId,
      name,
      exited: false,
      pendingCommandTimeoutId: null,
    };

    // Get or create the array for this workspace
    let workspaceProcesses = this.processes.get(workspaceId);
    if (!workspaceProcesses) {
      workspaceProcesses = [];
      this.processes.set(workspaceId, workspaceProcesses);
    }
    workspaceProcesses.push(tracked);

    logger.debug(`Spawned background process "${name}" for workspace ${workspaceId}`, {
      pid: ptyProcess.pid,
      commandLength: command.length,
    });

    // Debounce command write: wait for shell output to settle so the line
    // editor has switched from canonical mode (MAX_CANON limit) to raw mode.
    let commandWritten = commandArgs !== null;
    const scheduleWrite = () => {
      if (commandWritten || tracked.exited) return;
      // Clear both the settle timer and the global fallback
      if (tracked.pendingCommandTimeoutId) {
        clearTimeout(tracked.pendingCommandTimeoutId);
      }
      tracked.pendingCommandTimeoutId = setTimeout(() => {
        if (!commandWritten && !tracked.exited) {
          commandWritten = true;
          tracked.pendingCommandTimeoutId = null;
          ptyProcess.write(`${completionCommand}\r`);
        }
      }, PENDING_COMMAND_SETTLE_MS);
    };

    // Each output event resets the settle timer (drains output too).
    ptyProcess.onData((data) => {
      callbacks?.onData?.(data);
      scheduleWrite();
    });

    // Fallback: if the shell never emits output, write the command after a timeout
    if (!commandWritten) {
      tracked.pendingCommandTimeoutId = setTimeout(() => {
        if (!commandWritten && !tracked.exited) {
          commandWritten = true;
          tracked.pendingCommandTimeoutId = null;
          ptyProcess.write(`${completionCommand}\r`);
        }
      }, SHELL_READY_FALLBACK_MS);
    }

    // Auto-remove from tracking when process exits naturally
    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.debug(`Background process "${name}" exited`, {
        pid: ptyProcess.pid,
        exitCode,
        signal,
      });
      tracked.exited = true;
      callbacks?.onExit?.({ exitCode, signal });
      if (tracked.pendingCommandTimeoutId) {
        clearTimeout(tracked.pendingCommandTimeoutId);
        tracked.pendingCommandTimeoutId = null;
      }
      this.removeProcess(workspaceId, ptyProcess);
    });

    return ptyProcess;
  }

  /**
   * Remove a process from tracking (called on natural exit).
   */
  private removeProcess(workspaceId: string, ptyProcess: pty.IPty): void {
    const workspaceProcesses = this.processes.get(workspaceId);
    if (!workspaceProcesses) return;

    const index = workspaceProcesses.findIndex((t) => t.pty === ptyProcess);
    if (index !== -1) {
      workspaceProcesses.splice(index, 1);
    }

    // Clean up empty arrays
    if (workspaceProcesses.length === 0) {
      this.processes.delete(workspaceId);
    }
  }

  /**
   * Kill all background processes for a specific workspace.
   */
  killForWorkspace(workspaceId: string): void {
    const workspaceProcesses = this.processes.get(workspaceId);
    if (!workspaceProcesses || workspaceProcesses.length === 0) {
      return;
    }

    logger.debug(
      `Killing ${workspaceProcesses.length} background process(es) for workspace ${workspaceId}`
    );

    for (const tracked of workspaceProcesses) {
      this.killProcessTree(tracked);
    }

    this.processes.delete(workspaceId);
  }

  /**
   * Like killForWorkspace, but skips the SIGTERM grace period and waits for
   * processes to actually exit. Used when the workspace's worktree is about
   * to be removed from disk — otherwise a still-live shell with cwd inside
   * the deleted directory emits `shell-init: getcwd` warnings and breaks any
   * in-flight subprocess (e.g. git push).
   */
  async killForWorkspaceAndWait(workspaceId: string): Promise<void> {
    const workspaceProcesses = this.processes.get(workspaceId);
    if (!workspaceProcesses || workspaceProcesses.length === 0) {
      return;
    }

    logger.debug(
      `Killing ${workspaceProcesses.length} background process(es) for workspace ${workspaceId} (immediate)`
    );

    await Promise.all(workspaceProcesses.map((tracked) => this.killAndAwaitExit(tracked)));
    this.processes.delete(workspaceId);
  }

  private killAndAwaitExit(tracked: TrackedProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (tracked.exited) {
        resolve();
        return;
      }

      if (tracked.pendingCommandTimeoutId) {
        clearTimeout(tracked.pendingCommandTimeoutId);
        tracked.pendingCommandTimeoutId = null;
      }

      let settled = false;
      let safety: NodeJS.Timeout | null = null;
      let disposable: { dispose: () => void } | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (safety) clearTimeout(safety);
        disposable?.dispose();
        resolve();
      };

      safety = setTimeout(() => {
        logger.debug(`Process "${tracked.name}" did not exit within 1s, continuing`);
        finish();
      }, 1000);

      disposable = tracked.pty.onExit(() => {
        finish();
      });

      const pid = tracked.pty.pid;
      try {
        if (process.platform === 'win32') {
          if (pid) {
            cpSpawn('taskkill', ['/F', '/T', '/PID', pid.toString()], { stdio: 'ignore' });
          }
        } else {
          tracked.pty.kill('SIGKILL');
        }
      } catch {
        finish();
      }
    });
  }

  /** Kills one process, such as a background Action the user stops, and waits for it to exit. */
  async stop(ptyProcess: pty.IPty): Promise<void> {
    const tracked = this.processes
      .get(this.findWorkspaceId(ptyProcess) ?? '')
      ?.find((candidate) => candidate.pty === ptyProcess);
    if (tracked) await this.killAndAwaitExit(tracked);
  }

  private findWorkspaceId(ptyProcess: pty.IPty): string | undefined {
    for (const [workspaceId, processes] of this.processes) {
      if (processes.some((tracked) => tracked.pty === ptyProcess)) return workspaceId;
    }
    return undefined;
  }

  /**
   * Kill all tracked background processes (called on app exit).
   */
  killAll(): void {
    const totalCount = Array.from(this.processes.values()).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    if (totalCount === 0) return;

    logger.debug(`Killing all ${totalCount} background process(es)`);

    for (const [, workspaceProcesses] of this.processes) {
      for (const tracked of workspaceProcesses) {
        this.killProcessTree(tracked);
      }
    }

    this.processes.clear();
  }

  /**
   * Kill a process and its entire process tree.
   * Uses platform-specific approaches for best coverage.
   */
  private killProcessTree(tracked: TrackedProcess): void {
    const { pty: ptyProcess, name, exited } = tracked;
    const pid = ptyProcess.pid;

    // Clear pending command timeout
    if (tracked.pendingCommandTimeoutId) {
      clearTimeout(tracked.pendingCommandTimeoutId);
      tracked.pendingCommandTimeoutId = null;
    }

    if (!pid) {
      logger.debug(`Process "${name}" has no PID, skipping kill`);
      return;
    }

    // Check if already exited
    if (exited) {
      logger.debug(`Process "${name}" already exited, skipping kill`);
      return;
    }

    logger.debug(`Killing process tree for "${name}"`, { pid });

    try {
      if (process.platform === 'win32') {
        // Windows: use taskkill with /T to kill tree
        cpSpawn('taskkill', ['/F', '/T', '/PID', pid.toString()], {
          stdio: 'ignore',
        });
      } else {
        // Unix: first try SIGTERM for graceful shutdown
        ptyProcess.kill('SIGTERM');

        // Set up fallback SIGKILL after timeout
        setTimeout(() => {
          if (!tracked.exited) {
            logger.debug(`Process "${name}" didn't respond to SIGTERM, sending SIGKILL`, { pid });
            try {
              ptyProcess.kill('SIGKILL');
            } catch {
              // Process may have exited between check and kill
            }
          }
        }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      }
    } catch (error) {
      // Process may have already exited
      logger.debug(`Error killing process "${name}":`, error);
    }
  }

  /**
   * Get the number of tracked processes (useful for testing).
   */
  getProcessCount(): number {
    return Array.from(this.processes.values()).reduce((sum, arr) => sum + arr.length, 0);
  }

  getWorkspaceCount(): number {
    return this.processes.size;
  }

  /**
   * Get the running processes for a workspace.
   */
  getProcessesForWorkspace(workspaceId: string): TrackedProcess[] {
    return this.processes.get(workspaceId) || [];
  }
}

export const backgroundProcessService = new BackgroundProcessService();
