import { powerSaveBlocker } from 'electron';

import { createLogger } from '../lib/logger';

const logger = createLogger('RemoteControlKeepAwakeService');

class RemoteControlKeepAwakeService {
  private blockerId: number | null = null;

  sync(enabled: boolean | undefined, keepAwake: boolean | undefined): void {
    if (enabled && keepAwake === true) {
      this.start();
      return;
    }
    this.stop();
  }

  start(): void {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) return;
    this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
    logger.info('remote control keep-awake started', { blockerId: this.blockerId });
  }

  stop(): void {
    if (this.blockerId === null) return;
    const blockerId = this.blockerId;
    this.blockerId = null;
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
    logger.info('remote control keep-awake stopped', { blockerId });
  }

  isActive(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId);
  }
}

export const remoteControlKeepAwakeService = new RemoteControlKeepAwakeService();
