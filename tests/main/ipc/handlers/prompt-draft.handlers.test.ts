import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      listeners.set(channel, listener);
    }),
    handle: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      listeners.set(channel, listener);
    }),
  },
}));

const service = vi.hoisted(() => ({
  isPage: vi.fn((webContentsId: number) => webContentsId === 7),
  popOut: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  getStatus: vi.fn(() => ({ poppedOut: true, visible: false })),
  setContext: vi.fn(),
  receiveReference: vi.fn(),
  receiveNoteSaved: vi.fn(),
  sendState: vi.fn(),
  pageReady: vi.fn(),
  setText: vi.fn(),
  requestReference: vi.fn(),
  saveAsNote: vi.fn(),
  close: vi.fn(),
  popIn: vi.fn(),
}));

vi.mock('../../../../src/main/services/prompt-draft-window.service', () => ({
  promptDraftWindowService: service,
}));

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: {
    getWindowId: (webContentsId: number) => (webContentsId === 1 ? 'w1' : undefined),
  },
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerPromptDraftHandlers } from '../../../../src/main/ipc/handlers/prompt-draft.handlers';
import { IPC } from '../../../../src/shared/constants/ipc-channels';

const komla = { sender: { id: 1 } };
const page = { sender: { id: 7 } };
const preview = { sender: { id: 99 } };
const draft = { text: 'Fix it', selectionStart: 6, selectionEnd: 6 };
const rect = { x: 10, y: 20, width: 440, height: 280 };
const context = {
  theme: { className: 'dark', style: '' },
  workspaceId: 'ws-1',
  viewedFileName: 'server.ts',
};

describe('prompt draft IPC handlers', () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    registerPromptDraftHandlers();
  });

  it("pops out, shows and tells what's on screen only for Komla's windows", () => {
    for (const event of [preview, page, komla]) {
      listeners.get(IPC.PROMPT_DRAFT_POP_OUT)?.(event, draft, rect);
      listeners.get(IPC.PROMPT_DRAFT_SHOW)?.(event);
      listeners.get(IPC.PROMPT_DRAFT_HIDE)?.(event);
      listeners.get(IPC.PROMPT_DRAFT_CONTEXT)?.(event, context);
      listeners.get(IPC.PROMPT_DRAFT_REFERENCE)?.(event, '@server.ts');
      listeners.get(IPC.PROMPT_DRAFT_NOTE_SAVED)?.(event, true);
    }

    expect(service.popOut.mock.calls).toEqual([['w1', draft, rect]]);
    expect(service.show).toHaveBeenCalledTimes(1);
    expect(service.hide).toHaveBeenCalledTimes(1);
    expect(service.setContext.mock.calls).toEqual([['w1', context]]);
    expect(service.receiveReference.mock.calls).toEqual([['w1', '@server.ts']]);
    expect(service.receiveNoteSaved.mock.calls).toEqual([['w1', true]]);
  });

  it("takes the draft's own requests only from its page", () => {
    for (const event of [komla, preview, page]) {
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_STATE_REQUEST)?.(event);
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_READY)?.(event);
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_TEXT)?.(event, draft);
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_REQUEST_REFERENCE)?.(event);
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_SAVE_AS_NOTE)?.(event, 'Keep this');
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_CLOSE)?.(event, { copied: true });
      listeners.get(IPC.PROMPT_DRAFT_WINDOW_POP_IN)?.(event, draft);
    }

    expect(service.sendState).toHaveBeenCalledTimes(1);
    expect(service.pageReady).toHaveBeenCalledTimes(1);
    expect(service.setText.mock.calls).toEqual([[draft]]);
    expect(service.requestReference).toHaveBeenCalledTimes(1);
    expect(service.saveAsNote.mock.calls).toEqual([['Keep this']]);
    expect(service.close.mock.calls).toEqual([[{ copied: true }]]);
    expect(service.popIn.mock.calls).toEqual([[draft]]);
  });

  it('drops a draft whose cursor is not a place in it, or a rect without a size', () => {
    listeners.get(IPC.PROMPT_DRAFT_WINDOW_TEXT)?.(page, { ...draft, selectionStart: -1 });
    listeners.get(IPC.PROMPT_DRAFT_POP_OUT)?.(komla, draft, { ...rect, width: 0 });
    listeners.get(IPC.PROMPT_DRAFT_POP_OUT)?.(komla, { text: 'x'.repeat(1_000_001) }, rect);

    expect(service.setText).not.toHaveBeenCalled();
    expect(service.popOut).not.toHaveBeenCalled();
  });
});
