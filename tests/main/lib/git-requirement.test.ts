import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

const { isGitInstalled } = vi.hoisted(() => ({ isGitInstalled: vi.fn() }));

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/services/git/git-exec', () => ({ isGitInstalled }));

describe('checkGitInstalled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    const electron = (await import('electron')) as unknown as {
      app: { quit: ReturnType<typeof vi.fn> };
      dialog: { showMessageBox: ReturnType<typeof vi.fn> };
      shell: { openExternal: ReturnType<typeof vi.fn> };
    };
    const { checkGitInstalled } = await import('../../../src/main/lib/git-requirement');
    return { ...electron, checkGitInstalled };
  }

  it('lets startup continue when git is installed', async () => {
    isGitInstalled.mockResolvedValue(true);
    const { app, dialog, checkGitInstalled } = await load();

    await expect(checkGitInstalled()).resolves.toBe(true);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('offers the git download page and quits when git is missing', async () => {
    isGitInstalled.mockResolvedValue(false);
    const { app, dialog, shell, checkGitInstalled } = await load();
    dialog.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(checkGitInstalled()).resolves.toBe(false);

    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Git is not installed',
        buttons: ['Download Git', 'Quit'],
      })
    );
    expect(shell.openExternal).toHaveBeenCalledWith('https://git-scm.com/downloads');
    expect(app.quit).toHaveBeenCalled();
  });

  it('quits without opening the download page when the user picks Quit', async () => {
    isGitInstalled.mockResolvedValue(false);
    const { app, dialog, shell, checkGitInstalled } = await load();
    dialog.showMessageBox.mockResolvedValue({ response: 1 });

    await expect(checkGitInstalled()).resolves.toBe(false);

    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalled();
  });
});
