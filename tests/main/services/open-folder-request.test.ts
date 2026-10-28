import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const focused: { webContents: { id: number } } | null = null;
const window = {
  isDestroyed: () => false,
  isMinimized: () => true,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
};
let ready = true;
vi.mock('electron', () => ({
  app: { isReady: () => ready },
  BrowserWindow: { getFocusedWindow: () => focused },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    getWindowId: vi.fn(),
    getMainWindowId: vi.fn(() => 'main'),
    getWindow: vi.fn(() => window),
    sendToWindowOrNext: vi.fn(),
  },
}));

const { windowService } = await import('../../../src/main/services/window.service');
const { foldersInCommandLine, requestOpenFolder, setFolderWindowOpener } =
  await import('../../../src/main/services/open-folder-request');
const openWindow = vi.fn(() => 'new');
setFolderWindowOpener(openWindow);

describe('open folder requests', () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(windowService.getWindow).mockImplementation(() => window as never);
    ready = true;
    root = mkdtempSync(join(tmpdir(), 'komla-open-folder-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'file.txt'), '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('foldersInCommandLine', () => {
    it('finds folders, relative ones from the working directory, leaving out flags and files', () => {
      expect(
        foldersInCommandLine(
          ['/opt/Komla/komla', '--no-sandbox', 'notes', 'file.txt', 'missing', root],
          root,
          '/opt/Komla/resources/app.asar'
        )
      ).toEqual([join(root, 'notes'), root]);
    });

    it("leaves out the app's own folder when run as `electron <app>`, wherever it is", () => {
      expect(
        foldersInCommandLine(['electron', '--inspect=0', 'notes', `${root}/`], root, root)
      ).toEqual([join(root, 'notes')]);
      expect(foldersInCommandLine(['/opt/Komla/komla'], root, root)).toEqual([]);
    });
  });

  describe('requestOpenFolder', () => {
    it('asks the given window to open a folder and brings it forward', () => {
      expect(requestOpenFolder(join(root, 'notes'), 'window-2')).toBe(true);
      expect(windowService.sendToWindowOrNext).toHaveBeenCalledWith(
        'window-2',
        'menu:open-folder',
        join(root, 'notes')
      );
      expect(window.restore).toHaveBeenCalled();
      expect(window.focus).toHaveBeenCalled();
    });

    it('falls back to the main window', () => {
      requestOpenFolder(root);
      expect(windowService.sendToWindowOrNext).toHaveBeenCalledWith(
        'main',
        'menu:open-folder',
        root
      );
    });

    it('opens a window when Komla has none, as on macOS with every window closed', () => {
      vi.mocked(windowService.getWindow).mockImplementation((id) =>
        id === 'closed' ? undefined : (window as never)
      );
      vi.mocked(windowService.getMainWindowId).mockReturnValueOnce(null);
      requestOpenFolder(root, 'closed');
      expect(openWindow).toHaveBeenCalledOnce();
      expect(windowService.sendToWindowOrNext).toHaveBeenCalledWith(
        'new',
        'menu:open-folder',
        root
      );
    });

    it('leaves it to the first window before Komla is ready', () => {
      ready = false;
      vi.mocked(windowService.getMainWindowId).mockReturnValueOnce(null);
      requestOpenFolder(root);
      expect(openWindow).not.toHaveBeenCalled();
      expect(windowService.sendToWindowOrNext).toHaveBeenCalledWith(
        undefined,
        'menu:open-folder',
        root
      );
    });

    it('refuses a file or a path that is gone', () => {
      expect(requestOpenFolder(join(root, 'file.txt'))).toBe(false);
      expect(requestOpenFolder(join(root, 'missing'))).toBe(false);
      expect(windowService.sendToWindowOrNext).not.toHaveBeenCalled();
    });
  });
});
