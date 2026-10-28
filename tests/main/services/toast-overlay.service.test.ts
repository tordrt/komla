import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: any[]) => void;

const mocks = vi.hoisted(() => ({
  createdViews: [] as any[],
  focused: null as { focus: () => void; isDestroyed: () => boolean } | null,
}));

vi.mock('electron', () => {
  let nextId = 100;
  class MockView {
    readonly listeners = new Map<string, Listener>();
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn();
    readonly setVisible = vi.fn();
    readonly webContents = {
      close: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
      id: nextId++,
      isDestroyed: vi.fn(() => false),
      loadFile: vi.fn(async () => undefined),
      loadURL: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: Listener) => {
        this.listeners.set(event, listener);
      }),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
    };

    constructor(readonly options: unknown) {
      mocks.createdViews.push(this);
    }
  }

  return {
    WebContentsView: MockView,
    webContents: { getFocusedWebContents: () => mocks.focused },
  };
});

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('../../../src/main/lib/module-path', () => ({ MAIN_BUNDLE_DIR: '/app/out/main' }));
vi.mock('../../../src/main/services/shortcuts.service', () => ({
  shortcutsService: {
    getShortcut: vi.fn((action: string) => (action === 'pane.close' ? 'Cmd+W' : undefined)),
  },
}));

import { ToastOverlayService } from '../../../src/main/services/toast-overlay.service';
import { IPC } from '../../../src/shared/constants/ipc-channels';

const state = {
  bounds: { x: 900.4, y: 740.2, width: 284.3, height: 44 },
  toasts: [{ id: 'a1', message: 'Saved', type: 'success' as const, dismissOnTimeout: true }],
  themeClassName: 'dark',
  themeStyle: '--primary: 0.5 0.1 200;',
  messageMaxHeight: 320,
};
const { bounds: _bounds, ...content } = state;

function createOwner() {
  const listeners = new Map<string, Listener>();
  const children: unknown[] = [];
  return {
    contentView: {
      children,
      addChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index !== -1) children.splice(index, 1);
        children.push(view);
      }),
      removeChildView: vi.fn(),
    },
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

describe('ToastOverlayService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createdViews.length = 0;
    mocks.focused = null;
  });

  it('draws toasts in a transparent, sandboxed view on top of the window', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();

    service.show(owner as never, state);
    const [view] = mocks.createdViews;
    view.listeners.get('did-finish-load')?.();

    expect(view.options).toMatchObject({
      webPreferences: {
        preload: join('/app/out/main', '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    expect(view.webContents.loadFile).toHaveBeenCalledWith(
      join('/app/out/main', '../renderer/toast-overlay.html')
    );
    expect(owner.contentView.children.at(-1)).toBe(view);
  });

  it('joins the window only once its page has loaded, since loading takes keyboard focus', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();

    service.show(owner as never, state);
    const [view] = mocks.createdViews;
    expect(owner.contentView.addChildView).not.toHaveBeenCalled();
    expect(view.setVisible).not.toHaveBeenCalledWith(true);
    expect(view.webContents.send).not.toHaveBeenCalled();

    view.listeners.get('did-finish-load')?.();

    expect(owner.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.send).toHaveBeenCalledWith(IPC.TOAST_OVERLAY_CONTENT, content);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('can load its page ahead of the first toast without joining the window', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();

    service.prepare(owner as never);
    service.prepare(owner as never);
    const [view] = mocks.createdViews;
    view.listeners.get('did-finish-load')?.();

    expect(mocks.createdViews).toHaveLength(1);
    expect(view.webContents.loadFile).toHaveBeenCalledTimes(1);
    expect(owner.contentView.addChildView).not.toHaveBeenCalled();

    service.show(owner as never, state);
    expect(owner.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('covers the stack, rounded outward, at the window zoom', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;

    view.listeners.get('did-finish-load')?.();

    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 1125, y: 925, width: 356, height: 56 });
    expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('moves back above browser previews added after it', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;
    view.listeners.get('did-finish-load')?.();
    const preview = {};
    owner.contentView.addChildView(preview);
    owner.contentView.addChildView.mockClear();

    service.show(owner as never, state);
    service.show(owner as never, state);

    expect(owner.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(owner.contentView.children).toEqual([preview, view]);
  });

  it('clears hidden toasts so they stop counting down', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;
    view.listeners.get('did-finish-load')?.();

    service.hide(42);

    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.TOAST_OVERLAY_CONTENT, {
      toasts: [],
      themeClassName: '',
      themeStyle: '',
      messageMaxHeight: 0,
    });
  });

  it('hides when the main window navigates, but not while a frame inside it loads', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;
    view.listeners.get('did-finish-load')?.();

    owner.emit('did-start-loading');
    expect(view.setVisible).toHaveBeenLastCalledWith(true);

    owner.emit('did-navigate');
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('never navigates away from its page, which has the preload API', () => {
    const service = new ToastOverlayService();
    service.prepare(createOwner() as never);
    const preventDefault = vi.fn();

    mocks.createdViews[0].listeners.get('will-navigate')?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane-close shortcut from closing the window while a toast has focus', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.prepare(owner as never);
    const preventDefault = vi.fn();

    mocks.createdViews[0].listeners.get('before-input-event')?.(
      { preventDefault },
      {
        type: 'keyDown',
        key: 'w',
        control: process.platform !== 'darwin',
        meta: process.platform === 'darwin',
      }
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(owner.webContents.send).toHaveBeenCalledWith(IPC.SHORTCUT_PANE_CLOSE);
  });

  it('relays events from its page to the window that owns it', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;

    service.forwardEvent(view.webContents.id, { type: 'remove', id: 'a1' });
    service.forwardEvent(999, { type: 'remove', id: 'a1' });

    expect(owner.webContents.send).toHaveBeenCalledTimes(1);
    expect(owner.webContents.send).toHaveBeenCalledWith(IPC.TOAST_OVERLAY_EVENT, {
      type: 'remove',
      id: 'a1',
    });
  });

  it('gives keyboard focus back once the page reports a click on a toast is done', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;
    const preview = { focus: vi.fn(), isDestroyed: () => false };
    mocks.focused = preview;

    view.listeners.get('before-mouse-event')?.({}, { type: 'mouseDown' });
    service.releaseFocus(999);
    expect(preview.focus).not.toHaveBeenCalled();

    service.releaseFocus(view.webContents.id);
    service.releaseFocus(view.webContents.id);
    expect(preview.focus).toHaveBeenCalledTimes(1);
  });

  it('gives the window keyboard focus for an action, which can open Komla UI', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;

    service.forwardEvent(view.webContents.id, { type: 'remove', id: 'a1' });
    expect(owner.webContents.focus).not.toHaveBeenCalled();

    service.forwardEvent(view.webContents.id, { type: 'action', id: 'a1' });
    expect(owner.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('gives focus to the window when nothing had it before the click', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;

    view.listeners.get('before-mouse-event')?.({}, { type: 'mouseDown' });
    service.releaseFocus(view.webContents.id);

    expect(owner.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('closes the view with its window', () => {
    const service = new ToastOverlayService();
    const owner = createOwner();
    service.show(owner as never, state);
    const [view] = mocks.createdViews;

    owner.emit('closed');

    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalled();
  });
});
