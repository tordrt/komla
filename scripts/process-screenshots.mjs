#!/usr/bin/env node

/**
 * Process screenshots from e2e/screenshots/ → $KOMLA_SITE_PUBLIC_DIR/screenshots/
 *
 * Only processes the screenshots actually used by the website:
 *   - Landing images served directly: full PNG, 768w PNG+WebP (hero also gets 1280w PNG+WebP + base WebP)
 *   - Crop sources: full PNG only (used by crop-screenshots.mjs)
 *
 * Then automatically runs crop-screenshots.mjs to produce the cropped variants.
 *
 * Usage:
 *   KOMLA_SITE_PUBLIC_DIR=<landing site>/public node scripts/process-screenshots.mjs
 *   node scripts/process-screenshots.mjs --landing-only   (same, kept for compat)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'e2e', 'screenshots');
// The landing site's public/ folder, which lives outside this repo.
const SITE_PUBLIC_DIR = process.env.KOMLA_SITE_PUBLIC_DIR;
if (!SITE_PUBLIC_DIR || !fs.existsSync(SITE_PUBLIC_DIR)) {
  console.error(
    SITE_PUBLIC_DIR
      ? `No site at ${path.resolve(SITE_PUBLIC_DIR)}.`
      : "Set KOMLA_SITE_PUBLIC_DIR to the landing site's public/ folder."
  );
  process.exit(1);
}
const DEST_DIR = path.join(path.resolve(SITE_PUBLIC_DIR), 'screenshots');

const AGENT = process.env.AGENT || 'claude';
const AGENT_SUFFIX = AGENT === 'claude' ? '' : `-${AGENT}`;

// Insert the agent suffix before the theme in a base name like "landing-hero-dark".
function withAgent(name) {
  return AGENT_SUFFIX ? name.replace(/-(dark|light)$/, `${AGENT_SUFFIX}-$1`) : name;
}

// Full responsive treatment: full PNG, base WebP, 768w PNG+WebP, plus extras per image
const RESPONSIVE = {
  'landing-hero-dark': { extraWidths: [1280], baseWebp: true },
};

// Crop sources: read directly from e2e/screenshots/ by crop-screenshots.mjs — no processing needed
// Notification GIF frames are handled directly by crop-screenshots.mjs (not listed here)
const CROP_SOURCES = [
  'landing-workspace-dark',
  'landing-diff-dark',
  'dialog-new-workspace-launch-mode-dark',
];

async function processResponsive(srcPath, baseName, opts = {}) {
  const { extraWidths = [], baseWebp = false } = opts;
  const img = sharp(srcPath);
  const { width: fullWidth, height } = await img.metadata();

  console.log(`  ${baseName} (${fullWidth}x${height})`);

  await sharp(srcPath)
    .png({ quality: 90 })
    .toFile(path.join(DEST_DIR, `${baseName}.png`));

  if (baseWebp) {
    await sharp(srcPath)
      .webp({ quality: 85 })
      .toFile(path.join(DEST_DIR, `${baseName}.webp`));
  }

  const widths = [768, ...extraWidths].sort((a, b) => b - a);
  for (const w of widths) {
    if (w >= fullWidth) continue;
    await sharp(srcPath)
      .resize(w)
      .png({ quality: 90 })
      .toFile(path.join(DEST_DIR, `${baseName}-${w}w.png`));
    await sharp(srcPath)
      .resize(w)
      .webp({ quality: 85 })
      .toFile(path.join(DEST_DIR, `${baseName}-${w}w.webp`));
  }
}

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  console.log('Processing landing screenshots...\n');

  for (const [baseName, opts] of Object.entries(RESPONSIVE)) {
    const resolved = withAgent(baseName);
    const srcPath = path.join(SRC_DIR, `${resolved}.png`);
    if (!fs.existsSync(srcPath)) {
      console.warn(`  WARNING: ${resolved}.png not found, skipping`);
      continue;
    }
    await processResponsive(srcPath, resolved, opts);
  }

  // Verify crop sources exist before running crop step
  for (const baseName of CROP_SOURCES) {
    const resolved = withAgent(baseName);
    const srcPath = path.join(SRC_DIR, `${resolved}.png`);
    if (!fs.existsSync(srcPath)) {
      console.warn(`  WARNING: crop source ${resolved}.png not found`);
    }
  }

  console.log('\nRunning crop step...\n');
  execFileSync(process.execPath, [path.join(DEST_DIR, 'crop-screenshots.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, KOMLA_SCREENSHOTS_SRC_DIR: SRC_DIR },
  });

  const outputFiles = fs
    .readdirSync(DEST_DIR)
    .filter((f) => f.endsWith('.png') || f.endsWith('.webp'));
  console.log(`\nDone! ${outputFiles.length} image files in ${path.relative(ROOT, DEST_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
