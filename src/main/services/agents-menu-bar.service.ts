import { join } from 'path';

import { is } from '@electron-toolkit/utils';
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import {
  AGENT_STATE_TEXT,
  AGENT_STATES_BY_URGENCY,
  clearedFromOverview,
  workspaceAgents,
} from '../../shared/lib/agent-state';
import { createLogger } from '../lib/logger';
import { MAIN_BUNDLE_DIR } from '../lib/module-path';

import { onRemoteWorkspaceChange } from './remote-workspace-events';
import { windowService } from './window.service';

import type { AppConfig } from './config.service';
import type {
  AgentsMenuBarCounts,
  AgentsMenuBarDrawRequest,
  AgentsMenuBarImage,
  AgentsMenuBarProject,
  AgentsMenuBarState,
  AgentsMenuBarTheme,
  Workspace,
} from '../../shared/types';
import type { NativeImage, Rectangle } from 'electron';

const logger = createLogger('AgentsMenuBar');

/** As wide as the status bar's agents popover, with room for its shadow around it. */
const POPOVER_WIDTH = 400;
const POPOVER_MARGIN = 12;
/** Keeps the item where the user put it in the menu bar each time it comes back. */
const TRAY_GUID = '6f1d3c2a-8b4e-4f7a-9c5d-2e8a1b3f4c6d';

/**
 * Every window's active workspaces' agents, counted by state as the status bar counts them,
 * without the finished ones the overview cleared.
 */
export function countAgents(
  workspaces: readonly Workspace[],
  doneClearedAt?: number
): AgentsMenuBarCounts {
  const states = workspaces
    .filter((workspace) => workspace.status === 'active')
    .flatMap((workspace) => workspaceAgents(workspace))
    .filter((agent) => !clearedFromOverview(agent, doneClearedAt))
    .map(({ state }) => state);
  return AGENT_STATES_BY_URGENCY.map((state) => ({
    state,
    count: states.filter((each) => each === state).length,
  })).filter(({ count }) => count > 0);
}

/** "2 need input, 1 working". */
export function summarizeCounts(counts: AgentsMenuBarCounts): string {
  return counts
    .map(({ state, count }) => `${count} ${AGENT_STATE_TEXT[state].label(count)}`)
    .join(', ');
}

/** A ring, the menu bar item until Komla's window draws its icons. */
function ringIcon(): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor;
    const radius = 6 * scaleFactor;
    const stroke = 1.5 * scaleFactor;
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const coverage = Math.min(1, Math.max(0, stroke / 2 + 0.5 - Math.abs(distance - radius)));
        pixels[(y * size + x) * 4 + 3] = Math.round(coverage * 255);
      }
    }
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: pixels });
  }
  image.setTemplateImage(true);
  return image;
}

export interface AgentsMenuBarDeps {
  listWorkspaces: () => Workspace[];
  getWorkspace: (workspaceId: string) => Workspace | undefined;
  listProjects: () => AgentsMenuBarProject[];
  /** Terminals stopping or starting, which workspace changes don't announce. */
  onTerminalStatus: (listener: () => void) => () => void;
  /** Opens a Komla window, for a row clicked while none is open. */
  openWindow: () => string;
  /** Moves a workspace to a window, as dragging it there does. */
  moveToWindow: (workspaceId: string, windowId: string) => void;
  /** Saves a change to the item's settings, as Settings does. */
  updateConfig: (
    updates: Partial<Pick<AppConfig, 'showAgentsInMenuBar' | 'agentsMenuBarInBackgroundOnly'>>
  ) => void;
}

/**
 * Shows every window's agents in the macOS menu bar, with the status bar's icons and counts,
 * while there are any, and if the user asks, only while no Komla window is in front. Clicking it
 * opens the status bar's agents popover beneath it, in a
 * window of its own that lives only while open, so no hidden window stands in for Komla's.
 * Right-clicking it offers its settings.
 */
class AgentsMenuBarService {
  private deps: AgentsMenuBarDeps | null = null;
  private tray: Tray | null = null;
  private popover: BrowserWindow | null = null;
  private theme: AgentsMenuBarTheme | null = null;
  private closedOnBlurAt = 0;
  private drawnCounts: string | null = null;
  /** The last image Komla's window drew, to show again at once when the item comes back. */
  private image: { counts: string; image: NativeImage } | null = null;
  private enabled = false;
  private inBackgroundOnly = false;
  private doneClearedAt: number | undefined;
  private watchingFocus = false;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  init(deps: AgentsMenuBarDeps): void {
    this.deps = deps;
    // A dark menu bar takes brighter colors.
    nativeTheme.on('updated', () => this.redraw());
  }

  setEnabled(enabled: boolean | undefined): void {
    if (process.platform !== 'darwin' || !this.deps) return;
    this.enabled = !!enabled;
    this.sync();
  }

  /** Whether to show the item only while no Komla window is in front. */
  setInBackgroundOnly(inBackgroundOnly: boolean | undefined): void {
    if (process.platform !== 'darwin') return;
    this.inBackgroundOnly = !!inBackgroundOnly;
    this.watchFocus();
    this.sync();
  }

  /** When the overview last cleared its finished agents, which it no longer counts. */
  setDoneClearedAt(doneClearedAt: number | undefined): void {
    this.doneClearedAt = doneClearedAt;
    this.sync();
  }

  /** Removes the item for good, as Komla quits: its windows hiding then mustn't bring it back. */
  stop(): void {
    this.enabled = false;
    this.hide();
  }

  private hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.removeTray();
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = null;
  }

  private removeTray(): void {
    this.tray?.destroy();
    this.tray = null;
    this.drawnCounts = null;
    this.closePopover();
  }

  /** The popover's page, the only one whose messages this service takes. */
  isPopover(webContentsId: number): boolean {
    const popover = this.popover;
    return !!popover && !popover.isDestroyed() && popover.webContents.id === webContentsId;
  }

  /** Komla's theme as its windows show it, for the popover to match and the item's colors. */
  setTheme(theme: AgentsMenuBarTheme): void {
    const changed = theme.className !== this.theme?.className || theme.style !== this.theme.style;
    this.theme = theme;
    this.sendState();
    if (changed) this.redraw();
  }

  private redraw(): void {
    this.image = null;
    if (this.drawnCounts !== null) {
      this.requestImage(JSON.parse(this.drawnCounts) as AgentsMenuBarCounts);
    }
  }

  /** Shows the icons and counts Komla's window drew for the menu bar, unless they've changed since. */
  setImage({ counts, dataUrl, width, height }: AgentsMenuBarImage): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed() || JSON.stringify(counts) !== this.drawnCounts) return;
    const prefix = 'data:image/png;base64,';
    if (!dataUrl.startsWith(prefix)) return;
    const image = nativeImage.createFromBuffer(
      Buffer.from(dataUrl.slice(prefix.length), 'base64'),
      { scaleFactor: 2, width: width * 2, height: height * 2 }
    );
    if (image.isEmpty()) return;
    this.image = { counts: this.drawnCounts, image };
    tray.setImage(image);
  }

  /**
   * Fits the popover to its page: the panel, and a hovered row's card beside it on the left,
   * where the window grows while the panel stays under the item. Shows it once the page has
   * drawn, so it doesn't flash.
   */
  resizePopover(width: number, height: number): void {
    const popover = this.popover;
    if (!popover || popover.isDestroyed()) return;
    popover.setBounds(this.popoverBounds(width, height));
    if (!popover.isVisible()) {
      popover.show();
      popover.focus();
    }
  }

  /**
   * Opens the workspace in the window that shows it, on the agent's pane when given. One that no
   * window shows moves to the main window, or a new one.
   */
  open(workspaceId: string, terminalId: string | undefined): void {
    this.closePopover();
    const workspace = this.deps?.getWorkspace(workspaceId);
    if (!workspace || !this.deps) return;
    if (
      workspace.windowId &&
      windowService.showWorkspace(workspace.windowId, workspaceId, terminalId)
    ) {
      return;
    }
    const windowId = windowService.getMainWindowId() ?? this.deps.openWindow();
    this.deps.moveToWindow(workspaceId, windowId);
    windowService.showWorkspace(windowId, workspaceId, terminalId);
  }

  closePopover(): void {
    const popover = this.popover;
    this.popover = null;
    if (popover && !popover.isDestroyed()) popover.destroy();
    // The item it kept may have no agents left to show.
    if (popover && this.tray) this.scheduleSync();
  }

  private sync(): void {
    const deps = this.deps;
    if (!this.enabled || !deps) {
      this.hide();
      return;
    }
    this.watchAgents(deps);
    const counts = countAgents(deps.listWorkspaces(), this.doneClearedAt);
    if (counts.length === 0 && this.popover) {
      // Not from under the user: the item goes once they close its popover.
      this.sendState();
      return;
    }
    if (counts.length === 0 || (this.inBackgroundOnly && this.komlaInFront())) {
      this.removeTray();
      return;
    }
    if (!this.tray) this.start();
    this.show(counts);
  }

  /** Whether a Komla window has focus; the popover's own doesn't count. */
  private komlaInFront(): boolean {
    const focused = BrowserWindow.getFocusedWindow();
    return !!focused && !this.isPopover(focused.webContents.id);
  }

  private watchFocus(): void {
    if (this.watchingFocus) return;
    this.watchingFocus = true;
    // Moving from one Komla window to another blurs the first before it focuses the next.
    const schedule = () => {
      if (this.focusTimer) clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => {
        this.focusTimer = null;
        this.sync();
      }, 100);
    };
    app.on('browser-window-focus', schedule);
    app.on('browser-window-blur', schedule);
  }

  /** Follows the agents while the item is on, also while it hides, to show it once there are some. */
  private watchAgents(deps: AgentsMenuBarDeps): void {
    if (this.unsubscribe) return;
    const scheduleSync = () => this.scheduleSync();
    const unsubscribers = [
      onRemoteWorkspaceChange(scheduleSync),
      deps.onTerminalStatus(scheduleSync),
    ];
    this.unsubscribe = () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  private scheduleSync(): void {
    // One turn changes workspaces many times.
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.sync();
    }, 250);
  }

  private start(): void {
    const tray = new Tray(ringIcon(), TRAY_GUID);
    this.tray = tray;
    tray.on('click', () => this.togglePopover());
    tray.on('right-click', () => this.showSettingsMenu(tray));
    logger.info('menu bar item shown');
  }

  private showSettingsMenu(tray: Tray): void {
    this.closePopover();
    const updateConfig = this.deps?.updateConfig;
    if (!updateConfig) return;
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show in Menu Bar',
          type: 'checkbox',
          checked: true,
          click: () => updateConfig({ showAgentsInMenuBar: false }),
        },
        {
          label: 'Only While Komla Is in the Background',
          type: 'checkbox',
          checked: this.inBackgroundOnly,
          click: () => updateConfig({ agentsMenuBarInBackgroundOnly: !this.inBackgroundOnly }),
        },
      ])
    );
  }

  private show(counts: AgentsMenuBarCounts): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    this.tray.setToolTip(`Komla agents: ${summarizeCounts(counts)}`);
    const key = JSON.stringify(counts);
    if (key !== this.drawnCounts) {
      this.drawnCounts = key;
      if (this.image?.counts === key) this.tray.setImage(this.image.image);
      else this.requestImage(counts);
    }
    this.sendState();
  }

  /**
   * Asks Komla's window to draw the icons and counts: it has the icons and the fonts. With none
   * open, the next one draws them. In dark mode the menu bar is dark, whatever the wallpaper.
   */
  private requestImage(counts: AgentsMenuBarCounts): void {
    const request: AgentsMenuBarDrawRequest = { counts, dark: nativeTheme.shouldUseDarkColors };
    windowService.sendToWindowOrNext(null, IPC.AGENTS_MENU_BAR_DRAW, request);
  }

  /** What the popover shows, sent on every change and when its page, once listening, asks. */
  sendState(): void {
    const popover = this.popover;
    if (!popover || popover.isDestroyed() || !this.deps) return;
    const state: AgentsMenuBarState = {
      workspaces: this.deps.listWorkspaces().filter((workspace) => workspace.status === 'active'),
      projects: this.deps.listProjects(),
      theme: this.theme,
    };
    popover.webContents.send(IPC.AGENTS_MENU_BAR_STATE, state);
  }

  private togglePopover(): void {
    if (this.popover) {
      this.closePopover();
      return;
    }
    // Clicking the item to close the popover blurs it first, which already closed it.
    if (Date.now() - this.closedOnBlurAt < 300) return;
    const popover = new BrowserWindow({
      ...this.popoverBounds(POPOVER_WIDTH, 0),
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: 'panel',
      webPreferences: {
        preload: join(MAIN_BUNDLE_DIR, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.popover = popover;
    // Without skipping it, Electron turns Komla into a menu bar app and back, hiding its Dock icon.
    popover.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    popover.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popover.webContents.on('will-navigate', (event) => event.preventDefault());
    // Clicking anywhere else closes it, as a menu would.
    popover.on('blur', () => {
      if (this.popover !== popover) return;
      this.closedOnBlurAt = Date.now();
      this.closePopover();
    });
    popover.on('closed', () => {
      if (this.popover === popover) this.popover = null;
    });
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void popover.webContents.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}/agents-menu-bar.html`
      );
    } else {
      void popover.webContents.loadFile(join(MAIN_BUNDLE_DIR, '../renderer/agents-menu-bar.html'));
    }
  }

  /**
   * The panel under the menu bar item, its left edge on the item's, kept on the item's screen;
   * what the page needs beyond the panel's width extends the window to the left, with room for
   * the shadow all around.
   */
  private popoverBounds(width: number, height: number): Rectangle {
    const item = this.tray && !this.tray.isDestroyed() ? this.tray.getBounds() : null;
    const area = screen.getDisplayNearestPoint(
      item ? { x: item.x, y: item.y } : screen.getCursorScreenPoint()
    ).workArea;
    const right = Math.min(
      (item?.x ?? area.x + area.width) + POPOVER_WIDTH,
      area.x + area.width - POPOVER_MARGIN
    );
    const left = Math.max(area.x, right - Math.max(width, POPOVER_WIDTH) - POPOVER_MARGIN);
    return {
      x: Math.round(left),
      y: Math.round(item ? item.y + item.height : area.y),
      width: Math.round(right + POPOVER_MARGIN - left),
      height: Math.round(Math.min(height + POPOVER_MARGIN * 2, area.height)),
    };
  }
}

export const agentsMenuBarService = new AgentsMenuBarService();
