/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaneDragBarProvider } from '../../../../../../src/renderer/components/terminal/PaneDragGrip';
import { TooltipProvider } from '../../../../../../src/renderer/components/ui/tooltip';
import { RichMarkdownEditor } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor';
import { registerShortcutAction } from '../../../../../../src/renderer/lib/shortcut-actions';
import { isShortcutEventClaimed } from '../../../../../../src/renderer/lib/shortcut-claims';
import { useShortcutsStore } from '../../../../../../src/renderer/stores/shortcuts.store';

import type { MarkdownEditorHandle } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor';
import type { Editor } from '@tiptap/core';

const shiki = vi.hoisted(() => ({
  highlighter: null as null | object,
  loadShikiLanguage: vi.fn(async (_language: string) => false),
  languageListeners: new Set<() => void>(),
}));

vi.mock('../../../../../../src/renderer/lib/monaco-loader', () => ({
  ensureMonacoInitialized: () => Promise.resolve(),
  subscribeKomlaEditorTheme: () => () => {},
  getMonacoThemeName: () => 'komla-dark',
  getShikiHighlighter: () => shiki.highlighter,
  loadShikiLanguage: (language: string) => shiki.loadShikiLanguage(language),
  subscribeShikiLanguageLoads: (listener: () => void) => {
    shiki.languageListeners.add(listener);
    return () => shiki.languageListeners.delete(listener);
  },
}));

const SOURCE = '# Title\n\nSome __strong__ text.\n\n* a\n* b\n';

function renderEditor(props: Partial<React.ComponentProps<typeof RichMarkdownEditor>> = {}) {
  const ref = createRef<MarkdownEditorHandle>();
  const onChange = vi.fn();
  const readImage = vi.fn(async () => ({ data: 'AAAA', mimeType: 'image/png' }));
  const view = render(
    <RichMarkdownEditor
      ref={ref}
      filePath="docs/plan.md"
      content={SOURCE}
      readOnly={false}
      onChange={onChange}
      readImage={readImage}
      {...props}
    />,
    { wrapper: TooltipProvider }
  );
  const dom = view.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
  return { ...view, ref, onChange, readImage, dom, editor: dom.editor };
}

/** The position just inside the end of the top-level node at `index`. */
function endOfBlock(editor: Editor, index: number): number {
  let position = 0;
  for (let child = 0; child <= index; child++) position += editor.state.doc.child(child).nodeSize;
  return position - 1;
}

describe('RichMarkdownEditor', () => {
  it('colors a code block once its grammar has loaded', async () => {
    const loaded = new Set<string>();
    shiki.highlighter = {
      getTheme: () => ({ fg: '#d4d4d4' }),
      getLoadedLanguages: () => [...loaded],
      getLanguage: () => ({}),
      codeToTokensBase: (code: string) => [[{ content: code, offset: 0, color: '#569cd6' }]],
    };
    shiki.loadShikiLanguage.mockImplementation(async (language) => {
      await Promise.resolve();
      loaded.add(language);
      shiki.languageListeners.forEach((listener) => listener());
      return true;
    });
    try {
      const { dom } = renderEditor({ content: '```rust\nfn main() {}\n```\n' });

      await waitFor(() => expect(dom.querySelector('pre [style*="color"]')).toBeTruthy());
      expect(shiki.loadShikiLanguage).toHaveBeenCalledWith('rust');
    } finally {
      shiki.highlighter = null;
      shiki.loadShikiLanguage.mockReset();
    }
  });

  it('recolors a code block once a grammar it embeds arrives', async () => {
    let grammar = {};
    let color = '#569cd6';
    shiki.highlighter = {
      getTheme: () => ({ fg: '#d4d4d4' }),
      getLoadedLanguages: () => ['vue'],
      getLanguage: () => grammar,
      codeToTokensBase: (code: string) => [[{ content: code, offset: 0, color }]],
    };
    try {
      const { dom } = renderEditor({ content: '```vue\n<style lang="scss"></style>\n```\n' });
      const colorOf = () => dom.querySelector<HTMLElement>('pre [style]')?.style.color;
      await waitFor(() => expect(colorOf()).toBe('rgb(86, 156, 214)'));

      // Shiki rebuilds the Vue grammar once SCSS loads, and the rebuilt one colors more.
      grammar = {};
      color = '#ce9178';
      act(() => shiki.languageListeners.forEach((listener) => listener()));

      expect(colorOf()).toBe('rgb(206, 145, 120)');
    } finally {
      shiki.highlighter = null;
    }
  });

  it("drags its pane from the toolbar's empty space, and only in a pane", () => {
    const onDragStart = vi.fn();
    const { container } = render(
      <PaneDragBarProvider value={{ onDragStart, onDragEnd: () => {} }}>
        <TooltipProvider>
          <RichMarkdownEditor
            filePath="notes/a.md"
            content={SOURCE}
            readOnly={false}
            onChange={() => {}}
            readImage={vi.fn()}
          />
        </TooltipProvider>
      </PaneDragBarProvider>
    );
    const bold = container.querySelector('button[aria-label^="Bold"]') as HTMLElement;
    const toolbar = bold.closest('[draggable="true"]') as HTMLElement;

    // A browser fires dragstart at the draggable toolbar, wherever the press began.
    fireEvent.pointerDown(bold);
    fireEvent.dragStart(toolbar);
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.pointerDown(toolbar);
    fireEvent.dragStart(toolbar);
    expect(onDragStart).toHaveBeenCalledTimes(1);

    const outside = renderEditor();
    expect(outside.container.querySelector('[draggable="true"]')).toBeNull();
  });

  it('takes keyboard focus on request, then says so', async () => {
    const onFocused = vi.fn();
    const { rerender, dom, editor } = renderEditor({ onFocused });
    const focus = vi.spyOn(dom, 'focus');
    // jsdom can't focus a contenteditable, so the view reports the focus that would have landed.
    vi.spyOn(editor.view, 'hasFocus').mockImplementation(() => focus.mock.calls.length > 0);
    expect(onFocused).not.toHaveBeenCalled();

    rerender(
      <RichMarkdownEditor
        filePath="docs/plan.md"
        content={SOURCE}
        readOnly={false}
        readImage={vi.fn()}
        focusRequested
        onFocused={onFocused}
      />
    );

    expect(onFocused).not.toHaveBeenCalled();
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
    expect(focus).toHaveBeenCalled();
  });

  // A blank note Setup opened beside a browser took the focus a frame after it was created, from
  // the address field the user had just clicked into, and the address typed went into the note.
  describe('opened to take focus', () => {
    function frames(count: number) {
      return Array.from({ length: count }).reduce<Promise<unknown>>(
        (chain) => chain.then(() => new Promise((resolve) => requestAnimationFrame(resolve))),
        Promise.resolve()
      );
    }

    it('takes it once it shows', async () => {
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      const { dom } = renderEditor({ autoFocus: true });

      await waitFor(() => expect(focus.mock.contexts).toContain(dom));
      focus.mockRestore();
    });

    it('leaves it to a field the user went to as it opened', async () => {
      const address = document.createElement('input');
      document.body.append(address);
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      const { dom } = renderEditor({ autoFocus: true });
      address.focus();

      await new Promise((resolve) => setTimeout(resolve, 0));
      await frames(3);

      expect(focus.mock.contexts).not.toContain(dom);
      expect(document.activeElement).toBe(address);
      focus.mockRestore();
      address.remove();
    });
  });

  it("leaves a focus request that didn't land", async () => {
    const onFocused = vi.fn();
    const { editor } = renderEditor({ focusRequested: true, onFocused });
    vi.spyOn(editor.view, 'hasFocus').mockReturnValue(false);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(onFocused).not.toHaveBeenCalled();
  });

  it('shows the file as rich text', () => {
    const { dom } = renderEditor();
    expect(dom.querySelector('h1')?.textContent).toBe('Title');
    expect(dom.querySelector('strong')?.textContent).toBe('strong');
    expect(dom.querySelectorAll('li')).toHaveLength(2);
  });

  it('reports an edit with the rest of the file as written', () => {
    const { editor, onChange, ref } = renderEditor();
    act(() => {
      editor.commands.insertContentAt(endOfBlock(editor, 1), ' More');
    });
    const expected = '# Title\n\nSome __strong__ text. More\n\n* a\n* b\n';
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(ref.current?.getMarkdown()).toBe(expected);
  });

  it('reports later edits together, and all of them before a save', () => {
    vi.useFakeTimers();
    try {
      const { editor, onChange, ref } = renderEditor();
      act(() => {
        editor.commands.insertContentAt(endOfBlock(editor, 1), ' One');
        editor.commands.insertContentAt(endOfBlock(editor, 1), ' Two');
      });
      // The first edit marks the file unsaved at once; the second waits for the batch.
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(ref.current?.getMarkdown()).toContain('text. One Two');
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an edit at once while the file reads as saved, even mid-batch', () => {
    vi.useFakeTimers();
    try {
      const { editor, rerender, onChange, ref, readImage } = renderEditor({ savedContent: SOURCE });
      act(() => {
        editor.commands.insertContentAt(endOfBlock(editor, 1), ' One');
      });
      const saved = onChange.mock.lastCall![0];
      // The file viewer saves what it was told while the batch is still open.
      rerender(
        <RichMarkdownEditor
          ref={ref}
          filePath="docs/plan.md"
          content={saved}
          savedContent={saved}
          readOnly={false}
          onChange={onChange}
          readImage={readImage}
        />
      );
      act(() => {
        editor.commands.insertContentAt(endOfBlock(editor, 1), ' Two');
      });
      // Held back, the edit would leave the file reading as saved: Cmd+S and close would skip it.
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.lastCall![0]).toContain('text. One Two');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows changes made on disk, without reporting them as edits', () => {
    const { rerender, dom, onChange, ref, readImage } = renderEditor();
    rerender(
      <RichMarkdownEditor
        ref={ref}
        filePath="docs/plan.md"
        content={'# Title\n\nAn agent rewrote this.\n'}
        readOnly={false}
        onChange={onChange}
        readImage={readImage}
      />
    );
    expect(dom.textContent).toContain('An agent rewrote this.');
    expect(onChange).not.toHaveBeenCalled();
    expect(ref.current?.getMarkdown()).toBe('# Title\n\nAn agent rewrote this.\n');
  });

  it("doesn't reload when its own report comes back", () => {
    const { editor, rerender, onChange, ref, readImage } = renderEditor();
    act(() => {
      editor.commands.insertContentAt(endOfBlock(editor, 1), ' More');
    });
    const before = editor.state.doc;
    rerender(
      <RichMarkdownEditor
        ref={ref}
        filePath="docs/plan.md"
        content={onChange.mock.calls[0][0]}
        readOnly={false}
        onChange={onChange}
        readImage={readImage}
      />
    );
    expect(editor.state.doc).toBe(before);
  });

  it('keeps a heading on one line, as Markdown needs', () => {
    const { editor } = renderEditor();
    act(() => {
      editor.commands.setTextSelection(4);
      editor.commands.keyboardShortcut('Shift-Enter');
      editor.commands.keyboardShortcut('Mod-Enter');
    });
    expect(editor.state.doc.child(0).toJSON()).toEqual({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Title' }],
    });
    expect(editor.state.doc.child(1).textContent).toBe('Some strong text.');
  });

  it('keeps formatting shortcuts it handled from the app shortcuts', () => {
    const { dom, editor } = renderEditor();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    const claimed = vi.fn();
    const listener = (event: KeyboardEvent) => claimed(isShortcutEventClaimed(event));
    window.addEventListener('keydown', listener);
    try {
      fireEvent.keyDown(dom, { key: 'b', ctrlKey: true });
      expect(dom.querySelector('h1 strong')?.textContent).toBe('Title');
      fireEvent.keyDown(dom, { key: 's', ctrlKey: true });
    } finally {
      window.removeEventListener('keydown', listener);
    }
    expect(claimed.mock.calls).toEqual([[true], [false]]);
  });

  it('runs the app shortcuts code editors pass on, such as New note', () => {
    useShortcutsStore.setState({ config: { shortcuts: { 'note.new': 'Cmd+Shift+M' } } });
    const newNote = vi.fn();
    const unregister = registerShortcutAction('note.new', newNote);
    try {
      const { dom } = renderEditor();
      fireEvent.keyDown(dom, { key: 'M', ctrlKey: true, shiftKey: true });
      expect(newNote).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
      useShortcutsStore.setState({ config: null });
    }
  });

  describe('Escape', () => {
    // jsdom has no scrollIntoView, which the slash menu calls to keep its selection in view.
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn();
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    });

    // ProseMirror marks every Escape handled, which kept the file preview from closing on it.
    it('leaves it to the view around the editor', () => {
      const { dom } = renderEditor();
      expect(fireEvent.keyDown(dom, { key: 'Escape', keyCode: 27 })).toBe(true);
    });

    it('takes it to close the slash menu', async () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.chain().setTextSelection(endOfBlock(editor, 1)).splitBlock().insertContent('/').run();
      });
      const menu = await screen.findByRole('listbox', { name: 'Insert block' });

      expect(fireEvent.keyDown(dom, { key: 'Escape', keyCode: 27 })).toBe(false);
      await waitFor(() => expect(menu).not.toBeInTheDocument());
      expect(fireEvent.keyDown(dom, { key: 'Escape', keyCode: 27 })).toBe(true);
    });

    it('leaves a slash command nothing matches, and passes the key on', async () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.chain().setTextSelection(endOfBlock(editor, 1)).splitBlock().insertContent('/hzz').run();
      });
      expect(fireEvent.keyDown(dom, { key: 'Escape', keyCode: 27 })).toBe(true);

      // Once left, it stays dismissed as the query shrinks to one that matches.
      act(() => {
        const { from } = editor.state.selection;
        editor.commands.deleteRange({ from: from - 2, to: from });
      });
      expect(editor.state.doc.child(2).textContent).toBe('/h');
      await act(async () => {});
      expect(screen.queryByRole('listbox', { name: 'Insert block' })).toBeNull();
    });
  });

  it('jumps to the block a line of the file is in', () => {
    // jsdom doesn't lay out, so it has no scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
    const { editor, ref } = renderEditor();
    act(() => ref.current?.revealLine(6));
    expect(editor.state.selection.$from.node(1).type.name).toBe('bulletList');
    act(() => ref.current?.revealLine(3));
    expect(editor.state.selection.$from.parent.textContent).toBe('Some strong text.');
  });

  it.each([
    ['plain text', ['text/plain']],
    ['a copy from the Source view', ['text/plain', 'text/html', 'vscode-editor-data']],
  ])('pastes Markdown from %s as formatted blocks', (_source, types) => {
    const { dom, editor } = renderEditor();
    act(() => {
      editor.commands.setTextSelection(endOfBlock(editor, 1));
    });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(paste, {
      clipboardData: {
        types,
        files: [],
        getData: (type: string) =>
          type === 'text/plain' ? '## Pasted\n\n- one\n' : '<pre>x</pre>',
      },
    });
    act(() => {
      dom.dispatchEvent(paste);
    });
    expect(dom.querySelector('h2')?.textContent).toBe('Pasted');
  });

  it('reads images relative to the Markdown file', async () => {
    const { dom, readImage } = renderEditor({ content: '![diagram](./img/diagram.png)\n' });
    await waitFor(() =>
      expect(dom.querySelector('img[alt="diagram"]')).toHaveAttribute(
        'src',
        'data:image/png;base64,AAAA'
      )
    );
    expect(readImage).toHaveBeenCalledWith('docs/img/diagram.png');
  });

  describe('context menu', () => {
    // "Some" in the second block of SOURCE.
    const SOME = { from: 8, to: 12 };
    const runClipboardCommand = vi.fn(async () => {});
    const openExternal = vi.fn();

    beforeEach(() => {
      runClipboardCommand.mockReset();
      openExternal.mockReset();
      window.api = { runClipboardCommand, openExternal } as unknown as typeof window.api;
      // jsdom doesn't lay out, so it has no scrollIntoView for the menu's items, and no rects for
      // the editor to scroll a changed block into view with.
      Element.prototype.scrollIntoView = vi.fn();
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
      Range.prototype.getBoundingClientRect = () => new DOMRect();
    });

    /** Right-clicks text in the editor as if at the given document position. */
    function rightClick(editor: Editor, dom: HTMLElement, position: number) {
      // jsdom doesn't lay out, so it can't tell which position is under the pointer.
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: position, inside: -1 });
      fireEvent.contextMenu(dom.querySelector('p') as HTMLElement, { button: 2 });
    }

    function menuLabels(): string[] {
      return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
    }

    it('offers clipboard and formatting commands', () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from);

      expect(screen.getByRole('menuitem', { name: /^Paste/ })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: /^Select All/ })).toBeTruthy();
      expect(screen.getByRole('menuitemcheckbox', { name: /^Bold/ })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'Block' })).toBeTruthy();
    });

    it('only offers what leaves a read-only file unchanged', () => {
      const { dom, editor } = renderEditor({ readOnly: true });
      rightClick(editor, dom, SOME.from);

      expect(menuLabels().map((label) => label.replace(/(?:Ctrl|Cmd|⌘).*$/, ''))).toEqual([
        'Copy',
        'Select All',
      ]);
    });

    it('can only cut or copy a selection', () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from);

      expect(screen.getByRole('menuitem', { name: /^Cut/ })).toHaveAttribute('aria-disabled');
      expect(screen.getByRole('menuitem', { name: /^Copy/ })).toHaveAttribute('aria-disabled');
    });

    it('keeps the selection when the click is inside it', () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.commands.setTextSelection(SOME);
      });
      rightClick(editor, dom, SOME.from + 1);

      expect(editor.state.selection).toMatchObject(SOME);
      expect(screen.getByRole('menuitem', { name: /^Copy/ })).not.toHaveAttribute('aria-disabled');
    });

    it('puts the cursor at a click outside the selection', () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.commands.setTextSelection(SOME);
      });
      rightClick(editor, dom, SOME.to + 3);

      expect(editor.state.selection).toMatchObject({ from: SOME.to + 3, to: SOME.to + 3 });
    });

    it('takes up a selection Chromium made for the click', () => {
      // macOS selects the word under a right-click, and the menu takes focus before ProseMirror
      // reads that from the DOM.
      const { dom, editor } = renderEditor();
      const text = dom.querySelector('p')?.firstChild as Text;
      window.getSelection()?.setBaseAndExtent(text, 0, text, 4);
      rightClick(editor, dom, SOME.from + 1);

      expect(editor.state.selection).toMatchObject(SOME);
    });

    it('ignores a menu event that reports no mouse button', () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.commands.setTextSelection(SOME);
      });
      const posAtCoords = vi.spyOn(editor.view, 'posAtCoords');
      fireEvent.contextMenu(dom, { button: -1 });

      expect(posAtCoords).not.toHaveBeenCalled();
    });

    it('leaves the selection alone for a menu opened from the keyboard', () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.commands.setTextSelection(SOME);
      });
      const posAtCoords = vi.spyOn(editor.view, 'posAtCoords');
      fireEvent.contextMenu(dom, { button: 0 });

      expect(posAtCoords).not.toHaveBeenCalled();
      expect(editor.state.selection).toMatchObject(SOME);
    });

    it('leaves the selection alone for a right-click in the margin', () => {
      const { container, dom, editor } = renderEditor();
      act(() => {
        editor.commands.setTextSelection(SOME);
      });
      const scroller = container.querySelector('[data-markdown-scroller]') as HTMLElement;
      fireEvent.mouseDown(scroller, { button: 2 });
      fireEvent.contextMenu(scroller, { button: 2 });

      expect(editor.state.selection).toMatchObject(SOME);
      expect(dom.isConnected).toBe(true);
      expect(screen.getByRole('menuitem', { name: /^Copy/ })).toBeTruthy();
    });

    it.each(['Cut', 'Copy', 'Paste'])(
      'runs %s on the editor once the menu has given focus back',
      async (label) => {
        const { dom, editor } = renderEditor();
        act(() => {
          editor.commands.setTextSelection(SOME);
        });
        rightClick(editor, dom, SOME.from + 1);
        let focusedDuringCommand: Element | null = null;
        runClipboardCommand.mockImplementation(async () => {
          focusedDuringCommand = document.activeElement;
        });

        fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }));

        await waitFor(() => expect(runClipboardCommand).toHaveBeenCalledWith(label.toLowerCase()));
        expect(focusedDuringCommand).toBe(dom);
        expect(screen.queryByRole('menu')).toBeNull();
      }
    );

    it('runs no command when dismissed', async () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from);

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      await new Promise((resolve) => setTimeout(resolve));
      expect(runClipboardCommand).not.toHaveBeenCalled();
    });

    it('selects the whole document', async () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from);

      fireEvent.click(screen.getByRole('menuitem', { name: /^Select All/ }));

      await waitFor(() =>
        expect(editor.state.selection).toMatchObject({ from: 0, to: editor.state.doc.content.size })
      );
    });

    it('toggles a mark on the selection, showing it as checked', async () => {
      const { dom, editor } = renderEditor();
      act(() => {
        editor.commands.setTextSelection(SOME);
      });
      rightClick(editor, dom, SOME.from + 1);
      expect(screen.getByRole('menuitemcheckbox', { name: /^Bold/ })).not.toBeChecked();

      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /^Bold/ }));
      await waitFor(() => expect(dom.querySelector('p strong')?.textContent).toBe('Some'));

      rightClick(editor, dom, SOME.from + 1);
      expect(screen.getByRole('menuitemcheckbox', { name: /^Bold/ })).toBeChecked();
    });

    it('turns the current block into another from the Block submenu', async () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from);

      const block = screen.getByRole('menuitem', { name: 'Block' });
      fireEvent.keyDown(block, { key: 'Enter' });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Heading 2' }));

      await waitFor(() => expect(dom.querySelector('h2')?.textContent).toContain('Some'));
    });

    it('keeps a right-click on the menu to itself', () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from);

      // Prevented, so a menu around the editor, such as the pane's, doesn't open as well.
      expect(fireEvent.contextMenu(screen.getByRole('menu'), { button: 2 })).toBe(false);
    });

    it('selects a divider when right-clicked, rather than a cursor where no text can go', () => {
      const warn = vi.spyOn(console, 'warn');
      const { dom, editor } = renderEditor({ content: 'Before\n\n---\n\nAfter\n' });
      rightClick(editor, dom, editor.state.doc.child(0).nodeSize);

      expect(editor.state.selection).toMatchObject({ node: { type: { name: 'horizontalRule' } } });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    async function openBlockMenu() {
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Block' }), { key: 'Enter' });
      await screen.findByRole('menuitem', { name: 'Heading 1' });
    }

    it('leaves out the blocks that would split what is under the cursor', async () => {
      const { dom, editor } = renderEditor();
      rightClick(editor, dom, SOME.from + 1);
      await openBlockMenu();

      expect(screen.queryByRole('menuitem', { name: 'Table' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Divider' })).toBeNull();
    });

    it('has no block to convert to in a table cell', () => {
      const { dom, editor } = renderEditor({ content: '| a |\n| --- |\n| b |\n' });
      act(() => {
        editor.commands.setTextSelection(4);
      });
      rightClick(editor, dom, 4);

      expect(screen.getByRole('menuitem', { name: 'Block' })).toHaveAttribute('aria-disabled');
    });

    it('has no block to convert a selected divider to', () => {
      const { dom, editor } = renderEditor({ content: 'Before\n\n---\n\nAfter\n' });
      rightClick(editor, dom, editor.state.doc.child(0).nodeSize);

      expect(screen.getByRole('menuitem', { name: 'Block' })).toHaveAttribute('aria-disabled');
    });

    it('converts a heading to a list, which a dry run of the command would rule out', async () => {
      const { dom, editor } = renderEditor();
      // The heading of SOURCE.
      act(() => {
        editor.commands.setTextSelection(2);
      });
      rightClick(editor, dom, 2);
      await openBlockMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Bullet list' }));

      await waitFor(() => expect(dom.querySelector('ul li')?.textContent).toContain('Title'));
    });

    describe('a Ctrl+click on macOS, which opens the menu', () => {
      beforeEach(() => {
        window.api = {
          runClipboardCommand,
          openExternal,
          platform: 'darwin',
        } as unknown as typeof window.api;
      });

      it('moves the cursor as a right-click does', () => {
        const { dom, editor } = renderEditor();
        act(() => {
          editor.commands.setTextSelection(SOME);
        });
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: SOME.to + 3, inside: -1 });
        fireEvent.contextMenu(dom.querySelector('p') as HTMLElement, { button: 0, ctrlKey: true });

        expect(editor.state.selection).toMatchObject({ from: SOME.to + 3, to: SOME.to + 3 });
      });

      it('does not open a link', () => {
        const { dom, editor } = renderEditor({ content: '[docs](https://example.com)\n' });
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: -1 });
        const link = dom.querySelector('a') as HTMLElement;

        fireEvent.mouseDown(link, { button: 0, ctrlKey: true });
        fireEvent.mouseUp(link, { button: 0, ctrlKey: true });
        expect(openExternal).not.toHaveBeenCalled();

        // Far enough from the last click not to count as a double-click.
        fireEvent.mouseDown(link, { button: 0, metaKey: true, clientX: 100 });
        fireEvent.mouseUp(link, { button: 0, metaKey: true, clientX: 100 });
        expect(openExternal).toHaveBeenCalledWith('https://example.com');
      });

      it('does not move the cursor to the end from the margin', () => {
        const { container, editor } = renderEditor();
        act(() => {
          editor.commands.setTextSelection(SOME);
        });
        const scroller = container.querySelector('[data-markdown-scroller]') as HTMLElement;
        fireEvent.mouseDown(scroller, { button: 0, ctrlKey: true });

        expect(editor.state.selection).toMatchObject(SOME);
      });
    });

    it('does not open a link on a right-click in a read-only file', () => {
      const { dom, editor } = renderEditor({
        readOnly: true,
        content: '[docs](https://example.com)\n',
      });
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: -1 });
      const link = dom.querySelector('a') as HTMLElement;

      fireEvent.mouseDown(link, { button: 2 });
      fireEvent.mouseUp(link, { button: 2 });
      expect(openExternal).not.toHaveBeenCalled();

      fireEvent.mouseDown(link, { button: 0 });
      fireEvent.mouseUp(link, { button: 0 });
      expect(openExternal).toHaveBeenCalledWith('https://example.com');
    });
  });

  describe('links', () => {
    const openExternal = vi.fn();

    beforeEach(() => {
      openExternal.mockReset();
      window.api = {
        openExternal,
        platform: 'linux',
      } as unknown as typeof window.api;
      // jsdom doesn't lay out, so it has no scrollIntoView.
      Element.prototype.scrollIntoView = vi.fn();
    });

    /** Clicks the link with the given text, holding Ctrl unless told otherwise. */
    function clickLink(
      editor: Editor,
      dom: HTMLElement,
      text: string,
      modifiers: { ctrlKey?: boolean; metaKey?: boolean } = { ctrlKey: true }
    ) {
      const link = [...dom.querySelectorAll('a')].find((a) => a.textContent === text);
      if (!link) throw new Error(`No link ${text}`);
      // jsdom doesn't lay out, so it can't tell which position is under the pointer.
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
        pos: 2,
        inside: -1,
      });
      fireEvent.mouseDown(link, { button: 0, ...modifiers });
      fireEvent.mouseUp(link, { button: 0, ...modifiers });
      return link;
    }

    it('opens a file a link points to, relative to the Markdown file', () => {
      const fileLinks = { canOpen: vi.fn(() => true), open: vi.fn() };
      const { dom, editor } = renderEditor({
        content: '[setup](../setup.md#install)\n',
        fileLinks,
      });

      clickLink(editor, dom, 'setup', {});
      expect(fileLinks.open).not.toHaveBeenCalled();

      clickLink(editor, dom, 'setup');
      expect(fileLinks.open).toHaveBeenCalledWith('setup.md');
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('opens a linked file with a plain click when read-only', () => {
      const fileLinks = { canOpen: vi.fn(() => true), open: vi.fn() };
      const { dom, editor } = renderEditor({
        readOnly: true,
        content: '[auth](./api/auth.ts)\n',
        fileLinks,
      });

      clickLink(editor, dom, 'auth', {});
      expect(fileLinks.open).toHaveBeenCalledWith('docs/api/auth.ts');
    });

    it('jumps to the heading a link to #its-anchor names', () => {
      const { dom, editor } = renderEditor({
        content: '[later](#notes-1)\n\n## Notes\n\nFirst.\n\n## Notes\n\nSecond.\n',
      });

      clickLink(editor, dom, 'later');
      const { $from } = editor.state.selection;
      expect($from.parent.type.name).toBe('heading');
      // The second of the two headings, as GitHub numbers them.
      expect($from.before()).toBe(
        editor.state.doc.child(0).nodeSize +
          editor.state.doc.child(1).nodeSize +
          editor.state.doc.child(2).nodeSize
      );
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it('numbers a repeated heading past one whose own text ends in a number, as GitHub does', () => {
      const { dom, editor } = renderEditor({
        content: '[third](#notes-2)\n\n## Notes\n\n## Notes 1\n\n## Notes\n',
      });

      clickLink(editor, dom, 'third');
      const { doc } = editor.state;
      expect(editor.state.selection.$from.before()).toBe(
        doc.child(0).nodeSize + doc.child(1).nodeSize + doc.child(2).nodeSize
      );
    });

    it("leaves a file the host won't show to the editor", () => {
      const fileLinks = {
        canOpen: vi.fn((path: string) => path !== 'docs/LICENSE'),
        open: vi.fn(),
      };
      const { dom, editor } = renderEditor({ content: '[license](LICENSE)\n', fileLinks });

      clickLink(editor, dom, 'license');
      expect(fileLinks.open).not.toHaveBeenCalled();
    });

    it('opens no link with the Windows or Super key, outside macOS', () => {
      const { container, dom, editor } = renderEditor({
        content: '[docs](https://example.com)\n',
      });

      clickLink(editor, dom, 'docs', { metaKey: true });
      expect(openExternal).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
      expect(container.querySelector('[data-markdown-scroller]')).not.toHaveAttribute(
        'data-link-modifier'
      );
    });

    it("leaves a link it can't open to the editor", () => {
      const fileLinks = { canOpen: vi.fn(() => true), open: vi.fn() };
      const { dom, editor } = renderEditor({
        content: '[ftp](ftp://example.com/a) [missing](#nowhere)\n',
        fileLinks,
      });

      clickLink(editor, dom, 'ftp');
      clickLink(editor, dom, 'missing');
      expect(openExternal).not.toHaveBeenCalled();
      expect(fileLinks.open).not.toHaveBeenCalled();
    });

    it("doesn't open a file link where there's nowhere to show it", () => {
      const { dom, editor } = renderEditor({
        content: '[setup](../setup.md)\n',
      });
      clickLink(editor, dom, 'setup');
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('keeps the page from following a link itself', () => {
      const { dom } = renderEditor({
        readOnly: true,
        content: '[docs](https://example.com)\n',
      });
      const link = dom.querySelector('a') as HTMLElement;
      // false: the click's default, which would open the link a second time, was prevented.
      expect(fireEvent.click(link)).toBe(false);
    });

    describe('hint', () => {
      function scroller(container: HTMLElement): HTMLElement {
        return container.querySelector('[data-markdown-scroller]') as HTMLElement;
      }

      it('says how to open a link while editing', () => {
        const { container, dom } = renderEditor({
          content: '[docs](https://example.com) and [ftp](ftp://example.com)\n',
        });
        const [docs, ftp] = dom.querySelectorAll('a');

        fireEvent.mouseOver(docs);
        expect(scroller(container)).toHaveAttribute('title', 'Ctrl+Click to open');
        fireEvent.mouseOver(dom.querySelector('p') as HTMLElement);
        expect(scroller(container)).not.toHaveAttribute('title');
        fireEvent.mouseOver(ftp);
        expect(scroller(container)).not.toHaveAttribute('title');
      });

      it("has nothing to say about a file the host won't show", () => {
        const fileLinks = { canOpen: (path: string) => path !== 'docs/LICENSE', open: vi.fn() };
        const { container, dom } = renderEditor({
          content: '[license](LICENSE) and [setup](setup.md)\n',
          fileLinks,
        });
        const [license, setup] = dom.querySelectorAll('a');

        fireEvent.mouseOver(license);
        expect(scroller(container)).not.toHaveAttribute('title');
        fireEvent.mouseOver(setup);
        expect(scroller(container)).toHaveAttribute('title', 'Ctrl+Click to open');
      });

      it('has nothing to say when a plain click opens the link', () => {
        const { container, dom } = renderEditor({
          readOnly: true,
          content: '[docs](https://example.com)\n',
        });
        fireEvent.mouseOver(dom.querySelector('a') as HTMLElement);
        expect(scroller(container)).not.toHaveAttribute('title');
      });

      it('shows links as clickable while the key that opens them is held', () => {
        window.api = {
          openExternal,
          platform: 'darwin',
        } as unknown as typeof window.api;
        const { container } = renderEditor();

        fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
        expect(scroller(container)).toHaveAttribute('data-link-modifier');
        fireEvent.keyUp(window, { key: 'Meta' });
        expect(scroller(container)).not.toHaveAttribute('data-link-modifier');

        // Ctrl+click on macOS opens the context menu, not the link.
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
        expect(scroller(container)).not.toHaveAttribute('data-link-modifier');

        fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
        fireEvent.blur(window);
        expect(scroller(container)).not.toHaveAttribute('data-link-modifier');
      });
    });
  });
});
