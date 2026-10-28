/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { abortWorkspaceRebase } = vi.hoisted(() => ({ abortWorkspaceRebase: vi.fn() }));

vi.mock('../../../../src/renderer/utils/rebase-abort', () => ({ abortWorkspaceRebase }));

import { RebaseAbortDialog } from '../../../../src/renderer/components/layout/RebaseAbortDialog';
import { useRebaseAbortStore } from '../../../../src/renderer/stores/rebase-abort.store';

const workspace = { id: 'ws-1', workingDirectory: '/repo/feature', projectId: 'project-1' };

describe('RebaseAbortDialog', () => {
  beforeEach(() => {
    abortWorkspaceRebase.mockClear();
    useRebaseAbortStore.setState({ pending: null });
  });

  it('stays closed until an abort is requested', () => {
    render(<RebaseAbortDialog />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('warns that the abort discards work and focuses Cancel', () => {
    render(<RebaseAbortDialog />);

    act(() => useRebaseAbortStore.getState().requestAbort(workspace));

    expect(screen.getByRole('dialog')).toHaveTextContent(/conflict resolutions/i);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('aborts the requested rebase once confirmed', async () => {
    const user = userEvent.setup();
    render(<RebaseAbortDialog />);
    act(() => useRebaseAbortStore.getState().requestAbort(workspace));

    await user.click(screen.getByRole('button', { name: 'Abort rebase' }));

    expect(abortWorkspaceRebase).toHaveBeenCalledWith(workspace);
    expect(useRebaseAbortStore.getState().pending).toBeNull();
  });

  it('leaves the rebase alone when cancelled', async () => {
    const user = userEvent.setup();
    render(<RebaseAbortDialog />);
    act(() => useRebaseAbortStore.getState().requestAbort(workspace));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(abortWorkspaceRebase).not.toHaveBeenCalled();
    expect(useRebaseAbortStore.getState().pending).toBeNull();
  });
});
