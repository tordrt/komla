import { join } from 'path';

import { is } from '@electron-toolkit/utils';
import { webContents as allWebContents, WebContentsView } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { MAIN_BUNDLE_DIR } from '../lib/module-path';
import { interceptPaneCloseShortcut } from '../lib/pane-close-shortcut';

import { shortcutsService } from './shortcuts.service';

import type { ToastOverlayContent, ToastOverlayEvent, ToastOverlayState } from '../../shared/types';
import type { BrowserWindow, Rectangle, WebContents } from 'electron';

interface ToastOverlay {
  owner: BrowserWindow;
  view: WebContentsView;
  loaded: boolean;
  content: ToastOverlayContent | null;
  bounds: Rectangle;
  focusBeforeClick: WebContents | null;
}

const EMPTY_CONTENT: ToastOverlayContent = {
  toasts: [],
  themeClassName: '',
  themeStyle: '',
  messageMaxHeight: 0,
};

/**
 * Browser previews are native views drawn above the main window's DOM, so a
 * toast under one would be hidden. Toasts that overlap a preview are mirrored
 * into this transparent view instead, which sits above every preview and
 * covers only the toast stack, so the page around and under it stays live.
 */
export class ToastOverlayService {
  private readonly overlays = new Map<number, ToastOverlay>();

  /** Loads the overlay's page ahead of the first toast, which would otherwise wait for it. */
  prepare(owner: BrowserWindow): void {
    this.getOrCreate(owner);
  }

  show(owner: BrowserWindow, state: ToastOverlayState): void {
    const overlay = this.getOrCreate(owner);
    const { bounds, ...content } = state;
    const zoomFactor = owner.webContents.getZoomFactor();
    // Rounded outward: a narrower view could wrap a toast's text onto another line.
    const left = Math.floor(bounds.x * zoomFactor);
    const top = Math.floor(bounds.y * zoomFactor);
    overlay.content = content;
    overlay.bounds = {
      x: left,
      y: top,
      width: Math.ceil((bounds.x + bounds.width) * zoomFactor) - left,
      height: Math.ceil((bounds.y + bounds.height) * zoomFactor) - top,
    };
    if (overlay.view.webContents.getZoomFactor() !== zoomFactor) {
      overlay.view.webContents.setZoomFactor(zoomFactor);
    }
    if (overlay.loaded) this.present(overlay, content);
  }

  hide(ownerWebContentsId: number): void {
    const overlay = this.overlays.get(ownerWebContentsId);
    if (!overlay?.content) return;
    overlay.content = null;
    overlay.view.setVisible(false);
    // Hidden toasts would otherwise keep counting down and dismiss themselves
    // while the main window shows them.
    if (overlay.loaded) this.publish(overlay, EMPTY_CONTENT);
  }

  forwardEvent(senderWebContentsId: number, event: ToastOverlayEvent): void {
    const overlay = this.findBySender(senderWebContentsId);
    if (!overlay || overlay.owner.webContents.isDestroyed()) return;
    // An action can open Komla UI, such as a dialog that hides the preview, so
    // the keyboard goes to the window rather than back to the page.
    if (event.type === 'action') overlay.owner.webContents.focus();
    overlay.owner.webContents.send(IPC.TOAST_OVERLAY_EVENT, event);
  }

  // Clicking a toast focuses this view, where typing and shortcuts do nothing.
  // The page reports when the click is done, since its own handling of the
  // click can move focus here after the mouse event itself.
  releaseFocus(senderWebContentsId: number): void {
    const overlay = this.findBySender(senderWebContentsId);
    const target = overlay?.focusBeforeClick;
    if (!overlay || !target) return;
    overlay.focusBeforeClick = null;
    if (!target.isDestroyed()) target.focus();
  }

  dispose(ownerWebContentsId: number): void {
    const overlay = this.overlays.get(ownerWebContentsId);
    if (!overlay) return;
    this.overlays.delete(ownerWebContentsId);
    if (!overlay.owner.isDestroyed()) overlay.owner.contentView.removeChildView(overlay.view);
    if (!overlay.view.webContents.isDestroyed()) overlay.view.webContents.close();
  }

  private getOrCreate(owner: BrowserWindow): ToastOverlay {
    const ownerWebContentsId = owner.webContents.id;
    const existing = this.overlays.get(ownerWebContentsId);
    if (existing) return existing;

    const view = new WebContentsView({
      webPreferences: {
        // The page is first-party code from the renderer bundle, like the main window's.
        preload: join(MAIN_BUNDLE_DIR, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const overlay: ToastOverlay = {
      owner,
      view,
      loaded: false,
      content: null,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      focusBeforeClick: null,
    };

    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Dropping a link or file on a toast would navigate, and the next page
    // would get the preload's API.
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    // Keys reach this view only while a click on a toast holds focus, and the
    // pane-close shortcut would otherwise close the window from the app menu.
    view.webContents.on('before-input-event', (event, input) => {
      interceptPaneCloseShortcut(
        event,
        input,
        shortcutsService.getShortcut('pane.close'),
        owner.webContents
      );
    });
    view.webContents.on('did-finish-load', () => {
      overlay.loaded = true;
      if (overlay.content) this.present(overlay, overlay.content);
    });
    // Remembers where focus was before a click on a toast; see releaseFocus.
    view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return;
      const focused = allWebContents.getFocusedWebContents();
      overlay.focusBeforeClick =
        focused && focused !== view.webContents ? focused : owner.webContents;
    });
    owner.once('closed', () => this.dispose(ownerWebContentsId));
    // A reloaded main window starts without toasts. Unlike did-start-loading,
    // this ignores frames inside the window, such as a file preview.
    owner.webContents.on('did-navigate', () => this.hide(ownerWebContentsId));

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void view.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/toast-overlay.html`);
    } else {
      void view.webContents.loadFile(join(MAIN_BUNDLE_DIR, '../renderer/toast-overlay.html'));
    }
    this.overlays.set(ownerWebContentsId, overlay);
    return overlay;
  }

  private findBySender(senderWebContentsId: number): ToastOverlay | undefined {
    return [...this.overlays.values()].find(
      (overlay) => overlay.view.webContents.id === senderWebContentsId
    );
  }

  // Loading a page focuses its view, which would take the keyboard from
  // whatever the user is typing in, so the view joins the window only once its
  // page has loaded.
  private present(overlay: ToastOverlay, content: ToastOverlayContent): void {
    const { owner, view } = overlay;
    if (owner.isDestroyed()) return;
    // Previews created after the overlay are added above it.
    if (owner.contentView.children.at(-1) !== view) owner.contentView.addChildView(view);
    view.setBounds(overlay.bounds);
    this.publish(overlay, content);
    view.setVisible(true);
  }

  private publish(overlay: ToastOverlay, content: ToastOverlayContent): void {
    if (overlay.view.webContents.isDestroyed()) return;
    overlay.view.webContents.send(IPC.TOAST_OVERLAY_CONTENT, content);
  }
}

export const toastOverlayService = new ToastOverlayService();
