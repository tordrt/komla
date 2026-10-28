import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { readStatusIcon, statusIconDataUrl } from '../../../src/main/lib/status-icon';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

describe('statusIconDataUrl', () => {
  it('makes SVG markup and image data URLs base64 data URLs', () => {
    expect(statusIconDataUrl(` ${svg} `)).toBe(svgUrl);
    expect(statusIconDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toBe(svgUrl);
    expect(statusIconDataUrl(`data:image/svg+xml;utf8,${svg}`)).toBeUndefined();
    expect(statusIconDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    );
  });

  it('turns away what is not an image, and images over 32 KB', () => {
    expect(statusIconDataUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(statusIconDataUrl('https://example.com/logo.svg')).toBeUndefined();
    expect(statusIconDataUrl('data:image/svg+xml,%E0%A4%A')).toBeUndefined();
    expect(statusIconDataUrl('data:image/png;base64,')).toBeUndefined();
    expect(statusIconDataUrl(`<svg>${'x'.repeat(32 * 1024)}</svg>`)).toBeUndefined();
  });
});

describe('readStatusIcon', () => {
  const settings = mkdtempSync(join(tmpdir(), 'status-icon-'));
  mkdirSync(join(settings, 'icons'));
  writeFileSync(join(settings, 'icons', 'logo.svg'), svg);
  writeFileSync(join(settings, 'secret.svg'), svg);
  afterAll(() => rmSync(settings, { recursive: true, force: true }));

  it('reads icons from the icons folder only', async () => {
    await expect(readStatusIcon(settings, 'icons/logo.svg')).resolves.toBe(svgUrl);
    await expect(readStatusIcon(settings, 'icons/missing.svg')).resolves.toBeUndefined();
    await expect(readStatusIcon(settings, 'secret.svg')).resolves.toBeUndefined();
    await expect(readStatusIcon(settings, 'icons/../secret.svg')).resolves.toBeUndefined();
    await expect(readStatusIcon(settings, svg)).resolves.toBe(svgUrl);
  });

  it('reads an icon file again once it changes', async () => {
    const path = join(settings, 'icons', 'changing.svg');
    writeFileSync(path, svg);
    await expect(readStatusIcon(settings, 'icons/changing.svg')).resolves.toBe(svgUrl);
    const changed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"/>';
    writeFileSync(path, changed);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await expect(readStatusIcon(settings, 'icons/changing.svg')).resolves.toBe(
      `data:image/svg+xml;base64,${Buffer.from(changed).toString('base64')}`
    );
  });
});
