/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { lazy, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DeferredDialog } from '../../../../src/renderer/components/ui/DeferredDialog';
import { createDeferred } from '../../../setup';

describe('DeferredDialog', () => {
  it('loads only on first open without hiding the app, and preserves state and close effects', async () => {
    const onClose = vi.fn();
    const onUnmount = vi.fn();
    function Dialog({ open }: { open: boolean }) {
      const [draft, setDraft] = useState('');
      useEffect(() => {
        if (!open) onClose();
      }, [open]);
      useEffect(() => onUnmount, []);
      return open ? (
        <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : null;
    }
    const module = createDeferred<{ default: typeof Dialog }>();
    const load = vi.fn(() => module.promise);
    const LazyDialog = lazy(load);
    const content = (open: boolean) => (
      <>
        <button>Workspace</button>
        <DeferredDialog open={open}>
          <LazyDialog open={open} />
        </DeferredDialog>
      </>
    );

    const { rerender } = render(content(false));
    expect(load).not.toHaveBeenCalled();
    rerender(content(true));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeVisible();
    await act(async () => module.resolve({ default: Dialog }));
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Keep my draft' } });

    rerender(content(false));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
    rerender(content(true));
    expect(screen.getByLabelText('Draft')).toHaveValue('Keep my draft');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
