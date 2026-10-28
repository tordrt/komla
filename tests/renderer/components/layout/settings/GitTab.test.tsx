/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitTab } from '../../../../../src/renderer/components/layout/settings/GitTab';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  updateConfig: vi.fn(),
  actions: [] as Array<{ id: string; title: string; projectIds?: string[] }>,
}));

vi.mock('../../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector?: (state: { actions: typeof mocks.actions }) => unknown) =>
    selector ? selector({ actions: mocks.actions }) : { actions: mocks.actions },
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (
    selector: (state: { config: Record<string, unknown>; updateConfig: () => void }) => unknown
  ) => selector({ config: mocks.config, updateConfig: mocks.updateConfig }),
}));

const MAIN = 'Commits ahead (↑N), default branch';
const OTHER = 'Commits ahead (↑N), other branches';

describe('GitTab', () => {
  beforeEach(() => {
    mocks.config = {};
    mocks.updateConfig.mockReset();
    mocks.actions = [];
  });

  it('asks on first click until an ↑N choice is made, then fills in the other one', async () => {
    const user = userEvent.setup();
    render(<GitTab />);

    expect(screen.getByRole('combobox', { name: MAIN })).toHaveValue('ask');
    expect(screen.getByRole('combobox', { name: OTHER })).toHaveValue('ask');

    await user.selectOptions(screen.getByRole('combobox', { name: OTHER }), 'disabled');

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      gitDefaults: {
        aheadMainAction: 'pr',
        aheadOtherAction: 'disabled',
        aheadMainActionId: undefined,
        aheadOtherActionId: undefined,
      },
    });
  });

  it('starts a quick command choice on the PR draft command every project can see', async () => {
    const user = userEvent.setup();
    mocks.actions = [
      { id: 'scoped', title: 'Create PR draft with gh', projectIds: ['p1'] },
      { id: 'global', title: 'Create PR draft with gh' },
    ];
    render(<GitTab />);

    await user.selectOptions(screen.getByRole('combobox', { name: MAIN }), 'agent-prompt');

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      gitDefaults: {
        aheadMainAction: 'agent-prompt',
        aheadOtherAction: 'merge',
        aheadMainActionId: 'global',
        aheadOtherActionId: undefined,
      },
    });
  });

  it("leaves the other ↑N choice's quick command alone", async () => {
    const user = userEvent.setup();
    // 'custom' isn't in the loaded quick commands, as before they load.
    mocks.config = {
      gitDefaults: {
        aheadMainAction: 'agent-prompt',
        aheadMainActionId: 'custom',
        aheadOtherAction: 'merge',
      },
    };
    mocks.actions = [{ id: 'global', title: 'Create PR draft with gh' }];
    render(<GitTab />);

    await user.selectOptions(screen.getByRole('combobox', { name: OTHER }), 'disabled');

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      gitDefaults: expect.objectContaining({
        aheadMainAction: 'agent-prompt',
        aheadMainActionId: 'custom',
        aheadOtherAction: 'disabled',
      }),
    });
  });

  it('clears both ↑N choices when one goes back to asking', async () => {
    const user = userEvent.setup();
    mocks.config = { gitDefaults: { aheadMainAction: 'merge', aheadOtherAction: 'merge' } };
    render(<GitTab />);

    await user.selectOptions(screen.getByRole('combobox', { name: MAIN }), 'ask');

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      gitDefaults: {
        aheadMainAction: undefined,
        aheadOtherAction: undefined,
        aheadMainActionId: undefined,
        aheadOtherActionId: undefined,
      },
    });
  });

  it('saves the branch prefix once the field loses focus', async () => {
    const user = userEvent.setup();
    mocks.config = { gitDefaults: { behindTargetAction: 'rebase' } };
    render(<GitTab />);

    await user.type(screen.getByRole('textbox', { name: 'Branch prefix' }), ' me/ ');
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    await user.tab();

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      gitDefaults: { behindTargetAction: 'rebase', branchPrefix: 'me/' },
    });
  });

  it('saves the branch prefix when Settings closes while the field has focus', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<GitTab />);

    await user.type(screen.getByRole('textbox', { name: 'Branch prefix' }), 'me/');
    unmount();

    expect(mocks.updateConfig).toHaveBeenCalledWith({ gitDefaults: { branchPrefix: 'me/' } });
  });

  it('turns off fetching in the background', async () => {
    const user = userEvent.setup();
    render(<GitTab />);

    const fetch = screen.getByRole('switch', { name: 'Fetch in the background' });
    expect(fetch).toBeChecked();
    await user.click(fetch);

    expect(mocks.updateConfig).toHaveBeenCalledWith({ gitBackgroundFetch: false });
  });

  it('turns off pushing after a fast-forward', async () => {
    const user = userEvent.setup();
    render(<GitTab />);

    const push = screen.getByRole('switch', { name: 'Push target branch after fast-forward' });
    expect(push).toBeChecked();
    await user.click(push);

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      gitDefaults: { autoPushAfterMerge: false },
    });
  });
});
