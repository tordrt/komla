import { isBrowserPreviewableFile, isUnsupportedBinaryFile } from '../../../../shared/image-utils';

/**
 * The file a file viewer, the file panel's preview or a file pane shows, as one state machine:
 *
 *   empty -> loading -> loaded (text | image | media | binary) | missing | error
 *
 * and for its edits: clean -> dirty -> conflict (the disk changed under them) -> clean, once the
 * edits are saved over the disk's version or reloaded from it. `editorBufferReducer` is the only
 * writer. Each read of the file has an id, and only the latest read's result applies, so a read
 * that finishes late is dropped here rather than by checks around every await.
 */

export type MediaKind = 'audio' | 'video';

/** A video or audio file's playable data, read only once the user asks for it. */
export type MediaPreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: string; mimeType: string; kind: MediaKind }
  | { status: 'error'; message: string };

/** What a read found. Only text can be edited; the others show from what they were read as. */
export type BufferContent =
  /** `savedText` is the disk's text, or null for edits to a file gone from disk. */
  | { kind: 'text'; text: string; savedText: string | null }
  | { kind: 'image'; data: string; mimeType: string }
  | {
      kind: 'media';
      mimeType: string;
      mediaKind: MediaKind;
      size: number;
      diskToken: string;
      preview: MediaPreview;
    }
  /** A PDF or a file with no preview, known by its size and modification time. */
  | { kind: 'binary'; diskToken: string };

export type BufferView =
  | { status: 'empty' }
  | { status: 'loading'; filePath: string }
  /** `goneFromDisk`: a later look found the file deleted, though what was read still shows. */
  | { status: 'loaded'; filePath: string; content: BufferContent; goneFromDisk: boolean }
  | { status: 'missing'; filePath: string }
  | { status: 'error'; filePath: string; message: string };

/**
 * Whether there are unsaved edits, and whether the file changed on disk under them. A diff
 * editor's edits count too, so they don't need a file loaded here.
 */
export type BufferEdits = 'clean' | 'dirty' | 'conflict';

export type BufferRead =
  | { id: number; kind: 'open' }
  /** A reread of the shown file, which keeps showing it. */
  | { id: number; kind: 'reload'; startedDirty: boolean };

export interface EditorBufferState {
  /** The latest read; the result of any other is stale. */
  read: BufferRead;
  view: BufferView;
  edits: BufferEdits;
}

export type BufferReadResult =
  | { kind: 'loaded'; content: BufferContent }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export type MediaPreviewReadResult =
  | { ok: true; data: string; mimeType: string; kind: MediaKind }
  | { ok: false; message: string };

export type EditorBufferEvent =
  | { type: 'open'; readId: number; filePath: string }
  | { type: 'reload'; readId: number; filePath: string }
  | { type: 'read'; readId: number; result: BufferReadResult }
  | { type: 'reset'; readId: number }
  | { type: 'media-preview-start'; readId: number }
  | { type: 'media-preview-read'; readId: number; result: MediaPreviewReadResult }
  /** The user changed the text. */
  | { type: 'edit'; text: string }
  | { type: 'set-dirty'; dirty: boolean }
  /** The disk changed under the edits, or with false, the user kept them anyway. */
  | { type: 'external-change'; changed: boolean }
  | { type: 'disk-presence'; missing: boolean }
  /** `text` was written to disk; `stillDirty` if the user typed on while it was. */
  | { type: 'saved'; text: string; stillDirty: boolean };

export const INITIAL_EDITOR_BUFFER: EditorBufferState = {
  read: { id: 0, kind: 'open' },
  view: { status: 'empty' },
  edits: 'clean',
};

export function bufferFilePath(state: EditorBufferState): string | null {
  return state.view.status === 'empty' ? null : state.view.filePath;
}

function withEdits(state: EditorBufferState, edits: BufferEdits): EditorBufferState {
  return state.edits === edits ? state : { ...state, edits };
}

function withView(state: EditorBufferState, view: BufferView): EditorBufferState {
  return { ...state, view };
}

function applyRead(
  state: EditorBufferState,
  filePath: string,
  result: BufferReadResult
): EditorBufferState {
  const { read } = state;
  if (read.kind === 'reload' && result.kind === 'loaded') {
    if (result.content.kind === 'text' && !read.startedDirty && state.edits !== 'clean') {
      // The user typed while the file was reread: keep their edits and offer the reload.
      return withEdits(state, 'conflict');
    }
  }
  const view: BufferView =
    result.kind === 'loaded'
      ? { status: 'loaded', filePath, content: result.content, goneFromDisk: false }
      : result.kind === 'missing'
        ? { status: 'missing', filePath }
        : { status: 'error', filePath, message: result.message };
  // A reread that found the file replaces the edits, as does one the user asked for to drop them,
  // whose edits no longer show; edits typed during a failed reread stay.
  const replacesEdits = read.kind === 'reload' && (result.kind === 'loaded' || read.startedDirty);
  const edits = replacesEdits ? 'clean' : state.edits;
  return { ...state, view, edits };
}

function withMediaPreview(state: EditorBufferState, preview: MediaPreview): EditorBufferState {
  const { view } = state;
  if (view.status !== 'loaded' || view.content.kind !== 'media') return state;
  return withView(state, { ...view, content: { ...view.content, preview } });
}

function applyReload(
  state: EditorBufferState,
  readId: number,
  filePath: string
): EditorBufferState {
  // A reload asked for before another file opened is for a file no longer shown.
  if (bufferFilePath(state) !== filePath) return state;
  return {
    ...state,
    read: { id: readId, kind: 'reload', startedDirty: state.edits !== 'clean' },
    // Reloading answers a conflict: the disk's version replaces the edits.
    edits: state.edits === 'conflict' ? 'dirty' : state.edits,
  };
}

function mediaPreviewOf(result: MediaPreviewReadResult): MediaPreview {
  return result.ok
    ? { status: 'loaded', data: result.data, mimeType: result.mimeType, kind: result.kind }
    : { status: 'error', message: result.message };
}

function applyEdit(state: EditorBufferState, text: string): EditorBufferState {
  const { view } = state;
  if (view.status === 'loaded' && view.content.kind === 'text') {
    if (view.content.text === text) return state;
    return withView(state, { ...view, content: { ...view.content, text } });
  }
  // Edits kept for a file that's since gone or can't be read, as a file pane's after it remounts,
  // so they show and a save can write them.
  if (view.status === 'missing' || view.status === 'error') {
    return withView(state, {
      status: 'loaded',
      filePath: view.filePath,
      content: { kind: 'text', text, savedText: null },
      goneFromDisk: view.status === 'missing',
    });
  }
  return state;
}

/** Saving overwrites whatever changed on disk, so it ends a conflict too. */
function applySaved(
  state: EditorBufferState,
  text: string,
  stillDirty: boolean
): EditorBufferState {
  const { view } = state;
  const saved = withEdits(state, stillDirty ? 'dirty' : 'clean');
  if (view.status === 'loaded' && view.content.kind === 'text') {
    return withView(saved, {
      ...view,
      content: { ...view.content, savedText: text },
      goneFromDisk: false,
    });
  }
  if (view.status === 'missing') {
    return withView(saved, {
      status: 'loaded',
      filePath: view.filePath,
      content: { kind: 'text', text, savedText: text },
      goneFromDisk: false,
    });
  }
  return saved;
}

/** Edits flagged or unflagged: a conflict needs unsaved edits for the disk to change under. */
function nextEdits(edits: BufferEdits, event: EditorBufferEvent): BufferEdits {
  if (event.type === 'set-dirty') {
    if (!event.dirty) return 'clean';
    return edits === 'clean' ? 'dirty' : edits;
  }
  if (event.type === 'external-change') {
    if (event.changed) return edits === 'dirty' ? 'conflict' : edits;
    return edits === 'conflict' ? 'dirty' : edits;
  }
  return edits;
}

export function editorBufferReducer(
  state: EditorBufferState,
  event: EditorBufferEvent
): EditorBufferState {
  switch (event.type) {
    case 'open':
      return {
        read: { id: event.readId, kind: 'open' },
        view: { status: 'loading', filePath: event.filePath },
        edits: 'clean',
      };
    case 'reset':
      return {
        read: { id: event.readId, kind: 'open' },
        view: { status: 'empty' },
        edits: 'clean',
      };
    case 'reload':
      return applyReload(state, event.readId, event.filePath);
    case 'read': {
      const filePath = bufferFilePath(state);
      if (event.readId !== state.read.id || !filePath) return state;
      return applyRead(state, filePath, event.result);
    }
    case 'media-preview-start':
      if (event.readId !== state.read.id) return state;
      return withMediaPreview(state, { status: 'loading' });
    case 'media-preview-read':
      if (event.readId !== state.read.id) return state;
      return withMediaPreview(state, mediaPreviewOf(event.result));
    case 'edit':
      return applyEdit(state, event.text);
    case 'set-dirty':
    case 'external-change':
      return withEdits(state, nextEdits(state.edits, event));
    case 'disk-presence': {
      const { view } = state;
      if (view.status !== 'loaded' || view.goneFromDisk === event.missing) return state;
      return withView(state, { ...view, goneFromDisk: event.missing });
    }
    case 'saved':
      return applySaved(state, event.text, event.stillDirty);
  }
}

/** The buffer as the flat fields the file surfaces read. */
export function editorBufferFields(state: EditorBufferState) {
  const { view } = state;
  const filePath = bufferFilePath(state);
  const content = view.status === 'loaded' ? view.content : null;
  const text = content?.kind === 'text' ? content : null;
  const image = content?.kind === 'image' ? content : null;
  const media = content?.kind === 'media' ? content : null;
  const preview = media?.preview.status === 'loaded' ? media.preview : null;
  return {
    filePath,
    fileContent: text?.text ?? null,
    /** The disk's text, or the version of a file that isn't read as text. */
    diskContent: text
      ? text.savedText
      : content?.kind === 'binary' || content?.kind === 'media'
        ? content.diskToken
        : null,
    isDirty: state.edits !== 'clean',
    /** The file changed on disk under unsaved edits. */
    hasExternalChange: state.edits === 'conflict',
    missingOnDisk: view.status === 'missing' || (view.status === 'loaded' && view.goneFromDisk),
    loadingFile: view.status === 'loading',
    error: view.status === 'error' ? view.message : null,
    isBrowserPreviewable: filePath !== null && isBrowserPreviewableFile(filePath),
    isUnsupportedBinary: filePath !== null && isUnsupportedBinaryFile(filePath),
    isImage: image !== null,
    imageData: image?.data ?? null,
    imageMimeType: image?.mimeType ?? null,
    isMedia: media !== null,
    mediaData: preview?.data ?? null,
    mediaMimeType: preview?.mimeType ?? media?.mimeType ?? null,
    mediaKind: preview?.kind ?? media?.mediaKind ?? null,
    mediaSize: media?.size ?? null,
    mediaPreviewLoading: media?.preview.status === 'loading',
    mediaPreviewError: media?.preview.status === 'error' ? media.preview.message : null,
  };
}

/** What a look at the disk found for the shown file. */
export type DiskObservation =
  /** Its text, or for a file not read as text, its size and modification time. */
  | { kind: 'version'; version: string }
  /** An SSH file not read as text, which has no version to compare. */
  | { kind: 'unversioned' }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

export interface DiskReconcileDecision {
  /** Whether the file is gone from disk, or left as it was when undefined. */
  missingOnDisk?: boolean;
  /** `reload` takes the disk's version; `conflict` keeps the edits and says the disk changed. */
  action: 'none' | 'reload' | 'conflict';
}

/**
 * How a buffer takes what is on disk now: a clean one takes a new version, while unsaved edits
 * stay and are flagged, also when the file is gone or can't be read.
 */
export function decideDiskReconcile(
  buffer: { diskVersion: string | null; dirty: boolean },
  observation: DiskObservation
): DiskReconcileDecision {
  const changed = buffer.dirty ? 'conflict' : 'reload';
  switch (observation.kind) {
    case 'unversioned':
      return { action: 'reload' };
    case 'version':
      return {
        missingOnDisk: false,
        action: observation.version === buffer.diskVersion ? 'none' : changed,
      };
    case 'missing':
      return { missingOnDisk: true, action: buffer.dirty ? 'conflict' : 'none' };
    case 'unreadable':
      return { action: buffer.dirty ? 'conflict' : 'none' };
  }
}
