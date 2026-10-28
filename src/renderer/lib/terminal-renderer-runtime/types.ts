import type { TerminalExecutionLocation } from '../../../shared/types/terminal';
import type { TerminalDetectedLink } from '../xterm-url-links';
import type { ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm';

export type TerminalRendererOptions = ITerminalOptions & ITerminalInitOnlyOptions;

export interface TerminalRendererContext {
  workspaceId?: string;
  executionLocation?: TerminalExecutionLocation;
}

export interface TerminalRendererCallbacks {
  keyHandler: (event: KeyboardEvent) => boolean;
  onTitleChange?: (title: string) => void;
  onUrlLink: (event: MouseEvent, uri: string) => void;
  onFileLink: (
    event: MouseEvent,
    filePath: string,
    lineNumber?: number,
    columnNumber?: number
  ) => void;
  onLinkHover?: (link: TerminalDetectedLink | null, terminalElement?: HTMLElement) => void;
  /** The target of each OSC 8 hyperlink the terminal prints. */
  onHyperlinkPrinted?: (uri: string) => void;
}

export interface AttachTerminalRendererRequest {
  terminalId: string;
  container: HTMLElement;
  options: TerminalRendererOptions;
  visible: boolean;
  context: TerminalRendererContext;
  callbacks: TerminalRendererCallbacks;
}

export interface TerminalRendererConfiguration {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: ITerminalOptions['cursorStyle'];
  scrollback: number;
  theme: ITerminalOptions['theme'];
  sendRightClickToPrograms: boolean;
}

export interface TerminalRendererClipboardConfiguration {
  allowOsc52: boolean;
  copyOnSelect: boolean;
  decodeOsc52: (data: string) => string | null;
  copy: (text: string) => void;
}

export interface TerminalRendererDiagnostics {
  runtimeCount: number;
  parkedCount: number;
  activeWebglContexts: number;
}

/** What reads terminal output since it last did: the links list, or the files list. */
export type TerminalOutputScanner = 'links' | 'files';

export interface TerminalRendererOutput {
  terminalId: string;
  executionLocation: TerminalExecutionLocation;
  logicalLines: string[];
  /** When each logical line was written, to within a couple of seconds; undefined when unknown. */
  printedAt?: Array<number | undefined>;
}
