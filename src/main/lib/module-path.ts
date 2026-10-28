import { dirname } from 'path';
import { fileURLToPath } from 'url';

export function getModuleDir(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}

// The main build writes every chunk to out/main (see electron.vite.config.ts),
// so this resolves to out/main in both development and packaged builds.
export const MAIN_BUNDLE_DIR = getModuleDir(import.meta.url);
