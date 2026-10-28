#!/usr/bin/env node
/**
 * Render recordings from e2e/videos/output/<spec>/ into landing-page videos.
 *
 * Each recording is a set of CDP screencast frames plus a timeline of cursor,
 * click, shortcut and camera events (see e2e/videos/video-fixtures.ts). This
 * script resamples the frames to a constant frame rate, eases the camera, and
 * draws the macOS traffic lights, cursor, click ripples and shortcut badges
 * on top, then encodes an H.264 MP4, a smaller AV1 MP4 and a WebP poster.
 * A recording that lists further takes, such as one before Komla quits and one
 * after it reopens, plays them in order with a caption card between them.
 *
 * Usage:
 *   node scripts/render-videos.mjs                 # every recording
 *   node scripts/render-videos.mjs change-review   # selected recordings
 *   node scripts/render-videos.mjs --publish       # also copy into $KOMLA_SITE_PUBLIC_DIR/screenshots
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RECORDINGS_DIR = path.join(ROOT, 'e2e', 'videos', 'output');
// The landing site's public/ folder, which lives outside this repo.
const SITE_PUBLIC_DIR = process.env.KOMLA_SITE_PUBLIC_DIR;
const PUBLISH_DIR = SITE_PUBLIC_DIR && path.join(path.resolve(SITE_PUBLIC_DIR), 'screenshots');

// Native traffic lights are OS chrome that the screencast doesn't capture.
// Matches window.service.ts trafficLightPosition and the 12px / 20px macOS spacing.
const TRAFFIC_LIGHTS = {
  x: 21,
  y: 18,
  gap: 20,
  radius: 6,
  colors: ['#ff5f57', '#febc2e', '#28c840'],
};
const CLICK_RIPPLE_SECONDS = 0.45;
const KEYS_SECONDS = 1.2;
const CURSOR_FADE_SECONDS = 0.25;
// Between takes: fade to the caption card, hold it, fade into the next take.
const CUT_FADE_SECONDS = 0.35;
const CUT_HOLD_SECONDS = 1.6;
const CUT_BACKGROUND = '#0e0f12';
// An AV1 copy for browsers that decode it, with the H.264 MP4 as the fallback. At crf 50
// it is a quarter to two fifths smaller than the H.264 and scores a little higher on VMAF;
// screen content mode (scm=1) took ten times as long for the same size.
const SVT_AV1_PRESET = 4;
const SVT_AV1_CRF = 50;
const SVT_AV1_PARAMS = 'tune=0';

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, p) => a + (b - a) * p;
const escapeXml = (s) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  );

function loadRecording(dir) {
  const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  // Screencast timestamps are wall-clock seconds; fall back to arrival time if not.
  const frames = timeline.frames.map((f) => ({
    file: path.join(dir, f.file),
    t: Math.abs(f.t - f.received) < 1 ? f.t : f.received,
  }));
  frames.sort((a, b) => a.t - b.t);
  // Native views over the window (browser preview, toasts) recorded separately.
  const layerFrames = new Map();
  for (const f of timeline.layers?.frames ?? []) {
    if (!layerFrames.has(f.layer)) layerFrames.set(f.layer, []);
    layerFrames.get(f.layer).push({ file: path.join(dir, f.file), t: f.t });
  }
  for (const list of layerFrames.values()) list.sort((a, b) => a.t - b.t);
  const layouts = [...(timeline.layers?.layouts ?? [])].sort((a, b) => a.t - b.t);
  const rec = { ...timeline, frames, layerFrames, layouts, dir };
  rec.clock = timeMap(rec);
  for (const e of rec.events) e.o = rec.clock.toOutput(e.t);
  return rec;
}

/**
 * Maps output time (seconds from the start of the video) to recording time,
 * honouring `speed` events so slow stretches play back faster.
 */
function timeMap(rec) {
  const segments = [];
  let t0 = rec.start;
  let o0 = 0;
  let speed = 1;
  for (const e of rec.events.filter((e) => e.type === 'speed')) {
    segments.push({ t0, t1: e.t, o0, speed });
    o0 += (e.t - t0) / speed;
    t0 = e.t;
    speed = e.factor;
  }
  segments.push({ t0, t1: rec.end, o0, speed });
  const duration = o0 + (rec.end - t0) / speed;
  return {
    duration,
    toSource(o) {
      const seg = segments.findLast((s) => s.o0 <= o) ?? segments[0];
      return seg.t0 + (o - seg.o0) * seg.speed;
    },
    toOutput(t) {
      const seg = segments.findLast((s) => s.t0 <= t) ?? segments[0];
      return seg.o0 + (t - seg.t0) / seg.speed;
    },
  };
}

/** Widen a rect to the output aspect ratio and keep it inside the window. */
function fitRect(rect, aspect, viewport) {
  let { width, height } = rect;
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  if (width > viewport.width) {
    width = viewport.width;
    height = width / aspect;
  }
  if (height > viewport.height) {
    height = viewport.height;
    width = height * aspect;
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: clamp(cx - width / 2, 0, viewport.width - width),
    y: clamp(cy - height / 2, 0, viewport.height - height),
    width,
    height,
  };
}

function cameraTrack(rec) {
  const { output, viewport } = rec;
  const aspect = output.width / output.height;
  const base = fitRect(output.frame ?? { x: 0, y: 0, ...viewport }, aspect, viewport);
  const keys = rec.events.filter((e) => e.type === 'camera');
  // Moves run on output time, so a speed-up right after one doesn't squeeze it into a snap.
  const valueAt = (state, o) => {
    const p = state.duration > 0 ? ease(clamp((o - state.o0) / state.duration, 0, 1)) : 1;
    return {
      x: lerp(state.from.x, state.to.x, p),
      y: lerp(state.from.y, state.to.y, p),
      width: lerp(state.from.width, state.to.width, p),
      height: lerp(state.from.height, state.to.height, p),
    };
  };
  return (o) => {
    let state = { from: base, to: base, o0: 0, duration: 0 };
    for (const key of keys) {
      if (key.o > o) break;
      const to = key.rect ? fitRect(key.rect, aspect, viewport) : base;
      state = { from: valueAt(state, key.o), to, o0: key.o, duration: key.duration };
    }
    return valueAt(state, o);
  };
}

function cursorTrack(rec) {
  const moves = rec.events.filter((e) => e.type === 'cursor');
  const hides = rec.events.filter((e) => e.type === 'cursorHide');
  return (t) => {
    let i = -1;
    while (i + 1 < moves.length && moves[i + 1].t <= t) i++;
    if (i < 0) return null;
    // Typing hides the cursor, as macOS does; the next move fades it back in.
    const hide = hides.filter((h) => h.t <= t).at(-1);
    const shownAt = moves.find((m) => m.t > (hide?.t ?? -Infinity))?.t;
    const opacity =
      shownAt == null || shownAt > t
        ? 1 - clamp((t - hide.t) / CURSOR_FADE_SECONDS, 0, 1)
        : clamp((t - shownAt) / CURSOR_FADE_SECONDS, 0, 1);
    const a = moves[i];
    const b = moves[i + 1];
    if (!b || b.t - a.t > 0.1) return { x: a.x, y: a.y, opacity };
    const p = (t - a.t) / (b.t - a.t);
    return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), opacity };
  };
}

function frameAt(frames, t) {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo];
}

function overlaySvg(rec, t, o, cam, cursorAt) {
  const { width: W, height: H } = rec.output;
  const s = W / cam.width;
  const toOut = (p) => ({ x: (p.x - cam.x) * s, y: (p.y - cam.y) * s });
  const parts = [];

  TRAFFIC_LIGHTS.colors.forEach((color, i) => {
    const c = toOut({ x: TRAFFIC_LIGHTS.x + i * TRAFFIC_LIGHTS.gap, y: TRAFFIC_LIGHTS.y });
    parts.push(
      `<circle cx="${c.x}" cy="${c.y}" r="${TRAFFIC_LIGHTS.radius * s}" fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="${0.5 * s}"/>`
    );
  });

  for (const click of rec.events) {
    if (click.type !== 'click' || o < click.o || o > click.o + CLICK_RIPPLE_SECONDS) continue;
    const p = (o - click.o) / CLICK_RIPPLE_SECONDS;
    const c = toOut(click);
    parts.push(
      `<circle cx="${c.x}" cy="${c.y}" r="${(6 + 16 * ease(p)) * s}" fill="rgba(255,255,255,${0.22 * (1 - p)})" stroke="rgba(255,255,255,${0.55 * (1 - p)})" stroke-width="${1.5 * s}"/>`
    );
  }

  const cursor = cursorAt(t);
  if (cursor) {
    const held =
      rec.events.filter((e) => (e.type === 'mouseDown' || e.type === 'mouseUp') && e.o <= o).at(-1)
        ?.type === 'mouseDown';
    const pressed =
      held || rec.events.some((e) => e.type === 'click' && o >= e.o && o < e.o + 0.16);
    const c = toOut(cursor);
    const scale = s * 1.15 * (pressed ? 0.86 : 1);
    parts.push(
      `<g transform="translate(${c.x} ${c.y}) scale(${scale})" opacity="${cursor.opacity}" filter="url(#shadow)">` +
        '<path d="M0 0 L0 17.2 L4.3 13.2 L7.1 19.6 L9.9 18.4 L7.2 12.2 L12.8 12.2 Z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>' +
        '</g>'
    );
  }

  const keys = rec.events
    .filter((e) => e.type === 'keys' && o >= e.o && o < e.o + KEYS_SECONDS)
    .at(-1);
  if (keys) {
    const age = o - keys.o;
    const opacity = Math.min(1, age / 0.12, (KEYS_SECONDS - age) / 0.25);
    const rise = (1 - ease(Math.min(1, age / 0.18))) * 8;
    const size = Math.round(H * 0.052);
    const capW = (label) => Math.max(size * 1.5, label.length * size * 0.62 + size * 0.7);
    const gap = size * 0.3;
    const widths = keys.keys.map(capW);
    const pad = size * 0.4;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1) + pad * 2;
    const boxH = size * 1.9;
    const x0 = (W - totalW) / 2;
    const y0 = H - boxH - H * 0.06 + rise;
    let x = x0 + pad;
    const caps = keys.keys.map((label, i) => {
      const w = widths[i];
      const cap =
        `<rect x="${x}" y="${y0 + pad * 0.9}" width="${w}" height="${boxH - pad * 1.8}" rx="${size * 0.22}" fill="rgba(255,255,255,0.09)" stroke="rgba(255,255,255,0.14)"/>` +
        `<text x="${x + w / 2}" y="${y0 + boxH / 2}" dy="0.36em" text-anchor="middle" font-family="SF Pro Display, Helvetica Neue, Helvetica, Arial" font-weight="500" font-size="${size}" fill="#fff">${escapeXml(label)}</text>`;
      x += w + gap;
      return cap;
    });
    parts.push(
      `<g opacity="${opacity}"><rect x="${x0}" y="${y0}" width="${totalW}" height="${boxH}" rx="${size * 0.42}" fill="rgba(14,15,18,0.88)" stroke="rgba(255,255,255,0.16)"/>${caps.join('')}</g>`
    );
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      '<defs><filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-opacity="0.45"/></filter></defs>' +
      `${parts.join('')}</svg>`
  );
}

const layerCache = new Map();

/** A native view's frame scaled to its on-screen size, cached per layer. */
async function layerImage(layer, file, width, height) {
  const cached = layerCache.get(layer);
  if (cached?.file === file && cached.width === width && cached.height === height)
    return cached.data;
  const data = await sharp(file).resize(width, height).png().toBuffer();
  layerCache.set(layer, { file, width, height, data });
  return data;
}

/** The main frame at `t` with any visible native views drawn over it. */
async function sourceAt(rec, t, sourceScale) {
  const src = frameAt(rec.frames, t);
  const layout = rec.layouts.findLast((l) => l.t <= t);
  const composites = [];
  for (const rect of layout?.rects ?? []) {
    const frames = rec.layerFrames.get(rect.layer);
    const frame = frames && frames[0].t <= t ? frameAt(frames, t) : null;
    if (!frame) continue;
    const width = Math.round(rect.width * sourceScale);
    const height = Math.round(rect.height * sourceScale);
    composites.push({
      input: await layerImage(rect.layer, frame.file, width, height),
      left: Math.round(rect.x * sourceScale),
      top: Math.round(rect.y * sourceScale),
    });
  }
  if (composites.length === 0) return src.file;
  const { data, info } = await sharp(src.file)
    .composite(composites)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(data, { raw: info });
}

async function renderFrame(rec, o, cameraAt, cursorAt, sourceScale) {
  const t = rec.clock.toSource(o);
  const cam = cameraAt(o);
  const source = await sourceAt(rec, t, sourceScale);
  const region = {
    left: Math.round(cam.x * sourceScale),
    top: Math.round(cam.y * sourceScale),
    width: Math.round(cam.width * sourceScale),
    height: Math.round(cam.height * sourceScale),
  };
  return (typeof source === 'string' ? sharp(source) : source)
    .extract(region)
    .resize(rec.output.width, rec.output.height, { kernel: 'lanczos3' })
    .composite([{ input: overlaySvg(rec, t, o, cam, cursorAt) }])
    .removeAlpha()
    .raw()
    .toBuffer();
}

function blend(a, b, p) {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * p;
  return out;
}

/** The caption shown between two takes, centered on a dark frame. */
function captionCard(W, H, caption) {
  const size = Math.round(H * 0.042);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="${CUT_BACKGROUND}"/>` +
    `<text x="${W / 2}" y="${H / 2}" dy="0.36em" text-anchor="middle" font-family="SF Pro Display, Helvetica Neue, Helvetica, Arial" font-weight="500" font-size="${size}" fill="rgba(255,255,255,0.92)">${escapeXml(caption)}</text>` +
    '</svg>';
  return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
}

function once(fn) {
  let result;
  return () => (result ??= fn());
}

/** A take's frame count and renderer, at the video's frame rate. */
async function prepareTake(rec, fps) {
  const { width: srcW } = await sharp(rec.frames[0].file).metadata();
  const sourceScale = srcW / rec.viewport.width;
  const cameraAt = cameraTrack(rec);
  const cursorAt = cursorTrack(rec);
  return {
    rec,
    total: Math.floor(rec.clock.duration * fps),
    frame: (n) => renderFrame(rec, n / fps, cameraAt, cursorAt, sourceScale),
  };
}

async function render(dir, publish) {
  const rec = loadRecording(dir);
  const { output } = rec;
  const fps = output.fps ?? 30;
  const W = output.width;
  const H = output.height;
  if (W % 2 || H % 2) throw new Error(`${output.name}: output size must be even`);

  const takes = [rec, ...(rec.takes ?? []).map((take) => loadRecording(path.join(dir, take.dir)))];
  const prepared = await Promise.all(takes.map((take) => prepareTake(take, fps)));

  // Every output frame in order: each take's, with a caption card between takes.
  const jobs = [];
  let posterIndex = null;
  for (const [i, take] of prepared.entries()) {
    if (i > 0) {
      // Rendered once each, when the first job needs them.
      const before = once(() => prepared[i - 1].frame(prepared[i - 1].total - 1));
      const after = once(() => take.frame(0));
      const card = once(() => captionCard(W, H, rec.takes[i - 1].caption));
      const fade = Math.round(CUT_FADE_SECONDS * fps);
      const step = (k) => ease(k / (fade + 1));
      for (let k = 1; k <= fade; k++)
        jobs.push(async () => blend(await before(), await card(), step(k)));
      for (let k = 0; k < Math.round(CUT_HOLD_SECONDS * fps); k++) jobs.push(card);
      for (let k = 1; k <= fade; k++)
        jobs.push(async () => blend(await card(), await after(), step(k)));
    }
    const posterMark = take.rec.events.find((e) => e.type === 'poster');
    if (posterMark && posterIndex === null)
      posterIndex = jobs.length + Math.round(posterMark.o * fps);
    for (let n = 0; n < take.total; n++) jobs.push(() => take.frame(n));
  }
  const total = jobs.length;
  const fadeFrames = Math.round((output.loopFade ?? 0) * fps);
  posterIndex = clamp(posterIndex ?? total - fadeFrames - 1, 0, total - 1);

  const mp4Path = path.join(dir, `${output.name}.mp4`);
  const av1Path = path.join(dir, `${output.name}-av1.mp4`);
  const posterPath = path.join(dir, `${output.name}-poster.webp`);
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${W}x${H}`,
      '-r',
      String(fps),
      '-i',
      '-',
      // Screen content is flat fills and sharp text: veryslow with the animation tune
      // is about a quarter smaller than slow at crf 21 with the text just as crisp.
      '-c:v',
      'libx264',
      '-preset',
      'veryslow',
      '-tune',
      'animation',
      '-crf',
      '24',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      mp4Path,
      // The same frames in AV1.
      '-c:v',
      'libsvtav1',
      '-preset',
      String(SVT_AV1_PRESET),
      '-crf',
      String(SVT_AV1_CRF),
      '-svtav1-params',
      SVT_AV1_PARAMS,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      av1Path,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
  const done = new Promise((resolve, reject) =>
    ffmpeg.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))
    )
  );
  const write = (buf) =>
    new Promise((resolve) =>
      ffmpeg.stdin.write(buf) ? resolve() : ffmpeg.stdin.once('drain', resolve)
    );

  let first = null;
  const BATCH = 8;
  for (let i = 0; i < total; i += BATCH) {
    const indices = Array.from({ length: Math.min(BATCH, total - i) }, (_, k) => i + k);
    const buffers = await Promise.all(indices.map((n) => jobs[n]()));
    for (const [k, buf] of buffers.entries()) {
      const n = indices[k];
      if (n === 0) first = buf;
      if (n === posterIndex) {
        await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
          .webp({ quality: 85 })
          .toFile(posterPath);
      }
      // The fade stops a step short of the first frame, which follows as the loop restarts.
      const fadeStart = total - fadeFrames;
      await write(
        n >= fadeStart && fadeFrames > 0
          ? blend(buf, first, ease((n - fadeStart + 1) / (fadeFrames + 1)))
          : buf
      );
    }
  }
  ffmpeg.stdin.end();
  await done;

  const kb = (file) => `${Math.round(fs.statSync(file).size / 1024)} KB`;
  console.log(
    `  ${output.name}.mp4  ${W}x${H} @ ${fps}fps, ${(total / fps).toFixed(1)}s, ${kb(mp4Path)} (AV1 ${kb(av1Path)})`
  );
  if (publish) {
    for (const file of [mp4Path, av1Path, posterPath])
      fs.copyFileSync(file, path.join(PUBLISH_DIR, path.basename(file)));
    console.log(`  → published to ${path.relative(ROOT, PUBLISH_DIR)}/`);
  }
}

const args = process.argv.slice(2);
const publish = args.includes('--publish');
if (publish && !PUBLISH_DIR) {
  console.error("Set KOMLA_SITE_PUBLIC_DIR to the landing site's public/ folder to publish.");
  process.exit(1);
}
const names = args.filter((a) => !a.startsWith('--'));
const dirs = (names.length ? names : fs.readdirSync(RECORDINGS_DIR))
  .map((name) => path.join(RECORDINGS_DIR, name))
  .filter((dir) => fs.existsSync(path.join(dir, 'timeline.json')));
if (dirs.length === 0) {
  console.error('No recordings found. Run `npm run videos` first.');
  process.exit(1);
}
for (const dir of dirs) await render(dir, publish);
