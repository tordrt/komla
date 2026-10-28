import { useState, useEffect, useCallback, useLayoutEffect, useRef, useMemo } from 'react';

import { useDiffComparison, type DiffComparisonScope } from '@/hooks/useDiffComparison';
import { useConfigStore } from '@/stores/config.store';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';

import {
  isBrowserPreviewableFile,
  isImageFile,
  isMediaFile,
  isPdfFile,
  isUnsupportedBinaryFile,
} from '../../../../shared/image-utils';

import { matchFilePath } from './file-search-matcher';
import { groupFilesByStage, isOneSidedDiff, getFileLanguage } from './file-viewer-utils';

import type { FileViewerMode, ViewMode, GroupedFiles, FileSearchResult } from './types';
import type { CommitGraph, CommitGraphCommit } from '../../../../shared/types/commit-graph';
import type { WorktreeDiff, FileDiffContent, BranchInfo, CommitDiff } from '@/types';

// ============================================================================
// File Search State (for picker)
// ============================================================================

export interface FileSearchState {
  files: string[];
  filteredFiles: FileSearchResult[];
  query: string;
  setQuery: (query: string) => void;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  loading: boolean;
  error: string | null;
}

export function getFileDiskToken(metadata: { size: number; mtimeMs: number }): string {
  return `${metadata.size}:${metadata.mtimeMs}`;
}

export function usesFileMetadata(filePath: string, isMedia: boolean): boolean {
  return isMedia || isPdfFile(filePath) || isUnsupportedBinaryFile(filePath);
}

const FILE_SEARCH_DEBOUNCE_MS = 150;

export function useFileSearchState(
  workingDirectory: string,
  open: boolean,
  externalQuery?: { query: string; setQuery: (q: string) => void },
  includeGitIgnored = false,
  workspaceId?: string
): FileSearchState {
  // Use external query if provided, otherwise manage internally
  const [internalQuery, setInternalQuery] = useState('');
  const query = externalQuery?.query ?? internalQuery;
  const setQuery = externalQuery?.setQuery ?? setInternalQuery;
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Track if using external query (ref to avoid effect dependencies on object)
  const usingExternalQuery = useRef(!!externalQuery);
  usingExternalQuery.current = !!externalQuery;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced query setter for filtering
  const setQueryDebounced = useCallback(
    (value: string) => {
      setQuery(value); // Immediate UI feedback
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // External query comes from picker state and should update results immediately
      if (usingExternalQuery.current) {
        setDebouncedQuery(value);
        return;
      }
      debounceRef.current = setTimeout(() => setDebouncedQuery(value), FILE_SEARCH_DEBOUNCE_MS);
    },
    [setQuery]
  );

  // Cleanup debounce timeout on unmount
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  // Use the cached file list store
  const { getFileList, fetchFileListIfNeeded, fetchFileList } = useFileListStore();
  const cached = getFileList(workingDirectory);

  // Stable empty array reference to avoid dependency changes on every render
  const emptyArray = useMemo(() => [] as string[], []);
  const files = cached?.files ?? emptyArray;
  const gitIgnoredFiles = cached?.gitIgnoredFiles ?? emptyArray;
  const loading = cached?.isLoading ?? false;

  // Fetch gitignored files on-demand when user toggles the option on.
  // Track per-directory to avoid infinite loop when repo has no gitignored files.
  const gitIgnoredFetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      open &&
      includeGitIgnored &&
      gitIgnoredFiles.length === 0 &&
      !loading &&
      gitIgnoredFetchedFor.current !== workingDirectory
    ) {
      gitIgnoredFetchedFor.current = workingDirectory;
      fetchFileList(workingDirectory, true, workspaceId).catch(() => {});
    }
  }, [
    open,
    includeGitIgnored,
    gitIgnoredFiles.length,
    loading,
    workingDirectory,
    workspaceId,
    fetchFileList,
  ]);

  // Build haystack and item list for search
  const { haystack, items } = useMemo(() => {
    const itemList: Array<{ path: string; gitIgnored: boolean }> = files.map((f) => ({
      path: f,
      gitIgnored: false,
    }));
    if (includeGitIgnored) {
      itemList.push(...gitIgnoredFiles.map((f) => ({ path: f, gitIgnored: true })));
    }

    return {
      haystack: itemList.map((item) => item.path),
      items: itemList,
    };
  }, [files, gitIgnoredFiles, includeGitIgnored]);

  const filteredFiles: FileSearchResult[] = useMemo(() => {
    if (!debouncedQuery) {
      return items.map((item) => ({ path: item.path, gitIgnored: item.gitIgnored }));
    }

    // Cap results after scoring to avoid expensive list processing in the UI.
    const maxResults = 1000;
    const ranked = haystack
      .map((path, idx) => {
        const match = matchFilePath(path, debouncedQuery);
        if (!match) return null;
        return {
          idx,
          score: match.score,
          fileNameMatches: match.fileNameMatches,
          pathMatches: match.pathMatches,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (ranked.length === 0) return [];

    ranked.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const aPath = haystack[a.idx];
      const bPath = haystack[b.idx];
      const pathLengthDiff = aPath.length - bPath.length;
      if (pathLengthDiff !== 0) return pathLengthDiff;
      return aPath.localeCompare(bPath);
    });

    return ranked.slice(0, maxResults).map(({ idx, fileNameMatches, pathMatches }) => {
      const item = items[idx];
      return {
        path: item.path,
        gitIgnored: item.gitIgnored,
        fileNameMatches,
        pathMatches,
      };
    });
  }, [debouncedQuery, haystack, items]);

  // Reset selected index when debounced query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQuery]);

  // Sync debounced query when query changes (handles both internal and external query)
  useEffect(() => {
    if (!open) return;

    // For externally managed query (picker), avoid stale Enter selection by syncing immediately.
    if (usingExternalQuery.current) {
      setDebouncedQuery(query);
      return;
    }
    // Debounce query changes for internally managed inputs.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  // Fetch file list when opened (uses cache if fresh)
  useEffect(() => {
    if (open) {
      // Only reset internal query if not using external query
      if (!usingExternalQuery.current) {
        setInternalQuery('');
        setDebouncedQuery('');
      }
      setError(null);
      fetchFileListIfNeeded(workingDirectory, workspaceId).catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to list files');
      });
    } else {
      if (!usingExternalQuery.current) {
        setInternalQuery('');
        setDebouncedQuery('');
      }
      setError(null);
    }
  }, [open, workingDirectory, workspaceId, fetchFileListIfNeeded]);

  return {
    files,
    filteredFiles,
    query,
    setQuery: setQueryDebounced,
    selectedIndex,
    setSelectedIndex,
    loading,
    error,
  };
}

// ============================================================================
// File Editor State (for browse mode)
// ============================================================================

export interface FileEditorState {
  filePath: string | null;
  fileContent: string | null;
  diskContent: string | null; // Content when last loaded from disk
  isDirty: boolean;
  hasExternalChange: boolean; // File changed on disk since load
  missingOnDisk: boolean; // File was deleted or moved after being selected
  loadingFile: boolean;
  error: string | null;
  language: string;
  isBrowserPreviewable: boolean;
  isUnsupportedBinary: boolean;
  isImage: boolean;
  imageData: string | null;
  imageMimeType: string | null;
  isMedia: boolean;
  mediaData: string | null;
  mediaMimeType: string | null;
  mediaKind: 'audio' | 'video' | null;
  mediaSize: number | null;
  mediaPreviewLoading: boolean;
  mediaPreviewError: string | null;
  openFile: (path: string) => Promise<void>;
  loadMediaPreview: () => Promise<void>;
  reloadFromDisk: () => Promise<void>;
  setFileContent: (content: string) => void;
  setDiskContent: (content: string) => void;
  setIsDirty: (dirty: boolean) => void;
  setExternalChange: (changed: boolean) => void;
  setMissingOnDisk: (missing: boolean) => void;
  reset: () => void;
}

export function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('enoent') ||
    message.includes('no such file or directory') ||
    message.includes('cannot find the file')
  );
}

export function useFileEditorState(
  workingDirectory: string,
  workspaceId?: string
): FileEditorState {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [diskContent, setDiskContent] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [hasExternalChange, setHasExternalChange] = useState(false);
  const [missingOnDisk, setMissingOnDisk] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBrowserPreviewable, setIsBrowserPreviewable] = useState(false);
  const [isUnsupportedBinary, setIsUnsupportedBinary] = useState(false);
  const [isImage, setIsImage] = useState(false);
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string | null>(null);
  const [isMedia, setIsMedia] = useState(false);
  const [mediaData, setMediaData] = useState<string | null>(null);
  const [mediaMimeType, setMediaMimeType] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<'audio' | 'video' | null>(null);
  const [mediaSize, setMediaSize] = useState<number | null>(null);
  const [mediaPreviewLoading, setMediaPreviewLoading] = useState(false);
  const [mediaPreviewError, setMediaPreviewError] = useState<string | null>(null);

  const dirRef = useRef(workingDirectory);
  dirRef.current = workingDirectory;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const isDirtyRef = useRef(isDirty);
  useLayoutEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);
  const loadRequestIdRef = useRef(0);
  // An SSH file has no local metadata, so each load of one gets a version of its own.
  const remoteVersionRef = useRef(0);

  const language = useMemo(() => {
    if (!filePath) return 'plaintext';
    return getFileLanguage(filePath);
  }, [filePath]);

  const openFile = useCallback(async (path: string) => {
    const requestId = ++loadRequestIdRef.current;
    setFilePath(path);
    setLoadingFile(true);
    setIsDirty(false);
    setHasExternalChange(false);
    setMissingOnDisk(false);
    setError(null);
    const isRemoteWorkspace = dirRef.current.startsWith('ssh://');
    setIsBrowserPreviewable(isBrowserPreviewableFile(path));
    setIsUnsupportedBinary(isUnsupportedBinaryFile(path));
    setIsImage(false);
    setImageData(null);
    setImageMimeType(null);
    setIsMedia(false);
    setMediaData(null);
    setMediaMimeType(null);
    setMediaKind(null);
    setMediaSize(null);
    setMediaPreviewLoading(false);
    setMediaPreviewError(null);

    if (isUnsupportedBinaryFile(path) || isPdfFile(path)) {
      if (isRemoteWorkspace) {
        setFileContent(null);
        setDiskContent(`remote:${++remoteVersionRef.current}`);
        setLoadingFile(false);
        return;
      }
      try {
        const metadata = await window.api.getFileMetadata(dirRef.current, path);
        if (requestId !== loadRequestIdRef.current) return;
        setFileContent(null);
        setDiskContent(getFileDiskToken(metadata));
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return;
        setFileContent(null);
        setDiskContent(null);
        if (isMissingFileError(err)) {
          setMissingOnDisk(true);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to read file metadata');
        }
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setLoadingFile(false);
        }
      }
      return;
    }

    if (isImageFile(path)) {
      try {
        const result = workspaceIdRef.current
          ? await window.api.readWorkspaceImageFile(workspaceIdRef.current, path)
          : await window.api.readImageFile(dirRef.current, path);
        if (requestId !== loadRequestIdRef.current) return;
        setIsImage(true);
        setImageData(result.data);
        setImageMimeType(result.mimeType);
        setFileContent(null);
        setDiskContent(null);
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return;
        if (isMissingFileError(err)) {
          setMissingOnDisk(true);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to read image file');
        }
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setLoadingFile(false);
        }
      }
      return;
    }

    if (isMediaFile(path)) {
      if (isRemoteWorkspace) {
        setError('Remote media preview is not supported');
        setLoadingFile(false);
        return;
      }
      try {
        const result = await window.api.getMediaFileMetadata(dirRef.current, path);
        if (requestId !== loadRequestIdRef.current) return;
        setIsMedia(true);
        setMediaMimeType(result.mimeType);
        setMediaKind(result.kind);
        setMediaSize(result.size);
        setDiskContent(getFileDiskToken(result));
        setFileContent(null);
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return;
        if (isMissingFileError(err)) {
          setMissingOnDisk(true);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to read media metadata');
        }
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setLoadingFile(false);
        }
      }
      return;
    }

    try {
      const content = workspaceIdRef.current
        ? await window.api.readWorkspaceFile(workspaceIdRef.current, path)
        : await window.api.readFile(dirRef.current, path);
      if (requestId !== loadRequestIdRef.current) return;
      setFileContent(content);
      setDiskContent(content);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setFileContent(null);
      setDiskContent(null);
      if (isMissingFileError(err)) {
        setMissingOnDisk(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to read file');
      }
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoadingFile(false);
      }
    }
  }, []);

  const loadMediaPreview = useCallback(async () => {
    const path = filePathRef.current;
    if (!path || !isMediaFile(path)) return;
    const requestId = loadRequestIdRef.current;
    setMediaPreviewLoading(true);
    setMediaPreviewError(null);
    try {
      const result = await window.api.readMediaFile(dirRef.current, path);
      if (requestId !== loadRequestIdRef.current) return;
      if (filePathRef.current !== path) return;
      setMediaData(result.data);
      setMediaMimeType(result.mimeType);
      setMediaKind(result.kind);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      if (filePathRef.current !== path) return;
      setMediaPreviewError(err instanceof Error ? err.message : 'Failed to read media file');
    } finally {
      if (requestId === loadRequestIdRef.current && filePathRef.current === path) {
        setMediaPreviewLoading(false);
      }
    }
  }, []);

  const reloadFromDisk = useCallback(async () => {
    const path = filePathRef.current;
    if (!path) return;
    const requestId = ++loadRequestIdRef.current;
    // No loading state: the editor stays mounted and takes the new text as an edit, so the
    // cursor, scroll position and undo history survive an agent rewriting the file.
    const startedDirty = isDirtyRef.current;
    setError(null);
    const isRemoteWorkspace = dirRef.current.startsWith('ssh://');
    setIsBrowserPreviewable(isBrowserPreviewableFile(path));
    setIsUnsupportedBinary(isUnsupportedBinaryFile(path));
    try {
      if (isUnsupportedBinaryFile(path) || isPdfFile(path)) {
        const diskToken = isRemoteWorkspace
          ? `remote:${++remoteVersionRef.current}`
          : getFileDiskToken(await window.api.getFileMetadata(dirRef.current, path));
        if (requestId !== loadRequestIdRef.current) return;
        if (filePathRef.current !== path) return;
        setFileContent(null);
        setDiskContent(diskToken);
        setIsDirty(false);
        setHasExternalChange(false);
        setMissingOnDisk(false);
        return;
      }
      if (isImageFile(path)) {
        const result = workspaceIdRef.current
          ? await window.api.readWorkspaceImageFile(workspaceIdRef.current, path)
          : await window.api.readImageFile(dirRef.current, path);
        if (requestId !== loadRequestIdRef.current) return;
        if (filePathRef.current !== path) return;
        setImageData(result.data);
        setImageMimeType(result.mimeType);
        setIsDirty(false);
        setHasExternalChange(false);
        setMissingOnDisk(false);
        return;
      }
      if (isMediaFile(path)) {
        if (isRemoteWorkspace) {
          throw new Error('Remote media preview is not supported');
        }
        const result = await window.api.getMediaFileMetadata(dirRef.current, path);
        if (requestId !== loadRequestIdRef.current) return;
        if (filePathRef.current !== path) return;
        setMediaMimeType(result.mimeType);
        setMediaKind(result.kind);
        setMediaSize(result.size);
        setDiskContent(getFileDiskToken(result));
        setMediaData(null);
        setMediaPreviewError(null);
        setIsDirty(false);
        setHasExternalChange(false);
        setMissingOnDisk(false);
        return;
      }
      const content = workspaceIdRef.current
        ? await window.api.readWorkspaceFile(workspaceIdRef.current, path)
        : await window.api.readFile(dirRef.current, path);
      if (requestId !== loadRequestIdRef.current) return;
      if (filePathRef.current !== path) return;
      if (!startedDirty && isDirtyRef.current) {
        // The user typed while the file was reread: keep their edits and offer the reload.
        setHasExternalChange(true);
        return;
      }
      setFileContent(content);
      setDiskContent(content);
      setIsDirty(false);
      setHasExternalChange(false);
      setMissingOnDisk(false);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      if (filePathRef.current !== path) return;
      setFileContent(null);
      setDiskContent(null);
      if (isMissingFileError(err)) {
        setMissingOnDisk(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to read file');
      }
    } finally {
      if (requestId === loadRequestIdRef.current && filePathRef.current === path) {
        setLoadingFile(false);
      }
    }
  }, []);

  const setExternalChange = useCallback((changed: boolean) => {
    setHasExternalChange(changed);
  }, []);

  const reset = useCallback(() => {
    setFilePath(null);
    setFileContent(null);
    setDiskContent(null);
    setIsDirty(false);
    setHasExternalChange(false);
    setMissingOnDisk(false);
    setError(null);
    setIsBrowserPreviewable(false);
    setIsUnsupportedBinary(false);
    setIsImage(false);
    setImageData(null);
    setImageMimeType(null);
    setIsMedia(false);
    setMediaData(null);
    setMediaMimeType(null);
    setMediaKind(null);
    setMediaSize(null);
    setMediaPreviewLoading(false);
    setMediaPreviewError(null);
  }, []);

  return {
    filePath,
    fileContent,
    diskContent,
    isDirty,
    hasExternalChange,
    missingOnDisk,
    loadingFile,
    error,
    language,
    isBrowserPreviewable,
    isUnsupportedBinary,
    isImage,
    imageData,
    imageMimeType,
    isMedia,
    mediaData,
    mediaMimeType,
    mediaKind,
    mediaSize,
    mediaPreviewLoading,
    mediaPreviewError,
    openFile,
    loadMediaPreview,
    reloadFromDisk,
    setFileContent,
    setDiskContent,
    setIsDirty,
    setExternalChange,
    setMissingOnDisk,
    reset,
  };
}

// ============================================================================
// Diff Viewer State (for diff mode)
// ============================================================================

export interface DiffViewerState {
  diffData: WorktreeDiff | null;
  grouped: GroupedFiles;
  loading: boolean;
  hasFullDiff: boolean;
  error: string | null;
  selectedFile: string | null;
  fileContent: FileDiffContent | null;
  browserPreviewVersion: string | null;
  fileError: string | null;
  loadingFile: boolean;
  /** Layout for the selected file: the user's choice, or unified for one-sided diffs. */
  viewMode: ViewMode;
  /** False when the selected file only has one side (added or deleted). */
  splitViewAvailable: boolean;
  forceLargeFile: boolean;
  largeFileBlock: LargeFileBlock | null;
  hideUnchangedRegions: boolean;
  // Branch comparison
  comparisonBranch: string | null; // null = HEAD (current behavior)
  useMergeBase: boolean;
  comparisonLoading: boolean;
  availableBranches: BranchInfo[];
  loadingBranches: boolean;
  // History sub-state
  commits: CommitGraphCommit[];
  /** The checked-out branch and its upstream, for coloring their lanes. */
  historyBranchRoles: Pick<CommitGraph, 'currentBranch' | 'upstream'>;
  loadingCommits: boolean;
  hasMoreCommits: boolean;
  selectedCommitHash: string | null;
  commitDiff: CommitDiff | null;
  loadingCommitDiff: boolean;
  historySelectedFile: string | null;
  historyFileContent: FileDiffContent | null;
  historyLoadingFile: boolean;
  historyViewMode: ViewMode;
  historySplitViewAvailable: boolean;
  historyForceLargeFile: boolean;
  historyError: string | null;
  historyFilterPath: string | null;
  setHistoryFilterPath: (path: string | null) => void;
  historyBranch: string | null;
  setHistoryBranch: (branch: string | null) => void;
  // Actions
  /** Sets the user's split/unified choice, shared by changes and history. */
  setViewMode: (mode: ViewMode) => void;
  setSelectedFile: (path: string) => void;
  selectFileByPath: (path: string) => Promise<void>;
  selectFileByPathDeferred: (path: string) => void;
  /** Re-fetches the diff, and the per-file diffs of `changedPaths` or, without them, of all files. */
  refresh: (changedPaths?: readonly string[]) => Promise<void>;
  retryFile: () => void;
  loadLargeFile: () => void;
  setHideUnchangedRegions: (hide: boolean) => void;
  setComparisonBranch: (branch: string | null, useMergeBase?: boolean) => Promise<void>;
  loadBranches: () => Promise<void>;
  fetchBranches: () => Promise<void>;
  // History actions
  loadCommits: () => Promise<void>;
  loadMoreCommits: () => Promise<void>;
  loadCommitsUntil: (targetHash: string) => Promise<void>;
  selectCommit: (hash: string, preferFile?: string) => Promise<void>;
  selectHistoryFile: (path: string) => Promise<void>;
  setHistoryViewMode: (mode: ViewMode) => void;
  loadHistoryLargeFile: () => void;
  retryHistory: () => void;
  refreshHistory: () => Promise<void>;
}

const COMMITS_PAGE_SIZE = 50;

// Pre-flight gate: skip fetching diff content for files with very large change
// counts. Bytes ≠ lines, but for typical text files line count is a cheap and
// reliable proxy. The post-fetch byte gate in DiffPane catches edge cases like
// minified single-line bundles that slip through.
export const LARGE_FILE_LINE_THRESHOLD = 10_000;

const SELECTION_LOAD_DELAY_MS = 150;
const DIFF_PREFETCH_DELAY_MS = 100;
const DIFF_PREFETCH_OFFSETS = [1, 2, 3, -1];

export interface LargeFileBlock {
  lines: number;
}

export function computeLargeFileBlock(
  fileChange: { additions: number; deletions: number } | undefined,
  forceLargeFile: boolean,
  lineThreshold: number = LARGE_FILE_LINE_THRESHOLD
): LargeFileBlock | null {
  if (!fileChange || forceLargeFile) return null;
  const lines = fileChange.additions + fileChange.deletions;
  return lines > lineThreshold ? { lines } : null;
}

export function isFileViewerActive(open: boolean, enabled: boolean): boolean {
  return open && enabled;
}

export function shouldReloadSelectedDiffContent(params: {
  open: boolean;
  selectedFile: string | null;
  fileContent: FileDiffContent | null;
  isStale: boolean;
  loadingFile: boolean;
  fileError: string | null;
}): boolean {
  const { open, selectedFile, fileContent, isStale, loadingFile, fileError } = params;
  return open && !!selectedFile && (!fileContent || isStale) && !loadingFile && !fileError;
}

export function useDiffViewerState(
  workingDirectory: string,
  open: boolean,
  workspaceId: string,
  initialHistoryFilterPath?: string | null,
  comparisonScope: DiffComparisonScope = 'file-viewer'
): DiffViewerState {
  const { config, setDiffHideUnchangedRegions } = useConfigStore();
  const {
    getDiff: getCachedDiff,
    fetchDiff,
    fetchDiffIfNeeded,
    getFileDiffContent: getCachedFileDiffContent,
    fetchFileDiffContentIfNeeded,
    invalidateFileDiffs,
  } = useFileListStore();

  // Restore persisted selections from store (survives close/reopen)
  const persistedSelections = useFileViewerStore.getState().getDiffSelections(workspaceId);

  // Local UI state (not cached)
  const [selectedFile, setSelectedFile] = useState<string | null>(persistedSelections.selectedFile);
  const preferredViewMode = useFileViewerStore((s) => s.diffViewMode);
  const setViewMode = useFileViewerStore((s) => s.setDiffViewMode);
  const [forceLargeFile, setForceLargeFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [browserPreviewVersion, setBrowserPreviewVersion] = useState<string | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const comparisonLoadingRef = useRef(false);
  const { comparisonBranch, useMergeBase } = useDiffComparison(workspaceId, comparisonScope);
  const setInlineComparisonBranchInStore = useFileViewerStore(
    (s) => s.setInlineFileTreeComparisonBranch
  );
  const setFileViewerComparisonBranchInStore = useFileViewerStore(
    (s) => s.setFileViewerDiffComparisonBranch
  );
  const [availableBranches, setAvailableBranches] = useState<BranchInfo[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // History sub-state
  const [commits, setCommits] = useState<CommitGraphCommit[]>([]);
  const [historyBranchRoles, setHistoryBranchRoles] = useState<
    Pick<CommitGraph, 'currentBranch' | 'upstream'>
  >({ currentBranch: null, upstream: null });
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [hasMoreCommits, setHasMoreCommits] = useState(true);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
    persistedSelections.selectedCommitHash
  );
  const [commitDiff, setCommitDiff] = useState<CommitDiff | null>(null);
  const [loadingCommitDiff, setLoadingCommitDiff] = useState(false);
  const [historySelectedFile, setHistorySelectedFile] = useState<string | null>(
    persistedSelections.historySelectedFile
  );
  const [historyFileContent, setHistoryFileContent] = useState<FileDiffContent | null>(null);
  const [historyLoadingFile, setHistoryLoadingFile] = useState(false);
  const [historyForceLargeFile, setHistoryForceLargeFile] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilterPath, setHistoryFilterPathState] = useState<string | null>(null);
  const historyFilterPathRef = useRef<string | null>(null);
  const [historyBranch, setHistoryBranchState] = useState<string | null>(null);
  const historyBranchRef = useRef<string | null>(null);

  const historySplitViewAvailable = !isOneSidedDiff(historyFileContent?.status);
  const historyViewMode: ViewMode = historySplitViewAvailable ? preferredViewMode : 'unified';

  // Read from config, default to true (hide unchanged regions)
  const hideUnchangedRegions = config?.diffHideUnchangedRegions ?? true;

  // Get cached data from store
  const cachedDiff = getCachedDiff(workingDirectory, comparisonBranch, useMergeBase, workspaceId);
  const diffData = cachedDiff?.data ?? null;
  const loading = cachedDiff?.isLoading ?? false;
  const hasFullDiff = cachedDiff?.hasFullDiff ?? false;

  // Derive grouped files from diffData
  const grouped = useMemo(() => {
    if (!diffData) return { files: [] };
    return groupFilesByStage(diffData.files);
  }, [diffData]);

  const selectedFileChange = useMemo(() => {
    if (!selectedFile) return undefined;
    const path = selectedFile;
    return grouped.files.find((f) => f.path === path);
  }, [selectedFile, grouped.files]);

  // Pre-flight gate: derive whether the currently selected file is large
  // enough that we should refuse to fetch its diff content. Recomputed any
  // time the selection, file list, or force flag changes.
  const largeFileBlock = useMemo<LargeFileBlock | null>(
    () => computeLargeFileBlock(selectedFileChange, forceLargeFile),
    [selectedFileChange, forceLargeFile]
  );

  // Added and deleted files have an empty side, so they always show unified.
  // This is derived per file and never overwrites the user's choice.
  const splitViewAvailable = !isOneSidedDiff(selectedFileChange?.status);
  const viewMode: ViewMode = splitViewAvailable ? preferredViewMode : 'unified';

  // Get cached file content.
  // invalidateFileDiffs marks entries as stale (preserving content) instead of
  // deleting them, so fileContent stays non-null during background re-fetches
  // and the DiffEditor never unmounts due to cache churn.
  const cachedFileContent = selectedFile
    ? getCachedFileDiffContent(
        workingDirectory,
        selectedFile,
        comparisonBranch ?? false,
        useMergeBase,
        workspaceId
      )
    : undefined;
  const fileContent = cachedFileContent?.content ?? null;
  const loadingFile = cachedFileContent?.isLoading ?? false;
  const isStale = cachedFileContent?.isStale ?? false;

  // Keep refs for use in callbacks that shouldn't re-create
  const dirRef = useRef(workingDirectory);
  dirRef.current = workingDirectory;
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  // Separate ref for pending file restore — not overwritten by renders
  const pendingFileRestoreRef = useRef<string | null>(null);
  const comparisonBranchRef = useRef(comparisonBranch);
  comparisonBranchRef.current = comparisonBranch;
  const useMergeBaseRef = useRef(useMergeBase);
  useMergeBaseRef.current = useMergeBase;
  // Synchronously-updated refs so handlers see the freshest value without
  // waiting for a re-render. Critical for the large-file pre-flight gate:
  // when the user picks a different file we must reset force=false before
  // loadFileContent reads it, otherwise a stale "true" leaks across files.
  const groupedRef = useRef<GroupedFiles>({ files: [] });
  groupedRef.current = grouped;
  const forceLargeFileRef = useRef(forceLargeFile);
  forceLargeFileRef.current = forceLargeFile;
  // Debounced-load timer for arrow-key navigation
  const selectionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedDiffContextRef = useRef<{
    workingDirectory: string;
    comparisonBranch: string | null;
    useMergeBase: boolean;
  } | null>(null);
  const browserPreviewVersionLoadIdRef = useRef(0);

  const loadFileContent = useCallback(
    async (fileKey: string) => {
      const browserPreviewVersionLoadId = ++browserPreviewVersionLoadIdRef.current;
      setFileError(null);
      // Pre-flight size guard — skip the IPC + state allocation for huge diffs
      // until the user opts in via "Load Anyway".
      const path = fileKey;
      const fc = groupedRef.current.files.find((f) => f.path === path);
      if (computeLargeFileBlock(fc, forceLargeFileRef.current)) {
        return;
      }
      try {
        const stagedOrBranch = comparisonBranchRef.current ?? false;
        await fetchFileDiffContentIfNeeded(
          dirRef.current,
          path,
          stagedOrBranch,
          useMergeBaseRef.current,
          workspaceId
        );
        if (isPdfFile(path)) {
          if (fc?.status === 'deleted') {
            if (browserPreviewVersionLoadId === browserPreviewVersionLoadIdRef.current) {
              setBrowserPreviewVersion(null);
            }
          } else if (dirRef.current.startsWith('ssh://')) {
            // No local metadata: each load reads the PDF from the host again.
            if (browserPreviewVersionLoadId === browserPreviewVersionLoadIdRef.current) {
              setBrowserPreviewVersion(`remote:${browserPreviewVersionLoadId}`);
            }
          } else {
            try {
              const metadata = await window.api.getFileMetadata(dirRef.current, path);
              if (browserPreviewVersionLoadId === browserPreviewVersionLoadIdRef.current) {
                setBrowserPreviewVersion(getFileDiskToken(metadata));
              }
            } catch (err) {
              if (!isMissingFileError(err)) {
                console.warn('Failed to load PDF preview metadata:', err);
              }
              if (browserPreviewVersionLoadId === browserPreviewVersionLoadIdRef.current) {
                setBrowserPreviewVersion(null);
              }
            }
          }
        } else if (browserPreviewVersionLoadId === browserPreviewVersionLoadIdRef.current) {
          setBrowserPreviewVersion(null);
        }
      } catch (err) {
        console.error('Failed to load file content:', err);
        setFileError(err instanceof Error ? err.message : 'Failed to load file content');
      }
    },
    [fetchFileDiffContentIfNeeded, workspaceId]
  );

  useEffect(() => {
    if (!open || !selectedFile) return;

    const selectedPath = selectedFile;
    const selectedIndex = grouped.files.findIndex((file) => file.path === selectedPath);
    if (selectedIndex === -1) return;

    const stagedOrBranch = comparisonBranch ?? false;
    const candidates = DIFF_PREFETCH_OFFSETS.map((offset) => grouped.files[selectedIndex + offset])
      .filter((file): file is NonNullable<typeof file> => !!file && !file.isDirectory)
      .filter((file) => !computeLargeFileBlock(file, false))
      .filter((file) => {
        const cached = getCachedFileDiffContent(
          workingDirectory,
          file.path,
          stagedOrBranch,
          useMergeBase,
          workspaceId
        );
        return !cached || cached.isStale;
      });

    if (candidates.length === 0) return;

    const timeout = setTimeout(() => {
      for (const file of candidates) {
        void fetchFileDiffContentIfNeeded(
          workingDirectory,
          file.path,
          stagedOrBranch,
          useMergeBase,
          workspaceId
        ).catch(() => {});
      }
    }, DIFF_PREFETCH_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [
    open,
    selectedFile,
    grouped.files,
    comparisonBranch,
    useMergeBase,
    workingDirectory,
    workspaceId,
    getCachedFileDiffContent,
    fetchFileDiffContentIfNeeded,
  ]);

  const cancelDeferredSelection = useCallback(() => {
    if (selectionDebounceRef.current) {
      clearTimeout(selectionDebounceRef.current);
      selectionDebounceRef.current = null;
    }
  }, []);

  const selectFileByPath = useCallback(
    async (fileKey: string) => {
      cancelDeferredSelection();
      setSelectedFile(fileKey);
      setForceLargeFile(false);
      forceLargeFileRef.current = false;
      // Persist to layout store for restoration when reopening
      useFileViewerStore.getState().setLastDiffFile(dirRef.current, fileKey);
      await loadFileContent(fileKey);
    },
    [cancelDeferredSelection, loadFileContent]
  );

  const selectFileByPathDeferred = useCallback(
    (fileKey: string) => {
      cancelDeferredSelection();
      setSelectedFile(fileKey);
      setForceLargeFile(false);
      forceLargeFileRef.current = false;
      useFileViewerStore.getState().setLastDiffFile(dirRef.current, fileKey);
      selectionDebounceRef.current = setTimeout(() => {
        selectionDebounceRef.current = null;
        void loadFileContent(fileKey);
      }, SELECTION_LOAD_DELAY_MS);
    },
    [cancelDeferredSelection, loadFileContent]
  );

  // Cancel pending debounce on unmount
  useEffect(() => cancelDeferredSelection, [cancelDeferredSelection]);

  // Also cancel when the diff context changes underneath a queued load —
  // workspace, comparison branch, or merge-base mode. Without this, a timer
  // queued under one context would fire loadFileContent against the new one.
  useEffect(() => {
    cancelDeferredSelection();
  }, [workingDirectory, workspaceId, comparisonBranch, useMergeBase, cancelDeferredSelection]);

  const loadDiff = useCallback(
    async (options?: { force?: boolean; changedPaths?: readonly string[] }) => {
      setError(null);
      try {
        loadedDiffContextRef.current = {
          workingDirectory: dirRef.current,
          comparisonBranch: comparisonBranchRef.current,
          useMergeBase: useMergeBaseRef.current,
        };
        let data: WorktreeDiff | undefined;
        if (options?.force) {
          // Force re-fetch: clear stale per-file diffs, then unconditionally fetch
          invalidateFileDiffs(dirRef.current, workspaceId, options.changedPaths);
          data = await fetchDiff(
            dirRef.current,
            comparisonBranchRef.current,
            useMergeBaseRef.current,
            workspaceId
          );
        } else {
          data = await fetchDiffIfNeeded(
            dirRef.current,
            comparisonBranchRef.current,
            useMergeBaseRef.current,
            workspaceId
          );
        }
        if (!data) return; // Loading with no fetch to wait for, or another caller's fetch failed

        const groups = groupFilesByStage(data.files);
        // Sync ref so loadFileContent's pre-flight gate sees this list before
        // React commits the derived `grouped` state.
        groupedRef.current = groups;
        const allFiles = groups.files;

        if (allFiles.length > 0) {
          // Try to restore: pending restore first, then current selection, then lastDiffFile, then first file
          const pendingRestore = pendingFileRestoreRef.current;
          pendingFileRestoreRef.current = null;
          const currentSelection = selectedFileRef.current;
          const lastDiffFile = useFileViewerStore.getState().getLastDiffFile(dirRef.current);
          let preserved: (typeof allFiles)[0] | undefined;

          // Try pending restore first (set on open from per-workspace store)
          if (pendingRestore) {
            const pendPath = pendingRestore;
            preserved = allFiles.find((f) => f.path === pendPath);
          }
          // Try current selection
          if (!preserved && currentSelection) {
            const selPath = currentSelection;
            preserved = allFiles.find((f) => f.path === selPath);
          }
          // Fall back to lastDiffFile (per working directory)
          if (!preserved && lastDiffFile) {
            const lastPath = lastDiffFile;
            preserved = allFiles.find((f) => f.path === lastPath);
          }
          const target = preserved || allFiles[0];
          const targetKey = target.path;
          setSelectedFile(targetKey);
          // Reset the force flag whenever the diff load picks a new target —
          // the previous file's "Load Anyway" choice shouldn't carry over.
          setForceLargeFile(false);
          forceLargeFileRef.current = false;
          // Persist selection for restoration when reopening
          useFileViewerStore.getState().setLastDiffFile(dirRef.current, targetKey);
          await loadFileContent(targetKey);
        } else {
          setSelectedFile(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load diff');
      }
    },
    [fetchDiff, fetchDiffIfNeeded, invalidateFileDiffs, loadFileContent, workspaceId]
  );

  const retryFile = useCallback(() => {
    if (selectedFile) {
      void loadFileContent(selectedFile);
    }
  }, [selectedFile, loadFileContent]);

  const loadLargeFile = useCallback(() => {
    setForceLargeFile(true);
    forceLargeFileRef.current = true;
    // Re-fire the fetch — earlier loadFileContent calls bailed out at the
    // pre-flight gate, so content was never loaded.
    if (selectedFileRef.current) {
      void loadFileContent(selectedFileRef.current);
    }
  }, [loadFileContent]);

  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);
    try {
      const branches = await window.api.listWorkspaceBranches(workspaceId, true);
      setAvailableBranches(branches);
    } catch (err) {
      console.error('Failed to load branches:', err);
      setAvailableBranches([]);
    } finally {
      setLoadingBranches(false);
    }
  }, [workspaceId]);

  const fetchBranches = useCallback(async () => {
    const result = await window.api.fetchWorkspaceRemote(workspaceId);
    if (!result.success) throw new Error(result.message);
  }, [workspaceId]);

  const refresh = useCallback(
    async (changedPaths?: readonly string[]) => {
      await loadDiff({ force: true, changedPaths });
    },
    [loadDiff]
  );

  const setComparisonBranch = useCallback(
    async (branch: string | null, mergeBase?: boolean) => {
      if (comparisonLoadingRef.current) return;

      const previousBranch = comparisonBranchRef.current;
      const previousMergeBase = useMergeBaseRef.current;
      const nextMergeBase = mergeBase ?? false;
      if (previousBranch === branch && previousMergeBase === nextMergeBase) return;

      comparisonLoadingRef.current = true;
      setComparisonLoading(true);
      setError(null);
      try {
        await fetchDiff(dirRef.current, branch, nextMergeBase, workspaceId);
        if (comparisonScope === 'file-viewer') {
          setFileViewerComparisonBranchInStore(workspaceId, branch, nextMergeBase);
        } else {
          setInlineComparisonBranchInStore(workspaceId, branch, nextMergeBase);
        }
        comparisonBranchRef.current = branch;
        useMergeBaseRef.current = nextMergeBase;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load diff');
      } finally {
        comparisonLoadingRef.current = false;
        setComparisonLoading(false);
      }
    },
    [
      comparisonScope,
      fetchDiff,
      setFileViewerComparisonBranchInStore,
      setInlineComparisonBranchInStore,
      workspaceId,
    ]
  );

  // --- History callbacks ---
  const historyLoadIdRef = useRef(0);
  // Bumped per commit/file selection, and when another branch or file's history
  // shows, so a late answer can't land on, or report an error for, a selection
  // the user has already moved past.
  const historySelectionIdRef = useRef(0);
  // Re-runs whichever history load last failed (the DiffPane Retry button).
  const historyRetryRef = useRef<(() => void) | null>(null);
  const failHistory = useCallback((err: unknown, fallback: string, retry: () => void) => {
    historyRetryRef.current = retry;
    setHistoryError(err instanceof Error ? err.message : fallback);
  }, []);
  const failHistorySelection = useCallback(
    (selectionId: number, err: unknown, fallback: string, retry: () => void) => {
      if (selectionId === historySelectionIdRef.current) failHistory(err, fallback, retry);
    },
    [failHistory]
  );
  const selectedCommitHashRef = useRef(selectedCommitHash);
  selectedCommitHashRef.current = selectedCommitHash;
  const historySelectedFileRef = useRef(historySelectedFile);
  historySelectedFileRef.current = historySelectedFile;

  // A page of the history shown: older commits from `skip` on, of the chosen branch and file.
  const readCommitPage = useCallback(
    (skip: number, limit = COMMITS_PAGE_SIZE) =>
      window.api.getWorkspaceCommitGraph(workspaceId, {
        limit,
        skip,
        ref: historyBranchRef.current ?? undefined,
        path: historyFilterPathRef.current ?? undefined,
      }),
    [workspaceId]
  );

  const loadCommits = useCallback(async () => {
    const id = ++historyLoadIdRef.current;
    setLoadingCommits(true);
    setHistoryError(null);
    try {
      const page = await readCommitPage(0);
      if (id !== historyLoadIdRef.current) return;
      setCommits(page.commits);
      setHistoryBranchRoles({ currentBranch: page.currentBranch, upstream: page.upstream });
      setHasMoreCommits(page.hasMore);
    } catch (err) {
      if (id !== historyLoadIdRef.current) return;
      setCommits([]);
      setHasMoreCommits(false);
      failHistory(err, 'Failed to load commits', () => void loadCommits());
    } finally {
      if (id === historyLoadIdRef.current) setLoadingCommits(false);
    }
  }, [failHistory, readCommitPage]);

  const loadMoreCommits = useCallback(async () => {
    // A branch or file chosen meanwhile starts a load of its own, which these commits aren't part of.
    const id = historyLoadIdRef.current;
    setLoadingCommits(true);
    try {
      const page = await readCommitPage(commits.length);
      if (id !== historyLoadIdRef.current) return;
      setCommits((prev) => [...prev, ...page.commits]);
      setHasMoreCommits(page.hasMore);
    } catch {
      if (id === historyLoadIdRef.current) setHasMoreCommits(false);
    } finally {
      if (id === historyLoadIdRef.current) setLoadingCommits(false);
    }
  }, [commits.length, readCommitPage]);

  const selectCommit = useCallback(
    async (hash: string, preferFile?: string) => {
      const selectionId = ++historySelectionIdRef.current;
      // A commit or file chosen meanwhile has the diff view to itself.
      const isCurrent = () => selectionId === historySelectionIdRef.current;
      setSelectedCommitHash(hash);
      setCommitDiff(null);
      setHistorySelectedFile(null);
      setHistoryFileContent(null);
      setHistoryLoadingFile(false);
      setHistoryForceLargeFile(false);
      setHistoryError(null);
      setLoadingCommitDiff(true);
      try {
        const diff = await window.api.getWorkspaceCommitDiff(workspaceId, hash);
        if (!isCurrent()) return;
        setCommitDiff(diff);
        // Loaded, even if another of its files is chosen before the first one's diff answers.
        setLoadingCommitDiff(false);
        if (diff.files.length > 0) {
          // Prefer the explicitly requested file, then the filter path
          const filterPath = preferFile ?? historyFilterPathRef.current;
          let targetPath = diff.files[0].path;
          if (filterPath) {
            const exact = diff.files.find((f) => f.path === filterPath);
            if (exact) {
              targetPath = exact.path;
            } else {
              // --follow may show the file under a previous name; pick the closest match
              const filterBase = filterPath.split('/').pop();
              const byBasename = diff.files.find((f) => f.path.split('/').pop() === filterBase);
              if (byBasename) targetPath = byBasename.path;
            }
          }
          const firstPath = targetPath;
          setHistorySelectedFile(firstPath);
          setHistoryLoadingFile(true);
          try {
            const content = await window.api.getWorkspaceCommitFileDiff(
              workspaceId,
              hash,
              firstPath
            );
            if (isCurrent()) setHistoryFileContent(content);
          } catch (err) {
            if (isCurrent()) setHistoryFileContent(null);
            failHistorySelection(selectionId, err, 'Failed to load file diff', () => {
              void selectCommit(hash, firstPath);
            });
          } finally {
            if (isCurrent()) setHistoryLoadingFile(false);
          }
        }
      } catch (err) {
        if (!isCurrent()) return;
        setCommitDiff(null);
        failHistorySelection(selectionId, err, 'Failed to load commit', () => {
          void selectCommit(hash, preferFile);
        });
      } finally {
        if (isCurrent()) setLoadingCommitDiff(false);
      }
    },
    [failHistorySelection, workspaceId]
  );

  const selectHistoryFile = useCallback(
    async (path: string) => {
      const hash = selectedCommitHashRef.current;
      if (!hash) return;
      const selectionId = ++historySelectionIdRef.current;
      setHistorySelectedFile(path);
      setHistoryForceLargeFile(false);
      setHistoryError(null);
      setHistoryLoadingFile(true);
      const isCurrent = () => selectionId === historySelectionIdRef.current;
      try {
        const content = await window.api.getWorkspaceCommitFileDiff(workspaceId, hash, path);
        if (isCurrent()) setHistoryFileContent(content);
      } catch (err) {
        if (isCurrent()) setHistoryFileContent(null);
        failHistorySelection(selectionId, err, 'Failed to load file diff', () => {
          void selectHistoryFile(path);
        });
      } finally {
        if (isCurrent()) setHistoryLoadingFile(false);
      }
    },
    [failHistorySelection, workspaceId]
  );

  // History diffs arrive fully loaded before DiffPane's size gate, so opting
  // in only needs to lift the gate.
  const loadHistoryLargeFile = useCallback(() => setHistoryForceLargeFile(true), []);

  const retryHistory = useCallback(() => {
    const retry = historyRetryRef.current;
    historyRetryRef.current = null;
    retry?.();
  }, []);

  const setHistoryFilterPath = useCallback((path: string | null) => {
    historyFilterPathRef.current = path;
    setHistoryFilterPathState(path);
    // Clear commits and selection so the effect reloads with the new filter
    setCommits([]);
    ++historySelectionIdRef.current;
    setSelectedCommitHash(null);
    setCommitDiff(null);
    setLoadingCommitDiff(false);
    setHistorySelectedFile(null);
    setHistoryFileContent(null);
    setHistoryLoadingFile(false);
    setHasMoreCommits(true);
  }, []);

  const setHistoryBranch = useCallback((branch: string | null) => {
    historyBranchRef.current = branch;
    setHistoryBranchState(branch);
    // Clear commits and selection so the effect reloads with the new branch
    setCommits([]);
    ++historySelectionIdRef.current;
    setSelectedCommitHash(null);
    setCommitDiff(null);
    setLoadingCommitDiff(false);
    setHistorySelectedFile(null);
    setHistoryFileContent(null);
    setHistoryLoadingFile(false);
    setHasMoreCommits(true);
  }, []);

  const loadCommitsUntil = useCallback(
    async (targetHash: string) => {
      // First, load initial batch if empty
      const id = ++historyLoadIdRef.current;
      setLoadingCommits(true);
      setHistoryError(null);
      try {
        const page = await readCommitPage(0);
        if (id !== historyLoadIdRef.current) return;
        setCommits(page.commits);
        setHistoryBranchRoles({ currentBranch: page.currentBranch, upstream: page.upstream });
        setHasMoreCommits(page.hasMore);
        if (!page.hasMore || page.commits.some((c) => c.hash === targetHash)) return;

        // The next 10 pages in one read, a round trip each over SSH, shown up to the target's page.
        const older = await readCommitPage(page.commits.length, COMMITS_PAGE_SIZE * 10);
        if (id !== historyLoadIdRef.current) return;
        const allCommits = [...page.commits, ...older.commits];
        const index = allCommits.findIndex((c) => c.hash === targetHash);
        const shown =
          index < 0
            ? allCommits
            : allCommits.slice(0, Math.ceil((index + 1) / COMMITS_PAGE_SIZE) * COMMITS_PAGE_SIZE);
        setCommits(shown);
        setHasMoreCommits(older.hasMore || shown.length < allCommits.length);
      } catch (err) {
        if (id !== historyLoadIdRef.current) return;
        failHistory(err, 'Failed to load commits', () => void loadCommitsUntil(targetHash));
      } finally {
        if (id === historyLoadIdRef.current) setLoadingCommits(false);
      }
    },
    [failHistory, readCommitPage]
  );

  const refreshHistory = useCallback(async () => {
    const prevHash = selectedCommitHashRef.current;
    await loadCommits();
    if (prevHash) {
      void selectCommit(prevHash);
    }
  }, [loadCommits, selectCommit]);

  // Re-fetch file content when cache is invalidated (marked stale by the global
  // file watcher) while a file is still selected. The stale content is preserved
  // in the cache so the DiffEditor stays mounted during the re-fetch.
  useEffect(() => {
    // Skip while a deferred selection is queued — the timer will fire the load
    // once arrow-key navigation settles.
    if (selectionDebounceRef.current) return;
    if (
      selectedFile &&
      shouldReloadSelectedDiffContent({
        open,
        selectedFile,
        fileContent,
        isStale,
        loadingFile,
        fileError,
      })
    ) {
      void loadFileContent(selectedFile);
    }
  }, [open, selectedFile, fileContent, loadingFile, isStale, fileError, loadFileContent]);

  // Load diff when dialog opens (uses cache if available)
  useEffect(() => {
    if (open) {
      // Sync ref with store value on open
      comparisonBranchRef.current = comparisonBranch;
      // Apply initial history filter path (e.g. from inline panel "File History")
      // Must be set before loadCommits effect fires so the ref is available
      if (initialHistoryFilterPath) {
        historyFilterPathRef.current = initialHistoryFilterPath;
        setHistoryFilterPathState(initialHistoryFilterPath);
      }
      // Restore persisted selections from store
      const saved = useFileViewerStore.getState().getDiffSelections(workspaceId);
      // Use dedicated ref that won't be overwritten by re-renders during loadDiff
      if (saved.selectedFile) {
        pendingFileRestoreRef.current = saved.selectedFile;
      }
      // Restore history state (must be set before loadCommits effect fires)
      if (!initialHistoryFilterPath) {
        if (saved.historyBranch) {
          historyBranchRef.current = saved.historyBranch;
          setHistoryBranchState(saved.historyBranch);
        }
        if (saved.historyFilterPath) {
          historyFilterPathRef.current = saved.historyFilterPath;
          setHistoryFilterPathState(saved.historyFilterPath);
        }
      }
      void loadDiff();
    } else {
      // Save selections to store so they survive close/reopen (use refs for current values)
      useFileViewerStore.getState().saveDiffSelections(workspaceId, {
        selectedFile: selectedFileRef.current,
        selectedCommitHash: selectedCommitHashRef.current,
        historySelectedFile: historySelectedFileRef.current,
        historyBranch: historyBranchRef.current,
        historyFilterPath: historyFilterPathRef.current,
      });
      // Reset transient UI state on close, but keep cache and persisted selections
      // Note: comparisonBranch lives in the store and persists across open/close
      cancelDeferredSelection();
      setSelectedFile(null);
      setError(null);
      setFileError(null);
      setForceLargeFile(false);
      setAvailableBranches([]);
      // Reset history transient state (selections are persisted above)
      setCommits([]);
      setSelectedCommitHash(null);
      setCommitDiff(null);
      setHistorySelectedFile(null);
      setHistoryFileContent(null);
      setHistoryForceLargeFile(false);
      setHistoryError(null);
      setHasMoreCommits(true);
      historyFilterPathRef.current = null;
      setHistoryFilterPathState(null);
      historyBranchRef.current = null;
      setHistoryBranchState(null);
    }
  }, [open, workingDirectory, initialHistoryFilterPath]); // oxlint-disable-line react/exhaustive-deps

  // External controls such as the branch dropdown can change comparison state
  // without calling setComparisonBranch on this hook instance.
  useEffect(() => {
    if (!open) return;
    const loaded = loadedDiffContextRef.current;
    if (
      loaded?.workingDirectory === workingDirectory &&
      loaded.comparisonBranch === comparisonBranch &&
      loaded.useMergeBase === useMergeBase
    ) {
      return;
    }
    void loadDiff();
  }, [open, workingDirectory, comparisonBranch, useMergeBase, loadDiff]);

  // Load commits when history sub-mode is active
  const diffSubMode = useFileViewerStore((s) => s.fileViewerDiffSubMode);
  const pendingCommitRestore = useRef<{ hash: string; file: string | null } | null>(null);
  useEffect(() => {
    if (open && diffSubMode === 'history' && commits.length === 0 && !loadingCommits) {
      // Check if we should restore a persisted commit after loading
      const saved = useFileViewerStore.getState().getDiffSelections(workspaceId);
      if (saved.selectedCommitHash && !selectedCommitHash) {
        pendingCommitRestore.current = {
          hash: saved.selectedCommitHash,
          file: saved.historySelectedFile,
        };
      }
      void loadCommits();
    }
  }, [open, diffSubMode, historyFilterPath, historyBranch]); // oxlint-disable-line react/exhaustive-deps

  // Restore persisted commit selection after commits finish loading
  useEffect(() => {
    if (
      pendingCommitRestore.current &&
      commits.length > 0 &&
      !loadingCommits &&
      !selectedCommitHash
    ) {
      const { hash, file } = pendingCommitRestore.current;
      pendingCommitRestore.current = null;
      // Only restore if the commit exists in the loaded list
      if (commits.some((c) => c.hash === hash)) {
        void selectCommit(hash, file ?? undefined);
      }
    }
  }, [commits, loadingCommits]); // oxlint-disable-line react/exhaustive-deps

  return {
    diffData,
    grouped,
    loading,
    hasFullDiff,
    error,
    selectedFile,
    fileContent,
    browserPreviewVersion,
    fileError,
    loadingFile,
    viewMode,
    splitViewAvailable,
    forceLargeFile,
    largeFileBlock,
    hideUnchangedRegions,
    comparisonBranch,
    useMergeBase,
    comparisonLoading,
    availableBranches,
    loadingBranches,
    // History sub-state
    commits,
    historyBranchRoles,
    loadingCommits,
    hasMoreCommits,
    selectedCommitHash,
    commitDiff,
    loadingCommitDiff,
    historySelectedFile,
    historyFileContent,
    historyLoadingFile,
    historyViewMode,
    historySplitViewAvailable,
    historyForceLargeFile,
    historyError,
    historyFilterPath,
    setHistoryFilterPath,
    historyBranch,
    setHistoryBranch,
    // Actions
    setViewMode,
    setSelectedFile,
    selectFileByPath,
    selectFileByPathDeferred,
    refresh,
    retryFile,
    loadLargeFile,
    setHideUnchangedRegions: setDiffHideUnchangedRegions,
    setComparisonBranch,
    loadBranches,
    fetchBranches,
    // History actions
    loadCommits,
    loadMoreCommits,
    loadCommitsUntil,
    selectCommit,
    selectHistoryFile,
    setHistoryViewMode: setViewMode,
    loadHistoryLargeFile,
    retryHistory,
    refreshHistory,
  };
}

// ============================================================================
// Main File Viewer State (coordinates all modes)
// ============================================================================

export interface FileViewerState {
  mode: FileViewerMode;
  setMode: (mode: FileViewerMode) => void;
  // Editor state (browse mode)
  editor: FileEditorState;
  // Diff state (diff mode, includes history sub-state)
  diff: DiffViewerState;
  // Search state (picker)
  search: FileSearchState;
}

export function useFileViewerState(
  workingDirectory: string,
  open: boolean,
  initialMode: FileViewerMode = 'browse',
  workspaceId: string,
  diffEnabled = true,
  initialHistoryFilterPath?: string | null,
  enabled = true,
  comparisonScope: DiffComparisonScope = 'file-viewer'
): FileViewerState {
  const activeOpen = isFileViewerActive(open, enabled);
  const [mode, setModeState] = useState<FileViewerMode>(
    diffEnabled || initialMode !== 'diff' ? initialMode : 'browse'
  );

  const editor = useFileEditorState(workingDirectory, workspaceId);
  const diff = useDiffViewerState(
    workingDirectory,
    activeOpen && diffEnabled,
    workspaceId,
    initialHistoryFilterPath,
    comparisonScope
  );
  const search = useFileSearchState(workingDirectory, false, undefined, false, workspaceId); // Picker is managed separately

  // Refs so setMode (a stable callback) can read the latest editor/diff state
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const diffRef = useRef(diff);
  diffRef.current = diff;

  const setMode = useCallback(
    (nextMode: FileViewerMode) => {
      if (!diffEnabled && nextMode === 'diff') {
        setModeState('browse');
        return;
      }
      setModeState((prev) => {
        if (prev === nextMode) return prev;
        // When switching to browse, reload the file from disk so edits
        // made in diff mode (or by AI) are reflected immediately. Skip the
        // reload for git-deleted files — browse mode would read them off
        // disk and surface ENOENT; diff mode renders the deletion diff fine
        // so the user can see it there without us opening a doomed file here.
        if (nextMode === 'browse') {
          const diffFile = diffRef.current.selectedFile;
          const path = diffFile || editorRef.current.filePath;
          if (path) {
            const diffStatus = diffRef.current.diffData?.files.find((f) => f.path === path)?.status;
            if (diffStatus !== 'deleted') {
              void editorRef.current.openFile(path);
            }
          }
        }
        return nextMode;
      });
    },
    [diffEnabled]
  );

  // Sync mode from prop when dialog opens
  useEffect(() => {
    if (activeOpen) {
      setMode(diffEnabled || initialMode !== 'diff' ? initialMode : 'browse');
    }
  }, [activeOpen, initialMode, diffEnabled, setMode]);

  // When switching to diff mode while dialog is open, refresh diff data
  useEffect(() => {
    if (diffEnabled && activeOpen && mode === 'diff' && !diff.diffData && !diff.loading) {
      void diff.refresh();
    }
  }, [activeOpen, mode, diff, diffEnabled]);

  return {
    mode,
    setMode,
    editor,
    diff,
    search,
  };
}
