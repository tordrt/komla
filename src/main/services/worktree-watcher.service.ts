import { randomUUID } from 'crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';

import * as watcher from '@parcel/watcher';
import { BrowserWindow } from 'electron';
import ignore, { Ignore } from 'ignore';

import { IPC } from '../../shared/constants/ipc-channels';
import { createLogger } from '../lib/logger';

import { gitService } from './git.service';

import type { FileChange, GitBranchQuickStatus } from './git.service';
import type { LocalWorkspaceStatusSnapshot } from './workspace-status.service';

const logger = createLogger('WorktreeWatcher');

// Change types for targeted cache invalidation.
// Note: git index changes (from `git add`, `git reset --mixed`, etc.) are intentionally
// not tracked. The UI diffs against HEAD, so staging-only changes don't affect displayed
// state. The meaningful side-effects of commands that touch the index (working tree changes,
// ref updates) are already covered by the 'file' and 'git-head'/'git-branch' types.
export type ChangeType = 'file' | 'git-head' | 'git-branch';

const GIT_HEAD_FILES = new Set([
  'HEAD',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_HEAD',
  'COMMIT_EDITMSG',
]);

const REFS_PATH_SEGMENTS = [
  '/refs/heads',
  '\\refs\\heads',
  '/refs/remotes',
  '\\refs\\remotes',
  '/refs/tags',
  '\\refs\\tags',
];

// Git-dir subtrees whose changes never need a refresh: object storage, reflogs (which mirror
// HEAD/ref updates already seen elsewhere), sibling worktrees' private state (their own
// HEAD/COMMIT_EDITMSG would otherwise be classified as a HEAD change for every worktree), and LFS
// objects.
const IGNORED_GIT_SUBDIRS = ['objects', 'logs', 'worktrees', 'lfs'];
// A directory without git has no ignore rules; keep out the dependency folders it likely holds.
const NON_GIT_IGNORED_GLOBS = ['**/node_modules/**', '**/.venv/**'];
// Each ignored path is checked against every watched path, so a tree with thousands of them
// keeps only this many.
const MAX_GIT_IGNORED_DIRECTORIES = 500;

function classifyGitChange(
  gitDir: string,
  eventPath: string
): { type: ChangeType; fileName: string } | null {
  const topLevelEntry = relative(gitDir, eventPath).split(/[/\\]/)[0];
  if (IGNORED_GIT_SUBDIRS.includes(topLevelEntry)) return null;
  const fileName = eventPath.split(/[/\\]/).pop();
  if (!fileName) return null;
  if (GIT_HEAD_FILES.has(fileName)) return { type: 'git-head', fileName };
  if (fileName === 'packed-refs' || REFS_PATH_SEGMENTS.some((seg) => eventPath.includes(seg))) {
    return { type: 'git-branch', fileName };
  }
  return null;
}

interface WatcherEntry {
  subscription: watcher.AsyncSubscription | null;
  gitSubscription: watcher.AsyncSubscription | null;
  sharedGitDir: string | null; // commondir path if using a shared subscription
  path: string;
  ignoreFilter: Ignore;
  pendingChangeTypes: Set<ChangeType>;
  pendingActivity: boolean;
  isGitRepo: boolean;
  lastActivityFingerprint: string | null;
  lastBranchStatus: GitBranchQuickStatus | null;
  /** Timestamp after which activity events should be processed (prevents startup noise) */
  ignoreActivityUntil: number;
  observationEpoch: string;
  observationSequence: number;
  /** Counts resubscribes after .gitignore changes; only the newest keeps its subscription. */
  resubscriptions: number;
}

const LOCAL_OBSERVER_INSTANCE_ID = randomUUID();

interface SharedGitWatcher {
  // Pending while it is created, so worktrees that start at once share it.
  subscription: Promise<watcher.AsyncSubscription>;
  sessionIds: Set<string>;
}

class WorktreeWatcherService {
  private watchers: Map<string, WatcherEntry> = new Map();
  private sharedGitWatchers: Map<string, SharedGitWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceStartTimes: Map<string, number> = new Map();
  /** Pending sessions for shared git event notifications, keyed by git dir. */
  private pendingSharedNotifies: Map<string, Set<string>> = new Map();
  /** Debounce timers for shared git event notifications, keyed by git dir. */
  private sharedDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 500;
  /** Maximum time to accumulate changes before forcing a notification (caps debounce during rapid activity). */
  private readonly MAX_DEBOUNCE_MS = 3000;
  /** Suppress activity events for this many ms after a watcher starts to avoid startup noise. */
  private readonly STARTUP_ACTIVITY_SUPPRESS_MS = 5000;
  /** Max concurrent notifyRenderer calls for shared git events to prevent subprocess bursts. */
  private readonly SHARED_EVENT_CONCURRENCY = 2;
  /** Slower debounce and cap while no window or remote device can show the result. */
  private readonly BACKGROUND_DEBOUNCE_MS = 5000;
  private readonly BACKGROUND_MAX_DEBOUNCE_MS = 30000;

  /**
   * True when nobody can currently see refresh results (all windows hidden or minimized and
   * no remote-control device connected). Set by the app; defaults to always-foreground.
   */
  isBackgroundOnly: () => boolean = () => false;

  /**
   * True when every window shows some other workspace, so only this one's sidebar card shows
   * the result. Its refreshes slow down as in the background. Set by the app.
   */
  isOffScreen: (sessionId: string) => boolean = () => false;

  /** Called when file activity is detected for a workspace (sessionId = workspaceId) */
  onActivity: ((workspaceId: string, activityAt: number) => void) | null = null;
  onObservation: ((snapshot: LocalWorkspaceStatusSnapshot) => Promise<unknown>) | null = null;

  /**
   * Start watching a directory for file changes.
   * For git repos, also watches git internals for head/branch events.
   */
  async startWatching(sessionId: string, dirPath: string): Promise<void> {
    logger.debug('Starting watcher', { sessionId, dirPath });

    // Bail early if the directory no longer exists (e.g. worktree was deleted)
    if (!existsSync(dirPath)) {
      logger.warn('Directory does not exist, skipping watcher', { sessionId, dirPath });
      return;
    }

    // Stop existing watcher if any
    await this.stopWatching(sessionId);

    const gitPath = join(dirPath, '.git');
    const isGitRepo = existsSync(gitPath);

    // Load .gitignore patterns
    const ignoreFilter = this.loadGitignore(dirPath);

    // Store placeholder entry BEFORE subscribing to avoid race condition
    // where events fire before the entry exists in the map
    const entry: WatcherEntry = {
      subscription: null,
      gitSubscription: null,
      sharedGitDir: null,
      path: dirPath,
      ignoreFilter,
      pendingChangeTypes: new Set(),
      pendingActivity: false,
      isGitRepo,
      lastActivityFingerprint: null,
      lastBranchStatus: null,
      // Suppress activity briefly to avoid initial watcher noise (root dir, HEAD, etc)
      ignoreActivityUntil: Date.now() + this.STARTUP_ACTIVITY_SUPPRESS_MS,
      observationEpoch: randomUUID(),
      observationSequence: 0,
      resubscriptions: 0,
    };
    this.watchers.set(sessionId, entry);

    // A stop or restart while this start awaits replaces the entry; then release what it made.
    const superseded = (): boolean => this.watchers.get(sessionId) !== entry;
    try {
      // Watch the directory with gitignore-based OS-level filtering
      entry.subscription = await this.subscribeToFiles(sessionId, dirPath, entry);
      if (superseded()) {
        await this.releaseSubscriptions(sessionId, entry).catch(() => {});
        return;
      }

      if (!isGitRepo) {
        logger.debug('Started non-git file watcher', { sessionId, dirPath });
        return;
      }

      // Resolve the actual git directory (handles worktrees where .git is a file)
      const actualGitDir = this.resolveGitDir(gitPath, dirPath);

      // Watch git internal files for commit/staging detection
      await this.setupGitWatchers(sessionId, actualGitDir, entry);
      if (superseded()) {
        await this.releaseSubscriptions(sessionId, entry).catch(() => {});
        return;
      }
      await this.publishInitialObservation(sessionId, entry);
    } catch (error) {
      // Clean up any subscriptions created before the failure to prevent leaks
      await this.releaseSubscriptions(sessionId, entry).catch(() => {});
      if (this.watchers.get(sessionId) === entry) this.watchers.delete(sessionId);
      throw error;
    }
  }

  /**
   * Unsubscribes everything `entry` holds, and forgets it at once, so a start and a stop that
   * overlap never both release it. Rethrows the first failure once all are attempted.
   */
  private async releaseSubscriptions(sessionId: string, entry: WatcherEntry): Promise<void> {
    const { subscription, gitSubscription, sharedGitDir } = entry;
    entry.subscription = null;
    entry.gitSubscription = null;
    entry.sharedGitDir = null;
    const results = await Promise.allSettled([
      subscription?.unsubscribe(),
      gitSubscription?.unsubscribe(),
      sharedGitDir ? this.removeFromSharedGitWatcher(sharedGitDir, sessionId) : undefined,
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /**
   * Create a file subscription for a workspace directory.
   * Builds @parcel/watcher ignore list from .gitignore for OS-level filtering.
   */
  private async subscribeToFiles(
    sessionId: string,
    dirPath: string,
    entry: WatcherEntry
  ): Promise<watcher.AsyncSubscription> {
    // Resolve symlinks so relative() produces clean paths when the OS returns
    // real paths in file-change events (e.g. /tmp -> /private/tmp on macOS).
    const realDirPath = realpathSync(dirPath);
    const globbed = ignore();
    const ignoreGlobs = [
      ...this.gitignoreToWatcherGlobs(dirPath, globbed),
      ...(entry.isGitRepo
        ? await this.nestedIgnoredDirectories(dirPath, globbed)
        : NON_GIT_IGNORED_GLOBS),
    ];

    return watcher.subscribe(
      realDirPath,
      (err, events) => {
        if (err) {
          // FSEvents "Events were dropped" errors are non-destructive: the
          // @parcel/watcher subscription remains active and will continue
          // delivering future events. No need to tear down and recreate the
          // watcher — just notify the renderer to re-scan for missed changes.
          logger.debug('File watcher error (subscription still active)', {
            sessionId,
            error: err,
          });
          entry.pendingChangeTypes.add('file');
          entry.pendingChangeTypes.add('git-head');
          this.debouncedNotify(sessionId);
          return;
        }

        for (const event of events) {
          // Skip .git directory
          if (event.path.includes('/.git/') || event.path.includes('\\.git\\')) {
            continue;
          }

          const relativePath = relative(realDirPath, event.path);

          // Ignore root directory change events which can fire on startup
          if (!relativePath) {
            continue;
          }

          // If .gitignore changed, resubscribe with updated OS-level ignore patterns
          if (relativePath === '.gitignore') {
            this.resubscribeFileWatcher(sessionId).catch((err) => {
              logger.error('Failed to resubscribe after gitignore change', {
                sessionId,
                error: err,
              });
            });
            // Notify to cover any events missed during resubscription
            entry.pendingChangeTypes.add('file');
            entry.pendingActivity = true;
            this.debouncedNotify(sessionId);
            break;
          }

          // Userspace gitignore filter as safety net (handles negation patterns)
          const currentEntry = this.watchers.get(sessionId);
          const currentFilter = currentEntry?.ignoreFilter ?? entry.ignoreFilter;
          if (currentFilter.ignores(relativePath)) {
            continue;
          }

          entry.pendingChangeTypes.add('file');
          entry.pendingActivity = true;
          this.debouncedNotify(sessionId);
          break;
        }
      },
      { ignore: ignoreGlobs }
    );
  }

  /**
   * Resubscribe the file watcher with updated .gitignore patterns.
   */
  private async resubscribeFileWatcher(sessionId: string): Promise<void> {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;

    // Reload userspace ignore filter
    entry.ignoreFilter = this.loadGitignore(entry.path);

    // Unsubscribe old file watcher
    const previous = entry.subscription;
    entry.subscription = null;
    const resubscription = ++entry.resubscriptions;
    await previous?.unsubscribe().catch((error: unknown) => {
      logger.debug('Failed to unsubscribe file watcher before resubscribing', { sessionId, error });
    });

    // Subscribe with new OS-level ignore patterns
    const subscription = await this.subscribeToFiles(sessionId, entry.path, entry);
    if (this.watchers.get(sessionId) !== entry || entry.resubscriptions !== resubscription) {
      // Stopped meanwhile, or a newer .gitignore change resubscribes in its place.
      await subscription.unsubscribe();
      return;
    }
    entry.subscription = subscription;
    logger.debug('Resubscribed file watcher after gitignore change', { sessionId });
  }

  /**
   * Directories git ignores that the root .gitignore's globs miss: ignored by a nested
   * .gitignore, .git/info/exclude or the global excludes file, such as each package's
   * node_modules in a monorepo. Watching them costs memory per file.
   */
  private async nestedIgnoredDirectories(dirPath: string, globbed: Ignore): Promise<string[]> {
    try {
      const directories = await gitService.listIgnoredDirectories(dirPath);
      return directories
        .filter((directory) => !globbed.ignores(`${directory}/`))
        .slice(0, MAX_GIT_IGNORED_DIRECTORIES);
    } catch (error) {
      logger.debug('Failed to list git-ignored directories', { dirPath, error });
      return [];
    }
  }

  /**
   * Resolve the actual git directory path.
   * For regular repos, .git is a directory.
   * For worktrees, .git is a file containing "gitdir: /path/to/actual/git/dir"
   */
  private resolveGitDir(gitPath: string, workingDir: string): string {
    try {
      const stat = statSync(gitPath);

      if (stat.isDirectory()) {
        // Regular repo - .git is a directory
        return gitPath;
      }

      if (stat.isFile()) {
        // Worktree - .git is a file with "gitdir: <path>"
        const content = readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const gitdir = match[1];
          // Path could be relative or absolute
          if (gitdir.startsWith('/')) {
            return gitdir;
          }
          return resolve(workingDir, gitdir);
        }
      }
    } catch (error) {
      logger.debug('Failed to resolve git dir', { error });
    }

    // Fallback to original path
    return gitPath;
  }

  /**
   * Set up git watchers for a workspace.
   * The per-worktree git dir gets its own subscription.
   * The commondir (shared across worktrees of the same repo) uses a shared subscription.
   */
  private async setupGitWatchers(
    sessionId: string,
    gitDir: string,
    entry: WatcherEntry
  ): Promise<void> {
    // Always create a per-session watcher for the worktree's own git dir
    try {
      entry.gitSubscription = await this.createGitSubscription(gitDir, [sessionId]);
      logger.debug('Created git watcher', { sessionId, dir: gitDir });
    } catch (error) {
      logger.debug('Failed to create git watcher', { sessionId, dir: gitDir, error });
    }

    // For worktrees, share a single subscription on the commondir
    const commondirPath = join(gitDir, 'commondir');
    if (existsSync(commondirPath)) {
      try {
        const commondir = readFileSync(commondirPath, 'utf-8').trim();
        const mainGitDir = resolve(gitDir, commondir);
        if (existsSync(mainGitDir) && mainGitDir !== gitDir) {
          entry.sharedGitDir = mainGitDir;
          await this.addToSharedGitWatcher(mainGitDir, sessionId);
        }
      } catch (error) {
        logger.debug('Failed to set up shared commondir watcher', { error });
      }
    }
  }

  /**
   * Add a session to a shared commondir watcher, creating it if needed.
   */
  private async addToSharedGitWatcher(dir: string, sessionId: string): Promise<void> {
    const existing = this.sharedGitWatchers.get(dir);
    if (existing) {
      existing.sessionIds.add(sessionId);
      logger.debug('Joined shared git watcher', {
        sessionId,
        dir,
        subscribers: existing.sessionIds.size,
      });
      await existing.subscription;
      return;
    }

    const shared: SharedGitWatcher = {
      subscription: this.createGitSubscription(dir, null),
      sessionIds: new Set([sessionId]),
    };
    this.sharedGitWatchers.set(dir, shared);
    try {
      await shared.subscription;
    } catch (error) {
      if (this.sharedGitWatchers.get(dir) === shared) this.sharedGitWatchers.delete(dir);
      throw error;
    }
    logger.debug('Created shared git watcher', { sessionId, dir });
  }

  /**
   * Remove a session from a shared commondir watcher, unsubscribing if last.
   */
  private async removeFromSharedGitWatcher(dir: string, sessionId: string): Promise<void> {
    const shared = this.sharedGitWatchers.get(dir);
    if (!shared) return;

    shared.sessionIds.delete(sessionId);
    if (shared.sessionIds.size === 0) {
      this.sharedGitWatchers.delete(dir);
      const subscription = await shared.subscription.catch(() => null);
      await subscription?.unsubscribe();
      logger.debug('Removed shared git watcher (last subscriber)', { dir });
    }
  }

  /**
   * Create a @parcel/watcher subscription for a git directory.
   * If sessionIds is provided, only those sessions are notified.
   * If null, looks up subscribers from the shared watcher map (for shared commondirs).
   */
  private async createGitSubscription(
    dir: string,
    sessionIds: string[] | null
  ): Promise<watcher.AsyncSubscription> {
    const isShared = sessionIds === null;
    return watcher.subscribe(
      dir,
      (err, events) => {
        const targets = this.resolveGitTargets(dir, sessionIds);
        if (err) {
          this.handleGitWatcherError(dir, err, targets);
          return;
        }
        for (const event of events) {
          const classified = classifyGitChange(dir, event.path);
          if (!classified) continue;
          // A shared commondir's HEAD files are the main checkout's: each worktree keeps its own
          // in its git dir. A fetch or commit there would otherwise refresh every worktree.
          if (isShared && classified.type === 'git-head') continue;
          this.applyGitChange(dir, classified.type, classified.fileName, targets, isShared);
        }
      },
      { ignore: IGNORED_GIT_SUBDIRS }
    );
  }

  private resolveGitTargets(dir: string, sessionIds: string[] | null): string[] {
    if (sessionIds) return sessionIds;
    return Array.from(this.sharedGitWatchers.get(dir)?.sessionIds ?? []);
  }

  /**
   * Handle a non-destructive git watcher error (e.g. FSEvents "events dropped").
   * The subscription remains active; we notify affected sessions to re-scan.
   */
  private handleGitWatcherError(dir: string, err: Error, targets: string[]): void {
    logger.debug('Git watcher error (subscription still active)', { dir, error: err });
    for (const sid of targets) {
      const e = this.watchers.get(sid);
      if (!e) continue;
      e.pendingChangeTypes.add('git-head');
      e.pendingChangeTypes.add('git-branch');
      this.debouncedNotify(sid);
    }
  }

  private applyGitChange(
    dir: string,
    changeType: ChangeType,
    fileName: string,
    targets: string[],
    isShared: boolean
  ): void {
    logger.debug('Git change detected', { dir, changeType, file: fileName });
    for (const sid of targets) {
      const e = this.watchers.get(sid);
      if (!e) continue;
      e.pendingChangeTypes.add(changeType);
      if (changeType === 'git-head') {
        e.pendingActivity = true;
      }
    }

    // Throttle shared-path notifications to prevent N×subprocess bursts.
    // Per-session watchers use the regular debounce path.
    if (isShared && targets.length > 1) {
      this.debouncedSharedNotify(dir, targets);
    } else {
      for (const sid of targets) {
        this.debouncedNotify(sid);
      }
    }
  }

  /**
   * Restart watching for a session and force an immediate full status push.
   * Used for manual "Refresh Git Status" to recover from stale file watchers.
   */
  async restartWatching(sessionId: string, dirPath: string): Promise<void> {
    logger.info('Restarting watcher', { sessionId, dirPath });
    await this.startWatching(sessionId, dirPath);

    // Force an immediate notification with all change types
    const entry = this.watchers.get(sessionId);
    if (entry) {
      entry.pendingChangeTypes.add('file');
      entry.pendingChangeTypes.add('git-head');
      entry.pendingChangeTypes.add('git-branch');
      await this.notifyRenderer(sessionId, false);
    } else {
      logger.warn('Watcher entry missing after startWatching', { sessionId });
    }
  }

  /**
   * Start watchers for multiple workspaces at once.
   * Used on app startup to watch all workspaces outside the Trash.
   */
  async startAllWatchers(
    workspaces: Array<{ id: string; workingDirectory: string }>
  ): Promise<void> {
    const results = await Promise.allSettled(
      workspaces.map((ws) => this.startWatching(ws.id, ws.workingDirectory))
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.error('Failed to start watcher for workspace', {
          sessionId: workspaces[i].id,
          error: result.reason,
        });
      }
    }
  }

  /**
   * Check if a session is already being watched.
   */
  isWatching(sessionId: string): boolean {
    return this.watchers.has(sessionId);
  }

  /**
   * Stop watching a specific session's directory.
   */
  async stopWatching(sessionId: string): Promise<void> {
    const entry = this.watchers.get(sessionId);
    if (entry) {
      // Removed first, so a start still subscribing knows to release what it makes.
      this.watchers.delete(sessionId);
      await this.releaseSubscriptions(sessionId, entry);
    }

    // Clear any pending timers
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    this.debounceStartTimes.delete(sessionId);

    // Clean up shared notification state for this session
    for (const [dir, pending] of this.pendingSharedNotifies) {
      pending.delete(sessionId);
      if (pending.size === 0) {
        this.pendingSharedNotifies.delete(dir);
      }
    }
  }

  /**
   * Stop all watchers. Call this on app shutdown.
   */
  async stopAll(): Promise<void> {
    // Clear shared debounce timers first to prevent firing during teardown
    for (const timer of this.sharedDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.sharedDebounceTimers.clear();
    this.pendingSharedNotifies.clear();

    const stopPromises: Promise<void>[] = [];
    for (const sessionId of this.watchers.keys()) {
      stopPromises.push(this.stopWatching(sessionId));
    }
    await Promise.all(stopPromises);
  }

  /**
   * Load .gitignore patterns from a directory.
   */
  private loadGitignore(dirPath: string): Ignore {
    const ig = ignore();

    try {
      const gitignorePath = join(dirPath, '.gitignore');
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8');
        ig.add(content);
      }
    } catch (error) {
      logger.debug('Failed to load .gitignore', { error });
    }

    return ig;
  }

  /**
   * Convert .gitignore patterns to @parcel/watcher glob patterns for OS-level filtering.
   * Skips negation patterns and any positive patterns that have negation overrides,
   * since @parcel/watcher can't represent negation — those are handled by the userspace filter.
   * Adds each pattern it converts to `globbed`.
   */
  private gitignoreToWatcherGlobs(dirPath: string, globbed: Ignore): string[] {
    const globs: string[] = ['**/.git/**'];

    try {
      const gitignorePath = join(dirPath, '.gitignore');
      if (!existsSync(gitignorePath)) return globs;

      const content = readFileSync(gitignorePath, 'utf-8');
      const lines = content.split('\n');
      const negatedBases = new Set<string>();
      const positivePatterns: string[] = [];

      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('!')) {
          negatedBases.add(line.slice(1).replace(/\/$/, ''));
          continue;
        }

        positivePatterns.push(line);
      }

      for (const pattern of positivePatterns) {
        const isDirOnly = pattern.endsWith('/');
        const clean = pattern.replace(/^\//, '').replace(/\/$/, '');

        // Skip patterns with negation overrides — let userspace filter handle them
        const hasNegation = [...negatedBases].some(
          (neg) => neg.startsWith(clean + '/') || neg === clean
        );
        if (hasNegation) continue;
        globbed.add(pattern);

        // Gitignore: pattern with `/` in beginning or middle is anchored to repo root.
        // Pattern without `/` (except trailing) matches at any depth.
        const isAnchored = pattern.startsWith('/') || clean.includes('/');
        const prefix = isAnchored ? '' : '**/';

        // Always add directory glob to ignore contents
        globs.push(prefix + clean + '/**');
        // For non-directory patterns, also match as a file
        if (!isDirOnly) {
          globs.push(prefix + clean);
        }
      }
    } catch (error) {
      logger.debug('Failed to build watcher ignore globs', { error });
    }

    return globs;
  }

  /**
   * Debounced notification to renderer with adaptive cap.
   * Each new change resets the 500ms debounce, but a hard cap (MAX_DEBOUNCE_MS)
   * ensures notifications fire even during sustained rapid activity (e.g. agents writing files).
   */
  private debouncedNotify(sessionId: string): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Track when the current burst started
    const now = Date.now();
    if (!this.debounceStartTimes.has(sessionId)) {
      this.debounceStartTimes.set(sessionId, now);
    }

    // Calculate delay: normal debounce but capped at MAX_DEBOUNCE_MS from burst start
    const delay = this.debounceDelay(sessionId, now, this.isOffScreen(sessionId));

    // If we've hit the cap, fire immediately
    if (delay === 0) {
      this.debounceTimers.delete(sessionId);
      this.debounceStartTimes.delete(sessionId);
      void this.notifyRenderer(sessionId);
      return;
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      this.debounceStartTimes.delete(sessionId);
      void this.notifyRenderer(sessionId);
    }, delay);

    this.debounceTimers.set(sessionId, timer);
  }

  /**
   * Debounced notification for shared git events (multiple worktrees of same repo).
   * Collects all affected sessions, then fires notifyRenderer in chunks of
   * SHARED_EVENT_CONCURRENCY to prevent N×subprocess bursts when a commit,
   * fetch, or branch operation updates the shared git directory.
   */
  private debouncedSharedNotify(dir: string, targets: string[]): void {
    // Accumulate sessions for this shared dir
    if (!this.pendingSharedNotifies.has(dir)) {
      this.pendingSharedNotifies.set(dir, new Set());
    }
    const pending = this.pendingSharedNotifies.get(dir)!;
    for (const sid of targets) {
      pending.add(sid);
    }

    // Clear existing timer for this dir
    const existingTimer = this.sharedDebounceTimers.get(dir);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Apply the same debounce/cap logic as debouncedNotify
    const now = Date.now();
    const burstKey = `shared:${dir}`;
    if (!this.debounceStartTimes.has(burstKey)) {
      this.debounceStartTimes.set(burstKey, now);
    }
    const delay = this.debounceDelay(burstKey, now);

    if (delay === 0) {
      void this.fireSharedNotify(dir);
      return;
    }

    const timer = setTimeout(() => void this.fireSharedNotify(dir), delay);
    this.sharedDebounceTimers.set(dir, timer);
  }

  private async fireSharedNotify(dir: string): Promise<void> {
    const timer = this.sharedDebounceTimers.get(dir);
    if (timer) clearTimeout(timer);
    this.sharedDebounceTimers.delete(dir);
    this.debounceStartTimes.delete(`shared:${dir}`);
    const sessions = Array.from(this.pendingSharedNotifies.get(dir) ?? []);
    this.pendingSharedNotifies.delete(dir);

    // Process in chunks to cap concurrent git subprocess spawning
    for (let i = 0; i < sessions.length; i += this.SHARED_EVENT_CONCURRENCY) {
      const chunk = sessions.slice(i, i + this.SHARED_EVENT_CONCURRENCY);
      await Promise.all(chunk.map((sid) => this.notifyRenderer(sid)));
    }
  }

  /** Debounce delay for a burst, capped from its start; longer while nobody is watching. */
  private debounceDelay(burstKey: string, now: number, offScreen = false): number {
    const background = offScreen || this.isBackgroundOnly();
    const debounceMs = background ? this.BACKGROUND_DEBOUNCE_MS : this.DEBOUNCE_MS;
    const maxDebounceMs = background ? this.BACKGROUND_MAX_DEBOUNCE_MS : this.MAX_DEBOUNCE_MS;
    const elapsed = now - this.debounceStartTimes.get(burstKey)!;
    return Math.min(debounceMs, Math.max(0, maxDebounceMs - elapsed));
  }

  /**
   * Run every pending (debounced) refresh now that someone can see it, e.g. when a
   * window is focused or shown or a remote device connects. No-op while background-only.
   */
  flushPendingNotifications(): void {
    if (this.isBackgroundOnly()) return;
    for (const sessionId of Array.from(this.debounceTimers.keys())) {
      if (!this.isOffScreen(sessionId)) this.runPendingNotification(sessionId);
    }
    for (const dir of Array.from(this.sharedDebounceTimers.keys())) {
      void this.fireSharedNotify(dir);
    }
  }

  /** Run a workspace's pending refresh now, e.g. when a window starts showing it. */
  flushPendingNotification(sessionId: string): void {
    if (!this.isBackgroundOnly()) this.runPendingNotification(sessionId);
  }

  private runPendingNotification(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.debounceTimers.delete(sessionId);
    this.debounceStartTimes.delete(sessionId);
    void this.notifyRenderer(sessionId);
  }

  /**
   * Send IPC event to renderer with change types and pre-computed file status data.
   * By computing file status here we eliminate the renderer's round-trip IPC call
   * and the duplicate `git status` subprocess that it would trigger.
   */
  private async notifyRenderer(sessionId: string, publishObservation = true): Promise<void> {
    const entry = this.watchers.get(sessionId);
    if (!entry || entry.pendingChangeTypes.size === 0) {
      return;
    }
    const changeTypes = Array.from(entry.pendingChangeTypes);
    const shouldMarkActivity = entry.pendingActivity;
    const observationSequence = publishObservation ? ++entry.observationSequence : undefined;

    // Clear pending types after notification
    entry.pendingChangeTypes.clear();
    entry.pendingActivity = false;

    // Invalidate the cached branch name when HEAD changes (e.g. external git checkout/switch)
    // so the renderer's subsequent fetchStatus() gets the fresh branch.
    if (changeTypes.includes('git-head')) {
      gitService.invalidateBranchCache(entry.path);
    }

    const { pushedFileStatus, pushedGitStatus, activityAt } =
      await this.resolveFileStatusAndActivity(entry, changeTypes, shouldMarkActivity);
    if (this.watchers.get(sessionId) !== entry) return;
    if (observationSequence !== undefined && observationSequence !== entry.observationSequence) {
      return;
    }
    if (
      pushedGitStatus &&
      (changeTypes.includes('git-head') || changeTypes.includes('git-branch'))
    ) {
      entry.lastBranchStatus = pushedGitStatus;
    }
    if (activityAt !== undefined) {
      // Isolate the callback so a throw can't abort the IPC send below. The
      // pre-refactor code happened to swallow throws from this callsite via a
      // surrounding try/catch on the git-status call — preserve that intent.
      try {
        this.onActivity?.(sessionId, activityAt);
      } catch (err) {
        logger.debug('onActivity callback threw', { sessionId, error: err });
      }
    }

    if (publishObservation && pushedFileStatus && pushedGitStatus) {
      await this.publishObservation(
        sessionId,
        entry,
        pushedFileStatus,
        pushedGitStatus,
        observationSequence!
      );
    }

    const windows = BrowserWindow.getAllWindows();
    logger.debug('Notifying renderer of worktree change', {
      sessionId,
      changeTypes,
      windowCount: windows.length,
    });
    for (const window of windows) {
      if (!window.isDestroyed()) {
        if (pushedGitStatus) {
          window.webContents.send(
            IPC.GIT_STATUS_WORKTREE_CHANGED,
            sessionId,
            changeTypes,
            activityAt,
            pushedFileStatus,
            pushedGitStatus
          );
        } else {
          window.webContents.send(
            IPC.GIT_STATUS_WORKTREE_CHANGED,
            sessionId,
            changeTypes,
            activityAt,
            pushedFileStatus
          );
        }
      }
    }
  }

  /**
   * Pre-compute file status for git repos when file-relevant changes occurred and
   * resolve the corresponding activity timestamp. The file-status result replaces
   * the renderer's separate IPC call to getChangedFilesWithSummary and avoids a
   * second `git status --porcelain` subprocess for the activity fingerprint.
   */
  private async resolveFileStatusAndActivity(
    entry: WatcherEntry,
    changeTypes: ChangeType[],
    shouldMarkActivity: boolean
  ): Promise<{
    pushedFileStatus?: {
      files: FileChange[];
      summary: { additions: number; deletions: number; filesChanged: number };
    };
    pushedGitStatus?: GitBranchQuickStatus;
    activityAt?: number;
  }> {
    const needsFileStatus =
      entry.isGitRepo &&
      (changeTypes.includes('file') ||
        changeTypes.includes('git-head') ||
        changeTypes.includes('git-branch'));

    if (needsFileStatus) {
      try {
        const pushedFileStatus = await gitService.getChangedFilesWithSummary(entry.path);
        const branchChanged =
          changeTypes.includes('git-head') || changeTypes.includes('git-branch');
        let pushedGitStatus = entry.lastBranchStatus ?? undefined;
        if (branchChanged) {
          try {
            pushedGitStatus = await gitService.getBranchQuickStatus(entry.path);
          } catch (error) {
            pushedGitStatus = undefined;
            logger.debug('Could not include branch status in watcher projection', {
              path: entry.path,
              error,
            });
          }
        }
        // Evaluate the suppression gate AFTER the await so a long-running git
        // status that straddles `ignoreActivityUntil` still emits activity, as
        // the original code did.
        const activityAt = this.canEmitActivity(entry, shouldMarkActivity)
          ? this.deriveActivityTimestamp(entry, pushedFileStatus.files)
          : undefined;
        return { pushedFileStatus, pushedGitStatus, activityAt };
      } catch {
        // Non-fatal: renderer will fall back to its own IPC call
        const activityAt = this.canEmitActivity(entry, shouldMarkActivity)
          ? this.getActivityTimestampFallback(entry)
          : undefined;
        return { activityAt };
      }
    }

    if (this.canEmitActivity(entry, shouldMarkActivity)) {
      return { activityAt: await this.getActivityTimestamp(entry) };
    }
    return {};
  }

  private canEmitActivity(entry: WatcherEntry, shouldMarkActivity: boolean): boolean {
    return shouldMarkActivity && Date.now() > entry.ignoreActivityUntil;
  }

  /**
   * Derive activity fingerprint from pre-computed file status data.
   * Avoids a separate `git status --porcelain` subprocess.
   */
  private deriveActivityTimestamp(entry: WatcherEntry, files: FileChange[]): number | undefined {
    const fingerprint = this.buildActivityFingerprint(files);

    if (entry.lastActivityFingerprint === null) {
      entry.lastActivityFingerprint = fingerprint;
      return undefined;
    }
    if (fingerprint !== entry.lastActivityFingerprint) {
      entry.lastActivityFingerprint = fingerprint;
      return Date.now();
    }
    return undefined;
  }

  /**
   * Fallback activity timestamp when file status computation fails.
   */
  private getActivityTimestampFallback(entry: WatcherEntry): number | undefined {
    if (!entry.isGitRepo) return Date.now();
    // Can't determine if activity changed, assume it did
    return Date.now();
  }

  private async publishInitialObservation(sessionId: string, entry: WatcherEntry): Promise<void> {
    if (!entry.isGitRepo) return;
    const observationSequence = ++entry.observationSequence;
    let workingTree: {
      files: FileChange[];
      summary: { additions: number; deletions: number; filesChanged: number };
    };
    try {
      workingTree = await gitService.getChangedFilesWithSummary(entry.path);
      if (this.watchers.get(sessionId) !== entry) return;
      entry.lastActivityFingerprint = this.buildActivityFingerprint(workingTree.files);
    } catch (error) {
      logger.debug('Failed to initialize workspace observation', {
        sessionId,
        path: entry.path,
        error,
      });
      entry.lastActivityFingerprint = null;
      return;
    }
    if (!this.onObservation) return;
    try {
      const branch = await gitService.getBranchQuickStatus(entry.path);
      if (this.watchers.get(sessionId) !== entry) return;
      if (observationSequence !== entry.observationSequence) return;
      entry.lastBranchStatus = branch;
      await this.publishObservation(sessionId, entry, workingTree, branch, observationSequence);
    } catch (error) {
      logger.debug('Failed to publish initial workspace observation', {
        sessionId,
        path: entry.path,
        error,
      });
    }
  }

  private async publishObservation(
    sessionId: string,
    entry: WatcherEntry,
    workingTree: {
      files: FileChange[];
      summary: { additions: number; deletions: number; filesChanged: number };
    },
    branch: GitBranchQuickStatus,
    observationSequence: number
  ): Promise<void> {
    const observedAt = Date.now();
    try {
      await this.onObservation?.({
        workspaceId: sessionId,
        source: {
          kind: 'local-watcher',
          instanceId: LOCAL_OBSERVER_INSTANCE_ID,
          epoch: entry.observationEpoch,
          sequence: observationSequence,
        },
        observedAt,
        workingTree,
        branch,
      });
    } catch (error) {
      logger.warn('Could not publish workspace observation', { sessionId, error });
    }
  }

  private async getActivityTimestamp(entry: WatcherEntry): Promise<number | undefined> {
    if (!entry.isGitRepo) {
      return Date.now();
    }

    try {
      const currentFingerprint = await gitService.getActivityFingerprint(entry.path);
      if (entry.lastActivityFingerprint === null) {
        entry.lastActivityFingerprint = currentFingerprint;
        return undefined;
      }
      if (currentFingerprint !== entry.lastActivityFingerprint) {
        entry.lastActivityFingerprint = currentFingerprint;
        return Date.now();
      }
      return undefined;
    } catch (error) {
      logger.debug('Failed to evaluate activity fingerprint', { path: entry.path, error });
      return Date.now();
    }
  }

  private buildActivityFingerprint(files: FileChange[]): string {
    return files
      .map(
        (file) => `${file.status}:${file.staged}:${file.path}:${file.additions}:${file.deletions}`
      )
      .join('\n');
  }

  getDiagnostics(): {
    watcherCount: number;
    sharedGitWatcherCount: number;
    sharedGitSubscriberCount: number;
    debounceTimerCount: number;
    sharedDebounceTimerCount: number;
  } {
    let sharedGitSubscriberCount = 0;
    for (const shared of this.sharedGitWatchers.values()) {
      sharedGitSubscriberCount += shared.sessionIds.size;
    }

    return {
      watcherCount: this.watchers.size,
      sharedGitWatcherCount: this.sharedGitWatchers.size,
      sharedGitSubscriberCount,
      debounceTimerCount: this.debounceTimers.size,
      sharedDebounceTimerCount: this.sharedDebounceTimers.size,
    };
  }
}

export const worktreeWatcherService = new WorktreeWatcherService();
