import { execFile } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { delimiter, dirname, join, posix } from 'path';

import { app } from 'electron';

import { getKomlaBasePath } from '../services/paths';

import { createLogger } from './logger';

const logger = createLogger('KomlaCli');

let cliBlocked = false;

export type KomlaBinaryTarget =
  | 'x86_64-unknown-linux-musl'
  | 'aarch64-unknown-linux-musl'
  | 'x86_64-apple-darwin'
  | 'aarch64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc';

export function resolveKomlaBinaryTarget(
  operatingSystem: string,
  architecture: string
): KomlaBinaryTarget | undefined {
  const os = operatingSystem.trim().toLowerCase();
  const arch = architecture.trim().toLowerCase();
  const normalizedArch = ['amd64', 'x64', 'x86_64'].includes(arch) ? 'x86_64' : arch;
  if (os === 'linux' && normalizedArch === 'x86_64') return 'x86_64-unknown-linux-musl';
  if (os === 'linux' && ['aarch64', 'arm64'].includes(normalizedArch)) {
    return 'aarch64-unknown-linux-musl';
  }
  if ((os === 'darwin' || os === 'macos') && normalizedArch === 'x86_64') {
    return 'x86_64-apple-darwin';
  }
  if ((os === 'darwin' || os === 'macos') && ['aarch64', 'arm64'].includes(normalizedArch)) {
    return 'aarch64-apple-darwin';
  }
  if ((os === 'win32' || os === 'windows_nt') && normalizedArch === 'x86_64') {
    return 'x86_64-pc-windows-msvc';
  }
  if ((os === 'win32' || os === 'windows_nt') && ['aarch64', 'arm64'].includes(normalizedArch)) {
    return 'aarch64-pc-windows-msvc';
  }
  return undefined;
}

export function resolveKomlaArtifactRoot(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'native')
    : join(options.appPath, 'native', 'artifacts');
}

export function getKomlaArtifactRoot(): string {
  return resolveKomlaArtifactRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

function artifactPath(target: KomlaBinaryTarget): string {
  return join(
    getKomlaArtifactRoot(),
    target,
    target.endsWith('-windows-msvc') ? 'komla.exe' : 'komla'
  );
}

function executableSignature(path: string): string {
  const stat = statSync(path);
  return JSON.stringify([path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]);
}

function copyExecutable(source: string, destination: string): void {
  // Compare metadata instead of reading/hashing both binaries on every launch.
  // Include the installed file so deletion, edits, and permission changes repair it.
  const sourceSignature = executableSignature(source);
  const statePath = `${destination}.install-state.json`;
  try {
    const currentState = JSON.stringify([sourceSignature, executableSignature(destination)]);
    if (readFileSync(statePath, 'utf8') === currentState) return;
  } catch {
    // Missing installation or cache: install normally.
  }

  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.new.${process.pid}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }

  try {
    writeFileSync(statePath, JSON.stringify([sourceSignature, executableSignature(destination)]));
  } catch (error) {
    // The binary is usable even if caching fails; the next launch will retry.
    logger.debug('Failed to cache Komla CLI installation metadata', { error: String(error) });
  }
}

function installWslCliShim(windowsCliPath: string): void {
  const shimPath = windowsCliPath.replace(/\.exe$/i, '');
  const temporary = `${shimPath}.new.${process.pid}`;
  try {
    writeFileSync(temporary, '#!/bin/sh\nexec "$(dirname "$0")/komla.exe" "$@"\n', {
      mode: 0o755,
    });
    chmodSync(temporary, 0o755);
    renameSync(temporary, shimPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Install the shared Komla executable into user-owned paths used by managed
 * terminals. This does not modify the user's shell profile or global PATH.
 */
export function installKomlaCli(): void {
  const target = resolveKomlaBinaryTarget(process.platform, process.arch);
  if (!target) {
    logger.warn('The Komla CLI is not available on this desktop platform', {
      platform: process.platform,
      architecture: process.arch,
    });
    return;
  }
  const source = artifactPath(target);
  if (!existsSync(source)) {
    logger.warn('The Komla CLI artifact is missing', { source });
    return;
  }
  try {
    const cliPath = getKomlaCliPath();
    copyExecutable(source, cliPath);
    if (process.platform === 'win32') {
      installWslCliShim(cliPath);
      probeKomlaCli(cliPath);
    }
    process.env.KOMLA_CLI = cliPath;
  } catch (error) {
    logger.warn('Failed to install the Komla CLI', { error: String(error) });
  }
}

// How Node reports a process Windows refuses to create: UNKNOWN for the application control
// errors libuv doesn't name, EPERM for access denied.
const POLICY_BLOCK_CODES = new Set(['UNKNOWN', 'EPERM']);

/**
 * Starts the CLI once to learn whether this computer lets it run: Windows Smart App Control
 * refuses an unsigned executable it has no verdict for.
 */
export function probeKomlaCli(cliPath: string, timeoutMs = 10_000): boolean {
  try {
    // Windows refuses a blocked executable before it starts, so once it starts, how it
    // exits doesn't matter.
    execFile(cliPath, ['version'], { timeout: timeoutMs, windowsHide: true }, () => {});
    cliBlocked = false;
  } catch (error) {
    // Node throws, rather than calling back, for most errors process creation reports.
    const code = (error as NodeJS.ErrnoException).code;
    cliBlocked = code !== undefined && POLICY_BLOCK_CODES.has(code);
    logger.warn(
      cliBlocked
        ? 'Windows blocks the Komla CLI, so notification hooks run notify.js instead'
        : 'Could not start the Komla CLI to check that Windows lets it run',
      { code, error: String(error) }
    );
  }
  return cliBlocked;
}

/** Whether the last probe found the CLI blocked; notification hooks then run notify.js instead. */
export function isKomlaCliBlocked(): boolean {
  return cliBlocked;
}

/** How a notification update says what its hooks run, ending its sentence. */
export function describeNotifyRunner(): string {
  return cliBlocked
    ? 'notify.js, because Windows blocks the Komla CLI on this computer'
    : 'the Komla CLI';
}

/** What notification hooks run in place of a blocked CLI; Komla writes these files each launch. */
export function getNotifyHelper(): { nodeCommand: string; nodePathFile: string; script: string } {
  const base = getKomlaBasePath();
  return {
    // Runs its arguments with Komla's own executable as Node.
    nodeCommand: join(base, process.platform === 'win32' ? 'komla-node.cmd' : 'komla-node'),
    // Komla's executable path, for a caller that sets ELECTRON_RUN_AS_NODE itself.
    nodePathFile: join(base, 'node-path'),
    script: join(base, 'notify.js'),
  };
}

/**
 * komla-node.cmd, which runs its arguments with Komla's executable as Node. cmd reads a batch
 * file in the console's code page rather than UTF-8, so the part of a path outside ASCII, such
 * as a profile folder in the user's name, comes from the environment.
 */
export function komlaNodeCmd(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  let path = executable;
  if (/[^\x20-\x7e]/.test(path)) {
    for (const name of ['LOCALAPPDATA', 'USERPROFILE']) {
      const prefix = env[name];
      if (prefix && path.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`)) {
        path = `%${name}%${path.slice(prefix.length)}`;
        break;
      }
    }
  }
  return `@set ELECTRON_RUN_AS_NODE=1\r\n@"${path}" %*\r\n`;
}

export function getKomlaCliPath(): string {
  return join(getKomlaBasePath(), 'bin', process.platform === 'win32' ? 'komla.exe' : 'komla');
}

export function addKomlaCliToEnv(
  env: NodeJS.ProcessEnv,
  cliPath = process.env.KOMLA_CLI,
  options: {
    cliExists?: (path: string) => boolean;
    wslPathTranslator?: (path: string) => string;
  } = {}
): NodeJS.ProcessEnv {
  const cliExists = options.cliExists ?? existsSync;
  if (!cliPath || !cliExists(cliPath)) return env;
  if (options.wslPathTranslator) {
    const windowsPathToWsl = options.wslPathTranslator;
    const windowsWslCliPath = cliPath.replace(/\.exe$/i, '');
    if (!cliExists(windowsWslCliPath)) return env;
    const wslCliPath = windowsPathToWsl(windowsWslCliPath);
    const binDirectory = posix.dirname(wslCliPath);
    const linuxEntries = (env.PATH ?? '').split(':').filter(Boolean);
    const windowsEntries = (env.Path ?? '').split(';').filter(Boolean).map(windowsPathToWsl);
    env.KOMLA_CLI = wslCliPath;
    env.PATH = [binDirectory, ...linuxEntries, ...windowsEntries]
      .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
      .join(':');
    delete env.Path;
    return env;
  }
  env.KOMLA_CLI = cliPath;
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const binDirectory = dirname(cliPath);
  const currentPath = env[pathKey] ?? env.PATH ?? '';
  const entries = currentPath.split(delimiter).filter((entry) => entry !== binDirectory);
  env[pathKey] = [binDirectory, ...entries].filter(Boolean).join(delimiter);
  if (pathKey !== 'PATH') delete env.PATH;
  return env;
}
