/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TruncatingLabel } from '../../../../src/renderer/components/ui/truncating-label';

describe('TruncatingLabel', () => {
  // jsdom has no layout, so these pin the structure the dropping relies on: a wrapping row that
  // clips its second line, running right to left and packed at its left, with an empty item the
  // full line's height first in line order, then any trailing part, then the label, starting from
  // a few characters' width and growing to fill the line. With less room than those few
  // characters beside the rest, the label wraps onto the hidden line instead of truncating to a
  // stub.
  it('truncates to a few characters, then wraps onto a line it hides', () => {
    render(
      <button type="button">
        <TruncatingLabel>Jump to…</TruncatingLabel>
      </button>
    );

    const label = screen.getByText('Jump to…');
    // Left-aligned, since a button centers its text and the label grows past it.
    expect(label).toHaveClass('truncate', 'min-w-0', 'grow', 'basis-[3.5em]', 'text-left');
    expect(label).toHaveClass('order-last');
    const row = label.parentElement!;
    expect(row).toHaveClass('flex-wrap', 'overflow-hidden', 'min-w-0', 'h-full');
    expect(row).toHaveClass('flex-row-reverse', 'justify-end');
    expect(row.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(row.firstElementChild).toHaveClass('h-full', 'w-0');
    // Nothing trails it.
    expect(row.children).toHaveLength(2);
  });

  // The trailing part, such as a shortcut, outlasts the label: ahead of it in line order, it
  // fills the first line before the label, so the label is what wraps out, and then, alone on that
  // line, it packs to the row's left, beside whatever precedes the label.
  it('keeps a trailing part after the label drops', () => {
    render(
      <button type="button">
        <TruncatingLabel trailing={<kbd>⌘P</kbd>}>Jump to…</TruncatingLabel>
      </button>
    );

    const label = screen.getByText('Jump to…');
    const trailing = screen.getByText('⌘P').parentElement!;
    expect(trailing).toHaveClass('shrink-0');
    expect(trailing).not.toHaveClass('order-last');
    // Spaced from the label by a margin, outside the label's starting width.
    expect(label).toHaveClass('mr-1');
    expect(label).not.toHaveClass('pr-1');
    expect(trailing.parentElement).toBe(label.parentElement);
    expect(label).toHaveClass('order-last', 'basis-[3.5em]');
    // In reading order, the label still comes first.
    expect(label.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves out a trailing part that renders nothing', () => {
    render(
      <button type="button">
        <TruncatingLabel trailing={false}>Jump to…</TruncatingLabel>
      </button>
    );

    expect(screen.getByText('Jump to…').parentElement!.children).toHaveLength(2);
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
    expect(label).not.toHaveClass('basis-[3.5em]');
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
