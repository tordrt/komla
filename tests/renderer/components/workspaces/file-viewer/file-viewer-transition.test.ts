import { describe, expect, it } from 'vitest';

import {
  decideFileViewerTransition,
  describeFileViewerTransition,
  type FileViewerTransition,
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
