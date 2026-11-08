/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptDraftOutlet } from '../../../../src/renderer/components/prompt-draft/PromptDraft';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { openPromptDraft, popInPromptDraft } from '../../../../src/renderer/lib/prompt-draft';
import { registerShortcutAction } from '../../../../src/renderer/lib/shortcut-actions';
import { AT_PATH_MIME, setTreeDragActive } from '../../../../src/renderer/lib/tree-drag-token';
import { usePromptDraftStore } from '../../../../src/renderer/stores/prompt-draft.store';
import { useShortcutsStore } from '../../../../src/renderer/stores/shortcuts.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useViewedFileStore } from '../../../../src/renderer/stores/viewed-file.store';

const api = {
  copyToClipboard: vi.fn(),
  popOutPromptDraft: vi.fn(),
  showPromptDraftWindow: vi.fn(),
  platform: 'linux',
  getPathForFile: vi.fn((_file: File) => ''),
  importWorkspaceExternalFile: vi.fn(
    (_workspaceId: string, _sourcePath: string, preferredName?: string): Promise<string> =>
      Promise.resolve(`.komla-files/${preferredName}`)
  ),
  importClipboardImage: vi.fn((_workspaceId: string): Promise<string | null> =>
    Promise.resolve(null)
  ),
  showMessageBox: vi.fn(),
};

const { createNote } = vi.hoisted(() => ({ createNote: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../../../../src/renderer/lib/notes', () => ({ createNote }));

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
const draftText = () => usePromptDraftStore.getState().text;

/** Files from the OS at these paths, as a drop or a paste carries them. */
function osFiles(...paths: string[]) {
  const files = paths.map((path) => new File(['x'], path.split('/').pop()!));
  api.getPathForFile.mockImplementation((file: File) => paths[files.indexOf(file)] ?? '');
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: false }),
    })),
    getData: () => '',
    dropEffect: 'none',
  };
}

/** A file dragged from the file panel, which carries its `@path`. */
function fromFilePanel(atPath: string) {
  setTreeDragActive(true);
  return {
    types: [AT_PATH_MIME],
    files: [],
    items: [],
    getData: (type: string) => (type === AT_PATH_MIME ? atPath : ''),
    dropEffect: 'none',
  };
}

/** A screenshot on the clipboard, which exists only in memory, with `types` as it has them. */
function clipboardImage(types = ['Files']) {
  const file = new File(['x'], 'image.png', { type: 'image/png' });
  return {
    types,
    files: [file],
    items: [
      { kind: 'file', type: 'image/png', getAsFile: () => file, webkitGetAsEntry: () => null },
    ],
    getData: () => '',
  };
}

/** An import that finishes when the test says. */
function pendingImport() {
  let finish!: (path: string) => void;
  api.importWorkspaceExternalFile.mockReturnValueOnce(
    new Promise<string>((resolve) => (finish = resolve))
  );
  return (path: string) => act(async () => finish(path));
}

const toastMessages = () => useToastStore.getState().toasts.map((toast) => toast.message);

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
    api.getPathForFile.mockImplementation(() => '');
    setTreeDragActive(false);
  });

  it('shows once opened, with focus, ready to type', async () => {
    renderDraft();
    expect(queryDraft()).toBeNull();
    act(() => openPromptDraft());
    expect(queryDraft()).toBeInTheDocument();
    expect(prompt()).toHaveFocus();
    await userEvent.type(prompt(), 'Fix the login bug');
    expect(draftText()).toBe('Fix the login bug');
  });

  it('keeps the text when closed, one across workspaces', async () => {
    const { rerender } = renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'For one');
    await userEvent.keyboard('{Escape}');
    expect(queryDraft()).toBeNull();

    act(() => openPromptDraft());
    expect(prompt()).toHaveValue('For one');

    rerender(
      <TooltipProvider>
        <PromptDraftOutlet workspaceId="ws-2" />
      </TooltipProvider>
    );
    expect(prompt()).toHaveValue('For one');
  });

  it('shows only in the host on top, such as a viewer over the window', () => {
    render(
      <TooltipProvider>
        <div data-testid="window">
          <PromptDraftOutlet workspaceId="ws-1" />
        </div>
      </TooltipProvider>
    );
    act(() => openPromptDraft());
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
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'Look at');
    expect(screen.getByRole('button', { name: 'Open a file to refer to it' })).toBeDisabled();

    view('main.ts', '@src/main.ts:4-8');
    const insert = screen.getByRole('button', { name: 'Insert @path to main.ts' });
    // Not the file's name, which named in the tooltip leaves the header free to drag the draft by.
    expect(insert).toHaveTextContent(/^@path$/);
    await userEvent.click(insert);
    expect(prompt()).toHaveValue('Look at @src/main.ts:4-8 ');
    expect(prompt()).toHaveFocus();

    await userEvent.type(prompt(), 'and');
    await userEvent.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    expect(prompt()).toHaveValue('Look at @src/main.ts:4-8 and @src/main.ts:4-8 ');
  });

  it('copies the prompt and closes, without the space a reference left at its end', async () => {
    renderDraft();
    act(() => openPromptDraft());
    expect(screen.getByRole('button', { name: 'Copy and close' })).toBeDisabled();
    await userEvent.type(prompt(), 'Explain @a.ts ');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(api.copyToClipboard).toHaveBeenCalledWith('Explain @a.ts');
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Copied the prompt',
    ]);
    expect(queryDraft()).toBeNull();

    // Back with the text kept, all of it selected, for the next prompt to replace.
    act(() => openPromptDraft());
    expect(prompt()).toHaveValue('Explain @a.ts ');
    expect([prompt().selectionStart, prompt().selectionEnd]).toEqual([0, 14]);
    await userEvent.click(screen.getByRole('button', { name: 'Copy and close' }));
    expect(api.copyToClipboard).toHaveBeenCalledTimes(2);
    expect(queryDraft()).toBeNull();
  });

  it('copies all of it and closes on Cmd+C with nothing or everything selected', async () => {
    renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'Fix the bug');
    await userEvent.keyboard('{Control>}c{/Control}');
    expect(api.copyToClipboard).toHaveBeenCalledWith('Fix the bug');
    expect(queryDraft()).toBeNull();

    act(() => openPromptDraft());
    await userEvent.keyboard('{Control>}a{/Control}{Control>}c{/Control}');
    expect(api.copyToClipboard).toHaveBeenCalledTimes(2);
    expect(queryDraft()).toBeNull();
  });

  it('leaves Cmd+C on its buttons alone', async () => {
    renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'Fix the bug');
    screen.getByRole('button', { name: 'Close' }).focus();
    await userEvent.keyboard('{Control>}c{/Control}');
    expect(api.copyToClipboard).not.toHaveBeenCalled();
    expect(queryDraft()).toBeInTheDocument();
  });

  it('copies only a part selected on Cmd+C, as usual, staying open', async () => {
    renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'Fix the bug');
    prompt().setSelectionRange(4, 7);
    await userEvent.keyboard('{Control>}c{/Control}');
    expect(api.copyToClipboard).not.toHaveBeenCalled();
    expect(queryDraft()).toBeInTheDocument();
  });

  it('saves the prompt as a note in the workspace, emptying the draft', async () => {
    renderDraft();
    act(() => openPromptDraft());
    expect(screen.getByRole('button', { name: 'Save as note' })).toBeDisabled();
    await userEvent.type(prompt(), 'A plan to keep');
    await userEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    expect(createNote).toHaveBeenCalledWith('ws-1', 'A plan to keep');
    expect(queryDraft()).toBeNull();
    expect(draftText()).toBe('');
  });

  it('takes no typing while it saves, which the note would miss', async () => {
    let finish!: (saved: boolean) => void;
    createNote.mockReturnValueOnce(new Promise<boolean>((resolve) => (finish = resolve)));
    renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'A plan');
    await userEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    expect(prompt()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save as note' })).toBeDisabled();
    await act(async () => finish(true));
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(queryDraft()).toBeNull();
  });

  it('keeps the prompt when the note could not be made', async () => {
    createNote.mockResolvedValueOnce(false);
    renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'A plan to keep');
    await userEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    expect(queryDraft()).toBeInTheDocument();
    expect(draftText()).toBe('A plan to keep');
  });

  it('keeps Escape and Cmd keys from the viewer behind, which has shortcuts of its own', async () => {
    const { onParentKeyDown } = renderDraft();
    const keysReachingViewer = () =>
      onParentKeyDown.mock.calls.map(([event]: [{ key: string }]) => event.key);
    act(() => openPromptDraft());
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
      act(() => openPromptDraft());
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
    act(() => openPromptDraft());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(queryDraft()).toBeNull();
  });

  it('resizes from any edge or corner, remembering its size', () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    renderDraft();
    act(() => openPromptDraft());
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
    act(() => openPromptDraft());
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
    act(() => openPromptDraft());
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
    act(() => openPromptDraft());
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
  describe('files dropped or pasted in', () => {
    it('puts in the @path of a file dragged from the file panel, at the cursor', async () => {
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'Look at');
      const transfer = fromFilePanel('@src/main.ts ');
      expect(fireEvent.dragOver(prompt(), { dataTransfer: transfer })).toBe(false);
      expect(screen.getByText('Drop to insert path')).toBeInTheDocument();
      // The file panel's drags allow only a move, so a copy would take no drop.
      expect(transfer.dropEffect).toBe('none');
      expect(fireEvent.drop(prompt(), { dataTransfer: transfer })).toBe(false);
      expect(prompt()).toHaveValue('Look at @src/main.ts ');
      expect(screen.queryByText('Drop to insert path')).toBeNull();
    });

    it('leaves a drag that only claims to come from the file panel to the text box', () => {
      renderDraft();
      act(() => openPromptDraft());
      const transfer = { types: [AT_PATH_MIME], files: [], items: [], getData: () => '@x ' };
      expect(fireEvent.dragOver(prompt(), { dataTransfer: transfer })).toBe(true);
      expect(screen.queryByText('Drop to insert path')).toBeNull();
      fireEvent.drop(prompt(), { dataTransfer: transfer });
      expect(prompt()).toHaveValue('');
    });

    it('copies files dropped on it into the workspace on screen, putting in their @paths', async () => {
      const finish = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'See');
      const transfer = osFiles('/Users/ada/cat.png');
      expect(fireEvent.dragOver(prompt(), { dataTransfer: transfer })).toBe(false);
      expect(screen.getByText('Drop to upload')).toBeInTheDocument();
      expect(transfer.dropEffect).toBe('copy');
      expect(fireEvent.drop(prompt(), { dataTransfer: transfer })).toBe(false);
      expect(screen.queryByText('Drop to upload')).toBeNull();
      expect(api.importWorkspaceExternalFile).toHaveBeenCalledWith(
        'ws-1',
        '/Users/ada/cat.png',
        'cat.png'
      );
      expect(screen.getByRole('status')).toHaveTextContent('Uploading cat.png…');

      await finish('.komla-files/cat.png');
      expect(prompt()).toHaveValue('See @.komla-files/cat.png ');
      expect(prompt()).toHaveFocus();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('puts the @paths where the files were dropped, as typing goes on', async () => {
      const finish = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'Look at');
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/cat.png') });
      await userEvent.type(prompt(), ' and fix it');

      await finish('.komla-files/cat.png');
      expect(prompt()).toHaveValue('Look at @.komla-files/cat.png and fix it');
      // The cursor stays after what was typed.
      expect(prompt().selectionStart).toBe(prompt().value.length);
    });

    it('names a file it could not copy, putting in the others', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.importWorkspaceExternalFile
        .mockResolvedValueOnce('.komla-files/a.txt')
        .mockRejectedValueOnce(new Error('Host unreachable'));
      renderDraft();
      act(() => openPromptDraft());
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/a.txt', '/Users/ada/b.txt') });
      await waitFor(() => expect(prompt()).toHaveValue('@.komla-files/a.txt '));
      expect(toastMessages()).toEqual(['Couldn’t upload b.txt']);
    });

    it('keeps the @paths of files that finish copying once it has closed', async () => {
      const finish = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'See');
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/cat.png') });
      await userEvent.keyboard('{Escape}');
      expect(queryDraft()).toBeNull();

      await finish('.komla-files/cat.png');
      expect(draftText()).toBe('See @.komla-files/cat.png ');
    });

    it('puts in files dropped one after another at the same place in that order', async () => {
      const finishA = pendingImport();
      const finishB = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'See');
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/a.png') });
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/b.png') });
      await finishA('.komla-files/a.png');
      await finishB('.komla-files/b.png');
      expect(prompt()).toHaveValue('See @.komla-files/a.png @.komla-files/b.png ');
    });

    it('takes no drops while it saves as a note, which would miss them', async () => {
      let finish!: (saved: boolean) => void;
      createNote.mockReturnValueOnce(new Promise<boolean>((resolve) => (finish = resolve)));
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'A plan');
      await userEvent.click(screen.getByRole('button', { name: 'Save as note' }));
      const transfer = osFiles('/Users/ada/cat.png');
      expect(fireEvent.dragOver(prompt(), { dataTransfer: transfer })).toBe(true);
      fireEvent.drop(prompt(), { dataTransfer: transfer });
      fireEvent.paste(prompt(), { clipboardData: clipboardImage() });
      expect(api.importWorkspaceExternalFile).not.toHaveBeenCalled();
      expect(api.importClipboardImage).not.toHaveBeenCalled();
      await act(async () => finish(true));
    });

    it('still shows the files copying in once it moves over a viewer', async () => {
      const finish = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/cat.png') });
      const viewer = render(
        <TooltipProvider>
          <div data-testid="viewer">
            <PromptDraftOutlet workspaceId="ws-1" />
          </div>
        </TooltipProvider>
      );
      expect(screen.getByTestId('viewer')).toContainElement(queryDraft());
      expect(screen.getByRole('status')).toHaveTextContent('Uploading cat.png…');
      await finish('.komla-files/cat.png');
      expect(screen.queryByRole('status')).toBeNull();
      expect(prompt()).toHaveValue('@.komla-files/cat.png ');
      viewer.unmount();
    });

    it('pastes the text of a folder copied in, which it can not copy in itself', async () => {
      // A folder that Chromium doesn't flag as one: reading it fails.
      const folder = {
        name: 'src',
        size: 0,
        type: '',
        slice: () => ({ arrayBuffer: () => Promise.reject(new Error('EISDIR')) }),
      } as unknown as File;
      api.getPathForFile.mockImplementation((file: File) =>
        file === folder ? '/Users/ada/src' : ''
      );
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'In');
      const clipboardData = {
        types: ['text/plain', 'Files'],
        files: [folder],
        items: [{ kind: 'file', type: '', getAsFile: () => folder, webkitGetAsEntry: () => null }],
        getData: (type: string) => (type === 'text/plain' ? '/Users/ada/src' : ''),
      };
      fireEvent.paste(prompt(), { clipboardData });
      await waitFor(() => expect(prompt()).toHaveValue('In/Users/ada/src'));
      expect(api.importWorkspaceExternalFile).not.toHaveBeenCalled();
    });

    it('waits for files still copying before it saves, copies or pops out, which would miss them', async () => {
      const finish = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'See');
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/cat.png') });
      expect(screen.getByRole('button', { name: 'Save as note' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Copy and close' })).toBeDisabled();
      // Their @paths would go into this window's draft, not the one popped out.
      expect(screen.getByRole('button', { name: 'Pop out over other apps' })).toBeDisabled();
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      expect(api.copyToClipboard).not.toHaveBeenCalled();
      expect(queryDraft()).toBeInTheDocument();
      expect(toastMessages()).toEqual(['Wait for the upload to finish']);

      await finish('.komla-files/cat.png');
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      expect(api.copyToClipboard).toHaveBeenCalledWith('See @.komla-files/cat.png');
    });

    it('puts in the @path where it was dropped once it has moved over a viewer', async () => {
      const finish = pendingImport();
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'Look at');
      fireEvent.drop(prompt(), { dataTransfer: osFiles('/Users/ada/cat.png') });
      const viewer = render(
        <TooltipProvider>
          <div data-testid="viewer">
            <PromptDraftOutlet workspaceId="ws-1" />
          </div>
        </TooltipProvider>
      );
      await userEvent.type(prompt(), ' it');
      prompt().setSelectionRange(2, 2);

      await finish('.komla-files/cat.png');
      expect(prompt()).toHaveValue('Look at @.komla-files/cat.png it');
      // Where the user has it, in the draft over the viewer.
      expect([prompt().selectionStart, prompt().selectionEnd]).toEqual([2, 2]);
      viewer.unmount();
    });

    it('says so when files could not be copied at all', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.showMessageBox.mockRejectedValueOnce(new Error('Window closed'));
      renderDraft();
      act(() => openPromptDraft());
      const transfer = osFiles('/Users/ada/big.zip');
      Object.defineProperty(transfer.files[0], 'size', { value: 150 * 1024 * 1024 });
      fireEvent.drop(prompt(), { dataTransfer: transfer });
      await waitFor(() => expect(toastMessages()).toEqual(['Couldn’t upload big.zip']));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('leaves a drop without files on disk, such as a web page image, to the text box', () => {
      renderDraft();
      act(() => openPromptDraft());
      const image = new File(['x'], 'photo.png', { type: 'image/png' });
      const transfer = {
        types: ['text/plain', 'Files'],
        files: [image],
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => image, webkitGetAsEntry: () => null },
        ],
        getData: (type: string) => (type === 'text/plain' ? 'https://example.com/photo.png' : ''),
        dropEffect: 'none',
      };
      expect(fireEvent.drop(prompt(), { dataTransfer: transfer })).toBe(true);
      expect(api.importWorkspaceExternalFile).not.toHaveBeenCalled();
    });

    it('copies files pasted in, as dropped ones', async () => {
      renderDraft();
      act(() => openPromptDraft());
      const clipboardData = osFiles('/Users/ada/notes.txt');
      expect(fireEvent.paste(prompt(), { clipboardData })).toBe(false);
      await waitFor(() => expect(prompt()).toHaveValue('@.komla-files/notes.txt '));
      expect(api.importWorkspaceExternalFile).toHaveBeenCalledWith(
        'ws-1',
        '/Users/ada/notes.txt',
        'notes.txt'
      );
    });

    it('copies a pasted screenshot into the workspace, putting in its @path', async () => {
      api.importClipboardImage.mockResolvedValueOnce('.komla-files/clipboard-1.png');
      renderDraft();
      act(() => openPromptDraft());
      await userEvent.type(prompt(), 'Why');
      expect(fireEvent.paste(prompt(), { clipboardData: clipboardImage() })).toBe(false);
      expect(api.importClipboardImage).toHaveBeenCalledWith('ws-1');
      await waitFor(() => expect(prompt()).toHaveValue('Why @.komla-files/clipboard-1.png '));
    });

    it('pastes the text, not the image, from a clipboard with both', () => {
      renderDraft();
      act(() => openPromptDraft());
      const clipboardData = clipboardImage(['text/plain', 'Files']);
      expect(fireEvent.paste(prompt(), { clipboardData })).toBe(true);
      expect(api.importClipboardImage).not.toHaveBeenCalled();
    });

    it('says so when the screenshot could not be pasted', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.importClipboardImage.mockRejectedValueOnce(new Error('Host unreachable'));
      renderDraft();
      act(() => openPromptDraft());
      fireEvent.paste(prompt(), { clipboardData: clipboardImage() });
      await waitFor(() => expect(toastMessages()).toEqual(['Couldn’t paste the image']));
      expect(prompt()).toHaveValue('');
    });
  });

  it('pops out just where it is, taking the text and the cursor with it', async () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    renderDraft();
    act(() => openPromptDraft());
    await userEvent.type(prompt(), 'Fix the header');
    prompt().setSelectionRange(4, 7);

    await userEvent.click(screen.getByRole('button', { name: 'Pop out over other apps' }));

    expect(api.popOutPromptDraft).toHaveBeenCalledWith(
      { text: 'Fix the header', selectionStart: 4, selectionEnd: 7 },
      { x: 736, y: 472, width: 440, height: 280 }
    );
    expect(queryDraft()).toBeNull();
    expect(draftText()).toBe('');
    // Its own window shows it from now on.
    act(() => openPromptDraft());
    expect(api.showPromptDraftWindow).toHaveBeenCalledTimes(1);
    expect(queryDraft()).toBeNull();
  });

  it('pops back in where the cursor was, after any text written here meanwhile', async () => {
    renderDraft();
    act(() => popInPromptDraft({ text: 'Fix the header', selectionStart: 4, selectionEnd: 7 }));
    expect(prompt()).toHaveValue('Fix the header');
    expect(prompt()).toHaveFocus();
    expect([prompt().selectionStart, prompt().selectionEnd]).toEqual([4, 7]);

    await userEvent.keyboard('{Escape}');
    act(() => usePromptDraftStore.getState().setText('Written here'));
    act(() => popInPromptDraft({ text: 'Popped out', selectionStart: 6, selectionEnd: 6 }));
    expect(prompt()).toHaveValue('Written here\n\nPopped out');
    expect(prompt().selectionStart).toBe('Written here\n\nPopped'.length);
  });
});
