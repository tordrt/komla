/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoadingState } from '../../../../src/renderer/components/ui/loading-state';

describe('LoadingState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing for a load that ends at once, then a spinner and what is loading', () => {
    render(<LoadingState label="Loading diff" />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => vi.advanceTimersByTime(200));

    expect(screen.getByRole('status', { name: 'Loading diff' })).toBeInTheDocument();
    expect(screen.getByText('Loading diff…')).toBeInTheDocument();
  });

  it('shows at once when asked to', () => {
    render(<LoadingState label="Loading editor" delayMs={0} />);
    expect(screen.getByRole('status', { name: 'Loading editor' })).toBeInTheDocument();
  });
});
