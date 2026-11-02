import { z } from 'zod';

import { isSshWorkspace } from '../../shared/types';
import { MAX_STATUS_ICON_BYTES, isStatusItemColor } from '../../shared/types/status-items';
import { createLogger } from '../lib/logger';
import { statusIconDataUrl } from '../lib/status-icon';

import {
  MAX_COLOR_LEN,
  MAX_ID_LEN,
  MAX_NAME_LEN,
  MAX_NOTIFICATION_BADGE_LEN,
  MAX_NOTIFICATION_BODY_LEN,
  MAX_NOTIFICATION_SOURCE_LEN,
  MAX_PATH_LEN,
} from './komla-operation/schema';
import {
  notificationTargetResolutionService,
  type NotificationTargetResolution,
  type NotificationTargetWarning,
} from './notification-target-resolution.service';
import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { settlesBeforeShowing } from './terminal-attention/notification-lifecycle';
import {
  workspaceCwdResolutionService,
  type WorkspaceCwdResolutionContext,
  type WorkspaceCwdResolution,
} from './workspace-cwd-resolution.service';
import { workspaceService } from './workspace.service';

import type { AgentHook, HookTarget } from './terminal-attention/terminal-attention';
import type { Project, Workspace, WorkspaceAttentionKind } from '../../shared/types';

const logger = createLogger('NotificationDeliveryService');

// Unknown terminals whose hooks already had their host synced, before the oldest is forgotten.
const MAX_UNKNOWN_TERMINALS_TRACKED = 1024;

const MAX_LEVEL_LEN = 64;
const MAX_MESSAGE_LEN = 64 * 1024;

// The hooks the komla CLI reports as `interrupted`: Codex was cancelled, or Claude quit.
const INTERRUPT_HOOK_EVENTS = new Set(['Interrupt', 'SessionEnd']);

const NOTIFICATION_KIND_VALUES = [
  'input-required',
  'turn-complete',
  'error',
  'idle',
  'generic',
  'prompt-submit',
  'activity',
  'interrupted',
] as const satisfies readonly (
  | WorkspaceAttentionKind
  | 'prompt-submit'
  | 'activity'
  | 'interrupted'
)[];

const notificationKindSchema = z.enum(NOTIFICATION_KIND_VALUES);

// `source` accepts any bounded string so custom agents (the in-app integration
// example documents `source: "my-agent"`) keep working. Treated as an opaque
// label downstream — only used as a Map key for per-agent spinner tracking.
export const notificationPayloadSchema = z
  .object({
    cwd: z.string().min(1).max(MAX_PATH_LEN),
    workspaceId: z.string().min(1).max(MAX_ID_LEN).optional(),
    terminalId: z.string().min(1).max(MAX_ID_LEN).optional(),
    deliveryId: z.string().min(1).max(MAX_ID_LEN).optional(),
    kind: notificationKindSchema.optional(),
    source: z.string().min(1).max(MAX_NOTIFICATION_SOURCE_LEN).optional(),
    title: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
    body: z.string().max(MAX_NOTIFICATION_BODY_LEN).optional(),
    color: z.string().min(1).max(MAX_COLOR_LEN).optional(),
    badge: z.string().trim().min(1).max(MAX_NOTIFICATION_BADGE_LEN).optional(),
    // Shown like a status item's icon: as an image, where SVG runs no scripts.
    icon: z
      .string()
      .max(MAX_STATUS_ICON_BYTES * 3)
      .transform((icon, context) => {
        const dataUrl = statusIconDataUrl(icon);
        if (dataUrl) return dataUrl;
        context.addIssue({
          code: 'custom',
          message: `Notification icons are SVG markup or an image data URL (SVG, PNG, WebP, GIF or JPEG) of at most ${MAX_STATUS_ICON_BYTES / 1024} KB.`,
        });
        return z.NEVER;
      })
      .optional(),
    iconColor: z
      .string()
      .trim()
      .refine(
        isStatusItemColor,
        'Icon colors are success, warning, error, info, muted, foreground or a hex color such as #e5c07b.'
      )
      .optional(),
    message: z.string().max(MAX_MESSAGE_LEN).optional(),
    hookInput: z
      .object({
        session_id: z.string().min(1).max(MAX_ID_LEN).optional(),
        turn_id: z.string().min(1).max(MAX_ID_LEN).optional(),
        prompt_id: z.string().min(1).max(MAX_ID_LEN).optional(),
        agent_id: z.string().max(MAX_ID_LEN).optional(),
        hook_event_name: z.string().min(1).max(MAX_NAME_LEN).optional(),
      })
      .catchall(z.unknown())
      .optional(),
    level: z.string().max(MAX_LEVEL_LEN).optional(),
    /** A copy for a device that isn't attached to the terminal; only its owner acts on it. */
    copy: z.boolean().optional(),
  })
  .strip()
  // An interrupt comes from an agent hook (Codex's Interrupt, Claude's SessionEnd), or as a
  // copy from the device a keystroke interrupted the agent on.
  .refine(
    (payload) =>
      payload.kind !== 'interrupted' ||
      payload.copy === true ||
      INTERRUPT_HOOK_EVENTS.has(payload.hookInput?.hook_event_name ?? ''),
    {
      message: 'An interrupt is only accepted from an agent hook or as a copy',
      path: ['kind'],
    }
  );

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

function findUnambiguousWorkspaceByCwd(cwd: string, sshHostId?: string): WorkspaceCwdResolution {
  return workspaceCwdResolutionService.resolveWorkspaceByCwd(
    cwd,
    getWorkspaceCwdContext(sshHostId),
    { rejectAmbiguousMatches: true }
  );
}

function getWorkspaceCwdContext(sshHostId?: string): WorkspaceCwdResolutionContext {
  return {
    workspaces: workspaceService
      .list()
      .filter((workspace) => workspaceMatchesSshHost(workspace, sshHostId)),
    getProject: (projectId: string): Project | undefined => projectService.get(projectId),
    komlaBasePath: getKomlaBasePath(),
  };
}

function workspaceMatchesSshHost(workspace: Workspace, sshHostId?: string): boolean {
  return !sshHostId || (isSshWorkspace(workspace) && workspace.backend.hostId === sshHostId);
}

function logTargetWarnings(warnings: NotificationTargetWarning[]): void {
  for (const warning of warnings) {
    if (warning.kind === 'terminal-not-found') {
      logger.warn('Notification terminalId was not found; falling back to workspaceId/cwd', {
        workspaceId: warning.workspaceId,
        terminalId: warning.terminalId,
        cwd: warning.cwd,
      });
    } else if (warning.kind === 'terminal-not-in-workspace') {
      logger.warn('Notification terminalId did not belong to workspace; falling back to cwd', {
        workspaceId: warning.workspaceId,
        terminalId: warning.terminalId,
        cwd: warning.cwd,
      });
    } else if (warning.kind === 'workspace-not-found') {
      logger.warn('Notification workspaceId was not found; falling back to cwd', {
        workspaceId: warning.workspaceId,
        terminalId: warning.terminalId,
        cwd: warning.cwd,
      });
    } else if (warning.kind === 'cwd-not-resolved') {
      logger.warn('Notification cwd fallback did not resolve to a single workspace', {
        cwd: warning.cwd,
        error: warning.error,
      });
    }
  }
}

export type HookReceipt =
  | { kind: 'no-terminal' }
  | {
      kind: 'accepting';
      acceptance: Promise<Workspace | undefined>;
      settlesLater: boolean;
    };

/**
 * Takes agent hooks reported to Komla: which workspace and terminal each is for, and when each
 * counts as durably accepted. How hooks arrive stays with the route that receives them.
 */
class NotificationDeliveryService {
  private pendingAcceptances = new Map<string, Promise<Workspace | undefined>>();
  /** Unknown terminals whose hooks had their host synced; see syncHostOfUnknownTerminal. */
  private readonly hostSyncedForTerminals = new Set<string>();

  /**
   * Starts taking a hook. `settlesLater` says that accepting it waits for it to settle, so a sender
   * able to retry needn't wait.
   */
  receive(payload: NotificationPayload, sshHostId?: string): HookReceipt {
    const target = this.resolveTarget(payload, sshHostId);
    // A copy is a hook for a terminal another device is attached to. It can't be matched by
    // folder.
    if (payload.copy && (!target.workspace || !target.terminalId)) {
      this.syncHostOfUnknownTerminal(payload, sshHostId);
      return { kind: 'no-terminal' };
    }
    return {
      kind: 'accepting',
      acceptance: this.accept(payload, target),
      settlesLater: Boolean(
        payload.deliveryId && target.terminalId && settlesBeforeShowing(payload)
      ),
    };
  }

  private resolveWorkspaceByCwd(
    cwd: string,
    options: { rejectAmbiguousMatches?: boolean } = {}
  ): WorkspaceCwdResolution {
    return workspaceCwdResolutionService.resolveWorkspaceByCwd(
      cwd,
      getWorkspaceCwdContext(),
      options
    );
  }

  private resolveTarget(payload: NotificationPayload, sshHostId?: string) {
    return notificationTargetResolutionService.resolve(payload, {
      findWorkspaceByTerminalId: (terminalId) => {
        const workspace = workspaceService.findWorkspaceByTerminalId(terminalId);
        return workspace && workspaceMatchesSshHost(workspace, sshHostId) ? workspace : undefined;
      },
      getWorkspace: (workspaceId) => {
        const workspace = workspaceService.get(workspaceId);
        return workspace && workspaceMatchesSshHost(workspace, sshHostId) ? workspace : undefined;
      },
      resolveWorkspaceByCwd: (cwd) => findUnambiguousWorkspaceByCwd(cwd, sshHostId),
    });
  }

  /**
   * A hook from an SSH host for a terminal this installation lacks may come from a workspace
   * started there, e.g. from a phone: the host is synced to add it. Once per terminal, as one
   * still unknown after that is one this installation won't add, e.g. another device keeps it.
   */
  syncHostOfUnknownTerminal(payload: NotificationPayload, sshHostId?: string): void {
    if (!sshHostId || !payload.terminalId) return;
    if (workspaceService.findWorkspaceByTerminalId(payload.terminalId)) return;
    if (this.hostSyncedForTerminals.has(payload.terminalId)) return;
    if (this.hostSyncedForTerminals.size >= MAX_UNKNOWN_TERMINALS_TRACKED) {
      const [oldest] = this.hostSyncedForTerminals;
      this.hostSyncedForTerminals.delete(oldest);
    }
    this.hostSyncedForTerminals.add(payload.terminalId);
    workspaceService.sshSync.expectWorkspace(sshHostId);
  }

  /**
   * Shows a notification code sent for a workspace it named, as `workspace.notify` does: as a hook
   * without a delivery id is taken, then saved at once on an SSH workspace.
   */
  async notify(
    target: HookTarget & { workspace: Workspace },
    notification: AgentHook
  ): Promise<void> {
    const outcome = await workspaceService.attention.hook(target, notification);
    if (outcome === 'taken') await workspaceService.persistSshAttention(target.workspace.id);
  }

  /** Takes the hook: the same delivery of a terminal's hook is only ever taken once. */
  private async accept(
    payload: NotificationPayload,
    target: NotificationTargetResolution
  ): Promise<Workspace | undefined> {
    const deliveryKey =
      payload.deliveryId && target.terminalId
        ? `${target.terminalId}\0${payload.deliveryId}`
        : undefined;
    const pendingAcceptance = deliveryKey ? this.pendingAcceptances.get(deliveryKey) : undefined;
    if (pendingAcceptance) return pendingAcceptance;
    if (
      payload.deliveryId &&
      target.terminalId &&
      workspaceService.hasAcceptedTerminalHook(target.terminalId, payload.deliveryId)
    ) {
      return target.workspace;
    }

    const acceptance = Promise.resolve().then(async () => {
      const outcome = await workspaceService.attention.hook(target, payload);
      const matchedWorkspace = target.workspace;
      if (outcome === 'unmatched' || !matchedWorkspace) return undefined;
      logTargetWarnings(target.warnings);
      if (outcome === 'ignored') return matchedWorkspace;
      if (payload.copy) {
        workspaceService.recordCopiedHookDelivery(
          matchedWorkspace.id,
          payload.deliveryId && target.terminalId
            ? { terminalId: target.terminalId, deliveryId: payload.deliveryId }
            : undefined
        );
      } else if (payload.deliveryId && target.terminalId) {
        await workspaceService.persistSshAttention(matchedWorkspace.id, {
          terminalId: target.terminalId,
          deliveryId: payload.deliveryId,
        });
      } else {
        await workspaceService.persistSshAttention(matchedWorkspace.id);
      }
      return matchedWorkspace;
    });
    if (!deliveryKey) {
      if (target.workspace && !target.hasInvalidTerminalId && settlesBeforeShowing(payload)) {
        // Synchronous agent hooks must return before the settle timer expires,
        // otherwise the agent cannot resume and cancel what is settling.
        void acceptance.catch((error) => logger.error('Failed to settle notification:', error));
        return target.workspace;
      }
      return acceptance;
    }

    this.pendingAcceptances.set(deliveryKey, acceptance);
    try {
      return await acceptance;
    } finally {
      if (this.pendingAcceptances.get(deliveryKey) === acceptance) {
        this.pendingAcceptances.delete(deliveryKey);
      }
    }
  }
}

export const notificationDeliveryService = new NotificationDeliveryService();
