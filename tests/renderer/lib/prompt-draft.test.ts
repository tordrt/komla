/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { focusTerminalRenderer, getFocusedPromptTerminalId } = vi.hoisted(() => ({
  focusTerminalRenderer: vi.fn(),
  getFocusedPromptTerminalId: vi.fn((): string | null => null),
}));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  focusTerminalRenderer,
}));
vi.mock('../../../src/renderer/lib/focused-terminal', () => ({
  getFocusedPromptTerminalId,
}));

import {
  clampDraftRect,
  closeFocusedPromptDraft,
  closePromptDraft,
  defaultDraftRect,
  DRAFT_MIN_HEIGHT,
  DRAFT_MIN_WIDTH,
  openPromptDraft,
  readStoredDraftRect,
  positionAfterInsert,
  referencePlace,
  resizeDraftRect,
  spaceReference,
  storeDraftRect,
  togglePromptDraft,
} from '../../../src/renderer/lib/prompt-draft';
import { usePromptDraftStore } from '../../../src/renderer/stores/prompt-draft.store';

describe('spaceReference', () => {
  it('ends with a space at the end of the draft, so typing can go on', () => {
    expect(spaceReference('', 0, 0, '@a.ts')).toBe('@a.ts ');
    expect(spaceReference('Look at ', 8, 8, '@a.ts')).toBe('@a.ts ');
  });

  it('keeps the reference apart from the words beside it', () => {
    expect(spaceReference('Look at', 7, 7, '@a.ts')).toBe(' @a.ts ');
    expect(spaceReference('Fixand test', 3, 3, '@a.ts')).toBe(' @a.ts ');
  });

  it('adds no space where there is one already', () => {
    expect(spaceReference('Look at  please', 8, 8, '@a.ts')).toBe('@a.ts');
    expect(spaceReference('Line\n', 5, 5, '@a.ts')).toBe('@a.ts ');
    expect(spaceReference('Line\nnext', 5, 5, '@a.ts')).toBe('@a.ts ');
    expect(spaceReference('a \nb', 2, 2, '@x')).toBe('@x');
  });

  it('replaces a selection, spaced from what is left on either side', () => {
    expect(spaceReference('see THIS now', 4, 8, '@a.ts')).toBe('@a.ts');
    expect(spaceReference('seeTHISnow', 3, 7, '@a.ts')).toBe(' @a.ts ');
  });
});

describe('referencePlace', () => {
  const at = (text: string, start: number, end = start) => ({ text, start, end });

  it('goes where the cursor was when it was asked for, with the text as it was', () => {
    expect(referencePlace(at('Look at', 7), at('Look at', 2))).toEqual({ start: 7, end: 7 });
    expect(referencePlace(at('see THIS', 4, 8), at('see THIS', 8))).toEqual({ start: 4, end: 8 });
  });

  it('stays there with typing after it, replacing nothing then', () => {
    expect(referencePlace(at('Look at', 7), at('Look at and fix', 15))).toEqual({
      start: 7,
      end: 7,
    });
    expect(referencePlace(at('see THIS', 4, 8), at('see THIS now', 12))).toEqual({
      start: 4,
      end: 4,
    });
  });

  it('goes to the cursor now once the text before it has changed, after what is selected', () => {
    expect(referencePlace(at('Look at', 7), at('Look', 4))).toEqual({ start: 4, end: 4 });
    // Never over a selection made since, which the user may be about to copy.
    expect(referencePlace(at('Look at', 7), at('Now look at', 2, 5))).toEqual({
      start: 5,
      end: 5,
    });
  });
});

describe('positionAfterInsert', () => {
  it('keeps a place before the insert, and moves one after it along', () => {
    expect(positionAfterInsert(2, { start: 4, end: 8 }, 10)).toBe(2);
    expect(positionAfterInsert(4, { start: 4, end: 8 }, 10)).toBe(14);
    expect(positionAfterInsert(12, { start: 4, end: 8 }, 10)).toBe(18);
  });

  it('puts a place inside what was replaced after the insert, not inside it', () => {
    expect(positionAfterInsert(6, { start: 4, end: 8 }, 10)).toBe(14);
  });

  it('puts a place where the insert goes after it', () => {
    expect(positionAfterInsert(4, { start: 4, end: 4 }, 3)).toBe(7);
  });
});

describe('clampDraftRect', () => {
  it('keeps a rect that fits', () => {
    const rect = { x: 100, y: 50, width: 400, height: 300 };
    expect(clampDraftRect(rect, 1200, 800)).toEqual(rect);
  });

  it('moves a rect back inside the window, so its header stays in reach', () => {
    expect(clampDraftRect({ x: 1100, y: -40, width: 400, height: 300 }, 1200, 800)).toEqual({
      x: 786,
      y: 14,
      width: 400,
      height: 300,
    });
  });

  it('shrinks a rect larger than the window, never under the minimum size', () => {
    expect(clampDraftRect({ x: 0, y: 0, width: 5000, height: 5000 }, 1200, 800)).toEqual({
      x: 14,
      y: 14,
      width: 1172,
      height: 772,
    });
    const tiny = clampDraftRect({ x: 0, y: 0, width: 10, height: 10 }, 1200, 800);
    expect([tiny.width, tiny.height]).toEqual([DRAFT_MIN_WIDTH, DRAFT_MIN_HEIGHT]);
  });

  it('starts at the bottom right, inside the window', () => {
    const rect = defaultDraftRect(1200, 800);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1200 - 8);
    expect(rect.y + rect.height).toBeLessThanOrEqual(800 - 8);
    expect(rect.x).toBeGreaterThan(600);
    expect(rect.y).toBeGreaterThan(400);
  });
});

describe('resizeDraftRect', () => {
  const start = { x: 400, y: 300, width: 440, height: 280 };

  it('moves only the sides dragged, the opposite ones staying put', () => {
    expect(resizeDraftRect(start, 'se', 60, 40, 1200, 800)).toEqual({
      x: 400,
      y: 300,
      width: 500,
      height: 320,
    });
    expect(resizeDraftRect(start, 'nw', -100, -50, 1200, 800)).toEqual({
      x: 300,
      y: 250,
      width: 540,
      height: 330,
    });
    expect(resizeDraftRect(start, 'e', 60, 40, 1200, 800)).toEqual({ ...start, width: 500 });
    expect(resizeDraftRect(start, 'n', 60, 40, 1200, 800)).toEqual({
      ...start,
      y: 340,
      height: 240,
    });
  });

  it('grows up only to the top it is given', () => {
    expect(resizeDraftRect(start, 'n', 0, -5000, 1200, 800, 46)).toEqual({
      ...start,
      y: 46,
      height: 534,
    });
    expect(clampDraftRect({ ...start, y: 0 }, 1200, 800, 46).y).toBe(46);
  });

  it('keeps the opposite side put through fractional pointer moves', () => {
    const rect = resizeDraftRect(start, 'nw', 0.5, 0.5, 1200, 800);
    expect([rect.x + rect.width, rect.y + rect.height]).toEqual([840, 580]);
    expect(clampDraftRect(rect, 1200, 800)).toEqual(rect);
  });

  it("grows only to the window's edge and shrinks only to the minimum size, never moving", () => {
    expect(resizeDraftRect(start, 'nw', -5000, -5000, 1200, 800)).toEqual({
      x: 14,
      y: 14,
      width: 826,
      height: 566,
    });
    expect(resizeDraftRect(start, 'se', 5000, 5000, 1200, 800)).toEqual({
      x: 400,
      y: 300,
      width: 786,
      height: 486,
    });
    expect(resizeDraftRect(start, 'nw', 5000, 5000, 1200, 800)).toEqual({
      x: 840 - DRAFT_MIN_WIDTH,
      y: 580 - DRAFT_MIN_HEIGHT,
      width: DRAFT_MIN_WIDTH,
      height: DRAFT_MIN_HEIGHT,
    });
  });
});

describe('stored draft rect', () => {
  beforeEach(() => window.localStorage.clear());

  it('reads back what was stored', () => {
    storeDraftRect({ x: 1, y: 2, width: 300, height: 200 });
    expect(readStoredDraftRect()).toEqual({
      x: 1,
      y: 2,
      width: 300,
      height: 200,
    });
  });

  it.each([
    ['nothing stored', null],
    ['not JSON', '{'],
    ['not an object', '42'],
    ['a field missing', '{"x":1,"y":2,"width":300}'],
    ['a field not a number', '{"x":"1","y":2,"width":300,"height":200}'],
    ['a field not finite', '{"x":1e999,"y":2,"width":300,"height":200}'],
  ])('ignores %s', (_, raw) => {
    if (raw !== null) window.localStorage.setItem('komla.promptDraftRect', raw);
    expect(readStoredDraftRect()).toBeNull();
  });
});

describe('opening and closing the draft', () => {
  let draft: HTMLTextAreaElement;
  let before: HTMLButtonElement;

  beforeEach(() => {
    usePromptDraftStore.setState(usePromptDraftStore.getInitialState(), true);
    usePromptDraftStore.getState().addHost('window', 'ws-1');
    // Stands in for the draft's window, which its component renders.
    const section = document.createElement('section');
    section.setAttribute('data-prompt-draft', '');
    draft = document.createElement('textarea');
    section.append(draft);
    before = document.createElement('button');
    document.body.append(before, section);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.resetAllMocks();
  });

  const isOpen = () => usePromptDraftStore.getState().isOpen;

  it('opens over the workspace on screen, asking for focus', () => {
    togglePromptDraft();
    expect(isOpen()).toBe(true);
    expect(usePromptDraftStore.getState().focusRequested).toBe(true);
  });

  it('does nothing without a workspace on screen', () => {
    usePromptDraftStore.getState().updateHost('window', null);
    togglePromptDraft();
    openPromptDraft();
    expect(isOpen()).toBe(false);
    expect(usePromptDraftStore.getState().focusRequested).toBe(false);
  });

  it('gives an open draft focus rather than closing it, unless it has focus', () => {
    togglePromptDraft();
    usePromptDraftStore.getState().clearFocusRequest();
    togglePromptDraft();
    expect(isOpen()).toBe(true);
    expect(usePromptDraftStore.getState().focusRequested).toBe(true);

    draft.focus();
    togglePromptDraft();
    expect(isOpen()).toBe(false);
  });

  it('gives focus back to what had it when the draft opened', () => {
    before.focus();
    openPromptDraft();
    draft.focus();
    closePromptDraft();
    expect(document.activeElement).toBe(before);
  });

  it("leaves what had focus in another workspace, hidden now, for this one's terminal", () => {
    getFocusedPromptTerminalId.mockReturnValue('term-2');
    before.focus();
    openPromptDraft();
    usePromptDraftStore.getState().updateHost('window', 'ws-2');
    draft.focus();
    closePromptDraft();
    expect(getFocusedPromptTerminalId).toHaveBeenCalledWith('ws-2');
    expect(focusTerminalRenderer).toHaveBeenCalledWith('term-2');
  });

  it('remembers a copy for the next open, which selects the text to type over', () => {
    openPromptDraft();
    closePromptDraft({ copied: true });
    expect(usePromptDraftStore.getState().copied).toBe(true);
    openPromptDraft();
    closePromptDraft();
    expect(usePromptDraftStore.getState().copied).toBe(false);
  });

  it("gives focus to the workspace's terminal when what had it is gone, as a menu", () => {
    getFocusedPromptTerminalId.mockReturnValue('term-1');
    const menuItem = document.createElement('div');
    menuItem.tabIndex = -1;
    document.body.append(menuItem);
    menuItem.focus();
    openPromptDraft();
    menuItem.remove();
    draft.focus();
    closePromptDraft();
    expect(getFocusedPromptTerminalId).toHaveBeenCalledWith('ws-1');
    expect(focusTerminalRenderer).toHaveBeenCalledWith('term-1');
  });

  it("leaves a viewer's focus to the viewer when what had it is gone", () => {
    getFocusedPromptTerminalId.mockReturnValue('term-1');
    const viewer = document.createElement('div');
    viewer.setAttribute('role', 'dialog');
    viewer.append(draft.parentElement!);
    document.body.append(viewer);
    openPromptDraft();
    draft.focus();
    closePromptDraft();
    expect(focusTerminalRenderer).not.toHaveBeenCalled();
  });

  it('leaves focus alone when the draft closes without it', () => {
    before.focus();
    openPromptDraft();
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    closePromptDraft();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('keeps the text when it closes, whichever workspace is on screen next', () => {
    usePromptDraftStore.getState().setText('Fix the bug');
    openPromptDraft();
    closePromptDraft();
    usePromptDraftStore.getState().updateHost('window', 'ws-2');
    expect(usePromptDraftStore.getState().text).toBe('Fix the bug');
  });

  it('closes on Cmd+W only while it has focus', () => {
    openPromptDraft();
    before.focus();
    expect(closeFocusedPromptDraft()).toBe(false);
    expect(isOpen()).toBe(true);
    draft.focus();
    expect(closeFocusedPromptDraft()).toBe(true);
    expect(isOpen()).toBe(false);
  });

  it('shows and hides its own window while popped out, with or without a workspace here', () => {
    const api = { showPromptDraftWindow: vi.fn(), hidePromptDraftWindow: vi.fn() };
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    usePromptDraftStore.getState().setPoppedOut({ poppedOut: true, visible: false });
    usePromptDraftStore.getState().updateHost('window', null);

    togglePromptDraft();
    openPromptDraft();
    closePromptDraft();

    expect(api.showPromptDraftWindow).toHaveBeenCalledTimes(2);
    expect(api.hidePromptDraftWindow).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it("closes a draft still open here as another window's pops out, leaving that one be", () => {
    const api = { showPromptDraftWindow: vi.fn(), hidePromptDraftWindow: vi.fn() };
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    openPromptDraft();
    usePromptDraftStore.getState().setPoppedOut({ poppedOut: true, visible: true });

    closePromptDraft();
    expect(isOpen()).toBe(false);
    expect(api.hidePromptDraftWindow).not.toHaveBeenCalled();

    closePromptDraft();
    expect(api.hidePromptDraftWindow).toHaveBeenCalledTimes(1);
  });
});
