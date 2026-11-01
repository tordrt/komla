import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { isMcpToolEnabled } from '../../../shared/constants/mcp-built-in-tools';
import { MAX_STATUS_ITEM_TOOLTIP, STATUS_ITEM_TONES } from '../../../shared/types/status-items';
import { createLogger } from '../../lib/logger';
import { configService } from '../config.service';
import {
  statusIconSchema,
  statusItemColorSchema,
  statusItemIdSchema,
  statusItemSegmentsSchema,
  statusItemTextSchema,
  statusPopoverHtmlSchema,
  statusPopoverMarkdownSchema,
} from '../komla-operation/schema';
import { KomlaOperationError, komlaOperationService } from '../komla-operation.service';
import { telemetryService } from '../telemetry.service';

import type { McpBuiltInToolName } from '../../../shared/constants/mcp-built-in-tools';
import type {
  KomlaOperation,
  KomlaOperationContext,
  KomlaOperationResult,
} from '../komla-operation.service';
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

const logger = createLogger('HttpServerService');

export function createMcpServer(requestContext: KomlaOperationContext = {}): McpServer {
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
      return executeMcpOperation(
        { ...requestContext, cwd: params.cwd },
        {
          type: 'agent.launch',
          destination: 'workspace',
          name: params.name,
          description: params.description,
          branch: params.branchName,
          prompt: params.initialPrompt,
          ...(params.fromCurrentBranch ? { fromCurrentBranch: true } : {}),
        },
        ({ state, destination }) => {
          const { branch, branchedFrom, path } =
            destination.kind === 'workspace' ? destination : {};
          const lines = [
            state === 'provisioning' && !branch
              ? 'Workspace created — generating branch name in the background. The agent will start automatically once ready.'
              : 'Agent spawned in new workspace.',
          ];
          if (branch) lines.push(`Branch: ${branch}`);
          if (branchedFrom) lines.push(`Branched from: ${branchedFrom} (committed work only)`);
          if (path) lines.push(`Path: ${path}`);
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
      return executeMcpOperation(
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
      popover: statusPopoverHtmlSchema
        .optional()
        .describe(
          "An HTML page shown in a popover when the item is clicked, such as rows of checks with status icons; link then shows as a button below it. It runs sandboxed: inline <style> and <script> work, nothing loads from the web, and links open in the browser on a click. Komla's theme colors are CSS variables, such as var(--success) and var(--muted-foreground); keep the background transparent."
        ),
      popoverMarkdown: statusPopoverMarkdownSchema
        .optional()
        .describe('Plain Markdown in place of popover, for a line or two of text.'),
    },
    async ({
      cwd,
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
      popoverMarkdown,
    }) => {
      const clear = text === undefined && segments === undefined;
      return executeMcpOperation(
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
              popoverMarkdown,
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
      return executeMcpOperation(
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
      return executeMcpOperation({ ...requestContext, cwd }, { type: 'preview.open', url }, () =>
        url !== undefined ? `Browser preview opened at ${url}` : 'Browser preview opened.'
      );
    }
  );

  return server;
}

async function executeMcpOperation<T extends KomlaOperation>(
  context: KomlaOperationContext,
  operation: T,
  render: (result: KomlaOperationResult<T['type']>) => string
): Promise<CallToolResult> {
  try {
    const result = await komlaOperationService.execute(context, operation);
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
