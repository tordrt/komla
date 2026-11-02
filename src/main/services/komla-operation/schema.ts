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
import { NOTIFY_KINDS } from '../../../shared/types/workspace';
import { statusIconDataUrl } from '../../lib/status-icon';
import { visibleStatusText } from '../../lib/status-item-text';
import { MAX_TERMINAL_TEXT_HISTORY } from '../../lib/terminal-text';

import { KomlaOperationError, type KomlaOperation } from './operation';

// Length caps are generous — they exist to bound abuse, not to constrain real payloads.
export const MAX_PATH_LEN = 4096;
export const MAX_NAME_LEN = 256;
export const MAX_BRANCH_LEN = 256;
export const MAX_DESCRIPTION_LEN = 2048;
export const MAX_PROJECT_NAME_LEN = 256;
export const MAX_PROMPT_LEN = 64 * 1024;
export const MAX_ID_LEN = 128;
export const MAX_COLOR_LEN = 256;
/** The longest `komla wait` waits before it checks in. */
export const MAX_TERMINAL_WAIT_MS = 60 * 60 * 1000;
export const MAX_NOTIFICATION_SOURCE_LEN = 64;
// Room for a short label on the sidebar pill; the title carries the rest.
export const MAX_NOTIFICATION_BADGE_LEN = 64;
export const MAX_NOTIFICATION_BODY_LEN = 64 * 1024;

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

const terminalSelectorSchema = z.string().trim().min(1).max(MAX_NAME_LEN);
const terminalWaitTimeoutSchema = z.number().int().min(1).max(MAX_TERMINAL_WAIT_MS);

export const komlaOperationSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('terminal.list') })
    .strict()
    .describe("The workspace's terminals, each with its state."),
  z
    .object({
      type: z.literal('terminal.read'),
      terminal: terminalSelectorSchema.describe(
        'The terminal, by its id or a tab name only one terminal has.'
      ),
      history: z
        .number()
        .int()
        .min(0)
        .max(MAX_TERMINAL_TEXT_HISTORY)
        .optional()
        .describe('How many lines of scrollback to read before what the screen shows.'),
    })
    .strict()
    .describe('Reads what a terminal shows, as its pane shows it.'),
  z
    .object({
      type: z.literal('terminal.send'),
      terminal: terminalSelectorSchema.describe(
        'The terminal, by its id or a tab name only one terminal has.'
      ),
      text: z.string().min(1).max(MAX_PROMPT_LEN).describe('What to type, as a prompt.'),
      force: z.boolean().optional().describe('Sends it even to an agent waiting for the user.'),
      wait: z
        .boolean()
        .optional()
        .describe("Waits for the agent's turn that the text starts to end."),
      timeoutMs: terminalWaitTimeoutSchema
        .optional()
        .describe('How long to wait, in milliseconds.'),
    })
    .strict()
    .describe('Types text into a terminal, as to steer the agent in it.'),
  z
    .object({
      type: z.literal('terminal.wait'),
      terminal: terminalSelectorSchema.describe(
        'The terminal, by its id or a tab name only one terminal has.'
      ),
      output: z
        .string()
        .min(1)
        .max(MAX_NAME_LEN)
        .optional()
        .describe(
          "Waits until the terminal prints this text, in place of the agent's turn ending."
        ),
      timeoutMs: terminalWaitTimeoutSchema
        .optional()
        .describe('How long to wait, in milliseconds.'),
    })
    .strict()
    .describe('Waits until the agent in a terminal ends its turn, needs the user, or exits.'),
  z
    .object({ type: z.literal('context.get') })
    .strict()
    .describe('Where the call comes from: its workspace, project, terminal and agent.'),
  z
    .object({
      type: z.literal('agent.presets'),
      includeInactive: z
        .boolean()
        .optional()
        .describe('Lists the agents the user turned off as well.'),
    })
    .strict()
    .describe(
      'The agents and launch modes an agent launch can name, and which of them agents may start.'
    ),
  z
    .object({
      type: z.literal('agent.launch'),
      destination: z
        .enum(['tab', 'workspace'])
        .describe('A new tab in the workspace, or a new workspace with exactly one agent.'),
      project: z
        .string()
        .min(1)
        .max(MAX_PROJECT_NAME_LEN)
        .optional()
        .describe(
          'The project of a new workspace, by id or name; required outside every workspace.'
        ),
      preset: z
        .string()
        .min(1)
        .max(MAX_NAME_LEN)
        .optional()
        .describe('The agent, by an id or name `agent.presets` lists.'),
      mode: z
        .string()
        .min(1)
        .max(MAX_NAME_LEN)
        .optional()
        .describe("The agent's launch mode, by an id or name `agent.presets` lists."),
      effort: z
        .string()
        .min(1)
        .max(MAX_NAME_LEN)
        .optional()
        .describe("The agent's effort level, by an id or name `agent.presets` lists."),
      prompt: z.string().max(MAX_PROMPT_LEN).optional(),
      name: z.string().min(1).max(MAX_NAME_LEN).optional().describe("A new workspace's name."),
      description: z
        .string()
        .max(MAX_DESCRIPTION_LEN)
        .optional()
        .describe("A new workspace's description."),
      branch: z
        .string()
        .min(1)
        .max(MAX_BRANCH_LEN)
        .optional()
        .describe("A new workspace's branch."),
      fromCurrentBranch: z
        .boolean()
        .optional()
        .describe(
          "Starts a new workspace's worktree from the calling workspace's branch, not the project's base branch."
        ),
    })
    .strict()
    .describe('Launches an AI coding agent in a new tab or a new workspace.'),
  z
    .object({
      type: z.literal('workspace.title'),
      title: z.string().trim().min(1).max(MAX_NAME_LEN),
      description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
    })
    .strict()
    .describe('Sets the title and description shown for the workspace.'),
  z
    .object({
      type: z.literal('workspace.snooze'),
      until: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .optional()
        .describe(
          "A duration such as 30m, 2h or 1d, a time such as 17:30, or a date and time such as 2026-10-21 09:00, in the desktop's time zone."
        ),
      untilNotified: z
        .literal(true)
        .optional()
        .describe("Also ends the snooze at the workspace's next notification."),
    })
    .strict()
    .refine((operation) => operation.until !== undefined || operation.untilNotified, {
      message: 'A snooze needs until or untilNotified.',
    })
    .describe('Snoozes the workspace until a time or its next notification.'),
  z
    .object({ type: z.literal('workspace.wake') })
    .strict()
    .describe("Ends the workspace's snooze now."),
  z
    .object({ type: z.literal('workspace.list'), includeTrashed: z.boolean().optional() })
    .strict()
    .describe(
      "The workspaces a call can name with `workspace`; through an SSH host's tunnel, only that host's."
    ),
  z
    .object({ type: z.literal('tag.list') })
    .strict()
    .describe("The user's tags, in their list's order."),
  z
    .object({
      type: z.literal('workspace.tag'),
      tag: workspaceTagNameSchema.optional(),
      tooltip: z.string().trim().min(1).max(MAX_WORKSPACE_TAG_TOOLTIP).optional(),
      tone: z.enum(WORKSPACE_TAG_TONES).optional(),
      // Saved with the tag as the base64 data URL a status item's icon is.
      icon: statusIconSchema.transform((icon) => statusIconDataUrl(icon) as string).optional(),
      spinner: z.boolean().optional(),
      ifTag: workspaceTagNameSchema
        .optional()
        .describe('Changes only a workspace that has this tag.'),
    })
    .strict()
    .describe(
      "Gives the workspace its one tag, or takes it off without `tag`. A tag the user's list lacks joins it with `tone`, `icon` and `spinner`."
    ),
  z
    .object({
      type: z.literal('workspace.notify'),
      title: z
        .string()
        .trim()
        .min(1)
        .max(MAX_NAME_LEN)
        .describe(
          "Shown on the workspace's sidebar card, or `badge`'s shorter text with the title on hover."
        ),
      body: z
        .string()
        .max(MAX_NOTIFICATION_BODY_LEN)
        .optional()
        .describe("Replaces the card's secondary line while the notification is active."),
      kind: z
        .enum(NOTIFY_KINDS)
        .optional()
        .describe('Sets its glyph, color and how long it stays: generic by default.'),
      color: z
        .string()
        .min(1)
        .max(MAX_COLOR_LEN)
        .optional()
        .describe(
          'success, warning, error, info, attention or muted, which follow the theme, or any CSS color.'
        ),
      badge: z
        .string()
        .trim()
        .min(1)
        .max(MAX_NOTIFICATION_BADGE_LEN)
        .optional()
        .describe('Shorter text for the card, with the title on hover.'),
      // Shown as a status item's icon is, as an image, where SVG runs no scripts.
      icon: statusIconSchema
        .transform((icon) => statusIconDataUrl(icon) as string)
        .optional()
        .describe("An image in place of the kind's glyph."),
      iconColor: statusItemColorSchema
        .optional()
        .describe("Shows only the icon's shape, in a color."),
      source: z
        .string()
        .min(1)
        .max(MAX_NOTIFICATION_SOURCE_LEN)
        .optional()
        .describe(
          'What sent it, as agent hooks name their agent: agent by default, and hook from a hook, whose own notifications set off no hooks.'
        ),
    })
    .strict()
    .describe(
      'Shows a notification on the workspace, as `komla notify <title>` does: its badge on the sidebar card and its color on the pane border.'
    ),
  z
    .object({ type: z.literal('workspace.trash') })
    .strict()
    .describe(
      "Moves the calling workspace to the Trash once the agent's turn ends. It takes no `workspace`."
    ),
  z
    .object({
      type: z.enum(['workspace.link', 'workspace.unlink']),
      workspaceIds: z.array(z.string().min(1).max(MAX_ID_LEN)).min(1).max(100),
    })
    .strict()
    .describe('Links or unlinks the workspace and each of the others, both ways.'),
  z
    .object({
      type: z.literal('folder.open'),
      path: z.string().min(1).max(4096).describe('An absolute path on this computer.'),
    })
    .strict()
    .describe('Opens a folder on this computer in Komla, as its own workspace.'),
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
      popover: statusPopoverHtmlSchema
        .optional()
        .describe('A sandboxed HTML page for the popover.'),
      popoverMarkdown: statusPopoverMarkdownSchema
        .optional()
        .describe('Plain Markdown for the popover, in place of a page.'),
    })
    .strict()
    .describe(
      'Shows a status bar item while the workspace is open. It takes `text`, which may carry terminal colors, or `segments`.'
    ),
  z
    .object({
      type: z.literal('status.clear'),
      id: statusItemIdSchema.optional(),
    })
    .strict()
    .describe("Clears one of the workspace's status bar items, or all of them without `id`."),
  z
    .object({
      type: z.literal('status.refresh'),
      id: statusItemIdSchema,
    })
    .strict()
    .describe('Runs a status-items.json item again now.'),
  z
    .object({
      type: z.literal('preview.open'),
      url: z.string().min(1).max(MAX_PATH_LEN).optional(),
      open: z.boolean().optional(),
    })
    .strict()
    .describe("Opens a page, or the workspace's server without `url`, in the workspace's browser."),
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
    .strict()
    .describe(
      "Lists a virtual desktop under the workspace's globe button, and opens it where `viewer` asks."
    ),
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

/** The variant of a union whose `type` takes T, even one that two types share. */
type VariantOf<U, T> = U extends { type: infer V } ? (T extends V ? U : never) : never;
type Flat<T> = { [K in keyof T]: T[K] };
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type OperationsMatchingSchema = {
  [T in KomlaOperation['type']]: Equal<
    Flat<VariantOf<z.output<typeof komlaOperationSchema>, T>>,
    Flat<VariantOf<KomlaOperation, T>>
  >;
};
/**
 * The `KomlaOperation` union reads exactly as this schema parses requests, field for field, so
 * neither drifts; a mismatch names the operation.
 */
export const OPERATION_TYPE_MATCHES_SCHEMA: {
  [
    T in keyof OperationsMatchingSchema as OperationsMatchingSchema[T] extends true ? never : T
  ]: 'differs from its schema';
} = {};
