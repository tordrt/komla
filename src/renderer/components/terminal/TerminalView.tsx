import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import '@xterm/xterm/css/xterm.css';

import { Spinner } from '@/components/ui/spinner';
import { getDetector, configKeyToEventKey } from '@/lib/double-tap-detector';
import { hasFileDrop } from '@/lib/file-drop';
import { openTerminalUrl } from '@/lib/open-terminal-url';
import {
  buildTerminalTheme,
  getPaletteTerminalBackground,
  useActivePalette,
} from '@/lib/palette-runtime';
import { notePrintedHyperlink } from '@/lib/recent-links';
import { executeShortcutAction, registerShortcutAction } from '@/lib/shortcut-actions';
import { decodeOsc52Clipboard } from '@/lib/terminal-osc-clipboard';
import {
  attachTerminalRenderer,
  clearTerminalRendererClipboard,
  configureTerminalRendererClipboard,
  detachTerminalRenderer,
  focusTerminalRenderer,
  getTerminalRendererHoveredLink,
  getTerminalRendererSelection,
  pasteIntoTerminalRenderer,
  scrollTerminalRendererToBottom,
  setTerminalRendererVisible,
  takeTerminalRendererProgramRightClick,
  updateTerminalRendererConfiguration,
  updateTerminalRendererContext,
} from '@/lib/terminal-renderer-runtime';
import { terminalWindowsPtyOptions } from '@/lib/terminal-windows-pty';
import { AT_PATH_MIME, consumeTreeDragActive, isTreeDragActive } from '@/lib/tree-drag-token';
import { terminalHyperlinkTarget, type TerminalDetectedLink } from '@/lib/xterm-url-links';
import { useConfigStore } from '@/stores/config.store';
import { useCustomizationStore } from '@/stores/customization.store';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useQuickLookStore, type QuickLookItem } from '@/stores/quick-look.store';
import {
  useShortcutsStore,
  isDoubleTapShortcut,
  formatShortcutForDisplay,
} from '@/stores/shortcuts.store';
import {
  queuePrintedFileHyperlink,
  setTerminalFileLinkContext,
  useTerminalFilesStore,
} from '@/stores/terminal-files.store';
import { useTerminalSearchStore } from '@/stores/terminal-search.store';
import { useToastStore } from '@/stores/toast.store';
import { useVoiceStore } from '@/stores/voice.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isNewWorkspaceDialogShortcut } from '../../../shared/constants/shortcut-scopes';
import { buildTerminalFontFamily } from '../../../shared/constants/terminal';
import { isBrowserUrl, isLocalPageUrl, isSignInPageUrl } from '../../../shared/lib/browser-tabs';
import { normalizeLocalDevServerUrl } from '../../../shared/lib/loopback-url';
import {
  isLocalTerminalExecutionLocation,
  type TerminalExecutionLocation,
} from '../../../shared/types/terminal';

import { filePanelShows, openInFilePanel } from './file-panel';
import { TerminalSearchBar } from './TerminalSearchBar';
import { endTmuxFindForTyping } from './useTmuxFind';

import type { AppConfig } from '@/types';

interface TerminalViewProps {
  terminalId: string;
  isActive: boolean;
  isTabActive: boolean;
  workingDirectory?: string;
  fileLinkWorkspaceRoot?: string;
  workspaceId?: string;
  executionLocation?: TerminalExecutionLocation;
  workspaceBackendKind?: 'local' | 'ssh';
  allowOsc52Clipboard?: boolean;
  copyOnSelect?: boolean;
  /** The search bar searches tmux, which holds the history Komla's renderer never gets. */
  searchesInTmux?: boolean;
  onTitleChange?: (title: string) => void;
  onLinkContextMenu?: (link: TerminalContextMenuLink | null) => void;
}

export type TerminalContextMenuLink =
  | { type: 'url'; url: string }
  | {
      type: 'file';
      target: TerminalFileOpenTarget['type'];
      filePath: string;
      rawPath: string;
      lineNumber?: number;
      /** Opens the link where a click does. */
      open: () => void;
    };

export type TerminalFileOpenTarget =
  | { type: 'workspace'; filePath: string }
  /** A path outside the workspace, which the file viewer reads where the terminal runs. */
  | { type: 'external'; fullPath: string };

type MacBackwardKillWordKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'code' | 'altKey' | 'metaKey' | 'ctrlKey'
>;
type AltArrowWordJumpKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'
>;
type TerminalEditKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'preventDefault'
>;
type TerminalFileLinkClickEvent = Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>;
type TerminalUrlLinkClickEvent = Pick<MouseEvent, 'button' | 'ctrlKey'>;
type TerminalPasteOptions = {
  workspaceId?: string;
  executionLocation?: TerminalExecutionLocation;
  canImportClipboardImage?: boolean;
};

export function shouldOpenTerminalFileLink(
  platform: string | undefined,
  event: TerminalFileLinkClickEvent
): boolean {
  if (event.button !== 0) return false;
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey;
}

export function shouldOpenTerminalUrlLink(
  platform: string | undefined,
  event: TerminalUrlLinkClickEvent
): boolean {
  return event.button === 0 && !(platform === 'darwin' && event.ctrlKey);
}

export interface TerminalUrlOpenOptions {
  /** Where a click opens a link to a web page. */
  webLinkOpenTarget?: AppConfig['webLinkOpenTarget'];
  /** False in a terminal without a workspace, which has no browser to open links in. */
  canOpenInKomla?: boolean;
}

/**
 * Where a click opens a terminal link: web pages where the setting says (automatically:
 * localhost in Komla, other sites externally), sign-in pages externally, and Shift+click
 * the other way. Anything else opens externally.
 */
export function resolveTerminalUrlOpenTarget(
  url: string,
  shiftKey: boolean,
  { webLinkOpenTarget = 'auto', canOpenInKomla = true }: TerminalUrlOpenOptions = {}
): 'preview' | 'external' {
  const normalized = normalizeLocalDevServerUrl(url);
  if (!canOpenInKomla || !isBrowserUrl(normalized)) return 'external';
  const target = defaultTerminalUrlTarget(normalized, webLinkOpenTarget);
  return (target === 'komla') !== shiftKey ? 'preview' : 'external';
}

function defaultTerminalUrlTarget(
  url: string,
  webLinkOpenTarget: NonNullable<AppConfig['webLinkOpenTarget']>
): 'komla' | 'external' {
  // So signing in to a CLI happens where you're already signed in.
  if (isSignInPageUrl(url)) return 'external';
  if (webLinkOpenTarget !== 'auto') return webLinkOpenTarget;
  return isLocalPageUrl(url) ? 'komla' : 'external';
}

export function syncTerminalLinkHoverTitle(
  element: HTMLElement | undefined,
  platform: string | undefined,
  link: TerminalDetectedLink | null,
  options: TerminalUrlOpenOptions = {}
): void {
  if (!element) return;
  if (link?.type === 'file') {
    const action = isFolderPath(link.filePath) ? 'open folder' : 'open file';
    element.title = `${formatShortcutForDisplay('Cmd+Click', platform)} to ${action}`;
  } else if (
    link?.type === 'url' &&
    resolveTerminalUrlOpenTarget(link.url, false, options) !==
      resolveTerminalUrlOpenTarget(link.url, true, options)
  ) {
    const shiftClick = formatShortcutForDisplay('Shift+Click', platform);
    element.title =
      resolveTerminalUrlOpenTarget(link.url, false, options) === 'preview'
        ? `Click to open in Komla · ${shiftClick} to open externally`
        : isSignInPageUrl(link.url)
          ? `Click to open this sign-in page externally · ${shiftClick} to open in Komla`
          : `Click to open externally · ${shiftClick} to open in Komla`;
  } else {
    element.removeAttribute('title');
  }
}

function normalizeTerminalFileLinkPath(
  rawPath: string,
  workingDirectory: string | undefined,
  caseInsensitive: boolean
): string | null {
  const isWindowsWorkspaceRoot = /^[A-Za-z]:[\\/]/.test(workingDirectory ?? '');
  let filePath = rawPath.replace(/\\/g, '/');
  const workspaceRoot = workingDirectory?.replace(/\\/g, '/').replace(/\/+$/, '');

  if (filePath.startsWith('./')) {
    filePath = filePath.slice(2);
  }

  if (/^[A-Za-z]:\//.test(filePath) || filePath.startsWith('/')) {
    if (!workspaceRoot) return null;

    const comparisonPath =
      isWindowsWorkspaceRoot || caseInsensitive ? filePath.toLowerCase() : filePath;
    const comparisonRoot =
      isWindowsWorkspaceRoot || caseInsensitive ? workspaceRoot.toLowerCase() : workspaceRoot;
    if (!comparisonPath.startsWith(`${comparisonRoot}/`)) return null;
    filePath = filePath.slice(workspaceRoot.length + 1);
  }

  if (
    !filePath ||
    filePath.startsWith('~/') ||
    filePath === '..' ||
    filePath.startsWith('../') ||
    filePath.includes('/../')
  ) {
    return null;
  }

  return filePath;
}

export function resolveTerminalFileOpenTarget(
  rawPath: string,
  workingDirectory: string | undefined,
  platform: string | undefined,
  workspaceBackendKind: 'local' | 'ssh' = 'local',
  executionLocation?: TerminalExecutionLocation
): TerminalFileOpenTarget | null {
  const isHostLocalPath = workspaceBackendKind === 'local' || executionLocation === 'local-mirror';
  const workspacePath = normalizeTerminalFileLinkPath(
    rawPath,
    workingDirectory,
    platform === 'darwin' && isHostLocalPath
  );
  if (workspacePath) return { type: 'workspace', filePath: workspacePath };

  const isSupportedPlatform = platform === 'darwin' || platform === 'linux';
  // A path in the home folder stays as printed, since it's read where the terminal runs.
  const isTerminalPath = rawPath.startsWith('/') || rawPath.startsWith('~/');
  if (!isSupportedPlatform || !isTerminalPath || rawPath.includes('\0')) {
    return null;
  }

  return { type: 'external', fullPath: rawPath };
}

export interface TerminalFileLinkContext {
  workspaceId?: string;
  workspaceRoot?: string;
  workingDirectory?: string;
  workspaceBackendKind: 'local' | 'ssh';
  executionLocation?: TerminalExecutionLocation;
}

export function resolveTerminalFileLink(
  rawPath: string,
  context: TerminalFileLinkContext,
  platform: string | undefined
): TerminalFileOpenTarget | null {
  return resolveTerminalFileOpenTarget(
    rawPath,
    context.workspaceRoot,
    platform,
    context.workspaceBackendKind,
    context.executionLocation
  );
}

/** A host terminal's path on this computer, with ~/ for the home folder expanded. */
function hostTerminalPath(fullPath: string): string | undefined {
  if (!fullPath.startsWith('~/')) return fullPath;
  const home = window.api?.homeDir;
  return home ? `${home.replace(/\/$/, '')}/${fullPath.slice(2)}` : undefined;
}

/** The file viewer item for a link: the path as printed, read where it is. */
export function terminalLinkViewerItem(
  path: string,
  lineNumber: number | undefined,
  target: TerminalFileOpenTarget,
  terminalId: string,
  context: TerminalFileLinkContext
): QuickLookItem {
  const line = lineNumber === undefined ? {} : { lineNumber };
  if (target.type === 'workspace') {
    const hostRoot =
      context.workspaceBackendKind === 'local' ? context.workingDirectory : undefined;
    return {
      path,
      terminalId,
      source: { kind: 'workspace', filePath: target.filePath },
      hostPath: hostRoot ? `${hostRoot.replace(/[\\/]$/, '')}/${target.filePath}` : undefined,
      ...line,
    };
  }
  const isHostTerminal =
    context.workspaceBackendKind === 'local' || context.executionLocation === 'local-mirror';
  return {
    path,
    terminalId,
    source: { kind: 'terminal', fullPath: target.fullPath },
    hostPath: isHostTerminal ? hostTerminalPath(target.fullPath) : undefined,
    ...line,
  };
}

/**
 * Whether the workspace's file tree would list a folder, going by its file list: a folder of a
 * listed file, a listed empty folder, or a listed ignored folder while ignored files show.
 * Before the list loads, it may well.
 */
function fileTreeListsFolder(
  workspaceId: string,
  workingDirectory: string | undefined,
  folder: string
): boolean {
  const list = workingDirectory
    ? useFileListStore.getState().getFileList(workingDirectory)
    : undefined;
  if (!list || (list.isLoading && list.files.length === 0)) return true;
  const prefix = `${folder}/`;
  const lists = (paths: string[]) => paths.some((path) => path.startsWith(prefix));
  const showsIgnored = !!useFileViewerStore.getState().showGitIgnoredByWorkspace[workspaceId];
  return (
    lists(list.files) ||
    list.emptyDirs.some((dir) => dir === folder || dir === prefix) ||
    (showsIgnored && lists(list.gitIgnoredFiles))
  );
}

/**
 * Opens a terminal file link. Workspace files open in the file panel, unless it can't show them,
 * and workspace folders the file tree lists in the file tree. Everything else opens in the file
 * viewer, which reads paths outside the workspace where the terminal runs instead of copying them
 * into the workspace.
 */
export function openTerminalFileLink(
  rawPath: string,
  lineNumber: number | undefined,
  target: TerminalFileOpenTarget | null,
  terminalId: string,
  context: TerminalFileLinkContext
): void {
  const { workspaceId } = context;
  if (!workspaceId) return;
  if (!target) {
    if (isFolderPath(rawPath)) {
      useToastStore
        .getState()
        .addToast(`Couldn't open ${rawPath}: Komla can't tell where this folder is`, 'error');
    }
    return;
  }
  useTerminalFilesStore
    .getState()
    .noteOpened(workspaceId, { path: rawPath, lineNumber, terminalId, target, context });
  if (target.type === 'workspace') {
    const fileViewer = useFileViewerStore.getState();
    const folder = isFolderPath(target.filePath) ? target.filePath.slice(0, -1) : null;
    // The full viewer covers the file tree, so a folder opens in quick look over it.
    if (
      folder !== null &&
      fileViewer.fileViewerWorkspaceId !== workspaceId &&
      fileTreeListsFolder(workspaceId, context.workingDirectory, folder)
    ) {
      fileViewer.revealInFileTree(workspaceId, folder);
      return;
    }
    if (folder === null && filePanelShows(target.filePath, context.workspaceBackendKind)) {
      openInFilePanel(workspaceId, target.filePath, lineNumber);
      return;
    }
  }
  useQuickLookStore
    .getState()
    .open(workspaceId, terminalLinkViewerItem(rawPath, lineNumber, target, terminalId, context));
}

/** Whether a link is to a folder, which a terminal prints with a trailing separator. */
function isFolderPath(filePath: string): boolean {
  return /[\\/]$/.test(filePath);
}

export function shouldSendMacBackwardKillWord(
  platform: string | undefined,
  event: MacBackwardKillWordKeyEvent
): boolean {
  return (
    platform === 'darwin' &&
    event.type === 'keydown' &&
    (event.code === 'Backspace' || event.key === 'Backspace' || event.key === 'Delete') &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey
  );
}

export function getAltArrowWordJumpInput(
  platform: string | undefined,
  event: AltArrowWordJumpKeyEvent
): string | null {
  if (
    event.type !== 'keydown' ||
    !event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey
  ) {
    return null;
  }

  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return null;
  }

  if (platform === 'darwin') {
    return event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf';
  }

  return event.key === 'ArrowLeft' ? '\x1b[1;5D' : '\x1b[1;5C';
}

export function getTerminalClipboardShortcutAction(
  platform: string | undefined,
  event: TerminalEditKeyEvent
): 'copy' | 'paste' | null {
  if (event.type !== 'keydown' || event.altKey) return null;
  const usesPrimaryModifier =
    platform === 'darwin'
      ? event.metaKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!usesPrimaryModifier) return null;

  const key = event.key.toLowerCase();
  if (key === 'c') return 'copy';
  if (key === 'v') return 'paste';
  return null;
}

/** Imports land in `.komla-files`, which the Remote Companion ignores, so re-list the tree. */
function refreshFileListAfterImport(workspaceId: string): void {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;
  void useFileListStore
    .getState()
    .fetchFileList(workspace.workingDirectory, false, workspaceId)
    .catch(() => undefined);
}

export async function pasteClipboardIntoTerminal(
  terminalId: string,
  options: TerminalPasteOptions = {}
): Promise<void> {
  const text = await window.api.readFromClipboard();
  if (text) {
    pasteIntoTerminalRenderer(terminalId, text);
    return;
  }

  if (
    isLocalTerminalExecutionLocation(options.executionLocation) ||
    !options.canImportClipboardImage ||
    !options.workspaceId
  ) {
    return;
  }

  const imagePath = await window.api.importClipboardImage(
    options.workspaceId,
    options.executionLocation
  );
  if (!imagePath) return;

  refreshFileListAfterImport(options.workspaceId);
  window.api.sendInput(terminalId, `@${imagePath} `);
  focusTerminalRenderer(terminalId);
}

function handleTerminalClipboardShortcut(
  terminalId: string,
  event: KeyboardEvent,
  options: TerminalPasteOptions = {}
): boolean {
  const action = getTerminalClipboardShortcutAction(window.api?.platform, event);
  if (!action) return false;

  if (action === 'copy') {
    const selection = getTerminalRendererSelection(terminalId);
    if (!selection) return false;
    event.preventDefault();
    window.api.copyToClipboard(selection);
  } else if (action === 'paste') {
    event.preventDefault();
    void pasteClipboardIntoTerminal(terminalId, options).catch((err) => {
      console.warn('Failed to paste clipboard into terminal:', err);
    });
  }

  return true;
}

/**
 * Create a custom key event handler for xterm terminals.
 * Handles platform-specific shortcuts (Option+Backspace on macOS, Shift+Enter, Alt+Arrow)
 * plus shortcuts and double-tap detection from useShortcutsStore.
 */
function createTerminalKeyHandler(
  terminalId: string,
  xtermHandler: typeof xtermKeyHandler,
  getPasteOptions: () => TerminalPasteOptions = () => ({})
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent) => {
    if (handleTerminalClipboardShortcut(terminalId, event, getPasteOptions())) {
      return false;
    }

    // A key typed while tmux's search holds the pane ends the search first. Escape only ends it.
    const shortcuts = useShortcutsStore.getState().config?.shortcuts ?? {};
    if (
      isTerminalTypingKey(event, window.api.platform, shortcuts) &&
      endTmuxFindForTyping(terminalId) &&
      event.key === 'Escape'
    ) {
      event.preventDefault();
      return false;
    }

    // macOS: Option+Backspace → send Ctrl+W (backward-kill-word).
    // ESC+DEL (\x1b\x7f) is the standard sequence but many zsh configs
    // don't bind it. Ctrl+W (\x17) is universally bound in zsh and bash.
    // Only needed on macOS — Windows/Linux handle Alt+Backspace natively.
    if (shouldSendMacBackwardKillWord(window.api.platform, event)) {
      event.preventDefault();
      window.api.sendInput(terminalId, '\x17');
      return false;
    }
    // Shift+Enter: send CSI u encoded sequence for multi-line input in coding agents.
    // preventDefault() is critical — without it, the browser's default Enter behavior
    // on xterm's hidden textarea fires an `input` event that sends an extra `\r` to the PTY.
    if (
      event.type === 'keydown' &&
      event.key === 'Enter' &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      window.api.sendInput(terminalId, '\x1b[13;2u');
      return false;
    }
    // xterm 6: Alt+Arrow word-jump. xterm 5 had an internal hack mapping
    // Alt+Arrow to Ctrl+Arrow (\x1b[1;5C / \x1b[1;5D). That was removed in v6.
    // On macOS, send readline/zle Meta-b/f instead of Meta+Arrow so raw terminal
    // UIs do not interpret the leading escape as a standalone cancel/navigation key.
    const wordJumpInput = getAltArrowWordJumpInput(window.api.platform, event);
    if (wordJumpInput) {
      event.preventDefault();
      window.api.sendInput(terminalId, wordJumpInput);
      return false;
    }
    return xtermHandler(event);
  };
}

/**
 * Feed all registered double-tap detectors. On keyup, returns true if a
 * detector fired (signalling the event should be swallowed).
 */
export function feedDoubleTapDetectors(
  event: KeyboardEvent,
  shortcuts: Record<string, string>
): boolean {
  for (const [, shortcut] of Object.entries(shortcuts)) {
    if (!isDoubleTapShortcut(shortcut)) continue;
    const dtKey = configKeyToEventKey(shortcut.slice('DoubleTap+'.length));
    const detector = getDetector(dtKey);
    if (!detector) continue;
    if (event.type === 'keydown') {
      detector.handleKeyDown(event);
    } else if (event.type === 'keyup' && detector.handleKeyUp(event)) {
      return true;
    }
  }
  return false;
}

export function shortcutKeyMatches(shortcutKey: string, key: string): boolean {
  let matches = shortcutKey === key;
  if (shortcutKey === '\\' && (key === '\\' || key === '|')) {
    matches = true;
  }
  if (shortcutKey === '[' && key === '[') {
    matches = true;
  }
  if (shortcutKey === ']' && key === ']') {
    matches = true;
  }
  if (shortcutKey.startsWith('arrow')) {
    matches = key === shortcutKey;
  }
  return matches;
}

/** The configured modifier shortcut a keydown event matches, if any. */
function matchModifierShortcut(
  event: KeyboardEvent,
  shortcuts: Record<string, string>,
  isMac: boolean
): string | null {
  const modKey = isMac ? event.metaKey : event.ctrlKey;
  if (!modKey) return null;
  const key = event.key.toLowerCase();
  for (const [actionId, shortcut] of Object.entries(shortcuts)) {
    // The new workspace dialog's keys belong to the terminal everywhere else.
    if (isDoubleTapShortcut(shortcut) || isNewWorkspaceDialogShortcut(actionId)) continue;
    const parts = shortcut.split('+');
    const shortcutKey = parts[parts.length - 1].toLowerCase();
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
    const modifiersMatch =
      mods.includes('cmd') === modKey &&
      (!isMac || mods.includes('ctrl') === event.ctrlKey) &&
      mods.includes('shift') === event.shiftKey &&
      mods.includes('alt') === event.altKey;
    if (modifiersMatch && shortcutKeyMatches(shortcutKey, key)) return actionId;
  }
  return null;
}

/**
 * Try to match the keydown event against a configured modifier shortcut.
 * Returns true if a shortcut was matched and executed.
 */
export function tryExecuteModifierShortcut(
  event: KeyboardEvent,
  shortcuts: Record<string, string>,
  isMac: boolean
): boolean {
  const actionId = matchModifierShortcut(event, shortcuts, isMac);
  if (!actionId) return false;
  executeShortcutAction(actionId, event);
  return true;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Whether a key event types into the terminal, rather than being a Komla or macOS shortcut. */
export function isTerminalTypingKey(
  event: KeyboardEvent,
  platform: string | undefined,
  shortcuts: Record<string, string>
): boolean {
  if (event.type !== 'keydown' || MODIFIER_KEYS.has(event.key)) return false;
  const isMac = platform === 'darwin';
  if (isMac && event.metaKey) return false;
  return !matchModifierShortcut(event, shortcuts, isMac);
}

/**
 * Shared xterm custom key event handler.
 * Handles both keydown (modifier shortcuts) and keyup (double-tap detection).
 * Returns false to prevent xterm from processing the key, true to allow it.
 */
export function xtermKeyHandler(event: KeyboardEvent): boolean {
  // Cancel voice recording on Escape — intercept before xterm sends it to the PTY.
  const voiceState = useVoiceStore.getState();
  if (
    event.type === 'keydown' &&
    event.key === 'Escape' &&
    (voiceState.isStarting || voiceState.isRecording)
  ) {
    executeShortcutAction('voice.cancel');
    return false;
  }

  const shortcuts = useShortcutsStore.getState().config?.shortcuts;
  if (!shortcuts) return true;

  if (event.type === 'keyup') {
    executeShortcutAction('workspace.navigation.release', event);
    return !feedDoubleTapDetectors(event, shortcuts);
  }
  if (event.type !== 'keydown') return true;

  feedDoubleTapDetectors(event, shortcuts);

  const isMac = window.api?.platform === 'darwin';
  return !tryExecuteModifierShortcut(event, shortcuts, isMac);
}

export function isDroppedRegularFile(filePath: string): boolean {
  return filePath.length > 0;
}

const LARGE_FILE_TRANSFER_BYTES = 100 * 1024 * 1024;

export async function getDroppedFileAtPathInput(
  files: readonly File[],
  getPathForFile: (file: File) => string,
  importExternalFile: ((sourcePath: string, preferredName?: string) => Promise<string>) | undefined,
  confirmLargeTransfer?: (files: readonly File[], totalBytes: number) => Promise<boolean>
): Promise<string | null> {
  if (!importExternalFile) return null;

  const importableFiles = files
    .map((file) => ({ file, sourcePath: getPathForFile(file) }))
    .filter(({ sourcePath }) => isDroppedRegularFile(sourcePath));

  const totalBytes = importableFiles.reduce((total, { file }) => total + file.size, 0);
  if (
    totalBytes >= LARGE_FILE_TRANSFER_BYTES &&
    confirmLargeTransfer &&
    !(await confirmLargeTransfer(
      importableFiles.map(({ file }) => file),
      totalBytes
    ))
  ) {
    return null;
  }

  const refs = await Promise.all(
    importableFiles.map(async ({ file, sourcePath }) => {
      try {
        const relativePath = await importExternalFile(sourcePath, file.name);
        return `@${relativePath} `;
      } catch (err) {
        console.warn('Failed to import dropped file:', err);
        return null;
      }
    })
  );

  const input = refs.filter((ref): ref is string => ref !== null).join('');
  return input || null;
}

export function TerminalView({
  terminalId,
  isActive,
  isTabActive,
  workingDirectory,
  fileLinkWorkspaceRoot = workingDirectory,
  workspaceId,
  executionLocation,
  workspaceBackendKind = 'local',
  allowOsc52Clipboard = false,
  copyOnSelect = false,
  searchesInTmux = false,
  onTitleChange,
  onLinkContextMenu,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  const onLinkContextMenuRef = useRef(onLinkContextMenu);
  const pasteOptionsRef = useRef<TerminalPasteOptions>({});
  const fileLinkContextRef = useRef({
    workspaceRoot: fileLinkWorkspaceRoot,
    workingDirectory,
    workspaceId,
    workspaceBackendKind,
    executionLocation,
  });
  const [error, setError] = useState<string | null>(null);
  const [dropFeedback, setDropFeedback] = useState<'files' | 'path' | null>(null);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const terminalConfig = useCustomizationStore((state) => state.terminalConfig);

  useLayoutEffect(() => {
    onTitleChangeRef.current = onTitleChange;
    onLinkContextMenuRef.current = onLinkContextMenu;
    fileLinkContextRef.current = {
      workspaceRoot: fileLinkWorkspaceRoot,
      workingDirectory,
      workspaceId,
      workspaceBackendKind,
      executionLocation,
    };
    pasteOptionsRef.current = {
      workspaceId,
      executionLocation,
      canImportClipboardImage:
        !isLocalTerminalExecutionLocation(executionLocation) && workspaceBackendKind === 'ssh',
    };
    updateTerminalRendererContext(terminalId, { workspaceId, executionLocation });
    setTerminalFileLinkContext(terminalId, fileLinkContextRef.current);
    return () => setTerminalFileLinkContext(terminalId, undefined);
  }, [
    executionLocation,
    fileLinkWorkspaceRoot,
    onLinkContextMenu,
    onTitleChange,
    terminalId,
    workingDirectory,
    workspaceBackendKind,
    workspaceId,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    try {
      const cursorBlink = terminalConfig?.cursor.blink ?? false;
      const cursorStyle = terminalConfig?.cursor.style ?? 'block';
      const fontSize = terminalConfig?.font.size ?? 14;
      const fontFamily = buildTerminalFontFamily(terminalConfig?.font.family ?? '');
      const lineHeight = terminalConfig?.font.lineHeight ?? 1.2;
      const scrollback = terminalConfig?.scrollback ?? 5000;
      const theme = buildTerminalTheme(terminalConfig);
      const isUS = useShortcutsStore.getState().config?.isUSKeyboardLayout ?? true;
      const windowsPtyOptions = terminalWindowsPtyOptions(
        window.api?.platform,
        window.api?.systemVersion,
        useConfigStore.getState().config?.windowsUseConptyDll !== false
      );
      const urlOpenOptions = (): TerminalUrlOpenOptions => ({
        webLinkOpenTarget: useConfigStore.getState().config?.webLinkOpenTarget,
        canOpenInKomla: !!fileLinkContextRef.current.workspaceId,
      });
      attachTerminalRenderer({
        terminalId,
        container,
        visible: isTabActive,
        context: { workspaceId, executionLocation },
        options: {
          cursorBlink,
          cursorStyle,
          fontSize,
          fontFamily,
          lineHeight,
          theme,
          scrollback,
          macOptionIsMeta: isUS,
          ...windowsPtyOptions,
          allowProposedApi: true,
          rescaleOverlappingGlyphs: true,
          // WCAG AA. Lifts dim text and ANSI black, which themes often set at or near the
          // background, to a readable contrast.
          minimumContrastRatio: 4.5,
        },
        callbacks: {
          keyHandler: createTerminalKeyHandler(
            terminalId,
            xtermKeyHandler,
            () => pasteOptionsRef.current
          ),
          onTitleChange: (title) => onTitleChangeRef.current?.(title),
          onLinkHover: (link, element) =>
            syncTerminalLinkHoverTitle(element, window.api?.platform, link, urlOpenOptions()),
          onHyperlinkPrinted: (uri) => {
            const context = fileLinkContextRef.current;
            const { workspaceId: linkWorkspaceId } = context;
            if (!linkWorkspaceId) return;
            notePrintedHyperlink(linkWorkspaceId, uri);
            const link = terminalHyperlinkTarget(uri);
            if (link?.type !== 'file') return;
            const target = resolveTerminalFileLink(link.filePath, context, window.api?.platform);
            if (target) {
              queuePrintedFileHyperlink(linkWorkspaceId, {
                path: link.filePath,
                terminalId,
                target,
                context,
                printedAt: Date.now(),
              });
            }
          },
          onUrlLink: (event, uri) => {
            if (!shouldOpenTerminalUrlLink(window.api?.platform, event)) return;
            openTerminalUrl(
              uri,
              resolveTerminalUrlOpenTarget(uri, event.shiftKey, urlOpenOptions()),
              fileLinkContextRef.current
            );
          },
          onFileLink: (event, rawPath, lineNumber) => {
            if (!shouldOpenTerminalFileLink(window.api?.platform, event)) return;
            const context = fileLinkContextRef.current;
            const target = resolveTerminalFileLink(rawPath, context, window.api?.platform);
            openTerminalFileLink(rawPath, lineNumber, target, terminalId, context);
          },
        },
      });
      setError(null);
    } catch (attachError) {
      console.error('Terminal initialization failed:', attachError);
      setError((attachError as Error).message);
    }
    return () => detachTerminalRenderer(terminalId);
    // Creation values are intentionally fixed for one Terminal identity. Live values update below.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [terminalId]);

  useLayoutEffect(() => {
    setTerminalRendererVisible(terminalId, isTabActive);
  }, [isTabActive, terminalId]);

  useEffect(() => {
    configureTerminalRendererClipboard(terminalId, {
      allowOsc52: allowOsc52Clipboard,
      copyOnSelect,
      decodeOsc52: decodeOsc52Clipboard,
      copy: (text) => window.api.copyToClipboard(text),
    });
    return () => clearTerminalRendererClipboard(terminalId);
  }, [allowOsc52Clipboard, copyOnSelect, terminalId]);

  useEffect(() => {
    if (!terminalConfig) return;
    updateTerminalRendererConfiguration(terminalId, {
      fontSize: terminalConfig.font.size,
      fontFamily: buildTerminalFontFamily(terminalConfig.font.family),
      lineHeight: terminalConfig.font.lineHeight,
      cursorBlink: terminalConfig.cursor.blink,
      cursorStyle: terminalConfig.cursor.style,
      scrollback: terminalConfig.scrollback,
      theme: buildTerminalTheme(terminalConfig),
      sendRightClickToPrograms: terminalConfig.sendRightClickToPrograms,
    });
  }, [terminalConfig, terminalId]);

  useEffect(() => {
    if (isActive) focusTerminalRenderer(terminalId);
  }, [isActive, terminalId]);

  useEffect(() => () => window.api.setTerminalFocus(terminalId, false), [terminalId]);

  useEffect(() => {
    if (!isActive) return;
    return registerShortcutAction('terminal.scrollToBottom', () =>
      scrollTerminalRendererToBottom(terminalId)
    );
  }, [isActive, terminalId]);

  useEffect(() => {
    if (!isActive) return;
    return registerShortcutAction('terminal.search', () =>
      useTerminalSearchStore.getState().openSearch(terminalId)
    );
  }, [isActive, terminalId]);

  // Subscribe so React re-renders when the experimental palette changes.
  useActivePalette();
  const paletteBg = getPaletteTerminalBackground();
  const bgColor = paletteBg ?? (terminalConfig ? terminalConfig.colors.background : '#1a1714');

  // Accept drops from the sidebar file tree and files from the OS file
  // browser. Tree drops paste `@path`; file drops import into the
  // workspace and paste an `@relative/path` reference for agent prompts.
  // The matching dragstart in SidebarFileTree.tsx stamps this MIME with the
  // intended text (including the `@` prefix and trailing `/` for directories)
  // and flips the `tree-drag-token` module flag while the drag is live.
  //
  // Security: the MIME is not private — a web page or external app could
  // spoof it and drop arbitrary bytes onto our terminal, which sendInput
  // would write straight to the PTY (so a payload containing `\n` would run
  // commands). Two defenses stacked: reject drops when the tree token isn't
  // live (our own drag never happened), and strip control characters from
  // the payload before writing so even an accepted weird payload can't
  // smuggle newlines or escape sequences through.
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (isTreeDragActive() && e.dataTransfer.types.includes(AT_PATH_MIME)) {
      e.preventDefault();
      setDropFeedback('path');
      return;
    }
    if (hasFileDrop(e.dataTransfer)) {
      e.preventDefault();
      setDropFeedback('files');
    }
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
    setDropFeedback(null);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      setDropFeedback(null);
      if (consumeTreeDragActive()) {
        const atPath = e.dataTransfer.getData(AT_PATH_MIME);
        if (!atPath) return;
        e.preventDefault();
        // oxlint-disable-next-line no-control-regex
        const clean = atPath.replace(/[\x00-\x1f\x7f]/g, '');
        if (!clean) return;
        window.api.sendInput(terminalId, clean);
        focusTerminalRenderer(terminalId);
        return;
      }

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      e.preventDefault();
      const baseImportExternalFile = workspaceId
        ? (sourcePath: string, preferredName?: string) =>
            window.api.importWorkspaceExternalFile(
              workspaceId,
              sourcePath,
              preferredName,
              executionLocation
            )
        : workingDirectory
          ? (sourcePath: string, preferredName?: string) =>
              window.api.importExternalFile(workingDirectory, sourcePath, preferredName)
          : undefined;
      if (!baseImportExternalFile) return;
      const failedFiles: string[] = [];
      const importExternalFile = async (sourcePath: string, preferredName?: string) => {
        try {
          return await baseImportExternalFile(sourcePath, preferredName);
        } catch (err) {
          failedFiles.push(preferredName ?? 'file');
          throw err;
        }
      };
      setUploadLabel(
        files.length === 1 ? `Uploading ${files[0].name}…` : `Uploading ${files.length} files…`
      );
      void getDroppedFileAtPathInput(
        files,
        window.api.getPathForFile,
        importExternalFile,
        async (largeFiles, totalBytes) =>
          (await window.api.showMessageBox({
            type: 'warning',
            title: 'Transfer large files?',
            message: `Transfer ${largeFiles.length === 1 ? largeFiles[0].name : `${largeFiles.length} files`} (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)?`,
            detail: 'Large file transfers may take a while, especially for remote workspaces.',
            buttons: ['Transfer', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
          })) === 0
      )
        .then((fileAtPathInput) => {
          if (failedFiles.length > 0) {
            useToastStore
              .getState()
              .addToast(
                failedFiles.length === 1
                  ? `Couldn’t upload ${failedFiles[0]}`
                  : `Couldn’t upload ${failedFiles.length} files`,
                'error'
              );
          }
          if (!fileAtPathInput) return;
          if (workspaceId) refreshFileListAfterImport(workspaceId);
          window.api.sendInput(terminalId, fileAtPathInput);
          focusTerminalRenderer(terminalId);
        })
        .finally(() => setUploadLabel(null));
    },
    [executionLocation, terminalId, workingDirectory, workspaceId]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      // The program has this right-click; a prevented event keeps the pane's context menu closed.
      // A menu opened from the keyboard isn't a right-click, so it always opens.
      if (takeTerminalRendererProgramRightClick(terminalId) && event.button === 2) {
        event.preventDefault();
        return;
      }

      const hoveredLink = getTerminalRendererHoveredLink(terminalId);
      if (!hoveredLink) {
        onLinkContextMenuRef.current?.(null);
        return;
      }

      if (hoveredLink.type === 'url') {
        onLinkContextMenuRef.current?.(hoveredLink);
        return;
      }

      const context = fileLinkContextRef.current;
      const { filePath: rawPath, lineNumber } = hoveredLink;
      const target = resolveTerminalFileLink(rawPath, context, window.api?.platform);
      onLinkContextMenuRef.current?.(
        target
          ? {
              type: 'file',
              target: target.type,
              filePath: target.type === 'workspace' ? target.filePath : target.fullPath,
              rawPath,
              lineNumber,
              open: () => openTerminalFileLink(rawPath, lineNumber, target, terminalId, context),
            }
          : null
      );
    },
    [terminalId]
  );

  const handleTerminalFocus = useCallback(() => {
    window.api.setTerminalFocus(terminalId, true);
  }, [terminalId]);

  const handleTerminalBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        window.api.setTerminalFocus(terminalId, false);
      }
    },
    [terminalId]
  );

  if (error) {
    return (
      <div
        className="flex h-full items-center justify-center text-error"
        style={{ backgroundColor: bgColor }}
      >
        <div className="text-center">
          <p>Terminal failed to initialize</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-clip"
      style={{ backgroundColor: bgColor }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={handleContextMenu}
    >
      {dropFeedback && (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border-2 border-primary/60 bg-background/60 text-sm font-medium text-foreground backdrop-blur-[1px] reduce-effects:bg-background/90">
          {dropFeedback === 'files' ? 'Drop to upload' : 'Drop to insert path'}
        </div>
      )}
      {uploadLabel && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute top-3 right-3 z-20 flex items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-2 text-xs font-medium text-foreground shadow-md backdrop-blur-sm"
        >
          <Spinner size="md" className="text-primary" />
          <span>{uploadLabel}</span>
        </div>
      )}
      <TerminalSearchBar terminalId={terminalId} inTmux={searchesInTmux} />
      <div className="h-full w-full overflow-clip py-2 pl-3">
        <div
          ref={containerRef}
          className="h-full w-full overflow-clip"
          onFocusCapture={handleTerminalFocus}
          onBlurCapture={handleTerminalBlur}
        />
      </div>
    </div>
  );
}
