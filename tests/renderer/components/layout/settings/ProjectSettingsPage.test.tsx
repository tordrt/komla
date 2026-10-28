/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectSettingsPage } from '../../../../../src/renderer/components/layout/settings/ProjectSettingsPage';
import { PROJECT_COLORS } from '../../../../../src/renderer/lib/project-colors';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useSshHostsStore } from '../../../../../src/renderer/stores/ssh-hosts.store';

import type { Project } from '../../../../../src/shared/types';

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  addToast: vi.fn(),
  iconColors: {} as Record<string, string[]>,
}));

vi.mock('../../../../../src/renderer/lib/icon-colors', () => ({
  readIconColors: async (dataUrl: string) => mocks.iconColors[dataUrl] ?? [],
}));

vi.mock('../../../../../src/renderer/components/ui/branch-select', () => ({
  BranchSelect: ({
    placeholder,
    onChange,
  }: {
    placeholder?: string;
    onChange: (branch: string) => void;
  }) => (
    <>
      <span data-testid="target-branch">{placeholder}</span>
      <button type="button" onClick={() => onChange('develop')}>
        Pick develop
      </button>
    </>
  ),
}));

vi.mock('../../../../../src/renderer/components/layout/settings/ProjectSetupSkillButton', () => ({
  ProjectSetupSkillButton: () => <button type="button">Run setup skill</button>,
}));

vi.mock('../../../../../src/renderer/components/layout/settings/WorkspaceSetupSection', () => ({
  WorkspaceSetupSection: ({
    onStepsChange,
  }: {
    onStepsChange: (steps: Array<Record<string, unknown>>) => void;
  }) => (
    <div>
      Setup controls
      <button
        type="button"
        onClick={() =>
          onStepsChange([
            {
              id: 'agent-step',
              name: 'Agent',
              command: '',
              placement: 'split-right',
              agent: {},
            },
          ])
        }
      >
        Add test agent
      </button>
    </div>
  ),
}));

vi.mock('../../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({
    updateProject: mocks.updateProject,
    deleteProject: mocks.deleteProject,
  }),
}));

vi.mock('../../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({ presets: [], loadPresets: vi.fn() }),
}));

vi.mock('../../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: () => ({ actions: [] }),
}));

vi.mock('../../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(
    (selector: (state: { workspaces: [] }) => unknown) => selector({ workspaces: [] }),
    { getState: () => ({ workspaces: [] }) }
  ),
}));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector?: (state: { addToast: typeof mocks.addToast }) => unknown) => {
    const state = { addToast: mocks.addToast };
    return selector ? selector(state) : state;
  },
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

type PageProps = ComponentProps<typeof ProjectSettingsPage>;
let pageProps: PageProps;
let rerenderPage: (props: PageProps) => void;

function renderPage(pageProject: Project = project) {
  const onDirtyChange = vi.fn();
  pageProps = { project: pageProject, onDirtyChange };
  const view = render(<ProjectSettingsPage {...pageProps} />);
  rerenderPage = (props) => {
    pageProps = props;
    view.rerender(<ProjectSettingsPage {...props} />);
  };
  return {
    onDirtyChange,
    showProject: (next: Project) => rerenderPage({ ...pageProps, project: next }),
  };
}

/** Shows a section, as picking it in the Settings nav does. */
function showSection(section: NonNullable<PageProps['section']>) {
  rerenderPage({ ...pageProps, section });
}

describe('ProjectSettingsPage', () => {
  beforeEach(() => {
    mocks.updateProject.mockReset().mockResolvedValue(undefined);
    mocks.deleteProject.mockReset().mockResolvedValue(undefined);
    mocks.addToast.mockReset();
    mocks.iconColors = {};
    useSshHostsStore.setState({ hasLoaded: false, hosts: [] });
    useConfigStore.setState({ config: null });
    window.api = {
      findProjectIcons: vi.fn().mockResolvedValue([]),
      getMainBranch: vi.fn().mockResolvedValue('main'),
    } as never;
  });

  it('picks where SSH Terminal Commands run from a radio group', async () => {
    const user = userEvent.setup();
    renderPage();

    const group = screen.getByRole('radiogroup', { name: 'Run Terminal Commands on' });
    const remote = within(group).getByRole('radio', { name: 'Remote machine' });
    const local = within(group).getByRole('radio', { name: 'This computer' });
    // Unset falls back to Remote machine.
    expect(remote).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/Local copies require/)).not.toBeInTheDocument();

    await user.click(local);

    expect(local).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Local copies require/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.updateProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ sshWorkspaceMode: 'local-mirror-actions' })
    );
  });

  it('saves Remote machine explicitly when it is clicked while unset', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: 'Remote machine' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ sshWorkspaceMode: 'remote' })
    );
  });

  it('leaves out the SSH settings when there are no SSH hosts', () => {
    useSshHostsStore.setState({ hasLoaded: true, hosts: [] });
    renderPage();

    expect(screen.queryByRole('radiogroup', { name: 'Run Terminal Commands on' })).toBeNull();
  });

  it('marks the page dirty when the trash cleanup command changes', async () => {
    const user = userEvent.setup();
    const { onDirtyChange } = renderPage();
    showSection('setup');

    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Trash cleanup command' }), 'rm -rf dist');

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('saves only the groups of settings that changed', async () => {
    const user = userEvent.setup();
    renderPage({ ...project, aheadTargetAction: 'unconfigured' });
    showSection('setup');

    await user.type(screen.getByRole('textbox', { name: 'Trash cleanup command' }), 'rm -rf dist');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const updates = mocks.updateProject.mock.calls[0][1];
    expect(updates).toMatchObject({ trashCleanupScript: 'rm -rf dist', setupSteps: [] });
    // The commits-ahead button stays unconfigured, so it still asks on first use.
    expect(updates).not.toHaveProperty('aheadTargetAction');
    expect(updates).not.toHaveProperty('name');
  });

  it('keeps an unconfigured commits-ahead button unconfigured when the branch prefix changes', async () => {
    const user = userEvent.setup();
    renderPage({ ...project, aheadTargetAction: 'unconfigured' });
    showSection('git');

    await user.type(screen.getByRole('textbox', { name: 'Branch prefix' }), 'x');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const updates = mocks.updateProject.mock.calls[0][1];
    expect(updates).toMatchObject({ defaultBranchPrefix: 'agent/x' });
    expect(updates).not.toHaveProperty('aheadTargetAction');
  });

  it('shows a single commits-ahead action as the choice for both kinds of branch', () => {
    renderPage({ ...project, aheadTargetAction: 'pr' });
    showSection('git');

    expect(
      screen.getByRole('combobox', { name: 'Commits ahead (↑N), default branch' })
    ).toHaveValue('pr');
    expect(
      screen.getByRole('combobox', { name: 'Commits ahead (↑N), other branches' })
    ).toHaveValue('pr');
  });

  it.each([
    ['pr', 'merge', { aheadTargetAction: 'auto-default', autoMainBranchAction: undefined }],
    ['merge', 'merge', { aheadTargetAction: 'merge', autoOtherBranchAction: undefined }],
    ['disabled', 'disabled', { aheadTargetAction: 'disabled' }],
    [
      'pr',
      'pr',
      {
        aheadTargetAction: 'pr',
        autoMainBranchAction: undefined,
        autoOtherBranchAction: undefined,
      },
    ],
    [
      'merge',
      'pr',
      { aheadTargetAction: 'auto', autoMainBranchAction: 'merge', autoOtherBranchAction: 'pr' },
    ],
  ] as const)(
    'saves %s for the default branch and %s for others as the setting they match',
    async (main, other, expected) => {
      const user = userEvent.setup();
      renderPage({
        ...project,
        aheadTargetAction: 'auto',
        autoMainBranchAction: 'disabled',
        autoOtherBranchAction: 'agent-prompt',
      });
      showSection('git');

      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Commits ahead (↑N), default branch' }),
        main
      );
      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Commits ahead (↑N), other branches' }),
        other
      );
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(mocks.updateProject.mock.calls[0][1]).toMatchObject(expected);
    }
  );

  it('asks for the action to run when Run quick command is picked', async () => {
    const user = userEvent.setup();
    renderPage();
    showSection('git');

    expect(screen.queryByText('Quick command to run for the default branch')).toBeNull();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Commits ahead (↑N), default branch' }),
      'agent-prompt'
    );

    expect(screen.getByText('Quick command to run for the default branch')).toBeInTheDocument();
    // Other branches still fast-forward by default, so the push choice stays.
    expect(
      screen.getByRole('combobox', { name: 'Push target branch after fast-forward' })
    ).toBeInTheDocument();
  });

  it('shows what Default means from the app-wide git settings', () => {
    useConfigStore.setState({
      config: {
        gitDefaults: {
          branchPrefix: 'me/',
          aheadMainAction: 'merge',
          aheadOtherAction: 'merge',
          autoPushAfterMerge: false,
          behindTargetAction: 'rebase',
        },
      } as never,
    });
    renderPage({ ...project, defaultBranchPrefix: '' });
    showSection('git');

    expect(screen.getByRole('textbox', { name: 'Branch prefix' })).toHaveAttribute(
      'placeholder',
      'me/ (default)'
    );
    const main = screen.getByRole('combobox', { name: 'Commits ahead (↑N), default branch' });
    expect(main).toHaveValue('default');
    expect(
      within(main).getByRole('option', { name: 'Default (Fast-forward target branch)' })
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('combobox', { name: 'Push target branch after fast-forward' })
      ).getByRole('option', { name: "Default (don't push)" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('combobox', { name: 'Commits behind (↓N)' })).getByRole('option', {
        name: 'Default (Always rebase)',
      })
    ).toBeInTheDocument();
  });

  it('asks on first click only while both ↑N choices are Default', async () => {
    const user = userEvent.setup();
    renderPage();
    showSection('git');
    const main = screen.getByRole('combobox', { name: 'Commits ahead (↑N), default branch' });
    expect(
      within(main).getByRole('option', { name: 'Default (ask on first click)' })
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Commits ahead (↑N), other branches' }),
      'disabled'
    );

    expect(within(main).getByRole('option', { name: 'Default (Create PR)' })).toBeInTheDocument();
    expect(screen.queryByText(/Asks what to do on the first click/)).not.toBeInTheDocument();
  });

  it('goes back to the app-wide git settings when Default is picked', async () => {
    const user = userEvent.setup();
    renderPage({
      ...project,
      aheadTargetAction: 'merge',
      autoPushAfterMerge: false,
      behindTargetAction: 'rebase',
    });
    showSection('git');

    for (const name of [
      'Commits ahead (↑N), default branch',
      'Commits ahead (↑N), other branches',
    ]) {
      await user.selectOptions(screen.getByRole('combobox', { name }), 'default');
    }
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Push target branch after fast-forward' }),
      'default'
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Commits behind (↓N)' }),
      'default'
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const updates = mocks.updateProject.mock.calls[0][1];
    for (const key of ['aheadTargetAction', 'autoPushAfterMerge', 'behindTargetAction']) {
      expect(updates).toHaveProperty(key, undefined);
    }
  });

  it('saves one per-branch choice and leaves the other to the app-wide setting', async () => {
    const user = userEvent.setup();
    renderPage();
    showSection('git');

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Commits ahead (↑N), other branches' }),
      'disabled'
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateProject.mock.calls[0][1]).toMatchObject({
      aheadTargetAction: 'auto',
      autoMainBranchAction: undefined,
      autoOtherBranchAction: 'disabled',
    });
  });

  it('stays on the page after saving and shows the saved values', async () => {
    const user = userEvent.setup();
    const { onDirtyChange, showProject } = renderPage();

    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, ' Komla app ');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.updateProject).toHaveBeenCalledWith(project.id, { name: 'Komla app' });
    showProject({ ...project, name: 'Komla app' });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Komla app');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('takes up changes made elsewhere while nothing is edited, and keeps edits otherwise', async () => {
    const user = userEvent.setup();
    const { showProject } = renderPage();

    showProject({ ...project, defaultBranchPrefix: 'bot/' });
    showSection('git');
    expect(screen.getByRole('textbox', { name: 'Branch prefix' })).toHaveValue('bot/');

    showSection('general');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    showProject({ ...project, defaultBranchPrefix: 'other/' });

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Komla!');
    showSection('git');
    expect(screen.getByRole('textbox', { name: 'Branch prefix' })).toHaveValue('bot/');
  });

  it('saves agent setup steps without reading the project back', async () => {
    const user = userEvent.setup();
    const getProject = vi.fn();
    Object.assign(window.api, { getProject });
    renderPage();
    showSection('setup');

    await user.click(screen.getByRole('button', { name: 'Add test agent' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith('Project updated', 'success'));
    expect(getProject).not.toHaveBeenCalled();
  });

  it('names the detected default branch while no target branch is set', async () => {
    vi.mocked(window.api.getMainBranch).mockResolvedValue('develop');
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('target-branch')).toHaveTextContent('develop (default)')
    );
    expect(window.api.getMainBranch).toHaveBeenCalledWith('/tmp/komla');
  });

  it('opens the branch cleanup for this project', async () => {
    const user = userEvent.setup();
    window.api.listLeftoverBranches = vi.fn().mockResolvedValue({
      targetBranch: 'main',
      branches: [],
    }) as never;
    renderPage();
    showSection('git');

    await user.click(screen.getByRole('button', { name: 'Clean up…' }));

    const dialog = screen.getByRole('dialog', { name: 'Clean up branches' });
    expect(await within(dialog).findByText('No leftover branches.')).toBeInTheDocument();
    expect(window.api.listLeftoverBranches).toHaveBeenCalledWith(project.id, null);
  });

  it('holds back the branch cleanup while a new target branch is unsaved', async () => {
    const user = userEvent.setup();
    renderPage();
    showSection('git');

    await user.click(screen.getByRole('button', { name: 'Pick develop' }));

    expect(screen.getByRole('button', { name: 'Clean up…' })).toBeDisabled();
    expect(screen.getByText(/Save the target branch first/)).toBeInTheDocument();
  });

  it('shows only the general settings, workspace cleanup and delete for a directory project', () => {
    renderPage({ ...project, kind: 'directory' });

    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Branch prefix' })).not.toBeInTheDocument();
    expect(screen.queryByText('Setup controls')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText('Leftover branches')).not.toBeInTheDocument();
    expect(screen.getByText('Finished workspaces')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Clean up…' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeInTheDocument();
  });

  it('opens the workspace cleanup for this project', async () => {
    const user = userEvent.setup();
    window.api.checkWorkspacesForCleanup = vi.fn().mockResolvedValue([]) as never;
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Clean up…' }));

    const dialog = screen.getByRole('dialog', { name: 'Clean up workspaces' });
    expect(await within(dialog).findByText('No workspaces to clean up.')).toBeInTheDocument();
    expect(window.api.checkWorkspacesForCleanup).toHaveBeenCalledWith(project.id);
  });

  it('shows only the section picked in the nav', () => {
    renderPage();

    expect(screen.getByRole('textbox', { name: 'Name' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeVisible();
    expect(screen.getByText('Setup controls')).not.toBeVisible();

    showSection('setup');

    expect(screen.getByText('Setup controls')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Trash cleanup command' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Branch prefix' })).not.toBeInTheDocument();
  });

  it('keeps edits across sections and saves them together', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    showSection('setup');
    await user.type(screen.getByRole('textbox', { name: 'Trash cleanup command' }), 'make clean');
    showSection('general');

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Komla!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.updateProject.mock.calls[0][1]).toMatchObject({
      name: 'Komla!',
      trashCleanupScript: 'make clean',
    });
  });

  it('deletes the project once confirmed', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete project' });
    expect(confirm).toHaveTextContent('This project has no workspaces.');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(mocks.deleteProject).toHaveBeenCalledWith(project.id);
  });

  describe('icon', () => {
    const favicon = { path: 'public/favicon.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' };
    const saved = 'data:image/png;base64,iVBORw0KGgo=';

    it("offers the icons found in the project's files", async () => {
      const user = userEvent.setup();
      vi.mocked(window.api.findProjectIcons).mockResolvedValue([favicon]);
      renderPage();

      await user.click(await screen.findByRole('button', { name: favicon.path }));
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(window.api.findProjectIcons).toHaveBeenCalledWith({ projectId: project.id });
      expect(mocks.updateProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ icon: favicon.dataUrl })
      );
    });

    it('keeps the saved icon a choice after picking the color dot', async () => {
      const user = userEvent.setup();
      renderPage({ ...project, icon: saved });

      const current = await screen.findByRole('button', { name: 'Current icon' });
      expect(current).toHaveAttribute('aria-pressed', 'true');
      await user.click(screen.getByRole('button', { name: 'Color dot' }));
      expect(screen.getByRole('button', { name: 'Current icon' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(mocks.updateProject.mock.calls[0][1]).toMatchObject({ icon: undefined });
    });

    it("offers the picked icon's colors without changing the color", async () => {
      const user = userEvent.setup();
      mocks.iconColors = { [favicon.dataUrl]: ['#61dafb'] };
      vi.mocked(window.api.findProjectIcons).mockResolvedValue([favicon]);
      renderPage();

      await user.click(await screen.findByRole('button', { name: favicon.path }));
      const suggested = await screen.findByRole('button', { name: 'Icon color #61dafb' });
      expect(suggested).toHaveAttribute('aria-pressed', 'false');
      await user.click(suggested);
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(mocks.updateProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ icon: favicon.dataUrl, color: '#61dafb' })
      );
    });

    it('keeps a saved icon color first, and a choice after the icon changes', async () => {
      const user = userEvent.setup();
      mocks.iconColors = { [saved]: ['#e11d48', '#61dafb'] };
      renderPage({ ...project, icon: saved, color: '#61dafb' });

      const suggested = () =>
        screen
          .getAllByRole('button', { name: /^Icon color/ })
          .map((b) => b.getAttribute('aria-label'));
      await waitFor(() =>
        expect(suggested()).toEqual(['Icon color #61dafb', 'Icon color #e11d48'])
      );
      await user.click(screen.getByRole('button', { name: 'Color dot' }));
      expect(suggested()).toEqual(['Icon color #61dafb']);
      expect(screen.getByRole('button', { name: 'Icon color #61dafb' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('drops a color picked from an icon once another icon is picked', async () => {
      const user = userEvent.setup();
      const logo = { path: 'logo.svg', dataUrl: 'data:image/svg+xml;base64,PGcvPg==' };
      mocks.iconColors = { [favicon.dataUrl]: ['#61dafb'] };
      vi.mocked(window.api.findProjectIcons).mockResolvedValue([favicon, logo]);
      renderPage({ ...project, color: PROJECT_COLORS[2] });

      await user.click(await screen.findByRole('button', { name: favicon.path }));
      await user.click(await screen.findByRole('button', { name: 'Icon color #61dafb' }));
      await user.click(screen.getByRole('button', { name: logo.path }));
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(mocks.updateProject.mock.calls[0][1]).toMatchObject({
        icon: logo.dataUrl,
        color: PROJECT_COLORS[2],
      });
    });

    it('saves an uploaded icon when the files have none', async () => {
      const user = userEvent.setup();
      const uploaded = { path: 'brand.png', dataUrl: saved };
      window.api.chooseProjectIconFile = vi.fn().mockResolvedValue(uploaded);
      renderPage();
      await waitFor(() => expect(window.api.findProjectIcons).toHaveBeenCalled());

      await user.click(screen.getByRole('button', { name: 'Upload icon…' }));
      expect(await screen.findByRole('button', { name: 'brand.png' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(mocks.updateProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ icon: saved })
      );
    });
  });
});
