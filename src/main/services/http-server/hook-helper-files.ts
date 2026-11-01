import { writeFileSync } from 'fs';

import { getNotifyHelper, komlaNodeCmd } from '../../lib/komla-cli';
import { createLogger } from '../../lib/logger';
import { generateNotifyScript } from '../notify-script';

const logger = createLogger('HttpServerService');

/**
 * Writes the helper files hook commands depend on: the Electron binary path (node-path /
 * komla-node.cmd) and the shared notification script (notify.js). These persist across restarts
 * and are refreshed each launch.
 */
export function writeHookHelperFiles(portFilePath: string): void {
  const notifyHelper = getNotifyHelper();
  try {
    writeFileSync(notifyHelper.nodePathFile, process.execPath);
    if (process.platform === 'win32') {
      writeFileSync(notifyHelper.nodeCommand, komlaNodeCmd(process.execPath));
    } else {
      // Shell wrapper: tries node first (sandbox-friendly), falls back to
      // the Electron binary for users without node installed.
      writeFileSync(
        notifyHelper.nodeCommand,
        `#!/bin/sh\nif command -v node >/dev/null 2>&1; then\n  exec node "$@"\nelse\n  exec env ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "$@"\nfi\n`,
        { mode: 0o755 }
      );
    }
    writeFileSync(notifyHelper.script, generateNotifyScript(portFilePath), {
      mode: 0o755,
    });
  } catch (error) {
    logger.warn('Failed to write hook helper files (node-path, notify.js):', error);
  }
}
