import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import http from 'http';
import { join } from 'path';

import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { z } from 'zod';

import { IPC } from '../../shared/constants/ipc-channels';
import { isMcpToolEnabled } from '../../shared/constants/mcp-built-in-tools';
import { agentLaunchWorkspacePlacement } from '../../shared/lib/agent-environment';
import { isBrowserUrl, MAX_BROWSER_URL_LENGTH } from '../../shared/lib/browser-tabs';
import {
  MAX_VIRTUAL_DESKTOP_NAME_LENGTH,
  MAX_VNC_PASSWORD_LENGTH,
} from '../../shared/lib/virtual-desktops';
import {
  MAX_WORKSPACE_TAG_LENGTH,
  MAX_WORKSPACE_TAG_TOOLTIP,
  WORKSPACE_TAG_TONES,
} from '../../shared/lib/workspace-tags';
import {
  ACTION_SSH_EXECUTION_LOCATIONS,
  isSshWorkspace,
  SETTINGS_FILE_RESOURCES,
  SETUP_DESTINATIONS,
  SETUP_TRIGGERS,
  VIRTUAL_DESKTOP_VIEWERS,
} from '../../shared/types';
import {
  MAX_STATUS_ICON_BYTES,
  MAX_STATUS_ITEM_ICONS,
  MAX_STATUS_ITEM_SEGMENTS,
  MAX_STATUS_ITEM_TEXT,
  MAX_STATUS_ITEM_TOOLTIP,
  MAX_STATUS_POPOVER_MARKDOWN,
  isStatusItemColor,
  STATUS_ITEM_ID_PATTERN,
  STATUS_ITEM_TONES,
} from '../../shared/types/status-items';
import { BRANCH_NAME_PATTERN } from '../ipc/validation/primitives';
import { komlaNodeCmd, getNotifyHelper } from '../lib/komla-cli';
import { resolveKomlaRequestRoute } from '../lib/komla-request-route';
import { isLocalHostHeader } from '../lib/local-host-header';
import { createLogger } from '../lib/logger';
import { statusIconDataUrl } from '../lib/status-icon';
import { visibleStatusText } from '../lib/status-item-text';

import { actionService } from './action.service';
import { agentPresetService } from './agent-preset.service';
import {
  automationAgentProblem,
  automationHostProblem,
  automationService,
} from './automation.service';
import { configService } from './config.service';
import { customizationService } from './customization.service';
import { KomlaOperationError, komlaOperationService } from './komla-operation.service';
import {
  notificationTargetResolutionService,
  type NotificationTargetResolution,
  type NotificationTargetWarning,
} from './notification-target-resolution.service';
import { generateNotifyScript } from './notify-script';
import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { createSettingsFiles } from './settings-files';
import {
  SettingsManagementError,
  SettingsManagementService,
  type SettingsApprovalRequest,
  type SettingsRequestContext,
} from './settings-management.service';
import { shortcutsService } from './shortcuts.service';
import { sshHostService } from './ssh-host.service';
import { telemetryService } from './telemetry.service';
import { settlesBeforeShowing } from './terminal-attention/notification-lifecycle';
import { windowService } from './window.service';
import {
  workspaceCwdResolutionService,
  type WorkspaceCwdResolutionContext,
  type WorkspaceCwdResolution,
  type WorkspaceProjectCwdResolution,
} from './workspace-cwd-resolution.service';
import { workspaceStatusService } from './workspace-status.service';
import { workspaceService } from './workspace.service';

import type { KomlaOperation, KomlaOperationContext } from './komla-operation.service';
import type { McpBuiltInToolName } from '../../shared/constants/mcp-built-in-tools';
import type {
  Project,
  Workspace,
  WorkspaceAttentionKind,
  SettingsApprovalDecision,
  SettingsApprovalPrompt,
  SettingsFileResource,
  AppearanceSettings,
} from '../../shared/types';
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

const SKILL_FILE_ALIASES: Readonly<Record<string, string>> = {
  // `komla skill komla` prints the Komla skill, for agents that install it themselves.
  'komla.md': 'komla/SKILL.md',
};
const logger = createLogger('HttpServerService');

// Length caps are generous — they exist to bound abuse, not to constrain real payloads.
const MAX_PATH_LEN = 4096;
const MAX_NAME_LEN = 256;
const MAX_BRANCH_LEN = 256;
const MAX_DESCRIPTION_LEN = 2048;
const MAX_PROJECT_NAME_LEN = 256;
const MAX_SOURCE_LEN = 64;
const MAX_LEVEL_LEN = 64;
const MAX_COLOR_LEN = 256;
// Room for a short label on the sidebar pill; the title carries the rest.
const MAX_NOTIFICATION_BADGE_LEN = 64;
const MAX_MESSAGE_LEN = 64 * 1024;
const MAX_PROMPT_LEN = 64 * 1024;
const MAX_ID_LEN = 128;
// The Remote Companion reports more changed paths than this as unknown.
const MAX_CHANGED_PATHS = 500;

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

const createWorkspacePayloadSchema = z
  .object({
    project: z.string().min(1).max(MAX_PROJECT_NAME_LEN).optional(),
    cwd: z.string().min(1).max(MAX_PATH_LEN).optional(),
    branchName: z.string().min(1).max(MAX_BRANCH_LEN).optional(),
    name: z.string().min(1).max(MAX_NAME_LEN).optional(),
    description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
    initialPrompt: z.string().max(MAX_PROMPT_LEN).optional(),
  })
  .strip();

const statusItemIdSchema = z
  .string()
  .regex(
    STATUS_ITEM_ID_PATTERN,
    'Status item ids are up to 40 letters, digits, dots, dashes and underscores.'
  );
const statusItemColorSchema = z
  .string()
  .trim()
  .refine(
    isStatusItemColor,
    'Status item colors are success, warning, error, info, muted, foreground or a hex color such as #e5c07b.'
  );
const statusPopoverSchema = z.string().trim().min(1).max(MAX_STATUS_POPOVER_MARKDOWN);
// Terminal colors in an item's text don't count toward its length.
const MAX_STATUS_ITEM_RAW_TEXT = 1_000;
const fitsStatusItem = (text: string) => {
  const length = visibleStatusText(text).length;
  return length > 0 && length <= MAX_STATUS_ITEM_TEXT;
};
const statusItemTextSchema = z
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
const statusIconSchema = z
  .string()
  .max(MAX_STATUS_ICON_INPUT)
  .refine(
    (icon) => statusIconDataUrl(icon) !== undefined,
    `Status item icons are SVG markup or an image data URL (SVG, PNG, WebP, GIF or JPEG) of at most ${MAX_STATUS_ICON_BYTES / 1024} KB.`
  );
const workspaceTagNameSchema = z.string().trim().min(1).max(MAX_WORKSPACE_TAG_LENGTH);
const statusItemSegmentsSchema = z
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
      popover: statusPopoverSchema.optional(),
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

type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

const settingsActionSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LEN).optional(),
    title: z.string().min(1).max(MAX_NAME_LEN),
    content: z.string().min(1).max(MAX_PROMPT_LEN),
    type: z.enum(['prompt', 'command']),
    projectCount: z.number().int().positive().optional(),
    presetId: z.string().min(1).max(MAX_ID_LEN).optional(),
    launchModeId: z.string().min(1).max(MAX_ID_LEN).optional(),
    sshExecutionLocation: z.enum(ACTION_SSH_EXECUTION_LOCATIONS).optional(),
    background: z.boolean().optional(),
  })
  .strict();

const settingsActionsPayloadSchema = z.object({ actions: z.array(settingsActionSchema) }).strict();

const settingsSetupStepSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LEN).optional(),
    name: z.string().min(1).max(MAX_NAME_LEN),
    command: z.string().max(MAX_PROMPT_LEN),
    placement: z.enum(['background', 'tab', 'split-right', 'split-bottom']),
    actionId: z.string().min(1).max(MAX_ID_LEN).optional(),
    agent: z
      .object({
        presetId: z.string().min(1).max(MAX_ID_LEN).optional(),
        launchModeId: z.string().min(1).max(MAX_ID_LEN).optional(),
      })
      .strict()
      .optional(),
    destination: z.enum(SETUP_DESTINATIONS).optional(),
    trigger: z.enum(SETUP_TRIGGERS).optional(),
  })
  .strict();

// appearanceProblems checks customPalette's fields and colors.
const settingsAppearancePayloadSchema = z
  .object({
    palette: z.string().min(1).max(MAX_ID_LEN),
    customPalette: z.record(z.string(), z.unknown()).optional(),
    accent: z.string().max(MAX_COLOR_LEN),
    borderRadius: z.number(),
  })
  .strict();

// Each settings file checks its own content, so problems name its fields.
const settingsFilePayloadSchema = z.record(z.string(), z.unknown());

/** What the confirmation names for each settings file. */
const SETTINGS_FILE_TARGETS: Record<SettingsFileResource, string> = {
  'status-items': 'Status bar items',
  hooks: 'Hooks',
  shortcuts: 'Keyboard shortcuts',
  terminal: 'Terminal settings',
  agents: 'Agents',
};

const settingsAutomationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('ssh'), hostId: z.string().min(1).max(MAX_ID_LEN) }).strict(),
]);

const settingsAutomationsPayloadSchema = z
  .object({
    automations: z.array(
      z
        .object({
          id: z.string().min(1).max(MAX_ID_LEN).optional(),
          name: z.string().min(1).max(200),
          prompt: z.string().min(1).max(32_000),
          target: settingsAutomationTargetSchema,
          presetId: z.string().min(1).max(MAX_ID_LEN).optional(),
          launchModeId: z.string().min(1).max(MAX_ID_LEN).optional(),
          startBranch: z
            .union([z.literal(''), z.string().max(1024).regex(BRANCH_NAME_PATTERN)])
            .optional(),
          // Shown by settings get; accepted so its output can be sent back unchanged.
          agentName: z.string().max(MAX_NAME_LEN).optional(),
          schedule: z
            .object({
              cron: z.string().min(1).max(256),
              timeZone: z.string().min(1).max(64).optional(),
            })
            .strict(),
          enabled: z.boolean().optional(),
          missedRunGraceMinutes: z.number().int().nonnegative().optional(),
        })
        .strict()
    ),
  })
  .strict();

const settingsWorkspaceSetupPayloadSchema = z
  .object({
    setupSteps: z.array(settingsSetupStepSchema),
    agentPlacement: z.enum(['tab', 'split-right', 'split-bottom']),
    agentLayoutOrder: z.number().int().nonnegative(),
    trashCleanupScript: z.string().max(MAX_PROMPT_LEN),
  })
  .strict();

const sshWorkspaceStatusPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  kind: z.literal('repository-snapshot'),
  workspaceId: z.string().min(1).max(MAX_ID_LEN),
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  sequence: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  stateHash: z.string().min(1).max(128),
  currentBranch: z.string().max(MAX_BRANCH_LEN).optional(),
  targetBranch: z.string().max(MAX_BRANCH_LEN).optional(),
  defaultBranch: z.string().max(MAX_BRANCH_LEN).optional(),
  statusB64: z.string().optional(),
  numstatB64: z.string().optional(),
  statusTooLarge: z.boolean().optional(),
  workingTreeChanged: z.boolean().optional(),
  fileListHash: z.string().min(1).max(128).optional(),
  changedPaths: z.array(z.string().min(1).max(MAX_PATH_LEN)).max(MAX_CHANGED_PATHS).optional(),
  aheadTargetBranch: z.number().int().nonnegative().optional(),
  behindTargetBranch: z.number().int().nonnegative().optional(),
  unpushedCommits: z.number().int().nonnegative().optional(),
  behindRemote: z.number().int().nonnegative().optional(),
  hasRemote: z.boolean().optional(),
  hasOriginRemote: z.boolean().optional(),
  targetBranchHasRemote: z.boolean().optional(),
  targetBranchAheadRemote: z.number().int().nonnegative().optional(),
  targetBranchBehindRemote: z.number().int().nonnegative().optional(),
});

type CreateWorkspacePayload = z.infer<typeof createWorkspacePayloadSchema>;

type SettingsValidationFile = 'projects' | 'actions';

interface SettingsValidationResult {
  ok: boolean;
  files: Record<
    SettingsValidationFile,
    {
      ok: boolean;
      count?: number;
      warning?: string;
      error?: string;
    }
  >;
}

function stripUtf8Bom(data: string): { value: string; hadBom: boolean } {
  if (data.charCodeAt(0) === 0xfeff) {
    return { value: data.slice(1), hadBom: true };
  }
  return { value: data, hadBom: false };
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number';
}

function hasBoolean(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'boolean';
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function hasOptionalNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'number';
}

function hasOptionalNullableNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] == null || typeof value[key] === 'number';
}

function hasOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean';
}

function hasOptionalStringArray(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  return (
    field === undefined || (Array.isArray(field) && field.every((item) => typeof item === 'string'))
  );
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function hasOptionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[]
): boolean {
  return value[key] === undefined || isOneOf(value[key], allowed);
}

function isValidSetupStep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  const agent = step['agent'];
  return (
    hasString(step, 'id') &&
    hasString(step, 'name') &&
    hasString(step, 'command') &&
    isOneOf(step['placement'], ['background', 'tab', 'split-right', 'split-bottom']) &&
    hasOptionalString(step, 'actionId') &&
    (agent === undefined ||
      (typeof agent === 'object' &&
        agent !== null &&
        !Array.isArray(agent) &&
        hasOptionalString(agent as Record<string, unknown>, 'presetId') &&
        hasOptionalString(agent as Record<string, unknown>, 'launchModeId'))) &&
    hasOptionalEnum(step, 'destination', SETUP_DESTINATIONS) &&
    hasOptionalEnum(step, 'trigger', SETUP_TRIGGERS)
  );
}

function hasOptionalSetupSteps(value: Record<string, unknown>): boolean {
  const setupSteps = value['setupSteps'];
  return (
    setupSteps === undefined ||
    (Array.isArray(setupSteps) && setupSteps.every((step) => isValidSetupStep(step)))
  );
}

function findDuplicateIdIndex(entries: Array<Record<string, unknown>>): number {
  const seen = new Set<string>();
  return entries.findIndex((entry) => {
    const id = entry['id'];
    if (typeof id !== 'string') return false;
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

function isValidProjectEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    hasString(project, 'id') &&
    hasString(project, 'name') &&
    hasString(project, 'repositoryPath') &&
    hasString(project, 'defaultBranchPrefix') &&
    hasNumber(project, 'createdAt') &&
    hasNumber(project, 'order') &&
    hasBoolean(project, 'managed') &&
    hasOptionalString(project, 'color') &&
    hasOptionalSetupSteps(project) &&
    hasOptionalString(project, 'baseBranch') &&
    hasOptionalEnum(project, 'agentPlacement', ['tab', 'split-right', 'split-bottom']) &&
    hasOptionalNumber(project, 'agentLayoutOrder') &&
    hasOptionalString(project, 'trashCleanupScript') &&
    hasOptionalString(project, 'managedRepoPath') &&
    hasOptionalEnum(project, 'aheadTargetAction', [
      'auto-default',
      'auto',
      'unconfigured',
      'merge',
      'pr',
      'disabled',
      'agent-prompt',
    ]) &&
    hasOptionalBoolean(project, 'autoPushAfterMerge') &&
    hasOptionalString(project, 'aheadTargetActionId') &&
    hasOptionalEnum(project, 'autoMainBranchAction', ['merge', 'pr', 'disabled', 'agent-prompt']) &&
    hasOptionalEnum(project, 'autoOtherBranchAction', [
      'merge',
      'pr',
      'disabled',
      'agent-prompt',
    ]) &&
    hasOptionalString(project, 'autoMainActionId') &&
    hasOptionalString(project, 'autoOtherActionId') &&
    hasOptionalEnum(project, 'behindTargetAction', ['auto', 'rebase', 'merge'])
  );
}

function isValidActionEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const action = value as Record<string, unknown>;
  const type = action['type'];
  return (
    hasString(action, 'id') &&
    hasString(action, 'title') &&
    hasString(action, 'content') &&
    (type === undefined || type === 'prompt' || type === 'command') &&
    hasOptionalStringArray(action, 'projectIds') &&
    hasOptionalNullableNumber(action, 'lastUsedAt') &&
    hasOptionalString(action, 'lastUserInput') &&
    hasOptionalString(action, 'presetId') &&
    hasOptionalString(action, 'launchModeId') &&
    hasOptionalEnum(action, 'sshExecutionLocation', ACTION_SSH_EXECUTION_LOCATIONS) &&
    hasOptionalBoolean(action, 'background')
  );
}

interface CreateWorkspaceResult {
  workspace: {
    id: string;
    name: string;
    branchName?: string;
    workingDirectory?: string;
    provisioning: boolean;
  };
}

interface CreateWorkspaceError {
  error: string;
  statusCode: number;
  availableProjects?: string[];
}

class HttpServerService {
  private server: http.Server | null = null;
  private preferredPort = 52863;
  private actualPort: number | null = null;
  private readonly MAX_BODY_BYTES = 1024 * 1024; // 1 MB
  private maxPortRetries = 10;
  private portFilePath = join(getKomlaBasePath(), 'port');
  private notifyHelper = getNotifyHelper();
  private startedCallbacks: Array<() => void> = [];
  private portWaiters: Array<{
    resolve: (port: number) => void;
    reject: (error: Error) => void;
  }> = [];
  private startError: Error | null = null;
  private portChangeEvent: { oldPort: number; newPort: number } | null = null;
  private pendingTerminalHookAcceptances = new Map<string, Promise<Workspace | undefined>>();
  private settingsService: SettingsManagementService | null = null;
  // Refused hosts already logged, so a page retrying in a loop logs each host once.
  private readonly refusedHosts = new Set<string>();
  private recentSettingsFeedback = new Map<string, number>();
  private pendingSettingsApprovals = new Map<
    string,
    {
      senderId: number;
      window: BrowserWindow;
      prompt: SettingsApprovalPrompt;
      finish: (decision: SettingsApprovalDecision) => void;
    }
  >();

  start(preferredPort?: number): void {
    if (this.server) {
      return;
    }

    // Write helper files that hook commands depend on: the Electron binary
    // path (node-path / komla-node.cmd) and the shared notification script
    // (notify.js). These persist across restarts and are refreshed each launch.
    this.writeHookHelperFiles();

    if (preferredPort !== undefined) {
      this.preferredPort = preferredPort;
    }

    this.startError = null;
    this.server = http.createServer(this.createRequestHandler());
    this.tryListen(this.preferredPort);
  }

  private createRequestHandler(): http.RequestListener {
    return (req, res) => {
      // Read config per-request so toggles take effect without restart.
      const config = configService.get();
      if (this.refuseForeignHost(req, res)) return;
      if (this.refuseWebPage(req, res)) return;
      const route = this.resolveTerminalScopedRoute(req.url ?? '');
      if (!route) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const { url, terminalId } = route;
      const { disableMcpServer, disableNotificationEndpoint } = config;
      const spawnAgentDisabled = !isMcpToolEnabled('spawn_agent_in_new_workspace', config);

      const pathname = this.parseRequestUrl(url)?.pathname;
      if (pathname?.startsWith('/settings/') || pathname?.startsWith('/api/v1/settings/')) {
        this.handleSettingsManagementRequest(req, res, url, terminalId);
      } else if (req.method === 'GET' && (url === '/api/v1/health' || url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if ((req.method === 'GET' || req.method === 'POST') && url === '/validate-settings') {
        this.handleSettingsValidationRequest(res);
      } else if (req.method === 'POST' && (url === '/api/v1/notify' || url === '/notify')) {
        if (disableNotificationEndpoint) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        this.handleNotifyRequest(req, res);
      } else if (req.method === 'POST' && url === '/api/v1/ssh-workspace-status') {
        this.handleSshWorkspaceStatusRequest(req, res);
      } else if (
        req.method === 'POST' &&
        (url === '/api/v1/workspace' || url === '/api/workspace')
      ) {
        // REST sibling of the spawn_agent_in_new_workspace MCP tool — gate it
        // on the same per-tool toggle so disabling the tool actually disables
        // the capability, not just the MCP registration.
        if (disableMcpServer || spawnAgentDisabled) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        this.handleCreateWorkspaceRequest(req, res);
      } else if (req.method === 'POST' && pathname === '/api/v1/commands') {
        this.handleKomlaCommandRequest(req, res, url, terminalId);
      } else if (url === '/api/v1/cli/mcp') {
        if (disableMcpServer) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        // The installed `komla` executable exposes this adapter over stdio.
        // Typed CLI commands use /api/v1/commands and remain independent.
        this.handleMcpRequest(req, res, {
          terminalId: terminalId ?? this.singleHeader(req.headers['x-komla-terminal-id']),
          workspaceId: this.singleHeader(req.headers['x-komla-workspace-id']),
          sshHostId: this.singleHeader(req.headers['x-komla-ssh-host-id']),
        });
      } else if (url === '/api/v1/mcp' || url === '/mcp') {
        if (disableMcpServer) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        this.handleMcpRequest(req, res, {
          sshHostId: this.singleHeader(req.headers['x-komla-ssh-host-id']),
        });
      } else if (req.method === 'GET' && url.startsWith('/skills/')) {
        this.handleSkillFileRequest(url, res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    };
  }

  /**
   * Turns away web pages that point their own domain at 127.0.0.1 (DNS
   * rebinding), such as a site open in Komla's browser.
   */
  private refuseForeignHost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (isLocalHostHeader(req.headers.host)) return false;
    const host = req.headers.host ?? '';
    if (this.refusedHosts.size < 100 && !this.refusedHosts.has(host)) {
      this.refusedHosts.add(host);
      logger.warn('Refused a request whose Host is not this machine', {
        host: host.slice(0, 100),
      });
    }
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  /**
   * Turns away a request a browser sends for a web page, such as a site open
   * in Komla's browser or the user's own. The Host check misses pages reaching
   * Komla through an SSH host's gateway, which rewrites Host, and same-origin
   * or simple requests get no CORS preflight to stop them. Agent hooks, the
   * companion, `komla` and agents' MCP clients never send these headers.
   */
  private refuseWebPage(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const site = this.singleHeader(req.headers['sec-fetch-site']);
    if (req.headers.origin === undefined && (site === undefined || site === 'none')) return false;
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  private parseRequestUrl(url: string): URL | null {
    try {
      return new URL(url, 'http://127.0.0.1');
    } catch {
      return null;
    }
  }

  private handleKomlaCommandRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    scopedTerminalId?: string
  ): void {
    void (async () => {
      if (!this.isJsonRequest(req)) {
        this.writeKomlaCommandError(
          res,
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Komla command requests must use application/json.'
        );
        return;
      }
      const url = this.parseRequestUrl(rawUrl);
      if (!url) {
        this.writeKomlaCommandError(res, 400, 'INVALID_URL', 'Invalid request URL.');
        return;
      }
      const headerTerminalId = this.singleHeader(req.headers['x-komla-terminal-id']);
      if (scopedTerminalId && headerTerminalId && scopedTerminalId !== headerTerminalId) {
        this.writeKomlaCommandError(
          res,
          409,
          'WORKSPACE_CONTEXT_CONFLICT',
          'Terminal URL and header identities do not match.'
        );
        return;
      }
      try {
        const body = await this.readBody(req);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          this.writeKomlaCommandError(res, 400, 'INVALID_JSON', 'Request body must be JSON.');
          return;
        }
        const parsed = komlaOperationSchema.safeParse(raw);
        if (!parsed.success) {
          this.writeKomlaCommandError(res, 400, 'INVALID_OPERATION', 'Invalid Komla operation.', {
            issues: parsed.error.issues,
          });
          return;
        }
        const sshHostId = this.singleHeader(req.headers['x-komla-ssh-host-id']);
        const targetWorkspaceId = this.singleHeader(req.headers['x-komla-target-workspace-id']);
        // `--workspace` names the workspace to act on, in place of the calling terminal's.
        const result = await komlaOperationService.execute(
          targetWorkspaceId
            ? { workspaceId: targetWorkspaceId, sshHostId, targeted: true }
            : {
                terminalId: scopedTerminalId ?? headerTerminalId,
                workspaceId: this.singleHeader(req.headers['x-komla-workspace-id']),
                sshHostId,
                cwd: url.searchParams.get('cwd') ?? undefined,
              },
          parsed.data
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof KomlaOperationError) {
          this.writeKomlaCommandError(
            res,
            error.statusCode,
            error.code,
            error.message,
            error.details
          );
          return;
        }
        logger.error('Komla operation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.writeKomlaCommandError(
          res,
          500,
          'OPERATION_FAILED',
          'Komla could not complete the operation.'
        );
      }
    })();
  }

  private writeKomlaCommandError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
    );
  }

  private resolveTerminalScopedRoute(rawUrl: string): { url: string; terminalId?: string } | null {
    const resolved = resolveKomlaRequestRoute(rawUrl);
    if (!resolved) return null;
    if (!resolved.terminalId) return { url: rawUrl };
    return { url: `${resolved.route}${resolved.url.search}`, terminalId: resolved.terminalId };
  }

  private isJsonRequest(req: http.IncomingMessage): boolean {
    const contentType = this.singleHeader(req.headers['content-type']);
    return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
  }

  private getSettingsManagementService(): SettingsManagementService {
    if (this.settingsService) return this.settingsService;
    this.settingsService = new SettingsManagementService({
      actions: actionService,
      projects: projectService,
      workspaces: workspaceService,
      resolveProjectByCwd: (cwd, sshHostId) => {
        const result = workspaceCwdResolutionService.findProjectByCwd(cwd, {
          workspaces: workspaceService
            .list()
            .filter(
              (workspace) =>
                !sshHostId ||
                (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === sshHostId)
            ),
          getProject: (id) => projectService.get(id),
          komlaBasePath: getKomlaBasePath(),
        });
        return {
          project: result.project,
          workspace: result.sourceWorkspace,
          error: result.error,
        };
      },
      presets: agentPresetService,
      appearance: {
        get: () => customizationService.getTheme(),
        systemIsDark: () => nativeTheme.shouldUseDarkColors,
        set: (settings) => customizationService.setAppearance(settings),
      },
      environmentConfiguration: () => {
        const config = configService.get();
        return {
          lastWorkspaceEnvironment: config.lastWorkspaceEnvironment,
          defaultSshWorkspaceMode: config.defaultSshWorkspaceMode,
          sshHosts: sshHostService
            .list()
            .filter((host) => !host.setupPending)
            .map(({ id }) => ({ id })),
        };
      },
      files: createSettingsFiles({
        settingsPath: join(getKomlaBasePath(), 'settings'),
        shortcuts: {
          get: () => shortcutsService.getConfig().shortcuts,
          update: (shortcuts) => shortcutsService.updateConfig({ shortcuts }),
        },
        terminal: {
          get: () => customizationService.getTerminal(),
          update: (updates) => customizationService.updateTerminal(updates),
        },
        presets: agentPresetService,
      }),
      automations: {
        list: () => automationService.list(),
        listCurrent: (options) => automationService.listCurrent(options),
        hostProblem: (project) => automationHostProblem(project),
        agentProblem: (target, presetId, launchModeId) =>
          automationAgentProblem(target, presetId, launchModeId),
        save: (params) => automationService.save(params),
        setEnabled: (target, id, enabled) => automationService.setEnabled(target, id, enabled),
        delete: (target, id) => automationService.delete(target, id),
        hostName: (hostId) => sshHostService.get(hostId)?.name,
        timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      approve: (request, signal) => this.approveSettingsChange(request, signal),
      feedback: (message, workspace) => this.sendSettingsFeedback(message, workspace),
    });
    return this.settingsService;
  }

  private selectSettingsWindow(request: SettingsApprovalRequest): BrowserWindow | undefined {
    const workspaceWindow = request.workspace?.windowId
      ? windowService.getWindow(request.workspace.windowId)
      : undefined;
    return workspaceWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  }

  private async approveSettingsChange(
    request: SettingsApprovalRequest,
    signal?: AbortSignal
  ): Promise<boolean> {
    const window = this.selectSettingsWindow(request);
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
      target:
        request.resource in SETTINGS_FILE_TARGETS
          ? SETTINGS_FILE_TARGETS[request.resource as SettingsFileResource]
          : request.resource === 'appearance'
            ? 'Appearance'
            : request.resource === 'workspace-setup'
              ? `${request.project?.name ?? 'Project'} Workspace Setup`
              : request.resource === 'automations'
                ? `${request.project?.name ?? 'Project'} Automations`
                : request.project
                  ? `${request.project.name} Quick Commands`
                  : 'Global Quick Commands',
      changes: request.changes,
      ...((request.multiProjectWarning ?? request.warning)
        ? { warning: request.multiProjectWarning ?? request.warning }
        : {}),
      ...(request.preview ? { preview: request.preview } : {}),
    };
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (decision: SettingsApprovalDecision): void => {
        if (settled) return;
        settled = true;
        this.pendingSettingsApprovals.delete(prompt.id);
        signal?.removeEventListener('abort', onAbort);
        window.webContents.removeListener('destroyed', onDestroyed);
        window.webContents.removeListener('did-start-navigation', onNavigation);
        window.webContents.removeListener('render-process-gone', onRendererGone);
        if (!window.webContents.isDestroyed()) {
          this.sendToSettingsWindow(window, IPC.SETTINGS_APPROVAL_DISMISSED, prompt.id);
        }
        resolve(decision === 'apply');
      };
      const onAbort = (): void => finish('cancel');
      const onDestroyed = (): void => finish('cancel');
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) finish('cancel');
      };
      const onRendererGone = (): void => finish('cancel');
      this.pendingSettingsApprovals.set(prompt.id, {
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
        finish('cancel');
        return;
      }
      if (!this.sendToSettingsWindow(window, IPC.SETTINGS_APPROVAL_REQUESTED, prompt)) {
        finish('cancel');
        return;
      }
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

  private sendToSettingsWindow(
    window: BrowserWindow,
    channel: string,
    ...args: unknown[]
  ): boolean {
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

  resolveSettingsApproval(
    id: string,
    decision: SettingsApprovalDecision,
    senderId: number
  ): boolean {
    const pending = this.pendingSettingsApprovals.get(id);
    if (!pending || pending.senderId !== senderId) return false;
    pending.finish(decision);
    return true;
  }

  requestPendingSettingsApproval(senderId: number): boolean {
    const pending = Array.from(this.pendingSettingsApprovals.values()).find(
      (approval) => approval.senderId === senderId
    );
    if (!pending) return false;
    return this.sendToSettingsWindow(
      pending.window,
      IPC.SETTINGS_APPROVAL_REQUESTED,
      pending.prompt
    );
  }

  private sendSettingsFeedback(message: string, workspace?: Workspace): void {
    const request = { workspace, changes: [], resource: 'actions' as const };
    const window = this.selectSettingsWindow(request);
    if (!window) return;
    const key = `${window.id}:${message}`;
    const now = Date.now();
    if (now - (this.recentSettingsFeedback.get(key) ?? 0) < 2_000) return;
    this.recentSettingsFeedback.set(key, now);
    window.webContents.send(IPC.SETTINGS_FEEDBACK, message);
    setTimeout(() => this.recentSettingsFeedback.delete(key), 2_000).unref();
  }

  private resolveSettingsTarget(context: SettingsRequestContext): {
    workspace?: Workspace;
    project?: Project;
  } {
    const terminalWorkspace = context.terminalId
      ? workspaceService.findWorkspaceByTerminalId(context.terminalId)
      : undefined;
    const explicitWorkspace = context.workspaceId
      ? workspaceService.get(context.workspaceId)
      : undefined;
    const identifiedWorkspace = terminalWorkspace ?? explicitWorkspace;
    if (identifiedWorkspace) {
      return {
        workspace: identifiedWorkspace,
        project: identifiedWorkspace.projectId
          ? projectService.get(identifiedWorkspace.projectId)
          : undefined,
      };
    }
    if (!context.cwd) return {};
    const resolved = workspaceCwdResolutionService.findProjectByCwd(context.cwd, {
      workspaces: workspaceService
        .list()
        .filter(
          (workspace) =>
            !context.sshHostId ||
            (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === context.sshHostId)
        ),
      getProject: (id) => projectService.get(id),
      komlaBasePath: getKomlaBasePath(),
    });
    return { workspace: resolved.sourceWorkspace, project: resolved.project };
  }

  private logSettingsOutcome(
    resource: SettingsApprovalRequest['resource'],
    scope: 'global' | 'current-project' | undefined,
    context: SettingsRequestContext,
    outcome: string,
    errorCode?: string
  ): void {
    const { project } = this.resolveSettingsTarget(context);
    logger.info('Settings management request', {
      resource,
      ...(scope ? { scope } : {}),
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
      outcome,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private handleSettingsManagementRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    scopedTerminalId?: string
  ): void {
    void (async () => {
      const url = this.parseRequestUrl(rawUrl);
      if (!url) return this.writeSettingsError(res, 400, 'INVALID_URL', 'Invalid request URL.');
      if (req.method !== 'GET' && req.method !== 'PUT') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, PUT' });
        res.end(
          JSON.stringify({
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: 'Only GET and PUT are supported.',
              details: [],
            },
          })
        );
        return;
      }
      const pathname = url.pathname.startsWith('/api/v1/settings/')
        ? url.pathname.slice('/api/v1'.length)
        : url.pathname;
      const isActions = pathname === '/settings/actions';
      const isSetup = pathname === '/settings/workspace-setup';
      const isAppearance = pathname === '/settings/appearance';
      const isAutomations = pathname === '/settings/automations';
      const fileResource = SETTINGS_FILE_RESOURCES.find(
        (candidate) => pathname === `/settings/${candidate}`
      );
      if (!isActions && !isSetup && !isAppearance && !isAutomations && !fileResource) {
        this.writeSettingsError(res, 404, 'NOT_FOUND', 'Not found.');
        return;
      }
      const scope = isActions ? url.searchParams.get('scope') : null;
      if (isActions && scope !== 'global' && scope !== 'current-project') {
        this.writeSettingsError(
          res,
          400,
          'INVALID_SCOPE',
          'scope must be global or current-project.'
        );
        return;
      }
      const headerTerminalId = this.singleHeader(req.headers['x-komla-terminal-id']);
      if (scopedTerminalId && headerTerminalId && scopedTerminalId !== headerTerminalId) {
        this.writeSettingsError(
          res,
          409,
          'PROJECT_CONTEXT_CONFLICT',
          'Terminal URL and header identities do not match.'
        );
        return;
      }
      const context: SettingsRequestContext = {
        terminalId: scopedTerminalId ?? headerTerminalId,
        workspaceId: this.singleHeader(req.headers['x-komla-workspace-id']),
        sshHostId: this.singleHeader(req.headers['x-komla-ssh-host-id']),
        cwd: url.searchParams.get('cwd') ?? undefined,
      };
      const service = this.getSettingsManagementService();
      const resource =
        fileResource ??
        (isActions
          ? 'actions'
          : isSetup
            ? 'workspace-setup'
            : isAutomations
              ? 'automations'
              : 'appearance');
      const settingsScope = isActions ? (scope as 'global' | 'current-project') : undefined;
      try {
        if (req.method === 'GET') {
          const read = fileResource
            ? service.readSettingsFile(fileResource)
            : isActions
              ? service.readActions(context, scope as 'global' | 'current-project')
              : isSetup
                ? service.readWorkspaceSetup(context)
                : isAutomations
                  ? await service.readAutomations(context)
                  : service.readAppearance();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(read));
          this.logSettingsOutcome(resource, settingsScope, context, 'read');
          return;
        }
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            this.singleHeader(req.headers['content-type']) ?? ''
          )
        ) {
          this.writeSettingsError(
            res,
            400,
            'INVALID_CONTENT_TYPE',
            'Content-Type must be application/json.'
          );
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(await this.readBody(req));
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'Request body too large';
          this.writeSettingsError(
            res,
            tooLarge ? 413 : 400,
            tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
            tooLarge ? 'Request body too large.' : 'Malformed JSON.'
          );
          return;
        }
        const controller = new AbortController();
        req.socket?.setKeepAlive?.(true);
        res.on('close', () => {
          if (!res.writableEnded) controller.abort();
        });
        const parsed = fileResource
          ? settingsFilePayloadSchema.safeParse(raw)
          : isActions
            ? settingsActionsPayloadSchema.safeParse(raw)
            : isSetup
              ? settingsWorkspaceSetupPayloadSchema.safeParse(raw)
              : isAutomations
                ? settingsAutomationsPayloadSchema.safeParse(raw)
                : settingsAppearancePayloadSchema.safeParse(raw);
        if (!parsed.success) {
          this.writeSettingsError(
            res,
            400,
            'INVALID_REQUEST',
            'Invalid request body.',
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            }))
          );
          return;
        }
        const result = fileResource
          ? await service.proposeSettingsFile(
              context,
              fileResource,
              parsed.data as Record<string, unknown>,
              controller.signal
            )
          : isActions
            ? await service.proposeActions(
                context,
                scope as 'global' | 'current-project',
                parsed.data as z.infer<typeof settingsActionsPayloadSchema>,
                controller.signal
              )
            : isSetup
              ? await service.proposeWorkspaceSetup(
                  context,
                  parsed.data as z.infer<typeof settingsWorkspaceSetupPayloadSchema>,
                  controller.signal
                )
              : isAutomations
                ? await service.proposeAutomations(
                    context,
                    parsed.data as z.infer<typeof settingsAutomationsPayloadSchema>,
                    controller.signal
                  )
                : await service.proposeAppearance(
                    context,
                    parsed.data as AppearanceSettings,
                    controller.signal
                  );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ status: result.status, applied: result.applied, ...result.value })
        );
        this.logSettingsOutcome(resource, settingsScope, context, result.status);
      } catch (error) {
        const managed = error instanceof SettingsManagementError;
        const status = managed ? error.status : 500;
        const code = managed ? error.code : 'INTERNAL_ERROR';
        const message = managed ? error.message : 'Failed to update settings.';
        this.logSettingsOutcome(resource, settingsScope, context, 'rejected', code);
        if (!managed) logger.error('Settings management request failed:', error);
        this.writeSettingsError(res, status, code, message, managed ? error.details : []);
      }
    })();
  }

  private singleHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private writeSettingsError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    details: unknown[] = []
  ): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message, details } }));
  }

  private tryListen(port: number, attempt: number = 0): void {
    if (!this.server) return;

    // A failed listen() leaves its callback on 'listening', so the next port's success runs it too.
    let failed = false;
    const bindErrorHandler = (error: NodeJS.ErrnoException) => {
      failed = true;
      if (
        (error.code === 'EADDRINUSE' || error.code === 'EACCES') &&
        attempt < this.maxPortRetries
      ) {
        const nextPort = this.preferredPort + attempt + 1;
        logger.info(`Port ${port} unavailable (${error.code}), trying ${nextPort}...`);
        this.tryListen(nextPort, attempt + 1);
      } else {
        logger.error('Notification server error:', error);
        this.startError = error;
        for (const waiter of this.portWaiters) {
          waiter.reject(error);
        }
        this.portWaiters = [];
      }
    };

    this.server.once('error', bindErrorHandler);

    this.server.listen(port, '127.0.0.1', () => {
      if (failed) return;
      // Remove the bind-time error listener so it doesn't misfire on runtime errors
      this.server?.removeListener('error', bindErrorHandler);
      this.actualPort = port;
      process.env.KOMLA_API_URL = `http://127.0.0.1:${port}`;
      this.writePortFile(port);
      for (const waiter of this.portWaiters) {
        waiter.resolve(port);
      }
      this.portWaiters = [];
      for (const callback of this.startedCallbacks) {
        callback();
      }
      // One-shot — drop references so pre-bind callers aren't retained.
      this.startedCallbacks = [];

      if (port !== this.preferredPort) {
        // Persist fallback port so future boots use it. Always — even on first
        // run — so the chosen port becomes sticky from boot 2 onwards.
        configService.update({ notificationPort: port });
        // Only surface the "port changed" banner when there was a prior known
        // port to deviate from. On a first run (no config.json on disk), the
        // port we end up on is just our initial assignment, not a change —
        // and no MCP integrations can be pointing at a stale port yet.
        if (configService.wasLoadedFromDisk()) {
          this.portChangeEvent = { oldPort: this.preferredPort, newPort: port };
          const windows = BrowserWindow.getAllWindows();
          for (const window of windows) {
            window.webContents.send(IPC.SERVER_PORT_CHANGED, this.portChangeEvent);
          }
        }
        logger.info(
          `Notification server listening on fallback port ${port} (preferred ${this.preferredPort} was in use)`
        );
      } else {
        logger.info(`Notification server listening on port ${port}`);
      }
    });
  }

  stop(): void {
    for (const approval of Array.from(this.pendingSettingsApprovals.values())) {
      approval.finish('cancel');
    }
    workspaceService.attention.hooksStopped();
    const error = new Error('HTTP server stopped before a port became available');
    for (const waiter of this.portWaiters) {
      waiter.reject(error);
    }
    this.portWaiters = [];
    if (this.server) {
      this.server.close();
      this.server = null;
      if (
        this.actualPort !== null &&
        process.env.KOMLA_API_URL === `http://127.0.0.1:${this.actualPort}`
      ) {
        delete process.env.KOMLA_API_URL;
      }
      this.actualPort = null;
      this.startError = null;
      this.removePortFile();
    }
  }

  getActualPort(): number | null {
    return this.actualPort;
  }

  waitForActualPort(): Promise<number> {
    if (this.actualPort !== null) {
      return Promise.resolve(this.actualPort);
    }
    if (this.startError) {
      return Promise.reject(this.startError);
    }
    return new Promise((resolve, reject) => {
      this.portWaiters.push({ resolve, reject });
    });
  }

  private writePortFile(port: number): void {
    try {
      writeFileSync(this.portFilePath, String(port));
    } catch (error) {
      logger.warn('Failed to write port file:', error);
    }
  }

  private removePortFile(): void {
    try {
      unlinkSync(this.portFilePath);
    } catch {
      // File may already be gone
    }
  }

  private writeHookHelperFiles(): void {
    try {
      writeFileSync(this.notifyHelper.nodePathFile, process.execPath);
      if (process.platform === 'win32') {
        writeFileSync(this.notifyHelper.nodeCommand, komlaNodeCmd(process.execPath));
      } else {
        // Shell wrapper: tries node first (sandbox-friendly), falls back to
        // the Electron binary for users without node installed.
        writeFileSync(
          this.notifyHelper.nodeCommand,
          `#!/bin/sh\nif command -v node >/dev/null 2>&1; then\n  exec node "$@"\nelse\n  exec env ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "$@"\nfi\n`,
          { mode: 0o755 }
        );
      }
      writeFileSync(this.notifyHelper.script, generateNotifyScript(this.portFilePath), {
        mode: 0o755,
      });
    } catch (error) {
      logger.warn('Failed to write hook helper files (node-path, notify.js):', error);
    }
  }

  private readBody(req: http.IncomingMessage, maxBytes = this.MAX_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytesReceived = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        bytesReceived += chunk.length;
        if (bytesReceived > maxBytes) {
          tooLarge = true;
          reject(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => {
        if (!tooLarge) resolve(body);
      });
      req.on('error', (err) => {
        if (!tooLarge) reject(err);
      });
    });
  }

  private writeValidationError(res: http.ServerResponse, error: z.ZodError): void {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.') || '<root>',
      message: issue.message,
    }));
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid payload', details }));
  }

  private validateJsonSettingsFile(
    file: SettingsValidationFile,
    validate: (parsed: unknown) => number
  ): SettingsValidationResult['files'][SettingsValidationFile] {
    const filePath = join(getKomlaBasePath(), 'settings', `${file}.json`);

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { value, hadBom } = stripUtf8Bom(raw);
      const parsed: unknown = JSON.parse(value);
      const count = validate(parsed);
      return {
        ok: true,
        count,
        ...(hadBom
          ? {
              warning:
                'File starts with a UTF-8 BOM; Komla can read it, but agents should not write one.',
            }
          : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
      };
    }
  }

  private validateProjectsSettings(parsed: unknown): number {
    const projects =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['projects']
        : undefined;

    if (!Array.isArray(projects)) {
      throw new Error('projects.json must contain a projects array');
    }

    const invalidIndex = projects.findIndex((project) => !isValidProjectEntry(project));
    if (invalidIndex !== -1) {
      throw new Error(`projects.json has an invalid project entry at index ${invalidIndex}`);
    }

    const duplicateIndex = findDuplicateIdIndex(projects as Array<Record<string, unknown>>);
    if (duplicateIndex !== -1) {
      throw new Error(`projects.json has a duplicate project id at index ${duplicateIndex}`);
    }

    return projects.length;
  }

  private validateActionsSettings(parsed: unknown): number {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('actions.json must contain an actions array');
    }

    const actions = (parsed as Record<string, unknown>)['actions'];
    if (!Array.isArray(actions)) {
      throw new Error('actions.json must contain an actions array');
    }

    const invalidIndex = actions.findIndex((action) => !isValidActionEntry(action));
    if (invalidIndex !== -1) {
      throw new Error(`actions.json has an invalid action entry at index ${invalidIndex}`);
    }

    const duplicateIndex = findDuplicateIdIndex(actions as Array<Record<string, unknown>>);
    if (duplicateIndex !== -1) {
      throw new Error(`actions.json has a duplicate action id at index ${duplicateIndex}`);
    }

    return actions.length;
  }

  private handleSettingsValidationRequest(res: http.ServerResponse): void {
    const result: SettingsValidationResult = {
      ok: true,
      files: {
        projects: this.validateJsonSettingsFile('projects', (parsed) =>
          this.validateProjectsSettings(parsed)
        ),
        actions: this.validateJsonSettingsFile('actions', (parsed) =>
          this.validateActionsSettings(parsed)
        ),
      },
    };
    result.ok = Object.values(result.files).every((file) => file.ok);

    res.writeHead(result.ok ? 200 : 422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private handleNotifyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    void (async () => {
      let raw: unknown;
      try {
        const body = await this.readBody(req);
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
        this.writeValidationError(res, parsed.error);
        return;
      }
      const payload = parsed.data;
      const sshHostId = this.singleHeader(req.headers['x-komla-ssh-host-id']);

      try {
        const target = this.resolveNotificationTarget(payload, sshHostId);
        // A copy is a hook for a terminal another device is attached to. It can't be matched by
        // folder.
        if (payload.copy && (!target.workspace || !target.terminalId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No matching terminal found' }));
          return;
        }
        const acceptance = this.acceptNotificationDurably(payload, target);
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

  private async acceptNotificationDurably(
    payload: NotificationPayload,
    target: NotificationTargetResolution
  ): Promise<Workspace | undefined> {
    const deliveryKey =
      payload.deliveryId && target.terminalId
        ? `${target.terminalId}\0${payload.deliveryId}`
        : undefined;
    const pendingAcceptance = deliveryKey
      ? this.pendingTerminalHookAcceptances.get(deliveryKey)
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
      this.logNotificationTargetWarnings(target.warnings);
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

    this.pendingTerminalHookAcceptances.set(deliveryKey, acceptance);
    try {
      return await acceptance;
    } finally {
      if (this.pendingTerminalHookAcceptances.get(deliveryKey) === acceptance) {
        this.pendingTerminalHookAcceptances.delete(deliveryKey);
      }
    }
  }

  private handleSshWorkspaceStatusRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    void (async () => {
      let raw: unknown;
      try {
        const body = await this.readBody(req, 16 * 1024 * 1024);
        try {
          raw = JSON.parse(body);
        } catch {
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

      const parsed = sshWorkspaceStatusPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        this.writeValidationError(res, parsed.error);
        return;
      }

      try {
        const payload = parsed.data;
        const forwardedHostHeader = req.headers?.['x-komla-ssh-host-id'];
        const forwardedHostId = Array.isArray(forwardedHostHeader)
          ? forwardedHostHeader[0]
          : forwardedHostHeader;
        const receipt = await workspaceStatusService.change({
          kind: 'snapshot-observed',
          snapshot: {
            source: { kind: 'remote-companion', sequence: payload.sequence },
            workspaceId: payload.workspaceId,
            ...(forwardedHostId ? { hostId: forwardedHostId } : {}),
            cwd: payload.cwd,
            observedAt: payload.observedAt,
            stateHash: payload.stateHash,
            statusB64: payload.statusB64,
            numstatB64: payload.numstatB64,
            statusTooLarge: payload.statusTooLarge,
            workingTreeChanged: payload.workingTreeChanged,
            fileListHash: payload.fileListHash,
            changedPaths: payload.changedPaths,
            branch: {
              currentBranch: payload.currentBranch,
              targetBranch: payload.targetBranch,
              defaultBranch: payload.defaultBranch,
              aheadTargetBranch: payload.aheadTargetBranch,
              behindTargetBranch: payload.behindTargetBranch,
              hasRemote: payload.hasRemote,
              hasOriginRemote: payload.hasOriginRemote,
              unpushedCommits: payload.unpushedCommits,
              behindRemote: payload.behindRemote,
              targetBranchHasRemote: payload.targetBranchHasRemote,
              targetBranchAheadRemote: payload.targetBranchAheadRemote,
              targetBranchBehindRemote: payload.targetBranchBehindRemote,
            },
          },
        });
        if (receipt.disposition === 'rejected') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No matching SSH workspace found', cwd: payload.cwd }));
          return;
        }
        if (receipt.disposition === 'retry') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(receipt));
          return;
        }
        res.writeHead(204);
        res.end();
      } catch (error) {
        if (!res.headersSent) {
          logger.error('Failed to handle SSH workspace status:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to handle SSH workspace status' }));
        }
      }
    })();
  }

  private async createWorkspaceInternal(
    payload: CreateWorkspacePayload
  ): Promise<CreateWorkspaceResult | CreateWorkspaceError> {
    let project: ReturnType<typeof projectService.get> | undefined;
    let sourceWorkspace: Workspace | undefined;
    if (payload.cwd) {
      // Derive project from workspaces matching the cwd. Unlike tools that
      // mutate a workspace, spawning a new workspace only needs an unambiguous
      // project.
      const resolution = this.findWorkspaceProjectByCwd(payload.cwd);
      if (resolution.error && resolution.error !== 'No matching workspace found') {
        return {
          error: resolution.error,
          statusCode: 400,
        };
      }
      project = resolution.project;
      sourceWorkspace = resolution.sourceWorkspace;
    }

    if (!project && payload.project) {
      // Fallback for REST API: find project by name (case-insensitive)
      const projects = projectService.list();
      project = projects.find((p) => p.name.toLowerCase() === payload.project!.toLowerCase());
      if (!project) {
        return {
          error: `Project "${payload.project}" not found`,
          statusCode: 404,
          availableProjects: projects.map((p) => p.name),
        };
      }
    }

    const sshSourceBackend =
      sourceWorkspace && isSshWorkspace(sourceWorkspace) ? sourceWorkspace.backend : undefined;
    const isSourceSsh = sshSourceBackend !== undefined;
    if (!project && !isSourceSsh) {
      const projects = projectService.list();
      return {
        error: payload.cwd
          ? `No matching workspace found for cwd: ${payload.cwd}`
          : 'Missing required field: cwd',
        statusCode: 400,
        availableProjects: projects.map((p) => p.name),
      };
    }

    // Create workspace in the same window as the caller when we can identify it
    // from cwd. Fall back to the main window for project-only REST calls.
    const targetWindowId = sourceWorkspace?.windowId ?? windowService.getMainWindowId();
    // Always defer provisioning so the workspace appears instantly in the UI.
    // Worktree creation (the slow part) happens in the background.
    const deferBranchNaming = true;
    const mcpConfig = configService.get();
    const commonCreateParams = {
      ...(sshSourceBackend
        ? {
            location: {
              kind: 'ssh' as const,
              hostId: sshSourceBackend.hostId,
              gitUrl: sshSourceBackend.gitUrl,
              sourceBackend: sshSourceBackend,
            },
            ...(project ? { projectId: project.id } : {}),
          }
        : { projectId: project!.id }),
      customName: payload.name,
      customDescription: payload.description,
      initialPrompt: payload.initialPrompt,
      windowId: targetWindowId ?? undefined,
      presetId: mcpConfig.agentLaunchDefaultPresetId ?? undefined,
      launchModeId: mcpConfig.agentLaunchDefaultLaunchModeId ?? undefined,
      ...agentLaunchWorkspacePlacement(
        mcpConfig,
        {
          mode: project?.kind === 'directory' ? 'directory' : 'worktree',
          sourceIsSsh: isSourceSsh,
        },
        (hostId) => sshHostService.isReady(hostId)
      ),
      skipRecordUsage: true,
    };
    const workspace =
      project?.kind === 'directory'
        ? await workspaceService.create({
            ...commonCreateParams,
            mode: 'directory',
          })
        : await workspaceService.create({
            ...commonCreateParams,
            mode: 'worktree',
            branchName: payload.branchName,
            deferBranchNaming,
          });

    // Notify renderers through the readiness-aware queue so provisioning placeholders
    // are still delivered while a window is mounting or reloading.
    for (const windowId of windowService.getAllWindowIds()) {
      windowService.sendWhenReady(windowId, IPC.WORKSPACE_CREATED, workspace);
    }

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        ...(workspace.branchName ? { branchName: workspace.branchName } : {}),
        ...(workspace.workingDirectory ? { workingDirectory: workspace.workingDirectory } : {}),
        provisioning: workspace.provisioning || false,
      },
    };
  }

  private handleCreateWorkspaceRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // This route takes a bare project name and places the workspace by the
    // launch defaults. Remote agents launch through the CLI or MCP instead,
    // which keep new workspaces on their host. The SSH gateway already blocks
    // this route; refusing the header here is defense in depth.
    if (this.singleHeader(req.headers['x-komla-ssh-host-id'])) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not available from an SSH host' }));
      return;
    }
    // Requiring JSON keeps web pages from sending this as a simple cross-origin form post.
    if (!this.isJsonRequest(req)) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
      return;
    }
    void (async () => {
      let raw: unknown;
      try {
        const body = await this.readBody(req);
        try {
          raw = JSON.parse(body);
        } catch {
          // Scoped narrowly so a SyntaxError thrown deep inside workspace
          // creation isn't misclassified as malformed input.
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

      const parsed = createWorkspacePayloadSchema.safeParse(raw);
      if (!parsed.success) {
        this.writeValidationError(res, parsed.error);
        return;
      }

      try {
        const result = await this.createWorkspaceInternal(parsed.data);

        if ('error' in result) {
          res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: result.error,
              ...(result.availableProjects ? { availableProjects: result.availableProjects } : {}),
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, workspace: result.workspace }));
      } catch (error) {
        if (!res.headersSent) {
          // Log full detail server-side; return a stable generic body since this
          // endpoint is unauthenticated and callable from any local agent.
          logger.error('Failed to create workspace:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to create workspace' }));
        }
      }
    })();
  }

  private findUnambiguousWorkspaceByCwd(cwd: string, sshHostId?: string): WorkspaceCwdResolution {
    return workspaceCwdResolutionService.resolveWorkspaceByCwd(
      cwd,
      this.getWorkspaceCwdContext(sshHostId),
      { rejectAmbiguousMatches: true }
    );
  }

  private findWorkspaceProjectByCwd(cwd: string): WorkspaceProjectCwdResolution {
    return workspaceCwdResolutionService.findProjectByCwd(cwd, this.getWorkspaceCwdContext());
  }

  private resolveWorkspaceByCwd(
    cwd: string,
    options: { rejectAmbiguousMatches?: boolean } = {}
  ): WorkspaceCwdResolution {
    return workspaceCwdResolutionService.resolveWorkspaceByCwd(
      cwd,
      this.getWorkspaceCwdContext(),
      options
    );
  }

  private getWorkspaceCwdContext(sshHostId?: string): WorkspaceCwdResolutionContext {
    return {
      workspaces: workspaceService
        .list()
        .filter((workspace) => this.workspaceMatchesSshHost(workspace, sshHostId)),
      getProject: (projectId: string): Project | undefined => projectService.get(projectId),
      komlaBasePath: getKomlaBasePath(),
    };
  }

  private workspaceMatchesSshHost(workspace: Workspace, sshHostId?: string): boolean {
    return !sshHostId || (isSshWorkspace(workspace) && workspace.backend.hostId === sshHostId);
  }

  private resolveNotificationTarget(payload: NotificationPayload, sshHostId?: string) {
    return notificationTargetResolutionService.resolve(payload, {
      findWorkspaceByTerminalId: (terminalId) => {
        const workspace = workspaceService.findWorkspaceByTerminalId(terminalId);
        return workspace && this.workspaceMatchesSshHost(workspace, sshHostId)
          ? workspace
          : undefined;
      },
      getWorkspace: (workspaceId) => {
        const workspace = workspaceService.get(workspaceId);
        return workspace && this.workspaceMatchesSshHost(workspace, sshHostId)
          ? workspace
          : undefined;
      },
      resolveWorkspaceByCwd: (cwd) => this.findUnambiguousWorkspaceByCwd(cwd, sshHostId),
    });
  }

  private logNotificationTargetWarnings(warnings: NotificationTargetWarning[]): void {
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

  private createMcpServer(requestContext: KomlaOperationContext = {}): McpServer {
    const server = new McpServer({
      name: 'komla',
      version: '1.0.0',
    });

    const config = configService.get();
    // Drives both registration and the settings UI. Each `name` arg must appear
    // in MCP_BUILT_IN_TOOLS — TypeScript enforces this via `McpBuiltInToolName`.
    // `Schema` and the matching `ToolCallback<Schema>` are forwarded to
    // server.tool unchanged so the schema/handler pairing keeps type-checking.
    const registerTool = <Schema extends z.ZodRawShape>(
      name: McpBuiltInToolName,
      description: string,
      schema: Schema,
      handler: ToolCallback<Schema>
    ): void => {
      if (!isMcpToolEnabled(name, config)) {
        logger.debug(`MCP tool "${name}" is disabled in settings; skipping registration.`);
        return;
      }
      // Record the first MCP tool invocation — fires on call (before the
      // handler), so even a failed attempt counts as "the user tried MCP".
      const trackedHandler = (
        params: ShapeOutput<Schema>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
      ): CallToolResult | Promise<CallToolResult> => {
        telemetryService.sendIntegrationMilestone('mcp:tool-used', { tool: name });
        return handler(params, extra);
      };
      server.tool(name, description, schema, trackedHandler as ToolCallback<Schema>);
    };

    registerTool(
      'spawn_agent_in_new_workspace',
      "Spawn an AI coding agent in a new isolated Komla workspace: its own git branch and working directory, branched from the project's base branch (e.g. main) or, with fromCurrentBranch, from your current branch. The user switches to its workspace and steers the agent directly. Use only when the user asks for an agent in a new workspace or worktree. This is a separate interactive agent, not a substitute for your own built-in subagents.",
      {
        cwd: z
          .string()
          .describe(
            'Current working directory of the calling agent. Used to derive the project automatically.'
          ),
        name: z.string().optional().describe('Concise label for the current work, 2-3 words.'),
        description: z.string().optional().describe('One sentence summary.'),
        branchName: z
          .string()
          .optional()
          .describe(
            'Descriptive branch name for what is being worked on, e.g. "fix-login-redirect" or "add-search-api".'
          ),
        initialPrompt: z.string().optional().describe('Initial prompt to pass to the AI agent.'),
        fromCurrentBranch: z
          .boolean()
          .optional()
          .describe(
            "Branch from your workspace's current branch instead of the project's base branch, so the new agent builds on its committed work. Uncommitted changes are not copied. Use only when the user wants the new work to build on this branch."
          ),
      },
      async (params) => {
        const compatibilityProject = (params as typeof params & { project?: string }).project;
        return this.executeMcpOperation(
          { ...requestContext, cwd: params.cwd },
          {
            type: 'agent.launch',
            destination: 'workspace',
            ...(compatibilityProject ? { project: compatibilityProject } : {}),
            name: params.name,
            description: params.description,
            branch: params.branchName,
            prompt: params.initialPrompt,
            ...(params.fromCurrentBranch ? { fromCurrentBranch: true } : {}),
          },
          (result) => {
            const destination = result.destination as Record<string, unknown>;
            const lines = [
              result.state === 'provisioning' && !destination.branch
                ? 'Workspace created — generating branch name in the background. The agent will start automatically once ready.'
                : 'Agent spawned in new workspace.',
            ];
            if (typeof destination.branch === 'string') {
              lines.push(`Branch: ${destination.branch}`);
            }
            if (typeof destination.branchedFrom === 'string') {
              lines.push(`Branched from: ${destination.branchedFrom} (committed work only)`);
            }
            if (typeof destination.path === 'string') {
              lines.push(`Path: ${destination.path}`);
            }
            return lines.join('\n');
          }
        );
      }
    );

    registerTool(
      'set_workspace_title',
      'Set the title shown for this workspace in the user\'s list of parallel workstreams. Use the overall project task (e.g. "Stripe webhook retries"), not the current action ("Review Diff", "Fix Bug").',
      {
        cwd: z.string().describe('Current working directory of the agent process.'),
        title: z.string().trim().min(1).describe('2-3 word label for the overall task.'),
        description: z
          .string()
          .trim()
          .min(1)
          .describe('One sentence summary of the task.')
          .optional(),
      },
      async ({ cwd, title, description }) => {
        return this.executeMcpOperation(
          { ...requestContext, cwd },
          { type: 'workspace.title', title, description },
          () => 'Workspace title updated.'
        );
      }
    );

    registerTool(
      'set_status_item',
      "Show a short status in Komla's status bar while this workspace is open, such as test results, a build or deploy state, or the pull request for this work. Setting an id again replaces its item; leave out text to clear it.",
      {
        cwd: z.string().describe('Current working directory of the calling agent.'),
        id: statusItemIdSchema.describe('Short stable id, such as "tests" or "pr".'),
        text: statusItemTextSchema
          .optional()
          .describe(
            'What the item shows, a few words such as "142/150 tests". Omit it and segments to clear the item.'
          ),
        segments: statusItemSegmentsSchema
          .optional()
          .describe(
            'The text in parts with colors of their own, and icons anywhere in it, in place of text, such as [{"icon":"<svg …>"},{"text":" 142/150 tests","color":"success"}]. Text parts take color and bold; an icon part with a color shows its shape in that color.'
          ),
        icon: statusIconSchema
          .optional()
          .describe(
            'An icon or logo before the text: SVG markup or an image data URL (SVG, PNG, WebP, GIF or JPEG) of at most 32 KB. Put icons elsewhere with segments.'
          ),
        iconColor: statusItemColorSchema
          .optional()
          .describe(
            "Shows icon's shape in this color, such as foreground for a one-color logo that follows the theme; without it, icon keeps its own colors."
          ),
        tone: z
          .enum(STATUS_ITEM_TONES)
          .optional()
          .describe('Theme color for the dot before the item: success, warning, error or info.'),
        color: statusItemColorSchema
          .optional()
          .describe(
            "Color of the item's text, or of the segments without a color of their own: success, warning, error, info, muted, foreground or a hex color such as #e5c07b."
          ),
        tooltip: z
          .string()
          .trim()
          .min(1)
          .max(MAX_STATUS_ITEM_TOOLTIP)
          .optional()
          .describe('Longer detail shown on hover.'),
        link: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('HTTP(S) URL the item opens when clicked, such as the pull request.'),
        popover: statusPopoverSchema
          .optional()
          .describe(
            'Markdown shown in a popover when the item is clicked, such as a summary with links; link then shows as a button below it.'
          ),
      },
      async ({ cwd, id, text, segments, icon, iconColor, tone, color, tooltip, link, popover }) => {
        const clear = text === undefined && segments === undefined;
        return this.executeMcpOperation(
          { ...requestContext, cwd },
          clear
            ? { type: 'status.clear', id }
            : {
                type: 'status.set',
                id,
                text,
                segments,
                icon,
                iconColor,
                tone,
                color,
                tooltip,
                link,
                popover,
              },
          () => (clear ? `Status item ${id} cleared.` : `Status item ${id} set.`)
        );
      }
    );

    registerTool(
      'spawn_agent_new_tab',
      'Spawn a new AI agent in a new tab within the current Komla workspace, sharing its files. Use only when the user asks for a new agent in a tab or in the current workspace. This is a separate interactive agent, not a substitute for your own built-in subagents.',
      {
        cwd: z.string().describe('Current working directory of the calling agent.'),
        prompt: z.string().optional().describe('Prompt to pass to the new AI agent.'),
      },
      async ({ cwd, prompt }) => {
        return this.executeMcpOperation(
          { ...requestContext, cwd },
          { type: 'agent.launch', destination: 'tab', prompt },
          () => 'Agent spawned successfully.'
        );
      }
    );

    registerTool(
      'open_browser_preview',
      "Open Komla's browser for this workspace: its browser pane, or one in a tab of its own when it has none. Use it to show the user a page, such as a dev server you started; any http(s) URL works. URL is optional; with one, it opens in a new tab of that browser (or the tab already at that URL); without one, Komla shows the browser as it is, or a new one that detects a local dev URL.",
      {
        cwd: z.string().describe('Current working directory of the calling agent.'),
        url: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional HTTP(S) URL to show in a tab of the browser.'),
      },
      async ({ cwd, url }) => {
        return this.executeMcpOperation(
          { ...requestContext, cwd },
          { type: 'preview.open', url },
          () => (url !== undefined ? `Browser preview opened at ${url}` : 'Browser preview opened.')
        );
      }
    );

    return server;
  }

  private async executeMcpOperation(
    context: KomlaOperationContext,
    operation: KomlaOperation,
    render: (result: Record<string, unknown>) => string
  ): Promise<CallToolResult> {
    try {
      const result = (await komlaOperationService.execute(context, operation)) as Record<
        string,
        unknown
      >;
      return { content: [{ type: 'text' as const, text: render(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const availableProjects =
        error instanceof KomlaOperationError && Array.isArray(error.details?.availableProjects)
          ? `\nAvailable projects: ${error.details.availableProjects
              .map((project) =>
                project && typeof project === 'object' && 'name' in project
                  ? String(project.name)
                  : String(project)
              )
              .join(', ')}`
          : '';
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}${availableProjects}` }],
        isError: true,
      };
    }
  }

  private handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: KomlaOperationContext = {}
  ): void {
    const mcpServer = this.createMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Connect server to transport, then delegate request handling
    mcpServer
      .connect(transport)
      .then(() => {
        return transport.handleRequest(req, res);
      })
      .catch((error) => {
        logger.error('MCP request failed:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
  }

  // Serves the loose skill instruction files from <komlaDir>/skills/ so agents
  // can fetch them over loopback HTTP. Agents reliably fetch URLs but may fail
  // to read absolute paths outside their workspace sandbox (e.g. Gemini CLI).
  private handleSkillFileRequest(url: string, res: http.ServerResponse): void {
    let name: string;
    try {
      name = decodeURIComponent((url.split('?')[0] ?? '').slice('/skills/'.length));
    } catch {
      // Malformed percent-encoding — treat as not found rather than letting the
      // URIError escape the request handler as an uncaught exception.
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // Flat markdown filename only — the regex rejects path separators, so there
    // is no way to traverse out of the skills directory.
    if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const filename = SKILL_FILE_ALIASES[name] ?? name;
    try {
      const content = readFileSync(join(getKomlaBasePath(), 'skills', filename), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  getPort(): number {
    return this.actualPort ?? this.preferredPort;
  }

  onStarted(callback: () => void): void {
    if (this.actualPort !== null) {
      callback();
      return;
    }
    this.startedCallbacks.push(callback);
  }

  getPortChangeEvent(): { oldPort: number; newPort: number } | null {
    return this.portChangeEvent;
  }
}

export const httpServerService = new HttpServerService();
