/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactNode } from 'react';

import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { TruncatedText } from '../../../../src/renderer/components/ui/truncated-text';

const TEXT = 'Fix the flaky SSH tunnel restart test';

function renderText(details?: ReactNode) {
  render(
    <TooltipProvider>
      <TruncatedText details={details}>{TEXT}</TruncatedText>
    </TooltipProvider>
  );
  return screen.getByText(TEXT);
}

function setWidths(element: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
}

function hover(element: HTMLElement) {
  fireEvent.pointerEnter(element);
  fireEvent.pointerMove(element);
  act(() => {
    vi.advanceTimersByTime(600);
  });
}

describe('TruncatedText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the full text when the ellipsis hides part of it', () => {
    const text = renderText();
    setWidths(text, 300, 150);

    hover(text);

    expect(screen.getByRole('tooltip')).toHaveTextContent(TEXT);
    expect(text).toHaveAttribute('title', '');
  });

  it('stays out of the way when the text fits', () => {
    const text = renderText();
    setWidths(text, 120, 150);

    hover(text);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(text).not.toHaveAttribute('title');
  });

  it('opens for its details even when the text fits', () => {
    const text = renderText(<p>Agent finished a turn</p>);
    setWidths(text, 120, 150);

    hover(text);

    expect(screen.getByRole('tooltip')).toHaveTextContent(`${TEXT}Agent finished a turn`);
  });
});
