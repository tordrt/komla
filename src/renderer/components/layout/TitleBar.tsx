import {
  Command,
  GearSix,
  Folder,
  MagnifyingGlass,
  ChatCircle,
  GitDiff,
  Lightbulb,
  Sparkle,
  type Icon,
} from '@phosphor-icons/react';
import React, { useState, useLayoutEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCommandCenterStore } from '@/stores/command-center.store';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useLicenseStore } from '@/stores/license.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { CommandCenterButton } from './CommandCenterButton';
import { EditorToolbarButton, useEditorOptions } from './EditorToolbarButton';
import { GettingStartedMenu } from './GettingStartedMenu';
import { LinuxWindowControls } from './LinuxWindowControls';
import { SidebarExpandButton } from './SidebarExpandButton';
import {
  isOpenInEditorShownOutsideStatusBar,
  tipsInStatusBar,
} from './status-bar/status-bar-items';
import { TargetBranchSelector } from './TargetBranchSelector';
import {
  TITLE_BAR_ICON_BUTTON_CLASS,
  MAC_TRAFFIC_LIGHT_INSET_PX,
  WINDOWS_CAPTION_BUTTONS_WIDTH_PX,
} from './title-bar-metrics';
import { UnifiedMenu } from './UnifiedMenu';

import type { SettingsDialogTarget } from '@/stores/settings-dialog.store';

/** Below this content width (px), title-bar text labels collapse to icons. */
const TITLE_BAR_COMPACT_WIDTH_PX = 1024;

/** Tracks whether the title bar is too narrow for text labels. */
function useCompactTitleBar(ref: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Linux draws its window controls inside the content, but Windows keeps its caption buttons
    // outside it. Count them on Windows too, so labels collapse at the same window width.
    const captionWidth = window.api.platform === 'win32' ? WINDOWS_CAPTION_BUTTONS_WIDTH_PX : 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setCompact(width > 0 && width + captionWidth < TITLE_BAR_COMPACT_WIDTH_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return compact;
}

// A hairline between Komla's own buttons and the window controls, an even step from each.
const WINDOW_CONTROLS_DIVIDER_CLASS = 'h-4 w-px shrink-0 bg-foreground/15';

interface TitleBarProps {
  /**
   * The sidebar sits beside the title bar and holds the settings menu and Tips; on macOS also the
   * traffic lights and Command center.
   */
  sidebarVisible?: boolean;
  onOpenSettings?: () => void;
  onOpenShortcuts?: () => void;
  onOpenFeedback?: () => void;
  onOpenUpgrade?: () => void;
  onOpenSettingsTab?: (tab: string, target?: Omit<SettingsDialogTarget, 'tab'>) => void;
  onOpenNewWorkspace?: () => void;
  onOpenCommandCenter?: () => void;
}

/** Tips needs every action its tips link to; without them it isn't shown at all. */
function getTipsActions({
  onOpenShortcuts,
  onOpenFeedback,
  onOpenSettingsTab,
  onOpenNewWorkspace,
}: TitleBarProps) {
  return onOpenShortcuts && onOpenFeedback && onOpenSettingsTab && onOpenNewWorkspace
    ? { onOpenShortcuts, onOpenFeedback, onOpenSettingsTab, onOpenNewWorkspace }
    : null;
}

export function TitleBar({
  sidebarVisible = false,
  onOpenSettings,
  onOpenShortcuts,
  onOpenFeedback,
  onOpenUpgrade,
  onOpenSettingsTab,
  onOpenNewWorkspace,
  onOpenCommandCenter,
}: TitleBarProps) {
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectedWorkspace = useWorkspacesStore((s) =>
    s.selectedWorkspaceId ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId) : null
  );
  const isFullscreen = useWindowStore((s) => s.isFullscreen);
  const { fileViewerMode, requestFileViewerTransition } = useFileViewerStore();
  const toggleCommandCenter = useCommandCenterStore((s) => s.toggle);
  const fileTreeShortcut = useShortcutsStore((s) => s.getDisplayShortcut('file.tree'));
  const diffToggleShortcut = useShortcutsStore((s) => s.getDisplayShortcut('diff.toggle'));
  const fileOpenShortcut = useShortcutsStore((s) => s.getDisplayShortcut('file.open'));
  const quota = useLicenseStore((s) => s.quota);
  const { config, updateConfig } = useConfigStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const compact = useCompactTitleBar(contentRef);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [tipsOpen, setTipsOpen] = useState(false);
  const openTipsOnMoreClose = useRef(false);
  // Tips lives in the status bar; the settings menu offers it while the status bar doesn't show it.
  const tipsInMore = !tipsInStatusBar(config);
  const tipsActions = getTipsActions({
    onOpenShortcuts,
    onOpenFeedback,
    onOpenSettingsTab,
    onOpenNewWorkspace,
  });

  const { allOptions, defaultOption, workspacePath, handleOpen } = useEditorOptions();

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  const isGitWorkspace = !!selectedWorkspace?.isWorktree;
  const effectiveFileViewerMode = isGitWorkspace ? fileViewerMode : 'browse';
  // The sidebar carries the traffic lights when it is shown.
  const macLeftPadding =
    window.api.platform === 'darwin'
      ? isFullscreen || sidebarVisible
        ? 0
        : MAC_TRAFFIC_LIGHT_INSET_PX
      : undefined;

  const handleSegmentClick = (mode: 'browse' | 'diff') => {
    if (!selectedWorkspaceId) return;
    requestFileViewerTransition({ kind: 'toggle', workspaceId: selectedWorkspaceId, mode });
  };

  return (
    <div
      data-testid="title-bar"
      data-komla-title-bar="true"
      className={`${window.api.platform === 'win32' ? 'h-10' : 'h-9'} relative w-full shrink-0 border-b border-border/40 bg-card`}
      style={{
        // Make the title bar draggable for window movement
        WebkitAppRegion: 'drag',
        // Platform-specific padding for native window controls
        ...(window.api.platform === 'darwin'
          ? { paddingLeft: macLeftPadding } // macOS traffic lights on left
          : window.api.platform === 'win32'
            ? { paddingRight: WINDOWS_CAPTION_BUTTONS_WIDTH_PX } // Windows overlay controls on right
            : {}), // Linux: WM handles its own controls
      }}
    >
      <div ref={contentRef} className="flex h-full items-center justify-between gap-2 px-4">
        {/* Shrinks and clips first so the actions on the right always stay on screen. */}
        <div className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {/* Shows only while the sidebar is collapsed. */}
          <SidebarExpandButton className="-ml-2" />
          {selectedWorkspaceId && (
            <FileViewerTabs
              mode={effectiveFileViewerMode}
              isGitWorkspace={isGitWorkspace}
              compact={compact}
              noDrag={noDrag}
              fileTreeShortcut={fileTreeShortcut}
              diffToggleShortcut={diffToggleShortcut}
              fileOpenShortcut={fileOpenShortcut}
              onSegmentClick={handleSegmentClick}
              onToggleFileSearch={() => toggleCommandCenter('files')}
            />
          )}
          <UnifiedMenu />
          <TargetBranchSelector />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selectedWorkspaceId && workspacePath && isOpenInEditorShownOutsideStatusBar(config) && (
            <EditorToolbarButton
              allOptions={allOptions}
              defaultOption={defaultOption}
              noDrag={noDrag}
              onOpen={handleOpen}
              onSetDefault={(id) => void updateConfig({ defaultEditor: id })}
            />
          )}
          {onOpenCommandCenter && !sidebarVisible && (
            <CommandCenterButton
              className={TITLE_BAR_ICON_BUTTON_CLASS}
              style={noDrag}
              onClick={onOpenCommandCenter}
            />
          )}
          {tipsActions && !sidebarVisible && tipsInMore && (
            <GettingStartedMenu
              {...tipsActions}
              open={tipsOpen}
              onOpenChange={setTipsOpen}
              anchorRef={moreButtonRef}
            />
          )}
          {!sidebarVisible && (onOpenSettings || onOpenShortcuts || onOpenFeedback) && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  ref={moreButtonRef}
                  label="Settings"
                  data-tips-home="settings menu"
                  className={TITLE_BAR_ICON_BUTTON_CLASS}
                  style={noDrag}
                >
                  <GearSix className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-40 min-w-0"
                // Focus goes back to the gear before Tips opens. Arriving there after Tips
                // has opened, it would count as leaving Tips and close it at once.
                onCloseAutoFocus={(event) => {
                  if (!openTipsOnMoreClose.current) return;
                  openTipsOnMoreClose.current = false;
                  event.preventDefault();
                  moreButtonRef.current?.focus();
                  setTipsOpen(true);
                }}
              >
                {onOpenSettings && (
                  <DropdownMenuItem onClick={onOpenSettings}>
                    <GearSix />
                    Settings
                  </DropdownMenuItem>
                )}
                {onOpenShortcuts && (
                  <DropdownMenuItem onClick={onOpenShortcuts}>
                    <Command />
                    Shortcuts
                  </DropdownMenuItem>
                )}
                {tipsActions && tipsInMore && (
                  <DropdownMenuItem
                    onClick={() => {
                      openTipsOnMoreClose.current = true;
                    }}
                  >
                    <Lightbulb />
                    Tips
                  </DropdownMenuItem>
                )}
                {onOpenFeedback && (
                  <>
                    {(onOpenSettings || onOpenShortcuts) && <DropdownMenuSeparator />}
                    <DropdownMenuItem onClick={onOpenFeedback}>
                      <ChatCircle />
                      Feedback
                    </DropdownMenuItem>
                  </>
                )}
                {quota?.isLicensed === false && onOpenUpgrade && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onOpenUpgrade}>
                      <Sparkle />
                      Upgrade
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Linux custom window controls */}
          {window.api.platform === 'linux' && (
            <>
              <div
                data-testid="window-controls-divider"
                aria-hidden
                className={`mx-2 ${WINDOW_CONTROLS_DIVIDER_CLASS}`}
              />
              <LinuxWindowControls />
            </>
          )}
        </div>
      </div>
      {/* At the edge of the Windows caption buttons, as far from the first one as from the gear. */}
      {window.api.platform === 'win32' && (
        <div
          data-testid="window-controls-divider"
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${WINDOW_CONTROLS_DIVIDER_CLASS}`}
          style={{ right: WINDOWS_CAPTION_BUTTONS_WIDTH_PX + 2 }}
        />
      )}
    </div>
  );
}

function LabelWithShortcut({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </span>
  );
}

interface FileViewerSegmentProps {
  label: string;
  icon: Icon;
  roundedClassName: string;
  /** Shows the label next to the icon. */
  wide: boolean;
  shortcut: string;
  onClick: () => void;
}

function FileViewerSegment({
  label,
  icon: SegmentIcon,
  roundedClassName,
  wide,
  shortcut,
  onClick,
}: FileViewerSegmentProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`flex h-8 items-center justify-center gap-1 ${roundedClassName} text-xs text-muted-foreground transition-colors hover:text-foreground`}
          style={{ width: wide ? 56 : 30 }}
          onClick={onClick}
        >
          <SegmentIcon className="size-3.5 shrink-0" />
          {wide && <span className="text-xs font-medium">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <LabelWithShortcut label={label} shortcut={shortcut} />
      </TooltipContent>
    </Tooltip>
  );
}

interface FileViewerTabsProps {
  mode: 'browse' | 'diff';
  isGitWorkspace: boolean;
  /** Icons only, for a narrow title bar. */
  compact: boolean;
  noDrag: React.CSSProperties;
  fileTreeShortcut: string;
  diffToggleShortcut: string;
  fileOpenShortcut: string;
  onSegmentClick: (mode: 'browse' | 'diff') => void;
  onToggleFileSearch: () => void;
}

function FileViewerTabs({
  mode,
  isGitWorkspace,
  compact,
  noDrag,
  fileTreeShortcut,
  diffToggleShortcut,
  fileOpenShortcut,
  onSegmentClick,
  onToggleFileSearch,
}: FileViewerTabsProps) {
  const browseWide = !compact && (!isGitWorkspace || mode === 'browse');
  const diffWide = !compact && mode === 'diff';
  return (
    <>
      <div
        className="no-drag -mb-px flex shrink-0 items-center !rounded-t-md !rounded-b-none px-1"
        style={noDrag}
      >
        <FileViewerSegment
          label="Files"
          icon={Folder}
          roundedClassName="rounded-tl-md"
          wide={browseWide}
          shortcut={fileTreeShortcut}
          onClick={() => onSegmentClick('browse')}
        />
        {isGitWorkspace && (
          <FileViewerSegment
            label="Diff"
            icon={GitDiff}
            roundedClassName="rounded-tr-md"
            wide={diffWide}
            shortcut={diffToggleShortcut}
            onClick={() => onSegmentClick('diff')}
          />
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Search"
            className={`no-drag h-7 shrink-0 gap-1.5 ${compact ? 'w-7 px-0' : 'px-2'}`}
            style={noDrag}
            onClick={onToggleFileSearch}
          >
            <MagnifyingGlass className="size-4" />
            {!compact && <span className="text-xs font-medium">Search</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <LabelWithShortcut label="Search" shortcut={fileOpenShortcut} />
        </TooltipContent>
      </Tooltip>
    </>
  );
}
