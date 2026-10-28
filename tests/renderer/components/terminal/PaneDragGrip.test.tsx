/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  PaneDragBarProvider,
  usePaneDragBar,
} from '../../../../src/renderer/components/terminal/PaneDragGrip';

function Toolbar() {
  const dragBar = usePaneDragBar();
  return (
    <div data-testid="toolbar" {...dragBar}>
      <span data-testid="label">Markdown</span>
      <button type="button">Bold</button>
    </div>
  );
}

describe('usePaneDragBar', () => {
  it("drags the pane from a toolbar's empty space, not from its buttons", () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    render(
      <PaneDragBarProvider value={{ onDragStart, onDragEnd }}>
        <Toolbar />
      </PaneDragBarProvider>
    );
    expect(screen.getByTestId('toolbar')).toHaveAttribute('draggable', 'true');

    // A browser fires dragstart at the draggable toolbar, wherever the press began.
    const toolbar = screen.getByTestId('toolbar');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Bold' }));
    fireEvent.dragStart(toolbar);
    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByTestId('label'));
    fireEvent.dragStart(toolbar);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    fireEvent.dragEnd(screen.getByTestId('label'));
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('leaves a toolbar outside a pane undraggable', () => {
    render(<Toolbar />);
    expect(screen.getByTestId('toolbar')).not.toHaveAttribute('draggable');
  });
});
