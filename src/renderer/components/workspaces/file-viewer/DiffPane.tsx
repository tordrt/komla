import { DiffEditor } from '@monaco-editor/react';
import { WarningCircle, ArrowCounterClockwise, GitDiff } from '@phosphor-icons/react';
import {
  forwardRef,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { useKomlaEditorTheme, useMonacoThemeName } from '@/hooks/useKomlaEditorTheme';
import { editorFontSize, KOMLA_EDITOR_BASE_OPTIONS } from '@/lib/monaco-loader';
import { addMonacoShortcutForwarding } from '@/lib/monaco-shortcut-forwarding';
import { useCustomizationStore } from '@/stores/customization.store';

import { isMediaFile } from '../../../../shared/image-utils';

import {
  chooseDiffModelPaths,
  retainDiffModels,
  type DiffModelPaths,
  type DiffModelSource,
} from './diff-model-cache';
import { shouldShowDiffLoadingPlaceholder, shouldShowMissingDiffPanel } from './diff-pane-state';
import {
  buildDiffEditorKey,
  getFileLanguage,
  getShikiLanguage,
  hasBuiltInLanguageIntelligence,
  hasContentChanged,
} from './file-viewer-utils';
import { ImageDiffPane } from './ImageDiffPane';
import { MediaPane } from './MediaPane';

import type { ViewMode } from './types';
import type { FileDiffContent } from '@/types';
import type { Monaco } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';

interface DiffPaneProps {
  workingDirectory: string;
  fileContent: FileDiffContent | null;
  viewMode: ViewMode;
  selectedFile: string | null;
  loading: boolean;
  loadingFile: boolean;
  error: string | null;
  forceLargeFile: boolean;
  largeFileBlock: { lines: number } | null;
  hideUnchangedRegions: boolean;
  /** Editor width, in px, at or below which split draws as unified. */
  inlineBreakpointPx?: number;
  allowWorkingTreeMediaPreview?: boolean;
  onRetry: () => void;
  onLoadLargeFile: () => void;
  onCloseMissing?: () => void;
  // Preferred over onCloseMissing when set: diff mode has no tab to close.
  onRefreshMissing?: () => void;
  onEditorMount?: (editor: monacoEditor.IStandaloneDiffEditor) => void;
  hasFiles?: boolean;
  isDirty?: boolean;
  readOnly?: boolean;
}

const LARGE_FILE_THRESHOLD = 1024 * 1024;
/**
 * How long Monaco may refine a diff down to characters. Past it the changed lines still show,
 * highlighted whole. Its default of 5s left a heavily rewritten file blank that long.
 */
const DIFF_COMPUTATION_BUDGET_MS = 1000;
/** When to show an editor whose diff never arrived, as from a failed worker, rather than spin on. */
const DIFF_REVEAL_FALLBACK_MS = 10_000;

interface BinaryMediaDiffPreviewProps {
  workingDirectory: string;
  filePath: string;
}

function BinaryMediaDiffPreview({ workingDirectory, filePath }: BinaryMediaDiffPreviewProps) {
  const currentMediaRef = useRef({ workingDirectory, filePath });
  const previewRequestIdRef = useRef(0);
  const [data, setData] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [kind, setKind] = useState<'audio' | 'video' | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  currentMediaRef.current = { workingDirectory, filePath };

  useEffect(() => {
    let cancelled = false;
    previewRequestIdRef.current++;
    setData(null);
    setMimeType(null);
    setKind(null);
    setSize(null);
    setLoadingMetadata(true);
    setPreviewLoading(false);
    setError(null);

    window.api
      .getMediaFileMetadata(workingDirectory, filePath)
      .then((result) => {
        if (cancelled) return;
        setMimeType(result.mimeType);
        setKind(result.kind);
        setSize(result.size);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to read media metadata');
      })
      .finally(() => {
        if (!cancelled) setLoadingMetadata(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workingDirectory, filePath]);

  const loadPreview = useCallback(async () => {
    const requestId = ++previewRequestIdRef.current;
    const requestedMedia = { workingDirectory, filePath };
    setPreviewLoading(true);
    setError(null);
    try {
      const result = await window.api.readMediaFile(workingDirectory, filePath);
      if (
        requestId !== previewRequestIdRef.current ||
        currentMediaRef.current.workingDirectory !== requestedMedia.workingDirectory ||
        currentMediaRef.current.filePath !== requestedMedia.filePath
      ) {
        return;
      }
      setData(result.data);
      setMimeType(result.mimeType);
      setKind(result.kind);
    } catch (err) {
      if (
        requestId !== previewRequestIdRef.current ||
        currentMediaRef.current.workingDirectory !== requestedMedia.workingDirectory ||
        currentMediaRef.current.filePath !== requestedMedia.filePath
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to read media file');
    } finally {
      if (
        requestId === previewRequestIdRef.current &&
        currentMediaRef.current.workingDirectory === requestedMedia.workingDirectory &&
        currentMediaRef.current.filePath === requestedMedia.filePath
      ) {
        setPreviewLoading(false);
      }
    }
  }, [workingDirectory, filePath]);

  return (
    <MediaPane
      data={data}
      mimeType={mimeType ?? 'application/octet-stream'}
      kind={kind ?? 'video'}
      fileName={filePath}
      fileSize={size}
      loading={loadingMetadata || previewLoading}
      error={error}
      onLoadPreview={loadingMetadata ? undefined : loadPreview}
    />
  );
}

function MissingDiffFilePanel({
  path,
  onRefreshMissing,
  onCloseMissing,
}: {
  path: string;
  onRefreshMissing?: () => void;
  onCloseMissing?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-muted-foreground">
      <div className="text-sm font-medium text-foreground">File deleted or moved</div>
      <div className="max-w-md text-center font-mono text-xs" title={path}>
        {path}
      </div>
      {onRefreshMissing ? (
        <Button variant="outline" size="sm" onClick={onRefreshMissing}>
          Refresh changes
        </Button>
      ) : (
        onCloseMissing && (
          <Button variant="outline" size="sm" onClick={onCloseMissing}>
            Close Tab
          </Button>
        )
      )}
    </div>
  );
}

function renderDiffPaneStatus(params: {
  workingDirectory: string;
  fileContent: FileDiffContent | null;
  selectedFile: string | null;
  loading: boolean;
  loadingFile: boolean;
  error: string | null;
  forceLargeFile: boolean;
  largeFileBlock: { lines: number } | null;
  hasFiles: boolean;
  allowWorkingTreeMediaPreview: boolean;
  onRetry: () => void;
  onLoadLargeFile: () => void;
  onCloseMissing?: () => void;
  onRefreshMissing?: () => void;
}): React.ReactElement | null {
  const {
    workingDirectory,
    fileContent,
    selectedFile,
    loading,
    loadingFile,
    error,
    forceLargeFile,
    largeFileBlock,
    hasFiles,
    allowWorkingTreeMediaPreview,
    onRetry,
    onLoadLargeFile,
    onCloseMissing,
    onRefreshMissing,
  } = params;

  // Pre-flight gate: refuse to fetch oversized diffs based on line count from
  // FileChange metadata. Render this *before* the loading skeleton so we never
  // appear to be loading a file we've actually skipped.
  if (largeFileBlock) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <span>Large diff (~{largeFileBlock.lines.toLocaleString()} lines)</span>
        <span className="text-sm">Diff rendering may be slow</span>
        <Button variant="outline" size="sm" onClick={onLoadLargeFile}>
          Load Anyway
        </Button>
      </div>
    );
  }

  // Initialization failures leave Monaco unready; do not hide them behind loading.
  if (loading && !error) {
    return <LoadingState label="Loading editor" />;
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-error/30 bg-error/10 p-6">
          <WarningCircle className="size-8 text-error" />
          <p className="text-center text-sm text-error">{error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <ArrowCounterClockwise className="mr-2 size-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Only show loading skeleton when no content is available yet (initial load).
  // When content exists but is being re-fetched (stale cache), keep the DiffEditor
  // mounted to preserve undo history, scroll position, and unsaved edits.
  const deletedPath = fileContent?.path ?? selectedFile ?? null;
  const showMissingDiffPanel = shouldShowMissingDiffPanel({
    fileContent,
    selectedFile,
    loadingFile,
  });

  if (showMissingDiffPanel && deletedPath) {
    return (
      <MissingDiffFilePanel
        path={deletedPath}
        onRefreshMissing={onRefreshMissing}
        onCloseMissing={onCloseMissing}
      />
    );
  }

  if (shouldShowDiffLoadingPlaceholder({ fileContent, loadingFile })) {
    return <LoadingState label="Loading diff" />;
  }

  if (!fileContent) {
    return (
      <EmptyState
        className="min-h-0 flex-1"
        icon={<GitDiff weight="duotone" />}
        title={hasFiles ? 'Select a file to view changes' : 'No changes in worktree'}
      />
    );
  }

  if (fileContent.isBinary) {
    if (
      fileContent.isImage &&
      fileContent.mimeType &&
      (fileContent.oldImageData || fileContent.newImageData)
    ) {
      return (
        <ImageDiffPane
          oldImageData={fileContent.oldImageData ?? null}
          newImageData={fileContent.newImageData ?? null}
          mimeType={fileContent.mimeType}
          status={fileContent.status}
          fileName={fileContent.path}
        />
      );
    }
    if (
      allowWorkingTreeMediaPreview &&
      fileContent.status !== 'deleted' &&
      isMediaFile(fileContent.path)
    ) {
      return (
        <BinaryMediaDiffPreview workingDirectory={workingDirectory} filePath={fileContent.path} />
      );
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        Binary file changed
      </div>
    );
  }

  const totalSize = (fileContent.oldContent || '').length + (fileContent.newContent || '').length;
  if (totalSize > LARGE_FILE_THRESHOLD && !forceLargeFile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <span>Large file ({(totalSize / 1024 / 1024).toFixed(1)} MB)</span>
        <span className="text-sm">Diff rendering may be slow</span>
        <Button variant="outline" size="sm" onClick={onLoadLargeFile}>
          Load Anyway
        </Button>
      </div>
    );
  }

  return null;
}

function syncBackdropSnapshot(params: {
  editorInstanceKey: string;
  prevEditorKeyRef: React.MutableRefObject<string | null>;
  editorReadyRef: React.MutableRefObject<boolean>;
  diffContainerRef: React.RefObject<HTMLDivElement | null>;
  backdropRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { editorInstanceKey, prevEditorKeyRef, editorReadyRef, diffContainerRef, backdropRef } =
    params;

  if (prevEditorKeyRef.current === editorInstanceKey) return;

  const isFirstRender = prevEditorKeyRef.current === null;
  prevEditorKeyRef.current = editorInstanceKey;

  if (isFirstRender) return;

  // Only snapshot if the live editor is ready — on rapid switches, keep the existing backdrop.
  if (editorReadyRef.current && diffContainerRef.current && backdropRef.current) {
    backdropRef.current.innerHTML = diffContainerRef.current.innerHTML;
  }
  editorReadyRef.current = false;
  if (diffContainerRef.current) {
    diffContainerRef.current.style.visibility = 'hidden';
  }
}

const HIDDEN = { visibility: 'hidden' } as const;

interface DiffLoadingOverlayHandle {
  /** The diff of the editor with this key is on screen. */
  shown(editorKey: string): void;
}

/**
 * The spinner over a diff not worked out yet. It keeps its own state, so showing a diff renders
 * only this.
 */
const DiffLoadingOverlay = forwardRef<
  DiffLoadingOverlayHandle,
  { editorKey: string; backgroundColor?: string }
>(({ editorKey, backgroundColor }, ref) => {
  const [shownKey, setShownKey] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({ shown: setShownKey }), []);
  if (shownKey === editorKey) return null;
  return (
    <LoadingState label="Loading diff" className="absolute inset-0" style={{ backgroundColor }} />
  );
});
DiffLoadingOverlay.displayName = 'DiffLoadingOverlay';

function measureContainer(container: HTMLElement | null): monacoEditor.IDimension | undefined {
  if (!container || container.clientWidth === 0) return undefined;
  return { width: container.clientWidth, height: container.clientHeight };
}

/**
 * Starts the editor at its container's size, laid out by DiffPane from then on. Monaco's own
 * layout first measures the editor while @monaco-editor/react still hides it: 5px wide, under
 * the inline breakpoint, so its first diff skipped moved code and a second ran once it was shown.
 */
function sizedOptions(
  options: monacoEditor.IStandaloneDiffEditorConstructionOptions,
  dimension: monacoEditor.IDimension | undefined
): monacoEditor.IStandaloneDiffEditorConstructionOptions {
  return dimension ? { ...options, automaticLayout: false, dimension } : options;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines++;
  }
  return lines;
}

function buildDiffEditorOptions(params: {
  fontSize: number;
  readOnly: boolean;
  viewMode: ViewMode;
  lineNumbersMinChars: number;
  validationDecorations: boolean;
  hideUnchangedRegions: boolean;
  inlineBreakpointPx: number;
}): monacoEditor.IStandaloneDiffEditorConstructionOptions {
  const { viewMode } = params;
  return {
    ...KOMLA_EDITOR_BASE_OPTIONS,
    fontSize: params.fontSize,
    // Hide the regular vertical scrollbar; the fat diff overview ruler
    // is itself interactive (click/drag to scroll) and serves as the
    // sole scroll indicator in diff mode.
    scrollbar: {
      ...KOMLA_EDITOR_BASE_OPTIONS.scrollbar,
      vertical: 'hidden',
    },
    readOnly: params.readOnly,
    originalEditable: false,
    renderSideBySide: viewMode === 'split',
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    wordWrap: 'on',
    lineNumbers: 'on',
    lineNumbersMinChars: params.lineNumbersMinChars,
    lineDecorationsWidth: viewMode === 'split' ? 10 : 8,
    glyphMargin: viewMode === 'split',
    automaticLayout: true,
    renderOverviewRuler: true,
    overviewRulerBorder: false,
    overviewRulerLanes: 1,
    renderIndicators: false,
    // A highlighted current line reads as one more change in a diff.
    renderLineHighlight: 'none',
    padding: { top: 16, bottom: 12 },
    renderValidationDecorations: params.validationDecorations ? 'on' : 'off',
    renderMarginRevertIcon: viewMode === 'split',
    maxComputationTime: DIFF_COMPUTATION_BUDGET_MS,

    // Hide unchanged regions to focus on changes
    hideUnchangedRegions: {
      enabled: params.hideUnchangedRegions,
      revealLineCount: 2, // Lines to show around changes
      minimumLineCount: 3, // Min unchanged lines before collapsing
      contextLineCount: 2, // Context when expanded
    },

    // Auto-switch to unified view when editor is narrow
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: params.inlineBreakpointPx,

    // Sticky scroll for context (shows function/class headers)
    stickyScroll: {
      enabled: true,
      maxLineCount: 3,
    },

    // Experimental moved code detection
    experimental: {
      showMoves: true,
    },
  };
}

export function DiffPane({
  workingDirectory,
  fileContent,
  viewMode,
  selectedFile,
  loading,
  loadingFile,
  error,
  forceLargeFile,
  largeFileBlock,
  hideUnchangedRegions,
  inlineBreakpointPx = 900,
  allowWorkingTreeMediaPreview = true,
  onRetry,
  onLoadLargeFile,
  onCloseMissing,
  onRefreshMissing,
  onEditorMount,
  hasFiles = true,
  isDirty = false,
  readOnly = false,
}: DiffPaneProps) {
  // These refs must live above all early returns to satisfy Rules of Hooks.
  // They track a version counter that increments when content changes, so we
  // can force a DiffEditor remount and avoid a Monaco race condition where an
  // in-flight async diff references stale line numbers after a model update.
  const contentVersionRef = useRef(0);
  const cleanContentVersionRef = useRef(0);
  const prevContentRef = useRef<{ old: string; new: string } | null>(null);

  // A new editor shows its text before Monaco has diffed it: unhighlighted, and with unchanged
  // regions still open. So it stays hidden until its diff arrives. Meanwhile a snapshot of the
  // previous editor's DOM stays on a backdrop, and a slow diff shows a spinner over it.
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const prevEditorKeyRef = useRef<string | null>(null);
  const editorReadyRef = useRef(false);
  const loadingOverlayRef = useRef<DiffLoadingOverlayHandle>(null);
  const editorTheme = useKomlaEditorTheme();
  const monacoThemeName = useMonacoThemeName();
  const fontSize = useCustomizationStore((state) =>
    editorFontSize(state.terminalConfig?.font.size)
  );

  // The models this mount shows, picked once per editor key so the editor never swaps them.
  const modelsRef = useRef<{
    key: string;
    source: DiffModelSource;
    paths: DiffModelPaths;
    // Set when the editor starts at this size and DiffPane lays it out: see `sizedOptions`.
    dimension: monacoEditor.IDimension | undefined;
    baseOptions: monacoEditor.IStandaloneDiffEditorConstructionOptions;
    options: monacoEditor.IStandaloneDiffEditorConstructionOptions;
  } | null>(null);
  // The editor's last size, for one that mounts after the loading placeholder took its place.
  const lastDimensionRef = useRef<monacoEditor.IDimension | undefined>(undefined);

  const handleEditorMount = useCallback(
    (editor: monacoEditor.IStandaloneDiffEditor, monaco: Monaco) => {
      const shown = modelsRef.current;
      const container = diffContainerRef.current;
      if (shown?.dimension && container) {
        const layout = () => {
          const dimension = measureContainer(container);
          if (!dimension) return;
          lastDimensionRef.current = dimension;
          editor.layout(dimension);
        };
        const resizeObserver = new ResizeObserver(layout);
        resizeObserver.observe(container);
        editor.getModifiedEditor().onDidDispose(() => resizeObserver.disconnect());
      }
      const models = editor.getModel();
      if (shown && models) {
        const release = retainDiffModels(shown.source, shown.paths, models, () =>
          monaco.editor.getModels()
        );
        editor.getModifiedEditor().onDidDispose(() => {
          release();
          // An editor shown again later, as after a binary file, picks its models afresh.
          if (modelsRef.current === shown) modelsRef.current = null;
        });
      }

      // In unified mode, hide the original editor's line numbers
      if (viewMode !== 'split') {
        editor.getOriginalEditor().updateOptions({
          lineNumbers: 'off',
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          glyphMargin: false,
          folding: false,
        });
      }

      addMonacoShortcutForwarding(editor.getModifiedEditor());
      addMonacoShortcutForwarding(editor.getOriginalEditor());

      // Reveal after the first diff computation completes (regions are collapsed), or at the
      // deadline: a slow diff shows this file uncollapsed rather than the previous one.
      const reveal = () => {
        clearTimeout(revealDeadline);
        diffDisposable.dispose();
        editorReadyRef.current = true;
        if (shown) loadingOverlayRef.current?.shown(shown.key);
        if (diffContainerRef.current) {
          diffContainerRef.current.style.visibility = 'visible';
        }
        if (backdropRef.current) {
          backdropRef.current.innerHTML = '';
        }
      };
      const diffDisposable = editor.onDidUpdateDiff(reveal);
      const revealDeadline = setTimeout(reveal, DIFF_REVEAL_FALLBACK_MS);
      // Monaco keeps the diffs of models shown before: one may have arrived before this ran.
      if (editor.getLineChanges() !== null) reveal();
      editor.getModifiedEditor().onDidDispose(() => {
        clearTimeout(revealDeadline);
        diffDisposable.dispose();
      });

      onEditorMount?.(editor);
    },
    [viewMode, onEditorMount]
  );

  // Built once per change: the editor applies a new options object on every render it gets.
  const oldContent = fileContent?.oldContent || '';
  const newContent = fileContent?.newContent || '';
  const lineCount = useMemo(
    () => Math.max(countLines(oldContent), countLines(newContent)),
    [oldContent, newContent]
  );
  const monacoLanguage = fileContent ? getFileLanguage(fileContent.path) : 'plaintext';
  const isDeleted = fileContent?.status === 'deleted';
  const editorOptions = useMemo(
    () =>
      buildDiffEditorOptions({
        fontSize,
        readOnly: readOnly || isDeleted,
        viewMode,
        lineNumbersMinChars: Math.max(viewMode === 'split' ? 2 : 1, String(lineCount).length),
        validationDecorations: hasBuiltInLanguageIntelligence(monacoLanguage),
        hideUnchangedRegions,
        inlineBreakpointPx,
      }),
    [
      fontSize,
      readOnly,
      isDeleted,
      viewMode,
      lineCount,
      monacoLanguage,
      hideUnchangedRegions,
      inlineBreakpointPx,
    ]
  );

  const statusFallback = renderDiffPaneStatus({
    workingDirectory,
    fileContent,
    selectedFile,
    loading,
    loadingFile,
    error,
    forceLargeFile,
    largeFileBlock,
    hasFiles,
    allowWorkingTreeMediaPreview,
    onRetry,
    onLoadLargeFile,
    onCloseMissing,
    onRefreshMissing,
  });
  if (statusFallback) return statusFallback;
  // renderDiffPaneStatus returned null, so fileContent is a non-binary, renderable diff.
  if (!fileContent) return null;

  if (hasContentChanged(prevContentRef.current, oldContent, newContent)) {
    prevContentRef.current = { old: oldContent, new: newContent };
    contentVersionRef.current++;
  }
  if (!isDirty) {
    cleanContentVersionRef.current = contentVersionRef.current;
  }

  const editorLanguage =
    monacoLanguage === 'plaintext'
      ? monacoLanguage
      : getShikiLanguage(fileContent.path, monacoLanguage);
  const editorInstanceKey = buildDiffEditorKey({
    selectedFile,
    filePath: fileContent.path,
    viewMode,
    hideUnchangedRegions,
    contentVersion: cleanContentVersionRef.current,
  });

  if (modelsRef.current?.key !== editorInstanceKey) {
    const source = {
      workingDirectory,
      path: fileContent.path,
      original: oldContent,
      modified: newContent,
    };
    const dimension = measureContainer(diffContainerRef.current) ?? lastDimensionRef.current;
    modelsRef.current = {
      key: editorInstanceKey,
      source,
      paths: chooseDiffModelPaths(source),
      dimension,
      baseOptions: editorOptions,
      options: sizedOptions(editorOptions, dimension),
    };
  } else if (modelsRef.current.baseOptions !== editorOptions) {
    modelsRef.current.baseOptions = editorOptions;
    modelsRef.current.options = sizedOptions(editorOptions, modelsRef.current.dimension);
  }

  // When the editor key changes, snapshot the current editor DOM into the backdrop
  // and hide the new editor until its diff is ready.
  syncBackdropSnapshot({
    editorInstanceKey,
    prevEditorKeyRef,
    editorReadyRef,
    diffContainerRef,
    backdropRef,
  });

  return (
    <div className="relative min-h-0 flex-1" style={{ backgroundColor: editorTheme.bg }}>
      {/* Backdrop: holds a static snapshot of the previous editor while the new one loads */}
      <div ref={backdropRef} className="pointer-events-none absolute inset-0" />
      {/* Live editor container — hidden until its diff arrives */}
      <div
        ref={diffContainerRef}
        className="flex h-full flex-col"
        // Shown by the editor's mount once its diff arrives, without a render.
        style={HIDDEN}
      >
        <DiffEditor
          key={editorInstanceKey}
          height="100%"
          original={oldContent}
          modified={newContent}
          language={editorLanguage}
          theme={monacoThemeName}
          // Hidden with the editor: the spinner below says it is loading.
          loading={null}
          originalModelPath={modelsRef.current.paths.original}
          modifiedModelPath={modelsRef.current.paths.modified}
          // diff-model-cache owns these models, to show this diff again without rebuilding them.
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          onMount={handleEditorMount}
          options={modelsRef.current.options}
        />
      </div>
      <DiffLoadingOverlay
        ref={loadingOverlayRef}
        editorKey={editorInstanceKey}
        backgroundColor={editorTheme.bg}
      />
    </div>
  );
}
