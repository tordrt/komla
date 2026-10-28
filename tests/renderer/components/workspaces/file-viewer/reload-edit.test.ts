import { describe, expect, it } from 'vitest';

import {
  computeReloadEdit,
  detectEndOfLine,
} from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-utils';

/** A stand-in for a Monaco text model holding `text`, with Monaco's 1-based lines and columns. */
function textModel(text: string, eol = '\n') {
  const lines = text.split(eol);
  return {
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1],
    getLineMaxColumn: (lineNumber: number) => lines[lineNumber - 1].length + 1,
    getEOL: () => eol,
    offsetAt: (lineNumber: number, column: number) =>
      lines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + eol.length, 0) +
      column -
      1,
  };
}

function applyReload(text: string, next: string, eol = '\n') {
  const model = textModel(text, eol);
  const edit = computeReloadEdit(model, next);
  if (!edit) return { result: text, edit };
  const start = model.offsetAt(edit.range.startLineNumber, edit.range.startColumn);
  const end = model.offsetAt(edit.range.endLineNumber, edit.range.endColumn);
  return { result: text.slice(0, start) + edit.text + text.slice(end), edit };
}

describe('computeReloadEdit', () => {
  it('returns null when the text is unchanged', () => {
    expect(computeReloadEdit(textModel('a\nb\nc'), 'a\nb\nc')).toBeNull();
  });

  it('replaces only the lines between the unchanged head and tail', () => {
    const { result, edit } = applyReload('a\nb\nc\nd\ne', 'a\nb\nX\nY\nd\ne');
    expect(result).toBe('a\nb\nX\nY\nd\ne');
    expect(edit?.range).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    });
  });

  it.each([
    ['an insertion', 'a\nb\nc', 'a\nb\nnew\nc'],
    ['a deletion', 'a\nb\nc\nd', 'a\nd'],
    ['an appended tail', 'a\nb', 'a\nb\nc\nd'],
    ['a truncated tail', 'a\nb\nc\nd', 'a\nb'],
    ['a new head', 'b\nc', 'a\nb\nc'],
    ['a rewrite', 'a\nb', 'x\ny\nz'],
    ['an emptied file', 'a\nb', ''],
    ['a filled empty file', '', 'a\nb\n'],
    ['a trailing newline added', 'a\nb', 'a\nb\n'],
    ['a trailing newline removed', 'a\nb\n', 'a\nb'],
    ['a change inside one line', 'const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;'],
  ])('reproduces %s exactly', (_label, text, next) => {
    expect(applyReload(text, next).result).toBe(next);
  });

  it('writes new lines with the model end of line', () => {
    expect(applyReload('a\r\nb\r\nc', 'a\nX\nY\nc', '\r\n').result).toBe('a\r\nX\r\nY\r\nc');
  });

  it('writes new lines with the end of line it is given', () => {
    expect(computeReloadEdit(textModel('a\nb'), 'a\r\nX\r\nb', '\r\n')?.text).toBe('X\r\n');
  });

  it('ignores a byte order mark, which Monaco leaves out of the model', () => {
    expect(computeReloadEdit(textModel('abc\nd'), '\uFEFFabc\nd')).toBeNull();
    expect(applyReload('abc\nd', '\uFEFFabc\nX').result).toBe('abc\nX');
  });
});

describe('detectEndOfLine', () => {
  it.each([
    ['LF', 'a\nb\n', '\n'],
    ['CRLF', 'a\r\nb\r\n', '\r\n'],
    ['mostly CRLF', 'a\r\nb\r\nc\n', '\r\n'],
    ['mostly LF', 'a\nb\nc\r\n', '\n'],
    ['as many of each, as LF', 'a\r\nb\n', '\n'],
    ['no line break', 'abc', null],
  ])('reads %s as Monaco does', (_label, text, eol) => {
    expect(detectEndOfLine(text)).toBe(eol);
  });
});
