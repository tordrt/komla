/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectsTab } from '../../../../../src/renderer/components/layout/settings/ProjectsTab';
import { useProjectsStore } from '../../../../../src/renderer/stores/projects.store';

import type { Project } from '../../../../../src/shared/types';

vi.mock('../../../../../src/renderer/components/projects/ProjectCreationForm', () => ({
  ProjectCreationForm: ({ onCancel }: { onCancel?: () => void }) => (
    <div>
      <p>Project creation form</p>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

const project: Project = {
  id: 'project-1',
  name: 'Komla',
  repositoryPath: '/tmp/komla',
  defaultBranchPrefix: 'agent/',
  createdAt: 0,
  order: 0,
  managed: false,
};

function renderTab(props: Partial<React.ComponentProps<typeof ProjectsTab>> = {}) {
  const handlers = {
    onAddProject: vi.fn(),
    onShowList: vi.fn(),
    onOpenProject: vi.fn(),
  };
  render(<ProjectsTab adding={false} {...handlers} {...props} />);
  return handlers;
}

describe('ProjectsTab', () => {
  const getRepoWebInfo = vi.fn();

  beforeEach(() => {
    useProjectsStore.setState({ projects: [] });
    getRepoWebInfo.mockReset().mockResolvedValue({ webUrl: null });
    window.api = { getRepoWebInfo } as never;
  });

  it('offers to add a project from the empty state', async () => {
    const user = userEvent.setup();
    const { onAddProject } = renderTab();

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    // Only the empty state offers it, so there is one "Add project" button.
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    expect(onAddProject).toHaveBeenCalled();
  });

  it('opens a project from anywhere on its row', async () => {
    const user = userEvent.setup();
    useProjectsStore.setState({ projects: [project] });
    const { onOpenProject } = renderTab();

    await user.click(screen.getByText('/tmp/komla'));

    expect(onOpenProject).toHaveBeenCalledWith('project-1');
    expect(screen.getByRole('button', { name: /Komla/ })).toBeInTheDocument();
  });

  it("names each project's repository online instead of its folder", async () => {
    getRepoWebInfo.mockResolvedValue({ webUrl: 'https://github.com/acme/komla' });
    useProjectsStore.setState({ projects: [project] });
    renderTab();

    expect(await screen.findByText('github.com/acme/komla')).toBeInTheDocument();
    expect(getRepoWebInfo).toHaveBeenCalledWith('/tmp/komla');
    expect(screen.queryByText('/tmp/komla')).not.toBeInTheDocument();
  });

  it('shows the folder for a remote on an SSH host alias, whose web page is made up', async () => {
    getRepoWebInfo.mockResolvedValue({ webUrl: 'https://github-work/acme/komla' });
    useProjectsStore.setState({ projects: [project] });
    renderTab();

    // Once looked up, the folder shows for real rather than holding the line.
    await waitFor(() => expect(screen.getByText('/tmp/komla')).not.toHaveClass('invisible'));
    expect(screen.queryByText('github-work/acme/komla')).not.toBeInTheDocument();
  });

  it('shows the add form, which goes back to the list when cancelled', async () => {
    const user = userEvent.setup();
    useProjectsStore.setState({ projects: [project] });
    const { onShowList } = renderTab({ adding: true });

    expect(screen.getByText('Project creation form')).toBeInTheDocument();
    expect(screen.queryByText('/tmp/komla')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onShowList).toHaveBeenCalled();
  });
});
