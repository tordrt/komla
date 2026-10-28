/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KomlaMark } from '../../../../src/renderer/components/ui/komla-mark';

// The app icon is the master; KomlaMark and docs/brand carry copies of its three komlas.
// (jsdom's import.meta.url isn't a file: URL, so these resolve from the repo root.)
const iconSvg = readFileSync(join(process.cwd(), 'resources/icon.svg'), 'utf8');
const brandMark = readFileSync(join(process.cwd(), 'docs/brand/komla-mark.svg'), 'utf8');

const komlaPaths = (svg: string) =>
  [...svg.matchAll(/<path id="komla-\d" d="([^"]+)"/g)].map((match) => match[1]);
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('KomlaMark', () => {
  it('has docs/brand regenerated from the app icon', () => {
    expect(komlaPaths(iconSvg)).toHaveLength(3);
    expect(komlaPaths(brandMark)).toEqual(komlaPaths(iconSvg));
  });

  it('draws the app icon’s three komlas', () => {
    // docs/brand/komla-mark.svg's viewBox is the square of the icon that KomlaMark's 100 box covers.
    const [x, y, size] = numbers(brandMark.match(/viewBox="([^"]+)"/)![1]);
    const { container } = render(<KomlaMark />);
    const drawn = [...container.querySelectorAll('path[fill="currentColor"]')].map((path) =>
      numbers(path.getAttribute('d')!)
    );

    const expected = komlaPaths(iconSvg).map((d) =>
      numbers(d).map((n, i) => ((n - (i % 2 === 0 ? x : y)) / size) * 100)
    );
    expect(drawn).toHaveLength(expected.length);
    drawn.forEach((komla, k) => {
      expect(komla).toHaveLength(expected[k].length);
      // Both sides are rounded to one decimal.
      komla.forEach((n, i) => expect(Math.abs(n - expected[k][i])).toBeLessThan(0.1));
    });
  });
});
