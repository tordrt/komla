import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

declare const __KOMLA_ENV__: string;

const isStaging = typeof __KOMLA_ENV__ !== 'undefined' && __KOMLA_ENV__ === 'staging';

/**
 * Get the base path for all Komla data (~/.komla or ~/.komla-staging)
 * This consolidates all app data in a single, user-accessible location.
 * Staging builds use a separate directory so both can coexist.
 */
export function getKomlaBasePath(): string {
  if (process.env.KOMLA_DATA_DIR) {
    return process.env.KOMLA_DATA_DIR;
  }
  return join(app.getPath('home'), isStaging ? '.komla-staging' : '.komla');
}

/**
 * Ensure the komla base directory exists and return its path
 */
export function ensureKomlaBasePath(): string {
  const basePath = getKomlaBasePath();
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }
  return basePath;
}
