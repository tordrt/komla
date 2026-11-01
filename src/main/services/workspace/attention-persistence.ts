import { posix as pathPosix } from 'path';

import { isSshWorkspace } from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { executionLocations } from '../execution-location';
import { remoteCompanionService } from '../remote-companion.service';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';
import { sshWorkspaceService } from '../ssh-workspace.service';

import { workspaceStore } from './store';

import type { Workspace } from '../../../shared/types';

const logger = createLogger('WorkspaceService');

/** Saves SSH workspaces' Terminal Attention at once and records which hook deliveries it took in. */
export class SshAttentionPersistence {
  private pendingTerminalHookDeliveryIds = new Set<string>();

  hasAcceptedTerminalHook(terminalId: string, deliveryId: string): boolean {
    const deliveryKey = `${terminalId}\0${deliveryId}`;
    return (
      !this.pendingTerminalHookDeliveryIds.has(deliveryKey) &&
      workspaceStore.getTerminal(terminalId)?.lastAcceptedHookDeliveryId === deliveryId
    );
  }

  /** Records a copied hook's delivery; it only changes what's shown, so the save is batched. */
  recordCopiedHookDelivery(
    workspaceId: string,
    delivery?: { terminalId: string; deliveryId: string }
  ): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;
    const terminal = delivery
      ? workspace.terminals.find((candidate) => candidate.id === delivery.terminalId)
      : undefined;
    if (terminal && delivery) terminal.lastAcceptedHookDeliveryId = delivery.deliveryId;
    workspaceStore.saveWorkspaces();
  }

  async persistSshAttention(
    workspaceId: string,
    delivery?: { terminalId: string; deliveryId: string }
  ): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;
    const terminal = delivery
      ? workspace.terminals.find((candidate) => candidate.id === delivery.terminalId)
      : undefined;
    const previousDeliveryId = terminal?.lastAcceptedHookDeliveryId;
    const deliveryKey = delivery ? `${delivery.terminalId}\0${delivery.deliveryId}` : undefined;
    if (terminal && delivery && deliveryKey) {
      this.pendingTerminalHookDeliveryIds.add(deliveryKey);
      terminal.lastAcceptedHookDeliveryId = delivery.deliveryId;
    }
    try {
      await workspaceStore.saveWorkspacesImmediateChecked();
    } catch (error) {
      if (terminal) terminal.lastAcceptedHookDeliveryId = previousDeliveryId;
      throw error;
    } finally {
      if (deliveryKey) this.pendingTerminalHookDeliveryIds.delete(deliveryKey);
    }
  }
}

/** Tells the other devices showing an SSH tab that its agent was interrupted here. */
export function relayInterrupt(workspace: Workspace, terminalId: string, sources: string[]): void {
  const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
  if (
    !isSshWorkspace(workspace) ||
    !terminal ||
    !executionLocations.managesSession(workspace, terminal.executionLocation)
  ) {
    return;
  }
  const { backend } = workspace;
  void (async () => {
    const host = sshWorkspaceService.getHost(backend.hostId);
    // The inbox this device's terminals use, at <base>/helpers/companion/<key>/inbox.
    const { hookInbox } = remoteWorkspaceObservationService.companionForWorkspace(backend);
    const remoteBasePath = pathPosix.join(hookInbox, '..', '..', '..', '..');
    // Only through a companion already installed: stopping a tab mustn't upload one.
    const executable = await remoteCompanionService.installedPath(host, remoteBasePath);
    if (!executable) {
      logger.info('Not relaying an interrupt: no companion installed on its host yet', {
        hostId: backend.hostId,
      });
      return;
    }
    await sshWorkspaceService.relayInterrupt(
      backend,
      { executable, hookInbox },
      terminalId,
      sources
    );
  })().catch((error) => logger.warn('Could not tell other devices about an interrupt:', error));
}
