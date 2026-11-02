import { join } from 'path';

import { z } from 'zod';

import { isBrowserUrl } from '../../shared/lib/browser-tabs';
import {
  isStatusItemColor,
  isStatusIconSegment,
  MAX_STATUS_ITEM_ICONS,
  MAX_STATUS_ITEM_SEGMENTS,
  MAX_STATUS_ITEM_TEXT,
  MAX_STATUS_ITEM_TOOLTIP,
  STATUS_ITEM_TONES,
  type StatusButtonRunResult,
  type StatusCommand,
  type StatusCommandList,
  type StatusCommandResult,
  type StatusItemContent,
  type StatusItemSegment,
  type StatusPopoverResult,
  type StatusPopoverTheme,
} from '../../shared/types/status-items';
import { parseSettingsFile, readSettingsFile } from '../lib/settings-file';
import { readStatusIcon } from '../lib/status-icon';
import {
  ANSI_ESCAPE,
  statusItemSegmentsText,
  statusItemText,
  truncate,
  visibleStatusText,
  withLeadingIcon,
} from '../lib/status-item-text';

import {
  COLOR_DESCRIPTION,
  commandRunnerDependencies,
  CommandEntries,
  commandSchema,
  entryIdSchema,
  failureMessage,
  ICON_DESCRIPTION,
  iconColorSchema,
  iconSchema,
  intervalSecondsSchema,
  MAX_NAMED_COMMANDS,
  namedCommandsSchema,
  parseJsonOutput,
  projectsSchema,
  runOnSchema,
  serveCommandPage,
  timeoutSecondsSchema,
  type CommandRunnerDependencies,
  type ServePage,
} from './command-items';
import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';

import type { PluginSource, PluginStatusCommand } from './plugins.service';

/** How long a run may take, unless the item's `timeoutSeconds` says otherwise. */
export const STATUS_COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 64 * 1024;
const MAX_STATUS_COMMANDS = 30;
const STATUS_COMMANDS_VERSION = 1;
const DEFAULT_CONTENT = JSON.stringify({ _version: STATUS_COMMANDS_VERSION, items: [] }, null, 2);

// The descriptions are what `komla settings schema status-items` tells agents.
export const statusCommandSchema = z
  .object({
    id: entryIdSchema.meta({ description: 'Unique in the file.' }),
    command: commandSchema.meta({
      description:
        "Runs in the user's shell on each interval while the workspace is open. Komla shows the first line of its output, in the terminal colors it prints, with the rest as the tooltip, or a JSON object it prints, as under What `command` prints. Empty output hides the item.",
    }),
    intervalSeconds: intervalSecondsSchema.meta({
      description:
        'How often the command runs. `komla status refresh <id>`, as from a hook or a Quick Command, runs it again at once.',
    }),
    timeoutSeconds: timeoutSecondsSchema.meta({
      description: `How long the command and popover command may run, ${STATUS_COMMAND_TIMEOUT_MS / 1000} when left out. Past it, Komla stops the command and shows the label.`,
    }),
    runOn: runOnSchema.meta({
      description:
        "`workspace`, the default, runs its commands where the workspace's files are. `local` runs them on this computer in the home folder, even for an SSH workspace, and every workspace shows the same output, for items that don't depend on the workspace, such as an account's usage.",
    }),
    label: z.string().trim().min(1).max(MAX_STATUS_ITEM_TEXT).optional().meta({
      description:
        "Shown in place of the output while the command fails, in the status bar's menu, and as the item when it shows only icons.",
    }),
    projects: projectsSchema.meta({
      description: 'Project names or ids to show it in; every workspace when left out.',
    }),
    popoverCommand: commandSchema.optional().meta({
      description:
        'Runs when the item is clicked, and its output shows in a popover: a JSON object with an `html` page, as under What `popoverCommand` prints, or plain Markdown for a line or two of text.',
    }),
    action: z.string().trim().min(1).max(200).optional().meta({
      description: 'A Quick Command, by title, that clicking the item runs, in place of a popover.',
    }),
    iconColor: iconColorSchema.meta({
      description: `Shows the icon's shape in a color: ${COLOR_DESCRIPTION}. Without it, the icon keeps its own colors.`,
    }),
    icon: iconSchema.meta({
      description: `A logo or image before the output: ${ICON_DESCRIPTION}.`,
    }),
    commands: namedCommandsSchema.meta({
      description: `Up to ${MAX_NAMED_COMMANDS} named commands for the popover's buttons, which need a \`popoverCommand\`, such as \`{"rerun": "gh run rerun --failed"}\`. Komla runs one in the workspace when its button is clicked, then updates the item and the popover. Like the item's other commands, they have the \`komla\` CLI.`,
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

export type ConfiguredStatusCommand = z.infer<typeof statusCommandSchema>;

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

function itemTimeoutMs(item: StatusCommandItem): number {
  return item.timeoutSeconds === undefined ? STATUS_COMMAND_TIMEOUT_MS : item.timeoutSeconds * 1000;
}

export interface StatusCommandsDependencies extends CommandRunnerDependencies {
  readFile(): string | undefined;
  /**
   * An icon an item or its output names, as an image; undefined when it isn't one. A plugin's
   * icon files are in its folder, the user's in the settings folder.
   */
  readIcon(value: string, pluginDir?: string): Promise<string | undefined>;
  /** Serves an HTML popover's page in Komla's sandbox. */
  servePopoverPage: ServePage;
}

/** An item from status-items.json, or from a plugin that runs. */
type StatusCommandItem = ConfiguredStatusCommand & { plugin?: PluginSource };

/**
 * The status bar items users and agents define in status-items.json: commands Komla runs on an
 * interval in the open workspace, or on this computer for an item that runs there, whose output
 * becomes the item.
 */
export class StatusCommandsService {
  private readonly items: CommandEntries<StatusCommandItem>;
  private readonly inFlight = new Map<string, Promise<StatusCommandResult>>();
  // Refreshes waiting for the run under way, which the refreshes that come after them share.
  private readonly queuedRefreshes = new Map<string, Promise<StatusCommandResult>>();
  private readonly resultListeners = new Set<(result: StatusCommandResult) => void>();

  constructor(private readonly dependencies: StatusCommandsDependencies) {
    this.items = new CommandEntries(
      'status-items.json',
      () => dependencies.readFile(),
      (content) => {
        const { items, problem } = parseStatusCommandsFile(content);
        return { entries: items, ...(problem && { problem }) };
      },
      dependencies
    );
    // Runs under way may run an earlier command, so the next asked for doesn't share them.
    this.items.onChange(() => this.inFlight.clear());
  }

  onChange(listener: () => void): () => void {
    return this.items.onChange(listener);
  }

  /** Follows the runs `komla status refresh` asks for, which no window started. */
  onResult(listener: (result: StatusCommandResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  /** Reads the file again, as after it changed on disk. */
  reload(): void {
    this.items.reload();
  }

  /** The items of the plugins that run, after status-items.json's, which win on an id. */
  setPluginItems(items: PluginStatusCommand[]): void {
    this.items.setPluginEntries(items);
  }

  /** The commands that run in a workspace, with any problem reading the file. */
  list(workspaceId: string): StatusCommandList {
    const items: StatusCommand[] = this.items
      .forWorkspace(workspaceId)
      .map(({ id, intervalSeconds, runOn, label, popoverCommand, action, plugin }) => ({
        id,
        intervalSeconds,
        ...(runOn === 'local' && { runOn }),
        ...(label && { label }),
        ...(popoverCommand && { popover: true }),
        ...(action && { action }),
        ...(plugin && { plugin: plugin.name }),
      }));
    const { problem, changedAt } = this.items;
    return { items, ...(problem && { problem }), changedAt };
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
    const item = this.items.forWorkspace(workspaceId).find((candidate) => candidate.id === id);
    if (!item) return undefined;
    if (!this.items.runner(workspaceId, item)) return 'unavailable';
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
    return `${this.items.scope(workspaceId, this.items.find(id) ?? {})}\0${id}`;
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
    const item = this.items.find(id);
    const run = item && this.items.runner(workspaceId, item);
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
          (value) => this.dependencies.readIcon(value, item.plugin?.dir)
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
    const item = this.items.find(id);
    const base = { id, workspaceId };
    if (!item?.popoverCommand) return { ...base, content: null };
    const page = await this.items.runPage(
      workspaceId,
      item,
      item.popoverCommand,
      itemTimeoutMs(item),
      {
        pageKey: `status-popover:${windowKey}:${this.items.scope(workspaceId, item)}:${id}`,
        theme,
        servePage: this.dependencies.servePopoverPage,
      }
    );
    return { ...base, ...page };
  }

  /** Runs one of an item's named commands, for a button in its popover. */
  async runButton(workspaceId: string, id: string, name: string): Promise<StatusButtonRunResult> {
    const result = await this.items.runNamedCommand(workspaceId, id, name);
    if (result.error === undefined) {
      // A run under way began before the command, so the item's next run starts after it.
      const running = this.inFlight.get(this.runKey(workspaceId, id));
      if (running) void this.startRun(workspaceId, id, running);
    }
    return result;
  }
}

const settingsPath = join(getKomlaBasePath(), 'settings');
const statusCommandsPath = join(settingsPath, 'status-items.json');

export const statusCommandsService = new StatusCommandsService({
  ...commandRunnerDependencies(MAX_OUTPUT),
  readFile: () => readSettingsFile(statusCommandsPath, DEFAULT_CONTENT),
  readIcon: (value, pluginDir) => readStatusIcon(pluginDir ?? settingsPath, value),
  servePopoverPage: serveCommandPage,
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
