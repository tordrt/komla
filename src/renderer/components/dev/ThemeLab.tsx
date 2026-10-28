// Theme Lab: a dev-build panel for trying style changes on the real UI.
// Ctrl+Alt+Shift+T (Cmd+Alt+Shift+T on macOS) toggles it. Its own colors are fixed, so it stays
// readable whatever the page's colors become. Changes live in this browser's localStorage only.
// Past pickers (looks, surfaces, status bar line, terminal shades) are in git history.

import { ArrowCounterClockwise, Eye, X } from '@phosphor-icons/react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { LAB_STATUS_BARS, TODAY_STATUS_BAR_ID, statusBarCss } from '@/lib/theme-lab';
import { cn } from '@/lib/utils';

const OPEN_KEY = 'komla.themeLab.open';
const CHOICES_KEY = 'komla.themeLab.choices';
const FRAME_KEY = 'komla.themeLab.frame';

interface LabChoices {
  /** A LAB_STATUS_BARS id. */
  statusBar: string;
}

const DEFAULT_CHOICES: LabChoices = { statusBar: TODAY_STATUS_BAR_ID };

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
    height: Math.min(160, window.innerHeight - 80),
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
  const bar = LAB_STATUS_BARS.find((option) => option.id === saved.statusBar);
  return { statusBar: bar?.id ?? DEFAULT_CHOICES.statusBar };
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

  const css = statusBarCss(choices.statusBar);
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
        <div className="grid grid-cols-3 gap-1">
          {LAB_STATUS_BARS.map((bar) => (
            <button
              key={bar.id}
              type="button"
              title={bar.description}
              aria-pressed={choices.statusBar === bar.id}
              onClick={() => onChange({ statusBar: bar.id })}
              className={cn(
                'h-7 rounded-[4px] px-1 text-[11px] text-[#c9ced6] ring-1 ring-[#2a2f37] hover:bg-[#222730]',
                choices.statusBar === bar.id && 'bg-[#222730] text-white ring-[#e6e8eb]'
              )}
            >
              {bar.name}
            </button>
          ))}
        </div>
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

function PickerHeading({ children }: { children: ReactNode }) {
  return (
    <div className="pt-3 pb-1.5 text-[11px] font-medium tracking-wide text-[#9aa1ab] uppercase">
      {children}
    </div>
  );
}
