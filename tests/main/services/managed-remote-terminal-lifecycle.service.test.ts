import { describe, expect, it, vi } from 'vitest';

import {
  ManagedRemoteTerminalLifecycleService,
  type ManagedRemoteTerminalLifecycleAdapters,
} from '../../../src/main/services/managed-remote-terminal-lifecycle.service';

import type { Terminal } from '../../../src/shared/types/terminal';
import type { SshWorkspaceBackend } from '../../../src/shared/types/workspace';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => '/komla' }));
vi.mock('../../../src/main/services/pty.service', () => ({ ptyService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({ sshWorkspaceService: {} }));

const backend: SshWorkspaceBackend = {
  kind: 'ssh',
  hostId: 'ssh-dev',
  remoteDirectory: '/home/dev/worktree',
  remoteRepoPath: '/home/dev/repo.git',
  remoteProjectRoot: '/home/dev',
  gitUrl: 'git@example.com:repo.git',
};

function createHarness() {
  const terminal: Terminal = {
    id: 'term-1',
    name: 'Agent',
    status: 'stopped',
    createdAt: 1,
  };
  let finishPreparation: (() => void) | undefined;
  const adapters: ManagedRemoteTerminalLifecycleAdapters = {
    workspace: {
      findTerminal: vi.fn(() => ({ workspaceId: 'ws-1', backend, terminal })),
      findWorkspace: vi.fn(() => ({ workspaceId: 'ws-1', backend, terminals: [terminal] })),
      changed: vi.fn(),
      prepareObservationBestEffort: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishPreparation = resolve;
          })
      ),
      prepareObservationInBackground: vi.fn(),
      reconcileObservation: vi.fn(),
    },
    session: {
      hasHost: vi.fn(() => true),
      supportsPersistence: vi.fn(() => Promise.resolve(true)),
      observe: vi.fn(() => Promise.resolve(new Set<string>())),
      stopAndConfirmAbsent: vi.fn(() => Promise.resolve()),
      buildAttachment: vi.fn(() => ({
        cwd: '/komla',
        command: 'ssh remote command',
        startupMode: 'wait-for-marker',
      })),
    },
    attachment: {
      spawn: vi.fn(),
      replace: vi.fn(),
      stop: vi.fn(),
      release: vi.fn(() => Promise.resolve()),
    },
  };
  return {
    terminal,
    adapters,
    finishPreparation: () => finishPreparation?.(),
    lifecycle: new ManagedRemoteTerminalLifecycleService(adapters),
  };
}

describe('ManagedRemoteTerminalLifecycleService', () => {
  it('drops what a sync saw on the host once this device tracks the session itself', () => {
    const harness = createHarness();
    harness.terminal.remoteSessionOnHost = true;

    harness.lifecycle.attachmentStatusChanged('term-1', 'running');

    expect(harness.terminal.remoteSessionOnHost).toBeUndefined();
  });

  it('stops a session a sync found on the host without attaching to it here', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionResumable = true;
    harness.terminal.remoteSessionOnHost = true;

    await harness.lifecycle.stop({ workspaceId: 'ws-1' });

    expect(harness.adapters.session.stopAndConfirmAbsent).toHaveBeenCalledWith(backend, ['term-1']);
    expect(harness.adapters.attachment.spawn).not.toHaveBeenCalled();
    expect(harness.adapters.attachment.replace).not.toHaveBeenCalled();
    expect(harness.terminal).toMatchObject({ status: 'stopped', remoteSessionActive: false });
    expect(harness.terminal.remoteSessionOnHost).toBeUndefined();
  });

  it.each([
    ['found on the host', undefined],
    ['restarted elsewhere after it ended here', false],
  ])(
    'keeps a session %s running elsewhere when the stop cannot confirm it ended',
    async (_name, remoteSessionActive) => {
      const harness = createHarness();
      harness.terminal.remoteSessionResumable = true;
      harness.terminal.remoteSessionActive = remoteSessionActive;
      harness.terminal.remoteSessionOnHost = true;
      harness.adapters.session.stopAndConfirmAbsent = vi.fn(() =>
        Promise.reject(new Error('host unreachable'))
      );

      await expect(harness.lifecycle.stop({ workspaceId: 'ws-1' })).rejects.toThrow(
        'host unreachable'
      );

      expect(harness.terminal).toMatchObject({
        status: 'stopped',
        remoteSessionActive,
        remoteSessionOnHost: true,
      });
    }
  );

  it('stops a session a sync found on the host even though a launch here failed', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionResumable = true;
    harness.terminal.remoteSessionOnHost = true;
    harness.terminal.startupError = 'ssh: connect to host dev port 22: Connection refused';

    await harness.lifecycle.stop({ workspaceId: 'ws-1' });

    expect(harness.adapters.session.stopAndConfirmAbsent).toHaveBeenCalledWith(backend, ['term-1']);
  });

  it('skips the host after a failed launch when no sync found its session there', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionResumable = true;
    harness.terminal.startupError = 'ssh: connect to host dev port 22: Connection refused';

    await harness.lifecycle.stop({ workspaceId: 'ws-1' });

    expect(harness.adapters.session.stopAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('starts observation in the background and settles readiness after attachment launch', async () => {
    const harness = createHarness();

    const ticket = harness.lifecycle.create({
      workspaceId: 'ws-1',
      terminalId: 'term-1',
      command: 'claude',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
    });

    expect(ticket.initialState).toMatchObject({
      attachment: { kind: 'starting' },
      remoteSession: { kind: 'unknown' },
    });
    expect(harness.terminal.status).toBe('starting');

    await expect(ticket.ready).resolves.toMatchObject({ kind: 'ready' });
    expect(harness.adapters.workspace.prepareObservationInBackground).toHaveBeenCalledWith('ws-1');
    expect(harness.adapters.workspace.prepareObservationBestEffort).not.toHaveBeenCalled();
    expect(harness.adapters.attachment.spawn).toHaveBeenCalledWith({
      terminalId: 'term-1',
      workspaceId: 'ws-1',
      cwd: '/komla',
      command: 'ssh remote command',
      startupMode: 'wait-for-marker',
    });
    expect(harness.terminal.remoteSessionResumable).toBe(true);
  });

  it('launches a new attachment without waiting for host persistence detection', async () => {
    const harness = createHarness();
    harness.adapters.session.supportsPersistence = vi.fn(() => new Promise(() => {}));

    const ticket = harness.lifecycle.create({
      workspaceId: 'ws-1',
      terminalId: 'term-1',
      command: 'claude',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
    });

    expect(harness.adapters.session.supportsPersistence).toHaveBeenCalledWith(backend);
    await expect(ticket.ready).resolves.toMatchObject({ kind: 'ready' });
    expect(harness.adapters.attachment.spawn).toHaveBeenCalledOnce();
    expect(harness.terminal.remoteSessionResumable).toBeUndefined();
  });

  it('reattaches a persisted Managed Remote Terminal Session without capability preparation', () => {
    const harness = createHarness();
    harness.terminal.remoteSessionResumable = true;
    harness.adapters.session.supportsPersistence = vi.fn(() => new Promise(() => {}));
    const onAuthorized = vi.fn();

    const reconnect = harness.lifecycle.reconnect({
      terminalId: 'term-1',
      command: null,
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
      onAuthorized,
    });

    expect(reconnect).toMatchObject({ kind: 'ready' });
    expect(harness.adapters.session.supportsPersistence).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(harness.adapters.attachment.replace).toHaveBeenCalledWith({
      terminalId: 'term-1',
      workspaceId: 'ws-1',
      cwd: '/komla',
      command: 'ssh remote command',
      cols: undefined,
      rows: undefined,
      startupMode: 'wait-for-marker',
    });
    expect(harness.adapters.attachment.replace.mock.invocationCallOrder[0]).toBeLessThan(
      harness.adapters.workspace.prepareObservationInBackground.mock.invocationCallOrder[0]!
    );
  });

  it('reconciles observation resources when creation launch fails', async () => {
    const harness = createHarness();
    harness.adapters.workspace.prepareObservationBestEffort = vi.fn(() => Promise.resolve());
    harness.adapters.session.buildAttachment = vi.fn(() => {
      throw new Error('invalid launch');
    });

    const ticket = harness.lifecycle.create({
      workspaceId: 'ws-1',
      terminalId: 'term-1',
      command: 'claude',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
    });
    await expect(ticket.ready).resolves.toMatchObject({
      kind: 'failed',
      message: 'invalid launch',
    });

    expect(harness.terminal.status).toBe('stopped');
    expect(harness.adapters.workspace.reconcileObservation).toHaveBeenCalled();
  });

  it('fails closed when remote absence cannot be confirmed', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(() =>
      Promise.reject(new Error('offline'))
    );

    await expect(harness.lifecycle.stop({ terminalId: harness.terminal.id })).rejects.toThrow(
      'offline'
    );

    expect(harness.adapters.attachment.stop).not.toHaveBeenCalled();
    expect(harness.terminal.status).toBe('running');
  });

  it('can recover a detached Terminal after remote stop confirmation fails', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionActive = true;
    harness.adapters.workspace.prepareObservationBestEffort = vi.fn(() => Promise.resolve());
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(() =>
      Promise.reject(new Error('offline'))
    );

    await expect(harness.lifecycle.stop({ terminalId: 'term-1' })).rejects.toThrow('offline');
    const recovery = await harness.lifecycle.recover('ws-1');

    expect(recovery.endedTerminalIds).toEqual(new Set(['term-1']));
    expect(harness.terminal.remoteSessionActive).toBe(false);
  });

  it('detaches a cancelled reconnect when remote stop confirmation fails', async () => {
    const harness = createHarness();
    harness.terminal.status = 'stopped';
    harness.terminal.remoteSessionActive = true;
    const reconnect = harness.lifecycle.reconnect({
      terminalId: 'term-1',
      command: 'claude --resume',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
    });
    expect(harness.terminal.status).toBe('starting');
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(() =>
      Promise.reject(new Error('offline'))
    );

    await expect(harness.lifecycle.stop({ terminalId: 'term-1' })).rejects.toThrow('offline');

    expect(harness.terminal.status).toBe('stopped');
    expect(harness.terminal.remoteSessionActive).toBe(true);
    harness.finishPreparation();
    await expect(reconnect).resolves.toMatchObject({ kind: 'superseded' });
  });

  it('reconciles persisted terminals without treating unknown as absent', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionResumable = true;

    const recovery = await harness.lifecycle.recover('ws-1');

    expect(recovery.endedTerminalIds).toEqual(new Set(['term-1']));
    expect(harness.terminal.remoteSessionActive).toBe(false);

    harness.terminal.remoteSessionActive = undefined;
    harness.adapters.session.observe = vi.fn(() => Promise.reject(new Error('offline')));
    const freshLifecycle = new ManagedRemoteTerminalLifecycleService(harness.adapters);

    await expect(freshLifecycle.recover('ws-1')).rejects.toThrow('offline');
    expect(harness.terminal.remoteSessionActive).toBeUndefined();
  });

  it('recovers an existing session without probing terminal helper capability', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionActive = true;
    harness.adapters.workspace.prepareObservationBestEffort = vi.fn(() => Promise.resolve());
    harness.adapters.session.observe = vi.fn(() => Promise.resolve(new Set(['term-1'])));
    harness.adapters.session.supportsPersistence = vi.fn(() => new Promise(() => {}));

    const recovery = await harness.lifecycle.recover('ws-1');

    expect(recovery.states.get('term-1')).toMatchObject({
      remoteSession: { kind: 'present' },
      persistence: 'supported',
    });
    expect(harness.adapters.session.supportsPersistence).not.toHaveBeenCalled();
  });

  it('supersedes pending creation when the Terminal is stopped', async () => {
    const harness = createHarness();
    let finishPersistenceCheck!: (supported: boolean) => void;
    harness.adapters.session.supportsPersistence = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPersistenceCheck = resolve;
        })
    );
    const ticket = harness.lifecycle.create({
      workspaceId: 'ws-1',
      terminalId: 'term-1',
      command: 'claude',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
    });

    await harness.lifecycle.stop({ terminalId: 'term-1' });
    finishPersistenceCheck(true);

    await expect(ticket.ready).resolves.toMatchObject({ kind: 'superseded' });
    expect(harness.adapters.attachment.spawn).not.toHaveBeenCalled();
    expect(harness.terminal.status).toBe('stopped');
    expect(harness.terminal.remoteSessionResumable).toBeUndefined();
  });

  it('does not allow a replacement to overtake an in-flight stop', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionActive = true;
    let finishRemoteStop!: () => void;
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoteStop = resolve;
        })
    );

    const stop = harness.lifecycle.stop({ terminalId: 'term-1' });
    await vi.waitFor(() => expect(finishRemoteStop).toBeTypeOf('function'));

    const releaseStartSlot = vi.fn();
    const replacement = harness.lifecycle.replace({
      terminalId: 'term-1',
      command: 'claude --new',
      keepShellOpenAfterCommand: false,
      releaseStartSlot,
      explicit: true,
    });
    const replacementRejected = expect(replacement).rejects.toThrow('being stopped');
    harness.finishPreparation();
    finishRemoteStop();
    await stop;

    await replacementRejected;
    expect(releaseStartSlot).toHaveBeenCalledOnce();
    expect(harness.adapters.attachment.replace).not.toHaveBeenCalled();
    expect(harness.terminal.status).toBe('stopped');
  });

  it('does not let an attachment-exit observation overwrite a confirmed stop', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionActive = true;
    harness.terminal.remoteSessionResumable = true;
    let finishRemoteStop!: () => void;
    let finishExitObservation!: (activeIds: Set<string>) => void;
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoteStop = resolve;
        })
    );
    harness.adapters.session.observe = vi.fn(
      () =>
        new Promise<Set<string>>((resolve) => {
          finishExitObservation = resolve;
        })
    );

    const stop = harness.lifecycle.stop({ terminalId: 'term-1' });
    await vi.waitFor(() => expect(finishRemoteStop).toBeTypeOf('function'));
    const attachmentExit = harness.lifecycle.attachmentExited('term-1');
    await vi.waitFor(() => expect(finishExitObservation).toBeTypeOf('function'));

    finishRemoteStop();
    await stop;
    finishExitObservation(new Set(['term-1']));
    await attachmentExit;

    expect(harness.lifecycle.state('term-1').remoteSession).toEqual({ kind: 'absent' });
    expect(harness.terminal.remoteSessionActive).toBe(false);
  });

  it('does not allow a new Terminal to overtake an in-flight workspace stop', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionActive = true;
    let finishRemoteStop!: () => void;
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoteStop = resolve;
        })
    );

    const stop = harness.lifecycle.stop({ workspaceId: 'ws-1' });
    await vi.waitFor(() => expect(finishRemoteStop).toBeTypeOf('function'));

    const releaseStartSlot = vi.fn();
    let creationError: unknown;
    try {
      harness.lifecycle.create({
        workspaceId: 'ws-1',
        terminalId: 'term-2',
        command: 'claude --new',
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
      });
    } catch (error) {
      creationError = error;
    } finally {
      harness.finishPreparation();
      finishRemoteStop();
      await stop;
    }

    expect(creationError).toEqual(new Error('Managed remote workspace ws-1 is being stopped'));
    expect(releaseStartSlot).toHaveBeenCalledOnce();
    expect(harness.adapters.attachment.spawn).not.toHaveBeenCalled();
  });

  it('blocks replacements until every in-flight stop settles', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionActive = true;
    const finishRemoteStops: Array<() => void> = [];
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoteStops.push(resolve);
        })
    );

    const firstStop = harness.lifecycle.stop({ terminalId: 'term-1' });
    const secondStop = harness.lifecycle.stop({ terminalId: 'term-1' });
    await vi.waitFor(() => expect(finishRemoteStops).toHaveLength(2));
    finishRemoteStops[1]();
    await secondStop;

    const replacement = harness.lifecycle.replace({
      terminalId: 'term-1',
      command: 'claude --new',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
      explicit: true,
    });
    const replacementRejected = expect(replacement).rejects.toThrow('being stopped');
    harness.finishPreparation();
    finishRemoteStops[0]();
    await firstStop;

    await replacementRejected;
    expect(harness.adapters.attachment.replace).not.toHaveBeenCalled();
  });

  it('blocks creation until every in-flight workspace stop settles', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionActive = true;
    const finishRemoteStops: Array<() => void> = [];
    harness.adapters.session.stopAndConfirmAbsent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoteStops.push(resolve);
        })
    );

    const firstStop = harness.lifecycle.stop({ workspaceId: 'ws-1' });
    const secondStop = harness.lifecycle.stop({ workspaceId: 'ws-1' });
    await vi.waitFor(() => expect(finishRemoteStops).toHaveLength(2));
    finishRemoteStops[1]();
    await secondStop;

    const releaseStartSlot = vi.fn();
    let creationError: unknown;
    try {
      harness.lifecycle.create({
        workspaceId: 'ws-1',
        terminalId: 'term-2',
        command: 'claude --new',
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
      });
    } catch (error) {
      creationError = error;
    } finally {
      harness.finishPreparation();
      finishRemoteStops[0]();
      await firstStop;
    }

    expect(creationError).toEqual(new Error('Managed remote workspace ws-1 is being stopped'));
    expect(releaseStartSlot).toHaveBeenCalledOnce();
    expect(harness.adapters.attachment.spawn).not.toHaveBeenCalled();
  });

  it('replaces a Terminal through one lifecycle intent', async () => {
    const harness = createHarness();
    harness.adapters.workspace.prepareObservationBestEffort = vi.fn(() => Promise.resolve());

    await harness.lifecycle.replace({
      terminalId: 'term-1',
      command: 'claude --resume',
      keepShellOpenAfterCommand: false,
      releaseStartSlot: vi.fn(),
      explicit: true,
      cols: 120,
      rows: 30,
    });

    expect(harness.adapters.session.buildAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'replace', command: 'claude --resume' })
    );
    expect(harness.adapters.attachment.replace).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'term-1', cols: 120, rows: 30 })
    );
  });

  it('reconciles observation resources when replacement launch fails', async () => {
    const harness = createHarness();
    harness.adapters.workspace.prepareObservationBestEffort = vi.fn(() => Promise.resolve());
    harness.adapters.session.buildAttachment = vi.fn(() => {
      throw new Error('invalid launch');
    });

    await expect(
      harness.lifecycle.replace({
        terminalId: 'term-1',
        command: 'claude',
        keepShellOpenAfterCommand: false,
        releaseStartSlot: vi.fn(),
        explicit: true,
      })
    ).rejects.toThrow('invalid launch');

    expect(harness.terminal.status).toBe('stopped');
    expect(harness.adapters.workspace.reconcileObservation).toHaveBeenCalled();
  });

  it('releases the start slot when an attachment exit supersedes replacement preparation', async () => {
    const harness = createHarness();
    const releaseStartSlot = vi.fn();
    const replacement = harness.lifecycle.replace({
      terminalId: 'term-1',
      command: 'claude --new',
      keepShellOpenAfterCommand: false,
      releaseStartSlot,
      explicit: true,
    });

    await harness.lifecycle.attachmentExited('term-1');
    harness.finishPreparation();

    await expect(replacement).resolves.toMatchObject({ kind: 'superseded' });
    expect(releaseStartSlot).toHaveBeenCalled();
    expect(harness.adapters.attachment.replace).not.toHaveBeenCalled();
  });

  it('releases lifecycle state only after confirmed remote and local cleanup', async () => {
    const harness = createHarness();
    harness.terminal.remoteSessionActive = true;

    await harness.lifecycle.release({ terminalId: 'term-1' });

    expect(harness.adapters.session.stopAndConfirmAbsent).toHaveBeenCalledWith(backend, ['term-1']);
    expect(harness.adapters.attachment.release).toHaveBeenCalledWith('term-1');
    expect(() => harness.lifecycle.state('term-1')).toThrow('not found');
  });

  it('rejects a newer attachment while a Terminal is being released', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionActive = true;
    harness.adapters.workspace.prepareObservationBestEffort = vi.fn(() => Promise.resolve());
    let finishAttachmentRelease!: () => void;
    harness.adapters.attachment.release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAttachmentRelease = resolve;
        })
    );

    const release = harness.lifecycle.release({ terminalId: 'term-1' });
    await vi.waitFor(() => expect(finishAttachmentRelease).toBeTypeOf('function'));
    const releaseStartSlot = vi.fn();

    await expect(
      harness.lifecycle.replace({
        terminalId: 'term-1',
        command: 'claude --new',
        keepShellOpenAfterCommand: false,
        releaseStartSlot,
        explicit: true,
      })
    ).rejects.toThrow('being released');

    expect(releaseStartSlot).toHaveBeenCalledOnce();
    finishAttachmentRelease();
    await release;
    expect(harness.adapters.attachment.replace).not.toHaveBeenCalled();
  });

  it('keeps a Terminal in tmux when an attachment-exit check finds its session ended', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionResumable = true;

    await harness.lifecycle.attachmentExited('term-1');

    // Like a stop here: it ran in tmux, so it stays saved and synced.
    expect(harness.lifecycle.state('term-1')).toMatchObject({
      remoteSession: { kind: 'absent' },
      persistence: 'supported',
    });
    expect(harness.terminal).toMatchObject({
      status: 'stopped',
      remoteSessionActive: false,
      remoteSessionResumable: true,
    });
  });

  it('records a session a sync found gone from the host as ended', () => {
    const harness = createHarness();
    harness.terminal.remoteSessionActive = true;
    harness.terminal.remoteSessionResumable = true;
    const baseline = harness.lifecycle.hostCheckBaseline('term-1');

    expect(harness.lifecycle.sessionGoneFromHost('term-1', baseline)).toBe(true);

    expect(harness.terminal).toMatchObject({
      status: 'stopped',
      remoteSessionActive: false,
      remoteSessionResumable: true,
    });
    // The sync saves and tells the windows once for every Terminal it ends.
    expect(harness.adapters.workspace.changed).not.toHaveBeenCalled();
  });

  it('keeps a session a sync found gone from being overwritten by an earlier exit check', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionResumable = true;
    let finishExitObservation!: (activeIds: Set<string>) => void;
    harness.adapters.session.observe = vi.fn(
      () =>
        new Promise<Set<string>>((resolve) => {
          finishExitObservation = resolve;
        })
    );
    const attachmentExit = harness.lifecycle.attachmentExited('term-1');
    const baseline = harness.lifecycle.hostCheckBaseline('term-1');
    await vi.waitFor(() => expect(finishExitObservation).toBeTypeOf('function'));

    expect(harness.lifecycle.sessionGoneFromHost('term-1', baseline)).toBe(true);
    finishExitObservation(new Set(['term-1']));
    await attachmentExit;

    expect(harness.terminal.remoteSessionActive).toBe(false);
  });

  it('ignores a host check answered after this device saw the session itself', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionResumable = true;
    const baseline = harness.lifecycle.hostCheckBaseline('term-1');
    harness.adapters.session.observe = vi.fn(() => Promise.reject(new Error('offline')));
    await harness.lifecycle.attachmentExited('term-1');

    expect(harness.lifecycle.sessionGoneFromHost('term-1', baseline)).toBe(false);

    expect(harness.terminal.remoteSessionActive).toBe(true);
  });

  it('ignores a host check for a Terminal attached here', () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionResumable = true;
    const baseline = harness.lifecycle.hostCheckBaseline('term-1');

    expect(harness.lifecycle.sessionGoneFromHost('term-1', baseline)).toBe(false);

    expect(harness.terminal.status).toBe('running');
  });

  it('retains last-observed presence when an attachment-exit probe is unreachable', async () => {
    const harness = createHarness();
    harness.terminal.status = 'running';
    harness.terminal.remoteSessionResumable = true;
    harness.adapters.session.observe = vi.fn(() => Promise.reject(new Error('offline')));

    await harness.lifecycle.attachmentExited('term-1');

    expect(harness.lifecycle.state('term-1').remoteSession).toEqual({
      kind: 'unknown',
      lastObserved: 'present',
    });
    expect(harness.terminal.status).toBe('stopped');
    expect(harness.terminal.remoteSessionActive).toBe(true);
  });
});
