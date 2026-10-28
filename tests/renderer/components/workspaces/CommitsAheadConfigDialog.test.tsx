/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommitsAheadConfigDialog } from '../../../../src/renderer/components/workspaces/CommitsAheadConfigDialog';

import type { Action, GitDefaults } from '../../../../src/shared/types';

let actionsState: Action[] = [];
let gitDefaults: GitDefaults | undefined;
const addToast = vi.fn();
const updateConfig = vi.fn();

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector: (state: { actions: Action[] }) => Action[]) =>
    selector({ actions: actionsState }),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { gitDefaults }, updateConfig }),
}));

vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof addToast }) => typeof addToast) =>
    selector({ addToast }),
}));

const PR_DRAFT: Action = {
  id: 'pr-draft',
  title: 'Create PR draft with gh',
  type: 'prompt',
  content: 'Create a PR',
};

const REVIEW: Action = {
  id: 'review',
  title: 'Review changes',
  type: 'prompt',
  content: 'Review these changes',
};

function renderDialog(props: Partial<React.ComponentProps<typeof CommitsAheadConfigDialog>> = {}) {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn() };
  render(
    <CommitsAheadConfigDialog
      projectId="project-1"
      targetBranch="main"
      targetIsDefault
      hasOriginRemote
      pushAfterFastForward
      targetBranchOnOrigin
      canFastForward
      {...handlers}
      {...props}
    />
  );
  return handlers;
}

const defaultBranch = () => within(screen.getByRole('group', { name: /Default branch/ }));
const otherBranches = () => within(screen.getByRole('group', { name: /Other branches/ }));

describe('CommitsAheadConfigDialog', () => {
  beforeEach(() => {
    actionsState = [];
    gitDefaults = { branchPrefix: 'me/' };
    addToast.mockReset();
    updateConfig.mockReset().mockResolvedValue({ ok: true, error: null });
    global.window.api = {
      updateProject: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  it('starts on the PR draft quick command for the default branch, saves it for all projects when asked to and runs it', async () => {
    actionsState = [PR_DRAFT];
    const user = userEvent.setup();
    const { onClose, onSaved } = renderDialog();

    expect(defaultBranch().getByRole('radio', { name: /^Run a quick command/ })).toBeChecked();
    expect(
      defaultBranch().getByRole('button', { name: 'Create PR draft with gh' })
    ).toBeInTheDocument();
    expect(otherBranches().getByRole('radio', { name: /^Fast-forward/ })).toBeChecked();
    const allProjects = screen.getByRole('checkbox', { name: /Use for all projects/ });
    expect(allProjects).not.toBeChecked();
    await user.click(allProjects);
    await user.click(screen.getByRole('button', { name: 'Save & run' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('agent-prompt', 'pr-draft'));
    expect(updateConfig).toHaveBeenCalledWith({
      gitDefaults: {
        branchPrefix: 'me/',
        aheadMainAction: 'agent-prompt',
        aheadMainActionId: 'pr-draft',
        aheadOtherAction: 'merge',
        aheadOtherActionId: undefined,
      },
    });
    expect(window.api.updateProject).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('lists the choice this workspace uses first, under its branch name', () => {
    actionsState = [PR_DRAFT];
    renderDialog({ targetBranch: 'release', targetIsDefault: false });

    const [first, second] = screen.getAllByRole('group');
    expect(first).toHaveAccessibleName('Other branches (release)');
    expect(second).toHaveAccessibleName('Default branch (main or master)');
    expect(otherBranches().getByRole('radio', { name: /^Fast-forward release/ })).toBeChecked();
    expect(defaultBranch().getByRole('radio', { name: /^Run a quick command/ })).toBeChecked();
  });

  it("names origin's default branch when this workspace targets another", () => {
    renderDialog({
      targetBranch: 'release',
      targetIsDefault: false,
      remoteDefaultBranch: 'develop',
    });

    expect(screen.getByRole('group', { name: 'Default branch (develop)' })).toBeInTheDocument();
  });

  it('opens on the chosen option', async () => {
    renderDialog({ targetBranch: 'release', targetIsDefault: false });

    await waitFor(() =>
      expect(otherBranches().getByRole('radio', { name: /^Fast-forward release/ })).toHaveFocus()
    );
  });

  it('saves for this project only by default', async () => {
    actionsState = [PR_DRAFT];
    const user = userEvent.setup();
    const { onSaved } = renderDialog({ targetBranch: 'release', targetIsDefault: false });

    await user.click(screen.getByRole('button', { name: 'Save & fast-forward release' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('merge', undefined));
    expect(window.api.updateProject).toHaveBeenCalledWith('project-1', {
      aheadTargetAction: 'auto',
      autoMainBranchAction: 'agent-prompt',
      autoMainActionId: 'pr-draft',
      autoOtherBranchAction: 'merge',
      autoOtherActionId: undefined,
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("keeps a quick command that belongs to this project out of the other projects' setting", async () => {
    actionsState = [{ ...PR_DRAFT, projectIds: ['project-1'] }];
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByRole('checkbox', { name: /Use for all projects/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save & run' }));

    await waitFor(() => expect(window.api.updateProject).toHaveBeenCalled());
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('does not use actions scoped to a different project', async () => {
    actionsState = [{ ...PR_DRAFT, projectIds: ['project-2'] }];
    const user = userEvent.setup();
    renderDialog();

    await user.click(defaultBranch().getByRole('radio', { name: /^Run a quick command/ }));

    expect(defaultBranch().getByText(/No quick commands configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();
  });

  it('shows the quick command picker under its option and runs the picked command', async () => {
    actionsState = [PR_DRAFT, REVIEW];
    const user = userEvent.setup();
    const { onSaved } = renderDialog({ targetBranch: 'release', targetIsDefault: false });

    await user.click(otherBranches().getByRole('radio', { name: /^Run a quick command/ }));
    await user.click(otherBranches().getByRole('button', { name: /Select a quick command/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Review changes' }));

    await user.click(screen.getByRole('button', { name: 'Save & run' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('agent-prompt', 'review'));
  });

  it('says that fast-forwarding pushes, and only saves while the branch is behind', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderDialog({ canFastForward: false });

    await user.click(defaultBranch().getByRole('radio', { name: /^Fast-forward/ }));
    expect(defaultBranch().getByRole('radio', { name: /^Fast-forward/ })).toHaveAccessibleName(
      /then pushes it to origin/i
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(window.api.updateProject).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('offers no PR page without origin, and starts on fast-forwarding', () => {
    actionsState = [PR_DRAFT];
    renderDialog({ hasOriginRemote: false });

    expect(screen.queryByRole('radio', { name: /PR page/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/pushes/)).not.toBeInTheDocument();
    expect(defaultBranch().getByRole('radio', { name: /^Fast-forward/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save & fast-forward main' })).toBeInTheDocument();
  });

  it("keeps a repository without origin's choice in its own project", async () => {
    const user = userEvent.setup();
    renderDialog({ hasOriginRemote: false });

    expect(screen.getByRole('checkbox', { name: /Use for all projects/ })).toBeDisabled();
    expect(screen.getByText(/has no origin/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save & fast-forward main' }));

    await waitFor(() => expect(window.api.updateProject).toHaveBeenCalled());
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('fast-forwards instead of a PR page that origin went away from', async () => {
    const user = userEvent.setup();
    const handlers = { onClose: vi.fn(), onSaved: vi.fn() };
    const props = {
      projectId: 'project-1',
      targetBranch: 'main',
      targetIsDefault: true,
      pushAfterFastForward: true,
      targetBranchOnOrigin: true,
      canFastForward: true,
      ...handlers,
    };
    const { rerender } = render(<CommitsAheadConfigDialog {...props} hasOriginRemote />);
    await user.click(defaultBranch().getByRole('radio', { name: /^Open the PR page/ }));

    rerender(<CommitsAheadConfigDialog {...props} hasOriginRemote={false} />);

    expect(defaultBranch().getByRole('radio', { name: /^Fast-forward/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save & fast-forward main' }));
    await waitFor(() => expect(handlers.onSaved).toHaveBeenCalledWith('merge', undefined));
  });

  it("says fast-forwarding publishes this workspace's target when origin doesn't have it", () => {
    renderDialog({ targetBranchOnOrigin: false });

    expect(defaultBranch().getByRole('radio', { name: /^Fast-forward/ })).toHaveAccessibleName(
      /then publishes it to origin/i
    );
    expect(otherBranches().getByRole('radio', { name: /^Fast-forward/ })).toHaveAccessibleName(
      /then pushes it to origin/i
    );
  });

  it('saves picks that match a preset as that preset', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(defaultBranch().getByRole('radio', { name: /^Open the PR page/ }));
    await user.click(screen.getByRole('button', { name: 'Save & open PR' }));

    await waitFor(() =>
      expect(window.api.updateProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ aheadTargetAction: 'auto-default' })
      )
    );
  });

  it('uses the canonical action category names', async () => {
    actionsState = [
      { id: 'command', title: 'Run checks', type: 'command', content: 'npm test' },
      REVIEW,
    ];
    const user = userEvent.setup();
    renderDialog();

    await user.click(defaultBranch().getByRole('radio', { name: /^Run a quick command/ }));
    await user.click(defaultBranch().getByRole('button', { name: /Select a quick command/ }));

    expect(screen.getByText('Terminal Commands')).toBeInTheDocument();
    expect(screen.getByText('Saved Prompts')).toBeInTheDocument();
  });
});
