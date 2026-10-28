import type { WorkspaceCwdResolution } from './workspace-cwd-resolution.service';
import type { Workspace } from '../../shared/types';

export interface NotificationTargetPayload {
  cwd: string;
  workspaceId?: string;
  terminalId?: string;
  source?: string;
}

export interface NotificationTargetResolutionContext {
  findWorkspaceByTerminalId: (terminalId: string) => Workspace | undefined;
  getWorkspace: (workspaceId: string) => Workspace | undefined;
  resolveWorkspaceByCwd: (cwd: string) => WorkspaceCwdResolution;
}

export type NotificationTargetWarning =
  | {
      kind: 'terminal-not-found';
      workspaceId?: string;
      terminalId: string;
      cwd: string;
    }
  | {
      kind: 'terminal-not-in-workspace';
      workspaceId: string;
      terminalId: string;
      cwd: string;
    }
  | {
      kind: 'workspace-not-found';
      workspaceId: string;
      terminalId?: string;
      cwd: string;
    }
  | {
      kind: 'cwd-not-resolved';
      cwd: string;
      error: string;
    };

export type NotificationTargetResolution =
  | {
      workspace: Workspace;
      terminalId?: string;
      hasInvalidTerminalId: boolean;
      warnings: NotificationTargetWarning[];
      error?: undefined;
    }
  | {
      workspace?: undefined;
      terminalId?: undefined;
      hasInvalidTerminalId: boolean;
      warnings: NotificationTargetWarning[];
      error?: string;
    };

class NotificationTargetResolutionService {
  resolve(
    payload: NotificationTargetPayload,
    context: NotificationTargetResolutionContext
  ): NotificationTargetResolution {
    const warnings: NotificationTargetWarning[] = [];

    // Codex runs every session's hooks in one shared process, with the environment of the
    // Terminal that started it, so their ids may name another session's Terminal. Their cwd is
    // the session's own.
    if (payload.source === 'codex') {
      const { workspace } = context.resolveWorkspaceByCwd(payload.cwd);
      if (workspace) {
        return {
          workspace,
          terminalId:
            payload.terminalId && this.workspaceHasTerminal(workspace, payload.terminalId)
              ? payload.terminalId
              : undefined,
          hasInvalidTerminalId: false,
          warnings,
        };
      }
    }

    if (payload.terminalId) {
      const workspace = context.findWorkspaceByTerminalId(payload.terminalId);
      if (workspace) {
        return {
          workspace,
          terminalId: payload.terminalId,
          hasInvalidTerminalId: false,
          warnings,
        };
      }
      warnings.push({
        kind: 'terminal-not-found',
        workspaceId: payload.workspaceId,
        terminalId: payload.terminalId,
        cwd: payload.cwd,
      });
    }

    if (payload.workspaceId) {
      const workspace = context.getWorkspace(payload.workspaceId);
      if (workspace) {
        if (!payload.terminalId) {
          return {
            workspace,
            hasInvalidTerminalId: false,
            warnings,
          };
        }

        if (this.workspaceHasTerminal(workspace, payload.terminalId)) {
          return {
            workspace,
            terminalId: payload.terminalId,
            hasInvalidTerminalId: false,
            warnings,
          };
        }

        warnings.push({
          kind: 'terminal-not-in-workspace',
          workspaceId: payload.workspaceId,
          terminalId: payload.terminalId,
          cwd: payload.cwd,
        });
      } else {
        warnings.push({
          kind: 'workspace-not-found',
          workspaceId: payload.workspaceId,
          terminalId: payload.terminalId,
          cwd: payload.cwd,
        });
      }
    }

    const resolution = context.resolveWorkspaceByCwd(payload.cwd);
    if (!resolution.workspace) {
      if (resolution.error) {
        warnings.push({
          kind: 'cwd-not-resolved',
          cwd: payload.cwd,
          error: resolution.error,
        });
      }
      return {
        hasInvalidTerminalId: Boolean(payload.terminalId),
        warnings,
        error: resolution.error,
      };
    }

    const terminalId =
      payload.terminalId && this.workspaceHasTerminal(resolution.workspace, payload.terminalId)
        ? payload.terminalId
        : undefined;

    return {
      workspace: resolution.workspace,
      terminalId,
      hasInvalidTerminalId: Boolean(payload.terminalId && !terminalId),
      warnings,
    };
  }

  private workspaceHasTerminal(workspace: Workspace, terminalId: string): boolean {
    return workspace.terminals.some((terminal) => terminal.id === terminalId);
  }
}

export const notificationTargetResolutionService = new NotificationTargetResolutionService();
