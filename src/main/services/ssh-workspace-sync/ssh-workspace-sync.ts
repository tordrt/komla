import { posix as pathPosix } from 'path';

import { getWorkspaceDynamicTitle } from '../../../shared/lib/workspace-title';
import {
  isSshWorkspace,
  type SshWorkspaceBackend,
  type Workspace,
  type WorkspaceStatus,
} from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';

import {
  buildSshWorkspaceManifest,
  mergeSshWorkspaceManifest,
  parseSshWorkspaceManifest,
  sshWorkspaceManifestContentKey,
  sshWorkspaceManifestSyncedFieldsEqual,
  validSshWorkspaceManifest,
  type SshWorkspaceOnHost,
} from './workspace-manifest';

import type {
  RemoteSshWorkspace,
  SshWorkspaceLaunch,
  SshWorkspaceManifest,
} from '../../../shared/types/ssh-workspace-manifest';

const logger = createLogger('SshWorkspaceSync');

// How often focusing Komla or opening a workspace checks its SSH host for changes made by other
// Komla installations
const SYNC_INTERVAL_MS = 30_000;

// How long a workspace's manifest keeps the agent's title before taking a newer one: agents
// retitle their terminals often, and only the host's phone list shows it
const AGENT_TITLE_INTERVAL_MS = 5 * 60_000;
const MAX_AGENT_TITLE_CHARS = 256;

// How long a host is synced again each interval after another installation last changed its
// workspaces there, such as one it started, whose tabs' sessions start after the sync adds it
const FOLLOW_UP_MS = 5 * 60_000;

interface FollowUp {
  /** When following up on the last change from another installation ends. */
  until: number;
  timer?: NodeJS.Timeout;
}

interface AgentTitle {
  /** The title the manifest carries, this installation's or another's. */
  title?: string;
  /** The agent's title here when the manifest last took it, or when it took another's. */
  seen?: string;
  /** When the manifest last took the agent's title. */
  at: number;
  /** Writes the newer title once the interval is up. */
  timer?: NodeJS.Timeout;
}

interface HostSync {
  at: number;
  running?: Promise<void>;
  /** The pass a caller asked for while this one ran. */
  next?: Promise<void>;
}

type SshWorkspace = Workspace & { backend: SshWorkspaceBackend };

/** The title the workspace's agent set here, as its manifest carries it. */
function agentTitleHere(workspace: Workspace): string | undefined {
  return getWorkspaceDynamicTitle(workspace)?.trim().slice(0, MAX_AGENT_TITLE_CHARS) || undefined;
}

/** The Workspace manifests, Tombstones and Managed Remote Terminal Sessions on SSH hosts. */
export interface SshWorkspaceSyncHost {
  inspect: (backend: SshWorkspaceBackend, workspaceId: string) => Promise<SshWorkspaceOnHost>;
  /** Returns false, writing nothing, when a Komla installation deleted the workspace. */
  write: (backend: SshWorkspaceBackend, workspaceId: string, content: string) => Promise<boolean>;
  delete: (backend: SshWorkspaceBackend, workspaceId: string) => Promise<void>;
  /** `background` when no one is waiting on the listing, e.g. a sync. */
  read: (hostId: string, options: { background: boolean }) => Promise<string[]>;
  /** The Terminals among `terminalIds` whose sessions run on the host. */
  findTerminalSessions: (
    backend: SshWorkspaceBackend,
    terminalIds: string[]
  ) => Promise<Set<string>>;
  /** Removes a workspace's manifest if its files are gone, so no installation adds it again. */
  removeOrphaned: (backend: SshWorkspaceBackend, workspaceId: string) => Promise<void>;
  /** Whether the SSH host is configured here. */
  hasHost: (hostId: string) => boolean;
  /** The SSH hosts configured here whose setup has finished. */
  readyHosts: () => string[];
  /** The host's Komla data directory, which holds its repositories and worktrees. */
  basePath: (hostId: string) => Promise<string>;
}

/** The parts of an SSH workspace's backend that identify its repository. */
export type SshWorkspaceRepository = Pick<
  SshWorkspaceBackend,
  'hostId' | 'remoteRepoPath' | 'gitUrl'
>;

/** Where an adopted workspace goes: its project, and the workspace an agent started it from. */
export interface SshWorkspacePlacement {
  projectId: string | null;
  /** On the same clone; the adopted workspace takes its agent and window. */
  sibling?: SshWorkspace;
}

/**
 * This installation's workspaces. SSH Workspace Sync decides what changes;
 * the store makes the change, and only saves or tells windows when asked.
 */
export interface SshWorkspaceSyncStore {
  workspaces: () => Iterable<Workspace>;
  /** The workspace with this id, even one being deleted. */
  get: (workspaceId: string) => Workspace | undefined;
  isDeleting: (workspaceId: string) => boolean;
  /**
   * Resolves to a lookup of this installation's project for an SSH workspace's
   * repository. It reads the projects' origins once and the workspaces when called.
   */
  projectLookup: () => Promise<(repository: SshWorkspaceRepository) => string | null>;
  /** Adds a workspace adopted from its manifest where `placement` says, and saves it. */
  add: (
    hostId: string,
    manifest: SshWorkspaceManifest,
    placement: SshWorkspacePlacement
  ) => Workspace;
  /** Deletes the workspace here only, leaving its files and manifest on the host. */
  deleteHere: (workspaceId: string) => Promise<void>;
  /** A sync pass read the host, e.g. to check which tabs not attached here run there. */
  hostSynced: (hostId: string) => Promise<void>;
  /** Takes a merged manifest's names, tabs and layout; returns the ids of the tabs it added. */
  applyMerged: (workspaceId: string, merged: SshWorkspaceManifest) => string[];
  /**
   * Moves the workspace to the Trash or restores it, as another installation did.
   * Never hides it while its agents may run: rejects, keeping the status, if they can't be stopped.
   */
  changeStatus: (workspaceId: string, status: WorkspaceStatus) => Promise<void>;
  removeTerminal: (workspaceId: string, terminalId: string) => Promise<void>;
  /** Saves the workspaces, which publishes their manifests again. */
  save: () => void;
  /** Tells windows the workspace changed. */
  changed: (workspaceId: string) => void;
  /** Tells windows another installation opened tabs, `addedTerminalIds`, or `arranged` them. */
  layoutChanged: (
    workspaceId: string,
    change: { addedTerminalIds: string[]; arranged: boolean }
  ) => void;
  /** The workspace is missing from its host: its files are gone and no Tombstone says why. */
  markMissing: (workspaceId: string) => void;
  /** The files of a workspace marked missing are on its host again. */
  markFound: (workspaceId: string) => void;
  /** Removes here a workspace another installation deleted, leaving the host alone. */
  removeDeletedElsewhere: (workspaceId: string) => Promise<void>;
}

export interface SshWorkspaceSyncDependencies {
  host: SshWorkspaceSyncHost;
  store: SshWorkspaceSyncStore;
  now: () => number;
  /** Identifies this installation in the manifests it writes. */
  deviceId: () => string;
  /** Whether this installation takes other installations' workspaces and changes on a host. */
  syncsWith: (hostId: string) => boolean;
  /** Agent launch commands the host's CLI uses to start workspaces while Komla is disconnected. */
  launch?: (workspace: Workspace) => SshWorkspaceLaunch | undefined;
  /** Keeps the Host copies across restarts, so merges after one start from them. */
  hostCopies?: {
    read: () => string | undefined;
    write: (content: string) => Promise<void>;
  };
  /** The user is in Komla, e.g. a window is focused. Follow-up syncs wait for it. */
  inUse?: () => boolean;
}

/**
 * SSH Workspace Sync: keeps an SSH host's workspaces consistent across the
 * Komla installations that use it. It publishes each workspace's manifest on
 * its host, merges and applies other installations' changes before writing
 * over theirs, adopts the workspaces they start and removes the ones they
 * delete. Writes are best effort: a failed write is retried on the next
 * change or the next sync with the host.
 */
export class SshWorkspaceSync {
  /** Content key last queued for writing, or known to be on the host, per workspace. */
  private readonly published = new Map<string, string>();
  /** The manifest last known to be on the host per workspace: the base of three-way merges. */
  private readonly onHost = new Map<string, SshWorkspaceManifest>();
  /** The base until a host copy is known, e.g. on the first run of this version. Not saved. */
  private readonly standIns = new Map<string, SshWorkspaceManifest>();
  private readonly writes = new Map<string, Promise<void>>();
  /** Deleted here this session; a listing read before must not add them back. */
  private readonly deletedHere = new Set<string>();
  private readonly hostSyncs = new Map<string, HostSync>();
  /** The hosts synced again each interval after another installation changed their workspaces. */
  private readonly followUps = new Map<string, FollowUp>();
  /** The agent's title each workspace's manifest carries. */
  private readonly agentTitles = new Map<string, AgentTitle>();
  private disposed = false;
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(private readonly dependencies: SshWorkspaceSyncDependencies) {}

  /**
   * Records restored workspaces as already published so startup does not
   * contact every host, with the host copies saved before the restart.
   */
  restored(workspaces: Iterable<Workspace>): void {
    const saved = this.readSaved();
    for (const workspace of workspaces) {
      // The host's copy keeps its title until the interval is up, as after any other write, and
      // until the agent here retitles, as another device may have written it since. One with no
      // title yet, e.g. written by an older version, takes this installation's then.
      const title = saved.get(workspace.id)?.agentTitle;
      this.agentTitles.set(workspace.id, {
        title,
        seen: title === undefined ? undefined : agentTitleHere(workspace),
        at: this.dependencies.now(),
      });
      const manifest = this.build(workspace, 0);
      if (!manifest) continue;
      this.published.set(workspace.id, sshWorkspaceManifestContentKey(manifest));
      const copy = saved.get(workspace.id);
      // Without a saved copy, e.g. on the first run of this version, this installation's own
      // stands in. Status and tabs may have differed before sync: merges settle status on
      // active and combine tabs rather than take the other installation's as changes. A
      // different arrangement of the tabs counts as one, so devices settle on one layout.
      if (copy) this.onHost.set(workspace.id, copy);
      else this.standIns.set(workspace.id, { ...manifest, status: undefined, terminals: [] });
    }
  }

  /** Records the manifest a workspace was just adopted from as what its host holds. */
  private adopted(manifest: SshWorkspaceManifest): void {
    this.setOnHost(manifest.workspaceId, manifest);
  }

  /** Publishes the manifests of saved workspaces whose content changed since last written. */
  saved(workspaces: Iterable<Workspace>): void {
    this.publishChanges(workspaces);
  }

  /**
   * Syncs a host, or every host this installation syncs with, unless it was
   * synced within the last interval; `now` skips the interval. Concurrent calls
   * share one pass, except that one asking for `now` also gets one after it,
   * since e.g. a new connection can reach what the running pass could not.
   */
  syncSoon(hostId?: string, { now = false }: { now?: boolean } = {}): Promise<void> {
    if (hostId === undefined) {
      const hostIds = this.dependencies.host
        .readyHosts()
        .filter((candidate) => this.dependencies.syncsWith(candidate));
      return Promise.all(hostIds.map((candidate) => this.syncSoon(candidate, { now }))).then(
        () => undefined
      );
    }
    const minIntervalMs = now ? 0 : SYNC_INTERVAL_MS;
    const previous = this.hostSyncs.get(hostId);
    if (previous?.running) {
      if (minIntervalMs > 0) return previous.running;
      previous.next ??= previous.running.then(() => this.syncSoon(hostId, { now: true }));
      return previous.next;
    }
    if (previous && this.dependencies.now() - previous.at < minIntervalMs) return Promise.resolve();
    const state: HostSync = { at: this.dependencies.now() };
    state.running = this.syncHost(hostId)
      .then((read) => {
        this.afterPass(hostId, read);
        // The host couldn't be read, so checking its tmux sessions would only time out too.
        return read ? this.dependencies.store.hostSynced(hostId) : undefined;
      })
      .catch((error) => {
        this.afterPass(hostId, false);
        logger.warn('Could not sync SSH workspaces with other Komla installations', {
          hostId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.running = undefined;
      });
    this.hostSyncs.set(hostId, state);
    return state.running;
  }

  /** Stops syncing hosts again on its own, as when Komla quits. */
  dispose(): void {
    this.disposed = true;
    for (const { timer } of this.followUps.values()) clearTimeout(timer);
    this.followUps.clear();
    for (const { timer } of this.agentTitles.values()) clearTimeout(timer);
    this.agentTitles.clear();
  }

  /**
   * Another installation started a workspace on the host, or opened a tab, whose sessions may
   * start after this installation adds it: the host is synced again each interval for a while.
   */
  private startedElsewhere(hostId: string): void {
    if (this.disposed || !this.dependencies.syncsWith(hostId)) return;
    const pending = this.followUps.get(hostId) ?? { until: 0 };
    pending.until = this.dependencies.now() + FOLLOW_UP_MS;
    this.followUps.set(hostId, pending);
    // A merge can land after its pass ended.
    if (!pending.timer) this.scheduleFollowUp(hostId, pending);
  }

  /**
   * Schedules the host's next follow-up after a pass, while it has one. One it can't read is left
   * to the next focus: it would time out, or ask for a password.
   */
  private afterPass(hostId: string, read: boolean): void {
    const pending = this.followUps.get(hostId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = undefined;
    if (!read || this.dependencies.now() >= pending.until) {
      this.followUps.delete(hostId);
      return;
    }
    this.scheduleFollowUp(hostId, pending);
  }

  private scheduleFollowUp(hostId: string, pending: FollowUp): void {
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      if (!this.dependencies.syncsWith(hostId)) {
        this.followUps.delete(hostId);
        return;
      }
      // Focusing Komla again syncs, and that pass follows up again.
      if (this.dependencies.inUse?.() === false) return;
      // A pass still running follows up when it ends.
      void this.syncSoon(hostId);
    }, SYNC_INTERVAL_MS);
    pending.timer.unref?.();
  }

  private publishChanges(workspaces: Iterable<Workspace>): void {
    for (const workspace of workspaces) {
      this.takeAgentTitle(workspace);
      const manifest = this.build(workspace, this.dependencies.now());
      const { backend } = workspace;
      if (!manifest || backend?.kind !== 'ssh') continue;
      const key = sshWorkspaceManifestContentKey(manifest);
      if (this.published.get(workspace.id) === key) continue;
      this.published.set(workspace.id, key);
      // Built again when its turn comes: a write queued before it may merge changes into it.
      this.enqueue(workspace.id, () => this.publish(workspace, backend)).catch((error: unknown) => {
        if (this.published.get(workspace.id) === key) this.published.delete(workspace.id);
        logger.warn('Could not publish SSH workspace manifest', {
          workspaceId: workspace.id,
          hostId: backend.hostId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Merges what other installations changed in this installation's workspaces
   * on a host, and adds the workspaces they started there. Without sync, only
   * workspaces agents created while no installation was connected are added.
   * Resolves to whether it read the host and the host is still configured.
   */
  private async syncHost(hostId: string): Promise<boolean> {
    const { host, store } = this.dependencies;
    if (!host.hasHost(hostId)) return false;
    const manifests = await this.reconcileHost(hostId);
    if (!manifests) return false;
    const addAll = this.dependencies.syncsWith(hostId);
    let projects: ReturnType<SshWorkspaceSyncStore['projectLookup']> | undefined;
    // Each goes on top, so the newest ends up first.
    const oldestFirst = [...manifests].sort((a, b) => a.createdAt - b.createdAt);
    for (const manifest of oldestFirst) {
      const { workspaceId } = manifest;
      // The host may have been removed while it was read.
      if (!host.hasHost(hostId)) return false;
      if (!addAll && !manifest.adoptOnConnect) continue;
      if (store.get(workspaceId) || store.isDeleting(workspaceId)) continue;
      if (this.deletedHere.has(workspaceId)) continue;
      if (this.workspaceInDirectory(hostId, manifest.backend.remoteDirectory)) continue;
      projects ??= store.projectLookup();
      await this.adoptManifest(hostId, manifest, projects).catch((error) => {
        logger.warn('Could not add an SSH workspace from another Komla installation', {
          hostId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return true;
  }

  /** Lists the workspaces on an SSH host that any Komla installation has published. */
  async listOnHost(hostId: string): Promise<RemoteSshWorkspace[]> {
    this.assertHost(hostId);
    const manifests = await this.list(hostId);
    // Synced workspaces are on every installation that syncs with the host.
    const synced = this.dependencies.syncsWith(hostId);
    const deviceId = this.dependencies.deviceId();
    return manifests
      .map((manifest) => {
        const adopted = this.dependencies.store.get(manifest.workspaceId) !== undefined;
        return {
          workspaceId: manifest.workspaceId,
          name: manifest.customName || manifest.name,
          branchName: manifest.branchName,
          repoName: manifest.repoName,
          terminalCount: manifest.terminals.length,
          updatedAt: manifest.updatedAt,
          adopted,
          mayBeOnOtherDevices: !adopted || synced || manifest.writtenBy !== deviceId,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Adds a workspace published on an SSH host to this installation. Its
   * terminals keep their ids, so reconnecting attaches to the same tmux sessions.
   */
  async adopt(hostId: string, workspaceId: string): Promise<Workspace> {
    const existing = this.dependencies.store.get(workspaceId);
    if (existing) return existing;
    this.assertHost(hostId);
    const manifest = (await this.list(hostId)).find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!manifest) {
      throw new Error('That workspace is no longer on this SSH host.');
    }
    return this.adoptManifest(hostId, manifest, this.dependencies.store.projectLookup());
  }

  /**
   * Removes a workspace missing from its host from this installation only;
   * other installations that have it decide for themselves.
   */
  async removeMissing(workspaceId: string): Promise<void> {
    const workspace = this.dependencies.store.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) {
      throw new Error(`SSH workspace ${workspaceId} not found`);
    }
    if (!workspace.removedFromHost) {
      throw new Error('This workspace’s files are on its SSH host again.');
    }
    const { backend } = workspace;
    await this.dependencies.store.deleteHere(workspaceId);
    // Left in place, its manifest would add it back here on the next launch.
    await this.dependencies.host.removeOrphaned(backend, workspaceId).catch((error) => {
      logger.warn('Could not remove the manifest of an SSH workspace missing from its host', {
        workspaceId,
        hostId: backend.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private assertHost(hostId: string): void {
    if (!this.dependencies.host.hasHost(hostId)) {
      throw new Error(`SSH host ${hostId} not found`);
    }
  }

  private async adoptManifest(
    hostId: string,
    manifest: SshWorkspaceManifest,
    projects: ReturnType<SshWorkspaceSyncStore['projectLookup']>
  ): Promise<Workspace> {
    const { store } = this.dependencies;
    const basePath = await this.dependencies.host.basePath(hostId);
    const { remoteDirectory, remoteRepoPath, remoteProjectRoot } = manifest.backend;
    const isUnder = (path: string, root: string) =>
      pathPosix.normalize(path) === path && path.startsWith(`${root}/`);
    if (
      !isUnder(remoteProjectRoot, `${basePath}/worktrees`) ||
      !isUnder(remoteRepoPath, `${basePath}/repos`) ||
      !isUnder(remoteDirectory, remoteProjectRoot)
    ) {
      throw new Error("That workspace's files are outside this host's Komla data directory.");
    }
    await this.assertFilesOnHost(hostId, manifest);
    const projectOf = await projects;
    // Adoption may have raced with another call while the host was read.
    const raced = store.get(manifest.workspaceId);
    if (raced) return raced;
    const sameDirectory = this.workspaceInDirectory(hostId, remoteDirectory);
    if (sameDirectory) {
      throw new Error(
        `That workspace’s directory is already open here as "${sameDirectory.customName || sameDirectory.name}".`
      );
    }

    // A workspace an agent started on the host belongs with the workspace it came from.
    const source = manifest.sourceWorkspaceId ? store.get(manifest.sourceWorkspaceId) : undefined;
    const sibling =
      source &&
      isSshWorkspace(source) &&
      source.backend.hostId === hostId &&
      source.backend.remoteRepoPath === remoteRepoPath
        ? source
        : undefined;
    const workspace = store.add(hostId, manifest, {
      projectId: sibling?.projectId ?? projectOf({ hostId, ...manifest.backend }),
      sibling,
    });
    // The save rewrites the manifest from this installation if it differs, which
    // clears a pending adoption so other installations without sync leave it to the user.
    this.adopted(manifest);
    this.startedElsewhere(hostId);
    return workspace;
  }

  /** Refuses a workspace whose files are gone, e.g. one whose deletion elsewhere left no tombstone. */
  private async assertFilesOnHost(hostId: string, manifest: SshWorkspaceManifest): Promise<void> {
    const found = await this.dependencies.host.inspect(
      { kind: 'ssh', hostId, ...manifest.backend },
      manifest.workspaceId
    );
    if (found.state !== 'present') {
      throw new Error('That workspace’s files are no longer on this SSH host.');
    }
  }

  /**
   * The workspace here that uses a directory on an SSH host. Another id for it, e.g. from a
   * workspace list rebuilt by hand, would show the directory twice and share its terminals.
   * One whose files went missing, or being deleted, leaves the directory to a new workspace.
   */
  private workspaceInDirectory(hostId: string, remoteDirectory: string): Workspace | undefined {
    const { store } = this.dependencies;
    for (const workspace of store.workspaces()) {
      if (
        isSshWorkspace(workspace) &&
        workspace.backend.hostId === hostId &&
        workspace.backend.remoteDirectory === remoteDirectory &&
        !workspace.removedFromHost &&
        !store.isDeleting(workspace.id)
      ) {
        return workspace;
      }
    }
    return undefined;
  }

  /**
   * After a connection, merges what other installations changed on the host,
   * writes the manifests this installation owes it (ones missing there and
   * ones whose last write did not land), and checks again on workspaces whose
   * files were missing. Returns the manifests found on the host, or undefined
   * when it couldn't be read.
   */
  private async reconcileHost(hostId: string): Promise<SshWorkspaceManifest[] | undefined> {
    let manifests: SshWorkspaceManifest[];
    try {
      manifests = await this.list(hostId, true);
    } catch (error) {
      logger.warn('Could not read SSH workspace manifests', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const found = new Map(manifests.map((manifest) => [manifest.workspaceId, manifest]));
    // Read after the host replies so workspaces deleted meanwhile are not republished.
    const onHost = Array.from(this.dependencies.store.workspaces()).filter(
      (workspace) => isSshWorkspace(workspace) && workspace.backend.hostId === hostId
    );
    for (const workspace of onHost) {
      if (workspace.removedFromHost && isSshWorkspace(workspace)) {
        const { remoteDirectory } = workspace.backend;
        // A new workspace on the same branch can recreate the directory of one deleted without a trace.
        const reused = manifests.some(
          (manifest) =>
            manifest.workspaceId !== workspace.id &&
            manifest.backend.remoteDirectory === remoteDirectory
        );
        this.published.delete(workspace.id);
        this.recheck(workspace.backend, workspace.id, reused);
        continue;
      }
      const remote = found.get(workspace.id);
      // Publishing reads the host's copy again, after this installation's queued writes,
      // and first checks whether a missing manifest's workspace was deleted.
      if (!remote || this.owesHost(hostId, remote) || this.changedSinceHost(workspace)) {
        this.published.delete(workspace.id);
      }
    }
    this.publishChanges(onHost);
    return manifests;
  }

  /** Whether a manifest on the host lacks this installation's last write, or has changes to merge. */
  private owesHost(hostId: string, remote: SshWorkspaceManifest): boolean {
    const { workspaceId } = remote;
    const remoteKey = sshWorkspaceManifestContentKey(remote);
    if (remote.writtenBy === this.dependencies.deviceId()) {
      return this.published.get(workspaceId) !== remoteKey;
    }
    const base = this.base(workspaceId);
    // Without sync, a newer copy from another installation is left alone.
    return (
      (!base || sshWorkspaceManifestContentKey(base) !== remoteKey) &&
      this.dependencies.syncsWith(hostId)
    );
  }

  /**
   * Whether names, status, tabs or their arrangement changed here since the host's
   * copy, e.g. while the host was unreachable before a restart forgot the failed write.
   */
  private changedSinceHost(workspace: Workspace): boolean {
    const base = this.onHost.get(workspace.id);
    const local = base && this.build(workspace, 0);
    return Boolean(local && !sshWorkspaceManifestSyncedFieldsEqual(local, base));
  }

  /**
   * Checks again on a workspace whose files were missing: another installation may
   * have deleted it since. Files in a directory another workspace uses are not its own.
   */
  private recheck(backend: SshWorkspaceBackend, workspaceId: string, reused: boolean): void {
    this.enqueue(workspaceId, async () => {
      const found = await this.dependencies.host.inspect(backend, workspaceId);
      if (found.state === 'present' && !reused) this.dependencies.store.markFound(workspaceId);
      else if (found.state === 'deleted' && this.dependencies.syncsWith(backend.hostId)) {
        this.removeDeletedElsewhere(workspaceId);
      }
    }).catch((error: unknown) => {
      logger.warn('Could not check on an SSH workspace missing from its host', {
        workspaceId,
        hostId: backend.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Another installation deleted the workspace; without sync, the user decides what to do here. */
  private gone(hostId: string, workspaceId: string): void {
    if (this.dependencies.syncsWith(hostId)) this.removeDeletedElsewhere(workspaceId);
    else this.dependencies.store.markMissing(workspaceId);
  }

  private removeDeletedElsewhere(workspaceId: string): void {
    void this.dependencies.store.removeDeletedElsewhere(workspaceId).catch((error: unknown) => {
      logger.warn('Could not remove an SSH workspace deleted by another Komla installation', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async publish(workspace: Workspace, backend: SshWorkspaceBackend) {
    const manifest = this.build(workspace, this.dependencies.now());
    if (!manifest) return;
    const { workspaceId } = manifest;
    const found = await this.dependencies.host.inspect(backend, workspaceId);
    if (found.state === 'deleted') return this.gone(backend.hostId, workspaceId);
    if (found.state === 'missing') return this.dependencies.store.markMissing(workspaceId);
    const current =
      found.manifest === undefined ? undefined : parseSshWorkspaceManifest(found.manifest);
    // The merged workspace's save publishes again.
    if (current && (await this.receive(backend.hostId, current))) return;
    if (
      current &&
      sshWorkspaceManifestContentKey(current) === sshWorkspaceManifestContentKey(manifest)
    ) {
      this.setOnHost(workspaceId, current);
      return;
    }
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    if (!(await this.dependencies.host.write(backend, workspaceId, content))) {
      return this.gone(backend.hostId, workspaceId);
    }
    this.setOnHost(workspaceId, manifest);
  }

  /**
   * Takes in a manifest just read from the host for a workspace this
   * installation has. Resolves to true when it merged another installation's changes.
   */
  private async receive(hostId: string, remote: SshWorkspaceManifest): Promise<boolean> {
    const { workspaceId } = remote;
    if (remote.writtenBy === this.dependencies.deviceId()) {
      this.setOnHost(workspaceId, remote);
      return false;
    }
    const base = this.base(workspaceId);
    if (base && sshWorkspaceManifestContentKey(base) === sshWorkspaceManifestContentKey(remote)) {
      return false;
    }
    // Without sync, a newer copy from another installation is overwritten. So is one from an
    // installation without sync or an older version: it may predate changes made here.
    if (!this.dependencies.syncsWith(hostId) || !remote.syncs) return false;
    const tabsBefore = new Set(this.workspace(workspaceId)?.terminals.map(({ id }) => id));
    const workspace = await this.applyChanges(workspaceId, remote, base);
    if (workspace) this.takeOthersAgentTitle(workspace, remote);
    this.setOnHost(workspaceId, remote);
    const merged = workspace && this.build(workspace, 0);
    if (merged && sshWorkspaceManifestSyncedFieldsEqual(merged, remote)) {
      // Writing back would only restate it, and the other installation would answer in kind.
      this.published.set(workspaceId, sshWorkspaceManifestContentKey(merged));
    } else {
      this.published.delete(workspaceId);
    }
    if (workspace?.terminals.some(({ id }) => !tabsBefore.has(id))) this.startedElsewhere(hostId);
    return true;
  }

  /** The SSH workspace with this id, as it is now, unless it is being deleted. */
  private workspace(workspaceId: string): SshWorkspace | undefined {
    const { store } = this.dependencies;
    const workspace = store.get(workspaceId);
    return workspace && isSshWorkspace(workspace) && !store.isDeleting(workspaceId)
      ? workspace
      : undefined;
  }

  /**
   * Applies what another installation changed in an SSH workspace's manifest:
   * renames, agent tabs opened, closed or rearranged, and moving it to the Trash or restoring it.
   * Resolves to the updated workspace, or undefined when there is none to update.
   */
  private async applyChanges(
    workspaceId: string,
    remote: SshWorkspaceManifest,
    base: SshWorkspaceManifest | undefined
  ): Promise<Workspace | undefined> {
    const { store } = this.dependencies;
    const before = this.workspace(workspaceId);
    if (!before) return undefined;
    await this.removeTerminalsClosedElsewhere(before, remote, base);
    const workspace = this.workspace(workspaceId);
    const local = workspace && buildSshWorkspaceManifest(workspace, 0);
    if (!workspace || !local) return undefined;
    const { manifest: merged, arranged } = mergeSshWorkspaceManifest(base, local, remote);

    const addedTerminalIds = store.applyMerged(workspaceId, merged);
    let statusError: unknown;
    if (merged.status && merged.status !== workspace.status) {
      await store
        .changeStatus(workspaceId, merged.status)
        .catch((error: unknown) => (statusError = error));
    }

    const updated = this.workspace(workspaceId) ?? workspace;
    const after = buildSshWorkspaceManifest(updated, 0);
    // Built without layout sync, these compare names, status and tabs: a new arrangement
    // reaches windows through layoutChanged alone.
    const changed = !after || !sshWorkspaceManifestSyncedFieldsEqual(local, after);
    // Saving publishes this installation's changes the other one lacks, if any. After a failed
    // stop, publishing would only merge and fail again; the next sync tries again.
    if (changed || !statusError) store.save();
    if (changed) store.changed(workspaceId);
    if (arranged || addedTerminalIds.length > 0) {
      store.layoutChanged(workspaceId, { addedTerminalIds, arranged });
    }
    if (statusError) throw statusError;
    return updated;
  }

  /**
   * Removes the tabs another installation closed once tmux confirms their sessions
   * ended. A tab whose session still runs stays and is published again: a copy can
   * lack a tab nobody closed, e.g. one written by an installation that had not seen it yet.
   */
  private async removeTerminalsClosedElsewhere(
    workspace: SshWorkspace,
    remote: SshWorkspaceManifest,
    base: SshWorkspaceManifest | undefined
  ): Promise<void> {
    // A workspace in the Trash had its sessions stopped on purpose, so tmux can't tell.
    if (workspace.status !== 'active') return;
    const remoteIds = new Set(remote.terminals.map((terminal) => terminal.id));
    const closed = new Set(
      base?.terminals
        .map((terminal) => terminal.id)
        .filter((terminalId) => !remoteIds.has(terminalId))
    );
    const candidates = workspace.terminals
      .filter((terminal) => closed.has(terminal.id))
      .map((terminal) => terminal.id);
    if (candidates.length === 0) return;
    const running = await this.dependencies.host.findTerminalSessions(
      workspace.backend,
      candidates
    );
    for (const terminalId of candidates) {
      if (running.has(terminalId)) continue;
      if (!workspace.terminals.some((terminal) => terminal.id === terminalId)) continue;
      await this.dependencies.store.removeTerminal(workspace.id, terminalId);
    }
  }

  /**
   * Records that this installation deleted a workspace, so a listing read before
   * doesn't add it back. Unless its files were left on its host, replaces its
   * manifest there with a Tombstone; failures are logged, not thrown.
   */
  async deleted(workspace: Workspace, { leftOnHost }: { leftOnHost: boolean }): Promise<void> {
    this.deletedHere.add(workspace.id);
    clearTimeout(this.agentTitles.get(workspace.id)?.timer);
    this.agentTitles.delete(workspace.id);
    if (leftOnHost || !isSshWorkspace(workspace)) this.forget(workspace.id);
    else await this.remove(workspace.id, workspace.backend);
  }

  /**
   * Lets a host added again bring back the workspaces deleted here along with
   * it. Ones deleted before stay deleted for the rest of the session.
   */
  hostForgotten(workspaceIds: Iterable<string>): void {
    for (const workspaceId of workspaceIds) this.deletedHere.delete(workspaceId);
  }

  /** Replaces a deleted workspace's manifest with a tombstone. Failures are logged, not thrown. */
  private async remove(workspaceId: string, backend: SshWorkspaceBackend): Promise<void> {
    this.published.delete(workspaceId);
    this.forgetOnHost(workspaceId);
    try {
      await this.enqueue(workspaceId, () => this.dependencies.host.delete(backend, workspaceId));
    } catch (error) {
      logger.warn('Could not remove SSH workspace manifest', {
        workspaceId,
        hostId: backend.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Forgets local publish state without touching the host, e.g. when a workspace is forgotten. */
  private forget(workspaceId: string): void {
    this.published.delete(workspaceId);
    this.forgetOnHost(workspaceId);
  }

  private base(workspaceId: string): SshWorkspaceManifest | undefined {
    return this.onHost.get(workspaceId) ?? this.standIns.get(workspaceId);
  }

  private setOnHost(workspaceId: string, manifest: SshWorkspaceManifest): void {
    this.standIns.delete(workspaceId);
    this.onHost.set(workspaceId, manifest);
    this.save();
  }

  private forgetOnHost(workspaceId: string): void {
    this.standIns.delete(workspaceId);
    if (this.onHost.delete(workspaceId)) this.save();
  }

  /** Saves every host copy; changes made before a queued save runs are part of it. */
  private save(): void {
    const { hostCopies } = this.dependencies;
    if (!hostCopies || this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving
      .then(() => {
        this.saveQueued = false;
        return hostCopies.write(`${JSON.stringify(Object.fromEntries(this.onHost))}\n`);
      })
      .catch((error: unknown) => {
        logger.warn('Could not save the SSH workspace copies last seen on hosts', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private readSaved(): Map<string, SshWorkspaceManifest> {
    const saved = new Map<string, SshWorkspaceManifest>();
    let value: unknown;
    try {
      const text = this.dependencies.hostCopies?.read();
      if (!text) return saved;
      value = JSON.parse(text);
    } catch (error) {
      logger.warn('Could not read the SSH workspace copies last seen on hosts', {
        error: error instanceof Error ? error.message : String(error),
      });
      return saved;
    }
    if (!value || typeof value !== 'object') return saved;
    for (const [workspaceId, entry] of Object.entries(value)) {
      const manifest = validSshWorkspaceManifest(entry);
      if (manifest?.workspaceId === workspaceId) saved.set(workspaceId, manifest);
    }
    return saved;
  }

  /** Reads the valid manifests on a host. */
  private async list(hostId: string, background = false): Promise<SshWorkspaceManifest[]> {
    const manifests: SshWorkspaceManifest[] = [];
    for (const text of await this.dependencies.host.read(hostId, { background })) {
      const manifest = parseSshWorkspaceManifest(text);
      if (manifest) manifests.push(manifest);
      else logger.warn('Skipping invalid SSH workspace manifest', { hostId });
    }
    return manifests;
  }

  /**
   * Lets the manifest take the agent's current title: a workspace's first at once, a newer one
   * once the interval since the last is up, when a timer writes it unless a save did first.
   */
  private takeAgentTitle(workspace: Workspace): void {
    if (!isSshWorkspace(workspace) || workspace.customName) return;
    const title = agentTitleHere(workspace);
    const taken = this.agentTitles.get(workspace.id);
    // Only a change here replaces the title, so a stale one can't write over another device's.
    if (taken ? taken.seen === title : !title) return;
    const now = this.dependencies.now();
    if (!taken || now >= taken.at + AGENT_TITLE_INTERVAL_MS) {
      clearTimeout(taken?.timer);
      this.agentTitles.set(workspace.id, { title, seen: title, at: now });
      return;
    }
    if (taken.timer) return;
    taken.timer = setTimeout(
      () => {
        taken.timer = undefined;
        const { store } = this.dependencies;
        const current = store.get(workspace.id);
        if (!current) this.agentTitles.delete(workspace.id);
        else if (!this.disposed && !store.isDeleting(workspace.id)) this.publishChanges([current]);
      },
      taken.at + AGENT_TITLE_INTERVAL_MS - now
    );
    taken.timer.unref?.();
  }

  /**
   * Takes the title another installation wrote, newer than the one here: the title here, and one
   * waiting to be written, count as seen, so only the agent retitling here replaces it.
   */
  private takeOthersAgentTitle(workspace: Workspace, remote: SshWorkspaceManifest): void {
    if (remote.agentTitle === undefined) return;
    clearTimeout(this.agentTitles.get(workspace.id)?.timer);
    this.agentTitles.set(workspace.id, {
      title: remote.agentTitle,
      seen: agentTitleHere(workspace),
      at: this.dependencies.now(),
    });
  }

  /** Runs on every save, so it never throws and skips non-SSH workspaces before resolving presets. */
  private build(workspace: Workspace, updatedAt: number): SshWorkspaceManifest | undefined {
    if (!isSshWorkspace(workspace)) return undefined;
    try {
      const manifest = buildSshWorkspaceManifest(
        workspace,
        updatedAt,
        this.dependencies.launch?.(workspace),
        this.dependencies.deviceId(),
        this.dependencies.syncsWith(workspace.backend.hostId)
      );
      // Without a title of its own here, e.g. while another device runs the agent, the
      // workspace keeps the one on its host.
      const taken = this.agentTitles.get(workspace.id);
      const agentTitle = workspace.customName
        ? undefined
        : taken
          ? taken.title
          : this.base(workspace.id)?.agentTitle;
      return manifest && agentTitle ? { ...manifest, agentTitle } : manifest;
    } catch (error) {
      logger.warn('Could not describe SSH workspace for its manifest', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private enqueue<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.writes.set(workspaceId, settled);
    void settled.finally(() => {
      if (this.writes.get(workspaceId) === settled) this.writes.delete(workspaceId);
    });
    return result;
  }
}
