import { existsSync, statSync, watch } from 'fs';
import { basename, dirname, join } from 'path';

import { createLogger } from '../../lib/logger';

const logger = createLogger('SshLogins');

/** Which of Komla's connections to a host logged in. */
export interface SshLoginSource {
  hostId: string;
  connection: string;
}

// Terminals' shared connections, by control socket name, in the directories watched for them.
const terminalSockets = new Map<string, SshLoginSource>();
const watchedDirectories = new Set<string>();
// What each socket was when its login was logged, so a repeated event doesn't log it twice.
const loggedSockets = new Map<string, string>();

/**
 * Logs a login to an SSH host. Every login can ask the SSH agent to approve the key, as with a
 * fingerprint, so this log tells which connection asked. Komla's own ssh is logged as it starts,
 * so one that fails before it authenticates, such as on a host that doesn't answer, logs too; a
 * terminal's ssh on a shared connection is logged once it logged in.
 */
export function logSshLogin(source: SshLoginSource): void {
  logger.info('Logging in to an SSH host', source);
}

/**
 * Logs the login of an ssh about to run on the shared connection at `controlPath`, which logs in
 * when no connection is open there and joins it otherwise.
 */
export function logSshLoginUnlessShared(controlPath: string, source: SshLoginSource): void {
  if (!existsSync(controlPath)) logSshLogin(source);
}

/**
 * Logs the logins of a terminal's ssh, which runs in its terminal rather than in Komla, as it opens
 * the shared connection at `controlPath`: ssh creates the control socket once it logged in.
 */
export function watchSshTerminalLogins(controlPath: string, source: SshLoginSource): void {
  terminalSockets.set(basename(controlPath), source);
  const directory = dirname(controlPath);
  if (watchedDirectories.has(directory)) return;
  watchedDirectories.add(directory);
  try {
    const watcher = watch(directory, (_event, filename) => {
      const name = filename?.toString();
      const socket = name ? terminalSockets.get(name) : undefined;
      if (!name || !socket) return;
      let identity: string;
      try {
        // A socket opened right after one closed can have its inode, but not its birth time.
        const stat = statSync(join(directory, name));
        identity = `${stat.ino}:${stat.birthtimeMs}`;
      } catch {
        // The connection closed.
        loggedSockets.delete(name);
        return;
      }
      if (loggedSockets.get(name) === identity) return;
      loggedSockets.set(name, identity);
      logSshLogin(socket);
    });
    watcher.on('error', (error) => {
      watcher.close();
      // The next terminal watches again.
      watchedDirectories.delete(directory);
      logger.warn("Stopped logging terminals' SSH logins", { error });
    });
    watcher.unref();
  } catch (error) {
    watchedDirectories.delete(directory);
    logger.warn("Could not log terminals' SSH logins", { error });
  }
}
