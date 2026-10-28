/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectCreationForm } from '../../../../src/renderer/components/projects/ProjectCreationForm';
import { PROJECT_COLORS } from '../../../../src/renderer/lib/project-colors';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  createProjectFromRemote: vi.fn(),
  createProjectFromNew: vi.fn(),
  updateConfig: vi.fn(),
  cloneProtocol: 'ssh' as 'ssh' | 'https' | undefined,
  projects: [] as { color?: string }[],
  iconColors: {} as Record<string, string[]>,
}));

vi.mock('../../../../src/renderer/lib/icon-colors', () => ({
  readIconColors: async (dataUrl: string) => mocks.iconColors[dataUrl] ?? [],
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({
    projects: mocks.projects,
    createProject: mocks.createProject,
    createProjectFromRemote: mocks.createProjectFromRemote,
    createProjectFromNew: mocks.createProjectFromNew,
  }),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: () => ({
    config: { preferredCloneProtocol: mocks.cloneProtocol },
    updateConfig: mocks.updateConfig,
  }),
}));

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({ activePreset: { name: 'Codex' } }),
}));

describe('ProjectCreationForm source controls', () => {
  beforeEach(() => {
    mocks.cloneProtocol = 'ssh';
    mocks.updateConfig.mockReset();
    window.api = {
      selectAnyDirectory: vi.fn().mockResolvedValue('/projects/example'),
      getDirectoryInfo: vi.fn().mockResolvedValue({ isGit: true, branch: 'main' }),
      hasOriginRemote: vi.fn().mockResolvedValue(true),
      onGitProgress: vi.fn().mockReturnValue(() => undefined),
      getGitIdentity: vi.fn().mockResolvedValue({ canCommit: true }),
    } as never;
  });

  it('disables adding until a folder is selected, including a cancelled picker', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.selectAnyDirectory).mockResolvedValueOnce(null);
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    const submit = screen.getByRole('button', { name: 'Add Project', exact: true });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('requires a non-blank URL and disables again when cleared', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const submit = screen.getByRole('button', { name: 'Clone & Add Project' });
    const url = screen.getByLabelText('Repository URL');
    expect(submit).toBeDisabled();
    await user.type(url, '   ');
    expect(submit).toBeDisabled();
    await user.type(url, 'https://github.com/example/repo.git');
    expect(submit).toBeEnabled();
    await user.clear(url);
    expect(submit).toBeDisabled();
  });

  it('switches the clone protocol from its radio group and converts the URL', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const url = screen.getByLabelText('Repository URL');
    await user.type(url, 'git@github.com:example/repo.git');

    const protocol = screen.getByRole('radiogroup', { name: 'Clone protocol' });
    expect(within(protocol).getByRole('radio', { name: 'SSH' })).toBeChecked();
    await user.click(within(protocol).getByRole('radio', { name: 'HTTPS' }));

    expect(mocks.updateConfig).toHaveBeenCalledWith({ preferredCloneProtocol: 'https' });
    expect(url).toHaveValue('https://github.com/example/repo.git');
  });

  it('clones a pasted browser link over the selected SSH protocol', async () => {
    const user = userEvent.setup();
    mocks.createProjectFromRemote.mockReset().mockResolvedValue({ id: 'cloned' });
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const url = screen.getByLabelText('Repository URL');
    await user.click(url);
    await user.paste('https://github.com/example/repo/tree/main');

    expect(url).toHaveValue('https://github.com/example/repo/tree/main');
    expect(url).toHaveAccessibleDescription('Clones over SSH as git@github.com:example/repo.git');
    await user.click(screen.getByRole('button', { name: 'Clone & Add Project' }));
    await waitFor(() =>
      expect(mocks.createProjectFromRemote).toHaveBeenCalledWith(
        expect.objectContaining({ remoteUrl: 'git@github.com:example/repo.git' })
      )
    );
  });

  it('keeps a pasted link on its own protocol until one is picked', async () => {
    const user = userEvent.setup();
    mocks.cloneProtocol = undefined;
    mocks.createProjectFromRemote.mockReset().mockResolvedValue({ id: 'cloned' });
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const protocol = screen.getByRole('radiogroup', { name: 'Clone protocol' });
    expect(within(protocol).getByRole('radio', { name: 'SSH' })).toBeChecked();
    await user.click(screen.getByLabelText('Repository URL'));
    await user.paste('https://github.com/example/repo/tree/main');

    expect(within(protocol).getByRole('radio', { name: 'HTTPS' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Clone & Add Project' }));
    await waitFor(() =>
      expect(mocks.createProjectFromRemote).toHaveBeenCalledWith(
        expect.objectContaining({ remoteUrl: 'https://github.com/example/repo.git' })
      )
    );
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('leaves the URL alone when the selected protocol is clicked again', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const url = screen.getByLabelText('Repository URL');
    await user.type(url, 'https://git.example.com/team/repo.git');
    const protocol = screen.getByRole('radiogroup', { name: 'Clone protocol' });
    await user.click(within(protocol).getByRole('radio', { name: 'SSH' }));

    expect(url).toHaveValue('https://git.example.com/team/repo.git');
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('says a self-hosted https URL clones as entered while SSH is selected', async () => {
    const user = userEvent.setup();
    mocks.createProjectFromRemote.mockReset().mockResolvedValue({ id: 'cloned' });
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const url = screen.getByLabelText('Repository URL');
    await user.type(url, 'https://git.example.com/team/repo.git');

    expect(url).toHaveAccessibleDescription('Clones over HTTPS, as entered');
    await user.click(screen.getByRole('button', { name: 'Clone & Add Project' }));
    await waitFor(() =>
      expect(mocks.createProjectFromRemote).toHaveBeenCalledWith(
        expect.objectContaining({ remoteUrl: 'https://git.example.com/team/repo.git' })
      )
    );
  });

  it('requires a name for an empty repository and preserves the skip action', async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    render(
      <ProjectCreationForm
        onSuccess={vi.fn()}
        skipLabel="Skip for now"
        onSkip={onSkip}
        hideAdvanced
      />
    );
    const createEmptyRepo = screen.getByRole('button', { name: 'Create empty repo' });
    expect(createEmptyRepo).toHaveClass('border-input');
    await user.click(createEmptyRepo);
    const submit = screen.getByRole('button', { name: 'Create & Add Project' });
    const name = screen.getByLabelText('Project Name');
    expect(submit).toBeDisabled();
    await user.type(name, '   ');
    expect(submit).toBeDisabled();
    await user.type(name, 'new-project');
    expect(submit).toBeEnabled();
    await user.clear(name);
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('uses the source buttons as the folder picker and remote URL reveal', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced hideProjectColor />);

    const form = screen.getByRole('region', { name: 'Add project' });
    expect(screen.queryByText('Project source')).not.toBeInTheDocument();
    expect(screen.queryByText('Pick folder')).not.toBeInTheDocument();
    expect(screen.queryByText('Folder', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Paste path' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Repository URL')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Git folders use isolated worktrees. Other folders are added as fixed directory projects.'
      )
    ).not.toBeInTheDocument();

    const browseButton = screen.getByRole('button', { name: /Browse for folder/ });
    const cloneButton = screen.getByRole('button', { name: /Clone from remote/ });
    expect(browseButton).toHaveAttribute('aria-pressed', 'false');
    expect(cloneButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(cloneButton);
    expect(screen.getByLabelText('Repository URL')).toBeVisible();
    expect(cloneButton).toHaveAttribute('aria-pressed', 'true');
    expect(browseButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(browseButton);
    await waitFor(() => expect(window.api.selectAnyDirectory).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Repository URL')).not.toBeInTheDocument();
    expect(await screen.findByTitle('/projects/example')).toBeVisible();
    expect(browseButton).toHaveAttribute('aria-pressed', 'true');
    expect(cloneButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(form).toContainElement(screen.getByTitle('/projects/example'));
  });

  it('shows an invalid clone URL error on the URL field', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);
    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    const url = screen.getByLabelText('Repository URL');

    await user.type(url, 'github.com/example/repo');
    await user.click(screen.getByRole('button', { name: 'Clone & Add Project' }));

    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(url).toHaveAccessibleDescription('Enter a valid Git URL (https:// or git@)');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.createProjectFromRemote).not.toHaveBeenCalled();

    await user.type(url, '.git');
    expect(url).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a prominent notice only after selecting a non-Git folder', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.getDirectoryInfo).mockResolvedValue({ isGit: false, branch: null });
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced hideProjectColor />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('This folder is not a Git repository');
    expect(notice).toHaveTextContent(
      'All workspaces will share this folder instead of using isolated worktrees.'
    );
  });
});

describe('ProjectCreationForm project color', () => {
  const swatches = () =>
    within(screen.getByRole('group', { name: 'Project Color' })).getAllByRole('button');

  beforeEach(() => {
    mocks.createProject.mockReset().mockResolvedValue({ id: 'new' });
    mocks.projects = [{ color: PROJECT_COLORS[0] }, {}, { color: PROJECT_COLORS[1] }];
    window.api = {
      selectAnyDirectory: vi.fn().mockResolvedValue('/projects/notes'),
      getDirectoryInfo: vi.fn().mockResolvedValue({ isGit: false, branch: null }),
      hasOriginRemote: vi.fn().mockResolvedValue(false),
      onGitProgress: vi.fn().mockReturnValue(() => undefined),
      getGitIdentity: vi.fn().mockResolvedValue({ canCommit: true }),
      findProjectIcons: vi.fn().mockResolvedValue([]),
    } as never;
  });

  it('offers a color in New Workspace, starting on the first one no project uses', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    const pressed = swatches().map((swatch) => swatch.getAttribute('aria-pressed'));
    expect(pressed.indexOf('true')).toBe(2);
    expect(pressed.filter((value) => value === 'true')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await user.click(await screen.findByRole('button', { name: 'Add Project' }));
    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ repositoryPath: '/projects/notes', color: PROJECT_COLORS[2] })
      )
    );
  });

  it('adds the project in the color picked, which stays picked when clicked again', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    await user.click(swatches()[5]);
    await user.click(swatches()[5]);
    expect(swatches()[5]).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await user.click(await screen.findByRole('button', { name: 'Add Project' }));
    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ color: PROJECT_COLORS[5] })
      )
    );
  });

  it('leaves the color to Komla when the picker is hidden', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced hideProjectColor />);

    expect(screen.queryByRole('group', { name: 'Project Color' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await user.click(await screen.findByRole('button', { name: 'Add Project' }));
    await waitFor(() => expect(mocks.createProject).toHaveBeenCalled());
    expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('color');
  });

  it('starts on a folder passed in, as if picked', async () => {
    render(
      <ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced initialPath="/repos/given" />
    );

    expect(await screen.findByTitle('/repos/given')).toBeVisible();
    expect(screen.getByRole('button', { name: /Browse for folder/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await waitFor(() => expect(window.api.getDirectoryInfo).toHaveBeenCalledWith('/repos/given'));
    expect(window.api.selectAnyDirectory).not.toHaveBeenCalled();
  });
});

describe('ProjectCreationForm project icon', () => {
  const favicon = { path: 'public/favicon.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' };
  const logo = { path: 'logo.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };

  beforeEach(() => {
    mocks.createProject.mockReset().mockResolvedValue({ id: 'new' });
    mocks.projects = [];
    mocks.iconColors = {};
    window.api = {
      selectAnyDirectory: vi.fn().mockResolvedValue('/projects/site'),
      getDirectoryInfo: vi.fn().mockResolvedValue({ isGit: false, branch: null }),
      hasOriginRemote: vi.fn().mockResolvedValue(false),
      onGitProgress: vi.fn().mockReturnValue(() => undefined),
      getGitIdentity: vi.fn().mockResolvedValue({ canCommit: true }),
      findProjectIcons: vi.fn().mockResolvedValue([favicon, logo]),
    } as never;
  });

  it("offers the folder's icons, starting on the best one found", async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    const picker = await screen.findByRole('group', { name: 'Project Icon' });
    expect(window.api.findProjectIcons).toHaveBeenCalledWith({ folder: '/projects/site' });
    expect(within(picker).getByRole('button', { name: favicon.path })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await user.click(within(picker).getByRole('button', { name: logo.path }));
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ repositoryPath: '/projects/site', icon: logo.dataUrl })
      )
    );
  });

  it("follows the icon's main color until a color is picked", async () => {
    const user = userEvent.setup();
    mocks.iconColors = { [favicon.dataUrl]: ['#61dafb', '#e11d48'] };
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);
    const swatches = () =>
      within(screen.getByRole('group', { name: 'Project Color' })).getAllByRole('button');

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    expect(await screen.findByRole('button', { name: 'Icon color #61dafb' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // An icon in gray only leaves the color Komla would pick.
    await user.click(screen.getByRole('button', { name: logo.path }));
    expect(screen.queryByRole('button', { name: /^Icon color/ })).not.toBeInTheDocument();
    expect(swatches()[0]).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: favicon.path }));
    await user.click(await screen.findByRole('button', { name: 'Icon color #e11d48' }));
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ icon: favicon.dataUrl, color: '#e11d48' })
      )
    );
  });

  it('keeps a palette color picked when the icon changes', async () => {
    const user = userEvent.setup();
    mocks.iconColors = { [favicon.dataUrl]: ['#61dafb'], [logo.dataUrl]: ['#e11d48'] };
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await screen.findByRole('button', { name: 'Icon color #61dafb' });
    const palette = within(screen.getByRole('group', { name: 'Project Color' }))
      .getAllByRole('button')
      .filter((swatch) => !swatch.hasAttribute('aria-label'));
    await user.click(palette[4]);
    await user.click(screen.getByRole('button', { name: logo.path }));
    expect(await screen.findByRole('button', { name: 'Icon color #e11d48' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ icon: logo.dataUrl, color: PROJECT_COLORS[4] })
      )
    );
  });

  it('adds the project with its color dot when that is picked', async () => {
    const user = userEvent.setup();
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await user.click(await screen.findByRole('button', { name: 'Color dot' }));
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() => expect(mocks.createProject).toHaveBeenCalled());
    // The icons were offered here, so the first workspace doesn't offer them again.
    expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('icon');
    expect(mocks.createProject.mock.calls[0][0]).toMatchObject({ iconPromptAsked: true });
  });

  it('offers only the color dot and an upload when the folder has no icons', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.findProjectIcons).mockResolvedValue([]);
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    await waitFor(() => expect(window.api.findProjectIcons).toHaveBeenCalled());
    const picker = screen.getByRole('group', { name: 'Project Icon' });
    expect(
      within(picker)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual(['Color dot']);
    expect(screen.getByRole('button', { name: 'Upload icon…' })).toBeVisible();

    // Icons added to the folder later are offered at a new workspace.
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() => expect(mocks.createProject).toHaveBeenCalled());
    expect(mocks.createProject.mock.calls[0][0]).not.toHaveProperty('iconPromptAsked');
  });

  it('clones with an uploaded icon, without scanning first', async () => {
    const user = userEvent.setup();
    const uploaded = { path: 'brand.svg', dataUrl: 'data:image/svg+xml;base64,PGcvPg==' };
    window.api.chooseProjectIconFile = vi.fn().mockResolvedValue(uploaded);
    mocks.createProjectFromRemote.mockReset().mockResolvedValue({ id: 'cloned' });
    render(<ProjectCreationForm onSuccess={vi.fn()} hideAdvanced />);

    await user.click(screen.getByRole('button', { name: /Clone from remote/ }));
    await user.click(screen.getByRole('button', { name: 'Upload icon…' }));
    expect(await screen.findByRole('button', { name: 'brand.svg' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/example/repo.git');
    await user.click(screen.getByRole('button', { name: 'Clone & Add Project' }));

    await waitFor(() =>
      expect(mocks.createProjectFromRemote).toHaveBeenCalledWith(
        expect.objectContaining({ icon: uploaded.dataUrl })
      )
    );
    expect(window.api.findProjectIcons).not.toHaveBeenCalled();
  });

  it('keeps an upload picked when the folder changes, but not an image from the old folder', async () => {
    const user = userEvent.setup();
    const uploaded = { path: 'brand.svg', dataUrl: 'data:image/svg+xml;base64,PGcvPg==' };
    window.api.chooseProjectIconFile = vi.fn().mockResolvedValue(uploaded);
    vi.mocked(window.api.selectAnyDirectory)
      .mockResolvedValueOnce('/projects/site')
      .mockResolvedValueOnce('/projects/other')
      .mockResolvedValueOnce('/projects/site')
      .mockResolvedValueOnce('/projects/third');
    vi.mocked(window.api.findProjectIcons).mockImplementation(async (source) =>
      'folder' in source && source.folder === '/projects/site' ? [favicon, logo] : [favicon]
    );
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);
    const browse = () => user.click(screen.getByRole('button', { name: /Browse for folder/ }));

    await browse();
    await user.click(await screen.findByRole('button', { name: 'Upload icon…' }));
    await browse();
    await waitFor(() =>
      expect(window.api.findProjectIcons).toHaveBeenCalledWith({ folder: '/projects/other' })
    );
    expect(await screen.findByRole('button', { name: 'brand.svg' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await browse();
    await user.click(await screen.findByRole('button', { name: logo.path }));
    await browse();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: favicon.path })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    );
    expect(screen.queryByRole('button', { name: logo.path })).not.toBeInTheDocument();
  });

  it('keeps the current choice when the upload is cancelled or fails', async () => {
    const user = userEvent.setup();
    window.api.chooseProjectIconFile = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'project:choose-icon-file': Error: Too big.")
      );
    render(<ProjectCreationForm onSuccess={vi.fn()} compact hideAdvanced />);

    await user.click(screen.getByRole('button', { name: /Browse for folder/ }));
    const best = await screen.findByRole('button', { name: favicon.path });
    await user.click(screen.getByRole('button', { name: 'Upload icon…' }));
    await user.click(screen.getByRole('button', { name: 'Upload icon…' }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Too big.')
    );
    expect(best).toHaveAttribute('aria-pressed', 'true');
  });
});
