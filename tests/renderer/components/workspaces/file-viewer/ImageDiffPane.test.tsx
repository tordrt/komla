/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageDiffPane } from '../../../../../src/renderer/components/workspaces/file-viewer/ImageDiffPane';

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(element: HTMLElement) {
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 300 });
    this.callback();
  }
  disconnect() {}
}

function loadImage(name: string, w: number, h: number) {
  const image = screen.getByRole('img', { name });
  Object.defineProperty(image, 'naturalWidth', { value: w });
  Object.defineProperty(image, 'naturalHeight', { value: h });
  fireEvent.load(image);
  return image;
}

function renderDiff(oldSize = { w: 800, h: 600 }) {
  render(
    <ImageDiffPane
      oldImageData="b2xk"
      newImageData="bmV3"
      mimeType="image/png"
      status="modified"
      fileName="logo.png"
    />
  );
  return {
    oldImage: loadImage('logo.png (old)', oldSize.w, oldSize.h),
    newImage: loadImage('logo.png (new)', 1600, 1200),
  };
}

describe('ImageDiffPane', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  it('fits each side on its own and shows the new side’s zoom', () => {
    const { oldImage, newImage } = renderDiff();

    expect(oldImage.style.transform).toBe('translate(0px, 0px) scale(0.5)');
    expect(newImage.style.transform).toBe('translate(0px, 0px) scale(0.25)');
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('800 x 600')).toBeInTheDocument();
    expect(screen.getByText('1600 x 1200')).toBeInTheDocument();
  });

  it('zooms and pans both sides together', async () => {
    const user = userEvent.setup();
    const { oldImage, newImage } = renderDiff({ w: 1600, h: 1200 });

    await user.click(screen.getByRole('button', { name: '1:1' }));
    expect(oldImage.style.transform).toBe('translate(-600px, -450px) scale(1)');
    expect(newImage.style.transform).toBe('translate(-600px, -450px) scale(1)');

    fireEvent.wheel(screen.getByRole('group', { name: 'logo.png (old) image viewer' }), {
      deltaX: 100,
      deltaY: 0,
    });
    expect(oldImage.style.transform).toBe('translate(-700px, -450px) scale(1)');
    expect(newImage.style.transform).toBe('translate(-700px, -450px) scale(1)');

    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(newImage.style.transform).toBe('translate(0px, 0px) scale(0.25)');
  });
});
