/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InlinePanelResizeHandle } from '../../../../src/renderer/components/terminal/InlinePanelResizeHandle';

function renderHandle(widthPx = 300) {
  const props = {
    onResizeStart: vi.fn(),
    onResize: vi.fn(),
    onReset: vi.fn(),
  };
  render(
    <InlinePanelResizeHandle
      label="Resize file tree panel"
      title="Drag to resize file tree panel"
      widthPx={widthPx}
      minWidthPx={150}
      maxWidthPx={520}
      isResizing={false}
      {...props}
    />
  );
  return { handle: screen.getByRole('separator', { name: 'Resize file tree panel' }), ...props };
}

describe('InlinePanelResizeHandle', () => {
  it('exposes its width as a focusable separator', () => {
    const { handle } = renderHandle(300.4);

    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(handle).toHaveAttribute('aria-valuemin', '150');
    expect(handle).toHaveAttribute('aria-valuemax', '520');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('widens the panel with ArrowLeft and narrows it with ArrowRight', () => {
    const { handle, onResize } = renderHandle(300);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(onResize.mock.calls).toEqual([[316], [284]]);
  });

  it('clamps keyboard resizing to the allowed range', () => {
    const { handle, onResize } = renderHandle(510);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(520);
  });

  it('resets to the default width on double-click or Home', () => {
    const { handle, onReset } = renderHandle();

    fireEvent.doubleClick(handle);
    fireEvent.keyDown(handle, { key: 'Home' });

    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('starts a drag on mouse down and ignores unrelated keys', () => {
    const { handle, onResizeStart, onResize, onReset } = renderHandle();

    fireEvent.mouseDown(handle, { clientX: 10 });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });

    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResize).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});
