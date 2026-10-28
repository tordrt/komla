import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { stripTerminalFocusReports } from '../../../shared/lib/terminal-escape';
import { skipTerminalOutput } from '../../../shared/lib/terminal-mode-tracker';
import { subscribePtyData } from '../pty-data-dispatcher';
import { PtyStreamDedup } from '../pty-stream-dedup';
import { clearTerminalHost, hydrateTerminalHost } from '../terminal-host-tracker';
import { createTerminalLineTimes, type TerminalLineTimes } from '../terminal-line-times';
import {
  createTerminalScrollFollowState,
  loadRenderAddon,
  observeTerminalScrollFollow,
  startTerminalScrollFollow,
  stopTerminalScrollFollowForSearch,
  writeTerminalDataFollowingScroll,
  type TerminalScrollFollowState,
} from '../terminal-scroll';
import {
  createRecoveryState,
  getContextLossAction,
  resetRecoveryState,
  shouldProceedWithRetry,
  WEBGL_RETRY_DELAY_MS,
  type WebGLRecoveryState,
} from '../webgl-recovery';
import { HyperlinkUnderlineAddon } from '../xterm-hyperlink-underline';
import { resumeTerminalRendering } from '../xterm-render-resume';
import {
  terminalHyperlinkTarget,
  WrappedFileLinksAddon,
  WrappedUrlLinksAddon,
  type TerminalDetectedLink,
} from '../xterm-url-links';

import type {
  AttachTerminalRendererRequest,
  TerminalRendererCallbacks,
  TerminalRendererClipboardConfiguration,
  TerminalRendererConfiguration,
  TerminalRendererContext,
  TerminalRendererDiagnostics,
  TerminalRendererOutput,
  TerminalOutputScanner,
} from './types';
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import type { IDisposable, IMarker, ITheme } from '@xterm/xterm';

const MAX_WEBGL_CONTEXTS = 14;
const VISIBLE_REPAIR_DELAY_MS = 100;
// Each PTY resize sends SIGWINCH and full-screen agent UIs redraw everything, so coalesce
// resizes during split-drag/window-resize while still fitting xterm locally every frame.
const PTY_RESIZE_DEBOUNCE_MS = 100;
// A column change reflows the whole scrollback (~7 ms at 5,000 lines), so continuous container
// resizes of a large buffer apply rows every frame and settle columns once resizing stops.
const COLUMN_RESIZE_DEBOUNCE_MS = 100;
const COLUMN_RESIZE_DEBOUNCE_MIN_LINES = 200;
const HIDDEN_WRITE_FLUSH_MS = 50;
// xterm yields to rendering only between writes, so a backlog joined into one write froze the
// window until all of it was parsed. A visible terminal feeds its queue in pieces of at most
// this size, with at most this many writes waiting in xterm; the rest waits for later frames.
const MAX_FRAME_WRITE_CHARS = 64 * 1024;
const MAX_PENDING_FRAME_WRITES = 16;
// Flow control keeps a visible terminal's backlog near FLOW_CONTROL_HIGH_CHARS. A hidden window
// is not held back, though, and runs timers rarely, and a window that stops drawing frames while
// still reported visible parses nothing until main's flow control gives up on it: either way the
// backlog grew by hundreds of MB in a flood. Output scrollback could never show is skipped: a
// terminal keeps this many characters per cell of scrollback and screen waiting, but at least
// the minimum, so a backlog flow control holds is never skipped, and trims once twice that is.
const BACKLOG_CHARS_PER_CELL = 2;
const MIN_BACKLOG_CHARS = 1024 * 1024;
// The main process pauses a PTY whose output the renderer has not reported parsed (see
// FLOW_CONTROL_HIGH_CHARS in pty.service.ts). Reports go out in batches of at least this size.
const OUTPUT_REPORT_CHARS = 64 * 1024;
// Holding one of these alone, e.g. on the way to a shortcut, doesn't use the terminal.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);
const TERMINAL_RESET_FOCUS_REPORT_SUPPRESS_MS = 1000;

interface FrameBufferedWriter {
  write(data: string): void;
  clear(): void;
  /** More is waiting than the terminal keeps, so what arrives now may be skipped. */
  backlogged(): boolean;
}

interface SavedScroll {
  viewportY: number;
  wasAtBottom: boolean;
}

interface HostAttachment {
  container: HTMLElement;
  resizeObserver: ResizeObserver;
  disposeScrollFollow: () => void;
  resizeRepairFrame: number | null;
}

interface TerminalRendererEntry {
  terminalId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  xtermElement: HTMLElement;
  dataCleanup: () => void;
  liveWriter: FrameBufferedWriter;
  dedup: PtyStreamDedup;
  scrollFollow: TerminalScrollFollowState;
  lineTimes: TerminalLineTimes;
  /** Where each scanner's last outputSinceLastScan began the screen, which later output follows. */
  scanMarkers: Map<TerminalOutputScanner, IMarker>;
  context: TerminalRendererContext;
  callbacks: TerminalRendererCallbacks;
  host?: HostAttachment;
  parked: boolean;
  visible: boolean;
  disposed: boolean;
  savedScroll?: SavedScroll;
  webglAddon: WebglAddon | null;
  webglLastUsed: number;
  webglRecovery: WebGLRecoveryState;
  visibleRepairCleanup?: () => void;
  hoveredLink: TerminalDetectedLink | null;
  sendRightClickToPrograms: boolean;
  /** The last right-button press went to the program, so its context menu shouldn't open. */
  programRightClick: boolean;
  suppressFocusReportsUntil: number;
  osc52Disposable?: IDisposable;
  selectionDisposable?: IDisposable;
  lastPtySize: { cols: number; rows: number };
  // False until the replay snapshot and the font have arrived; the PTY keeps its size till then.
  ptySized: boolean;
  ptyResizeTimer: ReturnType<typeof setTimeout> | null;
  columnResizeTimer: ReturnType<typeof setTimeout> | null;
  unreportedOutput: number;
  // Output reported on receipt while hidden, so its parse is not reported again.
  outputReportedAhead: number;
}

function createFrameBufferedWriter(
  writeFrame: (data: string) => void,
  pendingWrites: () => number,
  backlogChars: () => number,
  onSkip: (chars: number) => void
): FrameBufferedWriter {
  let queued: string[] = [];
  let queuedChars = 0;
  let pending: { kind: 'frame' | 'timeout'; id: number } | null = null;

  const cancelPending = (): void => {
    if (pending?.kind === 'frame') cancelAnimationFrame(pending.id);
    else if (pending?.kind === 'timeout') clearTimeout(pending.id);
    pending = null;
    document.removeEventListener('visibilitychange', schedule);
  };
  const clear = (): void => {
    cancelPending();
    queued = [];
    queuedChars = 0;
  };
  const skipBacklog = (): void => {
    const keep = backlogChars();
    if (queuedChars <= 2 * keep) return;
    const backlog = queued.join('');
    const kept = skipTerminalOutput(backlog, keep);
    queued = [kept];
    queuedChars = kept.length;
    onSkip(backlog.length - kept.length);
  };
  const flush = (): void => {
    pending = null;
    document.removeEventListener('visibilitychange', schedule);
    // A hidden window paints nothing and runs timers rarely, so it writes everything at once,
    // once xterm has parsed the last write. Until then the backlog stays here, where it can be
    // trimmed. It goes in pieces, as xterm yields only between writes, so a window shown while
    // xterm works through them still draws.
    if (document.visibilityState === 'hidden') {
      if (queued.length === 0) return;
      if (pendingWrites() > 0) {
        schedule();
        return;
      }
      const backlog = queued.join('');
      queued = [];
      queuedChars = 0;
      for (let start = 0; start < backlog.length; start += MAX_FRAME_WRITE_CHARS) {
        writeFrame(backlog.slice(start, start + MAX_FRAME_WRITE_CHARS));
      }
      return;
    }
    let piece = '';
    while (queued.length > 0 && pendingWrites() < MAX_PENDING_FRAME_WRITES) {
      const chunk = queued[0];
      if (piece.length + chunk.length <= MAX_FRAME_WRITE_CHARS) {
        piece += chunk;
        queued.shift();
        queuedChars -= chunk.length;
      } else if (piece) {
        writeFrame(piece);
        piece = '';
      } else {
        queued[0] = chunk.slice(MAX_FRAME_WRITE_CHARS);
        queuedChars -= MAX_FRAME_WRITE_CHARS;
        writeFrame(chunk.slice(0, MAX_FRAME_WRITE_CHARS));
      }
    }
    if (piece) writeFrame(piece);
    if (queued.length > 0) schedule();
  };
  // Animation frames stop in hidden/minimized windows; fall back to a timer there so
  // output keeps draining into xterm instead of queueing until the window returns.
  // A pending frame is moved onto the timer if the window hides before it runs.
  function schedule(): void {
    cancelPending();
    if (document.visibilityState === 'hidden') {
      pending = { kind: 'timeout', id: window.setTimeout(flush, HIDDEN_WRITE_FLUSH_MS) };
    } else {
      pending = { kind: 'frame', id: requestAnimationFrame(flush) };
      document.addEventListener('visibilitychange', schedule);
    }
  }
  return {
    write(data) {
      // xterm parses the first write after a keystroke immediately, so an idle terminal paints
      // the echo on the next frame. Holding it for a frame of our own would add one more.
      if (queued.length === 0 && pendingWrites() === 0 && data.length <= MAX_FRAME_WRITE_CHARS) {
        writeFrame(data);
        return;
      }
      queued.push(data);
      queuedChars += data.length;
      skipBacklog();
      if (!pending) schedule();
    },
    clear,
    backlogged: () => queuedChars > backlogChars(),
  };
}

function loadFont(fontSize: number, fontFamily: string): Promise<unknown> | undefined {
  return document.fonts?.load?.(`${fontSize}px ${fontFamily}`);
}

function fitAfterFontLoad(fontSize: number, fontFamily: string, fit: () => void): void {
  void loadFont(fontSize, fontFamily)
    ?.then(fit)
    .catch(() => undefined);
}

export class TerminalRendererRuntime {
  private readonly entries = new Map<string, TerminalRendererEntry>();
  private parkingContainer: HTMLDivElement | null = null;
  private activeWebglContextCount = 0;
  private webglContextLimit = MAX_WEBGL_CONTEXTS;
  private webglUseSequence = 0;
  private resetCleanup: (() => void) | null = null;
  // A remote-control device may own a PTY's size; the desktop then renders at that size.
  private readonly remoteSizes = new Map<string, { cols: number; rows: number }>();
  private sizeAuthorityCleanup: (() => void) | null = null;

  attach(request: AttachTerminalRendererRequest): void {
    let entry = this.entries.get(request.terminalId);
    if (!entry) entry = this.create(request);
    if (entry.disposed) return;
    const attachedEntry = entry;

    attachedEntry.context = request.context;
    attachedEntry.callbacks = request.callbacks;
    attachedEntry.terminal.attachCustomKeyEventHandler(request.callbacks.keyHandler);
    this.detachHost(attachedEntry, false);

    request.container.appendChild(attachedEntry.xtermElement);
    attachedEntry.parked = false;
    this.cleanupParkingContainer();
    const resizeObserver = new ResizeObserver(() => this.scheduleResizeRepair(attachedEntry));
    resizeObserver.observe(request.container);
    attachedEntry.host = {
      container: request.container,
      resizeObserver,
      disposeScrollFollow: observeTerminalScrollFollow(
        attachedEntry.terminal,
        attachedEntry.scrollFollow,
        request.container,
        () => attachedEntry.visible
      ),
      resizeRepairFrame: null,
    };

    this.restoreParkScroll(attachedEntry);
    this.fit(attachedEntry);
    this.fitNextFrame(attachedEntry);
    fitAfterFontLoad(
      Number(attachedEntry.terminal.options.fontSize),
      String(attachedEntry.terminal.options.fontFamily),
      () => this.fit(attachedEntry)
    );
    this.setVisible(request.terminalId, request.visible);
  }

  detach(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    this.captureParkScroll(entry);
    entry.visible = false;
    entry.visibleRepairCleanup?.();
    entry.visibleRepairCleanup = undefined;
    this.disposeWebgl(entry);
    this.detachHost(entry, true);
  }

  dispose(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    this.cancelPtyResize(entry);
    this.cancelColumnResize(entry);
    entry.visibleRepairCleanup?.();
    entry.visibleRepairCleanup = undefined;
    this.detachHost(entry, false);
    this.disposeWebgl(entry);
    resetRecoveryState(entry.webglRecovery);
    this.clearClipboardHandlers(entry);
    entry.dataCleanup();
    entry.liveWriter.clear();
    entry.dedup.dispose();
    try {
      entry.terminal.dispose();
    } catch {
      // The renderer may already be partially torn down.
    }
    entry.xtermElement.remove();
    this.entries.delete(terminalId);
    this.remoteSizes.delete(terminalId);
    clearTerminalHost(terminalId);
    this.cleanupParkingContainer();
    if (this.entries.size === 0) {
      this.resetCleanup?.();
      this.resetCleanup = null;
      this.sizeAuthorityCleanup?.();
      this.sizeAuthorityCleanup = null;
    }
  }

  disposeAll(terminalIds: readonly string[]): void {
    for (const terminalId of terminalIds) this.dispose(terminalId);
  }

  setContext(terminalId: string, context: TerminalRendererContext): void {
    const entry = this.entries.get(terminalId);
    if (entry && !entry.disposed) entry.context = context;
  }

  setVisible(terminalId: string, visible: boolean): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    if (!visible) {
      if (entry.visible && !entry.savedScroll) entry.savedScroll = this.captureScroll(entry);
      entry.visible = false;
      resetRecoveryState(entry.webglRecovery);
      entry.visibleRepairCleanup?.();
      entry.visibleRepairCleanup = undefined;
      return;
    }

    entry.visible = true;
    resumeTerminalRendering(entry.terminal);
    entry.webglLastUsed = ++this.webglUseSequence;
    this.restoreVisibleScroll(entry);
    if (!entry.webglAddon) this.initWebgl(entry);
    this.scheduleVisibleRepair(entry);
  }

  /**
   * How many terminals may hold a WebGL context (each takes GPU memory). Lowering it gives up the
   * longest-hidden ones' at once; past it, a shown terminal draws without WebGL until raised again.
   */
  setWebglContextLimit(limit = MAX_WEBGL_CONTEXTS): void {
    this.webglContextLimit = limit;
    while (this.activeWebglContextCount > limit && this.reclaimHiddenWebgl(null)) {
      // Reclaims one per pass.
    }
    for (const entry of this.entries.values()) {
      if (entry.visible && !entry.webglAddon && this.initWebgl(entry)) {
        entry.terminal.refresh(0, entry.terminal.rows - 1);
      }
    }
  }

  focus(terminalId: string): void {
    this.entries.get(terminalId)?.terminal.focus();
  }

  dimensions(terminalId: string): { cols: number; rows: number } | undefined {
    const entry = this.entries.get(terminalId);
    return entry && !entry.disposed
      ? { cols: entry.terminal.cols, rows: entry.terminal.rows }
      : undefined;
  }

  selection(terminalId: string): string {
    return this.entries.get(terminalId)?.terminal.getSelection() ?? '';
  }

  paste(terminalId: string, text: string): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return false;
    entry.terminal.paste(text);
    return true;
  }

  search(
    terminalId: string,
    query: string,
    direction: 'next' | 'previous',
    { caseSensitive = false }: { caseSensitive?: boolean } = {}
  ): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed || !query) return false;
    stopTerminalScrollFollowForSearch(entry.scrollFollow);
    // Decorations also make the addon report result counts (onDidChangeResults).
    const options = {
      caseSensitive,
      decorations: { activeMatchColorOverviewRuler: '#e8a849' },
    } as ISearchOptions;
    return direction === 'next'
      ? entry.searchAddon.findNext(query, options)
      : entry.searchAddon.findPrevious(query, options);
  }

  onSearchResults(
    terminalId: string,
    listener: (results: ISearchResultChangeEvent) => void
  ): () => void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return () => {};
    const subscription = entry.searchAddon.onDidChangeResults(listener);
    return () => subscription.dispose();
  }

  clearSearch(terminalId: string, refocus = false): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    entry.searchAddon.clearDecorations();
    if (refocus) entry.terminal.focus();
  }

  scrollToBottom(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    startTerminalScrollFollow(entry.scrollFollow);
    entry.terminal.scrollToBottom();
  }

  hoveredLink(terminalId: string): TerminalDetectedLink | null | undefined {
    return this.entries.get(terminalId)?.hoveredLink;
  }

  takeProgramRightClick(terminalId: string): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry?.programRightClick) return false;
    entry.programRightClick = false;
    return true;
  }

  updateConfiguration(terminalId: string, configuration: TerminalRendererConfiguration): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed || !entry.terminal.element) return;
    const { terminal } = entry;
    terminal.options.fontSize = configuration.fontSize;
    terminal.options.fontFamily = configuration.fontFamily;
    terminal.options.lineHeight = configuration.lineHeight;
    terminal.options.cursorBlink = configuration.cursorBlink;
    terminal.options.cursorStyle = configuration.cursorStyle;
    terminal.options.scrollback = configuration.scrollback;
    terminal.options.theme = configuration.theme;
    entry.sendRightClickToPrograms = configuration.sendRightClickToPrograms;
    terminal.refresh(0, terminal.rows - 1);
    this.fit(entry);
    fitAfterFontLoad(configuration.fontSize, configuration.fontFamily, () => this.fit(entry));
  }

  updatePalette(theme: ITheme): void {
    for (const entry of this.entries.values()) {
      if (entry.disposed) continue;
      try {
        entry.terminal.options.theme = theme;
        if (entry.terminal.element) entry.terminal.refresh(0, entry.terminal.rows - 1);
      } catch {
        // A Terminal Renderer Runtime may be between hosts; the next repair repaints it.
      }
    }
  }

  configureClipboard(terminalId: string, options: TerminalRendererClipboardConfiguration): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    this.clearClipboardHandlers(entry);
    if (options.allowOsc52) {
      entry.osc52Disposable = entry.terminal.parser.registerOscHandler(52, (data) => {
        const text = options.decodeOsc52(data);
        if (text !== null) options.copy(text);
        return true;
      });
    }
    if (options.copyOnSelect) {
      entry.selectionDisposable = entry.terminal.onSelectionChange(() => {
        const selection = entry.terminal.getSelection();
        if (selection) options.copy(selection);
      });
    }
  }

  clearClipboard(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    this.clearClipboardHandlers(entry);
  }

  refresh(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    this.fit(entry);
    const { terminal } = entry;
    // Rebuild the renderer without a synthetic resize: SSH/tmux receives those
    // size changes too, and its redraw can race with the local buffer resize.
    requestAnimationFrame(() => {
      if (entry.disposed) return;
      this.fit(entry);
      this.disposeWebgl(entry);
      this.initWebgl(entry);
      terminal.refresh(0, terminal.rows - 1);
    });
  }

  recentOutput(workspaceId: string, maxLines: number): TerminalRendererOutput[] {
    return this.workspaceEntries(workspaceId).map((entry) =>
      this.outputFrom(entry, Math.max(0, entry.terminal.buffer.active.length - maxLines))
    );
  }

  /**
   * The last `maxLines` lines of each terminal, as recentOutput, but only those printed since
   * the previous call, and the screen, which programs rewrite in place. Terminals `includes`
   * leaves out are left for a later call.
   */
  outputSinceLastScan(
    workspaceId: string,
    maxLines: number,
    scanner: TerminalOutputScanner,
    includes: (terminalId: string) => boolean = () => true
  ): TerminalRendererOutput[] {
    const entries = this.workspaceEntries(workspaceId).filter((entry) =>
      includes(entry.terminalId)
    );
    return entries.map((entry) => {
      const buffer = entry.terminal.buffer.active;
      let startY = Math.max(0, buffer.length - maxLines);
      // The alternate screen is all screen.
      if (buffer.type === 'normal') {
        const scanned = entry.scanMarkers.get(scanner);
        if (scanned && !scanned.isDisposed) {
          startY = Math.max(startY, Math.min(scanned.line, buffer.baseY));
        }
        scanned?.dispose();
        entry.scanMarkers.set(scanner, entry.terminal.registerMarker(-buffer.cursorY));
      }
      return this.outputFrom(entry, startY);
    });
  }

  private workspaceEntries(workspaceId: string): TerminalRendererEntry[] {
    return [...this.entries.values()].filter(
      (entry) => !entry.disposed && entry.context.workspaceId === workspaceId
    );
  }

  private outputFrom(entry: TerminalRendererEntry, firstY: number): TerminalRendererOutput {
    const buffer = entry.terminal.buffer.active;
    const total = buffer.length;
    let startY = firstY;
    while (startY > 0 && buffer.getLine(startY)?.isWrapped) startY--;
    const logicalLines: string[] = [];
    const lineTimes = entry.lineTimes.timesOf(startY, total);
    const printedAt: Array<number | undefined> = [];
    for (let y = startY; y < total; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(false);
      if (line.isWrapped && logicalLines.length > 0) {
        logicalLines[logicalLines.length - 1] += text;
      } else {
        logicalLines.push(text);
        printedAt.push(lineTimes[y - startY]);
      }
    }
    return {
      terminalId: entry.terminalId,
      executionLocation: entry.context.executionLocation ?? 'workspace',
      logicalLines: logicalLines.map((line) => line.trimEnd()),
      printedAt,
    };
  }

  diagnostics(): TerminalRendererDiagnostics {
    let parkedCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.parked) parkedCount++;
    }
    return {
      runtimeCount: this.entries.size,
      parkedCount,
      activeWebglContexts: this.activeWebglContextCount,
    };
  }

  reset(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.disposed) return;
    entry.liveWriter.clear();
    entry.dedup.reset();
    entry.terminal.reset();
    entry.savedScroll = undefined;
    entry.scrollFollow.followBottom = true;
    entry.scrollFollow.pendingWrites = 0;
    entry.unreportedOutput = 0;
    entry.outputReportedAhead = 0;
    entry.suppressFocusReportsUntil = Date.now() + TERMINAL_RESET_FOCUS_REPORT_SUPPRESS_MS;
    clearTerminalHost(terminalId);
    this.fit(entry);
    this.syncPtySize(entry, true);
  }

  private create(request: AttachTerminalRendererRequest): TerminalRendererEntry {
    const updateHoveredLink = (link: TerminalDetectedLink | null) => {
      const current = this.entries.get(request.terminalId);
      if (current) current.hoveredLink = link;
      current?.callbacks.onLinkHover?.(link, current.terminal.element);
    };
    const hyperlinkUnderline = new HyperlinkUnderlineAddon();
    const terminal = new Terminal({
      ...request.options,
      // OSC 8 hyperlinks. Without a handler xterm drops file links and opens web links itself.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, uri) => {
          const link = terminalHyperlinkTarget(uri);
          const callbacks = this.entries.get(request.terminalId)?.callbacks;
          if (link?.type === 'url') callbacks?.onUrlLink(event, link.url);
          if (link?.type === 'file') callbacks?.onFileLink(event, link.filePath);
        },
        hover: (_event, uri, range) => {
          const link = terminalHyperlinkTarget(uri);
          updateHoveredLink(link);
          if (link) hyperlinkUnderline.show(range);
        },
        leave: () => {
          updateHoveredLink(null);
          hyperlinkUnderline.hide();
        },
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(hyperlinkUnderline);

    terminal.loadAddon(
      new WrappedUrlLinksAddon(
        (event, uri) => this.entries.get(request.terminalId)?.callbacks.onUrlLink(event, uri),
        updateHoveredLink
      )
    );
    terminal.loadAddon(
      new WrappedFileLinksAddon(
        (event, path, line, column) =>
          this.entries.get(request.terminalId)?.callbacks.onFileLink(event, path, line, column),
        updateHoveredLink
      )
    );
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    // The PTY's snapshot replays output printed before this renderer, which holds no new
    // links and whose lines' times are unknown. xterm parses it later, so this counts its writes.
    let replaying = 0;
    // Sees each OSC 8 link's full target, however the text wraps, and leaves it to xterm.
    terminal.parser.registerOscHandler(8, (data) => {
      const uri = data.slice(data.indexOf(';') + 1);
      if (uri && replaying === 0) {
        this.entries.get(request.terminalId)?.callbacks.onHyperlinkPrinted?.(uri);
      }
      return false;
    });
    // Times lines for the links popover.
    const lineTimes = createTerminalLineTimes(terminal, { paused: () => replaying > 0 });
    terminal.open(request.container);
    const xtermElement = request.container.querySelector('.xterm') as HTMLElement | null;
    if (!xtermElement) {
      terminal.dispose();
      throw new Error('Terminal renderer did not create an xterm element');
    }

    const scrollFollow = createTerminalScrollFollowState();
    const writeTerminalData = (data: string): void => {
      lineTimes.noteWrite();
      writeTerminalDataFollowingScroll(terminal, scrollFollow, data, () =>
        this.reportOutput(entry, data.length, false)
      );
    };
    const liveWriter = createFrameBufferedWriter(
      writeTerminalData,
      () => scrollFollow.pendingWrites,
      () =>
        Math.max(
          MIN_BACKLOG_CHARS,
          ((terminal.options.scrollback ?? 1000) + terminal.rows) *
            terminal.cols *
            BACKLOG_CHARS_PER_CELL
        ),
      // Skipped output is done with, as if parsed.
      (chars) => this.reportOutput(entry, chars, false)
    );
    // Output newer than the snapshot, queued while it was fetched, is new.
    const writeSnapshot = (snapshot: string, newer: string): void => {
      if (snapshot) {
        replaying++;
        try {
          writeTerminalDataFollowingScroll(terminal, scrollFollow, snapshot, () => {
            replaying--;
            this.reportOutput(entry, snapshot.length, false);
          });
        } catch (error) {
          replaying--;
          throw error;
        }
      }
      if (newer) writeTerminalData(newer);
    };
    const dedup = new PtyStreamDedup(writeSnapshot, (data) => liveWriter.write(data));
    const dataCleanup = subscribePtyData(request.terminalId, (data, seq) => {
      // A hidden window parses rarely, and a terminal this far behind may skip what arrives, so
      // waiting for xterm there would slow the program down.
      if (document.visibilityState === 'hidden' || liveWriter.backlogged()) {
        this.reportOutput(entry, data.length, true);
      }
      dedup.handleLive(data, seq);
    });
    const entry: TerminalRendererEntry = {
      terminalId: request.terminalId,
      terminal,
      fitAddon,
      searchAddon,
      xtermElement,
      dataCleanup,
      liveWriter,
      dedup,
      scrollFollow,
      lineTimes,
      scanMarkers: new Map(),
      context: request.context,
      callbacks: request.callbacks,
      parked: false,
      visible: request.visible,
      disposed: false,
      webglAddon: null,
      webglLastUsed: 0,
      webglRecovery: createRecoveryState(),
      hoveredLink: null,
      sendRightClickToPrograms: false,
      programRightClick: false,
      suppressFocusReportsUntil: 0,
      lastPtySize: { cols: terminal.cols, rows: terminal.rows },
      ptySized: false,
      ptyResizeTimer: null,
      columnResizeTimer: null,
      unreportedOutput: 0,
      outputReportedAhead: 0,
    };
    this.entries.set(request.terminalId, entry);
    this.ensureResetListener();
    this.ensureSizeAuthorityListener();

    // xterm reports right-button presses to a program tracking the mouse, and some act on them
    // (Claude Code pastes) while the pane menu opens too. Unless the setting sends right-clicks to
    // programs, stop the press before xterm sees it, doing what xterm's handler does besides.
    xtermElement.addEventListener(
      'mousedown',
      (event) => {
        if (event.button !== 2) return;
        entry.programRightClick =
          entry.sendRightClickToPrograms &&
          !event.shiftKey &&
          terminal.modes.mouseTrackingMode !== 'none';
        if (entry.programRightClick) return;
        event.preventDefault();
        event.stopPropagation();
        terminal.focus();
      },
      { capture: true }
    );

    // Using the terminal here takes its size back from a phone that holds it. xterm's own replies
    // to the program also arrive as input, so only a key or a press counts.
    const claimSize = (): void => {
      if (this.remoteSizes.has(request.terminalId)) {
        window.api.claimTerminalSize(request.terminalId);
      }
    };
    xtermElement.addEventListener(
      'keydown',
      (event) => {
        if (!MODIFIER_KEYS.has(event.key)) claimSize();
      },
      { capture: true }
    );
    xtermElement.addEventListener('pointerdown', claimSize, { capture: true });

    terminal.attachCustomKeyEventHandler(request.callbacks.keyHandler);
    terminal.onData((data) => {
      const input =
        Date.now() < entry.suppressFocusReportsUntil ? stripTerminalFocusReports(data) : data;
      if (input) window.api.sendInput(request.terminalId, input);
    });
    terminal.onResize(() => this.schedulePtyResize(entry));
    terminal.onTitleChange((title) => entry.callbacks.onTitleChange?.(title));

    const snapshotApplied = window.api
      .getPtyBuffer(request.terminalId)
      .then(({ buffer, seq, hostInfo }) => {
        if (entry.disposed) {
          dedup.dispose();
          return;
        }
        if (dedup.applySnapshot(buffer, seq) && hostInfo) {
          hydrateTerminalHost(request.terminalId, hostInfo);
        }
      })
      .catch((error) => {
        console.debug(
          `getPtyBuffer failed for ${request.terminalId}, falling back to live-only:`,
          error
        );
        if (entry.disposed) {
          dedup.dispose();
          return;
        }
        dedup.applySnapshot('', 0);
      });
    // A pane new to a window, e.g. one moved there, first measures a fallback font, and a remote
    // pane gains its status strip only from the snapshot's host. Sizing the PTY before both settle
    // resized the program twice, once to a size it never kept, and a full-screen agent's later
    // redraws then landed on the wrong rows. The frame lets the strip's layout land first.
    const sizePty = (): void => {
      if (entry.disposed) return;
      entry.ptySized = true;
      this.fit(entry);
      this.syncPtySize(entry, entry.visible);
    };
    void Promise.allSettled([
      snapshotApplied,
      loadFont(Number(request.options.fontSize), String(request.options.fontFamily)),
    ]).then(() => {
      // A hidden window draws no frames, so waiting for one would keep the old size until shown.
      if (document.visibilityState === 'hidden') sizePty();
      else requestAnimationFrame(sizePty);
    });
    return entry;
  }

  private detachHost(entry: TerminalRendererEntry, park: boolean): void {
    const host = entry.host;
    if (host) {
      if (host.resizeRepairFrame !== null) cancelAnimationFrame(host.resizeRepairFrame);
      host.resizeObserver.disconnect();
      host.disposeScrollFollow();
      entry.host = undefined;
    }
    if (!park) return;
    const parkingContainer = this.ensureParkingContainer();
    if (entry.xtermElement.parentElement !== parkingContainer) {
      parkingContainer.appendChild(entry.xtermElement);
    }
    entry.parked = true;
  }

  private clearClipboardHandlers(entry: TerminalRendererEntry): void {
    entry.osc52Disposable?.dispose();
    entry.selectionDisposable?.dispose();
    entry.osc52Disposable = undefined;
    entry.selectionDisposable = undefined;
  }

  private ensureParkingContainer(): HTMLDivElement {
    if (this.parkingContainer) return this.parkingContainer;
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '-9999px';
    container.style.width = '0';
    container.style.height = '0';
    container.style.overflow = 'hidden';
    container.style.visibility = 'hidden';
    container.setAttribute('aria-hidden', 'true');
    document.body.appendChild(container);
    this.parkingContainer = container;
    return container;
  }

  private cleanupParkingContainer(): void {
    if (!this.parkingContainer) return;
    const hasParkedEntry = [...this.entries.values()].some((entry) => entry.parked);
    if (hasParkedEntry) return;
    this.parkingContainer.remove();
    this.parkingContainer = null;
  }

  private captureScroll(entry: TerminalRendererEntry): SavedScroll {
    const buffer = entry.terminal.buffer.active;
    const saved = {
      viewportY: buffer.viewportY,
      wasAtBottom: buffer.viewportY >= buffer.baseY,
    };
    entry.scrollFollow.followBottom = saved.wasAtBottom;
    return saved;
  }

  private captureParkScroll(entry: TerminalRendererEntry): void {
    entry.savedScroll = this.captureScroll(entry);
  }

  private restoreParkScroll(entry: TerminalRendererEntry): void {
    const saved = entry.savedScroll;
    if (!saved) return;
    this.restoreScroll(entry, saved);
    entry.savedScroll = undefined;
  }

  private restoreVisibleScroll(entry: TerminalRendererEntry): void {
    const saved = entry.savedScroll;
    if (!saved) return;
    try {
      this.restoreScroll(entry, saved);
      entry.terminal.refresh(0, entry.terminal.rows - 1);
      entry.savedScroll = undefined;
    } catch {
      // A window move can temporarily leave xterm without a renderer; retry next visibility change.
    }
  }

  private restoreScroll(entry: TerminalRendererEntry, saved: SavedScroll): void {
    entry.scrollFollow.followBottom = saved.wasAtBottom;
    if (saved.wasAtBottom) entry.terminal.scrollToBottom();
    else entry.terminal.scrollToLine(saved.viewportY);
  }

  private fit(entry: TerminalRendererEntry, deferColumns = false): void {
    const container = entry.host?.container;
    const terminal = entry.terminal;
    if (!container || !terminal.element || entry.disposed) return;
    const remoteSize = this.remoteSizes.get(entry.terminalId);
    if (remoteSize) {
      if (terminal.cols !== remoteSize.cols || terminal.rows !== remoteSize.rows) {
        terminal.resize(remoteSize.cols, remoteSize.rows);
      }
      return;
    }
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
    try {
      const viewportY = terminal.buffer.active.viewportY;
      const wasAtBottom = viewportY >= terminal.buffer.active.baseY;
      if (!deferColumns || !this.deferColumnResize(entry)) {
        this.cancelColumnResize(entry);
        entry.fitAddon.fit();
      }
      if (wasAtBottom) terminal.scrollToBottom();
      else terminal.scrollToLine(Math.min(viewportY, terminal.buffer.active.baseY));
    } catch (error) {
      console.warn('Fit failed:', error);
    }
  }

  /** Applies a row change now and settles a column change later; false if columns are unchanged. */
  private deferColumnResize(entry: TerminalRendererEntry): boolean {
    const { terminal } = entry;
    if (terminal.buffer.normal.length < COLUMN_RESIZE_DEBOUNCE_MIN_LINES) return false;
    const dims = entry.fitAddon.proposeDimensions();
    if (!dims || isNaN(dims.cols) || isNaN(dims.rows) || dims.cols === terminal.cols) return false;
    if (dims.rows !== terminal.rows) terminal.resize(terminal.cols, dims.rows);
    this.cancelColumnResize(entry);
    entry.columnResizeTimer = setTimeout(() => {
      entry.columnResizeTimer = null;
      if (!entry.visible || entry.disposed) return;
      this.fit(entry);
      // Resizing has already settled, so the PTY follows the columns without another wait.
      this.syncPtySize(entry, false);
    }, COLUMN_RESIZE_DEBOUNCE_MS);
    return true;
  }

  private reportOutput(entry: TerminalRendererEntry, chars: number, onReceipt: boolean): void {
    if (onReceipt) {
      entry.outputReportedAhead += chars;
    } else {
      const reported = Math.min(chars, entry.outputReportedAhead);
      entry.outputReportedAhead -= reported;
      chars -= reported;
    }
    entry.unreportedOutput += chars;
    if (entry.unreportedOutput < OUTPUT_REPORT_CHARS) return;
    window.api.ackPtyOutput(entry.terminalId, entry.unreportedOutput);
    entry.unreportedOutput = 0;
  }

  private cancelColumnResize(entry: TerminalRendererEntry): void {
    if (entry.columnResizeTimer === null) return;
    clearTimeout(entry.columnResizeTimer);
    entry.columnResizeTimer = null;
  }

  private fitNextFrame(entry: TerminalRendererEntry): void {
    requestAnimationFrame(() => this.fit(entry));
  }

  private scheduleResizeRepair(entry: TerminalRendererEntry): void {
    const host = entry.host;
    if (!host || !entry.visible || host.resizeRepairFrame !== null) return;
    host.resizeRepairFrame = requestAnimationFrame(() => {
      if (!entry.host) return;
      entry.host.resizeRepairFrame = null;
      if (entry.visible) this.repair(entry);
    });
  }

  private repair(entry: TerminalRendererEntry, forcePtyResize = false): boolean {
    if (!entry.visible || !entry.host || !entry.terminal.element || entry.disposed) return false;
    // A forced repair (becoming visible) settles the size at once; container resizes defer columns.
    this.fit(entry, !forcePtyResize);
    entry.terminal.refresh(0, entry.terminal.rows - 1);
    if (forcePtyResize) this.syncPtySize(entry, true);
    else this.schedulePtyResize(entry);
    return true;
  }

  private schedulePtyResize(entry: TerminalRendererEntry): void {
    this.cancelPtyResize(entry);
    entry.ptyResizeTimer = setTimeout(() => {
      entry.ptyResizeTimer = null;
      // A pending column change syncs the PTY when it lands, so the app redraws only once.
      if (!entry.disposed && entry.columnResizeTimer === null) this.syncPtySize(entry, false);
    }, PTY_RESIZE_DEBOUNCE_MS);
  }

  private cancelPtyResize(entry: TerminalRendererEntry): void {
    if (entry.ptyResizeTimer === null) return;
    clearTimeout(entry.ptyResizeTimer);
    entry.ptyResizeTimer = null;
  }

  private syncPtySize(entry: TerminalRendererEntry, force: boolean): void {
    this.cancelPtyResize(entry);
    if (!entry.ptySized) return;
    // xterm shows a phone's size while it holds it; the desktop keeps this window's for release.
    const size = this.remoteSizes.has(entry.terminalId)
      ? this.windowSize(entry)
      : { cols: entry.terminal.cols, rows: entry.terminal.rows };
    if (!size) return;
    if (!force && size.cols === entry.lastPtySize.cols && size.rows === entry.lastPtySize.rows) {
      return;
    }
    window.api.resizePty(entry.terminalId, size.cols, size.rows);
    entry.lastPtySize = size;
  }

  private windowSize(entry: TerminalRendererEntry): { cols: number; rows: number } | null {
    const container = entry.host?.container;
    if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return null;
    const dims = entry.fitAddon.proposeDimensions();
    if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) return null;
    return { cols: dims.cols, rows: dims.rows };
  }

  private scheduleVisibleRepair(entry: TerminalRendererEntry): void {
    entry.visibleRepairCleanup?.();
    this.repair(entry, true);
    let cancelled = false;
    const firstFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      entry.terminal.refresh(0, entry.terminal.rows - 1);
      secondFrame = requestAnimationFrame(() => {
        if (!cancelled) entry.terminal.refresh(0, entry.terminal.rows - 1);
      });
    });
    let secondFrame = 0;
    const timeout = setTimeout(() => {
      if (!cancelled) entry.terminal.refresh(0, entry.terminal.rows - 1);
    }, VISIBLE_REPAIR_DELAY_MS);
    entry.visibleRepairCleanup = () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      clearTimeout(timeout);
    };
  }

  private initWebgl(entry: TerminalRendererEntry): WebglAddon | null {
    if (entry.webglAddon || entry.disposed || !entry.visible) return entry.webglAddon;
    if (this.activeWebglContextCount >= this.webglContextLimit) {
      const reclaimed = this.reclaimHiddenWebgl(entry.terminalId);
      if (!reclaimed) return null;
    }
    let addon: WebglAddon | null = null;
    try {
      const createdAddon = new WebglAddon();
      addon = createdAddon;
      createdAddon.onContextLoss(() => this.handleWebglContextLoss(entry, createdAddon));
      loadRenderAddon(entry.terminal, createdAddon);
      entry.webglAddon = createdAddon;
      entry.webglLastUsed = ++this.webglUseSequence;
      this.activeWebglContextCount++;
      return createdAddon;
    } catch (error) {
      try {
        addon?.dispose();
      } catch {
        // A failed renderer load can leave the addon partially initialized.
      }
      console.warn('WebGL not available:', error);
      return null;
    }
  }

  private handleWebglContextLoss(entry: TerminalRendererEntry, addon: WebglAddon): void {
    if (entry.webglAddon !== addon) return;
    entry.webglAddon = null;
    this.activeWebglContextCount = Math.max(0, this.activeWebglContextCount - 1);
    try {
      addon.dispose();
    } catch {
      // The context-loss callback can run after the addon has partially torn down.
    }
    const action = getContextLossAction(entry.visible, entry.webglRecovery.retryCount);
    if (action === 'skip-hidden') return;
    if (action === 'max-retries-reached') {
      entry.terminal.refresh(0, entry.terminal.rows - 1);
      this.fit(entry);
      return;
    }
    entry.webglRecovery.retryCount++;
    entry.webglRecovery.retryTimer = setTimeout(() => {
      entry.webglRecovery.retryTimer = null;
      if (!shouldProceedWithRetry(entry.visible, !!entry.terminal.element, !entry.disposed)) return;
      if (!this.initWebgl(entry)) {
        entry.terminal.refresh(0, entry.terminal.rows - 1);
        this.fit(entry);
      }
    }, WEBGL_RETRY_DELAY_MS);
  }

  private disposeWebgl(entry: TerminalRendererEntry): void {
    resetRecoveryState(entry.webglRecovery);
    const addon = entry.webglAddon;
    if (!addon) return;
    entry.webglAddon = null;
    this.activeWebglContextCount = Math.max(0, this.activeWebglContextCount - 1);
    try {
      addon.dispose();
    } catch {
      // Renderer cleanup is best-effort during structural teardown.
    }
  }

  private reclaimHiddenWebgl(requestingTerminalId: string | null): boolean {
    let candidate: TerminalRendererEntry | undefined;
    for (const entry of this.entries.values()) {
      if (
        entry.terminalId === requestingTerminalId ||
        entry.visible ||
        !entry.webglAddon ||
        (candidate && entry.webglLastUsed >= candidate.webglLastUsed)
      ) {
        continue;
      }
      candidate = entry;
    }
    if (!candidate) return false;
    this.disposeWebgl(candidate);
    return true;
  }

  private ensureResetListener(): void {
    if (this.resetCleanup || typeof window === 'undefined' || !window.api?.onTerminalReset) return;
    this.resetCleanup = window.api.onTerminalReset((terminalId) => this.reset(terminalId));
  }

  private ensureSizeAuthorityListener(): void {
    if (
      this.sizeAuthorityCleanup ||
      typeof window === 'undefined' ||
      !window.api?.onTerminalSizeAuthorityChanged
    ) {
      return;
    }
    this.sizeAuthorityCleanup = window.api.onTerminalSizeAuthorityChanged(
      (terminalId, remoteOwned, cols, rows) => {
        if (remoteOwned) this.remoteSizes.set(terminalId, { cols, rows });
        else this.remoteSizes.delete(terminalId);
        const entry = this.entries.get(terminalId);
        if (!entry || entry.disposed) return;
        this.fit(entry);
        if (!remoteOwned) this.syncPtySize(entry, true);
      }
    );
  }
}
