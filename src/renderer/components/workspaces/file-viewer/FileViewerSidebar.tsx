import { cn } from '@/lib/utils';

import { CommitHistorySidebar, type CommitHistorySidebarProps } from './CommitHistorySidebar';
import { SidebarFileTree } from './SidebarFileTree';

import type { FileViewerMode, FileTreeItem } from './types';
import type { FileChange } from '@/types';

interface FileViewerSidebarProps {
  width: number;
  isResizing: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
  // Mode
  mode: FileViewerMode;
  isGitWorkspace: boolean;
  isRemoteWorkspace: boolean;
  diffSubMode: 'changes' | 'history';
  // History sidebar props (passthrough — only used when diffSubMode==='history')
  historySidebar: CommitHistorySidebarProps;
  // SidebarFileTree props (browse + diff changes)
  workspaceId: string;
  workingDirectory: string;
  currentFile: string | null;
  focusAlignmentSignal?: number;
  onFileSelect: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
  onDeleteFile: (path: string, isDirectory?: boolean) => void;
  onRestoreFile?: (path: string, status: FileChange['status']) => void;
  onRenameComplete: (src: string, dest: string, isFolder: boolean) => Promise<boolean>;
  onCreateFile: (parentDir: string) => void;
  onCreateDirectory: (parentDir: string) => void;
  onMoveNodes: (sourcePaths: string[], targetDir: string) => Promise<boolean>;
  onAddToGitignore: (path: string, isDirectory: boolean) => void;
  onRollbackAll?: () => void;
  onCopyNode: (path: string, isDirectory: boolean) => void;
  onCutNode: (path: string, isDirectory: boolean) => void;
  onPasteInto: (targetDir: string) => void;
  hasCopiedFile: boolean;
  changedFiles: FileTreeItem[];
  diffFileStatuses?: Map<string, FileChange['status']>;
  diffSummary?: { additions: number; deletions: number; filesChanged: number };
  comparisonBranch?: string | null;
  useMergeBase: boolean;
  liveFollow: boolean;
  onToggleLiveFollow?: () => void;
  onShowFileHistory?: (path: string) => void;
  onOpenHtmlInBrowser?: (path: string) => void;
}

// Resolve the "current file" prop for SidebarFileTree based on mode.
function resolveCurrentFile(
  mode: FileViewerMode,
  diffSelectedFile: string | null,
  editorFilePath: string | null
): string | null {
  if (mode === 'diff') {
    return diffSelectedFile || null;
  }
  return editorFilePath;
}

export function FileViewerSidebar(props: FileViewerSidebarProps) {
  const {
    width,
    isResizing,
    onResizeStart,
    mode,
    isGitWorkspace,
    isRemoteWorkspace,
    diffSubMode,
    historySidebar,
    workspaceId,
    workingDirectory,
    currentFile,
    focusAlignmentSignal,
    onFileSelect,
    onFileDoubleClick,
    onDeleteFile,
    onRestoreFile,
    onRenameComplete,
    onCreateFile,
    onCreateDirectory,
    onMoveNodes,
    onAddToGitignore,
    onRollbackAll,
    onCopyNode,
    onCutNode,
    onPasteInto,
    hasCopiedFile,
    changedFiles,
    diffFileStatuses,
    diffSummary,
    comparisonBranch,
    useMergeBase,
    liveFollow,
    onToggleLiveFollow,
    onShowFileHistory,
    onOpenHtmlInBrowser,
  } = props;

  return (
    <div className="relative flex shrink-0 flex-col border-r bg-card" style={{ width }}>
      {mode === 'diff' && isGitWorkspace && diffSubMode === 'history' ? (
        <CommitHistorySidebar {...historySidebar} />
      ) : (
        <SidebarFileTree
          workspaceId={workspaceId}
          workingDirectory={workingDirectory}
          isRemoteWorkspace={isRemoteWorkspace}
          currentFile={currentFile}
          focusAlignmentSignal={focusAlignmentSignal}
          onFileSelect={onFileSelect}
          onFileDoubleClick={onFileDoubleClick}
          onDeleteFile={onDeleteFile}
          onRestoreFile={onRestoreFile}
          onRenameComplete={onRenameComplete}
          onCreateFile={onCreateFile}
          onCreateDirectory={onCreateDirectory}
          onMoveNodes={onMoveNodes}
          onAddToGitignore={onAddToGitignore}
          onRollbackAll={onRollbackAll}
          onCopyNode={onCopyNode}
          onCutNode={onCutNode}
          onPasteInto={onPasteInto}
          hasCopiedFile={hasCopiedFile}
          changedFilesOnly={mode === 'diff'}
          changedFiles={changedFiles}
          diffFileStatuses={mode === 'diff' ? diffFileStatuses : undefined}
          diffSummary={diffSummary}
          comparisonBranch={comparisonBranch}
          useMergeBase={useMergeBase}
          liveFollow={liveFollow}
          onToggleLiveFollow={onToggleLiveFollow}
          onShowFileHistory={onShowFileHistory}
          onOpenHtmlInBrowser={onOpenHtmlInBrowser}
          autoFocus
          embedded
        />
      )}
      <div
        className={cn(
          'absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isResizing ? 'bg-primary' : 'hover:bg-primary/50'
        )}
        onMouseDown={onResizeStart}
      />
    </div>
  );
}

export { resolveCurrentFile };
