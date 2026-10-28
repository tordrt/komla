/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BranchCleanupDialog,
  groupLeftoverBranches,
} from '../../../../src/renderer/components/projects/BranchCleanupDialog';

import type { LeftoverBranch } from '../../../../src/shared/types';

const addToast = vi.fn();
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof addToast }) => unknown) =>
    selector({ addToast }),
}));

const stores = {
  workspaces: [] as Array<{ id: string; projectId: string; backend?: object }>,
  hosts: [{ id: 'host-1', name: 'Build box' }],
};
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: typeof stores) => unknown) => selector(stores),
}));
vi.mock('../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: (selector: (state: typeof stores) => unknown) => selector(stores),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00Z');

function branch(name: string, daysAgo: number, landed: boolean): LeftoverBranch {
  return {
    name,
    commit: name.padEnd(40, '0').replace(/[^0-9a-f]/g, 'a'),
    lastCommitAt: NOW - daysAgo * DAY,
    subject: `${name} subject`,
    landed,
  };
}

const BRANCHES = [
  branch('merged-recently', 2, true),
  branch('wip', 3, false),
  branch('abandoned', 45, false),
  branch('merged-long-ago', 90, true),
];

describe('groupLeftoverBranches', () => {
  it('puts landed branches first, then splits the rest at 30 days, leaving out empty groups', () => {
    const groups = groupLeftoverBranches({ targetBranch: 'develop', branches: BRANCHES }, NOW);

    expect(groups.map((group) => [group.title, group.branches.map((b) => b.name)])).toEqual([
      ['Already in develop', ['merged-recently', 'merged-long-ago']],
      ['No commits in 30 days', ['abandoned']],
      ['Recent', ['wip']],
    ]);
    expect(
      groupLeftoverBranches({ targetBranch: 'main', branches: [BRANCHES[1]] }, NOW).map(
        (group) => group.key
      )
    ).toEqual(['recent']);
  });
});

describe('BranchCleanupDialog', () => {
  const listLeftoverBranches = vi.fn();
  const deleteLeftoverBranches = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    addToast.mockReset();
    listLeftoverBranches
      .mockReset()
      .mockResolvedValue({ targetBranch: 'main', branches: BRANCHES });
    deleteLeftoverBranches.mockReset().mockResolvedValue({ deleted: [], failed: [] });
    window.api = { listLeftoverBranches, deleteLeftoverBranches } as never;
    stores.workspaces = [{ id: 'local', projectId: 'project-1' }];
    return () => vi.useRealTimers();
  });

  function renderDialog() {
    const onOpenChange = vi.fn();
    render(<BranchCleanupDialog projectId="project-1" open onOpenChange={onOpenChange} />);
    return { onOpenChange };
  }

  it('selects only the landed branches and deletes what is checked', async () => {
    const user = userEvent.setup();
    deleteLeftoverBranches.mockResolvedValue({
      deleted: ['merged-recently', 'merged-long-ago', 'abandoned'],
      failed: [],
    });
    const { onOpenChange } = renderDialog();

    expect(await screen.findByRole('checkbox', { name: /merged-recently/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /merged-long-ago/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^abandoned/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^wip/ })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /^abandoned/ }));
    await user.click(screen.getByRole('button', { name: 'Delete 3 branches' }));

    expect(listLeftoverBranches).toHaveBeenCalledWith('project-1', null);
    expect(deleteLeftoverBranches).toHaveBeenCalledWith(
      'project-1',
      [
        { name: 'merged-recently', commit: BRANCHES[0].commit },
        { name: 'abandoned', commit: BRANCHES[2].commit },
        { name: 'merged-long-ago', commit: BRANCHES[3].commit },
      ],
      null
    );
    expect(screen.queryByRole('radiogroup', { name: 'Clone' })).not.toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith('Deleted 3 branches', 'success');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('checks and unchecks a whole group from its header', async () => {
    const user = userEvent.setup();
    renderDialog();

    const landed = await screen.findByRole('region', { name: 'Already in main' });
    await user.click(within(landed).getByRole('checkbox', { name: /Already in main/ }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

    const recent = screen.getByRole('region', { name: 'Recent' });
    await user.click(within(recent).getByRole('checkbox', { name: /Recent/ }));
    expect(screen.getByRole('checkbox', { name: /^wip/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Delete 1 branch' })).toBeEnabled();
  });

  it('stays open and lists the branches it kept, then lists again', async () => {
    const user = userEvent.setup();
    deleteLeftoverBranches.mockResolvedValue({
      deleted: ['merged-recently'],
      failed: [{ name: 'merged-long-ago', message: 'The branch has new commits.' }],
    });
    const { onOpenChange } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Delete 2 branches' }));

    expect(await screen.findByText('Kept 1 branch')).toBeInTheDocument();
    expect(screen.getByText(/The branch has new commits\./)).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith('Deleted 1 branch', 'success');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(listLeftoverBranches).toHaveBeenCalledTimes(2);
  });

  it('keeps what was unticked after a partial failure, and unticks the branches it kept', async () => {
    const user = userEvent.setup();
    deleteLeftoverBranches.mockResolvedValue({
      deleted: ['abandoned'],
      failed: [{ name: 'merged-long-ago', message: 'The branch has new commits.' }],
    });
    renderDialog();

    await user.click(await screen.findByRole('checkbox', { name: /merged-recently/ }));
    await user.click(screen.getByRole('checkbox', { name: /^abandoned/ }));
    listLeftoverBranches.mockResolvedValueOnce({
      targetBranch: 'main',
      branches: BRANCHES.filter((b) => b.name !== 'abandoned'),
    });
    await user.click(screen.getByRole('button', { name: 'Delete 2 branches' }));

    expect(await screen.findByText('Kept 1 branch')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /merged-recently/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /merged-long-ago/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('says when there is nothing to clean up, or why it could not list', async () => {
    listLeftoverBranches.mockResolvedValueOnce({ targetBranch: 'main', branches: [] });
    const { unmount } = render(
      <BranchCleanupDialog projectId="project-1" open onOpenChange={vi.fn()} />
    );
    expect(await screen.findByText('No leftover branches.')).toBeInTheDocument();
    unmount();

    listLeftoverBranches.mockRejectedValueOnce(new Error('not a git repository'));
    renderDialog();
    expect(await screen.findByText('not a git repository')).toBeInTheDocument();
  });

  it('cleans up the clone on each SSH host where the project has workspaces', async () => {
    const user = userEvent.setup();
    stores.workspaces = [
      { id: 'local', projectId: 'project-1' },
      { id: 'remote', projectId: 'project-1', backend: { kind: 'ssh', hostId: 'host-1' } },
      { id: 'other', projectId: 'project-2', backend: { kind: 'ssh', hostId: 'host-2' } },
    ];
    renderDialog();

    const clone = screen.getByRole('radiogroup', { name: 'Clone' });
    expect(
      within(clone)
        .getAllByRole('radio')
        .map((radio) => radio.textContent)
    ).toEqual(['This computer', 'Build box']);
    await screen.findByRole('checkbox', { name: /merged-recently/ });
    await user.click(within(clone).getByRole('radio', { name: 'Build box' }));
    await user.click(await screen.findByRole('button', { name: 'Delete 2 branches' }));

    expect(listLeftoverBranches.mock.calls).toEqual([
      ['project-1', null],
      ['project-1', 'host-1'],
    ]);
    expect(deleteLeftoverBranches).toHaveBeenCalledWith('project-1', expect.any(Array), 'host-1');
  });

  it("starts on the host's clone when opened from an SSH workspace", async () => {
    render(
      <BranchCleanupDialog projectId="project-1" hostId="host-1" open onOpenChange={vi.fn()} />
    );

    await screen.findByRole('checkbox', { name: /merged-recently/ });
    expect(listLeftoverBranches.mock.calls).toEqual([['project-1', 'host-1']]);
    expect(screen.getByRole('radio', { name: 'Build box' })).toBeChecked();
  });
});
