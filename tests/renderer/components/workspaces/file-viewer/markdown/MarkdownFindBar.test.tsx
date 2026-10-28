/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../../../src/renderer/components/ui/tooltip';
import {
  findMatches,
  getMarkdownSearch,
} from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-search';
import { RichMarkdownEditor } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor';
import { isEditorEscapeTarget } from '../../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-keyboard';
import { isShortcutEventClaimed } from '../../../../../../src/renderer/lib/shortcut-claims';

import type { MarkdownEditorHandle } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor';
import type { Editor } from '@tiptap/core';

vi.mock('../../../../../../src/renderer/lib/monaco-loader', () => ({
  ensureMonacoInitialized: () => Promise.resolve(),
  subscribeKomlaEditorTheme: () => () => {},
  getMonacoThemeName: () => 'komla-dark',
  getShikiHighlighter: () => null,
  loadShikiLanguage: async () => false,
  subscribeShikiLanguageLoads: () => () => {},
}));

// jsdom doesn't lay out: every range sits at this rect, and every element at the top.
const matchRect = { top: 0, bottom: 20 };
beforeAll(() => {
  const rect = () => ({ ...matchRect, left: 0, right: 10, width: 10, height: 20 }) as DOMRect;
  Range.prototype.getClientRects = () => [rect()] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = rect;
  Element.prototype.scrollIntoView = () => {};
});

const SOURCE = '# Plan\n\nThe __plan__ is a\nplan. PLAN it.\n\n```\nplan()\n```\n';

function renderEditor(props: Partial<React.ComponentProps<typeof RichMarkdownEditor>> = {}) {
  const ref = createRef<MarkdownEditorHandle>();
  const onChange = vi.fn();
  const view = render(
    <RichMarkdownEditor
      ref={ref}
      filePath="docs/plan.md"
      content={SOURCE}
      readOnly={false}
      onChange={onChange}
      readImage={vi.fn()}
      {...props}
    />,
    { wrapper: TooltipProvider }
  );
  const dom = view.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
  return { ...view, ref, onChange, dom, editor: dom.editor };
}

function openFind(target: Element) {
  fireEvent.keyDown(target, { key: 'f', ctrlKey: true });
  return screen.getByRole('textbox', { name: 'Find' });
}

function typeQuery(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

const highlighted = (dom: HTMLElement) =>
  [...dom.querySelectorAll('.markdown-search-match')].map((match) => match.textContent);
const current = (dom: HTMLElement) => dom.querySelector('.markdown-search-match.current');
function endOfFirstParagraph(editor: Editor): number {
  const { doc } = editor.state;
  return doc.child(0).nodeSize + doc.child(1).nodeSize - 1;
}
const selectedText = (editor: Editor) =>
  editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to);

describe('findMatches', () => {
  it('finds text across formatting, wrapped lines and code, ignoring case', () => {
    const { editor } = renderEditor();
    const texts = (query: string, caseSensitive = false) =>
      findMatches(editor.state.doc, query, caseSensitive).map(({ from, to }) =>
        editor.state.doc.textBetween(from, to, '\n')
      );
    expect(texts('plan')).toEqual(['Plan', 'plan', 'plan', 'PLAN', 'plan']);
    expect(texts('plan', true)).toEqual(['plan', 'plan', 'plan']);
    // The line break after "a" shows as a space.
    expect(texts('a plan')).toEqual(['a\nplan']);
    expect(texts('plan()')).toEqual(['plan()']);
    expect(texts('')).toEqual([]);
  });

  it("doesn't match across an image", () => {
    const { editor } = renderEditor({ content: 'a![x](x.png)b\n' });
    expect(findMatches(editor.state.doc, 'ab', false)).toEqual([]);
  });
});

describe('MarkdownFindBar', () => {
  it('opens on Ctrl+F, and claims the key from the app shortcuts', () => {
    const { dom } = renderEditor();
    const claimed = vi.fn();
    const listener = (event: KeyboardEvent) => claimed(isShortcutEventClaimed(event));
    window.addEventListener('keydown', listener);
    try {
      const input = openFind(dom);
      expect(input).toHaveFocus();
    } finally {
      window.removeEventListener('keydown', listener);
    }
    expect(claimed).toHaveBeenCalledWith(true);
  });

  it('highlights every match and selects the first from the cursor on', () => {
    const { dom, editor } = renderEditor();
    act(() => {
      editor.commands.setTextSelection(12);
    });
    typeQuery(openFind(dom), 'plan');
    expect(highlighted(dom)).toEqual(['Plan', 'plan', 'plan', 'PLAN', 'plan']);
    expect(current(dom)?.textContent).toBe('plan');
    expect(screen.getByRole('status')).toHaveTextContent('3/5');
    expect(selectedText(editor)).toBe('plan');
  });

  it('scrolls a match below the visible part of the file a third of the way down', () => {
    const { container, dom } = renderEditor();
    const scroller = container.querySelector('[data-markdown-scroller]') as HTMLElement;
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
    matchRect.top = 1000;
    matchRect.bottom = 1020;
    try {
      typeQuery(openFind(dom), 'plan');
    } finally {
      matchRect.top = 0;
      matchRect.bottom = 20;
    }
    expect(scroller.scrollTop).toBe(900);
  });

  it('steps through matches with Enter and Shift+Enter, wrapping around', () => {
    const { dom } = renderEditor();
    const input = openFind(dom);
    typeQuery(input, 'plan');
    expect(screen.getByRole('status')).toHaveTextContent('1/5');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('5/5');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent('2/5');
  });

  it('moves the current highlight between matches that touch', () => {
    const { dom } = renderEditor({ content: 'eee\n' });
    const input = openFind(dom);
    typeQuery(input, 'e');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(highlighted(dom)).toEqual(['e', 'e', 'e']);
    expect(dom.querySelectorAll('.markdown-search-match.current')).toHaveLength(1);
    expect(dom.querySelector('.markdown-search-match:last-child')).toHaveClass('current');
  });

  it('matches case when asked', () => {
    const { dom } = renderEditor();
    typeQuery(openFind(dom), 'PLAN');
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    expect(highlighted(dom)).toEqual(['PLAN']);
  });

  it('says when nothing matches', () => {
    const { dom } = renderEditor();
    typeQuery(openFind(dom), 'nowhere');
    expect(screen.getByRole('status')).toHaveTextContent('No results');
    expect(highlighted(dom)).toEqual([]);
  });

  it('seeds the search from the selected text', () => {
    const { dom, editor } = renderEditor();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    expect(openFind(dom)).toHaveValue('Plan');
  });

  it('closes on Escape without the Escape reaching the file viewer, and keeps the match selected', () => {
    const { dom, editor } = renderEditor();
    const input = openFind(dom);
    typeQuery(input, 'PLAN it');
    const reachedWindow = vi.fn();
    window.addEventListener('keydown', reachedWindow);
    try {
      expect(isEditorEscapeTarget(input)).toBe(true);
      fireEvent.keyDown(input, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', reachedWindow);
    }
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(document.querySelector('[data-markdown-find]')).toBeNull();
    expect(highlighted(dom)).toEqual([]);
    expect(selectedText(editor)).toBe('PLAN it');
  });

  it('closes on Escape from the text too, before the file viewer would close', () => {
    const { dom } = renderEditor();
    typeQuery(openFind(dom), 'plan');
    // The file viewer's Escape handler runs first and leaves Escape aimed at the editor alone.
    expect(isEditorEscapeTarget(dom)).toBe(true);
    const reachedWindow = vi.fn();
    window.addEventListener('keydown', reachedWindow);
    try {
      fireEvent.keyDown(dom, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', reachedWindow);
    }
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(document.querySelector('[data-markdown-find]')).toBeNull();
    // With the bar closed, Escape in the text closes the viewer as before.
    expect(isEditorEscapeTarget(dom)).toBe(false);
  });

  it('closes on Escape in the file viewer, whose dialog marks every Escape handled first', () => {
    const { dom } = renderEditor();
    const input = openFind(dom);
    // Radix's dialog listens in the capture phase and prevents Escape's default before the bar.
    const dialogEscape = (event: KeyboardEvent) => event.preventDefault();
    const reachedWindow = vi.fn();
    document.addEventListener('keydown', dialogEscape, true);
    window.addEventListener('keydown', reachedWindow);
    try {
      fireEvent.keyDown(input, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', dialogEscape, true);
      window.removeEventListener('keydown', reachedWindow);
    }
    expect(document.querySelector('[data-markdown-find]')).toBeNull();
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it('leaves Escape to the slash menu while it is open', async () => {
    const { dom, editor } = renderEditor({ content: 'text\n' });
    openFind(dom);
    act(() => {
      editor.chain().focus('end').splitBlock().insertContent('/').run();
    });
    expect(await screen.findByRole('listbox', { name: 'Insert block' })).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(dom, { key: 'Escape' });
    });
    expect(screen.queryByRole('listbox', { name: 'Insert block' })).toBeNull();
    expect(document.querySelector('[data-markdown-find]')).not.toBeNull();
  });

  it('leaves an Escape that ends an IME composition to the input', () => {
    const { dom } = renderEditor();
    const input = openFind(dom);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(document.querySelector('[data-markdown-find]')).not.toBeNull();
  });

  it('gives focus back to a read-only file, so Cmd+F works again', () => {
    const { container } = renderEditor({ readOnly: true });
    const scroller = container.querySelector('[data-markdown-scroller]') as HTMLElement;
    scroller.focus();
    fireEvent.keyDown(openFind(scroller), { key: 'Escape' });
    expect(scroller).toHaveFocus();
  });

  it('keeps the typed search when Cmd+F is pressed again in the bar', () => {
    const { dom } = renderEditor();
    const input = openFind(dom);
    typeQuery(input, 'plan');
    // The current match, "Plan", is now the editor's selection.
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    expect(input).toHaveValue('plan');
  });

  it("doesn't seed the search from a selection with an image in it", () => {
    const { dom, editor } = renderEditor({ content: 'see ![x](a.png) here\n' });
    act(() => {
      editor.commands.selectAll();
    });
    expect(openFind(dom)).toHaveValue('');
  });

  it('remembers the last search when opened again', () => {
    const { dom } = renderEditor();
    const input = openFind(dom);
    typeQuery(input, 'it');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(openFind(dom)).toHaveValue('it');
  });

  it('follows edits made while it is open', () => {
    const { dom, editor } = renderEditor();
    typeQuery(openFind(dom), 'plan');
    act(() => {
      editor.commands.insertContentAt(1, 'plan ');
    });
    expect(highlighted(dom)).toHaveLength(6);
  });

  it('keeps its matches in step with edits, as a fresh search would find them', () => {
    const { dom, editor, rerender } = renderEditor();
    typeQuery(openFind(dom), 'plan');
    const expectInSync = () => {
      const search = getMarkdownSearch(editor)!;
      expect(search.matches).toEqual(findMatches(editor.state.doc, 'plan', false));
      const decorations = search.decorations.find();
      expect(decorations.map(({ from, to }) => ({ from, to }))).toEqual(search.matches);
      const current = decorations.filter((decoration) => decoration.spec.current);
      expect(current.map(({ from, to }) => ({ from, to }))).toEqual([search.matches[search.current]]);
    };
    const edits: Array<() => void> = [
      // Typing into a match, then completing a new one.
      () => editor.commands.insertContentAt(15, 'x'),
      () => editor.commands.insertContentAt(endOfFirstParagraph(editor), ' pl'),
      () => editor.commands.insertContentAt(endOfFirstParagraph(editor), 'an'),
      // Splitting a paragraph inside a match, then joining it again.
      () => editor.chain().setTextSelection(20).splitBlock().run(),
      () => editor.commands.undo(),
      // Deleting across blocks.
      () => editor.commands.deleteRange({ from: 3, to: 14 }),
      () => editor.commands.undo(),
    ];
    for (const edit of edits) {
      act(() => {
        edit();
      });
      expectInSync();
    }
    // The file changing on disk replaces the whole document.
    rerender(
      <RichMarkdownEditor
        filePath="docs/plan.md"
        content={'Plan B.\n\nNo plan, no PLAN.\n'}
        readOnly={false}
        readImage={vi.fn()}
      />
    );
    expectInSync();
    expect(highlighted(dom)).toEqual(['Plan', 'plan', 'PLAN']);
  });

  it('replaces the current match and moves to the next, leaving the rest of the file as written', () => {
    const { dom, ref } = renderEditor();
    typeQuery(openFind(dom), 'plan');
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const replacement = screen.getByRole('textbox', { name: 'Replace' });
    typeQuery(replacement, 'plan B');
    fireEvent.keyDown(replacement, { key: 'Enter' });
    expect(ref.current?.getMarkdown()).toBe(
      '# plan B\n\nThe __plan__ is a\nplan. PLAN it.\n\n```\nplan()\n```\n'
    );
    // The replacement's own "plan" isn't the next match.
    expect(screen.getByRole('status')).toHaveTextContent('2/5');
  });

  it('replaces every match in one undoable step', () => {
    const { dom, editor, ref } = renderEditor();
    typeQuery(openFind(dom), 'plan');
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    typeQuery(screen.getByRole('textbox', { name: 'Replace' }), 'goal');
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    expect(ref.current?.getMarkdown()).toBe(
      '# goal\n\nThe __goal__ is a\ngoal. goal it.\n\n```\ngoal()\n```\n'
    );
    act(() => {
      editor.commands.undo();
    });
    expect(ref.current?.getMarkdown()).toBe(SOURCE);
  });

  it('deletes matches when replacing with nothing', () => {
    const { dom, ref } = renderEditor({ content: 'keep\n\nplan\n' });
    typeQuery(openFind(dom), 'plan');
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    expect(ref.current?.getMarkdown()).toBe('keep\n');
  });

  it('finds but offers no replace in a read-only file', () => {
    const { container, dom } = renderEditor({ readOnly: true });
    const scroller = container.querySelector('[data-markdown-scroller]') as HTMLElement;
    typeQuery(openFind(scroller), 'plan');
    expect(highlighted(dom)).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
  });
});
