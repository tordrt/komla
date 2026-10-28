import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, win32 } from 'path';

import { OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX } from '../../shared/types/workspace';

import { createLogger } from './logger';
import { removePath } from './remove-path';
import { isWslMode } from './wsl';

const logger = createLogger('OpenCodeService');

// opencode's shared background service reloads a folder within about a second while any of
// its TUIs is open, so each release gets an immediate delete and a few tries.
const RELEASE_ATTEMPTS = 3;
// Unloading a folder waits for the servers opencode runs there to stop, which can take seconds.
const REQUEST_TIMEOUT_MS = 10000;

interface OpenCodeService {
  url: string;
  password: string;
}

/** The running opencode background service, from the file it writes when it starts. */
function readRunningService(): OpenCodeService | undefined {
  const stateDir = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  try {
    const service = JSON.parse(readFileSync(join(stateDir, 'opencode', 'service.json'), 'utf-8'));
    if (typeof service?.url !== 'string' || typeof service.password !== 'string') return undefined;
    // The file outlives a service that crashed.
    if (Number.isInteger(service.pid)) process.kill(service.pid, 0);
    return { url: service.url, password: service.password };
  } catch {
    return undefined;
  }
}

/** Windows fails a delete with either code while another process uses the folder. */
function isInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || code === 'EPERM';
}

function request(service: OpenCodeService, path: string, method = 'GET'): Promise<Response> {
  return fetch(`${service.url}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function isAtOrInside(location: string, directory: string): boolean {
  const root = win32.resolve(directory).toLowerCase();
  const path = win32.resolve(location).toLowerCase();
  return path === root || path.startsWith(root + win32.sep);
}

/** The folders at or inside `directory` that the service has loaded; none when it can't say. */
async function loadedLocations(service: OpenCodeService, directory: string): Promise<string[]> {
  try {
    const response = await request(service, '/api/debug/location');
    if (!response.ok) return [];
    const locations: unknown = await response.json();
    if (!Array.isArray(locations)) return [];
    return locations
      .map((location) => (location as { directory?: unknown })?.directory)
      .filter((location): location is string => typeof location === 'string')
      .filter((location) => isAtOrInside(location, directory));
  } catch (error) {
    logger.warn('Could not list the folders opencode has loaded', {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * Asks the service to unload the folders opencode has loaded at or inside `directory`, which
 * ends the MCP and language servers it runs there. False when it has none or refuses.
 */
async function releaseLocations(service: OpenCodeService, directory: string): Promise<boolean> {
  const locations = await loadedLocations(service, directory);
  if (locations.length === 0) return false;
  for (const location of locations) {
    try {
      const response = await request(
        service,
        `/api/debug/location?location[directory]=${encodeURIComponent(location)}`,
        'DELETE'
      );
      if (!response.ok) {
        logger.warn('opencode refused to release folder', { location, status: response.status });
        return false;
      }
    } catch (error) {
      logger.warn('Could not reach opencode to release folder', {
        error: (error as Error).message,
      });
      return false;
    }
  }
  return true;
}

/**
 * Runs `remove`, a worktree delete. On Windows, a folder opencode's background service has
 * loaded stays in use by the servers it starts there, so when the delete finds the folder in
 * use and the service has it loaded, release the folder from it and delete again. Fails with
 * OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX when opencode keeps loading the folder, and with the
 * original error when opencode isn't what holds it.
 */
export async function deleteReleasingOpenCodeLocation(
  directory: string,
  remove: () => Promise<void>
): Promise<void> {
  let service: OpenCodeService | undefined;
  let inUse: unknown;
  try {
    await remove();
    return;
  } catch (error) {
    if (process.platform !== 'win32' || isWslMode() || !isInUse(error)) throw error;
    service = readRunningService();
    if (!service || !(await releaseLocations(service, directory))) throw error;
    inUse = error;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      // Retry a handle that closes just after the release for about 0.3 s, which gives up
      // before opencode can load the folder again.
      await removePath(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      break;
    } catch (error) {
      if (!isInUse(error)) throw error;
    }
    if (attempt >= RELEASE_ATTEMPTS) {
      throw new Error(
        `${OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX} opencode's background service may still be using ${directory}. opencode sessions open in other workspaces can load it again; close them, then retry.`
      );
    }
    // Still in use, but no longer loaded in opencode: something else holds it.
    if (!(await releaseLocations(service, directory))) throw inUse;
  }
  logger.info('Deleted worktree after opencode released it', { directory });
  // The folder is gone; this finishes git's bookkeeping and the branch.
  await remove();
}
