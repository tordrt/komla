/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceList } from '../../../../src/renderer/components/workspaces/WorkspaceList';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createTerminal, createWorktreeWorkspace } from '../../../factories';

import type { AppConfig, Project, Workspace } from '../../../../src/renderer/types';

const renders = vi.hoisted(() => ({ list: 0, cards: new Map<string, number>() }));

vi.mock('../../../../src/renderer/stores/window.store', () => {
  const state = { windowId: 'window-1' };
  return {
    useWindowStore: Object.assign(<T,>(selector: (s: typeof state) => T) => selector(state), {
      getState: () => state,
    }),
  };
});

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// The list renders it once each time it renders.
vi.mock('../../../../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => {
    renders.list++;
    return <div>{children}</div>;
  },
}));

vi.mock('../../../../src/renderer/components/workspaces/ProjectGroupContextMenu', () => ({
  ProjectGroupContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Memoized like the real card, which shows its workspace's title.
vi.mock('../../../../src/renderer/components/workspaces/WorkspaceCard', async () => {
  const { memo } = await import('react');
  return {
    WorkspaceCard: memo(function WorkspaceCard({ workspace }: { workspace: Workspace }) {
      renders.cards.set(workspace.id, (renders.cards.get(workspace.id) ?? 0) + 1);
      return (
        <div data-testid={`card-${workspace.id}`}>
          {workspace.terminals[0]?.dynamicTitle ?? workspace.name}
        </div>
      );
    }),
  };
});

describe('WorkspaceList and terminal titles', () => {
  beforeEach(() => {
    renders.list = 0;
    renders.cards.clear();
    useConfigStore.setState({ config: {} as AppConfig });
    useProjectsStore.setState({
      projects: [{ id: 'project-1', name: 'Komla', color: '#3b82f6', order: 0 } as Project],
    });
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
    useWorkspacesStore.setState({
      workspaces: ['ws-1', 'ws-2'].map((id, order) =>
        createWorktreeWorkspace({
          id,
          name: id,
          windowId: 'window-1',
          order,
          terminals: [createTerminal({ id: `${id}-agent`, dynamicTitle: '⠋ Working' })],
        })
      ),
      hasLoaded: true,
    });
  });

  // An agent changes its terminal's title with every frame of its spinner, and the list sorts
  // every workspace into its groups and shelves each time it renders.
  it('re-renders only the card whose title changed', () => {
    render(<WorkspaceList />);
    const listRenders = renders.list;
    const otherCardRenders = renders.cards.get('ws-1');

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('ws-2-agent', '⠙ Working'));

    expect(screen.getByTestId('card-ws-2')).toHaveTextContent('⠙ Working');
    expect(renders.list).toBe(listRenders);
    expect(renders.cards.get('ws-1')).toBe(otherCardRenders);
  });

  // The dialog names what it deletes for good, so it can't name a workspace by an old title.
  it('names a trashed workspace by its title as it is now when emptying the Trash', () => {
    act(() => useWorkspacesStore.getState().updateWorkspace('ws-2', { status: 'trashed' }));
    render(<WorkspaceList />);
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('⠋ Working');

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('ws-2-agent', 'Fix login'));

    expect(screen.getByRole('dialog')).toHaveTextContent('Fix login');
  });

  it('still lists a workspace again when something other than a title changes', () => {
    render(<WorkspaceList />);
    const listRenders = renders.list;

    act(() => useWorkspacesStore.getState().updateWorkspace('ws-2', { name: 'renamed' }));

    expect(renders.list).toBeGreaterThan(listRenders);
  });
});
