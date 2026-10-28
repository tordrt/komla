/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EditorPane } from '../../../../../src/renderer/components/workspaces/file-viewer/EditorPane';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useCustomizationStore } from '../../../../../src/renderer/stores/customization.store';
import { DEFAULT_TERMINAL_CONFIG } from '../../../../../src/shared/constants/terminal';

import type { AppConfig } from '../../../../../src/renderer/types';

const vim = vi.hoisted(() => ({
  defineEx: vi.fn(),
  initVimMode: vi.fn(() => ({ dispose: () => {} })),
}));
const mountedEditor = vi.hoisted(() => ({
  current: null as unknown,
  props: null as null | { value?: string; defaultValue?: string; options?: { fontSize?: number } },
  onChange: undefined as undefined | ((value: string) => void),
}));

vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor(props: {
    value?: string;
    defaultValue?: string;
    options?: { lineNumbersMinChars?: number; fontSize?: number };
    onMount?: (editor: unknown) => void;
    onChange?: (value: string) => void;
  }) {
    const { options, onMount } = props;
    mountedEditor.props = props;
    mountedEditor.onChange = props.onChange;
    useEffect(() => {
      if (mountedEditor.current) onMount?.(mountedEditor.current);
    }, [onMount]);
    return <div data-line-number-chars={options?.lineNumbersMinChars}>Editor</div>;
  },
}));

vi.mock('../../../../../src/renderer/hooks/useKomlaEditorTheme', () => ({
  useMonacoThemeName: () => 'komla-dark',
}));
vi.mock('../../../../../src/renderer/lib/monaco-shortcut-forwarding', () => ({
  addMonacoShortcutForwarding: () => {},
}));
vi.mock('monaco-vim', () => ({
  initVimMode: vim.initVimMode,
  VimMode: { Vim: { defineEx: vim.defineEx } },
}));

/** A Monaco editor whose model edits report through the wrapper's onChange, as Monaco's do. */
function fakeEditorWithModel(text: string) {
  let eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r\n|\n/);
  const value = () => lines.join(eol);
  const offsetAt = (lineNumber: number, column: number) =>
    lines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + eol.length, 0) +
    column -
    1;
  /** The user typing, leaving `next` in the editor. */
  const type = (next: string) => {
    lines = next.split(/\r\n|\n/);
    mountedEditor.onChange?.(value());
  };
  const model = {
    getValue: value,
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1],
    getLineMaxColumn: (lineNumber: number) => lines[lineNumber - 1].length + 1,
    getEOL: () => eol,
    setValue: vi.fn((next: string) => {
      eol = next.includes('\r\n') ? '\r\n' : '\n';
      lines = next.split(/\r\n|\n/);
      mountedEditor.onChange?.(value());
    }),
    pushEOL: vi.fn((sequence: number) => {
      eol = sequence === 1 ? '\r\n' : '\n';
      mountedEditor.onChange?.(value());
    }),
    pushStackElement: vi.fn(),
    pushEditOperations: vi.fn(
      (
        _selections: unknown,
        edits: Array<{
          range: {
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          };
          text: string;
        }>
      ) => {
        const before = value();
        for (const { range, text: replacement } of edits) {
          const start = offsetAt(range.startLineNumber, range.startColumn);
          const end = offsetAt(range.endLineNumber, range.endColumn);
          lines = (before.slice(0, start) + replacement + before.slice(end)).split(/\r\n|\n/);
        }
        mountedEditor.onChange?.(value());
        return null;
      }
    ),
  };
  return { model, editor: { getModel: () => model }, type };
}

describe('EditorPane', () => {
  it('shows editor initialization errors even while Monaco is not ready', () => {
    render(
      <EditorPane
        filePath="demo.ts"
        fileContent="hello"
        loading
        error="Failed to initialize editor: Outdated Optimize Dep"
      />
    );
    expect(screen.getByText('Failed to initialize editor: Outdated Optimize Dep')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it.each([
    { lines: 5, chars: 2 },
    { lines: 10, chars: 3 },
    { lines: 1200, chars: 5 },
  ])('keeps a character of space before $lines-line numbers', ({ lines, chars }) => {
    render(<EditorPane filePath="demo.ts" fileContent={'x\n'.repeat(lines - 1) + 'x'} />);

    expect(screen.getByText('Editor')).toHaveAttribute('data-line-number-chars', String(chars));
  });

  it('sizes its text a pixel under the terminal font, as at the 14px default', () => {
    const fontSize = () => mountedEditor.props?.options?.fontSize;
    render(<EditorPane filePath="demo.ts" fileContent="hello" />);
    expect(fontSize()).toBe(13);

    act(() => {
      useCustomizationStore.setState({
        terminalConfig: {
          ...DEFAULT_TERMINAL_CONFIG,
          font: { ...DEFAULT_TERMINAL_CONFIG.font, size: 18 },
        },
      });
    });
    expect(fontSize()).toBe(17);
    useCustomizationStore.setState({ terminalConfig: null });
  });

  it('saves on vim :w and keeps Escape inside the editor', async () => {
    const save = vi.fn();
    const editor = {
      getModel: () => null,
      getAction: vi.fn((id: string) => (id === 'save-file' ? { run: save } : null)),
    };
    mountedEditor.current = editor;
    useConfigStore.setState({ config: { vimModeEnabled: true } as AppConfig });
    try {
      render(<EditorPane filePath="demo.ts" fileContent="hello" loading={false} error={null} />);

      await waitFor(() =>
        expect(vim.defineEx).toHaveBeenCalledWith('write', 'w', expect.any(Function))
      );
      const write = vim.defineEx.mock.calls[0][2] as (cm: { editor: unknown }) => void;
      write({ editor });
      expect(save).toHaveBeenCalledTimes(1);

      // Escape in normal mode is a no-op in vim, so it must not close the viewer around it.
      const reachedWindow = vi.fn();
      window.addEventListener('keydown', reachedWindow);
      try {
        fireEvent.keyDown(screen.getByText('Editor'), { key: 'Escape' });
        fireEvent.keyDown(screen.getByText('Editor'), { key: 'j' });
      } finally {
        window.removeEventListener('keydown', reachedWindow);
      }
      expect(reachedWindow.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(['j']);
    } finally {
      mountedEditor.current = null;
      useConfigStore.setState({ config: null });
    }
  });

  it('lets Escape out of the editor when vim fails to start', async () => {
    vim.initVimMode.mockImplementationOnce(() => {
      throw new Error('vim failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mountedEditor.current = { getModel: () => null };
    useConfigStore.setState({ config: { vimModeEnabled: true } as AppConfig });
    const reachedWindow = vi.fn();
    window.addEventListener('keydown', reachedWindow);
    try {
      render(<EditorPane filePath="demo.ts" fileContent="hello" loading={false} error={null} />);
      await waitFor(() => expect(warn).toHaveBeenCalled());

      fireEvent.keyDown(screen.getByText('Editor'), { key: 'Escape' });

      expect(reachedWindow).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', reachedWindow);
      warn.mockRestore();
      mountedEditor.current = null;
      useConfigStore.setState({ config: null });
    }
  });

  it('applies a file changed on disk as an edit to the open text, not as typing', async () => {
    const { model, editor } = fakeEditorWithModel('a\nb\nc');
    mountedEditor.current = editor;
    const onChange = vi.fn();
    try {
      const view = render(
        <EditorPane
          filePath="demo.ts"
          fileContent={'a\nb\nc'}
          loading={false}
          error={null}
          onChange={onChange}
        />
      );
      await waitFor(() => expect(mountedEditor.onChange).toBeDefined());
      // The wrapper would replace the whole text on a new `value`, losing the cursor and scroll.
      expect(mountedEditor.props?.value).toBeUndefined();

      view.rerender(
        <EditorPane
          filePath="demo.ts"
          fileContent={'a\nX\nc'}
          loading={false}
          error={null}
          onChange={onChange}
        />
      );

      expect(model.pushEditOperations).toHaveBeenCalledTimes(1);
      expect(model.pushEditOperations.mock.calls[0][1]).toEqual([
        {
          range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
          text: 'X\n',
          forceMoveMarkers: true,
        },
      ]);
      expect(model.getValue()).toBe('a\nX\nc');
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      mountedEditor.current = null;
    }
  });

  it('leaves the text alone when the new content is what the user typed', async () => {
    const { model, editor } = fakeEditorWithModel('a');
    mountedEditor.current = editor;
    const onChange = vi.fn();
    try {
      const view = render(
        <EditorPane
          filePath="demo.ts"
          fileContent="a"
          loading={false}
          error={null}
          onChange={onChange}
        />
      );
      await waitFor(() => expect(mountedEditor.onChange).toBeDefined());

      mountedEditor.onChange?.('ab');
      expect(onChange).toHaveBeenCalledWith('ab');
      view.rerender(
        <EditorPane
          filePath="demo.ts"
          fileContent="ab"
          loading={false}
          error={null}
          onChange={onChange}
        />
      );

      expect(model.pushEditOperations).not.toHaveBeenCalled();
    } finally {
      mountedEditor.current = null;
    }
  });

  it('shows a file put back to the text last typed', async () => {
    const { model, editor, type } = fakeEditorWithModel('a');
    mountedEditor.current = editor;
    const pane = (fileContent: string) => (
      <EditorPane
        filePath="demo.ts"
        fileContent={fileContent}
        loading={false}
        error={null}
        onChange={() => {}}
      />
    );
    try {
      const view = render(pane('a'));
      await waitFor(() => expect(mountedEditor.onChange).toBeDefined());

      type('ab');
      view.rerender(pane('ab'));
      // An agent edits the saved file, then undoes its edit.
      view.rerender(pane('ab\nagent'));
      view.rerender(pane('ab'));

      expect(model.getValue()).toBe('ab');
    } finally {
      mountedEditor.current = null;
    }
  });

  it('takes the line endings of a file rewritten with other ones', async () => {
    const { model, editor } = fakeEditorWithModel('a\r\nb');
    mountedEditor.current = editor;
    const onChange = vi.fn();
    const pane = (fileContent: string) => (
      <EditorPane
        filePath="demo.ts"
        fileContent={fileContent}
        loading={false}
        error={null}
        onChange={onChange}
      />
    );
    try {
      const view = render(pane('a\r\nb'));
      await waitFor(() => expect(mountedEditor.onChange).toBeDefined());

      view.rerender(pane('a\nb'));

      expect(model.getValue()).toBe('a\nb');
      expect(model.pushEOL).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      mountedEditor.current = null;
    }
  });

  it('fills an editor that mounted empty while the file was unreadable, not as an undo step', async () => {
    mountedEditor.current = fakeEditorWithModel('old').editor;
    const onChange = vi.fn();
    const pane = (fileContent: string | null, error: string | null) => (
      <EditorPane
        filePath="demo.ts"
        fileContent={fileContent}
        loading={false}
        error={error}
        onChange={onChange}
      />
    );
    try {
      const view = render(pane('old', null));
      await waitFor(() => expect(mountedEditor.onChange).toBeDefined());
      view.rerender(pane(null, 'EBUSY: resource busy or locked'));
      // Rereading clears the error before the text arrives, so a new editor mounts empty.
      const remounted = fakeEditorWithModel('');
      mountedEditor.current = remounted.editor;
      view.rerender(pane(null, null));

      view.rerender(pane('new', null));

      expect(remounted.model.setValue).toHaveBeenCalledWith('new');
      expect(remounted.model.pushEditOperations).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      mountedEditor.current = null;
    }
  });
});
