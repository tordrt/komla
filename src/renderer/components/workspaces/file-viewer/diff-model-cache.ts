import type { editor as monacoEditor } from 'monaco-editor';

/** The text a diff editor shows, and where it came from. */
export interface DiffModelSource {
  workingDirectory: string;
  path: string;
  original: string;
  modified: string;
}

/** Model URIs to hand the diff editor, which creates models there or finds the ones it left. */
export interface DiffModelPaths {
  original: string;
  modified: string;
}

interface Entry {
  source: DiffModelSource;
  paths: DiffModelPaths;
  original: monacoEditor.ITextModel;
  modified: monacoEditor.ITextModel;
  // Versions as first shown: a model edited since is never handed out again.
  originalVersion: number;
  modifiedVersion: number;
  users: number;
  // Until when an editor about to mount has been promised this pair: see `isFree`.
  reservedUntil: number;
}

const SCHEME = 'komla-diff';
/**
 * Pairs kept for diffs no editor shows. Each keeps its tokens and Monaco's diff of it, so
 * opening that diff again shows it at once; TypeScript ones also join the TypeScript worker's
 * program, so keep few.
 */
export const MAX_IDLE_DIFF_MODELS = 6;
/** How long a pair stays promised to an editor that hasn't mounted, as one dropped mid-render. */
const RESERVATION_MS = 10_000;

// Keyed by the original model's URI, oldest idle first.
const entries = new Map<string, Entry>();
let nextId = 0;

function isPristine(entry: Entry): boolean {
  return (
    !entry.original.isDisposed() &&
    !entry.modified.isDisposed() &&
    entry.original.getAlternativeVersionId() === entry.originalVersion &&
    entry.modified.getAlternativeVersionId() === entry.modifiedVersion
  );
}

/** Whether no editor shows the pair or is about to. */
function isFree(entry: Entry): boolean {
  return entry.users === 0 && entry.reservedUntil <= performance.now();
}

function sameSource(a: DiffModelSource, b: DiffModelSource): boolean {
  return (
    a.workingDirectory === b.workingDirectory &&
    a.path === b.path &&
    a.original === b.original &&
    a.modified === b.modified
  );
}

/**
 * Model URIs for a diff editor about to mount: those of an idle pair showing the same text, or
 * new ones. Pick them once per mount; the editor swaps models when they change.
 */
export function chooseDiffModelPaths(source: DiffModelSource): DiffModelPaths {
  for (const entry of entries.values()) {
    if (isFree(entry) && sameSource(entry.source, source) && isPristine(entry)) {
      entry.reservedUntil = performance.now() + RESERVATION_MS;
      return entry.paths;
    }
  }
  const id = ++nextId;
  return {
    original: `${SCHEME}:/${id}/original`,
    modified: `${SCHEME}:/${id}/modified`,
  };
}

function dispose(key: string, entry: Entry): void {
  entries.delete(key);
  entry.original.dispose();
  entry.modified.dispose();
}

function trim(listModels: () => monacoEditor.ITextModel[]): void {
  for (const [key, entry] of entries) {
    if (isFree(entry) && !isPristine(entry)) dispose(key, entry);
  }
  let idle = [...entries.values()].filter(isFree).length;
  for (const [key, entry] of entries) {
    if (idle <= MAX_IDLE_DIFF_MODELS) break;
    if (!isFree(entry)) continue;
    dispose(key, entry);
    idle--;
  }
  // Models an editor made at these URIs but unmounted before handing over, such as one
  // closed while it mounted.
  const kept = new Set<monacoEditor.ITextModel>();
  for (const entry of entries.values()) {
    kept.add(entry.original);
    kept.add(entry.modified);
  }
  for (const model of listModels()) {
    if (model.uri.scheme === SCHEME && !kept.has(model) && !model.isAttachedToEditor()) {
      model.dispose();
    }
  }
}

/**
 * Keeps a mounted diff editor's models, from `chooseDiffModelPaths`, for a later view of the
 * same text. Returns the release to call once the editor is gone; models it edited are dropped.
 */
export function retainDiffModels(
  source: DiffModelSource,
  paths: DiffModelPaths,
  models: {
    original: monacoEditor.ITextModel;
    modified: monacoEditor.ITextModel;
  },
  listModels: () => monacoEditor.ITextModel[]
): () => void {
  const key = paths.original;
  let entry = entries.get(key);
  if (!entry || entry.original !== models.original || entry.modified !== models.modified) {
    entry = {
      source,
      paths,
      original: models.original,
      modified: models.modified,
      originalVersion: models.original.getAlternativeVersionId(),
      modifiedVersion: models.modified.getAlternativeVersionId(),
      users: 0,
      reservedUntil: 0,
    };
  } else {
    entry.reservedUntil = 0;
  }
  // Most recently used last.
  entries.delete(key);
  entries.set(key, entry);
  entry.users++;

  const retained = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained.users--;
    // The editor disposes with its models still attached; trim once it has let go.
    setTimeout(() => trim(listModels), 0);
  };
}

/** For tests: forget every kept pair. */
export function resetDiffModelCacheForTests(): void {
  entries.clear();
  nextId = 0;
}
