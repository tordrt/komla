import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExecutionLocations,
  type ExecutionLocationDependencies,
} from '../../../src/main/services/execution-location/execution-location';
import { STOP_STEP_TIME_LIMIT_MS } from '../../../src/main/services/workspace-setup/automation';
import { WorkspaceSetupService } from '../../../src/main/services/workspace-setup.service';
import {
  createBackgroundStep,
  createTabStep,
  createProject,
  createWorktreeWorkspace,
  createTerminal,
  createClaudePreset,
} from '../../factories';
import { createDeferred } from '../../setup';

import type { WorkspaceSetupDependencies } from '../../../src/main/services/workspace-setup.service';
import type { Workspace, Project, SshHost } from '../../../src/shared/types';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Shell interpolation remains real; prevent the WSL preference read from loading desktop storage.
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({ shellMode: 'native' }) },
}));

function harness(
  projectOverrides: Partial<Project> = {},
  workspaceOverrides: Partial<Workspace> = {}
) {
  const project = createProject({ id: 'project-1', ...projectOverrides });
  const workspace = createWorktreeWorkspace({
    id: 'ws-1',
    projectId: project.id,
    name: 'Workspace',
    ...workspaceOverrides,
  });
  const workspaces = new Map([[workspace.id, workspace]]);
  const launches: string[] = [];
  const host: SshHost = { id: 'host-1', name: 'Dev', hostname: 'dev.example', basePath: '/remote' };
  const preset = createClaudePreset();
  const stopBackgroundProcess = vi.fn(async () => undefined);
  // Execution stays real down to the background process and SSH leaves.
  const execution = {
    background: {
      spawn: vi.fn<ExecutionLocationDependencies['background']['spawn']>(
        (_id, _command, _cwd, name) => {
          launches.push(name);
          return { stop: stopBackgroundProcess };
        }
      ),
    },
    ssh: {
      runStreaming: vi.fn<ExecutionLocationDependencies['ssh']['runStreaming']>(async () => 0),
      komlaCliSetup: () => [],
    },
  };
  const hosts = { get: vi.fn((): SshHost | undefined => host) };
  const locations = createExecutionLocations({
    getLocalCopyPath: () => '/local-copy',
    prepareLocalCopy: vi.fn(async () => '/local-copy'),
    initializeLocalCopy: vi.fn(async () => '/local-copy'),
    ensureLocalCopyInitialSync: vi.fn(),
    isWslMode: () => false,
    windowsPathToWsl: (path) => path,
    pty: {
      spawn: vi.fn(),
      restart: vi.fn(),
      kill: vi.fn(),
      releaseTerminal: vi.fn(),
      releaseTerminalAndWait: vi.fn(async () => undefined),
    },
    background: execution.background,
    managedSessions: {
      create: vi.fn(),
      reconnect: vi.fn(),
      replace: vi.fn(),
      stop: vi.fn(),
      release: vi.fn(),
    },
    hosts,
    ssh: execution.ssh,
  });
  const dependencies = {
    getWorkspace: (id: string) => workspaces.get(id),
    broadcastWorkspaceUpdate: vi.fn(),
    addTerminal: vi.fn<WorkspaceSetupDependencies['addTerminal']>(
      (id, name, command, layoutHint) => {
        launches.push(name ?? '');
        const terminal = createTerminal({ name, layoutHint });
        workspaces.get(id)!.terminals.push(terminal);
        return terminal;
      }
    ),
    resolvePreset: vi.fn(() => preset),
    resolveAgentCommand: vi.fn(() => 'claude'),
    locations,
    prepareLocalMirror: vi.fn(async () => '/local-copy'),
    projects: { get: vi.fn((id: string) => (id === project.id ? project : undefined)) },
    actions: {
      get: vi.fn<WorkspaceSetupDependencies['actions']['get']>(),
    },
    presets: { get: vi.fn(() => preset), resolvePresetCommand: vi.fn(() => 'claude prompt') },
    hosts,
    ssh: {
      getRsyncTransport: vi.fn(() => ({ remoteShell: 'ssh', remoteTarget: 'dev@example' })),
    },
    background: {
      killForWorkspace: vi.fn(),
      killForWorkspaceAndWait: vi.fn(async () => undefined),
    },
    notifyActionRunFinished: vi.fn<WorkspaceSetupDependencies['notifyActionRunFinished']>(),
  } satisfies WorkspaceSetupDependencies;
  const setup = new WorkspaceSetupService(dependencies);
  return {
    setup,
    dependencies,
    execution,
    workspace,
    project,
    workspaces,
    launches,
    host,
    stopBackgroundProcess,
  };
}

const sshBackend = {
  kind: 'ssh' as const,
  hostId: 'host-1',
  remoteDirectory: '/remote/worktree',
  remoteRepoPath: '/remote/repo.git',
  remoteProjectRoot: '/remote',
  gitUrl: 'git@example:repo.git',
};

function retainedActivity(
  state: 'failed' | 'unsupported' | 'succeeded',
  index = 0
): NonNullable<Workspace['setupActivities']>[number] {
  return {
    id: `old-${index}`,
    workspaceId: 'ws-1',
    setupRunId: 'old-run',
    stepId: `old-step-${index}`,
    stepName: 'Earlier step',
    retryable: true,
    state,
    startedAt: 1000,
    completedAt: 2000,
    output: '',
    error: state === 'succeeded' ? undefined : 'still needs attention',
  };
}

describe('Workspace Setup Automation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('skips creation-only steps on start, preserving the primary Terminal position', () => {
    const h = harness({
      agentLayoutOrder: 2,
      setupSteps: [
        createBackgroundStep({ name: 'Install', trigger: 'workspace-creation' }),
        createTabStep({ name: 'Setup', trigger: 'workspace-creation' }),
        createTabStep({ name: 'Dev Server' }),
      ],
    });
    const primary = h.setup.start(h.workspace, 'claude --resume', 'start');
    expect(h.launches).toEqual(['Workspace', 'Dev Server']);
    expect(h.workspace.primaryTerminalId).toBe(primary!.id);
    expect(h.workspace.terminals.map((t) => t.layoutHint)).toEqual([undefined, 'tab']);
  });

  it('places the agent using visible steps while dispatching background steps in list order', () => {
    const h = harness({
      agentLayoutOrder: 2,
      setupSteps: [
        createBackgroundStep({ name: 'Install', trigger: 'workspace-creation' }),
        createTabStep({ name: 'Setup', trigger: 'workspace-creation' }),
        createTabStep({ name: 'Dev Server' }),
      ],
    });
    const primary = h.setup.start(h.workspace, 'claude', 'create');
    expect(h.launches).toEqual(['Install', 'Setup', 'Workspace', 'Dev Server']);
    expect(h.workspace.terminals.map((t) => t.name)).toEqual(['Setup', 'Workspace', 'Dev Server']);
    expect(h.workspace.primaryTerminalId).toBe(primary!.id);
  });

  it('runs every-start steps while skipping creation-only background steps', () => {
    const h = harness({
      setupSteps: [
        createBackgroundStep({ name: 'Install', trigger: 'workspace-creation' }),
        createBackgroundStep({ name: 'Watcher', command: 'npm run watch' }),
      ],
    });
    h.setup.start(h.workspace, 'claude', 'start');
    expect(h.execution.background.spawn.mock.calls.map((call) => call[1])).toEqual([
      'npm run watch',
    ]);
  });

  it('lets the caller supply the default Terminal when no steps apply', () => {
    const h = harness({ setupSteps: [createTabStep({ trigger: 'workspace-creation' })] });
    expect(h.setup.start(h.workspace, 'claude', 'start')).toBeNull();
    expect(h.launches).toEqual([]);
    h.workspace.isWorktree = false;
    expect(h.setup.start(h.workspace, 'claude', 'create')).toBeNull();
  });

  it('removes unsupported activity from the previous Setup run on start', () => {
    const h = harness(
      { setupSteps: [createBackgroundStep({ id: 'install-step' })] },
      {
        setupActivities: [retainedActivity('unsupported')],
      }
    );
    h.setup.start(h.workspace, 'claude', 'start');
    expect(h.workspace.setupActivities).toEqual([
      expect.objectContaining({ stepId: 'install-step', state: 'running' }),
    ]);
  });

  it('retains unresolved failures when activity history reaches its soft limit', () => {
    const h = harness(
      { setupSteps: [createBackgroundStep({ id: 'install-step' })] },
      {
        setupActivities: Array.from({ length: 50 }, (_, i) => retainedActivity('failed', i)),
      }
    );
    h.setup.start(h.workspace, 'claude', 'start');
    expect(h.workspace.setupActivities).toHaveLength(51);
    expect(h.workspace.setupActivities).toContainEqual(expect.objectContaining({ id: 'old-0' }));
    expect(h.workspace.setupActivities).toContainEqual(
      expect.objectContaining({ stepId: 'install-step', state: 'running' })
    );
  });

  it('evicts successful activity before unresolved failures at the retention limit', () => {
    const h = harness(
      { setupSteps: [createBackgroundStep()] },
      {
        setupActivities: Array.from({ length: 50 }, (_, i) =>
          retainedActivity(i === 25 ? 'succeeded' : 'failed', i)
        ),
      }
    );
    h.setup.start(h.workspace, 'claude', 'start');
    expect(h.workspace.setupActivities).toHaveLength(50);
    expect(h.workspace.setupActivities!.some((a) => a.id === 'old-25')).toBe(false);
    expect(h.workspace.setupActivities!.some((a) => a.id === 'old-0')).toBe(true);
  });

  it('retries one failed background step without rerunning other steps', () => {
    const h = harness({
      setupSteps: [
        createBackgroundStep({ id: 'install', command: 'npm install' }),
        createBackgroundStep({ id: 'seed', command: 'npm run seed' }),
      ],
    });
    h.setup.start(h.workspace, 'claude', 'create');
    const firstId = h.workspace.setupActivities![0].id;
    h.execution.background.spawn.mock.calls[0][4]!.onExit!({ exitCode: 1 });
    h.execution.background.spawn.mockClear();
    h.setup.retry(h.workspace.id, 'install');
    expect(h.execution.background.spawn.mock.calls.map((call) => call[1])).toEqual(['npm install']);
    expect(h.workspace.setupActivities!.some((a) => a.id === firstId)).toBe(false);
    expect(h.workspace.setupActivities!.find((a) => a.stepId === 'seed')!.state).toBe('running');
  });

  it('validates retry requests before changing activities or launching execution', () => {
    const h = harness({
      setupSteps: [
        createTabStep({ id: 'visible' }),
        createBackgroundStep({ id: 'remote-only', destination: 'ssh-workspace-repository' }),
      ],
    });
    expect(() => h.setup.retry('missing', 'visible')).toThrow('not found');
    expect(() => h.setup.retry(h.workspace.id, 'missing')).toThrow('not found');
    expect(() => h.setup.retry(h.workspace.id, 'visible')).toThrow('Only background');
    expect(() => h.setup.retry(h.workspace.id, 'remote-only')).toThrow('not applicable');
    h.workspace.projectId = null;
    expect(() => h.setup.retry(h.workspace.id, 'visible')).toThrow('no Project setup');
    expect(h.launches).toEqual([]);
  });

  it('captures bounded output, coalesces updates, and flushes completion immediately', async () => {
    const h = harness({ setupSteps: [createBackgroundStep()] });
    h.setup.start(h.workspace, 'claude', 'create');
    const callbacks = h.execution.background.spawn.mock.calls[0][4]!;
    h.dependencies.broadcastWorkspaceUpdate.mockClear();
    callbacks.onData!('x'.repeat(70 * 1024));
    callbacks.onData!('end');
    const activity = h.workspace.setupActivities![0];
    expect(activity.output.length).toBe(64 * 1024);
    expect(activity.output).toContain('earlier output truncated');
    expect(activity.output.endsWith('end')).toBe(true);
    expect(activity.truncated).toBe(true);
    expect(h.dependencies.broadcastWorkspaceUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.dependencies.broadcastWorkspaceUpdate).toHaveBeenCalledTimes(1);
    callbacks.onData!('done');
    callbacks.onExit!({ exitCode: 1 });
    expect(activity).toMatchObject({
      state: 'failed',
      exitCode: 1,
      completedAt: expect.any(Number),
    });
    expect(h.dependencies.broadcastWorkspaceUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.dependencies.broadcastWorkspaceUpdate).toHaveBeenCalledTimes(2);
    h.setup.dismiss(h.workspace.id, activity.id);
    expect(h.workspace.setupActivities).toEqual([]);
    expect(() => h.setup.dismiss('missing', activity.id)).toThrow('not found');
  });

  describe.each(['linux', 'darwin'] as const)('Local copy on %s', (platform) => {
    let originalPlatform: PropertyDescriptor;

    beforeEach(() => {
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', {
        ...originalPlatform,
        value: platform,
      });
    });
    afterEach(() => Object.defineProperty(process, 'platform', originalPlatform));

    it('keeps independent steps launchable while Local copy preparation is pending', async () => {
      const h = harness(
        {
          setupSteps: [
            createBackgroundStep({
              id: 'copy',
              destination: 'ssh-local-copy',
            }),
            createTabStep({ name: 'Remote shell' }),
          ],
        },
        { backend: sshBackend }
      );
      const preparation = createDeferred<string>();
      h.dependencies.prepareLocalMirror.mockReturnValue(preparation.promise);
      h.setup.start(h.workspace, 'claude', 'create');
      expect(h.workspace.terminals.map((t) => t.name)).toEqual(['Workspace', 'Remote shell']);
      expect(h.workspace.setupActivities![0].state).toBe('preparing');
      expect(h.execution.background.spawn).not.toHaveBeenCalled();
      preparation.resolve('/local-copy');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.execution.background.spawn).toHaveBeenCalledTimes(1);
      expect(h.workspace.setupActivities![0].state).toBe('running');
    });

    it.each(['pending', 'active'] as const)(
      'prevents prepared Local copy execution after %s cancellation',
      async (scope) => {
        const h = harness(
          {
            setupSteps: [createBackgroundStep({ destination: 'ssh-local-copy' })],
          },
          { backend: sshBackend }
        );
        const preparation = createDeferred<string>();
        h.dependencies.prepareLocalMirror.mockReturnValue(preparation.promise);
        h.setup.start(h.workspace, 'claude', 'create');
        if (scope === 'pending') h.setup.cancel(h.workspace.id, 'pending');
        else h.setup.clearActive(h.workspace.id);
        preparation.resolve('/local-copy');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.execution.background.spawn).not.toHaveBeenCalled();
        expect(h.workspace.setupActivities).toEqual([]);
      }
    );

    it('records where each background step runs', () => {
      const h = harness(
        {
          setupSteps: [
            createBackgroundStep({ id: 'copy', destination: 'ssh-local-copy' }),
            createBackgroundStep({ id: 'host', destination: 'workspace-repository' }),
          ],
        },
        { backend: sshBackend }
      );
      h.dependencies.prepareLocalMirror.mockReturnValue(createDeferred<string>().promise);
      h.setup.start(h.workspace, 'claude', 'create');

      expect(
        h.workspace.setupActivities!.map(({ stepId, executionLocation }) => [
          stepId,
          executionLocation,
        ])
      ).toEqual([
        ['copy', 'local-mirror'],
        ['host', 'workspace'],
      ]);
    });

    it('classifies a missing rsync failure as unsupported without blocking other steps', async () => {
      const h = harness(
        {
          setupSteps: [
            createBackgroundStep({
              id: 'copy',
              destination: 'ssh-local-copy',
            }),
            createTabStep({ name: 'Remote shell' }),
          ],
        },
        { backend: sshBackend }
      );
      h.dependencies.prepareLocalMirror.mockRejectedValue(new Error('rsync: command not found'));
      h.setup.start(h.workspace, 'claude', 'create');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.workspace.setupActivities![0]).toMatchObject({
        state: 'unsupported',
        error: 'rsync: command not found',
      });
      expect(h.launches).toContain('Remote shell');
    });
  });

  it.each(['background', 'tab'] as const)(
    'rejects a %s Local copy step on Windows without blocking other steps',
    (placement) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', {
        ...originalPlatform,
        value: 'win32',
      });
      try {
        const h = harness(
          {
            setupSteps: [
              createBackgroundStep({
                id: 'copy',
                placement,
                destination: 'ssh-local-copy',
              }),
              createTabStep({ name: 'Remote shell' }),
            ],
          },
          { backend: sshBackend }
        );
        h.setup.start(h.workspace, 'claude', 'create');
        expect(h.workspace.setupActivities).toEqual([
          expect.objectContaining({
            stepId: 'copy',
            state: 'unsupported',
            error: 'SSH Local copy requires rsync on this computer and the SSH host',
          }),
        ]);
        expect(h.dependencies.prepareLocalMirror).not.toHaveBeenCalled();
        expect(h.execution.background.spawn).not.toHaveBeenCalled();
        expect(h.workspace.terminals.map((t) => t.name)).toEqual(['Workspace', 'Remote shell']);
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  );

  it('awaits remote completion during cancellation without consuming other workspaces', async () => {
    const h = harness(
      { setupSteps: [createBackgroundStep({ id: 'remote' })] },
      { backend: sshBackend }
    );
    const remote = createDeferred<number>();
    h.execution.ssh.runStreaming.mockReturnValue(remote.promise);
    h.setup.start(h.workspace, 'claude', 'create');
    const options = h.execution.ssh.runStreaming.mock.calls[0][2]!;
    options.onData!('remote output');
    expect(h.workspace.setupActivities![0].output).toBe('remote output');
    expect(h.setup.cancel('different-workspace')).toBeUndefined();
    expect(options.signal!.aborted).toBe(false);
    let finished = false;
    const cancel = h.setup.cancel(h.workspace.id)!.then(() => {
      finished = true;
    });
    expect(options.signal!.aborted).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    remote.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await cancel;
    expect(h.workspace.setupActivities).toEqual([]);
    expect(h.setup.cancel(h.workspace.id)).toBeUndefined();
  });

  it('ignores remote completion and delayed broadcasts after workspace replacement', async () => {
    const h = harness({ setupSteps: [createBackgroundStep()] }, { backend: sshBackend });
    const remote = createDeferred<number>();
    h.execution.ssh.runStreaming.mockReturnValue(remote.promise);
    h.setup.start(h.workspace, 'claude', 'create');
    h.execution.ssh.runStreaming.mock.calls[0][2]!.onData!('pending');
    h.dependencies.broadcastWorkspaceUpdate.mockClear();
    const replacement = createWorktreeWorkspace({ id: h.workspace.id });
    h.workspaces.set(h.workspace.id, replacement);
    remote.resolve(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(replacement.setupActivities).toBeUndefined();
    expect(h.dependencies.broadcastWorkspaceUpdate).not.toHaveBeenCalled();
  });

  it('awaits all remote execution and clears output timers on disposal', async () => {
    const h = harness({ setupSteps: [createBackgroundStep()] }, { backend: sshBackend });
    const remote = createDeferred<number>();
    h.execution.ssh.runStreaming.mockReturnValue(remote.promise);
    h.setup.start(h.workspace, 'claude', 'create');
    const options = h.execution.ssh.runStreaming.mock.calls[0][2]!;
    options.onData!('pending');
    const disposal = h.setup.dispose();
    expect(options.signal!.aborted).toBe(true);
    remote.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await disposal;
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('background Actions', () => {
    const watchCi = {
      id: 'watch-ci',
      title: 'Watch CI',
      content: 'gh pr checks --watch',
      type: 'command' as const,
      background: true,
    };

    function actionHarness() {
      const h = harness();
      h.dependencies.actions.get.mockImplementation((id) => (id === watchCi.id ? watchCi : undefined));
      return h;
    }

    it('runs the launched command without a terminal and notifies how it ended', () => {
      const h = actionHarness();
      h.setup.runAction(h.workspace.id, watchCi.id, { command: 'gh pr checks 12 --watch' });

      expect(h.dependencies.addTerminal).not.toHaveBeenCalled();
      const [, command, , name, callbacks] = h.execution.background.spawn.mock.calls[0];
      expect(command).toBe('gh pr checks 12 --watch');
      expect(name).toBe('Watch CI');
      expect(h.workspace.setupActivities![0]).toMatchObject({
        actionId: watchCi.id,
        command: 'gh pr checks 12 --watch',
        executionLocation: 'workspace',
        stepName: 'Watch CI',
        state: 'running',
        retryable: true,
      });
      expect(h.dependencies.notifyActionRunFinished).not.toHaveBeenCalled();

      callbacks.onExit({ exitCode: 1 });

      expect(h.dependencies.notifyActionRunFinished).toHaveBeenCalledWith(
        h.workspace,
        expect.objectContaining({ actionId: watchCi.id, state: 'failed', exitCode: 1 })
      );
    });

    it('runs a launched command as filled in, without filling Setup variables into it again', () => {
      const h = actionHarness();
      // The user's input, typed into the command, happens to look like a Setup variable.
      h.setup.runAction(h.workspace.id, watchCi.id, { command: 'echo {{destinationPath}}' });

      expect(h.execution.background.spawn.mock.calls[0][1]).toBe('echo {{destinationPath}}');
    });

    it('replaces a failed run when it runs again, and notifies a success', () => {
      const h = actionHarness();
      h.setup.runAction(h.workspace.id, watchCi.id);
      h.execution.background.spawn.mock.calls[0][4].onExit({ exitCode: 1 });

      h.setup.runAction(h.workspace.id, watchCi.id);

      expect(h.workspace.setupActivities).toHaveLength(1);
      expect(h.execution.background.spawn.mock.calls[1][1]).toBe('gh pr checks --watch');
      h.execution.background.spawn.mock.calls[1][4].onExit({ exitCode: 0 });
      expect(h.dependencies.notifyActionRunFinished).toHaveBeenLastCalledWith(
        h.workspace,
        expect.objectContaining({ state: 'succeeded', exitCode: 0 })
      );
    });

    it('replaces an unsupported run when it runs again', () => {
      const h = actionHarness();
      h.setup.runAction(h.workspace.id, watchCi.id);
      h.workspace.setupActivities![0].state = 'unsupported';

      h.setup.runAction(h.workspace.id, watchCi.id);

      expect(h.workspace.setupActivities!.map((run) => run.state)).toEqual(['running']);
    });

    it('stops a run without notifying', async () => {
      const h = actionHarness();
      h.setup.runAction(h.workspace.id, watchCi.id);
      const activity = h.workspace.setupActivities![0];

      await h.setup.stopRun(h.workspace.id, activity.id);
      h.execution.background.spawn.mock.calls[0][4].onExit({ exitCode: 143 });

      expect(h.stopBackgroundProcess).toHaveBeenCalledTimes(1);
      expect(h.workspace.setupActivities).toEqual([]);
      expect(h.dependencies.notifyActionRunFinished).not.toHaveBeenCalled();
    });

    it('stops an SSH run by cancelling it', async () => {
      const h = actionHarness();
      h.workspace.backend = sshBackend;
      const remote = createDeferred<number>();
      h.execution.ssh.runStreaming.mockReturnValue(remote.promise);
      h.setup.runAction(h.workspace.id, watchCi.id);
      const options = h.execution.ssh.runStreaming.mock.calls[0][2]!;

      const stopped = h.setup.stopRun(h.workspace.id, h.workspace.setupActivities![0].id);
      expect(options.signal!.aborted).toBe(true);
      remote.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await stopped;

      expect(h.workspace.setupActivities).toEqual([]);
      expect(h.dependencies.notifyActionRunFinished).not.toHaveBeenCalled();
    });

    it('runs only Terminal Commands', () => {
      const h = actionHarness();
      h.dependencies.actions.get.mockReturnValue({ id: 'review', title: 'Review', content: '# Review' });

      expect(() => h.setup.runAction(h.workspace.id, 'review')).toThrow('Only Terminal Commands');
      expect(() => h.setup.runAction(h.workspace.id, 'missing')).toThrow();
      expect(h.execution.background.spawn).not.toHaveBeenCalled();
    });

    it('keeps notifying nothing for Setup steps', () => {
      const h = harness({ setupSteps: [createBackgroundStep()] });
      h.setup.start(h.workspace, 'claude', 'create');
      h.execution.background.spawn.mock.calls[0][4].onExit({ exitCode: 1 });

      expect(h.dependencies.notifyActionRunFinished).not.toHaveBeenCalled();
    });
  });

  describe('stop steps', () => {
    const stopStep = (name: string, command = `${name}-command`) =>
      createBackgroundStep({ id: name, name, command, trigger: 'workspace-stop' });

    it('never runs on creation or start', () => {
      const h = harness({
        setupSteps: [stopStep('down'), createBackgroundStep({ name: 'Install' })],
      });
      h.setup.start(h.workspace, 'claude', 'create');
      h.setup.start(h.workspace, 'claude', 'start');
      expect(h.launches).toEqual(['Workspace', 'Install', 'Workspace', 'Install']);
    });

    it('runs one after another and settles once the last has exited', async () => {
      const h = harness({
        setupSteps: [
          stopStep('down'),
          createBackgroundStep({ name: 'Install' }),
          stopStep('prune'),
        ],
      });
      let settled = false;
      const run = h.setup.runStopSteps(h.workspace).then(() => (settled = true));
      expect(h.setup.stopStepsSettled(h.workspace.id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.launches).toEqual(['down']);

      h.execution.background.spawn.mock.calls[0][4]!.onExit!({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.launches).toEqual(['down', 'prune']);
      expect(h.execution.background.spawn.mock.calls[1][1]).toBe('prune-command');
      expect(settled).toBe(false);

      h.execution.background.spawn.mock.calls[1][4]!.onExit!({ exitCode: 2 });
      await run;
      expect(h.setup.stopStepsSettled(h.workspace.id)).toBeUndefined();
      expect(
        h.workspace.setupActivities?.map((activity) => [activity.stepName, activity.state])
      ).toEqual([
        ['down', 'succeeded'],
        ['prune', 'failed'],
      ]);
    });

    it('stops a step that runs past the time limit and goes on with the next', async () => {
      const h = harness({ setupSteps: [stopStep('hangs'), stopStep('next')] });
      const run = h.setup.runStopSteps(h.workspace, 5_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(h.stopBackgroundProcess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.stopBackgroundProcess).toHaveBeenCalledTimes(1);
      expect(h.workspace.setupActivities![0]).toMatchObject({
        state: 'failed',
        error: 'Stopped after 5 seconds',
      });
      expect(h.launches).toEqual(['hangs', 'next']);
      h.execution.background.spawn.mock.calls[1][4]!.onExit!({ exitCode: 0 });
      await run;
    });

    it('runs on the SSH host for an SSH workspace', async () => {
      const h = harness(
        { setupSteps: [stopStep('down', 'docker compose down')] },
        { backend: sshBackend }
      );
      await h.setup.runStopSteps(h.workspace);
      const script = h.execution.ssh.runStreaming.mock.calls[0][1];
      expect(script).toContain("cd '/remote/worktree'");
      expect(script).toContain('docker compose down');
      expect(h.workspace.setupActivities![0].state).toBe('succeeded');
    });

    it('launches no agent', async () => {
      const h = harness({
        setupSteps: [{ ...stopStep('agent'), agent: {} }, stopStep('down')],
      });
      const run = h.setup.runStopSteps(h.workspace);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.dependencies.addTerminal).not.toHaveBeenCalled();
      expect(h.launches).toEqual(['down']);
      expect(h.workspace.setupActivities![0]).toMatchObject({ stepName: 'agent', state: 'failed' });
      h.execution.background.spawn.mock.calls[0][4]!.onExit!({ exitCode: 0 });
      await run;
    });

    it('retries a failed stop step as a stop step, which a start then waits for', async () => {
      const h = harness({ setupSteps: [stopStep('down')] });
      const run = h.setup.runStopSteps(h.workspace);
      await vi.advanceTimersByTimeAsync(0);
      h.execution.background.spawn.mock.calls[0][4]!.onExit!({ exitCode: 1 });
      await run;

      h.setup.retry(h.workspace.id, 'down');
      const retried = h.setup.stopStepsSettled(h.workspace.id);
      expect(retried).toBeDefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.launches).toEqual(['down', 'down']);
      expect(h.workspace.setupActivities).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(STOP_STEP_TIME_LIMIT_MS);
      await retried;
      expect(h.workspace.setupActivities![0]).toMatchObject({ state: 'failed' });
      expect(h.setup.stopStepsSettled(h.workspace.id)).toBeUndefined();
    });

    it('does nothing for a workspace without stop steps', async () => {
      const h = harness({ setupSteps: [createBackgroundStep()] });
      expect(h.setup.hasStopSteps(h.workspace)).toBe(false);
      await h.setup.runStopSteps(h.workspace);
      expect(h.launches).toEqual([]);
      expect(h.setup.stopStepsSettled(h.workspace.id)).toBeUndefined();
    });
  });
});
