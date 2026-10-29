/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkedWorkspacesSection } from '../../../../src/renderer/components/terminal/LinkedWorkspacesSection';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { AT_PATH_MIME, isTreeDragActive } from '../../../../src/renderer/lib/tree-drag-token';
import { useFileListStore } from '../../../../src/renderer/stores/file-list.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { Project, Workspace } from '../../../../src/renderer/types';

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: 'ws',
    name: 'ws',
    workingDirectory: '/work/ws',
    status: 'active',
    backend: { kind: 'local' },
    isWorktree: true,
    terminals: [],
    ...overrides,
  } as Workspace;
}

const origin = workspace({
  id: 'web',
  name: 'Login fix',
  workingDirectory: '/work/web',
  linkedWorkspaceIds: ['api', 'types'],
});
const api = workspace({
  id: 'api',
  name: 'API auth tokens',
  workingDirectory: '/work/api',
  projectId: 'project-api',
  branchName: 'auth-tokens',
});
const types = workspace({
  id: 'types',
  name: 'Shared types',
  workingDirectory: '/work/types',
  repoName: 'komla-shared',
  branchName: 'main',
});

// Cached, as the store keeps each diff: a selector that got a new object each time would loop.
const diffs: Record<string, unknown> = {
  '/work/api': {
    data: { files: [{}, {}, {}], summary: { additions: 64, deletions: 20, filesChanged: 3 } },
    isLoading: false,
  },
  '/work/types': {
    data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
    isLoading: false,
  },
};

const selectWorkspace = vi.fn(async () => {});
const unlinkWorkspace = vi.fn(async () => {});
const copyToClipboard = vi.fn();
const fetchFileStatusesIfNeeded = vi.fn(async () => {});

function renderSection(showChanges = false, from = origin) {
  return render(
    <TooltipProvider>
      <LinkedWorkspacesSection workspace={from} showChanges={showChanges} />
    </TooltipProvider>
  );
}

describe('LinkedWorkspacesSection', () => {
  beforeEach(() => {
    selectWorkspace.mockClear();
    unlinkWorkspace.mockClear();
    copyToClipboard.mockClear();
    (globalThis as unknown as { window: Window & { api: unknown } }).window.api = {
      getWorkspaceLinkPaths: vi.fn(async () => [
        { workspaceId: 'api', path: 'linked-workspaces/komla-api-auth-tokens' },
        { workspaceId: 'types', path: 'linked-workspaces/komla-shared-main' },
      ]),
      copyToClipboard,
      showItemInFolder: vi.fn(),
    };
    useWorkspacesStore.setState({
      workspaces: [origin, api, types],
      selectWorkspace,
      unlinkWorkspace,
    });
    useProjectsStore.setState({
      projects: [{ id: 'project-api', name: 'komla-api' } as Project],
    });
    useFileListStore.setState({
      fetchFileStatusesIfNeeded,
      getDiff: (dirPath: string) => diffs[dirPath],
    } as unknown as Partial<ReturnType<typeof useFileListStore.getState>>);
  });

  it('shows nothing while the workspace has no links', () => {
    const { container } = renderSection(false, workspace({ id: 'alone' }));

    expect(container).toBeEmptyDOMElement();
  });

  it('lists each linked workspace by its title, project and branch, and opens it', async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.getByRole('region', { name: 'Linked workspaces' })).toBeInTheDocument();
    expect(screen.getByText('komla-api · auth-tokens')).toBeInTheDocument();
    expect(screen.getByText('komla-shared · main')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /API auth tokens/ }));

    expect(selectWorkspace).toHaveBeenCalledWith('api');
  });

  it("shows the linked workspace's card details and its path on hover", async () => {
    const user = userEvent.setup();
    renderSection();
    const row = screen.getByRole('button', { name: /API auth tokens/ });
    await waitFor(() => expect(row).toHaveAttribute('draggable', 'true'));

    await user.hover(row);

    const details = await screen.findByRole('tooltip');
    expect(details).toHaveTextContent('API auth tokens');
    expect(details).toHaveTextContent('linked-workspaces/komla-api-auth-tokens/');
  });

  it('hides the rows while collapsed', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /Linked workspaces/ }));

    expect(screen.queryByText('API auth tokens')).not.toBeInTheDocument();
  });

  it('drags a linked workspace into a terminal as its path, as the tree drags a folder', async () => {
    renderSection();
    const row = screen.getByRole('button', { name: /API auth tokens/ });
    await waitFor(() => expect(row).toHaveAttribute('draggable', 'true'));
    const setData = vi.fn();

    fireEvent.dragStart(row, { dataTransfer: { setData } });

    expect(setData).toHaveBeenCalledWith(
      AT_PATH_MIME,
      '@linked-workspaces/komla-api-auth-tokens/ '
    );
    expect(isTreeDragActive()).toBe(true);
    fireEvent.dragEnd(row);
    expect(isTreeDragActive()).toBe(false);
  });

  it("shows what changed in each in the changes view, apart from this workspace's changes", () => {
    renderSection(true);

    expect(screen.getByText(/3 changed/)).toBeInTheDocument();
    expect(screen.getByText('+64')).toBeInTheDocument();
    expect(screen.getByText('−20')).toBeInTheDocument();
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(fetchFileStatusesIfNeeded).toHaveBeenCalledWith('/work/api');
  });

  it('shows no changes for a linked folder that is no git repository', () => {
    const folder = workspace({
      id: 'notes',
      name: 'Notes',
      workingDirectory: '/work/types',
      isWorktree: false,
    });
    useWorkspacesStore.setState({ workspaces: [origin, folder] });

    renderSection(true, { ...origin, linkedWorkspaceIds: ['notes'] });

    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
  });

  it('shows no count while a diff loads for the first time', () => {
    diffs['/work/loading'] = {
      data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
      isLoading: true,
    };
    const loading = workspace({
      id: 'loading',
      name: 'Loading',
      workingDirectory: '/work/loading',
    });
    useWorkspacesStore.setState({ workspaces: [origin, loading] });

    renderSection(true, { ...origin, linkedWorkspaceIds: ['loading'] });

    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No changes')).not.toBeInTheDocument();
  });

  it('looks up the paths again after a failure, as when an SSH host was out of reach', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = (window as unknown as { api: { getWorkspaceLinkPaths: ReturnType<typeof vi.fn> } })
      .api;
    api.getWorkspaceLinkPaths.mockRejectedValueOnce(new Error('unreachable'));
    try {
      renderSection();
      const row = screen.getByRole('button', { name: /API auth tokens/ });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await waitFor(() => expect(row).toHaveAttribute('draggable', 'true'));
      expect(api.getWorkspaceLinkPaths).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies the path and unlinks from the menu', async () => {
    renderSection();
    const row = screen.getByRole('button', { name: /API auth tokens/ });
    await waitFor(() => expect(row).toHaveAttribute('draggable', 'true'));

    fireEvent.contextMenu(row);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy @path' }));
    });
    expect(copyToClipboard).toHaveBeenCalledWith('@linked-workspaces/komla-api-auth-tokens/ ');

    fireEvent.contextMenu(row);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Unlink' }));
    });
    expect(unlinkWorkspace).toHaveBeenCalledWith('web', 'api');
  });
});
