import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => '/mock/.komla' }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}) },
}));
vi.mock('../../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../../src/main/services/ssh-host.service', () => ({ sshHostService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {},
  joinRemote: (...parts: string[]) => parts.join('/'),
  remoteKomlaDataPort: () => 0,
}));
vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: {} }));
vi.mock('../../../src/main/services/file-watcher', () => ({ FileWatcher: class {} }));

import { publishAttentionHookEvent, onHookEvent } from '../../../src/main/lib/hook-events';
import {
  HooksService,
  INTERVAL_TICK_MS,
  MAX_PARALLEL_INTERVAL_RUNS,
  parseHooksFile,
  type HooksDependencies,
} from '../../../src/main/services/hooks.service';
import { WorkspaceCommandError } from '../../../src/main/services/workspace-command';

import type { HookEventDetails } from '../../../src/shared/types/hooks';
import type { Workspace, WorkspaceAttention } from '../../../src/shared/types/workspace';

const workspace = {
  id: 'ws-1',
  name: 'Fix login',
  projectId: 'p-1',
  branchName: 'fix-login',
  workingDirectory: '/repo',
} as Workspace;

function createService(file: unknown, overrides: Partial<HooksDependencies> = {}) {
  const dependencies: HooksDependencies = {
    readFile: () => (typeof file === 'string' ? file : JSON.stringify(file)),
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    listWorkspaces: () => [workspace],
    getProjectKeys: () => ['p-1', 'komla'],
    canRun: () => true,
    run: vi.fn(async () => {}),
    runLocal: vi.fn(async () => {}),
    now: () => Date.now(),
    notify: vi.fn(),
    ...overrides,
  };
  const service = new HooksService(dependencies);
  service.reload();
  return { service, dependencies };
}

const done: HookEventDetails = {
  event: 'agent.done',
  workspaceId: 'ws-1',
  terminalId: 'term-1',
  agent: 'claude-code',
};

describe('parseHooksFile', () => {
  it('reads hooks with a default timeout', () => {
    expect(
      parseHooksFile(JSON.stringify({ hooks: [{ id: 'ping', event: 'agent.done', command: 'x' }] }))
    ).toEqual({ hooks: [{ id: 'ping', event: 'agent.done', command: 'x', timeoutSeconds: 60 }] });
  });

  it.each([
    ['{', /not valid JSON/],
    [JSON.stringify({ hooks: [{ id: 'a', event: 'agent.finished', command: 'x' }] }), /event/],
    [
      JSON.stringify({
        hooks: [{ id: 'a', event: 'agent.done', command: 'x', timeoutSeconds: 0 }],
      }),
      /timeoutSeconds/,
    ],
    [
      JSON.stringify({
        hooks: [
          { id: 'a', event: 'agent.done', command: 'x' },
          { id: 'a', event: 'agent.done', command: 'y' },
        ],
      }),
      /its own id/,
    ],
    [JSON.stringify({ hooks: [], extra: true }), /extra/],
    [JSON.stringify({ hooks: [{ id: 'a', event: 'interval', command: 'x' }] }), /intervalSeconds/],
    [
      JSON.stringify({
        hooks: [{ id: 'a', event: 'agent.done', command: 'x', intervalSeconds: 60 }],
      }),
      /intervalSeconds/,
    ],
    [
      JSON.stringify({
        hooks: [
          {
            id: 'a',
            event: 'interval',
            command: 'x',
            intervalSeconds: 60,
            runOn: 'local',
            projects: ['komla'],
          },
        ],
      }),
      /for no project/,
    ],
  ])('names what is wrong with %s', (content, problem) => {
    const parsed = parseHooksFile(content);
    expect(parsed.hooks).toEqual([]);
    expect(parsed.problem).toMatch(problem);
  });
});

describe('HooksService intervals', () => {
  const other = { ...workspace, id: 'ws-2', name: 'Other' } as Workspace;
  const trashed = { ...workspace, id: 'ws-3', status: 'trashed' } as Workspace;

  it('runs an interval hook in each active workspace, again once its interval passes', async () => {
    vi.useFakeTimers();
    const { service, dependencies } = createService(
      { hooks: [{ id: 'ci', event: 'interval', intervalSeconds: 60, command: 'check-ci' }] },
      { listWorkspaces: () => [workspace, other, trashed] }
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(dependencies.run).mock.calls.map(([target]) => target.id)).toEqual([
      'ws-1',
      'ws-2',
    ]);
    expect(vi.mocked(dependencies.run).mock.calls[0][2]).toMatchObject({
      KOMLA_EVENT: 'interval',
      KOMLA_WORKSPACE_ID: 'ws-1',
    });

    await vi.advanceTimersByTimeAsync(55_000);
    expect(dependencies.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL_TICK_MS);
    expect(dependencies.run).toHaveBeenCalledTimes(4);
    service.stop();
    vi.useRealTimers();
  });

  it('waits for a workspace whose files are still being made, and skips one that failed to', async () => {
    vi.useFakeTimers();
    const making = { ...workspace, id: 'ws-4', provisioning: true } as Workspace;
    const failed = {
      ...workspace,
      id: 'ws-5',
      provisionError: 'git worktree add failed',
    } as Workspace;
    const { service, dependencies } = createService(
      { hooks: [{ id: 'ci', event: 'interval', intervalSeconds: 60, command: 'check-ci' }] },
      { listWorkspaces: () => [workspace, making, failed] }
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(dependencies.run).mock.calls.map(([target]) => target.id)).toEqual(['ws-1']);
    service.stop();
    vi.useRealTimers();
  });

  it('runs a local interval hook once on this computer, even with no workspace', async () => {
    vi.useFakeTimers();
    const { service, dependencies } = createService(
      {
        hooks: [
          { id: 'sync', event: 'interval', intervalSeconds: 30, runOn: 'local', command: 'sync' },
        ],
      },
      { listWorkspaces: () => [] }
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.runLocal).toHaveBeenCalledWith(
      'sync',
      { KOMLA_EVENT: 'interval', KOMLA_HOOK_ID: 'sync' },
      60_000
    );
    expect(dependencies.run).not.toHaveBeenCalled();
    service.stop();
    vi.useRealTimers();
  });

  it('starts only a few interval runs at once, and none over one still running', async () => {
    vi.useFakeTimers();
    const many = Array.from(
      { length: MAX_PARALLEL_INTERVAL_RUNS + 2 },
      (_, index) => ({ ...workspace, id: `ws-${index}` }) as Workspace
    );
    const finishers: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => finishers.push(resolve)));
    const { service } = createService(
      { hooks: [{ id: 'ci', event: 'interval', intervalSeconds: 10, command: 'x' }] },
      { listWorkspaces: () => many, run }
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(MAX_PARALLEL_INTERVAL_RUNS);

    // Past the interval, the runs still going aren't started again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(MAX_PARALLEL_INTERVAL_RUNS);
    finishers.shift()!();
    await vi.advanceTimersByTimeAsync(INTERVAL_TICK_MS);
    expect(run).toHaveBeenCalledTimes(MAX_PARALLEL_INTERVAL_RUNS + 1);
    service.stop();
    vi.useRealTimers();
  });

  it('reports an interval hook failing everywhere once', async () => {
    vi.useFakeTimers();
    const { service, dependencies } = createService(
      { hooks: [{ id: 'ci', event: 'interval', intervalSeconds: 60, command: 'x' }] },
      {
        listWorkspaces: () => [workspace, other],
        run: vi.fn().mockRejectedValue(new WorkspaceCommandError('no gh')),
      }
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.notify).toHaveBeenCalledOnce();
    service.stop();
    vi.useRealTimers();
  });

  it('runs a local event hook on this computer while the SSH host is away', async () => {
    const { service, dependencies } = createService(
      { hooks: [{ id: 'log', event: 'agent.done', runOn: 'local', command: 'log' }] },
      { canRun: () => false }
    );
    await service.fire(done);
    expect(dependencies.runLocal).toHaveBeenCalledWith(
      'log',
      expect.objectContaining({ KOMLA_EVENT: 'agent.done', KOMLA_WORKSPACE_ID: 'ws-1' }),
      60_000
    );
  });
});

describe('HooksService', () => {
  it("runs the event's hooks for the workspace's project with the event in the environment", async () => {
    const { service, dependencies } = createService({
      hooks: [
        { id: 'ping', event: 'agent.done', command: 'say done' },
        { id: 'other-project', event: 'agent.done', command: 'x', projects: ['web'] },
        { id: 'this-project', event: 'agent.done', command: 'y', projects: ['komla'] },
        { id: 'created', event: 'workspace.created', command: 'z' },
      ],
    });

    await service.fire({ ...done, message: 'All tests pass' });

    expect(vi.mocked(dependencies.run).mock.calls.map((call) => call[1])).toEqual([
      'say done',
      'y',
    ]);
    expect(dependencies.run).toHaveBeenCalledWith(
      workspace,
      'say done',
      {
        KOMLA_EVENT: 'agent.done',
        KOMLA_HOOK_ID: 'ping',
        KOMLA_WORKSPACE_ID: 'ws-1',
        KOMLA_WORKSPACE_NAME: 'Fix login',
        KOMLA_BRANCH: 'fix-login',
        KOMLA_PROJECT: 'komla',
        KOMLA_TERMINAL_ID: 'term-1',
        KOMLA_AGENT: 'claude-code',
        KOMLA_MESSAGE: 'All tests pass',
      },
      60_000
    );
  });

  it("cuts a long agent message to fit in the hook's environment", async () => {
    const { service, dependencies } = createService({
      hooks: [{ id: 'ping', event: 'agent.done', command: 'x' }],
    });
    await service.fire({ ...done, message: 'a'.repeat(10_000) });
    const env = vi.mocked(dependencies.run).mock.calls[0][2];
    expect(env.KOMLA_MESSAGE).toHaveLength(4000);
    expect(env.KOMLA_MESSAGE.endsWith('…')).toBe(true);
  });

  it('names the workspace by the title the sidebar shows', async () => {
    const { service, dependencies } = createService(
      { hooks: [{ id: 'ping', event: 'agent.done', command: 'x' }] },
      { getWorkspace: () => ({ ...workspace, customName: 'Login fix' }) }
    );
    await service.fire(done);
    expect(vi.mocked(dependencies.run).mock.calls[0][2].KOMLA_WORKSPACE_NAME).toBe('Login fix');
  });

  it('runs nothing for an unknown workspace or one that cannot run commands', async () => {
    const { service, dependencies } = createService(
      { hooks: [{ id: 'ping', event: 'agent.done', command: 'x' }] },
      { canRun: () => false }
    );
    await service.fire(done);
    await service.fire({ ...done, workspaceId: 'gone' });
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it('skips an event while the same hook still runs for that terminal', async () => {
    const finishers: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishers.push(resolve);
        })
    );
    const { service } = createService(
      { hooks: [{ id: 'ping', event: 'agent.done', command: 'x' }] },
      { run }
    );

    const first = service.fire(done);
    await service.fire(done);
    const otherTerminal = service.fire({ ...done, terminalId: 'term-2' });
    expect(run).toHaveBeenCalledTimes(2);
    for (const finish of finishers) finish();
    await Promise.all([first, otherTerminal]);
    void service.fire(done);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('reports a failing hook once until it succeeds again', async () => {
    const run = vi
      .fn<HooksDependencies['run']>()
      .mockRejectedValue(new WorkspaceCommandError('no say'));
    const { service, dependencies } = createService(
      { hooks: [{ id: 'ping', event: 'agent.done', command: 'say' }] },
      { run }
    );

    await service.fire(done);
    await service.fire(done);
    expect(dependencies.notify).toHaveBeenCalledTimes(1);
    expect(dependencies.notify).toHaveBeenCalledWith('Hook "ping" in hooks.json failed: no say');

    run.mockResolvedValueOnce(undefined);
    await service.fire(done);
    await service.fire(done);
    expect(dependencies.notify).toHaveBeenCalledTimes(2);
  });

  it('reports a hook failing in one workspace even while it works in another', async () => {
    const other = { ...workspace, id: 'ws-2' };
    const run = vi.fn<HooksDependencies['run']>(async (target) => {
      if (target.id === 'ws-1') throw new WorkspaceCommandError('lint fails');
    });
    const { service, dependencies } = createService(
      { hooks: [{ id: 'lint', event: 'agent.done', command: 'npm run lint' }] },
      { run, getWorkspace: (id) => (id === 'ws-2' ? other : id === 'ws-1' ? workspace : undefined) }
    );

    await service.fire(done);
    await service.fire({ ...done, workspaceId: 'ws-2' });
    await service.fire(done);
    expect(dependencies.notify).toHaveBeenCalledTimes(1);
  });

  it('says when a hook timed out', async () => {
    const { service, dependencies } = createService(
      { hooks: [{ id: 'slow', event: 'agent.done', command: 'x', timeoutSeconds: 5 }] },
      { run: vi.fn().mockRejectedValue(new WorkspaceCommandError('timed out', true)) }
    );
    await service.fire(done);
    expect(dependencies.notify).toHaveBeenCalledWith(
      'Hook "slow" in hooks.json failed: timed out after 5 seconds'
    );
  });

  it('reports an unreadable file once, and runs no hooks from it', async () => {
    let content = '{';
    const { service, dependencies } = createService(undefined, { readFile: () => content });
    service.reload();
    expect(dependencies.notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.notify).mock.calls[0][0]).toMatch(
      /^hooks\.json is not valid JSON.*Its hooks don't run until it's fixed\.$/
    );

    content = JSON.stringify({ hooks: [{ id: 'ping', event: 'agent.done', command: 'x' }] });
    service.reload();
    await service.fire(done);
    expect(dependencies.run).toHaveBeenCalledTimes(1);
    expect(dependencies.notify).toHaveBeenCalledTimes(1);
  });
});

describe('publishAttentionHookEvent', () => {
  it.each([
    ['turn-complete', 'agent.done'],
    ['input-required', 'agent.needs-input'],
    ['error', 'agent.error'],
    ['idle', undefined],
    ['generic', undefined],
  ] as const)('publishes %s as %s', (kind, event) => {
    const published: HookEventDetails[] = [];
    const stop = onHookEvent((details) => published.push(details));
    const attention: WorkspaceAttention = {
      kind,
      source: 'codex',
      updatedAt: 1,
      terminalId: 'term-1',
      message: 'Needs approval',
    };
    publishAttentionHookEvent({ workspaceId: 'ws-1', attention, workspaceAttention: attention });
    stop();
    expect(published).toEqual(
      event
        ? [
            {
              event,
              workspaceId: 'ws-1',
              terminalId: 'term-1',
              agent: 'codex',
              message: 'Needs approval',
            },
          ]
        : []
    );
  });

  it("publishes nothing for a hook's own notification", () => {
    const published: HookEventDetails[] = [];
    const stop = onHookEvent((details) => published.push(details));
    const attention: WorkspaceAttention = { kind: 'error', source: 'hook', updatedAt: 1 };
    publishAttentionHookEvent({ workspaceId: 'ws-1', attention, workspaceAttention: attention });
    stop();
    expect(published).toEqual([]);
  });

  it('publishes nothing when a command run with `komla notify --` finishes', () => {
    const published: HookEventDetails[] = [];
    const stop = onHookEvent((details) => published.push(details));
    const attention: WorkspaceAttention = {
      kind: 'turn-complete',
      source: 'command',
      updatedAt: 1,
      terminalId: 'term-1',
    };
    publishAttentionHookEvent({ workspaceId: 'ws-1', attention, workspaceAttention: attention });
    stop();
    expect(published).toEqual([]);
  });
});
