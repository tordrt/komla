/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionEditorHost } from '../../../../src/renderer/components/actions/ActionEditorHost';
import {
  openActionEditor,
  useActionEditorStore,
} from '../../../../src/renderer/stores/action-editor.store';

import type { ActionEditorValues } from '../../../../src/renderer/components/actions/ActionEditorDialog';
import type { Action } from '../../../../src/shared/types';

const createAction = vi.fn();
const updateAction = vi.fn();
const deleteAction = vi.fn();
const addToast = vi.fn();
let actionsState: Action[] = [];

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector: any) =>
    selector({ actions: actionsState, createAction, updateAction, deleteAction }),
}));

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: (selector: any) => selector({ presets: [], loadPresets: vi.fn() }),
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: any) => selector({ projects: [] }),
}));

vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: any) => selector({ addToast }),
}));

let values: ActionEditorValues;

// The dialog's own behavior is covered in ActionEditorDialog.test.tsx.
vi.mock('../../../../src/renderer/components/actions/ActionEditorDialog', () => ({
  ActionEditorDialog: (props: any) => (
    <div data-testid="editor" data-action={props.action?.id ?? 'new'}>
      <span>{JSON.stringify(props.defaultProjectIds ?? [])}</span>
      <button onClick={() => props.onSave(values)}>Save</button>
      <button onClick={props.onClose}>Close</button>
      {props.onRequestDelete && <button onClick={props.onRequestDelete}>Delete</button>}
    </div>
  ),
}));

vi.mock('../../../../src/renderer/components/layout/settings/DeleteActionDialog', () => ({
  DeleteActionDialog: (props: any) =>
    props.open ? (
      <div data-testid="delete-dialog">
        {props.actionTitle}
        <button onClick={props.onConfirm}>Confirm delete</button>
      </div>
    ) : null,
}));

const command: Action = { id: 'cmd-1', title: 'Dev', type: 'command', content: 'npm run dev' };

describe('ActionEditorHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAction.mockResolvedValue({});
    updateAction.mockResolvedValue({});
    deleteAction.mockResolvedValue(undefined);
    actionsState = [command];
    useActionEditorStore.setState({ request: null, pendingDeleteId: null });
    values = {
      title: ' Storybook ',
      content: 'npm run storybook ',
      type: 'command',
      projectIds: ['proj-1'],
      presetId: 'claude',
      launchModeId: undefined,
      sshExecutionLocation: 'remote',
      background: false,
    };
  });

  it('renders nothing until asked to open', () => {
    render(<ActionEditorHost />);
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument();
  });

  it('creates a trimmed action in the requested projects and closes', async () => {
    const user = userEvent.setup();
    render(<ActionEditorHost />);
    act(() => openActionEditor({ actionId: null, projectIds: ['proj-1'] }));

    expect(screen.getByTestId('editor')).toHaveTextContent('["proj-1"]');
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(createAction).toHaveBeenCalledWith({
      title: 'Storybook',
      content: 'npm run storybook',
      type: 'command',
      projectIds: ['proj-1'],
      sshExecutionLocation: 'remote',
      background: false,
    });
    expect(addToast).toHaveBeenCalledWith('Quick command created', 'success');
    await waitFor(() => expect(screen.queryByTestId('editor')).not.toBeInTheDocument());
  });

  it('updates an existing action, clearing fields that do not apply to its type', async () => {
    const user = userEvent.setup();
    render(<ActionEditorHost />);
    act(() => openActionEditor({ actionId: 'cmd-1' }));

    expect(screen.getByTestId('editor')).toHaveAttribute('data-action', 'cmd-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateAction).toHaveBeenCalledWith('cmd-1', {
      title: 'Storybook',
      content: 'npm run storybook',
      type: 'command',
      projectIds: ['proj-1'],
      presetId: null,
      launchModeId: null,
      sshExecutionLocation: 'remote',
      background: false,
    });
    expect(addToast).toHaveBeenCalledWith('Quick command updated', 'success');
  });

  it('stays open when saving fails', async () => {
    createAction.mockRejectedValueOnce(new Error('disk full'));
    const user = userEvent.setup();
    render(<ActionEditorHost />);
    act(() => openActionEditor({ actionId: null }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Failed to save quick command', 'error')
    );
    expect(screen.getByTestId('editor')).toBeInTheDocument();
  });

  it('deletes the edited action after confirmation and closes the editor', async () => {
    const user = userEvent.setup();
    render(<ActionEditorHost />);
    act(() => openActionEditor({ actionId: 'cmd-1' }));

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByTestId('delete-dialog')).toHaveTextContent('Dev');
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(deleteAction).toHaveBeenCalledWith('cmd-1');
    await waitFor(() => {
      expect(screen.queryByTestId('editor')).not.toBeInTheDocument();
      expect(screen.queryByTestId('delete-dialog')).not.toBeInTheDocument();
    });
  });

  it('closes when the edited action disappears', async () => {
    const { rerender } = render(<ActionEditorHost />);
    act(() => openActionEditor({ actionId: 'cmd-1' }));
    expect(screen.getByTestId('editor')).toBeInTheDocument();

    actionsState = [];
    rerender(<ActionEditorHost />);

    await waitFor(() => expect(useActionEditorStore.getState().request).toBeNull());
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument();
  });
});
