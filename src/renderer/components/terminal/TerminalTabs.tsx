import {
  X,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalWindow,
  ArrowsInSimple,
  ArrowsOutSimple,
  ArrowSquareIn,
  ArrowSquareOut,
  CaretUp,
  CaretDown,
  Desktop,
  FileText,
  Globe,
  NotePencil,
  Plus,
} from '@phosphor-icons/react';
import React, {
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffectEvent,
  memo,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LinuxWindowControls } from '@/components/layout/LinuxWindowControls';
import { SidebarExpandButton } from '@/components/layout/SidebarExpandButton';
import { TabRowBranchControls } from '@/components/layout/TabRowBranchControls';
import {
  WINDOWS_CAPTION_BUTTONS_WIDTH_PX,
  titleBarHeightPx,
} from '@/components/layout/title-bar-metrics';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { ShortcutHint } from '@/components/ui/kbd';
import { KomlaBackdrop } from '@/components/ui/komla-backdrop';
import { KomlaMark } from '@/components/ui/komla-mark';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { TruncatedText } from '@/components/ui/truncated-text';
import {
  ATTENTION_CARD_CLASS_NAME,
  AttentionCard,
} from '@/components/workspaces/AttentionTooltipContent';
import { FolderDropZone } from '@/components/workspaces/FolderDropZone';
import { RecentFolders } from '@/components/workspaces/RecentFolders';
import { useAwaitingUserReturn } from '@/hooks/useAwaitingUserReturn';
import { useDiffComparison } from '@/hooks/useDiffComparison';
import { useElementWidth } from '@/hooks/useElementWidth';
import { useWindowFocused } from '@/hooks/useWindowFocused';
import { closeTerminalPane } from '@/lib/close-terminal-pane';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { findNode, getAllLeaves } from '@/lib/layout-utils';
import { UNTITLED_NOTE, useNoteTitle } from '@/lib/notes';
import { claimWindowsTitleBarOverlaySurface, useTerminalBackground } from '@/lib/palette-runtime';
import {
  getDroppedPaneId,
  isPaneDragFromPane,
  PANE_DRAG_MIME,
  setDraggedPaneId,
  TAB_PANE_DRAG_MIME,
} from '@/lib/pane-drag';
import {
  closePaneSurface,
  closingPanesStopsWorkspace,
  confirmClosingPaneSurfaces,
  confirmStoppingWorkspace,
  getPaneSurfaceTitle,
} from '@/lib/pane-surfaces';
import { useSidebarCollapsed } from '@/lib/sidebar-collapsed';
import { addTerminalForSplit } from '@/lib/split-terminal';
import { cn } from '@/lib/utils';
import {
  getTabAttentionDisplay,
  getTerminalTabLabel,
  getWorkspaceAttentionAppearance,
} from '@/lib/workspace-attention';
import { getWorkspaceHostId } from '@/lib/workspace-host';
import { isWorkspaceLayoutPlaceholder } from '@/lib/workspace-layout-hydration';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useNotesStore } from '@/stores/notes.store';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';
import { supportsLocalCopy } from '@/stores/ssh-command-execution-location.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isRunningHere, isWorkspaceAttentionActionable } from '@/types';

import {
  getPaneSurfaceKind,
  isPaneSurfaceId,
  type PaneSurfaceKind,
} from '../../../shared/lib/pane-surface-id';
import { DashboardView } from '../dashboard';
import { DiffStatsPills } from '../workspaces/file-viewer/DiffStatsPills';
import { FileTypeIcon } from '../workspaces/file-viewer/file-icon-utils';
import {
  SetupActivityNotificationCenter,
  WorkspaceSetupActivity,
} from '../workspaces/SetupActivityPanel';

import { ActionTabButton } from './ActionTabButton';
import { BrowserLinksPopover } from './BrowserLinksPopover';
import { FileTreeToggleButton } from './FileTreeToggleButton';
import { InlineFilePreviewPanel } from './InlineFilePreviewPanel';
import { InlineFileTreePanel } from './InlineFileTreePanel';
import { InlinePanelResizeHandle } from './InlinePanelResizeHandle';
import { NewTabButton } from './NewTabButton';
import {
  getPreviewLayoutAttention,
  getPreviewLayoutOptions,
  type PreviewLayoutAttention,
} from './preview-layout-options';
import { SplitContainer } from './SplitContainer';
import { TabStripScroller, type TabRoom } from './TabStripScroller';
import {
  getWorkspaceRestartAgent,
  getWorkspaceRestartDescription,
  type WorkspaceRestartAgent,
} from './workspace-restart-description';

import type { NoteSummary } from '../../../shared/types/notes';
import type { Terminal, Workspace } from '@/types';

interface TerminalTabsProps {
  onNewWorkspaceDialogChange?: (open: boolean) => void;
  /**
   * Command center and the settings menu, beside the Expand button while the sidebar that holds
   * them is collapsed.
   */
  renderCollapsedSidebarControls?: () => React.ReactNode;
}

// Stable fallbacks for store selectors; a fresh [] per call re-renders forever.
const EMPTY_TAB_IDS: string[] = [];

/**
 * On macOS the file panel's Diff and Files tabs sit in the top row, under its corner buttons. On
 * Windows and Linux the window controls share that corner, so the tabs move into the panel.
 */
function treeTabsInTopRow(): boolean {
  return window.api.platform === 'darwin';
}

/**
 * The room the top row's last header keeps at its right for the corner buttons (and window
 * controls), less what the file panel's empty stretch of the row already gives them.
 */
function topRowEndReserve(treeOpen: boolean, treeWidthPx: number, cornerWidthPx: number): number {
  if (treeOpen && treeTabsInTopRow()) return 0;
  return Math.max(0, cornerWidthPx + 8 - (treeOpen ? treeWidthPx : 0));
}

/**
 * The file panel's narrowest width. On macOS its Diff/Files tabs share the top row with the
 * corner buttons, so it never gets narrower than both together, plus a sliver so the active
 * tab's edge doesn't touch the first button.
 */
function inlineTreeMinWidthPx(treeTabsWidthPx: number, cornerWidthPx: number): number {
  if (!treeTabsInTopRow()) return INLINE_TREE_MIN_WIDTH_PX;
  return Math.max(INLINE_TREE_MIN_WIDTH_PX, Math.ceil(treeTabsWidthPx + cornerWidthPx + 4));
}

/** The tab row is the top of the window: as tall as the title bar, with room for the caption buttons. */
function topRowMetrics(): { heightPx: number; captionWidthPx: number } {
  return {
    heightPx: titleBarHeightPx(),
    captionWidthPx: window.api.platform === 'win32' ? WINDOWS_CAPTION_BUTTONS_WIDTH_PX : 0,
  };
}
const EMPTY_TERMINALS: Terminal[] = [];
const EMPTY_NOTES: NoteSummary[] = [];
// A tab marks the browsers and notes among its panes, in this order; terminals go unmarked.
const TAB_SURFACE_ICONS: { kind: PaneSurfaceKind; label: string; icon: React.ReactElement }[] = [
  { kind: 'browser', label: 'Browser', icon: <Globe className="size-3.5" /> },
  { kind: 'note', label: 'Note', icon: <NotePencil className="size-3.5" /> },
  { kind: 'file', label: 'File', icon: <FileText className="size-3.5" /> },
];

const INLINE_PREVIEW_DEFAULT_WIDTH_RATIO = 0.5;
const INLINE_TREE_DEFAULT_WIDTH_RATIO = 0.22;
const INLINE_PREVIEW_MIN_WIDTH_PX = 260;
const INLINE_PREVIEW_MAX_WIDTH_PX = 900;
// The preview header sheds metadata as its own slot narrows so the fixed
// controls, especially Close, remain reachable next to the file tree.
const INLINE_PREVIEW_HIDE_NAME_WIDTH_PX = 320;
const INLINE_TREE_MIN_WIDTH_PX = 150;
const INLINE_TREE_MAX_WIDTH_PX = 520;
const RESIZE_HANDLE_WIDTH_PX = 4;
// A tab sees its panes' notifications once it has been on screen this long, so tapping
// through workspaces doesn't clear the ones the user passed over.
const SEEN_AFTER_MS = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolvePanelWidthPx(
  containerWidth: number,
  ratio: number,
  minWidth: number,
  maxWidth: number
): number {
  if (containerWidth <= 0) return minWidth;
  return clamp(containerWidth * ratio, minWidth, maxWidth);
}

interface WorkspaceLayerProps {
  wsId: string;
  isCurrentWorkspace: boolean;
  workingDirectory: string;
  isWorktree: boolean;
  wsTabs: string[];
  wsActiveTabId: string | null;
  layoutsByTab: Record<string, Record<string, unknown>>;
  previewCloseRef: React.MutableRefObject<(() => void) | null>;
  changeNavRef: React.MutableRefObject<{ goToNext: () => void; goToPrev: () => void } | null>;
  setPreviewTotalChanges: (n: number) => void;
  contentWidth: number;
  treeMinWidthPx: number;
  isResizingPreview: boolean;
  onPreviewResizeStart: (e: React.MouseEvent, workspaceId: string) => void;
  isResizingTree: boolean;
  onTreeResizeStart: (e: React.MouseEvent, workspaceId: string) => void;
}

/** Renders a single workspace's panel layout. Memoized so each layer only re-renders for its own state changes. */
const WorkspaceLayer = memo(function WorkspaceLayer({
  wsId,
  isCurrentWorkspace,
  workingDirectory,
  isWorktree,
  wsTabs,
  wsActiveTabId,
  layoutsByTab,
  previewCloseRef,
  changeNavRef,
  setPreviewTotalChanges,
  contentWidth,
  treeMinWidthPx,
  isResizingPreview,
  onPreviewResizeStart,
  isResizingTree,
  onTreeResizeStart,
}: WorkspaceLayerProps) {
  const terminalBackground = useTerminalBackground();
  // Per-workspace store subscriptions — each layer only re-renders for its own slice
  const wsPreviewOpen = useFileViewerStore(
    (s) => s.inlineFilePreviewByWorkspace[wsId]?.open ?? false
  );
  const wsPreviewLayout = useFileViewerStore(
    (s) => s.inlineFilePreviewByWorkspace[wsId]?.layout ?? 'full'
  );
  const wsPreviewWidthRatio = useFileViewerStore(
    (s) => s.inlineFilePreviewWidthByWorkspace[wsId] ?? INLINE_PREVIEW_DEFAULT_WIDTH_RATIO
  );
  const wsFileTreeOpen = useFileViewerStore((s) => s.inlineFileTreeByWorkspace[wsId]?.open ?? true);
  const wsTreeWidthRatio = useFileViewerStore(
    (s) => s.inlineFileTreeWidthByWorkspace[wsId] ?? INLINE_TREE_DEFAULT_WIDTH_RATIO
  );
  const setInlineFilePreviewWidth = useFileViewerStore((s) => s.setInlineFilePreviewWidth);
  const setInlineFileTreeWidth = useFileViewerStore((s) => s.setInlineFileTreeWidth);

  const wsIsPreviewFullscreen = wsPreviewOpen && wsPreviewLayout === 'full';

  const wsResolvedTreeWidthPx = wsFileTreeOpen
    ? resolvePanelWidthPx(contentWidth, wsTreeWidthRatio, treeMinWidthPx, INLINE_TREE_MAX_WIDTH_PX)
    : 0;
  // Calculate preview width based on remaining space after file tree,
  // so 50% means half of the terminal+preview area, not half of everything.
  const availableForPreview = contentWidth - wsResolvedTreeWidthPx;
  const wsResolvedPreviewWidthPx =
    wsPreviewOpen && !wsIsPreviewFullscreen
      ? resolvePanelWidthPx(
          availableForPreview,
          wsPreviewWidthRatio,
          INLINE_PREVIEW_MIN_WIDTH_PX,
          INLINE_PREVIEW_MAX_WIDTH_PX
        )
      : 0;
  // Keyboard resizing bounds, matching what the drag handlers allow.
  const previewMaxWidthPx = Math.max(
    INLINE_PREVIEW_MIN_WIDTH_PX,
    Math.min(INLINE_PREVIEW_MAX_WIDTH_PX, availableForPreview - RESIZE_HANDLE_WIDTH_PX)
  );
  const treeMaxWidthPx = Math.max(
    treeMinWidthPx,
    Math.min(
      INLINE_TREE_MAX_WIDTH_PX,
      contentWidth -
        (wsResolvedPreviewWidthPx > 0 ? wsResolvedPreviewWidthPx + RESIZE_HANDLE_WIDTH_PX : 0) -
        RESIZE_HANDLE_WIDTH_PX
    )
  );

  return (
    // The terminal's color behind the file panel's rounded corners, so the panel sits on top of
    // the terminal area.
    <div
      className="absolute inset-0 flex"
      style={
        isCurrentWorkspace
          ? { visibility: 'visible' as const, backgroundColor: terminalBackground }
          : { visibility: 'hidden' as const, clipPath: 'inset(100%)' }
      }
    >
      {/* Terminal area — keeps its dimensions even when preview is fullscreen,
           so Allotment split panes don't recalculate to zero-width sizes */}
      <div className="relative min-h-0 overflow-clip" style={{ flex: 1 }}>
        {wsTabs.map((tabId) => {
          const tabLayout = layoutsByTab[wsId]?.[tabId];
          if (!tabLayout) return null;

          const isTabActive = isCurrentWorkspace && tabId === wsActiveTabId;
          return (
            <div
              key={tabId}
              className="absolute inset-0"
              // clip-path (like inactive workspaces above) lets xterm's IntersectionObserver
              // pause rendering for hidden tabs; visibility alone still counts as on-screen.
              style={
                isTabActive
                  ? { visibility: 'visible' }
                  : { visibility: 'hidden', clipPath: 'inset(100%)' }
              }
            >
              <SplitContainer tabId={tabId} isActive={isTabActive} workspaceId={wsId} />
            </div>
          );
        })}
      </div>
      {/* Preview resize handle — only when side-by-side */}
      {wsPreviewOpen && !wsIsPreviewFullscreen && (
        <InlinePanelResizeHandle
          label="Resize inline file preview"
          title="Drag to resize preview"
          widthPx={wsResolvedPreviewWidthPx}
          minWidthPx={INLINE_PREVIEW_MIN_WIDTH_PX}
          maxWidthPx={previewMaxWidthPx}
          isResizing={isResizingPreview && isCurrentWorkspace}
          onResizeStart={(e) => onPreviewResizeStart(e, wsId)}
          onResize={(widthPx) =>
            availableForPreview > 0 &&
            setInlineFilePreviewWidth(wsId, widthPx / availableForPreview)
          }
          onReset={() => setInlineFilePreviewWidth(wsId, INLINE_PREVIEW_DEFAULT_WIDTH_RATIO)}
        />
      )}
      {/* Preview panel — single instance, always mounted to preserve editor state.
           In fullscreen mode, absolutely positioned to overlay the terminal area only.
           In side-by-side mode, sized as a flex item next to the terminal.
           File preview and dev server preview share the slot; mutual exclusivity
           in the stores guarantees at most one is visible at a time. */}
      <div
        className={cn(
          'min-h-0',
          wsPreviewOpen && !wsIsPreviewFullscreen && 'shrink-0 border-l',
          wsIsPreviewFullscreen && 'bg-background'
        )}
        style={
          !wsPreviewOpen || contentWidth <= 0
            ? { width: 0, overflow: 'hidden' }
            : wsIsPreviewFullscreen
              ? {
                  position: 'absolute' as const,
                  top: 0,
                  bottom: 0,
                  left: 0,
                  right: wsFileTreeOpen ? wsResolvedTreeWidthPx + RESIZE_HANDLE_WIDTH_PX : 0,
                  zIndex: 10,
                }
              : { width: wsResolvedPreviewWidthPx, flexShrink: 0, flexGrow: 0 }
        }
      >
        <InlineFilePreviewPanel
          workspaceId={wsId}
          workingDirectory={workingDirectory}
          isGitWorkspace={isWorktree}
          isActive={isCurrentWorkspace}
          {...(isCurrentWorkspace
            ? {
                onCloseRef: previewCloseRef,
                changeNavRef: changeNavRef,
                onTotalChangesChange: setPreviewTotalChanges,
              }
            : {})}
        />
      </div>
      {/* File tree resize handle */}
      {wsFileTreeOpen && (
        <InlinePanelResizeHandle
          label="Resize file tree panel"
          title="Drag to resize file tree panel"
          widthPx={wsResolvedTreeWidthPx}
          minWidthPx={treeMinWidthPx}
          maxWidthPx={treeMaxWidthPx}
          isResizing={isResizingTree && isCurrentWorkspace}
          onResizeStart={(e) => onTreeResizeStart(e, wsId)}
          onResize={(widthPx) =>
            contentWidth > 0 && setInlineFileTreeWidth(wsId, widthPx / contentWidth)
          }
          onReset={() => setInlineFileTreeWidth(wsId, INLINE_TREE_DEFAULT_WIDTH_RATIO)}
          // The panel's own edge is the line; the handle shows only while in use.
          className="bg-transparent"
        />
      )}
      {/* File tree panel — always rendered, collapses to width 0 when closed. Its Diff/Files
           tabs are in the shared header bar above on macOS, where their row rounds the panel's
           top left like the work area card. Elsewhere they sit at the panel's top, under the
           header bar, and the panel's corner stays square. */}
      <div
        // Escape from the tree closes the preview, like Escape inside the panel.
        data-inline-file-preview-scope={wsId}
        className={cn(
          'shrink-0 overflow-hidden bg-card',
          wsFileTreeOpen && 'border-l border-foreground/15'
        )}
        style={
          !wsFileTreeOpen || contentWidth <= 0
            ? { width: 0, overflow: 'hidden' }
            : { width: wsResolvedTreeWidthPx }
        }
      >
        <div className="flex h-full flex-col">
          {!treeTabsInTopRow() && (
            <div className="flex h-8 shrink-0 items-stretch shadow-[inset_0_-1px_0_oklch(var(--border)/0.4)]">
              <FileTreeModeTabs workspaceId={wsId} isGitWorkspace={isWorktree} />
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <ErrorBoundary>
                <InlineFileTreePanel
                  workspaceId={wsId}
                  workingDirectory={workingDirectory}
                  isGitWorkspace={isWorktree}
                  isActive={isCurrentWorkspace && wsFileTreeOpen && contentWidth > 0}
                />
              </ErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/** The file panel's Diff and Files tabs. Diff needs git. */
function FileTreeModeTabs({
  workspaceId,
  isGitWorkspace,
}: {
  workspaceId: string;
  isGitWorkspace: boolean;
}) {
  const mode = useFileViewerStore((s) => s.inlineFileTreeByWorkspace[workspaceId]?.mode ?? 'diff');
  const requestModeChange = useFileViewerStore((s) => s.requestInlineFilePreviewModeChange);
  // The first tab meets the panel's top-left corner, as the first terminal tab meets
  // the work area card's.
  const tabClass = (active: boolean, first: boolean) =>
    cn(
      'relative mt-[0.5px] rounded-t-lg px-2.25 text-xs transition-colors [--tab-surface:oklch(var(--card))]',
      first ? 'edge-tab mr-px' : 'mx-px',
      active
        ? 'flat-tab-active joined-tab text-foreground'
        : 'text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground'
    );
  // Through the store action, so a dirty preview asks before reloading in the other mode.
  return (
    <>
      {isGitWorkspace && (
        <button
          onClick={() => requestModeChange(workspaceId, 'diff')}
          className={tabClass(mode === 'diff', true)}
          title="Show changed files"
        >
          Diff
        </button>
      )}
      <button
        onClick={() => requestModeChange(workspaceId, 'browse')}
        className={tabClass(mode === 'browse', !isGitWorkspace)}
        title="Show all files"
      >
        Files
      </button>
    </>
  );
}

function renderInlinePreviewHeader(params: {
  isInlinePreviewOpen: boolean;
  isInlinePreviewFullscreen: boolean;
  isFileTreeOpen: boolean;
  /** Room kept at the right for the top row's corner buttons; by default, theirs without the file panel. */
  endReservePx?: number;
  contentWidth: number;
  resolvedPreviewWidthPx: number;
  previewFilePath: string | null;
  /** Set while the preview shows a note: its title, '' while untitled. */
  previewNoteTitle?: string | null;
  previewFileStats: { additions: number; deletions: number } | null;
  previewIsDirty: boolean;
  previewMode: 'diff' | 'browse';
  previewHideUnchanged: boolean;
  setDiffHideUnchangedRegions: (value: boolean) => void;
  previewTotalChanges: number;
  changeNavRef: React.MutableRefObject<{ goToNext: () => void; goToPrev: () => void } | null>;
  inlinePreviewLayout: 'full' | 'side-by-side';
  selectedWorkspaceId: string | null;
  setInlineFilePreviewLayout: (workspaceId: string, layout: 'full' | 'side-by-side') => void;
  handleOpenPreviewFullscreen: () => void;
  previewCloseRef: React.MutableRefObject<(() => void) | null>;
  layoutAttention: PreviewLayoutAttention | null;
}): React.ReactElement | null {
  return <InlinePreviewHeader {...params} />;
}

export function InlinePreviewHeader({
  isInlinePreviewOpen,
  isInlinePreviewFullscreen,
  isFileTreeOpen,
  endReservePx = isFileTreeOpen ? 0 : 64,
  contentWidth,
  resolvedPreviewWidthPx,
  previewFilePath,
  previewNoteTitle = null,
  previewFileStats,
  previewIsDirty,
  previewMode,
  previewHideUnchanged,
  setDiffHideUnchangedRegions,
  previewTotalChanges,
  changeNavRef,
  inlinePreviewLayout,
  selectedWorkspaceId,
  setInlineFilePreviewLayout,
  handleOpenPreviewFullscreen,
  previewCloseRef,
  layoutAttention,
}: {
  isInlinePreviewOpen: boolean;
  isInlinePreviewFullscreen: boolean;
  isFileTreeOpen: boolean;
  /** Room kept at the right for the top row's corner buttons; by default, theirs without the file panel. */
  endReservePx?: number;
  contentWidth: number;
  resolvedPreviewWidthPx: number;
  previewFilePath: string | null;
  /** Set while the preview shows a note: its title, '' while untitled. */
  previewNoteTitle?: string | null;
  previewFileStats: { additions: number; deletions: number } | null;
  previewIsDirty: boolean;
  previewMode: 'diff' | 'browse';
  previewHideUnchanged: boolean;
  setDiffHideUnchangedRegions: (value: boolean) => void;
  previewTotalChanges: number;
  changeNavRef: React.MutableRefObject<{ goToNext: () => void; goToPrev: () => void } | null>;
  inlinePreviewLayout: 'full' | 'side-by-side';
  selectedWorkspaceId: string | null;
  setInlineFilePreviewLayout: (workspaceId: string, layout: 'full' | 'side-by-side') => void;
  handleOpenPreviewFullscreen: () => void;
  previewCloseRef: React.MutableRefObject<(() => void) | null>;
  /** Set while a full-screen preview hides a tab that needs the user. */
  layoutAttention?: PreviewLayoutAttention | null;
}): React.ReactElement | null {
  const headerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const iconMeasureRef = useRef<HTMLSpanElement>(null);
  const statsMeasureRef = useRef<HTMLSpanElement>(null);
  const [hideIconForFit, setHideIconForFit] = useState(false);
  const [hideStatsForFit, setHideStatsForFit] = useState(false);

  // Let the filename truncate naturally before hiding lower-priority metadata.
  // When the tree is closed the header also reserves space for the floating
  // browser/tree-toggle buttons with pr-16.
  const headerWidth = isInlinePreviewFullscreen ? contentWidth : resolvedPreviewWidthPx;
  const isTight = headerWidth > 0;
  const hideFileName = isTight && headerWidth < INLINE_PREVIEW_HIDE_NAME_WIDTH_PX;
  const hasStats = previewMode === 'diff' && !!previewFileStats;
  const hideFileIcon = hideIconForFit;
  const hideStats = hasStats && hideStatsForFit;

  useLayoutEffect(() => {
    if (!isInlinePreviewOpen) {
      setHideIconForFit(false);
      setHideStatsForFit(false);
      return;
    }

    const measure = () => {
      const header = headerRef.current;
      const controls = controlsRef.current;
      const icon = iconMeasureRef.current;
      if (!header || !controls || !icon) return;

      const headerStyle = window.getComputedStyle(header);
      const horizontalPadding =
        parseFloat(headerStyle.paddingLeft) + parseFloat(headerStyle.paddingRight);
      const headerGap =
        parseFloat(headerStyle.columnGap || headerStyle.gap) || parseFloat(headerStyle.gap) || 0;
      const controlsWidth = controls.getBoundingClientRect().width;
      const iconWidth = icon.getBoundingClientRect().width;
      const statsWidth = statsMeasureRef.current?.getBoundingClientRect().width ?? 0;
      const minimumNameWidth = previewIsDirty && !hideFileName ? 10 : 0;
      const statsGap = hasStats ? headerGap : 0;
      const iconGap = iconWidth > 0 ? headerGap : 0;
      const buffer = 2;
      const availableWidth = header.clientWidth - horizontalPadding;
      const baseWidth = controlsWidth + minimumNameWidth + buffer;
      const statsFits = !hasStats || baseWidth + statsWidth + statsGap <= availableWidth;
      const statsVisibleWidth = hasStats && statsFits ? statsWidth + statsGap : 0;

      setHideStatsForFit(hasStats && !statsFits);
      setHideIconForFit(baseWidth + statsVisibleWidth + iconWidth + iconGap > availableWidth);
    };

    measure();

    const observer = new ResizeObserver(measure);
    const elements = [
      headerRef.current,
      controlsRef.current,
      iconMeasureRef.current,
      statsMeasureRef.current,
    ].filter((element) => element !== null);
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [
    hasStats,
    hideFileName,
    isInlinePreviewOpen,
    previewFileStats?.additions,
    previewFileStats?.deletions,
    previewHideUnchanged,
    previewIsDirty,
    previewMode,
    previewTotalChanges,
  ]);

  if (!isInlinePreviewOpen) return null;

  return (
    <div
      ref={headerRef}
      // Escape from the header closes the preview, like Escape inside the panel.
      data-inline-file-preview-scope={selectedWorkspaceId ?? undefined}
      className={cn(
        'relative z-[1] flex h-full shrink-0 items-center gap-1 overflow-hidden px-2',
        isInlinePreviewFullscreen ? 'min-w-0 flex-1' : 'border-l border-border/40'
      )}
      style={{
        paddingRight: endReservePx,
        ...(isInlinePreviewFullscreen
          ? undefined
          : contentWidth > 0
            ? { width: resolvedPreviewWidthPx, flexShrink: 0, flexGrow: 0 }
            : { width: 0, overflow: 'hidden' }),
      }}
    >
      {!isFileTreeOpen && endReservePx > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-4 w-px -translate-y-1/2 bg-border/60"
          style={{ right: endReservePx - 8 }}
        />
      )}
      <span
        ref={iconMeasureRef}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 flex"
      >
        <PreviewFileIcon filePath={previewFilePath} isNote={previewNoteTitle !== null} />
      </span>
      <span className="flex shrink-0 items-center">
        {!hideFileIcon && (
          <PreviewFileIcon filePath={previewFilePath} isNote={previewNoteTitle !== null} />
        )}
      </span>
      {!hideFileName && (
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 truncate text-ui text-muted-foreground',
            previewNoteTitle === null && 'font-mono'
          )}
          title={previewNoteTitle ?? previewFilePath ?? undefined}
        >
          {previewIsDirty && (
            <span
              role="img"
              aria-label="Unsaved changes"
              className="inline-block size-2 shrink-0 rounded-full bg-warning"
              title="Unsaved changes"
            />
          )}
          {previewNoteTitle !== null ? (
            <span className="min-w-0 truncate">{previewNoteTitle || UNTITLED_NOTE}</span>
          ) : (
            <span className="min-w-0 truncate" style={{ direction: 'rtl', textAlign: 'left' }}>
              {/* Isolate the LTR path so RTL truncation can't move a leading "." or "/" to the end. */}
              <bdi>{previewFilePath ?? 'Preview'}</bdi>
            </span>
          )}
        </span>
      )}
      {hasStats && previewFileStats && (
        <span
          ref={statsMeasureRef}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0"
        >
          <DiffStatsPills
            additions={previewFileStats.additions}
            deletions={previewFileStats.deletions}
          />
        </span>
      )}
      <div className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-1">
        {/* Fullscreen, the preview covers the tab row and the progress shown there. */}
        {isInlinePreviewFullscreen && selectedWorkspaceId && (
          <WorkspaceSetupActivity key={selectedWorkspaceId} workspaceId={selectedWorkspaceId} />
        )}
        {!hideStats && hasStats && previewFileStats && (
          <DiffStatsPills
            additions={previewFileStats.additions}
            deletions={previewFileStats.deletions}
          />
        )}
        <div ref={controlsRef} className="flex shrink-0 items-center gap-1">
          {/* View controls group */}
          {previewMode === 'diff' && (
            <>
              {/* Change navigation — only when showing whole file */}
              {!previewHideUnchanged && (
                <div className="flex shrink-0 items-center">
                  <IconButton
                    label="Previous change"
                    size="xs"
                    className="rounded-md"
                    onClick={() => changeNavRef.current?.goToPrev()}
                    disabled={previewTotalChanges === 0}
                  >
                    <CaretUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Next change"
                    size="xs"
                    className="rounded-md"
                    onClick={() => changeNavRef.current?.goToNext()}
                    disabled={previewTotalChanges === 0}
                  >
                    <CaretDown className="size-3.5" />
                  </IconButton>
                </div>
              )}
              <IconButton
                label={previewHideUnchanged ? 'Show whole file' : 'Show only changes'}
                size="xs"
                className="rounded-md"
                onClick={() => setDiffHideUnchangedRegions(!previewHideUnchanged)}
              >
                {previewHideUnchanged ? (
                  <ArrowsInSimple className="size-3.5" />
                ) : (
                  <ArrowsOutSimple className="size-3.5" />
                )}
              </IconButton>
            </>
          )}
          <SegmentedControl
            aria-label="Preview layout"
            size="xs"
            value={inlinePreviewLayout}
            onValueChange={(layout) =>
              selectedWorkspaceId && setInlineFilePreviewLayout(selectedWorkspaceId, layout)
            }
            options={getPreviewLayoutOptions(layoutAttention)}
            className="shrink-0"
          />
          <div className="mx-0.5 h-4 w-px bg-border/60" />
          {/* Action buttons group */}
          {/* Notes open only here. */}
          {previewNoteTitle === null && (
            <IconButton
              label="Open full screen"
              size="xs"
              className="rounded-md"
              onClick={handleOpenPreviewFullscreen}
            >
              <ArrowSquareOut className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            label="Close preview"
            size="xs"
            className="rounded-md hover:bg-destructive/15 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              previewCloseRef.current?.();
            }}
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function PreviewFileIcon({ filePath, isNote }: { filePath: string | null; isNote: boolean }) {
  if (isNote) return <NotePencil className="size-3.5 shrink-0 text-muted-foreground" />;
  if (!filePath) return <span className="size-3.5 shrink-0 rounded-sm border border-border/70" />;
  return (
    <FileTypeIcon fileName={filePath.split('/').pop() ?? filePath} className="size-3.5 shrink-0" />
  );
}

function renderTerminalTabsEmptyState(params: {
  selectedWorkspaceId: string | null;
  selectedWorkspace: Workspace | null | undefined;
  showDashboard: boolean;
  hasLoaded: boolean;
  hasActiveWorkspaces: boolean;
  hasAnyWorkspaces: boolean;
  isRestarting: boolean;
  restartAgent: WorkspaceRestartAgent;
  /** The empty page's komlas float only while the left sidebar is collapsed. */
  sidebarCollapsed: boolean;
  onNewWorkspaceDialogChange?: (open: boolean) => void;
}): React.ReactElement | null {
  const {
    selectedWorkspaceId,
    selectedWorkspace,
    showDashboard,
    hasLoaded,
    hasActiveWorkspaces,
    hasAnyWorkspaces,
    isRestarting,
    restartAgent,
    sidebarCollapsed,
    onNewWorkspaceDialogChange,
  } = params;

  if (selectedWorkspaceId && selectedWorkspace && isRestarting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-card text-muted-foreground">
        <Spinner size="lg" />
        <div className="text-sm">Restarting workspace...</div>
        <div className="text-xs text-muted-foreground/60">
          {getWorkspaceRestartDescription(selectedWorkspace.backend?.kind === 'ssh', restartAgent)}
        </div>
      </div>
    );
  }

  if (!selectedWorkspaceId || !selectedWorkspace) {
    if (showDashboard) {
      return <DashboardView onNewWorkspaceDialogChange={onNewWorkspaceDialogChange} />;
    }
    if (!hasLoaded) {
      return <div className="h-full bg-card" />;
    }
    if (hasActiveWorkspaces) {
      return (
        <div className="empty-work-area relative flex h-full items-center justify-center bg-card text-sm text-muted-foreground">
          {sidebarCollapsed && <KomlaBackdrop />}
          <span className="relative">Select a workspace from the sidebar</span>
        </div>
      );
    }
    return (
      <FolderDropZone className="empty-work-area h-full bg-card">
        {sidebarCollapsed && <KomlaBackdrop />}
        <EmptyState
          className="relative h-full"
          icon={<KomlaMark />}
          // Neutral, like the rest of the empty page, so the logo brings the only color.
          iconClassName="bg-foreground/10"
          title={hasAnyWorkspaces ? 'No active workspaces' : 'No workspaces yet'}
          description="Give each task its own workspace: a fresh branch and folder where an agent can work on its own."
          action={
            onNewWorkspaceDialogChange && (
              <>
                <Button
                  size="sm"
                  aria-label="New Workspace"
                  className="gap-2"
                  onClick={() => onNewWorkspaceDialogChange(true)}
                >
                  <Plus className="size-3.5" />
                  New Workspace
                  <ShortcutHint
                    action="workspace.new"
                    className="border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground"
                  />
                </Button>
                <RecentFolders className="mt-4" />
              </>
            )
          }
        />
      </FolderDropZone>
    );
  }

  // Workspace is still being provisioned (worktree creation in progress)
  if (selectedWorkspace.provisioning) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Spinner size="lg" />
        <div className="text-sm">Setting up workspace...</div>
        <div className="text-xs text-muted-foreground/60">
          {selectedWorkspace.provisionStatus ??
            (selectedWorkspace.branchName
              ? 'Creating worktree'
              : 'Generating branch name and creating worktree')}
        </div>
      </div>
    );
  }

  // Workspace provisioning failed
  if (selectedWorkspace.provisionError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="text-sm">
          {selectedWorkspace.removedFromHost
            ? 'Workspace missing from host'
            : 'Workspace setup failed'}
        </div>
        <div className="max-w-md text-center text-xs text-muted-foreground/60">
          {selectedWorkspace.provisionError}
        </div>
        {selectedWorkspace.removedFromHost && (
          <RemoveFromThisDeviceButton workspaceId={selectedWorkspace.id} />
        )}
      </div>
    );
  }

  return null;
}

function RemoveFromThisDeviceButton({ workspaceId }: { workspaceId: string }) {
  const removeMissingSshWorkspace = useWorkspacesStore((s) => s.removeMissingSshWorkspace);
  return (
    <Button variant="outline" size="sm" onClick={() => void removeMissingSshWorkspace(workspaceId)}>
      Remove from this device
    </Button>
  );
}

// Memoized: App re-renders whenever one of its dialogs opens.
export const TerminalTabs = memo(function TerminalTabs({
  onNewWorkspaceDialogChange,
  renderCollapsedSidebarControls,
}: TerminalTabsProps) {
  // Use individual selectors to minimize re-renders
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  // Passed from the tab strip to the run button beside it without rendering either again.
  const [tabRoom] = useState<TabRoom>(() => ({ px: Infinity }));
  const showDashboard = useWorkspacesStore((s) => s.showDashboard);
  const hasLoaded = useWorkspacesStore((s) => s.hasLoaded);
  const currentWindowId = useWindowStore((s) => s.windowId);
  const hasActiveWorkspaces = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.status === 'active' && w.windowId === currentWindowId)
  );
  const hasAnyWorkspaces = useWorkspacesStore((s) => s.workspaces.length > 0);
  const isRestarting = useWorkspacesStore((s) =>
    s.selectedWorkspaceId ? (s.restartingWorkspaceIds?.has(s.selectedWorkspaceId) ?? false) : false
  );
  const presets = useAgentPresetsStore((s) => s.presets);
  const activePreset = useAgentPresetsStore((s) => s.activePreset);
  const addTerminal = useWorkspacesStore((s) => s.addTerminal);

  const currentWorkspaceId = useLayoutStore((s) => s.currentWorkspaceId);
  const setCurrentWorkspace = useLayoutStore((s) => s.setCurrentWorkspace);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);
  const showTabInFullPane = useLayoutStore((s) => s.showTabInFullPane);
  const isTabVisible = useLayoutStore((s) => s.isTabVisible);
  const addTab = useLayoutStore((s) => s.addTab);
  const reorderTabs = useLayoutStore((s) => s.reorderTabs);
  const movePaneToTab = useLayoutStore((s) => s.movePaneToTab);
  const movePaneToNewTab = useLayoutStore((s) => s.movePaneToNewTab);
  const initializeWorkspaceLayout = useLayoutStore((s) => s.initializeWorkspaceLayout);
  const sidebarCollapsed = useSidebarCollapsed();
  // The first tab meets the work area card's edge, unless the collapsed sidebar's buttons sit
  // before it.
  const firstTabAtEdge = !sidebarCollapsed;
  const [topRowActionsRef, topRowActionsWidth] = useElementWidth();
  const [treeTabsRef, treeTabsWidth] = useElementWidth();
  const treeMinWidthPx = inlineTreeMinWidthPx(treeTabsWidth, topRowActionsWidth);
  const { heightPx: topRowHeightPx, captionWidthPx: topRowCaptionWidthPx } = topRowMetrics();
  const terminalBackground = useTerminalBackground();
  const requestInlineFilePreviewModeChange = useFileViewerStore(
    (s) => s.requestInlineFilePreviewModeChange
  );
  const isFileTreeOpen = useFileViewerStore((s) =>
    currentWorkspaceId ? (s.inlineFileTreeByWorkspace[currentWorkspaceId]?.open ?? true) : false
  );
  const fileTreeMode = useFileViewerStore((s) =>
    currentWorkspaceId ? (s.inlineFileTreeByWorkspace[currentWorkspaceId]?.mode ?? 'diff') : 'diff'
  );
  const isInlinePreviewOpen = useFileViewerStore((s) =>
    currentWorkspaceId ? (s.inlineFilePreviewByWorkspace[currentWorkspaceId]?.open ?? false) : false
  );
  const inlinePreviewLayout = useFileViewerStore((s) =>
    currentWorkspaceId
      ? (s.inlineFilePreviewByWorkspace[currentWorkspaceId]?.layout ?? 'full')
      : 'full'
  );
  const inlinePreviewWidthRatio = useFileViewerStore((s) =>
    currentWorkspaceId
      ? (s.inlineFilePreviewWidthByWorkspace[currentWorkspaceId] ??
        INLINE_PREVIEW_DEFAULT_WIDTH_RATIO)
      : INLINE_PREVIEW_DEFAULT_WIDTH_RATIO
  );
  const inlineTreeWidthRatio = useFileViewerStore((s) =>
    currentWorkspaceId
      ? (s.inlineFileTreeWidthByWorkspace[currentWorkspaceId] ?? INLINE_TREE_DEFAULT_WIDTH_RATIO)
      : INLINE_TREE_DEFAULT_WIDTH_RATIO
  );
  const setInlineFilePreviewWidth = useFileViewerStore((s) => s.setInlineFilePreviewWidth);
  const setInlineFileTreeWidth = useFileViewerStore((s) => s.setInlineFileTreeWidth);
  const setInlineFilePreviewLayoutAction = useFileViewerStore((s) => s.setInlineFilePreviewLayout);
  const requestFileViewerTransition = useFileViewerStore((s) => s.requestFileViewerTransition);
  const copyInlineFileTreeComparisonToFileViewerDiff = useFileViewerStore(
    (s) => s.copyInlineFileTreeComparisonToFileViewerDiff
  );
  const previewMode = useFileViewerStore((s) =>
    currentWorkspaceId
      ? (s.inlineFilePreviewByWorkspace[currentWorkspaceId]?.mode ?? 'browse')
      : 'browse'
  );
  const previewFilePath = useFileViewerStore((s) =>
    currentWorkspaceId
      ? (s.inlineFilePreviewByWorkspace[currentWorkspaceId]?.filePath ?? null)
      : null
  );
  const previewIsDirty = useFileViewerStore((s) =>
    currentWorkspaceId
      ? (s.inlineFilePreviewByWorkspace[currentWorkspaceId]?.isDirty ?? false)
      : false
  );
  const previewNoteTitle = useNoteTitle(currentWorkspaceId, previewFilePath);
  const { config, updateConfig } = useConfigStore();
  const { setDiffHideUnchangedRegions } = useConfigStore();
  const previewHideUnchanged = config?.diffHideUnchangedRegions ?? true;

  // Toolbar Split/Full clicks: update the workspace's layout AND persist as the
  // user's preferred default so future workspaces seed from this choice. The
  // live-follow auto-set in InlineFileTreePanel uses the raw store action and
  // intentionally does NOT touch the global preference.
  // Mirror the new preference into the renderer config store synchronously
  // (before the IPC roundtrip resolves) so any same-tick openInlineFilePreview
  // in another workspace reads the up-to-date value. updateConfig itself only
  // refreshes the store after IPC returns, which would otherwise leave a race.
  const setInlineFilePreviewLayout = useCallback(
    (workspaceId: string, layout: 'full' | 'side-by-side') => {
      setInlineFilePreviewLayoutAction(workspaceId, layout);
      const currentConfig = useConfigStore.getState().config;
      if (currentConfig) {
        useConfigStore.setState({
          config: { ...currentConfig, defaultInlinePreviewLayout: layout },
        });
      }
      void updateConfig({ defaultInlinePreviewLayout: layout });
    },
    [setInlineFilePreviewLayoutAction, updateConfig]
  );

  // Get current workspace's tabs and active tab with individual selectors
  const openTabs = useLayoutStore((s) =>
    currentWorkspaceId ? (s.tabsByWorkspace[currentWorkspaceId] ?? EMPTY_TAB_IDS) : EMPTY_TAB_IDS
  );
  const activeTabId = useLayoutStore((s) =>
    currentWorkspaceId ? s.activeTabByWorkspace[currentWorkspaceId] || null : null
  );

  // Get layout data needed for rendering
  const tabsByWorkspace = useLayoutStore((s) => s.tabsByWorkspace);
  const layoutsByTab = useLayoutStore((s) => s.layoutsByTab);
  const activeTabByWorkspace = useLayoutStore((s) => s.activeTabByWorkspace);
  const focusedPaneByTab = useLayoutStore((s) => s.focusedPaneByTab);

  // Get workspaces array for initialization effect
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);

  // Get selected workspace terminals for getTabName
  const selectedWorkspaceTerminals = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === s.selectedWorkspaceId);
    return workspace?.terminals ?? EMPTY_TERMINALS;
  });

  // Get the selected workspace
  const selectedWorkspace = useWorkspacesStore((s) =>
    s.selectedWorkspaceId ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId) : null
  );
  const restartPreset =
    presets.find((preset) => preset.id === selectedWorkspace?.presetId) ?? activePreset;
  const restartAgent = getWorkspaceRestartAgent(restartPreset);

  // Per-file diff stats for the inline preview header — sourced from the same
  // cached diff that the inline file tree displays.
  const { comparisonBranch: previewComparisonBranch, useMergeBase: previewUseMergeBase } =
    useDiffComparison(currentWorkspaceId, 'inline');
  const previewWorkingDirectory = selectedWorkspace?.workingDirectory ?? null;
  const previewFileChange = useFileListStore((s) => {
    if (previewMode !== 'diff' || !previewFilePath || !previewWorkingDirectory) return null;
    return (
      s
        .getDiff(
          previewWorkingDirectory,
          previewComparisonBranch,
          previewUseMergeBase,
          currentWorkspaceId ?? undefined
        )
        ?.data.files.find((f) => f.path === previewFilePath) ?? null
    );
  });

  // Drag-and-drop state for tab reordering
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    tabId: string;
    position: 'before' | 'after';
  } | null>(null);
  const dropTargetRef = useRef<{ tabId: string; position: 'before' | 'after' } | null>(null);
  // The tab currently highlighted as the drop target of a cross-tab pane drag.
  const [paneDropTabId, setPaneDropTabId] = useState<string | null>(null);
  const [paneDropOnNewTab, setPaneDropOnNewTab] = useState(false);
  const previewCloseRef = useRef<(() => void) | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const [isResizingTree, setIsResizingTree] = useState(false);
  const previewResizeRef = useRef<{
    startX: number;
    startWidthPx: number;
    workspaceId: string;
  } | null>(null);
  const treeResizeRef = useRef<{
    startX: number;
    startWidthPx: number;
    workspaceId: string;
  } | null>(null);
  const changeNavRef = useRef<{ goToNext: () => void; goToPrev: () => void } | null>(null);
  const [previewTotalChanges, setPreviewTotalChanges] = useState(0);

  const isGitWorkspace = !!selectedWorkspace?.isWorktree;
  const resolvedTreeWidthPx = isFileTreeOpen
    ? resolvePanelWidthPx(
        contentWidth,
        inlineTreeWidthRatio,
        treeMinWidthPx,
        INLINE_TREE_MAX_WIDTH_PX
      )
    : 0;
  const availableForPreviewParent = contentWidth - resolvedTreeWidthPx;
  // The file panel keeps its stretch of the top row on macOS, for its tabs, and under a file
  // preview, whose header sits over the preview pane. Elsewhere that stretch would stand empty, so
  // the terminal tab row runs on into it and keeps the Action button beside the corner buttons.
  const treeTabsOnTop = treeTabsInTopRow();
  const isTreeInTopRow = isFileTreeOpen && (treeTabsOnTop || isInlinePreviewOpen);
  const topRowEndReservePx = topRowEndReserve(
    isTreeInTopRow,
    resolvedTreeWidthPx,
    topRowActionsWidth + topRowCaptionWidthPx
  );
  const resolvedPreviewWidthPx = isInlinePreviewOpen
    ? resolvePanelWidthPx(
        availableForPreviewParent,
        inlinePreviewWidthRatio,
        INLINE_PREVIEW_MIN_WIDTH_PX,
        INLINE_PREVIEW_MAX_WIDTH_PX
      )
    : 0;
  const isInlinePreviewFullscreen = isInlinePreviewOpen && inlinePreviewLayout === 'full';
  // A full-screen preview hides the tab strip, so flag tabs that need the user on Split.
  const previewLayoutAttention = useMemo(
    () =>
      isInlinePreviewFullscreen ? getPreviewLayoutAttention(selectedWorkspaceTerminals) : null,
    [isInlinePreviewFullscreen, selectedWorkspaceTerminals]
  );

  // Sync selectedWorkspaceId with layout store — useLayoutEffect ensures
  // currentWorkspaceId updates before the browser paints, so file tree
  // and tab visibility switch atomically (no visible layout shift).
  useLayoutEffect(() => {
    if (selectedWorkspaceId !== currentWorkspaceId) {
      // Find the first terminal for this workspace to initialize layout
      const terminals = selectedWorkspace?.terminals || [];
      const initialTerminalId = terminals.length > 0 ? terminals[0].id : undefined;
      setCurrentWorkspace(selectedWorkspaceId, initialTerminalId);
    }
  }, [selectedWorkspaceId, currentWorkspaceId, setCurrentWorkspace, selectedWorkspace?.terminals]);

  // Ensure workspaces running in this window have initialized layouts so hidden ones can render.
  // Any other workspace has no terminal running here whose state its panes would keep, and a
  // selected one gets its layout from setCurrentWorkspace.
  const inlineFileTreeByWorkspace = useFileViewerStore((s) => s.inlineFileTreeByWorkspace);
  useEffect(() => {
    for (const ws of workspaces) {
      const terminals = ws.terminals || [];
      if (terminals.length > 0 && !tabsByWorkspace[ws.id]?.length) {
        const ownedElsewhere = ws.windowId != null && ws.windowId !== currentWindowId;
        if (isRunningHere(ws) && !ownedElsewhere) {
          initializeWorkspaceLayout(ws.id, terminals[0].id);
        }
      } else if (
        terminals.length > 0 &&
        isWorkspaceLayoutPlaceholder(ws.id, tabsByWorkspace[ws.id])
      ) {
        // Replace placeholder layout (workspace ID used as tab during provisioning)
        // with the real terminal ID now that provisioning has completed.
        initializeWorkspaceLayout(ws.id, terminals[0].id, true);
      }
      // Initialize inline file tree state from persisted workspace data
      if (!(ws.id in inlineFileTreeByWorkspace)) {
        if (ws.fileTreeOpen !== undefined) {
          useFileViewerStore.getState().setInlineFileTreeOpen(ws.id, ws.fileTreeOpen);
        }
        if (ws.fileTreeMode) {
          useFileViewerStore.getState().setInlineFileTreeMode(ws.id, ws.fileTreeMode);
        }
      }
    }
  }, [
    workspaces,
    tabsByWorkspace,
    initializeWorkspaceLayout,
    inlineFileTreeByWorkspace,
    currentWindowId,
  ]);

  const terminalById = useMemo(
    () => new Map(selectedWorkspaceTerminals.map((terminal) => [terminal.id, terminal])),
    [selectedWorkspaceTerminals]
  );
  const selectedWorkspaceNotes =
    useNotesStore((s) => (selectedWorkspaceId ? s.byScope[selectedWorkspaceId] : undefined)) ??
    EMPTY_NOTES;
  // Only the titles: a page's every navigation shouldn't redraw the tabs.
  const paneSurfaceTitles = usePaneSurfacesStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.entries(s.surfaces).map(([id, surface]) => [
          id,
          getPaneSurfaceTitle(surface, selectedWorkspaceNotes),
        ])
      )
    )
  );
  const closingTerminalIds = useTerminalCloseStore((s) => s.closingTerminalIds);

  const getTerminalIdsForTab = useCallback(
    (tabId: string): string[] => {
      if (!selectedWorkspaceId) return [tabId];
      const tabLayout = layoutsByTab[selectedWorkspaceId]?.[tabId];
      if (!tabLayout) return [tabId];
      return getAllLeaves(tabLayout).map((leaf) => leaf.terminalId);
    },
    [layoutsByTab, selectedWorkspaceId]
  );

  const isTabLayoutLocked = useCallback(
    (tabId: string) => {
      const pendingIds = useTerminalCloseStore.getState().closingTerminalIds;
      return getTerminalIdsForTab(tabId).some((terminalId) => pendingIds.has(terminalId));
    },
    [getTerminalIdsForTab]
  );

  /** The terminal in the tab's last focused pane. */
  const getFocusedTerminalId = useCallback(
    (tabId: string): string | null => {
      if (!selectedWorkspaceId) return null;
      const focusedPaneId = focusedPaneByTab[selectedWorkspaceId]?.[tabId];
      const layout = layoutsByTab[selectedWorkspaceId]?.[tabId];
      if (!focusedPaneId || !layout) return null;
      const focusedPane = findNode(layout, focusedPaneId);
      return focusedPane?.type === 'leaf' ? focusedPane.terminalId : null;
    },
    [focusedPaneByTab, layoutsByTab, selectedWorkspaceId]
  );

  // A split tab is titled after its last focused pane, since its panes have no headers by default.
  const getTabName = useCallback(
    (tabId: string): string => {
      const tabTerminalIds = getTerminalIdsForTab(tabId);
      const primaryTerminalId =
        selectedWorkspace?.primaryTerminalId ?? selectedWorkspaceTerminals[0]?.id;
      const titleTerminalId =
        getFocusedTerminalId(tabId) ??
        (primaryTerminalId && tabTerminalIds.includes(primaryTerminalId)
          ? primaryTerminalId
          : tabTerminalIds.includes(tabId)
            ? tabId
            : tabTerminalIds[0]);
      if (titleTerminalId && isPaneSurfaceId(titleTerminalId)) {
        return paneSurfaceTitles[titleTerminalId] ?? getPaneSurfaceTitle(undefined, []);
      }
      const terminal = titleTerminalId ? terminalById.get(titleTerminalId) : null;
      return terminal?.dynamicTitle || terminal?.name || 'Terminal';
    },
    [
      paneSurfaceTitles,
      getFocusedTerminalId,
      getTerminalIdsForTab,
      selectedWorkspace?.primaryTerminalId,
      selectedWorkspaceTerminals,
      terminalById,
    ]
  );

  const activeFocusedTerminalId = useMemo(
    () => (activeTabId ? getFocusedTerminalId(activeTabId) : null),
    [activeTabId, getFocusedTerminalId]
  );

  const clearFocusedTerminalAttention = useCallback(() => {
    if (!activeFocusedTerminalId) return;
    if (terminalById.get(activeFocusedTerminalId)?.attention) {
      void window.api.clearTerminalAttention(activeFocusedTerminalId);
    }
  }, [activeFocusedTerminalId, terminalById]);

  // A done on another pane in view is seen: it leaves the tab and the workspace card, and stays
  // as that pane's border until the user focuses it. A prompt or error waits for the focus.
  // Each one is sent once, by when it was raised, while main's reply is on its way.
  const seenSentRef = useRef(new Map<string, number>());
  const markVisibleAttentionSeen = useCallback(() => {
    if (!activeTabId) return;
    for (const terminalId of getTerminalIdsForTab(activeTabId)) {
      if (terminalId === activeFocusedTerminalId) continue;
      const attention = terminalById.get(terminalId)?.attention;
      if (!attention || attention.seen || isWorkspaceAttentionActionable(attention)) continue;
      if (seenSentRef.current.get(terminalId) === attention.updatedAt) continue;
      seenSentRef.current.set(terminalId, attention.updatedAt);
      void window.api.markTerminalAttentionSeen(terminalId);
    }
  }, [activeFocusedTerminalId, activeTabId, getTerminalIdsForTab, terminalById]);

  // While Komla is in the background, or the user is away from the computer, keep the badge
  // until the user returns.
  const windowFocused = useWindowFocused();
  const awaitingUserReturn = useAwaitingUserReturn();
  const tabInView =
    selectedWorkspaceId &&
    activeTabId &&
    !isInlinePreviewFullscreen &&
    windowFocused &&
    !awaitingUserReturn
      ? `${selectedWorkspaceId}/${activeTabId}`
      : null;
  // The tab in view once it has been for SEEN_AFTER_MS; leaving it, or the window, starts over.
  const settledTabRef = useRef<string | null>(null);
  const seeTabInView = useEffectEvent(() => {
    clearFocusedTerminalAttention();
    markVisibleAttentionSeen();
  });
  useEffect(() => {
    if (!tabInView) return;
    const timer = setTimeout(() => {
      settledTabRef.current = tabInView;
      seeTabInView();
    }, SEEN_AFTER_MS);
    return () => {
      clearTimeout(timer);
      settledTabRef.current = null;
    };
  }, [tabInView]);
  // After that, a notification on a pane in view, or on the pane the user focuses, goes at once.
  useEffect(() => {
    if (!tabInView || settledTabRef.current !== tabInView) return;
    clearFocusedTerminalAttention();
    markVisibleAttentionSeen();
  }, [clearFocusedTerminalAttention, markVisibleAttentionSeen, tabInView]);

  const handleCreateTerminal = async () => {
    if (!selectedWorkspace || !selectedWorkspaceId) return;

    try {
      const terminal = await addTerminal(selectedWorkspaceId);
      // Add terminal to current workspace's tabs and switch to it
      addTab(selectedWorkspaceId, terminal.id);
      showTabInFullPane(terminal.id);
    } catch (error) {
      console.error('Failed to create terminal:', error);
      useToastStore
        .getState()
        .addToast(`Failed to open a terminal: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const selectedSshHost = useSshHostsStore((state) =>
    selectedWorkspace?.backend?.kind === 'ssh'
      ? state.hosts.find((host) => host.id === getWorkspaceHostId(selectedWorkspace))
      : undefined
  );
  const showLocalMirrorButton =
    selectedWorkspace?.backend?.kind === 'ssh' &&
    !!selectedSshHost &&
    supportsLocalCopy(selectedSshHost);

  const handleCreateLocalMirrorTerminal = async () => {
    if (!selectedWorkspaceId) return;
    try {
      const terminal = await addTerminal(
        selectedWorkspaceId,
        'Local terminal',
        null,
        undefined,
        'host-shell',
        'local-mirror'
      );
      addTab(selectedWorkspaceId, terminal.id);
      showTabInFullPane(terminal.id);
    } catch (error) {
      useToastStore
        .getState()
        .addToast(`Failed to open local terminal: ${(error as Error).message}`, 'error');
    }
  };

  const handleTabClick = (terminalId: string) => {
    // Switch to this tab's layout. The inline preview is workspace-level and
    // independent of which terminal tab is active, so don't touch it here —
    // closing it on tab switch would silently drop unsaved edits.
    setActiveTab(terminalId);
  };

  // Unsaved edits in a file pane keep every tab open unless they may go, asked once for all.
  // Closing the workspace's last tabs asks too, since that stops the workspace.
  const handleCloseTabs = async (tabIds: string[]) => {
    const paneIds = tabIds.flatMap((tabId) => getTerminalIdsForTab(tabId));
    const surfaceIds = paneIds.filter(isPaneSurfaceId);
    if (surfaceIds.length > 0 && !(await confirmClosingPaneSurfaces(surfaceIds))) return;
    if (
      selectedWorkspaceId &&
      closingPanesStopsWorkspace(selectedWorkspaceId, paneIds) &&
      !(await confirmStoppingWorkspace(selectedWorkspaceId))
    ) {
      return;
    }
    if (selectedWorkspaceId) {
      for (const id of surfaceIds) closePaneSurface(selectedWorkspaceId, id);
    }
    const allTerminalIds = paneIds.filter((id) => !isPaneSurfaceId(id));
    const results = await Promise.allSettled(allTerminalIds.map(closeTerminalPane));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Failed to remove terminal:', result.reason);
      }
    }
  };

  const handleCloseTab = (terminalId: string) => handleCloseTabs([terminalId]);

  // Activate the kept tab first so closing the active one doesn't jump to a neighbour.
  const handleCloseOtherTabs = (terminalId: string) => {
    setActiveTab(terminalId);
    void handleCloseTabs(openTabs.filter((tabId) => tabId !== terminalId));
  };

  const handleCloseTabsToRight = (terminalId: string) => {
    const tabsToClose = openTabs.slice(openTabs.indexOf(terminalId) + 1);
    if (activeTabId && tabsToClose.includes(activeTabId)) setActiveTab(terminalId);
    void handleCloseTabs(tabsToClose);
  };

  // Menu equivalent of dragging a single-pane tab's pane onto another tab, for
  // tabs whose pane header is hidden. movePaneToTab moves from the active tab.
  const handleMoveTabInto = (sourceTabId: string, targetTabId: string) => {
    if (!selectedWorkspaceId || isTabLayoutLocked(sourceTabId) || isTabLayoutLocked(targetTabId)) {
      return;
    }
    const sourceLayout = layoutsByTab[selectedWorkspaceId]?.[sourceTabId];
    if (sourceLayout?.type !== 'leaf') return;
    setActiveTab(sourceTabId);
    movePaneToTab(sourceLayout.id, targetTabId);
  };

  const handleSplitWithTab = async (terminalId: string, direction: 'horizontal' | 'vertical') => {
    if (!selectedWorkspaceId || isTabLayoutLocked(terminalId)) return;
    try {
      const tabLayout = layoutsByTab[selectedWorkspaceId]?.[terminalId];
      const focusedPaneId = focusedPaneByTab[selectedWorkspaceId]?.[terminalId];
      const focusedNode =
        tabLayout && focusedPaneId ? findNode(tabLayout, focusedPaneId) : undefined;
      const sourceTerminalId = focusedNode?.type === 'leaf' ? focusedNode.terminalId : terminalId;
      const sourceTerminal = terminalById.get(sourceTerminalId);
      // Switch to the tab first so the split happens in the right context
      setActiveTab(terminalId);
      // Create a new terminal for the split (not reuse the existing one)
      const newTerminal = await addTerminalForSplit(
        addTerminal,
        selectedWorkspaceId,
        sourceTerminal
      );
      splitPane(direction, newTerminal.id);
    } catch (error) {
      console.error('Failed to create terminal for split:', error);
      useToastStore
        .getState()
        .addToast(`Failed to split the pane: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const handleOpenPreviewFullscreen = useCallback(() => {
    if (!selectedWorkspaceId || !previewFilePath) return;
    if (previewMode === 'diff') {
      copyInlineFileTreeComparisonToFileViewerDiff(selectedWorkspaceId);
    }
    requestFileViewerTransition({
      kind: 'mode',
      workspaceId: selectedWorkspaceId,
      mode: previewMode,
      after:
        previewMode === 'diff'
          ? { kind: 'diff-file', filePath: previewFilePath }
          : { kind: 'browse-file', filePath: previewFilePath },
    });
  }, [
    selectedWorkspaceId,
    previewFilePath,
    previewMode,
    copyInlineFileTreeComparisonToFileViewerDiff,
    requestFileViewerTransition,
  ]);

  useEffect(() => {
    if (!selectedWorkspaceId || isGitWorkspace) return;
    if (fileTreeMode === 'diff') {
      // Route through the dirty-aware action so a dirty diff preview prompts
      // before being silently reloaded into the browse editor.
      requestInlineFilePreviewModeChange(selectedWorkspaceId, 'browse');
    }
  }, [selectedWorkspaceId, isGitWorkspace, fileTreeMode, requestInlineFilePreviewModeChange]);

  // Drag handlers for tab reordering
  const handleTabDragStart = useCallback(
    (e: React.DragEvent, terminalId: string) => {
      if (isTabLayoutLocked(terminalId)) {
        e.preventDefault();
        return;
      }
      setDraggedTabId(terminalId);
      e.dataTransfer.effectAllowed = 'move';
      // A tab holding one pane drags that pane too, so it can be dropped beside the shown tab's panes.
      // Read at dragstart so the handler doesn't change with every layout update.
      const tabLayout = selectedWorkspaceId
        ? useLayoutStore.getState().layoutsByTab[selectedWorkspaceId]?.[terminalId]
        : undefined;
      if (tabLayout?.type === 'leaf') {
        e.dataTransfer.setData(PANE_DRAG_MIME, tabLayout.id);
        e.dataTransfer.setData(TAB_PANE_DRAG_MIME, terminalId);
        setDraggedPaneId(tabLayout.id);
      }
    },
    [isTabLayoutLocked, selectedWorkspaceId]
  );

  const handleTabDragEnd = useCallback(() => {
    setDraggedPaneId(null);
    setDraggedTabId(null);
    setDropTarget(null);
    dropTargetRef.current = null;
  }, []);

  const handleTabDragOver = useCallback(
    (e: React.DragEvent, terminalId: string) => {
      if (isTabLayoutLocked(terminalId)) return;
      // Cross-tab pane drag: highlight this tab as a drop target (but never
      // the source tab the pane already lives in). A dragged tab reorders.
      if (isPaneDragFromPane(e.dataTransfer)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setPaneDropTabId(terminalId === activeTabId ? null : terminalId);
        return;
      }

      e.preventDefault();
      if (!draggedTabId || terminalId === draggedTabId) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const position: 'before' | 'after' = e.clientX < midX ? 'before' : 'after';
      const target = { tabId: terminalId, position };
      setDropTarget(target);
      dropTargetRef.current = target;
    },
    [draggedTabId, activeTabId, isTabLayoutLocked]
  );

  // Clear the cross-tab drop highlight when a drag leaves the tab — guarding
  // against the dragleave that fires when crossing into the tab's children.
  const handleTabDragLeave = useCallback((e: React.DragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setPaneDropTabId(null);
  }, []);

  const handleTabDrop = useCallback(
    (e: React.DragEvent, terminalId: string) => {
      if (isTabLayoutLocked(terminalId)) return;
      // Cross-tab pane drag: move the dragged pane into this tab's layout.
      if (isPaneDragFromPane(e.dataTransfer)) {
        e.preventDefault();
        setPaneDropTabId(null);
        const sourcePaneId = getDroppedPaneId(e.dataTransfer);
        setDraggedPaneId(null);
        if (sourcePaneId && terminalId !== activeTabId) {
          movePaneToTab(sourcePaneId, terminalId);
        }
        return;
      }

      const target = dropTargetRef.current;
      if (!draggedTabId || !target || !selectedWorkspaceId || draggedTabId === target.tabId) {
        setDraggedTabId(null);
        setDropTarget(null);
        dropTargetRef.current = null;
        return;
      }

      const fromIndex = openTabs.indexOf(draggedTabId);
      const rawToIndex = openTabs.indexOf(target.tabId);
      if (fromIndex === -1 || rawToIndex === -1) return;

      // Adjust target index based on position
      let toIndex = target.position === 'after' ? rawToIndex + 1 : rawToIndex;
      // If dragging forward, account for removal shifting indices
      if (fromIndex < toIndex) toIndex--;

      reorderTabs(selectedWorkspaceId, fromIndex, toIndex);

      setDraggedTabId(null);
      setDropTarget(null);
      dropTargetRef.current = null;
    },
    [
      draggedTabId,
      selectedWorkspaceId,
      openTabs,
      reorderTabs,
      activeTabId,
      movePaneToTab,
      isTabLayoutLocked,
    ]
  );

  // Cross-tab pane drag onto the `+` button: pop the dragged pane into its own
  // new tab. Tab drags, even those carrying their lone pane, are ignored here.
  const handleNewTabDragOver = useCallback((e: React.DragEvent) => {
    if (!isPaneDragFromPane(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setPaneDropOnNewTab(true);
  }, []);

  const handleNewTabDragLeave = useCallback((e: React.DragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setPaneDropOnNewTab(false);
  }, []);

  const handleNewTabDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isPaneDragFromPane(e.dataTransfer)) return;
      e.preventDefault();
      setPaneDropOnNewTab(false);
      const sourcePaneId = getDroppedPaneId(e.dataTransfer);
      setDraggedPaneId(null);
      if (sourcePaneId) movePaneToNewTab(sourcePaneId);
    },
    [movePaneToNewTab]
  );

  // A cancelled pane drag (Esc) may end while hovering a tab without firing a
  // dragleave — clear the cross-tab drop highlights on any dragend to be safe.
  useEffect(() => {
    const clear = () => {
      setPaneDropTabId(null);
      setPaneDropOnNewTab(false);
    };
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  // A tab dropped onto a pane leaves the tab row before its dragend, which then never reaches
  // React, so the drop itself ends the tab drag.
  useEffect(() => {
    window.addEventListener('drop', handleTabDragEnd);
    return () => window.removeEventListener('drop', handleTabDragEnd);
  }, [handleTabDragEnd]);

  const observerRef = useRef<ResizeObserver | null>(null);
  const contentCallbackRef = useCallback((el: HTMLDivElement | null) => {
    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    contentRef.current = el;
    if (!el) return;
    // Measure synchronously on mount
    setContentWidth(el.clientWidth);
    // Observe for subsequent resizes
    const observer = new ResizeObserver(() => setContentWidth(el.clientWidth));
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  const handlePreviewResizeStart = useCallback(
    (e: React.MouseEvent, workspaceId: string) => {
      if (!contentRef.current) return;
      e.preventDefault();
      const store = useFileViewerStore.getState();
      const previewRatio =
        store.inlineFilePreviewWidthByWorkspace[workspaceId] ?? INLINE_PREVIEW_DEFAULT_WIDTH_RATIO;
      const containerWidth = contentRef.current.clientWidth;
      // Compute available width excluding file tree (same basis used for resolution)
      const treeOpen = store.inlineFileTreeByWorkspace[workspaceId]?.open ?? true;
      const treeRatio =
        store.inlineFileTreeWidthByWorkspace[workspaceId] ?? INLINE_TREE_DEFAULT_WIDTH_RATIO;
      const treePx = treeOpen
        ? resolvePanelWidthPx(containerWidth, treeRatio, treeMinWidthPx, INLINE_TREE_MAX_WIDTH_PX)
        : 0;
      const availableWidth = containerWidth - treePx;
      const widthPx = resolvePanelWidthPx(
        availableWidth,
        previewRatio,
        INLINE_PREVIEW_MIN_WIDTH_PX,
        INLINE_PREVIEW_MAX_WIDTH_PX
      );
      previewResizeRef.current = { startX: e.clientX, startWidthPx: widthPx, workspaceId };
      setIsResizingPreview(true);
    },
    [treeMinWidthPx]
  );

  const handleTreeResizeStart = useCallback(
    (e: React.MouseEvent, workspaceId: string) => {
      if (!contentRef.current) return;
      e.preventDefault();
      const ratio =
        useFileViewerStore.getState().inlineFileTreeWidthByWorkspace[workspaceId] ??
        INLINE_TREE_DEFAULT_WIDTH_RATIO;
      const widthPx = resolvePanelWidthPx(
        contentRef.current.clientWidth,
        ratio,
        treeMinWidthPx,
        INLINE_TREE_MAX_WIDTH_PX
      );
      treeResizeRef.current = { startX: e.clientX, startWidthPx: widthPx, workspaceId };
      setIsResizingTree(true);
    },
    [treeMinWidthPx]
  );

  useEffect(() => {
    if (!isResizingPreview) return;

    const onMouseMove = (event: MouseEvent) => {
      const el = contentRef.current;
      if (!el || !previewResizeRef.current) return;

      const { workspaceId } = previewResizeRef.current;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;

      // Read per-workspace panel state from store at event time
      const store = useFileViewerStore.getState();
      const wsTreeOpen = store.inlineFileTreeByWorkspace[workspaceId]?.open ?? true;
      const wsTreeWidthRatio =
        store.inlineFileTreeWidthByWorkspace[workspaceId] ?? INLINE_TREE_DEFAULT_WIDTH_RATIO;
      const wsTreeWidthPx = wsTreeOpen
        ? resolvePanelWidthPx(
            rect.width,
            wsTreeWidthRatio,
            treeMinWidthPx,
            INLINE_TREE_MAX_WIDTH_PX
          )
        : 0;

      const availableWidth = rect.width - wsTreeWidthPx;
      const maxPreviewPx = availableWidth - RESIZE_HANDLE_WIDTH_PX;
      const deltaX = previewResizeRef.current.startX - event.clientX;
      const widthPixels = clamp(previewResizeRef.current.startWidthPx + deltaX, 0, maxPreviewPx);
      const nextRatio = availableWidth > 0 ? widthPixels / availableWidth : 0;
      // Both panels share the slot's width — always write through the file
      // viewer store regardless of which panel currently owns the slot.
      setInlineFilePreviewWidth(workspaceId, nextRatio);
    };

    const onMouseUp = () => {
      setIsResizingPreview(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingPreview, setInlineFilePreviewWidth, treeMinWidthPx]);

  useEffect(() => {
    if (!isResizingTree) return;

    const onMouseMove = (event: MouseEvent) => {
      const el = contentRef.current;
      if (!el || !treeResizeRef.current) return;

      const { workspaceId } = treeResizeRef.current;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;

      // Read per-workspace panel state from store at event time.
      const store = useFileViewerStore.getState();
      const wsPreviewOpen = store.inlineFilePreviewByWorkspace[workspaceId]?.open ?? false;
      const wsPreviewLayout = store.inlineFilePreviewByWorkspace[workspaceId]?.layout ?? 'full';
      const wsPreviewWidthRatio =
        store.inlineFilePreviewWidthByWorkspace[workspaceId] ?? INLINE_PREVIEW_DEFAULT_WIDTH_RATIO;

      // Compute candidate tree width, then resolve preview against remaining space
      const deltaX = treeResizeRef.current.startX - event.clientX;
      const candidateTreePx = Math.max(0, treeResizeRef.current.startWidthPx + deltaX);
      const previewAvailable = rect.width - candidateTreePx;
      const wsPreviewWidthPx =
        wsPreviewOpen && wsPreviewLayout !== 'full'
          ? resolvePanelWidthPx(
              previewAvailable,
              wsPreviewWidthRatio,
              INLINE_PREVIEW_MIN_WIDTH_PX,
              INLINE_PREVIEW_MAX_WIDTH_PX
            )
          : 0;

      const reservedLeftPx = wsPreviewWidthPx > 0 ? wsPreviewWidthPx + RESIZE_HANDLE_WIDTH_PX : 0;
      const maxTreePx = rect.width - reservedLeftPx - RESIZE_HANDLE_WIDTH_PX;
      const widthPixels = clamp(candidateTreePx, 0, maxTreePx);
      const nextRatio = widthPixels / rect.width;
      setInlineFileTreeWidth(workspaceId, nextRatio);
    };

    const onMouseUp = () => {
      setIsResizingTree(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingTree, setInlineFileTreeWidth]);

  // The empty page and the Overview put the title bar on the sidebar's chrome (globals.css), so
  // the Windows window controls follow.
  const emptyWorkAreaShown = !selectedWorkspace && (showDashboard || hasLoaded);
  useEffect(() => {
    if (!emptyWorkAreaShown) return;
    return claimWindowsTitleBarOverlaySurface('chrome');
  }, [emptyWorkAreaShown]);

  // No workspace selected — show dashboard if requested, empty state if no active workspaces
  const emptyState = renderTerminalTabsEmptyState({
    selectedWorkspaceId,
    selectedWorkspace,
    showDashboard,
    hasLoaded,
    hasActiveWorkspaces,
    hasAnyWorkspaces,
    isRestarting,
    restartAgent,
    sidebarCollapsed,
    onNewWorkspaceDialogChange,
  });
  // The Overview covers the workspace layers instead of replacing them, so opening and closing it
  // doesn't unmount and rebuild every workspace's terminals and panels.
  const showsOverview = showDashboard && !selectedWorkspace;
  if (emptyState && !showsOverview) {
    return (
      <>
        <SetupActivityNotificationCenter />
        {emptyState}
      </>
    );
  }
  // renderTerminalTabsEmptyState covered these cases, but TS can't narrow through the call.
  if (!showsOverview && (!selectedWorkspaceId || !selectedWorkspace)) {
    return <SetupActivityNotificationCenter />;
  }

  return (
    <div ref={contentCallbackRef} className="relative flex h-full min-h-0 flex-row">
      <SetupActivityNotificationCenter />
      {showsOverview && <div className="absolute inset-0 z-20">{emptyState}</div>}
      {/* Left side: tab bar + terminal content */}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={showsOverview ? { visibility: 'hidden' } : undefined}
      >
        {/* Tab bar: the top of the window, so its empty space drags the window. On Windows the
            caption buttons are drawn over its right end. */}
        {selectedWorkspaceId && selectedWorkspace && (
          <div
            data-testid="workspace-top-row"
            className="drag-region relative flex shrink-0 items-stretch bg-card shadow-[inset_0_-1px_0_oklch(var(--border))]"
            style={{ height: topRowHeightPx }}
          >
            <SidebarExpandButton trafficLightInset className="gap-0.5 pr-1 pl-1.5">
              {renderCollapsedSidebarControls?.()}
            </SidebarExpandButton>
            {/* Terminal tabs are hidden in full preview/browser mode — the
                terminals aren't on screen anyway, so the preview header takes
                the whole bar (and we skip the now-pointless attention badges). */}
            {!isInlinePreviewFullscreen && (
              // The new-tab and Action buttons sit outside the scroller so they never
              // scroll away: `+` follows the tabs, the Action button takes the rest
              // of the row, pinned right. With nothing to the right, leave room for
              // the absolutely positioned browser/file-panel toggles.
              <div
                data-testid="terminal-tab-row"
                className="flex h-full min-w-0 flex-1 items-center"
                style={
                  {
                    paddingRight: isInlinePreviewOpen ? undefined : topRowEndReservePx,
                    '--tab-surface': terminalBackground,
                  } as React.CSSProperties
                }
              >
                <TabStripScroller
                  activeTabId={activeTabId}
                  tabsKey={openTabs.join('\n')}
                  room={tabRoom}
                  className="flex h-full min-w-0 items-stretch"
                >
                  {openTabs.map((terminalId, tabIndex) => {
                    // A tab is "active" if it's the currently selected tab
                    const isActive = terminalId === activeTabId;
                    // A tab is "visible" if its terminal appears in the current layout (for split views)
                    const visible = isActive || isTabVisible(terminalId);
                    const terminalContentVisible = visible && !isInlinePreviewFullscreen;
                    const tabPaneIds = getTerminalIdsForTab(terminalId);
                    const tabTerminals = tabPaneIds
                      .map((id) => terminalById.get(id))
                      .filter((terminal): terminal is Terminal => !!terminal);
                    const tabSurfaceKinds = new Set(tabPaneIds.map(getPaneSurfaceKind));
                    const tabSurfaceIcons = TAB_SURFACE_ICONS.filter(({ kind }) =>
                      tabSurfaceKinds.has(kind)
                    );
                    const {
                      showSpinner: showTerminalSpinner,
                      commandsOnly: terminalCommandsOnly,
                      attention: terminalAttention,
                    } = getTabAttentionDisplay(
                      tabTerminals,
                      terminalContentVisible,
                      isActive ? activeFocusedTerminalId : null
                    );
                    const isTabClosing = tabTerminals.some((terminal) =>
                      closingTerminalIds.has(terminal.id)
                    );
                    const attentionAppearance = getWorkspaceAttentionAppearance(terminalAttention);
                    const tabName = getTabName(terminalId);
                    const tabLabel = getTerminalTabLabel(
                      tabName,
                      attentionAppearance,
                      showTerminalSpinner,
                      terminalCommandsOnly
                    );
                    const tabLayout = layoutsByTab[selectedWorkspaceId]?.[terminalId];
                    const otherTabIds = openTabs.filter((tabId) => tabId !== terminalId);
                    return (
                      <ContextMenu key={terminalId}>
                        <ContextMenuTrigger asChild>
                          <div
                            className={cn(
                              // Half a pixel off the top, one device pixel on Retina screens, so the
                              // active tab's outline shows there. The first tab meets the work area
                              // card's left edge like the terminal below it, without an outline.
                              'group/tab relative flex w-[180px] min-w-[96px] items-stretch pt-[0.5px] xl:w-[220px]',
                              firstTabAtEdge && tabIndex === 0 ? 'pr-px' : 'px-px',
                              draggedTabId === terminalId && 'opacity-50',
                              dropTarget?.tabId === terminalId &&
                                dropTarget.position === 'before' &&
                                'drop-indicator-left',
                              dropTarget?.tabId === terminalId &&
                                dropTarget.position === 'after' &&
                                'drop-indicator-right',
                              paneDropTabId === terminalId && 'ring-2 ring-inset ring-primary'
                            )}
                            data-tab-id={terminalId}
                            draggable={!isTabClosing}
                            onDragStart={(e) => handleTabDragStart(e, terminalId)}
                            onDragEnd={handleTabDragEnd}
                            onDragOver={(e) => handleTabDragOver(e, terminalId)}
                            onDragLeave={handleTabDragLeave}
                            onDrop={(e) => handleTabDrop(e, terminalId)}
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              aria-label={tabLabel}
                              onClick={() => handleTabClick(terminalId)}
                              // Middle-click closes, as in browsers; preventing the
                              // mousedown stops autoscroll/paste on Windows and Linux.
                              onMouseDown={(e) => {
                                if (e.button === 1) e.preventDefault();
                              }}
                              onAuxClick={(e) => {
                                if (e.button !== 1) return;
                                e.preventDefault();
                                if (!isTabClosing) void handleCloseTab(terminalId);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleTabClick(terminalId);
                                }
                              }}
                              className={cn(
                                'relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-t-lg px-3 text-xs transition-colors',
                                isActive
                                  ? 'flat-tab-active joined-tab text-foreground'
                                  : visible
                                    ? 'text-foreground/80 hover:bg-foreground/[0.045] hover:text-foreground'
                                    : 'text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground',
                                firstTabAtEdge && tabIndex === 0 && 'edge-tab'
                              )}
                            >
                              {tabSurfaceIcons.length > 0 && (
                                <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                                  {tabSurfaceIcons.map(({ kind, label, icon }) => (
                                    <span key={kind} data-tab-surface={kind} title={label}>
                                      {icon}
                                    </span>
                                  ))}
                                </span>
                              )}
                              <TruncatedText
                                className="min-w-0 flex-1"
                                contentClassName={
                                  attentionAppearance ? ATTENTION_CARD_CLASS_NAME : undefined
                                }
                                details={
                                  terminalAttention &&
                                  attentionAppearance && (
                                    <div className="mt-1.5 border-t border-foreground/10 pt-1.5">
                                      <AttentionCard
                                        attention={terminalAttention}
                                        appearance={attentionAppearance}
                                      />
                                    </div>
                                  )
                                }
                              >
                                {tabName}
                              </TruncatedText>
                              <span className="relative ml-1 flex size-4 shrink-0 items-center justify-center">
                                {attentionAppearance && (
                                  <span
                                    className={cn(
                                      'size-2.5 rounded-full transition-opacity group-hover/tab:opacity-0 group-focus-within/tab:opacity-0',
                                      attentionAppearance.dotClassName
                                    )}
                                  />
                                )}
                                {showTerminalSpinner && !attentionAppearance && (
                                  <Spinner
                                    size="xs"
                                    className="text-muted-foreground transition-opacity group-focus-within/tab:opacity-0 group-hover/tab:opacity-0"
                                  />
                                )}
                                <button
                                  type="button"
                                  aria-label={
                                    isTabClosing ? 'Closing terminal tab' : 'Close terminal tab'
                                  }
                                  disabled={isTabClosing}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleCloseTab(terminalId);
                                  }}
                                  className={cn(
                                    'absolute inset-0 flex items-center justify-center rounded p-0.5 transition-opacity',
                                    isTabClosing
                                      ? 'cursor-wait opacity-100'
                                      : 'opacity-0 hover:bg-muted/80 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100'
                                  )}
                                >
                                  {isTabClosing ? <Spinner size="xs" /> : <X className="size-3" />}
                                </button>
                              </span>
                            </div>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            disabled={isTabClosing}
                            onSelect={() => void handleSplitWithTab(terminalId, 'vertical')}
                          >
                            <SquareSplitHorizontal />
                            Split Right
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={isTabClosing}
                            onSelect={() => void handleSplitWithTab(terminalId, 'horizontal')}
                          >
                            <SquareSplitVertical />
                            Split Down
                          </ContextMenuItem>
                          {tabLayout?.type === 'leaf' && otherTabIds.length > 0 && (
                            <ContextMenuSub>
                              <ContextMenuSubTrigger disabled={isTabClosing}>
                                <ArrowSquareIn />
                                Move to Tab
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="max-w-xs">
                                {otherTabIds.map((tabId) => (
                                  <ContextMenuItem
                                    key={tabId}
                                    onSelect={() => handleMoveTabInto(terminalId, tabId)}
                                  >
                                    <span className="truncate">{getTabName(tabId)}</span>
                                  </ContextMenuItem>
                                ))}
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                          )}
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            disabled={isTabClosing}
                            onSelect={() => void handleCloseTab(terminalId)}
                          >
                            {isTabClosing ? <Spinner size="sm" /> : <X />}
                            {isTabClosing ? 'Closing Tab' : 'Close Tab'}
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={isTabClosing || otherTabIds.length === 0}
                            onSelect={() => handleCloseOtherTabs(terminalId)}
                          >
                            <span aria-hidden className="size-3.5" />
                            Close Other Tabs
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={isTabClosing || tabIndex === openTabs.length - 1}
                            onSelect={() => handleCloseTabsToRight(terminalId)}
                          >
                            <span aria-hidden className="size-3.5" />
                            Close Tabs to the Right
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </TabStripScroller>
                <div className="flex shrink-0 items-center pl-0.5">
                  <NewTabButton
                    workspaceId={selectedWorkspaceId}
                    onNewTerminal={() => void handleCreateTerminal()}
                    terminalOptions={
                      showLocalMirrorButton
                        ? [
                            {
                              label: 'New Local copy terminal',
                              icon: <Desktop />,
                              onSelect: () => void handleCreateLocalMirrorTerminal(),
                            },
                          ]
                        : []
                    }
                    dropActive={paneDropOnNewTab}
                    onDragOver={handleNewTabDragOver}
                    onDragLeave={handleNewTabDragLeave}
                    onDrop={handleNewTabDrop}
                  />
                </div>
                <ActionTabButton workspaceId={selectedWorkspaceId} tabRoom={tabRoom} />
                <TabRowBranchControls />
              </div>
            )}
            {renderInlinePreviewHeader({
              isInlinePreviewOpen,
              isInlinePreviewFullscreen,
              isFileTreeOpen,
              endReservePx: topRowEndReservePx,
              contentWidth,
              resolvedPreviewWidthPx,
              previewFilePath,
              previewNoteTitle,
              previewFileStats: previewFileChange
                ? {
                    additions: previewFileChange.additions,
                    deletions: previewFileChange.deletions,
                  }
                : null,
              previewIsDirty,
              previewMode,
              previewHideUnchanged,
              setDiffHideUnchangedRegions,
              previewTotalChanges,
              changeNavRef,
              inlinePreviewLayout,
              selectedWorkspaceId,
              setInlineFilePreviewLayout,
              handleOpenPreviewFullscreen,
              previewCloseRef,
              layoutAttention: previewLayoutAttention,
            })}
            {isTreeInTopRow && (
              <div
                // The tree's Diff/Files tabs on macOS. Elsewhere it only holds the tree's width,
                // so a preview's header stays over the preview pane.
                data-inline-file-preview-scope={selectedWorkspaceId ?? undefined}
                className={cn(
                  'relative flex h-full shrink-0 items-stretch',
                  treeTabsOnTop && 'overflow-hidden rounded-tl-[14px] border-l border-foreground/15'
                )}
                style={
                  contentWidth > 0
                    ? { width: resolvedTreeWidthPx, flexShrink: 0, flexGrow: 0 }
                    : { width: 0, overflow: 'hidden' }
                }
              >
                {treeTabsOnTop && selectedWorkspaceId && (
                  // Measured, so the panel stays wide enough for these and the corner buttons.
                  <div ref={treeTabsRef} className="flex items-stretch">
                    <FileTreeModeTabs
                      workspaceId={selectedWorkspaceId}
                      isGitWorkspace={isGitWorkspace}
                    />
                  </div>
                )}
              </div>
            )}
            {/* Globe + sidebar toggles live outside the file-tree conditional so
                toggling the tree never remounts them. Rendering them in both
                branches let React reconcile the file-tree tab buttons into these
                buttons, animating `transition-colors` through bg-card — a white flash. */}
            <div
              ref={topRowActionsRef}
              className="no-drag absolute top-1/2 z-[2] flex h-7 -translate-y-1/2 items-center pr-1"
              style={{ right: topRowCaptionWidthPx }}
            >
              {selectedWorkspaceId && (
                <BrowserLinksPopover workspaceId={selectedWorkspaceId}>
                  <IconButton
                    label="Open in default browser"
                    className="rounded-md hover:bg-muted/60"
                  >
                    <Globe className="size-3.5" />
                  </IconButton>
                </BrowserLinksPopover>
              )}
              <FileTreeToggleButton workspaceId={selectedWorkspaceId} />
              {window.api.platform === 'linux' && (
                <>
                  <span aria-hidden className="mx-2 h-4 w-px shrink-0 bg-foreground/15" />
                  <LinuxWindowControls />
                </>
              )}
            </div>
          </div>
        )}

        {/* Split container content - render ALL workspaces' tabs, hide inactive ones to preserve terminal state */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {openTabs.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-muted-foreground/60">
              <div className="text-center">
                <TerminalWindow className="mx-auto mb-3 size-10 opacity-40" />
                <p className="text-base font-medium">No terminals open</p>
                <p className="mt-1 text-sm opacity-70">Click + to open a new terminal</p>
              </div>
            </div>
          )}
          {Object.entries(tabsByWorkspace).map(([wsId, wsTabs]) => {
            const ws = workspaceById.get(wsId);
            if (!ws) return null;

            return (
              <WorkspaceLayer
                key={wsId}
                wsId={wsId}
                isCurrentWorkspace={wsId === selectedWorkspaceId}
                workingDirectory={ws.workingDirectory}
                isWorktree={!!ws.isWorktree}
                wsTabs={wsTabs}
                wsActiveTabId={activeTabByWorkspace[wsId] || null}
                layoutsByTab={layoutsByTab}
                previewCloseRef={previewCloseRef}
                changeNavRef={changeNavRef}
                setPreviewTotalChanges={setPreviewTotalChanges}
                contentWidth={contentWidth}
                treeMinWidthPx={treeMinWidthPx}
                isResizingPreview={isResizingPreview}
                onPreviewResizeStart={handlePreviewResizeStart}
                isResizingTree={isResizingTree}
                onTreeResizeStart={handleTreeResizeStart}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});
