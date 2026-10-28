/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/error-reporting', () => ({ reportError: vi.fn() }));

import { ErrorBoundary, RootErrorFallback } from '../../../src/renderer/components/ErrorBoundary';

function Boom(): never {
  throw new Error('Render exploded');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.api = { copyToClipboard: vi.fn() } as unknown as typeof window.api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses theme tokens and the shared Button in the default fallback', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toHaveClass('text-error');
    expect(screen.getByText('Something went wrong')).not.toHaveClass('text-red-500');
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveClass('inline-flex');
  });

  it('renders a fallback function with the caught error', () => {
    render(
      <ErrorBoundary fallback={(error) => <RootErrorFallback error={error} />}>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('button', { name: 'Reload window' })).toBeInTheDocument();
    expect(screen.getByText('Render exploded')).toBeInTheDocument();
  });

  it('copies the error details from the root fallback', () => {
    const error = new Error('Render exploded');
    render(<RootErrorFallback error={error} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }));

    expect(window.api.copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('Error: Render exploded')
    );
  });
});
