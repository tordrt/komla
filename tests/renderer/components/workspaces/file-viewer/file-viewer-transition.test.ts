import { describe, expect, it } from 'vitest';

import {
  decideFileViewerTransition,
  decideInlinePreviewTransition,
  describeFileViewerTransition,
  describeInlinePreviewTransition,
  type FileViewerTransition,
  type InlinePreviewTransition,
} from '../../../../../src/renderer/lib/file-viewer-transition';

const cleanBrowse = { dirty: false, mode: 'browse' as const, diffSubMode: 'changes' as const };
const dirtyBrowse = { ...cleanBrowse, dirty: true, currentFilePath: 'src/current.ts' };

describe('file viewer transitions', () => {
  it('applies every intent immediately when the active editor is clean', () => {
    const transition: FileViewerTransition = { kind: 'close' };
    expect(decideFileViewerTransition(transition, cleanBrowse)).toEqual({
      kind: 'apply',
      transition,
    });
  });

  it('requests confirmation before a dirty mode change', () => {
    const transition: FileViewerTransition = { kind: 'mode', mode: 'diff' };
    expect(decideFileViewerTransition(transition, dirtyBrowse)).toEqual({
      kind: 'confirm',
      transition,
    });
  });

  it('applies an idempotent mode intent without prompting', () => {
    const transition: FileViewerTransition = { kind: 'mode', mode: 'browse' };
    expect(decideFileViewerTransition(transition, dirtyBrowse).kind).toBe('apply');
  });

  it('requests confirmation for a dirty diff sub-mode change', () => {
    const transition: FileViewerTransition = {
      kind: 'mode',
      mode: 'diff',
      diffSubMode: 'history',
    };
    expect(
      decideFileViewerTransition(transition, {
        dirty: true,
        mode: 'diff',
        diffSubMode: 'changes',
      }).kind
    ).toBe('confirm');
  });

  it('requests confirmation before file, close, and inline-preview intents', () => {
    const transitions: FileViewerTransition[] = [
      { kind: 'file', filePath: 'src/next.ts', browseAction: 'preview' },
      { kind: 'close' },
      { kind: 'inline-preview', filePath: 'src/next.ts' },
    ];
    expect(
      transitions.map((intent) => decideFileViewerTransition(intent, dirtyBrowse).kind)
    ).toEqual(['confirm', 'confirm', 'confirm']);
  });

  it('describes confirmation actions from the single intent', () => {
    expect(describeFileViewerTransition({ kind: 'inline-preview', filePath: 'x' })).toBe(
      'switch to the inline preview'
    );
    expect(describeFileViewerTransition({ kind: 'mode', mode: 'diff' })).toBe('switch view mode');
    expect(
      describeFileViewerTransition({ kind: 'file', filePath: 'x', browseAction: 'close-tab' })
    ).toBe('close this tab');
    expect(describeFileViewerTransition({ kind: 'file', filePath: 'x', browseAction: null })).toBe(
      'switch files'
    );
  });
});

describe('file panel preview transitions', () => {
  const closed = { open: false, dirty: false, filePath: null, mode: 'browse' as const };
  const clean = { open: true, dirty: false, filePath: 'a.ts', mode: 'browse' as const };
  const dirty = { ...clean, dirty: true };
  const toB: InlinePreviewTransition = { kind: 'file', mode: 'browse', filePath: 'b.ts' };

  it('opens a file or switches mode when nothing is open, and has nothing to close', () => {
    expect(decideInlinePreviewTransition(toB, closed)).toBe('apply');
    expect(decideInlinePreviewTransition({ kind: 'mode', mode: 'diff' }, closed)).toBe('apply');
    expect(decideInlinePreviewTransition({ kind: 'close' }, closed)).toBe('ignore');
  });

  it('applies everything while the edits are saved', () => {
    expect(decideInlinePreviewTransition(toB, clean)).toBe('apply');
    expect(decideInlinePreviewTransition({ kind: 'mode', mode: 'diff' }, clean)).toBe('apply');
    expect(decideInlinePreviewTransition({ kind: 'close' }, clean)).toBe('apply');
  });

  it('asks before anything that would drop unsaved edits', () => {
    expect(decideInlinePreviewTransition(toB, dirty)).toBe('confirm');
    expect(
      decideInlinePreviewTransition({ kind: 'file', mode: 'diff', filePath: 'a.ts' }, dirty)
    ).toBe('confirm');
    expect(decideInlinePreviewTransition({ kind: 'mode', mode: 'diff' }, dirty)).toBe('confirm');
    expect(decideInlinePreviewTransition({ kind: 'close' }, dirty)).toBe('confirm');
  });

  it('applies what keeps the same file in the same mode', () => {
    expect(
      decideInlinePreviewTransition({ kind: 'file', mode: 'browse', filePath: 'a.ts' }, dirty)
    ).toBe('apply');
    expect(decideInlinePreviewTransition({ kind: 'mode', mode: 'browse' }, dirty)).toBe('apply');
  });

  it('names each transition for the prompt', () => {
    expect(describeInlinePreviewTransition(toB)).toBe('switch files');
    expect(describeInlinePreviewTransition({ kind: 'mode', mode: 'diff' })).toBe(
      'switch view mode'
    );
    expect(describeInlinePreviewTransition({ kind: 'close' })).toBe('close');
  });
});
