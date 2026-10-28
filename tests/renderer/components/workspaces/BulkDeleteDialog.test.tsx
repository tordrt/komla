/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BulkDeleteDialog } from '../../../../src/renderer/components/workspaces/BulkDeleteDialog';
import {
  createSshWorkspace,
  createTerminal,
  createWorkspace,
  createWorktreeWorkspace,
} from '../../../factories';

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: { projects: [] }) => unknown) => selector({ projects: [] }),
}));

describe('BulkDeleteDialog', () => {
  it('counts agents another device runs on the host among those that will be stopped', () => {
    render(
      <BulkDeleteDialog
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
});

describe('BulkDeleteDialog keeping unsaved work', () => {
  const clean = createWorktreeWorkspace({ id: 'ws-clean', customName: 'Merged cleanup' });
  const dirty = createWorktreeWorkspace({ id: 'ws-dirty', customName: 'Half-done refactor' });
  const unpushed = createWorktreeWorkspace({ id: 'ws-unpushed', customName: 'Squash-merged fix' });
  const offline = createWorktreeWorkspace({ id: 'ws-offline', customName: 'Remote spike' });

  function mockGit() {
    const uncommittedFiles: Record<string, number> = { 'ws-dirty': 2 };
    const commitsAhead: Record<string, number> = { 'ws-unpushed': 3 };
    window.api = {
      getWorkspaceDiff: vi.fn(async (id: string) => {
        if (id === 'ws-offline') throw new Error('Host unreachable');
        const files = Array.from({ length: uncommittedFiles[id] ?? 0 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          status: 'modified',
          staged: false,
          additions: 1,
          deletions: 0,
        }));
        return { files, summary: { additions: 0, deletions: 0, filesChanged: files.length } };
      }),
      getWorkspaceGitBranchStatus: vi.fn(async (id: string) => ({
        hasRemote: false,
        unpushedCommits: 0,
        aheadTargetBranch: commitsAhead[id] ?? 0,
      })),
    } as any;
  }

  function renderKeeping(onConfirm = vi.fn()) {
    mockGit();
    render(
      <BulkDeleteDialog
        open
        keepUnsavedWork
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        workspaces={[clean, dirty, unpushed, offline]}
      />
    );
    return onConfirm;
  }

  it('keeps workspaces whose work would be lost and deletes the rest', async () => {
    const onConfirm = renderKeeping();

    expect(
      screen.getByText('Checking for uncommitted changes and unpushed commits…')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete All' })).toBeDisabled();

    expect(await screen.findByText('Delete 1 workspace?')).toBeInTheDocument();
    expect(screen.getByText('Keeping 3 workspaces with unsaved work')).toBeInTheDocument();
    expect(
      screen.getByText('Half-done refactor: uncommitted changes in 2 files')
    ).toBeInTheDocument();
    expect(screen.getByText('Squash-merged fix: 3 unpushed commits')).toBeInTheDocument();
    expect(screen.getByText("Remote spike: couldn't check for unsaved work")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledWith(true, [clean]);
  });

  it('deletes workspaces with only unpushed commits once their branches are kept', async () => {
    const onConfirm = renderKeeping();
    await screen.findByText('Delete 1 workspace?');

    fireEvent.click(screen.getByRole('switch'));

    expect(screen.getByText('Delete 2 workspaces?')).toBeInTheDocument();
    expect(screen.queryByText(/Squash-merged fix:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete All' }));
    expect(onConfirm).toHaveBeenCalledWith(false, [clean, unpushed]);
  });

  it('offers to keep the branches when every workspace has unpushed commits', async () => {
    mockGit();
    const onConfirm = vi.fn();
    render(
      <BulkDeleteDialog
        open
        keepUnsavedWork
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        workspaces={[unpushed]}
      />
    );

    expect(await screen.findByText('Nothing to delete')).toBeInTheDocument();
    expect(screen.getByText(/Turn off “Also delete local branches”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));

    expect(screen.getByText('Delete 1 workspace?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledWith(false, [unpushed]);
  });

  it('deletes a hand-picked selection without asking git', () => {
    mockGit();
    const onConfirm = vi.fn();
    render(
      <BulkDeleteDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        workspaces={[clean, dirty]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete All' }));

    expect(window.api.getWorkspaceDiff).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledWith(true, [clean, dirty]);
  });
});
