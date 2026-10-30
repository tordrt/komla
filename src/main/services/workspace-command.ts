import { spawn, type ChildProcess } from 'child_process';
import { posix as pathPosix } from 'path';

import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { isSshWorkspace, type SshWorkspaceBackend } from '../../shared/types';
import { buildTerminalEnv, getShell } from '../lib/shell';
import { getConfiguredShellCommand } from '../lib/shell-command';

import { configService } from './config.service';
import { projectService } from './project.service';
import { sshHostService } from './ssh-host.service';
import { joinRemote, remoteKomlaDataPort, sshWorkspaceService } from './ssh-workspace.service';

import type { Workspace } from '../../shared/types/workspace';

/** How much of a failing command's error output Komla keeps to say why it failed. */
const MAX_ERROR_OUTPUT = 4096;
/** How long a command that ignores SIGTERM after its timeout gets before SIGKILL. */
const KILL_GRACE_MS = 2000;
/** How long Komla waits for output a command left behind after it exited. */
const OUTPUT_DRAIN_MS = 250;
/** Shells that read `PATH=...; export PATH` the way sh does. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'dash', 'ksh', 'zsh', 'zsh5']);

/** How a command Komla ran for a workspace ended without succeeding. */
export class WorkspaceCommandError extends Error {
  constructor(
    message: string,
    readonly timedOut = false
  ) {
    super(message);
  }
}

export interface WorkspaceCommandOptions {
  /** Variables the command gets on top of a terminal's environment. */
  env?: Record<string, string>;
  timeoutMs: number;
  /** Keeps up to this many characters of standard output; without it, output is discarded. */
  maxOutput?: number;
}

/** Names of the workspace's project, its id and name, that a settings file's `projects` match. */
export function workspaceProjectKeys(workspace: Workspace): string[] {
  const project = workspace.projectId ? projectService.get(workspace.projectId) : undefined;
  return project ? [project.id, project.name] : [];
}

/** False while the workspace can't run commands, as when its SSH host is not set up. */
export function canRunWorkspaceCommands(workspace: Workspace): boolean {
  return isSshWorkspace(workspace) ? sshHostService.isReady(workspace.backend.hostId) : true;
}

/** The last line of a failed command's error output. */
function lastLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
}

/**
 * Puts the directory holding the `komla` CLI first on PATH inside the command's shell. Commands run
 * in a login shell, and some login profiles, such as Debian's, set PATH again.
 */
function withCliOnPath(command: string, cliDirectory: string): string {
  return `PATH=${shellQuotePosix(cliDirectory)}:"$PATH"; export PATH; ${command}`;
}

const running = new Set<() => void>();

/** Stops every command still running, as when Komla quits. */
export function stopWorkspaceCommands(): void {
  for (const stop of running) stop();
}

// A command's own processes, such as the node an npm script starts, would outlive its shell, so
// the whole group, or on Windows the whole tree, is stopped.
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // It already exited.
  }
}

/** Runs a command in the workspace's folder on this computer and returns what it printed. */
export function runLocalWorkspaceCommand(
  workspace: Workspace,
  command: string,
  options: WorkspaceCommandOptions
): Promise<string> {
  return runLocalCommand(workspace.workingDirectory, command, options);
}

// Variables that hold a path on this computer, which WSL translates to its own.
const WSL_PATH_VARIABLES = new Set(['KOMLA_PLUGIN_DIR']);

/** WSLENV naming these variables too, as Windows passes only the ones it names into WSL. */
export function wslEnv(current: string | undefined, names: string[]): string {
  const added = names.map((name) => (WSL_PATH_VARIABLES.has(name) ? `${name}/p` : name));
  return [current, ...added].filter(Boolean).join(':');
}

/** Runs a command in a folder on this computer and returns what it printed. */
export function runLocalCommand(
  cwd: string,
  command: string,
  { env = {}, timeoutMs, maxOutput }: WorkspaceCommandOptions
): Promise<string> {
  const fullEnv: NodeJS.ProcessEnv = { ...buildTerminalEnv(), ...env };
  const shellName = pathPosix.basename(getShell().replace(/\\/g, '/')).toLowerCase();
  if (shellName === 'wsl' || shellName === 'wsl.exe') {
    fullEnv.WSLENV = wslEnv(fullEnv.WSLENV, Object.keys(env));
  }
  const script =
    fullEnv.KOMLA_CLI && POSIX_SHELLS.has(shellName)
      ? withCliOnPath(command, pathPosix.dirname(fullEnv.KOMLA_CLI))
      : command;
  const { shell, args } = getConfiguredShellCommand(script, configService.get().wslDistro);

  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd,
      env: fullEnv,
      stdio: ['ignore', maxOutput ? 'pipe' : 'ignore', 'pipe'],
      // Its own process group, so a timeout stops everything it started.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (maxOutput && stdout.length < maxOutput) stdout = (stdout + chunk).slice(0, maxOutput);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_ERROR_OUTPUT);
    });

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killTree(child, 'SIGTERM');
      killTimer ??= setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    running.add(stop);

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      // A SIGKILL already planned still runs: the shell can exit on SIGTERM while what it started
      // ignores it.
      clearTimeout(timer);
      running.delete(stop);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) reject(new WorkspaceCommandError('timed out', true));
      else if (code === 0) resolve(stdout);
      else reject(new WorkspaceCommandError(lastLine(stderr) ?? `exited with ${code ?? signal}`));
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(stop);
      reject(new WorkspaceCommandError(error.message));
    });
    // Something the command left running in the background can hold its output open, so the
    // command ends when its shell exits, once the output it already wrote has been read.
    child.on('exit', (code, signal) => {
      const drain = setTimeout(() => settle(code, signal), OUTPUT_DRAIN_MS);
      child.once('close', () => {
        clearTimeout(drain);
        settle(code, signal);
      });
    });
  });
}

/** The shell lines that let a command on an SSH host run `komla`, as the host's terminals can. */
export function remoteKomlaCliSetup(backend: SshWorkspaceBackend): string[] {
  // Where Komla installs its helpers on the host, as for the host's terminals.
  const helpers = joinRemote(
    pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot)),
    'helpers'
  );
  return [
    // The host reaches this Komla through its SSH tunnel.
    `export KOMLA_API_URL=${shellQuotePosix(`http://127.0.0.1:${remoteKomlaDataPort(backend.hostId)}`)}`,
    `export KOMLA_CLI=${shellQuotePosix(joinRemote(helpers, 'komla'))}`,
    `PATH=${shellQuotePosix(helpers)}:"$PATH"; export PATH`,
  ];
}

/**
 * The script that runs a command on an SSH host: in the workspace's folder, with Komla's helpers
 * on PATH, in a process group of its own that a watchdog stops when the timeout passes.
 */
export function remoteWorkspaceScript(
  backend: SshWorkspaceBackend,
  command: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  keepOutput: boolean
): string {
  const exports = Object.entries(env).map(
    ([name, value]) => `export ${name}=${shellQuotePosix(value)}`
  );
  const run = `sh -c ${shellQuotePosix(command)}${keepOutput ? '' : ' >/dev/null'}`;
  return [
    `cd ${shellQuotePosix(backend.remoteDirectory)} || exit $?`,
    ...exports,
    ...remoteKomlaCliSetup(backend),
    // setsid gives the command a process group of its own on Linux; elsewhere, as on macOS, job
    // control does.
    `if command -v setsid >/dev/null 2>&1; then setsid ${run} & else set -m; ${run} & fi`,
    'pid=$!',
    `(sleep ${timeoutSeconds}; kill -TERM -"$pid"; sleep 2; kill -KILL -"$pid") </dev/null >/dev/null 2>&1 &`,
    'watchdog=$!',
    'wait "$pid"; status=$?',
    'kill "$watchdog" 2>/dev/null',
    'exit "$status"',
  ].join('\n');
}

async function runRemoteWorkspaceCommand(
  workspace: Workspace & { backend: SshWorkspaceBackend },
  command: string,
  { env = {}, timeoutMs, maxOutput }: WorkspaceCommandOptions
): Promise<string> {
  const host = sshWorkspaceService.getHost(workspace.backend.hostId);
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  // The host stops the command at its timeout; this stops the connection should the host not.
  const controller = new AbortController();
  const stop = () => controller.abort();
  const backstop = setTimeout(stop, timeoutSeconds * 1000 + 10_000);
  running.add(stop);
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  try {
    // A streaming run gives its SSH slot back once the command starts, so a long hook doesn't keep
    // Komla's other commands on the host waiting.
    await sshWorkspaceService.runStreaming(
      host,
      remoteWorkspaceScript(workspace.backend, command, env, timeoutSeconds, !!maxOutput),
      {
        signal: controller.signal,
        onData: (chunk) => {
          if (maxOutput && stdout.length < maxOutput) stdout = (stdout + chunk).slice(0, maxOutput);
        },
        onErrorData: (chunk) => {
          stderr = (stderr + chunk).slice(-MAX_ERROR_OUTPUT);
        },
      }
    );
    return stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const stopped = code === 143 || code === 137;
    if (controller.signal.aborted || (stopped && Date.now() - started >= timeoutSeconds * 1000)) {
      throw new WorkspaceCommandError('timed out', true);
    }
    throw new WorkspaceCommandError(
      lastLine(stderr) ?? (error instanceof Error ? error.message : String(error))
    );
  } finally {
    clearTimeout(backstop);
    running.delete(stop);
  }
}

/**
 * Runs a command where the workspace's files are: in its folder on this computer, or on its SSH
 * host. Commands get a terminal's environment, with the `komla` CLI on PATH; a command that runs
 * past its timeout is stopped with everything it started.
 */
export function runWorkspaceCommand(
  workspace: Workspace,
  command: string,
  options: WorkspaceCommandOptions
): Promise<string> {
  return isSshWorkspace(workspace)
    ? runRemoteWorkspaceCommand(workspace, command, options)
    : runLocalWorkspaceCommand(workspace, command, options);
}
