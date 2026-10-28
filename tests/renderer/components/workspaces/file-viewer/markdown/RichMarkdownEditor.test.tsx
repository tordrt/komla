/** @vitest-environment jsdom */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
});
