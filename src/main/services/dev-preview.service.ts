import { createHash } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';

import { app, session, WebContentsView } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { isBrowserUrl } from '../../shared/lib/browser-tabs';
import { isPaneSurfaceId } from '../../shared/lib/pane-surface-id';
import { createLogger } from '../lib/logger';
import { interceptForwardedShortcut, interceptPaneCloseShortcut } from '../lib/pane-close-shortcut';

import { shortcutsService } from './shortcuts.service';
import { toastOverlayService } from './toast-overlay.service';

import type {
  DevPreviewBounds,
  DevPreviewNavigationDirection,
  DevPreviewNavigationState,
  DevPreviewOpenTabRequest,
  DevPreviewTabRef,
} from '../../shared/types';
import type { BrowserWindow, Session, WebContents } from 'electron';

const logger = createLogger('DevPreviewService');
const PREVIEW_PARTITION = 'persist:komla-dev-preview';
const ERR_ABORTED = -3;
// PNG-encoding a Retina-sized frame blocks the main process for ~200ms; JPEG
// takes a fraction of that.
const FRAME_JPEG_QUALITY = 90;
// Overlays share a capture in progress, so one that stalls (such as in a
// minimized window) is given up on rather than handed to every later overlay.
const CAPTURE_TIMEOUT_MS = 1000;
// A page opens at most one tab this often, so it can't flood the workspace with tabs.
const OPEN_TAB_INTERVAL_MS = 1000;
// Each page runs in its own renderer process. Tabs beyond this many per window
// lose the page least recently shown, and load it again when shown.
export const MAX_RETAINED_PREVIEW_VIEWS = 6;
// Like Chrome's reserved new-window and new-tab keys, plus workspace switching and the
// command center.
// Every other app shortcut stays with the page so its own bindings keep working.
const FORWARDED_SHORTCUT_ACTIONS = [
  'workspace.new',
  'terminal.new',
  'tab.newAgent',
  'commandCenter.open',
  ...Array.from({ length: 9 }, (_, index) => `workspace.select.${index + 1}`),
];

interface PreviewSlot {
  owner: BrowserWindow;
  // Kept because a closed window throws when its webContents is read.
  ownerWebContentsId: number;
  view: WebContentsView;
  session: Session;
  workspaceId: string;
  tabId: string;
  url: string;
  loaded: boolean;
  loading: boolean;
  loadGeneration: number;
  visible: boolean;
  lastShownAt: number;
  loadError: string | null;
  lastOpenTabAt: number;
  pendingCapture: Promise<string | null> | null;
  snapshotInFlight: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function slotKey(workspaceId: string, tabId: string): string {
  return JSON.stringify([workspaceId, tabId]);
}

// Each project's pages get their own cookies, storage and service workers, so a
// page from one project can't read another's or serve its pages, while the
// project's workspaces share logins. A workspace without a project keeps its
// own until Komla quits. Hashed, since a partition name becomes a folder name.
function hashed(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function projectPartition(projectId: string): string {
  return `${PREVIEW_PARTITION}-${hashed(projectId)}`;
}

function workspacePartition(workspaceId: string): string {
  return `komla-dev-preview-${hashed(workspaceId)}`;
}

function partitionFolder(partition: string): string {
  return join(app.getPath('userData'), 'Partitions', partition.replace(/^persist:/, ''));
}

export class DevPreviewService {
  /** Each window's pages, keyed by workspace and tab. */
  private readonly slotsByOwner = new Map<number, Map<string, PreviewSlot>>();
  private readonly sessions = new Map<string, Session>();
  private projectOf: (workspaceId: string) => string | null | undefined = () => undefined;
  private showCount = 0;

  setProjectLookup(lookup: (workspaceId: string) => string | null | undefined): void {
    this.projectOf = lookup;
  }

  /** Removes the session every project's pages shared before each got its own. */
  async removeSharedSessionData(): Promise<void> {
    await rm(partitionFolder(PREVIEW_PARTITION), { recursive: true, force: true });
  }

  /** Forgets a deleted project's logins and site data. */
  async clearProjectData(projectId: string): Promise<void> {
    const partition = projectPartition(projectId);
    const previewSession = this.sessions.get(partition);
    if (!previewSession) {
      await rm(partitionFolder(partition), { recursive: true, force: true });
      return;
    }
    // Its pages close first, or one could write its cookies back.
    for (const slots of this.slotsByOwner.values()) {
      for (const slot of slots.values()) {
        if (slot.session === previewSession) this.destroySlot(slot);
      }
    }
    await previewSession.clearStorageData();
    await previewSession.clearCache();
  }

  sync(
    owner: BrowserWindow,
    workspaceId: string,
    tabId: string,
    url: string,
    bounds: DevPreviewBounds
  ): void {
    if (!isBrowserUrl(url)) {
      logger.warn('Ignored a dev preview URL that is not http(s)');
      this.hide(owner.webContents.id, workspaceId, tabId);
      return;
    }

    const slot = this.getOrCreateSlot(owner, workspaceId, tabId);
    const wasVisible = slot.visible;
    slot.visible = true;
    slot.lastShownAt = ++this.showCount;
    slot.view.setBounds(this.toNativeBounds(owner, bounds));
    this.evictHiddenViews(owner.webContents.id);

    // The renderer saves where a tab navigated, then syncs that URL back.
    if (slot.url !== url && slot.view.webContents.getURL() === url) slot.url = url;

    if (slot.url === url) {
      if (!slot.loaded && !slot.loading) this.load(slot, url);
      slot.view.setVisible(slot.loaded);
      if (slot.loaded && !wasVisible) this.publishNavigationState(slot);
      return;
    }

    slot.url = url;
    slot.loaded = false;
    slot.view.setVisible(false);
    this.load(slot, url);
  }

  private load(slot: PreviewSlot, url: string): void {
    slot.loading = true;
    slot.loadError = null;
    const loadGeneration = ++slot.loadGeneration;
    const isCurrentLoad = () =>
      this.isRegistered(slot) && slot.url === url && slot.loadGeneration === loadGeneration;
    void slot.view.webContents
      .loadURL(url)
      .then(() => {
        if (!isCurrentLoad()) return;
        slot.loading = false;
        slot.loaded = true;
        slot.view.setVisible(slot.visible);
      })
      .catch((error) => {
        if (isCurrentLoad()) {
          slot.loading = false;
          slot.loaded = false;
        }
        logger.warn('Failed to load dev preview URL', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  hide(ownerWebContentsId: number, workspaceId: string, tabId: string): void {
    const slot = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (slot) this.setHidden(slot);
  }

  /** Closes a tab's page, for a tab the user closed. */
  close(ownerWebContentsId: number, workspaceId: string, tabId: string): void {
    const slot = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (slot) this.destroySlot(slot);
  }

  reload(
    ownerWebContentsId: number,
    workspaceId: string,
    tabId: string,
    ignoreCache: boolean
  ): boolean {
    const slot = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (!slot) return false;
    if (ignoreCache) {
      slot.view.webContents.reloadIgnoringCache();
    } else {
      slot.view.webContents.reload();
    }
    return true;
  }

  navigate(
    ownerWebContentsId: number,
    workspaceId: string,
    tabId: string,
    direction: DevPreviewNavigationDirection
  ): boolean {
    const slot = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (!slot) return false;
    const history = slot.view.webContents.navigationHistory;
    const canNavigate = direction === 'back' ? history.canGoBack() : history.canGoForward();
    if (!canNavigate) return false;
    if (direction === 'back') history.goBack();
    else history.goForward();
    return true;
  }

  async clearSiteData(
    ownerWebContentsId: number,
    workspaceId: string,
    tabId: string
  ): Promise<boolean> {
    const slot = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (!slot) return false;

    const documentOrigin = new URL(slot.view.webContents.getURL() || slot.url).origin;
    const origin = documentOrigin === 'null' ? new URL(slot.url).origin : documentOrigin;
    await slot.view.webContents
      .executeJavaScript('sessionStorage.clear(); localStorage.clear();', false)
      .catch(() => {
        // The page can be navigating or unavailable. Persistent stores are
        // still cleared through the session below.
      });
    await slot.session.clearStorageData({
      origin,
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'serviceworkers',
        'cachestorage',
      ],
    });
    await slot.session.clearCache();
    return true;
  }

  /** Captures the page as currently shown, so the renderer can stand it in while hidden. */
  async capture(
    ownerWebContentsId: number,
    workspaceId: string,
    tabId: string
  ): Promise<string | null> {
    const slot = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (!slot?.visible || !slot.loaded) return null;
    // Encoding blocks the main process, so overlays that open while a capture
    // is still running share it instead of starting another.
    if (slot.pendingCapture) return slot.pendingCapture;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = Promise.race([
      this.captureFrame(slot),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
      }),
    ])
      .catch((error) => {
        logger.debug('Could not capture dev preview frame', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (slot.pendingCapture === frame) slot.pendingCapture = null;
      });
    slot.pendingCapture = frame;
    return frame;
  }

  dispose(ownerWebContentsId: number): void {
    for (const slot of this.slotsOf(ownerWebContentsId)) this.destroySlot(slot);
    this.slotsByOwner.delete(ownerWebContentsId);
  }

  private getSession(workspaceId: string): Session {
    const projectId = this.projectOf(workspaceId);
    const partition = projectId ? projectPartition(projectId) : workspacePartition(workspaceId);
    const existing = this.sessions.get(partition);
    if (existing) return existing;
    const previewSession = session.fromPartition(partition);
    previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    previewSession.setPermissionCheckHandler(() => false);
    previewSession.on('will-download', (event, _item, webContents) => {
      event.preventDefault();
      // A tab opened straight to a file would otherwise stay empty without saying why.
      const slot = this.findSlotOf(webContents);
      if (!slot || slot.loaded) return;
      slot.loadGeneration += 1;
      slot.loading = false;
      slot.loadError =
        "Komla's browser doesn't download files. To download it, choose Open in external browser from the ⋯ menu.";
      slot.view.setVisible(false);
      this.publishNavigationState(slot);
    });
    this.sessions.set(partition, previewSession);
    return previewSession;
  }

  private findSlotOf(webContents: WebContents | undefined): PreviewSlot | undefined {
    for (const slots of this.slotsByOwner.values()) {
      for (const slot of slots.values()) if (slot.view.webContents === webContents) return slot;
    }
    return undefined;
  }

  private slotsOf(ownerWebContentsId: number): PreviewSlot[] {
    return [...(this.slotsByOwner.get(ownerWebContentsId)?.values() ?? [])];
  }

  private getSlot(
    ownerWebContentsId: number,
    workspaceId: string,
    tabId: string
  ): PreviewSlot | null {
    return this.slotsByOwner.get(ownerWebContentsId)?.get(slotKey(workspaceId, tabId)) ?? null;
  }

  private isRegistered(slot: PreviewSlot): boolean {
    return this.getSlot(slot.ownerWebContentsId, slot.workspaceId, slot.tabId) === slot;
  }

  private setHidden(slot: PreviewSlot): void {
    slot.visible = false;
    slot.view.setVisible(false);
  }

  private evictHiddenViews(ownerWebContentsId: number): void {
    const slots = this.slotsOf(ownerWebContentsId);
    const evictable = slots
      .filter((slot) => !slot.visible)
      .sort((a, b) => a.lastShownAt - b.lastShownAt);
    for (let count = slots.length; count > MAX_RETAINED_PREVIEW_VIEWS; count -= 1) {
      const slot = evictable.shift();
      if (!slot) return;
      this.destroySlot(slot);
    }
  }

  private destroySlot(slot: PreviewSlot): void {
    if (this.isRegistered(slot)) {
      this.slotsByOwner.get(slot.ownerWebContentsId)?.delete(slotKey(slot.workspaceId, slot.tabId));
    }
    if (!slot.owner.isDestroyed()) slot.owner.contentView.removeChildView(slot.view);
    if (!slot.view.webContents.isDestroyed()) {
      slot.view.webContents.close();
    }
  }

  private getOrCreateSlot(owner: BrowserWindow, workspaceId: string, tabId: string): PreviewSlot {
    const ownerWebContentsId = owner.webContents.id;
    const existing = this.getSlot(ownerWebContentsId, workspaceId, tabId);
    if (existing) return existing;

    const previewSession = this.getSession(workspaceId);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: previewSession,
      },
    });
    const slot: PreviewSlot = {
      owner,
      ownerWebContentsId,
      view,
      session: previewSession,
      workspaceId,
      tabId,
      url: '',
      loaded: false,
      loading: false,
      loadGeneration: 0,
      visible: false,
      lastShownAt: 0,
      loadError: null,
      lastOpenTabAt: 0,
      pendingCapture: null,
      snapshotInFlight: false,
    };

    view.setVisible(false);
    // Links that open a new window open as a tab of the same workspace
    // instead, but only from the page on screen.
    view.webContents.setWindowOpenHandler(({ url }) => {
      const now = Date.now();
      if (
        isBrowserUrl(url) &&
        slot.visible &&
        now - slot.lastOpenTabAt >= OPEN_TAB_INTERVAL_MS &&
        !owner.webContents.isDestroyed()
      ) {
        slot.lastOpenTabAt = now;
        const request: DevPreviewOpenTabRequest = { workspaceId, tabId, url };
        owner.webContents.send(IPC.DEV_PREVIEW_OPEN_TAB, request);
      }
      return { action: 'deny' };
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (
        interceptPaneCloseShortcut(
          event,
          input,
          shortcutsService.getShortcut('pane.close'),
          owner.webContents,
          isPaneSurfaceId(tabId) ? { workspaceId, tabId } : undefined
        )
      ) {
        // Closing the preview hides this view but would leave keyboard focus in it.
        if (!owner.webContents.isDestroyed()) owner.webContents.focus();
        return;
      }
      interceptForwardedShortcut(
        event,
        input,
        FORWARDED_SHORTCUT_ACTIONS,
        (actionId) => shortcutsService.getShortcut(actionId),
        owner.webContents
      );
    });
    // A click into the page never reaches the renderer's DOM, so it hears of it here.
    view.webContents.on('focus', () => {
      if (owner.webContents.isDestroyed()) return;
      const page: DevPreviewTabRef = { workspaceId, tabId };
      owner.webContents.send(IPC.DEV_PREVIEW_FOCUSED, page);
    });
    view.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) slot.loadError = null;
    });
    view.webContents.on('did-finish-load', () => {
      if (!this.isRegistered(slot)) return;
      // Chromium also finishes loading the error page of a failed load.
      if (slot.loadError) return;
      slot.loading = false;
      slot.loaded = true;
      slot.view.setVisible(slot.visible);
      this.publishNavigationState(slot);
      void this.publishSnapshot(slot);
    });
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (isMainFrame === false || errorCode === ERR_ABORTED) return;
        if (!this.isRegistered(slot)) return;
        slot.loadGeneration += 1;
        slot.loading = false;
        slot.loaded = false;
        slot.loadError = errorDescription || `Error ${errorCode}`;
        slot.view.setVisible(false);
        this.publishNavigationState(slot);
      }
    );
    view.webContents.on('did-navigate', () => this.publishNavigationState(slot));
    view.webContents.on('did-navigate-in-page', () => {
      this.publishNavigationState(slot);
      void this.publishSnapshot(slot);
    });
    view.webContents.on('page-title-updated', () => this.publishNavigationState(slot));
    owner.contentView.addChildView(view);

    let slots = this.slotsByOwner.get(ownerWebContentsId);
    if (!slots) {
      slots = new Map();
      this.slotsByOwner.set(ownerWebContentsId, slots);
      // Toasts that overlap a preview are drawn in that layer.
      toastOverlayService.prepare(owner);
      owner.once('closed', () => this.dispose(ownerWebContentsId));
      owner.webContents.on('did-start-loading', () => {
        for (const ownerSlot of this.slotsOf(ownerWebContentsId)) this.setHidden(ownerSlot);
      });
    }
    slots.set(slotKey(workspaceId, tabId), slot);
    return slot;
  }

  private publishNavigationState(slot: PreviewSlot): void {
    if (!this.isRegistered(slot) || slot.owner.webContents.isDestroyed()) return;
    const { webContents } = slot.view;
    const history = webContents.navigationHistory;
    const url = webContents.getURL() || slot.url;
    // Without a <title>, Chromium reports the URL as the title.
    const title = webContents.getTitle();
    const state: DevPreviewNavigationState = {
      workspaceId: slot.workspaceId,
      tabId: slot.tabId,
      url,
      title: title && title !== url ? title : '',
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      loadError: slot.loadError,
    };
    slot.owner.webContents.send(IPC.DEV_PREVIEW_NAVIGATION_STATE_CHANGED, state);
  }

  private async publishSnapshot(slot: PreviewSlot): Promise<void> {
    // Encoding blocks the main process, so a page changing its URL in a loop
    // gets one capture at a time.
    if (slot.snapshotInFlight) return;
    slot.snapshotInFlight = true;
    const url = slot.view.webContents.getURL() || slot.url;
    try {
      const dataUrl = await this.captureFrame(slot);
      if (
        !dataUrl ||
        !this.isRegistered(slot) ||
        (slot.view.webContents.getURL() || slot.url) !== url ||
        slot.owner.webContents.isDestroyed()
      ) {
        return;
      }
      slot.owner.webContents.send(IPC.DEV_PREVIEW_SNAPSHOT_UPDATED, {
        workspaceId: slot.workspaceId,
        tabId: slot.tabId,
        dataUrl,
      });
    } catch (error) {
      logger.debug('Could not retain dev preview frame', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      slot.snapshotInFlight = false;
    }
  }

  private async captureFrame(slot: PreviewSlot): Promise<string | null> {
    const image = await slot.view.webContents.capturePage();
    // A zero-sized or occluded view captures as an empty image.
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(FRAME_JPEG_QUALITY).toString('base64')}`;
  }

  private toNativeBounds(owner: BrowserWindow, bounds: DevPreviewBounds): Electron.Rectangle {
    const zoomFactor = owner.webContents.getZoomFactor();
    const contentBounds = owner.getContentBounds();
    const x = clamp(Math.round(bounds.x * zoomFactor), 0, contentBounds.width);
    const y = clamp(Math.round(bounds.y * zoomFactor), 0, contentBounds.height);
    const right = clamp(Math.round((bounds.x + bounds.width) * zoomFactor), x, contentBounds.width);
    const bottom = clamp(
      Math.round((bounds.y + bounds.height) * zoomFactor),
      y,
      contentBounds.height
    );
    return { x, y, width: right - x, height: bottom - y };
  }
}

export const devPreviewService = new DevPreviewService();
