/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectPageSubtitle } from '../../../../../src/renderer/components/layout/settings/ProjectPageSubtitle';

import type { Project } from '../../../../../src/shared/types';

const project: Project = {
  id: 'project-1',
  name: 'komla',
  repositoryPath: '/Users/me/projects/komla',
  managed: true,
  managedRepoPath: '/Users/me/.komla/repos/komla/repo.git',
  defaultBranchPrefix: 'agent/',
  createdAt: 0,
  order: 0,
};

describe('ProjectPageSubtitle', () => {
  const getRepoWebInfo = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    getRepoWebInfo.mockReset();
    openExternal.mockReset().mockResolvedValue(undefined);
    window.api = { getRepoWebInfo, openExternal } as never;
  });

  it("links to the repository's web page, from the clone Komla works in", async () => {
    const user = userEvent.setup();
    getRepoWebInfo.mockResolvedValue({ webUrl: 'https://github.com/me/komla' });
    render(<ProjectPageSubtitle project={project} />);

    const link = await screen.findByRole('button', { name: 'github.com/me/komla' });
    expect(getRepoWebInfo).toHaveBeenCalledWith('/Users/me/.komla/repos/komla/repo.git');
    expect(screen.queryByText('/Users/me/projects/komla')).not.toBeInTheDocument();

    await user.click(link);
    expect(openExternal).toHaveBeenCalledWith('https://github.com/me/komla');
  });

  it('shows the folder for a repository without a remote', async () => {
    getRepoWebInfo.mockResolvedValue({ webUrl: null });
    render(<ProjectPageSubtitle project={project} />);

    expect(await screen.findByText('/Users/me/projects/komla')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the folder of a directory project without asking for a remote', () => {
    render(<ProjectPageSubtitle project={{ ...project, kind: 'directory', managed: false }} />);

    expect(screen.getByText('/Users/me/projects/komla')).toBeVisible();
    expect(getRepoWebInfo).not.toHaveBeenCalled();
  });
});
