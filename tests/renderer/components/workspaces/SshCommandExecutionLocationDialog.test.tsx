/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SshCommandExecutionLocationDialog } from '../../../../src/renderer/components/workspaces/SshCommandExecutionLocationDialog';

import type { SshWorkspaceMode } from '../../../../src/shared/lib/ssh-workspace-mode';

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

function renderDialog(choice: SshWorkspaceMode, hostName?: string) {
  const onChoiceChange = vi.fn();
  const { unmount } = render(
    <SshCommandExecutionLocationDialog
      open
      projectName="acme"
      hostName={hostName}
      choice={choice}
      saving={false}
      error={null}
      onChoiceChange={onChoiceChange}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
  return { onChoiceChange, unmount };
}

describe('SshCommandExecutionLocationDialog', () => {
  it('keeps the already-selected location when it is clicked again', async () => {
    const user = userEvent.setup();
    const { onChoiceChange } = renderDialog('local-mirror-actions');

    await user.click(screen.getByText('This computer', { selector: 'button, button *' }));

    expect(onChoiceChange).not.toHaveBeenCalledWith('remote');
  });

  it('sets the location that was clicked and marks only it as selected', async () => {
    const user = userEvent.setup();
    const { onChoiceChange } = renderDialog('remote');

    const remote = screen.getByRole('button', { name: 'Remote machine' });
    const local = screen.getByRole('button', { name: 'This computer' });
    expect(remote).toHaveAttribute('aria-pressed', 'true');
    expect(local).toHaveAttribute('aria-pressed', 'false');

    await user.click(remote);
    expect(onChoiceChange).not.toHaveBeenCalledWith('local-mirror-actions');

    await user.click(local);
    expect(onChoiceChange).toHaveBeenLastCalledWith('local-mirror-actions');
  });

  it('styles the selected location the same whichever option it is', () => {
    const { unmount } = renderDialog('remote');
    const remoteSelectedClass = screen.getByRole('button', { name: 'Remote machine' }).className;
    unmount();

    renderDialog('local-mirror-actions');
    expect(screen.getByRole('button', { name: 'This computer' }).className).toBe(
      remoteSelectedClass
    );
  });

  it('describes each option neutrally instead of recommending both', () => {
    renderDialog('remote');

    expect(screen.queryByText(/Recommended/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Best for web, backend, CLI, and library development/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Best for desktop, mobile, and locally interactive apps/)
    ).toBeInTheDocument();
  });

  it('names the run button after the selected location', () => {
    const { unmount } = renderDialog('remote');
    expect(screen.getByRole('button', { name: 'Run remotely' })).toBeInTheDocument();
    unmount();

    renderDialog('local-mirror-actions');
    expect(screen.getByRole('button', { name: 'Run on this computer' })).toBeInTheDocument();
  });

  it('explains the local copy only when this computer is selected', () => {
    const { unmount } = renderDialog('remote');
    expect(screen.queryByText('How the local copy works')).not.toBeInTheDocument();
    unmount();

    renderDialog('local-mirror-actions');
    expect(screen.getByText('How the local copy works')).toBeInTheDocument();
    expect(screen.getByText(/Gitignored files/)).toBeInTheDocument();
  });

  it('shows the SSH host on the remote option without changing its name', () => {
    renderDialog('remote', 'devbox');

    const remote = screen.getByRole('button', { name: 'Remote machine' });
    expect(remote).toHaveTextContent('devbox');
  });
});
