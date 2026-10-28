import { isShortcutEventClaimed } from '@/lib/shortcut-claims';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import { getFlatFileKeys, formatAtPathWithLine } from './file-viewer-utils';

import type { FileViewerMode, ViewMode, GroupedFiles } from './types';
import type { editor as monacoEditor } from 'monaco-editor';

export type ToastVariant = 'success' | 'info' | 'error';

export interface FileViewerKeyboardContext {
  mode: FileViewerMode;
  diffSubMode: 'changes' | 'history';
  isGitWorkspace: boolean;
  editorFilePath: string | null;
  diffSelectedFile: string | null;
  diffGrouped: GroupedFiles;
  historyFilePaths: string[];
  historySelectedFile: string | null;
  currentFilePathRef: { current: string | null };
  monacoEditorRef: { current: monacoEditor.IStandaloneCodeEditor | null };
  diffEditorRef: { current: monacoEditor.IStandaloneDiffEditor | null };
  closeTabRef: { current: (path: string) => void };
  closeViewer: () => void;
  saveFile: () => void | Promise<void>;
  setSidebarOpen: (updater: (prev: boolean) => boolean) => void;
  handleModeChange: (mode: FileViewerMode) => void;
  goToNextChange: () => void;
  goToPreviousChange: () => void;
  handleDiffFileNavigate: (key: string) => void;
  setFileToDelete: (path: string) => void;
  setDiffViewMode: (mode: ViewMode) => void;
  handleHistoryFileNavigate: (path: string) => void;
  setHistoryViewMode: (mode: ViewMode) => void;
  copyToClipboard: (text: string) => void;
  showToast: (message: string, variant: ToastVariant) => void;
  getSelection: () => string;
  getActiveElement: () => Element | null;
}

/**
 * Monaco, the vim status bar and the rich Markdown editor while its find bar is open use Escape
 * themselves, to close the find bar or suggestions or to leave insert mode, and stop it from
 * propagating when they do.
 */
export function isEditorEscapeTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (typeof element?.closest !== 'function') return false;
  return !!(
    element.closest('.monaco-editor') ||
    element.closest('[data-vim-status-bar]') ||
    element.closest('[data-markdown-find-open]')
  );
}

/** Display form of the Mod+B sidebar toggle handled in handleAcceleratorShortcut. */
export function getSidebarToggleShortcutLabel(
  platform = typeof window !== 'undefined' ? window.api?.platform : undefined
): string {
  return formatShortcutForDisplay('Cmd+B', platform);
}

function getActiveMonacoEditor(ctx: FileViewerKeyboardContext): monacoEditor.ICodeEditor | null {
  if (ctx.mode === 'browse') {
    return ctx.monacoEditorRef.current?.hasTextFocus() ? ctx.monacoEditorRef.current : null;
  }
  if (!ctx.diffEditorRef.current) return null;
  const modified = ctx.diffEditorRef.current.getModifiedEditor();
  if (modified.hasTextFocus()) return modified;
  const original = ctx.diffEditorRef.current.getOriginalEditor();
  return original.hasTextFocus() ? original : null;
}

function handleCopyAtPath(e: KeyboardEvent, ctx: FileViewerKeyboardContext): void {
  const filePath = ctx.currentFilePathRef.current;
  if (!filePath) return;
  e.preventDefault();

  let activeEditor: monacoEditor.ICodeEditor | null = null;
  if (ctx.mode === 'browse') {
    activeEditor = ctx.monacoEditorRef.current;
  } else if (ctx.diffEditorRef.current) {
    const modified = ctx.diffEditorRef.current.getModifiedEditor();
    const original = ctx.diffEditorRef.current.getOriginalEditor();
    activeEditor = modified.hasTextFocus()
      ? modified
      : original.hasTextFocus()
        ? original
        : modified;
  }

  if (activeEditor) {
    const atPath = formatAtPathWithLine(filePath, activeEditor);
    ctx.copyToClipboard(atPath);
    ctx.showToast(`Copied ${atPath}`, 'success');
  }
}

function isHistoryMode(ctx: FileViewerKeyboardContext): boolean {
  return ctx.mode === 'diff' && ctx.diffSubMode === 'history';
}

function handleCopyFileAnnotation(e: KeyboardEvent, ctx: FileViewerKeyboardContext): void {
  const currentPath = isHistoryMode(ctx)
    ? ctx.historySelectedFile
    : ctx.mode === 'diff'
      ? ctx.diffSelectedFile
      : ctx.editorFilePath;
  // When Monaco has focus, defer to its built-in Cmd+C: copies the selection,
  // or the current line when nothing is selected. The @path shortcut is only
  // for focus outside the editor (sidebar, header, etc.).
  if (getActiveMonacoEditor(ctx) || ctx.getSelection() || !currentPath) return;
  e.preventDefault();
  // Trailing space for immediate continued typing after paste.
  ctx.copyToClipboard(`@${currentPath} `);
  ctx.showToast(`Copied @${currentPath}`, 'success');
}

function handleAcceleratorShortcut(
  e: KeyboardEvent,
  key: string,
  ctx: FileViewerKeyboardContext
): boolean {
  switch (key) {
    case 's':
      e.preventDefault();
      void ctx.saveFile();
      return true;
    case 'b':
      e.preventDefault();
      ctx.setSidebarOpen((prev) => !prev);
      return true;
    case '1':
      e.preventDefault();
      ctx.handleModeChange('browse');
      return true;
    case '2':
      e.preventDefault();
      if (ctx.isGitWorkspace) ctx.handleModeChange('diff');
      return true;
    case 'w':
      e.preventDefault();
      if (ctx.mode === 'browse' && ctx.editorFilePath) {
        ctx.closeTabRef.current(ctx.editorFilePath);
      }
      return true;
    case 'c':
      if (e.shiftKey) handleCopyAtPath(e, ctx);
      else handleCopyFileAnnotation(e, ctx);
      return true;
    default:
      return false;
  }
}

/** True when keys typed now would insert text, so plain-letter shortcuts must not take them. */
function isTypingTarget(ctx: FileViewerKeyboardContext): boolean {
  const active = ctx.getActiveElement();
  if (!active) return false;
  // The editor's own text types only when editable; its Find box, an input in it, always does.
  const editor = active.closest('.monaco-editor') ? getActiveMonacoEditor(ctx) : null;
  if (editor) return !editor.getRawOptions().readOnly;
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';
}

/** Alt+F5 / Shift+Alt+F5, as in VS Code, navigate changes from anywhere, editable editor included. */
function handleChangeNavigationChord(e: KeyboardEvent, ctx: FileViewerKeyboardContext): boolean {
  if (e.key !== 'F5' || !e.altKey || e.metaKey || e.ctrlKey) return false;
  e.preventDefault();
  if (e.shiftKey) ctx.goToPreviousChange();
  else ctx.goToNextChange();
  return true;
}

function handleChangeNavigation(e: KeyboardEvent, ctx: FileViewerKeyboardContext): boolean {
  if (e.key === 'n' || e.key === ']') {
    e.preventDefault();
    ctx.goToNextChange();
    return true;
  }
  if (e.key === 'p' || e.key === '[') {
    e.preventDefault();
    ctx.goToPreviousChange();
    return true;
  }
  return false;
}

function handleViewModeToggle(e: KeyboardEvent, ctx: FileViewerKeyboardContext): boolean {
  const setViewMode = isHistoryMode(ctx) ? ctx.setHistoryViewMode : ctx.setDiffViewMode;
  if (e.key === '1') {
    e.preventDefault();
    setViewMode('split');
    return true;
  }
  if (e.key === '2') {
    e.preventDefault();
    setViewMode('unified');
    return true;
  }
  return false;
}

function handleFileListNavigation(
  e: KeyboardEvent,
  paths: string[],
  current: string | null,
  navigate: (path: string) => void
): boolean {
  if (paths.length === 0) return false;
  const currentIndex = current ? paths.indexOf(current) : -1;
  switch (e.key) {
    case 'ArrowDown':
    case 'j': {
      e.preventDefault();
      navigate(paths[currentIndex < paths.length - 1 ? currentIndex + 1 : 0]);
      return true;
    }
    case 'ArrowUp':
    case 'k': {
      e.preventDefault();
      navigate(paths[currentIndex > 0 ? currentIndex - 1 : paths.length - 1]);
      return true;
    }
    default:
      return false;
  }
}

function handleHistoryFileNavigation(e: KeyboardEvent, ctx: FileViewerKeyboardContext): void {
  // The working-tree Changes list is hidden in History, so arrows move through
  // the selected commit's files and Delete has no target.
  handleFileListNavigation(
    e,
    ctx.historyFilePaths,
    ctx.historySelectedFile,
    ctx.handleHistoryFileNavigate
  );
}

function handleDiffFileNavigation(e: KeyboardEvent, ctx: FileViewerKeyboardContext): void {
  const allPaths = getFlatFileKeys(ctx.diffGrouped);
  if (allPaths.length === 0) return;

  // Focus + scroll-into-view for the new selection are handled by
  // SidebarFileTree's `model.focusPath(currentFile)` effect, which fires when
  // handleDiffFileNavigate updates the selected diff file.
  if (handleFileListNavigation(e, allPaths, ctx.diffSelectedFile, ctx.handleDiffFileNavigate)) {
    return;
  }
  switch (e.key) {
    case 'Delete':
    case 'Backspace': {
      e.preventDefault();
      if (ctx.diffSelectedFile) {
        const selPath = ctx.diffSelectedFile;
        const file = ctx.diffGrouped.files.find((f) => f.path === selPath);
        if (file) ctx.setFileToDelete(file.path);
      }
      break;
    }
  }
}

export function dispatchFileViewerKeydown(e: KeyboardEvent, ctx: FileViewerKeyboardContext): void {
  // A dialog opened over the file viewer, such as the new workspace dialog, already handled it.
  if (isShortcutEventClaimed(e)) return;
  // The dialog closes on Escape elsewhere; Escape aimed at the editor gets here only if the
  // editor had nothing to dismiss.
  if (e.key === 'Escape') {
    if (isEditorEscapeTarget(ctx.getActiveElement())) ctx.closeViewer();
    return;
  }

  const key = e.key.toLowerCase();

  if ((e.metaKey || e.ctrlKey) && handleAcceleratorShortcut(e, key, ctx)) return;

  if (ctx.mode === 'diff' && handleChangeNavigationChord(e, ctx)) return;

  // Change-navigation shortcuts work even when a read-only Monaco side is focused
  if (
    ctx.mode === 'diff' &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !isTypingTarget(ctx) &&
    handleChangeNavigation(e, ctx)
  ) {
    return;
  }

  // Below shortcuts only when focus is outside editor/input
  const active = ctx.getActiveElement();
  if (
    active?.closest('.monaco-editor') ||
    active?.tagName === 'INPUT' ||
    active?.tagName === 'TEXTAREA'
  ) {
    return;
  }

  if (ctx.mode === 'diff' && !e.metaKey && !e.ctrlKey && handleViewModeToggle(e, ctx)) return;

  if (isHistoryMode(ctx)) handleHistoryFileNavigation(e, ctx);
  else if (ctx.mode === 'diff') handleDiffFileNavigation(e, ctx);
}
