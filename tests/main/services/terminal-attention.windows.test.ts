import { app, BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { pinPlatform } from '../../helpers/platform';
import { electronAttentionWindows } from '../../../src/main/services/terminal-attention/windows';
import { IPC } from '../../../src/shared/constants/ipc-channels';
import { createMockBrowserWindow, type MockBrowserWindow } from '../../mocks/electron';

import type { WorkspaceAttentionEvent } from '../../../src/shared/types';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());
const { isUserAway } = vi.hoisted(() => ({ isUserAway: vi.fn(() => false) }));
vi.mock('../../../src/main/lib/user-presence', () => ({ isUserAway }));
// Komla's windows are all the windows here, but for the one `komla.draft` names.
const komla = vi.hoisted(() => ({ draft: null as unknown }));
vi.mock('../../../src/main/services/window.service', async () => {
  const { BrowserWindow } = await import('electron');
  const windows = () =>
    (BrowserWindow.getAllWindows() as unknown as MockBrowserWindow[]).filter(
      (window) => window !== komla.draft
    );
  return {
    windowService: {
      getAllWindows: windows,
      // The focused one, or Komla's first while the draft has focus.
      getActiveWindow: () => {
        const all = BrowserWindow.getAllWindows() as unknown as MockBrowserWindow[];
        const focused = all.find((window) => window.isFocused());
        return focused === komla.draft ? windows()[0] : focused;
      },
    },
  };
});

const getAllWindows = BrowserWindow.getAllWindows as unknown as Mock<() => MockBrowserWindow[]>;

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindows.mockReturnValue([]);
  komla.draft = null;
});

describe('badge', () => {
  it('waits for the app to be ready, then shows the latest count', async () => {
    pinPlatform('linux');
    const isReady = app.isReady as unknown as Mock<() => boolean>;
    const whenReady = app.whenReady as unknown as Mock<() => Promise<void>>;
    let ready!: () => void;
    isReady.mockReturnValue(false);
    whenReady.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)));

    electronAttentionWindows.badge(1);
    electronAttentionWindows.badge(2);
    expect(app.setBadgeCount).not.toHaveBeenCalled();

    isReady.mockReturnValue(true);
    ready();
    await vi.waitFor(() => expect(app.setBadgeCount).toHaveBeenCalled());

    expect(app.setBadgeCount).toHaveBeenCalledTimes(1);
    expect(app.setBadgeCount).toHaveBeenCalledWith(2);
  });

  it('shows the count on the macOS dock, and clears it at zero', () => {
    pinPlatform('darwin');

    electronAttentionWindows.badge(1);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith('1');

    electronAttentionWindows.badge(0);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith('');
    expect(app.setBadgeCount).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('never sets the dock badge on %s', (platform) => {
    pinPlatform(platform);

    electronAttentionWindows.badge(1);
    electronAttentionWindows.badge(0);

    expect(app.dock.setBadge).not.toHaveBeenCalled();
  });

  it('flashes the focused window on Windows while attention is needed', () => {
    pinPlatform('win32');
    const background = createMockBrowserWindow();
    const focused = createMockBrowserWindow({ isFocused: vi.fn(() => true) });
    getAllWindows.mockReturnValue([background, focused]);

    electronAttentionWindows.badge(1);
    expect(focused.flashFrame).toHaveBeenLastCalledWith(true);

    electronAttentionWindows.badge(0);
    expect(focused.flashFrame).toHaveBeenLastCalledWith(false);
    expect(background.flashFrame).not.toHaveBeenCalled();
  });

  it("flashes Komla's window on Windows while the popped-out prompt draft has focus", () => {
    pinPlatform('win32');
    const komlaWindow = createMockBrowserWindow();
    const draft = createMockBrowserWindow({ isFocused: vi.fn(() => true) });
    komla.draft = draft;
    getAllWindows.mockReturnValue([draft, komlaWindow]);

    electronAttentionWindows.badge(1);

    expect(komlaWindow.flashFrame).toHaveBeenCalledWith(true);
    expect(draft.flashFrame).not.toHaveBeenCalled();
  });

  it('flashes the first window on Windows when none is focused', () => {
    pinPlatform('win32');
    const first = createMockBrowserWindow();
    const second = createMockBrowserWindow();
    getAllWindows.mockReturnValue([first, second]);

    electronAttentionWindows.badge(2);

    expect(first.flashFrame).toHaveBeenCalledWith(true);
    expect(second.flashFrame).not.toHaveBeenCalled();
  });

  it('does nothing on Windows without a window', () => {
    pinPlatform('win32');

    expect(() => electronAttentionWindows.badge(1)).not.toThrow();
  });

  it('sets the badge count on Linux', () => {
    pinPlatform('linux');

    electronAttentionWindows.badge(1);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(1);

    electronAttentionWindows.badge(0);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(0);
  });
});

describe('attentionRaised', () => {
  it('sends the attention to every window', () => {
    const windows = [createMockBrowserWindow(), createMockBrowserWindow()];
    getAllWindows.mockReturnValue(windows);
    const event: WorkspaceAttentionEvent = {
      workspaceId: 'ws-1',
      attention: { kind: 'generic', source: 'generic', updatedAt: 1 },
    };

    electronAttentionWindows.attentionRaised(event);

    for (const window of windows) {
      expect(window.webContents.send).toHaveBeenCalledWith(IPC.WORKSPACE_NEEDS_ATTENTION, {
        ...event,
        userAway: false,
      });
    }
  });

  it('marks the attention as arriving while the user is away', () => {
    const window = createMockBrowserWindow();
    getAllWindows.mockReturnValue([window]);
    isUserAway.mockReturnValueOnce(true);
    const event: WorkspaceAttentionEvent = {
      workspaceId: 'ws-1',
      attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1 },
    };

    electronAttentionWindows.attentionRaised(event);

    expect(window.webContents.send).toHaveBeenCalledWith(IPC.WORKSPACE_NEEDS_ATTENTION, {
      ...event,
      userAway: true,
    });
  });
});
