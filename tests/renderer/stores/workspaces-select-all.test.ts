import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: vi.fn(),
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));

describe('selectAllWorkspaces', () => {
  beforeEach(() => {
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
  });

  it('skips workspaces the sidebar is not showing, such as those in collapsed groups', () => {
    const visible = createWorkspace({ id: 'visible', windowId: 'window-1' });
    const collapsed = createWorkspace({ id: 'collapsed', windowId: 'window-1' });
    useWorkspacesStore.setState({
      workspaces: [visible, collapsed],
      selectionMode: true,
      // The sidebar publishes only the ids it renders; collapsed groups are excluded.
      displayOrderedWorkspaceIds: ['visible'],
    });

    useWorkspacesStore.getState().selectAllWorkspaces();

    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['visible']));
  });

  it('keeps the workspaces Hide stopped shows, such as one running on its SSH host elsewhere', () => {
    const elsewhere = createSshWorkspace({
      id: 'elsewhere',
      windowId: 'window-1',
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });
    const stopped = createWorkspace({
      id: 'stopped',
      windowId: 'window-1',
      terminals: [createTerminal({ status: 'stopped' })],
    });
    useWorkspacesStore.setState({
      workspaces: [elsewhere, stopped],
      selectionMode: true,
      hideStopped: true,
    });

    useWorkspacesStore.getState().selectAllWorkspaces();

    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['elsewhere']));
  });

  it('selects stopped workspaces on the open Stopped shelf while stopped ones are hidden', () => {
    const running = createWorkspace({
      id: 'running',
      windowId: 'window-1',
      terminals: [createTerminal({ status: 'running' })],
    });
    const shelved = createWorkspace({
      id: 'shelved',
      windowId: 'window-1',
      terminals: [createTerminal({ status: 'stopped' })],
    });
    useWorkspacesStore.setState({
      workspaces: [running, shelved],
      selectionMode: true,
      hideStopped: true,
      displayOrderedWorkspaceIds: ['running', 'shelved'],
    });

    useWorkspacesStore.getState().selectAllWorkspaces();

    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(
      new Set(['running', 'shelved'])
    );
  });

  it('falls back to every listed workspace before the sidebar has published its order', () => {
    const first = createWorkspace({ id: 'first', windowId: 'window-1' });
    const second = createWorkspace({ id: 'second', windowId: 'window-1' });
    useWorkspacesStore.setState({ workspaces: [first, second], selectionMode: true });

    useWorkspacesStore.getState().selectAllWorkspaces();

    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(
      new Set(['first', 'second'])
    );
  });
});
