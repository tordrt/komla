import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../../src/shared/constants/ipc-channels';

import type { PromptDraftWindowContext } from '../../../src/shared/types';

type Listener = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  function emitter() {
    const handlers = new Map<string, Listener[]>();
    return {
      handlers,
      on: (event: string, handler: Listener) =>
        void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      emit: (event: string, ...args: unknown[]) =>
        handlers.get(event)?.forEach((handler) => handler(...args)),
    };
  }

  const windows: BrowserWindow[] = [];
  const appEvents = emitter();
  class BrowserWindow {
    events = emitter();
    on = this.events.on;
    visible = false;
    destroyed = false;
    bounds: { x: number; y: number; width: number; height: number };
    webContents = {
      id: 500 + windows.length,
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    };
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn((bounds: BrowserWindow['bounds']) => {
      this.bounds = bounds;
    });
    getBounds = () => this.bounds;
    show = vi.fn(() => {
      this.visible = true;
      this.events.emit('show');
    });
    hide = vi.fn(() => {
      this.visible = false;
      this.events.emit('hide');
    });
    focus = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.events.emit('closed');
    });
    constructor(public options: Record<string, unknown>) {
      const { x = 0, y = 0, width = 0, height = 0 } = options as Record<string, number>;
      this.bounds = { x, y, width, height };
      windows.push(this);
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    /** Closed as a window is, as with Cmd+W. */
    close() {
      this.events.emit('close');
      this.destroy();
    }
  }

  return {
    windows,
    appEvents,
    module: {
      app: { on: appEvents.on },
      BrowserWindow,
      nativeTheme: { shouldUseDarkColors: true },
      screen: {
        getDisplayMatching: vi.fn(() => ({
          workArea: { x: 0, y: 25, width: 1440, height: 875 },
        })),
      },
    },
  };
});

vi.mock('electron', () => electron.module);
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

/** Komla's own windows, by id, as the window service has them. */
const komla = vi.hoisted(() => {
  const windows = new Map<
    string,
    {
      webContents: { id: number; getZoomFactor: () => number };
      getContentBounds: () => { x: number; y: number; width: number; height: number };
      isDestroyed: () => boolean;
      isMinimized: () => boolean;
      restore: () => void;
      show: () => void;
      focus: () => void;
    }
  >();
  return {
    windows,
    service: {
      getWindow: (windowId: string) => windows.get(windowId),
      getWindowId: (webContentsId: number) =>
        [...windows].find(([, window]) => window.webContents.id === webContentsId)?.[0],
      getMainWindowId: () => windows.keys().next().value ?? null,
      getAllWindowIds: () => [...windows.keys()],
      sendWhenReady: vi.fn(),
      sendToWindowOrNext: vi.fn(),
      broadcastToAll: vi.fn(),
    },
  };
});

vi.mock('../../../src/main/services/window.service', () => ({
  windowService: komla.service,
  showWindow: (window: { show: () => void }) => window.show(),
  WINDOWS_TAKE_FOCUS: true,
  HIDDEN_WINDOW_OPTIONS: {},
  HIDDEN_WINDOW_WEB_PREFERENCES: {},
}));

function addKomlaWindow(windowId: string, webContentsId: number, zoom = 1) {
  const window = {
    webContents: { id: webContentsId, getZoomFactor: () => zoom },
    getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  komla.windows.set(windowId, window);
  return window;
}

const draft = { text: 'Fix the header', selectionStart: 4, selectionEnd: 4 };
const rect = { x: 600, y: 400, width: 440, height: 280 };

function context(overrides: Partial<PromptDraftWindowContext> = {}): PromptDraftWindowContext {
  return {
    theme: { className: 'dark', style: '--background: 0 0 0;' },
    workspaceId: 'ws-1',
    viewedFileName: 'server.ts',
    ...overrides,
  };
}

async function load() {
  const { promptDraftWindowService } =
    await import('../../../src/main/services/prompt-draft-window.service');
  promptDraftWindowService.init();
  return promptDraftWindowService;
}

/** The draft's window, with what its page was sent on a channel. */
function draftWindow(index = 0) {
  const window = electron.windows[index];
  const sent = (channel: string) =>
    window.webContents.send.mock.calls
      .filter(([each]) => each === channel)
      .map(([, ...args]) => args);
  return { window, sent };
}

function statuses() {
  return komla.service.broadcastToAll.mock.calls
    .filter(([channel]) => channel === IPC.PROMPT_DRAFT_STATUS)
    .map(([, status]) => status);
}

describe('promptDraftWindowService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    electron.windows.length = 0;
    electron.appEvents.handlers.clear();
    komla.windows.clear();
  });

  it('pops out just where the draft showed, on top of other apps, once its page has drawn', async () => {
    const service = await load();
    addKomlaWindow('w1', 1, 1.25);

    service.popOut('w1', draft, rect);

    const { window } = draftWindow();
    expect(window.options).toMatchObject({
      x: 850,
      y: 550,
      width: 550,
      height: 350,
      alwaysOnTop: true,
      frame: false,
      show: false,
    });
    expect(window.webContents.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[/\\]prompt-draft\.html$/)
    );
    expect(service.getStatus()).toEqual({ poppedOut: true, visible: false });

    // Not before its page has the draft, in Komla's theme.
    service.sendState();
    expect(draftWindow().sent(IPC.PROMPT_DRAFT_WINDOW_DRAFT)).toEqual([[draft]]);
    expect(window.show).not.toHaveBeenCalled();
    service.pageReady();
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    expect(statuses().at(-1)).toEqual({ poppedOut: true, visible: true });
  });

  it('keeps the draft on screen', async () => {
    const service = await load();
    addKomlaWindow('w1', 1);

    service.popOut('w1', draft, { x: 1500, y: -200, width: 440, height: 280 });

    expect(draftWindow().window.options).toMatchObject({ x: 1000, y: 25 });
  });

  it("refers to the Komla window used last, in that window's theme", async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    addKomlaWindow('w2', 2);
    service.popOut('w1', draft, rect);
    const { sent } = draftWindow();

    service.setContext('w1', context());
    service.setContext('w2', context({ workspaceId: 'ws-2', viewedFileName: null }));
    expect(sent(IPC.PROMPT_DRAFT_WINDOW_CONTEXT)).toEqual([[context()]]);

    electron.appEvents.emit('browser-window-focus', {}, { webContents: { id: 2 } });
    expect(sent(IPC.PROMPT_DRAFT_WINDOW_CONTEXT).at(-1)).toEqual([
      context({ workspaceId: 'ws-2', viewedFileName: null }),
    ]);
    // Its own focus leaves it referring to the Komla window it came from.
    electron.appEvents.emit('browser-window-focus', {}, draftWindow().window);
    expect(sent(IPC.PROMPT_DRAFT_WINDOW_CONTEXT)).toHaveLength(2);
  });

  it("keeps the draft popped out already as another window's pops out, with that one after it", async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    addKomlaWindow('w2', 2);
    service.popOut('w1', draft, rect);
    service.pageReady();

    service.popOut('w2', { text: 'Then the footer', selectionStart: 4, selectionEnd: 15 }, rect);

    const joined = {
      text: 'Fix the header\n\nThen the footer',
      selectionStart: 20,
      selectionEnd: 31,
    };
    expect(electron.windows).toHaveLength(1);
    expect(draftWindow().sent(IPC.PROMPT_DRAFT_WINDOW_DRAFT)).toEqual([[joined]]);
    service.sendState();
    expect(draftWindow().sent(IPC.PROMPT_DRAFT_WINDOW_DRAFT).at(-1)).toEqual([joined]);
  });

  it('gives a draft back to its window when joining it would make the draft too long', async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    addKomlaWindow('w2', 2);
    const long = { text: 'x'.repeat(600_000), selectionStart: 0, selectionEnd: 0 };
    service.popOut('w1', long, rect);
    service.pageReady();

    service.popOut('w2', long, rect);

    expect(komla.service.sendWhenReady.mock.calls).toEqual([
      ['w2', IPC.PROMPT_DRAFT_POPPED_IN, long],
      ['w2', IPC.PROMPT_DRAFT_STATUS, { poppedOut: true, visible: true }],
    ]);
    expect(draftWindow().sent(IPC.PROMPT_DRAFT_WINDOW_DRAFT)).toEqual([]);
  });

  it("doesn't show before its page has drawn, when shown again meanwhile", async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    service.popOut('w1', draft, rect);
    service.hide();
    service.show();
    expect(draftWindow().window.show).not.toHaveBeenCalled();

    service.pageReady();
    expect(draftWindow().window.show).toHaveBeenCalled();
  });

  it('keeps the text while hidden, and in a new window once closed as a window', async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    service.popOut('w1', draft, rect);
    service.pageReady();
    const typed = { text: 'Fix the header on mobile', selectionStart: 24, selectionEnd: 24 };
    service.setText(typed);

    service.hide();
    expect(statuses().at(-1)).toEqual({ poppedOut: true, visible: false });
    service.show();
    expect(electron.windows).toHaveLength(1);
    expect(draftWindow().window.visible).toBe(true);

    draftWindow().window.setBounds({ x: 40, y: 60, width: 500, height: 300 });
    draftWindow().window.close();
    expect(service.getStatus()).toEqual({ poppedOut: true, visible: false });
    service.show();
    const { window, sent } = draftWindow(1);
    expect(window.options).toMatchObject({ x: 40, y: 60, width: 500, height: 300 });
    service.sendState();
    expect(sent(IPC.PROMPT_DRAFT_WINDOW_DRAFT)).toEqual([[typed]]);
  });

  it("brings Komla forward once copied, to paste in the workspace's terminal", async () => {
    const service = await load();
    const komlaWindow = addKomlaWindow('w1', 1);
    service.popOut('w1', draft, rect);
    service.pageReady();

    service.close({ copied: false });
    expect(draftWindow().window.visible).toBe(false);
    expect(komlaWindow.focus).not.toHaveBeenCalled();

    service.show();
    service.close({ copied: true });
    expect(draftWindow().window.visible).toBe(false);
    expect(komlaWindow.focus).toHaveBeenCalled();
    expect(komla.service.sendWhenReady).toHaveBeenCalledWith('w1', IPC.PROMPT_DRAFT_COPIED);
  });

  it('puts in a reference to the file on screen in the Komla window used last', async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    addKomlaWindow('w2', 2);
    service.popOut('w1', draft, rect);
    service.setContext('w1', context({ viewedFileName: null }));

    // Nothing to refer to.
    service.requestReference();
    expect(komla.service.sendWhenReady).not.toHaveBeenCalled();

    service.setContext('w1', context());
    service.requestReference();
    expect(komla.service.sendWhenReady).toHaveBeenCalledWith(
      'w1',
      IPC.PROMPT_DRAFT_REFERENCE_REQUEST
    );
    // Only the window asked answers.
    service.receiveReference('w2', '@other.ts');
    service.receiveReference('w1', '@server.ts:1-3');
    service.receiveReference('w1', '@server.ts');
    expect(draftWindow().sent(IPC.PROMPT_DRAFT_WINDOW_INSERT)).toEqual([['@server.ts:1-3']]);
  });

  it('saves the draft as a note in the workspace on screen, which then shows', async () => {
    const service = await load();
    const komlaWindow = addKomlaWindow('w1', 1);
    service.popOut('w1', draft, rect);
    service.pageReady();
    const { sent } = draftWindow();

    service.setContext('w1', context({ workspaceId: null }));
    service.saveAsNote('Keep this plan');
    expect(sent(IPC.PROMPT_DRAFT_WINDOW_NOTE_SAVED)).toEqual([[false]]);

    service.setContext('w1', context());
    service.saveAsNote('Keep this plan');
    expect(komla.service.sendWhenReady).toHaveBeenCalledWith(
      'w1',
      IPC.PROMPT_DRAFT_SAVE_AS_NOTE,
      'ws-1',
      'Keep this plan'
    );
    service.receiveNoteSaved('w1', true);
    expect(sent(IPC.PROMPT_DRAFT_WINDOW_NOTE_SAVED)).toEqual([[false], [true]]);
    expect(draftWindow().window.visible).toBe(false);
    expect(komlaWindow.focus).toHaveBeenCalled();
  });

  it('pops back into the Komla window used last', async () => {
    const service = await load();
    const komlaWindow = addKomlaWindow('w1', 1);
    service.popOut('w1', draft, rect);
    service.pageReady();

    const typed = { text: 'Fix the header again', selectionStart: 20, selectionEnd: 20 };
    service.popIn(typed);

    expect(draftWindow().window.destroyed).toBe(true);
    expect(komla.service.sendToWindowOrNext).toHaveBeenCalledWith(
      'w1',
      IPC.PROMPT_DRAFT_POPPED_IN,
      typed
    );
    expect(komlaWindow.focus).toHaveBeenCalled();
    expect(statuses().at(-1)).toEqual({ poppedOut: false, visible: false });
    // Nothing to show until it pops out again.
    service.show();
    expect(electron.windows).toHaveLength(1);
  });

  it("goes with Komla's last window, which would otherwise keep Komla from quitting", async () => {
    const service = await load();
    addKomlaWindow('w1', 1);
    addKomlaWindow('w2', 2);
    service.popOut('w1', draft, rect);

    komla.windows.delete('w1');
    service.appWindowClosed('w1');
    expect(draftWindow().window.destroyed).toBe(false);

    komla.windows.delete('w2');
    service.appWindowClosed('w2');
    expect(draftWindow().window.destroyed).toBe(true);
    expect(service.getStatus()).toEqual({ poppedOut: false, visible: false });
  });
});
