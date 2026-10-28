import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mocks = vi.hoisted(() => ({
  notesService: {
    list: vi.fn(),
    create: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    trash: vi.fn(),
    delete: vi.fn(),
    watch: vi.fn(),
  },
  windowService: { broadcastToAll: vi.fn() },
}));

vi.mock('../../../../src/main/services/notes.service', () => ({
  notesService: mocks.notesService,
}));
vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: mocks.windowService,
}));

const SCOPE = '0b3e6f9a-2c41-4f3e-9a8b-1d2c3e4f5a6b';
const NOTE = '2026-10-15-143210.md';

async function setup() {
  const { registerNotesHandlers } =
    await import('../../../../src/main/ipc/handlers/notes.handlers');
  const { ipcMain } = (await import('electron')) as unknown as {
    ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
  };
  registerNotesHandlers();
  return ipcMain;
}

describe('notes IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('lists a project’s notes and starts telling windows when they change', async () => {
    mocks.notesService.list.mockResolvedValue([]);
    const ipcMain = await setup();

    await expect(ipcMain._invoke('notes:list', SCOPE)).resolves.toEqual([]);

    expect(mocks.notesService.list).toHaveBeenCalledWith(SCOPE);
    const onChange = mocks.notesService.watch.mock.calls[0][0] as (scopeId: string) => void;
    onChange(SCOPE);
    expect(mocks.windowService.broadcastToAll).toHaveBeenCalledWith('notes:changed', SCOPE);
  });

  it('writes, deletes and trashes notes by name', async () => {
    const ipcMain = await setup();

    await ipcMain._invoke('notes:write', SCOPE, NOTE, '# Prompt');
    await ipcMain._invoke('notes:delete', SCOPE, NOTE, true);
    await ipcMain._invoke('notes:trash', SCOPE, NOTE);

    expect(mocks.notesService.write).toHaveBeenCalledWith(SCOPE, NOTE, '# Prompt');
    expect(mocks.notesService.delete).toHaveBeenCalledWith(SCOPE, NOTE, { onlyIfBlank: true });
    expect(mocks.notesService.trash).toHaveBeenCalledWith(SCOPE, NOTE);
  });

  it.each([
    ['notes:list', ['../..']],
    ['notes:create', ['a/b']],
    ['notes:read', [SCOPE, '../../.ssh/id_rsa']],
    ['notes:read', [SCOPE, 'notes.txt']],
    ['notes:write', [SCOPE, NOTE, 'nul\0byte']],
    ['notes:write', [SCOPE, NOTE, 42]],
    ['notes:delete', [SCOPE, NOTE, 'yes']],
    ['notes:trash', ['..', NOTE]],
  ])('rejects %s with %j', async (channel, args) => {
    const ipcMain = await setup();

    await expect(ipcMain._invoke(channel, ...args)).rejects.toThrow();

    for (const method of Object.values(mocks.notesService)) {
      if (method !== mocks.notesService.watch) expect(method).not.toHaveBeenCalled();
    }
  });
});
