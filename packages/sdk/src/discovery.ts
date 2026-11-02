import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { KomlaError } from './errors.js';

import type { KomlaRoute } from './http.js';

/** The tmux socket Komla runs SSH workspaces' terminals on. */
const MANAGED_TMUX_SOCKET = 'komla-v1';

export interface DiscoveredRoute extends KomlaRoute {
  /**
   * The route came from a managed terminal on an SSH host, whose session another Komla
   * installation may take over, so it is found again before each request.
   */
  refresh: boolean;
}

export interface DiscoverOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  readFile?: (path: string) => Promise<string>;
  /** `tmux show-environment`'s output, or undefined when tmux can't say. */
  tmuxEnvironment?: () => Promise<string | undefined>;
}

interface RouteValues {
  url?: string;
  terminalId?: string;
  workspaceId?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function valuesFrom(lookup: (name: string) => string | undefined): RouteValues {
  return {
    url: nonEmpty(lookup('KOMLA_API_URL')),
    terminalId: nonEmpty(lookup('KOMLA_TERMINAL_ID')),
    workspaceId: nonEmpty(lookup('KOMLA_WORKSPACE_ID')),
  };
}

function withMissingFrom(values: RouteValues, fallback: RouteValues): RouteValues {
  return {
    url: values.url ?? fallback.url,
    terminalId: values.terminalId ?? fallback.terminalId,
    workspaceId: values.workspaceId ?? fallback.workspaceId,
  };
}

function parseTmuxEnvironment(output: string): RouteValues {
  const variables = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) variables.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return valuesFrom((name) => variables.get(name));
}

function showTmuxEnvironment(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('tmux', ['show-environment'], { timeout: 2000 }, (error, stdout) =>
      resolve(error ? undefined : stdout)
    );
  });
}

/**
 * Komla's data folder: `KOMLA_DATA_DIR`, else the one the CLI in `KOMLA_CLI` was installed in,
 * else `~/.komla`.
 */
export function komlaDataDir(env: Record<string, string | undefined>): string | undefined {
  const explicit = nonEmpty(env.KOMLA_DATA_DIR);
  if (explicit) return explicit;
  const cli = nonEmpty(env.KOMLA_CLI);
  if (cli) {
    // As the CLI finds its own: `<data>/bin/komla`, or `<data>/helpers/bin/komla` on a host.
    for (let folder = dirname(cli); dirname(folder) !== folder; folder = dirname(folder)) {
      if (basename(folder) !== 'bin') continue;
      const parent = dirname(folder);
      if (basename(parent).startsWith('.komla')) return parent;
      if (basename(parent) === 'helpers') return dirname(parent);
    }
  }
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  return home ? join(home, '.komla') : undefined;
}

/**
 * Finds Komla as the `komla` CLI does from a terminal or this computer: from the managed tmux
 * session's environment on an SSH host, then `KOMLA_API_URL` and the other `KOMLA_*` variables,
 * then the port file in Komla's data folder. Unlike the CLI, it doesn't look through the
 * companion's routes on an SSH host for a caller outside its managed terminals (ADR 0008).
 */
export async function discoverKomla(options: DiscoverOptions = {}): Promise<DiscoveredRoute> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const processValues = valuesFrom((name) => env[name]);
  const tmux = nonEmpty(env.TMUX);
  const managed = tmux !== undefined && basename(tmux.split(',')[0] ?? '') === MANAGED_TMUX_SOCKET;
  const missing = !processValues.url || !processValues.terminalId || !processValues.workspaceId;
  let values = processValues;
  if (managed || (missing && tmux)) {
    const output = await (options.tmuxEnvironment ?? showTmuxEnvironment)();
    const tmuxValues = output === undefined ? {} : parseTmuxEnvironment(output);
    // The session's environment names the installation that owns the terminal now.
    values = managed
      ? withMissingFrom(tmuxValues, processValues)
      : withMissingFrom(processValues, tmuxValues);
  }
  if (values.url) {
    return { ...values, url: values.url.replace(/\/+$/, ''), cwd, refresh: managed };
  }

  const dataDir = komlaDataDir(env);
  if (!dataDir) {
    throw new KomlaError(
      'KOMLA_NOT_RUNNING',
      "KOMLA_API_URL isn't set and Komla's data folder couldn't be found."
    );
  }
  const portFile = join(dataDir, 'port');
  let text: string;
  try {
    text = await (options.readFile ?? ((path) => readFile(path, 'utf8')))(portFile);
  } catch {
    throw new KomlaError('KOMLA_NOT_RUNNING', `Komla isn't running: ${portFile} doesn't exist.`);
  }
  const port = Number(text.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new KomlaError('KOMLA_NOT_RUNNING', `${portFile} doesn't hold a port.`);
  }
  return { ...values, url: `http://127.0.0.1:${port}`, cwd, refresh: false };
}
