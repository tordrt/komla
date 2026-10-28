#!/usr/bin/env node
// Renders every app and website icon from resources/icon.svg:
//   resources/icon.png, icon.icns, icon.ico and icons/<size>.png (Linux)
//   docs/brand/komla-mark.svg, -black.svg and -white.svg (the mark without the tile)
//   the site's favicon.svg, favicon.ico, apple-touch-icon.png,
//   android-chrome-*.png and icon-square-512.png
// The site's og-image.png is rendered separately, by the site's scripts/render-og.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import png2icons from 'png2icons';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = join(root, 'resources');
// The landing site's public/ folder, which lives outside this repo. Site icons
// are skipped unless KOMLA_SITE_PUBLIC_DIR points at it.
const publicDir = process.env.KOMLA_SITE_PUBLIC_DIR
  ? resolve(process.env.KOMLA_SITE_PUBLIC_DIR)
  : null;

const LINUX_SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
// The tile's bounds inside the 1024 viewBox, for full-bleed crops.
const TILE_VIEWBOX = '20.48 20.48 983.04 983.04';
// The square around the mark that KomlaMark's 100 box covers, so the docs/brand marks are framed
// the same way (tests/renderer/components/ui/komla-mark.test.tsx checks the two match).
const MARK_VIEWBOX = '221.6 215.3 580.6 580.6';

const master = readFileSync(join(resourcesDir, 'icon.svg'), 'utf8');

function render(svg, size) {
  return sharp(Buffer.from(svg), { density: 72 * (size / 1024) * 4 })
    .resize(size, size)
    .png()
    .toBuffer();
}

function write(path, data) {
  writeFileSync(path, data);
  console.log(`  ${path}`);
}

const masterPng = await render(master, 1024);
const ico = png2icons.createICO(masterPng, png2icons.BICUBIC2, 0, true);
const icns = png2icons.createICNS(masterPng, png2icons.BICUBIC2, 0);
if (!ico || !icns) throw new Error('png2icons could not build the .ico/.icns files');

console.log('App icons:');
write(join(resourcesDir, 'icon.png'), masterPng);
write(join(resourcesDir, 'icon.icns'), icns);
write(join(resourcesDir, 'icon.ico'), ico);
mkdirSync(join(resourcesDir, 'icons'), { recursive: true });
for (const size of LINUX_SIZES) {
  write(join(resourcesDir, 'icons', `${size}x${size}.png`), await render(master, size));
}

console.log('Brand marks:');
const brandDir = join(root, 'docs', 'brand');
const mark = master
  .replace('viewBox="0 0 1024 1024"', `viewBox="${MARK_VIEWBOX}"`)
  .replace(/ *<!-- Tile:.*-->\n *<path fill="#0f1014" d="[^"]*"\/>\n/, '')
  .replace('so the gaps show the tile', 'so the gaps are transparent');
if (mark.includes('#0f1014')) throw new Error('Could not take the tile out of icon.svg');
// One-color marks leave out the specks.
const oneColor = (fill) =>
  mark
    .replaceAll('fill="#339fee"', `fill="${fill}"`)
    .replace(/ *<!-- Grated specks[\s\S]*?<\/g>\n/, '');
write(join(brandDir, 'komla-mark.svg'), mark);
write(join(brandDir, 'komla-mark-black.svg'), oneColor('#000'));
write(join(brandDir, 'komla-mark-white.svg'), oneColor('#fff'));

if (publicDir && existsSync(publicDir)) {
  console.log('Site icons:');
  // Favicons fill the whole square, so crop the transparent margin away.
  const favicon = master.replace('viewBox="0 0 1024 1024"', `viewBox="${TILE_VIEWBOX}"`);
  write(join(publicDir, 'favicon.svg'), favicon);
  write(join(publicDir, 'favicon.ico'), ico);
  write(join(publicDir, 'apple-touch-icon.png'), await render(master, 180));
  write(join(publicDir, 'android-chrome-192x192.png'), await render(master, 192));
  write(join(publicDir, 'android-chrome-512x512.png'), await render(master, 512));
  // Square brand image for JSON-LD: no rounded corners or margin.
  const square = favicon.replace(/<path fill="#0f1014" d="[^"]*"\/>/, (tile) =>
    tile.replace(/d="[^"]*"/, 'd="M0 0H1024V1024H0Z"').replace('#0f1014', '#0c0d10')
  );
  write(join(publicDir, 'icon-square-512.png'), await render(square, 512));
} else {
  console.log(
    publicDir
      ? `No site at ${publicDir}; skipping site icons.`
      : 'KOMLA_SITE_PUBLIC_DIR is not set; skipping site icons.'
  );
}
