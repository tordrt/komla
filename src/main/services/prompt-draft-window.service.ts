import { join } from 'path';

import { is } from '@electron-toolkit/utils';
import { app, BrowserWindow, nativeTheme, screen } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { appendDraft } from '../../shared/lib/prompt-draft-text';
import { PROMPT_DRAFT_MAX_LENGTH, PROMPT_DRAFT_MIN_SIZE } from '../../shared/types';
import { MAIN_BUNDLE_DIR } from '../lib/module-path';

import {
  HIDDEN_WINDOW_OPTIONS,
  HIDDEN_WINDOW_WEB_PREFERENCES,
  showWindow,
  WINDOWS_TAKE_FOCUS,
  windowService,
} from './window.service';

import type {
  AgentsMenuBarTheme,
  PromptDraftRect,
  PromptDraftText,
  PromptDraftWindowContext,
  PromptDraftWindowStatus,
} from '../../shared/types';
import type { Rectangle } from 'electron';

/** `value` within `min` and `max`, in whole pixels. */
function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(value, max)));
}

/** The bounds, moved and shrunk to fit on the display they're most on. */
export function fitToDisplay(bounds: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = clamp(bounds.width, PROMPT_DRAFT_MIN_SIZE.width, area.width);
  const height = clamp(bounds.height, PROMPT_DRAFT_MIN_SIZE.height, area.height);
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * The prompt draft popped out of Komla's windows into one of its own, which stays on top of other
 * apps, as a browser showing what an agent built. It refers to the Komla window used last: the
 * file on screen there, the workspace it's saved to as a note, and the terminal it's pasted in
 * once copied. Its text stays here as its page reports it, so the window can go and come back,
 * until it pops back into a Komla window or Komla quits.
 */
class PromptDraftWindowService {
  private window: BrowserWindow | null = null;
  /** The draft while it's popped out, as its page last reported it; null while it isn't. */
  private draft: PromptDraftText | null = null;
  private bounds: Rectangle | null = null;
  /** What each Komla window last offered the draft, while it's popped out. */
  private contexts = new Map<string, PromptDraftWindowContext>();
  /** Komla's theme as a window last sent it, for a draft with no Komla window left to refer to. */
  private theme: AgentsMenuBarTheme | null = null;
  private lastWindowId: string | null = null;
  /** Whether the window shows once its page has drawn: it isn't shown before, so it doesn't flash. */
  private shows = false;
  /** Whether the window's page has drawn the draft, before which it isn't shown. */
  private drawn = false;
  /** The Komla windows asked for a reference, or to save a note, whose answer goes to the page. */
  private referenceFrom: string | null = null;
  private noteFrom: string | null = null;
  private sentStatus = '';

  init(): void {
    app.on('browser-window-focus', (_event, window) => {
      const windowId = windowService.getWindowId(window.webContents.id);
      if (!windowId || windowId === this.lastWindowId) return;
      this.lastWindowId = windowId;
      this.sendContext();
    });
  }

  /** The draft's page, the only one whose messages from it this service takes. */
  isPage(webContentsId: number): boolean {
    const window = this.window;
    return !!window && !window.isDestroyed() && window.webContents.id === webContentsId;
  }

  getStatus(): PromptDraftWindowStatus {
    const window = this.window;
    return {
      poppedOut: this.draft !== null,
      visible: !!window && !window.isDestroyed() && window.isVisible(),
    };
  }

  /**
   * Pops the draft out of a Komla window, into a window of its own just where it was: `rect` is
   * where it showed in the window's page. A draft popped out already, from another Komla window,
   * keeps its text, and this one's follows it.
   */
  popOut(windowId: string, draft: PromptDraftText, rect: PromptDraftRect): void {
    const source = windowService.getWindow(windowId);
    if (!source || source.isDestroyed()) return;
    const content = source.getContentBounds();
    const zoom = source.webContents.getZoomFactor();
    const joined = appendDraft(this.draft?.text ?? '', draft);
    if (joined.text.length > PROMPT_DRAFT_MAX_LENGTH) {
      this.handBack(windowId, draft);
      return;
    }
    this.lastWindowId = windowId;
    this.draft = joined;
    this.bounds = fitToDisplay({
      x: content.x + rect.x * zoom,
      y: content.y + rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    });
    const window = this.window;
    if (window && !window.isDestroyed()) {
      window.setBounds(this.bounds);
      window.webContents.send(IPC.PROMPT_DRAFT_WINDOW_DRAFT, this.draft);
    }
    this.show();
  }

  /**
   * Gives a draft that can't pop out back to the window it came from, which took it as popped out,
   * along with whether another is.
   */
  private handBack(windowId: string, draft: PromptDraftText): void {
    windowService.sendWhenReady(windowId, IPC.PROMPT_DRAFT_POPPED_IN, draft);
    windowService.sendWhenReady(windowId, IPC.PROMPT_DRAFT_STATUS, this.getStatus());
  }

  /** Shows the popped-out draft and gives it focus. */
  show(): void {
    if (!this.draft) return;
    this.shows = true;
    const window = this.window;
    if (!window || window.isDestroyed()) {
      this.create();
      this.sendStatus();
      return;
    }
    // Not before its page has drawn, which shows it then.
    if (!this.drawn) return;
    if (!window.isVisible()) showWindow(window);
    if (WINDOWS_TAKE_FOCUS) window.focus();
    this.sendStatus();
  }

  /** Hides the popped-out draft, which keeps its text; it pops out again when shown. */
  hide(): void {
    this.shows = false;
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    this.bounds = window.getBounds();
    window.hide();
    this.sendStatus();
  }

  /**
   * Hides the draft, as its page asks. Once copied, Komla's window comes forward with focus in
   * its terminal, for the prompt to be pasted there.
   */
  close({ copied }: { copied: boolean }): void {
    this.hide();
    const windowId = this.targetWindowId();
    if (!copied || !windowId) return;
    this.focusWindow(windowId);
    windowService.sendWhenReady(windowId, IPC.PROMPT_DRAFT_COPIED);
  }

  /** Puts the draft back in the Komla window used last, where it opens. */
  popIn(draft: PromptDraftText): void {
    if (!this.draft) return;
    this.draft = null;
    this.shows = false;
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) {
      this.bounds = window.getBounds();
      window.destroy();
    }
    const windowId = this.targetWindowId();
    windowService.sendToWindowOrNext(windowId, IPC.PROMPT_DRAFT_POPPED_IN, draft);
    if (windowId) this.focusWindow(windowId);
    this.sendStatus();
  }

  /** The draft as its page has it now. */
  setText(draft: PromptDraftText): void {
    if (this.draft) this.draft = draft;
  }

  setContext(windowId: string, context: PromptDraftWindowContext): void {
    this.contexts.set(windowId, context);
    if (windowId === this.targetWindowId()) {
      this.theme = context.theme;
      this.sendContext();
    }
  }

  /** Asks the Komla window used last for a reference to its file on screen, for the page. */
  requestReference(): void {
    const windowId = this.targetWindowId();
    if (!windowId || !this.contexts.get(windowId)?.viewedFileName) return;
    this.referenceFrom = windowId;
    windowService.sendWhenReady(windowId, IPC.PROMPT_DRAFT_REFERENCE_REQUEST);
  }

  /** The reference a Komla window asked for answers with, which the page puts in. */
  receiveReference(windowId: string, reference: string | null): void {
    if (windowId !== this.referenceFrom) return;
    this.referenceFrom = null;
    if (reference) this.sendToPage(IPC.PROMPT_DRAFT_WINDOW_INSERT, reference);
  }

  /** Has the Komla window used last save the draft as a note in its workspace on screen. */
  saveAsNote(text: string): void {
    const windowId = this.targetWindowId();
    const workspaceId = windowId ? this.contexts.get(windowId)?.workspaceId : null;
    if (!windowId || !workspaceId) {
      this.sendToPage(IPC.PROMPT_DRAFT_WINDOW_NOTE_SAVED, false);
      return;
    }
    this.noteFrom = windowId;
    windowService.sendWhenReady(windowId, IPC.PROMPT_DRAFT_SAVE_AS_NOTE, workspaceId, text);
  }

  /** Whether the note was saved, which opened it: the draft makes way for it. */
  receiveNoteSaved(windowId: string, saved: boolean): void {
    if (windowId !== this.noteFrom) return;
    this.noteFrom = null;
    this.sendToPage(IPC.PROMPT_DRAFT_WINDOW_NOTE_SAVED, saved);
    if (!saved) return;
    this.hide();
    this.focusWindow(windowId);
  }

  /**
   * Forgets a Komla window that closed. Once none is left, the draft's window goes too, as it
   * would otherwise keep Komla from quitting as its last window closes.
   */
  appWindowClosed(windowId: string): void {
    this.contexts.delete(windowId);
    if (this.lastWindowId === windowId) this.lastWindowId = null;
    if (this.referenceFrom === windowId) this.referenceFrom = null;
    if (this.noteFrom === windowId) this.receiveNoteSaved(windowId, false);
    if (windowService.getAllWindowIds().length > 0) {
      this.sendContext();
      return;
    }
    this.draft = null;
    this.shows = false;
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  /** What the page shows, sent when it asks, once it's listening. */
  sendState(): void {
    if (this.draft) this.sendToPage(IPC.PROMPT_DRAFT_WINDOW_DRAFT, this.draft);
    this.sendContext();
  }

  /** The page has drawn the draft, in Komla's theme: the window shows, unless hidden meanwhile. */
  pageReady(): void {
    const window = this.window;
    if (window && !window.isDestroyed()) this.drawn = true;
    if (!this.shows || !window || window.isDestroyed() || window.isVisible()) return;
    showWindow(window);
    if (WINDOWS_TAKE_FOCUS) window.focus();
    this.sendStatus();
  }

  private create(): void {
    const bounds = this.bounds ? fitToDisplay(this.bounds) : undefined;
    const window = new BrowserWindow({
      ...bounds,
      minWidth: PROMPT_DRAFT_MIN_SIZE.width,
      minHeight: PROMPT_DRAFT_MIN_SIZE.height,
      title: 'Prompt draft',
      show: false,
      frame: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Over full-screen apps too, and typing in it leaves the app in front where it is: Komla
      // comes forward only once the prompt is copied, to be pasted there.
      ...(process.platform === 'darwin' && { type: 'panel' }),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16191c' : '#ffffff',
      ...HIDDEN_WINDOW_OPTIONS,
      webPreferences: {
        preload: join(MAIN_BUNDLE_DIR, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        ...HIDDEN_WINDOW_WEB_PREFERENCES,
      },
    });
    this.window = window;
    this.drawn = false;
    if (process.platform === 'darwin') {
      // Without skipping it, Electron turns Komla into a menu bar app and back, hiding its Dock icon.
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('show', () => this.sendStatus());
    window.on('hide', () => this.sendStatus());
    // Closed as a window is, as with Cmd+W: its text stays, to show in a new one.
    window.on('close', () => {
      if (!window.isDestroyed()) this.bounds = window.getBounds();
    });
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.shows = false;
      this.sendStatus();
    });
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void window.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/prompt-draft.html`);
    } else {
      void window.webContents.loadFile(join(MAIN_BUNDLE_DIR, '../renderer/prompt-draft.html'));
    }
  }

  /** The Komla window the draft refers to: the one used last, or else the main window. */
  private targetWindowId(): string | null {
    const last = this.lastWindowId;
    if (last && windowService.getWindow(last)) return last;
    return windowService.getMainWindowId();
  }

  private focusWindow(windowId: string): void {
    const window = windowService.getWindow(windowId);
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!WINDOWS_TAKE_FOCUS) return;
    window.show();
    window.focus();
  }

  private sendContext(): void {
    const windowId = this.targetWindowId();
    const context = windowId ? this.contexts.get(windowId) : undefined;
    if (context) this.theme = context.theme;
    this.sendToPage(
      IPC.PROMPT_DRAFT_WINDOW_CONTEXT,
      context ??
        (this.theme ? { theme: this.theme, workspaceId: null, viewedFileName: null } : null)
    );
  }

  private sendToPage(channel: string, ...args: unknown[]): void {
    const window = this.window;
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
  }

  /** Tells Komla's windows whether the draft is popped out and shows, as that changes. */
  private sendStatus(): void {
    const status = this.getStatus();
    const key = JSON.stringify(status);
    if (key === this.sentStatus) return;
    this.sentStatus = key;
    windowService.broadcastToAll(IPC.PROMPT_DRAFT_STATUS, status);
  }
}

export const promptDraftWindowService = new PromptDraftWindowService();
