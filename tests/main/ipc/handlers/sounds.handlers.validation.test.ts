import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const fs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => Buffer.from('audio')),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ size: 5, isFile: () => true })),
}));

vi.mock('fs', () => fs);

vi.mock('../../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/.komla'),
}));

describe('sounds IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function setup() {
    const { registerSoundsHandlers } =
      await import('../../../../src/main/ipc/handlers/sounds.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerSoundsHandlers();
    return ipcMain;
  }

  it.each([[[]], [[42]], [[null]], [[{ filename: 'chime.mp3' }]], [['chime\0.mp3']]])(
    'sounds:get-data-url rejects %j',
    async (args) => {
      const ipcMain = await setup();

      await expect(ipcMain._invoke('sounds:get-data-url', ...args)).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    }
  );

  it('sounds:get-data-url reads a sound by its file name', async () => {
    const ipcMain = await setup();

    await expect(ipcMain._invoke('sounds:get-data-url', 'chime.mp3')).resolves.toBe(
      `data:audio/mpeg;base64,${Buffer.from('audio').toString('base64')}`
    );
  });

  it('sounds:get-data-url never leaves the sounds folder', async () => {
    const ipcMain = await setup();

    await ipcMain._invoke('sounds:get-data-url', '../../etc/chime.mp3');

    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/sounds[/\\]chime\.mp3$/)
    );
  });
});
