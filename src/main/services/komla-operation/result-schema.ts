import { z } from 'zod';

import { PULL_REQUEST_TAG_STATES, WORKSPACE_TAG_TONES } from '../../../shared/lib/workspace-tags';
import { STATUS_ITEM_STYLES, STATUS_ITEM_TONES } from '../../../shared/types/status-items';
import { WORKSPACE_ATTENTION_KINDS } from '../../../shared/types/workspace';

import type { KomlaOperation } from './operation';

/**
 * What each Komla Operation resolves to. The operation service's return types are derived from
 * these, its tests check every result against them, and the SDK's result types are rendered from
 * them (ADR 0008), so a result can't change without the schema changing with it.
 */

const environment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('ssh'), hostId: z.string() }).strict(),
]);

const named = z.object({ id: z.string(), name: z.string() }).strict();

const statusSegment = z.union([
  z
    .object({ text: z.string(), color: z.string().optional(), bold: z.boolean().optional() })
    .strict(),
  z.object({ icon: z.string(), color: z.string().optional() }).strict(),
  z.object({ gap: z.literal(true) }).strict(),
]);

const agentSelection = z
  .object({ preset: named, mode: named.optional(), effort: named.optional() })
  .strict();

const terminal = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    state: z
      .enum(['working', 'blocked', 'error', 'done', 'idle', 'exited'])
      .describe("From the terminal's Attention; `exited` once its program isn't running here."),
    message: z.string().optional().describe("A done's, error's or question's text."),
  })
  .strict();

const terminalWait = {
  reason: z.enum([
    'done',
    'error',
    'idle',
    'blocked',
    'exited',
    'output',
    'timeout',
    'not_started',
  ]),
  message: z.string().optional().describe("The done's, error's or question's text as raised."),
  terminal,
};

export const komlaOperationResultSchemas = {
  'terminal.list': z
    .object({
      terminals: z.array(
        terminal.extend({
          current: z.literal(true).optional().describe('The terminal the call comes from.'),
        })
      ),
    })
    .strict(),
  'terminal.read': z.object({ terminal, text: z.string() }).strict(),
  'terminal.send': z
    .object({
      sent: z.literal(true),
      terminal,
      reason: terminalWait.reason.optional().describe('With `wait`, why the wait returned.'),
      message: terminalWait.message,
    })
    .strict(),
  'terminal.wait': z.object(terminalWait).strict(),
  'context.get': z
    .object({
      context: z
        .object({
          connected: z.literal(true),
          project: named.optional(),
          workspace: z
            .object({ id: z.string(), path: z.string().optional(), environment })
            .strict()
            .optional(),
          terminalId: z.string().optional(),
          agent: z
            .object({ presetId: z.string(), modeId: z.string().optional() })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  'agent.presets': z
    .object({
      default: z
        .object({ presetId: z.string(), modeId: z.string().optional() })
        .strict()
        .optional()
        .describe('The agent a launch starts without a preset, and its mode when one is pinned.'),
      presets: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            active: z.boolean(),
            launchable: z.boolean(),
            unavailableReason: z.string().optional(),
            environment,
            effort: z
              .object({
                title: z.string().describe("The picker's title, such as Effort or Model."),
                levels: z.array(
                  z
                    .object({
                      id: z.string(),
                      name: z.string(),
                      isolatedOnly: z
                        .literal(true)
                        .optional()
                        .describe('Agents may start it only on an SSH host marked isolated.'),
                    })
                    .strict()
                ),
              })
              .strict()
              .optional()
              .describe('The levels `effort` picks from; absent while the picker is hidden.'),
            modes: z.array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  environment,
                  launchable: z.boolean().describe('False for a mode only the user may start.'),
                  isolatedOnly: z
                    .literal(true)
                    .optional()
                    .describe('Agents may start it only on an SSH host marked isolated.'),
                  unavailableReason: z.string().optional(),
                })
                .strict()
            ),
          })
          .strict()
      ),
    })
    .strict(),
  'agent.launch': z
    .object({
      state: z
        .enum(['started', 'provisioning', 'drafted'])
        .describe(
          'A new workspace is provisioning while its worktree and branch are made; a draft waits in New Workspace for the user.'
        ),
      destination: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('draft'),
            projectId: z.string().optional().describe('The project New Workspace opened on.'),
            branchedFrom: z
              .string()
              .optional()
              .describe("The calling workspace's branch, for a draft from the current branch."),
          })
          .strict(),
        z
          .object({ kind: z.literal('tab'), workspaceId: z.string(), terminalId: z.string() })
          .strict(),
        z
          .object({
            kind: z.literal('workspace'),
            workspaceId: z.string(),
            path: z.string().optional(),
            branch: z.string().optional(),
            branchedFrom: z
              .string()
              .optional()
              .describe("The calling workspace's branch, for a launch from the current branch."),
          })
          .strict(),
      ]),
      agent: agentSelection.optional(),
    })
    .strict(),
  'workspace.list': z
    .object({
      workspaces: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            project: named.optional(),
            branch: z.string().optional(),
            path: z.string().optional(),
            environment,
            trashed: z.literal(true).optional(),
            agentActive: z.boolean(),
            attention: z
              .enum(WORKSPACE_ATTENTION_KINDS)
              .optional()
              .describe('The attention the workspace shows.'),
            tag: z.string().optional(),
            linkedWorkspaceIds: z.array(z.string()).optional(),
          })
          .strict()
      ),
    })
    .strict(),
  'tag.list': z
    .object({
      tags: z.array(
        z
          .object({
            name: z.string(),
            tone: z.enum(WORKSPACE_TAG_TONES),
            pullRequestState: z
              .enum(PULL_REQUEST_TAG_STATES)
              .optional()
              .describe('Komla puts this tag on workspaces whose pull request stands so.'),
            hasIcon: z.literal(true).optional(),
            spinner: z.literal(true).optional(),
            hidden: z
              .literal(true)
              .optional()
              .describe("The sidebar moves this tag's workspaces to its Filtered shelf."),
          })
          .strict()
      ),
    })
    .strict(),
  'workspace.title': z
    .object({
      workspace: z
        .object({ id: z.string(), title: z.string(), description: z.string().optional() })
        .strict(),
    })
    .strict(),
  'workspace.snooze': z
    .object({
      snooze: z.union([
        z
          .object({
            workspaceId: z.string(),
            until: z.number().describe('When the snooze ends, in epoch ms.'),
            untilText: z.string().describe("`until` in the desktop's locale and time zone."),
            untilNotified: z.literal(true).optional(),
          })
          .strict(),
        z.object({ workspaceId: z.string(), untilNotified: z.literal(true) }).strict(),
      ]),
    })
    .strict(),
  'workspace.wake': z
    .object({
      snooze: z
        .object({ workspaceId: z.string(), woke: z.boolean() })
        .strict()
        .describe("`woke` is false when the workspace wasn't snoozed."),
    })
    .strict(),
  'workspace.tag': z
    .object({
      tag: z
        .object({
          workspaceId: z.string(),
          tag: z.string().nullable().describe("The workspace's tag afterward."),
          changed: z
            .boolean()
            .describe("False when `ifTag` named a tag the workspace didn't have."),
          added: z.boolean().optional().describe("The tag joined the user's list."),
        })
        .strict(),
    })
    .strict(),
  'workspace.trash': z
    .object({
      trash: z
        .object({ workspaceId: z.string(), afterTurn: z.boolean() })
        .strict()
        .describe("`afterTurn`: it moves once the calling agent's turn ends."),
    })
    .strict(),
  'workspace.notify': z
    .object({
      notification: z
        .object({
          workspaceId: z.string(),
          terminalId: z.string().optional().describe('The terminal whose pane shows it.'),
        })
        .strict(),
    })
    .strict(),
  'workspace.link': z
    .object({
      links: z
        .object({ workspaceId: z.string(), linkedWorkspaceIds: z.array(z.string()) })
        .strict(),
    })
    .strict(),
  'workspace.unlink': z
    .object({
      links: z
        .object({ workspaceId: z.string(), linkedWorkspaceIds: z.array(z.string()) })
        .strict(),
    })
    .strict(),
  'folder.open': z.object({ folder: z.object({ path: z.string() }).strict() }).strict(),
  'status.set': z
    .object({
      status: z
        .object({
          workspaceId: z.string(),
          id: z.string(),
          text: z.string(),
          segments: z.array(statusSegment).optional(),
          tone: z.enum(STATUS_ITEM_TONES).optional(),
          style: z.enum(STATUS_ITEM_STYLES).optional(),
          color: z.string().optional(),
          tooltip: z.string().optional(),
          link: z.string().optional(),
          popoverMarkdown: z.string().optional(),
        })
        .strict()
        .describe('The item as set, without its HTML popover, which the caller has.'),
    })
    .strict(),
  'status.clear': z
    .object({
      status: z
        .object({
          workspaceId: z.string(),
          id: z.string().optional(),
          cleared: z.number().describe('How many items it cleared.'),
        })
        .strict(),
    })
    .strict(),
  'status.refresh': z
    .object({
      status: z
        .object({
          workspaceId: z.string(),
          id: z.string(),
          refreshed: z.literal(true),
          text: z.string().optional(),
          error: z.string().optional().describe("Why the item's command failed."),
        })
        .strict(),
    })
    .strict(),
  'preview.open': z
    .object({
      preview: z
        .object({
          workspaceId: z.string(),
          url: z.string().optional(),
          opened: z
            .boolean()
            .describe(
              "Whether it opened in Komla's browser, rather than being offered to the user."
            ),
        })
        .strict(),
    })
    .strict(),
  'desktop.open': z
    .object({
      desktop: z
        .object({
          workspaceId: z.string(),
          vncApp: z.string().optional().describe('The app this computer opens vnc:// links with.'),
          viewer: z
            .enum(['vnc-app', 'preview'])
            .optional()
            .describe('Where it opened; absent when the workspace asks the user where to open it.'),
          opensWhenShown: z
            .literal(true)
            .optional()
            .describe('It opens there once a window shows the workspace, which none does yet.'),
        })
        .strict(),
    })
    .strict(),
} satisfies Record<KomlaOperation['type'], z.ZodType>;

/** What `execute` resolves to for each operation. */
export type KomlaOperationResults = {
  [T in KomlaOperation['type']]: z.output<(typeof komlaOperationResultSchemas)[T]>;
};
