import {
  AppWindow,
  ArrowLeft,
  ArrowLineDown,
  BellRinging,
  CaretRight,
  ClockCounterClockwise,
  Command,
  Eye,
  EyeSlash,
  File,
  FolderOpen,
  GearSix,
  GitBranch,
  GitDiff,
  MagnifyingGlass,
  Microphone,
  NotePencil,
  Plus,
  Robot,
  SidebarSimple,
  SquareSplitHorizontal,
  SquareSplitVertical,
  SquaresFour,
  Stop,
  TerminalWindow,
  TextAa,
  Trash,
  TreeStructure,
  X,
  type Icon,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useListRef } from 'react-window';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import {
  WorkingAgentsGlyph,
  workingAgentCount,
  workingAgentsLabel,
  workingCommandCount,
} from '@/components/workspaces/agent-state';
import {
  openFileSearchResult,
  resolveOpenTarget,
  type OpenTarget,
} from '@/components/workspaces/file-viewer/search-open-target';
import { getWorkspaceDisplayTitle } from '@/components/workspaces/WorkspaceInfoCard';
import { shortcutEntries } from '@/constants/shortcut-entries';
import { formatRelativeTime } from '@/lib/format-time';
import { openWorkspace } from '@/lib/open-workspace';
import { openFilePane } from '@/lib/pane-surfaces';
import { executeShortcutAction, hasShortcutAction } from '@/lib/shortcut-actions';
import { cn } from '@/lib/utils';
import { getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import {
  isFileMode,
  type CommandCenterFileMode,
  type CommandCenterMode,
} from '@/stores/command-center.store';
import { useConfigStore } from '@/stores/config.store';
import { NEW_WORKSPACE_DIALOG_EVENT } from '@/stores/dialogs.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { formatShortcutForDisplay, useShortcutsStore } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  buildCommandCenterResults,
  COMMANDS_ONLY_PREFIX,
  matchCommands,
  type CommandCenterCommand,
  type CommandCenterSection,
  type CommandCenterWorkspaceResult,
} from './command-center-model';
import { FileSearchResults, type PickModifiers } from './FileSearchResults';
import { useCommandCenterFileSearch } from './useCommandCenterFileSearch';

import type { Project, Workspace } from '@/types';

interface CommandItem extends CommandCenterCommand {
  icon: ReactNode;
  /** Display form of the keys that run it directly. */
  shortcut?: string;
  /** Shows another list in the dialog, which stays open. */
  opensView?: boolean;
  run: () => void;
}

type ResultOption =
  | { kind: 'workspace'; key: string; result: CommandCenterWorkspaceResult }
  | { kind: 'command'; key: string; command: CommandItem };

interface ResultSection {
  key: string;
  label: string;
  options: { option: ResultOption; index: number }[];
}

// Relative moves are meant to be pressed repeatedly, and the range row is nine actions.
// File search is offered as its two modes instead.
const SHORTCUTS_NOT_OFFERED = new Set([
  'commandCenter.open',
  'file.open',
  'workspace.next',
  'workspace.previous',
  'tab.next',
  'tab.previous',
  'pane.focusNext',
  'pane.focusPrev',
]);

// Always registered, though they do nothing without an open workspace to act on.
const WORKSPACE_ACTIONS = new Set([
  'workspace.stop',
  'workspace.trash',
  'workspace.delete',
  'diff.toggle',
  'history.toggle',
  'tab.newAgent',
  'terminal.new',
  'file.open',
  'file.tree',
  'inline.file.tree',
  'note.new',
]);

const COMMAND_ICONS: Record<string, Icon> = {
  'workspace.overview': SquaresFour,
  'workspace.new': Plus,
  'workspace.newIn': Plus,
  'workspace.openFolder': FolderOpen,
  'workspace.stop': Stop,
  'workspace.delete': Trash,
  'workspace.nextAttention': BellRinging,
  'sidebar.toggle': SidebarSimple,
  'diff.toggle': GitDiff,
  'history.toggle': ClockCounterClockwise,
  'tab.newAgent': Robot,
  'terminal.new': TerminalWindow,
  'terminal.scrollToBottom': ArrowLineDown,
  'terminal.search': MagnifyingGlass,
  'pane.close': X,
  'pane.splitRight': SquareSplitHorizontal,
  'pane.splitDown': SquareSplitVertical,
  'search.files': File,
  'search.content': TextAa,
  'file.tree': TreeStructure,
  'inline.file.tree': SidebarSimple,
  'note.new': NotePencil,
  'voice.record': Microphone,
  'settings.open': GearSix,
  'window.new': AppWindow,
};

function commandIcon(id: string): ReactNode {
  const CommandIcon = COMMAND_ICONS[id] ?? Command;
  return <CommandIcon className="size-4 shrink-0 text-muted-foreground" />;
}

/** Listed under Actions, in this order, before anything is typed; first among commands. */
// Few enough that recent workspaces still show below them.
const FEATURED_COMMANDS = [
  'workspace.new',
  'workspace.newIn',
  'tab.newAgent',
  'search.files',
  'settings.open',
];

function featuredRank(command: CommandItem): number {
  const rank = FEATURED_COMMANDS.indexOf(command.id);
  return rank === -1 ? FEATURED_COMMANDS.length : rank;
}

function openNewWorkspaceDialog(project: Project) {
  window.dispatchEvent(
    new CustomEvent(NEW_WORKSPACE_DIALOG_EVENT, { detail: { projectId: project.id } })
  );
}

function canActOn(action: string, workspace: Workspace | undefined): boolean {
  if (!WORKSPACE_ACTIONS.has(action)) return true;
  if (!workspace) return false;
  // As in ShortcutProvider: diffs and history need git.
  if (action === 'diff.toggle' || action === 'history.toggle') return workspace.isWorktree;
  return true;
}

interface CommandViews {
  /** Switches to a file search mode, or null without a workspace to search. */
  searchIn: ((mode: CommandCenterFileMode) => void) | null;
  showProjects: () => void;
}

function buildCommands(
  projects: Project[],
  getDisplayShortcut: (action: string) => string,
  selectedWorkspace: Workspace | undefined,
  views: CommandViews
): CommandItem[] {
  // Other actions register only while they can run, such as pane actions while a tab is open.
  const shortcutCommands = shortcutEntries
    .filter(
      (entry) =>
        !entry.rangeActions &&
        !SHORTCUTS_NOT_OFFERED.has(entry.action) &&
        hasShortcutAction(entry.action) &&
        canActOn(entry.action, selectedWorkspace)
    )
    .map((entry) => ({
      id: entry.action,
      label: entry.label,
      icon: commandIcon(entry.action),
      shortcut: getDisplayShortcut(entry.action) || undefined,
      run: () => executeShortcutAction(entry.action),
    }));
  const projectCommands = projects.map((project) => ({
    id: `workspace.new:${project.id}`,
    label: `New workspace in ${project.name}`,
    icon: <ProjectMark project={project} iconClassName="size-4" />,
    run: () => openNewWorkspaceDialog(project),
  }));
  const { searchIn } = views;
  const searchCommands: CommandItem[] = searchIn
    ? [
        {
          id: 'search.files',
          label: 'Search files',
          icon: commandIcon('search.files'),
          shortcut: getDisplayShortcut('file.open') || undefined,
          opensView: true,
          run: () => searchIn('files'),
        },
        {
          id: 'search.content',
          label: 'Search in files',
          icon: commandIcon('search.content'),
          opensView: true,
          run: () => searchIn('content'),
        },
      ]
    : [];
  // With one project, New workspace already opens on it.
  const newInCommands: CommandItem[] =
    projects.length > 1
      ? [
          {
            id: 'workspace.newIn',
            label: 'New workspace in...',
            icon: commandIcon('workspace.newIn'),
            opensView: true,
            run: views.showProjects,
          },
        ]
      : [];
  return [
    ...shortcutCommands,
    ...newInCommands,
    ...projectCommands,
    ...searchCommands,
    {
      id: 'settings.open',
      label: 'Settings',
      icon: commandIcon('settings.open'),
      shortcut: formatShortcutForDisplay('Cmd+,'),
      run: () => useSettingsDialogStore.getState().openSettings(),
    },
    {
      id: 'window.new',
      label: 'New window',
      icon: commandIcon('window.new'),
      shortcut: formatShortcutForDisplay('Cmd+Shift+N'),
      run: () => void window.api.createWindow(),
    },
  ]
    .map((command) => ({ ...command, featured: FEATURED_COMMANDS.includes(command.id) }))
    .sort((a, b) => featuredRank(a) - featuredRank(b));
}

/** The projects that "New workspace in..." lists. */
function buildProjectSections(
  projects: Project[],
  query: string
): CommandCenterSection<CommandItem>[] {
  const items: CommandItem[] = projects.map((project) => ({
    id: `project:${project.id}`,
    label: project.name,
    icon: <ProjectMark project={project} iconClassName="size-4" />,
    run: () => openNewWorkspaceDialog(project),
  }));
  const matches = matchCommands(items, query);
  return matches.length > 0
    ? [
        {
          key: 'commands',
          label: 'New workspace in',
          items: matches.map((command) => ({ kind: 'command', command })),
        },
      ]
    : [];
}

/** When nothing matches, offers to search the open workspace's files for the query. */
function buildFileSearchOffers(
  query: string,
  workspace: Workspace | undefined,
  searchIn: (mode: CommandCenterFileMode) => void
): CommandCenterSection<CommandItem>[] {
  const trimmed = query.trim();
  if (!workspace || !trimmed || trimmed.startsWith(COMMANDS_ONLY_PREFIX)) return [];
  const offers: CommandItem[] = [
    {
      id: 'searchQuery.files',
      label: `Search files for "${trimmed}"`,
      icon: commandIcon('search.files'),
      // Tab goes to the same search.
      shortcut: 'Tab',
      opensView: true,
      run: () => searchIn('files'),
    },
    {
      id: 'searchQuery.content',
      label: `Search contents for "${trimmed}"`,
      icon: commandIcon('search.content'),
      opensView: true,
      run: () => searchIn('content'),
    },
  ];
  return [
    {
      key: 'commands',
      label: `Search in ${getWorkspaceDisplayTitle(workspace)}`,
      items: offers.map((command) => ({ kind: 'command', command })),
    },
  ];
}

function indexSections(sections: CommandCenterSection<CommandItem>[]): {
  sections: ResultSection[];
  options: ResultOption[];
} {
  const options: ResultOption[] = [];
  return {
    sections: sections.map((section) => ({
      key: section.key,
      label: section.label,
      options: section.items.map((item) => {
        const option: ResultOption =
          item.kind === 'workspace'
            ? { kind: 'workspace', key: item.result.workspace.id, result: item.result }
            : { kind: 'command', key: item.command.id, command: item.command };
        return { option, index: options.push(option) - 1 };
      }),
    })),
    options,
  };
}

const MODE_LABELS: Record<CommandCenterMode, string> = {
  workspaces: 'Workspaces',
  files: 'Files',
  content: 'Content',
};

const INPUT_LABELS: Record<CommandCenterMode, { label: string; placeholder: string }> = {
  workspaces: {
    label: 'Search workspaces and commands',
    placeholder: 'Search workspaces and commands',
  },
  files: { label: 'Search files by name', placeholder: 'Search files...' },
  content: { label: 'Search file contents', placeholder: 'Search in files...' },
};

const PROJECTS_INPUT_LABELS = { label: 'Search projects', placeholder: 'Search projects...' };

/** File search covers the open workspace's directory. */
function availableModesFor(workspace: Workspace | undefined): CommandCenterMode[] {
  if (!workspace?.workingDirectory) return ['workspaces'];
  return ['workspaces', 'files', 'content'];
}

/** Without a workspace to search, file modes fall back to workspaces. */
function resolveMode(mode: CommandCenterMode, available: CommandCenterMode[]): CommandCenterMode {
  return available.includes(mode) ? mode : 'workspaces';
}

function isCopyAtPathKey(event: KeyboardEvent<HTMLInputElement>): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c';
}

interface CommandCenterPanelProps {
  mode: CommandCenterMode;
  onModeChange: (mode: CommandCenterMode) => void;
  onClose: (options: { restoreFocus: boolean }) => void;
}

function CommandCenterPanel({ mode, onModeChange, onClose }: CommandCenterPanelProps) {
  // The highlighted row is tracked by key, so it stays put when live updates re-sort the list.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The dialog stays mounted while it animates out, so a repeated Enter must not pick again.
  const pickedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useListRef(null);
  const listboxId = useId();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const projects = useProjectsStore((s) => s.projects);
  const currentWindowId = useWindowStore((s) => s.windowId);
  const getDisplayShortcut = useShortcutsStore((s) => s.getDisplayShortcut);
  const matchesEvent = useShortcutsStore((s) => s.matchesEvent);
  const setFilePickerQuery = useFileViewerStore((s) => s.setFilePickerQuery);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);

  const fileWorkspace = selectedWorkspace?.workingDirectory ? selectedWorkspace : undefined;
  const fileWorkspaceId = fileWorkspace?.id;
  const availableModes = availableModesFor(fileWorkspace);
  const effectiveMode = resolveMode(mode, availableModes);
  const fileMode = isFileMode(effectiveMode) ? effectiveMode : null;
  const inFileMode = fileMode !== null;

  // File search starts from the query last searched in this workspace, selected to replace.
  const [query, setQuery] = useState(() =>
    inFileMode && fileWorkspaceId
      ? useFileViewerStore.getState().getFilePickerQuery(fileWorkspaceId)
      : ''
  );
  const files = useCommandCenterFileSearch(fileWorkspace, effectiveMode, query, setQuery);
  // "New workspace in..." lists the projects in place of the results.
  const [view, setView] = useState<'results' | 'projects'>('results');
  const inProjects = view === 'projects' && !inFileMode;

  const showView = useCallback((next: 'results' | 'projects', nextQuery = '') => {
    setView(next);
    setQuery(nextQuery);
    setActiveKey(null);
  }, []);

  const commands = useMemo(
    () =>
      buildCommands(projects, getDisplayShortcut, selectedWorkspace, {
        searchIn: fileWorkspaceId
          ? (next) => {
              onModeChange(next);
              // As when its shortcut opens it, file search starts from its remembered query.
              showView(
                'results',
                useFileViewerStore.getState().getFilePickerQuery(fileWorkspaceId)
              );
              requestAnimationFrame(() => inputRef.current?.select());
            }
          : null,
        showProjects: () => showView('projects'),
      }),
    [projects, getDisplayShortcut, selectedWorkspace, fileWorkspaceId, onModeChange, showView]
  );
  const found = useMemo(
    () =>
      inProjects
        ? buildProjectSections(projects, query)
        : buildCommandCenterResults({
            query,
            workspaces,
            projects,
            commands,
            currentWorkspaceId: selectedWorkspaceId,
          }),
    [inProjects, query, workspaces, projects, commands, selectedWorkspaceId]
  );
  const noResults = found.length === 0;
  // The query carries into file search, as when Tab switches to it.
  const searchQueryIn = useCallback(
    (next: CommandCenterFileMode) => {
      onModeChange(next);
      if (fileWorkspaceId) setFilePickerQuery(fileWorkspaceId, query);
    },
    [onModeChange, fileWorkspaceId, setFilePickerQuery, query]
  );
  const { sections, options } = useMemo(
    () =>
      indexSections(
        noResults && !inProjects
          ? buildFileSearchOffers(query, fileWorkspace, searchQueryIn)
          : found
      ),
    [noResults, inProjects, query, fileWorkspace, searchQueryIn, found]
  );
  const keyedIndex = options.findIndex((option) => option.key === activeKey);
  // Until the user picks a row, or once theirs is gone, the top result is the one Enter opens.
  const active = keyedIndex === -1 && options.length > 0 ? 0 : keyedIndex;

  const itemCount = inFileMode ? files.results.length : options.length;
  const activeIndex = inFileMode ? files.selectedIndex : active;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  // The list opens at the top, so the first row is in view until the highlight moves. Scrolling
  // to it anyway forces a style pass over the whole app while the dialog opens.
  const highlightMovedRef = useRef(false);
  useEffect(() => {
    if (inFileMode || active < 0) return;
    if (active === 0 && !highlightMovedRef.current) return;
    highlightMovedRef.current = true;
    document.getElementById(`${listboxId}-option-${active}`)?.scrollIntoView?.({
      block: 'nearest',
    });
  }, [inFileMode, active, listboxId]);

  // Select a remembered query so typing replaces it.
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  // File search keeps each workspace's last query for the next time it opens.
  const rememberFileQuery = (nextMode: CommandCenterMode, nextQuery: string) => {
    if (isFileMode(nextMode) && fileWorkspaceId) setFilePickerQuery(fileWorkspaceId, nextQuery);
  };

  const changeMode = (next: CommandCenterMode) => {
    onModeChange(next);
    rememberFileQuery(next, query);
    setView('results');
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option || pickedRef.current) return;
    if (option.kind === 'command' && option.command.opensView) {
      option.command.run();
      return;
    }
    pickedRef.current = true;
    if (option.kind === 'command') {
      onClose({ restoreFocus: true });
      option.command.run();
      return;
    }
    const { workspace } = option.result;
    // Here, a workspace's terminal takes focus once it shows. When it already shows,
    // or another window shows it, focus goes back to where it was.
    const opensElsewhere =
      workspace.status === 'active' &&
      workspace.windowId !== null &&
      workspace.windowId !== currentWindowId;
    onClose({ restoreFocus: opensElsewhere || workspace.id === selectedWorkspaceId });
    void openWorkspace(workspace, currentWindowId);
  };

  const pickFile = (index: number, modifiers: PickModifiers) => {
    const result = files.results[index];
    if (!result || !fileWorkspaceId || pickedRef.current) return;
    pickedRef.current = true;
    // Cmd/Ctrl opens the file in a tab of its own among the terminals, whose editor takes focus.
    if (modifiers.metaKey || modifiers.ctrlKey) {
      onClose({ restoreFocus: false });
      openFilePane(fileWorkspaceId, result.path, { kind: 'tab' }, result.lineNumber);
      return;
    }
    onClose({ restoreFocus: true });
    openFileSearchResult(
      fileWorkspaceId,
      result.path,
      result.lineNumber,
      resolveOpenTarget(modifiers.shiftKey, files.defaultOpenMode)
    );
  };

  const copyAtPath = () => {
    const path = files.results[activeIndex]?.path;
    if (!path) return;
    const atPath = `@${path}`;
    // Trailing space so the user can keep typing after paste without having
    // to reach for space themselves. Toast shows the logical value (no
    // trailing space); the clipboard has the space.
    window.api.copyToClipboard(`${atPath} `);
    useToastStore.getState().addToast(`Copied ${atPath}`, 'success');
    onClose({ restoreFocus: true });
  };

  const highlight = (index: number) => {
    if (inFileMode) {
      files.setSelectedIndex(index);
      listRef.current?.scrollToRow({ index, align: 'smart' });
    } else {
      setActiveKey(options[index].key);
    }
  };

  const cycleMode = () => {
    const current = availableModes.indexOf(effectiveMode);
    changeMode(availableModes[(current + 1) % availableModes.length]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter and the arrows belong to an input method while it composes text.
    if (event.nativeEvent.isComposing) return;
    if (matchesEvent('commandCenter.open', event.nativeEvent)) {
      event.preventDefault();
      if (inFileMode) changeMode('workspaces');
      else onClose({ restoreFocus: true });
      return;
    }
    if (inFileMode && isCopyAtPathKey(event)) {
      event.preventDefault();
      copyAtPath();
      return;
    }
    switch (event.key) {
      // Shift+Tab, and Tab with no other mode, move focus to the controls beside the input.
      case 'Tab': {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        if (availableModes.length < 2 || inProjects) return;
        event.preventDefault();
        cycleMode();
        break;
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        if (itemCount === 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        highlight((activeIndex + step + itemCount) % itemCount);
        break;
      }
      case 'Enter':
        event.preventDefault();
        if (inFileMode) pickFile(activeIndex, event);
        else pick(active);
        break;
      case 'Backspace':
        if (!inProjects || query) return;
        event.preventDefault();
        showView('results');
        break;
    }
  };

  // Without an open workspace, file search shows as unavailable.
  const available = new Set(availableModes);
  const shownModes = fileWorkspace
    ? availableModes
    : (Object.keys(MODE_LABELS) as CommandCenterMode[]);
  const modeOptions = shownModes.map((value) => ({
    value,
    label: MODE_LABELS[value],
    disabled: !available.has(value),
    title: available.has(value) ? undefined : 'Open a workspace to search its files',
  }));
  const inputLabels = inProjects ? PROJECTS_INPUT_LABELS : INPUT_LABELS[effectiveMode];
  const activeOption = inFileMode ? undefined : options[active];

  return (
    <div className="flex min-h-0 flex-col" style={inFileMode ? files.projectColorStyle : undefined}>
      <div className="flex h-12 items-center gap-2 border-b border-foreground/10 px-3">
        {inProjects ? (
          <IconButton
            label="Back"
            size="xs"
            tooltipSide="bottom"
            className="-ml-1"
            onClick={() => {
              showView('results');
              inputRef.current?.focus();
            }}
          >
            <ArrowLeft className="size-4" />
          </IconButton>
        ) : (
          <MagnifyingGlass className="size-4 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={inputLabels.label}
          aria-expanded={itemCount > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveKey(null);
            rememberFileQuery(effectiveMode, event.target.value);
            // A new query selects its top result, so show it.
            if (inFileMode) listRef.current?.scrollToRow({ index: 0 });
          }}
          onKeyDown={handleKeyDown}
          placeholder={inputLabels.placeholder}
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-hidden"
        />
        {fileMode && (
          <FileSearchControls
            mode={fileMode}
            searching={files.loading && itemCount > 0}
            includeGitIgnored={files.includeGitIgnored}
            onToggleGitIgnored={files.toggleIncludeGitIgnored}
          />
        )}
        {!inProjects && (
          <SegmentedControl
            aria-label="Search mode"
            value={effectiveMode}
            onValueChange={(next) => {
              changeMode(next);
              // Typing goes on in the input after a click on a mode.
              inputRef.current?.focus();
            }}
            options={modeOptions}
            className="shrink-0"
          />
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {!inFileMode && noResults
          ? 'No results'
          : itemCount === 1
            ? '1 result'
            : `${itemCount} results`}
      </p>
      {fileMode ? (
        <>
          {files.error && (
            <Callout tone="error" role="alert" className="mx-2 mt-2">
              {files.error}
            </Callout>
          )}
          <FileSearchResults
            mode={fileMode}
            query={query}
            loading={files.loading}
            itemCount={itemCount}
            listboxId={listboxId}
            listRef={listRef}
            fileState={files.fileState}
            contentState={files.contentState}
            selectedIndex={activeIndex}
            optionId={optionId}
            onHover={files.setSelectedIndex}
            onPick={pickFile}
          />
        </>
      ) : (
        <WorkspaceResults
          sections={sections}
          options={options}
          isEmpty={noResults}
          active={active}
          listboxId={listboxId}
          optionId={optionId}
          onHover={setActiveKey}
          onPick={pick}
        />
      )}

      <CommandCenterFooter
        inFileMode={inFileMode}
        inProjects={inProjects}
        activeOption={activeOption}
        defaultOpenMode={files.defaultOpenMode}
        canSwitchMode={availableModes.length > 1 && !inProjects}
      />
    </div>
  );
}

/** Beside the input in file search: a spinner while it searches, and the ignored-files toggle. */
function FileSearchControls({
  mode,
  searching,
  includeGitIgnored,
  onToggleGitIgnored,
}: {
  mode: CommandCenterFileMode;
  searching: boolean;
  includeGitIgnored: boolean;
  onToggleGitIgnored: () => void;
}) {
  return (
    <>
      {searching && <Spinner size="sm" label="Searching" className="text-muted-foreground" />}
      {mode === 'files' && (
        <IconButton
          label={includeGitIgnored ? 'Hide ignored files' : 'Show ignored files'}
          size="xs"
          tooltipSide="bottom"
          onClick={onToggleGitIgnored}
          className={
            includeGitIgnored ? undefined : 'text-muted-foreground/60 hover:text-muted-foreground'
          }
        >
          {includeGitIgnored ? <Eye className="size-4" /> : <EyeSlash className="size-4" />}
        </IconButton>
      )}
    </>
  );
}

interface WorkspaceResultsProps {
  sections: ResultSection[];
  options: ResultOption[];
  /** Nothing matched. The options left are offers to search elsewhere. */
  isEmpty: boolean;
  active: number;
  listboxId: string;
  optionId: (index: number) => string;
  onHover: (key: string) => void;
  onPick: (index: number) => void;
}

function WorkspaceResults({
  sections,
  options,
  isEmpty,
  active,
  listboxId,
  optionId,
  onHover,
  onPick,
}: WorkspaceResultsProps) {
  const currentWindowId = useWindowStore((s) => s.windowId);
  const availableWindows = useWindowStore((s) => s.availableWindows);
  const showAgentSpinner = useConfigStore((state) => state.config?.showAgentSpinner) !== false;
  const workingCounts = useMemo(
    () =>
      new Map(
        showAgentSpinner
          ? options.flatMap((option) =>
              option.kind === 'workspace'
                ? [[option.key, workingAgentCount(option.result.workspace)] as const]
                : []
            )
          : []
      ),
    [options, showAgentSpinner]
  );
  const workingId = (index: number) => `${optionId(index)}-working`;

  const windowLabel = (workspace: Workspace): string | null => {
    if (workspace.status !== 'active' || !workspace.windowId) return null;
    if (workspace.windowId === currentWindowId) return null;
    const info = availableWindows.find((candidate) => candidate.id === workspace.windowId);
    return info ? `Window ${info.displayNumber}` : 'Other window';
  };

  return (
    <div className="max-h-[min(28rem,60vh)] min-h-0 overflow-y-auto p-2">
      {isEmpty && (
        <p
          className={cn(
            'px-2 text-center text-sm text-muted-foreground',
            options.length > 0 ? 'pt-6 pb-4' : 'py-10'
          )}
        >
          No results
        </p>
      )}
      <div id={listboxId} role="listbox" aria-label="Results">
        {sections.map((section, sectionIndex) => (
          <div
            key={section.key}
            role="group"
            aria-labelledby={`${listboxId}-${section.key}`}
            className={sectionIndex > 0 ? 'pt-1.5' : undefined}
          >
            <div
              id={`${listboxId}-${section.key}`}
              role="presentation"
              className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
            >
              {section.label}
            </div>
            {section.options.map(({ option, index }) => (
              <div
                key={option.key}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                // A description, so the option's name stays put while agents start and stop.
                aria-describedby={workingCounts.get(option.key) ? workingId(index) : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => onHover(option.key)}
                onClick={() => onPick(index)}
                className={cn(
                  'flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5',
                  index === active ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                {option.kind === 'workspace' ? (
                  <WorkspaceRow
                    result={option.result}
                    windowLabel={windowLabel(option.result.workspace)}
                    workingCount={workingCounts.get(option.key) ?? 0}
                    workingId={workingId(index)}
                  />
                ) : (
                  <CommandRow command={option.command} />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandRow({ command }: { command: CommandItem }) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{command.icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{command.label}</span>
      {command.shortcut && <Kbd>{command.shortcut}</Kbd>}
      {command.opensView && (
        <CaretRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
      )}
    </>
  );
}

function FooterHint({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {keys}
      {children}
    </span>
  );
}

function CommandCenterFooter({
  inFileMode,
  inProjects,
  activeOption,
  defaultOpenMode,
  canSwitchMode,
}: {
  inFileMode: boolean;
  inProjects: boolean;
  activeOption: ResultOption | undefined;
  defaultOpenMode: OpenTarget;
  canSwitchMode: boolean;
}) {
  let enterLabel = 'Open';
  if (inProjects) enterLabel = 'Choose';
  else if (activeOption?.kind === 'command' && !activeOption.command.opensView) enterLabel = 'Run';
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-foreground/10 bg-foreground/[0.025] px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {inFileMode ? (
          <>
            <FooterHint keys={<Kbd>Shift+↵</Kbd>}>
              {defaultOpenMode === 'viewer' ? 'Workspace view' : 'Full screen'}
            </FooterHint>
            <FooterHint keys={<Kbd>{formatShortcutForDisplay('Cmd+↵')}</Kbd>}>New tab</FooterHint>
            <FooterHint keys={<Kbd>{formatShortcutForDisplay('Cmd+Shift+C')}</Kbd>}>
              Copy @path
            </FooterHint>
          </>
        ) : (
          <>
            <FooterHint
              keys={
                <>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </>
              }
            >
              Navigate
            </FooterHint>
            <FooterHint keys={<Kbd>↵</Kbd>}>{enterLabel}</FooterHint>
            {inProjects && <FooterHint keys={<Kbd>⌫</Kbd>}>Back</FooterHint>}
            <FooterHint keys={<Kbd>Esc</Kbd>}>Close</FooterHint>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!inFileMode && !inProjects && (
          <FooterHint keys={<Kbd>{COMMANDS_ONLY_PREFIX}</Kbd>}>Commands</FooterHint>
        )}
        {canSwitchMode && <FooterHint keys={<Kbd>Tab</Kbd>}>Switch mode</FooterHint>}
      </div>
    </div>
  );
}

function WorkspaceRow({
  result,
  windowLabel,
  workingCount,
  workingId,
}: {
  result: CommandCenterWorkspaceResult;
  windowLabel: string | null;
  workingCount: number;
  /** The hidden text that describes the row while agents work. */
  workingId: string;
}) {
  const { workspace, projectInfo } = result;
  const attentionAppearance =
    result.group === 'attention' ? getWorkspaceAttentionAppearance(workspace.attention) : null;
  // Stopped and trashed workspaces read quieter, though their row highlights as usual.
  const quiet = workspace.status !== 'active';
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {projectInfo?.icon ? (
          <ProjectMark project={projectInfo} iconClassName="size-4" />
        ) : (
          <span
            aria-hidden
            className={cn(
              'size-2 shrink-0 rounded-full',
              projectInfo ? 'light-darken' : 'border border-muted-foreground/60'
            )}
            style={projectInfo ? { backgroundColor: projectInfo.color } : undefined}
          />
        )}
      </span>
      <span className={cn('flex min-w-0 flex-1 flex-col', quiet && 'opacity-60')}>
        <span className="truncate text-sm">{result.title}</span>
        <WorkspaceMeta result={result} />
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {attentionAppearance && (
          <span
            className={cn(
              'max-w-32 truncate rounded-full px-1.5 py-0.5 text-2xs font-medium',
              attentionAppearance.badgeClassName
            )}
            style={attentionAppearance.badgeStyle}
          >
            {attentionAppearance.label}
          </span>
        )}
        {workingCount > 0 && (
          <>
            <WorkingAgentsGlyph count={workingCount} decorative />
            <span id={workingId} hidden>
              {workingAgentsLabel(workingCount, workingCommandCount(workspace))}
            </span>
          </>
        )}
        {windowLabel && <span>{windowLabel}</span>}
        <span className="min-w-8 text-right text-muted-foreground/70 tabular-nums">
          {formatRelativeTime(result.lastActivityAt)}
        </span>
      </span>
    </>
  );
}

/** The row's second line: project, branch and description, as far as they fit. */
function WorkspaceMeta({ result }: { result: CommandCenterWorkspaceResult }) {
  const { workspace, projectInfo } = result;
  const branch = workspace.isWorktree ? workspace.branchName : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {projectInfo && <span className="max-w-40 shrink-0 truncate">{projectInfo.name}</span>}
      {branch && (
        <>
          {projectInfo && <MetaDot />}
          <GitBranch aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="max-w-48 shrink-0 truncate">{branch}</span>
        </>
      )}
      {workspace.customDescription && (
        <>
          {(projectInfo || branch) && <MetaDot />}
          <span className="min-w-0 truncate">{workspace.customDescription}</span>
        </>
      )}
    </span>
  );
}

function MetaDot() {
  return (
    <span aria-hidden className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}

interface CommandCenterDialogProps {
  open: boolean;
  mode: CommandCenterMode;
  /** Changes when a shortcut opens or switches a search, which then starts afresh. */
  session: number;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: CommandCenterMode) => void;
}

/**
 * Searches every workspace, in every window and state, plus app commands. Before
 * anything is typed it lists workspaces waiting on the user, then the main actions, then
 * recent workspaces. Its other modes search the open workspace's files by name or content.
 */
export function CommandCenterDialog({
  open,
  mode,
  session,
  onOpenChange,
  onModeChange,
}: CommandCenterDialogProps) {
  const previousFocusRef = useRef<Element | null>(null);
  const restoreFocusRef = useRef(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[12%] flex w-[640px] max-w-[90vw] translate-y-0 flex-col gap-0 overflow-hidden p-0"
        showCloseButton={false}
        // Escape only closes this, rather than also leaving the overview behind it.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onOpenAutoFocus={() => {
          previousFocusRef.current = document.activeElement;
          restoreFocusRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Leave focus wherever the chosen command, workspace or file moved it.
          const previous = previousFocusRef.current;
          const focusUnclaimed =
            !document.activeElement || document.activeElement === document.body;
          if (restoreFocusRef.current && focusUnclaimed && previous instanceof HTMLElement) {
            previous.focus();
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command Center</DialogTitle>
          <DialogDescription>Search workspaces, commands and files</DialogDescription>
        </DialogHeader>
        {/* A command that reopens the dialog does so before it ever closes, so the panel
            remounts here rather than on open. */}
        <CommandCenterPanel
          key={session}
          mode={mode}
          onModeChange={onModeChange}
          onClose={({ restoreFocus }) => {
            restoreFocusRef.current = restoreFocus;
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
