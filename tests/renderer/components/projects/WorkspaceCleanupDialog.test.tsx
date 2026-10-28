/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorkspaceCleanupDialog,
  groupWorkspacesForCleanup,
} from '../../../../src/renderer/components/projects/WorkspaceCleanupDialog';

import type { Workspace, WorkspaceCleanupStatus } from '../../../../src/shared/types';

const addToast = vi.fn();
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof addToast }) => unknown) =>
    selector({ addToast }),
}));

const trashWorkspaces = vi.fn();
const store = { workspaces: [] as Workspace[], trashWorkspaces };
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(
    (selector: (state: typeof store) => unknown) => selector(store),
    { getState: () => store }
  ),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00Z');

function workspace(id: string, daysAgo: number, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    customName: id,
    workingDirectory: `/worktrees/${id}`,
    branchName: `branch-${id}`,
    isWorktree: true,
    projectId: 'project-1',
    terminals: [],
    windowId: null,
    categoryId: null,
    createdAt: NOW - 100 * DAY,
    lastActivityAt: NOW - daysAgo * DAY,
    order: 0,
    status: 'active',
    ...extra,
  };
}

function landed(workspaceId: string, targetBranch = 'main'): WorkspaceCleanupStatus {
  return {
    workspaceId,
    targetBranch,
    ok: true,
    landed: true,
    uncommittedChanges: false,
  };
}

const WORKSPACES = [
  workspace('merged-recently', 1),
  workspace('wip', 2),
  workspace('dirty', 3),
  workspace('old-dirty', 40),
  workspace('abandoned', 45),
  workspace('merged-pinned', 60, { pinned: true }),
  workspace('merged-busy', 70, { agentActive: true }),
  workspace('offline', 80),
];

const STATUSES: WorkspaceCleanupStatus[] = [
  landed('merged-recently'),
  { ...landed('wip'), landed: false },
  { ...landed('dirty'), uncommittedChanges: true },
  { ...landed('old-dirty'), uncommittedChanges: true },
  { ...landed('abandoned'), landed: false },
  landed('merged-pinned'),
  landed('merged-busy'),
  {
    workspaceId: 'offline',
    targetBranch: 'main',
    ok: false,
    error: 'Host unreachable',
  },
];

const names = (groups: ReturnType<typeof groupWorkspacesForCleanup>) =>
  groups.map((group) => [group.title, group.workspaces.map((w) => w.id)]);

describe('groupWorkspacesForCleanup', () => {
  it('lists workspaces with nothing to lose, then the rest not used in 30 days', () => {
    const statuses = new Map(STATUSES.map((status) => [status.workspaceId, status]));

    // wip and dirty are in use and have changes to lose, so they aren't offered.
    expect(names(groupWorkspacesForCleanup(WORKSPACES, statuses, NOW))).toEqual([
      ['Already in main', ['merged-recently', 'merged-pinned', 'merged-busy']],
      ['Not used in 30 days', ['old-dirty', 'abandoned', 'offline']],
    ]);
  });

  it('names no branch when the workspaces target different ones, and leaves out empty groups', () => {
    const statuses = new Map([
      ['merged-recently', landed('merged-recently')],
      ['wip', landed('wip', 'develop')],
    ]);

    expect(names(groupWorkspacesForCleanup(WORKSPACES.slice(0, 2), statuses, NOW))).toEqual([
      ['Already in their target branch', ['merged-recently', 'wip']],
    ]);
    // Directory projects have no branches to check, so only age counts.
    expect(names(groupWorkspacesForCleanup(WORKSPACES, new Map(), NOW))).toEqual([
      [
        'Not used in 30 days',
        ['old-dirty', 'abandoned', 'merged-pinned', 'merged-busy', 'offline'],
      ],
    ]);
    expect(groupWorkspacesForCleanup(WORKSPACES.slice(0, 3), new Map(), NOW)).toEqual([]);
  });

  it('counts a prompt or a notification as use, not only file changes', () => {
    const chatty = [
      workspace('prompted', 40, {
        promptSubmits: [{ prompt: 'go on', submittedAt: NOW - 2 * DAY }],
      }),
      workspace('notified', 40, {
        attention: { kind: 'turn-complete', updatedAt: NOW - DAY } as Workspace['attention'],
      }),
      workspace('never-active', 0, { lastActivityAt: 0, createdAt: NOW - DAY }),
      workspace('quiet', 40),
    ];

    expect(names(groupWorkspacesForCleanup(chatty, new Map(), NOW))).toEqual([
      ['Not used in 30 days', ['quiet']],
    ]);
  });
});

describe('WorkspaceCleanupDialog', () => {
  const checkWorkspacesForCleanup = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    addToast.mockReset();
    store.workspaces = [
      ...WORKSPACES,
      workspace('trashed', 1, { status: 'trashed' }),
      workspace('provisioning', 1, { provisioning: true }),
      workspace('other-project', 1, { projectId: 'project-2' }),
    ];
    trashWorkspaces.mockReset().mockImplementation(async (ids: string[]) => {
      store.workspaces = store.workspaces.map((w) =>
        ids.includes(w.id) ? { ...w, status: 'trashed' as const } : w
      );
    });
    checkWorkspacesForCleanup.mockReset().mockResolvedValue(STATUSES);
    window.api = { checkWorkspacesForCleanup } as never;
    return () => vi.useRealTimers();
  });

  function renderDialog() {
    const onOpenChange = vi.fn();
    render(<WorkspaceCleanupDialog projectId="project-1" open onOpenChange={onOpenChange} />);
    return { onOpenChange };
  }

  it("ticks only landed workspaces that aren't pinned or busy, and trashes what is ticked", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    expect(await screen.findByRole('checkbox', { name: /^merged-recently/ })).toBeChecked();
    for (const id of ['merged-pinned', 'merged-busy', 'old-dirty', 'abandoned', 'offline']) {
      expect(screen.getByRole('checkbox', { name: new RegExp(`^${id}`) })).not.toBeChecked();
    }
    for (const id of ['wip', 'dirty', 'trashed', 'provisioning', 'other-project']) {
      expect(screen.queryByText(id)).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole('checkbox', { name: /^abandoned/ }));
    await user.click(screen.getByRole('button', { name: 'Move 2 workspaces to Trash' }));

    expect(checkWorkspacesForCleanup).toHaveBeenCalledWith('project-1');
    expect(trashWorkspaces).toHaveBeenCalledWith(['merged-recently', 'abandoned']);
    expect(addToast).toHaveBeenCalledWith('Moved 2 workspaces to the Trash', 'success');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Still listed while it closes, rather than flashing the empty state.
    expect(screen.getByRole('checkbox', { name: /^abandoned/ })).toBeInTheDocument();
  });

  it('says why a workspace was left unticked', async () => {
    renderDialog();

    const row = (id: string) => screen.getByRole('checkbox', { name: new RegExp(`^${id}`) });
    await screen.findByRole('checkbox', { name: /^merged-recently/ });
    expect(row('merged-pinned')).toHaveAccessibleName(/Pinned/);
    expect(row('merged-busy')).toHaveAccessibleName(/Agent working/);
    expect(row('old-dirty')).toHaveAccessibleName(/Uncommitted changes/);
    expect(row('abandoned')).toHaveAccessibleName(/Changes not in main/);
    expect(row('offline')).toHaveAccessibleName(/Couldn't check its branch/);
  });

  it('says which worktrees went unchecked, such as one whose files never got made', async () => {
    store.workspaces = [workspace('failed', 40, { provisionError: 'clone failed' })];
    checkWorkspacesForCleanup.mockResolvedValueOnce([]);
    renderDialog();

    expect(await screen.findByRole('checkbox', { name: /^failed/ })).toHaveAccessibleName(
      /Not checked/
    );
  });

  it('starts from no ticks each time it opens, until the new check is back', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WorkspaceCleanupDialog projectId="project-1" open onOpenChange={vi.fn()} />
    );
    await user.click(await screen.findByRole('checkbox', { name: /^abandoned/ }));
    expect(screen.getByRole('button', { name: 'Move 2 workspaces to Trash' })).toBeEnabled();

    rerender(<WorkspaceCleanupDialog projectId="project-1" open={false} onOpenChange={vi.fn()} />);
    let finishCheck: (statuses: WorkspaceCleanupStatus[]) => void = () => {};
    checkWorkspacesForCleanup.mockReturnValueOnce(
      new Promise((resolve) => (finishCheck = resolve))
    );
    rerender(<WorkspaceCleanupDialog projectId="project-1" open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeDisabled();
    expect(checkWorkspacesForCleanup).toHaveBeenCalledTimes(2);
    finishCheck(STATUSES);
    expect(await screen.findByRole('checkbox', { name: /^merged-recently/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^abandoned/ })).not.toBeChecked();
  });

  it('drops a workspace moved to the Trash elsewhere while it is open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WorkspaceCleanupDialog projectId="project-1" open onOpenChange={vi.fn()} />
    );
    await user.click(await screen.findByRole('checkbox', { name: /^abandoned/ }));

    store.workspaces = store.workspaces.map((w) =>
      w.id === 'abandoned' ? { ...w, status: 'trashed' as const } : w
    );
    rerender(<WorkspaceCleanupDialog projectId="project-1" open onOpenChange={vi.fn()} />);

    expect(screen.queryByText('abandoned')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move 1 workspace to Trash' })).toBeEnabled();
  });

  it("speaks only of time since use in a directory project's", async () => {
    store.workspaces = [workspace('old', 40, { isWorktree: false, branchName: undefined })];
    checkWorkspacesForCleanup.mockResolvedValueOnce([]);
    render(
      <WorkspaceCleanupDialog projectId="project-1" isDirectory open onOpenChange={vi.fn()} />
    );

    expect(await screen.findByRole('checkbox', { name: /^old/ })).not.toBeChecked();
    expect(screen.getByText(/^Workspaces not used in 30 days\./)).toBeInTheDocument();
    expect(screen.queryByText(/target branch|Not checked/)).not.toBeInTheDocument();
  });

  it('checks and unchecks a whole group from its header', async () => {
    const user = userEvent.setup();
    renderDialog();

    const landedGroup = await screen.findByRole('region', {
      name: 'Already in main',
    });
    await user.click(within(landedGroup).getByRole('checkbox', { name: /^Already in main/ }));
    expect(screen.getByRole('checkbox', { name: /^merged-busy/ })).toBeChecked();
    await user.click(within(landedGroup).getByRole('checkbox', { name: /^Already in main/ }));
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeDisabled();
  });

  it('stays open when some workspaces stay, unticking the ones that moved', async () => {
    const user = userEvent.setup();
    trashWorkspaces.mockImplementation(async () => {
      store.workspaces = store.workspaces.map((w) =>
        w.id === 'merged-recently' ? { ...w, status: 'trashed' as const } : w
      );
    });
    const { onOpenChange } = renderDialog();

    await user.click(await screen.findByRole('checkbox', { name: /^abandoned/ }));
    await user.click(screen.getByRole('button', { name: 'Move 2 workspaces to Trash' }));

    expect(addToast).toHaveBeenCalledWith('Moved 1 workspace to the Trash', 'success');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText('merged-recently')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^abandoned/ })).toBeChecked();
  });

  it('still lists the unused workspaces when their branches could not be checked', async () => {
    checkWorkspacesForCleanup.mockRejectedValueOnce(new Error('Project not found'));
    renderDialog();

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Not used in 30 days' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^abandoned/ })).not.toBeChecked();
    expect(screen.queryByText('merged-recently')).not.toBeInTheDocument();
    // The callout says so once, not on every row.
    expect(screen.queryByText(/Not checked/)).not.toBeInTheDocument();
  });

  it('says when there is nothing to clean up', async () => {
    store.workspaces = [];
    checkWorkspacesForCleanup.mockResolvedValueOnce([]);
    renderDialog();

    expect(await screen.findByText('No workspaces to clean up.')).toBeInTheDocument();
  });
});
