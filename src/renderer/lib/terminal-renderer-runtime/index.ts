export type {
  AttachTerminalRendererRequest,
  TerminalRendererCallbacks,
  TerminalRendererClipboardConfiguration,
  TerminalRendererConfiguration,
  TerminalRendererContext,
  TerminalRendererDiagnostics,
  TerminalRendererOptions,
  TerminalRendererOutput,
  TerminalOutputScanner,
} from './types';

import { TerminalRendererRuntime } from './runtime';

import type {
  AttachTerminalRendererRequest,
  TerminalRendererClipboardConfiguration,
  TerminalRendererConfiguration,
  TerminalRendererContext,
  TerminalOutputScanner,
} from './types';
import type { ITheme } from '@xterm/xterm';

const runtime = new TerminalRendererRuntime();

export const attachTerminalRenderer = (request: AttachTerminalRendererRequest): void =>
  runtime.attach(request);
export const detachTerminalRenderer = (terminalId: string): void => runtime.detach(terminalId);
export const disposeTerminalRenderer = (terminalId: string): void => runtime.dispose(terminalId);
export const disposeTerminalRenderers = (terminalIds: readonly string[]): void =>
  runtime.disposeAll(terminalIds);
export const updateTerminalRendererContext = (
  terminalId: string,
  context: TerminalRendererContext
): void => runtime.setContext(terminalId, context);
export const setTerminalRendererVisible = (terminalId: string, visible: boolean): void =>
  runtime.setVisible(terminalId, visible);
export const focusTerminalRenderer = (terminalId: string): void => runtime.focus(terminalId);
export const getTerminalRendererDimensions = (
  terminalId: string
): { cols: number; rows: number } | undefined => runtime.dimensions(terminalId);
export const getTerminalRendererSelection = (terminalId: string): string =>
  runtime.selection(terminalId);
export const pasteIntoTerminalRenderer = (terminalId: string, text: string): boolean =>
  runtime.paste(terminalId, text);
export const searchTerminalRenderer = (
  terminalId: string,
  query: string,
  direction: 'next' | 'previous',
  options?: { caseSensitive?: boolean }
): boolean => runtime.search(terminalId, query, direction, options);
export const subscribeTerminalRendererSearchResults = (
  terminalId: string,
  listener: (results: { resultIndex: number; resultCount: number }) => void
): (() => void) => runtime.onSearchResults(terminalId, listener);
export const clearTerminalRendererSearch = (terminalId: string, refocus = false): void =>
  runtime.clearSearch(terminalId, refocus);
export const scrollTerminalRendererToBottom = (terminalId: string): void =>
  runtime.scrollToBottom(terminalId);
export const getTerminalRendererHoveredLink = (terminalId: string) =>
  runtime.hoveredLink(terminalId);
/** Whether the last right-click went to the program, which then gets it instead of the menu. */
export const takeTerminalRendererProgramRightClick = (terminalId: string): boolean =>
  runtime.takeProgramRightClick(terminalId);
export const updateTerminalRendererConfiguration = (
  terminalId: string,
  configuration: TerminalRendererConfiguration
): void => runtime.updateConfiguration(terminalId, configuration);
export const updateTerminalRendererPalette = (theme: ITheme): void => runtime.updatePalette(theme);
export const configureTerminalRendererClipboard = (
  terminalId: string,
  options: TerminalRendererClipboardConfiguration
): void => runtime.configureClipboard(terminalId, options);
export const clearTerminalRendererClipboard = (terminalId: string): void =>
  runtime.clearClipboard(terminalId);
export const refreshTerminalRenderer = (terminalId: string): void => runtime.refresh(terminalId);
export const getRecentTerminalRendererOutput = (workspaceId: string, maxLines: number) =>
  runtime.recentOutput(workspaceId, maxLines);
export const getTerminalRendererOutputSinceLastScan = (
  workspaceId: string,
  maxLines: number,
  scanner: TerminalOutputScanner,
  includes?: (terminalId: string) => boolean
) => runtime.outputSinceLastScan(workspaceId, maxLines, scanner, includes);
export const getTerminalRendererDiagnostics = () => runtime.diagnostics();
/** Omit the limit for the default. */
export const setTerminalRendererWebglLimit = (limit?: number): void =>
  runtime.setWebglContextLimit(limit);
