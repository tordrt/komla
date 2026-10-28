import { hexToOklchValues } from './project-colors';

/**
 * The colors of a project's icon, offered as its project color. Each is an exact "#rrggbb" from
 * the image, so a flat logo gives its own brand color.
 */

// Few enough to sit beside the palette in one row.
const MAX_COLORS = 3;
// Channels this close together are gray, white or black: ink, not a color to pick.
const MIN_CHANNEL_SPREAD = 48;
// Shades this close (RGB distance) are one color: anti-aliasing and scaling blend edges.
const SAME_COLOR_DISTANCE = 64;
// A color covering less of the icon than this is a speck, not one the icon reads as.
const MIN_SHARE = 0.04;
// OKLCH lightness outside these all but vanishes as a dot or rail on a dark or light theme.
const MIN_LIGHTNESS = 0.4;
const MAX_LIGHTNESS = 0.92;
// Large enough to keep small details, small enough to read in a blink.
const SAMPLE_SIZE = 64;

/**
 * The colors of RGBA pixels, most of the icon first. The most common exact color stands for
 * its close shades. Transparent and gray pixels count toward the icon but are never offered,
 * and neither are colors nearly as dark as black or as light as white.
 */
export function pickIconColors(pixels: Uint8ClampedArray): string[] {
  const counts = new Map<number, number>();
  let opaque = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    opaque++;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) < MIN_CHANNEL_SPREAD) continue;
    const rgb = (r << 16) | (g << 8) | b;
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }

  const groups: { rgb: number; count: number }[] = [];
  for (const [rgb, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const group = groups.find((candidate) => distance(candidate.rgb, rgb) < SAME_COLOR_DISTANCE);
    if (group) group.count += count;
    else groups.push({ rgb, count });
  }
  return groups
    .filter((group) => group.count >= opaque * MIN_SHARE)
    .sort((a, b) => b.count - a.count)
    .map((group) => `#${group.rgb.toString(16).padStart(6, '0')}`)
    .filter((hex) => {
      const lightness = Number(hexToOklchValues(hex)!.split(' ')[0]);
      return lightness >= MIN_LIGHTNESS && lightness <= MAX_LIGHTNESS;
    })
    .slice(0, MAX_COLORS);
}

function distance(a: number, b: number): number {
  const dr = (a >> 16) - (b >> 16);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** The colors of an icon's data URL, most of the icon first. */
export async function readIconColors(dataUrl: string): Promise<string[]> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return pickIconColors(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
}
