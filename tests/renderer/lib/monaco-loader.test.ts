import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

interface FakeTokensProvider {
  getInitialState(): unknown;
  tokenize(line: string, state: unknown): { tokens: { startIndex: number; scopes: string }[] };
}

interface FakeModel {
  getLanguageId(): string;
  getValue(): string;
  getLineContent(lineNumber: number): string;
  onDidChangeContent(listener: Listener): { dispose(): void };
  onDidChangeLanguage(listener: Listener): { dispose(): void };
}

const fake = vi.hoisted(() => {
  const state = {
    languages: new Set<string>(),
    onLanguage: new Map<string, Array<() => void>>(),
    factories: new Map<string, { create: () => Promise<unknown> }>(),
    providers: new Map<string, unknown>(),
    configurations: new Map<string, unknown>(),
    modelListeners: [] as Array<(model: unknown) => void>,
    setupJsonMode: null as null | ((defaults: unknown) => void),
    // Languages whose Monarch tokenizer Monaco made before Komla registered Shiki's.
    monarchTokenizers: new Set<string>(),
    frames: [] as Array<() => void>,
  };
  const disposable = { dispose() {} };
  const api = {
    languages: {
      getLanguages: () => [...state.languages].map((id) => ({ id })),
      register: ({ id }: { id: string }) => {
        state.languages.add(id);
      },
      onLanguage: (id: string, listener: () => void) => {
        state.onLanguage.set(id, [...(state.onLanguage.get(id) ?? []), listener]);
        return disposable;
      },
      setTokensProvider: (id: string, provider: unknown) => {
        state.providers.set(id, provider);
        return disposable;
      },
      registerTokensProviderFactory: (id: string, factory: { create: () => Promise<unknown> }) => {
        state.factories.set(id, factory);
        return disposable;
      },
      setLanguageConfiguration: (id: string, configuration: unknown) => {
        state.configurations.set(id, configuration);
        return disposable;
      },
    },
    editor: {
      defineTheme: () => {},
      setTheme: () => {},
      create: () => ({}),
      onDidCreateModel: (listener: (model: unknown) => void) => {
        state.modelListeners.push(listener);
        return disposable;
      },
    },
    json: {
      jsonDefaults: {
        diagnosticsOptions: { validate: true, comments: 'error', trailingCommas: 'error' },
        modeConfiguration: {},
        onDidChange: () => disposable,
      },
    },
  };
  return { state, api };
});

vi.mock('monaco-editor', () => fake.api);
vi.mock('monaco-editor/esm/vs/editor/common/languages.js', () => ({
  TokenizationRegistry: {
    get: (id: string) => (fake.state.monarchTokenizers.has(id) ? {} : null),
    getOrCreate: (id: string) => fake.state.factories.get(id)?.create() ?? Promise.resolve(null),
  },
}));
vi.mock('@monaco-editor/react', () => ({ loader: { config: () => {} } }));
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({
  default: class {},
}));
vi.mock(
  'monaco-editor/esm/vs/editor/browser/widget/diffEditor/features/overviewRulerFeature.js',
  () => ({ OverviewRulerFeature: { ONE_OVERVIEW_WIDTH: 15, ENTIRE_DIFF_OVERVIEW_WIDTH: 30 } })
);
vi.mock('monaco-editor/esm/vs/language/json/jsonMode.js', () => ({
  setupMode: (defaults: unknown) => fake.state.setupJsonMode?.(defaults),
}));
vi.mock('monaco-editor/esm/vs/basic-languages/typescript/typescript.js', () => ({
  conf: { comments: { lineComment: '//' } },
  language: {},
}));
vi.mock('monaco-editor/esm/vs/basic-languages/hcl/hcl.js', () => ({
  conf: { comments: { lineComment: '#' } },
  language: {},
}));
vi.mock('monaco-editor/esm/vs/basic-languages/scss/scss.js', () => ({
  conf: { comments: { blockComment: ['/*', '*/'] } },
  language: {},
}));
vi.mock('monaco-editor/esm/vs/basic-languages/markdown/markdown.js', () => ({
  conf: { comments: { blockComment: ['<!--', '-->'] } },
  language: {},
}));

const disposableStub = { dispose() {} };

async function loadInitializedLoader() {
  const loader = await import('../../../src/renderer/lib/monaco-loader');
  await loader.ensureMonacoInitialized();
  return loader;
}

function fakeModel(languageId: string, lines: string[]): FakeModel {
  return {
    getLanguageId: () => languageId,
    getValue: () => lines.join('\n'),
    getLineContent: (lineNumber) => lines[lineNumber - 1] ?? '',
    onDidChangeContent: () => disposableStub,
    onDidChangeLanguage: () => disposableStub,
  };
}

function runFrames(): void {
  for (const frame of fake.state.frames.splice(0)) frame();
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    runFrames();
  }
  expect(check()).toBe(true);
}

const loadedLanguages = (loader: typeof import('../../../src/renderer/lib/monaco-loader')) =>
  loader.getShikiHighlighter()!.getLoadedLanguages();

beforeEach(() => {
  vi.resetModules();
  fake.state.languages = new Set(['typescript', 'javascript', 'json', 'markdown', 'rust']);
  fake.state.onLanguage.clear();
  fake.state.factories.clear();
  fake.state.providers.clear();
  fake.state.configurations.clear();
  fake.state.modelListeners = [];
  fake.state.setupJsonMode = null;
  fake.state.monarchTokenizers.clear();
  fake.state.frames = [];
  vi.stubGlobal('requestAnimationFrame', (frame: () => void) => fake.state.frames.push(frame));
});

describe('ensureMonacoInitialized grammars', () => {
  it('does not load every grammar before the first editor can mount', async () => {
    const loader = await loadInitializedLoader();

    const loaded = loader.getShikiHighlighter()?.getLoadedLanguages() ?? [];
    expect(loaded).not.toContain('rust');
    expect(loaded).not.toContain('typescript');
  });

  it('loads a grammar when Monaco first asks for its tokenizer', async () => {
    const loader = await loadInitializedLoader();

    const provider = (await fake.state.factories.get('rust')!.create()) as FakeTokensProvider;

    expect(loader.getShikiHighlighter()!.getLoadedLanguages()).toContain('rust');
    const { tokens } = provider.tokenize('fn main() {}', provider.getInitialState());
    expect(tokens.some((token) => token.scopes !== '')).toBe(true);
  });

  it('retokenizes markdown once a fenced language grammar arrives', async () => {
    const loader = await loadInitializedLoader();
    await fake.state.factories.get('markdown')!.create();
    fake.state.providers.clear();

    await loader.loadShikiLanguage('python');

    await waitFor(() => fake.state.providers.has('markdown'));
  });

  it('retokenizes markdown once for grammars that arrive together', async () => {
    const loader = await loadInitializedLoader();
    await fake.state.factories.get('markdown')!.create();
    const setTokensProvider = vi.spyOn(fake.api.languages, 'setTokensProvider');

    await Promise.all(['python', 'go', 'rust'].map((name) => loader.loadShikiLanguage(name)));
    runFrames();

    expect(setTokensProvider.mock.calls.filter(([id]) => id === 'markdown')).toHaveLength(1);
  });

  it('loads the grammars a Vue file embeds lazily, such as SCSS', async () => {
    const loader = await loadInitializedLoader();

    await fake.state.factories.get('vue')!.create();

    await waitFor(() => loadedLanguages(loader).includes('scss'));
  });

  it('leaves the languages markdown embeds to its code fences', async () => {
    const loader = await loadInitializedLoader();

    await fake.state.factories.get('markdown')!.create();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loadedLanguages(loader)).not.toContain('python');
  });

  it('loads the JSX and front matter grammars of MDX, and leaves the rest to its code fences', async () => {
    const loader = await loadInitializedLoader();

    await fake.state.factories.get('mdx')!.create();

    await waitFor(() => ['tsx', 'yaml'].every((id) => loadedLanguages(loader).includes(id)));
    expect(loadedLanguages(loader)).not.toContain('python');
  });

  it('loads the grammars named by code fences in an MDX model', async () => {
    const loader = await loadInitializedLoader();

    for (const listener of fake.state.modelListeners) {
      listener(fakeModel('mdx', ['# Notes', '```go', 'package main', '```']));
    }

    await waitFor(() => loadedLanguages(loader).includes('go'));
  });

  it('gives Shiki colors to a language Monaco gave Monarch colors before Shiki was ready', async () => {
    fake.state.monarchTokenizers.add('html');
    const loader = await loadInitializedLoader();

    await waitFor(() => loadedLanguages(loader).includes('html'));
  });

  it('tries a grammar that failed to load again on next use', async () => {
    const loader = await loadInitializedLoader();
    const loadLanguage = vi
      .spyOn(loader.getShikiHighlighter()!, 'loadLanguage')
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));

    expect(await loader.loadShikiLanguage('rust')).toBe(false);
    expect(await loader.loadShikiLanguage('rust')).toBe(true);
    expect(loadLanguage).toHaveBeenCalledTimes(2);
  });

  it("doesn't try to load a language Shiki doesn't have", async () => {
    const loader = await loadInitializedLoader();
    const loadLanguage = vi.spyOn(loader.getShikiHighlighter()!, 'loadLanguage');

    expect(await loader.loadShikiLanguage('not-a-language')).toBe(false);
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it('loads the grammars named by code fences in a markdown model', async () => {
    const loader = await loadInitializedLoader();

    for (const listener of fake.state.modelListeners) {
      listener(fakeModel('markdown', ['# Notes', '```go', 'package main', '```']));
    }

    await waitFor(() => loader.getShikiHighlighter()!.getLoadedLanguages().includes('go'));
  });

  it('loads a fence language once its line is finished, not while it is typed', async () => {
    const loader = await loadInitializedLoader();
    const lines = [''];
    const changeListeners: Listener[] = [];
    const model = {
      ...fakeModel('markdown', lines),
      onDidChangeContent: (listener: Listener) => {
        changeListeners.push(listener);
        return disposableStub;
      },
    };
    for (const listener of fake.state.modelListeners) listener(model);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const typed = (text: string) =>
      changeListeners.forEach((listener) =>
        listener({ changes: [{ range: { startLineNumber: 1 }, text }] })
      );

    lines[0] = '```r';
    typed('```r');
    lines[0] = '```ru';
    typed('u');
    lines[0] = '```rust';
    typed('st');
    typed('\n');

    await waitFor(() => loader.getShikiHighlighter()!.getLoadedLanguages().includes('rust'));
    expect(loader.getShikiHighlighter()!.getLoadedLanguages()).not.toContain('r');
  });

  it('reads code fences from an edit made in several places at once', async () => {
    const loader = await loadInitializedLoader();
    const lines = ['# Notes', 'text'];
    const changeListeners: Listener[] = [];
    const model = {
      ...fakeModel('markdown', lines),
      getLineContent: (lineNumber: number) => {
        if (lineNumber > lines.length) throw new Error('Illegal value for lineNumber');
        return lines[lineNumber - 1];
      },
      onDidChangeContent: (listener: Listener) => {
        changeListeners.push(listener);
        return disposableStub;
      },
    };
    for (const listener of fake.state.modelListeners) listener(model);

    // Two cursors: one deletes a block near the top, one adds a fence lower down. Both
    // changes give line numbers from before the edit, past the end of the text after it.
    const changes = [
      { range: { startLineNumber: 40 }, text: '\n```go\n' },
      { range: { startLineNumber: 2 }, text: '' },
    ];
    expect(() => changeListeners.forEach((listener) => listener({ changes }))).not.toThrow();

    await waitFor(() => loadedLanguages(loader).includes('go'));
  });

  // Brackets colored by depth, matching and closing, and comment toggling come from these.
  it.each([
    ['tsx', 'TypeScript', { lineComment: '//' }],
    ['terraform', 'HCL', { lineComment: '#' }],
    ['sass', 'SCSS', { blockComment: ['/*', '*/'] }],
    ['mdx', 'Markdown', { blockComment: ['<!--', '-->'] }],
  ])('registers %s with the %s language configuration', async (id, _from, comments) => {
    await loadInitializedLoader();

    expect(fake.state.languages.has(id)).toBe(true);
    expect(fake.state.factories.has(id)).toBe(true);
    for (const listener of fake.state.onLanguage.get(id) ?? []) listener();
    await waitFor(() => fake.state.configurations.has(id));
    expect(fake.state.configurations.get(id)).toEqual({ comments });
  });
});

describe('ensureMonacoInitialized jsonc', () => {
  it('accepts comments and trailing commas in JSON with Comments', async () => {
    const setups: Array<{ languageId: string; diagnosticsOptions: Record<string, unknown> }> = [];
    fake.state.setupJsonMode = (defaults) => setups.push(defaults as (typeof setups)[number]);
    await loadInitializedLoader();

    for (const listener of fake.state.onLanguage.get('jsonc') ?? []) listener();

    expect(setups).toHaveLength(1);
    expect(setups[0].languageId).toBe('jsonc');
    expect(setups[0].diagnosticsOptions).toMatchObject({
      validate: true,
      comments: 'ignore',
      trailingCommas: 'ignore',
    });
  });
});

describe('setMonacoPalette', () => {
  it("paints the editor's widgets in a palette's colors, then in the mode's own again", async () => {
    const loader = await import('../../../src/renderer/lib/monaco-loader');
    const own = loader.getKomlaEditorTheme().colors!;

    loader.setMonacoPalette('dark', '#282a36', { background: '#343746', hover: '#44475a' });
    expect(loader.getKomlaEditorTheme().colors).toMatchObject({
      'editorWidget.background': '#343746',
      'editorStickyScroll.background': '#343746',
      'editorStickyScrollHover.background': '#44475a',
      'diffEditor.unchangedRegionBackground': '#343746',
    });

    loader.setMonacoPalette('dark', null, null);
    expect(loader.getKomlaEditorTheme().colors?.['editorWidget.background']).toBe(
      own['editorWidget.background']
    );
  });

  it('re-themes once for a new mode, background and widgets together', async () => {
    const loader = await import('../../../src/renderer/lib/monaco-loader');
    const listener = vi.fn();
    loader.subscribeKomlaEditorTheme(listener);

    loader.setMonacoPalette('light', '#ffffff', { background: '#f5f5f5', hover: '#ebebeb' });
    loader.setMonacoPalette('light', '#ffffff', { background: '#f5f5f5', hover: '#ebebeb' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(loader.getKomlaEditorTheme()).toMatchObject({ type: 'light', bg: '#ffffff' });
  });
});
