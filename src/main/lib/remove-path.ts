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
