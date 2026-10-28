/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageDiffPane } from '../../../../../src/renderer/components/workspaces/file-viewer/ImageDiffPane';
import { ImagePane } from '../../../../../src/renderer/components/workspaces/file-viewer/ImagePane';

// The theme defines `--muted` as a bare OKLCH triplet ("0.92 0.012 260"), so a
// usable colour is `oklch(var(--muted))`. `--color-muted` is the Tailwind v4
// name and is not defined, which made the checkerboard gradients invalid.
function checkerboardStyles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[style]'))
    .map((el) => el.getAttribute('style') ?? '')
    .filter((style) => style.includes('linear-gradient'));
}

describe('image transparency checkerboard', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  it('ImagePane uses the defined --muted token', () => {
    const { container } = render(
      <ImagePane data="AAAA" mimeType="image/png" fileName="logo.png" />
    );
    const styles = checkerboardStyles(container);
    expect(styles).toHaveLength(1);
    expect(styles[0]).toContain('oklch(var(--muted))');
    expect(styles[0]).not.toContain('--color-muted');
  });

  it('ImageDiffPane uses the defined --muted token on both sides', () => {
    const { container } = render(
      <ImageDiffPane
        oldImageData="AAAA"
        newImageData="BBBB"
        mimeType="image/png"
        status="modified"
        fileName="logo.png"
      />
    );
    const styles = checkerboardStyles(container);
    expect(styles).toHaveLength(2);
    for (const style of styles) {
      expect(style).toContain('oklch(var(--muted))');
      expect(style).not.toContain('--color-muted');
    }
  });
});
