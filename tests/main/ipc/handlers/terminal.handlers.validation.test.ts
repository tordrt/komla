import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockPtyService = {
  acknowledgeOutput: vi.fn(),
  attachRenderer: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  claimLocalSize: vi.fn(),
  getBuffer: vi.fn(() => ({ buffer: 'buffer-output', seq: 3 })),
};

const mockWindowService = {
  setTerminalFocus: vi.fn(),
};

vi.mock('../../../../src/main/services/pty.service', () => ({
  ptyService: mockPtyService,
}));

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: mockWindowService,
}));

describe('terminal IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('rejects invalid terminal ID for pty:get-buffer', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerTerminalHandlers();

    await expect(ipcMain._invoke('pty:get-buffer', '   ')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockPtyService.getBuffer).not.toHaveBeenCalled();
  });

  it('returns buffer for valid pty:get-buffer request', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerTerminalHandlers();

    await expect(ipcMain._invoke('pty:get-buffer', 'terminal-1')).resolves.toEqual({
      buffer: 'buffer-output',
      seq: 3,
    });
    expect(mockPtyService.getBuffer).toHaveBeenCalledWith('terminal-1');
    expect(mockPtyService.getBuffer).toHaveBeenCalledTimes(1);
    expect(mockPtyService.attachRenderer).toHaveBeenCalledExactlyOnceWith('terminal-1');
  });

  it('drops invalid pty:input payload and does not write to PTY', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const inputHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:input')?.[1];
    expect(inputHandler).toBeDefined();

    // Invalid because terminal ID fails min length after trim.
    inputHandler?.({}, '   ', 'hello');
    expect(mockPtyService.write).not.toHaveBeenCalled();
  });

  it('accepts valid pty:input payload and writes to PTY', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const inputHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:input')?.[1];
    expect(inputHandler).toBeDefined();

    inputHandler?.({}, 'terminal-1', 'echo hi');
    expect(mockPtyService.write).toHaveBeenCalledWith('terminal-1', 'echo hi');
    expect(mockPtyService.write).toHaveBeenCalledTimes(1);
  });

  it('passes valid pty:ack reports to the PTY service and drops invalid ones', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const ackHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:ack')?.[1];
    expect(ackHandler).toBeDefined();

    ackHandler?.({}, 'terminal-1', -5);
    ackHandler?.({}, 'terminal-1', 1.5);
    ackHandler?.({}, 'terminal-1', '65536');
    ackHandler?.({}, '   ', 65536);
    expect(mockPtyService.acknowledgeOutput).not.toHaveBeenCalled();

    ackHandler?.({}, 'terminal-1', 65536);
    expect(mockPtyService.acknowledgeOutput).toHaveBeenCalledExactlyOnceWith('terminal-1', 65536);
  });

  it('passes a valid terminal:claim-size to the PTY service and drops invalid ones', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const claimHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'terminal:claim-size')?.[1];
    expect(claimHandler).toBeDefined();

    claimHandler?.({}, '   ');
    claimHandler?.({}, 42);
    expect(mockPtyService.claimLocalSize).not.toHaveBeenCalled();

    claimHandler?.({}, 'terminal-1');
    expect(mockPtyService.claimLocalSize).toHaveBeenCalledExactlyOnceWith('terminal-1');
  });

  it('tracks the focused terminal for the sending renderer', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const focusHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'terminal:set-focus')?.[1];
    expect(focusHandler).toBeDefined();

    focusHandler?.({ sender: { id: 42 } }, 'terminal-1', true);
    expect(mockWindowService.setTerminalFocus).toHaveBeenCalledWith(42, 'terminal-1', true);
  });

  it('drops invalid terminal focus payloads', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const focusHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'terminal:set-focus')?.[1];
    expect(focusHandler).toBeDefined();

    focusHandler?.({ sender: { id: 42 } }, '   ', true);
    expect(mockWindowService.setTerminalFocus).not.toHaveBeenCalled();
  });

  it('drops pty:input payload with null bytes and does not write to PTY', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const inputHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:input')?.[1];
    expect(inputHandler).toBeDefined();

    inputHandler?.({}, 'terminal-1', 'bad\0input');
    expect(mockPtyService.write).not.toHaveBeenCalled();
  });

  it('accepts valid pty:resize payload and calls resize', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const resizeHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:resize')?.[1];
    expect(resizeHandler).toBeDefined();

    resizeHandler?.({}, 'terminal-1', 120, 40);
    expect(mockPtyService.resize).toHaveBeenCalledWith('terminal-1', 120, 40);
  });

  it('drops invalid pty:resize payload and does not resize PTY', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const resizeHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:resize')?.[1];
    expect(resizeHandler).toBeDefined();

    // Invalid because cols must be >= 1.
    resizeHandler?.({}, 'terminal-1', 0, 40);
    expect(mockPtyService.resize).not.toHaveBeenCalled();
  });

  it('drops invalid pty:resize payload with oversized rows and does not resize PTY', async () => {
    const { registerTerminalHandlers } =
      await import('../../../../src/main/ipc/handlers/terminal.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: ReturnType<typeof vi.fn> };
    };

    registerTerminalHandlers();

    const resizeHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'pty:resize')?.[1];
    expect(resizeHandler).toBeDefined();

    resizeHandler?.({}, 'terminal-1', 120, 2001);
    expect(mockPtyService.resize).not.toHaveBeenCalled();
  });
});
