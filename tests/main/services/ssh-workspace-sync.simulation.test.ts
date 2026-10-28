/* eslint-disable import/order -- Vitest's hoisted mocks must precede service imports. */
/**
 * Two Komla installations syncing SSH workspaces through one host. The host
 * is a local directory: the SSH layer runs each remote command with `sh`, so
 * the real manifest, tombstone and listing scripts run against real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockElectron } from '../../mocks/electron';
import type { SshWorkspaceSyncStore } from '../../../src/main/services/ssh-workspace-sync/ssh-workspace-sync';
import type { SshWorkspaceManifest } from '../../../src/shared/types/ssh-workspace-manifest';
import type { SshWorkspaceBackend, Terminal, Workspace } from '../../../src/shared/types';

const holder = vi.hoisted(() => ({
  host: undefined as undefined | Record<string, unknown>,
  warnings: [] as unknown[],
}));

vi.mock('electron', () => mockElectron());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('node:util');
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  function execFile(file: string, args: string[], options: object, callback?: Callback) {
    if (file !== 'ssh') return actual.execFile(file, args, options, callback);
    // ssh's last argument is the remote command; run it on this machine instead.
    return actual.execFile('sh', ['-c', String(args.at(-1))], options, callback);
  }
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    options: object = {}
  ) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })
      );
    });
  return { ...actual, execFile };
});

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => holder.warnings.push(args),
    error: (...args: unknown[]) => holder.warnings.push(args),
  }),
}));

vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(() => null),
    getSocketPath: vi.fn(() => null),
  },
}));

vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({ sshHosts: [holder.host] }) },
}));

vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: {
    has: (hostId: string) => hostId === 'ssh-dev',
    get: (hostId: string) => (hostId === 'ssh-dev' ? holder.host : undefined),
  },
}));

vi.mock('../../../src/main/services/http-server.service', () => ({
  httpServerService: { getActualPort: vi.fn(() => 54183) },
}));

const { sshWorkspaceSyncHost } = await import('../../../src/main/services/ssh-workspace-sync/host');
const { SshWorkspaceSync } =
  await import('../../../src/main/services/ssh-workspace-sync/ssh-workspace-sync');
const { buildSshWorkspaceManifest } =
  await import('../../../src/main/services/ssh-workspace-sync/workspace-manifest');
const { normalizePersistedTerminalLayout } =
  await import('../../../src/main/services/ssh-workspace-sync/terminal-layout');

let base = '';
let scratch = '';
/** tmux sessions still running on the host. */
const live = new Set<string>();

function terminal(id: string, name = `Agent ${id}`): Terminal {
  return {
    id,
    name,
    status: 'stopped',
    createdAt: 1,
    executionLocation: 'workspace',
    remoteSessionResumable: true,
  } as Terminal;
}

function backend(slug = 'fix-login'): SshWorkspaceBackend {
  return {
    kind: 'ssh',
    hostId: 'ssh-dev',
    remoteDirectory: `${base}/worktrees/app/${slug}`,
    remoteRepoPath: `${base}/repos/app/repo.git`,
    remoteProjectRoot: `${base}/worktrees/app`,
    gitUrl: 'git@example.com:acme/app.git',
    projectName: 'app',
  } as SshWorkspaceBackend;
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  mkdirSync(backend().remoteDirectory, { recursive: true });
  return {
    id,
    name: 'fix-login',
    workingDirectory: `ssh://ssh-dev${backend().remoteDirectory}`,
    backend: backend(),
    isWorktree: true,
    projectId: null,
    terminals: [terminal('t1')],
    primaryTerminalId: 't1',
    // In the key order Komla saves layouts in.
    terminalLayout: {
      tabs: ['t1'],
      layouts: { t1: { type: 'leaf', id: 'pane-t1', terminalId: 't1' } },
      activeTab: 't1',
    },
    windowId: null,
    categoryId: null,
    createdAt: 100,
    lastActivityAt: 200,
    order: 0,
    status: 'active',
    ...overrides,
  } as Workspace;
}

type Device = ReturnType<typeof device>;

/** One installation: its workspaces, the sync service, and what workspaceService would do. */
function device(id: string, options: { syncs?: boolean; savedPath?: string } = {}) {
  const workspaces = new Map<string, Workspace>();
  const writes: string[] = [];
  const missing = new Set<string>();
  let pendingSaves = 0;
  const state = { syncs: options.syncs ?? true, stopFails: false };

  const saveSoon = () => {
    pendingSaves += 1;
    setTimeout(() => {
      pendingSaves -= 1;
      manifests.saved(workspaces.values());
    }, 5);
  };

  // What workspaceService does when SSH Workspace Sync asks, without windows or agents.
  const store: SshWorkspaceSyncStore = {
    workspaces: () => workspaces.values(),
    get: (workspaceId) => workspaces.get(workspaceId),
    isDeleting: () => false,
    projectLookup: async () => () => null,
    add: (hostId, manifest, { projectId }) => {
      const adopted = {
        ...workspace(manifest.workspaceId),
        name: manifest.name,
        customName: manifest.customName,
        customDescription: manifest.customDescription,
        customNameSource: manifest.customNameSource,
        backend: { kind: 'ssh', hostId, ...manifest.backend },
        projectId,
        terminals: manifest.terminals.map((entry) => terminal(entry.id, entry.name)),
        primaryTerminalId: manifest.primaryTerminalId,
        status: manifest.status,
      } as Workspace;
      workspaces.set(adopted.id, adopted);
      saveSoon();
      return adopted;
    },
    hostSynced: async () => undefined,
    deleteHere: async (workspaceId) => {
      const local = workspaces.get(workspaceId)!;
      workspaces.delete(workspaceId);
      await manifests.deleted(local, { leftOnHost: true });
    },
    applyMerged: (workspaceId, merged) => {
      const local = workspaces.get(workspaceId)!;
      local.name = merged.name;
      local.customName = merged.customName;
      local.customDescription = merged.customDescription;
      local.customNameSource = merged.customNameSource;
      const added: string[] = [];
      for (const entry of merged.terminals) {
        const existing = local.terminals.find((candidate) => candidate.id === entry.id);
        if (existing) {
          existing.name = entry.name;
          continue;
        }
        local.terminals.push(terminal(entry.id, entry.name));
        added.push(entry.id);
      }
      local.terminalLayout = normalizePersistedTerminalLayout(
        merged.terminalLayout,
        new Set(local.terminals.map((entry) => entry.id))
      );
      return added;
    },
    changeStatus: async (workspaceId, status) => {
      const local = workspaces.get(workspaceId)!;
      if (state.stopFails && local.status === 'active' && status !== 'active') {
        throw new Error('Could not stop its agents');
      }
      local.status = status;
    },
    removeTerminal: async (workspaceId, terminalId) => {
      const local = workspaces.get(workspaceId)!;
      local.terminals = local.terminals.filter((entry) => entry.id !== terminalId);
    },
    save: () => saveSoon(),
    changed: () => undefined,
    layoutChanged: () => undefined,
    markMissing: (workspaceId) => {
      const local = workspaces.get(workspaceId);
      if (!local) return;
      local.removedFromHost = true;
      local.provisionError = 'This workspace’s files are no longer on its SSH host.';
      missing.add(workspaceId);
    },
    markFound: (workspaceId) => {
      const local = workspaces.get(workspaceId);
      if (!local?.removedFromHost) return;
      local.removedFromHost = undefined;
      local.provisionError = undefined;
      missing.delete(workspaceId);
    },
    removeDeletedElsewhere: async (workspaceId) => {
      const local = workspaces.get(workspaceId)!;
      workspaces.delete(workspaceId);
      await manifests.deleted(local, { leftOnHost: true });
    },
  };

  const manifests = new SshWorkspaceSync({
    host: {
      ...sshWorkspaceSyncHost,
      write: async (target, workspaceId, content) => {
        const written = await sshWorkspaceSyncHost.write(target, workspaceId, content);
        if (written) writes.push(workspaceId);
        return written;
      },
      // tmux runs the sessions in `live`.
      findTerminalSessions: async (_target, terminalIds) =>
        new Set(terminalIds.filter((terminalId) => live.has(terminalId))),
    },
    store,
    now: () => Date.now(),
    deviceId: () => id,
    syncsWith: () => state.syncs,
    hostCopies: options.savedPath
      ? {
          read: () =>
            existsSync(options.savedPath!) ? readFileSync(options.savedPath!, 'utf8') : undefined,
          write: async (content) => writeFileSync(options.savedPath!, content),
        }
      : undefined,
  });

  return {
    id,
    state,
    workspaces,
    writes,
    missing,
    manifests,
    saveSoon,
    idle: () =>
      pendingSaves === 0 &&
      (manifests as unknown as { writes: Map<unknown, unknown> }).writes.size === 0,
    /** Starts with these workspaces as restored from disk. */
    restore(...restored: Workspace[]) {
      for (const entry of restored) workspaces.set(entry.id, entry);
      manifests.restored(restored);
      return this;
    },
    async syncHost() {
      await manifests.syncSoon('ssh-dev', { now: true });
      await settle(this);
    },
    /** Deletes a workspace here the way workspaceService.delete does. */
    async deleteWorkspace(workspaceId: string) {
      const target = workspaces.get(workspaceId)!;
      workspaces.delete(workspaceId);
      rmSync((target.backend as SshWorkspaceBackend).remoteDirectory, {
        recursive: true,
        force: true,
      });
      await manifests.deleted(target, { leftOnHost: false });
    },
  };
}

async function settle(...devices: Device[]) {
  const deadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (!devices.every((entry) => entry.idle()) && Date.now() < deadline);
  expect(devices.every((entry) => entry.idle())).toBe(true);
}

function onHost(workspaceId: string): SshWorkspaceManifest | undefined {
  const path = join(base, 'workspaces', `${workspaceId}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

const tabs = (entry: Device, workspaceId = 'ws-1') =>
  entry.workspaces.get(workspaceId)?.terminals.map((candidate) => candidate.id);

beforeEach(() => {
  // The host resolves its base path with `pwd -P`, and macOS's tmpdir is under the /var symlink.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'komla-sync-')));
  base = join(scratch, 'host', 'komla');
  mkdirSync(base, { recursive: true });
  holder.host = { id: 'ssh-dev', name: 'Host', hostname: 'localhost', user: 'dev', basePath: base };
  holder.warnings = [];
  live.clear();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The host scripts need a POSIX shell.
describe.skipIf(process.platform === 'win32')(
  'SSH workspace sync between two devices sharing a host',
  () => {
    async function shared() {
      const laptop = device('laptop');
      const desktop = device('desktop');
      laptop.workspaces.set('ws-1', workspace('ws-1'));
      laptop.saveSoon();
      await settle(laptop);
      await desktop.syncHost();
      expect(desktop.workspaces.get('ws-1')).toBeDefined();
      laptop.writes.length = 0;
      desktop.writes.length = 0;
      return { laptop, desktop };
    }

    it('adds a workspace started on the other device without writing it back', async () => {
      const { laptop, desktop } = await shared();

      await laptop.syncHost();
      await desktop.syncHost();

      expect(onHost('ws-1')).toMatchObject({ writtenBy: 'laptop', syncs: true });
      expect([...laptop.writes, ...desktop.writes]).toEqual([]);
      expect(holder.warnings).toEqual([]);
    });

    it('keeps one workspace per directory when the devices know it by different ids', async () => {
      const laptop = device('laptop');
      const desktop = device('desktop');
      laptop.workspaces.set('ws-1', workspace('ws-1'));
      desktop.workspaces.set('ws-2', workspace('ws-2'));
      laptop.saveSoon();
      desktop.saveSoon();
      await settle(laptop);
      await settle(desktop);

      await laptop.syncHost();
      await desktop.syncHost();

      expect([...laptop.workspaces.keys()]).toEqual(['ws-1']);
      expect([...desktop.workspaces.keys()]).toEqual(['ws-2']);
      expect(holder.warnings).toEqual([]);
    });

    it('carries renames both ways and settles without writing back and forth', async () => {
      const { laptop, desktop } = await shared();

      laptop.workspaces.get('ws-1')!.customName = 'Login fix';
      laptop.saveSoon();
      await settle(laptop);
      await desktop.syncHost();
      expect(desktop.workspaces.get('ws-1')?.customName).toBe('Login fix');

      desktop.workspaces.get('ws-1')!.terminals[0]!.name = 'Reviewer';
      desktop.saveSoon();
      await settle(desktop);
      await laptop.syncHost();
      expect(laptop.workspaces.get('ws-1')?.terminals[0]?.name).toBe('Reviewer');

      const writes = laptop.writes.length + desktop.writes.length;
      for (let round = 0; round < 3; round += 1) {
        await laptop.syncHost();
        await desktop.syncHost();
      }
      expect(laptop.writes.length + desktop.writes.length).toBe(writes);
      expect(holder.warnings).toEqual([]);
    });

    it('keeps changes both devices made to different fields before either synced', async () => {
      const { laptop, desktop } = await shared();

      laptop.workspaces.get('ws-1')!.customName = 'Login fix';
      desktop.workspaces.get('ws-1')!.customDescription = 'Checks the redirect';
      laptop.saveSoon();
      await settle(laptop);
      desktop.saveSoon();
      await settle(desktop);
      await laptop.syncHost();

      for (const entry of [laptop, desktop]) {
        expect(entry.workspaces.get('ws-1')).toMatchObject({
          customName: 'Login fix',
          customDescription: 'Checks the redirect',
        });
      }
      expect(onHost('ws-1')).toMatchObject({
        customName: 'Login fix',
        customDescription: 'Checks the redirect',
      });
    });

    it('adds tabs opened elsewhere, drops ended ones closed elsewhere and keeps running ones', async () => {
      const { laptop, desktop } = await shared();

      desktop.workspaces.get('ws-1')!.terminals.push(terminal('t2'), terminal('t3'));
      live.add('t2').add('t3');
      desktop.saveSoon();
      await settle(desktop);
      await laptop.syncHost();
      expect(tabs(laptop)).toEqual(['t1', 't2', 't3']);

      // The desktop closes t2 and its session ends; t3 is missing from a copy but still runs.
      desktop.workspaces.get('ws-1')!.terminals = desktop.workspaces
        .get('ws-1')!
        .terminals.filter((entry) => entry.id !== 't2' && entry.id !== 't3');
      live.delete('t2');
      desktop.saveSoon();
      await settle(desktop);
      await laptop.syncHost();
      await desktop.syncHost();

      expect(tabs(laptop)).toEqual(['t1', 't3']);
      expect(tabs(desktop)).toEqual(['t1', 't3']);
      expect(onHost('ws-1')?.terminals.map((entry) => entry.id)).toEqual(['t1', 't3']);
    });

    it("takes a phone's restart on the host instead of writing over it", async () => {
      const { laptop } = await shared();

      // As the host's companion writes it: t1 ended, and t9 resumes the agent.
      const { terminalLayout: _layout, ...manifest } = onHost('ws-1')!;
      writeFileSync(
        join(base, 'workspaces', 'ws-1.json'),
        JSON.stringify({
          ...manifest,
          terminals: [{ id: 't9', name: 'Claude Code', createdAt: 5 }],
          primaryTerminalId: 't9',
          updatedAt: Date.now(),
          writtenBy: 'remote-companion',
          syncs: true,
        })
      );
      live.add('t9');
      await laptop.syncHost();

      expect(tabs(laptop)).toEqual(['t9']);
      expect(onHost('ws-1')?.terminals.map((entry) => entry.id)).toEqual(['t9']);
      expect(holder.warnings).toEqual([]);
    });

    it("carries tab and pane arrangements both ways, keeps each device's own panes and settles", async () => {
      const { laptop, desktop } = await shared();
      const pane = (terminalId: string) => ({ type: 'leaf', id: `pane-${terminalId}`, terminalId });
      const layoutOf = (entry: Device) => entry.workspaces.get('ws-1')!.terminalLayout;
      const arrange = (entry: Device, layouts: Record<string, unknown>, activeTab: string) => {
        entry.workspaces.get('ws-1')!.terminalLayout = {
          tabs: Object.keys(layouts),
          layouts,
          activeTab,
        };
        entry.saveSoon();
      };
      // The desktop has a pane of its own, e.g. a Local copy's terminal.
      desktop.workspaces
        .get('ws-1')!
        .terminals.push({ ...terminal('mirror'), remoteSessionResumable: false });
      arrange(desktop, { t1: pane('t1'), mirror: pane('mirror') }, 'mirror');
      await settle(desktop);

      // The laptop opens t2 beside t1.
      laptop.workspaces.get('ws-1')!.terminals.push(terminal('t2'));
      live.add('t2');
      const sideBySide = {
        type: 'split',
        id: 'split-1',
        direction: 'vertical',
        children: [pane('t1'), pane('t2')],
        sizes: [700, 300],
      };
      arrange(laptop, { t1: sideBySide }, 't1');
      await settle(laptop);
      await desktop.syncHost();

      expect(layoutOf(desktop)).toEqual({
        tabs: ['t1', 'mirror'],
        layouts: { t1: sideBySide, mirror: pane('mirror') },
        activeTab: 'mirror',
      });

      // The desktop gives t2 its own tab again.
      arrange(desktop, { t1: pane('t1'), t2: pane('t2'), mirror: pane('mirror') }, 't2');
      await settle(desktop);
      await laptop.syncHost();

      expect(layoutOf(laptop)).toEqual({
        tabs: ['t1', 't2'],
        layouts: { t1: pane('t1'), t2: pane('t2') },
        activeTab: 't1',
      });
      const writes = laptop.writes.length + desktop.writes.length;
      for (let round = 0; round < 3; round += 1) {
        await laptop.syncHost();
        await desktop.syncHost();
      }
      expect(laptop.writes.length + desktop.writes.length).toBe(writes);
      expect(holder.warnings).toEqual([]);
    });

    it('trashes a workspace trashed elsewhere', async () => {
      const { laptop, desktop } = await shared();

      laptop.workspaces.get('ws-1')!.status = 'trashed';
      laptop.saveSoon();
      await settle(laptop);
      await desktop.syncHost();

      expect(desktop.workspaces.get('ws-1')?.status).toBe('trashed');
    });

    it('keeps a workspace trashed elsewhere active until its agents can be stopped', async () => {
      const { laptop, desktop } = await shared();
      desktop.state.stopFails = true;

      laptop.workspaces.get('ws-1')!.status = 'trashed';
      laptop.saveSoon();
      await settle(laptop);
      await desktop.syncHost();

      // Publishing it as active would only undo the trash on the laptop.
      expect(desktop.workspaces.get('ws-1')?.status).toBe('active');
      expect(desktop.writes).toEqual([]);

      desktop.state.stopFails = false;
      await desktop.syncHost();

      expect(desktop.workspaces.get('ws-1')?.status).toBe('trashed');
      expect(laptop.workspaces.get('ws-1')?.status).toBe('trashed');
    });

    it('removes a workspace deleted elsewhere and never brings it back', async () => {
      const { laptop, desktop } = await shared();

      await laptop.deleteWorkspace('ws-1');
      // A copy the desktop writes afterwards must not recreate it.
      desktop.workspaces.get('ws-1')!.customName = 'Late rename';
      desktop.saveSoon();
      await settle(desktop);
      await desktop.syncHost();
      await laptop.syncHost();

      expect(desktop.workspaces.get('ws-1')).toBeUndefined();
      expect(laptop.workspaces.get('ws-1')).toBeUndefined();
      expect(onHost('ws-1')).toBeUndefined();
      expect(existsSync(join(base, 'workspaces', 'deleted', 'ws-1'))).toBe(true);
    });

    it('leaves a workspace deleted elsewhere to the user on a device without sync', async () => {
      const { laptop, desktop } = await shared();
      desktop.state.syncs = false;

      await laptop.deleteWorkspace('ws-1');
      await desktop.syncHost();

      expect(desktop.workspaces.get('ws-1')).toBeDefined();
      expect(desktop.missing.has('ws-1')).toBe(true);
      expect(onHost('ws-1')).toBeUndefined();
    });

    it('adds a workspace started in the directory of one whose files went missing', async () => {
      const { laptop, desktop } = await shared();
      // The files of the laptop's ws-1 are gone, e.g. removed on the host by hand.
      rmSync(backend().remoteDirectory, { recursive: true, force: true });
      laptop.workspaces.get('ws-1')!.name = 'renamed';
      laptop.saveSoon();
      await settle(laptop);
      expect(laptop.missing.has('ws-1')).toBe(true);

      // The desktop starts a new workspace on the same branch, in the same directory.
      desktop.workspaces.set('ws-2', workspace('ws-2'));
      desktop.saveSoon();
      await settle(desktop);
      await laptop.syncHost();

      expect(laptop.workspaces.has('ws-2')).toBe(true);
      // The files there are ws-2's, so ws-1 stays missing.
      expect(laptop.missing.has('ws-1')).toBe(true);
    });

    it('removes a workspace missing from its host here and its manifest there', async () => {
      const { laptop } = await shared();
      rmSync(backend().remoteDirectory, { recursive: true, force: true });
      laptop.workspaces.get('ws-1')!.name = 'renamed';
      laptop.saveSoon();
      await settle(laptop);
      expect(laptop.missing.has('ws-1')).toBe(true);

      await laptop.manifests.removeMissing('ws-1');

      expect(laptop.workspaces.has('ws-1')).toBe(false);
      expect(onHost('ws-1')).toBeUndefined();
    });

    it('does not take stale state from a device without sync and restores its own', async () => {
      const { laptop, desktop } = await shared();
      laptop.workspaces.get('ws-1')!.customName = 'Login fix';
      laptop.saveSoon();
      await settle(laptop);
      await desktop.syncHost();
      desktop.state.syncs = false;

      // The desktop stops syncing, then writes its copy, which never took the next rename.
      laptop.workspaces.get('ws-1')!.customName = 'Login fix v2';
      laptop.saveSoon();
      await settle(laptop);
      desktop.workspaces.get('ws-1')!.status = 'trashed';
      desktop.saveSoon();
      await settle(desktop);
      expect(onHost('ws-1')).toMatchObject({ writtenBy: 'desktop', status: 'trashed' });
      expect(onHost('ws-1')?.syncs).toBeUndefined();

      await laptop.syncHost();

      expect(laptop.workspaces.get('ws-1')).toMatchObject({
        customName: 'Login fix v2',
        status: 'active',
      });
      expect(onHost('ws-1')).toMatchObject({ writtenBy: 'laptop', customName: 'Login fix v2' });
    });

    it('settles devices that disagreed before syncing on active, whichever syncs first', async () => {
      for (const order of ['trashed first', 'active first']) {
        rmSync(join(base, 'workspaces'), { recursive: true, force: true });
        // Written by a version without sync, which wrote no status.
        const { status: _status, ...old } = buildSshWorkspaceManifest(workspace('ws-1'), 1)!;
        mkdirSync(join(base, 'workspaces'), { recursive: true });
        writeFileSync(join(base, 'workspaces', 'ws-1.json'), JSON.stringify(old));
        const laptop = device('laptop').restore(workspace('ws-1', { status: 'trashed' }));
        const desktop = device('desktop').restore(workspace('ws-1'));

        const [first, second] = order === 'trashed first' ? [laptop, desktop] : [desktop, laptop];
        await first.syncHost();
        await second.syncHost();
        await first.syncHost();
        await second.syncHost();

        expect([laptop, desktop].map((entry) => entry.workspaces.get('ws-1')?.status)).toEqual([
          'active',
          'active',
        ]);
      }
    });

    it('publishes a rename made while the host was unreachable after a restart', async () => {
      const savedPath = join(scratch, 'laptop-sync.json');
      const laptop = device('laptop', { savedPath });
      const desktop = device('desktop');
      laptop.workspaces.set('ws-1', workspace('ws-1'));
      laptop.saveSoon();
      await settle(laptop);
      await desktop.syncHost();
      desktop.workspaces.get('ws-1')!.customDescription = 'From the desktop';
      desktop.saveSoon();
      await settle(desktop);
      await laptop.syncHost();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Renamed while offline, so the write never landed; then Komla restarts.
      const restored = { ...laptop.workspaces.get('ws-1')!, customName: 'Renamed offline' };
      const restarted = device('laptop', { savedPath }).restore(restored);
      await restarted.syncHost();
      await desktop.syncHost();

      expect(desktop.workspaces.get('ws-1')).toMatchObject({
        customName: 'Renamed offline',
        customDescription: 'From the desktop',
      });
      expect(restarted.workspaces.get('ws-1')?.customDescription).toBe('From the desktop');
    });
  }
);

describe.skipIf(process.platform === 'win32')('SSH workspace host scripts', () => {
  const tombstones = () => join(base, 'workspaces', 'deleted');
  const leaveTombstone = (workspaceId: string) => {
    mkdirSync(tombstones(), { recursive: true });
    writeFileSync(join(tombstones(), workspaceId), '');
  };

  it('reports a workspace deleted even when a new one uses its directory', async () => {
    mkdirSync(backend().remoteDirectory, { recursive: true });
    leaveTombstone('ws-1');

    await expect(sshWorkspaceSyncHost.inspect(backend(), 'ws-1')).resolves.toEqual({
      state: 'deleted',
    });
  });

  it('does not write a manifest over a Tombstone', async () => {
    leaveTombstone('ws-1');

    await expect(sshWorkspaceSyncHost.write(backend(), 'ws-1', '{}')).resolves.toBe(false);
    expect(existsSync(join(base, 'workspaces', 'ws-1.json'))).toBe(false);
  });

  it('does not list a manifest written while its workspace was deleted', async () => {
    await sshWorkspaceSyncHost.write(backend(), 'ws-1', '{"schema":1}');
    await sshWorkspaceSyncHost.write(backend(), 'ws-2', '{"schema":1}');
    leaveTombstone('ws-1');

    await expect(sshWorkspaceSyncHost.read('ssh-dev')).resolves.toEqual(['{"schema":1}']);
  });

  it('prunes Tombstones older than 30 days when it leaves one', async () => {
    leaveTombstone('ws-old');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(tombstones(), 'ws-old'), old, old);

    await sshWorkspaceSyncHost.delete(backend(), 'ws-1');

    expect(existsSync(join(tombstones(), 'ws-1'))).toBe(true);
    expect(existsSync(join(tombstones(), 'ws-old'))).toBe(false);
  });

  it('refuses manifest ids that could escape the manifest directory', async () => {
    await expect(
      sshWorkspaceSyncHost.write(backend(), '../../.ssh/authorized_keys', '{}')
    ).rejects.toThrow('Invalid SSH workspace manifest id');
  });
});
