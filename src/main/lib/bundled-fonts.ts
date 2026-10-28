import { existsSync, readdirSync } from 'fs';
import { extname, join } from 'path';

import { MAIN_BUNDLE_DIR } from './module-path';

/** Fonts the app bundles that pages Komla serves can load, by the name they load them as. */
const FONTS: Record<string, string> = {
  'geist.woff2': 'Geist-Variable.woff2',
  'nerd-font.ttf': 'JetBrainsMonoNLNerdFontMono-Regular.ttf',
};

const found = new Map<string, string | null>();

// A build names its assets with a hash, as Geist-Variable-Bj2R_7yk.woff2; a dev run serves the
// renderer from source, where the font keeps its own name.
function locate(file: string): string | null {
  const extension = extname(file);
  const base = file.slice(0, -extension.length);
  const assets = join(MAIN_BUNDLE_DIR, '../renderer/assets');
  try {
    const built = readdirSync(assets).find(
      (name) => name.startsWith(`${base}-`) && name.endsWith(extension)
    );
    if (built) return join(assets, built);
  } catch {
    // No renderer build, as in a dev run.
  }
  const source = join(MAIN_BUNDLE_DIR, '../../src/renderer/assets/fonts', file);
  return existsSync(source) ? source : null;
}

/** The path of a bundled font, such as `geist.woff2`, or null when Komla has none by that name. */
export function bundledFontPath(name: string): string | null {
  const file = Object.hasOwn(FONTS, name) ? FONTS[name] : undefined;
  if (!file) return null;
  if (!found.has(file)) found.set(file, locate(file));
  return found.get(file) ?? null;
}
