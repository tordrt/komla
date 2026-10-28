import { LinuxWindowControlsEnd } from '@/components/layout/LinuxWindowControls';
import { WorkspaceBranchControls } from '@/components/layout/TabRowBranchControls';
import { SetupActivityIndicator } from '@/components/workspaces/SetupActivityPanel';
import { hasUnsavedFilePane } from '@/lib/pane-surfaces';
import { cn } from '@/lib/utils';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isBrowserPreviewableFile, isPdfFile } from '../../../../shared/image-utils';

import { CommitDetailsPanel } from './CommitDetailsPanel';
import { ContentArea } from './ContentArea';
import { FileViewerSidebar } from './FileViewerSidebar';
import { FileViewerToolbar } from './FileViewerToolbar';

import type { CommitHistorySidebarProps } from './CommitHistorySidebar';
import type { MarkdownEditorHandle } from './markdown/RichMarkdownEditor';
import type { FileTreeItem } from './types';
import type { useBlameState } from './useBlameState';
import type { useFileViewerState } from './useFileViewerState';
import type { FileChange, BlameHunk, Workspace } from '@/types';
import type { editor as monacoEditor } from 'monaco-editor';

type State = ReturnType<typeof useFileViewerState>;
type BlameState = ReturnType<typeof useBlameState>;

interface FileViewerMainPaneProps {
  workspace: Workspace;
  isGitWorkspace: boolean;
  isRemoteWorkspace: boolean;
  state: State;
  blame: BlameState;
  diffSubMode: 'changes' | 'history';
  // Sidebar
  sidebarOpen: boolean;
  sidebarWidth: number;
  isResizingSidebar: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
  setSidebarOpen: (updater: (prev: boolean) => boolean) => void;
  sidebarCurrentFile: string | null;
  focusAlignmentSignal?: number;
  changedFiles: FileTreeItem[];
  diffFileStatuses: Map<string, FileChange['status']> | undefined;
  liveFollow: boolean;
  copiedPath: string | null;
  targetBranch: string;
  // The history sidebar's "exit history" toggle reloads Monaco with different
  // content (changes view diff vs commit-based diff) — route it through the
  // dialog so it can prompt before silently dropping dirty edits.
  onExitHistory: () => void;
  // Sidebar handlers
  handleSidebarFileClick: (path: string) => void;
  handleFileDoubleClick: (path: string) => void;
  handleDeleteFile: (path: string, isDirectory?: boolean) => void;
  handleRestoreFile: (path: string, status: FileChange['status']) => void;
  handleRenameComplete: (src: string, dest: string, isFolder: boolean) => Promise<boolean>;
  handleCreateFile: (parentDir: string) => void;
  handleCreateDirectory: (parentDir: string) => void;
  handleMoveNodes: (sourcePaths: string[], targetDir: string) => Promise<boolean>;
  handleAddToGitignore: (path: string, isDirectory: boolean) => Promise<void>;
  handleRollbackAll: () => void;
  handleCopyNode: (path: string, isDirectory: boolean) => void;
  handleCutNode: (path: string, isDirectory: boolean) => void;
  handlePasteInto: (targetDir: string) => Promise<void>;
  handleToggleLiveFollow: () => void;
  handleShowFileHistory: (path: string) => void;
  handleOpenInBrowserPreview: (path: string) => void;
  // Toolbar
  tabs: string[];
  previewTab: string | null;
  handleSwitchTab: (path: string) => void;
  handleCloseTab: (path: string) => void;
  totalChanges: number;
  currentChangeIndex: number;
  goToPreviousChange: () => void;
  goToNextChange: () => void;
  onClose: () => void;
  // Editor
  isMonacoReady: boolean;
  monacoLoadError: string | null;
  handleEditorChange: (content: string) => void;
  handleEditorMount: (editor: monacoEditor.IStandaloneCodeEditor) => void;
  handleMarkdownEditorMount: (handle: MarkdownEditorHandle | null) => void;
  handleDiffEditorMount: (editor: monacoEditor.IStandaloneDiffEditor) => void;
  handleBlameHunkClick: (hunk: BlameHunk) => void;
}

export function selectContentAreaProps(params: {
  state: State;
  isHistory: boolean;
  isMonacoReady: boolean;
  monacoLoadError: string | null;
}) {
  const { state, isHistory, isMonacoReady, monacoLoadError } = params;
  return {
    diffContent: isHistory ? state.diff.historyFileContent : state.diff.fileContent,
    viewMode: isHistory ? state.diff.historyViewMode : state.diff.viewMode,
    selectedFile: isHistory ? state.diff.historySelectedFile : state.diff.selectedFile,
    diffLoading: isHistory
      ? state.diff.loadingCommitDiff || !isMonacoReady
      : state.diff.loading || !isMonacoReady,
    diffLoadingFile: isHistory ? state.diff.historyLoadingFile : state.diff.loadingFile,
    diffError: monacoLoadError ?? (isHistory ? state.diff.historyError : state.diff.fileError),
    forceLargeFile: isHistory ? state.diff.historyForceLargeFile : state.diff.forceLargeFile,
    largeFileBlock: isHistory ? null : state.diff.largeFileBlock,
    allowWorkingTreeMediaPreview: !isHistory,
    onRetry: isHistory ? state.diff.retryHistory : state.diff.retryFile,
    onLoadLargeFile: isHistory ? state.diff.loadHistoryLargeFile : state.diff.loadLargeFile,
    hasFiles: isHistory
      ? !!state.diff.selectedCommitHash
      : (state.diff.diffData?.files.length ?? 0) > 0,
  };
}

function selectHistorySidebarProps(params: {
  workspace: Workspace;
  diff: State['diff'];
  targetBranch: string;
  onExitHistory: () => void;
  onShowFileHistory: ((path: string) => void) | undefined;
}): CommitHistorySidebarProps {
  const { workspace, diff, targetBranch, onExitHistory, onShowFileHistory } = params;
  return {
    workspaceId: workspace.id,
    workingDirectory: workspace.workingDirectory,
    isRemoteWorkspace: workspace.backend?.kind === 'ssh',
    commits: diff.commits,
    branchRoles: diff.historyBranchRoles,
    targetBranch,
    loadingCommits: diff.loadingCommits,
    hasMoreCommits: diff.hasMoreCommits,
    selectedCommitHash: diff.selectedCommitHash,
    commitDiff: diff.commitDiff,
    loadingCommitDiff: diff.loadingCommitDiff,
    selectedFilePath: diff.historySelectedFile,
    onSelectCommit: (hash) => void diff.selectCommit(hash),
    onSelectFile: (path) => void diff.selectHistoryFile(path),
    onLoadMore: () => void diff.loadMoreCommits(),
    onToggleHistory: onExitHistory,
    filterPath: diff.historyFilterPath,
    onClearFilterPath: () => diff.setHistoryFilterPath(null),
    onShowFileHistory,
    historyBranch: diff.historyBranch,
    onBranchChange: diff.setHistoryBranch,
    availableBranches: diff.availableBranches,
    loadingBranches: diff.loadingBranches,
    onLoadBranches: diff.loadBranches,
  };
}

function selectSidebarHandlers(params: {
  isGitWorkspace: boolean;
  isBrowseMode: boolean;
  isDiffMode: boolean;
  hasComparison: boolean;
  handleRestoreFile: FileViewerMainPaneProps['handleRestoreFile'];
  handleRollbackAll: () => void;
  handleToggleLiveFollow: () => void;
  handleShowFileHistory: (path: string) => void;
  handleFileDoubleClick: (path: string) => void;
}) {
  const {
    isGitWorkspace,
    isBrowseMode,
    isDiffMode,
    hasComparison,
    handleRestoreFile,
    handleRollbackAll,
    handleToggleLiveFollow,
    handleShowFileHistory,
    handleFileDoubleClick,
  } = params;
  return {
    onRestoreFile: hasComparison ? undefined : handleRestoreFile,
    onRollbackAll: isGitWorkspace && !hasComparison ? handleRollbackAll : undefined,
    onToggleLiveFollow: isGitWorkspace && isDiffMode ? handleToggleLiveFollow : undefined,
    onShowFileHistory: isGitWorkspace ? handleShowFileHistory : undefined,
    onFileDoubleClick: isBrowseMode ? handleFileDoubleClick : undefined,
  };
}

/**
 * The branch menus and Open in editor, which the status bar under the viewer holds otherwise, and
 * the setup progress the tab row holds. They act on the selected workspace, so they show only
 * while that's the viewer's, and they give way to the diff's controls in a narrow window.
 */
function BranchMenus({ workspace, inDiff }: { workspace: Workspace; inDiff: boolean }) {
  const isSelected = useWorkspacesStore((s) => s.selectedWorkspaceId === workspace.id);
  if (!isSelected) return null;
  return (
    <div className={cn('flex shrink-0 items-center', inDiff && '@max-6xl:hidden')}>
      <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <SetupActivityIndicator key={workspace.id} workspace={workspace} />
      <WorkspaceBranchControls />
    </div>
  );
}

export function FileViewerMainPane(props: FileViewerMainPaneProps) {
  const {
    workspace,
    isGitWorkspace,
    isRemoteWorkspace,
    state,
    blame,
    diffSubMode,
    sidebarOpen,
    sidebarWidth,
    isResizingSidebar,
    onResizeStart,
    setSidebarOpen,
    sidebarCurrentFile,
    focusAlignmentSignal,
    changedFiles,
    diffFileStatuses,
    liveFollow,
    copiedPath,
    targetBranch,
    onExitHistory,
    handleSidebarFileClick,
    handleFileDoubleClick,
    handleDeleteFile,
    handleRestoreFile,
    handleRenameComplete,
    handleCreateFile,
    handleCreateDirectory,
    handleMoveNodes,
    handleAddToGitignore,
    handleRollbackAll,
    handleCopyNode,
    handleCutNode,
    handlePasteInto,
    handleToggleLiveFollow,
    handleShowFileHistory,
    handleOpenInBrowserPreview,
    tabs,
    previewTab,
    handleSwitchTab,
    handleCloseTab,
    totalChanges,
    currentChangeIndex,
    goToPreviousChange,
    goToNextChange,
    onClose,
    isMonacoReady,
    monacoLoadError,
    handleEditorChange,
    handleEditorMount,
    handleMarkdownEditorMount,
    handleDiffEditorMount,
    handleBlameHunkClick,
  } = props;

  const isDiffMode = state.mode === 'diff';
  const isBrowseMode = state.mode === 'browse';
  const isHistory = diffSubMode === 'history';
  const hasComparison = !!state.diff.comparisonBranch;
  // A file pane with unsaved edits to the file keeps this copy from editing it too.
  const editedInFilePane = usePaneSurfacesStore((s) =>
    hasUnsavedFilePane(s.surfaces, workspace.id, state.editor.filePath)
  );

  const sidebarHandlers = selectSidebarHandlers({
    isGitWorkspace,
    isBrowseMode,
    isDiffMode,
    hasComparison,
    handleRestoreFile,
    handleRollbackAll,
    handleToggleLiveFollow,
    handleShowFileHistory,
    handleFileDoubleClick,
  });
  const { onRestoreFile, onRollbackAll, onToggleLiveFollow, onShowFileHistory, onFileDoubleClick } =
    sidebarHandlers;

  const contentAreaProps = selectContentAreaProps({
    state,
    isHistory,
    isMonacoReady,
    monacoLoadError,
  });

  // Diff-mode browser toggle: only surface for directly renderable files the diff
  // doesn't delete (deleted files have nothing to render). A history diff renders
  // the commit's text, which a PDF doesn't have.
  const diffBrowserPreviewFilePath = (() => {
    if (!isDiffMode) return null;
    const path = isHistory ? state.diff.historySelectedFile : state.diff.selectedFile;
    if (!path || !isBrowserPreviewableFile(path) || (isHistory && isPdfFile(path))) return null;
    const files = isHistory ? state.diff.commitDiff?.files : state.diff.grouped.files;
    const fileChange = files?.find((f) => f.path === path);
    if (!fileChange || fileChange.status === 'deleted') return null;
    return path;
  })();

  return (
    <>
      <FileViewerToolbar
        mode={state.mode}
        isGitWorkspace={isGitWorkspace}
        diffSubMode={diffSubMode}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        onClose={onClose}
        trailing={<BranchMenus workspace={workspace} inDiff={isDiffMode} />}
        windowControls={<LinuxWindowControlsEnd />}
        browseTabs={{
          tabs,
          previewTab,
          activeFilePath: state.editor.filePath,
          isDirty: state.editor.isDirty,
          onSwitchTab: handleSwitchTab,
          onCloseTab: handleCloseTab,
          onDoubleClickTab: handleFileDoubleClick,
        }}
        selectedFile={state.diff.selectedFile}
        isDirty={state.editor.isDirty}
        hasExternalChange={state.editor.hasExternalChange}
        groupedFiles={state.diff.grouped.files}
        diffFilesLength={state.diff.diffData?.files.length ?? 0}
        comparisonBranch={state.diff.comparisonBranch}
        selectedCommitHash={state.diff.selectedCommitHash}
        commitDiff={state.diff.commitDiff}
        historySelectedFile={state.diff.historySelectedFile}
        useMergeBase={state.diff.useMergeBase}
        availableBranches={state.diff.availableBranches}
        loadingBranches={state.diff.loadingBranches}
        comparisonLoading={state.diff.comparisonLoading}
        onBranchChange={(branch) => state.diff.setComparisonBranch(branch, false)}
        onLoadBranches={state.diff.loadBranches}
        onFetchBranches={state.diff.fetchBranches}
        onCompareSinceTarget={() => void state.diff.setComparisonBranch(targetBranch, true)}
        workingDirectory={workspace.workingDirectory}
        workspaceId={workspace.id}
        isRemoteWorkspace={isRemoteWorkspace}
        onCommitted={async () => {
          await state.diff.refresh();
        }}
        targetBranch={targetBranch}
        hideUnchangedRegions={state.diff.hideUnchangedRegions}
        onToggleHideUnchanged={() =>
          state.diff.setHideUnchangedRegions(!state.diff.hideUnchangedRegions)
        }
        viewMode={contentAreaProps.viewMode}
        splitViewAvailable={
          isHistory ? state.diff.historySplitViewAvailable : state.diff.splitViewAvailable
        }
        onViewModeChange={state.diff.setViewMode}
        totalChanges={totalChanges}
        currentChangeIndex={currentChangeIndex}
        goToPreviousChange={goToPreviousChange}
        goToNextChange={goToNextChange}
      />

      {state.diff.error && isDiffMode && (
        <div className="border-b bg-error/10 p-3 text-sm text-error">{state.diff.error}</div>
      )}

      {state.editor.error && isBrowseMode && (
        <div className="border-b bg-error/10 p-3 text-sm text-error">{state.editor.error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <FileViewerSidebar
            width={sidebarWidth}
            isResizing={isResizingSidebar}
            onResizeStart={onResizeStart}
            mode={state.mode}
            isGitWorkspace={isGitWorkspace}
            isRemoteWorkspace={isRemoteWorkspace}
            diffSubMode={diffSubMode}
            historySidebar={selectHistorySidebarProps({
              workspace,
              diff: state.diff,
              targetBranch,
              onExitHistory,
              onShowFileHistory,
            })}
            workspaceId={workspace.id}
            workingDirectory={workspace.workingDirectory}
            currentFile={sidebarCurrentFile}
            focusAlignmentSignal={focusAlignmentSignal}
            onFileSelect={handleSidebarFileClick}
            onFileDoubleClick={onFileDoubleClick}
            onDeleteFile={handleDeleteFile}
            onRestoreFile={onRestoreFile}
            onRenameComplete={handleRenameComplete}
            onCreateFile={handleCreateFile}
            onCreateDirectory={handleCreateDirectory}
            onMoveNodes={handleMoveNodes}
            onAddToGitignore={handleAddToGitignore}
            onRollbackAll={onRollbackAll}
            onCopyNode={handleCopyNode}
            onCutNode={handleCutNode}
            onPasteInto={handlePasteInto}
            hasCopiedFile={copiedPath !== null}
            changedFiles={changedFiles}
            diffFileStatuses={diffFileStatuses}
            diffSummary={state.diff.diffData?.summary}
            comparisonBranch={state.diff.comparisonBranch}
            useMergeBase={state.diff.useMergeBase}
            liveFollow={liveFollow}
            onToggleLiveFollow={onToggleLiveFollow}
            onShowFileHistory={onShowFileHistory}
            onOpenHtmlInBrowser={handleOpenInBrowserPreview}
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {isDiffMode && isHistory && state.diff.selectedCommitHash && (
            <CommitDetailsPanel
              commit={state.diff.commits.find(
                (commit) => commit.hash === state.diff.selectedCommitHash
              )}
              commitDiff={state.diff.commitDiff}
              roles={{ ...state.diff.historyBranchRoles, targetBranch }}
              onSelectCommit={(hash) => void state.diff.selectCommit(hash)}
            />
          )}

          <ContentArea
            mode={state.mode}
            workingDirectory={workspace.workingDirectory}
            workspaceId={workspace.id}
            // Browse props
            filePath={state.editor.filePath}
            fileContent={state.editor.fileContent}
            savedContent={state.editor.diskContent}
            loadingFile={
              state.editor.loadingFile ||
              (!state.editor.isBrowserPreviewable &&
                !state.editor.isUnsupportedBinary &&
                !isMonacoReady)
            }
            fileError={
              state.editor.isBrowserPreviewable || state.editor.isUnsupportedBinary
                ? state.editor.error
                : (monacoLoadError ?? state.editor.error)
            }
            missingOnDisk={state.editor.missingOnDisk && !state.editor.isDirty}
            readOnly={isBrowseMode && editedInFilePane && !state.editor.isDirty}
            onChange={handleEditorChange}
            onEditorMount={handleEditorMount}
            onMarkdownEditorMount={handleMarkdownEditorMount}
            onCloseMissing={() => {
              if (state.mode === 'browse' && state.editor.filePath) {
                handleCloseTab(state.editor.filePath);
              } else {
                onClose();
              }
            }}
            onRefreshMissingDiff={() =>
              void (isHistory ? state.diff.refreshHistory() : state.diff.refresh())
            }
            // Blame props
            blameEnabled={blame.blameEnabled && isBrowseMode}
            blameAnnotations={blame.blameAnnotations}
            blameLineMap={blame.blameLineMap}
            blameLoading={blame.blameLoading}
            onBlameHunkClick={handleBlameHunkClick}
            onBlameHide={blame.toggleBlame}
            // Image props
            browserPreviewFilePath={
              state.editor.isBrowserPreviewable ? state.editor.filePath : null
            }
            browserPreviewVersion={state.editor.diskContent}
            isImage={state.editor.isImage}
            imageData={state.editor.imageData}
            imageMimeType={state.editor.imageMimeType}
            isMedia={state.editor.isMedia}
            mediaData={state.editor.mediaData}
            mediaMimeType={state.editor.mediaMimeType}
            mediaKind={state.editor.mediaKind}
            mediaSize={state.editor.mediaSize}
            mediaPreviewLoading={state.editor.mediaPreviewLoading}
            mediaPreviewError={state.editor.mediaPreviewError}
            onLoadMediaPreview={() => void state.editor.loadMediaPreview()}
            // Diff props
            {...contentAreaProps}
            hideUnchangedRegions={state.diff.hideUnchangedRegions}
            // The toolbar's Split/Unified toggle picks the layout; only a
            // window too narrow for two columns still falls back to unified.
            inlineBreakpointPx={500}
            onDiffEditorMount={handleDiffEditorMount}
            isDirty={state.editor.isDirty}
            diffBrowserPreviewFilePath={diffBrowserPreviewFilePath}
            diffBrowserPreviewVersion={state.diff.browserPreviewVersion}
          />
        </div>
      </div>
    </>
  );
}
