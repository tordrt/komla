#!/usr/bin/env node
// Renders the macOS installer window's background: resources/dmg-background.png (1x) and
// dmg-background@2x.png (Retina). electron-builder.yml points `dmg.background` at the 1x file and
// merges the @2x one next to it. electron-builder sizes the installer window from the image, and
// the icon positions in `dmg.contents` must match APP_X, APPS_X and ICON_Y below.
//
// Chromium draws it so the headline can use Geist. Run it after changing the design:
//   node scripts/generate-dmg-background.mjs
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { chromium } from '@playwright/test';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 660;
const HEIGHT = 400;
const ICON_Y = 230;
const APP_X = 180;
const APPS_X = 480;

// Finder draws the icon labels in black, so the background stays light. Flat colors, no
// gradients (docs/BRAND.md).
const PAPER = '#f4f5f7';
const INK = '#1a1c21';
const MUTED = '#6b7280';

const geist = readFileSync(join(root, 'src/renderer/assets/fonts/Geist-Variable.woff2')).toString(
  'base64'
);
// The mark without its tile, so its gaps show the paper.
const mark = readFileSync(join(root, 'docs/brand/komla-mark.svg'), 'utf8').replace(
  '<svg ',
  '<svg x="40" y="34" width="44" height="44" '
);

// The arrow: a curve between the two icons, with its head turned to follow the curve's end.
const tail = { x: APP_X + 92, y: ICON_Y - 4 };
const tip = { x: APPS_X - 92, y: ICON_Y - 4 };
const bend = { x: (tail.x + tip.x) / 2, y: ICON_Y - 44 };
const heading = Math.atan2(tip.y - bend.y, tip.x - bend.x);
const wing = (turn) => ({
  x: Math.round((tip.x - 16 * Math.cos(heading + turn)) * 10) / 10,
  y: Math.round((tip.y - 16 * Math.sin(heading + turn)) * 10) / 10,
});
const wingA = wing(0.55);
const wingB = wing(-0.55);

const html = `<!doctype html>
<style>
  @font-face {
    font-family: Geist;
    font-weight: 100 900;
    src: url(data:font/woff2;base64,${geist}) format('woff2');
  }
  html, body { margin: 0; background: ${PAPER}; }
  svg { display: block; }
  text { font-family: Geist, sans-serif; text-anchor: middle; }
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  ${mark}
  <text x="${WIDTH / 2}" y="130" font-size="30" font-weight="650" fill="${INK}">Drag Komla into Applications.</text>
  <path d="M${tail.x} ${tail.y} Q${bend.x} ${bend.y} ${tip.x} ${tip.y}" fill="none" stroke="${INK}"
        stroke-width="3" stroke-linecap="round"/>
  <path d="M${wingA.x} ${wingA.y} L${tip.x} ${tip.y} L${wingB.x} ${wingB.y}" fill="none" stroke="${INK}"
        stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="${WIDTH / 2}" y="${HEIGHT - 28}" font-size="14" fill="${MUTED}">Once copied, open it from Applications.</text>
</svg>`;

const browser = await chromium.launch();
try {
  for (const [scale, name] of [
    [1, 'dmg-background.png'],
    [2, 'dmg-background@2x.png'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: scale,
    });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    // A font that failed to decode falls back to sans-serif without an error.
    if (!(await page.evaluate(() => document.fonts.check('650 30px Geist')))) {
      throw new Error('Geist did not load, so the headline would be drawn in a fallback font');
    }
    const shot = await page.screenshot({ type: 'png' });
    // tiffutil only merges the pair as a HiDPI image when the @2x file says it is 144 dpi.
    const png = await sharp(shot)
      .withMetadata({ density: 72 * scale })
      .png()
      .toBuffer();
    const path = join(root, 'resources', name);
    writeFileSync(path, png);
    console.log(`  ${path}`);
    await page.close();
  }
} finally {
  await browser.close();
}
