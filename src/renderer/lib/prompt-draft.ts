import { getFocusedPromptTerminalId } from '@/lib/focused-terminal';
import { focusTerminalRenderer } from '@/lib/terminal-renderer-runtime';
import { selectPromptDraftWorkspace, usePromptDraftStore } from '@/stores/prompt-draft.store';

/** Marks the prompt draft's window, which viewers it floats over leave its keys and clicks to. */
export const PROMPT_DRAFT_ATTRIBUTE = 'data-prompt-draft';

/** Whether an event's target, or an element, is in the prompt draft. */
export function isInPromptDraft(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(`[${PROMPT_DRAFT_ATTRIBUTE}]`) !== null;
}

function isPromptDraftFocused(): boolean {
  return isInPromptDraft(document.activeElement);
}

// What had focus when each workspace's draft opened, which gets it back when that draft closes.
// Weakly held, as a workspace can go with its draft still open.
const returnFocusTo = new Map<string, WeakRef<HTMLElement>>();

/** Shows the workspace's prompt draft and gives it focus. */
export function openPromptDraft(workspaceId: string): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !isInPromptDraft(active)) {
    returnFocusTo.set(workspaceId, new WeakRef(active));
  }
  usePromptDraftStore.getState().open(workspaceId);
}

/** Hides the workspace's prompt draft, keeping its text, and gives focus back if it had it. */
export function closePromptDraft(workspaceId: string): void {
  const draft = document.activeElement?.closest(`[${PROMPT_DRAFT_ATTRIBUTE}]`);
  const target = returnFocusTo.get(workspaceId)?.deref();
  returnFocusTo.delete(workspaceId);
  usePromptDraftStore.getState().close(workspaceId);
  if (!draft) return;
  if (target?.isConnected) {
    target.focus();
    return;
  }
  // Opened from a menu or the Command Center, which are gone: to the workspace's terminal, unless
  // the draft was over a viewer, which covers the terminals or traps focus.
  if (draft.parentElement?.closest('[role="dialog"]')) return;
  const terminalId = getFocusedPromptTerminalId(workspaceId);
  if (terminalId) focusTerminalRenderer(terminalId);
}

/**
 * Shows the prompt draft of the workspace on screen, or gives it focus if it's open; closes it if
 * it has focus.
 */
export function togglePromptDraft(): void {
  const store = usePromptDraftStore.getState();
  const workspaceId = selectPromptDraftWorkspace(store);
  if (!workspaceId) return;
  if (store.openByWorkspace[workspaceId] && isPromptDraftFocused()) closePromptDraft(workspaceId);
  else openPromptDraft(workspaceId);
}

/** Closes the prompt draft if it has focus, as Cmd+W does; returns whether it did. */
export function closeFocusedPromptDraft(): boolean {
  if (!isPromptDraftFocused()) return false;
  const workspaceId = selectPromptDraftWorkspace(usePromptDraftStore.getState());
  if (!workspaceId) return false;
  closePromptDraft(workspaceId);
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

export interface DraftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DRAFT_MIN_WIDTH = 280;
export const DRAFT_MIN_HEIGHT = 140;
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
