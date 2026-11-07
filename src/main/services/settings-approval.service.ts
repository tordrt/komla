import { randomUUID } from 'crypto';

import { app, BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { createLogger } from '../lib/logger';

import {
  SettingsManagementError,
  type SettingsApprovalRequest,
} from './settings-management.service';
import { windowService } from './window.service';

import type {
  SettingsApprovalDecision,
  SettingsApprovalPrompt,
  SettingsFileResource,
  Workspace,
} from '../../shared/types';

const logger = createLogger('SettingsApprovalService');

/** What the confirmation names for each settings file. */
const SETTINGS_FILE_TARGETS: Record<SettingsFileResource, string> = {
  'status-items': 'Status bar items',
  'sidebar-panels': 'Sidebar panels',
  plugins: 'Plugins',
  hooks: 'Hooks',
  shortcuts: 'Keyboard shortcuts',
  terminal: 'Terminal settings',
  agents: 'Agents',
};

/** What a settings approval says it changes. */
function settingsApprovalTarget(request: SettingsApprovalRequest): string {
  if (request.resource in SETTINGS_FILE_TARGETS) {
    return SETTINGS_FILE_TARGETS[request.resource as SettingsFileResource];
  }
  const project = request.project?.name ?? 'Project';
  switch (request.resource) {
    case 'appearance':
      return 'Appearance';
    case 'workspace-setup':
      return `${project} Workspace Setup`;
    case 'automations':
      return `${project} Automations`;
    case 'project-settings':
      return `${project} settings`;
    default:
      return request.project ? `${request.project.name} Quick Commands` : 'Global Quick Commands';
  }
}

class SettingsApprovalService {
  private recentFeedback = new Map<string, number>();
  private pending = new Map<
    string,
    {
      senderId: number;
      window: BrowserWindow;
      prompt: SettingsApprovalPrompt;
      finish: (decision: SettingsApprovalDecision | 'unanswered') => void;
    }
  >();

  private selectWindow(request: SettingsApprovalRequest): BrowserWindow | undefined {
    const workspaceWindow = request.workspace?.windowId
      ? windowService.getWindow(request.workspace.windowId)
      : undefined;
    return workspaceWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  }

  /** Asks the user in a Komla window to apply the changes; true once they do. */
  async approve(request: SettingsApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    return (await this.decide(request, signal)) === 'apply';
  }

  /**
   * Asks the user in a Komla window whether to apply the changes. `unanswered`
   * when the prompt ended without their choice, e.g. as the window closed or
   * reloaded.
   */
  async decide(
    request: SettingsApprovalRequest,
    signal?: AbortSignal
  ): Promise<SettingsApprovalDecision | 'unanswered'> {
    const window = this.selectWindow(request);
    if (!window) {
      throw new SettingsManagementError(
        'NO_APPROVAL_WINDOW',
        'No Komla window is available to approve settings.',
        503
      );
    }
    const prompt: SettingsApprovalPrompt = {
      id: randomUUID(),
      resource: request.resource,
      target: settingsApprovalTarget(request),
      changes: request.changes,
      ...((request.multiProjectWarning ?? request.warning)
        ? { warning: request.multiProjectWarning ?? request.warning }
        : {}),
      ...(request.preview ? { preview: request.preview } : {}),
      ...(request.description ? { description: request.description } : {}),
      ...(request.workspace && {
        source: {
          workspaceId: request.workspace.id,
          ...(request.terminalId && { terminalId: request.terminalId }),
        },
      }),
    };
    return new Promise<SettingsApprovalDecision | 'unanswered'>((resolve) => {
      let settled = false;
      const finish = (decision: SettingsApprovalDecision | 'unanswered'): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(prompt.id);
        signal?.removeEventListener('abort', onAbort);
        window.webContents.removeListener('destroyed', onDestroyed);
        window.webContents.removeListener('did-start-navigation', onNavigation);
        window.webContents.removeListener('render-process-gone', onRendererGone);
        if (!window.webContents.isDestroyed()) {
          this.sendToWindow(window, IPC.SETTINGS_APPROVAL_DISMISSED, prompt.id);
        }
        resolve(decision);
      };
      const onAbort = (): void => finish('unanswered');
      const onDestroyed = (): void => finish('unanswered');
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) finish('unanswered');
      };
      const onRendererGone = (): void => finish('unanswered');
      this.pending.set(prompt.id, {
        senderId: window.webContents.id,
        window,
        prompt,
        finish,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      window.webContents.once('destroyed', onDestroyed);
      window.webContents.on('did-start-navigation', onNavigation);
      window.webContents.once('render-process-gone', onRendererGone);
      if (signal?.aborted) {
        finish('unanswered');
        return;
      }
      if (!this.sendToWindow(window, IPC.SETTINGS_APPROVAL_REQUESTED, prompt)) {
        finish('unanswered');
        return;
      }
      if (request.background) return;
      if (window.isMinimized()) window.restore();
      window.show();
      if (process.platform === 'darwin') {
        app.focus({ steal: true });
      } else {
        app.focus();
      }
      window.focus();
    });
  }

  private sendToWindow(window: BrowserWindow, channel: string, ...args: unknown[]): boolean {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
    try {
      window.webContents.send(channel, ...args);
      return true;
    } catch (error) {
      logger.warn('Failed to deliver settings approval to renderer', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  resolve(id: string, decision: SettingsApprovalDecision, senderId: number): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.senderId !== senderId) return false;
    pending.finish(decision);
    return true;
  }

  requestPending(senderId: number): boolean {
    const pending = Array.from(this.pending.values()).find(
      (approval) => approval.senderId === senderId
    );
    if (!pending) return false;
    return this.sendToWindow(pending.window, IPC.SETTINGS_APPROVAL_REQUESTED, pending.prompt);
  }

  sendFeedback(message: string, workspace?: Workspace): void {
    const request = { workspace, changes: [], resource: 'actions' as const };
    const window = this.selectWindow(request);
    if (!window) return;
    const key = `${window.id}:${message}`;
    const now = Date.now();
    if (now - (this.recentFeedback.get(key) ?? 0) < 2_000) return;
    this.recentFeedback.set(key, now);
    window.webContents.send(IPC.SETTINGS_FEEDBACK, message);
    setTimeout(() => this.recentFeedback.delete(key), 2_000).unref();
  }

  /** Ends every open prompt without the user's choice, as when the HTTP server stops. */
  dismissAll(): void {
    for (const approval of Array.from(this.pending.values())) {
      approval.finish('unanswered');
    }
  }
}

export const settingsApprovalService = new SettingsApprovalService();
