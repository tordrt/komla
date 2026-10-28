/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjectsStore } from '../../../src/renderer/stores/projects.store';
import { usePublishRepoDialogStore } from '../../../src/renderer/stores/publish-repo-dialog.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import {
  handleCreateError,
  showUpgradeDialog,
  type UpgradeDialogRequest,
} from '../../../src/renderer/utils/workspace-error';
import { SshProjectNeedsRemoteError } from '../../../src/shared/types/workspace';
import { createProject } from '../../factories';

describe('showUpgradeDialog', () => {
  const listeners: Array<(event: Event) => void> = [];

  afterEach(() => {
    for (const listener of listeners) {
      window.removeEventListener('show-upgrade-dialog', listener);
    }
    listeners.length = 0;
  });

  it('carries the requested workspace count with the retry action', () => {
    const retry = vi.fn();
    let request: UpgradeDialogRequest | undefined;
    const listener = (event: Event) => {
      request = (event as CustomEvent<UpgradeDialogRequest>).detail;
    };
    listeners.push(listener);
    window.addEventListener('show-upgrade-dialog', listener);

    showUpgradeDialog(retry, 2);

    expect(request?.retry?.requestedWorkspaceCount).toBe(2);
    request?.retry?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('handleCreateError', () => {
  afterEach(() => {
    usePublishRepoDialogStore.setState({ open: false, request: null });
    useProjectsStore.setState({ projects: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('offers to publish a project an SSH workspace has no remote to clone', () => {
    useProjectsStore.setState({ projects: [createProject({ id: 'project-1' })] });
    const retry = vi.fn();

    handleCreateError(
      new SshProjectNeedsRemoteError({ projectId: 'project-1', branches: ['main'] }),
      retry
    );

    const { open, request } = usePublishRepoDialogStore.getState();
    expect(open).toBe(true);
    expect(request).toMatchObject({ projectId: 'project-1', branches: ['main'] });
    request?.onPublished?.();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('reports the error when the project is not loaded in this window', () => {
    handleCreateError(new SshProjectNeedsRemoteError({ projectId: 'gone', branches: [] }));

    expect(usePublishRepoDialogStore.getState().open).toBe(false);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failed to create workspace: SSH workspaces require a Git remote URL. Add a remote to this project.',
    ]);
  });

  it('toasts other creation errors', () => {
    handleCreateError(new Error('disk full'));

    expect(usePublishRepoDialogStore.getState().open).toBe(false);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failed to create workspace: disk full',
    ]);
  });
});
