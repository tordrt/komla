import { z } from 'zod';

import { isSshWorkspace } from '../../../../shared/types';
import { MAX_STATUS_ICON_BYTES, isStatusItemColor } from '../../../../shared/types/status-items';
import { createLogger } from '../../../lib/logger';
import { statusIconDataUrl } from '../../../lib/status-icon';
import { MAX_ID_LEN, MAX_NAME_LEN, MAX_PATH_LEN } from '../../komla-operation/schema';
import {
  notificationTargetResolutionService,
  type NotificationTargetResolution,
  type NotificationTargetWarning,
} from '../../notification-target-resolution.service';
import { getKomlaBasePath } from '../../paths';
import { projectService } from '../../project.service';
import { settlesBeforeShowing } from '../../terminal-attention/notification-lifecycle';
import {
  workspaceCwdResolutionService,
  type WorkspaceCwdResolutionContext,
  type WorkspaceCwdResolution,
} from '../../workspace-cwd-resolution.service';
import { workspaceService } from '../../workspace.service';
import { readBody, singleHeader, writeValidationError } from '../http-io';

import type { Project, Workspace, WorkspaceAttentionKind } from '../../../../shared/types';
import type http from 'http';

const logger = createLogger('HttpServerService');

// Unknown terminals whose hooks already had their host synced, before the oldest is forgotten.
const MAX_UNKNOWN_TERMINALS_TRACKED = 1024;

const MAX_SOURCE_LEN = 64;
const MAX_LEVEL_LEN = 64;
const MAX_COLOR_LEN = 256;
// Room for a short label on the sidebar pill; the title carries the rest.
const MAX_NOTIFICATION_BADGE_LEN = 64;
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
const notificationPayloadSchema = z
  .object({
    cwd: z.string().min(1).max(MAX_PATH_LEN),
    workspaceId: z.string().min(1).max(MAX_ID_LEN).optional(),
    terminalId: z.string().min(1).max(MAX_ID_LEN).optional(),
    deliveryId: z.string().min(1).max(MAX_ID_LEN).optional(),
    kind: notificationKindSchema.optional(),
    source: z.string().min(1).max(MAX_SOURCE_LEN).optional(),
    title: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
    body: z.string().max(MAX_MESSAGE_LEN).optional(),
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

type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

const pendingTerminalHookAcceptances = new Map<string, Promise<Workspace | undefined>>();
/** Unknown terminals whose hooks had their host synced; see syncHostOfUnknownTerminal. */
const hostSyncedForTerminals = new Set<string>();

export function handleNotifyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    let raw: unknown;
    try {
      const body = await readBody(req);
      try {
        raw = JSON.parse(body);
      } catch {
        // Scoped narrowly so a SyntaxError thrown deeper in handleNotification
        // isn't misclassified as malformed input.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
    } catch (error) {
      if (!res.headersSent) {
        const isTooBig = error instanceof Error && error.message === 'Request body too large';
        res.writeHead(isTooBig ? 413 : 500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: isTooBig ? 'Request body too large' : 'Failed to read body' })
        );
      }
      return;
    }

    const parsed = notificationPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      writeValidationError(res, parsed.error);
      return;
    }
    const payload = parsed.data;
    const sshHostId = singleHeader(req.headers['x-komla-ssh-host-id']);

    try {
      const target = resolveNotificationTarget(payload, sshHostId);
      // A copy is a hook for a terminal another device is attached to. It can't be matched by
      // folder.
      if (payload.copy && (!target.workspace || !target.terminalId)) {
        syncHostOfUnknownTerminal(payload, sshHostId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching terminal found' }));
        return;
      }
      const acceptance = acceptNotificationDurably(payload, target);
      const canRetryPending =
        req.headers['x-komla-hook-pending'] === 'retry' &&
        payload.deliveryId &&
        target.terminalId &&
        settlesBeforeShowing(payload);
      // A pending response releases the companion's delivery slot without
      // acknowledging durability. Retries share the same acceptance promise.
      const matchedWorkspace = canRetryPending
        ? await Promise.race([
            acceptance,
            new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
          ])
        : await acceptance;
      if (matchedWorkspace === 'pending') {
        void acceptance.catch((error) =>
          logger.error('Failed to settle remote notification:', error)
        );
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending: true }));
      } else if (matchedWorkspace) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        syncHostOfUnknownTerminal(payload, sshHostId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching workspace found', cwd: payload.cwd }));
      }
    } catch (error) {
      if (!res.headersSent) {
        // Log full detail server-side; return a stable generic body since this
        // endpoint is unauthenticated and callable from any local agent.
        logger.error('Failed to handle notification:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to handle notification' }));
      }
    }
  })();
}

/**
 * A hook from an SSH host for a terminal this installation lacks may come from a workspace
 * started there, e.g. from a phone: the host is synced to add it. Once per terminal, as one
 * still unknown after that is one this installation won't add, e.g. another device keeps it.
 */
function syncHostOfUnknownTerminal(payload: NotificationPayload, sshHostId?: string): void {
  if (!sshHostId || !payload.terminalId) return;
  if (workspaceService.findWorkspaceByTerminalId(payload.terminalId)) return;
  if (hostSyncedForTerminals.has(payload.terminalId)) return;
  if (hostSyncedForTerminals.size >= MAX_UNKNOWN_TERMINALS_TRACKED) {
    const [oldest] = hostSyncedForTerminals;
    hostSyncedForTerminals.delete(oldest!);
  }
  hostSyncedForTerminals.add(payload.terminalId);
  workspaceService.sshSync.expectWorkspace(sshHostId);
}

async function acceptNotificationDurably(
  payload: NotificationPayload,
  target: NotificationTargetResolution
): Promise<Workspace | undefined> {
  const deliveryKey =
    payload.deliveryId && target.terminalId
      ? `${target.terminalId}\0${payload.deliveryId}`
      : undefined;
  const pendingAcceptance = deliveryKey
    ? pendingTerminalHookAcceptances.get(deliveryKey)
    : undefined;
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
    logNotificationTargetWarnings(target.warnings);
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

  pendingTerminalHookAcceptances.set(deliveryKey, acceptance);
  try {
    return await acceptance;
  } finally {
    if (pendingTerminalHookAcceptances.get(deliveryKey) === acceptance) {
      pendingTerminalHookAcceptances.delete(deliveryKey);
    }
  }
}

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

function resolveNotificationTarget(payload: NotificationPayload, sshHostId?: string) {
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

function logNotificationTargetWarnings(warnings: NotificationTargetWarning[]): void {
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
