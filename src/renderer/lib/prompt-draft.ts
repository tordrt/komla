import { getFocusedPromptTerminalId } from '@/lib/focused-terminal';
import { focusTerminalRenderer } from '@/lib/terminal-renderer-runtime';
import { selectPromptDraftWorkspace, usePromptDraftStore } from '@/stores/prompt-draft.store';

import { appendDraft } from '../../shared/lib/prompt-draft-text';
import { PROMPT_DRAFT_MIN_SIZE } from '../../shared/types';

import type { PromptDraftRect, PromptDraftText } from '../../shared/types';

/** Marks the prompt draft's window, which viewers it floats over leave its keys and clicks to. */
export const PROMPT_DRAFT_ATTRIBUTE = 'data-prompt-draft';

/** Whether an event's target, or an element, is in the prompt draft. */
export function isInPromptDraft(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(`[${PROMPT_DRAFT_ATTRIBUTE}]`) !== null;
}

function isPromptDraftFocused(): boolean {
  return isInPromptDraft(document.activeElement);
}

// What had focus when the draft opened, and the workspace on screen then, which gets it back when
// the draft closes over that workspace. Weakly held, as a pane can go with the draft still open.
let returnFocusTo: { element: WeakRef<HTMLElement>; workspaceId: string } | null = null;

/**
 * Shows the prompt draft and gives it focus, while a workspace is on screen for it to show over,
 * or in its own window while it's popped out. A draft open in this window as another popped out
 * stays here until closed.
 */
export function openPromptDraft(): void {
  const store = usePromptDraftStore.getState();
  if (store.poppedOut.poppedOut && !store.isOpen) {
    window.api.showPromptDraftWindow();
    return;
  }
  const workspaceId = selectPromptDraftWorkspace(store);
  if (!workspaceId) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !isInPromptDraft(active)) {
    returnFocusTo = { element: new WeakRef(active), workspaceId };
  }
  store.show();
}

/**
 * Hides the prompt draft, keeping its text, and gives focus back if it had it. Once `copied`, it
 * shows next with its text selected.
 */
export function closePromptDraft(options?: { copied?: boolean }): void {
  const store = usePromptDraftStore.getState();
  if (store.poppedOut.poppedOut && !store.isOpen) {
    window.api.hidePromptDraftWindow();
    return;
  }
  const draft = document.activeElement?.closest(`[${PROMPT_DRAFT_ATTRIBUTE}]`);
  // The workspace on screen, as the draft closes: what had focus in another one is hidden now.
  const workspaceId = selectPromptDraftWorkspace(store);
  const target =
    returnFocusTo?.workspaceId === workspaceId ? returnFocusTo.element.deref() : undefined;
  returnFocusTo = null;
  store.hide(options);
  if (!draft) return;
  if (target?.isConnected) {
    target.focus();
    return;
  }
  // Opened from a menu or the Command Center, which are gone: to the workspace's terminal, unless
  // the draft was over a viewer, which covers the terminals or traps focus.
  if (draft.parentElement?.closest('[role="dialog"]') || !workspaceId) return;
  const terminalId = getFocusedPromptTerminalId(workspaceId);
  if (terminalId) focusTerminalRenderer(terminalId);
}

/**
 * Shows the prompt draft, or gives it focus if it's open; closes it if it has focus. Popped out,
 * it has focus in its own window, which takes the shortcut there.
 */
export function togglePromptDraft(): void {
  if (usePromptDraftStore.getState().isOpen && isPromptDraftFocused()) closePromptDraft();
  else openPromptDraft();
}

/**
 * Pops the draft out into a window of its own, which stays over other apps, just where it shows
 * in this one: `rect`. Its text goes with it, until it pops back in.
 */
export function popOutPromptDraft(draft: PromptDraftText, rect: PromptDraftRect): void {
  const store = usePromptDraftStore.getState();
  window.api.popOutPromptDraft(draft, rect);
  returnFocusTo = null;
  // Until main says so, for the shortcut to go to the new window meanwhile.
  store.setPoppedOut({ poppedOut: true, visible: true });
  store.hide();
  store.setText('');
  store.setSelection(null);
}

/**
 * Puts the popped-out draft back in this window and opens it. Text written here meanwhile, in a
 * window other than the one it popped out of, comes first.
 */
export function popInPromptDraft(draft: PromptDraftText): void {
  const store = usePromptDraftStore.getState();
  store.setPoppedOut({ poppedOut: false, visible: false });
  store.clearCopied();
  const joined = appendDraft(store.text, draft);
  store.setText(joined.text);
  store.setSelection({ start: joined.selectionStart, end: joined.selectionEnd });
  openPromptDraft();
}

/** Closes the prompt draft if it has focus, as Cmd+W does; returns whether it did. */
export function closeFocusedPromptDraft(): boolean {
  if (!isPromptDraftFocused()) return false;
  closePromptDraft();
  return true;
}

/**
 * The text to put in at the cursor for a reference: spaced from the words beside it, and
 * followed by a space at the end of the draft, so typing can go on.
 */
export function spaceReference(text: string, start: number, end: number, reference: string) {
  const before = start > 0 && !/\s/.test(text[start - 1]) ? ' ' : '';
  const after = end < text.length && /\s/.test(text[end]) ? '' : ' ';
  return `${before}${reference}${after}`;
}

/** The draft's text and the selection in it, or the cursor where `start` and `end` are one. */
export interface DraftCursor {
  text: string;
  start: number;
  end: number;
}

/**
 * Where a reference that took a while to make goes in, such as a dropped file's once it's copied:
 * where the cursor was when it was asked for, if the text before that hasn't changed, replacing
 * the selection then only if nothing has. Otherwise at the cursor now, after any selection, which
 * the user may be about to copy.
 */
export function referencePlace(
  then: DraftCursor,
  now: DraftCursor
): { start: number; end: number } {
  if (now.text === then.text) return { start: then.start, end: then.end };
  if (now.text.startsWith(then.text.slice(0, then.start))) {
    return { start: then.start, end: then.start };
  }
  return { start: now.end, end: now.end };
}

/**
 * Where a place in the text is once `length` characters replace `place`: after them if it was
 * where they went or inside what they replaced.
 */
export function positionAfterInsert(
  position: number,
  place: { start: number; end: number },
  length: number
): number {
  if (position < place.start) return position;
  if (position >= place.end) return position + length - (place.end - place.start);
  return place.start + length;
}

/**
 * Where a reference still on its way goes once another went in, turning `before` into `after`:
 * after that one, if it was asked for at the same place, so references dropped one after another
 * go in that order. A place whose text before it has changed already stays as it was.
 */
export function cursorAfterInsert(
  cursor: DraftCursor,
  before: string,
  place: { start: number; end: number },
  insertedLength: number,
  after: string
): DraftCursor {
  if (!before.startsWith(cursor.text.slice(0, cursor.start))) return cursor;
  const start = positionAfterInsert(cursor.start, place, insertedLength);
  // Its selection is kept only if nothing else had changed, as `referencePlace` replaces it then.
  const end =
    cursor.text === before
      ? Math.max(start, positionAfterInsert(cursor.end, place, insertedLength))
      : start;
  return { text: after, start, end };
}

export type DraftRect = PromptDraftRect;

export const DRAFT_MIN_WIDTH = PROMPT_DRAFT_MIN_SIZE.width;
export const DRAFT_MIN_HEIGHT = PROMPT_DRAFT_MIN_SIZE.height;
/** How far the draft's resize handles reach outside its border. */
export const DRAFT_HANDLE_OUTSET = 6;
// Kept this far inside the window, so the header can always be grabbed, and its resize handles
// stay clear of the window's own resize border.
const EDGE = DRAFT_HANDLE_OUTSET + 8;
const RECT_STORAGE_KEY = 'komla.promptDraftRect';

/** `value` within `min` and `max`, in whole pixels. */
function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(value, max)));
}

/** At the bottom right, above the status bar. */
export function defaultDraftRect(viewportWidth: number, viewportHeight: number): DraftRect {
  const width = 440;
  const height = 280;
  return clampDraftRect(
    { x: viewportWidth - width - 24, y: viewportHeight - height - 48, width, height },
    viewportWidth,
    viewportHeight
  );
}

/**
 * Fits a rect inside the window, as large as it is if it fits, never under the minimum size.
 * `top` is as high as it goes, such as under the title bar, where the window's own controls are.
 */
export function clampDraftRect(
  rect: DraftRect,
  viewportWidth: number,
  viewportHeight: number,
  top = EDGE
): DraftRect {
  const width = clamp(rect.width, DRAFT_MIN_WIDTH, viewportWidth - 2 * EDGE);
  const height = clamp(rect.height, DRAFT_MIN_HEIGHT, viewportHeight - top - EDGE);
  return {
    x: clamp(rect.x, EDGE, viewportWidth - width - EDGE),
    y: clamp(rect.y, top, viewportHeight - height - EDGE),
    width,
    height,
  };
}

/** A side or corner of the draft that can be dragged to resize it, as compass points. */
export type DraftEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * The rect for dragging an edge or corner of `start` this far: the opposite sides stay put, and
 * it grows only to the window's edge, or `top` above, and shrinks only to the minimum size, so it
 * never moves instead.
 */
export function resizeDraftRect(
  start: DraftRect,
  edge: DraftEdge,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
  top = EDGE
): DraftRect {
  let { x, y, width, height } = start;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (edge.includes('e')) {
    width = clamp(start.width + dx, DRAFT_MIN_WIDTH, viewportWidth - EDGE - x);
  }
  if (edge.includes('w')) {
    x = clamp(start.x + dx, EDGE, right - DRAFT_MIN_WIDTH);
    width = right - x;
  }
  if (edge.includes('s')) {
    height = clamp(start.height + dy, DRAFT_MIN_HEIGHT, viewportHeight - EDGE - y);
  }
  if (edge.includes('n')) {
    y = clamp(start.y + dy, top, bottom - DRAFT_MIN_HEIGHT);
    height = bottom - y;
  }
  return { x, y, width, height };
}

/** Where the user last put the draft, in any workspace. */
export function readStoredDraftRect(): DraftRect | null {
  try {
    const raw = window.localStorage.getItem(RECT_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { x, y, width, height } = value as Record<string, unknown>;
    return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? ({ x, y, width, height } as DraftRect)
      : null;
  } catch {
    return null;
  }
}

export function storeDraftRect(rect: DraftRect): void {
  try {
    window.localStorage.setItem(RECT_STORAGE_KEY, JSON.stringify(rect));
  } catch {
    // Storage can be unavailable; the draft still goes back to its default place next time.
  }
}
