/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeleteActionDialog } from '../../../../../src/renderer/components/layout/settings/DeleteActionDialog';

describe('DeleteActionDialog', () => {
  it('names the Setup steps that run the quick command, and offers no delete', () => {
    render(
      <DeleteActionDialog
        open
        onOpenChange={vi.fn()}
        actionTitle="Run tests"
        usedBy={[{ project: { id: 'p1', name: 'Komla' }, step: { id: 's1', name: 'Tests' } }]}
        onConfirm={vi.fn()}
        isBusy={false}
      />
    );

    expect(screen.getByText(/Komla › Tests/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('offers to delete a quick command nothing uses', () => {
    render(
      <DeleteActionDialog
        open
        onOpenChange={vi.fn()}
        actionTitle="Run tests"
        usedBy={[]}
        onConfirm={vi.fn()}
        isBusy={false}
      />
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});
