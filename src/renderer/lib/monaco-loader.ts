import { loader } from '@monaco-editor/react';

import { SHIKI_BUNDLED_LANGUAGES } from '@/components/workspaces/file-viewer/file-viewer-utils';

import { DEFAULT_TERMINAL_CONFIG } from '../../shared/constants/terminal';

import type { TreeThemeInput } from '@pierre/trees';
import type { languages as monacoLanguages, editor as monacoEditor } from 'monaco-editor';
import type { BundledLanguage, Highlighter, bundledLanguages } from 'shiki';

type MonacoWorkerFactory = new () => Worker;

// Two registered theme names — Shiki keys its loaded themes by name, so we
// must use the same identifier in Monaco's defineTheme/setTheme. The active
// name follows the current palette mode and is exposed via
// `useMonacoThemeName` so React-mounted editors pass the right `theme` prop.
const KOMLA_EDITOR_THEME_DARK = 'komla-dark';
const KOMLA_EDITOR_THEME_LIGHT = 'komla-light';
export const KOMLA_EDITOR_BACKGROUND = '#13171b';
const KOMLA_LIGHT_BACKGROUND = '#ffffff';

const KOMLA_DARK_COLORS: Record<string, string> = {
  'editor.background': KOMLA_EDITOR_BACKGROUND,
  'editor.foreground': '#e4e4e7',
  'editor.lineHighlightBackground': '#ffffff0a',
  'editor.lineHighlightBorder': '#00000000',
  'editorLineNumber.foreground': '#52525b',
  'editorLineNumber.activeForeground': '#a1a1aa',
  'editorCursor.foreground': '#e5e5e5',
  'editor.selectionBackground': '#3b82f655',
  'editor.selectionHighlightBackground': '#3b82f628',
  'editor.inactiveSelectionBackground': '#3b82f625',
  'editor.findMatchBackground': '#3b82f660',
  'editor.findMatchHighlightBackground': '#3b82f630',
  'editor.wordHighlightBackground': '#ffffff14',
  'editor.wordHighlightStrongBackground': '#ffffff1c',
  'editorIndentGuide.background1': '#ffffff0a',
  'editorIndentGuide.activeBackground1': '#ffffff22',
  'editorBracketMatch.background': '#3b82f630',
  'editorBracketMatch.border': '#3b82f680',
  'editorGutter.background': KOMLA_EDITOR_BACKGROUND,
  'editorStickyScroll.background': '#262a2f',
  'editorStickyScrollHover.background': '#363b3f',
  'editorWidget.background': '#262a2f',
  'editorWidget.border': '#ffffff14',
  'editorOverviewRuler.border': '#00000000',
  'scrollbarSlider.background': '#79797966',
  'scrollbarSlider.hoverBackground': '#646464b3',
  'scrollbarSlider.activeBackground': '#bfbfbf66',
  'diffEditor.insertedLineBackground': '#22c55e22',
  'diffEditor.insertedTextBackground': '#22c55e3c',
  'diffEditor.removedLineBackground': '#ef444422',
  'diffEditor.removedTextBackground': '#ef44443c',
  'diffEditorGutter.insertedLineBackground': '#22c55e26',
  'diffEditorGutter.removedLineBackground': '#ef444426',
  'diffEditor.border': '#ffffff14',
  'diffEditor.diagonalFill': '#ffffff08',
  // Default fallbacks are sideBar.background / foreground (unset in standalone
  // Monaco) and pitch-black #000000 shadow. Without overrides the unchanged-
  // region widget's inset shadow makes narrow widgets look like a solid black
  // bar instead of showing the fold icon and "N hidden lines" label.
  'diffEditor.unchangedRegionBackground': '#262a2f',
  'diffEditor.unchangedRegionForeground': '#a1a1aa',
  'diffEditor.unchangedRegionShadow': '#00000040',
};

const KOMLA_LIGHT_COLORS: Record<string, string> = {
  'editor.background': KOMLA_LIGHT_BACKGROUND,
  'editor.foreground': '#171717',
  'editor.lineHighlightBackground': '#0000000a',
  'editor.lineHighlightBorder': '#00000000',
  'editorLineNumber.foreground': '#a1a1aa',
  'editorLineNumber.activeForeground': '#52525b',
  'editorCursor.foreground': '#171717',
  'editor.selectionBackground': '#3b82f640',
  'editor.selectionHighlightBackground': '#3b82f622',
  'editor.inactiveSelectionBackground': '#3b82f622',
  'editor.findMatchBackground': '#3b82f655',
  'editor.findMatchHighlightBackground': '#3b82f628',
  'editor.wordHighlightBackground': '#00000010',
  'editor.wordHighlightStrongBackground': '#00000018',
  'editorIndentGuide.background1': '#0000000a',
  'editorIndentGuide.activeBackground1': '#00000022',
  'editorBracketMatch.background': '#3b82f628',
  'editorBracketMatch.border': '#3b82f680',
  'editorGutter.background': KOMLA_LIGHT_BACKGROUND,
  'editorStickyScroll.background': '#f5f5f5',
  'editorStickyScrollHover.background': '#ebebeb',
  'editorWidget.background': '#f5f5f5',
  'editorWidget.border': '#0000001f',
  'editorOverviewRuler.border': '#00000000',
  'scrollbarSlider.background': '#0000001f',
  'scrollbarSlider.hoverBackground': '#00000033',
  'scrollbarSlider.activeBackground': '#00000044',
  'diffEditor.insertedLineBackground': '#22c55e22',
  'diffEditor.insertedTextBackground': '#22c55e3c',
  'diffEditor.removedLineBackground': '#ef444422',
  'diffEditor.removedTextBackground': '#ef44443c',
  'diffEditorGutter.insertedLineBackground': '#22c55e26',
  'diffEditorGutter.removedLineBackground': '#ef444426',
  'diffEditor.border': '#0000001f',
  'diffEditor.diagonalFill': '#00000010',
  'diffEditor.unchangedRegionBackground': '#f5f5f5',
  'diffEditor.unchangedRegionForeground': '#52525b',
  'diffEditor.unchangedRegionShadow': '#00000018',
};

export const KOMLA_EDITOR_BASE_OPTIONS: monacoEditor.IEditorOptions = {
  fontFamily:
    "'JetBrainsMonoNL Nerd Font Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
  fontLigatures: false,
  lineHeight: 1.6,
  letterSpacing: 0.3,
  cursorBlinking: 'smooth',
  cursorWidth: 2,
  roundedSelection: true,
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },
};

/** One pixel under the terminal font, so the editor is 13px at the terminal's 14px default. */
export function editorFontSize(terminalFontSize = DEFAULT_TERMINAL_CONFIG.font.size): number {
  return terminalFontSize - 1;
}

type MonacoWorkerEnvironmentConfig = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: MonacoWorkerEnvironmentConfig;
};

let monacoInitPromise: Promise<void> | null = null;

type ThemeMode = 'dark' | 'light';

// Per-mode rules + base for syntax highlighting. Captured during Shiki init so
// `redefineActiveTheme` can replay them when the mode flips.
interface ModeRecipe {
  base: 'vs-dark' | 'vs';
  inherit: boolean;
  colors: Record<string, string>;
  rules: monacoEditor.ITokenThemeRule[];
}

const RECIPES: Record<ThemeMode, ModeRecipe> = {
  dark: {
    base: 'vs-dark',
    inherit: true,
    colors: KOMLA_DARK_COLORS,
    rules: [],
  },
  light: {
    base: 'vs',
    inherit: true,
    colors: KOMLA_LIGHT_COLORS,
    rules: [],
  },
};

let currentMode: ThemeMode = 'dark';
let monacoBgOverride: string | null = null;
let monacoWidgetOverride: MonacoWidgetColors | null = null;
let loadedMonaco: typeof import('monaco-editor') | null = null;
let shikiHighlighter: Highlighter | null = null;
let shikiLanguageImports: typeof bundledLanguages | null = null;
let shikiRefreshScheduled = false;
const shikiLanguageLoads = new Map<string, Promise<boolean>>();
const shikiLanguageSubscribers = new Set<() => void>();
// Grammar behind each Monaco language whose tokenizer is live, so a rebuilt one is noticed.
const tokenizerGrammars = new Map<string, unknown>();
const shikiTokenizers = new Map<string, monacoLanguages.TokensProvider>();

function themeNameForMode(mode: ThemeMode): string {
  return mode === 'dark' ? KOMLA_EDITOR_THEME_DARK : KOMLA_EDITOR_THEME_LIGHT;
}

export function getMonacoThemeName(): string {
  return themeNameForMode(currentMode);
}

/**
 * Monaco's Shiki highlighter, with the active theme loaded under `getMonacoThemeName()`.
 * Null until `ensureMonacoInitialized` has loaded it; `subscribeKomlaEditorTheme` fires then.
 */
export function getShikiHighlighter(): Highlighter | null {
  return shikiHighlighter;
}

/**
 * Loads a Shiki grammar, by language id or alias, the first time anything asks for it.
 * Resolves false for a language Shiki doesn't bundle, or before Monaco is initialized.
 */
export function loadShikiLanguage(language: string): Promise<boolean> {
  const highlighter = shikiHighlighter;
  const imports = shikiLanguageImports;
  if (!highlighter || !imports || !Object.hasOwn(imports, language)) return Promise.resolve(false);
  let load = shikiLanguageLoads.get(language);
  if (!load) {
    load = highlighter.loadLanguage(language as BundledLanguage).then(
      () => {
        void loadLazilyEmbeddedLanguages(imports, language);
        scheduleShikiLanguageRefresh(highlighter);
        return true;
      },
      () => {
        // Such as a chunk that failed to load: forget it, so the next use tries again.
        shikiLanguageLoads.delete(language);
        return false;
      }
    );
    shikiLanguageLoads.set(language, load);
  }
  return load;
}

// Markdown and MDX embed every language: their code fences load their own. MDX also embeds
// these outside fences, for its imports, JSX and front matter.
const CODE_FENCE_GRAMMAR_EMBEDS: Record<string, readonly string[]> = {
  markdown: [],
  mdx: ['tsx', 'yaml'],
};

// A grammar colors code it embeds lazily, such as Vue's <style lang="scss">, only once that
// code's grammar has loaded too.
async function loadLazilyEmbeddedLanguages(
  imports: typeof bundledLanguages,
  language: string
): Promise<void> {
  const registrations = (await imports[language as BundledLanguage]()).default;
  const registration = registrations.find(
    (candidate) => candidate.name === language || candidate.aliases?.includes(language)
  );
  if (!registration) return;
  const embeds =
    CODE_FENCE_GRAMMAR_EMBEDS[registration.name] ?? registration.embeddedLangsLazy ?? [];
  for (const embedded of embeds) {
    if ((SHIKI_BUNDLED_LANGUAGES as readonly string[]).includes(embedded)) {
      void loadShikiLanguage(embedded);
    }
  }
}

// Grammars arrive one at a time, often several at once, such as a file's code fences.
// Retokenizing and recoloring once a frame does that work once for all of them.
function scheduleShikiLanguageRefresh(highlighter: Highlighter): void {
  if (shikiRefreshScheduled) return;
  shikiRefreshScheduled = true;
  requestAnimationFrame(() => {
    shikiRefreshScheduled = false;
    refreshRebuiltTokenizers(highlighter);
    shikiLanguageSubscribers.forEach((listener) => listener());
  });
}

/** Fires after `loadShikiLanguage` adds grammars, so text colored outside Monaco can recolor. */
export function subscribeShikiLanguageLoads(listener: () => void): () => void {
  shikiLanguageSubscribers.add(listener);
  return () => {
    shikiLanguageSubscribers.delete(listener);
  };
}

// A grammar that embeds others lazily, such as markdown with its code fences, is rebuilt by
// Shiki when one of them loads. Monaco's cached line states point into the old grammar, so
// registering the tokenizer again makes Monaco tokenize those models afresh.
function refreshRebuiltTokenizers(highlighter: Highlighter): void {
  for (const [language, grammar] of tokenizerGrammars) {
    const current = highlighter.getLanguage(language);
    if (current === grammar) continue;
    tokenizerGrammars.set(language, current);
    loadedMonaco?.languages.setTokensProvider(language, shikiTokenizers.get(language)!);
  }
}

// Markdown and MDX color a code fence only once the fence language's grammar is loaded.
const CODE_FENCE_LANGUAGE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*([\w#+.-]+)/gm;

function loadCodeFenceLanguages(text: string): void {
  for (const match of text.matchAll(CODE_FENCE_LANGUAGE)) {
    void loadShikiLanguage(match[1].toLowerCase());
  }
}

function watchMarkdownCodeFences(monaco: typeof import('monaco-editor')): void {
  monaco.editor.onDidCreateModel((model) => {
    const isMarkdown = () => Object.hasOwn(CODE_FENCE_GRAMMAR_EMBEDS, model.getLanguageId());
    if (isMarkdown()) loadCodeFenceLanguages(model.getValue());
    model.onDidChangeLanguage(() => {
      if (isMarkdown()) loadCodeFenceLanguages(model.getValue());
    });
    model.onDidChangeContent((event) => {
      if (!isMarkdown()) return;
      // Only completed lines, so typing ```rust doesn't load the R grammar on the way. A lone
      // change leaves its first line where it was; several report lines from before all of them.
      const { changes } = event;
      for (const change of changes) {
        if (!change.text.includes('\n')) continue;
        const line = changes.length === 1 ? model.getLineContent(change.range.startLineNumber) : '';
        loadCodeFenceLanguages(`${line}\n${change.text}`);
      }
    });
  });
}

/** The parts of Monaco's internal TokenizationRegistry Komla uses. */
interface MonacoTokenizationRegistry {
  get(languageId: string): unknown;
  getOrCreate(languageId: string): Promise<unknown>;
}

/**
 * Registers each grammar's Monaco tokenizer to load that grammar on first use. Loading
 * all ~60 before the first editor mounted held it back by about two seconds.
 */
function registerLazyShikiTokenizers(
  highlighter: Highlighter,
  monaco: typeof import('monaco-editor'),
  tokenizationRegistry: MonacoTokenizationRegistry,
  shikiToMonaco: typeof import('@shikijs/monaco').shikiToMonaco
): void {
  // shikiToMonaco registers a tokenizer for every grammar it sees loaded. Show it all of
  // them and keep the tokenizers instead, to hand Monaco as each grammar arrives.
  shikiToMonaco(
    { ...highlighter, getLoadedLanguages: () => [...SHIKI_BUNDLED_LANGUAGES] },
    {
      editor: monaco.editor,
      languages: {
        getLanguages: () => monaco.languages.getLanguages(),
        setTokensProvider: (language: string, provider: monacoLanguages.TokensProvider) => {
          shikiTokenizers.set(language, provider);
        },
      },
    }
  );

  for (const [language, provider] of shikiTokenizers) {
    // Monaco asks for a language's tokenizer once. An editor that mounted before this ran, such
    // as an HTML file's source, got Monarch's, which the new factory drops: so ask again.
    const requested = tokenizationRegistry.get(language) !== null;
    monaco.languages.registerTokensProviderFactory(language, {
      create: async () => {
        if (!(await loadShikiLanguage(language))) {
          console.warn(`Failed to load the Shiki grammar for ${language}`);
          return null;
        }
        tokenizerGrammars.set(language, highlighter.getLanguage(language));
        return provider;
      },
    });
    if (requested) void tokenizationRegistry.getOrCreate(language);
  }
}

// Shared Shiki-style theme object, consumed by Monaco AND @pierre/trees so
// both surfaces pull from the same color definitions. The initial value uses
// only KOMLA_DARK_COLORS so it's available synchronously on first render; once
// Shiki finishes loading we swap in the full merged dark-plus theme so the
// tree picks up tokens like gitDecoration.* and terminal.ansi* that we don't
// override manually.
const INITIAL_KOMLA_EDITOR_THEME: TreeThemeInput = {
  type: 'dark',
  bg: KOMLA_DARK_COLORS['editor.background'],
  fg: KOMLA_DARK_COLORS['editor.foreground'],
  colors: { ...KOMLA_DARK_COLORS },
};

let currentKomlaEditorTheme: TreeThemeInput = INITIAL_KOMLA_EDITOR_THEME;
const komlaEditorThemeSubscribers = new Set<() => void>();

export function getKomlaEditorTheme(): TreeThemeInput {
  return currentKomlaEditorTheme;
}

export function subscribeKomlaEditorTheme(listener: () => void): () => void {
  komlaEditorThemeSubscribers.add(listener);
  return () => {
    komlaEditorThemeSubscribers.delete(listener);
  };
}

function setKomlaEditorTheme(next: TreeThemeInput) {
  currentKomlaEditorTheme = next;
  komlaEditorThemeSubscribers.forEach((listener) => listener());
}

/** The editor's floating surfaces (find box, sticky scroll, folded diff regions) and their hover. */
export interface MonacoWidgetColors {
  background: string;
  hover: string;
}

function applyOverrides(colors: Record<string, string>): Record<string, string> {
  const widgets = monacoWidgetOverride;
  if (!monacoBgOverride && !widgets) return colors;
  return {
    ...colors,
    ...(monacoBgOverride && {
      'editor.background': monacoBgOverride,
      'editorGutter.background': monacoBgOverride,
    }),
    ...(widgets && {
      'editorStickyScroll.background': widgets.background,
      'editorStickyScrollHover.background': widgets.hover,
      'editorWidget.background': widgets.background,
      'diffEditor.unchangedRegionBackground': widgets.background,
    }),
  };
}

function redefineActiveTheme(): void {
  const recipe = RECIPES[currentMode];
  const colors = applyOverrides(recipe.colors);
  const themeName = themeNameForMode(currentMode);
  if (loadedMonaco) {
    loadedMonaco.editor.defineTheme(themeName, {
      base: recipe.base,
      inherit: recipe.inherit,
      rules: recipe.rules,
      colors,
    });
    loadedMonaco.editor.setTheme(themeName);
  }
  setKomlaEditorTheme({
    type: currentMode,
    bg:
      colors['editor.background'] ?? recipe.colors['editor.background'] ?? KOMLA_EDITOR_BACKGROUND,
    fg: colors['editor.foreground'] ?? recipe.colors['editor.foreground'] ?? '#e4e4e7',
    colors,
  });
}

/**
 * Switch the editor theme to the active palette's: its mode, and its background and widget colors
 * in place of the mode's own (null keeps those). Applies them together, so editors re-theme once.
 */
export function setMonacoPalette(
  mode: ThemeMode,
  background: string | null,
  widgets: MonacoWidgetColors | null
): void {
  if (
    currentMode === mode &&
    monacoBgOverride === background &&
    monacoWidgetOverride?.background === widgets?.background &&
    monacoWidgetOverride?.hover === widgets?.hover
  ) {
    return;
  }
  currentMode = mode;
  monacoBgOverride = background;
  monacoWidgetOverride = widgets;
  redefineActiveTheme();
}

type LanguageConfigurationModule = Promise<{ conf: monacoLanguages.LanguageConfiguration }>;

const BORROWED_LANGUAGE_CONFIGURATIONS: Record<string, () => LanguageConfigurationModule> = {
  // @ts-expect-error — internal Monaco module, no public types
  tsx: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js'),
  // @ts-expect-error — internal Monaco module, no public types
  terraform: () => import('monaco-editor/esm/vs/basic-languages/hcl/hcl.js'),
  // @ts-expect-error — internal Monaco module, no public types
  sass: () => import('monaco-editor/esm/vs/basic-languages/scss/scss.js'),
  // @ts-expect-error — internal Monaco module, no public types
  mdx: () => import('monaco-editor/esm/vs/basic-languages/markdown/markdown.js'),
};

async function ensureJsoncLanguageSupport(monaco: typeof import('monaco-editor')): Promise<void> {
  const registered = new Set(monaco.languages.getLanguages().map((language) => language.id));
  if (registered.has('jsonc')) {
    return;
  }

  // @ts-expect-error — internal Monaco module, no public types
  const { setupMode } = await import('monaco-editor/esm/vs/language/json/jsonMode.js');
  const { jsonDefaults } = monaco.json;

  monaco.languages.register({
    id: 'jsonc',
    extensions: ['.jsonc'],
    aliases: ['JSON with Comments', 'jsonc'],
    mimetypes: ['application/jsonc'],
  });

  const jsoncDefaults = {
    languageId: 'jsonc',
    diagnosticsOptions: {
      ...jsonDefaults.diagnosticsOptions,
      comments: 'ignore' as const,
      trailingCommas: 'ignore' as const,
    },
    modeConfiguration: jsonDefaults.modeConfiguration,
    onDidChange: jsonDefaults.onDidChange,
  };

  monaco.languages.onLanguage('jsonc', () => {
    setupMode(jsoncDefaults);
  });
}

export function ensureMonacoInitialized(): Promise<void> {
  if (monacoInitPromise) {
    return monacoInitPromise;
  }

  monacoInitPromise = (async () => {
    const [
      monaco,
      editorWorkerModule,
      cssWorkerModule,
      htmlWorkerModule,
      jsonWorkerModule,
      tsWorkerModule,
      overviewRulerFeatureModule,
      languagesModule,
    ] = await Promise.all([
      import('monaco-editor'),
      import('monaco-editor/esm/vs/editor/editor.worker?worker'),
      import('monaco-editor/esm/vs/language/css/css.worker?worker'),
      import('monaco-editor/esm/vs/language/html/html.worker?worker'),
      import('monaco-editor/esm/vs/language/json/json.worker?worker'),
      import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
      // @ts-expect-error — internal Monaco module, no public types
      import('monaco-editor/esm/vs/editor/browser/widget/diffEditor/features/overviewRulerFeature.js'),
      // @ts-expect-error — internal Monaco module, no public types
      import('monaco-editor/esm/vs/editor/common/languages.js'),
    ]);

    // Narrow the diff overview ruler from Monaco's hardcoded 30px (two 15px
    // sub-rulers) to 12px (two 6px). The widths live as static fields on an
    // internal class — re-verify after Monaco upgrades.
    const overviewRulerFeature = (
      overviewRulerFeatureModule as {
        OverviewRulerFeature: { ONE_OVERVIEW_WIDTH: number; ENTIRE_DIFF_OVERVIEW_WIDTH: number };
      }
    ).OverviewRulerFeature;
    overviewRulerFeature.ONE_OVERVIEW_WIDTH = 6;
    overviewRulerFeature.ENTIRE_DIFF_OVERVIEW_WIDTH = 12;

    const editorWorker = editorWorkerModule.default as MonacoWorkerFactory;
    const cssWorker = cssWorkerModule.default as MonacoWorkerFactory;
    const htmlWorker = htmlWorkerModule.default as MonacoWorkerFactory;
    const jsonWorker = jsonWorkerModule.default as MonacoWorkerFactory;
    const tsWorker = tsWorkerModule.default as MonacoWorkerFactory;

    // Monaco workers must be provided explicitly in Electron.
    const monacoGlobal = globalThis as MonacoGlobal;
    monacoGlobal.MonacoEnvironment = {
      getWorker(_, label) {
        if (label === 'json' || label === 'jsonc') return new jsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor')
          return new htmlWorker();
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        return new editorWorker();
      },
    };

    // Use bundled Monaco instead of the CDN path.
    loader.config({ monaco });
    loadedMonaco = monaco;

    // Register a baseline theme immediately so editors mounting before Shiki finishes
    // have something to render with. Shiki will replace this with a version that has
    // proper TextMate-based token rules.
    redefineActiveTheme();

    try {
      await ensureJsoncLanguageSupport(monaco);

      const { createHighlighter, bundledLanguages } = await import('shiki');
      const { shikiToMonaco, textmateThemeToMonacoTheme } = await import('@shikijs/monaco');

      const registeredLanguages = new Set(
        monaco.languages.getLanguages().map((language) => language.id)
      );
      for (const id of SHIKI_BUNDLED_LANGUAGES) {
        if (!registeredLanguages.has(id)) {
          monaco.languages.register({ id });
          registeredLanguages.add(id);
        }
      }
      // These exist only for their grammars; each borrows the brackets, comments and indenting
      // of the Monaco language its files had, or the one closest to it.
      for (const [id, load] of Object.entries(BORROWED_LANGUAGE_CONFIGURATIONS)) {
        monaco.languages.onLanguage(id, () => {
          void load().then(({ conf }) => monaco.languages.setLanguageConfiguration(id, conf));
        });
      }

      const highlighter = await createHighlighter({
        themes: ['dark-plus', 'light-plus'],
        langs: [],
      });

      // Bake each Shiki source theme into a mode recipe: merge its colors with
      // our overrides and capture the rules so palette/mode redefines preserve
      // syntax highlighting.
      for (const mode of ['dark', 'light'] as const) {
        const sourceName = mode === 'dark' ? 'dark-plus' : 'light-plus';
        const sourceTheme = highlighter.getTheme(sourceName);
        const overrides = mode === 'dark' ? KOMLA_DARK_COLORS : KOMLA_LIGHT_COLORS;
        const merged = { ...sourceTheme.colors, ...overrides };
        const themeName = themeNameForMode(mode);

        await highlighter.loadTheme({
          ...sourceTheme,
          name: themeName,
          colors: merged,
        });
        const loaded = highlighter.getTheme(themeName);
        // @shikijs/monaco types this against monaco-editor-core, which isn't installed.
        const monacoTheme = textmateThemeToMonacoTheme(loaded) as monacoEditor.IStandaloneThemeData;

        RECIPES[mode] = {
          base: mode === 'dark' ? 'vs-dark' : 'vs',
          inherit: false,
          colors: merged,
          rules: monacoTheme.rules,
        };
      }

      shikiHighlighter = highlighter;
      shikiLanguageImports = bundledLanguages;
      registerLazyShikiTokenizers(
        highlighter,
        monaco,
        (languagesModule as { TokenizationRegistry: MonacoTokenizationRegistry })
          .TokenizationRegistry,
        shikiToMonaco
      );
      watchMarkdownCodeFences(monaco);

      // Re-define the active theme using the now-fully-baked recipe so live
      // editors pick up the Shiki-derived rules and the color merge.
      redefineActiveTheme();
    } catch (error) {
      console.warn('Failed to initialize Shiki TextMate grammars, falling back to Monarch:', error);
    }
  })().catch((error) => {
    monacoInitPromise = null;
    throw error;
  });

  return monacoInitPromise;
}
