import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

import { addKomlaCliToEnv } from './komla-cli';
import { createLogger } from './logger';
import { isWslMode, getWslShell, getWslShellArgs, windowsPathToWsl } from './wsl';

const logger = createLogger('Shell');

/**
 * Read the current PATH from the Windows registry (Machine + User).
 * Electron's process.env is a snapshot from app launch, so tools installed
 * after Komla started won't appear in the inherited PATH.  Reading from the
 * registry gives us the up-to-date value that a freshly opened PowerShell
 * or cmd.exe would see.
 */
function getFreshWindowsPath(): string | undefined {
  try {
    // System PATH (HKLM) — must always exist on a working Windows install.
    // If we can't read it, bail out entirely to avoid replacing the inherited
    // PATH with something incomplete.
    let systemPath: string | undefined;
    try {
      const result = execFileSync(
        'reg',
        [
          'query',
          'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
          '/v',
          'Path',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }
      );
      const match = result.toString().match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (match) systemPath = match[1].trim();
    } catch (err) {
      logger.debug('System PATH (HKLM) registry query failed', { error: String(err) });
    }

    if (!systemPath) {
      logger.debug('Could not read system PATH from registry, keeping inherited PATH');
      return undefined;
    }

    // User PATH (HKCU) — may legitimately not exist if the user has never
    // added anything to their personal PATH.  Only the system PATH is required.
    let userPath: string | undefined;
    try {
      const result = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 3000,
      });
      const match = result.toString().match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (match) userPath = match[1].trim();
    } catch (err) {
      logger.debug('User PATH (HKCU) registry query failed (may not exist)', {
        error: String(err),
      });
    }

    const combined = userPath ? `${systemPath};${userPath}` : systemPath;

    // Expand %VAR% references (REG_EXPAND_SZ values contain unexpanded variables)
    return combined.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
  } catch (err) {
    logger.debug('Failed to read fresh PATH from registry', { error: String(err) });
    return undefined;
  }
}

/**
 * Build the environment for spawned terminal/PTY processes.
 * Sets terminal type and cleans up stale host-session metadata.
 */
export function buildTerminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Komla',
  };

  // On Windows, refresh PATH from the registry so that tools installed after
  // Komla was launched are discoverable in spawned terminals.
  if (process.platform === 'win32' && !isWslMode()) {
    const freshPath = getFreshWindowsPath();
    if (freshPath) {
      // Remove all case variants of PATH to avoid duplicates — the spread of
      // process.env produces a plain (case-sensitive) object, so both "Path"
      // and "PATH" could coexist.  Keep only a single canonical key.
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path') {
          delete env[key];
        }
      }
      env.Path = freshPath;
    }
  }

  // Prevent nested PTYs from inheriting stale host terminal session metadata
  // (for example Apple Terminal's session restore integration).
  delete env.TERM_SESSION_ID;
  delete env.TERM_PROGRAM_VERSION;
  delete env.KOMLA_WORKSPACE_ID;
  delete env.KOMLA_TERMINAL_ID;
  // App runtime env should not leak into user shells.
  delete env.NODE_ENV;
  delete env.NODE_OPTIONS;
  // A Claude Code session that started Komla says how it runs, which Claude in a terminal keeps,
  // and Komla's hooks drop the hooks of a Claude in print mode or a background session.
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_JOB_DIR;

  return addKomlaCliToEnv(
    env,
    process.env.KOMLA_CLI,
    isWslMode() ? { wslPathTranslator: windowsPathToWsl } : undefined
  );
}

// Looking pwsh up runs where.exe, which blocks the main process; status bar commands and hooks ask
// for the shell every few seconds, so the answer is kept for a minute.
const WINDOWS_SHELL_CACHE_MS = 60_000;
let windowsShell: { path: string; foundAt: number } | undefined;

function findWindowsShell(): string {
  if (windowsShell && Date.now() - windowsShell.foundAt < WINDOWS_SHELL_CACHE_MS) {
    return windowsShell.path;
  }
  let path = 'powershell.exe';
  // Prefer PowerShell 7+ (pwsh) over legacy Windows PowerShell 5.1
  try {
    const result = execFileSync('where.exe', ['pwsh.exe'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    });
    const pwshPath = result.toString().trim().split(/\r?\n/)[0];
    if (pwshPath && existsSync(pwshPath)) {
      path = pwshPath;
    }
  } catch {
    // pwsh not installed, fall back to legacy powershell
  }
  windowsShell = { path, foundAt: Date.now() };
  return path;
}

/**
 * Detect the user's preferred shell.
 */
export function getShell(): string {
  if (process.platform === 'win32') {
    if (isWslMode()) {
      return getWslShell();
    }
    return findWindowsShell();
  }

  // Try common shell locations in order of preference
  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];

  for (const shell of shells) {
    if (shell && existsSync(shell)) {
      return shell;
    }
  }

  // Last resort fallback
  return '/bin/sh';
}

/**
 * Get the shell arguments for spawning a login shell.
 * Uses -l on Unix for login shell (reads profile files).
 * On Windows WSL, uses wsl.exe args with optional distro selection.
 */
export function getShellArgs(wslDistro?: string): string[] {
  if (process.platform === 'win32') {
    return isWslMode() ? getWslShellArgs(wslDistro) : ['-ExecutionPolicy', 'Bypass', '-NoLogo'];
  }
  const shell = getShell();
  // Suppress zsh's PROMPT_SP ('%' marker on first line) for cleaner terminal startup
  if (shell.endsWith('/zsh') || shell.endsWith('/zsh5')) {
    return ['-l', '-o', 'nopromptsp'];
  }
  return ['-l'];
}
