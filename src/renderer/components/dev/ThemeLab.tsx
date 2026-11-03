// Theme Lab: a dev-build panel for trying style changes on the real UI.
// Ctrl+Alt+Shift+T (Cmd+Alt+Shift+T on macOS) toggles it. Its own colors are fixed, so it stays
// readable whatever the page's colors become. Changes live in this browser's localStorage only.
// Past pickers (looks, surfaces, terminal shades, corners) are in git history.

import { ArrowCounterClockwise, Eye, X } from '@phosphor-icons/react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import {
  LAB_ACTIVE_TABS,
  LAB_ALL_LINES,
  LAB_BOTTOM_BARS,
  LAB_BOTTOM_ROW_DIVIDERS,
  LAB_FILE_PANEL_TOPS,
  LAB_FILE_PANELS,
  LAB_FILE_TREE_DIVIDERS,
  LAB_NEW_WORKSPACE_BUTTONS,
  LAB_PANE_BORDERS,
  LAB_PANE_CORNERS,
  LAB_PANE_GAPS,
  LAB_QUICK_COMMANDS,
  LAB_SELECTED_WORKSPACES,
  LAB_SIDEBAR_PANELS,
  LAB_STATUS_BARS,
  LAB_TAB_CORNERS,
  LAB_TOP_ROW_DIVIDERS,
  TODAY_OPTION_ID,
  TODAY_STATUS_BAR_ID,
  optionCss,
  statusBarCss,
  type LabOption,
} from '@/lib/theme-lab';
import { cn } from '@/lib/utils';

const OPEN_KEY = 'komla.themeLab.open';
const CHOICES_KEY = 'komla.themeLab.choices';
const FRAME_KEY = 'komla.themeLab.frame';

interface LabChoices {
  /** A LAB_STATUS_BARS id. */
  statusBar: string;
  /** A LAB_PANE_CORNERS id. */
  paneCorners: string;
  /** A LAB_PANE_GAPS id. */
  paneGap: string;
  /** A LAB_TAB_CORNERS id. */
  tabCorners: string;
  /** A LAB_BOTTOM_BARS id. */
  bottomBar: string;
  /** A LAB_BOTTOM_ROW_DIVIDERS id. */
  bottomRowDivider: string;
  /** A LAB_FILE_PANELS id. */
  filePanel: string;
  /** A LAB_FILE_PANEL_TOPS id. */
  filePanelTop: string;
  /** A LAB_FILE_TREE_DIVIDERS id. */
  fileTreeDivider: string;
  /** A LAB_TOP_ROW_DIVIDERS id. */
  topRowDivider: string;
  /** A LAB_ALL_LINES id. */
  allLines: string;
  /** A LAB_QUICK_COMMANDS id. */
  quickCommands: string;
  /** A LAB_PANE_BORDERS id. */
  paneBorder: string;
  /** A LAB_ACTIVE_TABS id. */
  activeTab: string;
  /** A LAB_SIDEBAR_PANELS id. */
  sidebarPanels: string;
  /** A LAB_NEW_WORKSPACE_BUTTONS id. */
  newWorkspaceButton: string;
  /** A LAB_SELECTED_WORKSPACES id. */
  selectedWorkspace: string;
}

// The pickers whose options are LabOptions, in the panel's order.
const OPTION_PICKERS: readonly {
  key: Exclude<keyof LabChoices, 'statusBar'>;
  heading: string;
  options: readonly LabOption[];
}[] = [
  { key: 'bottomBar', heading: 'Bottom row', options: LAB_BOTTOM_BARS },
  { key: 'bottomRowDivider', heading: 'Bottom row divider', options: LAB_BOTTOM_ROW_DIVIDERS },
  { key: 'filePanel', heading: 'File panel', options: LAB_FILE_PANELS },
  { key: 'filePanelTop', heading: 'File panel top', options: LAB_FILE_PANEL_TOPS },
  { key: 'fileTreeDivider', heading: 'File tree divider', options: LAB_FILE_TREE_DIVIDERS },
  { key: 'topRowDivider', heading: 'Top row divider', options: LAB_TOP_ROW_DIVIDERS },
  { key: 'allLines', heading: 'All lines', options: LAB_ALL_LINES },
  { key: 'paneBorder', heading: 'Pane border', options: LAB_PANE_BORDERS },
  { key: 'activeTab', heading: 'Active tab', options: LAB_ACTIVE_TABS },
  { key: 'quickCommands', heading: 'Quick commands', options: LAB_QUICK_COMMANDS },
  { key: 'sidebarPanels', heading: 'Sidebar panels', options: LAB_SIDEBAR_PANELS },
  { key: 'newWorkspaceButton', heading: 'New Workspace', options: LAB_NEW_WORKSPACE_BUTTONS },
  { key: 'selectedWorkspace', heading: 'Selected workspace', options: LAB_SELECTED_WORKSPACES },
  { key: 'paneCorners', heading: 'Pane corners', options: LAB_PANE_CORNERS },
  { key: 'paneGap', heading: 'Pane gap', options: LAB_PANE_GAPS },
  { key: 'tabCorners', heading: 'Tab corners', options: LAB_TAB_CORNERS },
];

const DEFAULT_CHOICES: LabChoices = {
  statusBar: TODAY_STATUS_BAR_ID,
  paneCorners: TODAY_OPTION_ID,
  paneGap: TODAY_OPTION_ID,
  tabCorners: TODAY_OPTION_ID,
  bottomBar: TODAY_OPTION_ID,
  bottomRowDivider: TODAY_OPTION_ID,
  filePanel: TODAY_OPTION_ID,
  filePanelTop: TODAY_OPTION_ID,
  fileTreeDivider: TODAY_OPTION_ID,
  topRowDivider: TODAY_OPTION_ID,
  allLines: TODAY_OPTION_ID,
  quickCommands: TODAY_OPTION_ID,
  paneBorder: TODAY_OPTION_ID,
  activeTab: TODAY_OPTION_ID,
  sidebarPanels: TODAY_OPTION_ID,
  newWorkspaceButton: TODAY_OPTION_ID,
  selectedWorkspace: TODAY_OPTION_ID,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: the lab still works for this session.
  }
}

/** The panel's place and size in px, from the window's top left. */
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_WIDTH = 260;
const MIN_HEIGHT = 140;
const EDGE = 8;

function defaultFrame(): Frame {
  const width = 300;
  return {
    x: window.innerWidth - width - EDGE,
    y: 40,
    width,
    height: Math.min(460, window.innerHeight - 80),
  };
}

// Keeps the panel inside the window, at least its minimum size.
function fitFrame(frame: Frame): Frame {
  const width = Math.max(MIN_WIDTH, Math.min(frame.width, window.innerWidth - 2 * EDGE));
  const height = Math.max(MIN_HEIGHT, Math.min(frame.height, window.innerHeight - 2 * EDGE));
  return {
    width,
    height,
    x: Math.max(EDGE, Math.min(frame.x, window.innerWidth - width - EDGE)),
    y: Math.max(EDGE, Math.min(frame.y, window.innerHeight - height - EDGE)),
  };
}

/** A floating panel's frame: drag it by a handle, resize it by a grip, kept inside the window. */
function useFloatingFrame() {
  const [frame, setFrame] = useState(() => fitFrame(readJson(FRAME_KEY, defaultFrame())));
  const gesture = useRef<{ kind: 'move' | 'resize'; x: number; y: number; start: Frame } | null>(
    null
  );

  useEffect(() => {
    const refit = () => setFrame((current) => fitFrame(current));
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, []);

  const begin = (kind: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
    // The header's buttons stay buttons.
    if (event.button !== 0 || (kind === 'move' && (event.target as Element).closest('button'))) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind, x: event.clientX, y: event.clientY, start: frame };
  };
  const frameAt = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return null;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    const { start } = current;
    return fitFrame(
      current.kind === 'move'
        ? { ...start, x: start.x + dx, y: start.y + dy }
        : { ...start, width: start.width + dx, height: start.height + dy }
    );
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const next = frameAt(event);
    if (next) setFrame(next);
  };
  // Saved once the gesture ends, not on every move.
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const next = frameAt(event);
    gesture.current = null;
    if (!next) return;
    setFrame(next);
    writeJson(FRAME_KEY, next);
  };
  const handlers = { onPointerMove, onPointerUp, onPointerCancel: onPointerUp };

  return {
    frame,
    moveHandle: { onPointerDown: begin('move'), ...handlers },
    resizeHandle: { onPointerDown: begin('resize'), ...handlers },
  };
}

// Older saves hold removed pickers' choices, which are dropped, and removed options fall back to
// today's.
function savedChoices(saved: Partial<LabChoices>): LabChoices {
  const known = (options: readonly { id: string }[], id: string | undefined, fallback: string) =>
    options.find((option) => option.id === id)?.id ?? fallback;
  const choices = {
    ...DEFAULT_CHOICES,
    statusBar: known(LAB_STATUS_BARS, saved.statusBar, DEFAULT_CHOICES.statusBar),
  };
  for (const { key, options } of OPTION_PICKERS) {
    choices[key] = known(options, saved[key], DEFAULT_CHOICES[key]);
  }
  return choices;
}

export function ThemeLab() {
  const [open, setOpen] = useState(() => readJson(OPEN_KEY, false));
  const [choices, setChoices] = useState<LabChoices>(() =>
    savedChoices(readJson<Partial<LabChoices>>(CHOICES_KEY, {}))
  );
  const [sheet] = useState(() => document.createElement('style'));
  const [comparing, setComparing] = useState(false);
  // A panel that unmounts mid-press never sees the pointer go up.
  const close = () => {
    setOpen(false);
    setComparing(false);
  };

  useEffect(() => writeJson(CHOICES_KEY, choices), [choices]);
  useEffect(() => writeJson(OPEN_KEY, open), [open]);

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || !event.shiftKey) return;
      if (event.code !== 'KeyT') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((value) => !value);
      setComparing(false);
    };
    window.addEventListener('keydown', toggle, true);
    return () => window.removeEventListener('keydown', toggle, true);
  }, []);

  useEffect(() => {
    document.head.appendChild(sheet);
    return () => sheet.remove();
  }, [sheet]);

  const css =
    statusBarCss(choices.statusBar) +
    OPTION_PICKERS.map(({ key, options }) => optionCss(options, choices[key])).join('');
  useLayoutEffect(() => {
    sheet.textContent = comparing ? '' : css;
  }, [sheet, css, comparing]);

  if (!open) {
    return css ? (
      <button
        type="button"
        data-theme-lab
        onClick={() => setOpen(true)}
        className="fixed right-2 bottom-[calc(var(--status-bar-height,0px)+8px)] z-[9999] rounded-[6px] border border-[#2a2f37] bg-[#15181d] px-2 py-1 text-[11px] text-[#e6e8eb] shadow-lg hover:bg-[#222730]"
      >
        Theme Lab
      </button>
    ) : null;
  }

  return (
    <ThemeLabPanel
      choices={choices}
      onChange={(next) => setChoices((current) => ({ ...current, ...next }))}
      onReset={() => setChoices(DEFAULT_CHOICES)}
      onClose={close}
      onCompare={setComparing}
    />
  );
}

interface PanelProps {
  choices: LabChoices;
  onChange: (choices: Partial<LabChoices>) => void;
  onReset: () => void;
  onClose: () => void;
  onCompare: (comparing: boolean) => void;
}

function ThemeLabPanel({ choices, onChange, onReset, onClose, onCompare }: PanelProps) {
  const { frame, moveHandle, resizeHandle } = useFloatingFrame();

  return (
    <div
      data-theme-lab
      className="fixed z-[9999] flex flex-col overflow-hidden rounded-[8px] border border-[#2a2f37] bg-[#15181d] font-sans text-[12px] text-[#e6e8eb] shadow-2xl"
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      {/* Drag the header to move the panel. */}
      <div
        {...moveHandle}
        className="flex cursor-grab items-center gap-1 border-b border-[#2a2f37] px-2 py-1.5 select-none active:cursor-grabbing"
      >
        <span className="min-w-0 flex-1 truncate pl-1 font-medium">Theme Lab</span>
        <LabButton
          title="Hold to compare with today's look"
          onPointerDown={() => onCompare(true)}
          onPointerUp={() => onCompare(false)}
          onPointerLeave={() => onCompare(false)}
          onPointerCancel={() => onCompare(false)}
        >
          <Eye className="size-3.5" />
        </LabButton>
        <LabButton title="Back to today's look" onClick={onReset}>
          <ArrowCounterClockwise className="size-3.5" />
        </LabButton>
        <LabButton title="Close (Ctrl/Cmd+Alt+Shift+T). Changes stay applied." onClick={onClose}>
          <X className="size-3.5" />
        </LabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <PickerHeading>Status bar</PickerHeading>
        <OptionGrid
          columns={3}
          options={LAB_STATUS_BARS}
          selected={choices.statusBar}
          onSelect={(id) => onChange({ statusBar: id })}
        />
        {OPTION_PICKERS.map(({ key, heading, options }) => (
          <div key={key}>
            <PickerHeading>{heading}</PickerHeading>
            <OptionGrid
              columns={options.length % 3 === 0 || options.length === 5 ? 3 : 2}
              options={options}
              selected={choices[key]}
              onSelect={(id) => onChange({ [key]: id })}
            />
          </div>
        ))}
      </div>
      <div
        {...resizeHandle}
        title="Drag to resize"
        aria-hidden="true"
        className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
      >
        <span className="absolute right-1 bottom-1 size-2 border-r-2 border-b-2 border-[#4a515c]" />
      </div>
    </div>
  );
}

function LabButton({
  title,
  children,
  ...handlers
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onPointerLeave?: () => void;
  onPointerCancel?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="flex size-6 shrink-0 items-center justify-center rounded-[4px] text-[#c9ced6] hover:bg-[#222730] hover:text-white"
      {...handlers}
    >
      {children}
    </button>
  );
}

function OptionGrid({
  columns,
  options,
  selected,
  onSelect,
}: {
  columns: 2 | 3;
  options: readonly { id: string; name: string; description: string }[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={cn('grid gap-1', columns === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.description}
          aria-pressed={selected === option.id}
          onClick={() => onSelect(option.id)}
          className={cn(
            'h-7 rounded-[4px] px-1 text-[11px] text-[#c9ced6] ring-1 ring-[#2a2f37] hover:bg-[#222730]',
            selected === option.id && 'bg-[#222730] text-white ring-[#e6e8eb]'
          )}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

function PickerHeading({ children }: { children: ReactNode }) {
  return (
    <div className="pt-3 pb-1.5 text-[11px] font-medium tracking-wide text-[#9aa1ab] uppercase">
      {children}
    </div>
  );
}
