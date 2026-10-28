/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockTerminal {
  cols: number;
  rows: number;
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
      length: number;
      getLine: ReturnType<typeof vi.fn>;
    };
    normal: { length: number };
  };
  element: HTMLElement | undefined;
  options: Record<string, unknown>;
  modes: { mouseTrackingMode: string };
  focus: ReturnType<typeof vi.fn>;
  selection: string;
  oscHandlers: Map<number, (data: string) => boolean>;
  oscDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }>;
  selectionListeners: Array<() => void>;
  selectionDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }>;
  resizeListeners: Array<(size: { cols: number; rows: number }) => void>;
  parser: {
    registerOscHandler: ReturnType<typeof vi.fn>;
    registerCsiHandler: ReturnType<typeof vi.fn>;
    registerEscHandler: ReturnType<typeof vi.fn>;
  };
  onSelectionChange: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

interface MockWebglAddon {
  contextLoss?: () => void;
  dispose: ReturnType<typeof vi.fn>;
}

const xtermState = vi.hoisted(() => ({
  terminals: [] as MockTerminal[],
  webglInstances: [] as MockWebglAddon[],
  failWebglLoad: false,
  fit: vi.fn(),
  proposeDimensions: vi.fn(),
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
  clearDecorations: vi.fn(),
  searchResultListeners: new Set<(event: { resultIndex: number; resultCount: number }) => void>(),
}));
const streamState = vi.hoisted(() => ({
  cleanup: vi.fn(),
  listeners: new Map<string, (data: string, seq: number) => void>(),
}));
const hostState = vi.hoisted(() => ({ clear: vi.fn(), hydrate: vi.fn() }));
const resizeState = vi.hoisted(() => ({ callbacks: [] as ResizeObserverCallback[] }));
const renderState = vi.hoisted(() => ({ resume: vi.fn() }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    options: Record<string, unknown>;
    unicode = { activeVersion: '' };
    modes = { mouseTrackingMode: 'none' };
    parser = {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerEscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    };
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        length: 0,
        getLine: vi.fn(),
      },
      normal: { length: 0 },
    };
    selection = '';
    oscHandlers = new Map<number, (data: string) => boolean>();
    oscDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    selectionListeners: Array<() => void> = [];
    selectionDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
    attachCustomKeyEventHandler = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    getSelection = vi.fn(() => this.selection);
    onData = vi.fn();
    onResize = vi.fn((listener: (size: { cols: number; rows: number }) => void) => {
      this.resizeListeners.push(listener);
    });
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onSelectionChange = vi.fn((listener: () => void) => {
      this.selectionListeners.push(listener);
      const disposable = { dispose: vi.fn() };
      this.selectionDisposables.push(disposable);
      return disposable;
    });
    onTitleChange = vi.fn();
    paste = vi.fn();
    refresh = vi.fn();
    reset = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
      for (const listener of this.resizeListeners) listener({ cols, rows });
    });
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    });
    scrollToLine = vi.fn((line: number) => {
      this.buffer.active.viewportY = line;
    });
    write = vi.fn((_data: string, callback?: () => void) => callback?.());

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.parser.registerOscHandler = vi.fn((code: number, handler: (data: string) => boolean) => {
        this.oscHandlers.set(code, handler);
        const disposable = { dispose: vi.fn() };
        this.oscDisposables.push(disposable);
        return disposable;
      });
      xtermState.terminals.push(this);
    }

    loadAddon(addon: { _terminal?: unknown; isWebgl?: boolean }) {
      if (addon.isWebgl && xtermState.failWebglLoad) throw new Error('WebGL load failed');
      addon._terminal = this;
    }

    open(container: HTMLElement) {
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      container.appendChild(this.element);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = xtermState.fit;
    proposeDimensions = xtermState.proposeDimensions;
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = xtermState.findNext;
    findPrevious = xtermState.findPrevious;
    clearDecorations = xtermState.clearDecorations;
    onDidChangeResults = (
      listener: (event: { resultIndex: number; resultCount: number }) => void
    ) => {
      xtermState.searchResultListeners.add(listener);
      return { dispose: () => xtermState.searchResultListeners.delete(listener) };
    };
  },
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    isWebgl = true;
    contextLoss: (() => void) | undefined;
    onContextLoss = vi.fn((callback: () => void) => {
      this.contextLoss = callback;
    });
    dispose = vi.fn();

    constructor() {
      xtermState.webglInstances.push(this);
    }
  },
}));
vi.mock('../../../src/renderer/lib/pty-data-dispatcher', () => ({
  subscribePtyData: vi.fn((terminalId: string, listener: (data: string, seq: number) => void) => {
    streamState.listeners.set(terminalId, listener);
    return () => {
      streamState.listeners.delete(terminalId);
      streamState.cleanup();
    };
  }),
}));
vi.mock('../../../src/renderer/lib/terminal-host-tracker', () => ({
  clearTerminalHost: hostState.clear,
  hydrateTerminalHost: hostState.hydrate,
}));
vi.mock('../../../src/renderer/lib/xterm-render-resume', () => ({
  resumeTerminalRendering: renderState.resume,
}));
vi.mock('../../../src/renderer/lib/xterm-url-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/lib/xterm-url-links')>()),
  WrappedFileLinksAddon: class {},
  WrappedUrlLinksAddon: class {},
}));

import { TerminalRendererRuntime } from '../../../src/renderer/lib/terminal-renderer-runtime/runtime';

import type { ILinkHandler } from '@xterm/xterm';

const api = {
  ackPtyOutput: vi.fn(),
  claimTerminalSize: vi.fn(),
  getPtyBuffer: vi.fn().mockResolvedValue({ buffer: '', seq: 0 }),
  onTerminalReset: vi.fn(),
  onTerminalSizeAuthorityChanged: vi.fn(),
  resizePty: vi.fn(),
  sendInput: vi.fn(),
};
let resetListener: ((terminalId: string) => void) | undefined;
let removeResetListener: ReturnType<typeof vi.fn>;
let sizeAuthorityListener:
  | ((terminalId: string, remoteOwned: boolean, cols: number, rows: number) => void)
  | undefined;
let removeSizeAuthorityListener: ReturnType<typeof vi.fn>;

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 480 });
  document.body.appendChild(host);
  return host;
}

function attach(runtime: TerminalRendererRuntime, terminalId: string, host: HTMLElement): void {
  runtime.attach({
    terminalId,
    container: host,
    options: { fontSize: 14, fontFamily: 'monospace' },
    visible: true,
    context: { workspaceId: 'workspace-1', executionLocation: 'workspace' },
    callbacks: {
      keyHandler: () => true,
      onUrlLink: vi.fn(),
      onFileLink: vi.fn(),
    },
  });
}

describe('TerminalRendererRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    xtermState.terminals = [];
    xtermState.webglInstances = [];
    xtermState.failWebglLoad = false;
    streamState.listeners.clear();
    resizeState.callbacks = [];
    vi.clearAllMocks();
    xtermState.fit.mockImplementation(() => undefined);
    xtermState.proposeDimensions.mockReset();
    api.getPtyBuffer.mockResolvedValue({ buffer: '', seq: 0 });
    removeResetListener = vi.fn();
    resetListener = undefined;
    api.onTerminalReset.mockImplementation((listener) => {
      resetListener = listener;
      return removeResetListener;
    });
    removeSizeAuthorityListener = vi.fn();
    sizeAuthorityListener = undefined;
    api.onTerminalSizeAuthorityChanged.mockImplementation((listener) => {
      sizeAuthorityListener = listener;
      return removeSizeAuthorityListener;
    });
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn().mockResolvedValue([]) },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeState.callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('keeps one renderer identity across detach and reattach, then cleans up on disposal', async () => {
    const runtime = new TerminalRendererRuntime();
    const firstHost = makeHost();
    attach(runtime, 'term-1', firstHost);
    // A new renderer sizes its PTY once the snapshot is in.
    await vi.advanceTimersByTimeAsync(0);
    const terminal = xtermState.terminals[0];

    expect(xtermState.terminals).toHaveLength(1);
    expect(runtime.diagnostics()).toEqual({
      runtimeCount: 1,
      parkedCount: 0,
      activeWebglContexts: 1,
    });

    terminal.buffer.active.viewportY = 42;
    terminal.buffer.active.baseY = 100;
    runtime.detach('term-1');

    expect(runtime.diagnostics()).toEqual({
      runtimeCount: 1,
      parkedCount: 1,
      activeWebglContexts: 0,
    });
    expect(terminal.element?.parentElement?.style.visibility).toBe('hidden');

    const secondHost = makeHost();
    attach(runtime, 'term-1', secondHost);

    expect(xtermState.terminals).toHaveLength(1);
    expect(secondHost.contains(terminal.element ?? null)).toBe(true);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(42);
    expect(runtime.diagnostics().parkedCount).toBe(0);

    resetListener?.('term-1');
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(api.resizePty).toHaveBeenCalledWith('term-1', 80, 24);

    runtime.dispose('term-1');

    expect(runtime.diagnostics()).toEqual({
      runtimeCount: 0,
      parkedCount: 0,
      activeWebglContexts: 0,
    });
    expect(streamState.cleanup).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(hostState.clear).toHaveBeenCalledWith('term-1');
    expect(removeResetListener).toHaveBeenCalledOnce();
  });

  it('opens file and web hyperlinks through the link callbacks', () => {
    const runtime = new TerminalRendererRuntime();
    const callbacks = {
      keyHandler: () => true,
      onUrlLink: vi.fn(),
      onFileLink: vi.fn(),
      onLinkHover: vi.fn(),
    };
    runtime.attach({
      terminalId: 'term-hyperlinks',
      container: makeHost(),
      options: { fontSize: 14, fontFamily: 'monospace' },
      visible: true,
      context: { workspaceId: 'workspace-1', executionLocation: 'workspace' },
      callbacks,
    });
    const terminal = xtermState.terminals[0];
    const linkHandler = terminal.options.linkHandler as ILinkHandler;
    const event = new MouseEvent('click');
    const range = { start: { x: 1, y: 1 }, end: { x: 9, y: 2 } };

    expect(linkHandler.allowNonHttpProtocols).toBe(true);
    linkHandler.activate(event, 'file:///tmp/shots/variants-grid.png', range);
    linkHandler.activate(event, 'https://example.com/', range);
    linkHandler.activate(event, 'vscode://file/home/me/a.ts', range);

    expect(callbacks.onFileLink).toHaveBeenCalledOnce();
    expect(callbacks.onFileLink).toHaveBeenCalledWith(event, '/tmp/shots/variants-grid.png');
    expect(callbacks.onUrlLink).toHaveBeenCalledOnce();
    expect(callbacks.onUrlLink).toHaveBeenCalledWith(event, 'https://example.com/');

    linkHandler.hover?.(event, 'file:///tmp/shots/variants-grid.png', range);
    expect(callbacks.onLinkHover).toHaveBeenLastCalledWith(
      { type: 'file', filePath: '/tmp/shots/variants-grid.png' },
      terminal.element
    );
    linkHandler.leave?.(event, 'file:///tmp/shots/variants-grid.png', range);
    expect(callbacks.onLinkHover).toHaveBeenLastCalledWith(null, terminal.element);
  });

  it('reports search result counts until the listener unsubscribes', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-search', makeHost());
    const listener = vi.fn();

    const unsubscribe = runtime.onSearchResults('term-search', listener);
    for (const notify of xtermState.searchResultListeners) {
      notify({ resultIndex: 2, resultCount: 12 });
    }
    unsubscribe();

    expect(listener).toHaveBeenCalledExactlyOnceWith({ resultIndex: 2, resultCount: 12 });
    expect(xtermState.searchResultListeners.size).toBe(0);
    expect(runtime.onSearchResults('missing-terminal', listener)).toBeTypeOf('function');
  });

  it('answers semantic queries without exposing the xterm instance', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-queries', makeHost());
    const terminal = xtermState.terminals[0];
    terminal.selection = 'selected text';
    terminal.buffer.active.length = 3;
    terminal.buffer.active.getLine.mockImplementation((line: number) => {
      const lines = [
        { isWrapped: false, text: 'server ready at http://localhost:' },
        { isWrapped: true, text: '5173/   ' },
        { isWrapped: false, text: 'done   ' },
      ];
      const value = lines[line];
      return value
        ? { isWrapped: value.isWrapped, translateToString: () => value.text }
        : undefined;
    });

    expect(runtime.dimensions('term-queries')).toEqual({ cols: 80, rows: 24 });
    expect(runtime.selection('term-queries')).toBe('selected text');
    expect(runtime.paste('term-queries', 'pasted')).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith('pasted');
    expect(runtime.search('term-queries', 'ready', 'next')).toBe(true);
    expect(xtermState.findNext).toHaveBeenCalledWith(
      'ready',
      expect.objectContaining({ caseSensitive: false })
    );
    runtime.search('term-queries', 'Ready', 'previous', { caseSensitive: true });
    expect(xtermState.findPrevious).toHaveBeenCalledWith(
      'Ready',
      expect.objectContaining({ caseSensitive: true })
    );
    expect(runtime.recentOutput('workspace-1', 20)).toEqual([
      {
        terminalId: 'term-queries',
        executionLocation: 'workspace',
        logicalLines: ['server ready at http://localhost:5173/', 'done'],
        // This fake terminal has no normal screen, so no line times.
        printedAt: [undefined, undefined],
      },
    ]);

    runtime.dispose('term-queries');
    expect(runtime.paste('term-queries', 'ignored')).toBe(false);
    expect(runtime.dimensions('term-queries')).toBeUndefined();
  });

  it('scans the lines printed since the last scan, and the screen', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-scan', makeHost());
    const terminal = xtermState.terminals[0] as unknown as {
      buffer: { active: Record<string, unknown> };
      registerMarker: (offset: number) => unknown;
    };
    const text: string[] = [];
    const markers: Array<{ line: number; isDisposed: boolean; dispose: () => void }> = [];
    const print = (count: number) => {
      for (let i = 0; i < count; i++) text.push(`line ${text.length}`);
      // A 3-row screen with the cursor on its last row.
      Object.assign(terminal.buffer.active, {
        type: 'normal',
        length: text.length,
        baseY: text.length - 3,
        cursorY: 2,
        getLine: (y: number) =>
          y < text.length ? { isWrapped: false, translateToString: () => text[y] } : undefined,
      });
    };
    terminal.registerMarker = (offset: number) => {
      const marker = {
        line: (terminal.buffer.active.baseY as number) + 2 + offset,
        isDisposed: false,
        dispose: () => {
          marker.isDisposed = true;
        },
      };
      markers.push(marker);
      return marker;
    };
    const scan = () => runtime.outputSinceLastScan('workspace-1', 100, 'links')[0].logicalLines;

    print(5);
    expect(scan()).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
    print(2);
    expect(scan()).toEqual(['line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
    expect(scan()).toEqual(['line 4', 'line 5', 'line 6']);
    expect(markers.filter((marker) => !marker.isDisposed)).toHaveLength(1);
    // A terminal left out keeps its output for the next scan.
    expect(runtime.outputSinceLastScan('workspace-1', 100, 'files', () => false)).toEqual([]);
    // Each scanner reads from where it last did.
    expect(runtime.outputSinceLastScan('workspace-1', 100, 'files')[0].logicalLines).toHaveLength(7);
  });

  it('deduplicates the PTY snapshot against live output', async () => {
    api.getPtyBuffer.mockResolvedValue({ buffer: 'snapshot', seq: 2 });
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-stream', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-stream');

    listener?.('duplicate', 2);
    listener?.('queued', 3);
    await Promise.resolve();

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['snapshot', 'queued']);
  });

  it('writes live output straight through while xterm is idle and batches it while parsing', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-echo', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-echo');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    terminal.write.mockClear();
    // xterm parses writes asynchronously; hold the callbacks to keep them in flight.
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );

    // A keystroke echo reaches xterm at once, so it paints on the next frame.
    listener?.('echo', 1);
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith('echo', expect.any(Function));

    listener?.('a', 2);
    listener?.('b', 3);
    expect(terminal.write).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(0);
    expect(terminal.write).toHaveBeenLastCalledWith('ab', expect.any(Function));

    for (const done of parsed.splice(0)) done();
    terminal.write.mockClear();
    listener?.('next', 4);
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith('next', expect.any(Function));
    runtime.dispose('term-echo');
  });

  it('feeds a backlog to xterm in bounded pieces so it can yield to rendering', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-backlog', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-backlog');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    terminal.write.mockClear();
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );

    listener?.('busy', 1);
    const backlog = [
      'a'.repeat(200_000),
      ...Array.from({ length: 40 }, (_, index) => String(index % 10).repeat(40_000)),
    ];
    backlog.forEach((chunk, index) => listener?.(chunk, index + 2));

    const writes = () => terminal.write.mock.calls.map(([data]) => data as string);
    const expected = 'busy' + backlog.join('');
    let frames = 0;
    while (writes().join('').length < expected.length && frames < 20) {
      // xterm parses each frame's writes before the next frame.
      expect(parsed.length).toBeLessThanOrEqual(16);
      for (const done of parsed.splice(0)) done();
      vi.advanceTimersByTime(16);
      frames++;
    }

    expect(frames).toBeGreaterThan(1);
    expect(Math.max(...writes().map((data) => data.length))).toBeLessThanOrEqual(64 * 1024);
    expect(writes().join('') === expected).toBe(true);
    runtime.dispose('term-backlog');
  });

  it('reports output to the main process in batches once xterm has parsed it', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-ack', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-ack');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );

    listener?.('x'.repeat(40_000), 1);
    listener?.('y'.repeat(40_000), 2);
    vi.advanceTimersByTime(16);
    expect(parsed).toHaveLength(2);
    expect(api.ackPtyOutput).not.toHaveBeenCalled();

    parsed.shift()?.();
    expect(api.ackPtyOutput).not.toHaveBeenCalled();
    parsed.shift()?.();
    expect(api.ackPtyOutput).toHaveBeenCalledExactlyOnceWith('term-ack', 80_000);
    runtime.dispose('term-ack');
  });

  it('reports output on receipt while the window is hidden, and not again once parsed', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-hidden-ack', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-hidden-ack');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );

    // A hidden window parses rarely, so waiting for xterm would slow the program down.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    listener?.('h'.repeat(70_000), 1);
    expect(api.ackPtyOutput).toHaveBeenCalledExactlyOnceWith('term-hidden-ack', 70_000);
    vi.advanceTimersByTime(100);
    visibility.mockRestore();
    for (const done of parsed.splice(0)) done();
    expect(api.ackPtyOutput).toHaveBeenCalledOnce();

    listener?.('v'.repeat(40_000), 2);
    listener?.('w'.repeat(40_000), 3);
    vi.advanceTimersByTime(16);
    for (const done of parsed.splice(0)) done();
    expect(api.ackPtyOutput).toHaveBeenCalledTimes(2);
    expect(api.ackPtyOutput).toHaveBeenLastCalledWith('term-hidden-ack', 80_000);
    runtime.dispose('term-hidden-ack');
  });

  it('skips output a hidden terminal could never show once its backlog outgrows scrollback', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-hidden-flood', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-hidden-flood');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    terminal.write.mockClear();
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    listener?.('still parsing', 1);
    listener?.('\x1b[?1049h', 2);
    for (let seq = 3; seq < 303; seq++) listener?.(`${'x'.repeat(9_999)}\n`, seq);
    listener?.('last line', 303);
    vi.advanceTimersByTime(100);
    // xterm takes nothing more while it is still parsing.
    expect(terminal.write).toHaveBeenCalledOnce();

    parsed.shift()?.();
    vi.advanceTimersByTime(100);
    const pieces = terminal.write.mock.calls.slice(1).map(([data]) => data as string);
    // xterm yields only between writes, so a window shown meanwhile is not held up.
    expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThanOrEqual(64 * 1024);
    const written = pieces.join('');
    // A small terminal keeps the 1 MiB minimum waiting, trimmed once twice that is.
    expect(written.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(written.startsWith('\x1b[?1049h')).toBe(true);
    expect(written.endsWith('last line')).toBe(true);

    // Skipped output counts as parsed: everything received is reported once (all but the last
    // batch, under 64K), and output after the window is shown is reported again.
    for (const done of parsed.splice(0)) done();
    visibility.mockRestore();
    const reportsWhileHidden = api.ackPtyOutput.mock.calls.length;
    listener?.('v'.repeat(70_000), 304);
    vi.advanceTimersByTime(16);
    for (const done of parsed.splice(0)) done();
    expect(api.ackPtyOutput.mock.calls.length).toBeGreaterThan(reportsWhileHidden);
    const reported = api.ackPtyOutput.mock.calls.reduce((sum, [, chars]) => sum + chars, 0);
    const received = 'still parsing'.length + '\x1b[?1049h'.length + 3_000_000 + 9 + 70_000;
    expect(received - reported).toBeGreaterThanOrEqual(0);
    expect(received - reported).toBeLessThan(64 * 1024);
    runtime.dispose('term-hidden-flood');
  });

  it('skips output beyond scrollback while a visible window draws no frames', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-stalled-flood', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-stalled-flood');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    terminal.write.mockClear();
    // A window can stop drawing frames while its page still reports itself visible.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );

    listener?.('still parsing', 1);
    listener?.('\x1b[?2004h', 2);
    for (let seq = 3; seq < 303; seq++) listener?.(`${'x'.repeat(9_999)}\n`, seq);
    listener?.('last line', 303);
    expect(terminal.write).toHaveBeenCalledOnce();
    // Output past what it keeps is reported on receipt, so the program isn't held back.
    const received = 'still parsing'.length + '\x1b[?2004h'.length + 3_000_000 + 9;
    const reported = () =>
      api.ackPtyOutput.mock.calls.reduce((sum, [, chars]) => sum + (chars as number), 0);
    expect(received - reported()).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);

    // Frames resume: what waited is at most twice the 1 MiB a small terminal keeps.
    let written = '';
    terminal.write.mockImplementation((data: string, callback: () => void) => {
      written += data;
      callback();
    });
    parsed.shift()?.();
    while (frames.length > 0) frames.shift()?.(performance.now());
    expect(written.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(written.endsWith('last line')).toBe(true);
    runtime.dispose('term-stalled-flood');
  });

  it('keeps flushing live output on a timer while the window is hidden', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-hidden-window', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-hidden-window');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    terminal.write.mockClear();

    // Animation frames stop firing in a hidden or minimized window.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );
    listener?.('still parsing', 1);

    listener?.('a', 2);
    listener?.('b', 3);
    parsed.shift()?.();
    vi.advanceTimersByTime(100);
    expect(terminal.write).toHaveBeenLastCalledWith('ab', expect.any(Function));

    visibility.mockRestore();
    runtime.dispose('term-hidden-window');
  });

  it('flushes output queued for a frame when the window is hidden before it runs', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-hidden-pending', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-hidden-pending');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    terminal.write.mockClear();

    // The frame is requested while visible, but never runs once the window is hidden.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const parsed: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback: () => void) =>
      parsed.push(callback)
    );
    listener?.('still parsing', 1);
    listener?.('last output', 2);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    parsed.shift()?.();
    vi.advanceTimersByTime(100);
    expect(terminal.write).toHaveBeenLastCalledWith('last output', expect.any(Function));

    visibility.mockRestore();
    runtime.dispose('term-hidden-pending');
  });

  it('discards pre-reconnect output even when the initial snapshot arrives after reset', async () => {
    let resolveSnapshot!: (value: { buffer: string; seq: number; hostInfo: string }) => void;
    api.getPtyBuffer.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      })
    );
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-reconnect', makeHost());
    const terminal = xtermState.terminals[0];
    const listener = streamState.listeners.get('term-reconnect');

    listener?.('old queued output', 3);
    resetListener?.('term-reconnect');
    listener?.('fresh tmux redraw', 4);
    vi.advanceTimersByTime(0);
    expect(terminal.write).toHaveBeenCalledWith('fresh tmux redraw', expect.any(Function));

    terminal.write.mockClear();
    resolveSnapshot({ buffer: 'old screen', seq: 2, hostInfo: 'old host' });
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    expect(terminal.write).not.toHaveBeenCalled();
    expect(hostState.hydrate).not.toHaveBeenCalled();

    listener?.('next update', 5);
    vi.advanceTimersByTime(0);
    expect(terminal.write).toHaveBeenCalledWith('next update', expect.any(Function));
    runtime.dispose('term-reconnect');
  });

  it('repairs only visible hosts and cancels pending repairs when parked', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-visible', makeHost());
    const terminal = xtermState.terminals[0];
    // A new renderer sizes its PTY once the snapshot is in.
    await vi.advanceTimersByTimeAsync(0);
    vi.runOnlyPendingTimers();
    xtermState.fit.mockClear();
    terminal.refresh.mockClear();
    api.resizePty.mockClear();

    runtime.setVisible('term-visible', false);
    resizeState.callbacks[0]?.([], {} as ResizeObserver);
    vi.runOnlyPendingTimers();

    expect(xtermState.fit).not.toHaveBeenCalled();
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(api.resizePty).not.toHaveBeenCalled();

    runtime.setVisible('term-visible', true);
    expect(xtermState.fit).toHaveBeenCalled();
    expect(api.resizePty).toHaveBeenCalledWith('term-visible', 80, 24);

    terminal.refresh.mockClear();
    runtime.detach('term-visible');
    vi.runOnlyPendingTimers();
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(runtime.diagnostics().parkedCount).toBe(1);
  });

  it('resumes drawing as soon as a hidden terminal is shown', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-1', makeHost());
    const terminal = xtermState.terminals[0];
    renderState.resume.mockClear();

    runtime.setVisible('term-1', false);
    expect(renderState.resume).not.toHaveBeenCalled();

    runtime.setVisible('term-1', true);
    expect(renderState.resume).toHaveBeenCalledWith(terminal);
  });

  it('updates terminal configuration and refits the active host', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-config', makeHost());
    const terminal = xtermState.terminals[0];
    xtermState.fit.mockClear();
    terminal.refresh.mockClear();

    runtime.updateConfiguration('term-config', {
      fontSize: 18,
      fontFamily: 'Fira Code',
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'underline',
      scrollback: 9000,
      theme: { background: '#000000' },
      sendRightClickToPrograms: false,
    });

    expect(terminal.options).toMatchObject({
      fontSize: 18,
      fontFamily: 'Fira Code',
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'underline',
      scrollback: 9000,
      theme: { background: '#000000' },
    });
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(xtermState.fit).toHaveBeenCalled();
  });

  it('keeps right-button presses from programs unless right-clicks go to them', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-right-click', makeHost());
    const terminal = xtermState.terminals[0];
    terminal.modes.mouseTrackingMode = 'vt200';
    const screen = terminal.element!.appendChild(document.createElement('div'));
    // Stands in for xterm's own mousedown listener, which reports presses to the program.
    const reported = vi.fn();
    terminal.element!.addEventListener('mousedown', (event) => reported(event.button));
    const press = (init: MouseEventInit) =>
      screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...init }));
    const configure = (sendRightClickToPrograms: boolean) =>
      runtime.updateConfiguration('term-right-click', {
        fontSize: 14,
        fontFamily: 'monospace',
        lineHeight: 1,
        cursorBlink: false,
        cursorStyle: 'block',
        scrollback: 1000,
        theme: {},
        sendRightClickToPrograms,
      });

    press({ button: 2 });
    expect(reported).not.toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();
    expect(runtime.takeProgramRightClick('term-right-click')).toBe(false);

    press({ button: 0 });
    expect(reported).toHaveBeenCalledWith(0);

    configure(true);
    reported.mockClear();
    press({ button: 2 });
    expect(reported).toHaveBeenCalledWith(2);
    expect(runtime.takeProgramRightClick('term-right-click')).toBe(true);
    expect(runtime.takeProgramRightClick('term-right-click')).toBe(false);

    reported.mockClear();
    press({ button: 2, shiftKey: true });
    expect(reported).not.toHaveBeenCalled();
    expect(runtime.takeProgramRightClick('term-right-click')).toBe(false);

    terminal.modes.mouseTrackingMode = 'none';
    press({ button: 2 });
    expect(runtime.takeProgramRightClick('term-right-click')).toBe(false);
  });

  it("replaces the theme on a palette switch so the previous palette's colors don't linger", () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-palette', makeHost());
    const terminal = xtermState.terminals[0];
    terminal.options.theme = { background: '#000000', red: '#ff5555' };

    runtime.updatePalette({ background: '#fdf6e3' });

    expect(terminal.options.theme).toEqual({ background: '#fdf6e3' });
  });

  it('reports the target of each OSC 8 hyperlink and leaves the link to xterm', () => {
    const runtime = new TerminalRendererRuntime();
    const onHyperlinkPrinted = vi.fn();
    runtime.attach({
      terminalId: 'term-links',
      container: makeHost(),
      options: { fontSize: 14, fontFamily: 'monospace' },
      visible: true,
      context: { workspaceId: 'workspace-1', executionLocation: 'workspace' },
      callbacks: {
        keyHandler: () => true,
        onUrlLink: vi.fn(),
        onFileLink: vi.fn(),
        onHyperlinkPrinted,
      },
    });
    const handler = xtermState.terminals[0].oscHandlers.get(8);

    expect(handler?.('id=1;https://example.com/a;b')).toBe(false);
    expect(handler?.(';')).toBe(false);
    expect(onHyperlinkPrinted.mock.calls).toEqual([['https://example.com/a;b']]);
  });

  it('reports no hyperlinks the PTY snapshot replays, only those printed after', async () => {
    api.getPtyBuffer.mockResolvedValue({ buffer: 'snapshot', seq: 1 });
    const runtime = new TerminalRendererRuntime();
    const onHyperlinkPrinted = vi.fn();
    runtime.attach({
      terminalId: 'term-replay',
      container: makeHost(),
      options: { fontSize: 14, fontFamily: 'monospace' },
      visible: true,
      context: { workspaceId: 'workspace-1', executionLocation: 'workspace' },
      callbacks: {
        keyHandler: () => true,
        onUrlLink: vi.fn(),
        onFileLink: vi.fn(),
        onHyperlinkPrinted,
      },
    });
    const terminal = xtermState.terminals[0];
    const handler = terminal.oscHandlers.get(8)!;
    // The fake parses each write as it comes, printing the hyperlink the data names.
    terminal.write.mockImplementation((data: string, callback?: () => void) => {
      handler(`;https://${data}.example/`);
      callback?.();
    });

    // Printed while the snapshot was fetched, so not in it.
    streamState.listeners.get('term-replay')?.('early', 2);
    await Promise.resolve();
    await Promise.resolve();
    streamState.listeners.get('term-replay')?.('live', 3);

    expect(terminal.write).toHaveBeenCalledWith('snapshot', expect.any(Function));
    expect(onHyperlinkPrinted.mock.calls).toEqual([
      ['https://early.example/'],
      ['https://live.example/'],
    ]);
  });

  it('reconfigures OSC 52 and copy-on-select clipboard handlers without duplicates', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-clipboard', makeHost());
    const terminal = xtermState.terminals[0];
    const copy = vi.fn();

    runtime.configureClipboard('term-clipboard', {
      allowOsc52: true,
      copyOnSelect: true,
      decodeOsc52: (data) => (data === 'valid' ? 'decoded' : null),
      copy,
    });

    expect(terminal.oscHandlers.get(52)?.('valid')).toBe(true);
    expect(terminal.oscHandlers.get(52)?.('invalid')).toBe(true);
    terminal.selection = 'selected';
    terminal.selectionListeners[0]?.();
    expect(copy).toHaveBeenNthCalledWith(1, 'decoded');
    expect(copy).toHaveBeenNthCalledWith(2, 'selected');

    runtime.clearClipboard('term-clipboard');

    const osc52Calls = terminal.parser.registerOscHandler.mock.calls
      .map(([code], index) => ({ code, index }))
      .filter(({ code }) => code === 52);
    expect(osc52Calls).toHaveLength(1);
    expect(terminal.oscDisposables[osc52Calls[0].index].dispose).toHaveBeenCalledOnce();
    expect(terminal.selectionDisposables[0].dispose).toHaveBeenCalledOnce();
    expect(terminal.onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('sizes a new renderer’s PTY once, after its snapshot and font arrive', async () => {
    // A pane moved to another window first measures a fallback font and lacks its host's status
    // strip, so sizing the PTY at once resized the program twice, once to a size it never kept.
    let resolveSnapshot!: (snapshot: { buffer: string; seq: number }) => void;
    api.getPtyBuffer.mockReturnValue(new Promise((resolve) => (resolveSnapshot = resolve)));
    let resolveFont!: () => void;
    const fontLoaded = new Promise<void>((resolve) => (resolveFont = resolve));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(() => fontLoaded) },
    });
    let proposed = { cols: 139, rows: 37 };
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-moved', makeHost());
    const terminal = xtermState.terminals[0];
    xtermState.fit.mockImplementation(() => terminal.resize(proposed.cols, proposed.rows));
    resizeState.callbacks[0]?.([], {} as ResizeObserver);
    await vi.advanceTimersByTimeAsync(500);
    expect(api.resizePty).not.toHaveBeenCalled();

    proposed = { cols: 108, rows: 37 };
    resolveFont();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.resizePty).not.toHaveBeenCalled();

    proposed = { cols: 108, rows: 36 };
    resolveSnapshot({ buffer: '', seq: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.resizePty).toHaveBeenCalledExactlyOnceWith('term-moved', 108, 36);

    // Once sized, it follows its pane as before.
    proposed = { cols: 100, rows: 36 };
    resizeState.callbacks[0]?.([], {} as ResizeObserver);
    await vi.advanceTimersByTimeAsync(500);
    expect(api.resizePty).toHaveBeenLastCalledWith('term-moved', 100, 36);
    runtime.dispose('term-moved');
  });

  it('sizes a new renderer’s PTY in a hidden window, which draws no frames', async () => {
    // An agent tab opened while the window is minimized would otherwise keep its spawn size.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-hidden-window', makeHost());

    await vi.advanceTimersByTimeAsync(0);

    expect(api.resizePty).toHaveBeenCalledExactlyOnceWith('term-hidden-window', 80, 24);
    runtime.dispose('term-hidden-window');
    visibility.mockRestore();
  });

  it('sizes a new renderer’s PTY even when handling its snapshot fails', async () => {
    api.getPtyBuffer.mockResolvedValue({ buffer: '', seq: 1, hostInfo: 'host' });
    hostState.hydrate.mockImplementation(() => {
      throw new Error('hydrate failed');
    });
    vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('log failed');
    });
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-snapshot-failed', makeHost());

    await vi.advanceTimersByTimeAsync(0);

    expect(api.resizePty).toHaveBeenCalledExactlyOnceWith('term-snapshot-failed', 80, 24);
    runtime.dispose('term-snapshot-failed');
    hostState.hydrate.mockReset();
  });

  it('debounces PTY resizes while a pane is being resized continuously', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-drag', makeHost());
    const terminal = xtermState.terminals[0];
    // A new renderer sizes its PTY once the snapshot is in.
    await vi.advanceTimersByTimeAsync(0);
    vi.runOnlyPendingTimers();
    xtermState.fit.mockClear();
    api.resizePty.mockClear();
    let cols = 80;
    xtermState.fit.mockImplementation(() => terminal.resize(++cols, 24));

    for (let frame = 0; frame < 5; frame++) {
      resizeState.callbacks[0]?.([], {} as ResizeObserver);
      vi.advanceTimersByTime(16);
    }

    expect(xtermState.fit).toHaveBeenCalledTimes(5);
    expect(api.resizePty).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);

    expect(api.resizePty).toHaveBeenCalledOnce();
    expect(api.resizePty).toHaveBeenCalledWith('term-drag', 85, 24);

    // A forced sync (becoming visible) still resizes immediately and cancels the pending one.
    resizeState.callbacks[0]?.([], {} as ResizeObserver);
    vi.advanceTimersByTime(16);
    api.resizePty.mockClear();
    runtime.setVisible('term-drag', false);
    runtime.setVisible('term-drag', true);
    expect(api.resizePty).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(150);
    expect(api.resizePty).toHaveBeenCalledOnce();
    runtime.dispose('term-drag');
  });

  it('settles columns once a large buffer stops resizing while rows follow every frame', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-reflow', makeHost());
    const terminal = xtermState.terminals[0];
    // A new renderer sizes its PTY once the snapshot is in.
    await vi.advanceTimersByTimeAsync(0);
    vi.runOnlyPendingTimers();
    terminal.buffer.normal.length = 5000;
    terminal.resize.mockClear();
    api.resizePty.mockClear();
    let proposed = { cols: 80, rows: 24 };
    xtermState.proposeDimensions.mockImplementation(() => proposed);
    xtermState.fit.mockImplementation(() => terminal.resize(proposed.cols, proposed.rows));

    for (let frame = 1; frame <= 5; frame++) {
      proposed = { cols: 80 + frame, rows: 24 + frame };
      resizeState.callbacks[0]?.([], {} as ResizeObserver);
      vi.advanceTimersByTime(16);
    }

    // A column change reflows the whole scrollback, so it waits until resizing stops.
    expect(terminal.resize).toHaveBeenCalledTimes(5);
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(29);
    expect(api.resizePty).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(terminal.cols).toBe(85);
    expect(api.resizePty).toHaveBeenCalledExactlyOnceWith('term-reflow', 85, 29);
    vi.advanceTimersByTime(200);
    expect(api.resizePty).toHaveBeenCalledOnce();
    runtime.dispose('term-reflow');
  });

  it('renders at a remote device size, reporting the window size for the release', async () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-remote', makeHost());
    const terminal = xtermState.terminals[0];
    // A new renderer sizes its PTY once the snapshot is in.
    await vi.advanceTimersByTimeAsync(0);
    vi.runOnlyPendingTimers();
    xtermState.fit.mockClear();
    api.resizePty.mockClear();
    xtermState.fit.mockImplementation(() => terminal.resize(100, 30));
    xtermState.proposeDimensions.mockReturnValue({ cols: 100, rows: 30 });

    sizeAuthorityListener?.('term-remote', true, 48, 18);
    resizeState.callbacks[0]?.([], {} as ResizeObserver);
    vi.advanceTimersByTime(200);

    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 48, rows: 18 });
    expect(xtermState.fit).not.toHaveBeenCalled();
    // The desktop restores this size when the phone lets go, not one from before it took it.
    expect(api.resizePty.mock.calls).toEqual([['term-remote', 100, 30]]);

    sizeAuthorityListener?.('term-remote', false, 90, 28);

    expect(xtermState.fit).toHaveBeenCalledOnce();
    expect(api.resizePty).toHaveBeenCalledWith('term-remote', 100, 30);
    runtime.dispose('term-remote');
    expect(removeSizeAuthorityListener).toHaveBeenCalledOnce();
  });

  it('takes the size back from a remote device when someone types or clicks in the terminal', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-claim', makeHost());
    const element = xtermState.terminals[0].element!;
    const textarea = element.appendChild(document.createElement('textarea'));
    const type = (key: string) =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    type('a');
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(api.claimTerminalSize).not.toHaveBeenCalled();

    sizeAuthorityListener?.('term-claim', true, 48, 18);
    type('Shift');
    expect(api.claimTerminalSize).not.toHaveBeenCalled();
    type('a');
    expect(api.claimTerminalSize).toHaveBeenCalledExactlyOnceWith('term-claim');

    api.claimTerminalSize.mockClear();
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(api.claimTerminalSize).toHaveBeenCalledExactlyOnceWith('term-claim');
    runtime.dispose('term-claim');
  });

  it('refreshes without resizing the PTY and repaints after replacing the WebGL renderer', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-refresh', makeHost());
    const terminal = xtermState.terminals[0];
    const initialWebgl = xtermState.webglInstances[0];
    vi.runOnlyPendingTimers();
    xtermState.fit.mockClear();
    terminal.refresh.mockClear();
    api.resizePty.mockClear();
    xtermState.fit.mockImplementation(() => {
      if (terminal.cols !== 80 || terminal.rows !== 24) terminal.resize(80, 24);
    });

    runtime.refresh('term-refresh');

    expect(terminal.resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(xtermState.fit).toHaveBeenCalled();
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
    expect(api.resizePty).not.toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(initialWebgl.dispose).toHaveBeenCalledOnce();
    expect(initialWebgl.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      terminal.refresh.mock.invocationCallOrder[0]
    );
    expect(xtermState.webglInstances).toHaveLength(2);
    expect(runtime.diagnostics().activeWebglContexts).toBe(1);
  });

  it('reclaims a hidden WebGL renderer when the context budget is exhausted', () => {
    const runtime = new TerminalRendererRuntime();
    const terminalIds = Array.from({ length: 14 }, (_, index) => `term-budget-${index}`);
    for (const terminalId of terminalIds) attach(runtime, terminalId, makeHost());
    const hiddenWebgl = xtermState.webglInstances[0];

    expect(runtime.diagnostics().activeWebglContexts).toBe(14);
    runtime.setVisible(terminalIds[0], false);
    attach(runtime, 'term-budget-new', makeHost());

    expect(hiddenWebgl.dispose).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().activeWebglContexts).toBe(14);

    runtime.disposeAll([...terminalIds, 'term-budget-new']);
    expect(runtime.diagnostics().activeWebglContexts).toBe(0);
  });

  it('gives up hidden WebGL renderers at once when the context budget is lowered', () => {
    const runtime = new TerminalRendererRuntime();
    const terminalIds = Array.from({ length: 6 }, (_, index) => `term-limit-${index}`);
    for (const terminalId of terminalIds) attach(runtime, terminalId, makeHost());
    for (const terminalId of terminalIds.slice(0, 4)) runtime.setVisible(terminalId, false);

    runtime.setWebglContextLimit(3);

    // The longest-hidden go first; shown terminals keep theirs.
    const disposed = xtermState.webglInstances.map((addon) => addon.dispose.mock.calls.length);
    expect(disposed).toEqual([1, 1, 1, 0, 0, 0]);
    expect(runtime.diagnostics().activeWebglContexts).toBe(3);

    attach(runtime, 'term-limit-new', makeHost());
    expect(xtermState.webglInstances[3].dispose).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().activeWebglContexts).toBe(3);
  });

  it('gives WebGL back to shown terminals when the context limit goes up', () => {
    const runtime = new TerminalRendererRuntime();
    runtime.setWebglContextLimit(2);
    for (const terminalId of ['term-a', 'term-b', 'term-c'])
      attach(runtime, terminalId, makeHost());
    expect(runtime.diagnostics().activeWebglContexts).toBe(2);

    runtime.setWebglContextLimit();

    expect(xtermState.webglInstances).toHaveLength(3);
    expect(runtime.diagnostics().activeWebglContexts).toBe(3);
    expect(xtermState.terminals[2].refresh).toHaveBeenCalled();
  });

  it('recovers once from WebGL context loss while visible', () => {
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-recovery', makeHost());
    const failedWebgl = xtermState.webglInstances[0];

    failedWebgl.contextLoss?.();
    expect(failedWebgl.dispose).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().activeWebglContexts).toBe(0);

    vi.advanceTimersByTime(2000);
    expect(xtermState.webglInstances).toHaveLength(2);
    expect(runtime.diagnostics().activeWebglContexts).toBe(1);
  });

  it('falls back to live output when the PTY snapshot fails', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    api.getPtyBuffer.mockRejectedValue(new Error('snapshot unavailable'));
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-snapshot-failure', makeHost());
    const terminal = xtermState.terminals[0];

    streamState.listeners.get('term-snapshot-failure')?.('live output', 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(terminal.write).toHaveBeenCalledWith('live output', expect.any(Function));
  });

  it('cleans up partially initialized renderers and tolerates terminal disposal failure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    xtermState.failWebglLoad = true;
    const runtime = new TerminalRendererRuntime();
    attach(runtime, 'term-failure', makeHost());
    const terminal = xtermState.terminals[0];
    const failedWebgl = xtermState.webglInstances[0];

    expect(failedWebgl.dispose).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().activeWebglContexts).toBe(0);
    terminal.dispose.mockImplementation(() => {
      throw new Error('already disposed');
    });

    expect(() => runtime.dispose('term-failure')).not.toThrow();
    expect(streamState.cleanup).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().runtimeCount).toBe(0);
  });
});
