/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FileViewerConfirmDialogs } from '../../../../../src/renderer/components/workspaces/file-viewer/FileViewerConfirmDialogs';

type Props = ComponentProps<typeof FileViewerConfirmDialogs>;

function renderDialogs(overrides: Partial<Props> = {}) {
  const props: Props = {
    fileToDelete: null,
    deletesPermanently: false,
    onCancelDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    createTarget: null,
    createValue: '',
    onCreateValueChange: vi.fn(),
    onCancelCreate: vi.fn(),
    onConfirmCreate: vi.fn(),
    fileToRestore: null,
    onCancelRestore: vi.fn(),
    onConfirmRestore: vi.fn(),
    rollbackAllConfirmOpen: false,
    onCancelRollbackAll: vi.fn(),
    onConfirmRollbackAll: vi.fn(),
    unsavedConfirmOpen: false,
    pendingTransition: null,
    onCancelUnsaved: vi.fn(),
    onConfirmDiscard: vi.fn(),
    overwriteTarget: null,
    onCancelOverwrite: vi.fn(),
    onConfirmOverwrite: vi.fn(),
    conflictDialogOpen: false,
    conflictFilePath: null,
    onKeepMyChanges: vi.fn(),
    onReloadFromDisk: vi.fn(),
    ...overrides,
  };
  return render(<FileViewerConfirmDialogs {...props} />);
}

async function expectCancelFocused() {
  const cancel = await screen.findByRole('button', { name: 'Cancel' });
  // Delete-then-Enter must not confirm a destructive action.
  await waitFor(() => expect(document.activeElement).toBe(cancel));
}

describe('FileViewerConfirmDialogs destructive focus', () => {
  it('focuses Delete in the delete dialog, since a local delete goes to the trash', async () => {
    const onConfirmDelete = vi.fn();
    renderDialogs({ fileToDelete: { path: 'src/a.ts', isDirectory: false }, onConfirmDelete });
    const deleteButton = await screen.findByRole('button', { name: 'Delete' });
    await waitFor(() => expect(document.activeElement).toBe(deleteButton));

    await userEvent.keyboard('{Enter}');
    expect(onConfirmDelete).toHaveBeenCalledOnce();
  });

  it('focuses Cancel in the delete dialog when the delete is permanent', async () => {
    const onConfirmDelete = vi.fn();
    const onCancelDelete = vi.fn();
    renderDialogs({
      fileToDelete: { path: 'src/a.ts', isDirectory: false },
      deletesPermanently: true,
      onConfirmDelete,
      onCancelDelete,
    });
    await expectCancelFocused();

    await userEvent.keyboard('{Enter}');
    expect(onCancelDelete).toHaveBeenCalled();
    expect(onConfirmDelete).not.toHaveBeenCalled();
  });

  it('focuses Cancel in the restore dialog', async () => {
    renderDialogs({ fileToRestore: { path: 'src/a.ts', status: 'untracked' } });
    await expectCancelFocused();
  });

  it('focuses Cancel in the overwrite dialog', async () => {
    renderDialogs({ overwriteTarget: { src: 'a.ts', dest: 'src/a.ts', isDirectory: false } });
    await expectCancelFocused();
  });
});

describe('FileViewerConfirmDialogs delete copy', () => {
  it('titles file deletion "Delete File"', async () => {
    renderDialogs({ fileToDelete: { path: 'src/a.ts', isDirectory: false } });
    expect(await screen.findByRole('heading', { name: 'Delete File' })).toBeInTheDocument();
  });

  it('titles folder deletion "Delete Folder" and mentions its contents', async () => {
    renderDialogs({ fileToDelete: { path: 'src', isDirectory: true } });
    expect(await screen.findByRole('heading', { name: 'Delete Folder' })).toBeInTheDocument();
    expect(screen.getByText(/all of its contents/i)).toBeInTheDocument();
  });

  it('warns that a delete on an SSH host is permanent, since it skips the trash', async () => {
    renderDialogs({ fileToDelete: { path: 'src', isDirectory: true }, deletesPermanently: true });
    expect(await screen.findByText(/permanently/i)).toBeInTheDocument();
  });

  it('does not call a local delete permanent', async () => {
    renderDialogs({ fileToDelete: { path: 'src/a.ts', isDirectory: false } });
    await screen.findByRole('heading', { name: 'Delete File' });
    expect(screen.queryByText(/permanently/i)).not.toBeInTheDocument();
  });
});
