import { describe, expect, it } from 'vitest';

import {
  buildDiffEditorKey,
  hasSelectedText,
  hasContentChanged,
} from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-utils';

// ============================================================================
// hasContentChanged
// ============================================================================

describe('hasContentChanged', () => {
  it('returns true when prev is null (first render)', () => {
    expect(hasContentChanged(null, 'old', 'new')).toBe(true);
  });

  it('returns false when content is identical', () => {
    const prev = { old: 'old', new: 'new' };
    expect(hasContentChanged(prev, 'old', 'new')).toBe(false);
  });

  it('returns true when old content changed', () => {
    const prev = { old: 'old', new: 'new' };
    expect(hasContentChanged(prev, 'old-v2', 'new')).toBe(true);
  });

  it('returns true when new content changed', () => {
    const prev = { old: 'old', new: 'new' };
    expect(hasContentChanged(prev, 'old', 'new-v2')).toBe(true);
  });

  it('returns true when both changed', () => {
    const prev = { old: 'old', new: 'new' };
    expect(hasContentChanged(prev, 'old-v2', 'new-v2')).toBe(true);
  });

  it('returns true with empty strings vs non-empty', () => {
    const prev = { old: '', new: '' };
    expect(hasContentChanged(prev, 'content', '')).toBe(true);
  });

  it('returns false with both empty strings', () => {
    const prev = { old: '', new: '' };
    expect(hasContentChanged(prev, '', '')).toBe(false);
  });
});

// ============================================================================
// buildDiffEditorKey
// ============================================================================

const baseParams = {
  selectedFile: 'src/index.ts' as string | null,
  filePath: 'src/fallback.ts',
  viewMode: 'split' as const,
  hideUnchangedRegions: false,
  contentVersion: 1,
};

describe('buildDiffEditorKey', () => {
  it('uses selectedFile when provided', () => {
    const key = buildDiffEditorKey(baseParams);
    expect(key).toBe('src/index.ts:split:show:v1');
  });

  it('falls back to filePath when selectedFile is null', () => {
    const key = buildDiffEditorKey({ ...baseParams, selectedFile: null });
    expect(key).toBe('src/fallback.ts:split:show:v1');
  });

  it('includes viewMode', () => {
    const key = buildDiffEditorKey({ ...baseParams, viewMode: 'unified' });
    expect(key).toBe('src/index.ts:unified:show:v1');
  });

  it('includes hideUnchangedRegions as hide/show', () => {
    const key = buildDiffEditorKey({ ...baseParams, hideUnchangedRegions: true });
    expect(key).toBe('src/index.ts:split:hide:v1');
  });

  it('includes content version when not dirty', () => {
    const key = buildDiffEditorKey({ ...baseParams, contentVersion: 42 });
    expect(key).toBe('src/index.ts:split:show:v42');
  });

  it('produces different keys for different content versions (forces remount)', () => {
    const key1 = buildDiffEditorKey({ ...baseParams, contentVersion: 1 });
    const key2 = buildDiffEditorKey({ ...baseParams, contentVersion: 2 });
    expect(key1).not.toBe(key2);
  });
});

// ============================================================================
// hasSelectedText
// ============================================================================

describe('hasSelectedText', () => {
  it('returns false when editor is null', () => {
    expect(hasSelectedText(null)).toBe(false);
  });

  it('returns false when selection is empty', () => {
    const editor = {
      getSelection: () => ({
        isEmpty: () => true,
      }),
    } as any;

    expect(hasSelectedText(editor)).toBe(false);
  });

  it('returns true when selection is non-empty', () => {
    const editor = {
      getSelection: () => ({
        isEmpty: () => false,
      }),
    } as any;

    expect(hasSelectedText(editor)).toBe(true);
  });
});

// ============================================================================
// Content version tracking integration
// ============================================================================

describe('content version tracking (simulated render cycle)', () => {
  /**
   * Simulates the ref-based content-version tracking logic from DiffPane
   * across a sequence of renders. Returns the content version after each render.
   */
  function simulateRenders(renders: Array<{ old: string; new: string }>): number[] {
    let version = 0;
    let prev: { old: string; new: string } | null = null;
    const versions: number[] = [];

    for (const { old: oldContent, new: newContent } of renders) {
      if (hasContentChanged(prev, oldContent, newContent)) {
        prev = { old: oldContent, new: newContent };
        version++;
      }
      versions.push(version);
    }

    return versions;
  }

  it('bumps version on first render', () => {
    const versions = simulateRenders([{ old: 'a', new: 'b' }]);
    expect(versions).toEqual([1]);
  });

  it('does not bump on re-render with same content', () => {
    const versions = simulateRenders([
      { old: 'a', new: 'b' },
      { old: 'a', new: 'b' },
      { old: 'a', new: 'b' },
    ]);
    expect(versions).toEqual([1, 1, 1]);
  });

  it('bumps when content changes', () => {
    const versions = simulateRenders([
      { old: 'a', new: 'b' },
      { old: 'a', new: 'b' }, // same
      { old: 'a', new: 'c' }, // new content changed
      { old: 'a', new: 'c' }, // same
    ]);
    expect(versions).toEqual([1, 1, 2, 2]);
  });

  it('bumps on every content change', () => {
    const versions = simulateRenders([
      { old: 'a', new: 'b' },
      { old: 'c', new: 'd' },
      { old: 'e', new: 'f' },
    ]);
    expect(versions).toEqual([1, 2, 3]);
  });

  it('bumps when content reverts to original', () => {
    const versions = simulateRenders([
      { old: 'a', new: 'b' },
      { old: 'c', new: 'd' }, // change
      { old: 'a', new: 'b' }, // revert to original
    ]);
    expect(versions).toEqual([1, 2, 3]);
  });

  it('produces distinct keys when content version changes', () => {
    const renders = [
      { old: 'a', new: 'b' },
      { old: 'a', new: 'c' }, // content changes
    ];
    const versions = simulateRenders(renders);

    // Not dirty: keys differ because version bumped
    const keyNotDirty1 = buildDiffEditorKey({
      ...baseParams,
      contentVersion: versions[0],
    });
    const keyNotDirty2 = buildDiffEditorKey({
      ...baseParams,
      contentVersion: versions[1],
    });
    expect(keyNotDirty1).not.toBe(keyNotDirty2);
  });
});
