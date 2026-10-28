import { describe, expect, it } from 'vitest';

import {
  getNextChangeAction,
  getPrevChangeAction,
} from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-utils';

const files = ['a.ts', 'b.ts', 'c.ts'];

describe('getNextChangeAction', () => {
  it('navigates to next change within the same file', () => {
    const result = getNextChangeAction(0, 3, files, 'a.ts');
    expect(result).toEqual({ type: 'navigate', index: 1 });
  });

  it('navigates from middle to next change', () => {
    const result = getNextChangeAction(1, 5, files, 'b.ts');
    expect(result).toEqual({ type: 'navigate', index: 2 });
  });

  it('switches to next file when at last change', () => {
    const result = getNextChangeAction(2, 3, files, 'a.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'b.ts', target: 'first' });
  });

  it('wraps to first file when at last change of last file', () => {
    const result = getNextChangeAction(4, 5, files, 'c.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'a.ts', target: 'first' });
  });

  it('switches to next file when current file has no changes', () => {
    const result = getNextChangeAction(-1, 0, files, 'b.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'c.ts', target: 'first' });
  });

  it('returns null when no changes and no file keys', () => {
    const result = getNextChangeAction(-1, 0, [], null);
    expect(result).toBeNull();
  });

  it('returns null when at last change with no cross-file navigation', () => {
    const result = getNextChangeAction(2, 3, [], 'a.ts');
    expect(result).toBeNull();
  });

  it('switches to first file when selectedFile is not in the list', () => {
    const result = getNextChangeAction(2, 3, files, 'unknown.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'a.ts', target: 'first' });
  });

  it('switches to first file when selectedFile is null', () => {
    const result = getNextChangeAction(-1, 0, files, null);
    expect(result).toEqual({ type: 'switchFile', fileKey: 'a.ts', target: 'first' });
  });

  it('navigates to index 0 when currentIndex is -1 and file has changes', () => {
    const result = getNextChangeAction(-1, 3, files, 'a.ts');
    expect(result).toEqual({ type: 'navigate', index: 0 });
  });
});

describe('getPrevChangeAction', () => {
  it('navigates to previous change within the same file', () => {
    const result = getPrevChangeAction(2, 3, files, 'a.ts');
    expect(result).toEqual({ type: 'navigate', index: 1 });
  });

  it('switches to previous file when at first change', () => {
    const result = getPrevChangeAction(0, 3, files, 'b.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'a.ts', target: 'last' });
  });

  it('wraps to last file when at first change of first file', () => {
    const result = getPrevChangeAction(0, 3, files, 'a.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'c.ts', target: 'last' });
  });

  it('switches to previous file when current file has no changes', () => {
    const result = getPrevChangeAction(-1, 0, files, 'b.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'a.ts', target: 'last' });
  });

  it('returns null when no changes and no file keys', () => {
    const result = getPrevChangeAction(-1, 0, [], null);
    expect(result).toBeNull();
  });

  it('returns null when at first change with no cross-file navigation', () => {
    const result = getPrevChangeAction(0, 3, [], 'a.ts');
    expect(result).toBeNull();
  });

  it('wraps to last file when selectedFile is not in the list', () => {
    const result = getPrevChangeAction(0, 3, files, 'unknown.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'c.ts', target: 'last' });
  });

  it('wraps to last file when selectedFile is null', () => {
    const result = getPrevChangeAction(-1, 0, files, null);
    expect(result).toEqual({ type: 'switchFile', fileKey: 'c.ts', target: 'last' });
  });

  it('switches file when currentIndex is -1 even with changes present', () => {
    // currentIndex -1 means we just switched to this file, going prev should go to previous file
    const result = getPrevChangeAction(-1, 3, files, 'b.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'a.ts', target: 'last' });
  });
});

describe('single file list edge cases', () => {
  const singleFile = ['only.ts'];

  it('next wraps to same file when only one file', () => {
    const result = getNextChangeAction(2, 3, singleFile, 'only.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'only.ts', target: 'first' });
  });

  it('prev wraps to same file when only one file', () => {
    const result = getPrevChangeAction(0, 3, singleFile, 'only.ts');
    expect(result).toEqual({ type: 'switchFile', fileKey: 'only.ts', target: 'last' });
  });
});
