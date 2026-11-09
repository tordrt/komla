import { execFile } from 'child_process';
import { rmSync, type RmOptions } from 'fs';
import { rm } from 'fs/promises';
import { createRequire } from 'module';

// Electron patches fs to treat .asar archives as directories, so recursive
// removal of a tree containing one (e.g. node_modules/electron's
// default_app.asar) leaves the archive behind and fails with ENOTEMPTY.
// Remove trees that may hold project content with Electron's unpatched fs.
interface RemoveFs {
  rmSync: typeof rmSync;
  promises: { rm: typeof rm };
}

let originalFs: RemoveFs | undefined;

function getOriginalFs(): RemoveFs | undefined {
  if (!process.versions.electron) return undefined;
  originalFs ??= createRequire(import.meta.url)('original-fs') as RemoveFs;
  return originalFs;
}

export function removePath(path: string, options?: RmOptions): Promise<void> {
  const fs = getOriginalFs();
  return fs ? fs.promises.rm(path, options) : rm(path, options);
}

export function removePathSync(path: string, options?: RmOptions): void {
  const fs = getOriginalFs();
  if (fs) fs.rmSync(path, options);
  else rmSync(path, options);
}

// Electron's own asar patching is off here, as in `removePath`.
const REMOVE_IN_CHILD_SCRIPT =
  "process.noAsar = true; require('fs').rmSync(process.argv[1], { recursive: true, force: true });";

/**
 * Removes a tree in a short-lived child process. `removePath` deletes in the main process, where
 * a big tree (`node_modules`) holds up everything else main does, such as answering the renderer,
 * for as long as the delete takes. Use this for a tree that may be large.
 */
export function removePathInChild(path: string): Promise<void> {
  // The app's NODE_OPTIONS (a --require, an --inspect port) isn't meant for this helper.
  const { NODE_OPTIONS: _nodeOptions, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    // The same binary run as plain Node, so no Node install is needed.
    execFile(
      process.execPath,
      ['-e', REMOVE_IN_CHILD_SCRIPT, path],
      { env: { ...inherited, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = stderr.trim();
        reject(new Error(detail ? `${error.message}\n${detail}` : error.message));
      }
    );
  });
}
