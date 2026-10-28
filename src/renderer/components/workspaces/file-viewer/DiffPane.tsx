import { DiffEditor } from '@monaco-editor/react';
import { WarningCircle, ArrowCounterClockwise, GitDiff } from '@phosphor-icons/react';
import { useRef, useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useKomlaEditorTheme, useMonacoThemeName } from '@/hooks/useKomlaEditorTheme';
import { editorFontSize, KOMLA_EDITOR_BASE_OPTIONS } from '@/lib/monaco-loader';
import { addMonacoShortcutForwarding } from '@/lib/monaco-shortcut-forwarding';
import { useCustomizationStore } from '@/stores/customization.store';

import { isMediaFile } from '../../../../shared/image-utils';

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
const INITIAL_LOADING_WIDTHS = [92, 74, 88, 67, 96, 71, 84, 78];
const FILE_LOADING_WIDTHS = [58, 91, 44, 76, 63, 97, 52, 83, 69, 89, 47, 72];

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
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-64 space-y-3">
          {INITIAL_LOADING_WIDTHS.map((width) => (
            <div
              key={width}
              className="h-4 animate-pulse rounded bg-muted"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      </div>
    );
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
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-lg space-y-3 px-8">
          {FILE_LOADING_WIDTHS.map((width) => (
            <div
              key={width}
              className="h-3.5 animate-pulse rounded bg-muted"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      </div>
    );
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
  hideUnchangedRegions: boolean;
  prevEditorKeyRef: React.MutableRefObject<string | null>;
  editorReadyRef: React.MutableRefObject<boolean>;
  diffContainerRef: React.RefObject<HTMLDivElement | null>;
  backdropRef: React.RefObject<HTMLDivElement | null>;
}) {
  const {
    editorInstanceKey,
    hideUnchangedRegions,
    prevEditorKeyRef,
    editorReadyRef,
    diffContainerRef,
    backdropRef,
  } = params;

  if (prevEditorKeyRef.current === editorInstanceKey) return;

  const isFirstRender = prevEditorKeyRef.current === null;
  prevEditorKeyRef.current = editorInstanceKey;

  if (!hideUnchangedRegions || isFirstRender) return;

  // Only snapshot if the live editor is ready — on rapid switches, keep the existing backdrop.
  if (editorReadyRef.current && diffContainerRef.current && backdropRef.current) {
    backdropRef.current.innerHTML = diffContainerRef.current.innerHTML;
  }
  editorReadyRef.current = false;
  if (diffContainerRef.current) {
    diffContainerRef.current.style.visibility = 'hidden';
  }
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

  // When hideUnchangedRegions is enabled and the editor remounts (file switch),
  // the new editor briefly shows the full file before Monaco collapses regions.
  // To avoid this flash, we snapshot the old editor's DOM into a backdrop div,
  // render the new editor invisibly on top, then remove the backdrop once the
  // diff computation completes and regions are collapsed.
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const prevEditorKeyRef = useRef<string | null>(null);
  const editorReadyRef = useRef(true);
  const editorTheme = useKomlaEditorTheme();
  const monacoThemeName = useMonacoThemeName();
  const fontSize = useCustomizationStore((state) =>
    editorFontSize(state.terminalConfig?.font.size)
  );

  const handleEditorMount = useCallback(
    (editor: monacoEditor.IStandaloneDiffEditor) => {
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

      // Reveal after the first diff computation completes (regions are collapsed)
      const diffDisposable = editor.onDidUpdateDiff(() => {
        editorReadyRef.current = true;
        if (diffContainerRef.current) {
          diffContainerRef.current.style.visibility = 'visible';
        }
        if (backdropRef.current) {
          backdropRef.current.innerHTML = '';
        }
        diffDisposable.dispose();
      });
      editor.onDidDispose(() => diffDisposable.dispose());

      onEditorMount?.(editor);
    },
    [viewMode, onEditorMount]
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

  const oldContent = fileContent.oldContent || '';
  const newContent = fileContent.newContent || '';
  const lineCount = Math.max(oldContent.split('\n').length, newContent.split('\n').length);
  const lineNumbersMinChars = Math.max(viewMode === 'split' ? 2 : 1, String(lineCount).length);

  if (hasContentChanged(prevContentRef.current, oldContent, newContent)) {
    prevContentRef.current = { old: oldContent, new: newContent };
    contentVersionRef.current++;
  }
  if (!isDirty) {
    cleanContentVersionRef.current = contentVersionRef.current;
  }

  const monacoLanguage = getFileLanguage(fileContent.path);
  const editorLanguage =
    monacoLanguage === 'plaintext'
      ? monacoLanguage
      : getShikiLanguage(fileContent.path, monacoLanguage);
  const isDeleted = fileContent.status === 'deleted';
  const editorInstanceKey = buildDiffEditorKey({
    selectedFile,
    filePath: fileContent.path,
    viewMode,
    hideUnchangedRegions,
    contentVersion: cleanContentVersionRef.current,
  });

  // When the editor key changes, snapshot the current editor DOM into the backdrop
  // and hide the new editor until its diff is ready.
  syncBackdropSnapshot({
    editorInstanceKey,
    hideUnchangedRegions,
    prevEditorKeyRef,
    editorReadyRef,
    diffContainerRef,
    backdropRef,
  });

  return (
    <div className="relative min-h-0 flex-1" style={{ backgroundColor: editorTheme.bg }}>
      {/* Backdrop: holds a static snapshot of the previous editor while the new one loads */}
      <div ref={backdropRef} className="pointer-events-none absolute inset-0" />
      {/* Live editor container — hidden until diff regions collapse */}
      <div ref={diffContainerRef} className="flex h-full flex-col">
        <DiffEditor
          key={editorInstanceKey}
          height="100%"
          original={oldContent}
          modified={newContent}
          language={editorLanguage}
          theme={monacoThemeName}
          loading={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Initializing editor&hellip;
            </div>
          }
          onMount={handleEditorMount}
          options={{
            ...KOMLA_EDITOR_BASE_OPTIONS,
            fontSize,
            // Hide the regular vertical scrollbar; the fat diff overview ruler
            // is itself interactive (click/drag to scroll) and serves as the
            // sole scroll indicator in diff mode.
            scrollbar: {
              ...KOMLA_EDITOR_BASE_OPTIONS.scrollbar,
              vertical: 'hidden',
            },
            readOnly: readOnly || isDeleted,
            originalEditable: false,
            renderSideBySide: viewMode === 'split',
            scrollBeyondLastLine: false,
            minimap: { enabled: false },
            wordWrap: 'on',
            lineNumbers: 'on',
            lineNumbersMinChars,
            lineDecorationsWidth: viewMode === 'split' ? 10 : 8,
            glyphMargin: viewMode === 'split',
            automaticLayout: true,
            renderOverviewRuler: true,
            overviewRulerBorder: false,
            overviewRulerLanes: 1,
            renderIndicators: false,
            padding: { top: 16, bottom: 12 },
            renderValidationDecorations: hasBuiltInLanguageIntelligence(monacoLanguage)
              ? 'on'
              : 'off',
            renderMarginRevertIcon: viewMode === 'split',

            // Hide unchanged regions to focus on changes
            hideUnchangedRegions: {
              enabled: hideUnchangedRegions,
              revealLineCount: 2, // Lines to show around changes
              minimumLineCount: 3, // Min unchanged lines before collapsing
              contextLineCount: 2, // Context when expanded
            },

            // Auto-switch to unified view when editor is narrow
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: inlineBreakpointPx,

            // Sticky scroll for context (shows function/class headers)
            stickyScroll: {
              enabled: true,
              maxLineCount: 3,
            },

            // Experimental moved code detection
            experimental: {
              showMoves: true,
            },
          }}
        />
      </div>
    </div>
  );
}
