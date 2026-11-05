import { At, ChatText, Copy, Eraser, X } from '@phosphor-icons/react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { titleBarHeightPx } from '@/components/layout/title-bar-metrics';
import { Button } from '@/components/ui/button';
import { IconButton, ignoreFocusAfterPointer } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { forwardAppShortcut } from '@/lib/monaco-shortcut-forwarding';
import {
  clampDraftRect,
  closePromptDraft,
  defaultDraftRect,
  DRAFT_HANDLE_OUTSET,
  openPromptDraft,
  DRAFT_MIN_HEIGHT,
  DRAFT_MIN_WIDTH,
  PROMPT_DRAFT_ATTRIBUTE,
  readStoredDraftRect,
  resizeDraftRect,
  spaceReference,
  storeDraftRect,
  type DraftEdge,
  type DraftRect,
} from '@/lib/prompt-draft';
import { usePromptDraftStore } from '@/stores/prompt-draft.store';
import { formatShortcutForDisplay, useShortcutsStore } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';
import { selectViewedFile, useViewedFileStore, type ViewedFile } from '@/stores/viewed-file.store';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt']);

// Where the cursor was in each workspace's draft, for when it shows again: it remounts as it
// moves between the window and a viewer over it.
const selections = new Map<string, { start: number; end: number }>();

/**
 * Where the prompt draft shows while this is the top of what's on screen: the window, or a viewer
 * covering it, which renders one inside itself so its focus and outside-click handling leave the
 * draft alone. The latest to mount is on top.
 */
export function PromptDraftOutlet({ workspaceId }: { workspaceId: string | null | undefined }) {
  const id = useId();
  const workspace = workspaceId ?? null;
  useLayoutEffect(() => {
    const store = usePromptDraftStore.getState();
    store.addHost(id, null);
    return () => usePromptDraftStore.getState().removeHost(id);
  }, [id]);
  useLayoutEffect(() => {
    usePromptDraftStore.getState().updateHost(id, workspace);
  }, [id, workspace]);
  const isTop = usePromptDraftStore((s) => s.hosts.at(-1)?.id === id);
  const open = usePromptDraftStore((s) => workspace !== null && !!s.openByWorkspace[workspace]);
  if (!isTop || !open || !workspace) return null;
  return <PromptDraftWindow key={workspace} workspaceId={workspace} />;
}

/** A viewer's button that opens the prompt draft, which has its own button for the file shown. */
export function PromptDraftButton({ workspaceId }: { workspaceId: string }) {
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('promptDraft.toggle'));
  return (
    <IconButton
      label="Prompt draft"
      shortcut={shortcut}
      onMouseDown={keepFocus}
      onClick={() => openPromptDraft(workspaceId)}
    >
      <ChatText className="size-4" />
    </IconButton>
  );
}

// Where each edge's and corner's grab area sits, and the cursor over it: just outside the border,
// by DRAFT_HANDLE_OUTSET (1.5 is 6px), clear of the header's buttons and the text's scrollbar, with
// the corners reaching a little inside. The bottom right one, under the grip, reaches further. The
// corners come after the edges, so they're on top where they meet.
const RESIZE_HANDLES: { edge: DraftEdge; className: string }[] = [
  { edge: 'n', className: 'inset-x-0 -top-1.5 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'inset-x-0 -bottom-1.5 h-1.5 cursor-ns-resize' },
  { edge: 'e', className: 'inset-y-0 -right-1.5 w-1.5 cursor-ew-resize' },
  { edge: 'w', className: 'inset-y-0 -left-1.5 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: '-top-1.5 -left-1.5 size-2.5 cursor-nwse-resize' },
  { edge: 'ne', className: '-top-1.5 -right-1.5 size-2.5 cursor-nesw-resize' },
  { edge: 'sw', className: '-bottom-1.5 -left-1.5 size-2.5 cursor-nesw-resize' },
  { edge: 'se', className: '-right-1.5 -bottom-1.5 size-4.5 cursor-nwse-resize' },
];

/** As high as the draft goes: under the title bar, where the window's own controls are. */
function topLimit(): number {
  return titleBarHeightPx() + DRAFT_HANDLE_OUTSET;
}

function viewportRect(rect: DraftRect): DraftRect {
  return clampDraftRect(rect, window.innerWidth, window.innerHeight, topLimit());
}

function initialRect(): DraftRect {
  return viewportRect(
    readStoredDraftRect() ?? defaultDraftRect(window.innerWidth, window.innerHeight)
  );
}

/** Keeps focus where it is, such as in the draft or on the lines selected in a file. */
function keepFocus(event: ReactMouseEvent) {
  event.preventDefault();
}

/**
 * A floating window for writing a prompt while looking at files, to copy into an agent. Its text
 * stays, per workspace, until cleared or Komla quits.
 */
function PromptDraftWindow({ workspaceId }: { workspaceId: string }) {
  const text = usePromptDraftStore((s) => s.textByWorkspace[workspaceId] ?? '');
  const focusRequest = usePromptDraftStore((s) =>
    s.focusRequest?.workspaceId === workspaceId ? s.focusRequest : null
  );
  const viewed = useViewedFileStore((s) => selectViewedFile(s, workspaceId));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [rect, setRect] = useState(initialRect);
  const rectRef = useRef(rect);
  useLayoutEffect(() => {
    rectRef.current = rect;
  });

  const platform = window.api?.platform;
  const copyShortcut = formatShortcutForDisplay('Cmd+Enter', platform);
  const insertShortcut = formatShortcutForDisplay('Cmd+Shift+C', platform);

  // Back where the cursor was, or at the end.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const selection = selections.get(workspaceId) ?? {
      start: textarea.value.length,
      end: textarea.value.length,
    };
    textarea.setSelectionRange(selection.start, selection.end);
    return () => {
      selections.set(workspaceId, { start: textarea.selectionStart, end: textarea.selectionEnd });
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!focusRequest) return;
    usePromptDraftStore.getState().clearFocusRequest();
    textareaRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    const onResize = () => setRect((current) => viewportRect(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setText = (value: string) => usePromptDraftStore.getState().setText(workspaceId, value);

  /**
   * Replaces the selection of the textarea, which has focus. execCommand is deprecated, but it is
   * the only edit the textarea's own undo can take back; the fallback can't be undone.
   */
  const replaceSelection = (textarea: HTMLTextAreaElement, value: string) => {
    const inserted =
      typeof document.execCommand === 'function' &&
      document.execCommand(value ? 'insertText' : 'delete', false, value);
    if (inserted) return;
    textarea.setRangeText(value, textarea.selectionStart, textarea.selectionEnd, 'end');
    setText(textarea.value);
  };

  const insertReference = () => {
    const reference = viewed?.getReference();
    const textarea = textareaRef.current;
    if (!textarea || !reference) return;
    textarea.focus();
    replaceSelection(
      textarea,
      spaceReference(textarea.value, textarea.selectionStart, textarea.selectionEnd, reference)
    );
  };

  const copy = () => {
    const prompt = (textareaRef.current?.value ?? text).trimEnd();
    if (!prompt.trim()) return;
    window.api.copyToClipboard(prompt);
    useToastStore.getState().addToast('Copied the prompt', 'success');
  };

  const clear = () => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.value) return;
    textarea.focus();
    textarea.select();
    replaceSelection(textarea, '');
  };

  const close = () => closePromptDraft(workspaceId);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const native = event.nativeEvent;
    if (native.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    // Whatever it is bound to, as the window's shortcuts pass over a textarea.
    if (useShortcutsStore.getState().matchesEvent('promptDraft.toggle', native)) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    // Other keys without Cmd are typing, such as Option+N starting an ñ.
    if (!(event.metaKey || event.ctrlKey)) return;
    // The viewers behind take keys like these for their own shortcuts, such as Cmd+C copying a
    // file's @path; here they edit the draft.
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      copy();
    } else if (event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      insertReference();
    } else if (forwardAppShortcut(native)) {
      event.preventDefault();
    }
  };

  /** Follows the pointer from a press, changing the rect as `apply` says for how far it moved. */
  const track = (
    event: ReactPointerEvent<HTMLElement>,
    apply: (start: DraftRect, dx: number, dy: number) => DraftRect
  ) => {
    if (event.button !== 0) return;
    // Leaves focus where it is and selects no text.
    event.preventDefault();
    const element = event.currentTarget;
    const start = rectRef.current;
    const { clientX, clientY, pointerId } = event;
    element.setPointerCapture?.(pointerId);
    // Stored as moved, as the render of the last move may not be in yet when the press ends.
    let latest = start;
    const onMove = (move: PointerEvent) => {
      latest = viewportRect(apply(start, move.clientX - clientX, move.clientY - clientY));
      setRect(latest);
    };
    const onEnd = () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onEnd);
      element.removeEventListener('pointercancel', onEnd);
      storeDraftRect(latest);
    };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onEnd);
    element.addEventListener('pointercancel', onEnd);
  };

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button')) return;
    track(event, (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }));
  };

  const startResize = (event: ReactPointerEvent<HTMLElement>, edge: DraftEdge) => {
    track(event, (start, dx, dy) =>
      resizeDraftRect(start, edge, dx, dy, window.innerWidth, window.innerHeight, topLimit())
    );
  };

  return (
    <section
      role="dialog"
      aria-label="Prompt draft"
      {...{ [PROMPT_DRAFT_ATTRIBUTE]: '' }}
      className="floating-surface no-drag fixed z-40 flex flex-col rounded-lg border shadow-xl"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        minWidth: DRAFT_MIN_WIDTH,
        minHeight: DRAFT_MIN_HEIGHT,
      }}
      onKeyDown={onKeyDown}
    >
      {/* Clipped to the rounded corners; the resize handles reach outside them. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[calc(var(--radius-lg)-1px)]">
        <div
          className="flex h-8 shrink-0 cursor-grab items-center gap-0.5 border-b pr-1 pl-2.5 select-none active:cursor-grabbing"
          onPointerDown={startMove}
        >
          <ChatText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="mr-1 ml-1.5 min-w-0 flex-1 truncate text-xs font-medium">Prompt draft</h2>
          <ReferenceButton viewed={viewed} shortcut={insertShortcut} onInsert={insertReference} />
          <IconButton
            label="Copy prompt"
            shortcut={copyShortcut}
            size="xs"
            disabled={!text.trim()}
            onMouseDown={keepFocus}
            onClick={copy}
          >
            <Copy className="size-3.5" />
          </IconButton>
          <IconButton
            label="Clear"
            size="xs"
            disabled={!text}
            onMouseDown={keepFocus}
            onClick={clear}
          >
            <Eraser className="size-3.5" />
          </IconButton>
          <IconButton
            label="Close"
            shortcut="Esc"
            size="xs"
            onMouseDown={keepFocus}
            onClick={close}
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
        <textarea
          ref={textareaRef}
          aria-label="Prompt"
          value={text}
          onChange={(event) => setText(event.target.value)}
          // Paths and code would be underlined as misspelled.
          spellCheck={false}
          placeholder={`Draft a prompt to paste into an agent. ${insertShortcut} puts in the file you're looking at.`}
          className="thin-scrollbar min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[13px] leading-5 text-foreground outline-hidden placeholder:text-muted-foreground"
        />
      </div>
      {/* Covers the handles too, for a native preview to step aside from. */}
      <div
        aria-hidden="true"
        data-native-overlay="prompt-draft"
        className="pointer-events-none absolute -inset-1.5"
      />
      {RESIZE_HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          aria-hidden="true"
          data-resize-edge={edge}
          // Outside the draft's no-drag box, over a title bar's drag region it would get no presses
          // otherwise.
          className={`no-drag absolute z-10 touch-none ${className}`}
          onPointerDown={(event) => startResize(event, edge)}
        />
      ))}
      {/* Shows that it can be resized; any edge or corner does it. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 8 8"
        className="pointer-events-none absolute right-1 bottom-1 size-2 text-muted-foreground/60"
      >
        <path d="M7 1 1 7M7 4 4 7" stroke="currentColor" strokeLinecap="round" fill="none" />
      </svg>
    </section>
  );
}

/** Puts in a reference to the file the user is looking at, with its selected lines. */
function ReferenceButton({
  viewed,
  shortcut,
  onInsert,
}: {
  viewed: ViewedFile | null;
  shortcut: string;
  onInsert: () => void;
}) {
  const label = viewed ? `Insert @path to ${viewed.name}` : 'Open a file to refer to it';
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={ignoreFocusAfterPointer}>
        {/* A disabled button gets no pointer events, so its tooltip goes on a wrapper. */}
        <span className="min-w-0 shrink">
          <Button
            variant="ghost"
            aria-label={label}
            disabled={!viewed}
            onMouseDown={keepFocus}
            onClick={onInsert}
            className="h-6 max-w-40 min-w-0 gap-1 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            <At className="size-3.5 shrink-0" />
            <span className="truncate">{viewed?.name ?? 'File'}</span>
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-2">
          {label}
          {viewed && <Kbd>{shortcut}</Kbd>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
