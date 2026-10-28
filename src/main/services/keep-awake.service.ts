import { powerSaveBlocker } from 'electron';

import { agentsWorkingHere } from '../../shared/lib/terminal-execution-state';
import { createLogger } from '../lib/logger';

import { onRemoteWorkspaceChange } from './remote-workspace-events';

import type { Workspace } from '../../shared/types';

const logger = createLogger('KeepAwakeService');

export type KeepAwakeMode = 'off' | 'agents' | 'always';

/**
 * Keeps the computer from going to sleep on its own, always or while an agent is working on it, as
 * the user chose. The display can still turn off. Separate from remote control's keep-awake, which
 * holds its own blocker.
 */
class KeepAwakeService {
  private mode: KeepAwakeMode = 'off';
  private agentsWorking = false;
  private blockerId: number | null = null;

  setMode(mode: KeepAwakeMode | undefined): void {
    this.mode = mode ?? 'off';
    this.apply();
  }

  setAgentsWorking(working: boolean): void {
    if (working === this.agentsWorking) return;
    this.agentsWorking = working;
    this.apply();
  }

  stop(): void {
    this.mode = 'off';
    this.apply();
  }

  isActive(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId);
  }

  private apply(): void {
    const keepAwake = this.mode === 'always' || (this.mode === 'agents' && this.agentsWorking);
    if (keepAwake) {
      if (this.isActive()) return;
      this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
      logger.info('keep-awake started', { mode: this.mode, blockerId: this.blockerId });
      return;
    }
    if (this.blockerId === null) return;
    const blockerId = this.blockerId;
    this.blockerId = null;
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    logger.info('keep-awake stopped', { mode: this.mode, blockerId });
  }
}

export const keepAwakeService = new KeepAwakeService();

/**
 * Tells the service whether any agent is working on this computer, after every workspace change.
 * Agents in tmux on an SSH host keep working while it sleeps.
 */
export function keepAwakeWhileAgentsWork(listWorkspaces: () => Workspace[]): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = onRemoteWorkspaceChange(() => {
    // One turn changes workspaces many times; sleep can wait a second.
    timer ??= setTimeout(() => {
      timer = null;
      keepAwakeService.setAgentsWorking(
        listWorkspaces().some(
          (workspace) => workspace.status === 'active' && agentsWorkingHere(workspace) > 0
        )
      );
    }, 1000);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
