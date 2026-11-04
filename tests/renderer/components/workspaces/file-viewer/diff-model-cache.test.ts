import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chooseDiffModelPaths,
  MAX_IDLE_DIFF_MODELS,
  resetDiffModelCacheForTests,
  retainDiffModels,
  type DiffModelPaths,
  type DiffModelSource,
} from '../../../../../src/renderer/components/workspaces/file-viewer/diff-model-cache';

import type { editor as monacoEditor } from 'monaco-editor';

interface FakeModel {
  uri: { scheme: string; toString(): string };
  version: number;
  disposed: boolean;
  attached: boolean;
  getAlternativeVersionId(): number;
  isDisposed(): boolean;
  isAttachedToEditor(): boolean;
  dispose(): void;
}

let models: FakeModel[] = [];

function fakeModel(uri: string): FakeModel {
  const model: FakeModel = {
    uri: { scheme: uri.split(':')[0], toString: () => uri },
    version: 1,
    disposed: false,
    attached: true,
    getAlternativeVersionId: () => model.version,
    isDisposed: () => model.disposed,
    isAttachedToEditor: () => model.attached,
    dispose: () => {
      model.disposed = true;
      models = models.filter((candidate) => candidate !== model);
    },
  };
  models.push(model);
  return model;
}

const listModels = () => models as unknown as monacoEditor.ITextModel[];

/** What the diff editor does: find the models at these URIs, or make them. */
function mount(paths: DiffModelPaths) {
  const find = (uri: string) =>
    models.find((model) => model.uri.toString() === uri) ?? fakeModel(uri);
  const original = find(paths.original);
  const modified = find(paths.modified);
  original.attached = true;
  modified.attached = true;
  return { original, modified };
}

function show(source: DiffModelSource) {
  const paths = chooseDiffModelPaths(source);
  const mounted = mount(paths);
  const release = retainDiffModels(
    source,
    paths,
    mounted as unknown as {
      original: monacoEditor.ITextModel;
      modified: monacoEditor.ITextModel;
    },
    listModels
  );
  return {
    paths,
    ...mounted,
    close: () => {
      mounted.original.attached = false;
      mounted.modified.attached = false;
      release();
      vi.runAllTimers();
    },
  };
}

const source = (path: string, modified = `${path} after`): DiffModelSource => ({
  workingDirectory: '/repo',
  path,
  original: `${path} before`,
  modified,
});

describe('diff model cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    resetDiffModelCacheForTests();
    models = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a diff opened again with the models it had', () => {
    const first = show(source('a.ts'));
    first.close();
    show(source('b.ts')).close();

    const again = show(source('a.ts'));

    expect(again.paths).toEqual(first.paths);
    expect(again.original).toBe(first.original);
    expect(again.modified).toBe(first.modified);
  });

  it('makes new models once the text changed', () => {
    const first = show(source('a.ts'));
    first.close();

    const changed = show(source('a.ts', 'a.ts edited on disk'));

    expect(changed.paths).not.toEqual(first.paths);
    expect(changed.modified).not.toBe(first.modified);
  });

  it('never hands out models edited in the editor', () => {
    const first = show(source('a.ts'));
    first.modified.version++;
    first.close();

    const again = show(source('a.ts'));

    expect(again.modified).not.toBe(first.modified);
    expect(first.modified.disposed).toBe(true);
  });

  it('gives a second editor showing the same diff its own models', () => {
    const first = show(source('a.ts'));

    const second = show(source('a.ts'));

    expect(second.modified).not.toBe(first.modified);
  });

  it(`keeps at most ${MAX_IDLE_DIFF_MODELS} idle pairs, dropping the oldest`, () => {
    const shown = Array.from({ length: MAX_IDLE_DIFF_MODELS + 2 }, (_, index) => {
      const diff = show(source(`${index}.ts`));
      diff.close();
      return diff;
    });

    expect(shown[0].original.disposed).toBe(true);
    expect(shown[1].modified.disposed).toBe(true);
    expect(shown[2].original.disposed).toBe(false);
    expect(models).toHaveLength(MAX_IDLE_DIFF_MODELS * 2);
  });

  it('keeps the models of a diff on screen however many others close', () => {
    const onScreen = show(source('open.ts'));
    for (let index = 0; index < MAX_IDLE_DIFF_MODELS + 2; index++) {
      show(source(`${index}.ts`)).close();
    }

    expect(onScreen.original.disposed).toBe(false);
    expect(onScreen.modified.disposed).toBe(false);
  });

  it('disposes models an editor left at its URIs without handing them over', () => {
    const paths = chooseDiffModelPaths(source('a.ts'));
    const stray = mount(paths);
    stray.original.attached = false;
    stray.modified.attached = false;

    show(source('b.ts')).close();

    expect(stray.original.disposed).toBe(true);
    expect(stray.modified.disposed).toBe(true);
  });

  it('keeps the pair chosen for an editor still mounting while others close', () => {
    const shown = Array.from({ length: MAX_IDLE_DIFF_MODELS }, (_, index) => {
      const diff = show(source(`${index}.ts`));
      diff.close();
      return diff;
    });

    const paths = chooseDiffModelPaths(source('0.ts'));
    show(source('other.ts')).close();

    expect(paths).toEqual(shown[0].paths);
    expect(shown[0].original.disposed).toBe(false);
    expect(shown[0].modified.disposed).toBe(false);
  });

  it('gives two editors mounting together with the same diff their own models', () => {
    show(source('a.ts')).close();

    const first = chooseDiffModelPaths(source('a.ts'));
    const second = chooseDiffModelPaths(source('a.ts'));

    expect(second).not.toEqual(first);
  });

  it('frees a chosen pair whose editor never mounted', () => {
    const first = show(source('a.ts'));
    first.close();
    chooseDiffModelPaths(source('a.ts'));
    vi.advanceTimersByTime(60_000);

    expect(chooseDiffModelPaths(source('a.ts'))).toEqual(first.paths);
  });
});
