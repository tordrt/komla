/* eslint-disable import/order -- Vitest's hoisted mocks must precede service imports. */
import { describe, expect, it, vi, type Mock } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

import {
  AutomationService,
  type AutomationServiceDependencies,
  type LocalAutomationStorage,
} from '../../../../src/main/services/automation/automation-service';

import type {
  AutomationHostClient,
  AutomationHostListing,
} from '../../../../src/main/services/automation/host-client';
import type { LocalAutomationState } from '../../../../src/main/services/automation/local-store';
import type {
  Automation,
  AutomationRun,
  HostAutomation,
  SaveAutomationParams,
} from '../../../../src/shared/types/automation';

const at = (iso: string) => Date.parse(iso);

function memoryStore(initial: Partial<LocalAutomationState> = {}): LocalAutomationStorage & {
  state: LocalAutomationState;
} {
  const state: LocalAutomationState = { automations: [], runs: {}, ...initial };
  const store = {
    state,
    read: () => store.state,
    saveAutomation: vi.fn(async (automation: Automation) => {
      store.state = {
        ...store.state,
        automations: [
          ...store.state.automations.filter((candidate) => candidate.id !== automation.id),
          automation,
        ],
      };
    }),
    deleteAutomation: vi.fn(async (id: string) => {
      store.state = {
        ...store.state,
        automations: store.state.automations.filter((automation) => automation.id !== id),
      };
    }),
    addRun: vi.fn(async (run: AutomationRun) => {
      store.state = {
        ...store.state,
        runs: {
          ...store.state.runs,
          [run.automationId]: [run, ...(store.state.runs[run.automationId] ?? [])],
        },
      };
    }),
  };
  return store;
}

function hostClient(overrides: Partial<Record<keyof AutomationHostClient, Mock>> = {}) {
  return {
    list: vi.fn(async () => ({ automations: [], runs: {}, scheduler: { available: true } })),
    save: vi.fn(async () => ({ available: true })),
    delete: vi.fn(async () => ({ available: true })),
    setEnabled: vi.fn(),
    run: vi.fn(),
    ...overrides,
  };
}

function localAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'nightly',
    name: 'Nightly deps',
    prompt: 'Update dependencies',
    projectId: 'project-1',
    target: { kind: 'local' },
    schedule: { cron: '0 9 * * *', timeZone: 'UTC' },
    enabled: true,
    missedRunGraceMinutes: 720,
    createdAt: at('2026-10-01T00:00:00Z'),
    updatedAt: at('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function hostAutomation(overrides: Partial<HostAutomation> = {}): HostAutomation {
  return {
    schema: 1,
    id: 'triage',
    name: 'Triage issues',
    prompt: 'Triage new issues',
    enabled: true,
    schedule: { cron: '0 8 * * 1-5', timeZone: 'Europe/Oslo' },
    missedRunGraceMinutes: 720,
    project: {
      remoteRepoPath: '/home/me/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/me/.komla/worktrees/app',
      gitUrl: 'git@github.com:me/app.git',
      projectName: 'app',
    },
    launch: { agentName: 'Codex', promptCommand: 'codex {{prompt}}', openCommand: 'codex' },
    createdAt: at('2026-10-01T00:00:00Z'),
    updatedAt: at('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function setup(
  options: {
    now?: string;
    store?: ReturnType<typeof memoryStore>;
    hosts?: ReturnType<typeof hostClient>;
    hostIds?: string[];
    hostIdsInUse?: string[];
    launchLocal?: Mock;
    projectOf?: (automation: HostAutomation) => string | undefined;
    projectGitSettings?: AutomationServiceDependencies['projectGitSettings'];
  } = {}
) {
  const now = at(options.now ?? '2026-10-15T09:00:20Z');
  let id = 0;
  const store = options.store ?? memoryStore();
  const launchLocal =
    options.launchLocal ??
    vi.fn(async () => ({ workspaceId: 'workspace-1', branch: 'nightly-deps-20261015-0900' }));
  const compileForHost = vi.fn(async (automation: Automation) =>
    hostAutomation({
      id: automation.id,
      name: automation.name,
      prompt: automation.prompt,
      enabled: automation.enabled,
      schedule: automation.schedule,
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
    })
  );
  const changed = vi.fn();
  const dependencies: AutomationServiceDependencies = {
    now: () => now,
    newId: () => `id-${++id}`,
    local: store,
    hosts: options.hosts ?? hostClient(),
    hostIds: () => options.hostIds ?? ['host-1'],
    hostIdsInUse: () => options.hostIdsInUse ?? [],
    launchLocal,
    compileForHost,
    resolveHostAutomations: async (_hostId, automations) =>
      automations.map((automation) => {
        const projectId = options.projectOf ? options.projectOf(automation) : 'project-1';
        return projectId ? { projectId } : {};
      }),
    projectGitSettings: options.projectGitSettings ?? (() => ({})),
    changed,
  };
  return { service: new AutomationService(dependencies), store, launchLocal, compileForHost, changed };
}

const saveParams = (overrides: Partial<SaveAutomationParams> = {}): SaveAutomationParams => ({
  name: 'Nightly deps',
  prompt: 'Update dependencies',
  projectId: 'project-1',
  target: { kind: 'local' },
  schedule: { cron: '0 9 * * *', timeZone: 'UTC' },
  enabled: true,
  missedRunGraceMinutes: 720,
  ...overrides,
});

describe('AutomationService', () => {
  it('starts a due local automation once and records the run', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    const { service, launchLocal, changed } = setup({ store });

    await service.tick();
    await service.tick();

    expect(launchLocal).toHaveBeenCalledTimes(1);
    expect(launchLocal).toHaveBeenCalledWith(store.state.automations[0], {
      trigger: 'schedule',
      scheduledFor: at('2026-10-15T09:00:00Z'),
      startedAt: at('2026-10-15T09:00:20Z'),
    });
    expect(store.state.runs.nightly).toEqual([
      {
        id: 'id-1',
        automationId: 'nightly',
        trigger: 'schedule',
        scheduledFor: at('2026-10-15T09:00:00Z'),
        startedAt: at('2026-10-15T09:00:20Z'),
        status: 'started',
        workspaceId: 'workspace-1',
        branch: 'nightly-deps-20261015-0900',
      },
    ]);
    expect(changed).toHaveBeenCalled();
  });

  it('records a run missed for longer than the grace instead of starting it', async () => {
    const store = memoryStore({ automations: [localAutomation({ missedRunGraceMinutes: 30 })] });
    const { service, launchLocal } = setup({ store, now: '2026-10-15T11:00:00Z' });

    await service.tick();

    expect(launchLocal).not.toHaveBeenCalled();
    expect(store.state.runs.nightly).toEqual([
      expect.objectContaining({
        status: 'skipped',
        scheduledFor: at('2026-10-15T09:00:00Z'),
        message: expect.stringContaining('Missed'),
      }),
    ]);
  });

  it('records why a run failed to start, and does not retry it', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    const launchLocal = vi.fn(async () => {
      throw new Error('Its project is no longer in Komla.');
    });
    const { service } = setup({ store, launchLocal });

    await service.tick();
    await service.tick();

    expect(launchLocal).toHaveBeenCalledTimes(1);
    expect(store.state.runs.nightly).toEqual([
      expect.objectContaining({ status: 'failed', message: 'Its project is no longer in Komla.' }),
    ]);
  });

  it('doesn’t start an automation turned off while an earlier one in the tick was starting', async () => {
    const store = memoryStore({
      automations: [localAutomation(), localAutomation({ id: 'triage', name: 'Triage' })],
    });
    const launchLocal = vi.fn(async (automation: Automation) => {
      store.state = {
        ...store.state,
        automations: store.state.automations.map((candidate) =>
          candidate.id === 'triage' ? { ...candidate, enabled: false } : candidate
        ),
      };
      return { workspaceId: `workspace-${automation.id}` };
    });
    const { service } = setup({ store, launchLocal });

    await service.tick();

    expect(launchLocal).toHaveBeenCalledTimes(1);
    expect(launchLocal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nightly' }),
      expect.anything()
    );
  });

  it('runs one tick at a time', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    let finish: (value: { workspaceId: string }) => void = () => {};
    const launchLocal = vi.fn(
      () =>
        new Promise<{ workspaceId: string }>((resolve) => {
          finish = resolve;
        })
    );
    const { service } = setup({ store, launchLocal });

    const first = service.tick();
    const second = service.tick();
    finish({ workspaceId: 'workspace-1' });
    await Promise.all([first, second]);

    expect(launchLocal).toHaveBeenCalledTimes(1);
  });

  it('starts a manual run without counting it as the scheduled one', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    const { service } = setup({ store, now: '2026-10-15T08:00:00Z' });

    const run = await service.runNow({ kind: 'local' }, 'nightly');
    expect(run).toMatchObject({ trigger: 'manual', status: 'started' });
    expect(run.scheduledFor).toBeUndefined();

    const later = setup({ store, now: '2026-10-15T09:00:30Z' });
    await later.service.tick();
    expect(later.launchLocal).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid schedule or an empty prompt', async () => {
    const { service } = setup();

    await expect(
      service.save(saveParams({ schedule: { cron: '0 25 * * *', timeZone: 'UTC' } }))
    ).rejects.toThrow('hour');
    await expect(
      service.save(saveParams({ schedule: { cron: '0 9 * * *', timeZone: 'Nowhere/Land' } }))
    ).rejects.toThrow('time zone');
    await expect(service.save(saveParams({ prompt: '   ' }))).rejects.toThrow('prompt');
  });

  it('keeps when an edited automation was created', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    const { service } = setup({ store });

    const saved = await service.save(saveParams({ id: 'nightly', name: 'Renamed' }));

    expect(saved).toMatchObject({
      id: 'nightly',
      name: 'Renamed',
      createdAt: at('2026-10-01T00:00:00Z'),
      updatedAt: at('2026-10-15T09:00:20Z'),
    });
  });

  it('keeps the branch an automation starts from', async () => {
    const { service, store } = setup();

    await service.save(saveParams({ startBranch: 'release/1.x' }));

    expect(store.state.automations[0]?.startBranch).toBe('release/1.x');
  });

  it('saves an SSH automation on its host and moves it off this computer', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    const hosts = hostClient();
    const { service, compileForHost } = setup({ store, hosts });

    await service.save(
      saveParams({
        id: 'nightly',
        previousTarget: { kind: 'local' },
        target: { kind: 'ssh', hostId: 'host-1' },
      })
    );

    expect(compileForHost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nightly', target: { kind: 'ssh', hostId: 'host-1' } })
    );
    expect(hosts.save).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({ id: 'nightly', schema: 1 })
    );
    expect(store.state.automations).toEqual([]);
  });

  it('keeps an automation where it was when its new host refuses it', async () => {
    const store = memoryStore({ automations: [localAutomation()] });
    const hosts = hostClient({
      save: vi.fn(async () => {
        throw new Error('Start one workspace for this project on this host first.');
      }),
    });
    const { service } = setup({ store, hosts });

    await expect(
      service.save(
        saveParams({
          id: 'nightly',
          previousTarget: { kind: 'local' },
          target: { kind: 'ssh', hostId: 'host-1' },
        })
      )
    ).rejects.toThrow('Start one workspace');
    expect(store.state.automations).toHaveLength(1);
  });

  it('leaves an automation on its SSH host when it can’t be removed from there', async () => {
    const hosts = hostClient({
      list: vi.fn(async () => ({
        automations: [hostAutomation({ id: 'nightly' })],
        runs: {},
        scheduler: { available: true },
      })),
      delete: vi.fn(async () => {
        throw new Error('Could not delete the automation on the SSH host: timed out');
      }),
    });
    const store = memoryStore();
    const { service } = setup({ store, hosts });
    await service.refreshHost('host-1');

    await expect(
      service.save(
        saveParams({
          id: 'nightly',
          previousTarget: { kind: 'ssh', hostId: 'host-1' },
          target: { kind: 'local' },
        })
      )
    ).rejects.toThrow("It wasn't moved");

    expect(store.state.automations).toEqual([]);
    const [, host] = await service.list();
    expect(host?.automations.map((automation) => automation.id)).toEqual(['nightly']);
  });

  it('doesn’t bring back an automation deleted while its host was being read', async () => {
    const listing = (automations: HostAutomation[]): AutomationHostListing => ({
      automations,
      runs: {},
      scheduler: { available: true },
    });
    let finishRead: (listing: AutomationHostListing) => void = () => {};
    const list = vi
      .fn<AutomationHostClient['list']>()
      .mockResolvedValueOnce(listing([hostAutomation()]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          })
      )
      .mockResolvedValue(listing([]));
    const { service } = setup({ hosts: hostClient({ list }) });
    await service.refreshHost('host-1');

    const slowRead = service.refreshHost('host-1');
    await service.delete({ kind: 'ssh', hostId: 'host-1' }, 'triage');
    finishRead(listing([hostAutomation()]));
    await slowRead;

    const [, host] = await service.list();
    expect(host?.automations).toEqual([]);
  });

  it('shows why this computer’s automations couldn’t be read', async () => {
    const error = 'A newer version of Komla saved the automations on this computer.';
    const { service } = setup({ store: memoryStore({ error }) });

    const [local] = await service.list();

    expect(local).toMatchObject({ target: { kind: 'local' }, automations: [], error });
  });

  it('lists host automations, and the last ones read while the host is unreachable', async () => {
    const list = vi
      .fn<AutomationHostClient['list']>()
      .mockResolvedValueOnce({
        automations: [hostAutomation()],
        runs: { triage: [] },
        scheduler: { available: true },
      })
      .mockRejectedValueOnce(new Error('ssh: connect to host timed out'));
    const { service, changed } = setup({ hosts: hostClient({ list }) });

    const [, loading] = await service.list();
    expect(loading).toMatchObject({ loading: true, automations: [] });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    const [, first] = await service.list();
    expect(first).toMatchObject({
      target: { kind: 'ssh', hostId: 'host-1' },
      automations: [
        {
          id: 'triage',
          projectId: 'project-1',
          projectName: 'app',
          agentName: 'Codex',
          target: { kind: 'ssh', hostId: 'host-1' },
        },
      ],
    });
    expect(first?.error).toBeUndefined();

    await service.refreshHost('host-1');
    const [, second] = await service.list();
    expect(second?.error).toBe('ssh: connect to host timed out');
    expect(second?.automations.map((automation) => automation.id)).toEqual(['triage']);
  });

  it('lists the branch a host automation starts from', async () => {
    const hosts = hostClient({
      list: vi.fn(async () => ({
        automations: [hostAutomation({ startBranch: 'release/1.x' })],
        runs: {},
        scheduler: { available: true },
      })),
    });
    const { service } = setup({ hosts });
    await service.refreshHost('host-1');

    const [, host] = await service.list();

    expect(host?.automations[0]?.startBranch).toBe('release/1.x');
  });

  it('saves a project’s host automations again with its new target branch and prefix', async () => {
    const follows = hostAutomation({ id: 'follows' });
    // Runs start from release, but still target the project's branch.
    const pinned = hostAutomation({ id: 'pinned', startBranch: 'release/1.x' });
    const current = hostAutomation({
      id: 'current',
      project: { ...follows.project, baseBranch: 'develop', branchPrefix: 'me/' },
    });
    const other = hostAutomation({ id: 'other' });
    const hosts = hostClient({
      list: vi.fn(async () => ({
        automations: [follows, pinned, current, other],
        runs: {},
        scheduler: { available: true },
      })),
    });
    const { service, changed } = setup({
      hosts,
      projectOf: (automation) => (automation.id === 'other' ? 'project-2' : 'project-1'),
      projectGitSettings: () => ({ baseBranch: 'develop', branchPrefix: 'me/' }),
    });

    await service.retargetProject('project-1');

    const project = { ...follows.project, baseBranch: 'develop', branchPrefix: 'me/' };
    expect(hosts.save.mock.calls).toEqual([
      ['host-1', { ...follows, project }],
      ['host-1', { ...pinned, project }],
    ]);
    expect(changed).toHaveBeenCalled();
  });

  it('drops the target branch of a project’s host automations when the project has none', async () => {
    const automation = hostAutomation({
      project: { ...hostAutomation().project, baseBranch: 'develop' },
    });
    const hosts = hostClient({
      list: vi.fn(async () => ({ automations: [automation], runs: {}, scheduler: { available: true } })),
    });
    const { service } = setup({ hosts });

    await service.retargetProject('project-1');

    expect(hosts.save).toHaveBeenCalledWith('host-1', hostAutomation());
  });

  it('saves a host’s automations with the new target once the host can be read again', async () => {
    const list = vi
      .fn<AutomationHostClient['list']>()
      .mockResolvedValueOnce({
        automations: [hostAutomation()],
        runs: {},
        scheduler: { available: true },
      })
      .mockRejectedValueOnce(new Error('ssh: connect to host timed out'))
      .mockResolvedValue({
        automations: [hostAutomation()],
        runs: {},
        scheduler: { available: true },
      });
    const hosts = hostClient({ list });
    const { service } = setup({ hosts, projectGitSettings: () => ({ baseBranch: 'develop' }) });
    await service.refreshHost('host-1');

    // Not from the listing read before the host went away, which may be out of date.
    await service.retargetProject('project-1');
    expect(hosts.save).not.toHaveBeenCalled();

    await service.refreshHost('host-1');
    await vi.waitFor(() =>
      expect(hosts.save).toHaveBeenCalledWith(
        'host-1',
        hostAutomation({ project: { ...hostAutomation().project, baseBranch: 'develop' } })
      )
    );
    expect(hosts.save).toHaveBeenCalledTimes(1);
  });

  it('saves the target that is current when changes follow each other quickly', async () => {
    let target = 'develop';
    const hosts = hostClient({
      list: vi.fn(async () => ({
        automations: [hostAutomation()],
        runs: {},
        scheduler: { available: true },
      })),
    });
    const { service } = setup({ hosts, projectGitSettings: () => ({ baseBranch: target }) });

    const first = service.retargetProject('project-1');
    target = 'trunk';
    await Promise.all([first, service.retargetProject('project-1')]);

    const saved = hosts.save.mock.calls.map(([, automation]) => automation.project.baseBranch);
    expect(saved.at(-1)).toBe('trunk');
  });

  it('reads only the hosts with workspaces here when asked to', async () => {
    const list = vi.fn<AutomationHostClient['list']>(async () => ({
      automations: [],
      runs: {},
      scheduler: { available: true },
    }));
    const { service } = setup({
      hosts: hostClient({ list }),
      hostIds: ['host-1', 'host-2'],
      hostIdsInUse: ['host-2'],
    });

    const snapshots = await service.list({ readHosts: 'in-use' });

    expect(list.mock.calls).toEqual([['host-2']]);
    expect(snapshots.map((snapshot) => snapshot.target)).toEqual([
      { kind: 'local' },
      { kind: 'ssh', hostId: 'host-1' },
      { kind: 'ssh', hostId: 'host-2' },
    ]);
  });

  it('reads every host again before listing for a caller that changes them', async () => {
    const list = vi
      .fn<AutomationHostClient['list']>()
      .mockResolvedValueOnce({ automations: [], runs: {}, scheduler: { available: true } })
      .mockResolvedValueOnce({
        automations: [hostAutomation()],
        runs: {},
        scheduler: { available: true },
      });
    const { service } = setup({ hosts: hostClient({ list }) });
    await service.refreshHost('host-1');

    const [, host] = await service.listCurrent();

    expect(list).toHaveBeenCalledTimes(2);
    expect(host?.loading).toBeUndefined();
    expect(host?.automations.map((automation) => automation.id)).toEqual(['triage']);
  });

  it('stops waiting for a slow host after waitMs and shows it as still being read', async () => {
    const list = vi.fn<AutomationHostClient['list']>(() => new Promise(() => {}));
    const { service } = setup({ hosts: hostClient({ list }) });

    const [, host] = await service.listCurrent({ waitMs: 10 });

    expect(list).toHaveBeenCalledTimes(1);
    expect(host?.loading).toBe(true);
  });

  it('turns a host automation off on the host, keeping edits made elsewhere', async () => {
    const hosts = hostClient({
      list: vi.fn(async () => ({
        automations: [hostAutomation()],
        runs: {},
        scheduler: { available: true },
      })),
      setEnabled: vi.fn(async () => ({
        automation: hostAutomation({ prompt: 'Edited on another device', enabled: false }),
        scheduler: { available: true },
      })),
    });
    const { service, compileForHost } = setup({ hosts });
    await service.refreshHost('host-1');

    await service.setEnabled({ kind: 'ssh', hostId: 'host-1' }, 'triage', false);

    expect(compileForHost).not.toHaveBeenCalled();
    expect(hosts.save).not.toHaveBeenCalled();
    expect(hosts.setEnabled).toHaveBeenCalledWith('host-1', 'triage', false);
    const [, host] = await service.list();
    expect(host?.automations[0]).toMatchObject({
      enabled: false,
      prompt: 'Edited on another device',
    });
  });
});
