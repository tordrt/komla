import { homedir } from 'os';
import { join } from 'path';

import { z } from 'zod';

import { isBrowserUrl } from '../../shared/lib/browser-tabs';
import {
  isStatusItemColor,
  MAX_STATUS_BUTTON_LABEL,
  isStatusIconSegment,
  MAX_STATUS_ICON_BYTES,
  MAX_STATUS_ITEM_ICONS,
  MAX_STATUS_ITEM_SEGMENTS,
  MAX_STATUS_ITEM_TEXT,
  MAX_STATUS_ITEM_TOOLTIP,
  MAX_STATUS_POPOVER_BUTTONS,
  MAX_STATUS_POPOVER_MARKDOWN,
  STATUS_ITEM_ID_PATTERN,
  STATUS_ITEM_TONES,
  statusCommandScope,
  type StatusButtonRunResult,
  type StatusCommand,
  type StatusCommandList,
  type StatusCommandResult,
  type StatusItemContent,
  type StatusItemSegment,
  type StatusPopoverButton,
  type StatusPopoverResult,
  type StatusPopoverTheme,
} from '../../shared/types/status-items';
import { createLogger } from '../lib/logger';
import { parseSettingsFile, readSettingsFile } from '../lib/settings-file';
import { isSettingsIconPath, readStatusIcon, statusIconDataUrl } from '../lib/status-icon';
import {
  ANSI_ESCAPE,
  statusItemSegmentsText,
  statusItemText,
  truncate,
  visibleStatusText,
  withLeadingIcon,
} from '../lib/status-item-text';

import { FileWatcher } from './file-watcher';
import { htmlPreviewService } from './html-preview.service';
import { getKomlaBasePath } from './paths';
import { buildStatusPopoverPage } from './status-popover-page';
import {
  canRunWorkspaceCommands,
  runLocalCommand,
  runWorkspaceCommand,
  workspaceProjectKeys,
  WorkspaceCommandError,
} from './workspace-command';
import { workspaceService } from './workspace.service';

import type { Workspace } from '../../shared/types/workspace';

const logger = createLogger('StatusCommandsService');

/** How long a run may take, unless the item's `timeoutSeconds` says otherwise. */
export const STATUS_COMMAND_TIMEOUT_MS = 15_000;
/** Buttons can start longer work, such as rerunning CI. */
export const STATUS_BUTTON_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;
const MAX_STATUS_COMMANDS = 30;
/** Named commands per item; its popover shows at most MAX_STATUS_POPOVER_BUTTONS buttons of them. */
const MAX_STATUS_ITEM_COMMANDS = 12;
const STATUS_COMMANDS_VERSION = 1;
const DEFAULT_CONTENT = JSON.stringify({ _version: STATUS_COMMANDS_VERSION, items: [] }, null, 2);

const ID_MESSAGE = 'ids are up to 40 letters, digits, dots, dashes and underscores';
const COLOR_MESSAGE =
  'iconColor: success, warning, error, info, muted, foreground or a hex color such as #e5c07b';
const commandSchema = z.string().trim().min(1).max(16_000);

const ICON_DESCRIPTION = `SVG markup, an image data URL (SVG, PNG, WebP, GIF or JPEG, up to ${MAX_STATUS_ICON_BYTES / 1024} KB), or a file the user keeps in the settings folder's icons folder, named \`icons/<file>\``;
const COLOR_DESCRIPTION =
  '`success`, `warning`, `error`, `info`, `muted`, `foreground` or a hex color such as `#e5c07b`';

// The descriptions are what `komla settings schema status-items` tells agents.
const statusCommandSchema = z
  .object({
    id: z
      .string()
      .regex(STATUS_ITEM_ID_PATTERN, ID_MESSAGE)
      .meta({ description: 'Unique in the file.' }),
    command: commandSchema.meta({
      description:
        "Runs in the user's shell on each interval while the workspace is open. Komla shows the first line of its output, in the terminal colors it prints, with the rest as the tooltip, or a JSON object it prints, as under What `command` prints. Empty output hides the item.",
    }),
    intervalSeconds: z.number().int().min(10).max(86_400).default(60).meta({
      description:
        'How often the command runs. `komla status refresh <id>`, as from a hook or a Quick Command, runs it again at once.',
    }),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .meta({
        description: `How long the command and popover command may run, ${STATUS_COMMAND_TIMEOUT_MS / 1000} when left out. Past it, Komla stops the command and shows the label.`,
      }),
    runOn: z.enum(['workspace', 'local']).optional().meta({
      description:
        "`workspace`, the default, runs its commands where the workspace's files are. `local` runs them on this computer in the home folder, even for an SSH workspace, and every workspace shows the same output, for items that don't depend on the workspace, such as an account's usage.",
    }),
    label: z.string().trim().min(1).max(MAX_STATUS_ITEM_TEXT).optional().meta({
      description:
        "Shown in place of the output while the command fails, in the status bar's menu, and as the item when it shows only icons.",
    }),
    projects: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .meta({ description: 'Project names or ids to show it in; every workspace when left out.' }),
    popoverCommand: commandSchema.optional().meta({
      description:
        'Runs when the item is clicked, and its output shows in a popover: a JSON object with an `html` page, as under What `popoverCommand` prints, or plain Markdown for a line or two of text.',
    }),
    action: z.string().trim().min(1).max(200).optional().meta({
      description: 'A Quick Command, by title, that clicking the item runs, in place of a popover.',
    }),
    iconColor: z
      .string()
      .refine(isStatusItemColor, { message: COLOR_MESSAGE })
      .optional()
      .meta({
        description: `Shows the icon's shape in a color: ${COLOR_DESCRIPTION}. Without it, the icon keeps its own colors.`,
      }),
    icon: z
      .string()
      .trim()
      .refine((icon) => isSettingsIconPath(icon) || statusIconDataUrl(icon) !== undefined, {
        message: `icon: a file in the settings folder's icons folder, such as icons/logo.svg, SVG markup, or an image data URL of at most ${MAX_STATUS_ICON_BYTES / 1024} KB`,
      })
      .optional()
      .meta({ description: `A logo or image before the output: ${ICON_DESCRIPTION}.` }),
    commands: z
      .record(z.string(), commandSchema)
      .refine(
        (commands) => Object.keys(commands).every((name) => STATUS_ITEM_ID_PATTERN.test(name)),
        {
          message: `command names: ${ID_MESSAGE}`,
        }
      )
      .refine((commands) => Object.keys(commands).length <= MAX_STATUS_ITEM_COMMANDS, {
        message: `at most ${MAX_STATUS_ITEM_COMMANDS} commands`,
      })
      .optional()
      .meta({
        description: `Up to ${MAX_STATUS_ITEM_COMMANDS} named commands for the popover's buttons, which need a \`popoverCommand\`, such as \`{"rerun": "gh run rerun --failed"}\`. Komla runs one in the workspace when its button is clicked, then updates the item and the popover. Like the item's other commands, they have the \`komla\` CLI.`,
      }),
  })
  .strict()
  .refine((item) => !(item.popoverCommand && item.action), {
    message: 'an item opens its popover or runs a Quick Command when clicked, not both',
  })
  .refine((item) => !item.commands || item.popoverCommand, {
    message: 'commands run from popover buttons, so the item needs a popoverCommand',
  });

export const statusCommandsFileSchema = z
  .object({
    _version: z.number().int().optional().meta({ description: "The file's format, 1." }),
    items: z
      .array(statusCommandSchema)
      .max(MAX_STATUS_COMMANDS)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        message: 'each item needs its own id',
      }),
  })
  .strict()
  .meta({
    description:
      "Status bar items whose text comes from a command. Apply the whole file: keep every item the user didn't ask to change. If Komla can't read the file, a warning item in the status bar says what's wrong.",
  });

type ConfiguredStatusCommand = z.infer<typeof statusCommandSchema>;

/** Reads status-items.json; a problem names what is wrong with the file instead. */
export function parseStatusCommandsFile(content: string): {
  items: ConfiguredStatusCommand[];
  problem?: string;
} {
  const parsed = parseSettingsFile('status-items.json', content, statusCommandsFileSchema);
  return 'problem' in parsed ? { items: [], problem: parsed.problem } : parsed.value;
}

const outputColorSchema = z
  .string()
  .refine(isStatusItemColor)
  .optional()
  .catch(undefined)
  .meta({ description: COLOR_DESCRIPTION });
const outputSegmentSchema = z.union([
  z.object({
    text: z.string(),
    color: outputColorSchema,
    bold: z.boolean().optional().catch(undefined),
  }),
  z.object({
    icon: z.string().meta({ description: ICON_DESCRIPTION }),
    color: outputColorSchema.meta({ description: `The icon's color: ${COLOR_DESCRIPTION}.` }),
  }),
]);
/** What a status item's command can print as JSON, which `komla settings schema` shows. */
export const commandOutputSchema = z
  .object({
    text: z.string().optional(),
    // Parts it can't show are left out, as are those past the most an item has.
    segments: z
      .array(outputSegmentSchema.optional().catch(undefined))
      .transform((segments) => {
        const shown = segments.filter((segment) => segment !== undefined);
        return shown.length > 0 ? shown.slice(0, MAX_STATUS_ITEM_SEGMENTS) : undefined;
      })
      .optional()
      .catch(undefined)
      .meta({
        description: `Parts in place of \`text\`, up to ${MAX_STATUS_ITEM_SEGMENTS}, to color parts or put icons anywhere, such as \`[{"text": "\\uf00c", "color": "success"}, {"text": " 2", "bold": true}]\`. An item shows at most ${MAX_STATUS_ITEM_ICONS} icons. \`color\` then applies to the parts without one.`,
      }),
    icon: z
      .string()
      .optional()
      .catch(undefined)
      .meta({ description: `In place of the item's \`icon\`: ${ICON_DESCRIPTION}.` }),
    iconColor: outputColorSchema,
    tone: z
      .enum(STATUS_ITEM_TONES)
      .optional()
      .catch(undefined)
      .meta({ description: 'Adds a dot of that color.' }),
    color: z
      .string()
      .refine(isStatusItemColor)
      .optional()
      .catch(undefined)
      .meta({ description: `Colors the text: ${COLOR_DESCRIPTION}.` }),
    tooltip: z.string().optional().catch(undefined),
    link: z
      .string()
      .optional()
      .catch(undefined)
      .meta({ description: 'An http(s) URL the item opens when clicked.' }),
  })
  .refine((output) => output.text !== undefined || output.segments !== undefined)
  .meta({
    description:
      "A JSON object in place of plain output, with `text` or `segments`. Nerd Font icons, such as U+F407 for a pull request (`\\uf407` in JSON), show from Komla's bundled font.",
  });

// JSON output starts with `{`; anything else, or JSON that doesn't parse, is text.
function parseJsonOutput(output: string): unknown {
  if (!output.startsWith('{')) return undefined;
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

/**
 * What a command's output shows: a JSON object with `text`, which may carry terminal colors, or
 * `segments` of text in colors of their own and icons, and optionally `icon` and `iconColor`,
 * `tone`, `color`, `tooltip` and `link`; or plain text whose first line is the item, in the colors it printed, and
 * the rest its tooltip. Nothing shows for empty output, so a command can hide its item. `icon`, or
 * else the item's own, goes before the text; icons stay as the output names them, for
 * resolveStatusIcons to read.
 */
export function parseStatusCommandOutput(
  stdout: string,
  icon?: { icon: string; color?: string }
): StatusItemContent | null {
  const output = stdout.replace(ANSI_ESCAPE, '').trim();
  if (!output) return null;
  const parsed = commandOutputSchema.safeParse(parseJsonOutput(output));
  if (parsed.success) {
    const fitted = parsed.data.segments
      ? statusItemSegmentsText(parsed.data.segments)
      : statusItemText(parsed.data.text ?? '');
    const leading = parsed.data.icon
      ? { icon: parsed.data.icon, color: parsed.data.iconColor }
      : icon;
    const text = fitted.text;
    const segments = leading
      ? withLeadingIcon(fitted, leading.icon, leading.color)
      : fitted.segments;
    if (!text && !segments?.some(isStatusIconSegment)) return null;
    const tooltip = parsed.data.tooltip?.trim();
    const link = parsed.data.link?.trim();
    return {
      text,
      ...(segments && { segments }),
      ...(parsed.data.tone && { tone: parsed.data.tone }),
      ...(parsed.data.color && { color: parsed.data.color }),
      ...(tooltip && { tooltip: truncate(tooltip, MAX_STATUS_ITEM_TOOLTIP) }),
      ...(link && isBrowserUrl(link) && { link }),
    };
  }
  const tooltip = output.split(/\r?\n/).slice(1).join('\n').trim();
  const firstLine = stdout.split(/\r?\n/).find((line) => visibleStatusText(line)) ?? '';
  const fitted = statusItemText(firstLine);
  const segments = icon ? withLeadingIcon(fitted, icon.icon, icon.color) : fitted.segments;
  return {
    text: fitted.text,
    ...(segments && { segments }),
    ...(tooltip && { tooltip: truncate(tooltip, MAX_STATUS_ITEM_TOOLTIP) }),
  };
}

/**
 * Reads the icons an item's content names into images, leaving out any that aren't icons Komla
 * shows, and those past the most an item shows. Without text or icons left, nothing shows.
 */
export async function resolveStatusIcons(
  content: StatusItemContent | null,
  readIcon: (value: string) => Promise<string | undefined>
): Promise<StatusItemContent | null> {
  if (!content?.segments?.some(isStatusIconSegment)) return content;
  let icons = 0;
  const segments: StatusItemSegment[] = [];
  for (const segment of content.segments) {
    if (!isStatusIconSegment(segment)) {
      segments.push(segment);
      continue;
    }
    if (icons >= MAX_STATUS_ITEM_ICONS) continue;
    const icon = await readIcon(segment.icon);
    if (!icon) continue;
    icons++;
    segments.push({ ...segment, icon });
  }
  if (!content.text && icons === 0) return null;
  return { ...content, segments };
}

const buttonLabelSchema = z.string().trim().min(1).max(MAX_STATUS_BUTTON_LABEL);
const popoverButtonSchema = z.union([
  z.object({
    label: buttonLabelSchema,
    link: z
      .string()
      .trim()
      .refine(isBrowserUrl)
      .meta({ description: 'An http(s) URL the button opens.' }),
  }),
  z.object({
    label: buttonLabelSchema,
    action: z.string().trim().min(1).max(200).meta({
      description: "One of the project's Quick Commands, by title, for the button to run.",
    }),
  }),
  z.object({
    label: buttonLabelSchema,
    run: z
      .string()
      .meta({ description: "One of the item's `commands`, by name, for the button to run." }),
  }),
]);
const popoverOutputSchema = z
  .object({
    markdown: z
      .string()
      .optional()
      .meta({ description: 'Plain Markdown in place of `html`, for a line or two of text.' }),
    html: z.string().optional().meta({
      description:
        "A page shown in a sandbox: inline `<style>` and `<script>` work, but nothing loads from the web and it can't reach Komla. `komla skill status-items` says how to make it match Komla's theme.",
    }),
    buttons: z.array(z.unknown()).optional().catch(undefined),
  })
  .refine((output) => output.markdown !== undefined || output.html !== undefined);

/** The popover's buttons as `komla settings schema` shows them; they parse one by one. */
export const popoverOutputDescription = popoverOutputSchema
  .safeExtend({
    buttons: z
      .array(popoverButtonSchema)
      .max(MAX_STATUS_POPOVER_BUTTONS)
      .optional()
      .meta({
        description: `Shown below the page, up to ${MAX_STATUS_POPOVER_BUTTONS}. A button can't carry a command of its own, since output can include text from elsewhere, such as a pull request title.`,
      }),
  })
  .meta({ description: 'A JSON object in place of Markdown output, with `markdown` or `html`.' });

/** A popover command's output: Markdown, or HTML for Komla to serve as a sandboxed page. */
export interface ParsedStatusPopover {
  markdown: string;
  html?: string;
  buttons: StatusPopoverButton[];
}

/**
 * What a popover command's output shows: a JSON object with `markdown` or `html` and optionally
 * `buttons`, or Markdown. A button that runs a command names one of the item's `commands`; any
 * other is left out, as are buttons that don't parse.
 */
export function parseStatusPopoverOutput(
  stdout: string,
  commandNames: readonly string[]
): ParsedStatusPopover | null {
  const output = stdout.replace(ANSI_ESCAPE, '').trim();
  if (!output) return null;
  const parsed = popoverOutputSchema.safeParse(parseJsonOutput(output));
  if (!parsed.success) {
    return { markdown: truncate(output, MAX_STATUS_POPOVER_MARKDOWN), buttons: [] };
  }
  const buttons = (parsed.data.buttons ?? [])
    .flatMap((button): StatusPopoverButton[] => {
      const valid = popoverButtonSchema.safeParse(button);
      if (!valid.success) return [];
      if ('run' in valid.data && !commandNames.includes(valid.data.run)) return [];
      return [valid.data];
    })
    .slice(0, MAX_STATUS_POPOVER_BUTTONS);
  const html = parsed.data.html?.trim();
  if (html) return { markdown: '', html, buttons };
  const markdown = parsed.data.markdown?.trim() ?? '';
  if (!markdown && buttons.length === 0) return null;
  return { markdown: truncate(markdown, MAX_STATUS_POPOVER_MARKDOWN), buttons };
}

function itemTimeoutMs(item: ConfiguredStatusCommand): number {
  return item.timeoutSeconds === undefined ? STATUS_COMMAND_TIMEOUT_MS : item.timeoutSeconds * 1000;
}

function failureMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof WorkspaceCommandError && error.timedOut) {
    return `timed out after ${timeoutMs / 1000} seconds`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message.replace(ANSI_ESCAPE, ''), MAX_STATUS_ITEM_TOOLTIP);
}

export interface StatusCommandsDependencies {
  readFile(): string | undefined;
  getWorkspace(id: string): Workspace | undefined;
  /** Names of the workspace's project, its id and name, that `projects` can match. */
  getProjectKeys(workspace: Workspace): string[];
  /** False while the workspace can't run commands, as when its SSH host is not connected. */
  canRun(workspace: Workspace): boolean;
  /** Runs the command where the workspace's files are and returns its standard output. */
  run(workspace: Workspace, command: string, timeoutMs: number): Promise<string>;
  /** Runs the command on this computer, in the user's home folder, for a `runOn: local` item. */
  runLocal(command: string, timeoutMs: number): Promise<string>;
  /** An icon an item or its output names, as an image; undefined when it isn't one. */
  readIcon(value: string): Promise<string | undefined>;
  /**
   * Serves an HTML popover's page in Komla's sandbox. Of the pages before it with this key, only
   * the last stays, as it may be on screen while this one loads.
   */
  servePopoverPage(key: string, page: string): Promise<string>;
  now(): number;
}

type RunCommand = (command: string, timeoutMs: number) => Promise<string>;

/**
 * The status bar items users and agents define in status-items.json: commands Komla runs on an
 * interval in the open workspace, or on this computer for an item that runs there, whose output
 * becomes the item.
 */
export class StatusCommandsService {
  private items: ConfiguredStatusCommand[] = [];
  private problem: string | undefined;
  private changedAt = 0;
  private readonly inFlight = new Map<string, Promise<StatusCommandResult>>();
  // Refreshes waiting for the run under way, which the refreshes that come after them share.
  private readonly queuedRefreshes = new Map<string, Promise<StatusCommandResult>>();
  private readonly listeners = new Set<() => void>();
  private readonly resultListeners = new Set<(result: StatusCommandResult) => void>();

  constructor(private readonly dependencies: StatusCommandsDependencies) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Follows the runs `komla status refresh` asks for, which no window started. */
  onResult(listener: (result: StatusCommandResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  /** Reads the file again, as after it changed on disk. */
  reload(): void {
    let content: string | undefined;
    try {
      content = this.dependencies.readFile();
    } catch (error) {
      logger.warn('Could not read status-items.json', error);
      content = undefined;
    }
    const parsed = content === undefined ? { items: [] } : parseStatusCommandsFile(content);
    this.items = parsed.items;
    this.problem = parsed.problem;
    this.changedAt = this.dependencies.now();
    // Runs under way may run an earlier command, so the next asked for doesn't share them.
    this.inFlight.clear();
    if (parsed.problem) logger.warn(parsed.problem);
    for (const listener of this.listeners) listener();
  }

  /** The commands that run in a workspace, with any problem reading the file. */
  list(workspaceId: string): StatusCommandList {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    const keys = workspace ? this.dependencies.getProjectKeys(workspace) : [];
    const items: StatusCommand[] = workspace
      ? this.items
          .filter((item) => !item.projects || item.projects.some((name) => keys.includes(name)))
          .map(({ id, intervalSeconds, runOn, label, popoverCommand, action }) => ({
            id,
            intervalSeconds,
            ...(runOn === 'local' && { runOn }),
            ...(label && { label }),
            ...(popoverCommand && { popover: true }),
            ...(action && { action }),
          }))
      : [];
    return { items, ...(this.problem && { problem: this.problem }), changedAt: this.changedAt };
  }

  /** Runs one item's command for a workspace; a run already under way is shared. */
  run(workspaceId: string, id: string): Promise<StatusCommandResult> {
    return this.inFlight.get(this.runKey(workspaceId, id)) ?? this.startRun(workspaceId, id);
  }

  /**
   * Runs an item again now, after any run under way, for `komla status refresh`, and tells the
   * listeners what it shows. Refreshes while one waits share it. Undefined when the workspace has
   * no such item, and 'unavailable' when it can't run commands now, as while an SSH host is down.
   */
  async refresh(
    workspaceId: string,
    id: string
  ): Promise<StatusCommandResult | 'unavailable' | undefined> {
    if (!this.list(workspaceId).items.some((item) => item.id === id)) return undefined;
    const item = this.items.find((candidate) => candidate.id === id)!;
    if (!this.runner(workspaceId, item)) return 'unavailable';
    const key = this.runKey(workspaceId, id);
    const queued = this.queuedRefreshes.get(key);
    if (queued) return queued;
    const running = this.inFlight.get(key);
    const refreshed = this.startRun(workspaceId, id, running).then((result) => {
      for (const listener of this.resultListeners) listener(result);
      return result;
    });
    if (running) {
      this.queuedRefreshes.set(key, refreshed);
      void running.finally(() => {
        if (this.queuedRefreshes.get(key) === refreshed) this.queuedRefreshes.delete(key);
      });
    }
    return refreshed;
  }

  /** Runs of an item that runs on this computer are the same for every workspace. */
  private runKey(workspaceId: string, id: string): string {
    const item = this.items.find((candidate) => candidate.id === id);
    return `${statusCommandScope(workspaceId, item ?? {})}\0${id}`;
  }

  /** Where an item's commands run, unless they can't run now, as while an SSH host is down. */
  private runner(workspaceId: string, item: ConfiguredStatusCommand): RunCommand | undefined {
    if (item.runOn === 'local') {
      return (command, timeoutMs) => this.dependencies.runLocal(command, timeoutMs);
    }
    const workspace = this.runnableWorkspace(workspaceId);
    if (!workspace) return undefined;
    return (command, timeoutMs) => this.dependencies.run(workspace, command, timeoutMs);
  }

  /** Starts a run, after `after` when one under way started too early to show what changed. */
  private startRun(
    workspaceId: string,
    id: string,
    after?: Promise<unknown>
  ): Promise<StatusCommandResult> {
    const key = this.runKey(workspaceId, id);
    const run = (
      after ? after.then(() => this.runNow(workspaceId, id)) : this.runNow(workspaceId, id)
    ).finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async runNow(workspaceId: string, id: string): Promise<StatusCommandResult> {
    const item = this.items.find((candidate) => candidate.id === id);
    const run = item && this.runner(workspaceId, item);
    const base = { id, workspaceId, ...(item?.runOn === 'local' && { runOn: item.runOn }) };
    if (!item || !run) {
      return { ...base, content: null, ranAt: this.dependencies.now() };
    }
    const timeoutMs = itemTimeoutMs(item);
    try {
      const stdout = await run(item.command, timeoutMs);
      return {
        ...base,
        content: await resolveStatusIcons(
          parseStatusCommandOutput(
            stdout,
            item.icon ? { icon: item.icon, color: item.iconColor } : undefined
          ),
          (value) => this.dependencies.readIcon(value)
        ),
        ranAt: this.dependencies.now(),
      };
    } catch (error) {
      return {
        ...base,
        content: null,
        error: failureMessage(error, timeoutMs),
        ranAt: this.dependencies.now(),
      };
    }
  }

  /**
   * Runs an item's popover command for a workspace, for the popover its click opens in a window;
   * HTML popovers take the window's theme. Each window has pages of its own, so one opening the
   * popover doesn't replace the page another shows.
   */
  async runPopover(
    workspaceId: string,
    id: string,
    theme?: StatusPopoverTheme,
    windowKey = ''
  ): Promise<StatusPopoverResult> {
    const item = this.items.find((candidate) => candidate.id === id);
    const run = item && this.runner(workspaceId, item);
    const base = { id, workspaceId };
    if (!item?.popoverCommand || !run) return { ...base, content: null };
    const timeoutMs = itemTimeoutMs(item);
    try {
      const stdout = await run(item.popoverCommand, timeoutMs);
      const parsed = parseStatusPopoverOutput(stdout, Object.keys(item.commands ?? {}));
      if (!parsed?.html) return { ...base, content: parsed };
      const htmlUrl = await this.dependencies.servePopoverPage(
        `status-popover:${windowKey}:${statusCommandScope(workspaceId, item)}:${id}`,
        buildStatusPopoverPage(parsed.html, theme)
      );
      return { ...base, content: { markdown: '', htmlUrl, buttons: parsed.buttons } };
    } catch (error) {
      return { ...base, content: null, error: failureMessage(error, timeoutMs) };
    }
  }

  /** Runs one of an item's named commands, for a button in its popover. */
  async runButton(workspaceId: string, id: string, name: string): Promise<StatusButtonRunResult> {
    const item = this.items.find((candidate) => candidate.id === id);
    const command =
      item?.commands && Object.hasOwn(item.commands, name) ? item.commands[name] : undefined;
    if (!item || !command) return { error: `status-items.json has no command ${name} for ${id}` };
    const run = this.runner(workspaceId, item);
    if (!run) return { error: "This workspace can't run commands right now" };
    try {
      await run(command, STATUS_BUTTON_TIMEOUT_MS);
      // A run under way began before the command, so the item's next run starts after it.
      const running = this.inFlight.get(this.runKey(workspaceId, id));
      if (running) void this.startRun(workspaceId, id, running);
      return {};
    } catch (error) {
      return { error: failureMessage(error, STATUS_BUTTON_TIMEOUT_MS) };
    }
  }

  private runnableWorkspace(workspaceId: string): Workspace | undefined {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    return workspace && this.dependencies.canRun(workspace) ? workspace : undefined;
  }
}

const settingsPath = join(getKomlaBasePath(), 'settings');
const statusCommandsPath = join(settingsPath, 'status-items.json');

/** Serves an HTML popover's page in the preview sandbox, replacing the last one with that key. */
export function serveStatusPopoverPage(key: string, page: string): Promise<string> {
  return htmlPreviewService.createContentPreviewUrl('popover.html', page, { key, fonts: true });
}

export const statusCommandsService = new StatusCommandsService({
  readFile: () => readSettingsFile(statusCommandsPath, DEFAULT_CONTENT),
  getWorkspace: (id) => workspaceService.get(id),
  getProjectKeys: workspaceProjectKeys,
  canRun: canRunWorkspaceCommands,
  run: (workspace, command, timeoutMs) =>
    runWorkspaceCommand(workspace, command, { timeoutMs, maxOutput: MAX_OUTPUT }),
  runLocal: (command, timeoutMs) =>
    runLocalCommand(homedir(), command, { timeoutMs, maxOutput: MAX_OUTPUT }),
  readIcon: (value) => readStatusIcon(settingsPath, value),
  servePopoverPage: serveStatusPopoverPage,
  now: Date.now,
});

let watcher: FileWatcher | null = null;

/** Follows changes to status-items.json, so edits show without a restart. */
export async function watchStatusCommands(): Promise<void> {
  if (watcher) return;
  statusCommandsService.reload();
  watcher = new FileWatcher(statusCommandsPath, () => statusCommandsService.reload());
  await watcher.start();
}

export async function stopWatchingStatusCommands(): Promise<void> {
  await watcher?.stop();
  watcher = null;
}
