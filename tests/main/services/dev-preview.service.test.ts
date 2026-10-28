import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: any[]) => void;

const mocks = vi.hoisted(() => ({
  loadURL: vi.fn(async () => undefined),
  previewSession: {
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  },
  createdViews: [] as any[],
  fromPartition: vi.fn(),
  userData: '',
}));
mocks.fromPartition.mockReturnValue(mocks.previewSession);

vi.mock('electron', () => {
  class MockView {
    readonly listeners = new Map<string, Listener>();
    windowOpenHandler: Listener | undefined;
    readonly setBounds = vi.fn();
    readonly setVisible = vi.fn();
    readonly webContents = {
      close: vi.fn(),
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        toJPEG: () => Buffer.from('frame'),
      })),
      executeJavaScript: vi.fn(async () => undefined),
      getTitle: vi.fn(() => ''),
      getURL: vi.fn(() => 'http://localhost:5173/dashboard'),
      isDestroyed: vi.fn(() => false),
      loadURL: mocks.loadURL,
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
        clear: vi.fn(),
        goBack: vi.fn(),
        goForward: vi.fn(),
      },
      on: vi.fn((event: string, listener: Listener) => {
        this.listeners.set(event, listener);
      }),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: Listener) => {
        this.windowOpenHandler = handler;
      }),
      stop: vi.fn(),
    };

    constructor(readonly options: unknown) {
      mocks.createdViews.push(this);
    }
  }

  return {
    app: { getPath: vi.fn(() => mocks.userData) },
    session: { fromPartition: mocks.fromPartition },
    WebContentsView: MockView,
  };
});

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const shortcuts: Record<string, string> = {
  'pane.close': 'Cmd+Alt+W',
  'pane.focusNext': 'Cmd+K',
  'workspace.new': 'Cmd+N',
  'commandCenter.open': 'Cmd+P',
  'workspace.select.2': 'Cmd+2',
  'workspace.select.3': 'Alt+3',
};

const toastOverlay = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../../../src/main/services/toast-overlay.service', () => ({
  toastOverlayService: toastOverlay,
}));

vi.mock('../../../src/main/services/shortcuts.service', () => ({
  shortcutsService: { getShortcut: vi.fn((action: string) => shortcuts[action]) },
}));

import {
  DevPreviewService,
  MAX_RETAINED_PREVIEW_VIEWS,
} from '../../../src/main/services/dev-preview.service';

function createOwner() {
  const listeners = new Map<string, Listener>();
  return {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    getContentBounds: vi.fn(() => ({ x: 20, y: 30, width: 800, height: 600 })),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
    webContents: {
      focus: vi.fn(),
      getZoomFactor: vi.fn(() => 1.25),
      id: 42,
      isDestroyed: vi.fn(() => false),
      on: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
      send: vi.fn(),
    },
    emit(event: string) {
      listeners.get(event)?.();
    },
  };
}

describe('DevPreviewService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadURL.mockResolvedValue(undefined);
    mocks.fromPartition.mockReturnValue(mocks.previewSession);
    mocks.createdViews.length = 0;
    mocks.userData = mkdtempSync(join(tmpdir(), 'komla-preview-sessions-'));
  });

  afterEach(() => {
    rmSync(mocks.userData, { recursive: true, force: true });
  });

  it('hosts a tab page in a first-party WebContentsView with a persistent session', async () => {
    const service = new DevPreviewService();
    service.setProjectLookup(() => 'project-1');
    const owner = createOwner();

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173/dashboard', {
      x: 100,
      y: 80,
      width: 400,
      height: 300,
    });
    await Promise.resolve();

    expect(mocks.fromPartition).toHaveBeenCalledWith(
      expect.stringMatching(/^persist:komla-dev-preview-[0-9a-f]{32}$/)
    );
    expect(mocks.createdViews).toHaveLength(1);
    expect(mocks.createdViews[0].options).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: mocks.previewSession,
      },
    });
    expect(owner.contentView.addChildView).toHaveBeenCalledWith(mocks.createdViews[0]);
    // The toast layer loads alongside the first preview, so the first toast over it is instant.
    expect(toastOverlay.prepare).toHaveBeenCalledWith(owner);
    expect(mocks.createdViews[0].webContents.loadURL).toHaveBeenCalledWith(
      'http://localhost:5173/dashboard'
    );
    expect(mocks.createdViews[0].setBounds).toHaveBeenCalledWith({
      x: 125,
      y: 100,
      width: 500,
      height: 375,
    });
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('keeps the native page alive while hidden and reuses it when shown again', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();
    service.hide(owner.webContents.id, 'workspace-1', 'tab-1');
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);

    expect(mocks.createdViews).toHaveLength(1);
    expect(mocks.createdViews[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('publishes retained navigation state when shown again', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();
    mocks.createdViews[0].webContents.navigationHistory.canGoBack.mockReturnValue(true);
    service.hide(owner.webContents.id, 'workspace-1', 'tab-1');
    owner.webContents.send.mockClear();

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);

    expect(owner.webContents.send).toHaveBeenCalledWith('dev-preview:navigation-state-changed', {
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      url: 'http://localhost:5173/dashboard',
      title: '',
      canGoBack: true,
      canGoForward: false,
      loadError: null,
    });
  });

  it('retries the same URL after its first native load fails', async () => {
    mocks.loadURL.mockRejectedValueOnce(new Error('server not ready'));
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();
    await Promise.resolve();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();

    expect(mocks.loadURL).toHaveBeenCalledTimes(2);
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('cancels downloads started by preview content', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const preventDefault = vi.fn();
    const downloadListener = mocks.previewSession.on.mock.calls.find(
      ([event]) => event === 'will-download'
    )?.[1];

    downloadListener?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('says why a tab opened straight to a download is empty', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    mocks.loadURL.mockReturnValueOnce(new Promise(() => {}));
    service.sync(owner as never, 'workspace-1', 'tab-1', 'https://example.com/tool.zip', bounds);
    service.sync(owner as never, 'workspace-1', 'tab-2', 'https://example.com/', bounds);
    await Promise.resolve();
    const [downloadTab, loadedTab] = mocks.createdViews;
    const downloadListener = mocks.previewSession.on.mock.calls.find(
      ([event]) => event === 'will-download'
    )?.[1];

    // A download link on a page that loaded leaves the page as it is.
    downloadListener?.({ preventDefault: vi.fn() }, {}, loadedTab.webContents);
    expect(owner.webContents.send).not.toHaveBeenCalledWith(
      'dev-preview:navigation-state-changed',
      expect.objectContaining({ tabId: 'tab-2', loadError: expect.any(String) })
    );

    downloadListener?.({ preventDefault: vi.fn() }, {}, downloadTab.webContents);
    expect(owner.webContents.send).toHaveBeenLastCalledWith(
      'dev-preview:navigation-state-changed',
      expect.objectContaining({
        tabId: 'tab-1',
        loadError: expect.stringContaining("doesn't download files"),
      })
    );
  });

  it('gives each tab its own page, kept while hidden', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();
    service.hide(owner.webContents.id, 'workspace-1', 'tab-1');
    service.sync(owner as never, 'workspace-2', 'tab-1', 'https://example.com/', bounds);
    await Promise.resolve();

    expect(mocks.createdViews).toHaveLength(2);
    expect(mocks.createdViews[1].webContents.loadURL).toHaveBeenCalledWith('https://example.com/');
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(false);

    // Showing it again shows the first page as it was, without loading it again.
    service.hide(owner.webContents.id, 'workspace-2', 'tab-1');
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    expect(mocks.loadURL).toHaveBeenCalledTimes(2);
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(mocks.createdViews[1].setVisible).toHaveBeenLastCalledWith(false);
  });

  it('shows browser pane pages beside each other', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'surface:browser:a/1', 'https://a.test/', bounds);
    await Promise.resolve();
    service.sync(owner as never, 'workspace-1', 'surface:browser:b/1', 'https://b.test/', bounds);
    await Promise.resolve();

    expect(mocks.createdViews).toHaveLength(2);
    for (const view of mocks.createdViews) {
      expect(view.setVisible).toHaveBeenLastCalledWith(true);
    }
  });

  it('closes the least recently shown hidden pages beyond the retained limit', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    // Each page hides as the next one shows, as switching a pane's tab does.
    for (let index = 0; index <= MAX_RETAINED_PREVIEW_VIEWS; index += 1) {
      if (index > 0) service.hide(owner.webContents.id, 'workspace-1', `tab-${index - 1}`);
      service.sync(owner as never, 'workspace-1', `tab-${index}`, 'http://localhost:5173', bounds);
      await Promise.resolve();
    }

    expect(mocks.createdViews).toHaveLength(MAX_RETAINED_PREVIEW_VIEWS + 1);
    expect(mocks.createdViews[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(mocks.createdViews[0]);
    expect(mocks.createdViews[1].webContents.close).not.toHaveBeenCalled();

    // A closed page loads again when its tab is shown.
    service.sync(owner as never, 'workspace-1', 'tab-0', 'http://localhost:5173', bounds);
    expect(mocks.createdViews).toHaveLength(MAX_RETAINED_PREVIEW_VIEWS + 2);
  });

  it('closes a tab page on request', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    service.close(owner.webContents.id, 'workspace-1', 'tab-1');

    expect(mocks.createdViews[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(service.reload(owner.webContents.id, 'workspace-1', 'tab-1', false)).toBe(false);
  });

  it('ignores URLs that are not web pages', () => {
    const service = new DevPreviewService();
    const owner = createOwner();

    service.sync(owner as never, 'workspace-1', 'tab-1', 'file:///etc/passwd', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    expect(mocks.createdViews).toHaveLength(0);
  });

  it('keeps a page where it navigated when the renderer saves that URL', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173/dashboard', bounds);

    expect(mocks.loadURL).toHaveBeenCalledTimes(1);
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('opens links that ask for a new window as a tab of the same workspace', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const openWindow = mocks.createdViews[0].windowOpenHandler!;

    expect(openWindow({ url: 'https://example.com/help' })).toEqual({ action: 'deny' });
    expect(openWindow({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });

    expect(owner.webContents.send).toHaveBeenCalledTimes(1);
    expect(owner.webContents.send).toHaveBeenCalledWith('dev-preview:open-tab', {
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      url: 'https://example.com/help',
    });
  });

  it('opens no tabs for hidden pages, and one a second for the page on screen', () => {
    vi.useFakeTimers();
    try {
      const service = new DevPreviewService();
      const owner = createOwner();
      const bounds = { x: 0, y: 0, width: 400, height: 300 };
      service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
      const openWindow = mocks.createdViews[0].windowOpenHandler!;

      openWindow({ url: 'https://example.com/1' });
      openWindow({ url: 'https://example.com/2' });
      vi.advanceTimersByTime(1000);
      openWindow({ url: 'https://example.com/3' });
      service.hide(owner.webContents.id, 'workspace-1', 'tab-1');
      vi.advanceTimersByTime(1000);
      openWindow({ url: 'https://example.com/4' });

      const opened = owner.webContents.send.mock.calls
        .filter(([channel]) => channel === 'dev-preview:open-tab')
        .map(([, request]) => request.url);
      expect(opened).toEqual(['https://example.com/1', 'https://example.com/3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures one retained frame at a time while a page changes its URL', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const view = mocks.createdViews[0];
    let finish!: (image: unknown) => void;
    view.webContents.capturePage.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    view.listeners.get('did-navigate-in-page')?.();
    view.listeners.get('did-navigate-in-page')?.();
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);

    finish({ isEmpty: () => true, toJPEG: () => Buffer.alloc(0) });
    await Promise.resolve();
    await Promise.resolve();
    view.listeners.get('did-navigate-in-page')?.();
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(2);
  });

  it('publishes page titles and why a page failed to load', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'https://example.com/', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const view = mocks.createdViews[0];
    view.webContents.getURL.mockReturnValue('https://example.com/');
    view.webContents.getTitle.mockReturnValue('Example Domain');

    view.listeners.get('page-title-updated')?.();
    expect(owner.webContents.send).toHaveBeenLastCalledWith(
      'dev-preview:navigation-state-changed',
      expect.objectContaining({ title: 'Example Domain', loadError: null })
    );

    view.webContents.getTitle.mockReturnValue('https://example.com/');
    view.listeners.get('did-fail-load')?.({}, -105, 'ERR_NAME_NOT_RESOLVED', '', true);
    expect(owner.webContents.send).toHaveBeenLastCalledWith(
      'dev-preview:navigation-state-changed',
      expect.objectContaining({ title: '', loadError: 'ERR_NAME_NOT_RESOLVED' })
    );
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    // The error page finishing its load is not the page loading.
    owner.webContents.send.mockClear();
    view.listeners.get('did-finish-load')?.();
    expect(owner.webContents.send).not.toHaveBeenCalled();
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    view.listeners.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: false });
    view.listeners.get('did-finish-load')?.();
    expect(owner.webContents.send).toHaveBeenCalledWith(
      'dev-preview:navigation-state-changed',
      expect.objectContaining({ loadError: null })
    );
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('reloads the active workspace normally or while ignoring cache', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();

    expect(service.reload(owner.webContents.id, 'workspace-1', 'tab-1', false)).toBe(true);
    expect(mocks.createdViews[0].webContents.reload).toHaveBeenCalledTimes(1);
    expect(service.reload(owner.webContents.id, 'workspace-1', 'tab-1', true)).toBe(true);
    expect(mocks.createdViews[0].webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(service.reload(owner.webContents.id, 'another-workspace', 'tab-1', false)).toBe(false);
  });

  it('becomes visible when a reload finishes after the initial load was aborted', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    service.reload(owner.webContents.id, 'workspace-1', 'tab-1', false);
    mocks.createdViews[0].listeners.get('did-finish-load')?.();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);

    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('retries the same URL after a reload fails', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();
    service.reload(owner.webContents.id, 'workspace-1', 'tab-1', false);
    mocks.createdViews[0].listeners.get('did-fail-load')?.(
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://localhost:5173',
      true
    );

    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    await Promise.resolve();

    expect(mocks.loadURL).toHaveBeenCalledTimes(2);
    expect(mocks.createdViews[0].setVisible).toHaveBeenLastCalledWith(true);
  });

  it('routes the configured pane-close shortcut to the owner renderer', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const preventDefault = vi.fn();

    mocks.createdViews[0].listeners.get('before-input-event')?.(
      { preventDefault },
      {
        type: 'keyDown',
        key: 'w',
        control: process.platform !== 'darwin',
        meta: process.platform === 'darwin',
        alt: true,
      }
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(owner.webContents.send).toHaveBeenCalledWith('shortcut:pane-close');
    expect(owner.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('names the browser pane a pane-close shortcut came from', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'surface:browser:a', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    mocks.createdViews[0].listeners.get('before-input-event')?.(
      { preventDefault: vi.fn() },
      {
        type: 'keyDown',
        key: 'w',
        control: process.platform !== 'darwin',
        meta: process.platform === 'darwin',
        alt: true,
      }
    );

    expect(owner.webContents.send).toHaveBeenCalledWith('shortcut:pane-close', {
      workspaceId: 'workspace-1',
      tabId: 'surface:browser:a',
    });
  });

  it('tells the owner renderer when its page gains focus', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'surface:browser:a', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    mocks.createdViews[0].listeners.get('focus')?.();

    expect(owner.webContents.send).toHaveBeenCalledWith('dev-preview:focused', {
      workspaceId: 'workspace-1',
      tabId: 'surface:browser:a',
    });
  });

  it('hands window and workspace shortcuts from the page back to Komla', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const isMac = process.platform === 'darwin';
    const sendKey = (key: string) => {
      const preventDefault = vi.fn();
      mocks.createdViews[0].listeners.get('before-input-event')?.(
        { preventDefault },
        { type: 'keyDown', key, control: !isMac, meta: isMac }
      );
      return preventDefault;
    };

    expect(sendKey('n')).toHaveBeenCalledTimes(1);
    expect(sendKey('2')).toHaveBeenCalledTimes(1);
    expect(sendKey('p')).toHaveBeenCalledTimes(1);

    expect(owner.webContents.focus).toHaveBeenCalledTimes(3);
    expect(owner.webContents.send).toHaveBeenCalledWith('shortcut:forwarded', 'workspace.new');
    expect(owner.webContents.send).toHaveBeenCalledWith('shortcut:forwarded', 'workspace.select.2');
    expect(owner.webContents.send).toHaveBeenCalledWith('shortcut:forwarded', 'commandCenter.open');
  });

  it('leaves custom bindings without Cmd or Ctrl to the page', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const preventDefault = vi.fn();

    mocks.createdViews[0].listeners.get('before-input-event')?.(
      { preventDefault },
      { type: 'keyDown', key: '3', alt: true }
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(owner.webContents.send).not.toHaveBeenCalled();
  });

  it('leaves shortcuts that web apps commonly bind to the page', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    const preventDefault = vi.fn();
    const isMac = process.platform === 'darwin';

    mocks.createdViews[0].listeners.get('before-input-event')?.(
      { preventDefault },
      { type: 'keyDown', key: 'k', control: !isMac, meta: isMac }
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(owner.webContents.focus).not.toHaveBeenCalled();
    expect(owner.webContents.send).not.toHaveBeenCalledWith(
      'shortcut:forwarded',
      expect.anything()
    );
  });

  it('publishes a retained frame after navigation for renderer overlays', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    mocks.createdViews[0].listeners.get('did-finish-load')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(owner.webContents.send).toHaveBeenCalledWith('dev-preview:snapshot-updated', {
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      dataUrl: 'data:image/jpeg;base64,ZnJhbWU=',
    });
  });

  it('captures the live page on demand for renderer overlays', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();

    await expect(service.capture(owner.webContents.id, 'workspace-1', 'tab-1')).resolves.toBe(
      'data:image/jpeg;base64,ZnJhbWU='
    );
  });

  it('does not capture a page that is loading, hidden, or owned by another workspace', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    await expect(service.capture(owner.webContents.id, 'workspace-1', 'tab-1')).resolves.toBeNull();
    await Promise.resolve();
    await expect(service.capture(owner.webContents.id, 'workspace-2', 'tab-1')).resolves.toBeNull();
    service.hide(owner.webContents.id, 'workspace-1', 'tab-1');
    await expect(service.capture(owner.webContents.id, 'workspace-1', 'tab-1')).resolves.toBeNull();
    expect(mocks.createdViews[0].webContents.capturePage).not.toHaveBeenCalled();
  });

  it('returns no frame when the native capture is empty', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    mocks.createdViews[0].webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      toJPEG: () => Buffer.alloc(0),
    });

    await expect(service.capture(owner.webContents.id, 'workspace-1', 'tab-1')).resolves.toBeNull();
  });

  it('does not publish an empty frame after navigation', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    mocks.createdViews[0].webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      toJPEG: () => Buffer.alloc(0),
    });

    mocks.createdViews[0].listeners.get('did-finish-load')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(owner.webContents.send).not.toHaveBeenCalledWith(
      'dev-preview:snapshot-updated',
      expect.anything()
    );
  });

  it('shares one native capture between overlapping requests', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    const { capturePage } = mocks.createdViews[0].webContents;

    const frames = await Promise.all([
      service.capture(owner.webContents.id, 'workspace-1', 'tab-1'),
      service.capture(owner.webContents.id, 'workspace-1', 'tab-1'),
    ]);
    expect(frames).toEqual(['data:image/jpeg;base64,ZnJhbWU=', 'data:image/jpeg;base64,ZnJhbWU=']);
    expect(capturePage).toHaveBeenCalledTimes(1);

    await service.capture(owner.webContents.id, 'workspace-1', 'tab-1');
    expect(capturePage).toHaveBeenCalledTimes(2);
  });

  it('stops sharing a native capture that never finishes', async () => {
    vi.useFakeTimers();
    try {
      const service = new DevPreviewService();
      const owner = createOwner();
      service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      });
      await Promise.resolve();
      const { capturePage } = mocks.createdViews[0].webContents;
      capturePage.mockReturnValueOnce(new Promise(() => undefined));

      const stalled = service.capture(owner.webContents.id, 'workspace-1', 'tab-1');
      await vi.advanceTimersByTimeAsync(1000);

      await expect(stalled).resolves.toBeNull();
      await expect(service.capture(owner.webContents.id, 'workspace-1', 'tab-1')).resolves.toBe(
        'data:image/jpeg;base64,ZnJhbWU='
      );
      expect(capturePage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no frame when the native capture fails', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    mocks.createdViews[0].webContents.capturePage.mockRejectedValueOnce(new Error('gone'));

    await expect(service.capture(owner.webContents.id, 'workspace-1', 'tab-1')).resolves.toBeNull();
  });

  it("gives each project's pages their own session, shared by its workspaces", async () => {
    const service = new DevPreviewService();
    const projects: Record<string, string | null> = {
      'a-1': 'project-a',
      'a-2': 'project-a',
      'b-1': 'project-b',
      loose: null,
    };
    service.setProjectLookup((workspaceId) => projects[workspaceId]);
    mocks.fromPartition.mockImplementation((partition: string) => ({
      ...mocks.previewSession,
      partition,
    }));
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    for (const workspaceId of Object.keys(projects)) {
      service.sync(owner as never, workspaceId, 'tab-1', 'http://localhost:3000/', bounds);
    }
    await Promise.resolve();

    const partitions = mocks.createdViews.map((view) => view.options.webPreferences.session.partition);
    expect(partitions[0]).toBe(partitions[1]);
    expect(new Set(partitions).size).toBe(3);
    // A workspace without a project keeps nothing once Komla quits.
    expect(partitions[3]).not.toMatch(/^persist:/);
  });

  it("closes a deleted project's pages, then clears its session", async () => {
    const service = new DevPreviewService();
    service.setProjectLookup(() => 'project-a');
    service.sync(createOwner() as never, 'a-1', 'tab-1', 'http://localhost:3000/', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    const page = mocks.createdViews[0].webContents;
    page.close.mockImplementation(() => {
      expect(mocks.previewSession.clearStorageData).not.toHaveBeenCalled();
    });

    await service.clearProjectData('project-a');

    expect(page.close).toHaveBeenCalled();
    expect(mocks.previewSession.clearStorageData).toHaveBeenCalledWith();
    expect(mocks.previewSession.clearCache).toHaveBeenCalled();
  });

  it("removes a deleted project's saved session without loading it", async () => {
    const service = new DevPreviewService();
    service.setProjectLookup(() => 'project-a');
    service.sync(createOwner() as never, 'a-1', 'tab-1', 'http://localhost:3000/', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    const folder = join(
      mocks.userData,
      'Partitions',
      mocks.fromPartition.mock.calls[0][0].replace(/^persist:/, '')
    );
    mkdirSync(folder, { recursive: true });
    mocks.fromPartition.mockClear();

    // As after a restart, when no page of the project has opened yet.
    await new DevPreviewService().clearProjectData('project-a');

    expect(existsSync(folder)).toBe(false);
    expect(mocks.fromPartition).not.toHaveBeenCalled();
  });

  it('removes the session all projects used to share, and only that one', async () => {
    const shared = join(mocks.userData, 'Partitions', 'komla-dev-preview');
    const project = join(mocks.userData, 'Partitions', 'komla-dev-preview-0123');
    mkdirSync(shared, { recursive: true });
    mkdirSync(project, { recursive: true });

    await new DevPreviewService().removeSharedSessionData();

    expect(existsSync(shared)).toBe(false);
    expect(existsSync(project)).toBe(true);
  });

  it('clears site data from the dedicated preview session', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173/dashboard', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();

    expect(await service.clearSiteData(owner.webContents.id, 'workspace-1', 'tab-1')).toBe(true);
    expect(mocks.createdViews[0].webContents.executeJavaScript).toHaveBeenCalledWith(
      'sessionStorage.clear(); localStorage.clear();',
      false
    );
    expect(mocks.previewSession.clearStorageData).toHaveBeenCalledWith({
      origin: 'http://localhost:5173',
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'serviceworkers',
        'cachestorage',
      ],
    });
    expect(mocks.previewSession.clearCache).toHaveBeenCalledTimes(1);
  });

  it('clears the configured origin after an opaque navigation', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173/dashboard', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    mocks.createdViews[0].webContents.getURL.mockReturnValue('about:blank');

    await service.clearSiteData(owner.webContents.id, 'workspace-1', 'tab-1');

    expect(mocks.previewSession.clearStorageData).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'http://localhost:5173' })
    );
  });

  it('navigates backward and forward only when history allows it', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    const history = mocks.createdViews[0].webContents.navigationHistory;
    history.canGoBack.mockReturnValue(true);

    expect(service.navigate(owner.webContents.id, 'workspace-1', 'tab-1', 'back')).toBe(true);
    expect(history.goBack).toHaveBeenCalledTimes(1);
    expect(service.navigate(owner.webContents.id, 'workspace-1', 'tab-1', 'forward')).toBe(false);
    expect(history.goForward).not.toHaveBeenCalled();
  });

  it('publishes native navigation history state to the owner renderer', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    const history = mocks.createdViews[0].webContents.navigationHistory;
    history.canGoBack.mockReturnValue(true);

    mocks.createdViews[0].listeners.get('did-navigate')?.();

    expect(owner.webContents.send).toHaveBeenCalledWith('dev-preview:navigation-state-changed', {
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      url: 'http://localhost:5173/dashboard',
      title: '',
      canGoBack: true,
      canGoForward: false,
      loadError: null,
    });
  });

  it('closes the child WebContents without touching its destroyed owner', async () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await Promise.resolve();
    owner.isDestroyed.mockReturnValue(true);
    owner.contentView.removeChildView.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });

    expect(() => owner.emit('closed')).not.toThrow();

    expect(owner.contentView.removeChildView).not.toHaveBeenCalled();
    expect(mocks.createdViews[0].webContents.close).toHaveBeenCalledTimes(1);
  });

  it('closes every tab page when its window closes, without reading the destroyed window', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    service.sync(owner as never, 'workspace-1', 'tab-2', 'http://localhost:5174', bounds);
    const ownerWebContents = owner.webContents;
    // Like Electron, a closed window throws when its webContents is read.
    owner.isDestroyed.mockReturnValue(true);
    Object.defineProperty(owner, 'webContents', {
      get: () => {
        throw new TypeError('Object has been destroyed');
      },
    });

    expect(() => owner.emit('closed')).not.toThrow();

    expect(mocks.createdViews.map((view) => view.webContents.close.mock.calls.length)).toEqual([
      1, 1,
    ]);
    // A new window that reuses the id starts with no tabs.
    const next = createOwner();
    service.sync(next as never, 'workspace-1', 'tab-1', 'http://localhost:5173', bounds);
    expect(mocks.createdViews).toHaveLength(3);
    expect(ownerWebContents.id).toBe(next.webContents.id);
  });

  it('removes the child view when disposed while its owner is alive', () => {
    const service = new DevPreviewService();
    const owner = createOwner();
    service.sync(owner as never, 'workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    service.dispose(owner.webContents.id);

    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(mocks.createdViews[0]);
    expect(mocks.createdViews[0].webContents.close).toHaveBeenCalledTimes(1);
  });
});
