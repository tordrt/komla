import { app, BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { electronAttentionWindows } from '../../../src/main/services/terminal-attention/windows';
import { IPC } from '../../../src/shared/constants/ipc-channels';
import { createMockBrowserWindow, type MockBrowserWindow } from '../../mocks/electron';

import type { WorkspaceAttentionEvent } from '../../../src/shared/types';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());
const { isUserAway } = vi.hoisted(() => ({ isUserAway: vi.fn(() => false) }));
vi.mock('../../../src/main/lib/user-presence', () => ({ isUserAway }));

const originalPlatform = process.platform;
const getAllWindows = BrowserWindow.getAllWindows as unknown as Mock<() => MockBrowserWindow[]>;

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindows.mockReturnValue([]);
});

afterEach(() => {
  onPlatform(originalPlatform);
});

describe('badge', () => {
  it('waits for the app to be ready, then shows the latest count', async () => {
    onPlatform('linux');
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
    onPlatform('darwin');

    electronAttentionWindows.badge(1);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith('1');

    electronAttentionWindows.badge(0);
    expect(app.dock.setBadge).toHaveBeenLastCalledWith('');
    expect(app.setBadgeCount).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('never sets the dock badge on %s', (platform) => {
    onPlatform(platform);

    electronAttentionWindows.badge(1);
    electronAttentionWindows.badge(0);

    expect(app.dock.setBadge).not.toHaveBeenCalled();
  });

  it('flashes the focused window on Windows while attention is needed', () => {
    onPlatform('win32');
    const background = createMockBrowserWindow();
    const focused = createMockBrowserWindow({ isFocused: vi.fn(() => true) });
    getAllWindows.mockReturnValue([background, focused]);

    electronAttentionWindows.badge(1);
    expect(focused.flashFrame).toHaveBeenLastCalledWith(true);

    electronAttentionWindows.badge(0);
    expect(focused.flashFrame).toHaveBeenLastCalledWith(false);
    expect(background.flashFrame).not.toHaveBeenCalled();
  });

  it('flashes the first window on Windows when none is focused', () => {
    onPlatform('win32');
    const first = createMockBrowserWindow();
    const second = createMockBrowserWindow();
    getAllWindows.mockReturnValue([first, second]);

    electronAttentionWindows.badge(2);

    expect(first.flashFrame).toHaveBeenCalledWith(true);
    expect(second.flashFrame).not.toHaveBeenCalled();
  });

  it('does nothing on Windows without a window', () => {
    onPlatform('win32');

    expect(() => electronAttentionWindows.badge(1)).not.toThrow();
  });

  it('sets the badge count on Linux', () => {
    onPlatform('linux');

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
