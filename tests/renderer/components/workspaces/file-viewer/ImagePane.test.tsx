/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePane } from '../../../../../src/renderer/components/workspaces/file-viewer/ImagePane';

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(element: HTMLElement) {
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 600 });
    this.callback();
  }
  disconnect() {}
}

function renderImage() {
  render(<ImagePane data="aW1hZ2U=" mimeType="image/png" fileName="shot.png" />);
  const image = screen.getByRole('img', { name: 'shot.png' });
  Object.defineProperty(image, 'naturalWidth', { value: 1600 });
  Object.defineProperty(image, 'naturalHeight', { value: 600 });
  fireEvent.load(image);
  return { viewer: screen.getByRole('group', { name: 'shot.png image viewer' }), image };
}

describe('ImagePane', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.setPointerCapture = vi.fn();
  });

  it('fits a large image and shows its zoom against the real size', () => {
    const { image } = renderImage();

    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(image.style.transform).toBe('translate(0px, 150px) scale(0.5)');
  });

  it('zooms toward the cursor on pinch and pans on plain scrolling', () => {
    const { viewer, image } = renderImage();

    fireEvent.wheel(viewer, {
      ctrlKey: true,
      deltaY: -100 * Math.log(1.2),
      clientX: 0,
      clientY: 0,
    });
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(image.style.transform).toMatch(/^translate\(0px, 120px\) scale\(0\.6/);

    // A mouse-wheel notch zooms one modest step, not a jump
    fireEvent.wheel(viewer, { ctrlKey: true, deltaY: -100, clientX: 0, clientY: 0 });
    expect(screen.getByText('77%')).toBeInTheDocument();

    fireEvent.wheel(viewer, { deltaX: 300, deltaY: 0 });
    expect(image.style.transform).toMatch(/^translate\(-300px, /);
  });

  it('pans a zoomed image by dragging, stopping at its edges', () => {
    const { viewer, image } = renderImage();
    fireEvent.doubleClick(viewer, { clientX: 0, clientY: 300 });

    fireEvent.pointerDown(viewer, { button: 0, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(viewer, { clientX: 300, clientY: 300 });
    expect(image.style.transform).toBe('translate(-200px, 0px) scale(1)');

    fireEvent.pointerMove(viewer, { clientX: -5000, clientY: 300 });
    fireEvent.pointerUp(viewer);
    expect(image.style.transform).toBe('translate(-800px, 0px) scale(1)');
  });

  it('toggles fit and actual size with double-click, buttons and keys', async () => {
    const user = userEvent.setup();
    const { viewer } = renderImage();

    fireEvent.doubleClick(viewer, { clientX: 400, clientY: 300 });
    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.doubleClick(viewer, { clientX: 400, clientY: 300 });
    expect(screen.getByText('50%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('67%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByText('50%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1:1' }));
    expect(screen.getByText('100%')).toBeInTheDocument();

    viewer.focus();
    await user.keyboard('0');
    expect(screen.getByText('50%')).toBeInTheDocument();
    await user.keyboard('-');
    expect(screen.getByText('33%')).toBeInTheDocument();
    await user.keyboard('1');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
