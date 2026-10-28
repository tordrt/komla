/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const disposeTerminalRenderer = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderer,
}));

import { createDeferred } from '../../setup';
import { createTerminal, createWorkspace } from '../../factories';
import {
  _resetPendingTerminalExits,
  closeTerminalPane,
  disposeRenderersOfRemovedTerminals,
  handleTerminalExit,
  reconcileRemovedTerminalPanes,
  retryPendingTerminalExits,
} from '../../../src/renderer/lib/close-terminal-pane';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useTerminalCloseStore } from '../../../src/renderer/stores/terminal-close.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

describe('handleTerminalExit', () => {
  beforeEach(() => {
    disposeTerminalRenderer.mockClear();
    _resetPendingTerminalExits();
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
    useToastStore.setState(useToastStore.getInitialState(), true);
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
  });

  it('closes a terminal after a clean exit', () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const terminal = createTerminal({ id: 'term-1' });
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', terminals: [terminal] })],
    });

    handleTerminalExit('term-1', 0, undefined, close);

    expect(close).toHaveBeenCalledWith('term-1');
  });

  it('retains a terminal after a failed exit', () => {
    const close = vi.fn().mockResolvedValue(undefined);

    handleTerminalExit('term-1', 255, undefined, close);

    expect(close).not.toHaveBeenCalled();
  });

  it('retains an SSH workspace terminal after a clean exit', () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const terminal = createTerminal({ id: 'term-1' });
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-1',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-devbox',
            remoteDirectory: '/remote/worktree',
            remoteRepoPath: '/remote/repo.git',
            remoteProjectRoot: '/remote',
            gitUrl: 'git@github.com:example/repo.git',
          },
          terminals: [terminal],
        }),
      ],
    });

    handleTerminalExit('term-1', 0, undefined, close);

    expect(close).not.toHaveBeenCalled();
  });

  it('closes a local mirror terminal in an SSH workspace after a clean exit', () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const terminal = createTerminal({ id: 'term-1', executionLocation: 'local-mirror' });
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ws-1',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-devbox',
            remoteDirectory: '/remote/worktree',
            remoteRepoPath: '/remote/repo.git',
            remoteProjectRoot: '/remote',
            gitUrl: 'git@github.com:example/repo.git',
          },
          terminals: [terminal],
        }),
      ],
    });

    handleTerminalExit('term-1', 0, undefined, close);

    expect(close).toHaveBeenCalledWith('term-1');
  });

  it('retains a terminal after a signal exit', () => {
    const close = vi.fn().mockResolvedValue(undefined);

    handleTerminalExit('term-1', 0, 9, close);

    expect(close).not.toHaveBeenCalled();
  });

  it('retries a clean exit after a newly added terminal is loaded', () => {
    const close = vi.fn().mockResolvedValue(undefined);

    handleTerminalExit('term-1', 0, undefined, close);
    expect(close).not.toHaveBeenCalled();

    const terminal = createTerminal({ id: 'term-1' });
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', terminals: [terminal] })],
    });
    retryPendingTerminalExits(close);

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith('term-1');
  });

  it('uses the close-pane cleanup and stops a workspace after its final terminal exits', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const removeTerminal = vi.fn().mockResolvedValue(undefined);
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    const getWorkspaces = vi.fn().mockResolvedValue([]);
    const getWorkspaceQuota = vi
      .fn()
      .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false });
    Object.assign(window, {
      api: { removeTerminal, stopWorkspace, getWorkspaces, getWorkspaceQuota },
    });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    await closeTerminalPane(terminal.id);

    expect(removeTerminal).toHaveBeenCalledWith(workspace.id, terminal.id);
    expect(stopWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([]);
  });

  it('keeps a workspace running whose browser pane outlives its final terminal', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const removeTerminal = vi.fn().mockResolvedValue(undefined);
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    const getWorkspaces = vi.fn().mockResolvedValue([{ ...workspace, terminals: [] }]);
    const getWorkspaceQuota = vi
      .fn()
      .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false });
    Object.assign(window, {
      api: { removeTerminal, stopWorkspace, getWorkspaces, getWorkspaceQuota },
    });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);
    useLayoutStore.getState().splitPane('vertical', 'surface:browser:b');

    await closeTerminalPane(terminal.id);

    expect(stopWorkspace).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual(['surface:browser:b']);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(workspace.id);
  });

  it('serializes simultaneous exits and stops after the final removal', async () => {
    const terminal1 = createTerminal({ id: 'term-1' });
    const terminal2 = createTerminal({ id: 'term-2' });
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [terminal1, terminal2],
    });
    let remainingTerminals = [terminal1, terminal2];
    const removeTerminal = vi.fn(async (_workspaceId: string, terminalId: string) => {
      remainingTerminals = remainingTerminals.filter((terminal) => terminal.id !== terminalId);
    });
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    const getWorkspaces = vi.fn(async () => [{ ...workspace, terminals: remainingTerminals }]);
    const getWorkspaceQuota = vi
      .fn()
      .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false });
    Object.assign(window, {
      api: { removeTerminal, stopWorkspace, getWorkspaces, getWorkspaceQuota },
    });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal1.id);
    useLayoutStore.getState().addTab(workspace.id, terminal2.id);

    await Promise.all([closeTerminalPane(terminal1.id), closeTerminalPane(terminal2.id)]);

    expect(removeTerminal).toHaveBeenNthCalledWith(1, workspace.id, terminal1.id);
    expect(removeTerminal).toHaveBeenNthCalledWith(2, workspace.id, terminal2.id);
    expect(stopWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it('preserves the pane when terminal removal fails', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({
      id: 'ws-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
        gitUrl: 'git@github.com:example/repo.git',
      },
      terminals: [terminal],
    });
    const removeTerminal = vi.fn().mockRejectedValue(new Error('remove failed'));
    Object.assign(window, {
      api: { removeTerminal },
    });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    await expect(closeTerminalPane(terminal.id)).rejects.toThrow('remove failed');

    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([terminal.id]);
    expect(useLayoutStore.getState().getCurrentLayout()?.type).toBe('leaf');
    expect(useWorkspacesStore.getState().workspaces[0].terminals).toEqual([terminal]);
    expect(useTerminalCloseStore.getState().closingTerminalIds.has(terminal.id)).toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      "Couldn't close the remote terminal. The pane was left open."
    );
  });

  it('says a local terminal could not close', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    Object.assign(window, {
      api: { removeTerminal: vi.fn().mockRejectedValue(new Error('remove failed')) },
    });
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    await expect(closeTerminalPane(terminal.id)).rejects.toThrow('remove failed');

    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      "Couldn't close the terminal. The pane was left open."
    );
  });

  it('preserves layout changes made while a failed terminal removal is pending', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const addedTerminal = createTerminal({ id: 'term-2' });
    const workspace = createWorkspace({
      id: 'ws-1',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/remote/worktree',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
        gitUrl: 'git@github.com:example/repo.git',
      },
      terminals: [terminal, addedTerminal],
    });
    const removal = createDeferred<void>();
    const removeTerminal = vi.fn(() => removal.promise);
    Object.assign(window, { api: { removeTerminal } });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    const close = closeTerminalPane(terminal.id);
    useLayoutStore.getState().addTab(workspace.id, addedTerminal.id);
    removal.reject(new Error('remove failed'));

    await expect(close).rejects.toThrow('remove failed');

    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([addedTerminal.id, terminal.id]);
    expect(useLayoutStore.getState().getCurrentLayout()).toMatchObject({
      type: 'leaf',
      terminalId: terminal.id,
    });
  });

  it('hides a closing terminal immediately but retains its renderer until cleanup succeeds', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const removal = createDeferred<void>();
    const removeTerminal = vi.fn(() => removal.promise);
    const getWorkspaces = vi.fn().mockResolvedValue([{ ...workspace, terminals: [] }]);
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    const getWorkspaceQuota = vi
      .fn()
      .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false });
    Object.assign(window, {
      api: { removeTerminal, getWorkspaces, stopWorkspace, getWorkspaceQuota },
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    const close = closeTerminalPane(terminal.id);

    expect(useTerminalCloseStore.getState().closingTerminalIds.has(terminal.id)).toBe(true);
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([]);
    expect(disposeTerminalRenderer).not.toHaveBeenCalled();

    removal.resolve();
    await close;

    expect(useTerminalCloseStore.getState().closingTerminalIds.has(terminal.id)).toBe(false);
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([]);
    expect(disposeTerminalRenderer).toHaveBeenCalledWith(terminal.id);
  });

  it('reconciles layouts when another window removes a terminal', () => {
    const terminal1 = createTerminal({ id: 'term-1' });
    const terminal2 = createTerminal({ id: 'term-2' });
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [terminal1, terminal2],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal1.id);
    useLayoutStore.getState().addTab(workspace.id, terminal2.id);

    reconcileRemovedTerminalPanes({ ...workspace, terminals: [terminal2] });

    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([terminal2.id]);
  });

  it('leaves a workspace when another window removes its final terminal', () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    reconcileRemovedTerminalPanes({ ...workspace, terminals: [] });

    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([]);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
  });

  it('keeps a workspace whose note pane outlives the final terminal another window removed', () => {
    const terminal = createTerminal({ id: 'term-1' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);
    useLayoutStore.getState().addTab(workspace.id, 'surface:note:n');

    reconcileRemovedTerminalPanes({ ...workspace, terminals: [] });

    expect(useLayoutStore.getState().currentWorkspaceId).toBe(workspace.id);
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual(['surface:note:n']);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(workspace.id);
  });

  it('preserves a selected provisioning workspace before it has terminals', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      status: 'provisioning',
      terminals: [],
    });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
    });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id);

    reconcileRemovedTerminalPanes(workspace);

    expect(useLayoutStore.getState().currentWorkspaceId).toBe(workspace.id);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(workspace.id);
  });
});

describe('disposeRenderersOfRemovedTerminals', () => {
  beforeEach(() => {
    disposeTerminalRenderer.mockClear();
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
  });

  it('frees the renderer and pane of a terminal replaced by a restart elsewhere', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, 'term-1');
    useLayoutStore.getState().addTab(workspace.id, 'term-2');
    const unsubscribe = disposeRenderersOfRemovedTerminals();

    useWorkspacesStore.setState({
      workspaces: [
        {
          ...workspace,
          terminals: [createTerminal({ id: 'term-2' }), createTerminal({ id: 'term-3' })],
        },
      ],
    });

    expect(disposeTerminalRenderer.mock.calls).toEqual([['term-1']]);
    expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['term-2']);
    unsubscribe();
  });

  it('frees every terminal and the layout of a workspace removed elsewhere', () => {
    const removed = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 'term-1' })] });
    const kept = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 'term-2' })] });
    useWorkspacesStore.setState({ workspaces: [removed, kept] });
    useLayoutStore.getState().initializeWorkspaceLayout(removed.id, 'term-1');
    useLayoutStore.getState().initializeWorkspaceLayout(kept.id, 'term-2');
    const unsubscribe = disposeRenderersOfRemovedTerminals();

    useWorkspacesStore.setState({ workspaces: [kept] });

    expect(disposeTerminalRenderer.mock.calls).toEqual([['term-1']]);
    expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toBeUndefined();
    expect(useLayoutStore.getState().tabsByWorkspace['ws-2']).toEqual(['term-2']);
    unsubscribe();
  });

  it('keeps the renderer of a terminal that only stopped', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1' })],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const unsubscribe = disposeRenderersOfRemovedTerminals();

    useWorkspacesStore.setState({
      workspaces: [
        { ...workspace, terminals: [createTerminal({ id: 'term-1', status: 'stopped' })] },
      ],
    });

    expect(disposeTerminalRenderer).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops watching once unsubscribed', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1' })],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    disposeRenderersOfRemovedTerminals()();

    useWorkspacesStore.setState({ workspaces: [] });

    expect(disposeTerminalRenderer).not.toHaveBeenCalled();
  });
});
