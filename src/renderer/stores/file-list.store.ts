import { create } from 'zustand';

import { isSameOrInside, MANAGED_FILE_ROOTS } from '@/lib/workspace-file-paths';

import type { FileChange, WorktreeDiff, FileDiffContent, RemoteWorkingTreeChange } from '@/types';

interface CachedFileList {
  files: string[];
  gitIgnoredFiles: string[];
  emptyDirs: string[];
  managedLinkPaths?: string[];
  isLoading: boolean;
  /** When true, files may have changed since this list was fetched. A shown tree re-lists it,
   *  and anything else re-fetches it the next time it needs it. */
  isStale?: boolean;
  /** An SSH list's fingerprint. A Remote Companion report with the same one lists the same files. */
  fileListHash?: string;
  /** The fingerprint the report that marked this list stale saw, if it sent one. */
  staleFileListHash?: string;
}

interface CachedFileStatuses {
  statuses: Map<string, FileChange['status']>;
  isLoading: boolean;
}

// Cached diff data (keyed by dirPath or dirPath:branch for branch comparisons)
interface CachedDiff {
  data: WorktreeDiff;
  isLoading: boolean;
  hasFullDiff: boolean; // false when populated by lightweight endpoint (no diff text)
}

// Cached file diff content (keyed by dirPath:filePath or dirPath:filePath:branch)
interface CachedFileDiffContent {
  content: FileDiffContent;
  isLoading: boolean;
  /** When true, the cached content is stale and should be re-fetched, but the
   *  old content is preserved so the UI doesn't flash while the fetch is in progress. */
  isStale?: boolean;
}

interface FileListState {
  cache: Map<string, CachedFileList>;
  statusCache: Map<string, CachedFileStatuses>;
  diffCache: Map<string, CachedDiff>;
  fileDiffCache: Map<string, CachedFileDiffContent>;
  /** Directories created by the user via the UI (not tracked by git). Keyed by dirPath. */
  userCreatedDirs: Map<string, Set<string>>;

  // File list actions
  getFileList: (dirPath: string) => CachedFileList | undefined;
  fetchFileList: (
    dirPath: string,
    includeGitIgnored?: boolean,
    workspaceId?: string
  ) => Promise<{ files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] }>;
  fetchFileListIfNeeded: (dirPath: string, workspaceId?: string) => Promise<void>;
  /** Marks a list stale after a change, unless `fileListHash` shows it lists the same files. */
  markFileListStale: (dirPath: string, fileListHash?: string) => void;
  /** Whether a Remote Companion report may have changed `filePath`, so it must be read again. */
  mayHaveChangedRemoteFile: (
    dirPath: string,
    filePath: string,
    change: RemoteWorkingTreeChange | undefined
  ) => boolean;
  evictPath: (dirPath: string, relativePath: string) => void;

  // File statuses actions (for sidebar tree)
  getFileStatuses: (dirPath: string) => CachedFileStatuses | undefined;
  fetchFileStatuses: (dirPath: string) => Promise<Map<string, FileChange['status']>>;
  fetchFileStatusesIfNeeded: (dirPath: string) => Promise<void>;

  // Diff cache actions
  getDiff: (
    dirPath: string,
    comparisonBranch?: string | null,
    useMergeBase?: boolean,
    workspaceId?: string
  ) => CachedDiff | undefined;
  fetchDiff: (
    dirPath: string,
    comparisonBranch?: string | null,
    useMergeBase?: boolean,
    workspaceId?: string
  ) => Promise<WorktreeDiff>;
  fetchDiffIfNeeded: (
    dirPath: string,
    comparisonBranch?: string | null,
    useMergeBase?: boolean,
    workspaceId?: string
  ) => Promise<WorktreeDiff | undefined>;

  // File diff content cache actions
  getFileDiffContent: (
    dirPath: string,
    filePath: string,
    stagedOrBranch: boolean | string,
    useMergeBase?: boolean,
    workspaceId?: string
  ) => CachedFileDiffContent | undefined;
  fetchFileDiffContent: (
    dirPath: string,
    filePath: string,
    staged: boolean,
    workspaceId?: string
  ) => Promise<FileDiffContent>;
  fetchFileDiffContentAgainstBranch: (
    dirPath: string,
    filePath: string,
    branch: string,
    useMergeBase?: boolean,
    workspaceId?: string
  ) => Promise<FileDiffContent>;
  fetchFileDiffContentIfNeeded: (
    dirPath: string,
    filePath: string,
    stagedOrBranch: boolean | string,
    useMergeBase?: boolean,
    workspaceId?: string
  ) => Promise<FileDiffContent | undefined>;

  invalidate: (dirPath: string, workspaceId?: string) => void;
  invalidateAll: () => void;

  // Targeted invalidation methods for optimized cache clearing
  invalidateStatuses: (dirPath: string) => void;
  invalidateDiffs: (dirPath: string) => void;
  /** Marks per-file diffs stale: those of `changedPaths` when given, otherwise all. */
  invalidateFileDiffs: (
    dirPath: string,
    workspaceId?: string,
    changedPaths?: readonly string[]
  ) => void;
  /** Invalidate only branch comparison diffs (e.g. "diff against main"), not the base HEAD-vs-working-tree diff. */
  invalidateBranchComparisonDiffs: (dirPath: string, workspaceId?: string) => void;

  // Apply pre-computed file status pushed from the main process (avoids IPC round-trip)
  applyPushedFileStatus: (
    dirPath: string,
    data: {
      files: FileChange[];
      summary: { additions: number; deletions: number; filesChanged: number };
    },
    workspaceId?: string
  ) => void;

  // User-created empty directory tracking
  addUserCreatedDir: (dirPath: string, relativeDirPath: string) => void;
}

// Helper to get ancestor paths for a file path
function getAncestorPaths(filePath: string): string[] {
  const parts = filePath.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

// Cache key helpers
function getDiffCacheKey(
  dirPath: string,
  comparisonBranch?: string | null,
  useMergeBase?: boolean,
  workspaceId?: string
): string {
  const baseKey = workspaceId ? `workspace:${workspaceId}` : dirPath;
  if (!comparisonBranch) return baseKey;
  return useMergeBase ? `${baseKey}:${comparisonBranch}:mb` : `${baseKey}:${comparisonBranch}`;
}

function getFileDiffCacheKey(
  dirPath: string,
  filePath: string,
  stagedOrBranch: boolean | string,
  useMergeBase?: boolean,
  workspaceId?: string
): string {
  const baseKey = workspaceId ? `workspace:${workspaceId}` : dirPath;
  if (typeof stagedOrBranch === 'string') {
    const suffix = useMergeBase ? ':mb' : '';
    return `${baseKey}:${filePath}:branch:${stagedOrBranch}${suffix}`;
  }
  return `${baseKey}:${filePath}`;
}

const diffRequests = new Map<string, Promise<WorktreeDiff>>();
const fileDiffContentRequests = new Map<string, Promise<FileDiffContent>>();
// File diffs invalidated while their fetch was in flight, whose results therefore arrive stale.
const fileDiffsInvalidatedInFlight = new Set<string>();
// Lookup sets for cached file lists, built the first time each is needed.
const listedFileSets = new WeakMap<readonly string[], ReadonlySet<string>>();

function listedFileSet(files: readonly string[]): ReadonlySet<string> {
  let listed = listedFileSets.get(files);
  if (!listed) {
    listed = new Set(files);
    listedFileSets.set(files, listed);
  }
  return listed;
}
const fileListRequestGenerations = new Map<
  string,
  { basic: number; includingGitIgnored: number }
>();

type FileListResult = { files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] };
const sameTickFileListRequests = new Map<
  string,
  { generation: number; promise: Promise<FileListResult> }
>();

function advanceFileListRequestGeneration(dirPath: string, includeGitIgnored: boolean): number {
  const generations = fileListRequestGenerations.get(dirPath) ?? {
    basic: 0,
    includingGitIgnored: 0,
  };
  const key = includeGitIgnored ? 'includingGitIgnored' : 'basic';
  const generation = generations[key] + 1;
  fileListRequestGenerations.set(dirPath, { ...generations, [key]: generation });
  return generation;
}

function isCurrentFileListRequest(
  dirPath: string,
  includeGitIgnored: boolean,
  generation: number
): boolean {
  const generations = fileListRequestGenerations.get(dirPath);
  return (includeGitIgnored ? generations?.includingGitIgnored : generations?.basic) === generation;
}

/**
 * Returns the cached list when a fetch brought back the same paths. Most
 * watcher refreshes list an unchanged tree (a file was edited, not added or
 * removed), and a new array would make every mounted tree diff its paths.
 */
function keepIfSame<T extends readonly string[] | undefined>(cached: T | undefined, fetched: T): T {
  if (!cached || !fetched || cached.length !== fetched.length) return fetched;
  for (let i = 0; i < fetched.length; i++) {
    if (cached[i] !== fetched[i]) return fetched;
  }
  return cached;
}

export const useFileListStore = create<FileListState>((set, get) => ({
  cache: new Map(),
  statusCache: new Map(),
  diffCache: new Map(),
  fileDiffCache: new Map(),
  userCreatedDirs: new Map(),

  getFileList: (dirPath) => {
    return get().cache.get(dirPath);
  },

  fetchFileList: (dirPath, includeGitIgnored, workspaceId) => {
    const requestsGitIgnoredFiles = includeGitIgnored === true;
    // Several listeners refresh the same list for one watcher event; let callers in the same
    // tick share the request unless something (e.g. an eviction) has superseded it.
    const sameTickKey = `${dirPath}\0${requestsGitIgnoredFiles}\0${workspaceId ?? ''}`;
    const sameTick = sameTickFileListRequests.get(sameTickKey);
    if (
      sameTick &&
      isCurrentFileListRequest(dirPath, requestsGitIgnoredFiles, sameTick.generation)
    ) {
      return sameTick.promise;
    }
    const requestGeneration = advanceFileListRequestGeneration(dirPath, requestsGitIgnoredFiles);
    const promise = loadFileList(requestGeneration);
    sameTickFileListRequests.set(sameTickKey, { generation: requestGeneration, promise });
    queueMicrotask(() => {
      if (sameTickFileListRequests.get(sameTickKey)?.promise === promise) {
        sameTickFileListRequests.delete(sameTickKey);
      }
    });
    return promise;

    async function loadFileList(requestGeneration: number): Promise<FileListResult> {
      // Mark as loading, preserve existing data if available
      set((state) => {
        const newCache = new Map(state.cache);
        const existing = newCache.get(dirPath);
        newCache.set(dirPath, {
          files: existing?.files ?? [],
          gitIgnoredFiles: existing?.gitIgnoredFiles ?? [],
          emptyDirs: existing?.emptyDirs ?? [],
          managedLinkPaths: existing?.managedLinkPaths,
          fileListHash: existing?.fileListHash,
          isLoading: true,
        });
        return { cache: newCache };
      });

      try {
        const result: Awaited<ReturnType<typeof window.api.listWorkspaceFiles>> = workspaceId
          ? await window.api.listWorkspaceFiles(workspaceId, includeGitIgnored ?? false)
          : await window.api.listFiles(dirPath, includeGitIgnored ?? false);
        if (!isCurrentFileListRequest(dirPath, requestsGitIgnoredFiles, requestGeneration)) {
          return result;
        }
        set((state) => {
          const newCache = new Map(state.cache);

          // Prune user-created dirs that now contain files (no longer empty)
          const allFiles = [...result.files, ...result.gitIgnoredFiles];
          const userDirs = state.userCreatedDirs.get(dirPath);
          let newUserCreatedDirs = state.userCreatedDirs;
          if (userDirs && userDirs.size > 0) {
            const remaining = new Set<string>();
            for (const dir of userDirs) {
              const hasFile = allFiles.some((f) => f.startsWith(dir + '/'));
              if (!hasFile) remaining.add(dir);
            }
            if (remaining.size !== userDirs.size) {
              newUserCreatedDirs = new Map(state.userCreatedDirs);
              if (remaining.size === 0) {
                newUserCreatedDirs.delete(dirPath);
              } else {
                newUserCreatedDirs.set(dirPath, remaining);
              }
            }
          }

          // Merge surviving user-created dirs into emptyDirs
          const emptyDirs = [
            ...new Set([
              ...(result.emptyDirs ?? []),
              ...(newUserCreatedDirs.get(dirPath)
                ? Array.from(newUserCreatedDirs.get(dirPath)!)
                : []),
            ]),
          ];

          const existing = newCache.get(dirPath);
          const fileListHash = 'fileListHash' in result ? result.fileListHash : undefined;
          // Marked stale while this request ran, so it may predate the change, unless it
          // lists the files the report that marked it saw.
          const staysStale =
            existing?.isStale &&
            (!existing.staleFileListHash || existing.staleFileListHash !== fileListHash);
          newCache.set(dirPath, {
            files: keepIfSame(existing?.files, result.files),
            // When gitignored files weren't requested (e.g. hot-path watcher refresh),
            // preserve any previously fetched list so the UI toggle keeps working.
            gitIgnoredFiles:
              includeGitIgnored || result.gitIgnoredFiles.length > 0
                ? keepIfSame(existing?.gitIgnoredFiles, result.gitIgnoredFiles)
                : (existing?.gitIgnoredFiles ?? []),
            emptyDirs: keepIfSame(existing?.emptyDirs, emptyDirs),
            managedLinkPaths: keepIfSame(existing?.managedLinkPaths, result.managedLinkPaths),
            fileListHash,
            isLoading: false,
            ...(staysStale ? { isStale: true, staleFileListHash: existing.staleFileListHash } : {}),
          });
          return { cache: newCache, userCreatedDirs: newUserCreatedDirs };
        });
        return result;
      } catch (error) {
        console.error('Failed to fetch file list:', error);
        if (isCurrentFileListRequest(dirPath, requestsGitIgnoredFiles, requestGeneration)) {
          set((state) => {
            const newCache = new Map(state.cache);
            const existing = newCache.get(dirPath);
            if (existing) {
              newCache.set(dirPath, { ...existing, isLoading: false });
            }
            return { cache: newCache };
          });
        }
        throw error;
      }
    }
  },

  evictPath: (dirPath, relativePath) => {
    advanceFileListRequestGeneration(dirPath, false);
    advanceFileListRequestGeneration(dirPath, true);
    const isDeletedPath = (candidate: string): boolean =>
      candidate === relativePath || candidate.startsWith(`${relativePath}/`);
    set((state) => {
      const existing = state.cache.get(dirPath);
      const existingUserDirs = state.userCreatedDirs.get(dirPath);
      if (!existing && !existingUserDirs) return state;

      const cache = new Map(state.cache);
      if (existing) {
        cache.set(dirPath, {
          ...existing,
          files: existing.files.filter((path) => !isDeletedPath(path)),
          gitIgnoredFiles: existing.gitIgnoredFiles.filter((path) => !isDeletedPath(path)),
          emptyDirs: existing.emptyDirs.filter((path) => !isDeletedPath(path)),
          isLoading: false,
        });
      }

      const userCreatedDirs = new Map(state.userCreatedDirs);
      if (existingUserDirs) {
        const remaining = new Set([...existingUserDirs].filter((path) => !isDeletedPath(path)));
        if (remaining.size > 0) userCreatedDirs.set(dirPath, remaining);
        else userCreatedDirs.delete(dirPath);
      }
      return { cache, userCreatedDirs };
    });
  },

  fetchFileListIfNeeded: async (dirPath, workspaceId) => {
    const state = get();
    const cached = state.cache.get(dirPath);

    // Skip if already loading or has current data (the file watcher marks it stale or refreshes it)
    if (cached?.isLoading || (cached && cached.files.length > 0 && !cached.isStale)) {
      return;
    }

    await state.fetchFileList(dirPath, false, workspaceId);
  },

  markFileListStale: (dirPath, reportedFileListHash) => {
    set((state) => {
      const existing = state.cache.get(dirPath);
      if (!existing) return state;
      // A fingerprint covers the workspace's own files, not those of its linked workspaces.
      const fileListHash = existing.managedLinkPaths?.length ? undefined : reportedFileListHash;
      // A list still loading may predate the report, whatever its fingerprint.
      const listsSameFiles =
        !!fileListHash && !existing.isLoading && existing.fileListHash === fileListHash;
      const unchanged = listsSameFiles
        ? !existing.isStale
        : existing.isStale && existing.staleFileListHash === fileListHash;
      if (unchanged) return state;
      const cache = new Map(state.cache);
      cache.set(dirPath, {
        ...existing,
        isStale: listsSameFiles ? undefined : true,
        staleFileListHash: listsSameFiles ? undefined : fileListHash,
      });
      return { cache };
    });
  },

  mayHaveChangedRemoteFile: (dirPath, filePath, change) => {
    const changedPaths = change?.changedPaths;
    if (!changedPaths || isSameOrInside(filePath, changedPaths)) return true;
    // The changed paths cover the files the Remote Companion watches: those the list holds
    // outside Komla's own folders.
    const files = get().cache.get(dirPath)?.files;
    return (
      isSameOrInside(filePath, MANAGED_FILE_ROOTS) || !files || !listedFileSet(files).has(filePath)
    );
  },

  getFileStatuses: (dirPath) => {
    return get().statusCache.get(dirPath);
  },

  fetchFileStatuses: async (dirPath) => {
    // Skip if already in-flight (watcher can call this directly, bypassing fetchFileStatusesIfNeeded)
    const existingEntry = get().statusCache.get(dirPath);
    if (existingEntry?.isLoading) return existingEntry.statuses;

    // Mark as loading, preserve existing data if available
    set((state) => {
      const newCache = new Map(state.statusCache);
      const existing = newCache.get(dirPath);
      newCache.set(dirPath, {
        statuses: existing?.statuses ?? new Map(),
        isLoading: true,
      });
      return { statusCache: newCache };
    });

    try {
      // Use lightweight endpoint: only file list + summary counts, no full diff text
      const result = await window.api.getChangedFilesWithSummary(dirPath);
      const statuses = new Map<string, FileChange['status']>();
      for (const f of result.files) {
        statuses.set(f.path, f.status);
        // Also mark ancestor directories as modified
        for (const ancestor of getAncestorPaths(f.path)) {
          if (!statuses.has(ancestor)) {
            statuses.set(ancestor, 'modified');
          }
        }
      }

      set((state) => {
        const newStatusCache = new Map(state.statusCache);
        newStatusCache.set(dirPath, {
          statuses,
          isLoading: false,
        });

        // Update diff cache with lightweight data (files + summary, empty diff string).
        // The diff viewer will re-fetch full diff text when needed.
        const newDiffCache = new Map(state.diffCache);
        const existingDiff = newDiffCache.get(dirPath);
        // Only overwrite if there's no full diff already cached
        if (!existingDiff || !existingDiff.hasFullDiff) {
          newDiffCache.set(dirPath, {
            data: { files: result.files, summary: result.summary },
            isLoading: false,
            hasFullDiff: false,
          });
        }

        return { statusCache: newStatusCache, diffCache: newDiffCache };
      });
      return statuses;
    } catch (error) {
      console.error('Failed to fetch file statuses:', error);
      set((state) => {
        const newCache = new Map(state.statusCache);
        const existing = newCache.get(dirPath);
        if (existing) {
          newCache.set(dirPath, { ...existing, isLoading: false });
        }
        return { statusCache: newCache };
      });
      return new Map();
    }
  },

  fetchFileStatusesIfNeeded: async (dirPath) => {
    const state = get();
    const cached = state.statusCache.get(dirPath);

    // Skip if already loading or has been fetched (will be invalidated by file watcher when needed)
    // Note: empty statuses map is valid (no changes), so we check if cached exists
    if (cached?.isLoading || cached) {
      return;
    }

    await state.fetchFileStatuses(dirPath);
  },

  // Diff cache methods
  getDiff: (dirPath, comparisonBranch, useMergeBase, workspaceId) => {
    const cacheKey = getDiffCacheKey(dirPath, comparisonBranch, useMergeBase, workspaceId);
    return get().diffCache.get(cacheKey);
  },

  fetchDiff: async (dirPath, comparisonBranch, useMergeBase, workspaceId) => {
    const cacheKey = getDiffCacheKey(dirPath, comparisonBranch, useMergeBase, workspaceId);

    // Mark as loading, preserve existing data
    set((state) => {
      const newCache = new Map(state.diffCache);
      const existing = newCache.get(cacheKey);
      if (existing) {
        newCache.set(cacheKey, { ...existing, isLoading: true });
      } else {
        newCache.set(cacheKey, {
          data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
          isLoading: true,
          hasFullDiff: false,
        });
      }
      return { diffCache: newCache };
    });

    let request: Promise<WorktreeDiff> | undefined;
    try {
      request = workspaceId
        ? comparisonBranch
          ? window.api.getWorkspaceDiffAgainstBranch(workspaceId, comparisonBranch, !!useMergeBase)
          : window.api.getWorkspaceDiff(workspaceId)
        : comparisonBranch
          ? window.api.getDiffAgainstBranch(dirPath, comparisonBranch, !!useMergeBase)
          : window.api.getDiff(dirPath);
      diffRequests.set(cacheKey, request);
      const data = await request;

      set((state) => {
        const newCache = new Map(state.diffCache);
        const refreshedEntry = { data, isLoading: false, hasFullDiff: true };
        newCache.set(cacheKey, refreshedEntry);
        if (workspaceId && !comparisonBranch) {
          newCache.set(dirPath, refreshedEntry);
        }
        return { diffCache: newCache };
      });
      return data;
    } catch (error) {
      console.error('Failed to fetch diff:', error);
      set((state) => {
        const newCache = new Map(state.diffCache);
        const existing = newCache.get(cacheKey);
        if (existing) {
          newCache.set(cacheKey, { ...existing, isLoading: false });
        }
        return { diffCache: newCache };
      });
      throw error;
    } finally {
      if (diffRequests.get(cacheKey) === request) diffRequests.delete(cacheKey);
    }
  },

  fetchDiffIfNeeded: async (dirPath, comparisonBranch, useMergeBase, workspaceId) => {
    const state = get();
    const cacheKey = getDiffCacheKey(dirPath, comparisonBranch, useMergeBase, workspaceId);
    const cached = state.diffCache.get(cacheKey);

    // Return cached data if available, not loading, and has full diff text
    if (cached && !cached.isLoading && cached.hasFullDiff) {
      return cached.data;
    }

    // Already loading: answer with that fetch's diff, so callers still get one to show. A failure
    // is the fetch's own caller's to report.
    if (cached?.isLoading) {
      return diffRequests.get(cacheKey)?.catch(() => undefined);
    }

    return await state.fetchDiff(dirPath, comparisonBranch, useMergeBase, workspaceId);
  },

  // File diff content cache methods
  getFileDiffContent: (dirPath, filePath, stagedOrBranch, useMergeBase, workspaceId) => {
    const cacheKey = getFileDiffCacheKey(
      dirPath,
      filePath,
      stagedOrBranch,
      useMergeBase,
      workspaceId
    );
    return get().fileDiffCache.get(cacheKey);
  },

  fetchFileDiffContent: async (dirPath, filePath, staged, workspaceId) => {
    const cacheKey = getFileDiffCacheKey(dirPath, filePath, staged, undefined, workspaceId);
    const existingRequest = fileDiffContentRequests.get(cacheKey);
    if (existingRequest) return existingRequest;
    fileDiffsInvalidatedInFlight.delete(cacheKey);

    // Mark as loading
    set((state) => {
      const newCache = new Map(state.fileDiffCache);
      const existing = newCache.get(cacheKey);
      if (existing) {
        newCache.set(cacheKey, { ...existing, isLoading: true });
      } else {
        newCache.set(cacheKey, {
          content: {
            path: filePath,
            oldContent: null,
            newContent: null,
            status: 'modified',
            isBinary: false,
          },
          isLoading: true,
        });
      }
      return { fileDiffCache: newCache };
    });

    const request = (async () => {
      const content = workspaceId
        ? await window.api.getWorkspaceFileDiffContent(workspaceId, filePath, staged)
        : await window.api.getFileDiffContent(dirPath, filePath, staged);
      set((state) => {
        const newCache = new Map(state.fileDiffCache);
        const invalidatedDuringRequest = fileDiffsInvalidatedInFlight.has(cacheKey);
        newCache.set(cacheKey, {
          content,
          isLoading: false,
          ...(invalidatedDuringRequest ? { isStale: true } : {}),
        });
        return { fileDiffCache: newCache };
      });
      return content;
    })();

    fileDiffContentRequests.set(cacheKey, request);
    try {
      return await request;
    } catch (error) {
      console.error('Failed to fetch file diff content:', error);
      set((state) => {
        const newCache = new Map(state.fileDiffCache);
        const existing = newCache.get(cacheKey);
        if (existing) {
          newCache.set(cacheKey, { ...existing, isLoading: false });
        }
        return { fileDiffCache: newCache };
      });
      throw error;
    } finally {
      fileDiffContentRequests.delete(cacheKey);
      fileDiffsInvalidatedInFlight.delete(cacheKey);
    }
  },

  fetchFileDiffContentAgainstBranch: async (
    dirPath,
    filePath,
    branch,
    useMergeBase,
    workspaceId
  ) => {
    const cacheKey = getFileDiffCacheKey(dirPath, filePath, branch, useMergeBase, workspaceId);
    const existingRequest = fileDiffContentRequests.get(cacheKey);
    if (existingRequest) return existingRequest;
    fileDiffsInvalidatedInFlight.delete(cacheKey);

    // Mark as loading
    set((state) => {
      const newCache = new Map(state.fileDiffCache);
      const existing = newCache.get(cacheKey);
      if (existing) {
        newCache.set(cacheKey, { ...existing, isLoading: true });
      } else {
        newCache.set(cacheKey, {
          content: {
            path: filePath,
            oldContent: null,
            newContent: null,
            status: 'modified',
            isBinary: false,
          },
          isLoading: true,
        });
      }
      return { fileDiffCache: newCache };
    });

    const request = (async () => {
      const content = workspaceId
        ? await window.api.getWorkspaceFileDiffContentAgainstBranch(
            workspaceId,
            filePath,
            branch,
            !!useMergeBase
          )
        : await window.api.getFileDiffContentAgainstBranch(
            dirPath,
            filePath,
            branch,
            !!useMergeBase
          );
      set((state) => {
        const newCache = new Map(state.fileDiffCache);
        const invalidatedDuringRequest = fileDiffsInvalidatedInFlight.has(cacheKey);
        newCache.set(cacheKey, {
          content,
          isLoading: false,
          ...(invalidatedDuringRequest ? { isStale: true } : {}),
        });
        return { fileDiffCache: newCache };
      });
      return content;
    })();

    fileDiffContentRequests.set(cacheKey, request);
    try {
      return await request;
    } catch (error) {
      console.error('Failed to fetch file diff content against branch:', error);
      set((state) => {
        const newCache = new Map(state.fileDiffCache);
        const existing = newCache.get(cacheKey);
        if (existing) {
          newCache.set(cacheKey, { ...existing, isLoading: false });
        }
        return { fileDiffCache: newCache };
      });
      throw error;
    } finally {
      fileDiffContentRequests.delete(cacheKey);
      fileDiffsInvalidatedInFlight.delete(cacheKey);
    }
  },

  fetchFileDiffContentIfNeeded: async (
    dirPath,
    filePath,
    stagedOrBranch,
    useMergeBase,
    workspaceId
  ) => {
    const state = get();
    const cacheKey = getFileDiffCacheKey(
      dirPath,
      filePath,
      stagedOrBranch,
      useMergeBase,
      workspaceId
    );
    const cached = state.fileDiffCache.get(cacheKey);

    // Return cached data if available, not loading, and not stale
    if (cached && !cached.isLoading && !cached.isStale) {
      return cached.content;
    }

    // Reuse the existing request if this file is already being loaded.
    if (cached?.isLoading) {
      return fileDiffContentRequests.get(cacheKey);
    }

    if (typeof stagedOrBranch === 'string') {
      return await state.fetchFileDiffContentAgainstBranch(
        dirPath,
        filePath,
        stagedOrBranch,
        useMergeBase,
        workspaceId
      );
    }
    return await state.fetchFileDiffContent(dirPath, filePath, stagedOrBranch, workspaceId);
  },

  invalidate: (dirPath, workspaceId) => {
    set((state) => {
      const newCache = new Map(state.cache);
      const newStatusCache = new Map(state.statusCache);
      const newDiffCache = new Map(state.diffCache);
      const newFileDiffCache = new Map(state.fileDiffCache);
      const baseKeys = workspaceId ? [dirPath, `workspace:${workspaceId}`] : [dirPath];

      newCache.delete(dirPath);
      newStatusCache.delete(dirPath);

      // Clear all diff caches for this path (including branch comparisons)
      for (const key of newDiffCache.keys()) {
        if (baseKeys.some((baseKey) => key === baseKey || key.startsWith(`${baseKey}:`))) {
          newDiffCache.delete(key);
        }
      }

      // Clear all file diff content caches for this path
      for (const key of newFileDiffCache.keys()) {
        if (baseKeys.some((baseKey) => key.startsWith(`${baseKey}:`))) {
          newFileDiffCache.delete(key);
        }
      }

      return {
        cache: newCache,
        statusCache: newStatusCache,
        diffCache: newDiffCache,
        fileDiffCache: newFileDiffCache,
      };
    });
  },

  invalidateAll: () => {
    set({
      cache: new Map(),
      statusCache: new Map(),
      diffCache: new Map(),
      fileDiffCache: new Map(),
    });
  },

  invalidateStatuses: (dirPath) => {
    set((state) => {
      const newStatusCache = new Map(state.statusCache);
      newStatusCache.delete(dirPath);
      return { statusCache: newStatusCache };
    });
  },

  invalidateDiffs: (dirPath) => {
    set((state) => {
      const newDiffCache = new Map(state.diffCache);
      const newFileDiffCache = new Map(state.fileDiffCache);

      // Clear all diff caches for this path (including branch comparisons)
      for (const key of newDiffCache.keys()) {
        if (key === dirPath || key.startsWith(`${dirPath}:`)) {
          newDiffCache.delete(key);
        }
      }

      // Clear all file diff content caches for this path
      for (const key of newFileDiffCache.keys()) {
        if (key.startsWith(`${dirPath}:`)) {
          newFileDiffCache.delete(key);
        }
      }

      return {
        diffCache: newDiffCache,
        fileDiffCache: newFileDiffCache,
      };
    });
  },

  invalidateFileDiffs: (dirPath, workspaceId, changedPaths) => {
    set((state) => {
      let newFileDiffCache: typeof state.fileDiffCache | null = null;
      const prefixes = workspaceId ? [`${dirPath}:`, `workspace:${workspaceId}:`] : [`${dirPath}:`];
      // Keys continue with the file's path, then `:branch:…` for a branch comparison.
      const isInvalidated = (key: string): boolean =>
        prefixes.some((prefix) => {
          if (!key.startsWith(prefix)) return false;
          if (!changedPaths) return true;
          const rest = key.slice(prefix.length);
          return (
            isSameOrInside(rest, changedPaths) ||
            changedPaths.some((path) => rest.startsWith(`${path}:branch:`))
          );
        });

      // Mark per-file diff content caches as stale (not the summary diffCache).
      // Content is preserved so the UI can keep showing the DiffEditor while
      // a re-fetch is in progress, preventing unmount/remount flicker.
      for (const [key, entry] of state.fileDiffCache.entries()) {
        if (!isInvalidated(key)) continue;
        if (entry.isLoading) fileDiffsInvalidatedInFlight.add(key);
        if (!entry.isStale) {
          newFileDiffCache ??= new Map(state.fileDiffCache);
          newFileDiffCache.set(key, { ...entry, isStale: true });
        }
      }

      // Keep the existing Map when nothing changed so selectors don't re-render.
      return newFileDiffCache ? { fileDiffCache: newFileDiffCache } : state;
    });
  },

  invalidateBranchComparisonDiffs: (dirPath, workspaceId) => {
    set((state) => {
      let newDiffCache: typeof state.diffCache | null = null;
      const baseKeys = workspaceId ? [dirPath, `workspace:${workspaceId}`] : [dirPath];

      // Mark branch comparison entries (keys like "dirPath:main") as stale,
      // but preserve existing data so the UI doesn't flash empty during re-fetch.
      // The base entry (key = dirPath) is updated by applyPushedFileStatus.
      for (const [key, existing] of state.diffCache.entries()) {
        if (
          existing.hasFullDiff !== false &&
          baseKeys.some((baseKey) => key.startsWith(`${baseKey}:`) && key !== baseKey)
        ) {
          newDiffCache ??= new Map(state.diffCache);
          newDiffCache.set(key, { ...existing, hasFullDiff: false });
        }
      }

      // Keep the existing Map when nothing changed so selectors don't re-render.
      return newDiffCache ? { diffCache: newDiffCache } : state;
    });
  },

  applyPushedFileStatus: (dirPath, data, workspaceId) => {
    const statuses = new Map<string, FileChange['status']>();
    for (const f of data.files) {
      statuses.set(f.path, f.status);
      for (const ancestor of getAncestorPaths(f.path)) {
        if (!statuses.has(ancestor)) {
          statuses.set(ancestor, 'modified');
        }
      }
    }

    set((state) => {
      const newStatusCache = new Map(state.statusCache);
      newStatusCache.set(dirPath, { statuses, isLoading: false });

      const newDiffCache = new Map(state.diffCache);
      const cacheKeys = workspaceId ? [dirPath, `workspace:${workspaceId}`] : [dirPath];
      for (const cacheKey of cacheKeys) {
        const existingDiff = newDiffCache.get(cacheKey);
        if (existingDiff?.hasFullDiff) {
          // Update file list and summary stats, but mark full diff text as stale
          // so the diff viewer re-fetches it on next open.
          newDiffCache.set(cacheKey, {
            ...existingDiff,
            data: { ...existingDiff.data, files: data.files, summary: data.summary },
            hasFullDiff: false,
          });
        } else {
          newDiffCache.set(cacheKey, {
            data: { files: data.files, summary: data.summary },
            isLoading: false,
            hasFullDiff: false,
          });
        }
      }

      return { statusCache: newStatusCache, diffCache: newDiffCache };
    });
  },

  addUserCreatedDir: (dirPath, relativeDirPath) => {
    set((state) => {
      const newUserCreatedDirs = new Map(state.userCreatedDirs);
      const existing = newUserCreatedDirs.get(dirPath) ?? new Set();
      const updated = new Set(existing);
      updated.add(relativeDirPath);
      newUserCreatedDirs.set(dirPath, updated);

      // Also inject into the cached file list immediately so the tree updates
      const newCache = new Map(state.cache);
      const cached = newCache.get(dirPath);
      if (cached) {
        const emptyDirs = [...cached.emptyDirs];
        if (!emptyDirs.includes(relativeDirPath)) {
          emptyDirs.push(relativeDirPath);
        }
        newCache.set(dirPath, { ...cached, emptyDirs });
      }

      return { userCreatedDirs: newUserCreatedDirs, cache: newCache };
    });
  },
}));

/**
 * Where a file the working-tree changes list as renamed came from, so rolling it back can
 * restore that path. Reads the workspace's changes or the statuses the file tree fetched.
 */
export function findRenameSource(
  dirPath: string,
  filePath: string,
  workspaceId?: string
): string | undefined {
  const { getDiff } = useFileListStore.getState();
  return [getDiff(dirPath, null, false, workspaceId), getDiff(dirPath)]
    .flatMap((cached) => cached?.data?.files ?? [])
    .find((file) => file.path === filePath && file.originalPath)?.originalPath;
}
