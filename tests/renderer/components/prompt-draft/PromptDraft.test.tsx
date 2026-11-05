/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptDraftOutlet } from '../../../../src/renderer/components/prompt-draft/PromptDraft';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { openPromptDraft } from '../../../../src/renderer/lib/prompt-draft';
import { registerShortcutAction } from '../../../../src/renderer/lib/shortcut-actions';
import { usePromptDraftStore } from '../../../../src/renderer/stores/prompt-draft.store';
import { useShortcutsStore } from '../../../../src/renderer/stores/shortcuts.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useViewedFileStore } from '../../../../src/renderer/stores/viewed-file.store';

const api = { copyToClipboard: vi.fn(), platform: 'linux' };

function renderDraft(workspaceId: string | null = 'ws-1', onParentKeyDown = vi.fn()) {
  const view = render(
    <TooltipProvider>
      <div onKeyDown={onParentKeyDown}>
        <PromptDraftOutlet workspaceId={workspaceId} />
      </div>
    </TooltipProvider>
  );
  return { ...view, onParentKeyDown };
}

const prompt = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' });
const queryDraft = () => screen.queryByRole('dialog', { name: 'Prompt draft' });
const draftText = (workspaceId = 'ws-1') =>
  usePromptDraftStore.getState().textByWorkspace[workspaceId];

/** A file on screen in ws-1, as a viewer reports it. */
function view(name: string, reference: string) {
  act(() =>
    useViewedFileStore
      .getState()
      .show(name, { workspaceId: 'ws-1', name, getReference: () => reference })
  );
}

describe('PromptDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    window.localStorage.clear();
    usePromptDraftStore.setState(usePromptDraftStore.getInitialState(), true);
    useViewedFileStore.setState({ viewed: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('shows once opened, with focus, ready to type', async () => {
    renderDraft();
    expect(queryDraft()).toBeNull();
    act(() => openPromptDraft('ws-1'));
    expect(queryDraft()).toBeInTheDocument();
    expect(prompt()).toHaveFocus();
    await userEvent.type(prompt(), 'Fix the login bug');
    expect(draftText()).toBe('Fix the login bug');
  });

  it("keeps the text when closed, and shows each workspace's own", async () => {
    const { rerender } = renderDraft();
    act(() => openPromptDraft('ws-1'));
    await userEvent.type(prompt(), 'For one');
    await userEvent.keyboard('{Escape}');
    expect(queryDraft()).toBeNull();

    act(() => openPromptDraft('ws-1'));
    expect(prompt()).toHaveValue('For one');

    rerender(
      <TooltipProvider>
        <PromptDraftOutlet workspaceId="ws-2" />
      </TooltipProvider>
    );
    expect(queryDraft()).toBeNull();
    act(() => openPromptDraft('ws-2'));
    expect(prompt()).toHaveValue('');
  });

  it('shows only in the host on top, such as a viewer over the window', () => {
    render(
      <TooltipProvider>
        <div data-testid="window">
          <PromptDraftOutlet workspaceId="ws-1" />
        </div>
      </TooltipProvider>
    );
    act(() => openPromptDraft('ws-1'));
    const viewer = render(
      <TooltipProvider>
        <div data-testid="viewer">
          <PromptDraftOutlet workspaceId="ws-1" />
        </div>
      </TooltipProvider>
    );
    expect(screen.getAllByRole('dialog', { name: 'Prompt draft' })).toHaveLength(1);
    expect(screen.getByTestId('viewer')).toContainElement(queryDraft());

    viewer.unmount();
    expect(screen.getByTestId('window')).toContainElement(queryDraft());
  });

  it('puts in a reference to the file on screen at the cursor, spaced from the words', async () => {
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    await userEvent.type(prompt(), 'Look at');
    expect(screen.getByRole('button', { name: 'Open a file to refer to it' })).toBeDisabled();

    view('main.ts', '@src/main.ts:4-8');
    await userEvent.click(screen.getByRole('button', { name: 'Insert @path to main.ts' }));
    expect(prompt()).toHaveValue('Look at @src/main.ts:4-8 ');
    expect(prompt()).toHaveFocus();

    await userEvent.type(prompt(), 'and');
    await userEvent.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    expect(prompt()).toHaveValue('Look at @src/main.ts:4-8 and @src/main.ts:4-8 ');
  });

  it('copies the prompt, without the space a reference left at its end', async () => {
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeDisabled();
    await userEvent.type(prompt(), 'Explain @a.ts ');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(api.copyToClipboard).toHaveBeenCalledWith('Explain @a.ts');
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Copied the prompt',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(api.copyToClipboard).toHaveBeenCalledTimes(2);
  });

  it('clears the draft', async () => {
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    await userEvent.type(prompt(), 'Scrap this');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(prompt()).toHaveValue('');
    expect(draftText()).toBe('');
  });

  it('keeps Escape and Cmd keys from the viewer behind, which has shortcuts of its own', async () => {
    const { onParentKeyDown } = renderDraft();
    const keysReachingViewer = () =>
      onParentKeyDown.mock.calls.map(([event]: [{ key: string }]) => event.key);
    act(() => openPromptDraft('ws-1'));
    await userEvent.keyboard('{Control>}b{/Control}{Control>}c{/Control}');
    // Typing and modifier presses alone still reach it, for double-tap shortcuts.
    await userEvent.keyboard('x');
    expect(keysReachingViewer()).toEqual(['Control', 'Control', 'x']);

    onParentKeyDown.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(queryDraft()).toBeNull();
  });

  it('closes on its shortcut, even one bound without Cmd, which other shortcuts type as', async () => {
    useShortcutsStore.setState({
      config: { shortcuts: { 'promptDraft.toggle': 'Alt+Shift+P', 'note.new': 'Alt+N' } } as never,
    });
    const newNote = vi.fn(() => true);
    const unregister = registerShortcutAction('note.new', newNote);
    try {
      const { onParentKeyDown } = renderDraft();
      act(() => openPromptDraft('ws-1'));
      await userEvent.keyboard('{Alt>}n{/Alt}');
      expect(newNote).not.toHaveBeenCalled();
      onParentKeyDown.mockClear();
      await userEvent.keyboard('{Alt>}{Shift>}P{/Shift}{/Alt}');
      expect(queryDraft()).toBeNull();
      expect(onParentKeyDown.mock.calls.map(([event]: [{ key: string }]) => event.key)).toEqual([
        'Alt',
        'Shift',
      ]);
    } finally {
      unregister();
      useShortcutsStore.setState({ config: null });
    }
  });

  it('closes from its close button', async () => {
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(queryDraft()).toBeNull();
  });

  it('resizes from any edge or corner, remembering its size', () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    const draft = queryDraft() as HTMLElement;
    const rect = () => ({
      left: draft.style.left,
      top: draft.style.top,
      width: draft.style.width,
      height: draft.style.height,
    });
    expect(rect()).toEqual({ left: '736px', top: '472px', width: '440px', height: '280px' });
    const edge = (name: string) => draft.querySelector(`[data-resize-edge="${name}"]`)!;

    fireEvent.pointerDown(edge('w'), { button: 0, clientX: 736, clientY: 600, pointerId: 1 });
    fireEvent.pointerMove(edge('w'), { clientX: 636, clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(edge('w'), { pointerId: 1 });
    expect(rect()).toEqual({ left: '636px', top: '472px', width: '540px', height: '280px' });

    fireEvent.pointerDown(edge('ne'), { button: 0, clientX: 1176, clientY: 472, pointerId: 1 });
    fireEvent.pointerMove(edge('ne'), { clientX: 1146, clientY: 412, pointerId: 1 });
    fireEvent.pointerUp(edge('ne'), { pointerId: 1 });
    expect(rect()).toEqual({ left: '636px', top: '412px', width: '510px', height: '340px' });
    expect(JSON.parse(window.localStorage.getItem('komla.promptDraftRect')!)).toEqual({
      x: 636,
      y: 412,
      width: 510,
      height: 340,
    });
  });

  it('stays under the title bar, where the window has its own controls', () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    const draft = queryDraft() as HTMLElement;
    const header = screen.getByRole('heading', { name: 'Prompt draft' }).parentElement!;
    fireEvent.pointerDown(header, { button: 0, clientX: 800, clientY: 480, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 800, clientY: -500, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    // Linux's 36px title bar, and room for the handles above the draft.
    expect(draft.style.top).toBe('42px');

    const edge = draft.querySelector('[data-resize-edge="n"]')!;
    fireEvent.pointerDown(edge, { button: 0, clientX: 800, clientY: 42, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 800, clientY: -500, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(draft.style.top).toBe('42px');
  });

  it('marks its handles, which reach outside it, as part of it for drag regions and previews', () => {
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    const draft = queryDraft() as HTMLElement;
    const handles = [...draft.querySelectorAll('[data-resize-edge]')];
    expect(handles).toHaveLength(8);
    for (const handle of handles) expect(handle).toHaveClass('no-drag');
    // One box, over the draft and its handles, for a native preview to step aside from.
    const overlays = draft.querySelectorAll('[data-native-overlay]');
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toHaveClass('-inset-1.5');
  });

  it('moves with its header and stays inside the window, remembering where it was put', () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    renderDraft();
    act(() => openPromptDraft('ws-1'));
    const draft = queryDraft() as HTMLElement;
    const header = screen.getByRole('heading', { name: 'Prompt draft' }).parentElement!;
    const start = { left: draft.style.left, top: draft.style.top };
    expect(start).toEqual({ left: '736px', top: '472px' });

    fireEvent.pointerDown(header, { button: 0, clientX: 800, clientY: 480, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 700, clientY: 380, pointerId: 1 });
    expect({ left: draft.style.left, top: draft.style.top }).toEqual({
      left: '636px',
      top: '372px',
    });
    // Not past the window's edge.
    fireEvent.pointerMove(header, { clientX: 5000, clientY: 5000, pointerId: 1 });
    expect({ left: draft.style.left, top: draft.style.top }).toEqual({
      left: '746px',
      top: '506px',
    });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(JSON.parse(window.localStorage.getItem('komla.promptDraftRect')!)).toEqual({
      x: 746,
      y: 506,
      width: 440,
      height: 280,
    });
  });
});
