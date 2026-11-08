/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PoppedOutPromptDraft } from '../../../../src/renderer/components/prompt-draft/PoppedOutPromptDraft';
import { useShortcutsStore } from '../../../../src/renderer/stores/shortcuts.store';

import type { PromptDraftText, PromptDraftWindowContext } from '../../../../src/shared/types';

/** What main sends the page, by channel, once it listens. */
const main = {
  draft: null as ((draft: PromptDraftText) => void) | null,
  context: null as ((context: PromptDraftWindowContext | null) => void) | null,
  insert: null as ((reference: string) => void) | null,
  noteSaved: null as ((saved: boolean) => void) | null,
};

function listen<K extends keyof typeof main>(key: K) {
  return vi.fn((callback: NonNullable<(typeof main)[K]>) => {
    main[key] = callback as (typeof main)[K];
    return () => {
      main[key] = null;
    };
  });
}

const api = {
  platform: 'linux',
  copyToClipboard: vi.fn(),
  getShortcuts: vi.fn(() =>
    Promise.resolve({ shortcuts: { 'promptDraft.toggle': 'Cmd+Shift+X' } })
  ),
  onPromptDraftWindowDraft: listen('draft'),
  onPromptDraftWindowContext: listen('context'),
  onPromptDraftWindowInsert: listen('insert'),
  onPromptDraftWindowNoteSaved: listen('noteSaved'),
  requestPromptDraftWindowState: vi.fn(),
  promptDraftWindowReady: vi.fn(),
  setPromptDraftWindowText: vi.fn(),
  requestPromptDraftWindowReference: vi.fn(),
  savePromptDraftWindowAsNote: vi.fn(),
  closePromptDraftWindow: vi.fn(),
  popInPromptDraft: vi.fn(),
};

const theme = { className: 'dark', style: '--background: 1 2 3;' };
const context: PromptDraftWindowContext = {
  theme,
  workspaceId: 'ws-1',
  viewedFileName: 'server.ts',
};

const prompt = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' });

/** The page, once main has sent it the draft and what's on screen in Komla. */
function renderLoaded(
  draft: PromptDraftText = { text: 'Fix the header', selectionStart: 4, selectionEnd: 4 },
  onScreen: PromptDraftWindowContext | null = context
) {
  const view = render(<PoppedOutPromptDraft />);
  expect(api.requestPromptDraftWindowState).toHaveBeenCalled();
  act(() => main.draft?.(draft));
  act(() => main.context?.(onScreen));
  return view;
}

describe('PoppedOutPromptDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    useShortcutsStore.setState({ config: null });
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  it("shows the draft in Komla's theme, with the cursor where it was, then tells main", () => {
    render(<PoppedOutPromptDraft />);
    act(() => main.draft?.({ text: 'Fix the header', selectionStart: 4, selectionEnd: 7 }));
    // Not before it has Komla's theme.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(api.promptDraftWindowReady).not.toHaveBeenCalled();

    act(() => main.context?.(context));

    expect(prompt()).toHaveValue('Fix the header');
    expect(prompt()).toHaveFocus();
    expect([prompt().selectionStart, prompt().selectionEnd]).toEqual([4, 7]);
    expect(document.documentElement.className).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('1 2 3');
    expect(api.promptDraftWindowReady).toHaveBeenCalledTimes(1);
  });

  it("puts the cursor where main says as another window's draft joins this one", () => {
    renderLoaded();
    const joined = 'Fix the header\n\nThen the footer';
    act(() => main.draft?.({ text: joined, selectionStart: 20, selectionEnd: 31 }));
    expect(prompt()).toHaveValue(joined);
    expect([prompt().selectionStart, prompt().selectionEnd]).toEqual([20, 31]);
  });

  it('tells main the text as it changes, with the cursor', async () => {
    renderLoaded({ text: '', selectionStart: 0, selectionEnd: 0 });
    await userEvent.type(prompt(), 'Hi');
    expect(api.setPromptDraftWindowText).toHaveBeenLastCalledWith({
      text: 'Hi',
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("puts in a reference to the file on screen in Komla, as Komla's window gives it", async () => {
    renderLoaded({ text: 'Explain', selectionStart: 7, selectionEnd: 7 });
    await userEvent.click(screen.getByRole('button', { name: 'Insert @path to server.ts' }));
    expect(api.requestPromptDraftWindowReference).toHaveBeenCalledTimes(1);

    act(() => main.insert?.('@server.ts:1-3'));
    expect(prompt()).toHaveValue('Explain @server.ts:1-3 ');

    await userEvent.keyboard('{Control>}{Shift>}c{/Shift}{/Control}');
    expect(api.requestPromptDraftWindowReference).toHaveBeenCalledTimes(2);
  });

  it('has no file to refer to, or workspace to save a note in, without a Komla window', () => {
    renderLoaded(undefined, null);
    expect(
      screen.getByRole('button', { name: 'Open a file in Komla to refer to it' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as note' })).toBeDisabled();
  });

  it('copies the prompt and closes, selected for the next prompt to replace', async () => {
    renderLoaded({ text: 'Fix the header @server.ts ', selectionStart: 26, selectionEnd: 26 });
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(api.copyToClipboard).toHaveBeenCalledWith('Fix the header @server.ts');
    expect(api.closePromptDraftWindow).toHaveBeenCalledWith({ copied: true });
    expect(api.setPromptDraftWindowText).toHaveBeenLastCalledWith({
      text: 'Fix the header @server.ts ',
      selectionStart: 0,
      selectionEnd: 26,
    });
  });

  it('closes on Escape or its own shortcut, keeping the text', async () => {
    renderLoaded();
    await act(() => useShortcutsStore.getState().loadShortcuts());

    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Control>}{Shift>}x{/Shift}{/Control}');

    expect(api.closePromptDraftWindow.mock.calls).toEqual([
      [{ copied: false }],
      [{ copied: false }],
    ]);
    expect(api.copyToClipboard).not.toHaveBeenCalled();
  });

  it('saves the prompt as a note in Komla, emptying the draft once saved', async () => {
    renderLoaded({ text: 'Keep this plan', selectionStart: 14, selectionEnd: 14 });
    await userEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    expect(api.savePromptDraftWindowAsNote).toHaveBeenCalledWith('Keep this plan');
    // No typing meanwhile, which the note would miss.
    expect(prompt()).toHaveAttribute('readonly');

    act(() => main.noteSaved?.(false));
    expect(prompt()).toHaveValue('Keep this plan');
    expect(prompt()).not.toHaveAttribute('readonly');

    await userEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    act(() => main.noteSaved?.(true));
    expect(prompt()).toHaveValue('');
    expect(api.setPromptDraftWindowText).toHaveBeenLastCalledWith({
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
  });

  it('puts the draft back in Komla, with the cursor', async () => {
    renderLoaded({ text: 'Fix the header', selectionStart: 3, selectionEnd: 3 });
    await userEvent.click(screen.getByRole('button', { name: 'Put back in Komla' }));
    expect(api.popInPromptDraft).toHaveBeenCalledWith({
      text: 'Fix the header',
      selectionStart: 3,
      selectionEnd: 3,
    });
  });
});
