/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommitComposer } from '../../../../../src/renderer/components/workspaces/file-viewer/CommitComposer';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';

describe('CommitComposer', () => {
  const inspectCommitScope = vi.fn();
  const generateCommitDraft = vi.fn();
  const commitChanges = vi.fn();
  const refreshGitStatus = vi.fn();
  const inspectWorkspaceCommitScope = vi.fn();
  const generateWorkspaceCommitDraft = vi.fn();
  const commitWorkspaceChanges = vi.fn();

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    inspectCommitScope.mockReset().mockResolvedValue({ scope: 'staged', fileCount: 1 });
    generateCommitDraft.mockReset();
    commitChanges.mockReset().mockResolvedValue({ commitHash: 'abc', subject: 'Add feature' });
    refreshGitStatus.mockReset().mockResolvedValue(undefined);
    inspectWorkspaceCommitScope.mockReset().mockResolvedValue({ scope: 'all', fileCount: 2 });
    generateWorkspaceCommitDraft.mockReset();
    commitWorkspaceChanges.mockReset().mockResolvedValue({
      commitHash: 'remote-abc',
      subject: 'Remote change',
    });
    window.api = {
      inspectCommitScope,
      generateCommitDraft,
      commitChanges,
      refreshGitStatus,
      inspectWorkspaceCommitScope,
      generateWorkspaceCommitDraft,
      commitWorkspaceChanges,
    } as typeof window.api;
  });

  it('routes remote workspace commits through workspace-aware APIs', async () => {
    const user = userEvent.setup();
    const onCommitted = vi.fn();
    render(
      <CommitComposer
        workspaceId="remote-ws"
        workingDirectory="ssh://host/repo"
        isRemoteWorkspace
        onCommitted={onCommitted}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    expect(await screen.findByText(/2 changed files · all changes/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Summary'), 'Remote change');
    await user.click(screen.getByRole('button', { name: 'Stage all changes and commit' }));

    expect(inspectWorkspaceCommitScope).toHaveBeenCalledWith('remote-ws');
    expect(commitWorkspaceChanges).toHaveBeenCalledWith('remote-ws', {
      subject: 'Remote change',
      body: null,
      scope: 'all',
    });
    expect(inspectCommitScope).not.toHaveBeenCalled();
    expect(commitChanges).not.toHaveBeenCalled();
    await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    expect(refreshGitStatus).not.toHaveBeenCalled();
  });

  it('only generates after explicit confirmation and labels stage-all commits', async () => {
    inspectCommitScope.mockResolvedValue({ scope: 'all', fileCount: 2 });
    generateCommitDraft.mockResolvedValue({
      subject: 'Add feature',
      body: null,
      scope: 'all',
      fileCount: 2,
    });
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    expect(await screen.findByText(/2 changed files · all changes/i)).toBeInTheDocument();
    expect(generateCommitDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByDisplayValue('Add feature');

    expect(commitChanges).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Summary')).not.toHaveAttribute('maxlength');
    expect(screen.getByLabelText(/Description/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage all changes and commit' })).toBeEnabled();
  });

  it('only inspects local commit scope when opened by an external trigger', async () => {
    inspectCommitScope.mockResolvedValue({
      scope: 'staged',
      fileCount: 1,
    });
    const props = {
      workspaceId: 'ws',
      workingDirectory: '/repo',
      onCommitted: vi.fn(),
      onOpenChange: vi.fn(),
      showTrigger: false,
    };
    const { rerender } = render(<CommitComposer {...props} open={false} />);

    rerender(<CommitComposer {...props} open />);

    expect(await screen.findByText(/1 changed file · staged changes only/i)).toBeInTheDocument();
    expect(inspectCommitScope).toHaveBeenCalledWith('/repo');
    expect(generateCommitDraft).not.toHaveBeenCalled();
  });

  it('shows a friendly empty state when there are no changes', async () => {
    inspectCommitScope.mockRejectedValue(
      new Error(
        "Error invoking remote method 'git:inspect-commit-scope': Error: There are no changes to commit"
      )
    );
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));

    expect(await screen.findByText('Nothing to commit')).toBeInTheDocument();
    expect(screen.getByText(/working tree is clean/i)).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument();

    inspectCommitScope.mockResolvedValue({ scope: 'staged', fileCount: 1 });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));

    expect(await screen.findByText(/1 changed file · staged changes only/i)).toBeInTheDocument();
    expect(inspectCommitScope).toHaveBeenCalledTimes(2);
  });

  it('preserves an unfinished message when closed and reopened', async () => {
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.type(screen.getByLabelText('Summary'), 'Keep this draft');
    await user.type(screen.getByLabelText(/Description/), 'Some useful context');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));

    expect(await screen.findByDisplayValue('Keep this draft')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Some useful context')).toBeInTheDocument();
    expect(inspectCommitScope).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate submissions while a staged commit is pending', async () => {
    generateCommitDraft.mockResolvedValue({
      subject: 'Fix parser',
      body: 'Handle empty input.',
      scope: 'staged',
      fileCount: 1,
    });
    let resolveCommit!: () => void;
    commitChanges.mockReturnValue(new Promise<void>((resolve) => (resolveCommit = resolve)));
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const commitButton = await screen.findByRole('button', { name: 'Commit staged changes' });

    await user.click(commitButton);
    await user.click(commitButton);

    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(commitButton).toBeDisabled();
    resolveCommit();
    await waitFor(() => expect(refreshGitStatus).toHaveBeenCalledWith('ws'));
  });

  it('keeps the composer open and surfaces Git failures', async () => {
    generateCommitDraft.mockResolvedValue({
      subject: 'Fix parser',
      body: null,
      scope: 'staged',
      fileCount: 1,
    });
    commitChanges.mockRejectedValue(new Error('Author identity unknown'));
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await user.click(await screen.findByRole('button', { name: 'Commit staged changes' }));

    expect(await screen.findByText('Author identity unknown')).toBeInTheDocument();
    expect(refreshGitStatus).not.toHaveBeenCalled();
  });

  it('allows a manual commit when AI generation fails after detecting the scope', async () => {
    inspectCommitScope.mockResolvedValue({ scope: 'all', fileCount: 2 });
    generateCommitDraft.mockResolvedValue({
      subject: '',
      body: null,
      scope: 'all',
      fileCount: 2,
      generationError: 'Utility inference is unavailable',
    });
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText('2 changed files · all changes');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText('Utility inference is unavailable')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Summary'), 'Commit manually');
    await user.click(screen.getByRole('button', { name: 'Stage all changes and commit' }));

    expect(commitChanges).toHaveBeenCalledWith('/repo', {
      subject: 'Commit manually',
      body: null,
      scope: 'all',
    });
  });

  it('invalidates the previous draft when regeneration fails', async () => {
    generateCommitDraft
      .mockResolvedValueOnce({
        subject: 'Fix parser',
        body: 'Handle empty input.',
        scope: 'staged',
        fileCount: 1,
      })
      .mockRejectedValueOnce(new Error('Could not generate a commit message'));
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByDisplayValue('Fix parser');

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByText('Could not generate a commit message')).toBeInTheDocument();
    expect(screen.getByLabelText('Summary')).toHaveValue('');
    expect(screen.getByLabelText(/Description/)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Commit staged changes' })).toBeDisabled();
    expect(commitChanges).not.toHaveBeenCalled();
  });

  it('lets the summary run past 72 characters and flags it as long', async () => {
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);

    await user.type(screen.getByLabelText('Summary'), 'x'.repeat(72));
    expect(screen.getByText('72/72')).not.toHaveClass('text-warning');

    await user.type(screen.getByLabelText('Summary'), 'yz');

    expect(screen.getByLabelText('Summary')).toHaveValue(`${'x'.repeat(72)}yz`);
    expect(screen.getByText('74/72')).toHaveClass('text-warning');
  });

  it('commits with Enter in the summary', async () => {
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);

    await user.type(screen.getByLabelText('Summary'), 'Fix parser{Enter}');

    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(commitChanges).toHaveBeenCalledWith('/repo', {
      subject: 'Fix parser',
      body: null,
      scope: 'staged',
    });
  });

  it('commits with Cmd/Ctrl+Enter from the description', async () => {
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.type(screen.getByLabelText('Summary'), 'Fix parser');

    await user.type(screen.getByLabelText(/Description/), 'First line{Enter}Second line');
    expect(commitChanges).not.toHaveBeenCalled();

    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(commitChanges).toHaveBeenCalledWith('/repo', {
      subject: 'Fix parser',
      body: 'First line\nSecond line',
      scope: 'staged',
    });
  });

  it('closes without a toast after a successful commit', async () => {
    const user = userEvent.setup();
    const onCommitted = vi.fn();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={onCommitted} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.type(screen.getByLabelText('Summary'), 'Add feature');
    await user.click(screen.getByRole('button', { name: 'Commit staged changes' }));

    await waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Summary')).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('asks before a generated message replaces one the user typed', async () => {
    generateCommitDraft.mockResolvedValue({
      subject: 'Generated subject',
      body: null,
      scope: 'staged',
      fileCount: 1,
    });
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));
    await screen.findByText(/staged changes only/i);
    await user.type(screen.getByLabelText('Summary'), 'My own words');

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(generateCommitDraft).not.toHaveBeenCalled();
    expect(screen.getByText(/replace your message/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.getByLabelText('Summary')).toHaveValue('My own words');
    expect(screen.queryByText(/replace your message/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await user.click(screen.getByRole('button', { name: 'Replace' }));

    expect(await screen.findByDisplayValue('Generated subject')).toBeInTheDocument();
    expect(generateCommitDraft).toHaveBeenCalledTimes(1);

    // A generated message that was not edited is replaced without asking.
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(generateCommitDraft).toHaveBeenCalledTimes(2));
  });

  it('lets the user choose between staged and all changes when some are staged', async () => {
    inspectCommitScope.mockResolvedValue({
      scope: 'staged',
      fileCount: 2,
      stagedFileCount: 2,
      allFileCount: 10,
    });
    generateCommitDraft.mockResolvedValue({
      subject: 'Update everything',
      body: null,
      scope: 'all',
      fileCount: 10,
    });
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));

    const staged = await screen.findByRole('radio', { name: 'Staged (2)' });
    const all = screen.getByRole('radio', { name: 'All changes (10)' });
    expect(staged).toBeChecked();

    await user.click(all);
    expect(all).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByDisplayValue('Update everything');
    expect(generateCommitDraft).toHaveBeenCalledWith('/repo', 'all');

    await user.click(screen.getByRole('button', { name: 'Stage all changes and commit' }));
    expect(commitChanges).toHaveBeenCalledWith('/repo', {
      subject: 'Update everything',
      body: null,
      scope: 'all',
    });
  });

  it('does not offer a scope choice when nothing is staged', async () => {
    inspectCommitScope.mockResolvedValue({
      scope: 'all',
      fileCount: 3,
      stagedFileCount: 0,
      allFileCount: 3,
    });
    const user = userEvent.setup();
    render(<CommitComposer workspaceId="ws" workingDirectory="/repo" onCommitted={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));

    expect(await screen.findByText('3 changed files · all changes')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});
