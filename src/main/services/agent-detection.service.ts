import { execFile, spawn } from 'child_process';
import { accessSync, constants, statSync } from 'fs';
import path from 'path';

import { createLogger } from '../lib/logger';
import { buildTerminalEnv, getShell } from '../lib/shell';
import { getWslShellArgs, isWslMode } from '../lib/wsl';

import { configService } from './config.service';

import type { AgentPreset } from '../../shared/types';

const logger = createLogger('AgentDetection');

// Executable names go into a shell script, so anything else is left out.
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FOUND_MARKER = '__komla_agent_found__';
const FOUND_LINE = new RegExp(`${FOUND_MARKER} ([A-Za-z0-9._-]+)`, 'g');
// Interactive login shells with heavy rc files can take a few seconds to start.
const PROBE_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;

/**
 * Other programs that share an agent's executable name, told apart by what `--version`
 * prints:
 * - pressly/goose, a Go database migration tool, prints "goose version: v3.28.0", while
 *   Block's goose prints just its version.
 * - The AWS Copilot CLI prints "copilot version: v1.34.0", GitHub's "GitHub Copilot CLI 1.0.98.".
 * - The Amp text editor has no `--version` and fails to open a terminal without one, while
 *   Amp starts with its version. No output at all keeps the agent: without a shell, native
 *   Windows can't run npm's shims.
 */
const LOOKALIKE_VERSIONS: Record<string, (versionOutput: string) => boolean> = {
  goose: (output) => /^goose version:/m.test(output),
  copilot: (output) => /^copilot version:/m.test(output),
  amp: (output) => output.trim() !== '' && !/^\d+\.\d+\.\d+/m.test(output),
};

/** Whether `--version` output shows the executable is another program with an agent's name. */
export function isLookalike(executable: string, versionOutput: string): boolean {
  return LOOKALIKE_VERSIONS[executable]?.(versionOutput) ?? false;
}

type AgentTemplate = Pick<AgentPreset, 'name' | 'openCommand'>;

/** The program a template launches, or null for templates without one (Shell Only, Custom). */
export function templateExecutable(openCommand: string): string | null {
  const executable = openCommand.trim().split(/\s+/)[0];
  return executable && EXECUTABLE_NAME.test(executable) ? executable : null;
}

/**
 * A script that prints a marker for each executable the shell resolves, followed by the
 * `--version` output of names other programs share. It sticks to syntax that bash, zsh,
 * dash and fish all run, and ends on `true` so a missing last executable doesn't fail the
 * probe. Version checks run last, so one that hangs only costs its own agent.
 *
 * In a WSL distro, `skipWindowsDrives` leaves out what resolves under /mnt/c and the like:
 * WSL adds the Windows PATH to the distro's, where npm's shims for Windows can't run.
 */
export function buildProbeScript(
  executables: string[],
  { skipWindowsDrives = false }: { skipWindowsDrives?: boolean } = {}
): string {
  const ordered = [
    ...executables.filter((executable) => !LOOKALIKE_VERSIONS[executable]),
    ...executables.filter((executable) => LOOKALIKE_VERSIONS[executable]),
  ];
  return [
    ...ordered.map((executable) => {
      const resolves = skipWindowsDrives
        ? `command -v ${executable} 2>/dev/null | grep -qv '^/mnt/[a-zA-Z]/'`
        : `command -v ${executable} >/dev/null 2>&1`;
      const found = `${resolves} && echo ${FOUND_MARKER} ${executable}`;
      return LOOKALIKE_VERSIONS[executable]
        ? `${found} && ${executable} --version </dev/null 2>&1`
        : found;
    }),
    'true',
  ].join('; ');
}

/** Reads the markers out of the probe's output; rc files may print anything around them. */
export function parseProbeOutput(stdout: string, executables: string[]): Set<string> {
  const requested = new Set(executables);
  const found = new Set<string>();
  const matches = [...stdout.matchAll(FOUND_LINE)];
  matches.forEach((match, index) => {
    const executable = match[1];
    // What an executable printed runs up to the next marker.
    const printed = stdout.slice(match.index + match[0].length, matches[index + 1]?.index);
    if (requested.has(executable) && !isLookalike(executable, printed)) found.add(executable);
  });
  return found;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform !== 'win32') accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The executables found in PATH's directories, trying each PATHEXT extension on Windows. */
export function findOnPath(
  executables: string[],
  pathValue: string,
  {
    platform = process.platform,
    pathExt = '.COM;.EXE;.BAT;.CMD',
    isExecutable = isExecutableFile,
  }: {
    platform?: NodeJS.Platform;
    pathExt?: string;
    isExecutable?: (filePath: string) => boolean;
  } = {}
): Set<string> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const directories = pathValue.split(pathApi.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? pathExt.split(';').filter(Boolean) : [''];
  const found = new Set<string>();
  for (const executable of executables) {
    const isFound = directories.some((directory) =>
      extensions.some((extension) => isExecutable(pathApi.join(directory, executable + extension)))
    );
    if (isFound) found.add(executable);
  }
  return found;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * Asks the shell Komla's terminals start, so PATH entries from .zshrc, .bashrc, nvm and the
 * like count, and aliases and functions resolve as they do when an agent launches.
 *
 * Off Windows the shell runs in a session of its own. Without a controlling terminal, an
 * interactive bash can't stop Komla with SIGTTIN when Komla runs as a background job, and
 * since interactive shells ignore SIGTERM, the timeout SIGKILLs the shell and everything
 * it started.
 */
function probeShell(executables: string[], env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const script = buildProbeScript(executables, { skipWindowsDrives: isWslMode() });
  const [file, args] = isWslMode()
    ? ['wsl.exe', [...getWslShellArgs(configService.get().wslDistro), '--', 'bash', '-lic', script]]
    : [getShell(), ['-ilc', script]];
  const ownSession = process.platform !== 'win32';
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseProbeOutput(stdout, executables));
    };
    // Input is /dev/null, so an rc file that reads input doesn't hang the probe.
    const child = spawn(file, args, {
      env,
      detached: ownSession,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      logger.debug('Agent probe shell timed out');
      try {
        if (ownSession && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish();
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.on('error', (error) => {
      logger.debug('Agent probe shell failed to start', { error: error.message });
      finish();
    });
    child.on('close', (code) => {
      if (code) logger.debug('Agent probe shell exited with an error', { code });
      finish();
    });
  });
}

function versionOutput(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      ['--version'],
      { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (_error, stdout, stderr) => resolve(`${stdout ?? ''}${stderr ?? ''}`)
    );
    child.stdin?.end();
  });
}

async function findExecutables(executables: string[]): Promise<Set<string>> {
  const env = buildTerminalEnv();
  const pathValue = envValue(env, 'PATH') ?? '';
  // Native Windows terminals run PowerShell, which finds programs on PATH alone.
  if (process.platform === 'win32' && !isWslMode()) {
    const found = findOnPath(executables, pathValue, { pathExt: envValue(env, 'PATHEXT') });
    for (const executable of found) {
      if (isLookalike(executable, await versionOutput(executable, env))) found.delete(executable);
    }
    return found;
  }
  // Komla's own PATH also reaches its terminals, so it counts when the shell probe can't run.
  // Under WSL it is the Windows PATH, which the agents in the distro don't use. Names other
  // programs share count only once the shell has checked their version.
  const onPath = isWslMode()
    ? []
    : [...findOnPath(executables, pathValue)].filter(
        (executable) => !LOOKALIKE_VERSIONS[executable]
      );
  const inShell = await probeShell(executables, env);
  return new Set([...onPath, ...inShell]);
}

/** Names of the templates whose agent CLI is installed, in template order. */
export async function detectInstalledAgents(templates: AgentTemplate[]): Promise<string[]> {
  const executables = [
    ...new Set(templates.map((template) => templateExecutable(template.openCommand))),
  ].filter((executable): executable is string => executable !== null);
  if (executables.length === 0) return [];
  try {
    const found = await findExecutables(executables);
    return templates
      .filter((template) => {
        const executable = templateExecutable(template.openCommand);
        return executable !== null && found.has(executable);
      })
      .map((template) => template.name);
  } catch (error) {
    logger.warn('Agent detection failed', { error: String(error) });
    return [];
  }
}
