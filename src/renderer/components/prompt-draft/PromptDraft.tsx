import { ChatText, Copy, NotePencil, X } from '@phosphor-icons/react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { titleBarHeightPx } from '@/components/layout/title-bar-metrics';
import { Button } from '@/components/ui/button';
import { IconButton, ignoreFocusAfterPointer } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getTransferFiles,
  hasClipboardImage,
  readableFilePaths,
} from '@/components/workspaces/NewWorkspacePromptAttachments';
import { hasFileDrop, uploadingLabel } from '@/lib/file-drop';
import {
  couldNotUploadMessage,
  importFilesAsReferences,
  refreshFileListAfterImport,
} from '@/lib/file-imports';
import { forwardAppShortcut } from '@/lib/monaco-shortcut-forwarding';
import { createNote } from '@/lib/notes';
import {
  clampDraftRect,
  closePromptDraft,
  cursorAfterInsert,
  defaultDraftRect,
  DRAFT_HANDLE_OUTSET,
  openPromptDraft,
  DRAFT_MIN_HEIGHT,
  DRAFT_MIN_WIDTH,
  PROMPT_DRAFT_ATTRIBUTE,
  positionAfterInsert,
  readStoredDraftRect,
  referencePlace,
  resizeDraftRect,
  spaceReference,
  storeDraftRect,
  type DraftCursor,
  type DraftEdge,
  type DraftRect,
} from '@/lib/prompt-draft';
import { AT_PATH_MIME, consumeTreeDragActive, isTreeDragActive } from '@/lib/tree-drag-token';
import { usePromptDraftStore } from '@/stores/prompt-draft.store';
import { formatShortcutForDisplay, useShortcutsStore } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';
import { selectViewedFile, useViewedFileStore, type ViewedFile } from '@/stores/viewed-file.store';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt']);

// Where the cursor was in the draft, for when it shows again: it remounts as it moves between the
// window and a viewer over it.
let selection: { start: number; end: number } | null = null;

// Where each reference still on its way goes, as the cursor was when it was asked for. Kept up to
// date as others go in, here as they outlast the draft remounting.
const pendingCursors = new Set<DraftCursor>();

// The draft's text box on screen, for references on their way to go into, wherever it moved since.
let mountedTextarea: HTMLTextAreaElement | null = null;

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
  const open = usePromptDraftStore((s) => s.isOpen);
  if (!isTop || !open || !workspace) return null;
  return <PromptDraftWindow workspaceId={workspace} />;
}

/** A viewer's button that opens the prompt draft, which has its own button for the file shown. */
export function PromptDraftButton() {
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('promptDraft.toggle'));
  return (
    <IconButton
      label="Prompt draft"
      shortcut={shortcut}
      onMouseDown={keepFocus}
      onClick={openPromptDraft}
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

function cursorIn(textarea: HTMLTextAreaElement): DraftCursor {
  return { text: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
}

/** What a drag over the draft would put in: a `@path` from the file panel, or files from outside. */
function dropKind(dataTransfer: DataTransfer): 'path' | 'files' | null {
  if (isTreeDragActive() && dataTransfer.types.includes(AT_PATH_MIME)) return 'path';
  return hasFileDrop(dataTransfer) ? 'files' : null;
}

/** Keeps focus where it is, such as in the draft or on the lines selected in a file. */
function keepFocus(event: ReactMouseEvent) {
  event.preventDefault();
}

/**
 * A floating window for writing a prompt while looking at files, to copy into an agent. There's
 * one per window, across its workspaces, whose text stays until copied over or Komla quits.
 * `workspaceId` is the workspace on screen, whose file it refers to and where it's saved as a
 * note.
 */
function PromptDraftWindow({ workspaceId }: { workspaceId: string }) {
  const text = usePromptDraftStore((s) => s.text);
  const focusRequested = usePromptDraftStore((s) => s.focusRequested);
  const viewed = useViewedFileStore((s) => selectViewedFile(s, workspaceId));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<'path' | 'files' | null>(null);
  const upload = usePromptDraftStore((s) => s.uploads.at(-1)?.label);
  const [rect, setRect] = useState(initialRect);
  const rectRef = useRef(rect);
  useLayoutEffect(() => {
    rectRef.current = rect;
  });

  const platform = window.api?.platform;
  const copyShortcut = formatShortcutForDisplay('Cmd+Enter', platform);
  const insertShortcut = formatShortcutForDisplay('Cmd+Shift+C', platform);

  // Back where the cursor was, or at the end. Once copied, all of it, for the next prompt to
  // replace as it's typed.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const store = usePromptDraftStore.getState();
    if (store.copied) {
      store.clearCopied();
      textarea.select();
    } else {
      const { start, end } = selection ?? {
        start: textarea.value.length,
        end: textarea.value.length,
      };
      textarea.setSelectionRange(start, end);
    }
    return () => {
      selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    };
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    mountedTextarea = textarea;
    return () => {
      if (mountedTextarea === textarea) mountedTextarea = null;
    };
  }, []);

  useEffect(() => {
    if (!focusRequested) return;
    usePromptDraftStore.getState().clearFocusRequest();
    textareaRef.current?.focus();
  }, [focusRequested]);

  useEffect(() => {
    const onResize = () => setRect((current) => viewportRect(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setText = (value: string) => usePromptDraftStore.getState().setText(value);

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

  /**
   * Puts in text that took a while to make, such as a dropped file's reference once it's copied,
   * spaced from the words beside it unless `spaced` is false, where `then` says the cursor was
   * when it was asked for. With the draft closed, or moving to a viewer, it goes into the text
   * kept for it.
   */
  const insertLater = (reference: string, then: DraftCursor, spaced = true) => {
    const textarea = mountedTextarea;
    const store = usePromptDraftStore.getState();
    const now = textarea
      ? cursorIn(textarea)
      : { text: store.text, start: store.text.length, end: store.text.length };
    const place = referencePlace(then, now);
    const value = spaced ? spaceReference(now.text, place.start, place.end, reference) : reference;
    const after = now.text.slice(0, place.start) + value + now.text.slice(place.end);
    for (const pending of pendingCursors) {
      if (pending !== then) {
        Object.assign(pending, cursorAfterInsert(pending, now.text, place, value.length, after));
      }
    }
    if (!textarea) {
      store.setText(after);
      return;
    }
    textarea.setSelectionRange(place.start, place.end);
    if (document.activeElement === textarea) {
      replaceSelection(textarea, value);
    } else {
      // Without focus, which it would take from where the user is now; this can't be undone.
      textarea.setRangeText(value, place.start, place.end, 'end');
      setText(textarea.value);
    }
    // Back where the user has the cursor, moved along if the reference went in before it.
    textarea.setSelectionRange(
      positionAfterInsert(now.start, place, value.length),
      positionAfterInsert(now.end, place, value.length)
    );
  };

  /**
   * Copies files from outside Komla into the workspace on screen, its SSH host's for a remote
   * one, and puts in their `@path`s once copied.
   */
  const importFiles = (files: File[], then: DraftCursor) => {
    if (files.length === 0) return;
    const endUpload = usePromptDraftStore.getState().startUpload(uploadingLabel(files));
    pendingCursors.add(then);
    void importFilesAsReferences(files, (sourcePath, preferredName) =>
      window.api.importWorkspaceExternalFile(workspaceId, sourcePath, preferredName)
    )
      .then((references) => {
        if (!references) return;
        refreshFileListAfterImport(workspaceId);
        insertLater(references.trimEnd(), then);
      })
      .catch((err: unknown) => {
        console.warn('Failed to import files into the prompt draft:', err);
        useToastStore
          .getState()
          .addToast(couldNotUploadMessage(files.map((file) => file.name)), 'error');
      })
      .finally(() => {
        pendingCursors.delete(then);
        endUpload();
      });
  };

  /** Copies the image on the clipboard into the workspace on screen, putting in its `@path`. */
  const importScreenshot = (then: DraftCursor) => {
    const endUpload = usePromptDraftStore.getState().startUpload('Pasting the image…');
    pendingCursors.add(then);
    window.api
      .importClipboardImage(workspaceId)
      .then((path) => {
        if (!path) return;
        refreshFileListAfterImport(workspaceId);
        insertLater(`@${path}`, then);
      })
      .catch((err: unknown) => {
        console.warn('Failed to paste clipboard image:', err);
        useToastStore.getState().addToast('Couldn’t paste the image', 'error');
      })
      .finally(() => {
        pendingCursors.delete(then);
        endUpload();
      });
  };

  const onDragOver = (event: ReactDragEvent) => {
    // A note being saved would miss what a drop puts in.
    if (saving) return;
    const kind = dropKind(event.dataTransfer);
    if (!kind) return;
    // Not the viewers' behind it, which take drops of their own.
    event.preventDefault();
    event.stopPropagation();
    // The file panel allows only moves, for its own, and a copy it doesn't allow takes no drop.
    if (kind === 'files') event.dataTransfer.dropEffect = 'copy';
    setDropFeedback(kind);
  };

  const onDragLeave = (event: ReactDragEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropFeedback(null);
  };

  /**
   * Puts in the `@path` of a file dragged from the file panel, or copies files dropped from
   * outside Komla into the workspace and puts in theirs.
   */
  const onDrop = (event: ReactDragEvent) => {
    setDropFeedback(null);
    const textarea = textareaRef.current;
    if (!textarea || saving) return;
    // Only the file panel's own drag: anything can claim its type.
    if (consumeTreeDragActive()) {
      const reference = event.dataTransfer.getData(AT_PATH_MIME).trim();
      if (!reference) return;
      event.preventDefault();
      event.stopPropagation();
      textarea.focus();
      const { selectionStart: start, selectionEnd: end, value } = textarea;
      replaceSelection(textarea, spaceReference(value, start, end, reference));
      return;
    }
    if (!hasFileDrop(event.dataTransfer)) return;
    const files = getTransferFiles(event.dataTransfer, window.api.getPathForFile);
    // Nothing on disk, such as an image from a web page: the text box takes its text, if any.
    if (files.length === 0 && event.dataTransfer.types.includes('text/plain')) return;
    event.preventDefault();
    event.stopPropagation();
    textarea.focus();
    importFiles(
      files.map(({ file }) => file),
      cursorIn(textarea)
    );
  };

  /**
   * Copies files pasted from outside Komla into the workspace, as dropped ones, and a screenshot
   * on the clipboard too, as the draft can't hand an agent the image itself.
   */
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    // Read-only, as a note being saved would miss it.
    if (saving) return;
    const then = cursorIn(event.currentTarget);
    const files = getTransferFiles(event.clipboardData, window.api.getPathForFile);
    if (files.length > 0) {
      event.preventDefault();
      // What a paste would have put in, for folders that turn out not to be files.
      const pasted = event.clipboardData.getData('text/plain');
      pendingCursors.add(then);
      void readableFilePaths(files).then((paths) => {
        const readable = files.filter(({ path }) => paths.includes(path));
        pendingCursors.delete(then);
        if (readable.length > 0) {
          importFiles(
            readable.map(({ file }) => file),
            then
          );
        } else if (pasted) {
          insertLater(pasted, then, false);
        }
      });
      return;
    }
    // Text wins, as in terminals: apps that copy both, like spreadsheets, mean the text.
    if (
      event.clipboardData.types.includes('text/plain') ||
      !hasClipboardImage(event.clipboardData)
    ) {
      return;
    }
    event.preventDefault();
    importScreenshot(then);
  };

  /** Whether files are still copying in, whose references the prompt would miss; says so if so. */
  const waitForUploads = () => {
    if (!usePromptDraftStore.getState().uploads.length) return false;
    useToastStore.getState().addToast('Wait for the upload to finish', 'info');
    return true;
  };

  /** Copies the whole prompt and closes, for it to be pasted where focus goes back to. */
  const copyAndClose = () => {
    if (waitForUploads()) return;
    const prompt = (textareaRef.current?.value ?? text).trimEnd();
    if (!prompt.trim()) return;
    window.api.copyToClipboard(prompt);
    useToastStore.getState().addToast('Copied the prompt', 'success');
    closePromptDraft({ copied: true });
  };

  /**
   * Moves the prompt into a new note in the workspace, for one to keep or keep working on. The
   * draft takes no typing meanwhile, which the note wouldn't have.
   */
  const saveAsNote = async () => {
    const content = textareaRef.current?.value ?? text;
    if (saving || !content.trim() || waitForUploads()) return;
    setSaving(true);
    const saved = await createNote(workspaceId, content);
    setSaving(false);
    if (!saved) return;
    usePromptDraftStore.getState().setText('');
    closePromptDraft();
  };

  const close = () => closePromptDraft();

  /** Whether Cmd+C takes the whole prompt: with nothing, or all of it, selected. */
  const copiesWhole = (textarea: HTMLTextAreaElement) => {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    return start === end || (start === 0 && end === value.length);
  };

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
    const plain = !event.shiftKey && !event.altKey;
    const textarea = textareaRef.current;
    // Cmd+C as the platform has it, in the text: on a button it's no copy.
    const copyKey = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey;
    if (
      (event.key === 'Enter' && plain) ||
      (plain &&
        copyKey &&
        event.key.toLowerCase() === 'c' &&
        event.target === textarea &&
        copiesWhole(textarea))
    ) {
      event.preventDefault();
      copyAndClose();
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
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
            label="Save as note"
            size="xs"
            disabled={saving || !text.trim() || !!upload}
            onMouseDown={keepFocus}
            onClick={() => void saveAsNote()}
          >
            <NotePencil className="size-3.5" />
          </IconButton>
          <IconButton
            label="Copy and close"
            shortcut={copyShortcut}
            size="xs"
            disabled={!text.trim() || !!upload}
            onMouseDown={keepFocus}
            onClick={copyAndClose}
          >
            <Copy className="size-3.5" />
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
          readOnly={saving}
          onChange={(event) => setText(event.target.value)}
          onPaste={onPaste}
          // Paths and code would be underlined as misspelled.
          spellCheck={false}
          placeholder={`Draft a prompt to paste into an agent. ${insertShortcut} puts in the file you're looking at.`}
          className="thin-scrollbar min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[13px] leading-5 text-foreground outline-hidden placeholder:text-muted-foreground"
        />
      </div>
      {dropFeedback && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-primary/60 bg-background/60 text-sm font-medium text-foreground backdrop-blur-[1px] reduce-effects:bg-background/90">
          {dropFeedback === 'files' ? 'Drop to upload' : 'Drop to insert path'}
        </div>
      )}
      {upload && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute right-4 bottom-3 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1.5 rounded-md border bg-card/95 px-2 py-1 text-xs text-foreground shadow-sm"
        >
          <Spinner size="xs" className="text-primary" />
          <span className="truncate">{upload}</span>
        </div>
      )}
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

/**
 * Puts in a reference to the file the user is looking at, with its selected lines. A short
 * "@path", with the file named in its tooltip, as a long name would leave little to drag by.
 */
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
        <span className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            aria-label={label}
            disabled={!viewed}
            onMouseDown={keepFocus}
            onClick={onInsert}
            className="h-6 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            @path
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
