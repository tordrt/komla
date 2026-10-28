import { Code, GitDiff, Globe, WarningCircle } from '@phosphor-icons/react';
import React, { Suspense, useEffect, useReducer, useSyncExternalStore } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';

import { isPdfFile, isUnsupportedBinaryFile } from '../../../../shared/image-utils';

import { BrowserPreviewFrame } from './BrowserPreviewFrame';
import {
  getHtmlDiffViewMode,
  getHtmlViewMode,
  setHtmlDiffViewMode,
  setHtmlViewMode,
  subscribeHtmlViewMode,
} from './html-view-mode';
import { ImagePane } from './ImagePane';
import { isMarkdownFile } from './markdown/markdown-view-mode';
import { MarkdownContentArea } from './markdown/MarkdownContentArea';
import { MediaPane } from './MediaPane';

import type { HtmlDiffViewMode, HtmlViewMode } from './html-view-mode';
import type { MarkdownEditorHandle } from './markdown/RichMarkdownEditor';
import type { FileViewerMode, ViewMode } from './types';
import type { BlameLineMap } from './useBlameState';
import type { FileDiffContent, BlameHunk } from '@/types';
import type { editor as monacoEditor } from 'monaco-editor';

const EditorPane = React.lazy(() =>
  import('./EditorPane').then((m) => ({ default: m.EditorPane }))
);
const DiffPane = React.lazy(() => import('./DiffPane').then((m) => ({ default: m.DiffPane })));

const HTML_VIEW_MODE_OPTIONS = [
  { value: 'browser', label: 'Browser', icon: <Globe className="size-3.5" /> },
  { value: 'source', label: 'Source', icon: <Code className="size-3.5" /> },
] as const;

const HTML_DIFF_VIEW_MODE_OPTIONS = [
  { value: 'browser', label: 'Browser', icon: <Globe className="size-3.5" /> },
  { value: 'diff', label: 'Diff', icon: <GitDiff className="size-3.5" /> },
] as const;

const editorFallback = (
  <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
    <Spinner size="lg" className="size-5" />
    <span className="text-sm">Loading editor&hellip;</span>
  </div>
);

interface ContentAreaProps {
  mode: FileViewerMode;
  workingDirectory: string;
  /** Reads images a Markdown file shows through the workspace, local or remote. */
  workspaceId?: string;
  // For browse mode
  filePath: string | null;
  fileContent: string | null;
  /** The file's text as last loaded or saved. */
  savedContent?: string | null;
  loadingFile: boolean;
  fileError: string | null;
  missingOnDisk?: boolean;
  onChange?: (content: string) => void;
  onEditorMount?: (editor: monacoEditor.IStandaloneCodeEditor) => void;
  /** The rich Markdown editor, which replaces Monaco for Markdown files; null when it goes away. */
  onMarkdownEditorMount?: (handle: MarkdownEditorHandle | null) => void;
  onCloseMissing?: () => void;
  readOnly?: boolean;
  /** Focuses the rich Markdown editor when it first shows. */
  autoFocus?: boolean;
  // Blame props (browse mode only)
  blameEnabled?: boolean;
  blameAnnotations?: BlameHunk[];
  blameLineMap?: BlameLineMap;
  blameLoading?: boolean;
  onBlameHunkClick?: (hunk: BlameHunk) => void;
  onBlameHide?: () => void;
  // Browser-renderable props (browse mode)
  browserPreviewFilePath?: string | null;
  browserPreviewVersion?: string | null;
  isImage?: boolean;
  imageData?: string | null;
  imageMimeType?: string | null;
  isMedia?: boolean;
  mediaData?: string | null;
  mediaMimeType?: string | null;
  mediaKind?: 'audio' | 'video' | null;
  mediaSize?: number | null;
  mediaPreviewLoading?: boolean;
  mediaPreviewError?: string | null;
  onLoadMediaPreview?: () => void;
  // For diff mode
  diffContent: FileDiffContent | null;
  viewMode: ViewMode;
  selectedFile: string | null;
  diffLoading: boolean;
  diffLoadingFile: boolean;
  diffError: string | null;
  forceLargeFile: boolean;
  largeFileBlock: { lines: number } | null;
  hideUnchangedRegions: boolean;
  inlineBreakpointPx?: number;
  allowWorkingTreeMediaPreview?: boolean;
  onRetry: () => void;
  onLoadLargeFile: () => void;
  onRefreshMissingDiff?: () => void;
  onDiffEditorMount?: (editor: monacoEditor.IStandaloneDiffEditor) => void;
  hasFiles?: boolean;
  isDirty?: boolean;
  // Diff-mode browser toggle: when the selected diff file can render directly and its
  // working-copy version still exists (i.e. not a deleted file), surface a
  // Diff/Browser toggle so reviewers can flip to the rendered preview.
  diffBrowserPreviewFilePath?: string | null;
  diffBrowserPreviewVersion?: string | null;
}

type BrowserPreviewState = {
  filePath: string | null;
  url: string | null;
  loading: boolean;
  error: string | null;
};

type BrowserPreviewAction =
  | { type: 'start'; filePath: string }
  | { type: 'success'; filePath: string; url: string }
  | { type: 'error'; filePath: string; error: string };

function browserPreviewReducer(
  state: BrowserPreviewState,
  action: BrowserPreviewAction
): BrowserPreviewState {
  switch (action.type) {
    case 'start':
      return { filePath: action.filePath, url: null, loading: true, error: null };
    case 'success':
      if (state.filePath !== action.filePath) return state;
      return { filePath: action.filePath, url: action.url, loading: false, error: null };
    case 'error':
      if (state.filePath !== action.filePath) return state;
      return { filePath: action.filePath, url: null, loading: false, error: action.error };
  }
}

/**
 * A preview URL for a file: of `content` when given, read from the host for an SSH file,
 * else served from the worktree.
 */
function createPreviewUrl(
  workingDirectory: string,
  workspaceId: string | undefined,
  filePath: string,
  content?: string
): Promise<string> {
  if (content === undefined && workspaceId && workingDirectory.startsWith('ssh://')) {
    return window.api.getViewerPreviewUrl(workspaceId, null, { kind: 'workspace', filePath });
  }
  return window.api.getHtmlPreviewUrl(workingDirectory, filePath, content);
}

interface BrowserPreviewContentAreaProps {
  workingDirectory: string;
  workspaceId?: string;
  filePath: string | null;
  fileContent: string | null;
  loadingFile: boolean;
  fileError: string | null;
  onChange?: (content: string) => void;
  onEditorMount?: (editor: monacoEditor.IStandaloneCodeEditor) => void;
  readOnly: boolean;
  blameEnabled?: boolean;
  blameAnnotations?: BlameHunk[];
  blameLineMap?: BlameLineMap;
  blameLoading?: boolean;
  onBlameHunkClick?: (hunk: BlameHunk) => void;
  onBlameHide?: () => void;
}

function BrowserPreviewContentArea({
  workingDirectory,
  workspaceId,
  filePath,
  fileContent,
  loadingFile,
  fileError,
  onChange,
  onEditorMount,
  readOnly,
  blameEnabled,
  blameAnnotations,
  blameLineMap,
  blameLoading,
  onBlameHunkClick,
  onBlameHide,
}: BrowserPreviewContentAreaProps) {
  const htmlViewMode = useSyncExternalStore<HtmlViewMode>(
    subscribeHtmlViewMode,
    () => getHtmlViewMode(workingDirectory),
    () => 'browser'
  );
  const sourceAvailable = !filePath || !isPdfFile(filePath);
  const effectiveViewMode = sourceAvailable ? htmlViewMode : 'browser';
  const [browserPreview, dispatchBrowserPreview] = useReducer(browserPreviewReducer, {
    filePath: null,
    url: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (effectiveViewMode !== 'browser' || !filePath) return;
    const isContentPreview =
      !isPdfFile(filePath) &&
      (workingDirectory.startsWith('ssh://') || filePath.startsWith('.komla-files/'));
    if (isContentPreview && fileContent === null) return;

    let cancelled = false;
    dispatchBrowserPreview({ type: 'start', filePath });
    createPreviewUrl(
      workingDirectory,
      workspaceId,
      filePath,
      isContentPreview ? (fileContent ?? undefined) : undefined
    )
      .then((url) => {
        if (!cancelled) dispatchBrowserPreview({ type: 'success', filePath, url });
      })
      .catch((err) => {
        if (!cancelled) {
          dispatchBrowserPreview({
            type: 'error',
            filePath,
            error: err instanceof Error ? err.message : 'Failed to create preview URL',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveViewMode, workingDirectory, workspaceId, filePath, fileContent]);

  const selectHtmlViewMode = (mode: HtmlViewMode): void => {
    setHtmlViewMode(workingDirectory, mode);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-background px-2">
        <span className="text-xs font-medium text-muted-foreground">Preview</span>
        {sourceAvailable && (
          <SegmentedControl
            aria-label="Preview mode"
            iconOnly
            value={htmlViewMode}
            onValueChange={selectHtmlViewMode}
            options={HTML_VIEW_MODE_OPTIONS}
          />
        )}
      </div>
      {effectiveViewMode === 'browser' ? (
        <BrowserPreviewPane
          filePath={filePath}
          browserUrl={browserPreview.url}
          loading={loadingFile || browserPreview.loading || browserPreview.filePath !== filePath}
          error={fileError ?? browserPreview.error}
        />
      ) : (
        <ErrorBoundary key={`browser-preview-source:${filePath}`}>
          <Suspense fallback={editorFallback}>
            <EditorPane
              filePath={filePath}
              fileContent={fileContent}
              loading={loadingFile}
              error={fileError}
              onChange={onChange}
              onMount={onEditorMount}
              readOnly={readOnly}
              blameEnabled={blameEnabled}
              blameAnnotations={blameAnnotations}
              blameLineMap={blameLineMap}
              blameLoading={blameLoading}
              onBlameHunkClick={onBlameHunkClick}
              onBlameHide={onBlameHide}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

interface BrowserPreviewDiffContentAreaProps {
  workingDirectory: string;
  workspaceId?: string;
  diffBrowserPreviewFilePath: string;
  diffBrowserPreviewVersion?: string | null;
  /**
   * The text to render instead of the working-tree file, which SSH workspaces don't have
   * here and which history diffs don't show; null until the diff loads it.
   */
  previewContent?: string | null;
  previewContentLoading?: boolean;
  diffNode: React.ReactNode;
}

function BrowserPreviewDiffContentArea({
  workingDirectory,
  workspaceId,
  diffBrowserPreviewFilePath,
  diffBrowserPreviewVersion,
  previewContent,
  previewContentLoading = false,
  diffNode,
}: BrowserPreviewDiffContentAreaProps) {
  const htmlDiffViewMode = useSyncExternalStore<HtmlDiffViewMode>(
    subscribeHtmlViewMode,
    () => getHtmlDiffViewMode(workingDirectory),
    () => 'diff'
  );
  const [browserPreview, dispatchBrowserPreview] = useReducer(browserPreviewReducer, {
    filePath: null,
    url: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (htmlDiffViewMode !== 'browser' || previewContent === null) return;

    let cancelled = false;
    dispatchBrowserPreview({ type: 'start', filePath: diffBrowserPreviewFilePath });
    createPreviewUrl(workingDirectory, workspaceId, diffBrowserPreviewFilePath, previewContent)
      .then((url) => {
        if (!cancelled) {
          dispatchBrowserPreview({ type: 'success', filePath: diffBrowserPreviewFilePath, url });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          dispatchBrowserPreview({
            type: 'error',
            filePath: diffBrowserPreviewFilePath,
            error: err instanceof Error ? err.message : 'Failed to create preview URL',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    htmlDiffViewMode,
    workingDirectory,
    workspaceId,
    diffBrowserPreviewFilePath,
    diffBrowserPreviewVersion,
    previewContent,
  ]);

  const selectHtmlDiffViewMode = (mode: HtmlDiffViewMode): void => {
    setHtmlDiffViewMode(workingDirectory, mode);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-background px-2">
        <span className="text-xs font-medium text-muted-foreground">Preview</span>
        <SegmentedControl
          aria-label="Preview mode"
          iconOnly
          value={htmlDiffViewMode}
          onValueChange={selectHtmlDiffViewMode}
          options={HTML_DIFF_VIEW_MODE_OPTIONS}
        />
      </div>
      {htmlDiffViewMode === 'browser' ? (
        <BrowserPreviewPane
          filePath={diffBrowserPreviewFilePath}
          browserUrl={browserPreview.url}
          loading={
            previewContent === null
              ? previewContentLoading
              : browserPreview.loading || browserPreview.filePath !== diffBrowserPreviewFilePath
          }
          error={previewContent === null ? 'Preview unavailable' : browserPreview.error}
        />
      ) : (
        diffNode
      )}
    </div>
  );
}

function BrowserPreviewPane({
  filePath,
  browserUrl,
  loading,
  error,
}: {
  filePath: string | null;
  browserUrl: string | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" className="mr-2 size-5" />
        Loading&hellip;
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-error">
        <WarningCircle className="size-5" />
        {error}
      </div>
    );
  }

  if (!filePath || !browserUrl) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No file selected
      </div>
    );
  }

  return <BrowserPreviewFrame filePath={filePath} url={browserUrl} />;
}

export function ContentArea({
  mode,
  workingDirectory,
  workspaceId,
  // Browse props
  filePath,
  fileContent,
  savedContent,
  loadingFile,
  fileError,
  missingOnDisk,
  onChange,
  onEditorMount,
  onMarkdownEditorMount,
  onCloseMissing,
  readOnly = false,
  autoFocus = false,
  // Blame props
  blameEnabled,
  blameAnnotations,
  blameLineMap,
  blameLoading,
  onBlameHunkClick,
  onBlameHide,
  // Image props
  browserPreviewFilePath,
  browserPreviewVersion,
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
  onLoadMediaPreview,
  // Diff props
  diffContent,
  viewMode,
  selectedFile,
  diffLoading,
  diffLoadingFile,
  diffError,
  forceLargeFile,
  largeFileBlock,
  hideUnchangedRegions,
  inlineBreakpointPx,
  allowWorkingTreeMediaPreview = true,
  onRetry,
  onLoadLargeFile,
  onRefreshMissingDiff,
  onDiffEditorMount,
  hasFiles = true,
  isDirty = false,
  diffBrowserPreviewFilePath = null,
  diffBrowserPreviewVersion = null,
}: ContentAreaProps) {
  // In browse mode, show image or editor
  if (mode === 'browse') {
    if (!missingOnDisk && filePath && isUnsupportedBinaryFile(filePath)) {
      const fullPath = `${workingDirectory.replace(/[\\/]$/, '')}/${filePath}`;
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <WarningCircle className="size-8" />
          <span>Preview unavailable for this binary file</span>
          {!workingDirectory.startsWith('ssh://') && (
            <Button variant="outline" size="sm" onClick={() => void window.api.openPath(fullPath)}>
              Open in default app
            </Button>
          )}
        </div>
      );
    }
    if (!missingOnDisk && isImage && imageData && imageMimeType) {
      return <ImagePane data={imageData} mimeType={imageMimeType} fileName={filePath || ''} />;
    }
    if (!missingOnDisk && browserPreviewFilePath) {
      return (
        <BrowserPreviewContentArea
          key={`${browserPreviewFilePath}:${browserPreviewVersion ?? ''}`}
          workingDirectory={workingDirectory}
          workspaceId={workspaceId}
          filePath={filePath}
          fileContent={fileContent}
          loadingFile={loadingFile}
          fileError={fileError}
          onChange={onChange}
          onEditorMount={onEditorMount}
          readOnly={readOnly}
          blameEnabled={blameEnabled}
          blameAnnotations={blameAnnotations}
          blameLineMap={blameLineMap}
          blameLoading={blameLoading}
          onBlameHunkClick={onBlameHunkClick}
          onBlameHide={onBlameHide}
        />
      );
    }
    if (!missingOnDisk && isMedia && mediaMimeType && mediaKind) {
      return (
        <MediaPane
          data={mediaData ?? null}
          mimeType={mediaMimeType}
          kind={mediaKind}
          fileName={filePath || ''}
          fileSize={mediaSize}
          loading={mediaPreviewLoading}
          error={mediaPreviewError}
          onLoadPreview={onLoadMediaPreview}
        />
      );
    }
    const editorPane = (
      <ErrorBoundary key={`browse:${filePath}`}>
        <Suspense fallback={editorFallback}>
          <EditorPane
            filePath={filePath}
            fileContent={fileContent}
            loading={loadingFile}
            error={fileError}
            missingOnDisk={missingOnDisk}
            onChange={onChange}
            onMount={onEditorMount}
            onCloseMissing={onCloseMissing}
            readOnly={readOnly}
            blameEnabled={blameEnabled}
            blameAnnotations={blameAnnotations}
            blameLineMap={blameLineMap}
            blameLoading={blameLoading}
            onBlameHunkClick={onBlameHunkClick}
            onBlameHide={onBlameHide}
          />
        </Suspense>
      </ErrorBoundary>
    );
    if (!missingOnDisk && filePath && isMarkdownFile(filePath)) {
      return (
        <MarkdownContentArea
          key={filePath}
          filePath={filePath}
          fileContent={fileContent}
          savedContent={savedContent}
          loadingFile={loadingFile}
          fileError={fileError}
          readOnly={readOnly}
          sourceOnly={!!blameEnabled}
          autoFocus={autoFocus}
          onChange={onChange}
          onMarkdownEditorMount={onMarkdownEditorMount}
          readImage={(path) =>
            workspaceId
              ? window.api.readWorkspaceImageFile(workspaceId, path)
              : window.api.readImageFile(workingDirectory, path)
          }
          sourceEditor={editorPane}
        />
      );
    }
    return editorPane;
  }

  // In diff mode, show diff
  const diffNode = (
    <ErrorBoundary key={`diff:${selectedFile}:${viewMode}`}>
      <Suspense fallback={editorFallback}>
        <DiffPane
          workingDirectory={workingDirectory}
          fileContent={diffContent}
          viewMode={viewMode}
          selectedFile={selectedFile}
          loading={diffLoading}
          loadingFile={diffLoadingFile}
          error={diffError}
          forceLargeFile={forceLargeFile}
          largeFileBlock={largeFileBlock}
          hideUnchangedRegions={hideUnchangedRegions}
          inlineBreakpointPx={inlineBreakpointPx}
          allowWorkingTreeMediaPreview={allowWorkingTreeMediaPreview}
          onRetry={onRetry}
          onLoadLargeFile={onLoadLargeFile}
          onCloseMissing={onCloseMissing}
          onRefreshMissing={onRefreshMissingDiff}
          onEditorMount={onDiffEditorMount}
          hasFiles={hasFiles}
          isDirty={isDirty}
          readOnly={readOnly}
        />
      </Suspense>
    </ErrorBoundary>
  );

  if (diffBrowserPreviewFilePath) {
    // SSH and history diffs render the diff's new side, which the diff already fetched. A
    // PDF has no text, so an SSH one is read from the host.
    const rendersNewSide =
      (workingDirectory.startsWith('ssh://') || !allowWorkingTreeMediaPreview) &&
      !isPdfFile(diffBrowserPreviewFilePath);
    const previewContent = rendersNewSide
      ? diffContent?.path === diffBrowserPreviewFilePath
        ? diffContent.newContent
        : null
      : undefined;
    return (
      <BrowserPreviewDiffContentArea
        key={`${diffBrowserPreviewFilePath}:${diffBrowserPreviewVersion ?? ''}`}
        workingDirectory={workingDirectory}
        workspaceId={workspaceId}
        diffBrowserPreviewFilePath={diffBrowserPreviewFilePath}
        diffBrowserPreviewVersion={diffBrowserPreviewVersion}
        previewContent={previewContent}
        previewContentLoading={diffLoading || diffLoadingFile}
        diffNode={diffNode}
      />
    );
  }

  return diffNode;
}
