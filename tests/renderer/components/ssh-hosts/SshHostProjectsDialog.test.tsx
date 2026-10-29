/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SshHostProjectsDialog } from '../../../../src/renderer/components/ssh-hosts/SshHostProjectsDialog';

import type { SshHostProject } from '../../../../src/shared/types/ssh-project-manifest';

const addToast = vi.fn();
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof addToast }) => unknown) =>
    selector({ addToast }),
}));

const loadProjects = vi.fn(async () => undefined);
const stores = { hosts: [{ id: 'host-1', name: 'Build box' }], loadProjects };
vi.mock('../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: (selector: (state: typeof stores) => unknown) => selector(stores),
}));
vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: typeof stores) => unknown) => selector(stores),
}));

const WEB = '0123456789abcdef0123456789abcdef';
const API = 'fedcba9876543210fedcba9876543210';

const PROJECTS: SshHostProject[] = [
  {
    manifestId: WEB,
    name: 'web',
    gitUrl: 'git@github.com:acme/web.git',
    differs: ['appearance', 'workspaceSetup', 'quickCommands', 'settings'],
    setupSteps: [{ name: 'Install', command: 'npm install' }],
    trashCleanupScript: 'docker compose down',
    quickCommands: [{ title: 'Deploy', content: './deploy.sh', type: 'command' }],
    updatedAt: 1,
  },
  {
    manifestId: API,
    name: 'api',
    gitUrl: 'git@github.com:acme/api.git',
    projectId: 'project-api',
    differs: ['appearance'],
    setupSteps: [],
    quickCommands: [],
    updatedAt: 1,
  },
];

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<SshHostProjectsDialog hostId="host-1" open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe('SshHostProjectsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { api: unknown }).api = {
      listSshHostProjects: vi.fn().mockResolvedValue(PROJECTS),
      importSshHostProjects: vi.fn(async (_hostId: string, imports: Array<{ manifestId: string }>) =>
        imports.map(({ manifestId }) => ({
          manifestId,
          ok: true,
          projectId: manifestId === API ? 'project-api' : 'project-web',
          added: manifestId !== API,
        }))
      ),
    };
  });

  it('lists projects to add apart from ones whose settings differ, with commands to review', async () => {
    renderDialog();

    const toAdd = await screen.findByRole('region', { name: 'Not here yet' });
    expect(within(toAdd).getByText('web')).toBeInTheDocument();
    expect(within(toAdd).getByText('New')).toBeInTheDocument();
    const changed = screen.getByRole('region', { name: 'Different settings on the host' });
    expect(within(changed).getByText('api')).toBeInTheDocument();
    expect(within(changed).queryByLabelText('Workspace Setup')).not.toBeInTheDocument();

    expect(screen.getByText('Review the commands first')).toBeInTheDocument();
    await userEvent.click(within(toAdd).getByText('Review commands'));
    expect(within(toAdd).getByText('npm install')).toBeVisible();
    expect(within(toAdd).getByText('docker compose down')).toBeVisible();
    expect(within(toAdd).getByText('./deploy.sh')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import 2 projects' })).toBeEnabled();
  });

  it('imports the projects and parts picked', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    const toAdd = await screen.findByRole('region', { name: 'Not here yet' });
    await user.click(within(toAdd).getByLabelText('Quick Commands'));
    await user.click(
      within(screen.getByRole('region', { name: 'Different settings on the host' })).getByRole(
        'checkbox',
        { name: /api/ }
      )
    );
    await user.click(screen.getByRole('button', { name: 'Add 1 project' }));

    expect(window.api.importSshHostProjects).toHaveBeenCalledWith('host-1', [
      { manifestId: WEB, parts: ['appearance', 'workspaceSetup', 'settings'] },
    ]);
    expect(loadProjects).toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('Added 1 project from Build box', 'success');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open on what failed, offering only what wasn’t taken', async () => {
    vi.mocked(window.api.importSshHostProjects).mockResolvedValueOnce([
      { manifestId: WEB, ok: false, error: 'Could not clone' },
      { manifestId: API, ok: true, projectId: 'project-api', added: false },
    ]);
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Import 2 projects' }));

    expect(await screen.findByText(/Could not clone/)).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith('Copied settings for 1 project', 'success');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('region', { name: 'Different settings on the host' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 1 project' })).toBeEnabled();
  });

  it('leaves a project removed here unticked', async () => {
    vi.mocked(window.api.listSshHostProjects).mockResolvedValueOnce([
      { ...PROJECTS[0], removedHere: true },
    ]);
    renderDialog();

    const row = await screen.findByRole('region', { name: 'Not here yet' });
    expect(within(row).getByText('Removed here')).toBeInTheDocument();
    expect(within(row).getByRole('checkbox', { name: /web/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Copy settings' })).toBeDisabled();
  });

  it('says so when every project on the host is here already', async () => {
    vi.mocked(window.api.listSshHostProjects).mockResolvedValueOnce([]);
    renderDialog();

    expect(
      await screen.findByText('Every project on this host is here already, with the same settings.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy settings' })).toBeDisabled();
  });
});
