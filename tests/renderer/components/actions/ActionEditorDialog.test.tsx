/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionEditorDialog } from '../../../../src/renderer/components/actions/ActionEditorDialog';
import { useSshHostsStore } from '../../../../src/renderer/stores/ssh-hosts.store';

import type { Action, AgentPreset, Project } from '../../../../src/shared/types';

const presetWithMode: AgentPreset = {
  id: 'p1',
  name: 'My Preset',
  openCommand: '',
  continueCommand: '',
  promptCommand: 'agent prompt',
  launchModes: [{ id: 'm1', name: 'Mode 1', command: 'agent --mode-1' }],
  isBuiltin: false,
};

const projects = [
  { id: 'alpha', name: 'Alpha', repositoryPath: '/alpha' } as Project,
  { id: 'beta', name: 'Beta', repositoryPath: '/beta' } as Project,
];

const baseAction: Action = {
  id: 'a1',
  title: 'Original title',
  content: 'Original content',
  type: 'prompt',
  presetId: 'p1',
  launchModeId: 'm1',
};

function renderEditor(overrides: Partial<React.ComponentProps<typeof ActionEditorDialog>> = {}) {
  const props = {
    action: baseAction,
    presets: [presetWithMode],
    projects: [],
    isSaving: false,
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<ActionEditorDialog {...props} />), props };
}

describe('ActionEditorDialog', () => {
  afterEach(() => {
    useSshHostsStore.setState(useSshHostsStore.getInitialState(), true);
  });

  it('lets a Terminal Command choose where it runs in SSH workspaces, under Advanced', async () => {
    useSshHostsStore.setState({
      hosts: [{ id: 'ssh-dev', name: 'Devbox', hostname: 'dev.example.com', basePath: '~/.komla' }],
      hasLoaded: true,
    });
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({
      onSave,
      defaultAdvancedOpen: true,
      action: {
        id: 'a1',
        title: 'Desktop',
        content: 'komla desktop run -- npm run dev',
        type: 'command',
      },
    });

    const runOn = screen.getByRole('combobox', { name: 'SSH workspaces' });
    expect(runOn).toHaveValue('');
    await user.selectOptions(runOn, 'remote');
    expect(screen.getByText(/even when this project runs Terminal Commands/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ sshExecutionLocation: 'remote' })
    );
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(screen.getByRole('button', { name: /Advanced/ })).toHaveTextContent('Remote machine');
  });

  it('runs a Terminal Command in the background', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({
      onSave,
      action: { id: 'a1', title: 'Watch CI', content: 'gh pr checks --watch', type: 'command' },
    });

    expect(screen.getByText('Opens in a new terminal tab')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Run in background/ }));
    expect(screen.getByText('Runs in the background')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ background: true }));
  });

  it("doesn't count Run in background as an edit for a Saved Prompt, which never saves it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderEditor({ onClose });

    await user.click(screen.getByRole('radio', { name: 'Terminal Command' }));
    await user.click(screen.getByRole('checkbox', { name: /Run in background/ }));
    await user.click(screen.getByRole('radio', { name: 'Saved Prompt' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('offers running in the background only for Terminal Commands', () => {
    renderEditor();

    expect(screen.queryByRole('checkbox', { name: /Run in background/ })).not.toBeInTheDocument();
  });

  it('clears an SSH execution location back to the project setting', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({
      onSave,
      defaultAdvancedOpen: true,
      action: {
        id: 'a1',
        title: 'Desktop',
        content: 'npm run dev',
        type: 'command',
        sshExecutionLocation: 'local-mirror',
      },
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'SSH workspaces' }), '');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sshExecutionLocation: null }));
  });

  it('shows where a command runs in SSH workspaces only when SSH hosts exist', () => {
    renderEditor({
      defaultAdvancedOpen: true,
      action: { id: 'a1', title: 'Dev', content: 'npm run dev', type: 'command' },
    });

    expect(screen.queryByRole('combobox', { name: 'SSH workspaces' })).not.toBeInTheDocument();
  });

  it('uses the canonical action type names and defaults new actions to Terminal Command', async () => {
    const user = userEvent.setup();
    renderEditor({ action: null });

    expect(screen.getByRole('heading', { name: 'New quick command' })).toBeInTheDocument();
    const commandButton = screen.getByRole('radio', { name: 'Terminal Command' });
    const promptButton = screen.getByRole('radio', { name: 'Saved Prompt' });
    expect(screen.getByRole('radiogroup', { name: 'Type' })).toBeInTheDocument();
    expect(commandButton.compareDocumentPosition(promptButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(commandButton).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: 'Terminal Command' })).toHaveAttribute(
      'placeholder',
      'e.g., npm run dev'
    );
    expect(screen.queryByRole('combobox', { name: 'Agent preset' })).not.toBeInTheDocument();

    await user.click(promptButton);

    expect(promptButton).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: 'Saved Prompt' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Agent preset' })).toBeInTheDocument();
  });

  it('focuses the title and saves with the keyboard shortcut once title and content are set', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({ action: null, onSave });

    const save = screen.getByRole('button', { name: /Create quick command/ });
    expect(save).toBeDisabled();
    expect(screen.getByLabelText('Title')).toHaveFocus();

    await user.keyboard('Dev server');
    await user.type(screen.getByRole('textbox', { name: 'Terminal Command' }), 'npm run dev');
    expect(save).toBeEnabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Terminal Command' }), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dev server', content: 'npm run dev', type: 'command' })
    );
  });

  it('keeps every line of a multi-line command', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({
      action: { id: 'c1', title: 'Build', type: 'command', content: 'npm ci\nnpm run build' },
      onSave,
    });

    expect(screen.getByRole('textbox', { name: 'Terminal Command' })).toHaveValue(
      'npm ci\nnpm run build'
    );
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Build all');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'npm ci\nnpm run build' })
    );
  });

  it('starts a new action in the given projects, summarized under a collapsed Advanced', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({ action: null, projects, defaultProjectIds: ['alpha'], onSave });

    const advanced = screen.getByRole('button', { name: /Advanced/ });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(advanced).toHaveTextContent('Advanced· Alpha');
    expect(screen.queryByRole('checkbox', { name: 'Alpha' })).not.toBeInTheDocument();

    await user.click(advanced);
    expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await user.type(screen.getByLabelText('Title'), 'Dev');
    await user.type(screen.getByRole('textbox', { name: 'Terminal Command' }), 'npm run dev');
    await user.click(screen.getByRole('button', { name: /Create quick command/ }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['alpha', 'beta'] }));
  });

  it('opens Advanced up front when asked and shows an existing action in all projects', () => {
    renderEditor({ projects, defaultAdvancedOpen: true, defaultProjectIds: ['alpha'] });

    expect(screen.getByRole('button', { name: /Advanced/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    // defaultProjectIds only seeds new actions.
    expect(screen.getByRole('checkbox', { name: 'Alpha' })).not.toBeChecked();
    expect(screen.getByText(/Available in all projects/)).toBeInTheDocument();
  });

  it('picks the preset and launch mode from labelled selects', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({
      onSave,
      action: { ...baseAction, presetId: undefined, launchModeId: undefined },
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent preset' }), 'p1');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Launch mode' }), 'm1');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'p1', launchModeId: 'm1' })
    );
  });

  it('treats existing actions without a type as legacy prompts', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({ action: { ...baseAction, type: undefined }, onSave });

    await user.type(screen.getByRole('textbox', { name: 'Saved Prompt' }), ' updated');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }));
  });

  it('keeps a saved launch mode while presets are still loading', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor({ presets: [], onSave });

    await user.type(screen.getByRole('textbox', { name: 'Saved Prompt' }), '!');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'p1', launchModeId: 'm1' })
    );
  });

  it('closes right away without edits', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderEditor({ onClose });

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('asks before discarding edits', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderEditor({ onClose });

    await user.type(screen.getByLabelText('Title'), ' edited');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Original title edited');
    // The editor has no DialogTrigger for Radix to return focus to.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('returns focus to what opened it once closed', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = renderEditor();
    expect(screen.getByLabelText('Title')).toHaveFocus();

    unmount();

    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
    await user.keyboard('{Escape}');
  });

  it('returns focus elsewhere when what opened it is gone, such as a closed menu', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const returnFocus = vi.fn();
    const { unmount } = renderEditor({ returnFocus });
    opener.remove();

    unmount();

    await waitFor(() => expect(returnFocus).toHaveBeenCalled());
  });

  it('drops a launch mode its preset no longer has, without counting that as an edit', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onClose = vi.fn();
    renderEditor({ action: { ...baseAction, launchModeId: 'removed' }, onSave, onClose });

    expect(screen.getByRole('combobox', { name: 'Launch mode' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ launchModeId: undefined }));

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('keeps the dirty baseline frozen when the upstream action object is replaced', async () => {
    // The host looks the action up in the store on every render. If the store reloads
    // (second window, hand-edit), the same action becomes a new object.
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender, props } = renderEditor({ onClose });

    rerender(
      <ActionEditorDialog {...props} action={{ ...baseAction, title: 'External update' }} />
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Original title');
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('offers Delete only for an existing action', async () => {
    const user = userEvent.setup();
    const onRequestDelete = vi.fn();
    const { unmount } = renderEditor({ onRequestDelete });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onRequestDelete).toHaveBeenCalled();
    unmount();

    renderEditor({ action: null });
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
