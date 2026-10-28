import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspace, createTerminal } from '../../factories';
import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

async function load() {
  const { powerSaveBlocker } = await import('electron');
  const service = await import('../../../src/main/services/keep-awake.service');
  const events = await import('../../../src/main/services/remote-workspace-events');
  return { powerSaveBlocker, ...service, ...events };
}

describe('KeepAwakeService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets the computer sleep by default', async () => {
    const { powerSaveBlocker, keepAwakeService } = await load();

    keepAwakeService.setMode(undefined);
    keepAwakeService.setAgentsWorking(true);

    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it('keeps awake always, without keeping the display on', async () => {
    const { powerSaveBlocker, keepAwakeService } = await load();

    keepAwakeService.setMode('always');

    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(keepAwakeService.isActive()).toBe(true);
  });

  it('keeps awake only while agents work in agents mode', async () => {
    const { powerSaveBlocker, keepAwakeService } = await load();

    keepAwakeService.setMode('agents');
    expect(keepAwakeService.isActive()).toBe(false);

    keepAwakeService.setAgentsWorking(true);
    expect(keepAwakeService.isActive()).toBe(true);

    keepAwakeService.setAgentsWorking(false);
    expect(keepAwakeService.isActive()).toBe(false);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('holds one blocker across repeated updates and releases it when turned off', async () => {
    const { powerSaveBlocker, keepAwakeService } = await load();

    keepAwakeService.setMode('always');
    keepAwakeService.setMode('always');
    keepAwakeService.setAgentsWorking(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

    keepAwakeService.setMode('off');
    expect(keepAwakeService.isActive()).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('releases the blocker on stop', async () => {
    const { keepAwakeService } = await load();

    keepAwakeService.setMode('always');
    keepAwakeService.stop();

    expect(keepAwakeService.isActive()).toBe(false);
  });

  it('follows whether any active workspace has an agent working', async () => {
    vi.useFakeTimers();
    const { keepAwakeService, keepAwakeWhileAgentsWork, publishRemoteWorkspaceChange } =
      await load();
    const working = createWorkspace({
      agentActive: true,
      terminals: [createTerminal({ status: 'running' })],
    });
    let workspaces = [createWorkspace({ status: 'trashed', agentActive: true }), working];
    keepAwakeService.setMode('agents');
    const unsubscribe = keepAwakeWhileAgentsWork(() => workspaces);

    publishRemoteWorkspaceChange();
    publishRemoteWorkspaceChange();
    expect(keepAwakeService.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(keepAwakeService.isActive()).toBe(true);

    workspaces = [{ ...working, agentActive: false }];
    publishRemoteWorkspaceChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(keepAwakeService.isActive()).toBe(false);

    unsubscribe();
  });

  it('leaves out agents working in tmux on an SSH host', async () => {
    vi.useFakeTimers();
    const { keepAwakeService, keepAwakeWhileAgentsWork, publishRemoteWorkspaceChange } =
      await load();
    const onHost = createWorkspace({
      agentActive: true,
      backend: {
        kind: 'ssh',
        hostId: 'devbox',
        remoteDirectory: '/r',
        remoteRepoPath: '/r',
        remoteProjectRoot: '/r',
        gitUrl: '',
      },
      terminals: [createTerminal({ status: 'running', agentActive: true })],
    });
    let workspaces = [onHost];
    keepAwakeService.setMode('agents');
    const unsubscribe = keepAwakeWhileAgentsWork(() => workspaces);

    publishRemoteWorkspaceChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(keepAwakeService.isActive()).toBe(false);

    // A Local copy's agent runs on this computer.
    workspaces = [
      {
        ...onHost,
        terminals: [
          createTerminal({
            status: 'running',
            agentActive: true,
            executionLocation: 'local-mirror',
          }),
        ],
      },
    ];
    publishRemoteWorkspaceChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(keepAwakeService.isActive()).toBe(true);

    unsubscribe();
  });
});
