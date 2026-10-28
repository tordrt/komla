import {
  SidebarSimple,
  CaretUp,
  CaretDown,
  ArrowLeft,
  ArrowsInSimple,
  ArrowsOutSimple,
  Folder,
  GitDiff,
  X,
} from '@phosphor-icons/react';

import { useTopRowStyle } from '@/components/layout/title-bar-metrics';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';

import { BranchCompareSelect } from './BranchCompareSelect';
import { CommitComposer } from './CommitComposer';
import { DiffStatsPills } from './DiffStatsPills';
import { getSidebarToggleShortcutLabel } from './file-viewer-keyboard';
import { getFileName, getSameNameFolderHints } from './file-viewer-utils';

import type { FileViewerMode, ViewMode } from './types';
import type { FileChange, CommitDiff, BranchInfo } from '@/types';
import type { ReactNode } from 'react';

interface HideUnchangedToggleProps {
  hideUnchangedRegions: boolean;
  onToggle: () => void;
}

function HideUnchangedToggle({ hideUnchangedRegions, onToggle }: HideUnchangedToggleProps) {
  return (
    <IconButton
      label={hideUnchangedRegions ? 'Show whole file' : 'Show only changes'}
      variant={hideUnchangedRegions ? 'secondary' : 'ghost'}
      onClick={onToggle}
    >
      {hideUnchangedRegions ? (
        <ArrowsInSimple className="size-3.5" />
      ) : (
        <ArrowsOutSimple className="size-3.5" />
      )}
    </IconButton>
  );
}

interface ViewModeToggleProps {
  viewMode: ViewMode;
  splitViewAvailable: boolean;
  onViewModeChange: (mode: ViewMode) => void;
}

function ViewModeToggle({ viewMode, splitViewAvailable, onViewModeChange }: ViewModeToggleProps) {
  return (
    <SegmentedControl
      aria-label="Diff layout"
      value={viewMode}
      onValueChange={onViewModeChange}
      options={[
        {
          value: 'split',
          label: 'Split',
          disabled: !splitViewAvailable,
          title: splitViewAvailable
            ? 'Old and new side by side (1)'
            : 'Added and deleted files have only one side',
        },
        { value: 'unified', label: 'Unified', title: 'Old and new in one column (2)' },
      ]}
    />
  );
}

interface ChangeNavButtonsProps {
  totalChanges: number;
  /** Index of the focused change, or -1 before the user has moved between changes. */
  currentChangeIndex: number;
  goToPreviousChange: () => void;
  goToNextChange: () => void;
}

function ChangeNavButtons({
  totalChanges,
  currentChangeIndex,
  goToPreviousChange,
  goToNextChange,
}: ChangeNavButtonsProps) {
  const position = currentChangeIndex >= 0 ? currentChangeIndex + 1 : null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {totalChanges > 0 && (
        <span className="min-w-[3.5ch] text-right text-2xs text-muted-foreground tabular-nums">
          <span aria-hidden="true">
            {position ?? '–'} / {totalChanges}
          </span>
          <span className="sr-only">
            {position === null
              ? `${totalChanges} ${totalChanges === 1 ? 'change' : 'changes'}`
              : `Change ${position} of ${totalChanges}`}
          </span>
        </span>
      )}
      <IconButton
        label="Previous change"
        shortcut="[ or p"
        size="xs"
        onClick={goToPreviousChange}
        disabled={totalChanges === 0}
      >
        <CaretUp className="size-3.5" />
      </IconButton>
      <IconButton
        label="Next change"
        shortcut="] or n"
        size="xs"
        onClick={goToNextChange}
        disabled={totalChanges === 0}
      >
        <CaretDown className="size-3.5" />
      </IconButton>
    </div>
  );
}

interface ModeSwitchProps {
  workspaceId: string;
  mode: FileViewerMode;
}

/** Files or Diff, as the title bar's switch picks them while the viewer is closed. */
function ModeSwitch({ workspaceId, mode }: ModeSwitchProps) {
  const requestFileViewerTransition = useFileViewerStore((s) => s.requestFileViewerTransition);
  const fileTreeShortcut = useShortcutsStore((s) => s.getDisplayShortcut('file.tree'));
  const diffToggleShortcut = useShortcutsStore((s) => s.getDisplayShortcut('diff.toggle'));
  return (
    <SegmentedControl
      aria-label="View"
      iconOnly
      value={mode}
      onValueChange={(next) => {
        // A click on the mode on screen would close the viewer.
        if (next !== mode) requestFileViewerTransition({ kind: 'toggle', workspaceId, mode: next });
      }}
      options={[
        {
          value: 'browse',
          label: 'Files',
          icon: <Folder className="size-3.5" />,
          shortcut: fileTreeShortcut,
        },
        {
          value: 'diff',
          label: 'Diff',
          icon: <GitDiff className="size-3.5" />,
          shortcut: diffToggleShortcut,
        },
      ]}
    />
  );
}

interface BrowseTabsProps {
  tabs: string[];
  previewTab: string | null;
  activeFilePath: string | null;
  isDirty: boolean;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onDoubleClickTab: (path: string) => void;
}

function BrowseTabs({
  tabs,
  previewTab,
  activeFilePath,
  isDirty,
  onSwitchTab,
  onCloseTab,
  onDoubleClickTab,
}: BrowseTabsProps) {
  if (tabs.length === 0 && !previewTab) return null;
  const folderHints = getSameNameFolderHints(previewTab ? [...tabs, previewTab] : tabs);
  const renderTabName = (tabPath: string) => {
    const hint = folderHints.get(tabPath);
    return (
      <>
        <span>{getFileName(tabPath)}</span>
        {hint && (
          <>
            {' '}
            <span className="max-w-40 truncate font-normal text-muted-foreground">— {hint}</span>
          </>
        )}
      </>
    );
  };
  return (
    <>
      {tabs.map((tabPath) => {
        const isActive = tabPath === activeFilePath;
        const hint = folderHints.get(tabPath);
        const tabLabel = `${getFileName(tabPath)}${hint ? ` — ${hint}` : ''}`;
        const tabIsDirty = isDirty && tabPath === activeFilePath;
        return (
          <div
            key={tabPath}
            className={cn(
              'flex h-full shrink-0 items-center whitespace-nowrap border-r border-border/40 text-xs font-medium transition-colors',
              isActive
                ? 'border-b-2 border-b-primary bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <button
              onClick={() => onSwitchTab(tabPath)}
              className="flex h-full items-center gap-1.5 pr-1.5 pl-3"
              title={tabPath}
            >
              {renderTabName(tabPath)}
              {tabIsDirty && (
                <span
                  role="img"
                  aria-label="Unsaved changes"
                  className="size-2 shrink-0 rounded-full bg-warning"
                />
              )}
            </button>
            <IconButton
              label={`Close ${tabLabel}`}
              size="xs"
              className="mr-1.5 size-5"
              onClick={() => onCloseTab(tabPath)}
            >
              <X className="size-3" />
            </IconButton>
          </div>
        );
      })}
      {previewTab && !tabs.includes(previewTab) && (
        <button
          onClick={() => onSwitchTab(previewTab)}
          onDoubleClick={() => onDoubleClickTab(previewTab)}
          className={cn(
            'flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-border/40 px-3 text-xs font-medium italic transition-colors',
            previewTab === activeFilePath
              ? 'border-b-2 border-b-primary bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          )}
          title={previewTab}
        >
          {renderTabName(previewTab)}
        </button>
      )}
    </>
  );
}

interface HistoryHeaderProps {
  selectedCommitHash: string | null;
  historySelectedFile: string | null;
  commitFiles: FileChange[] | undefined;
}

function HistoryHeader({
  selectedCommitHash,
  historySelectedFile,
  commitFiles,
}: HistoryHeaderProps) {
  if (!selectedCommitHash) {
    return (
      <span className="px-3 text-xs text-muted-foreground">Select a commit to view changes</span>
    );
  }
  const file = historySelectedFile
    ? commitFiles?.find((f) => f.path === historySelectedFile)
    : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate px-3 font-mono text-ui text-muted-foreground">
      {historySelectedFile && (
        <span
          className="truncate"
          style={{ direction: 'rtl', textAlign: 'left' }}
          title={historySelectedFile}
        >
          <bdi>{historySelectedFile}</bdi>
        </span>
      )}
      {file && <DiffStatsPills additions={file.additions} deletions={file.deletions} />}
    </span>
  );
}

interface DiffHeaderProps {
  selectedFile: string | null;
  isDirty: boolean;
  hasExternalChange: boolean;
  groupedFiles: FileChange[];
  diffFilesLength: number;
  comparisonBranch: string | null;
}

function DiffHeader({
  selectedFile,
  isDirty,
  hasExternalChange,
  groupedFiles,
  diffFilesLength,
  comparisonBranch,
}: DiffHeaderProps) {
  if (!selectedFile) {
    return (
      <span className="px-3 text-xs text-muted-foreground">
        {diffFilesLength > 0
          ? 'Select a file to view changes'
          : `No differences${comparisonBranch ? ` from ${comparisonBranch}` : ''}`}
      </span>
    );
  }
  const path = selectedFile;
  const file = groupedFiles.find((f) => f.path === path);
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate px-3 font-mono text-ui text-muted-foreground">
      {isDirty && (
        <span
          role="img"
          aria-label="Unsaved changes"
          className="inline-block size-2 shrink-0 rounded-full bg-warning"
          title="Unsaved changes"
        />
      )}
      {hasExternalChange && (
        <span
          role="img"
          aria-label="Changed on disk"
          className="inline-block size-2 shrink-0 rounded-full bg-info"
          title="Changed on disk"
        />
      )}
      <span className="truncate" style={{ direction: 'rtl', textAlign: 'left' }} title={path}>
        <bdi>{path}</bdi>
      </span>
      {file && <DiffStatsPills additions={file.additions} deletions={file.deletions} />}
    </span>
  );
}

export interface FileViewerToolbarProps {
  mode: FileViewerMode;
  /** Shows the Files and Diff switch, which a folder that isn't a git worktree has no use for. */
  isGitWorkspace: boolean;
  diffSubMode: 'changes' | 'history';
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onClose: () => void;
  /** At the right end of the row, before the window controls. */
  trailing?: ReactNode;
  /** Linux's window controls, which stay when the row is too narrow for everything else. */
  windowControls?: ReactNode;
  // Browse tabs
  browseTabs: BrowseTabsProps;
  // Diff header data
  selectedFile: string | null;
  isDirty: boolean;
  hasExternalChange: boolean;
  groupedFiles: FileChange[];
  diffFilesLength: number;
  comparisonBranch: string | null;
  // History header data
  selectedCommitHash: string | null;
  commitDiff: CommitDiff | null;
  historySelectedFile: string | null;
  // Branch controls
  useMergeBase: boolean;
  availableBranches: BranchInfo[];
  loadingBranches: boolean;
  comparisonLoading: boolean;
  onBranchChange: (branch: string | null) => void;
  onLoadBranches: () => Promise<void>;
  onFetchBranches?: () => Promise<void>;
  /** Compare with everything since the target branch (merge-base). */
  onCompareSinceTarget: () => void;
  targetBranch: string;
  workingDirectory: string;
  workspaceId: string;
  isRemoteWorkspace: boolean;
  onCommitted: () => Promise<void> | void;
  // Hide unchanged
  hideUnchangedRegions: boolean;
  onToggleHideUnchanged: () => void;
  // Split/unified layout
  viewMode: ViewMode;
  splitViewAvailable: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  // Change nav
  totalChanges: number;
  currentChangeIndex: number;
  goToPreviousChange: () => void;
  goToNextChange: () => void;
}

export function FileViewerToolbar(props: FileViewerToolbarProps) {
  const {
    mode,
    isGitWorkspace,
    diffSubMode,
    sidebarOpen,
    onToggleSidebar,
    onClose,
    trailing,
    windowControls,
    browseTabs,
    selectedFile,
    isDirty,
    hasExternalChange,
    groupedFiles,
    diffFilesLength,
    comparisonBranch,
    selectedCommitHash,
    commitDiff,
    historySelectedFile,
    useMergeBase,
    availableBranches,
    loadingBranches,
    comparisonLoading,
    onBranchChange,
    onLoadBranches,
    onFetchBranches,
    onCompareSinceTarget,
    targetBranch,
    workingDirectory,
    workspaceId,
    isRemoteWorkspace,
    onCommitted,
    hideUnchangedRegions,
    onToggleHideUnchanged,
    viewMode,
    splitViewAvailable,
    onViewModeChange,
    totalChanges,
    currentChangeIndex,
    goToPreviousChange,
    goToNextChange,
  } = props;
  const topRowStyle = useTopRowStyle();

  const diffViewControls = (
    <>
      <div className="mx-1 h-4 w-px bg-border" />
      <ViewModeToggle
        viewMode={viewMode}
        splitViewAvailable={splitViewAvailable}
        onViewModeChange={onViewModeChange}
      />
      <HideUnchangedToggle
        hideUnchangedRegions={hideUnchangedRegions}
        onToggle={onToggleHideUnchanged}
      />
      <ChangeNavButtons
        totalChanges={totalChanges}
        currentChangeIndex={currentChangeIndex}
        goToPreviousChange={goToPreviousChange}
        goToNextChange={goToNextChange}
      />
    </>
  );

  return (
    // The viewer covers the window, title bar included, so this is its top row: draggable, beside
    // the window controls.
    <div
      className="drag-region @container flex shrink-0 items-center border-b bg-card text-sm"
      style={topRowStyle}
    >
      <div className="flex shrink-0 items-center gap-1 px-1.5">
        {/* Back, not a close X: on Linux the window's own close X sits at the right. */}
        <IconButton label="Back" shortcut="Esc" onClick={onClose}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton
          label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          shortcut={getSidebarToggleShortcutLabel()}
          onClick={onToggleSidebar}
        >
          <SidebarSimple className="size-4" />
        </IconButton>
        {isGitWorkspace && <ModeSwitch workspaceId={workspaceId} mode={mode} />}
      </div>

      <div className="h-4 w-px shrink-0 bg-border" />

      {/* Not draggable, so its scrollbar scrolls and its paths show their titles; the space
          after them still moves the window. */}
      <div className="no-drag flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden">
        {mode === 'browse' && <BrowseTabs {...browseTabs} />}
        {mode === 'diff' && diffSubMode === 'history' && (
          <HistoryHeader
            selectedCommitHash={selectedCommitHash}
            historySelectedFile={historySelectedFile}
            commitFiles={commitDiff?.files}
          />
        )}
        {mode === 'diff' && diffSubMode !== 'history' && (
          <DiffHeader
            selectedFile={selectedFile}
            isDirty={isDirty}
            hasExternalChange={hasExternalChange}
            groupedFiles={groupedFiles}
            diffFilesLength={diffFilesLength}
            comparisonBranch={comparisonBranch}
          />
        )}
        <div className="drag-region h-full min-w-0 flex-1" />
      </div>

      {/* Clipped, rather than pushing the window controls out, in a very narrow window. */}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden px-3">
        {mode === 'diff' && diffSubMode === 'changes' && (
          <>
            {!comparisonBranch && !useMergeBase && (
              <CommitComposer
                key={workspaceId}
                workspaceId={workspaceId}
                workingDirectory={workingDirectory}
                isRemoteWorkspace={isRemoteWorkspace}
                disabled={diffFilesLength === 0}
                onCommitted={onCommitted}
              />
            )}
            <BranchCompareSelect
              value={comparisonBranch}
              useMergeBase={useMergeBase}
              targetBranch={targetBranch}
              branches={availableBranches}
              loading={loadingBranches}
              disabled={comparisonLoading}
              onBranchChange={onBranchChange}
              onCompareSinceTarget={onCompareSinceTarget}
              onLoadBranches={onLoadBranches}
              onFetchBranches={onFetchBranches}
            />
            {diffViewControls}
          </>
        )}
        {mode === 'diff' && diffSubMode === 'history' && selectedCommitHash && diffViewControls}

        {trailing}
      </div>
      {windowControls}
    </div>
  );
}
