/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/lib/error-reporting', () => ({ reportError: vi.fn() }));

import { ErrorBoundary, RootErrorFallback } from '../../../src/renderer/components/ErrorBoundary';

function Boom(): never {
  throw new Error('Render exploded');
}

function MaybeBoom({ explode, label }: { explode: boolean; label: string }) {
  if (explode) throw new Error('Render exploded');
  return <div>{label}</div>;
}

// Counts its mounts, to tell a re-render from a remount.
let mounts = 0;
function Counted({ label }: { label: string }) {
  useState(() => ++mounts);
  return <div>{label}</div>;
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

  it('shows its children again once its reset key changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="a.ts">
        <MaybeBoom explode label="a.ts" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="b.ts">
        <MaybeBoom explode={false} label="b.ts" />
      </ErrorBoundary>
    );

    expect(screen.getByText('b.ts')).toBeInTheDocument();
  });

  it('keeps its children mounted when its reset key changes', () => {
    mounts = 0;
    const { rerender } = render(
      <ErrorBoundary resetKey="a.ts">
        <Counted label="a.ts" />
      </ErrorBoundary>
    );

    rerender(
      <ErrorBoundary resetKey="b.ts">
        <Counted label="b.ts" />
      </ErrorBoundary>
    );

    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(mounts).toBe(1);
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
