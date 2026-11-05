import type * as monacoEditor from 'monaco-editor';
import { describe, expect, it } from 'vitest';

import { formatFileReference } from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-utils';

function editorWith(selection: { start: number; end: number } | null, mounted = true) {
  return {
    getModel: () => (mounted ? {} : null),
    getSelection: () =>
      selection && {
        startLineNumber: selection.start,
        endLineNumber: selection.end,
        isEmpty: () => false,
      },
  } as unknown as monacoEditor.ICodeEditor;
}

describe('formatFileReference', () => {
  it('refers to the lines selected in a mounted editor', () => {
    expect(formatFileReference('src/a.ts', editorWith({ start: 3, end: 5 }))).toBe('@src/a.ts:3-5');
    expect(formatFileReference('src/a.ts', editorWith({ start: 3, end: 5 }, false))).toBe(
      '@src/a.ts'
    );
    expect(formatFileReference('src/a.ts', null)).toBe('@src/a.ts');
  });

  it('drops control characters, which a shell would run a newline of', () => {
    expect(formatFileReference('src/a\nrm -rf ~\t.ts', null)).toBe('@src/arm -rf ~.ts');
  });
});
