/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/components/layout/ReleaseNotesDialog', () => ({
  ReleaseNotesDialog: () => null,
}));

type TestTerminal = { id: string; status: string; remoteSessionResumable?: boolean };
const workspacesState = {
  workspaces: [] as Array<{ id: string; backend?: { kind: 'ssh' }; terminals: TestTerminal[] }>,
};
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: typeof workspacesState) => unknown) =>
    selector(workspacesState),
}));

import { UpdateBanner } from '../../../../src/renderer/components/layout/UpdateBanner';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useUpdateStore } from '../../../../src/renderer/stores/update.store';

const installUpdate = vi.fn();

describe('UpdateBanner', () => {
  beforeEach(() => {
    installUpdate.mockReset();
    window.api = { installUpdate } as unknown as typeof window.api;
    useUpdateStore.setState({ status: 'ready', version: '2.0.0', dismissed: false });
    workspacesState.workspaces = [];
  });

  it('restarts immediately when nothing is running', () => {
    render(<UpdateBanner />, { wrapper: TooltipProvider });

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));

    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before stopping running terminals and agents', () => {
    workspacesState.workspaces = [
      {
        id: 'ws-1',
        terminals: [
          { id: 't1', status: 'running' },
          { id: 't2', status: 'stopped' },
        ],
      },
      { id: 'ws-2', terminals: [{ id: 't3', status: 'starting' }] },
    ];
    render(<UpdateBanner />, { wrapper: TooltipProvider });

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));

    expect(installUpdate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('2 terminals are still running and will be stopped');
    expect(dialog).toHaveTextContent(/installs .*when you quit/);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(installUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not count remote sessions that survive a restart', () => {
    workspacesState.workspaces = [
      {
        id: 'ws-1',
        backend: { kind: 'ssh' },
        terminals: [{ id: 't1', status: 'running', remoteSessionResumable: true }],
      },
    ];
    render(<UpdateBanner />, { wrapper: TooltipProvider });

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));

    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it('notes that the update installs on quit and labels the dismiss button', () => {
    render(<UpdateBanner />, { wrapper: TooltipProvider });

    expect(screen.getByText(/installs .*when you quit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it('offers a download where Komla cannot update itself', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.api = { installUpdate, openExternal } as unknown as typeof window.api;
    useUpdateStore.setState({
      status: 'manual',
      version: '3.7.0',
      downloadUrl: 'https://downloads.komla.dev/latest/komla-3.7.0-x86_64.AppImage',
    });
    render(<UpdateBanner />, { wrapper: TooltipProvider });

    expect(screen.getByText('Komla v3.7.0 is available.')).toBeInTheDocument();
    expect(screen.getByText(/doesn't run from its AppImage file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart to update/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    expect(openExternal).toHaveBeenCalledWith(
      'https://downloads.komla.dev/latest/komla-3.7.0-x86_64.AppImage'
    );
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
