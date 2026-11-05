import { existsSync, readFileSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join, resolve, sep } from 'path';

import { sanitizeWorktreeProjectSegment } from '../../shared/lib/random-names';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { createLogger } from '../lib/logger';
import { removePath } from '../lib/remove-path';

import { KOMLA_FILES_DIR } from './git/git-status';
import { buildKeptPathsCommand, keptPathRules, parseKeptPaths } from './local-copy-kept-paths';
import { collectGitignoreProtectRules } from './local-copy-protect';
import { syncWithSupportedOptions } from './local-copy-rsync';
import { getKomlaBasePath } from './paths';
import { isSshHostDisconnected } from './ssh-host-disconnection';
import { sshWorkspaceService } from './ssh-workspace.service';

import type { SshWorkspaceBackend } from '../../shared/types';
import type { LocalCopySyncStatus } from '../../shared/types/local-copy';

const logger = createLogger('LocalCopyService');
const SYNC_TIMEOUT_MS = 5 * 60_000;
const LOCAL_COPY_OWNER_FILE = '.komla-local-copy';
const LOCAL_COPY_PATH_MAX_ATTEMPTS = 25;
const LOCAL_COPY_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
};
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type SyncReason = 'prepare' | 'remote-change' | 'initial-sync' | 'retry';

function traceSync(message: string, details: Record<string, unknown>): void {
  if (process.env.KOMLA_DIAGNOSTICS === '1') logger.debug(message, details);
}

class LocalCopyService {
  private syncs = new Map<string, Promise<string>>();
  private initializations = new Map<string, Promise<string>>();
  private pendingSyncs = new Set<string>();
  private syncedWorkspaceIds = new Set<string>();
  private syncStatuses = new Map<string, LocalCopySyncStatus>();
  private syncStatusListeners = new Set<(status: LocalCopySyncStatus) => void>();
  private localCopyPaths = new Map<string, string>();
  private pathOwners = new Map<string, string>();
  private leftoverRemovals = new Map<string, Promise<void>>();
  // Counts the remove() calls under way for each workspace.
  private removing = new Map<string, number>();

  getLocalCopyPath(workspaceId: string, backend: SshWorkspaceBackend): string {
    this.validateWorkspaceId(workspaceId);
    const current = this.localCopyPaths.get(workspaceId);
    if (current) return current;

    const root = this.localCopyRoot();
    const projectName =
      backend.projectName || basename(backend.remoteRepoPath).replace(/\.git$/i, '') || 'project';
    const branchName = backend.branchName || basename(backend.remoteDirectory) || 'branch';
    const safeProject = sanitizeWorktreeProjectSegment(projectName);
    const safeBranch = sanitizeWorktreeProjectSegment(branchName);
    const preferred = resolve(root, safeProject, safeBranch);
    const candidates = Array.from({ length: LOCAL_COPY_PATH_MAX_ATTEMPTS }, (_, index) =>
      index === 0 ? preferred : resolve(root, safeProject, `${safeBranch}-${index + 1}`)
    );
    const candidateStates = candidates.map((candidate) => {
      this.assertInsideLocalCopyRoot(root, candidate);
      const reservedOwner = this.pathOwners.get(candidate);
      const exists = existsSync(candidate);
      return {
        candidate,
        exists,
        owner: reservedOwner ?? (exists ? this.readOwner(candidate) : undefined),
        reserved: reservedOwner !== undefined,
      };
    });

    // Prefer a folder already owned by this workspace, even if an earlier
    // numeric slot became free while Komla was closed.
    const owned = candidateStates.find(({ owner }) => owner === workspaceId);
    if (owned) {
      this.localCopyPaths.set(workspaceId, owned.candidate);
      this.pathOwners.set(owned.candidate, workspaceId);
      return owned.candidate;
    }

    const available = candidateStates.find(({ exists, reserved }) => !exists && !reserved);
    if (available) {
      this.localCopyPaths.set(workspaceId, available.candidate);
      this.pathOwners.set(available.candidate, workspaceId);
      return available.candidate;
    }

    throw new Error(`Could not allocate a local folder for workspace ${workspaceId}`);
  }

  hasLocalCopy(workspaceId: string, backend: SshWorkspaceBackend): boolean {
    return (
      this.initializations.has(workspaceId) ||
      this.syncs.has(workspaceId) ||
      this.readOwner(this.getLocalCopyPath(workspaceId, backend)) === workspaceId
    );
  }

  prepare(
    workspaceId: string,
    backend: SshWorkspaceBackend,
    reason: SyncReason = 'prepare'
  ): Promise<string> {
    traceSync('local copy sync requested', {
      workspaceId,
      reason,
      action: this.syncs.has(workspaceId) ? 'wait-for-active-sync' : 'start',
    });
    if (!this.syncs.has(workspaceId)) {
      this.startSync(workspaceId, backend);
    }
    return this.waitForSyncDrain(workspaceId, backend);
  }

  private startSync(workspaceId: string, backend: SshWorkspaceBackend): void {
    traceSync('local copy sync started', { workspaceId });
    this.setSyncStatus({ workspaceId, state: 'syncing' });
    const sync = this.sync(workspaceId, backend);
    this.syncs.set(workspaceId, sync);
    void sync.then(
      () => this.finishSync(workspaceId, backend, sync),
      (error) => this.finishSync(workspaceId, backend, sync, error)
    );
  }

  private async waitForSyncDrain(
    workspaceId: string,
    backend: SshWorkspaceBackend
  ): Promise<string> {
    let localCopyPath: string | undefined;
    let lastError: unknown;
    while (true) {
      const sync = this.syncs.get(workspaceId);
      if (!sync) {
        if (lastError) throw lastError;
        return localCopyPath ?? this.getLocalCopyPath(workspaceId, backend);
      }
      try {
        localCopyPath = await sync;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
    }
  }

  onSyncStatus(listener: (status: LocalCopySyncStatus) => void): () => void {
    this.syncStatusListeners.add(listener);
    return () => this.syncStatusListeners.delete(listener);
  }

  getSyncStatuses(): LocalCopySyncStatus[] {
    return Array.from(this.syncStatuses.values());
  }

  initialize(workspaceId: string, backend: SshWorkspaceBackend): Promise<string> {
    const current = this.initializations.get(workspaceId);
    if (current) return current;

    const initialization = this.initializeLocalCopy(workspaceId, backend);
    this.initializations.set(workspaceId, initialization);
    void initialization.then(
      () => {
        if (this.initializations.get(workspaceId) === initialization) {
          this.initializations.delete(workspaceId);
        }
      },
      () => {
        if (this.initializations.get(workspaceId) === initialization) {
          this.initializations.delete(workspaceId);
        }
      }
    );
    return initialization;
  }

  /** Whether a sync succeeded this session with no sync running or failed since. */
  isCurrent(workspaceId: string): boolean {
    return this.syncedWorkspaceIds.has(workspaceId) && !this.syncStatuses.has(workspaceId);
  }

  ensureInitialSync(workspaceId: string, backend: SshWorkspaceBackend): void {
    if (this.syncedWorkspaceIds.has(workspaceId) || this.syncs.has(workspaceId)) return;
    this.requestSync(workspaceId, backend, 'initial-sync');
  }

  private async initializeLocalCopy(
    workspaceId: string,
    backend: SshWorkspaceBackend
  ): Promise<string> {
    if (process.platform === 'win32') {
      throw new Error('Local copies are not yet supported on Windows');
    }

    await this.leftoverRemovals.get(workspaceId);
    const localCopyPath = this.getLocalCopyPath(workspaceId, backend);
    await mkdir(localCopyPath, { recursive: true });
    await writeFile(join(localCopyPath, LOCAL_COPY_OWNER_FILE), workspaceId, 'utf8');
    return localCopyPath;
  }

  requestSync(
    workspaceId: string,
    backend: SshWorkspaceBackend,
    reason: SyncReason = 'remote-change'
  ): void {
    if (isSshHostDisconnected(backend.hostId)) {
      // Not current any more: the first refresh after connecting again syncs it.
      this.syncedWorkspaceIds.delete(workspaceId);
      return;
    }
    if (this.syncs.has(workspaceId)) {
      traceSync('local copy sync requested', {
        workspaceId,
        reason,
        action: 'queue-followup',
      });
      this.pendingSyncs.add(workspaceId);
      return;
    }
    void this.prepare(workspaceId, backend, reason).catch((error) => {
      logger.warn('background local copy sync failed', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async remove(workspaceId: string, backend?: SshWorkspaceBackend): Promise<void> {
    this.pendingSyncs.delete(workspaceId);
    this.removing.set(workspaceId, (this.removing.get(workspaceId) ?? 0) + 1);
    try {
      await this.initializations.get(workspaceId)?.catch(() => undefined);
      await this.syncs.get(workspaceId)?.catch(() => undefined);
      await this.leftoverRemovals.get(workspaceId);
      const localCopyPath =
        this.localCopyPaths.get(workspaceId) ??
        (backend ? this.getLocalCopyPath(workspaceId, backend) : undefined);
      if (localCopyPath) {
        await removePath(localCopyPath, LOCAL_COPY_REMOVE_OPTIONS);
        this.pathOwners.delete(localCopyPath);
        this.localCopyPaths.delete(workspaceId);
      }
      this.syncedWorkspaceIds.delete(workspaceId);
      this.syncStatuses.delete(workspaceId);
    } finally {
      const count = (this.removing.get(workspaceId) ?? 1) - 1;
      if (count > 0) this.removing.set(workspaceId, count);
      else this.removing.delete(workspaceId);
    }
  }

  /**
   * Removes the local copies of workspaces `keep` rejects, such as ones left when removing a
   * copy failed or Komla quit partway through a deletion. Folders without an owner marker were
   * not made by Komla and stay, as does a copy being made, synced or removed. Once `stopped`, it
   * removes no more.
   */
  async removeLeftovers(
    keep: (workspaceId: string) => boolean,
    stopped: () => boolean = () => false
  ): Promise<void> {
    const root = this.localCopyRoot();
    for (const project of await readDirectoryNames(root)) {
      const projectPath = join(root, project);
      for (const folder of await readDirectoryNames(projectPath)) {
        if (stopped()) return;
        await this.removeLeftover(join(projectPath, folder), keep, stopped);
      }
      // Fails, as it should, while the project folder still holds a copy or anything else.
      await rmdir(projectPath).catch(() => undefined);
    }
  }

  private async removeLeftover(
    localCopyPath: string,
    keep: (workspaceId: string) => boolean,
    stopped: () => boolean
  ): Promise<void> {
    const owner = await readFile(join(localCopyPath, LOCAL_COPY_OWNER_FILE), 'utf8')
      .then(ownerFromMarker)
      .catch(() => undefined);
    if (stopped() || !owner || !WORKSPACE_ID_PATTERN.test(owner) || keep(owner)) return;
    if (this.initializations.has(owner) || this.syncs.has(owner) || this.removing.has(owner)) {
      return;
    }

    const removal = removePath(localCopyPath, LOCAL_COPY_REMOVE_OPTIONS);
    this.leftoverRemovals.set(
      owner,
      removal.catch(() => undefined)
    );
    try {
      await removal;
      if (this.localCopyPaths.get(owner) === localCopyPath) this.localCopyPaths.delete(owner);
      if (this.pathOwners.get(localCopyPath) === owner) this.pathOwners.delete(localCopyPath);
      this.syncedWorkspaceIds.delete(owner);
      // A workspace restored meanwhile is already syncing its new copy.
      if (!this.syncs.has(owner) && this.syncStatuses.has(owner)) {
        this.setSyncStatus({ workspaceId: owner, state: 'ready' });
      }
      logger.info('removed a leftover local copy', {
        workspaceId: owner,
        localCopyPath,
      });
    } catch (error) {
      logger.warn('could not remove a leftover local copy', {
        workspaceId: owner,
        localCopyPath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.leftoverRemovals.delete(owner);
    }
  }

  private async sync(workspaceId: string, backend: SshWorkspaceBackend): Promise<string> {
    // Provisioning owns remote setup. Repeating it here rewrites watched Git config,
    // which triggers another snapshot and local copy sync indefinitely.
    const localCopyPath = await this.initialize(workspaceId, backend);
    const [protectRules, keptRules] = await Promise.all([
      collectGitignoreProtectRules(
        localCopyPath,
        new Set(['.git', LOCAL_COPY_OWNER_FILE, KOMLA_FILES_DIR])
      ),
      readKeptPathRules(workspaceId, backend),
    ]);
    const transport = sshWorkspaceService.getRsyncTransport(backend.hostId);
    const remotePath = `${transport.remoteTarget}:${backend.remoteDirectory}/`;
    const legacyRemotePath = `${transport.remoteTarget}:${shellQuotePosix(`${backend.remoteDirectory}/`)}`;
    try {
      await withRuleFiles(keptRules, (keptPathArgs) =>
        syncWithSupportedOptions(
          {
            commonArgs: [
              // Directory times are not content. Restoring them bumps folders that local tools
              // write ignored files into, which dev-server watchers treat as changes.
              '--omit-dir-times',
              '--delete-after',
              '--safe-links',
              '--exclude=/.git',
              `--exclude=/${LOCAL_COPY_OWNER_FILE}`,
              `--exclude=/${KOMLA_FILES_DIR}`,
              ...keptPathArgs,
              '--filter=:- .gitignore',
              ...protectRules.map((rule) => `--filter=${rule}`),
              '-e',
              transport.remoteShell,
            ],
            remotePath,
            legacyRemotePath,
            localPath: `${localCopyPath}${sep}`,
            timeout: SYNC_TIMEOUT_MS,
          },
          (percent) => this.setSyncStatus({ workspaceId, state: 'syncing', percent })
        )
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error('Local copies require rsync to be installed on this computer');
      }
      throw new Error(
        `Failed to update local copy: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    logger.debug('local copy synced', { workspaceId, localCopyPath });
    this.syncedWorkspaceIds.add(workspaceId);
    return localCopyPath;
  }

  private finishSync(
    workspaceId: string,
    backend: SshWorkspaceBackend,
    sync: Promise<string>,
    error?: unknown
  ): void {
    if (this.syncs.get(workspaceId) !== sync) return;
    traceSync('local copy sync finished', {
      workspaceId,
      failed: error !== undefined,
      followupQueued: this.pendingSyncs.has(workspaceId),
    });
    this.syncs.delete(workspaceId);
    if (this.pendingSyncs.delete(workspaceId)) {
      this.startSync(workspaceId, backend);
      return;
    }
    if (error) {
      this.setSyncStatus({
        workspaceId,
        state: 'error',
        // oxlint-disable-next-line typescript/no-base-to-string -- last resort for a non-Error rejection
        message: error instanceof Error ? error.message : String(error),
      });
    } else {
      this.setSyncStatus({ workspaceId, state: 'ready' });
    }
  }

  private setSyncStatus(status: LocalCopySyncStatus): void {
    if (isSameSyncStatus(this.syncStatuses.get(status.workspaceId), status)) return;
    if (status.state === 'ready') {
      this.syncStatuses.delete(status.workspaceId);
    } else {
      this.syncStatuses.set(status.workspaceId, status);
    }
    for (const listener of this.syncStatusListeners) listener(status);
  }

  private localCopyRoot(): string {
    return resolve(getKomlaBasePath(), 'local-copies');
  }

  private validateWorkspaceId(workspaceId: string): void {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new Error('Invalid workspace id for local copy');
    }
  }

  private assertInsideLocalCopyRoot(root: string, candidate: string): void {
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
      throw new Error('Invalid local copy path');
    }
  }

  private readOwner(localCopyPath: string): string | undefined {
    try {
      return ownerFromMarker(readFileSync(join(localCopyPath, LOCAL_COPY_OWNER_FILE), 'utf8'));
    } catch {
      return undefined;
    }
  }
}

/**
 * The rules that copy what Git keeps in the remote workspace although .gitignore matches it, which
 * `--filter=:- .gitignore` alone would leave out. Outside a Git work tree there are none.
 */
async function readKeptPathRules(
  workspaceId: string,
  backend: SshWorkspaceBackend
): Promise<{ include: string[]; exclude: string[] }> {
  try {
    const kept = parseKeptPaths(
      await sshWorkspaceService.run(
        sshWorkspaceService.getHost(backend.hostId),
        buildKeptPathsCommand(backend.remoteDirectory)
      )
    );
    return kept ? keptPathRules(kept) : { include: [], exclude: [] };
  } catch (error) {
    // The .gitignore filter alone never copies an ignored file, so the sync can go ahead.
    logger.warn('could not ask Git which ignored files it keeps, so the local copy may lack some', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { include: [], exclude: [] };
  }
}

/**
 * Runs `run` with the rsync options that read `rules` from files, removing the files after.
 * Without rules, there are no files.
 */
async function withRuleFiles<T>(
  rules: { include: string[]; exclude: string[] },
  run: (args: string[]) => Promise<T>
): Promise<T> {
  if (!rules.include.length && !rules.exclude.length) return run([]);
  const directory = await mkdtemp(join(tmpdir(), 'komla-local-copy-'));
  try {
    const args: string[] = [];
    // rsync applies the rules in this order, so the includes come first.
    for (const [kind, patterns] of [
      ['include', rules.include],
      ['exclude', rules.exclude],
    ] as const) {
      if (!patterns.length) continue;
      const file = join(directory, kind);
      await writeFile(file, patterns.map((pattern) => `${pattern}\n`).join(''), 'utf8');
      args.push(`--${kind}-from=${file}`);
    }
    return await run(args);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function isSameSyncStatus(
  previous: LocalCopySyncStatus | undefined,
  next: LocalCopySyncStatus
): boolean {
  if (previous?.state === 'syncing' && next.state === 'syncing') {
    return previous.percent === next.percent;
  }
  if (previous?.state === 'error' && next.state === 'error') {
    return previous.message === next.message;
  }
  return previous?.state === next.state;
}

function ownerFromMarker(content: string): string | undefined {
  return content.trim() || undefined;
}

async function readDirectoryNames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  // Not following links keeps removal inside the local-copies folder.
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export const localCopyService = new LocalCopyService();
