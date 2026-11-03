import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEW_WORKSPACE_DIALOG_EVENT,
  openNewWorkspaceDraft,
  useDialogsStore,
} from '../../../src/renderer/stores/dialogs.store';

function resetStore(): void {
  useDialogsStore.setState(useDialogsStore.getInitialState(), true);
}

describe('dialogs.store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('restores a retained prompt when workspace provisioning fails', () => {
    const store = useDialogsStore.getState();
    store.setNewWorkspaceDialogPrompt('Investigate the remote build');
    store.retainProvisioningWorkspacePrompt('ws-remote', 'Investigate the remote build');

    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe('');

    useDialogsStore.getState().settleProvisioningWorkspacePrompt({
      id: 'ws-remote',
      provisioning: false,
      provisionError: 'Connection refused',
    });

    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe(
      'Investigate the remote build'
    );
    expect(useDialogsStore.getState().pendingWorkspacePrompts).toEqual({});
  });

  it('discards a retained prompt when workspace provisioning succeeds', () => {
    const store = useDialogsStore.getState();
    store.setNewWorkspaceDialogPrompt('Investigate the remote build');
    store.retainProvisioningWorkspacePrompt('ws-remote', 'Investigate the remote build');

    useDialogsStore.getState().settleProvisioningWorkspacePrompt({
      id: 'ws-remote',
      provisioning: false,
    });

    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe('');
    expect(useDialogsStore.getState().pendingWorkspacePrompts).toEqual({});
  });

  it('does not overwrite a newer draft when earlier provisioning fails', () => {
    const store = useDialogsStore.getState();
    store.setNewWorkspaceDialogPrompt('First prompt');
    store.retainProvisioningWorkspacePrompt('ws-remote', 'First prompt');
    store.setNewWorkspaceDialogPrompt('Newer draft');

    useDialogsStore.getState().settleProvisioningWorkspacePrompt({
      id: 'ws-remote',
      provisioning: false,
      provisionError: 'Connection refused',
    });

    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe('Newer draft');
  });

  it('only clears the prompt associated with the completed submission', () => {
    const store = useDialogsStore.getState();
    store.setNewWorkspaceDialogPrompt('Submitted prompt');
    store.setNewWorkspaceDialogPrompt('Newer draft');

    store.clearNewWorkspaceDialogPrompt('Submitted prompt');

    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe('Newer draft');
  });

  it('opens New Workspace on a drafted launch', () => {
    // These tests run in node, where the event goes to a window of its own.
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const opened = vi.fn();
    target.addEventListener(NEW_WORKSPACE_DIALOG_EVENT, opened);
    openNewWorkspaceDraft({
      workspaceId: 'ws-1',
      prompt: 'Fix the flaky login test',
      projectId: 'p-1',
      baseBranch: 'feature/search',
      sourceWorkspaceId: 'ws-1',
      presetId: 'claude',
      launchModeId: 'plan',
    });
    vi.unstubAllGlobals();

    expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe('Fix the flaky login test');
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      projectId: 'p-1',
      baseBranch: 'feature/search',
      sourceWorkspaceId: 'ws-1',
      presetIds: ['claude'],
      launchModeId: 'plan',
    });
  });
});
