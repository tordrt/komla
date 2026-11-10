import { describe, expect, it } from 'vitest';

import {
  decideDiskReconcile,
  editorBufferFields,
  editorBufferReducer,
  INITIAL_EDITOR_BUFFER,
  type BufferContent,
  type EditorBufferEvent,
  type EditorBufferState,
} from '../../../../../src/renderer/components/workspaces/file-viewer/editor-buffer';

function run(...events: EditorBufferEvent[]): EditorBufferState {
  return events.reduce(editorBufferReducer, INITIAL_EDITOR_BUFFER);
}

const text = (value: string): BufferContent => ({ kind: 'text', text: value, savedText: value });

function openText(path: string, value: string, readId = 1): EditorBufferEvent[] {
  return [
    { type: 'open', readId, filePath: path },
    { type: 'read', readId, result: { kind: 'loaded', content: text(value) } },
  ];
}

describe('editorBufferReducer reads', () => {
  it('drops the result of a read a newer one replaced', () => {
    const state = run(
      { type: 'open', readId: 1, filePath: 'a.ts' },
      { type: 'open', readId: 2, filePath: 'b.ts' },
      { type: 'read', readId: 1, result: { kind: 'loaded', content: text('a') } }
    );

    expect(state.view).toEqual({ status: 'loading', filePath: 'b.ts' });
  });

  it('drops a read that finishes after a reset', () => {
    const state = run(
      { type: 'open', readId: 1, filePath: 'a.ts' },
      { type: 'reset', readId: 2 },
      { type: 'read', readId: 1, result: { kind: 'loaded', content: text('a') } }
    );

    expect(state.view).toEqual({ status: 'empty' });
  });

  it('ignores a reload asked for a file no longer shown', () => {
    const before = run(...openText('b.ts', 'b'));

    expect(editorBufferReducer(before, { type: 'reload', readId: 2, filePath: 'a.ts' })).toBe(
      before
    );
  });

  it('shows exactly one kind of content at a time', () => {
    const image = run(
      { type: 'open', readId: 1, filePath: 'logo.png' },
      {
        type: 'read',
        readId: 1,
        result: { kind: 'loaded', content: { kind: 'image', data: 'x', mimeType: 'image/png' } },
      }
    );
    const fields = editorBufferFields(image);

    expect(fields).toMatchObject({ isImage: true, isMedia: false, fileContent: null });
    expect(fields.loadingFile && fields.error !== null).toBe(false);
  });

  it('keeps edits typed during a reread and calls it a conflict', () => {
    const state = run(
      ...openText('a.ts', 'v1'),
      { type: 'reload', readId: 2, filePath: 'a.ts' },
      { type: 'edit', text: 'typed' },
      { type: 'set-dirty', dirty: true },
      { type: 'read', readId: 2, result: { kind: 'loaded', content: text('v2') } }
    );

    expect(state.edits).toBe('conflict');
    expect(editorBufferFields(state).fileContent).toBe('typed');
  });

  it('takes the disk text over edits the user asked to reload, ending the conflict at once', () => {
    const conflicted = run(
      ...openText('a.ts', 'v1'),
      { type: 'edit', text: 'typed' },
      { type: 'set-dirty', dirty: true },
      { type: 'external-change', changed: true }
    );
    const reloading = editorBufferReducer(conflicted, {
      type: 'reload',
      readId: 2,
      filePath: 'a.ts',
    });
    expect(reloading.edits).toBe('dirty');

    const reloaded = editorBufferReducer(reloading, {
      type: 'read',
      readId: 2,
      result: { kind: 'loaded', content: text('v2') },
    });
    expect(reloaded.edits).toBe('clean');
    expect(editorBufferFields(reloaded)).toMatchObject({ fileContent: 'v2', diskContent: 'v2' });
  });

  it('drops the edits the user asked to reload even when the reread fails', () => {
    const state = run(
      ...openText('a.ts', 'v1'),
      { type: 'edit', text: 'mine' },
      { type: 'set-dirty', dirty: true },
      { type: 'external-change', changed: true },
      { type: 'reload', readId: 2, filePath: 'a.ts' },
      { type: 'read', readId: 2, result: { kind: 'missing' } }
    );

    expect(state.edits).toBe('clean');
    expect(editorBufferFields(state).missingOnDisk).toBe(true);
  });

  it('keeps edits typed during a reread that fails', () => {
    const state = run(
      ...openText('a.ts', 'v1'),
      { type: 'reload', readId: 2, filePath: 'a.ts' },
      { type: 'set-dirty', dirty: true },
      { type: 'read', readId: 2, result: { kind: 'missing' } }
    );

    expect(state.edits).toBe('dirty');
    expect(editorBufferFields(state).missingOnDisk).toBe(true);
  });
});

describe('editorBufferReducer edits', () => {
  it('has no conflict without unsaved edits', () => {
    const state = run(...openText('a.ts', 'v1'), { type: 'external-change', changed: true });

    expect(state.edits).toBe('clean');
  });

  it('keeps a conflict while more is typed, until the edits are kept', () => {
    const conflicted = run(
      ...openText('a.ts', 'v1'),
      { type: 'set-dirty', dirty: true },
      { type: 'external-change', changed: true },
      { type: 'set-dirty', dirty: true }
    );
    expect(conflicted.edits).toBe('conflict');

    expect(editorBufferReducer(conflicted, { type: 'external-change', changed: false }).edits).toBe(
      'dirty'
    );
  });

  it('ends a conflict when the edits are saved over the disk', () => {
    const state = run(
      ...openText('a.ts', 'v1'),
      { type: 'edit', text: 'mine' },
      { type: 'set-dirty', dirty: true },
      { type: 'external-change', changed: true },
      { type: 'disk-presence', missing: true },
      { type: 'saved', text: 'mine', stillDirty: false }
    );

    expect(state.edits).toBe('clean');
    expect(editorBufferFields(state)).toMatchObject({
      diskContent: 'mine',
      missingOnDisk: false,
      hasExternalChange: false,
    });
  });

  it('stays dirty after a save when the user typed on while it wrote', () => {
    const state = run(
      ...openText('a.ts', 'v1'),
      { type: 'set-dirty', dirty: true },
      { type: 'saved', text: 'v2', stillDirty: true }
    );

    expect(state.edits).toBe('dirty');
  });

  it('keeps edits to a file gone from disk, which a save writes back', () => {
    const restored = run(
      { type: 'open', readId: 1, filePath: 'a.ts' },
      { type: 'read', readId: 1, result: { kind: 'missing' } },
      { type: 'edit', text: 'draft' },
      { type: 'set-dirty', dirty: true }
    );
    expect(editorBufferFields(restored)).toMatchObject({
      fileContent: 'draft',
      diskContent: null,
      missingOnDisk: true,
      isDirty: true,
    });

    const saved = editorBufferReducer(restored, {
      type: 'saved',
      text: 'draft',
      stillDirty: false,
    });
    expect(editorBufferFields(saved)).toMatchObject({
      diskContent: 'draft',
      missingOnDisk: false,
      isDirty: false,
    });
  });

  it('keeps edits restored over a file that could not be read, for a save to write', () => {
    const state = run(
      { type: 'open', readId: 1, filePath: 'a.ts' },
      { type: 'read', readId: 1, result: { kind: 'error', message: 'EACCES' } },
      { type: 'edit', text: 'draft' },
      { type: 'set-dirty', dirty: true }
    );

    expect(editorBufferFields(state)).toMatchObject({ fileContent: 'draft', isDirty: true });
  });

  it('counts a diff editor as dirty with no file loaded', () => {
    expect(run({ type: 'set-dirty', dirty: true }).edits).toBe('dirty');
  });
});

describe('editorBufferReducer media previews', () => {
  const media: BufferContent = {
    kind: 'media',
    mimeType: 'video/mp4',
    mediaKind: 'video',
    size: 1,
    diskToken: '1:1',
    preview: { status: 'idle' },
  };
  const openMedia: EditorBufferEvent[] = [
    { type: 'open', readId: 1, filePath: 'clip.mp4' },
    { type: 'read', readId: 1, result: { kind: 'loaded', content: media } },
  ];

  it('drops a preview the reread of its file outdated', () => {
    const state = run(
      ...openMedia,
      { type: 'media-preview-start', readId: 1 },
      { type: 'reload', readId: 2, filePath: 'clip.mp4' },
      { type: 'read', readId: 2, result: { kind: 'loaded', content: media } },
      {
        type: 'media-preview-read',
        readId: 1,
        result: { ok: true, data: 'old', mimeType: 'video/mp4', kind: 'video' },
      }
    );

    expect(editorBufferFields(state)).toMatchObject({
      mediaData: null,
      mediaPreviewLoading: false,
    });
  });

  it('shows a preview with the type it was read as', () => {
    const state = run(
      ...openMedia,
      { type: 'media-preview-start', readId: 1 },
      {
        type: 'media-preview-read',
        readId: 1,
        result: { ok: true, data: 'd', mimeType: 'video/webm', kind: 'video' },
      }
    );

    expect(editorBufferFields(state)).toMatchObject({
      mediaData: 'd',
      mediaMimeType: 'video/webm',
      mediaPreviewLoading: false,
    });
  });
});

describe('decideDiskReconcile', () => {
  const clean = { diskVersion: 'v1', dirty: false };
  const dirty = { diskVersion: 'v1', dirty: true };

  it('leaves a buffer the disk agrees with', () => {
    expect(decideDiskReconcile(clean, { kind: 'version', version: 'v1' })).toEqual({
      missingOnDisk: false,
      action: 'none',
    });
    expect(decideDiskReconcile(dirty, { kind: 'version', version: 'v1' })).toEqual({
      missingOnDisk: false,
      action: 'none',
    });
  });

  it('reloads a clean buffer and flags unsaved edits when the disk changed', () => {
    expect(decideDiskReconcile(clean, { kind: 'version', version: 'v2' }).action).toBe('reload');
    expect(decideDiskReconcile(dirty, { kind: 'version', version: 'v2' }).action).toBe('conflict');
  });

  it('marks a deleted file missing, flagging unsaved edits to it', () => {
    expect(decideDiskReconcile(clean, { kind: 'missing' })).toEqual({
      missingOnDisk: true,
      action: 'none',
    });
    expect(decideDiskReconcile(dirty, { kind: 'missing' }).action).toBe('conflict');
  });

  it('keeps what it knows when the file is unreadable', () => {
    expect(decideDiskReconcile(clean, { kind: 'unreadable' })).toEqual({ action: 'none' });
    expect(decideDiskReconcile(dirty, { kind: 'unreadable' })).toEqual({ action: 'conflict' });
  });

  it('reloads a file with no version to compare', () => {
    expect(decideDiskReconcile(dirty, { kind: 'unversioned' })).toEqual({ action: 'reload' });
  });
});
