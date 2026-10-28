import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, (...args: any[]) => unknown>();
const owner = { webContents: { id: 42 } };

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => owner) },
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      listeners.set(channel, listener);
    }),
  },
}));

const service = vi.hoisted(() => ({
  forwardEvent: vi.fn(),
  hide: vi.fn(),
  releaseFocus: vi.fn(),
  show: vi.fn(),
}));

vi.mock('../../../../src/main/services/toast-overlay.service', () => ({
  toastOverlayService: service,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { IPC } from '../../../../src/shared/constants/ipc-channels';
import { registerToastOverlayHandlers } from '../../../../src/main/ipc/handlers/toast-overlay.handlers';

const state = {
  bounds: { x: 900, y: 740, width: 284, height: 44 },
  toasts: [{ id: 'a1', message: 'Saved', type: 'success', dismissOnTimeout: true }],
  themeClassName: 'dark',
  themeStyle: '',
  messageMaxHeight: 320,
};

describe('toast overlay IPC handlers', () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    registerToastOverlayHandlers();
  });

  it("shows a validated stack in the sender window's overlay", () => {
    listeners.get(IPC.TOAST_OVERLAY_SHOW)?.({ sender: owner.webContents }, state);
    expect(service.show).toHaveBeenCalledWith(owner, state);

    listeners.get(IPC.TOAST_OVERLAY_SHOW)?.(
      { sender: owner.webContents },
      { ...state, toasts: [] }
    );
    expect(service.show).toHaveBeenCalledTimes(1);
  });

  it("hides the sender window's overlay", () => {
    listeners.get(IPC.TOAST_OVERLAY_HIDE)?.({ sender: owner.webContents });

    expect(service.hide).toHaveBeenCalledWith(42);
  });

  it('relays validated events from the overlay page', () => {
    listeners.get(IPC.TOAST_OVERLAY_EVENT)?.({ sender: { id: 7 } }, { type: 'remove', id: 'a1' });
    listeners.get(IPC.TOAST_OVERLAY_EVENT)?.({ sender: { id: 7 } }, { type: 'close-window' });

    expect(service.forwardEvent).toHaveBeenCalledTimes(1);
    expect(service.forwardEvent).toHaveBeenCalledWith(7, { type: 'remove', id: 'a1' });
  });

  it('hands focus back when the overlay page reports a finished click', () => {
    listeners.get(IPC.TOAST_OVERLAY_POINTER_UP)?.({ sender: { id: 7 } });

    expect(service.releaseFocus).toHaveBeenCalledWith(7);
  });
});
