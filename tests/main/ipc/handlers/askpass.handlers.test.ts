import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

const mockAskpassService = {
  start: vi.fn((_selectWindow?: () => unknown) => Promise.resolve()),
  stop: vi.fn(),
};

const komlaWindows = { active: undefined as unknown, all: [] as unknown[] };
vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: {
    getActiveWindow: () => komlaWindows.active,
    getAllWindows: () => komlaWindows.all,
  },
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('../../../../src/main/services/askpass.service', () => ({
  askpassService: mockAskpassService,
}));

describe('askpass handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAskpassService.start.mockResolvedValue(undefined);
  });

  it('starts askpass service and logs registration', async () => {
    const { registerAskpassHandlers } =
      await import('../../../../src/main/ipc/handlers/askpass.handlers');

    registerAskpassHandlers();

    expect(mockAskpassService.start).toHaveBeenCalled();
    expect(mockAskpassService.start).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith('Askpass handlers registered');
  });

  it('asks in the Komla window the user is in, else in any', async () => {
    const { registerAskpassHandlers } =
      await import('../../../../src/main/ipc/handlers/askpass.handlers');
    registerAskpassHandlers();
    const selectWindow = mockAskpassService.start.mock.calls[0][0]!;

    komlaWindows.all = ['first', 'second'];
    komlaWindows.active = undefined;
    expect(selectWindow()).toBe('first');
    komlaWindows.active = 'second';
    expect(selectWindow()).toBe('second');
  });

  it('logs startup failure if askpass service fails to start', async () => {
    const error = new Error('socket unavailable');
    mockAskpassService.start.mockRejectedValueOnce(error);

    const { registerAskpassHandlers } =
      await import('../../../../src/main/ipc/handlers/askpass.handlers');

    expect(() => registerAskpassHandlers()).not.toThrow();
    await Promise.resolve();

    expect(mockLogger.info).toHaveBeenCalledWith('Askpass handlers registered');
    expect(mockLogger.error).toHaveBeenCalledWith('Failed to start askpass service', error);
  });

  it('stops askpass service and logs unregistration', async () => {
    const { unregisterAskpassHandlers } =
      await import('../../../../src/main/ipc/handlers/askpass.handlers');

    unregisterAskpassHandlers();

    expect(mockAskpassService.stop).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Askpass handlers unregistered');
  });
});
