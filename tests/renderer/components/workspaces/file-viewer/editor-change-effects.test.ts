import { describe, expect, it } from 'vitest';

import {
  computeEditorChangeEffects,
  shouldNavigateAfterDeletion,
} from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-utils';
import type { FileViewerMode } from '../../../../../src/renderer/components/workspaces/file-viewer/types';

describe('computeEditorChangeEffects', () => {
  it('treats content matching the disk baseline as clean', () => {
    const result = computeEditorChangeEffects({
      content: 'const x = 1\n',
      diskContent: 'const x = 1\n',
      mode: 'browse',
      filePath: 'src/foo.ts',
      previewPath: 'src/foo.ts',
    });
    expect(result).toEqual({ isDirty: false, promotePreview: false });
  });

  it('flags real edits as dirty and promotes the matching preview tab', () => {
    const result = computeEditorChangeEffects({
      content: 'const x = 2\n',
      diskContent: 'const x = 1\n',
      mode: 'browse',
      filePath: 'src/foo.ts',
      previewPath: 'src/foo.ts',
    });
    expect(result).toEqual({ isDirty: true, promotePreview: true });
  });

  it('marks content dirty when disk baseline has not loaded yet', () => {
    const result = computeEditorChangeEffects({
      content: '',
      diskContent: null,
      mode: 'browse',
      filePath: 'src/foo.ts',
      previewPath: null,
    });
    expect(result.isDirty).toBe(true);
    expect(result.promotePreview).toBe(false);
  });

  it('does not promote when the preview tab is a different file', () => {
    const result = computeEditorChangeEffects({
      content: 'edited',
      diskContent: 'original',
      mode: 'browse',
      filePath: 'src/foo.ts',
      previewPath: 'src/bar.ts',
    });
    expect(result).toEqual({ isDirty: true, promotePreview: false });
  });

  it('does not promote when there is no preview tab', () => {
    const result = computeEditorChangeEffects({
      content: 'edited',
      diskContent: 'original',
      mode: 'browse',
      filePath: 'src/foo.ts',
      previewPath: null,
    });
    expect(result).toEqual({ isDirty: true, promotePreview: false });
  });

  it('does not promote in diff mode even when dirty', () => {
    const result = computeEditorChangeEffects({
      content: 'edited',
      diskContent: 'original',
      mode: 'diff',
      filePath: 'src/foo.ts',
      previewPath: 'src/foo.ts',
    });
    expect(result).toEqual({ isDirty: true, promotePreview: false });
  });

  it('does not promote when no file is open', () => {
    const result = computeEditorChangeEffects({
      content: 'edited',
      diskContent: 'original',
      mode: 'browse',
      filePath: null,
      previewPath: null,
    });
    expect(result).toEqual({ isDirty: true, promotePreview: false });
  });
});

describe('shouldNavigateAfterDeletion', () => {
  it('navigates only when the editor that is current at completion was deleted', () => {
    const currentViewer = () => ({ mode: 'browse' as FileViewerMode, workspaceId: 'workspace-a' });

    expect(
      shouldNavigateAfterDeletion(
        currentViewer,
        'workspace-a',
        'src/deleted.ts',
        'src/deleted.ts'
      )
    ).toBe(true);
    expect(
      shouldNavigateAfterDeletion(currentViewer, 'workspace-a', 'generated/output.ts', 'generated')
    ).toBe(true);
    expect(
      shouldNavigateAfterDeletion(
        currentViewer,
        'workspace-a',
        'src/edited-after-delete-started.ts',
        'src/deleted.ts'
      )
    ).toBe(false);
    expect(
      shouldNavigateAfterDeletion(currentViewer, 'workspace-a', null, 'src/deleted.ts')
    ).toBe(false);
  });

  it('keeps the diff viewer open when a background browse editor was deleted', () => {
    const currentViewer = () => ({ mode: 'diff' as FileViewerMode, workspaceId: 'workspace-a' });

    expect(
      shouldNavigateAfterDeletion(
        currentViewer,
        'workspace-a',
        'src/deleted.ts',
        'src/deleted.ts'
      )
    ).toBe(false);
    expect(
      shouldNavigateAfterDeletion(currentViewer, 'workspace-a', 'generated/output.ts', 'generated')
    ).toBe(false);
  });

  it('uses the viewer mode current when deletion completes', () => {
    let mode: FileViewerMode = 'browse';
    const currentViewer = () => ({ mode, workspaceId: 'workspace-a' });
    mode = 'diff';

    expect(
      shouldNavigateAfterDeletion(
        currentViewer,
        'workspace-a',
        'src/deleted.ts',
        'src/deleted.ts'
      )
    ).toBe(false);
  });

  it('does not navigate a viewer opened for another workspace while deletion was pending', () => {
    expect(
      shouldNavigateAfterDeletion(
        () => ({ mode: 'browse', workspaceId: 'workspace-b' }),
        'workspace-a',
        'src/deleted.ts',
        'src/deleted.ts'
      )
    ).toBe(false);
  });
});
