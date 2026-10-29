import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SshWorkspaceSync,
  type SshWorkspaceSyncDependencies,
  type SshWorkspacePlacement,
  type SshWorkspaceRepository,
  type SshWorkspaceSyncHost,
  type SshWorkspaceSyncStore,
} from '../../../src/main/services/ssh-workspace-sync/ssh-workspace-sync';
import {
  buildSshWorkspaceManifest,
  mergeSshWorkspaceManifest,
  parseSshWorkspaceManifest,
  sshWorkspaceManifestContentKey,
  sshWorkspaceManifestSyncedFieldsEqual,
} from '../../../src/main/services/ssh-workspace-sync/workspace-manifest';

import type { Terminal, Workspace } from '../../../src/shared/types';
import type { SshWorkspaceManifest } from '../../../src/shared/types/ssh-workspace-manifest';
import type { WorkspaceStatus } from '../../../src/shared/types/workspace';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function terminal(id: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    id,
    name: `Agent ${id}`,
    status: 'running',
    createdAt: 1,
    executionLocation: 'workspace',
    remoteSessionResumable: true,
    ...overrides,
  } as Terminal;
}

function sshWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-42',
    name: 'fix-login-redirect',
    workingDirectory: 'ssh://host-a/home/dev/.komla/worktrees/app/fix-login-redirect',
    backend: {
      kind: 'ssh',
      hostId: 'host-a',
      remoteDirectory: '/home/dev/.komla/worktrees/app/fix-login-redirect',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:acme/app.git',
      projectId: 'local-project',
      projectName: 'app',
      branchName: 'fix-login-redirect',
      baseBranch: 'main',
    },
    branchName: 'fix-login-redirect',
    isWorktree: true,
    projectId: 'local-project',
    repoName: 'app',
    terminals: [terminal('t1'), terminal('t2')],
    primaryTerminalId: 't1',
    terminalLayout: { activeTab: 't1', tabs: ['t1'], layouts: {} },
    windowId: null,
    categoryId: null,
    createdAt: 100,
    lastActivityAt: 200,
    order: 0,
    status: 'active',
    ...overrides,
  } as Workspace;
}

type OnHost = Awaited<ReturnType<SshWorkspaceSyncHost['inspect']>>;

/** Workspaces held in memory, changed the way workspaceService changes them. */
function memoryStore(workspaces: Map<string, Workspace>) {
  return {
    workspaces: () => workspaces.values(),
    get: (workspaceId: string) => workspaces.get(workspaceId),
    isDeleting: vi.fn((_workspaceId: string) => false),
    projectLookup: vi.fn(
      async () =>
        (_repository: SshWorkspaceRepository): string | null =>
          null
    ),
    add: vi.fn(
      (hostId: string, manifest: SshWorkspaceManifest, placement: SshWorkspacePlacement) => {
        const workspace = sshWorkspace({
          id: manifest.workspaceId,
          name: manifest.name,
          backend: { kind: 'ssh', hostId, ...manifest.backend },
          terminals: manifest.terminals.map((entry) => terminal(entry.id, { name: entry.name })),
          projectId: placement.projectId,
          status: manifest.status ?? 'active',
        });
        workspaces.set(workspace.id, workspace);
        return workspace;
      }
    ),
    deleteHere: vi.fn(async (workspaceId: string) => {
      workspaces.delete(workspaceId);
    }),
    hostSynced: vi.fn(async (_hostId: string) => undefined),
    applyMerged: vi.fn((workspaceId: string, merged: SshWorkspaceManifest) => {
      const workspace = workspaces.get(workspaceId)!;
      workspace.name = merged.name;
      workspace.customName = merged.customName;
      workspace.customDescription = merged.customDescription;
      workspace.customNameSource = merged.customNameSource;
      const added: string[] = [];
      for (const entry of merged.terminals) {
        const existing = workspace.terminals.find((candidate) => candidate.id === entry.id);
        if (existing) {
          existing.name = entry.name;
          continue;
        }
        workspace.terminals.push(terminal(entry.id, { name: entry.name }));
        added.push(entry.id);
      }
      workspace.terminalLayout = merged.terminalLayout;
      return added;
    }),
    changeStatus: vi.fn(async (workspaceId: string, status: WorkspaceStatus) => {
      workspaces.get(workspaceId)!.status = status;
    }),
    removeTerminal: vi.fn(async (workspaceId: string, terminalId: string) => {
      const workspace = workspaces.get(workspaceId)!;
      workspace.terminals = workspace.terminals.filter((entry) => entry.id !== terminalId);
    }),
    save: vi.fn(),
    changed: vi.fn(),
    layoutChanged: vi.fn(),
    markMissing: vi.fn(),
    markFound: vi.fn(),
    removeDeletedElsewhere: vi.fn(async (workspaceId: string) => {
      workspaces.delete(workspaceId);
    }),
  } satisfies SshWorkspaceSyncStore;
}

function service(
  write = vi.fn(async (): Promise<boolean> => true),
  saved?: SshWorkspaceSyncDependencies['hostCopies']
) {
  const inspect = vi.fn(async (): Promise<OnHost> => ({ state: 'present' }));
  const del = vi.fn(async () => undefined);
  const read = vi.fn(async (): Promise<string[]> => []);
  const findTerminalSessions = vi.fn(async (): Promise<Set<string>> => new Set());
  const removeOrphaned = vi.fn(async () => undefined);
  const hasHost = vi.fn(() => true);
  const readyHosts = vi.fn(() => ['host-a']);
  const basePath = vi.fn(async () => '/home/dev/.komla');
  const workspaces = new Map<string, Workspace>();
  const store = memoryStore(workspaces);
  const syncsWith = vi.fn((_hostId: string) => true);
  const inUse = vi.fn(() => true);
  let now = 1_000;
  return {
    inspect,
    write,
    del,
    read,
    findTerminalSessions,
    removeOrphaned,
    hasHost,
    readyHosts,
    store,
    syncsWith,
    inUse,
    /** Holds these workspaces here, as workspaceService would. */
    hold: (...held: Workspace[]) =>
      held.forEach((workspace) => workspaces.set(workspace.id, workspace)),
    tick: () => (now += 1),
    advance: (ms: number) => (now += ms),
    manifests: new SshWorkspaceSync({
      host: {
        inspect,
        write,
        delete: del,
        read,
        findTerminalSessions,
        removeOrphaned,
        hasHost,
        readyHosts,
        basePath,
      },
      store,
      now: () => now,
      deviceId: () => 'this-device',
      syncsWith,
      hostCopies: saved,
      inUse,
    }),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('SSH workspace manifest', () => {
  it('describes only portable state and resumable remote terminals', () => {
    const manifest = buildSshWorkspaceManifest(
      sshWorkspace({
        terminals: [
          terminal('t1'),
          terminal('mirror', { executionLocation: 'local-mirror' }),
          terminal('plain', { remoteSessionResumable: false }),
        ],
      }),
      5
    );

    expect(manifest?.terminals.map((entry) => entry.id)).toEqual(['t1']);
    expect(manifest?.backend).not.toHaveProperty('hostId');
    expect(manifest?.backend).not.toHaveProperty('projectId');
    expect(manifest).not.toHaveProperty('projectId');
    expect(manifest?.updatedAt).toBe(5);
  });

  it('has no manifest for local or still-provisioning workspaces', () => {
    expect(buildSshWorkspaceManifest(sshWorkspace({ backend: { kind: 'local' } }), 1)).toBe(
      undefined
    );
    expect(buildSshWorkspaceManifest(sshWorkspace({ provisioning: true }), 1)).toBe(undefined);
  });

  it('round-trips a manifest and rejects untrusted content', () => {
    const manifest = buildSshWorkspaceManifest(sshWorkspace(), 5, {
      agentName: 'Claude Code',
      promptCommand: 'claude {{prompt}}',
      openCommand: 'claude',
    })!;

    expect(parseSshWorkspaceManifest(JSON.stringify(manifest))).toEqual(
      JSON.parse(JSON.stringify(manifest))
    );
    expect(parseSshWorkspaceManifest('{not json')).toBe(undefined);
    expect(
      parseSshWorkspaceManifest(JSON.stringify({ ...manifest, workspaceId: '../escape' }))
    ).toBe(undefined);
    expect(
      parseSshWorkspaceManifest(
        JSON.stringify({ ...manifest, terminals: [{ id: 'bad id', name: 'x', createdAt: 1 }] })
      )
    ).toBe(undefined);
    expect(parseSshWorkspaceManifest(JSON.stringify({ ...manifest, schema: 2 }))).toBe(undefined);
    expect(
      parseSshWorkspaceManifest(JSON.stringify({ ...manifest, sourceWorkspaceId: '../escape' }))
    ).toBe(undefined);
  });

  it('identifies the same content however its keys are ordered', () => {
    const manifest = buildSshWorkspaceManifest(
      sshWorkspace({ terminalLayout: { tabs: ['t1'], layouts: {}, activeTab: 't1' } }),
      5
    )!;

    expect(
      sshWorkspaceManifestContentKey(parseSshWorkspaceManifest(JSON.stringify(manifest))!)
    ).toBe(sshWorkspaceManifestContentKey(manifest));
  });
});

describe('mergeSshWorkspaceManifest', () => {
  const leaf = (terminalId: string, id = `pane-${terminalId}`) => ({
    type: 'leaf',
    id,
    terminalId,
  });
  const layout = (...tabs: string[]) => ({
    activeTab: tabs[0],
    tabs,
    layouts: Object.fromEntries(tabs.map((tab) => [tab, leaf(tab)])),
  });
  const split = (first: string, second: string) => ({
    type: 'split',
    id: `split-${first}-${second}`,
    direction: 'vertical',
    children: [leaf(first), leaf(second)],
    sizes: [700, 300],
  });
  const withTerminal = (manifest: SshWorkspaceManifest, id: string) => ({
    ...manifest,
    terminals: [...manifest.terminals, { id, name: 'Codex', createdAt: 3 }],
  });
  // Written by a device that syncs, so others merge its copies.
  const base = buildSshWorkspaceManifest(
    sshWorkspace({ terminalLayout: layout('t1', 't2') }),
    1,
    undefined,
    'other-device',
    true
  )!;
  const merge = (...args: Parameters<typeof mergeSshWorkspaceManifest>) =>
    mergeSshWorkspaceManifest(...args).manifest;

  it('takes what the other device changed and keeps what changed here', () => {
    const local = { ...base, customDescription: 'Edited here' };
    const remote = { ...base, customName: 'Renamed there', status: 'trashed' as const };

    expect(merge(base, local, remote)).toMatchObject({
      customName: 'Renamed there',
      customDescription: 'Edited here',
      status: 'trashed',
    });
  });

  it("keeps whether a name was generated with the name, so a rename elsewhere isn't regenerated", () => {
    const generated = { ...base, customName: 'Fix login', customNameSource: 'generated' as const };
    const renamed = { ...generated, customName: 'Login fix', customNameSource: 'manual' as const };

    expect(merge(generated, generated, renamed)).toMatchObject({
      customName: 'Login fix',
      customNameSource: 'manual',
    });
    expect(merge(generated, { ...renamed, customName: 'Mine' }, generated)).toMatchObject({
      customName: 'Mine',
      customNameSource: 'manual',
    });
  });

  it('ignores a status the other device did not write', () => {
    const local = { ...base, status: 'trashed' as const };
    const remote = { ...base, status: undefined };

    expect(merge(base, local, remote).status).toBe('trashed');
  });

  it('settles on active when the base has no status to tell a change from an old difference', () => {
    const before = { ...base, status: undefined };
    const trashed = { ...base, status: 'trashed' as const };
    const active = { ...base, status: 'active' as const };

    expect(merge(before, active, trashed).status).toBe('active');
    expect(merge(before, trashed, active).status).toBe('active');
  });

  it('adds tabs the other device opened, applies renames and keeps tabs closed here closed', () => {
    const local = {
      ...base,
      terminals: base.terminals.filter((terminal) => terminal.id !== 't2'),
      terminalLayout: layout('t1'),
    };
    const remote = {
      ...withTerminal(base, 't3'),
      terminals: [
        { ...base.terminals[0]!, name: 'Reviewer' },
        base.terminals[1]!,
        { id: 't3', name: 'Codex', createdAt: 3 },
      ],
      terminalLayout: layout('t3', 't1', 't2'),
    };

    const { manifest: merged, arranged } = mergeSshWorkspaceManifest(base, local, remote);

    expect(merged.terminals.map((terminal) => [terminal.id, terminal.name])).toEqual([
      ['t1', 'Reviewer'],
      ['t3', 'Codex'],
    ]);
    // Its tabs keep the place it gave them, without the one closed here.
    expect(arranged).toBe(true);
    expect(merged.terminalLayout).toEqual({
      activeTab: 't1',
      tabs: ['t3', 't1'],
      layouts: { t3: leaf('t3'), t1: leaf('t1') },
    });
  });

  it('takes the tabs and panes the other device arranged, keeping the tab shown here', () => {
    const local = { ...base, terminalLayout: { ...layout('t1', 't2'), activeTab: 't2' } };
    const reordered = { ...base, terminalLayout: layout('t2', 't1') };
    const combined = {
      ...base,
      terminalLayout: { tabs: ['t1'], layouts: { t1: split('t1', 't2') } },
    };

    expect(merge(base, local, reordered).terminalLayout).toEqual({
      activeTab: 't2',
      tabs: ['t2', 't1'],
      layouts: { t2: leaf('t2'), t1: leaf('t1') },
    });
    // The tab shown here is gone, so the window picks one.
    expect(merge(base, local, combined).terminalLayout).toEqual({
      tabs: ['t1'],
      layouts: { t1: split('t1', 't2') },
    });
  });

  it('takes the arrangement of a device that rearranged when there is no layout here yet', () => {
    const local = { ...base, terminalLayout: undefined };
    const reordered = { ...base, terminalLayout: layout('t2', 't1') };

    expect(merge(base, local, reordered).terminalLayout).toEqual({
      tabs: ['t2', 't1'],
      layouts: { t2: leaf('t2'), t1: leaf('t1') },
    });
  });

  it('keeps an arrangement made here that the other device has not seen, adding its new tab', () => {
    const local = { ...base, terminalLayout: layout('t2', 't1') };
    const remote = { ...withTerminal(base, 't3'), terminalLayout: layout('t1', 't2', 't3') };

    expect(mergeSshWorkspaceManifest(base, local, remote)).toEqual({
      manifest: expect.objectContaining({
        terminalLayout: {
          activeTab: 't2',
          tabs: ['t2', 't1', 't3'],
          layouts: { t2: leaf('t2'), t1: leaf('t1'), t3: leaf('t3') },
        },
      }),
      arranged: false,
    });
  });

  it('adds a tab the other device has not placed yet, e.g. opened moments before it wrote', () => {
    const remote = withTerminal(base, 't3');

    expect(merge(base, base, remote).terminalLayout).toEqual({
      activeTab: 't1',
      tabs: ['t1', 't2', 't3'],
      layouts: { t1: leaf('t1'), t2: leaf('t2'), t3: leaf('t3') },
    });
    // Once it places the tab, the place it chose wins over the one given here.
    const placed = {
      ...remote,
      terminalLayout: { tabs: ['t1', 't2'], layouts: { t1: split('t1', 't3'), t2: leaf('t2') } },
    };
    const local = merge(base, base, remote);
    expect(merge(remote, local, placed).terminalLayout).toEqual({
      activeTab: 't1',
      tabs: ['t1', 't2'],
      layouts: { t1: split('t1', 't3'), t2: leaf('t2') },
    });
  });

  it("keeps this device's own panes, and leaves out the other device's, when taking its layout", () => {
    // `mirror` runs on this device, e.g. in a Local copy; `their-shell` only on the other.
    const local = {
      ...base,
      terminalLayout: {
        activeTab: 't1',
        tabs: ['t1', 't2'],
        layouts: { t1: split('t1', 'mirror'), t2: leaf('t2') },
      },
    };
    const remote = {
      ...base,
      terminalLayout: {
        tabs: ['t2', 'their-shell'],
        layouts: { t2: split('t2', 't1'), 'their-shell': leaf('their-shell') },
      },
    };

    expect(merge(base, local, remote).terminalLayout).toEqual({
      tabs: ['t2', 'mirror'],
      layouts: { t2: split('t2', 't1'), mirror: leaf('mirror') },
    });
  });

  it("does not take a layout that changed only in the other device's own panes or pane ids", () => {
    const theirs = (...extra: string[]) => ({
      ...base,
      terminalLayout: {
        tabs: ['t1', 't2', ...extra],
        layouts: {
          t1: leaf('t1', 'their-pane-1'),
          t2: leaf('t2', 'their-pane-2'),
          ...Object.fromEntries(extra.map((tab) => [tab, leaf(tab)])),
        },
      },
    });

    expect(mergeSshWorkspaceManifest(base, base, theirs('their-shell'))).toEqual({
      manifest: expect.objectContaining({ terminalLayout: layout('t1', 't2') }),
      arranged: false,
    });
  });

  it('keeps the layout here over one from a device that predates layout sync', () => {
    const remote = { ...base, syncsLayout: undefined, terminalLayout: layout('t2', 't1') };

    expect(merge(base, base, remote).terminalLayout).toEqual(layout('t1', 't2'));
    expect(sshWorkspaceManifestSyncedFieldsEqual(base, remote)).toBe(true);
  });

  it('compares only the fields devices reconcile', () => {
    const remote = {
      ...base,
      terminalLayout: { ...layout('t1', 't2'), activeTab: 't2' },
      launch: undefined,
      status: undefined,
    };
    const local = {
      ...base,
      terminals: [...base.terminals].reverse(),
      status: 'active' as const,
      launch: { agentName: 'Claude', promptCommand: 'claude {{prompt}}', openCommand: 'claude' },
    };

    expect(sshWorkspaceManifestSyncedFieldsEqual(local, remote)).toBe(true);
    expect(sshWorkspaceManifestSyncedFieldsEqual({ ...local, name: 'other' }, remote)).toBe(false);
  });

  it('compares how tabs and panes are arranged, not pane ids or panes one device has alone', () => {
    const withOwnPane = {
      ...base,
      terminalLayout: {
        ...layout('t1', 't2'),
        tabs: ['t1', 't2', 'mirror'],
        layouts: { t1: leaf('t1', 'mine-1'), t2: leaf('t2'), mirror: leaf('mirror') },
      },
    };
    // The other device has not placed t3 yet; this one gave it a tab.
    const unplaced = withTerminal(base, 't3');
    const placedHere = { ...unplaced, terminalLayout: layout('t1', 't2', 't3') };

    expect(sshWorkspaceManifestSyncedFieldsEqual(withOwnPane, base)).toBe(true);
    expect(sshWorkspaceManifestSyncedFieldsEqual(placedHere, unplaced)).toBe(true);
    expect(
      sshWorkspaceManifestSyncedFieldsEqual({ ...base, terminalLayout: layout('t2', 't1') }, base)
    ).toBe(false);
  });
});

describe('SshWorkspaceSync', () => {
  const fromOtherDevice = (workspace: Workspace, changes: Partial<Workspace> = {}, syncs = true) =>
    JSON.stringify(
      buildSshWorkspaceManifest(
        { ...workspace, ...changes },
        9_999,
        undefined,
        'other-device',
        syncs
      )
    );

  it('syncs a host where a workspace is expected now and again shortly after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manifests, read, advance } = service();

    manifests.expectWorkspace('host-a');
    manifests.expectWorkspace('host-a');
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not contact hosts for workspaces restored at startup', async () => {
    const { manifests, inspect, write } = service();
    const workspace = sshWorkspace();

    manifests.restored([workspace]);
    manifests.saved([workspace]);
    await flush();

    expect(inspect).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes only when content another device needs changes', async () => {
    const { manifests, write, tick } = service();
    const workspace = sshWorkspace();

    manifests.saved([workspace]);
    tick();
    manifests.saved([{ ...workspace, lastActivityAt: 999, agentActive: true }]);
    manifests.saved([{ ...workspace, name: 'renamed' }]);
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ hostId: 'host-a' });
    expect(write.mock.calls[0]?.[1]).toBe('ws-42');
    expect(JSON.parse(String(write.mock.calls[1]?.[2]))).toMatchObject({
      name: 'renamed',
      writtenBy: 'this-device',
    });
  });

  describe("the agent's title", () => {
    const titled = (title: string, overrides: Partial<Workspace> = {}) =>
      sshWorkspace({
        terminals: [terminal('t1', { dynamicTitle: title }), terminal('t2')],
        ...overrides,
      });
    const written = (write: ReturnType<typeof vi.fn>) =>
      write.mock.calls.map((call) => JSON.parse(String(call[2])).agentTitle);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is written at once the first time, then at most every few minutes', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { manifests, write, advance, hold } = service();
      manifests.saved([titled('Login redirect')]);
      await flush();
      advance(60_000);
      const renamed = titled('Login redirect loop');
      hold(renamed);
      manifests.saved([renamed]);
      await flush();

      expect(written(write)).toEqual(['Login redirect']);

      advance(4 * 60_000);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await flush();

      expect(written(write)).toEqual(['Login redirect', 'Login redirect loop']);
    });

    it("keeps another device's title when this one has none", async () => {
      const { manifests, inspect, write, hold } = service();
      const workspace = sshWorkspace();
      const theirs = JSON.parse(fromOtherDevice(workspace, { customDescription: 'There' }));
      inspect.mockResolvedValue({
        state: 'present',
        manifest: JSON.stringify({ ...theirs, agentTitle: 'Stripe webhook retries' }),
      });
      hold(workspace);

      manifests.saved([workspace]);
      await flush();
      // Renamed here after taking the other device's copy, so this device writes next.
      manifests.saved([{ ...workspace, name: 'renamed-here' }]);
      await flush();

      expect(written(write)).toEqual(['Stripe webhook retries']);
    });

    it('leaves the manifest once the agent no longer sets one', async () => {
      const { manifests, write, advance } = service();
      manifests.saved([titled('Login redirect')]);
      await flush();
      advance(5 * 60_000);
      manifests.saved([sshWorkspace()]);
      await flush();

      expect(written(write)).toEqual(['Login redirect', undefined]);
    });

    it("takes another device's newer title over its own older one", async () => {
      const { manifests, inspect, write, hold } = service();
      const workspace = titled('Login redirect');
      manifests.saved([workspace]);
      await flush();
      const theirs = JSON.parse(fromOtherDevice(workspace, { customDescription: 'There' }));
      inspect.mockResolvedValue({
        state: 'present',
        manifest: JSON.stringify({ ...theirs, agentTitle: 'Stripe webhook retries' }),
      });
      const renamed = { ...workspace, name: 'renamed-here' };
      hold(renamed);

      manifests.saved([renamed]);
      await flush();
      manifests.saved([renamed]);
      await flush();

      expect(written(write)).toEqual(['Login redirect', 'Stripe webhook retries']);
    });

    it("keeps another device's title after a restart until the agent here retitles", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { manifests, inspect, write, hold, advance } = service();
      const workspace = titled('Login redirect');
      manifests.restored([workspace]);
      manifests.saved([workspace]);
      const theirs = JSON.parse(fromOtherDevice(workspace, { customDescription: 'There' }));
      inspect.mockResolvedValue({
        state: 'present',
        manifest: JSON.stringify({ ...theirs, agentTitle: 'Stripe webhook retries' }),
      });
      const renamed = { ...workspace, name: 'renamed-here' };
      hold(renamed);
      manifests.saved([renamed]);
      await flush();

      advance(5 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      manifests.saved([renamed]);
      await flush();

      expect(written(write)).toEqual(['Stripe webhook retries']);
    });

    it('is not written for a workspace deleted while a newer one waited', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { manifests, write, advance, hold } = service();
      manifests.saved([titled('Login redirect')]);
      await flush();
      const renamed = titled('Login redirect loop');
      hold(renamed);
      manifests.saved([renamed]);
      await manifests.deleted(renamed, { leftOnHost: true });

      advance(5 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await flush();

      expect(written(write)).toEqual(['Login redirect']);
    });

    it('is left out while the workspace has a custom name', async () => {
      const { manifests, write } = service();
      manifests.saved([titled('Login redirect', { customName: 'Fix login' })]);
      await flush();

      expect(written(write)).toEqual([undefined]);
    });

    it('waits after a restart, so startup does not contact hosts', async () => {
      const { manifests, inspect } = service();
      manifests.restored([sshWorkspace()]);
      manifests.saved([titled('Login redirect')]);
      await flush();

      expect(inspect).not.toHaveBeenCalled();
    });
  });

  it('never fails a save when a workspace cannot be described', () => {
    const manifests = new SshWorkspaceSync({
      host: {
        inspect: vi.fn(),
        write: vi.fn(),
        delete: vi.fn(),
        read: vi.fn(),
        findTerminalSessions: vi.fn(),
        removeOrphaned: vi.fn(),
        hasHost: () => true,
        readyHosts: () => [],
        basePath: vi.fn(),
      },
      store: memoryStore(new Map()),
      now: () => 1,
      deviceId: () => 'this-device',
      syncsWith: () => true,
      launch: () => {
        throw new Error('broken preset');
      },
    });

    expect(() => manifests.saved([sshWorkspace()])).not.toThrow();
  });

  it('retries a failed write on the next sync', async () => {
    const write = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true);
    const { manifests } = service(write);
    const workspace = sshWorkspace();

    manifests.saved([workspace]);
    await flush();
    manifests.saved([workspace]);
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it('skips a write the host already has', async () => {
    const { manifests, inspect, write } = service();
    const workspace = sshWorkspace();
    inspect.mockResolvedValue({
      state: 'present',
      manifest: JSON.stringify(
        buildSshWorkspaceManifest(workspace, 5, undefined, 'this-device', true)
      ),
    });

    manifests.saved([workspace]);
    await flush();

    expect(write).not.toHaveBeenCalled();
  });

  it('skips a write the host already has with its layout keys in another order', async () => {
    const { manifests, inspect, read, write, hold } = service();
    const workspace = sshWorkspace({
      terminalLayout: { tabs: ['t1'], layouts: {}, activeTab: 't1' },
    });
    manifests.restored([workspace]);
    const own = JSON.stringify(
      buildSshWorkspaceManifest(workspace, 5, undefined, 'this-device', true)
    );
    read.mockResolvedValue([own]);
    inspect.mockResolvedValue({ state: 'present', manifest: own });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(write).not.toHaveBeenCalled();
  });

  it('writes what a workspace holds when its turn comes, not when it was queued', async () => {
    const { manifests, inspect, write, store, hold } = service();
    const workspace = sshWorkspace();
    hold(workspace);
    manifests.restored([sshWorkspace()]);
    inspect.mockResolvedValue({
      state: 'present',
      manifest: fromOtherDevice(sshWorkspace(), { customName: 'Renamed there' }),
    });

    // Two saves queue writes before the first merges the other device's rename.
    workspace.customDescription = 'First';
    manifests.saved([workspace]);
    workspace.customDescription = 'Second';
    manifests.saved([workspace]);
    await flush();

    expect(store.applyMerged).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[2]))).toMatchObject({
      customName: 'Renamed there',
      customDescription: 'Second',
    });
  });

  it('writes over a copy from a device without sync instead of taking its changes', async () => {
    const { manifests, inspect, read, write, store, hold } = service();
    const workspace = sshWorkspace();
    hold(workspace);
    manifests.restored([workspace]);
    const stale = fromOtherDevice(workspace, { name: 'stale name', status: 'trashed' }, false);
    read.mockResolvedValue([stale]);
    inspect.mockResolvedValue({ state: 'present', manifest: stale });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.applyMerged).not.toHaveBeenCalled();
    expect(JSON.parse(String(write.mock.calls[0]?.[2]))).toMatchObject({
      name: 'fix-login-redirect',
      status: 'active',
      syncs: true,
    });
  });

  it('merges without the status and tabs it had before its first sync', async () => {
    const { manifests, inspect, read, store, hold } = service();
    const workspace = sshWorkspace();
    hold(workspace);
    manifests.restored([workspace]);
    const theirs = fromOtherDevice(workspace, { status: 'trashed', terminals: [] });
    read.mockResolvedValue([theirs]);
    inspect.mockResolvedValue({ state: 'present', manifest: theirs });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    // With no host copy to compare against, it neither trashes it nor closes tabs.
    expect(store.applyMerged).toHaveBeenCalled();
    expect(store.changeStatus).not.toHaveBeenCalled();
    expect(workspace.status).toBe('active');
    expect(workspace.terminals.map((entry) => entry.id)).toEqual(['t1', 't2']);
  });

  it('reads hosts it syncs with in the background', async () => {
    const { manifests, read } = service();

    await manifests.syncSoon('host-a', { now: true });
    await manifests.listOnHost('host-a');

    expect(read.mock.calls).toEqual([
      ['host-a', { background: true }],
      ['host-a', { background: false }],
    ]);
  });

  it("merges another device's newer copy instead of writing over it", async () => {
    const { manifests, inspect, write, store, hold } = service();
    const workspace = sshWorkspace();
    manifests.restored([workspace]);
    inspect.mockResolvedValue({
      state: 'present',
      manifest: fromOtherDevice(workspace, { customName: 'Renamed there' }),
    });
    const mine = { ...workspace, customDescription: 'Mine' };
    hold(mine);

    manifests.saved([mine]);
    await flush();

    expect(mine.customName).toBe('Renamed there');
    expect(store.save).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    // The merged workspace's save publishes it, now on top of the other device's copy.
    manifests.saved([mine]);
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[2]))).toMatchObject({
      customName: 'Renamed there',
      customDescription: 'Mine',
    });
  });

  it('does not answer a merge with a write when nothing it syncs differs', async () => {
    const { manifests, inspect, read, write, store, hold } = service();
    const workspace = sshWorkspace();
    hold(workspace);
    manifests.restored([workspace]);
    const theirs = fromOtherDevice(workspace, { name: 'renamed elsewhere' });
    read.mockResolvedValue([theirs]);
    inspect.mockResolvedValue({ state: 'present', manifest: theirs });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    manifests.saved([workspace]);
    await flush();

    expect(workspace.name).toBe('renamed elsewhere');
    expect(store.applyMerged).toHaveBeenCalledTimes(1);
    expect(store.layoutChanged).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('tells windows how another device arranged the tabs, without answering with a write', async () => {
    const { manifests, inspect, read, write, store, hold } = service();
    const pane = (terminalId: string) => ({ type: 'leaf', id: `pane-${terminalId}`, terminalId });
    const workspace = sshWorkspace({
      terminalLayout: {
        tabs: ['t1', 't2'],
        layouts: { t1: pane('t1'), t2: pane('t2') },
        activeTab: 't1',
      },
    });
    hold(workspace);
    manifests.restored([workspace]);
    const arranged = { tabs: ['t2', 't1'], layouts: { t2: pane('t2'), t1: pane('t1') } };
    const theirs = fromOtherDevice(workspace, { terminalLayout: arranged });
    read.mockResolvedValue([theirs]);
    inspect.mockResolvedValue({ state: 'present', manifest: theirs });

    await manifests.syncSoon('host-a', { now: true });
    manifests.saved([workspace]);
    await flush();

    expect(workspace.terminalLayout).toEqual({ ...arranged, activeTab: 't1' });
    expect(store.layoutChanged).toHaveBeenCalledWith('ws-42', {
      addedTerminalIds: [],
      arranged: true,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves another device's newer copy alone when not syncing with the host", async () => {
    const { manifests, write, read, store, syncsWith, hold } = service();
    const missing = sshWorkspace();
    const present = sshWorkspace({ id: 'ws-50' });
    const elsewhere = sshWorkspace({
      id: 'ws-57',
      backend: { ...(sshWorkspace().backend as object), hostId: 'host-b' } as Workspace['backend'],
    });
    syncsWith.mockReturnValue(false);
    manifests.restored([missing, present, elsewhere]);
    read.mockResolvedValue([fromOtherDevice(present, { name: 'renamed elsewhere' })]);

    hold(missing, present, elsewhere);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.applyMerged).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[1]).toBe('ws-42');
  });

  it('writes its own copy again when its last write never landed', async () => {
    const { manifests, read, write, hold } = service();
    const workspace = sshWorkspace({ name: 'renamed offline' });
    manifests.restored([workspace]);
    read.mockResolvedValue([
      JSON.stringify(buildSshWorkspaceManifest(sshWorkspace(), 5, undefined, 'this-device')),
    ]);

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(JSON.parse(String(write.mock.calls[0]?.[2]))).toMatchObject({
      name: 'renamed offline',
    });
  });

  it('merges what the host holds behind its own queued writes, not an older listing', async () => {
    const { manifests, inspect, read, store, hold } = service();
    const workspace = sshWorkspace({ name: 'renamed here' });
    manifests.restored([sshWorkspace()]);
    // The listing was read before this device's rename landed on the host.
    read.mockResolvedValue([fromOtherDevice(sshWorkspace(), { customName: 'Older there' })]);
    inspect.mockResolvedValue({
      state: 'present',
      manifest: JSON.stringify(buildSshWorkspaceManifest(workspace, 7, undefined, 'this-device')),
    });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.applyMerged).not.toHaveBeenCalled();
  });

  it('keeps the tabs of a trashed workspace, whose sessions were stopped on purpose', async () => {
    const workspace = sshWorkspace({ status: 'trashed' });
    const hostCopy = JSON.stringify(
      buildSshWorkspaceManifest(workspace, 5, undefined, 'other-device', true)
    );
    const { manifests, inspect, read, findTerminalSessions, store, hold } = service(undefined, {
      read: () => `{"ws-42":${hostCopy}}`,
      write: vi.fn(async () => undefined),
    });
    hold(workspace);
    manifests.restored([workspace]);
    // The other device closed t2, but a trashed workspace's sessions ended on purpose.
    const theirs = fromOtherDevice(workspace, { terminals: [terminal('t1')] });
    read.mockResolvedValue([theirs]);
    inspect.mockResolvedValue({ state: 'present', manifest: theirs });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.applyMerged).toHaveBeenCalled();
    expect(findTerminalSessions).not.toHaveBeenCalled();
    expect(workspace.terminals.map((entry) => entry.id)).toEqual(['t1', 't2']);
  });

  it('checks again on a workspace whose files were missing', async () => {
    const { manifests, inspect, store, hold } = service();
    const deleted = sshWorkspace({ removedFromHost: true, provisionError: 'gone' });
    const back = sshWorkspace({ id: 'ws-50', removedFromHost: true, provisionError: 'gone' });
    inspect.mockImplementation(async (_backend, workspaceId) =>
      workspaceId === 'ws-42' ? { state: 'deleted' } : { state: 'present' }
    );

    hold(deleted, back);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.removeDeletedElsewhere).toHaveBeenCalledWith('ws-42');
    expect(store.markFound).toHaveBeenCalledWith('ws-50');
  });

  it('does not count files another workspace now uses as found again', async () => {
    const { manifests, inspect, read, store, hold } = service();
    const missing = sshWorkspace({ removedFromHost: true, provisionError: 'gone' });
    // Created later on the same branch, in the directory the missing one had.
    read.mockResolvedValue([fromOtherDevice(sshWorkspace({ id: 'ws-50' }))]);
    inspect.mockResolvedValue({ state: 'present' });

    hold(missing);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-a' }), 'ws-42');
    expect(store.markFound).not.toHaveBeenCalled();
  });

  it('leaves a workspace deleted elsewhere to the user when not syncing with the host', async () => {
    const { manifests, inspect, syncsWith, store } = service();
    inspect.mockResolvedValue({ state: 'deleted' });
    syncsWith.mockReturnValue(false);
    const workspace = sshWorkspace();

    manifests.saved([workspace]);
    await flush();

    expect(store.removeDeletedElsewhere).not.toHaveBeenCalled();
    expect(store.markMissing).toHaveBeenCalledWith('ws-42');
  });

  it('reports a workspace deleted between checking the host and writing to it', async () => {
    const write = vi.fn(async (): Promise<boolean> => false);
    const { manifests, store } = service(write);

    manifests.saved([sshWorkspace()]);
    await flush();

    expect(store.removeDeletedElsewhere).toHaveBeenCalledWith('ws-42');
  });

  it('publishes a change made before a restart on top of the host copy saved then', async () => {
    const theirs = fromOtherDevice(sshWorkspace());
    const { manifests, inspect, read, write, store, hold } = service(undefined, {
      read: () => `{"ws-42":${theirs}}`,
      write: vi.fn(async () => undefined),
    });
    // Renamed while the host was unreachable, then Komla restarted.
    const workspace = sshWorkspace({ customName: 'Renamed offline' });
    manifests.restored([workspace]);
    read.mockResolvedValue([theirs]);
    inspect.mockResolvedValue({ state: 'present', manifest: theirs });

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.applyMerged).not.toHaveBeenCalled();
    expect(JSON.parse(String(write.mock.calls[0]?.[2]))).toMatchObject({
      customName: 'Renamed offline',
    });
  });

  it.each(['not json', '{"ws-42":{"schema":2},"ws-50":"garbage"}'])(
    'saves the host copies it learns and ignores invalid saved ones (%j)',
    async (content) => {
      const saved = { read: () => content, write: vi.fn(async (_content: string) => undefined) };
      const { manifests, write } = service(undefined, saved);
      const workspace = sshWorkspace();
      manifests.restored([workspace]);

      manifests.saved([{ ...workspace, name: 'renamed' }]);
      await flush();

      expect(write).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(saved.write.mock.calls.at(-1)?.[0]))).toEqual({
        'ws-42': expect.objectContaining({ name: 'renamed', writtenBy: 'this-device' }),
      });
    }
  );

  it('does not republish a workspace deleted while the host was being read', async () => {
    const { manifests, inspect } = service();
    const workspace = sshWorkspace();
    manifests.restored([workspace]);

    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(inspect).not.toHaveBeenCalled();
  });

  it('reports a workspace whose files are gone instead of resurrecting its manifest', async () => {
    const { manifests, inspect, write, store, hold } = service();
    inspect.mockResolvedValue({ state: 'missing' });
    const workspace = sshWorkspace();
    manifests.restored([workspace]);

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(write).not.toHaveBeenCalled();
    expect(store.markMissing).toHaveBeenCalledWith('ws-42');
  });

  it('reports a workspace another installation deleted', async () => {
    const { manifests, inspect, store, hold } = service();
    inspect.mockResolvedValue({ state: 'deleted' });
    const workspace = sshWorkspace();
    manifests.restored([workspace]);

    hold(workspace);
    await manifests.syncSoon('host-a', { now: true });
    await flush();

    expect(store.removeDeletedElsewhere).toHaveBeenCalledWith('ws-42');
    expect(store.markMissing).not.toHaveBeenCalled();
  });

  it('removes a deleted workspace manifest and tolerates failures', async () => {
    const { manifests, del } = service();
    const workspace = sshWorkspace();
    del.mockRejectedValueOnce(new Error('offline'));

    await expect(manifests.deleted(workspace, { leftOnHost: false })).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith(workspace.backend, 'ws-42');
  });

  it('lists valid manifests and skips invalid ones', async () => {
    const { manifests, read } = service();
    const manifest = buildSshWorkspaceManifest(sshWorkspace(), 5);
    read.mockResolvedValue(['garbage', JSON.stringify(manifest)]);

    await expect(manifests.listOnHost('host-a')).resolves.toEqual([
      expect.objectContaining({ workspaceId: 'ws-42', terminalCount: 2 }),
    ]);
  });
});

describe('SshWorkspaceSync adoption', () => {
  const elsewhere = (
    overrides: Partial<Workspace> = {},
    extra: Partial<SshWorkspaceManifest> = {}
  ) => {
    const workspace = sshWorkspace({
      id: 'ws-50',
      name: 'add-search',
      backend: {
        ...(sshWorkspace().backend as object),
        remoteDirectory: '/home/dev/.komla/worktrees/app/add-search',
      } as Workspace['backend'],
      ...overrides,
    });
    return JSON.stringify({
      ...buildSshWorkspaceManifest(workspace, 9_999, undefined, 'other-device', true),
      ...extra,
    });
  };

  it('places a workspace an agent started with the workspace it came from', async () => {
    const { manifests, read, store, hold } = service();
    const source = sshWorkspace();
    hold(source);
    read.mockResolvedValue([elsewhere({}, { sourceWorkspaceId: 'ws-42' })]);

    await manifests.syncSoon('host-a', { now: true });

    expect(store.add).toHaveBeenCalledWith(
      'host-a',
      expect.objectContaining({ workspaceId: 'ws-50' }),
      { projectId: 'local-project', sibling: source }
    );
  });

  it('places any other workspace in the project for its repository', async () => {
    const { manifests, read, store } = service();
    store.projectLookup.mockResolvedValue((repository) =>
      repository.gitUrl === 'git@github.com:acme/app.git' ? 'project-7' : null
    );
    read.mockResolvedValue([elsewhere({}, { sourceWorkspaceId: 'ws-elsewhere' })]);

    await manifests.syncSoon('host-a', { now: true });

    expect(store.add).toHaveBeenCalledWith('host-a', expect.anything(), {
      projectId: 'project-7',
      sibling: undefined,
    });
  });

  it("refuses a workspace whose files are outside the host's Komla data directory", async () => {
    const { manifests, read, store } = service();
    const escaping = JSON.parse(elsewhere());
    escaping.backend.remoteDirectory = '/home/dev/.komla/worktrees/app/../../../.ssh';
    read.mockResolvedValue([JSON.stringify(escaping)]);

    await manifests.syncSoon('host-a', { now: true });
    await expect(manifests.adopt('host-a', 'ws-50')).rejects.toThrow(
      "outside this host's Komla data directory"
    );

    expect(store.add).not.toHaveBeenCalled();
  });

  it('does not add back a workspace deleted here until it is removed with its host', async () => {
    const { manifests, read, store, hold } = service();
    const otherDirectory = {
      ...(sshWorkspace().backend as object),
      remoteDirectory: '/home/dev/.komla/worktrees/app/add-filters',
    } as Workspace['backend'];
    const deletedBefore = sshWorkspace({ id: 'ws-51', backend: otherDirectory });
    const deleted = sshWorkspace({ id: 'ws-50' });
    hold(deletedBefore, deleted);
    for (const workspace of [deletedBefore, deleted]) {
      await store.deleteHere(workspace.id);
      await manifests.deleted(workspace, { leftOnHost: true });
    }
    // A listing read before the deletions still has them.
    read.mockResolvedValue([elsewhere(), elsewhere({ id: 'ws-51', backend: otherDirectory })]);

    await manifests.syncSoon('host-a', { now: true });
    expect(store.add).not.toHaveBeenCalled();

    // Adding the host again brings back the workspaces removed along with it, and only those.
    manifests.hostForgotten(['ws-50']);
    await manifests.syncSoon('host-a', { now: true });
    expect(store.add.mock.calls.map(([, manifest]) => manifest.workspaceId)).toEqual(['ws-50']);
  });

  it('does not add a workspace whose files are gone from its host', async () => {
    const { manifests, inspect, read, store } = service();
    read.mockResolvedValue([elsewhere()]);
    inspect.mockResolvedValue({ state: 'missing' });

    await manifests.syncSoon('host-a', { now: true });

    expect(store.add).not.toHaveBeenCalled();
  });

  describe('in a directory a workspace here uses', () => {
    const sameDirectory = () => elsewhere({ backend: sshWorkspace().backend });

    it('does not add it, so the directory does not show twice', async () => {
      const { manifests, read, store, hold } = service();
      const here = sshWorkspace();
      hold(here);
      const ownCopy = buildSshWorkspaceManifest(here, 9_999, undefined, 'other-device', true);
      read.mockResolvedValue([JSON.stringify(ownCopy), sameDirectory()]);

      await manifests.syncSoon('host-a', { now: true });

      expect(store.add).not.toHaveBeenCalled();
    });

    it('does not add it while the workspace here is not on the host yet', async () => {
      const { manifests, read, store, hold } = service();
      hold(sshWorkspace());
      read.mockResolvedValue([sameDirectory()]);

      await manifests.syncSoon('host-a', { now: true });

      expect(store.add).not.toHaveBeenCalled();
      expect(store.removeDeletedElsewhere).not.toHaveBeenCalled();
    });

    it('adds it on the next sync once the workspace here was deleted elsewhere', async () => {
      const { manifests, inspect, read, store, hold } = service();
      hold(sshWorkspace());
      read.mockResolvedValue([sameDirectory()]);
      inspect.mockImplementation(async (_backend, workspaceId) =>
        workspaceId === 'ws-42' ? { state: 'deleted' } : { state: 'present' }
      );

      await manifests.syncSoon('host-a', { now: true });
      await vi.waitFor(() => expect(store.removeDeletedElsewhere).toHaveBeenCalledWith('ws-42'));
      await manifests.syncSoon('host-a', { now: true });

      expect(store.add).toHaveBeenCalledWith(
        'host-a',
        expect.objectContaining({ workspaceId: 'ws-50' }),
        expect.anything()
      );
    });

    it('refuses it when added by hand', async () => {
      const { manifests, read, store, hold } = service();
      hold(sshWorkspace());
      read.mockResolvedValue([sameDirectory()]);

      await expect(manifests.adopt('host-a', 'ws-50')).rejects.toThrow(
        'already open here as "fix-login-redirect"'
      );
      expect(store.add).not.toHaveBeenCalled();
    });
  });

  it('adds only one of two workspaces for the same directory added at once', async () => {
    const { manifests, read } = service();
    const first = elsewhere();
    read.mockResolvedValue([first, JSON.stringify({ ...JSON.parse(first), workspaceId: 'ws-51' })]);

    const results = await Promise.allSettled([
      manifests.adopt('host-a', 'ws-50'),
      manifests.adopt('host-a', 'ws-51'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it("leaves other devices' workspaces to the user when not syncing with the host", async () => {
    const { manifests, read, store, syncsWith } = service();
    syncsWith.mockReturnValue(false);
    read.mockResolvedValue([elsewhere()]);

    await manifests.syncSoon('host-a', { now: true });

    expect(store.add).not.toHaveBeenCalled();
    await expect(manifests.listOnHost('host-a')).resolves.toEqual([
      expect.objectContaining({ workspaceId: 'ws-50', mayBeOnOtherDevices: true }),
    ]);
  });

  it('refuses to remove a workspace whose files are back on its host', async () => {
    const { manifests, store, hold } = service();
    hold(sshWorkspace());

    await expect(manifests.removeMissing('ws-42')).rejects.toThrow(
      'files are on its SSH host again'
    );
    expect(store.deleteHere).not.toHaveBeenCalled();
  });
});

describe('SshWorkspaceSync scheduling', () => {
  it('reports a pass that read the host, and only such a pass', async () => {
    const { manifests, read, store } = service();
    read.mockRejectedValueOnce(new Error('offline'));

    await manifests.syncSoon('host-a', { now: true });
    expect(store.hostSynced).not.toHaveBeenCalled();

    await manifests.syncSoon('host-a', { now: true });
    expect(store.hostSynced).toHaveBeenCalledWith('host-a');
  });

  it('syncs a host at most once per interval unless asked to now', async () => {
    const { manifests, read } = service();

    await manifests.syncSoon('host-a');
    await manifests.syncSoon('host-a');
    expect(read).toHaveBeenCalledTimes(1);

    await manifests.syncSoon('host-a', { now: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('syncs a host again once the interval has passed', async () => {
    const { manifests, read, advance } = service();

    await manifests.syncSoon('host-a');
    advance(31_000);
    await manifests.syncSoon('host-a');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares a running pass, and runs one more after it when asked to now', async () => {
    const { manifests, read } = service();
    let answer!: (texts: string[]) => void;
    read.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const first = manifests.syncSoon('host-a', { now: true });
    const shared = manifests.syncSoon('host-a');
    const again = manifests.syncSoon('host-a', { now: true });
    answer([]);
    await Promise.all([first, shared, again]);

    expect(read).toHaveBeenCalledTimes(2);
  });

  describe('after another installation changes workspaces on a host', () => {
    /** One manifest another installation wrote, as the adoption tests build it. */
    const theirs = (name = 'add-search') =>
      JSON.stringify(
        buildSshWorkspaceManifest(
          sshWorkspace({
            id: 'ws-50',
            name,
            backend: {
              ...(sshWorkspace().backend as object),
              remoteDirectory: '/home/dev/.komla/worktrees/app/add-search',
            } as Workspace['backend'],
          }),
          9_999,
          undefined,
          'other-device',
          true
        )
      );

    /** Fake timers that move the service's clock along with them. */
    function timed() {
      vi.useFakeTimers();
      const sync = service();
      return {
        ...sync,
        wait: async (ms: number) => {
          for (let waited = 0; waited < ms; waited += 1_000) {
            sync.advance(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
          }
        },
      };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    // A workspace another installation starts is added before its tabs' sessions run, so the
    // sync that adds it can't show it running. Nothing else may sync before the user opens it.
    it('syncs the host again after adding a workspace, so its sessions are found once they run', async () => {
      const { manifests, read, store, wait } = timed();
      read.mockResolvedValue([theirs()]);

      await manifests.syncSoon('host-a', { now: true });
      expect(store.add).toHaveBeenCalledTimes(1);
      await wait(30_000);

      expect(read).toHaveBeenCalledTimes(2);
      expect(store.hostSynced).toHaveBeenCalledTimes(2);
    });

    // Even on the first pass, as after a restart: the tab another installation just opened may
    // not run yet.
    it('syncs again after merging a tab another installation opened in a workspace here', async () => {
      const { manifests, read, inspect, hold, wait } = timed();
      hold(sshWorkspace({ id: 'ws-50', name: 'add-search', terminals: [terminal('t1')] }));
      read.mockResolvedValue([theirs()]);
      inspect.mockResolvedValue({ state: 'present', manifest: theirs() });

      await manifests.syncSoon('host-a', { now: true });
      await wait(30_000);

      expect(read).toHaveBeenCalledTimes(2);
    });

    // Switching tabs or renaming there starts no session here to look for.
    it('leaves the host alone after merging changes that open no tab', async () => {
      const { manifests, read, inspect, hold, wait } = timed();
      hold(sshWorkspace({ id: 'ws-50', name: 'add-search' }));
      const renamed = theirs('renamed elsewhere');
      read.mockResolvedValue([renamed]);
      inspect.mockResolvedValue({ state: 'present', manifest: renamed });

      await manifests.syncSoon('host-a', { now: true });
      await wait(60_000);

      expect(read).toHaveBeenCalledTimes(1);
    });

    it('syncs again after the user adds a workspace from the host', async () => {
      const { manifests, read, wait } = timed();
      read.mockResolvedValue([theirs()]);

      await manifests.adopt('host-a', 'ws-50');
      await wait(30_000);

      expect(read).toHaveBeenCalledTimes(2);
    });

    it('stops once the host has gone a while without changes from elsewhere', async () => {
      const { manifests, read, wait } = timed();
      read.mockResolvedValue([theirs()]);
      await manifests.syncSoon('host-a', { now: true });

      await wait(10 * 60_000);
      const reads = read.mock.calls.length;
      await wait(10 * 60_000);

      expect(reads).toBeGreaterThan(2);
      expect(read).toHaveBeenCalledTimes(reads);
    });

    it('leaves a host it does not sync with alone', async () => {
      const { manifests, read, syncsWith, wait } = timed();
      syncsWith.mockReturnValue(false);
      read.mockResolvedValue([theirs()]);

      await manifests.adopt('host-a', 'ws-50');
      await wait(60_000);

      expect(read).toHaveBeenCalledTimes(1);
    });

    it('stops once the user turns sync off for the host', async () => {
      const { manifests, read, syncsWith, wait } = timed();
      read.mockResolvedValue([theirs()]);
      await manifests.syncSoon('host-a', { now: true });

      syncsWith.mockReturnValue(false);
      await wait(60_000);

      expect(read).toHaveBeenCalledTimes(1);
    });

    // Away from Komla, a host that lost its connection could ask for a password unasked.
    it('waits for the user to be back in Komla, whose focus syncs and follows up again', async () => {
      const { manifests, read, inUse, wait } = timed();
      read.mockResolvedValue([theirs()]);
      await manifests.syncSoon('host-a', { now: true });
      inUse.mockReturnValue(false);
      await wait(60_000);
      expect(read).toHaveBeenCalledTimes(1);

      inUse.mockReturnValue(true);
      await manifests.syncSoon('host-a');
      await wait(30_000);

      expect(read).toHaveBeenCalledTimes(3);
    });

    it('leaves a host alone when only this installation changed its workspaces', async () => {
      const { manifests, read, hold, wait } = timed();
      hold(sshWorkspace());
      read.mockResolvedValue([
        JSON.stringify(
          buildSshWorkspaceManifest(sshWorkspace(), 5, undefined, 'this-device', true)
        ),
      ]);

      await manifests.syncSoon('host-a', { now: true });
      await wait(60_000);

      expect(read).toHaveBeenCalledTimes(1);
    });

    // A host gone offline would time out, and one that lost its connection could ask for a
    // password, each time.
    it('stops when the host cannot be read', async () => {
      const { manifests, read, wait } = timed();
      read.mockResolvedValue([theirs()]);
      await manifests.syncSoon('host-a', { now: true });
      read.mockRejectedValue(new Error('offline'));

      await wait(30_000);
      await wait(5 * 60_000);

      expect(read).toHaveBeenCalledTimes(2);
    });

    it('syncs no more once disposed, as when Komla quits', async () => {
      const { manifests, read, wait } = timed();
      read.mockResolvedValue([theirs()]);
      await manifests.syncSoon('host-a', { now: true });

      manifests.dispose();
      await wait(60_000);

      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  it('syncs every host it syncs with when given none', async () => {
    const { manifests, read, syncsWith, readyHosts } = service();
    syncsWith.mockImplementation((hostId: string) => hostId !== 'host-b');
    readyHosts.mockReturnValue(['host-a', 'host-b']);

    await manifests.syncSoon();

    expect(read.mock.calls.map(([hostId]) => hostId)).toEqual(['host-a']);
  });
});
