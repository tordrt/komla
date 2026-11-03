/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BannerHost } from '../../../../src/renderer/components/layout/BannerHost';
import { RunningAtLastQuitBanner } from '../../../../src/renderer/components/layout/RunningAtLastQuitBanner';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useWindowStore } from '../../../../src/renderer/stores/window.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../../src/shared/types/workspace';

const listWorkspacesRunningAtLastQuit = vi.fn<() => Promise<string[]>>();
const forgetWorkspacesRunningAtLastQuit = vi.fn().mockResolvedValue(undefined);
const restartWorkspace = vi.fn().mockResolvedValue({});

const workspace = (id: string, extra: Partial<Workspace> = {}): Workspace =>
  ({
    id,
    name: id,
    windowId: 'window-1',
    status: 'active',
    terminals: [],
    ...extra,
  }) as Workspace;

function setup({
  mode = 'ask',
  ids = ['one', 'two'],
  workspaces = [workspace('one', { customName: 'Fix login' }), workspace('two')],
}: {
  mode?: 'ask' | 'always' | 'never';
  ids?: string[];
  workspaces?: Workspace[];
} = {}) {
  listWorkspacesRunningAtLastQuit.mockResolvedValue(ids);
  window.api = {
    listWorkspacesRunningAtLastQuit,
    forgetWorkspacesRunningAtLastQuit,
  } as unknown as typeof window.api;
  useWindowStore.setState({ windowId: 'window-1' });
  useConfigStore.setState({
    config: { restoreRunningWorkspaces: mode } as never,
    isLoading: false,
  });
  useWorkspacesStore.setState({ workspaces, hasLoaded: true, restartWorkspace });
  render(
    <TooltipProvider>
      <BannerHost>
        <RunningAtLastQuitBanner />
      </BannerHost>
    </TooltipProvider>
  );
}

const banner = () => screen.queryByText(/were running when Komla quit|was running when Komla quit/);

describe('RunningAtLastQuitBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers to restart the workspaces that were running, by name', async () => {
    setup();
    expect(await screen.findByText('2 workspaces were running when Komla quit.')).toBeVisible();
    expect(screen.getByText('Fix login, two')).toBeVisible();
    expect(restartWorkspace).not.toHaveBeenCalled();
  });

  it('restarts them all, in order, and forgets them', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart all' }));

    await waitFor(() => expect(restartWorkspace).toHaveBeenCalledTimes(2));
    expect(restartWorkspace.mock.calls.map(([id]) => id)).toEqual(['one', 'two']);
    expect(forgetWorkspacesRunningAtLastQuit).toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it('stops restarting at the workspace limit', async () => {
    restartWorkspace.mockResolvedValueOnce({ __workspaceRestartError: true, message: 'limit' });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart all' }));

    await waitFor(() => expect(restartWorkspace).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(restartWorkspace).toHaveBeenCalledTimes(1);
  });

  it('forgets them when dismissed, without restarting', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Dismiss workspaces running at last quit'));

    expect(forgetWorkspacesRunningAtLastQuit).toHaveBeenCalled();
    expect(restartWorkspace).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it('restarts them without asking when set to always', async () => {
    setup({ mode: 'always' });
    await waitFor(() => expect(restartWorkspace).toHaveBeenCalledTimes(2));
    expect(banner()).toBeNull();
  });

  it('neither asks nor restarts when set to never', async () => {
    setup({ mode: 'never' });
    await waitFor(() => expect(forgetWorkspacesRunningAtLastQuit).toHaveBeenCalled());
    expect(restartWorkspace).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("leaves out another window's workspaces and ones already running", async () => {
    setup({
      ids: ['mine', 'other', 'started'],
      workspaces: [
        workspace('mine'),
        workspace('other', { windowId: 'window-2' }),
        workspace('started', {
          terminals: [{ id: 't', status: 'running' } as Workspace['terminals'][number]],
        }),
      ],
    });
    expect(await screen.findByText('1 workspace was running when Komla quit.')).toBeVisible();
    expect(screen.getByText('mine')).toBeVisible();
  });

  it('stays hidden when nothing was running', async () => {
    setup({ ids: [] });
    await waitFor(() => expect(listWorkspacesRunningAtLastQuit).toHaveBeenCalled());
    expect(banner()).toBeNull();
  });
});
