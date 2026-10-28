/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const projectPageMounts = vi.hoisted(() => [] as string[]);

vi.hoisted(() => {
  (globalThis as unknown as { window: Window }).window.api = {
    platform: 'darwin',
    getAppVersion: () => Promise.resolve('1.2.3'),
    getRepoWebInfo: () => Promise.resolve({ webUrl: null }),
  } as unknown as typeof window.api;
});

type DirtyProps = { onDirtyChange?: (dirty: boolean) => void };

function stubPage(name: string) {
  return function StubPage({ onDirtyChange }: DirtyProps) {
    return (
      <div>
        <p>{`${name} page`}</p>
        <button type="button" onClick={() => onDirtyChange?.(true)}>
          {`Edit ${name}`}
        </button>
      </div>
    );
  };
}

vi.mock('../../../../../src/renderer/components/layout/settings/GeneralTab', () => ({
  GeneralTab: stubPage('General'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/AgentTab', () => ({
  AgentTab: stubPage('Agents'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/IntegrationsTab', () => ({
  IntegrationsTab: stubPage('Integrations'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/ProjectsTab', () => ({
  ProjectsTab: ({
    adding,
    onAddProject,
    onShowList,
    onOpenProject,
  }: {
    adding: boolean;
    onAddProject: () => void;
    onShowList: () => void;
    onOpenProject: (projectId: string) => void;
  }) => (
    <div>
      <p>{adding ? 'Add project form' : 'Project list'}</p>
      <button type="button" onClick={onAddProject}>
        Add project
      </button>
      <button type="button" onClick={onShowList}>
        Cancel adding
      </button>
      <button type="button" onClick={() => onOpenProject('project-2')}>
        Open Docs from the list
      </button>
    </div>
  ),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/ProjectSettingsPage', () => ({
  ProjectSettingsPage: function StubProjectSettingsPage({
    project,
    onDirtyChange,
    section,
  }: DirtyProps & { project: { id: string; name: string }; section?: string }) {
    React.useEffect(() => {
      projectPageMounts.push(project.id);
    }, [project.id]);
    return (
      <div>
        <p>{`Settings for ${project.name}`}</p>
        <p>{`Section ${section ?? 'none'}`}</p>
        <section id="settings-card-setup-steps">Setup steps card</section>
        <button type="button" onClick={() => onDirtyChange?.(true)}>
          Edit the project
        </button>
      </div>
    );
  },
}));
vi.mock('../../../../../src/renderer/components/layout/settings/ActionsTab', () => ({
  ActionsTab: stubPage('Actions'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/SshTab', () => ({
  SshTab: stubPage('SSH'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/AppearanceTab', () => ({
  AppearanceTab: () => (
    <div>
      <p>Appearance page</p>
      <section id="settings-card-terminal">Terminal card</section>
    </div>
  ),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/TerminalTab', () => ({
  TerminalTab: stubPage('Terminal'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/FilesTab', () => ({
  FilesTab: stubPage('Files'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/VoiceTab', () => ({
  VoiceTab: stubPage('Voice'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/LicenseTab', () => ({
  LicenseTab: stubPage('License'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/ChangelogTab', () => ({
  ChangelogTab: stubPage('Changelog'),
}));
vi.mock('../../../../../src/renderer/components/layout/settings/RemoteTab', () => ({
  RemoteTab: stubPage('Remote'),
}));
vi.mock('../../../../../src/renderer/components/layout/ReleaseNotesDialog', () => ({
  ReleaseNotesDialog: () => null,
}));
vi.mock('../../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: (selector: (state: { completePendingSetup: () => void }) => unknown) =>
    selector({ completePendingSetup: vi.fn() }),
}));
vi.mock('../../../../../src/renderer/stores/update.store', () => ({
  useUpdateStore: () => ({
    status: 'idle',
    version: null,
    releaseNotes: null,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
  }),
}));

import { SettingsDialog } from '../../../../../src/renderer/components/layout/settings/SettingsDialog';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useProjectsStore } from '../../../../../src/renderer/stores/projects.store';
import { useShortcutsStore } from '../../../../../src/renderer/stores/shortcuts.store';

import type { Project } from '../../../../../src/shared/types';

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    repositoryPath: `/tmp/${name}`,
    defaultBranchPrefix: 'agent/',
    createdAt: 0,
    order: 0,
    managed: false,
  };
}

function renderSettings(props: Partial<React.ComponentProps<typeof SettingsDialog>> = {}) {
  const onOpenChange = vi.fn();
  const view = render(
    <TooltipProvider>
      <SettingsDialog open onOpenChange={onOpenChange} {...props} />
    </TooltipProvider>
  );
  return { onOpenChange, ...view };
}

function navButton(name: RegExp | string) {
  return within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('button', {
    name,
  });
}

/** A section row listed under a project in the nav. */
function sectionButton(projectName: string, name: string) {
  return within(screen.getByRole('group', { name: `${projectName} settings` })).getByRole(
    'button',
    { name }
  );
}

describe('SettingsDialog', () => {
  let scrolledTo: Element[];

  beforeEach(() => {
    scrolledTo = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this);
    };
    useProjectsStore.setState({ projects: [] });
    useConfigStore.setState({ config: null });
  });

  describe('projects in the navigation', () => {
    beforeEach(() => {
      projectPageMounts.length = 0;
      useProjectsStore.setState({
        projects: [makeProject('project-1', 'Komla'), makeProject('project-2', 'Docs')],
      });
    });

    it('lists each project under Projects and opens its page', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects' });

      await user.click(navButton('Docs'));

      expect(screen.getByText('Settings for Docs')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Docs' })).toBeInTheDocument();
      expect(sectionButton('Docs', 'General')).toHaveAttribute('aria-current', 'page');
      expect(navButton('Projects')).not.toHaveAttribute('aria-current');
      // Only the project shown lists its sections.
      expect(screen.queryByRole('group', { name: 'Komla settings' })).not.toBeInTheDocument();

      await user.click(navButton('Projects'));

      expect(screen.getByText('Project list')).toBeInTheDocument();
      expect(navButton('Projects')).toHaveAttribute('aria-current', 'page');
    });

    it('folds the projects away on other pages, and unfolds them on request', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      expect(screen.queryByRole('button', { name: 'Docs' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show projects' }));
      await user.click(navButton('Docs'));

      expect(screen.getByText('Settings for Docs')).toBeInTheDocument();

      // Folding them away while on a project marks Projects instead.
      await user.click(screen.getByRole('button', { name: 'Hide projects' }));
      expect(screen.queryByRole('button', { name: 'Docs' })).not.toBeInTheDocument();
      expect(navButton('Projects')).toHaveAttribute('aria-current', 'page');

      await user.click(navButton('Terminal'));
      expect(screen.queryByRole('button', { name: 'Docs' })).not.toBeInTheDocument();
    });

    it('folds and unfolds the projects with the arrow keys on Projects', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      navButton('Projects').focus();
      await user.keyboard('{ArrowRight}');
      expect(navButton('Komla')).toBeInTheDocument();

      await user.keyboard('{ArrowLeft}');
      expect(screen.queryByRole('button', { name: 'Komla' })).not.toBeInTheDocument();
    });

    it('marks the project a link opened Settings for', () => {
      renderSettings({ initialTab: 'projects', initialEditProjectId: 'project-1' });

      expect(screen.getByText('Settings for Komla')).toBeInTheDocument();
      expect(sectionButton('Komla', 'General')).toHaveAttribute('aria-current', 'page');
    });

    it('shows the list for a link to a project that no longer exists', () => {
      renderSettings({ initialTab: 'projects', initialEditProjectId: 'deleted-project' });

      expect(screen.getByText('Project list')).toBeInTheDocument();
      expect(navButton('Projects')).toHaveAttribute('aria-current', 'page');
    });

    it('opens the list, not the last project, when Projects is reached another way', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects' });

      await user.click(navButton('Docs'));
      await user.click(navButton('Terminal'));
      await user.type(screen.getByRole('combobox', { name: 'Search settings' }), 'projects{Enter}');

      expect(screen.getByText('Project list')).toBeInTheDocument();
      // Clear the search to bring the navigation back.
      await user.keyboard('{Escape}');
      expect(navButton('Projects')).toHaveAttribute('aria-current', 'page');
    });

    it('leaves the add form when Projects is clicked', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects' });

      await user.click(screen.getByRole('button', { name: 'Add project' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Add project' })).toBeInTheDocument();
      expect(navButton('Projects')).toHaveAttribute('aria-current', 'page');

      await user.click(navButton('Projects'));

      expect(screen.getByText('Project list')).toBeInTheDocument();
    });

    it('moves through the projects with the arrow keys', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects' });

      navButton('Projects').focus();
      await user.keyboard('{ArrowDown}');

      expect(screen.getByText('Settings for Komla')).toBeInTheDocument();
      expect(navButton('Komla')).toHaveFocus();

      // Through Komla's sections, then on to the next project.
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(sectionButton('Komla', 'Setup')).toHaveFocus();
      expect(screen.getByText('Section setup')).toBeInTheDocument();

      await user.keyboard('{ArrowDown}');
      expect(screen.getByText('Settings for Docs')).toBeInTheDocument();
      expect(navButton('Docs')).toHaveFocus();
    });

    it('asks before leaving a project with unsaved edits for another one, naming it', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects', initialEditProjectId: 'project-1' });

      await user.click(screen.getByRole('button', { name: 'Edit the project' }));
      expect(navButton(/Komla.*unsaved changes/)).toBeInTheDocument();

      await user.click(navButton('Docs'));
      const confirm = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
      expect(confirm).toHaveTextContent('You have unsaved changes to Komla. Discard them?');
      expect(screen.getByText('Settings for Komla')).toBeInTheDocument();

      await user.click(within(confirm).getByRole('button', { name: 'Discard changes' }));

      expect(screen.getByText('Settings for Docs')).toBeInTheDocument();
      expect(navButton('Docs')).not.toHaveAccessibleName(/unsaved/);
    });

    it('keeps the edits when the project shown is asked for again', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects', initialEditProjectId: 'project-1' });

      await user.click(screen.getByRole('button', { name: 'Edit the project' }));
      await user.click(navButton(/Komla/));
      navButton(/Komla/).focus();
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' })
      );

      expect(projectPageMounts).toEqual(['project-1']);
      expect(navButton(/Komla.*unsaved changes/)).toBeInTheDocument();
    });

    it('switches between a project’s sections without asking, keeping its edits', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects', initialEditProjectId: 'project-1' });

      await user.click(screen.getByRole('button', { name: 'Edit the project' }));
      await user.click(sectionButton('Komla', 'Git'));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText('Section git')).toBeInTheDocument();
      expect(sectionButton('Komla', 'Git')).toHaveAttribute('aria-current', 'page');
      expect(projectPageMounts).toEqual(['project-1']);
      // The project's row carries the unsaved marker, not the section's.
      expect(navButton(/Komla.*unsaved changes/)).toBeInTheDocument();
    });

    it('switches sections from the tabs on the project page too, keeping its edits', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'projects', initialEditProjectId: 'project-1' });
      const tabs = screen.getByRole('tablist', { name: 'Komla sections' });
      expect(within(tabs).getByRole('tab', { name: 'General' })).toHaveAttribute(
        'aria-selected',
        'true'
      );

      await user.click(screen.getByRole('button', { name: 'Edit the project' }));
      await user.click(within(tabs).getByRole('tab', { name: 'Setup' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText('Section setup')).toBeInTheDocument();
      expect(within(tabs).getByRole('tab', { name: 'Setup' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(sectionButton('Komla', 'Setup')).toHaveAttribute('aria-current', 'page');
      expect(projectPageMounts).toEqual(['project-1']);
    });

    it('opens the section of a project card found in search', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      await user.type(
        screen.getByRole('combobox', { name: 'Search settings' }),
        'trash cleanup{Enter}'
      );

      expect(screen.getByText('Section setup')).toBeInTheDocument();
    });

    it('lists no sections for a directory project', async () => {
      const user = userEvent.setup();
      useProjectsStore.setState({
        projects: [{ ...makeProject('project-3', 'Notes'), kind: 'directory' }],
      });
      renderSettings({ initialTab: 'projects' });

      await user.click(navButton('Notes'));

      expect(navButton('Notes')).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('group', { name: 'Notes settings' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tablist', { name: 'Notes sections' })).not.toBeInTheDocument();
    });

    it('finds a project by name in search', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      await user.type(screen.getByRole('combobox', { name: 'Search settings' }), 'docs{Enter}');

      expect(screen.getByText('Settings for Docs')).toBeInTheDocument();
    });

    it('opens the setup on a project page for a link to Workspace Setup', () => {
      renderSettings({ initialTab: 'workspace-setup', initialSetupProjectId: 'project-2' });

      expect(screen.getByText('Settings for Docs')).toBeInTheDocument();
      expect(scrolledTo).toContain(screen.getByText('Setup steps card'));
      expect(screen.getByText('Section setup')).toBeInTheDocument();
      expect(sectionButton('Docs', 'Setup')).toHaveAttribute('aria-current', 'page');
    });
  });

  it('lists the Remote page, marked Alpha, and opens it', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(navButton('Remote Alpha'));

    expect(await screen.findByText('Remote page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Remote Alpha' })).toBeInTheDocument();
  });

  describe('leaving a page with unsaved changes', () => {
    it('asks before discarding, and clears the unsaved marker when the edits are discarded', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderSettings({ initialTab: 'general' });

      await user.click(screen.getByRole('button', { name: 'Edit General' }));
      expect(navButton(/General.*unsaved changes/)).toBeInTheDocument();

      await user.click(navButton('Terminal'));

      const confirm = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
      expect(confirm).toHaveTextContent('General');
      expect(screen.getByText('General page')).toBeInTheDocument();

      await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText('General page')).toBeInTheDocument();
      expect(navButton(/General.*unsaved changes/)).toBeInTheDocument();

      await user.click(navButton('Terminal'));
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' })
      );

      expect(screen.getByText('Terminal page')).toBeInTheDocument();
      expect(screen.queryByText('General page')).not.toBeInTheDocument();
      expect(navButton('General')).not.toHaveAccessibleName(/unsaved/);

      // Nothing is left unsaved, so closing doesn't warn.
      await user.click(screen.getByRole('button', { name: 'Back to app' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('switches without asking when the current page has no unsaved changes', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      await user.click(navButton('Terminal'));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText('Terminal page')).toBeInTheDocument();
    });

    it('asks before following a link away from unsaved edits', async () => {
      const user = userEvent.setup();
      const { rerender } = renderSettings({ initialTab: 'general', openRequestId: 1 });

      await user.click(screen.getByRole('button', { name: 'Edit General' }));
      rerender(
        <TooltipProvider>
          <SettingsDialog open onOpenChange={vi.fn()} initialTab="actions" openRequestId={2} />
        </TooltipProvider>
      );

      const confirm = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
      await user.click(within(confirm).getByRole('button', { name: 'Discard changes' }));

      expect(screen.getByText('Actions page')).toBeInTheDocument();
    });

    it('asks before closing on Escape', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderSettings({ initialTab: 'general' });

      await user.click(screen.getByRole('button', { name: 'Edit General' }));
      await user.keyboard('{Escape}');

      expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toHaveTextContent(
        'close Settings'
      );
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  describe('Escape in a search field', () => {
    beforeEach(() => {
      useShortcutsStore.setState({
        config: { shortcuts: { 'pane.splitRight': 'Cmd+\\', 'pane.splitDown': 'Cmd+Shift+\\' } },
      });
    });

    it('clears the Shortcuts search first, then closes Settings on a second Escape', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderSettings({ initialTab: 'shortcuts' });

      const search = screen.getByPlaceholderText('Search shortcuts...');
      await user.type(search, 'split');
      expect(search).toHaveValue('split');

      await user.keyboard('{Escape}');

      expect(search).toHaveValue('');
      expect(onOpenChange).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('search', () => {
    it('lists matching settings in place of the navigation, and opens one from the keyboard', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderSettings({ initialTab: 'general' });

      const search = screen.getByRole('combobox', { name: 'Search settings' });
      await user.type(search, 'cursor');

      expect(screen.queryByRole('navigation', { name: 'Settings' })).not.toBeInTheDocument();
      const options = within(
        screen.getByRole('listbox', { name: 'Settings search results' })
      ).getAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual([
        'TerminalAppearance',
        'Cursor styleAppearance › Terminal',
        'Cursor blinkAppearance › Terminal',
      ]);
      expect(options[0]).toHaveAttribute('aria-selected', 'true');

      await user.keyboard('{ArrowDown}');
      expect(options[1]).toHaveAttribute('aria-selected', 'true');
      expect(search).toHaveAttribute('aria-activedescendant', options[1].id);
      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(options[2]).toHaveAttribute('aria-selected', 'true');

      await user.keyboard('{Enter}');

      expect(screen.getByText('Appearance page')).toBeInTheDocument();
      const card = screen.getByText('Terminal card');
      expect(scrolledTo).toContain(card);
      expect(card).toHaveAttribute('data-search-target');

      // Escape clears the search and brings the navigation back, without closing Settings.
      await user.keyboard('{Escape}');
      expect(search).toHaveValue('');
      expect(navButton('Appearance')).toHaveAttribute('aria-current', 'page');
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('marks what matched and opens a result on click', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      await user.type(screen.getByRole('combobox', { name: 'Search settings' }), 'blink');
      const option = screen.getByRole('option', { name: /Cursor blink/ });
      expect(within(option).getByText('blink').tagName).toBe('MARK');

      await user.click(option);

      expect(screen.getByText('Appearance page')).toBeInTheDocument();
    });

    it('says when nothing matches', async () => {
      const user = userEvent.setup();
      renderSettings();

      await user.type(screen.getByRole('combobox', { name: 'Search settings' }), 'zzzz');

      expect(screen.getByText('No matching settings')).toBeInTheDocument();
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    it('asks before leaving a page with unsaved edits', async () => {
      const user = userEvent.setup();
      renderSettings({ initialTab: 'general' });

      await user.click(screen.getByRole('button', { name: 'Edit General' }));
      await user.type(screen.getByRole('combobox', { name: 'Search settings' }), 'cursor{Enter}');

      const confirm = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
      expect(screen.getByText('General page')).toBeInTheDocument();
      await user.click(within(confirm).getByRole('button', { name: 'Discard changes' }));

      expect(screen.getByText('Appearance page')).toBeInTheDocument();
      expect(scrolledTo).toContain(screen.getByText('Terminal card'));
    });
  });

  it('offers an update check in an official build', () => {
    renderSettings({ initialTab: 'general' });

    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument();
    expect(screen.queryByText('Built from source')).not.toBeInTheDocument();
  });

  it('says it was built from source instead of offering an update check', () => {
    window.api.buildFromSource = true;
    try {
      renderSettings({ initialTab: 'general' });

      expect(screen.getByText('Built from source')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument();
    } finally {
      window.api.buildFromSource = false;
    }
  });

  it('shows voice input on its own page', async () => {
    const user = userEvent.setup();
    renderSettings({ initialTab: 'general' });

    await user.click(navButton('Voice'));

    expect(screen.getByRole('heading', { level: 1, name: 'Voice' })).toBeInTheDocument();
    expect(screen.getByText('Voice page')).toBeInTheDocument();
    expect(navButton('Voice')).toHaveAttribute('aria-current', 'page');
  });

  it('opens the Voice page for a link to the old voice section', () => {
    renderSettings({ initialGeneralSection: 'voice' });

    expect(screen.getByText('Voice page')).toBeInTheDocument();
  });

  it('follows a link to the page it last linked to after you have left it', async () => {
    const user = userEvent.setup();
    const { rerender } = renderSettings({ initialTab: 'shortcuts', openRequestId: 1 });
    await user.click(navButton('Voice'));
    expect(screen.getByText('Voice page')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <SettingsDialog open onOpenChange={vi.fn()} initialTab="shortcuts" openRequestId={2} />
      </TooltipProvider>
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Shortcuts' })).toBeInTheDocument();
  });

  it('closes the dialog when Back to app is pressed', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderSettings();

    await user.click(screen.getByRole('button', { name: 'Back to app' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('puts focus in the search box when it opens', async () => {
    renderSettings();

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Search settings' })).toHaveFocus()
    );
  });

  it('shows the app version in the footer', async () => {
    renderSettings();
    await act(async () => {});
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });
});
