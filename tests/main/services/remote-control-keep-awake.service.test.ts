import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

describe('RemoteControlKeepAwakeService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('starts a prevent-app-suspension blocker when direct remote is enabled', async () => {
    const { powerSaveBlocker } = await import('electron');
    const { remoteControlKeepAwakeService } = await import(
      '../../../src/main/services/remote-control-keep-awake.service'
    );

    remoteControlKeepAwakeService.sync(true, true);

    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(remoteControlKeepAwakeService.isActive()).toBe(true);
  });

  it.each([false, undefined])(
    'does not start when keep-awake is %s, which is the default',
    async (keepAwake) => {
      const { powerSaveBlocker } = await import('electron');
      const { remoteControlKeepAwakeService } = await import(
        '../../../src/main/services/remote-control-keep-awake.service'
      );

      remoteControlKeepAwakeService.sync(true, keepAwake);

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
      expect(remoteControlKeepAwakeService.isActive()).toBe(false);
    }
  );

  it('stops the blocker when direct remote is disabled', async () => {
    const { powerSaveBlocker } = await import('electron');
    const { remoteControlKeepAwakeService } = await import(
      '../../../src/main/services/remote-control-keep-awake.service'
    );

    remoteControlKeepAwakeService.sync(true, true);
    remoteControlKeepAwakeService.sync(false, true);

    const blockerId = powerSaveBlocker.start.mock.results[0]?.value;
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(blockerId);
    expect(remoteControlKeepAwakeService.isActive()).toBe(false);
  });
});
