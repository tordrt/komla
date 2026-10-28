import type { StatusColor, GroupedFiles, FileViewerMode, ViewMode } from './types';
import type { FileChange } from '@/types';
import type { IRange, editor as monacoEditor } from 'monaco-editor';

// Monaco keybinding: Ctrl/Cmd+Shift+C
export const COPY_AT_PATH_KEYBINDING = 2048 | 1024 | 33;

const FILE_NAME_LANGUAGE_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  Brewfile: 'ruby',
  Podfile: 'ruby',
  Vagrantfile: 'ruby',
  Jenkinsfile: 'groovy',
  'Cargo.lock': 'toml',
  'uv.lock': 'toml',
  'poetry.lock': 'toml',
  'nginx.conf': 'nginx',
  '.env': 'dotenv',
  '.envrc': 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zshenv': 'shell',
  '.zprofile': 'shell',
  '.editorconfig': 'ini',
};

// Variants named after their base file, such as Dockerfile.dev and .env.local.
const FILE_NAME_PREFIX_LANGUAGE_MAP: Record<string, string> = {
  'Dockerfile.': 'dockerfile',
  '.env.': 'dotenv',
};

const FILE_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  // Web
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  graphql: 'graphql',
  gql: 'graphql',
  astro: 'astro',

  // Markup / data
  md: 'markdown',
  mdx: 'mdx',
  xml: 'xml',
  xsl: 'xml',
  xsd: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  properties: 'ini',
  json5: 'json5',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  csv: 'csv',
  tsv: 'tsv',
  log: 'log',
  diff: 'diff',
  patch: 'diff',

  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',

  // Systems
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  rs: 'rust',
  go: 'go',
  zig: 'zig',

  // JVM
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',

  // .NET
  cs: 'csharp',
  fs: 'fsharp',
  fsx: 'fsharp',
  vb: 'vb',

  // Scripting
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  R: 'r',
  dart: 'dart',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-c',
  coffee: 'coffeescript',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  lhs: 'haskell',
  jl: 'julia',
  ml: 'ocaml',
  mli: 'ocaml',
  groovy: 'groovy',
  gradle: 'groovy',
  gemspec: 'ruby',
  rake: 'ruby',

  // Infra / config
  dockerfile: 'dockerfile',
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'hcl',
  proto: 'protobuf',
  nix: 'nix',
  prisma: 'prisma',
  cmake: 'cmake',

  // Query / DB
  sql: 'sql',
  psql: 'sql',

  // Other
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  asm: 'mips',
  s: 'mips',
  tex: 'latex',
  bib: 'bibtex',
  sol: 'sol',
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  wgsl: 'wgsl',
  azcli: 'azcli',
  bicep: 'bicep',
  pug: 'pug',
  jade: 'pug',
  handlebars: 'handlebars',
  hbs: 'handlebars',
  twig: 'twig',
  liquid: 'liquid',
  razor: 'razor',
  cshtml: 'razor',
};

const SHIKI_LANGUAGE_OVERRIDES: Record<string, string> = {
  html: 'html',
  shell: 'shellscript',
  sol: 'solidity',
  mips: 'asm',
};

export const SHIKI_BUNDLED_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'json',
  'jsonc',
  'html',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
  'graphql',
  'markdown',
  'mdx',
  'astro',
  'sass',
  'xml',
  'yaml',
  'toml',
  'ini',
  'json5',
  'jsonl',
  'csv',
  'tsv',
  'log',
  'diff',
  'dotenv',
  'shellscript',
  'fish',
  'powershell',
  'bat',
  'c',
  'cpp',
  'rust',
  'go',
  'zig',
  'java',
  'kotlin',
  'scala',
  'csharp',
  'fsharp',
  'vb',
  'python',
  'ruby',
  'php',
  'lua',
  'perl',
  'r',
  'dart',
  'swift',
  'objective-c',
  'coffeescript',
  'clojure',
  'elixir',
  'erlang',
  'haskell',
  'julia',
  'ocaml',
  'groovy',
  'dockerfile',
  'hcl',
  'terraform',
  'nix',
  'prisma',
  'cmake',
  'nginx',
  'protobuf',
  'sql',
  'latex',
  'bibtex',
  'handlebars',
  'pug',
  'razor',
  'liquid',
  'twig',
  'solidity',
  'glsl',
  'wgsl',
  'makefile',
  'asm',
] as const;

// ============================================================================
// Git Status Utilities
// ============================================================================

export function getStatusColor(status: FileChange['status']): StatusColor {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'green';
    case 'deleted':
      return 'red';
    case 'modified':
      return 'amber';
    case 'renamed':
      return 'purple';
    default:
      return 'muted';
  }
}

export function getStatusLabel(status: FileChange['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'untracked':
      return 'U';
    case 'deleted':
      return 'D';
    case 'modified':
      return 'M';
    case 'renamed':
      return 'R';
    default:
      return '?';
  }
}

/** Added and deleted files have nothing on one side, so a split diff would be half empty. */
export function isOneSidedDiff(status: FileChange['status'] | undefined): boolean {
  return status === 'added' || status === 'untracked' || status === 'deleted';
}

// ============================================================================
// File Language Detection
// ============================================================================

export function getFileLanguage(filePath: string): string {
  const fileName = filePath.split('/').pop() || '';
  if (FILE_NAME_LANGUAGE_MAP[fileName]) return FILE_NAME_LANGUAGE_MAP[fileName];
  for (const [prefix, language] of Object.entries(FILE_NAME_PREFIX_LANGUAGE_MAP)) {
    if (fileName.startsWith(prefix)) return language;
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return FILE_EXTENSION_LANGUAGE_MAP[ext] || 'plaintext';
}

/** JSON files whose tools accept comments and trailing commas, as VS Code treats them. */
function isJsonWithCommentsFile(filePath: string): boolean {
  const [fileName = '', parent] = filePath.split(/[\\/]/).reverse();
  return (
    /^[tj]sconfig(\..+)?\.json$/.test(fileName) ||
    /^\.?devcontainer\.json$/.test(fileName) ||
    (parent === '.vscode' && fileName.endsWith('.json'))
  );
}

export function getShikiLanguage(filePath: string, monacoLanguage: string): string {
  const fileName = filePath.split('/').pop() || '';
  if (fileName === 'Dockerfile') return 'dockerfile';
  if (fileName === 'Makefile') return 'makefile';

  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (ext === 'fish') return 'fish';
  if (ext === 'vue') return 'vue';
  if (ext === 'svelte') return 'svelte';
  // The TypeScript grammar reads JSX text such as `Don't` as a string literal.
  if (ext === 'tsx') return 'tsx';

  if (ext === 'jsonc' || isJsonWithCommentsFile(filePath)) return 'jsonc';
  if (ext === 'toml') return 'toml';

  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'shellscript';
  if (ext === 'asm' || ext === 's') return 'asm';
  if (ext === 'sol') return 'solidity';

  return SHIKI_LANGUAGE_OVERRIDES[monacoLanguage] ?? monacoLanguage;
}

// ============================================================================
// File Grouping Utilities (for diff mode)
// ============================================================================

/**
 * Compare two file paths for tree ordering:
 * - Compare path segments left-to-right
 * - At each level, directories come before files
 * - Within same type, sort alphabetically (case-insensitive)
 */
function comparePathsTreeOrder(a: string, b: string): number {
  const partsA = a.split('/');
  const partsB = b.split('/');

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i];
    const partB = partsB[i];

    // If one path is shorter, it's a parent directory - comes first
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;

    const isLastA = i === partsA.length - 1;
    const isLastB = i === partsB.length - 1;

    // If at same depth, directory (not last) comes before file (last)
    if (isLastA !== isLastB) {
      return isLastA ? 1 : -1; // directory first
    }

    // Same type at this level, compare alphabetically
    const cmp = partA.localeCompare(partB, undefined, { sensitivity: 'base' });
    if (cmp !== 0) return cmp;
  }

  return 0;
}

/** Sort files by tree display order */
export function sortFilesByTreeOrder<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => comparePathsTreeOrder(a.path, b.path));
}

export function groupFilesByStage(files: FileChange[]): GroupedFiles {
  return {
    files: sortFilesByTreeOrder(files),
  };
}

export function shouldNavigateAfterDeletion(
  getCurrentViewer: () => { mode: FileViewerMode; workspaceId: string | null },
  deletionWorkspaceId: string,
  currentEditorPath: string | null,
  deletedPath: string
): boolean {
  const currentViewer = getCurrentViewer();
  return (
    currentViewer.workspaceId === deletionWorkspaceId &&
    currentViewer.mode === 'browse' &&
    (currentEditorPath === deletedPath || currentEditorPath?.startsWith(`${deletedPath}/`) === true)
  );
}

/** Get a flat ordered list of all composite file keys in tree order */
export function getFlatFileKeys(grouped: GroupedFiles): string[] {
  return grouped.files.map((file) => file.path);
}

// ============================================================================
// Change Navigation Utilities
// ============================================================================

export type ChangeNavAction =
  | { type: 'navigate'; index: number }
  | { type: 'switchFile'; fileKey: string; target: 'first' | 'last' };

/**
 * Determine the action for navigating to the next change in a diff.
 * Pass an empty allFileKeys array to disable cross-file navigation.
 */
export function getNextChangeAction(
  currentIndex: number,
  totalChanges: number,
  allFileKeys: string[],
  selectedFile: string | null
): ChangeNavAction | null {
  if (totalChanges > 0 && currentIndex < totalChanges - 1) {
    return { type: 'navigate', index: currentIndex + 1 };
  }
  if (allFileKeys.length === 0) return null;
  const curIdx = selectedFile ? allFileKeys.indexOf(selectedFile) : -1;
  const nextIdx = curIdx < allFileKeys.length - 1 ? curIdx + 1 : 0;
  return { type: 'switchFile', fileKey: allFileKeys[nextIdx], target: 'first' };
}

/**
 * Determine the action for navigating to the previous change in a diff.
 * Pass an empty allFileKeys array to disable cross-file navigation.
 */
export function getPrevChangeAction(
  currentIndex: number,
  totalChanges: number,
  allFileKeys: string[],
  selectedFile: string | null
): ChangeNavAction | null {
  if (totalChanges > 0 && currentIndex > 0) {
    return { type: 'navigate', index: currentIndex - 1 };
  }
  if (allFileKeys.length === 0) return null;
  const curIdx = selectedFile ? allFileKeys.indexOf(selectedFile) : -1;
  const prevIdx = curIdx > 0 ? curIdx - 1 : allFileKeys.length - 1;
  return { type: 'switchFile', fileKey: allFileKeys[prevIdx], target: 'last' };
}

export function getAncestorPaths(filePath: string): string[] {
  const parts = filePath.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

// ============================================================================
// File Name Utilities
// ============================================================================

export function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

export function getDirPath(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

/**
 * For paths that share a file name, the shortest trailing folder path that tells
 * them apart ("utils", or "web/src" when the parent folders match too). Paths
 * with a unique file name are left out.
 */
export function getSameNameFolderHints(paths: readonly string[]): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const path of Array.from(new Set(paths))) {
    const name = getFileName(path);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const hints = new Map<string, string>();
  for (const group of Array.from(byName.values())) {
    if (group.length < 2) continue;
    const folders = group.map((path) => getDirPath(path).split('/').filter(Boolean));
    const deepest = Math.max(...folders.map((segments) => segments.length));
    for (let depth = 1; depth <= deepest; depth++) {
      const suffixes = folders.map((segments) => segments.slice(-depth).join('/'));
      if (new Set(suffixes).size === suffixes.length || depth === deepest) {
        group.forEach((path, index) => {
          if (suffixes[index]) hints.set(path, suffixes[index]);
        });
        break;
      }
    }
  }
  return hints;
}

// ============================================================================
// Diff Editor Key Utilities
// ============================================================================

/**
 * Check whether diff content has changed compared to the previous snapshot.
 * Used to decide whether to bump a content-version counter that forces a
 * DiffEditor remount (avoiding a Monaco race where an in-flight async diff
 * references stale line numbers after a model update).
 */
export function hasContentChanged(
  prev: { old: string; new: string } | null,
  oldContent: string,
  newContent: string
): boolean {
  return prev?.old !== oldContent || prev?.new !== newContent;
}

/**
 * Build the React `key` for a DiffEditor instance.  Changing the key forces
 * React to unmount and remount the editor, which is how we work around
 * Monaco's async-diff race condition.
 *
 * The caller is responsible for deciding which content version to use in the
 * key. In DiffPane we latch the most recent clean content version so local
 * edits don't force a remount when dirty state flips on.
 */
export function buildDiffEditorKey(params: {
  selectedFile: string | null;
  filePath: string;
  viewMode: ViewMode;
  hideUnchangedRegions: boolean;
  contentVersion: number;
}): string {
  return `${params.selectedFile ?? params.filePath}:${params.viewMode}:${params.hideUnchangedRegions ? 'hide' : 'show'}:v${params.contentVersion}`;
}

/**
 * Decide what side effects an editor `onChange` should produce. Monaco fires
 * `onDidChangeModelContent` for non-edits too (EOL normalization on load,
 * programmatic value sync when switching files, vim attach), so we must
 * compare against the on-disk baseline before flipping dirty state or
 * promoting a preview tab.
 */
export function computeEditorChangeEffects(params: {
  content: string;
  diskContent: string | null;
  mode: FileViewerMode;
  filePath: string | null;
  previewPath: string | null;
}): { isDirty: boolean; promotePreview: boolean } {
  const isDirty = params.content !== params.diskContent;
  const promotePreview =
    isDirty &&
    params.mode === 'browse' &&
    params.filePath !== null &&
    params.previewPath === params.filePath;
  return { isDirty, promotePreview };
}

/** The parts of a Monaco text model `computeReloadEdit` reads. */
export type ReloadEditModel = Pick<
  monacoEditor.ITextModel,
  'getLineCount' | 'getLineContent' | 'getLineMaxColumn' | 'getEOL'
>;

/**
 * The single edit that turns the model's text into `next`, leaving the unchanged lines at the
 * head and tail alone so the cursor, folds and decorations there survive. VS Code applies a
 * file changed on disk the same way. New lines end with `eol`. Null when the lines already match.
 */
export function computeReloadEdit(
  model: ReloadEditModel,
  next: string,
  eol = model.getEOL()
): { range: IRange; text: string; forceMoveMarkers: true } | null {
  // Monaco drops a leading byte order mark when it makes a model, so the model never has one.
  const nextLines = next.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const oldCount = model.getLineCount();
  const newCount = nextLines.length;

  let prefix = 0;
  while (
    prefix < oldCount &&
    prefix < newCount &&
    model.getLineContent(prefix + 1) === nextLines[prefix]
  ) {
    prefix++;
  }
  if (prefix === oldCount && prefix === newCount) return null;

  let suffix = 0;
  while (
    suffix < oldCount - prefix &&
    suffix < newCount - prefix &&
    model.getLineContent(oldCount - suffix) === nextLines[newCount - 1 - suffix]
  ) {
    suffix++;
  }

  const changed = nextLines.slice(prefix, newCount - suffix);
  if (suffix > 0) {
    // Whole lines, each with its line break, ending at the start of the unchanged tail.
    return {
      range: range(prefix + 1, 1, oldCount - suffix + 1, 1),
      text: changed.map((line) => line + eol).join(''),
      forceMoveMarkers: true,
    };
  }
  if (prefix > 0) {
    // From the end of the last unchanged line to the end of the text.
    return {
      range: range(
        prefix,
        model.getLineMaxColumn(prefix),
        oldCount,
        model.getLineMaxColumn(oldCount)
      ),
      text: changed.map((line) => eol + line).join(''),
      forceMoveMarkers: true,
    };
  }
  return {
    range: range(1, 1, oldCount, model.getLineMaxColumn(oldCount)),
    text: changed.join(eol),
    forceMoveMarkers: true,
  };
}

/**
 * The end of line Monaco gives a model made from `text`: CRLF when most line breaks carry a
 * carriage return. Null for text without line breaks, which keeps whatever the model has.
 */
export function detectEndOfLine(text: string): '\n' | '\r\n' | null {
  let lineBreaks = 0;
  let carriageReturns = 0;
  for (const [lineBreak] of text.matchAll(/\r\n|\r|\n/g)) {
    lineBreaks++;
    if (lineBreak !== '\n') carriageReturns++;
  }
  if (lineBreaks === 0) return null;
  return carriageReturns > lineBreaks / 2 ? '\r\n' : '\n';
}

function range(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number
): IRange {
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

// ============================================================================
// @path:line Formatting
// ============================================================================

/**
 * Build an `@path` or `@path:line(s)` string from a Monaco editor.
 * Line numbers are only included when the user has an active selection.
 */
export function formatAtPathWithLine(filePath: string, editor: monacoEditor.ICodeEditor): string {
  const selection = editor.getSelection();
  if (selection && !selection.isEmpty()) {
    const startLine = selection.startLineNumber;
    const endLine = selection.endLineNumber;
    if (startLine === endLine) {
      return `@${filePath}:${startLine}`;
    }
    return `@${filePath}:${startLine}-${endLine}`;
  }
  return `@${filePath}`;
}

/**
 * The text of a Monaco editor that is still mounted. A view switch (Rich text,
 * Browser) disposes it, and a disposed editor reads as empty, which a save
 * would write over the file.
 */
export function readMountedEditor(
  editor: monacoEditor.ICodeEditor | null | undefined
): string | undefined {
  return editor?.getModel() ? editor.getValue() : undefined;
}

/**
 * Returns true when the Monaco editor has a non-empty text selection.
 */
export function hasSelectedText(editor: monacoEditor.ICodeEditor | null | undefined): boolean {
  const selection = editor?.getSelection();
  return !!selection && !selection.isEmpty();
}

// ============================================================================
// Monaco Built-in Language Intelligence
// ============================================================================

/**
 * Languages whose Monaco workers provide useful built-in intelligence
 * (validation, completions, formatting) without needing an external LSP.
 * TS/JS are excluded because their workers need type definitions and
 * tsconfig loaded into Monaco's virtual filesystem to be useful.
 */
const LANGUAGES_WITH_BUILTIN_INTELLIGENCE = new Set([
  'json',
  'css',
  'scss',
  'less',
  'html',
  'handlebars',
  'razor',
]);

/**
 * Returns true if the given Monaco language ID has useful built-in
 * intelligence from Monaco's bundled workers.
 */
export function hasBuiltInLanguageIntelligence(language: string): boolean {
  return LANGUAGES_WITH_BUILTIN_INTELLIGENCE.has(language);
}

// ============================================================================
// Monaco Context Menu Cleanup
// ============================================================================

/**
 * Built-in Monaco actions that require an LSP (go-to-definition,
 * find references, etc.) and do nothing useful without one.  We remove these
 * from the context menu so users aren't presented with non-functional items.
 */
const NON_FUNCTIONAL_ACTION_IDS = [
  'editor.action.revealDefinition',
  'editor.action.revealDeclaration',
  'editor.action.goToTypeDefinition',
  'editor.action.goToImplementation',
  'editor.action.referenceSearch.trigger',
  'editor.action.peekDefinition',
  'editor.action.peekTypeDefinition',
  'editor.action.peekImplementation',
  'editor.action.rename',
  'editor.action.quickOutline',
  'editor.action.changeAll',
];

/**
 * Remove context-menu entries that depend on language services we don't enable.
 * Safe to call on any standalone editor — silently skips actions that don't exist.
 */
export function removeNonFunctionalActions(editor: monacoEditor.IStandaloneCodeEditor): void {
  for (const id of NON_FUNCTIONAL_ACTION_IDS) {
    const action = editor.getAction(id);
    // Monaco actions returned by getAction() don't have a public remove API,
    // but we can override them with a no-op that has no context-menu group,
    // which effectively hides them from the menu.
    if (action) {
      editor.addAction({
        id,
        label: action.label,
        run: () => {},
        // Omitting contextMenuGroupId removes it from the context menu
      });
    }
  }
}
