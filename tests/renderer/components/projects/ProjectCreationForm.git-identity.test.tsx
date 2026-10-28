/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectCreationForm } from '../../../../src/renderer/components/projects/ProjectCreationForm';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  createProjectFromRemote: vi.fn(),
  createProjectFromNew: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({
    projects: [],
    createProject: mocks.createProject,
    createProjectFromRemote: mocks.createProjectFromRemote,
    createProjectFromNew: mocks.createProjectFromNew,
  }),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: () => ({
    config: { preferredCloneProtocol: 'ssh' },
    updateConfig: mocks.updateConfig,
  }),
}));

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({ activePreset: { name: 'Codex' } }),
}));

const project = { id: 'p1', name: 'helloo' };

async function startNewRepo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
  await user.click(await screen.findByRole('button', { name: 'Create empty repo' }));
  await user.type(screen.getByLabelText('Project Name'), 'helloo');
}

describe('ProjectCreationForm git identity', () => {
  beforeEach(() => {
    mocks.createProjectFromNew.mockResolvedValue(project);
    window.api = {
      // Cancelled picker, so "Browse for folder" just shows the local options.
      selectAnyDirectory: vi.fn().mockResolvedValue(null),
      getDirectoryInfo: vi.fn().mockResolvedValue({ isGit: false, branch: null }),
      hasOriginRemote: vi.fn().mockResolvedValue(false),
      onGitProgress: vi.fn().mockReturnValue(() => undefined),
      getGitIdentity: vi.fn().mockResolvedValue({ canCommit: false }),
      setGitIdentity: vi.fn().mockResolvedValue({ success: true, message: 'Git identity saved' }),
    } as never;
  });

  it('asks for a name and email and saves them before creating the repo', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(<ProjectCreationForm onSuccess={onSuccess} hideAdvanced hideProjectColor />);
    await startNewRepo(user);

    const submit = screen.getByRole('button', { name: 'Create & Add Project' });
    expect(screen.getByRole('group', { name: 'Git identity' })).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Your name'), ' Ada Lovelace ');
    await user.type(screen.getByLabelText('Your email'), 'ada@example.com');
    await user.click(submit);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(project));
    expect(window.api.setGitIdentity).toHaveBeenCalledWith('Ada Lovelace', 'ada@example.com');
    expect(vi.mocked(window.api.setGitIdentity).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createProjectFromNew.mock.invocationCallOrder[0]
    );
  });

  it('prefills the part of the identity git already has', async () => {
    vi.mocked(window.api.getGitIdentity).mockResolvedValue({ canCommit: false, userName: 'Ada' });
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await startNewRepo(user);

    expect(screen.getByLabelText('Your name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Your email')).toHaveValue('');
  });

  it('rejects an invalid email without saving or creating anything', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await startNewRepo(user);

    await user.type(screen.getByLabelText('Your name'), 'Ada');
    await user.type(screen.getByLabelText('Your email'), 'ada');
    await user.click(screen.getByRole('button', { name: 'Create & Add Project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an email address like you@example.com'
    );
    expect(window.api.setGitIdentity).not.toHaveBeenCalled();
    expect(mocks.createProjectFromNew).not.toHaveBeenCalled();
  });

  it('shows a failed save and does not create the project', async () => {
    vi.mocked(window.api.setGitIdentity).mockResolvedValue({
      success: false,
      message: 'could not lock config file',
    });
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await startNewRepo(user);

    await user.type(screen.getByLabelText('Your name'), 'Ada');
    await user.type(screen.getByLabelText('Your email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Create & Add Project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not lock config file');
    expect(mocks.createProjectFromNew).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Git identity' })).toBeInTheDocument();
  });

  it('waits for the folder check before allowing an existing repo to be added', async () => {
    let resolveDirectoryInfo!: (info: { isGit: boolean; branch: string | null }) => void;
    vi.mocked(window.api.selectAnyDirectory).mockResolvedValue('/projects/app');
    vi.mocked(window.api.getDirectoryInfo).mockReturnValue(
      new Promise((resolve) => {
        resolveDirectoryInfo = resolve;
      })
    );
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));

    const submit = screen.getByRole('button', { name: 'Add Project', exact: true });
    await waitFor(() => expect(window.api.getDirectoryInfo).toHaveBeenCalled());
    expect(submit).toBeDisabled();

    resolveDirectoryInfo({ isGit: true, branch: 'main' });
    expect(await screen.findByRole('group', { name: 'Git identity' })).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it('does not ask when git can already commit', async () => {
    vi.mocked(window.api.getGitIdentity).mockResolvedValue({ canCommit: true });
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(<ProjectCreationForm onSuccess={onSuccess} hideAdvanced hideProjectColor />);
    await startNewRepo(user);

    expect(screen.queryByRole('group', { name: 'Git identity' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create & Add Project' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(project));
    expect(window.api.setGitIdentity).not.toHaveBeenCalled();
  });

  it('does not ask for a folder that is not a git repository', async () => {
    vi.mocked(window.api.selectAnyDirectory).mockResolvedValue('/projects/notes');
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));

    expect(await screen.findByText('This folder is not a Git repository')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Git identity' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Project', exact: true })).toBeEnabled();
  });
});
