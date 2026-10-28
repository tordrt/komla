/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublishRepoDialogHost } from '../../../../src/renderer/components/layout/PublishRepoDialogHost';
import { useGitStatusStore } from '../../../../src/renderer/stores/git-status.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { usePublishRepoDialogStore } from '../../../../src/renderer/stores/publish-repo-dialog.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createProject, createWorktreeWorkspace } from '../../../factories';

const addOriginRemote = vi.fn();
const pushProjectBranches = vi.fn();
const invalidateStatus = vi.fn();
const fetchStatusIfStale = vi.fn();

async function addRemote(url: string) {
  fireEvent.change(await screen.findByLabelText('Remote URL'), { target: { value: url } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add Remote' }));
  });
}

describe('PublishRepoDialogHost', () => {
  beforeEach(() => {
    addOriginRemote.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    pushProjectBranches.mockReset().mockResolvedValue({ success: true, message: 'Pushed main' });
    invalidateStatus.mockReset();
    fetchStatusIfStale.mockReset().mockResolvedValue(undefined);
    window.api = {
      ...window.api,
      checkGhAuth: vi.fn().mockResolvedValue({ authenticated: false, installed: true }),
      createGithubRepo: vi.fn(),
      addOriginRemote,
      pushProjectBranches,
    } as typeof window.api;
    useGitStatusStore.setState({ invalidateStatus, fetchStatusIfStale });
    useWorkspacesStore.setState({
      workspaces: [
        createWorktreeWorkspace({ id: 'local-1', projectId: 'project-1' }),
        createWorktreeWorkspace({ id: 'other-1', projectId: 'other' }),
      ],
    });
    useToastStore.setState({ toasts: [] });
    useProjectsStore.setState({
      projects: [
        createProject({ id: 'project-1', name: 'Komla', repositoryPath: '/repos/komla' }),
        createProject({
          id: 'managed-1',
          name: 'Cloned',
          managed: true,
          managedRepoPath: '/managed/cloned',
        }),
      ],
    });
    usePublishRepoDialogStore.setState({ open: false, request: null });
  });

  it('publishes the project, pushes its branches, then retries the SSH workspace', async () => {
    const onPublished = vi.fn();
    render(<PublishRepoDialogHost />);
    act(() =>
      usePublishRepoDialogStore
        .getState()
        .openForProject({ projectId: 'project-1', branches: ['main', 'feature'], onPublished })
    );

    expect(screen.getByText(/SSH hosts clone Komla from a Git remote/)).toBeInTheDocument();
    await addRemote('git@github.com:me/komla.git');

    expect(addOriginRemote).toHaveBeenCalledWith('/repos/komla', 'git@github.com:me/komla.git');
    expect(pushProjectBranches).toHaveBeenCalledWith('project-1', ['main', 'feature']);
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(usePublishRepoDialogStore.getState().open).toBe(false);
    // The project's other workspaces stop offering to publish it.
    expect(invalidateStatus.mock.calls).toEqual([['local-1']]);
  });

  it('does not retry when pushing to the new remote fails', async () => {
    pushProjectBranches.mockResolvedValue({ success: false, message: 'Permission denied' });
    const onPublished = vi.fn();
    render(<PublishRepoDialogHost />);
    act(() =>
      usePublishRepoDialogStore
        .getState()
        .openForProject({ projectId: 'project-1', branches: ['main'], onPublished })
    );

    await addRemote('git@github.com:me/komla.git');

    expect(onPublished).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
      "Added the remote, but couldn't push to it: Permission denied"
    );
    expect(invalidateStatus).toHaveBeenCalledWith('local-1');
  });

  it('says the new remote was removed when nothing could be pushed to it', async () => {
    pushProjectBranches.mockResolvedValue({
      success: false,
      message: 'Repository not found.',
      removedOrigin: true,
    });
    const onPublished = vi.fn();
    render(<PublishRepoDialogHost />);
    act(() =>
      usePublishRepoDialogStore
        .getState()
        .openForProject({ projectId: 'project-1', branches: ['main'], onPublished })
    );

    await addRemote('git@github.com:me/komla.git');

    expect(onPublished).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
      "Couldn't push to the new remote, so it was removed: Repository not found."
    );
  });

  it("publishes a managed project's own clone", async () => {
    render(<PublishRepoDialogHost />);
    act(() =>
      usePublishRepoDialogStore.getState().openForProject({ projectId: 'managed-1', branches: [] })
    );

    await addRemote('git@github.com:me/cloned.git');

    expect(addOriginRemote).toHaveBeenCalledWith('/managed/cloned', 'git@github.com:me/cloned.git');
    expect(pushProjectBranches).not.toHaveBeenCalled();
  });
});
