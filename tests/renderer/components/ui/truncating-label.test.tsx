/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TruncatingLabel } from '../../../../src/renderer/components/ui/truncating-label';

describe('TruncatingLabel', () => {
  // jsdom has no layout, so this pins the structure the dropping relies on: an empty first item
  // the full line's height, then the label, starting from a few characters' width and growing to
  // fill the line, in a wrapping row that clips its second line. With less room than those few
  // characters, the label wraps onto that line instead of truncating to a stub.
  it('truncates to a few characters, then wraps onto a line it hides', () => {
    render(
      <button type="button">
        <TruncatingLabel>Jump to…</TruncatingLabel>
      </button>
    );

    const label = screen.getByText('Jump to…');
    // Left-aligned, since a button centers its text and the label grows past it.
    expect(label).toHaveClass('truncate', 'grow', 'basis-[3em]', 'text-left');
    const row = label.parentElement!;
    expect(row).toHaveClass('flex-wrap', 'overflow-hidden', 'min-w-0', 'h-full');
    expect(row.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(row.firstElementChild).toHaveClass('h-full', 'w-0');
  });

  it('shows a short name whole or not at all, and sizes a control that fits its content', () => {
    render(
      <button type="button">
        <TruncatingLabel whole>Komla</TruncatingLabel>
      </button>
    );

    // From its full width, so it wraps out rather than shortening, and a button sized to its
    // content is as wide as the name.
    const label = screen.getByText('Komla');
    expect(label).toHaveClass('basis-auto');
    expect(label).not.toHaveClass('basis-[3em]');
  });

  it('still names what it labels while hidden', () => {
    render(
      <button type="button">
        <TruncatingLabel>Komla</TruncatingLabel>
      </button>
    );

    expect(screen.getByRole('button', { name: 'Komla' })).toBeTruthy();
  });
});
