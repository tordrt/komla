/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalView } from '../../../../src/renderer/components/terminal/TerminalView';
import { updateTerminalRendererConfiguration } from '../../../../src/renderer/lib/terminal-renderer-runtime';
import { useQuickLookStore } from '../../../../src/renderer/stores/quick-look.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createSshWorkspace } from '../../../factories';

const resizePty = vi.fn();
const sendInput = vi.fn();
const setTerminalFocus = vi.fn();
const getPathForFile = vi.fn();
const importWorkspaceExternalFile = vi.fn();
const requestInlineFilePreviewNav = vi.fn();
const revealInFileTree = vi.fn();
const reserveInlineFilePreviewNav = vi.fn();
const fetchFileList = vi.fn();
const getFileList = vi.fn();
const addToast = vi.fn();
const refresh = vi.fn();
const fit = vi.fn();
const createWebglAddon = vi.hoisted(() => vi.fn());
const webglTestState = vi.hoisted(() => ({
  disposedAddonIds: [] as number[],
  nextAddonId: 0,
}));
const disposeOscHandler = vi.fn();
const registerOscHandler = vi.fn(() => ({ dispose: disposeOscHandler }));
const disposeSelectionHandler = vi.fn();
let selectionHandler: (() => void) | undefined;
let terminalSelection = '';
const getPtyBuffer = vi.fn();
const openPath = vi.fn().mockResolvedValue(undefined);
const linkMocks = vi.hoisted(() => ({
  fileLinkActivate: undefined as
    | ((event: MouseEvent, rawPath: string, lineNumber?: number) => void)
    | undefined,
}));
const terminalTestState = vi.hoisted(() => ({
  latestTerminal: null as {
    buffer: { active: { viewportY: number; baseY: number } };
    cols: number;
    deferWrites: boolean;
    emitScroll: () => void;
    flushNextWrite: () => void;
    modes: { mouseTrackingMode: string };
    options: Record<string, unknown>;
    pendingWriteCallbacks: Array<() => void>;
    rows: number;
    scrollToBottom: ReturnType<typeof vi.fn>;
  } | null,
}));
const { clearTerminalHost, emitPtyData, hydrateTerminalHost, resetPtyData, subscribePtyData } =
  vi.hoisted(() => {
    let callback: ((data: string, seq: number) => void) | undefined;
    return {
      clearTerminalHost: vi.fn(),
      emitPtyData: (data: string, seq: number) => callback?.(data, seq),
      hydrateTerminalHost: vi.fn(),
      resetPtyData: () => {
        callback = undefined;
      },
      subscribePtyData: vi.fn(
        (_terminalId: string, nextCallback: (data: string, seq: number) => void) => {
          callback = nextCallback;
          return () => {
            callback = undefined;
          };
        }
      ),
    };
  });

let resizeObserverCallback: ResizeObserverCallback | null = null;
let resizeObserverDisconnect = vi.fn();

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    private dataHandler: ((data: string) => void) | undefined;
    private scrollHandler: (() => void) | undefined;
    public cols = 80;
    public rows = 24;
    public deferWrites = false;
    public pendingWriteCallbacks: Array<() => void> = [];
    public element: HTMLElement | undefined;
    public options: Record<string, unknown>;
    public unicode = { activeVersion: '' };
    public modes = { mouseTrackingMode: 'none' };
    public parser = {
      registerOscHandler,
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerEscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    };
    public buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
      },
      normal: { length: 0 },
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminalTestState.latestTerminal = this as unknown as NonNullable<
        typeof terminalTestState.latestTerminal
      >;
    }

    loadAddon(addon: { _terminal?: MockTerminal }) {
      addon._terminal = this;
    }

    open(container: HTMLElement) {
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      const textarea = document.createElement('textarea');
      textarea.className = 'xterm-helper-textarea';
      this.element.appendChild(textarea);
      container.appendChild(this.element);
    }

    attachCustomKeyEventHandler() {}
    onData(callback: (data: string) => void) {
      this.dataHandler = callback;
    }
    onResize() {}
    onTitleChange() {}
    onScroll(callback: () => void) {
      this.scrollHandler = callback;
      return { dispose: vi.fn() };
    }
    onSelectionChange(callback: () => void) {
      selectionHandler = callback;
      return { dispose: disposeSelectionHandler };
    }
    getSelection() {
      return terminalSelection;
    }
    write(data: string, callback?: () => void) {
      if (data.includes('\x1b[6n')) this.dataHandler?.('\x1b[1;1R');
      if (callback && this.deferWrites) {
        this.pendingWriteCallbacks.push(callback);
      } else {
        callback?.();
      }
    }
    emitScroll() {
      this.scrollHandler?.();
    }
    flushNextWrite() {
      this.pendingWriteCallbacks.shift()?.();
    }
    focus() {}
    dispose() {}
    reset() {}
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    });
    scrollToLine() {}
    refresh = refresh;
  }

  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = fit;
  },
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {},
}));

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {},
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    private readonly addonId = ++webglTestState.nextAddonId;

    constructor() {
      createWebglAddon();
    }
    onContextLoss() {}
    dispose() {
      webglTestState.disposedAddonIds.push(this.addonId);
    }
  },
}));

vi.mock('../../../../src/renderer/components/terminal/TerminalSearchBar', () => ({
  TerminalSearchBar: () => null,
}));

vi.mock('../../../../src/renderer/lib/palette-runtime', () => ({
  buildTerminalTheme: () => ({}),
  getPaletteTerminalBackground: () => null,
  useActivePalette: () => ({}),
}));

vi.mock('../../../../src/renderer/lib/pty-data-dispatcher', () => ({
  subscribePtyData,
}));

vi.mock('../../../../src/renderer/lib/shortcut-actions', () => ({
  executeShortcutAction: vi.fn(),
  registerShortcutAction: () => () => {},
}));

vi.mock('../../../../src/renderer/lib/terminal-host-tracker', () => ({
  clearTerminalHost,
  hydrateTerminalHost,
}));

vi.mock('../../../../src/renderer/lib/webgl-recovery', () => ({
  WEBGL_RETRY_DELAY_MS: 100,
  createRecoveryState: () => ({ retryTimer: null }),
  getContextLossAction: () => 'retry',
  resetRecoveryState: vi.fn(),
  shouldProceedWithRetry: () => false,
}));

vi.mock('../../../../src/renderer/lib/xterm-url-links', () => ({
  WrappedFileLinksAddon: class {
    constructor(activate: (event: MouseEvent, rawPath: string, lineNumber?: number) => void) {
      linkMocks.fileLinkActivate = activate;
    }
  },
  WrappedUrlLinksAddon: class {},
}));

vi.mock('../../../../src/renderer/stores/customization.store', () => ({
  useCustomizationStore: (selector: (state: { terminalConfig: null }) => unknown) =>
    selector({ terminalConfig: null }),
}));

vi.mock('../../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: {
    getState: () => ({
      requestInlineFilePreviewNav,
      reserveInlineFilePreviewNav,
      revealInFileTree,
      showGitIgnoredByWorkspace: {},
    }),
  },
}));

vi.mock('../../../../src/renderer/stores/file-list.store', () => ({
  useFileListStore: {
    getState: () => ({ fetchFileList, getFileList }),
  },
}));

vi.mock('../../../../src/renderer/stores/shortcuts.store', () => ({
  isDoubleTapShortcut: () => false,
  useShortcutsStore: {
    getState: () => ({ config: { isUSKeyboardLayout: true, shortcuts: {} } }),
  },
}));

vi.mock('../../../../src/renderer/stores/terminal-search.store', () => ({
  useTerminalSearchStore: {
    getState: () => ({ openSearch: vi.fn() }),
  },
}));

vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: {
    getState: () => ({ addToast }),
  },
}));

vi.mock('../../../../src/renderer/stores/voice.store', () => ({
  useVoiceStore: {
    getState: () => ({ isStarting: false, isRecording: false }),
  },
}));

describe('TerminalView resize repair', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizePty.mockClear();
    sendInput.mockClear();
    setTerminalFocus.mockClear();
    getPathForFile.mockReset();
    importWorkspaceExternalFile.mockReset();
    requestInlineFilePreviewNav.mockReset();
    revealInFileTree.mockReset();
    getFileList.mockReset();
    reserveInlineFilePreviewNav.mockReset().mockReturnValue(1);
    fetchFileList.mockReset().mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] });
    addToast.mockReset();
    refresh.mockClear();
    fit.mockClear();
    createWebglAddon.mockClear();
    webglTestState.disposedAddonIds = [];
    webglTestState.nextAddonId = 0;
    registerOscHandler.mockClear();
    disposeOscHandler.mockClear();
    disposeSelectionHandler.mockClear();
    selectionHandler = undefined;
    terminalSelection = '';
    openPath.mockClear();
    linkMocks.fileLinkActivate = undefined;
    hydrateTerminalHost.mockClear();
    resetPtyData();
    getPtyBuffer.mockReset();
    getPtyBuffer.mockResolvedValue({ buffer: '', seq: 0 });
    terminalTestState.latestTerminal = null;
    resizeObserverCallback = null;
    resizeObserverDisconnect = vi.fn();

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      clearTimeout(id);
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }

        observe() {}
        disconnect = resizeObserverDisconnect;
      }
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'darwin',
        homeDir: '/Users/me',
        sendInput,
        setTerminalFocus,
        resizePty,
        openExternal: vi.fn(),
        openPath,
        copyToClipboard: vi.fn(),
        readFromClipboard: vi.fn().mockResolvedValue(''),
        importClipboardImage: vi.fn().mockResolvedValue(null),
        getPtyBuffer,
        onTerminalReset: vi.fn(() => () => {}),
        getPathForFile,
        importExternalFile: vi.fn(),
        importWorkspaceExternalFile,
        listViewerFolder: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forces one immediate PTY size sync when the terminal becomes visible', async () => {
    const terminalView = (visible: boolean) => (
      <TerminalView
        terminalId="term-1"
        isActive={visible}
        isTabActive={visible}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const view = render(terminalView(true));

    expect(fit).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(0, 23);
    // A new renderer sizes the PTY once its snapshot is in.
    expect(resizePty).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(resizePty).toHaveBeenCalledExactlyOnceWith('term-1', 80, 24);

    vi.advanceTimersByTime(100);
    expect(resizePty).toHaveBeenCalledTimes(1);

    view.rerender(terminalView(false));
    view.rerender(terminalView(true));
    expect(resizePty).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(resizePty).toHaveBeenCalledTimes(2);
  });

  it('keeps following new output after restoring a hidden terminal that was at the bottom', async () => {
    const view = render(
      <TerminalView
        terminalId="term-follow-bottom"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const terminal = terminalTestState.latestTerminal!;
    await act(async () => Promise.resolve());
    terminal.buffer.active.baseY = 100;
    terminal.buffer.active.viewportY = 100;
    act(() => vi.runOnlyPendingTimers());

    view.rerender(
      <TerminalView
        terminalId="term-follow-bottom"
        isActive={false}
        isTabActive={false}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );

    terminal.buffer.active.baseY = 200;
    terminal.buffer.active.viewportY = 100;
    fit.mockImplementation(() => {
      terminal.buffer.active.viewportY = 100;
    });

    view.rerender(
      <TerminalView
        terminalId="term-follow-bottom"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    act(() => vi.runOnlyPendingTimers());

    terminal.buffer.active.baseY = 210;
    terminal.buffer.active.viewportY = 200;
    act(() => {
      emitPtyData('late remote output', 1);
      vi.runOnlyPendingTimers();
    });

    expect(terminal.buffer.active.viewportY).toBe(210);
  });

  it('refits a switched workspace without rebuilding its renderer', async () => {
    const view = render(
      <TerminalView
        terminalId="term-workspace-switch"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const terminal = terminalTestState.latestTerminal!;
    await act(async () => Promise.resolve());
    terminal.buffer.active.baseY = 100;
    terminal.buffer.active.viewportY = 100;
    act(() => vi.runOnlyPendingTimers());
    terminal.scrollToBottom.mockClear();
    fit.mockClear();
    resizePty.mockClear();
    expect(createWebglAddon).toHaveBeenCalledOnce();

    view.rerender(
      <TerminalView
        terminalId="term-workspace-switch"
        isActive={false}
        isTabActive={false}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    view.rerender(
      <TerminalView
        terminalId="term-workspace-switch"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    act(() => vi.runOnlyPendingTimers());

    expect(createWebglAddon).toHaveBeenCalledOnce();
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(fit).toHaveBeenCalledOnce();
    expect(resizePty).toHaveBeenCalledWith('term-workspace-switch', 80, 24);
  });

  it('reclaims the least recently used hidden WebGL renderer for the visible terminal', () => {
    const renderTerminals = (activeIndex: number) => (
      <>
        {Array.from({ length: 15 }, (_, index) => (
          <TerminalView
            key={index}
            terminalId={`term-webgl-budget-${index}`}
            isActive={index === activeIndex}
            isTabActive={index === activeIndex}
            workingDirectory="/tmp/project"
            workspaceId={`workspace-${index}`}
          />
        ))}
      </>
    );
    const view = render(renderTerminals(0));
    act(() => vi.runOnlyPendingTimers());

    for (let index = 1; index < 15; index++) {
      view.rerender(renderTerminals(index));
      act(() => vi.runOnlyPendingTimers());
    }

    expect(createWebglAddon).toHaveBeenCalledTimes(15);
    expect(webglTestState.disposedAddonIds).toEqual([1]);
  });

  it('fits once after its container resizes while hidden', async () => {
    const view = render(
      <TerminalView
        terminalId="term-hidden-resize"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const terminal = terminalTestState.latestTerminal!;
    await act(async () => Promise.resolve());
    act(() => vi.runOnlyPendingTimers());
    fit.mockClear();
    resizePty.mockClear();

    view.rerender(
      <TerminalView
        terminalId="term-hidden-resize"
        isActive={false}
        isTabActive={false}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    resizeObserverCallback?.([], {} as ResizeObserver);
    act(() => vi.runOnlyPendingTimers());

    expect(fit).not.toHaveBeenCalled();

    fit.mockImplementationOnce(() => {
      terminal.cols = 100;
      terminal.rows = 30;
    });
    view.rerender(
      <TerminalView
        terminalId="term-hidden-resize"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    act(() => vi.runOnlyPendingTimers());

    expect(fit).toHaveBeenCalledOnce();
    expect(resizePty).toHaveBeenCalledWith('term-hidden-resize', 100, 30);
  });

  it('preserves pointer scrollback while terminal writes are pending', async () => {
    const view = render(
      <TerminalView
        terminalId="term-pointer-scrollback"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const terminal = terminalTestState.latestTerminal!;
    await act(async () => Promise.resolve());
    terminal.buffer.active.baseY = 200;
    terminal.buffer.active.viewportY = 200;
    terminal.deferWrites = true;
    terminal.scrollToBottom.mockClear();

    act(() => {
      emitPtyData('sustained output', 1);
      vi.runOnlyPendingTimers();
    });
    expect(terminal.pendingWriteCallbacks).toHaveLength(1);
    terminal.scrollToBottom.mockClear();

    fireEvent.pointerDown(view.container.querySelector('.xterm')!);
    terminal.buffer.active.baseY = 201;
    terminal.buffer.active.viewportY = 100;
    act(() => terminal.emitScroll());
    fireEvent.pointerUp(window);
    act(() => terminal.flushNextWrite());

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(terminal.buffer.active.viewportY).toBe(100);
  });

  it('resumes following when wheel scrolling reaches bottom during pending output', async () => {
    const view = render(
      <TerminalView
        terminalId="term-wheel-resume"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const terminal = terminalTestState.latestTerminal!;
    await act(async () => Promise.resolve());
    const xterm = view.container.querySelector('.xterm')!;
    terminal.buffer.active.baseY = 200;
    terminal.buffer.active.viewportY = 200;
    terminal.deferWrites = true;

    act(() => {
      emitPtyData('sustained output', 1);
      vi.runOnlyPendingTimers();
    });
    expect(terminal.pendingWriteCallbacks).toHaveLength(1);

    fireEvent.wheel(xterm, { deltaY: -1 });
    terminal.buffer.active.baseY = 201;
    terminal.buffer.active.viewportY = 100;
    act(() => terminal.emitScroll());

    fireEvent.wheel(xterm, { deltaY: 1 });
    terminal.buffer.active.viewportY = 201;
    act(() => terminal.emitScroll());
    act(() => terminal.flushNextWrite());

    terminal.deferWrites = false;
    terminal.buffer.active.baseY = 202;
    act(() => {
      emitPtyData('more output', 2);
      vi.runOnlyPendingTimers();
    });

    expect(terminal.buffer.active.viewportY).toBe(202);
  });

  it('resumes following when keyboard scrolling reaches bottom during pending output', async () => {
    const view = render(
      <TerminalView
        terminalId="term-keyboard-resume"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const terminal = terminalTestState.latestTerminal!;
    await act(async () => Promise.resolve());
    const xterm = view.container.querySelector('.xterm')!;
    terminal.buffer.active.baseY = 200;
    terminal.buffer.active.viewportY = 200;
    terminal.deferWrites = true;

    act(() => {
      emitPtyData('sustained output', 1);
      vi.runOnlyPendingTimers();
    });
    expect(terminal.pendingWriteCallbacks).toHaveLength(1);

    fireEvent.keyDown(xterm, { key: 'PageUp', shiftKey: true });
    terminal.buffer.active.baseY = 201;
    terminal.buffer.active.viewportY = 100;
    act(() => terminal.emitScroll());

    fireEvent.keyDown(xterm, { key: 'PageDown', shiftKey: true });
    terminal.buffer.active.viewportY = 201;
    act(() => terminal.emitScroll());
    act(() => terminal.flushNextWrite());

    terminal.deferWrites = false;
    terminal.buffer.active.baseY = 202;
    act(() => {
      emitPtyData('more output', 2);
      vi.runOnlyPendingTimers();
    });

    expect(terminal.buffer.active.viewportY).toBe(202);
  });

  it('opens a page link in the file viewer instead of copying it into the workspace', async () => {
    render(
      <TerminalView
        terminalId="term-quick-look-link"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        workspaceBackendKind="local"
      />
    );

    linkMocks.fileLinkActivate?.(
      { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
      '/tmp/architecture-review.html'
    );
    await act(async () => Promise.resolve());

    expect(requestInlineFilePreviewNav).not.toHaveBeenCalled();
    expect(useQuickLookStore.getState().session).toEqual({
      workspaceId: 'workspace-1',
      item: {
        path: '/tmp/architecture-review.html',
        terminalId: 'term-quick-look-link',
        source: { kind: 'terminal', fullPath: '/tmp/architecture-review.html' },
        hostPath: '/tmp/architecture-review.html',
      },
    });
    act(() => useQuickLookStore.getState().close());
    vi.runOnlyPendingTimers();
  });

  it.each(['docs/plan.md', 'report/index.html', 'shots/home.png'])(
    'opens the workspace file %s in the file panel, whatever its type',
    async (filePath) => {
      render(
        <TerminalView
          terminalId={`term-workspace-link-${filePath}`}
          isActive={true}
          isTabActive={true}
          workingDirectory="/tmp/project"
          workspaceId="workspace-1"
          workspaceBackendKind="local"
        />
      );

      linkMocks.fileLinkActivate?.(
        { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
        filePath
      );
      await act(async () => Promise.resolve());

      expect(requestInlineFilePreviewNav).toHaveBeenCalledWith(
        'workspace-1',
        'browse',
        filePath,
        undefined,
        // The tree shows its files, so the file shows in it.
        { browseTree: true }
      );
      expect(useQuickLookStore.getState().session).toBeNull();
      vi.runOnlyPendingTimers();
    }
  );

  it('opens a workspace file the file panel would read as text in quick look', async () => {
    render(
      <TerminalView
        terminalId="term-workspace-archive-link"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        workspaceBackendKind="local"
      />
    );

    linkMocks.fileLinkActivate?.(
      { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
      'dist/app.tar.gz'
    );
    await act(async () => Promise.resolve());

    expect(requestInlineFilePreviewNav).not.toHaveBeenCalled();
    expect(useQuickLookStore.getState().session?.item).toEqual({
      path: 'dist/app.tar.gz',
      terminalId: 'term-workspace-archive-link',
      source: { kind: 'workspace', filePath: 'dist/app.tar.gz' },
      hostPath: '/tmp/project/dist/app.tar.gz',
    });
    act(() => useQuickLookStore.getState().close());
    vi.runOnlyPendingTimers();
  });

  it('shows a workspace folder in the file tree and others in the viewer, and says when it cannot', async () => {
    render(
      <TerminalView
        terminalId="term-folder-link"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        workspaceBackendKind="local"
      />
    );
    const click = { button: 0, metaKey: true, ctrlKey: false } as MouseEvent;

    linkMocks.fileLinkActivate?.(click, '/tmp/project/out/');
    await act(async () => Promise.resolve());
    expect(revealInFileTree).toHaveBeenCalledWith('workspace-1', 'out');
    expect(useQuickLookStore.getState().session).toBeNull();

    linkMocks.fileLinkActivate?.(click, '/tmp/shots/');
    await act(async () => Promise.resolve());
    expect(useQuickLookStore.getState().session?.item).toEqual({
      path: '/tmp/shots/',
      terminalId: 'term-folder-link',
      source: { kind: 'terminal', fullPath: '/tmp/shots/' },
      hostPath: '/tmp/shots/',
    });
    act(() => useQuickLookStore.getState().close());

    // A home folder path, read where the terminal runs.
    linkMocks.fileLinkActivate?.(click, '~/shots/');
    await act(async () => Promise.resolve());
    expect(useQuickLookStore.getState().session?.item).toEqual({
      path: '~/shots/',
      terminalId: 'term-folder-link',
      source: { kind: 'terminal', fullPath: '~/shots/' },
      hostPath: '/Users/me/shots/',
    });
    act(() => useQuickLookStore.getState().close());

    // A Windows path, on a Mac, names no folder Komla can read.
    linkMocks.fileLinkActivate?.(click, 'C:\\shots\\');
    await act(async () => Promise.resolve());
    expect(useQuickLookStore.getState().session).toBeNull();
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't open C:\\shots\\"),
      'error'
    );
    expect(requestInlineFilePreviewNav).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
  });

  it('opens a workspace folder the file tree does not list in the viewer instead', async () => {
    getFileList.mockImplementation((directory: string) =>
      directory === '/tmp/project'
        ? {
            files: ['out/shots/a.png', 'src/main.ts'],
            gitIgnoredFiles: ['test-results/'],
            emptyDirs: ['scratch'],
            isLoading: false,
          }
        : undefined
    );
    render(
      <TerminalView
        terminalId="term-unlisted-folder-link"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        workspaceBackendKind="local"
      />
    );
    const click = { button: 0, metaKey: true, ctrlKey: false } as MouseEvent;
    const open = async (path: string) => {
      act(() => useQuickLookStore.getState().close());
      linkMocks.fileLinkActivate?.(click, path);
      await act(async () => Promise.resolve());
    };

    await open('/tmp/project/out/shots/');
    await open('/tmp/project/scratch/');
    expect(revealInFileTree.mock.calls).toEqual([
      ['workspace-1', 'out/shots'],
      ['workspace-1', 'scratch'],
    ]);

    // Ignored, while the tree hides ignored files.
    await open('/tmp/project/test-results/');
    expect(useQuickLookStore.getState().session?.item.source).toEqual({
      kind: 'workspace',
      filePath: 'test-results/',
    });
    // Missing from the tree, as when it differs in case on macOS.
    await open('/tmp/project/Out/');
    expect(useQuickLookStore.getState().session?.item.source).toEqual({
      kind: 'workspace',
      filePath: 'Out/',
    });
    expect(revealInFileTree).toHaveBeenCalledTimes(2);
    act(() => useQuickLookStore.getState().close());
    vi.runOnlyPendingTimers();
  });

  it.each([
    {
      name: 'a local terminal, from this computer',
      terminalId: 'term-file-link-local',
      props: { workspaceBackendKind: 'local' as const },
      hostPath: '/tmp/migrate.py',
    },
    {
      name: 'an SSH terminal, from the SSH host',
      terminalId: 'term-file-link-ssh',
      props: { workspaceBackendKind: 'ssh' as const },
      hostPath: undefined,
    },
    {
      name: 'an SSH local-copy terminal, from this computer',
      terminalId: 'term-file-link-local-copy',
      props: { workspaceBackendKind: 'ssh' as const, executionLocation: 'local-mirror' as const },
      hostPath: '/tmp/migrate.py',
    },
  ])(
    'opens code outside the workspace at its line in the file viewer, without copying it: $name',
    async ({ terminalId, props, hostPath }) => {
      render(
        <TerminalView
          terminalId={terminalId}
          isActive={true}
          isTabActive={true}
          workingDirectory="/tmp/project"
          workspaceId="workspace-1"
          {...props}
        />
      );

      linkMocks.fileLinkActivate?.(
        { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
        '/tmp/migrate.py',
        12
      );
      await act(async () => Promise.resolve());

      expect(useQuickLookStore.getState().session).toEqual({
        workspaceId: 'workspace-1',
        item: {
          path: '/tmp/migrate.py',
          terminalId,
          source: { kind: 'terminal', fullPath: '/tmp/migrate.py' },
          hostPath,
          lineNumber: 12,
        },
      });
      expect(requestInlineFilePreviewNav).not.toHaveBeenCalled();
      act(() => useQuickLookStore.getState().close());
      vi.runOnlyPendingTimers();
    }
  );

  it('opens an absolute path inside an SSH workspace in the file panel', async () => {
    render(
      <TerminalView
        terminalId="term-ssh-workspace-file-link"
        isActive={true}
        isTabActive={true}
        workingDirectory="ssh://ssh-dev/home/dev/project"
        fileLinkWorkspaceRoot="/home/dev/project"
        workspaceId="workspace-1"
        workspaceBackendKind="ssh"
      />
    );

    linkMocks.fileLinkActivate?.(
      { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
      '/home/dev/project/src/main.ts',
      12
    );
    await act(async () => Promise.resolve());

    expect(requestInlineFilePreviewNav).toHaveBeenCalledWith(
      'workspace-1',
      'browse',
      'src/main.ts',
      12,
      { browseTree: true }
    );
    vi.runOnlyPendingTimers();
  });

  it('preserves case when classifying absolute paths in an SSH workspace', async () => {
    render(
      <TerminalView
        terminalId="term-ssh-case-sensitive-file-link"
        isActive={true}
        isTabActive={true}
        workingDirectory="ssh://ssh-dev/home/dev/Project"
        fileLinkWorkspaceRoot="/home/dev/Project"
        workspaceId="workspace-1"
        workspaceBackendKind="ssh"
      />
    );

    linkMocks.fileLinkActivate?.(
      { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
      '/home/dev/project/file.ts'
    );
    await act(async () => Promise.resolve());

    // Another folder than the workspace on a case-sensitive host, so it opens from there.
    expect(useQuickLookStore.getState().session?.item.source).toEqual({
      kind: 'terminal',
      fullPath: '/home/dev/project/file.ts',
    });
    expect(requestInlineFilePreviewNav).not.toHaveBeenCalled();
    act(() => useQuickLookStore.getState().close());
    vi.runOnlyPendingTimers();
  });

  it('forwards terminal-query responses while the pane is hidden', async () => {
    render(
      <TerminalView
        terminalId="term-hidden-query"
        isActive={false}
        isTabActive={false}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    await act(async () => Promise.resolve());

    act(() => {
      emitPtyData('\x1b[6n', 1);
      vi.runOnlyPendingTimers();
    });

    expect(sendInput).toHaveBeenCalledWith('term-hidden-query', '\x1b[1;1R');
  });

  it('reports xterm focus and blur to the main process', () => {
    const { container, unmount } = render(
      <TerminalView
        terminalId="term-focus"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );
    const textarea = container.querySelector('.xterm-helper-textarea');
    expect(textarea).not.toBeNull();

    fireEvent.focus(textarea!);
    expect(setTerminalFocus).toHaveBeenCalledWith('term-focus', true);

    fireEvent.blur(textarea!);
    expect(setTerminalFocus).toHaveBeenCalledWith('term-focus', false);

    setTerminalFocus.mockClear();
    unmount();
    expect(setTerminalFocus).toHaveBeenCalledWith('term-focus', false);
  });

  it('opens the menu on right-click, unless the setting sent the click to the program', () => {
    const onLinkContextMenu = vi.fn();
    const { container, unmount } = render(
      <TerminalView
        terminalId="term-right-click"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        onLinkContextMenu={onLinkContextMenu}
      />
    );
    const xterm = container.querySelector('.xterm')!;
    const screen = xterm.appendChild(document.createElement('div'));
    terminalTestState.latestTerminal!.modes.mouseTrackingMode = 'vt200';
    const rightClick = () => {
      fireEvent.mouseDown(screen, { button: 2 });
      return fireEvent.contextMenu(screen, { button: 2 });
    };

    expect(rightClick()).toBe(true);
    expect(onLinkContextMenu).toHaveBeenCalledWith(null);

    updateTerminalRendererConfiguration('term-right-click', {
      fontSize: 14,
      fontFamily: 'monospace',
      lineHeight: 1,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 1000,
      theme: {},
      sendRightClickToPrograms: true,
    });
    onLinkContextMenu.mockClear();
    expect(rightClick()).toBe(false);
    expect(onLinkContextMenu).not.toHaveBeenCalled();

    // The Menu key opens the menu, as no press went to the program.
    expect(fireEvent.contextMenu(screen)).toBe(true);
    expect(onLinkContextMenu).toHaveBeenCalledWith(null);
    unmount();
  });

  it('raises low-contrast text to a readable minimum', () => {
    const { unmount } = render(
      <TerminalView
        terminalId="term-contrast"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );

    expect(terminalTestState.latestTerminal?.options.minimumContrastRatio).toBe(4.5);
    unmount();
  });

  it('rehydrates terminal host state from the PTY snapshot', async () => {
    const hostInfo = {
      hostname: 'devbox',
      isLocal: false,
    };
    getPtyBuffer.mockResolvedValue({ buffer: '', seq: 0, hostInfo });

    render(
      <TerminalView
        terminalId="term-host"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateTerminalHost).toHaveBeenCalledWith('term-host', hostInfo);
    vi.advanceTimersByTime(100);
  });

  it('coalesces container repairs per frame without redundantly resizing the PTY', () => {
    render(
      <TerminalView
        terminalId="term-1"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );

    vi.runOnlyPendingTimers();
    resizePty.mockClear();
    refresh.mockClear();
    fit.mockClear();

    expect(resizeObserverCallback).not.toBeNull();
    resizeObserverCallback?.([], {} as ResizeObserver);
    resizeObserverCallback?.([], {} as ResizeObserver);
    resizeObserverCallback?.([], {} as ResizeObserver);

    expect(fit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);

    expect(fit).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(0, 23);
    expect(resizePty).not.toHaveBeenCalled();

    resizeObserverCallback?.([], {} as ResizeObserver);
    vi.advanceTimersByTime(0);

    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued container repair when the terminal unmounts', () => {
    const { unmount } = render(
      <TerminalView
        terminalId="term-1"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
      />
    );

    vi.runOnlyPendingTimers();
    refresh.mockClear();
    fit.mockClear();

    expect(resizeObserverCallback).not.toBeNull();
    resizeObserverCallback?.([], {} as ResizeObserver);
    unmount();
    vi.runOnlyPendingTimers();

    expect(fit).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(resizeObserverDisconnect).toHaveBeenCalledOnce();
  });

  it('updates OSC 52 handling when managed tmux availability changes', () => {
    const { rerender } = render(
      <TerminalView
        terminalId="term-osc"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        allowOsc52Clipboard={false}
      />
    );

    expect(registerOscHandler).not.toHaveBeenCalledWith(52, expect.any(Function));

    rerender(
      <TerminalView
        terminalId="term-osc"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        allowOsc52Clipboard={true}
      />
    );
    expect(registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function));

    rerender(
      <TerminalView
        terminalId="term-osc"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        allowOsc52Clipboard={false}
      />
    );
    expect(disposeOscHandler).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
  });

  it('copies managed tmux selections through the local clipboard', () => {
    render(
      <TerminalView
        terminalId="term-selection"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        copyOnSelect={true}
      />
    );

    terminalSelection = 'remote output';
    act(() => selectionHandler?.());

    expect(window.api.copyToClipboard).toHaveBeenCalledWith('remote output');
    vi.runOnlyPendingTimers();
  });

  it('shows drop and upload feedback until a dropped file import finishes', async () => {
    let finishImport!: (path: string) => void;
    const file = new File(['contents'], 'cat.png', { type: 'image/png' });
    getPathForFile.mockReturnValue('/tmp/cat.png');
    importWorkspaceExternalFile.mockReturnValue(
      new Promise<string>((resolve) => {
        finishImport = resolve;
      })
    );
    const view = render(
      <TerminalView
        terminalId="term-drop"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        executionLocation="workspace"
        workspaceBackendKind="ssh"
      />
    );
    const dropTarget = view.container.firstElementChild as HTMLElement;
    const dataTransfer = { files: [file], types: ['Files'] };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    expect(view.getByText('Drop to upload')).toBeInTheDocument();

    fireEvent.drop(dropTarget, { dataTransfer });
    expect(view.getByRole('status')).toHaveTextContent('Uploading cat.png…');

    await act(async () => {
      finishImport('.komla-files/cat.png');
      await Promise.resolve();
    });

    expect(view.queryByRole('status')).not.toBeInTheDocument();
    expect(sendInput).toHaveBeenCalledWith('term-drop', '@.komla-files/cat.png ');
    vi.runOnlyPendingTimers();
  });

  it('imports a dropped file into an SSH local-copy pane', async () => {
    const file = new File(['contents'], 'notes.txt', { type: 'text/plain' });
    getPathForFile.mockReturnValue('/tmp/notes.txt');
    importWorkspaceExternalFile.mockResolvedValue('.komla-files/notes.txt');
    const view = render(
      <TerminalView
        terminalId="term-local-copy-drop"
        isActive={true}
        isTabActive={true}
        workingDirectory="ssh://ssh-dev/home/dev/project"
        workspaceId="workspace-1"
        executionLocation="local-mirror"
        workspaceBackendKind="ssh"
      />
    );
    const dropTarget = view.container.firstElementChild as HTMLElement;
    const dataTransfer = { files: [file], types: ['Files'] };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    expect(view.getByText('Drop to upload')).toBeInTheDocument();

    fireEvent.drop(dropTarget, { dataTransfer });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(importWorkspaceExternalFile).toHaveBeenCalledWith(
      'workspace-1',
      '/tmp/notes.txt',
      'notes.txt',
      'local-mirror'
    );
    expect(sendInput).toHaveBeenCalledWith('term-local-copy-drop', '@.komla-files/notes.txt ');
    vi.runOnlyPendingTimers();
  });

  it('re-lists the file tree after a drop, since the Remote Companion ignores Komla files', async () => {
    const workingDirectory = 'ssh://ssh-dev/home/dev/project';
    useWorkspacesStore.setState({
      workspaces: [createSshWorkspace({ id: 'workspace-1', workingDirectory })],
    });
    const file = new File(['contents'], 'notes.txt', { type: 'text/plain' });
    getPathForFile.mockReturnValue('/tmp/notes.txt');
    importWorkspaceExternalFile.mockResolvedValue('.komla-files/notes.txt');
    const view = render(
      <TerminalView
        terminalId="term-drop-refresh"
        isActive={true}
        isTabActive={true}
        workingDirectory={workingDirectory}
        workspaceId="workspace-1"
        executionLocation="workspace"
        workspaceBackendKind="ssh"
      />
    );

    try {
      fireEvent.drop(view.container.firstElementChild as HTMLElement, {
        dataTransfer: { files: [file], types: ['Files'] },
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchFileList).toHaveBeenCalledWith(workingDirectory, false, 'workspace-1');
    } finally {
      useWorkspacesStore.setState({ workspaces: [] });
      vi.runOnlyPendingTimers();
    }
  });

  it('shows an error toast when a dropped file cannot be imported', async () => {
    const file = new File(['contents'], 'cat.png', { type: 'image/png' });
    getPathForFile.mockReturnValue('/tmp/cat.png');
    importWorkspaceExternalFile.mockRejectedValue(new Error('connection lost'));
    const view = render(
      <TerminalView
        terminalId="term-drop-error"
        isActive={true}
        isTabActive={true}
        workingDirectory="/tmp/project"
        workspaceId="workspace-1"
        executionLocation="workspace"
        workspaceBackendKind="ssh"
      />
    );

    fireEvent.drop(view.container.firstElementChild as HTMLElement, {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addToast).toHaveBeenCalledWith('Couldn’t upload cat.png', 'error');
    expect(view.queryByRole('status')).not.toBeInTheDocument();
    vi.runOnlyPendingTimers();
  });
});
