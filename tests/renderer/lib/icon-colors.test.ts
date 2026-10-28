import { describe, expect, it } from 'vitest';

import { pickIconColors } from '../../../src/renderer/lib/icon-colors';

type Pixel = [number, number, number, number];

/** RGBA pixels: each color repeated its count of times. */
function pixels(...runs: [Pixel, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(runs.flatMap(([pixel, count]) => Array(count).fill(pixel).flat()));
}

const react: Pixel = [0x61, 0xda, 0xfb, 255];
const rose: Pixel = [0xe1, 0x1d, 0x48, 255];
const transparent: Pixel = [0, 0, 0, 0];

describe('pickIconColors', () => {
  it("gives a flat logo's exact color", () => {
    expect(pickIconColors(pixels([react, 300], [transparent, 700]))).toEqual(['#61dafb']);
  });

  it('offers nothing for an icon in gray, black and white only', () => {
    const icon = pixels(
      [[0, 0, 0, 255], 400],
      [[255, 255, 255, 255], 400],
      [[90, 92, 96, 255], 200]
    );
    expect(pickIconColors(icon)).toEqual([]);
  });

  it('counts anti-aliased shades toward the color they blend from', () => {
    const icon = pixels(
      [react, 100],
      [[0x5a, 0xd0, 0xf0, 255], 60],
      [[0x6a, 0xe0, 0xff, 255], 60],
      [rose, 150]
    );
    expect(pickIconColors(icon)).toEqual(['#61dafb', '#e11d48']);
  });

  it('skips specks and half-transparent edges', () => {
    const violet: Pixel = [0x7c, 0x3a, 0xed, 255];
    const icon = pixels([rose, 400], [violet, 10], [[0x7c, 0x3a, 0xed, 100], 500]);
    expect(pickIconColors(icon)).toEqual(['#e11d48']);
  });

  it('offers at most three colors, most of the icon first', () => {
    const icon = pixels(
      [react, 300],
      [rose, 400],
      [[0x22, 0xc5, 0x5e, 255], 150],
      [[0xf5, 0x9e, 0x0b, 255], 100]
    );
    expect(pickIconColors(icon)).toEqual(['#e11d48', '#61dafb', '#22c55e']);
  });

  it('skips colors nearly as dark as black or as light as white', () => {
    const navy: Pixel = [0x0a, 0x1a, 0x40, 255];
    const cream: Pixel = [0xfe, 0xf3, 0xc7, 255];
    expect(pickIconColors(pixels([navy, 500], [cream, 300], [rose, 100]))).toEqual(['#e11d48']);
  });

  it('offers nothing for an empty or fully transparent image', () => {
    expect(pickIconColors(new Uint8ClampedArray())).toEqual([]);
    expect(pickIconColors(pixels([transparent, 100]))).toEqual([]);
  });
});
