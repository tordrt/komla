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

const project = { id: 'project-new', name: 'repo', repositoryPath: '/repos/repo' };

describe('ProjectCreationForm Enter key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProjectFromRemote.mockResolvedValue(project);
    mocks.createProjectFromNew.mockResolvedValue(project);
    window.api = {
      selectAnyDirectory: vi.fn().mockResolvedValue(null),
      getDirectoryInfo: vi.fn().mockResolvedValue({ isGit: true, branch: 'main' }),
      hasOriginRemote: vi.fn().mockResolvedValue(true),
      onGitProgress: vi.fn().mockReturnValue(() => undefined),
      getGitIdentity: vi.fn().mockResolvedValue({ canCommit: true }),
    } as never;
  });

  it('adds the project when Enter is pressed in a text field', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(<ProjectCreationForm onSuccess={onSuccess} hideAdvanced hideProjectColor />);

    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    await user.type(screen.getByLabelText('Repository URL'), 'git@github.com:acme/repo.git');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(project));
    expect(mocks.createProjectFromRemote).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: 'git@github.com:acme/repo.git' })
    );
  });

  it('does not add the project on Enter while required input is missing', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);

    await user.click(screen.getByRole('button', { name: 'Create empty repo' }));
    await user.type(screen.getByLabelText('Project Name'), '   {Enter}');

    expect(mocks.createProjectFromNew).not.toHaveBeenCalled();
  });

  it('never submits an enclosing form when Enter is pressed inside it', async () => {
    const user = userEvent.setup();
    const onOuterSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onOuterSubmit}>
        <ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />
        <button type="submit">Launch</button>
      </form>
    );

    await user.click(screen.getByRole('button', { name: 'Create empty repo' }));
    await user.type(screen.getByLabelText('Project Name'), 'new-project{Enter}');

    await waitFor(() =>
      expect(mocks.createProjectFromNew).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'new-project' })
      )
    );
    expect(onOuterSubmit).not.toHaveBeenCalled();
  });
});
