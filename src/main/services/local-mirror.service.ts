import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { basename, join, resolve, sep } from 'path';
import { promisify } from 'util';

import { sanitizeWorktreeProjectSegment } from '../../shared/lib/random-names';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { createLogger } from '../lib/logger';
import { removePath } from '../lib/remove-path';

import { KOMLA_FILES_DIR } from './git/git-status';
import { collectGitignoreProtectRules } from './local-mirror-protect';
import { getKomlaBasePath } from './paths';
import { sshWorkspaceService } from './ssh-workspace.service';

import type { SshWorkspaceBackend } from '../../shared/types';
import type { LocalMirrorSyncStatus } from '../../shared/types/local-mirror';

const execFileAsync = promisify(execFile);
const logger = createLogger('LocalMirrorService');
const SYNC_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MIRROR_OWNER_FILE = '.komla-local-mirror';
const MIRROR_PATH_MAX_ATTEMPTS = 25;
const MIRROR_REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };

type SyncReason = 'prepare' | 'remote-change' | 'initial-sync' | 'retry';

function traceSync(message: string, details: Record<string, unknown>): void {
  if (process.env.KOMLA_DIAGNOSTICS === '1') logger.debug(message, details);
}

class LocalMirrorService {
  private syncs = new Map<string, Promise<string>>();
  private initializations = new Map<string, Promise<string>>();
  private pendingSyncs = new Set<string>();
  private syncedWorkspaceIds = new Set<string>();
  private syncStatuses = new Map<string, LocalMirrorSyncStatus>();
  private syncStatusListeners = new Set<(status: LocalMirrorSyncStatus) => void>();
  private mirrorPaths = new Map<string, string>();
  private pathOwners = new Map<string, string>();

  getMirrorPath(workspaceId: string, backend: SshWorkspaceBackend): string {
    this.validateWorkspaceId(workspaceId);
    const current = this.mirrorPaths.get(workspaceId);
    if (current) return current;

    const root = resolve(getKomlaBasePath(), 'mirrors');
    const projectName =
      backend.projectName || basename(backend.remoteRepoPath).replace(/\.git$/i, '') || 'project';
    const branchName = backend.branchName || basename(backend.remoteDirectory) || 'branch';
    const safeProject = sanitizeWorktreeProjectSegment(projectName);
    const safeBranch = sanitizeWorktreeProjectSegment(branchName);
    const preferred = resolve(root, safeProject, safeBranch);
    const candidates = Array.from({ length: MIRROR_PATH_MAX_ATTEMPTS }, (_, index) =>
      index === 0 ? preferred : resolve(root, safeProject, `${safeBranch}-${index + 1}`)
    );
    const candidateStates = candidates.map((candidate) => {
      this.assertInsideMirrorRoot(root, candidate);
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
      this.mirrorPaths.set(workspaceId, owned.candidate);
      this.pathOwners.set(owned.candidate, workspaceId);
      return owned.candidate;
    }

    const available = candidateStates.find(({ exists, reserved }) => !exists && !reserved);
    if (available) {
      this.mirrorPaths.set(workspaceId, available.candidate);
      this.pathOwners.set(available.candidate, workspaceId);
      return available.candidate;
    }

    throw new Error(`Could not allocate a local folder for workspace ${workspaceId}`);
  }

  hasMirror(workspaceId: string, backend: SshWorkspaceBackend): boolean {
    return (
      this.initializations.has(workspaceId) ||
      this.syncs.has(workspaceId) ||
      this.readOwner(this.getMirrorPath(workspaceId, backend)) === workspaceId
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
    let mirrorPath: string | undefined;
    let lastError: unknown;
    while (true) {
      const sync = this.syncs.get(workspaceId);
      if (!sync) {
        if (lastError) throw lastError;
        return mirrorPath ?? this.getMirrorPath(workspaceId, backend);
      }
      try {
        mirrorPath = await sync;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
    }
  }

  onSyncStatus(listener: (status: LocalMirrorSyncStatus) => void): () => void {
    this.syncStatusListeners.add(listener);
    return () => this.syncStatusListeners.delete(listener);
  }

  getSyncStatuses(): LocalMirrorSyncStatus[] {
    return Array.from(this.syncStatuses.values());
  }

  initialize(workspaceId: string, backend: SshWorkspaceBackend): Promise<string> {
    const current = this.initializations.get(workspaceId);
    if (current) return current;

    const initialization = this.initializeMirror(workspaceId, backend);
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

  private async initializeMirror(
    workspaceId: string,
    backend: SshWorkspaceBackend
  ): Promise<string> {
    if (process.platform === 'win32') {
      throw new Error('Local copies are not yet supported on Windows');
    }

    const mirrorPath = this.getMirrorPath(workspaceId, backend);
    await mkdir(mirrorPath, { recursive: true });
    await writeFile(join(mirrorPath, MIRROR_OWNER_FILE), workspaceId, 'utf8');
    return mirrorPath;
  }

  requestSync(
    workspaceId: string,
    backend: SshWorkspaceBackend,
    reason: SyncReason = 'remote-change'
  ): void {
    if (this.syncs.has(workspaceId)) {
      traceSync('local copy sync requested', { workspaceId, reason, action: 'queue-followup' });
      this.pendingSyncs.add(workspaceId);
      return;
    }
    void this.prepare(workspaceId, backend, reason).catch((error) => {
      logger.warn('background mirror sync failed', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async remove(workspaceId: string, backend?: SshWorkspaceBackend): Promise<void> {
    this.pendingSyncs.delete(workspaceId);
    await this.initializations.get(workspaceId)?.catch(() => undefined);
    await this.syncs.get(workspaceId)?.catch(() => undefined);
    const mirrorPath =
      this.mirrorPaths.get(workspaceId) ??
      (backend ? this.getMirrorPath(workspaceId, backend) : undefined);
    if (mirrorPath) {
      await removePath(mirrorPath, MIRROR_REMOVE_OPTIONS);
      this.pathOwners.delete(mirrorPath);
      this.mirrorPaths.delete(workspaceId);
    }
    this.syncedWorkspaceIds.delete(workspaceId);
    this.syncStatuses.delete(workspaceId);
  }

  private async sync(workspaceId: string, backend: SshWorkspaceBackend): Promise<string> {
    // Provisioning owns remote setup. Repeating it here rewrites watched Git config,
    // which triggers another snapshot and local copy sync indefinitely.
    const mirrorPath = await this.initialize(workspaceId, backend);
    const protectRules = await collectGitignoreProtectRules(
      mirrorPath,
      new Set(['.git', MIRROR_OWNER_FILE, KOMLA_FILES_DIR])
    );

    const transport = sshWorkspaceService.getRsyncTransport(backend.hostId);
    const remotePath = `${transport.remoteTarget}:${backend.remoteDirectory}/`;
    const legacyRemotePath = `${transport.remoteTarget}:${shellQuotePosix(`${backend.remoteDirectory}/`)}`;
    const commonArgs = [
      // Directory times are not content. Restoring them bumps folders that local tools write
      // ignored files into, which dev-server watchers treat as changes.
      '--omit-dir-times',
      '--delete-after',
      '--safe-links',
      '--exclude=/.git',
      `--exclude=/${MIRROR_OWNER_FILE}`,
      `--exclude=/${KOMLA_FILES_DIR}`,
      '--filter=:- .gitignore',
      ...protectRules.map((rule) => `--filter=${rule}`),
      '-e',
      transport.remoteShell,
    ];
    const options = { timeout: SYNC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES };
    try {
      try {
        await execFileAsync(
          'rsync',
          ['-a', '-s', ...commonArgs, remotePath, `${mirrorPath}${sep}`],
          options
        );
      } catch (error) {
        if (
          !/(?:invalid option -- s|-s: unknown option)/i.test(
            error instanceof Error ? error.message : String(error)
          )
        ) {
          throw error;
        }
        await execFileAsync(
          'rsync',
          ['-a', ...commonArgs, legacyRemotePath, `${mirrorPath}${sep}`],
          {
            ...options,
            env: { ...process.env, RSYNC_OLD_ARGS: '1', RSYNC_PROTECT_ARGS: '0' },
          }
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error('Local copies require rsync to be installed on this computer');
      }
      throw new Error(
        `Failed to update local copy: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    logger.debug('local mirror synced', { workspaceId, mirrorPath });
    this.syncedWorkspaceIds.add(workspaceId);
    return mirrorPath;
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
        message: error instanceof Error ? error.message : String(error),
      });
    } else {
      this.setSyncStatus({ workspaceId, state: 'ready' });
    }
  }

  private setSyncStatus(status: LocalMirrorSyncStatus): void {
    const previous = this.syncStatuses.get(status.workspaceId);
    if (
      previous?.state === status.state &&
      (previous.state !== 'error' ||
        (status.state === 'error' && previous.message === status.message))
    ) {
      return;
    }
    if (status.state === 'ready') {
      this.syncStatuses.delete(status.workspaceId);
    } else {
      this.syncStatuses.set(status.workspaceId, status);
    }
    for (const listener of this.syncStatusListeners) listener(status);
  }

  private validateWorkspaceId(workspaceId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
      throw new Error('Invalid workspace id for local copy');
    }
  }

  private assertInsideMirrorRoot(root: string, candidate: string): void {
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
      throw new Error('Invalid local copy path');
    }
  }

  private readOwner(mirrorPath: string): string | undefined {
    try {
      return readFileSync(join(mirrorPath, MIRROR_OWNER_FILE), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

export const localMirrorService = new LocalMirrorService();
