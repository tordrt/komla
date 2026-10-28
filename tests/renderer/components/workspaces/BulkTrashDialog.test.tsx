/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BulkTrashDialog } from '../../../../src/renderer/components/workspaces/BulkTrashDialog';
import { createSshWorkspace, createTerminal, createWorkspace } from '../../../factories';

describe('BulkTrashDialog', () => {
  it('lists the workspaces and trashes them once confirmed', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <BulkTrashDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        workspaces={[
          createWorkspace({ customName: 'Auth refactor', terminals: [] }),
          createWorkspace({ name: 'docs-pass', terminals: [] }),
        ]}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Move 2 workspaces to the Trash?')).toBeInTheDocument();
    expect(within(dialog).getByText('Auth refactor')).toBeInTheDocument();
    expect(within(dialog).getByText('docs-pass')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move All to Trash' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns about running agents, also those another device runs on the host', () => {
    render(
      <BulkTrashDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        workspaces={[
          createWorkspace({ terminals: [createTerminal({ status: 'running' })] }),
          createSshWorkspace({
            terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
          }),
          createWorkspace({ terminals: [createTerminal({ status: 'stopped' })] }),
        ]}
      />
    );

    expect(
      screen.getByText('2 of these workspaces are currently running and will be stopped.')
    ).toBeInTheDocument();
  });

  it('names workspaces by the title their rows show', () => {
    render(
      <BulkTrashDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        workspaces={[
          createWorkspace({ name: 'brave-otter-42', lastDynamicTitle: 'Fix login redirect' }),
          createWorkspace({ name: 'calm-heron-7', terminals: [] }),
        ]}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Fix login redirect')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('brave-otter-42');
    expect(within(dialog).getByText('calm-heron-7')).toBeInTheDocument();
  });

  it('marks Escape handled, so the overview behind it stays', () => {
    const windowEscapes: boolean[] = [];
    const windowEscape = (event: KeyboardEvent) => windowEscapes.push(event.defaultPrevented);
    window.addEventListener('keydown', windowEscape);
    const onOpenChange = vi.fn();
    render(
      <BulkTrashDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
        workspaces={[createWorkspace({ terminals: [] }), createWorkspace({ terminals: [] })]}
      />
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(windowEscapes).toEqual([true]);
    window.removeEventListener('keydown', windowEscape);
  });
});
