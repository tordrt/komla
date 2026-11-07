import { z } from 'zod';

import { MAX_STATUS_ICON_BYTES, isStatusItemColor } from '../../shared/types/status-items';
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

import type { WorkspaceAttentionKind } from '../../shared/types';

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
/** An agent hook as reported to Komla, by the komla CLI or from a companion's mailbox. */
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
