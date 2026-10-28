import { existsSync, readFileSync } from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('ConfigService - voice config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should preserve voice config when loading existing config without voice field', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        _version: 1,
        agentSetupComplete: true,
        scrollbackLines: 5000,
      })
    );
    const { configService } = await import('../../../src/main/services/config.service');
    const config = configService.get();
    expect(config.voice).toEqual({
      modelId: 'parakeet-tdt-0.6b-v3-int8',
      modelPath: null,
      enabled: false,
      autoRecord: false,
      transcribeAction: 'fill',
    });
  });
});
