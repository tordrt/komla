import { describe, expect, it, vi } from 'vitest';

import {
  dispatchFileViewerKeydown,
  isEditorEscapeTarget,
  type FileViewerKeyboardContext,
  type ToastVariant,
} from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-keyboard';
import { claimShortcutEvent } from '../../../../../src/renderer/lib/shortcut-claims';

import type {
  FileViewerMode,
  GroupedFiles,
} from '../../../../../src/renderer/components/workspaces/file-viewer/types';
import type { FileChange } from '../../../../../src/types';

/**
 * Characterization tests for the FileViewerDialog keyboard dispatcher.
 *
 * Locks down the invariants the dispatcher refactor was designed to preserve:
 *   1. Cmd+Shift+C with no file path returns WITHOUT preventDefault.
 *   2. Cmd+C falls through (always exits handler) and only prevents default
 *      when no text is selected and a current path exists.
 *   3. View-mode toggles and diff file navigation are gated on focus NOT being
 *      in `.monaco-editor`, INPUT, or TEXTAREA.
 *   4. Change navigation (n/p/]/[) works even when a read-only Monaco side is
 *      focused, but never steals keys typed into an editable editor or input.
 *   5. Cmd+2 only switches to diff mode when isGitWorkspace is true.
 */

interface CallTrackers {
  saveFile: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  handleModeChange: ReturnType<typeof vi.fn>;
  goToNextChange: ReturnType<typeof vi.fn>;
  goToPreviousChange: ReturnType<typeof vi.fn>;
  handleDiffFileNavigate: ReturnType<typeof vi.fn>;
  setFileToDelete: ReturnType<typeof vi.fn>;
  setDiffViewMode: ReturnType<typeof vi.fn>;
  handleHistoryFileNavigate: ReturnType<typeof vi.fn>;
  setHistoryViewMode: ReturnType<typeof vi.fn>;
  copyToClipboard: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  closeTab: ReturnType<typeof vi.fn>;
  closeViewer: ReturnType<typeof vi.fn>;
}

interface BuildOpts {
  mode?: FileViewerMode;
  diffSubMode?: 'changes' | 'history';
  historyFilePaths?: string[];
  historySelectedFile?: string | null;
  isGitWorkspace?: boolean;
  editorFilePath?: string | null;
  diffSelectedFile?: string | null;
  diffFiles?: FileChange[];
  currentFilePath?: string | null;
  selectionText?: string;
  activeElement?: Element | null;
  monacoEditor?: ReturnType<typeof makeMonacoEditor> | null;
  diffEditor?: ReturnType<typeof makeDiffEditor> | null;
}

function makeFileChange(path: string, status: FileChange['status'] = 'modified'): FileChange {
  return {
    path,
    status,
    additions: 0,
    deletions: 0,
    isDirectory: false,
  };
}

function makeMonacoEditor(
  opts: { hasFocus?: boolean; selectionEmpty?: boolean; readOnly?: boolean } = {}
) {
  const hasFocus = opts.hasFocus ?? false;
  const selectionEmpty = opts.selectionEmpty ?? true;
  return {
    hasTextFocus: vi.fn(() => hasFocus),
    getRawOptions: vi.fn(() => ({ readOnly: opts.readOnly ?? false })),
    getSelection: vi.fn(() => ({
      isEmpty: () => selectionEmpty,
      startLineNumber: 1,
      endLineNumber: 1,
    })),
  };
}

function makeDiffEditor(
  opts: {
    modifiedFocus?: boolean;
    originalFocus?: boolean;
    selectionEmpty?: boolean;
    modifiedReadOnly?: boolean;
  } = {}
) {
  const modified = makeMonacoEditor({
    hasFocus: opts.modifiedFocus ?? false,
    selectionEmpty: opts.selectionEmpty ?? true,
    readOnly: opts.modifiedReadOnly ?? false,
  });
  const original = makeMonacoEditor({
    hasFocus: opts.originalFocus ?? false,
    selectionEmpty: opts.selectionEmpty ?? true,
    readOnly: true,
  });
  return {
    getModifiedEditor: vi.fn(() => modified),
    getOriginalEditor: vi.fn(() => original),
    modified,
    original,
  };
}

function buildContext(opts: BuildOpts = {}): {
  ctx: FileViewerKeyboardContext;
  calls: CallTrackers;
} {
  const calls: CallTrackers = {
    saveFile: vi.fn(),
    setSidebarOpen: vi.fn(),
    handleModeChange: vi.fn(),
    goToNextChange: vi.fn(),
    goToPreviousChange: vi.fn(),
    handleDiffFileNavigate: vi.fn(),
    setFileToDelete: vi.fn(),
    setDiffViewMode: vi.fn(),
    handleHistoryFileNavigate: vi.fn(),
    setHistoryViewMode: vi.fn(),
    copyToClipboard: vi.fn(),
    showToast: vi.fn<[string, ToastVariant], void>(),
    closeTab: vi.fn(),
    closeViewer: vi.fn(),
  };

  const grouped: GroupedFiles = {
    files: opts.diffFiles ?? [],
  };

  const ctx: FileViewerKeyboardContext = {
    mode: opts.mode ?? 'browse',
    diffSubMode: opts.diffSubMode ?? 'changes',
    isGitWorkspace: opts.isGitWorkspace ?? true,
    editorFilePath: opts.editorFilePath ?? null,
    diffSelectedFile: opts.diffSelectedFile ?? null,
    diffGrouped: grouped,
    historyFilePaths: opts.historyFilePaths ?? [],
    historySelectedFile: opts.historySelectedFile ?? null,
    currentFilePathRef: { current: opts.currentFilePath ?? null },
    monacoEditorRef: { current: (opts.monacoEditor ?? null) as never },
    diffEditorRef: { current: (opts.diffEditor ?? null) as never },
    closeTabRef: { current: calls.closeTab },
    closeViewer: calls.closeViewer,
    saveFile: calls.saveFile,
    setSidebarOpen: calls.setSidebarOpen,
    handleModeChange: calls.handleModeChange,
    goToNextChange: calls.goToNextChange,
    goToPreviousChange: calls.goToPreviousChange,
    handleDiffFileNavigate: calls.handleDiffFileNavigate,
    setFileToDelete: calls.setFileToDelete,
    setDiffViewMode: calls.setDiffViewMode,
    handleHistoryFileNavigate: calls.handleHistoryFileNavigate,
    setHistoryViewMode: calls.setHistoryViewMode,
    copyToClipboard: calls.copyToClipboard,
    showToast: calls.showToast,
    getSelection: () => opts.selectionText ?? '',
    getActiveElement: () => opts.activeElement ?? null,
  };

  return { ctx, calls };
}

interface FakeKeyOpts {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function fakeKey(opts: FakeKeyOpts): KeyboardEvent {
  const preventDefault = vi.fn();
  return {
    key: opts.key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    preventDefault,
  } as unknown as KeyboardEvent;
}

/**
 * Build a lightweight fake `Element` that satisfies the dispatcher's focus-guard
 * checks (`closest('.monaco-editor')` and `tagName`). Tests run in the `node`
 * vitest environment, so `document.createElement` is unavailable.
 */
function fakeElement(opts: { tagName?: string; insideMonaco?: boolean } = {}): Element {
  return {
    tagName: opts.tagName ?? 'DIV',
    closest: (selector: string) =>
      opts.insideMonaco && selector === '.monaco-editor' ? ({} as Element) : null,
  } as unknown as Element;
}

const NEUTRAL_ELEMENT = fakeElement();
const MONACO_ELEMENT = fakeElement({ insideMonaco: true });
const INPUT_ELEMENT = fakeElement({ tagName: 'INPUT' });
const TEXTAREA_ELEMENT = fakeElement({ tagName: 'TEXTAREA' });

describe('dispatchFileViewerKeydown — accelerator shortcuts', () => {
  it('Cmd+S triggers saveFile and preventDefault', () => {
    const { ctx, calls } = buildContext();
    const e = fakeKey({ key: 's', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.saveFile).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S also triggers saveFile (treated identically to Cmd)', () => {
    const { ctx, calls } = buildContext();
    const e = fakeKey({ key: 's', ctrl: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.saveFile).toHaveBeenCalledTimes(1);
  });

  it('Cmd+B toggles sidebar', () => {
    const { ctx, calls } = buildContext();
    const e = fakeKey({ key: 'b', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.setSidebarOpen).toHaveBeenCalledTimes(1);
    const updater = calls.setSidebarOpen.mock.calls[0][0] as (prev: boolean) => boolean;
    expect(updater(true)).toBe(false);
    expect(updater(false)).toBe(true);
  });

  it('Cmd+1 switches to browse mode', () => {
    const { ctx, calls } = buildContext({ mode: 'diff' });
    const e = fakeKey({ key: '1', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.handleModeChange).toHaveBeenCalledWith('browse');
  });

  it('Cmd+2 switches to diff mode when isGitWorkspace', () => {
    const { ctx, calls } = buildContext({ isGitWorkspace: true });
    const e = fakeKey({ key: '2', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.handleModeChange).toHaveBeenCalledWith('diff');
  });

  it('Cmd+2 still preventDefaults but does NOT switch mode in non-git workspace', () => {
    const { ctx, calls } = buildContext({ isGitWorkspace: false });
    const e = fakeKey({ key: '2', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.handleModeChange).not.toHaveBeenCalled();
  });

  it('ignores Cmd+1 and Cmd+2 that a dialog over the file viewer already handled', () => {
    for (const key of ['1', '2']) {
      const { ctx, calls } = buildContext({ mode: 'diff' });
      const e = fakeKey({ key, meta: true });
      claimShortcutEvent(e);
      dispatchFileViewerKeydown(e, ctx);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(calls.handleModeChange).not.toHaveBeenCalled();
    }
  });

  it('Cmd+W in browse mode with a file path closes the tab', () => {
    const { ctx, calls } = buildContext({ mode: 'browse', editorFilePath: 'a.ts' });
    const e = fakeKey({ key: 'w', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.closeTab).toHaveBeenCalledWith('a.ts');
  });

  it('Cmd+W in diff mode preventDefaults but does not close', () => {
    const { ctx, calls } = buildContext({ mode: 'diff', editorFilePath: 'a.ts' });
    const e = fakeKey({ key: 'w', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.closeTab).not.toHaveBeenCalled();
  });
});

describe('dispatchFileViewerKeydown — copy shortcuts', () => {
  it('Cmd+Shift+C with current file path copies @path:line and preventDefaults', () => {
    const monacoEditor = makeMonacoEditor({ hasFocus: true, selectionEmpty: true });
    const { ctx, calls } = buildContext({
      mode: 'browse',
      currentFilePath: 'src/foo.ts',
      monacoEditor,
    });
    const e = fakeKey({ key: 'c', meta: true, shift: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(calls.copyToClipboard.mock.calls[0][0]).toContain('src/foo.ts');
    expect(calls.showToast).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Shift+C without current file path does NOT preventDefault and does not copy', () => {
    const { ctx, calls } = buildContext({ currentFilePath: null });
    const e = fakeKey({ key: 'c', meta: true, shift: true });
    dispatchFileViewerKeydown(e, ctx);
    // INVARIANT 1: refuses to call preventDefault when there's nothing to copy
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.copyToClipboard).not.toHaveBeenCalled();
  });

  it('Cmd+C with no selection and a current path copies "@path " and preventDefaults', () => {
    const { ctx, calls } = buildContext({
      mode: 'browse',
      editorFilePath: 'src/foo.ts',
      selectionText: '',
    });
    const e = fakeKey({ key: 'c', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.copyToClipboard).toHaveBeenCalledWith('@src/foo.ts ');
    expect(calls.showToast).toHaveBeenCalledTimes(1);
  });

  it('Cmd+C with text selection does NOT preventDefault (browser handles native copy)', () => {
    const { ctx, calls } = buildContext({
      mode: 'browse',
      editorFilePath: 'src/foo.ts',
      selectionText: 'highlighted text',
    });
    const e = fakeKey({ key: 'c', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    // INVARIANT 2: lets the browser do the native copy
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.copyToClipboard).not.toHaveBeenCalled();
  });

  it('Cmd+C with no selection but no current path does nothing', () => {
    const { ctx, calls } = buildContext({
      mode: 'browse',
      editorFilePath: null,
      selectionText: '',
    });
    const e = fakeKey({ key: 'c', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.copyToClipboard).not.toHaveBeenCalled();
  });

  it('Cmd+C with focused Monaco (any selection state) defers to Monaco built-in copy', () => {
    // Monaco's default Cmd+C copies the current line when nothing is selected,
    // and the selection otherwise. We must not hijack either case.
    for (const selectionEmpty of [true, false]) {
      const monacoEditor = makeMonacoEditor({ hasFocus: true, selectionEmpty });
      const { ctx, calls } = buildContext({
        mode: 'browse',
        editorFilePath: 'src/foo.ts',
        selectionText: '',
        monacoEditor,
      });
      const e = fakeKey({ key: 'c', meta: true });
      dispatchFileViewerKeydown(e, ctx);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(calls.copyToClipboard).not.toHaveBeenCalled();
    }
  });

  it('Cmd+C in diff mode defers to Monaco when either side of the diff editor is focused', () => {
    // Same invariant as browse mode, but exercises the modified/original
    // branches of getActiveMonacoEditor so a refactor there can't regress.
    for (const focusedSide of ['modified', 'original'] as const) {
      for (const selectionEmpty of [true, false]) {
        const diffEditor = makeDiffEditor({
          modifiedFocus: focusedSide === 'modified',
          originalFocus: focusedSide === 'original',
          selectionEmpty,
        });
        const { ctx, calls } = buildContext({
          mode: 'diff',
          diffSelectedFile: 'src/foo.ts',
          selectionText: '',
          diffEditor,
        });
        const e = fakeKey({ key: 'c', meta: true });
        dispatchFileViewerKeydown(e, ctx);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(calls.copyToClipboard).not.toHaveBeenCalled();
      }
    }
  });
});

describe('dispatchFileViewerKeydown — change navigation (works even with Monaco focused)', () => {
  it('n key calls goToNextChange in diff mode when the read-only original side is focused', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      activeElement: MONACO_ELEMENT,
      diffEditor: makeDiffEditor({ originalFocus: true }),
    });
    const e = fakeKey({ key: 'n' });
    dispatchFileViewerKeydown(e, ctx);
    // INVARIANT 4: change-nav runs before the focus guard
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.goToNextChange).toHaveBeenCalledTimes(1);
  });

  it('n key navigates when a read-only modified side is focused', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      activeElement: MONACO_ELEMENT,
      diffEditor: makeDiffEditor({ modifiedFocus: true, modifiedReadOnly: true }),
    });
    const e = fakeKey({ key: 'n' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.goToNextChange).toHaveBeenCalledTimes(1);
  });

  it.each(['n', 'p', '[', ']'])(
    '%s is typed, not taken, when the editable modified side is focused',
    (key) => {
      const { ctx, calls } = buildContext({
        mode: 'diff',
        activeElement: MONACO_ELEMENT,
        diffEditor: makeDiffEditor({ modifiedFocus: true }),
      });
      const e = fakeKey({ key });
      dispatchFileViewerKeydown(e, ctx);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(calls.goToNextChange).not.toHaveBeenCalled();
      expect(calls.goToPreviousChange).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['INPUT', INPUT_ELEMENT],
    ['TEXTAREA', TEXTAREA_ELEMENT],
    ["editor's Find box", fakeElement({ tagName: 'TEXTAREA', insideMonaco: true })],
  ])('n is typed, not taken, when focus is in an %s', (_label, activeElement) => {
    const { ctx, calls } = buildContext({ mode: 'diff', activeElement });
    const e = fakeKey({ key: 'n' });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.goToNextChange).not.toHaveBeenCalled();
  });

  it('Alt+F5 and Shift+Alt+F5 navigate from inside the editable modified side', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      activeElement: MONACO_ELEMENT,
      diffEditor: makeDiffEditor({ modifiedFocus: true }),
    });
    const next = fakeKey({ key: 'F5', alt: true });
    dispatchFileViewerKeydown(next, ctx);
    expect(next.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.goToNextChange).toHaveBeenCalledTimes(1);

    const prev = fakeKey({ key: 'F5', alt: true, shift: true });
    dispatchFileViewerKeydown(prev, ctx);
    expect(prev.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.goToPreviousChange).toHaveBeenCalledTimes(1);
  });

  it('Alt+F5 does nothing in browse mode', () => {
    const { ctx, calls } = buildContext({ mode: 'browse' });
    const e = fakeKey({ key: 'F5', alt: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.goToNextChange).not.toHaveBeenCalled();
  });

  it('] key also triggers next change', () => {
    const { ctx, calls } = buildContext({ mode: 'diff' });
    const e = fakeKey({ key: ']' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.goToNextChange).toHaveBeenCalledTimes(1);
  });

  it('p key calls goToPreviousChange', () => {
    const { ctx, calls } = buildContext({ mode: 'diff', activeElement: NEUTRAL_ELEMENT });
    const e = fakeKey({ key: 'p' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.goToPreviousChange).toHaveBeenCalledTimes(1);
  });

  it('[ key also triggers previous change', () => {
    const { ctx, calls } = buildContext({ mode: 'diff' });
    const e = fakeKey({ key: '[' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.goToPreviousChange).toHaveBeenCalledTimes(1);
  });

  it('change-nav keys do NOT fire in browse mode', () => {
    const { ctx, calls } = buildContext({ mode: 'browse' });
    const e = fakeKey({ key: 'n' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.goToNextChange).not.toHaveBeenCalled();
  });

  it('change-nav keys do NOT fire when modifier is held', () => {
    const { ctx, calls } = buildContext({ mode: 'diff' });
    const e = fakeKey({ key: 'n', alt: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.goToNextChange).not.toHaveBeenCalled();
  });
});

describe('dispatchFileViewerKeydown — view mode toggle (gated by focus)', () => {
  it('"1" toggles split when focus is on body', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: '1' });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.setDiffViewMode).toHaveBeenCalledWith('split');
  });

  it('"2" toggles unified when focus is on body', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: '2' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.setDiffViewMode).toHaveBeenCalledWith('unified');
  });

  it('view mode toggle does NOT fire when focus is in monaco-editor', () => {
    const { ctx, calls } = buildContext({ mode: 'diff', activeElement: MONACO_ELEMENT });
    const e = fakeKey({ key: '1' });
    dispatchFileViewerKeydown(e, ctx);
    // INVARIANT 3: focus guard blocks view-mode toggle in editor
    expect(calls.setDiffViewMode).not.toHaveBeenCalled();
  });

  it('view mode toggle does NOT fire when focus is in INPUT', () => {
    const { ctx, calls } = buildContext({ mode: 'diff', activeElement: INPUT_ELEMENT });
    const e = fakeKey({ key: '1' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.setDiffViewMode).not.toHaveBeenCalled();
  });

  it('view mode toggle does NOT fire when focus is in TEXTAREA', () => {
    const { ctx, calls } = buildContext({ mode: 'diff', activeElement: TEXTAREA_ELEMENT });
    const e = fakeKey({ key: '1' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.setDiffViewMode).not.toHaveBeenCalled();
  });

  it('view mode toggle does NOT fire in browse mode', () => {
    const { ctx, calls } = buildContext({ mode: 'browse' });
    const e = fakeKey({ key: '1' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.setDiffViewMode).not.toHaveBeenCalled();
  });
});

describe('dispatchFileViewerKeydown — diff file navigation (gated by focus)', () => {
  const files = [makeFileChange('a.ts'), makeFileChange('b.ts'), makeFileChange('c.ts')];

  it('ArrowDown advances selection forward', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'ArrowDown' });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.handleDiffFileNavigate).toHaveBeenCalledWith('b.ts');
  });

  it('j key advances selection forward', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'j' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).toHaveBeenCalledWith('b.ts');
  });

  it('ArrowDown wraps from last to first', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'c.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'ArrowDown' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).toHaveBeenCalledWith('a.ts');
  });

  it('ArrowUp goes backward and wraps from first to last', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'ArrowUp' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).toHaveBeenCalledWith('c.ts');
  });

  it('k key goes backward', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'b.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'k' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).toHaveBeenCalledWith('a.ts');
  });

  it('Delete sets fileToDelete based on selected file', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'b.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'Delete' });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.setFileToDelete).toHaveBeenCalledWith('b.ts');
  });

  it('Backspace also sets fileToDelete', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'Backspace' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.setFileToDelete).toHaveBeenCalledWith('a.ts');
  });

  it('navigation does NOT fire when focus is in monaco-editor', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: MONACO_ELEMENT,
    });
    const e = fakeKey({ key: 'ArrowDown' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).not.toHaveBeenCalled();
  });

  it('navigation does NOT fire when focus is in an INPUT', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: INPUT_ELEMENT,
    });
    const e = fakeKey({ key: 'j' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).not.toHaveBeenCalled();
  });

  it('navigation does nothing when no files in grouped diff', () => {
    const { ctx, calls } = buildContext({
      mode: 'diff',
      diffFiles: [],
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'ArrowDown' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).not.toHaveBeenCalled();
  });

  it('navigation does NOT fire in browse mode', () => {
    const { ctx, calls } = buildContext({
      mode: 'browse',
      diffFiles: files,
      diffSelectedFile: 'a.ts',
      activeElement: NEUTRAL_ELEMENT,
    });
    const e = fakeKey({ key: 'ArrowDown' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.handleDiffFileNavigate).not.toHaveBeenCalled();
  });
});

describe('dispatchFileViewerKeydown — history sub-mode', () => {
  const workingTreeFiles = [makeFileChange('a.ts'), makeFileChange('b.ts')];
  const historyOpts: BuildOpts = {
    mode: 'diff',
    diffSubMode: 'history',
    diffFiles: workingTreeFiles,
    diffSelectedFile: 'a.ts',
    historyFilePaths: ['x.ts', 'y.ts', 'z.ts'],
    historySelectedFile: 'y.ts',
    activeElement: NEUTRAL_ELEMENT,
  };

  it.each([
    ['ArrowDown', 'z.ts'],
    ['j', 'z.ts'],
    ['ArrowUp', 'x.ts'],
    ['k', 'x.ts'],
  ])('%s moves through the commit files, not the hidden Changes list', (key, expected) => {
    const { ctx, calls } = buildContext(historyOpts);
    const e = fakeKey({ key });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.handleHistoryFileNavigate).toHaveBeenCalledWith(expected);
    expect(calls.handleDiffFileNavigate).not.toHaveBeenCalled();
  });

  it('wraps commit-file navigation at the ends', () => {
    const { ctx, calls } = buildContext({ ...historyOpts, historySelectedFile: 'z.ts' });
    dispatchFileViewerKeydown(fakeKey({ key: 'ArrowDown' }), ctx);
    expect(calls.handleHistoryFileNavigate).toHaveBeenCalledWith('x.ts');
  });

  it('does nothing when the selected commit has no files', () => {
    const { ctx, calls } = buildContext({ ...historyOpts, historyFilePaths: [] });
    const e = fakeKey({ key: 'ArrowDown' });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.handleHistoryFileNavigate).not.toHaveBeenCalled();
    expect(calls.handleDiffFileNavigate).not.toHaveBeenCalled();
  });

  it.each(['Delete', 'Backspace'])(
    '%s does not offer to delete a hidden working-tree file',
    (key) => {
      const { ctx, calls } = buildContext(historyOpts);
      const e = fakeKey({ key });
      dispatchFileViewerKeydown(e, ctx);
      expect(calls.setFileToDelete).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['1', 'split'],
    ['2', 'unified'],
  ])('"%s" sets the history view mode', (key, viewMode) => {
    const { ctx, calls } = buildContext(historyOpts);
    const e = fakeKey({ key });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls.setHistoryViewMode).toHaveBeenCalledWith(viewMode);
    expect(calls.setDiffViewMode).not.toHaveBeenCalled();
  });

  it('Cmd+C copies the selected commit file, not the hidden Changes selection', () => {
    const { ctx, calls } = buildContext({ ...historyOpts, selectionText: '' });
    const e = fakeKey({ key: 'c', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.copyToClipboard).toHaveBeenCalledWith('@y.ts ');
  });

  it('history navigation does NOT fire when focus is in monaco-editor', () => {
    const { ctx, calls } = buildContext({ ...historyOpts, activeElement: MONACO_ELEMENT });
    dispatchFileViewerKeydown(fakeKey({ key: 'ArrowDown' }), ctx);
    dispatchFileViewerKeydown(fakeKey({ key: '1' }), ctx);
    expect(calls.handleHistoryFileNavigate).not.toHaveBeenCalled();
    expect(calls.setHistoryViewMode).not.toHaveBeenCalled();
  });
});

describe('dispatchFileViewerKeydown — Escape', () => {
  it('closes the viewer when Escape aimed at the editor reaches the window unhandled', () => {
    const { ctx, calls } = buildContext({ activeElement: MONACO_ELEMENT });
    const e = fakeKey({ key: 'Escape' });
    dispatchFileViewerKeydown(e, ctx);
    expect(calls.closeViewer).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape outside the editor to the dialog, which already closed', () => {
    const { ctx, calls } = buildContext({ activeElement: NEUTRAL_ELEMENT });
    dispatchFileViewerKeydown(fakeKey({ key: 'Escape' }), ctx);
    expect(calls.closeViewer).not.toHaveBeenCalled();
  });

  it('treats the editor and its vim status bar as using Escape themselves', () => {
    expect(isEditorEscapeTarget(MONACO_ELEMENT)).toBe(true);
    expect(
      isEditorEscapeTarget({
        closest: (selector: string) =>
          selector.includes('[data-vim-status-bar]') ? ({} as Element) : null,
      } as unknown as Element)
    ).toBe(true);
    expect(isEditorEscapeTarget(INPUT_ELEMENT)).toBe(false);
    expect(isEditorEscapeTarget(null)).toBe(false);
  });
});

describe('dispatchFileViewerKeydown — unhandled keys', () => {
  it('lets unrelated keys fall through without preventDefault', () => {
    const { ctx, calls } = buildContext();
    const e = fakeKey({ key: 'Tab' });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.saveFile).not.toHaveBeenCalled();
    expect(calls.handleModeChange).not.toHaveBeenCalled();
  });

  it('Cmd+key for an unhandled key does nothing', () => {
    const { ctx, calls } = buildContext();
    const e = fakeKey({ key: 'q', meta: true });
    dispatchFileViewerKeydown(e, ctx);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(calls.saveFile).not.toHaveBeenCalled();
  });
});
