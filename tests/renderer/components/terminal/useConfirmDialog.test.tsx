/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import {
  useConfirmDialog,
  type ConfirmRequest,
} from '../../../../src/renderer/components/terminal/useConfirmDialog';

let ask: (request: ConfirmRequest) => Promise<boolean>;

function Host() {
  const { confirm, confirmDialog } = useConfirmDialog();
  ask = confirm;
  return confirmDialog;
}

describe('useConfirmDialog', () => {
  it('focuses Cancel unless the request asks for the confirm button', async () => {
    render(<Host />);

    await act(async () => {
      void ask({ title: 'Discard?', description: '', confirmLabel: 'Discard' });
    });

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('moves focus for each request, so Enter never confirms one that asks for Cancel', async () => {
    render(<Host />);

    await act(async () => {
      void ask({ title: 'Stop?', description: '', confirmLabel: 'Stop', focusConfirm: true });
    });
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveFocus();

    // A newer request replaces the open one while the dialog stays up.
    await act(async () => {
      void ask({ title: 'Discard?', description: '', confirmLabel: 'Discard' });
    });

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });
});
