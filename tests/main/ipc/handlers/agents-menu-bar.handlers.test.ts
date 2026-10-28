import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      listeners.set(channel, listener);
    }),
  },
}));

const service = vi.hoisted(() => ({
  isPopover: vi.fn((webContentsId: number) => webContentsId === 7),
  setImage: vi.fn(),
  setTheme: vi.fn(),
  resizePopover: vi.fn(),
  open: vi.fn(),
  closePopover: vi.fn(),
  sendState: vi.fn(),
}));

vi.mock('../../../../src/main/services/agents-menu-bar.service', () => ({
  agentsMenuBarService: service,
}));

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: {
    getWindowId: (webContentsId: number) => (webContentsId === 1 ? 'w1' : undefined),
  },
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerAgentsMenuBarHandlers } from '../../../../src/main/ipc/handlers/agents-menu-bar.handlers';
import { IPC } from '../../../../src/shared/constants/ipc-channels';

const komla = { sender: { id: 1 } };
const popover = { sender: { id: 7 } };
const preview = { sender: { id: 99 } };
const image = {
  counts: [{ state: 'input', count: 1 }],
  dataUrl: 'data:image/png;base64,AAAA',
  width: 30,
  height: 18,
};

describe('agents menu bar IPC handlers', () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    registerAgentsMenuBarHandlers();
  });

  it("takes the item's image and Komla's theme only from Komla's windows", () => {
    const theme = { className: 'dark', style: '' };
    for (const event of [preview, popover, komla]) {
      listeners.get(IPC.AGENTS_MENU_BAR_IMAGE)?.(event, image);
      listeners.get(IPC.AGENTS_MENU_BAR_THEME)?.(event, theme);
    }

    expect(service.setImage.mock.calls).toEqual([[image]]);
    expect(service.setTheme.mock.calls).toEqual([[theme]]);
  });

  it('opens, fits, fills and closes the popover only for its own page', () => {
    for (const event of [komla, preview, popover]) {
      listeners.get(IPC.AGENTS_MENU_BAR_STATE_REQUEST)?.(event);
      listeners.get(IPC.AGENTS_MENU_BAR_OPEN)?.(event, 'ws-1', 'term-1');
      listeners.get(IPC.AGENTS_MENU_BAR_RESIZE)?.(event, 400, 240);
      listeners.get(IPC.AGENTS_MENU_BAR_CLOSE)?.(event);
    }

    expect(service.open.mock.calls).toEqual([['ws-1', 'term-1']]);
    expect(service.resizePopover.mock.calls).toEqual([[400, 240]]);
    expect(service.closePopover).toHaveBeenCalledTimes(1);
    expect(service.sendState).toHaveBeenCalledTimes(1);
  });

  it('drops an oversized image, a missing one, or a state that does not exist', () => {
    for (const bad of [
      { ...image, dataUrl: 'x'.repeat(300_000) },
      { ...image, dataUrl: undefined },
      { ...image, counts: [{ state: 'sleeping', count: 1 }] },
    ]) {
      listeners.get(IPC.AGENTS_MENU_BAR_IMAGE)?.(komla, bad);
    }

    expect(service.setImage).not.toHaveBeenCalled();
  });
});
