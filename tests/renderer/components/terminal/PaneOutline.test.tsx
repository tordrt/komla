/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PaneOutline } from '../../../../src/renderer/components/terminal/PaneOutline';

describe('PaneOutline', () => {
  it("draws a notification in the focus outline's soft style, in the notification's color", () => {
    render(<PaneOutline focused={false} attention={{ color: 'oklch(var(--warning))' }} />);

    const outline = screen.getByTestId('pane-outline');
    expect(outline).toHaveAttribute('data-attention', 'true');
    expect(outline.style.getPropertyValue('--pane-attention')).toBe('oklch(var(--warning))');
    // The stylesheet softens the color, as it does the accent; nothing fades the whole line.
    expect(outline.style.borderColor).toBe('');
    expect(outline.style.opacity).toBe('');
  });

  it('gives the notification the outline over focus', () => {
    render(<PaneOutline focused attention={{ color: 'oklch(var(--error))' }} />);

    expect(screen.getByTestId('pane-outline')).toHaveAttribute('data-focused', 'false');
  });

  it('marks nothing without a notification', () => {
    render(<PaneOutline focused />);

    const outline = screen.getByTestId('pane-outline');
    expect(outline).toHaveAttribute('data-focused', 'true');
    expect(outline).not.toHaveAttribute('data-attention');
  });
});
