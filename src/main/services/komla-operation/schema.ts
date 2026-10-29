import { z } from 'zod';

import { isBrowserUrl, MAX_BROWSER_URL_LENGTH } from '../../../shared/lib/browser-tabs';
import {
  MAX_VIRTUAL_DESKTOP_NAME_LENGTH,
  MAX_VNC_PASSWORD_LENGTH,
} from '../../../shared/lib/virtual-desktops';
import {
  MAX_WORKSPACE_TAG_LENGTH,
  MAX_WORKSPACE_TAG_TOOLTIP,
  WORKSPACE_TAG_TONES,
} from '../../../shared/lib/workspace-tags';
import { VIRTUAL_DESKTOP_VIEWERS } from '../../../shared/types';
import {
  MAX_STATUS_ICON_BYTES,
  MAX_STATUS_ITEM_ICONS,
  MAX_STATUS_ITEM_SEGMENTS,
  MAX_STATUS_ITEM_TEXT,
  MAX_STATUS_ITEM_TOOLTIP,
  MAX_STATUS_POPOVER_HTML,
  MAX_STATUS_POPOVER_MARKDOWN,
  isStatusItemColor,
  STATUS_ITEM_ID_PATTERN,
  STATUS_ITEM_TONES,
} from '../../../shared/types/status-items';
import { statusIconDataUrl } from '../../lib/status-icon';
import { visibleStatusText } from '../../lib/status-item-text';

import { KomlaOperationError, type KomlaOperation } from './operation';

// Length caps are generous — they exist to bound abuse, not to constrain real payloads.
export const MAX_PATH_LEN = 4096;
export const MAX_NAME_LEN = 256;
export const MAX_BRANCH_LEN = 256;
export const MAX_DESCRIPTION_LEN = 2048;
export const MAX_PROJECT_NAME_LEN = 256;
export const MAX_PROMPT_LEN = 64 * 1024;
export const MAX_ID_LEN = 128;

export const statusItemIdSchema = z
  .string()
  .regex(
    STATUS_ITEM_ID_PATTERN,
    'Status item ids are up to 40 letters, digits, dots, dashes and underscores.'
  );
export const statusItemColorSchema = z
  .string()
  .trim()
  .refine(
    isStatusItemColor,
    'Status item colors are success, warning, error, info, muted, foreground or a hex color such as #e5c07b.'
  );
export const statusPopoverMarkdownSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_STATUS_POPOVER_MARKDOWN);
export const statusPopoverHtmlSchema = z.string().trim().min(1).max(MAX_STATUS_POPOVER_HTML);
// Terminal colors in an item's text don't count toward its length.
const MAX_STATUS_ITEM_RAW_TEXT = 1_000;
const fitsStatusItem = (text: string) => {
  const length = visibleStatusText(text).length;
  return length > 0 && length <= MAX_STATUS_ITEM_TEXT;
};
export const statusItemTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_STATUS_ITEM_RAW_TEXT)
  .refine(
    fitsStatusItem,
    `Status item text is 1 to ${MAX_STATUS_ITEM_TEXT} characters, not counting terminal colors.`
  );
// Percent-encoded SVG can take three characters a byte.
const MAX_STATUS_ICON_INPUT = MAX_STATUS_ICON_BYTES * 3;
export const statusIconSchema = z
  .string()
  .max(MAX_STATUS_ICON_INPUT)
  .refine(
    (icon) => statusIconDataUrl(icon) !== undefined,
    `Status item icons are SVG markup or an image data URL (SVG, PNG, WebP, GIF or JPEG) of at most ${MAX_STATUS_ICON_BYTES / 1024} KB.`
  );
const workspaceTagNameSchema = z.string().trim().min(1).max(MAX_WORKSPACE_TAG_LENGTH);
export const statusItemSegmentsSchema = z
  .array(
    z.union([
      z
        .object({
          // The parts' text together, past terminal colors, is checked below.
          text: z.string().min(1).max(MAX_STATUS_ITEM_RAW_TEXT),
          color: statusItemColorSchema.optional(),
          bold: z.boolean().optional(),
        })
        .strict(),
      z.object({ icon: statusIconSchema, color: statusItemColorSchema.optional() }).strict(),
    ])
  )
  .min(1)
  .max(MAX_STATUS_ITEM_SEGMENTS)
  .refine(
    (segments) =>
      fitsStatusItem(segments.map((segment) => ('text' in segment ? segment.text : '')).join('')),
    `Status item segments are 1 to ${MAX_STATUS_ITEM_TEXT} characters together.`
  )
  .refine(
    (segments) => segments.filter((segment) => 'icon' in segment).length <= MAX_STATUS_ITEM_ICONS,
    `A status item shows at most ${MAX_STATUS_ITEM_ICONS} icons.`
  );

const komlaOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('context.get') }).strict(),
  z
    .object({
      type: z.literal('agent.presets'),
      includeInactive: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('agent.launch'),
      destination: z.enum(['tab', 'workspace']),
      project: z.string().min(1).max(MAX_PROJECT_NAME_LEN).optional(),
      preset: z.string().min(1).max(MAX_NAME_LEN).optional(),
      mode: z.string().min(1).max(MAX_NAME_LEN).optional(),
      prompt: z.string().max(MAX_PROMPT_LEN).optional(),
      name: z.string().min(1).max(MAX_NAME_LEN).optional(),
      description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
      branch: z.string().min(1).max(MAX_BRANCH_LEN).optional(),
      fromCurrentBranch: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace.title'),
      title: z.string().trim().min(1).max(MAX_NAME_LEN),
      description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace.snooze'),
      until: z.string().trim().min(1).max(40).optional(),
      untilNotified: z.literal(true).optional(),
    })
    .strict()
    .refine((operation) => operation.until !== undefined || operation.untilNotified, {
      message: 'A snooze needs until or untilNotified.',
    }),
  z.object({ type: z.literal('workspace.wake') }).strict(),
  z.object({ type: z.literal('workspace.list'), includeTrashed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('tag.list') }).strict(),
  z
    .object({
      type: z.literal('workspace.tag'),
      tag: workspaceTagNameSchema.optional(),
      tooltip: z.string().trim().min(1).max(MAX_WORKSPACE_TAG_TOOLTIP).optional(),
      tone: z.enum(WORKSPACE_TAG_TONES).optional(),
      // Saved with the tag as the base64 data URL a status item's icon is.
      icon: statusIconSchema.transform((icon) => statusIconDataUrl(icon) as string).optional(),
      spinner: z.boolean().optional(),
      ifTag: workspaceTagNameSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('workspace.trash') }).strict(),
  z
    .object({
      type: z.enum(['workspace.link', 'workspace.unlink']),
      workspaceIds: z.array(z.string().min(1).max(MAX_ID_LEN)).min(1).max(100),
    })
    .strict(),
  z.object({ type: z.literal('folder.open'), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      type: z.literal('status.set'),
      id: statusItemIdSchema,
      text: statusItemTextSchema.optional(),
      segments: statusItemSegmentsSchema.optional(),
      icon: statusIconSchema.optional(),
      iconColor: statusItemColorSchema.optional(),
      tone: z.enum(STATUS_ITEM_TONES).optional(),
      color: statusItemColorSchema.optional(),
      tooltip: z.string().trim().min(1).max(MAX_STATUS_ITEM_TOOLTIP).optional(),
      link: z.string().min(1).max(MAX_PATH_LEN).optional(),
      popover: statusPopoverHtmlSchema.optional(),
      popoverMarkdown: statusPopoverMarkdownSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('status.clear'),
      id: statusItemIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('status.refresh'),
      id: statusItemIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('preview.open'),
      url: z.string().min(1).max(MAX_PATH_LEN).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('desktop.open'),
      vncPort: z.number().int().min(1).max(65535),
      url: z.string().max(MAX_BROWSER_URL_LENGTH).refine(isBrowserUrl).optional(),
      viewer: z.enum(VIRTUAL_DESKTOP_VIEWERS).optional(),
      vncPassword: z.string().min(1).max(MAX_VNC_PASSWORD_LENGTH).optional(),
      vncPorts: z.array(z.number().int().min(1).max(65535)).max(100).optional(),
      app: z.string().min(1).max(MAX_VIRTUAL_DESKTOP_NAME_LENGTH).optional(),
    })
    .strict(),
]);

/**
 * The Komla Operation a request body asks for, as the CLI sends it. Throws INVALID_OPERATION,
 * with the schema's issues in its details, for anything else.
 */
export function parseKomlaOperation(raw: unknown): KomlaOperation {
  const parsed = komlaOperationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KomlaOperationError('INVALID_OPERATION', 'Invalid Komla operation.', 400, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
