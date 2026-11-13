import { z } from 'zod';

import {
  MAX_BROWSER_TAB_TITLE_LENGTH,
  MAX_BROWSER_TABS,
  MAX_BROWSER_URL_LENGTH,
  isBrowserUrl,
} from '../../lib/browser-tabs';
import { NOTE_NAME_PATTERN } from '../../lib/notes';
import { MAX_RECENT_LINKS } from '../../lib/recent-links';
import { MAX_SAVED_LAYOUT_PANES } from '../../lib/saved-layout';
import { WORKSPACE_MARKER_KEY_PATTERN } from '../../lib/workspace-markers';
import { MAX_WORKSPACE_TAG_LENGTH, MAX_WORKSPACE_TAG_TOOLTIP } from '../../lib/workspace-tags';
import { STATUS_ITEM_ID_PATTERN } from '../../types/status-items';
import { MAX_PROMPT_ATTACHMENTS } from '../../types/workspace';

import {
  idSchema,
  layoutHintSchema,
  nonEmptyStringSchema,
  optionalBooleanSchema,
  safePathSchema,
  terminalStatusSchema,
  untrimmedSafePathSchema,
  workspaceModeSchema,
} from './primitives';

import type { WorkspaceLayoutNode } from '../../types/workspace';

const recentLinkSchema = z
  .object({
    url: z.string().max(MAX_BROWSER_URL_LENGTH).refine(isBrowserUrl, {
      message: 'must be an http(s) URL',
    }),
    openedAt: z.number().int().optional(),
    printedAt: z.number().int().optional(),
  })
  .strip();

// Tabs load in a sandboxed native view, never in the renderer, so any web
// page is allowed. An empty URL is a new tab without a page.
const browserTabSchema = z
  .object({
    id: idSchema,
    url: z
      .string()
      .max(MAX_BROWSER_URL_LENGTH)
      .refine((value) => value === '' || isBrowserUrl(value), {
        message: 'must be empty or an http(s) URL',
      }),
    urlExecutionLocation: z.enum(['workspace', 'local-copy']).optional(),
    title: z.string().max(MAX_BROWSER_TAB_TITLE_LENGTH).optional(),
  })
  .strip();

const workspaceEnvironmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strip(),
  z.object({ kind: z.literal('ssh'), hostId: idSchema }).strip(),
]);

export const stagePromptAttachmentsArgsSchema = z.tuple([
  z.array(untrimmedSafePathSchema).max(MAX_PROMPT_ATTACHMENTS),
]);

export const createWorkspaceParamsSchema = z
  .object({
    name: z.string().optional(),
    customName: z.string().optional(),
    mode: workspaceModeSchema,
    branchName: z.string().optional(),
    projectId: idSchema.optional(),
    useExactBranchName: z.boolean().optional(),
    autoResolveBranchConflicts: z.boolean().optional(),
    directoryPath: safePathSchema.optional(),
    scratch: z.boolean().optional(),
    categoryId: idSchema.optional(),
    initialPrompt: z.string().optional(),
    attachments: z.array(untrimmedSafePathSchema).max(MAX_PROMPT_ATTACHMENTS).optional(),
    launchModeId: idSchema.optional(),
    reasoningLevelId: idSchema.nullable().optional(),
    modelId: idSchema.nullable().optional(),
    initialCommand: z.string().optional(),
    baseBranch: z.string().optional(),
    startFromOrigin: z.boolean().optional(),
    baseBranchOnHost: z.boolean().optional(),
    sourceWorkspaceId: idSchema.optional(),
    windowId: idSchema.optional(),
    deferBranchNaming: z.boolean().optional(),
    autoNameBranches: z.boolean().optional(),
    fetchRemote: z.boolean().optional(),
    checkoutExistingBranch: z.boolean().optional(),
    presetId: idSchema.optional(),
    environment: workspaceEnvironmentSchema.optional(),
    defaultActionId: idSchema.optional(),
  })
  .strip();

const layoutPaneSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('browser'),
      browserTabs: z.array(browserTabSchema).max(MAX_BROWSER_TABS),
      activeBrowserTabId: idSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('note'), name: z.string().regex(NOTE_NAME_PATTERN) }).strict(),
  z.object({ kind: z.literal('agent') }).strict(),
  z.object({ kind: z.literal('setup-step'), stepId: idSchema }).strict(),
]);

const layoutNodeSchema: z.ZodType<WorkspaceLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), pane: layoutPaneSchema }).strict(),
    z
      .object({
        type: z.literal('split'),
        direction: z.enum(['horizontal', 'vertical']),
        sizes: z.tuple([z.number().finite(), z.number().finite()]),
        children: z.tuple([layoutNodeSchema, layoutNodeSchema]),
      })
      .strict(),
  ])
);

export const workspaceUpdateSchema = z
  .object({
    name: z.string().optional(),
    customName: z.string().optional(),
    workingDirectory: safePathSchema.optional(),
    branchName: z.string().optional(),
    isWorktree: z.boolean().optional(),
    projectId: idSchema.nullable().optional(),
    repoName: z.string().optional(),
    baseBranch: z.string().optional(),
    primaryTerminalId: idSchema.optional(),
    lastDynamicTitle: z.string().optional(),
    windowId: idSchema.nullable().optional(),
    fileTreeOpen: z.boolean().optional(),
    fileTreeMode: z.enum(['diff', 'browse']).optional(),
    sidebarPanelId: z.string().regex(STATUS_ITEM_ID_PATTERN).nullable().optional(),
    // Only cleared: the window that laid out Setup's panes has them now.
    setupPanes: z
      .array(z.unknown())
      .max(0)
      .transform(() => undefined)
      .optional(),
    // No tabs clears it; the main process drops what it can't open again.
    savedLayout: z
      .object({
        tabs: z.array(layoutNodeSchema).max(MAX_SAVED_LAYOUT_PANES),
        activeTab: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    recentLinks: z.array(recentLinkSchema).max(MAX_RECENT_LINKS).optional(),
    color: z
      .string()
      .regex(/^hsl\(\d{1,3},\s*\d{1,3}%,\s*\d{1,3}%\)$/)
      .nullable()
      .optional(),
    categoryId: idSchema.nullable().optional(),
    createdAt: z.number().int().optional(),
    lastActivityAt: z.number().int().optional(),
    lastStoppedAt: z.number().int().optional(),
    order: z.number().int().optional(),
    needsAttention: z.boolean().optional(),
    attention: z
      .object({
        kind: z.enum(['input-required', 'turn-complete', 'error', 'idle', 'generic']),
        source: z.string().min(1).max(64),
        updatedAt: z.number().int(),
        message: z.string().optional(),
        terminalId: idSchema.optional(),
      })
      .optional(),
    unread: z
      .object({ reason: z.enum(['marked', 'snooze-ended']), at: z.number().int() })
      .optional(),
    pinned: z.boolean().optional(),
    tag: z.string().trim().min(1).max(MAX_WORKSPACE_TAG_LENGTH).optional(),
    tagSource: z.literal('pull-request').optional(),
    tagTooltip: z.string().max(MAX_WORKSPACE_TAG_TOOLTIP).optional(),
    snoozedUntil: z.number().int().optional(),
    wakesOnNotification: z.boolean().optional(),
    status: z.enum(['active', 'trashed']).optional(),
    defaultActionId: idSchema.optional(),
    paneDefaultActionId: idSchema.optional(),
  })
  .strip();

export const terminalUpdateSchema = z
  .object({
    name: z.string().optional(),
    status: terminalStatusSchema.optional(),
    dynamicTitle: z.string().optional(),
    createdAt: z.number().int().optional(),
    layoutHint: layoutHintSchema.optional(),
    agentActive: z.boolean().optional(),
    attention: z
      .object({
        kind: z.enum(['input-required', 'turn-complete', 'error', 'idle', 'generic']),
        source: z.string().min(1).max(64),
        updatedAt: z.number().int(),
        message: z.string().optional(),
        terminalId: idSchema.optional(),
      })
      .optional(),
  })
  .strip();

export const workspaceCreateArgsSchema = z.tuple([createWorkspaceParamsSchema]);
export const workspaceCreateBatchArgsSchema = z.tuple([
  z.array(createWorkspaceParamsSchema).min(1).max(100),
]);
export const workspaceAddTerminalArgsSchema = z
  .tuple([
    idSchema,
    z.string().optional(),
    z.string().nullable().optional(),
    layoutHintSchema.optional(),
    z.enum(['agent', 'host', 'host-shell']).optional(),
  ])
  .rest(z.enum(['workspace', 'local-copy', 'remote']).optional());
export const workspaceAddAgentTabArgsSchema = z.tuple([
  idSchema,
  z.string().optional(),
  z.string().optional(),
  z.string().optional(),
  z.object({ keepWorkspaceAgent: z.boolean().optional() }).strict().optional(),
]);
export const workspaceRemoveTerminalArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceStopArgsSchema = z.tuple([idSchema]);
export const workspaceStopTerminalArgsSchema = z.tuple([idSchema]);
const terminalDimensionSchema = z.number().int().min(1).max(2000).optional();
export const workspaceReconnectSshTerminalArgsSchema = z.tuple([
  idSchema,
  terminalDimensionSchema,
  terminalDimensionSchema,
]);
export const workspaceFindInSshTerminalArgsSchema = z.tuple([
  idSchema,
  z.string().min(1).max(1000),
]);
export const workspaceRecoverSshSessionsArgsSchema = z.tuple([idSchema]);
export const workspaceListRemoteSshArgsSchema = z.tuple([idSchema]);
export const workspaceAdoptRemoteSshArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceLinkSshProjectArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceSyncSshHostArgsSchema = z.tuple([idSchema]);
export const workspaceRemoveMissingSshArgsSchema = z.tuple([idSchema]);
export const workspaceRetrySetupStepArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceRetryLocalCopySyncArgsSchema = z.tuple([idSchema]);
export const workspaceDismissSetupActivityArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceRunBackgroundActionArgsSchema = z.tuple([
  idSchema,
  idSchema,
  z
    .object({
      command: nonEmptyStringSchema.optional(),
      executionLocation: z.enum(['workspace', 'local-copy']).optional(),
    })
    .strict()
    .optional(),
]);
export const workspaceStopBackgroundActionRunArgsSchema = z.tuple([idSchema, idSchema]);
const restartTerminalOptionsSchema = z.union([
  z.object({
    command: z.string(),
    commandKind: z.enum(['agent', 'host', 'host-shell']),
    replaceSession: z.boolean().optional(),
  }),
  z
    .object({
      plainShell: z.boolean().optional(),
      replaceSession: z.boolean().optional(),
      resumeAgent: z.boolean().optional(),
      executionLocation: z.enum(['local-copy', 'workspace']).optional(),
    })
    .strict(),
]);
const restartTerminalBaseSchemas = [
  idSchema,
  idSchema.optional(),
  idSchema.nullable().optional(),
] as const;

// Older renderer callers omit trailing values while the current preload always
// sends all six positions, even when the optional values are undefined.
export const workspaceRestartTerminalArgsSchema = z.union([
  z.tuple([
    ...restartTerminalBaseSchemas,
    terminalDimensionSchema,
    terminalDimensionSchema,
    restartTerminalOptionsSchema.optional(),
  ]),
  z.tuple([...restartTerminalBaseSchemas, terminalDimensionSchema, terminalDimensionSchema]),
  z.tuple([...restartTerminalBaseSchemas, terminalDimensionSchema]),
  z.tuple(restartTerminalBaseSchemas),
  z.tuple([idSchema, idSchema.optional()]),
  z.tuple([idSchema]),
]);
export const workspaceDeleteArgsSchema = z.tuple([
  idSchema,
  optionalBooleanSchema,
  optionalBooleanSchema,
]);
export const workspaceGetArgsSchema = z.tuple([idSchema]);
export const workspaceUpdateArgsSchema = z.tuple([idSchema, workspaceUpdateSchema]);
/** Main takes it off its own list, so a marker a script put on meanwhile stays. */
export const workspaceRemoveMarkerArgsSchema = z.tuple([
  idSchema,
  z.string().regex(WORKSPACE_MARKER_KEY_PATTERN),
]);
export const workspaceKeepScratchArgsSchema = z.tuple([idSchema]);
export const workspaceUpdateTerminalArgsSchema = z.tuple([idSchema, terminalUpdateSchema]);
export const workspaceRestartArgsSchema = z.tuple([idSchema]);
export const workspaceReorderArgsSchema = z.tuple([idSchema, z.number().int()]);
export const clearAttentionArgsSchema = z.tuple([idSchema]);
export const clearTerminalAttentionArgsSchema = z.tuple([idSchema]);
export const terminalAttentionSeenArgsSchema = z.tuple([idSchema]);
export const generateBranchNameArgsSchema = z.tuple([z.string()]);
export const regenerateWorkspaceNameArgsSchema = z.tuple([idSchema]);
export const workspaceLinkArgsSchema = z.tuple([idSchema, z.array(idSchema)]);
export const workspaceForgetRunningAtLastQuitArgsSchema = z.tuple([z.array(idSchema).max(10_000)]);
export const workspaceUnlinkArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceLinkPathsArgsSchema = z.tuple([idSchema]);
export const workspaceSetManualSpinnerArgsSchema = z.tuple([idSchema, z.boolean()]);
// Each of a workspace's browser tabs has its own forward: [workspaceId, tabId, ...].
export const workspaceStartSshPreviewForwardArgsSchema = z.tuple([
  idSchema,
  idSchema,
  z.number().int().min(1).max(65535),
  z.enum(['http', 'https']),
]);
export const workspaceStopSshPreviewForwardArgsSchema = z.tuple([idSchema, idSchema]);
export const workspaceStartSshLinkForwardArgsSchema = z.tuple([
  idSchema,
  z.number().int().min(1).max(65535),
  z.enum(['http', 'https']),
]);
export const workspaceStopSshLinkForwardArgsSchema = z.tuple([idSchema, idSchema]);
