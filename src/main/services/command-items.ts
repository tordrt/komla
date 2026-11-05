import { homedir } from 'os';

import { z } from 'zod';

import { isBrowserUrl } from '../../shared/lib/browser-tabs';
import { KOMLA_EVENT_LABELS, KOMLA_EVENT_TYPES } from '../../shared/types/komla-events';
import {
  isStatusItemColor,
  MAX_STATUS_BUTTON_LABEL,
  MAX_STATUS_ICON_BYTES,
  MAX_STATUS_ITEM_TOOLTIP,
  MAX_STATUS_POPOVER_BUTTONS,
  MAX_STATUS_POPOVER_MARKDOWN,
  STATUS_ITEM_ID_PATTERN,
  statusCommandScope,
  type StatusButtonRunResult,
  type StatusPopoverButton,
  type StatusPopoverContent,
  type StatusPopoverTheme,
  type StatusTextSegment,
} from '../../shared/types/status-items';
import { ansiSegments } from '../lib/ansi-colors';
import { createLogger } from '../lib/logger';
import { isSettingsIconPath, statusIconDataUrl } from '../lib/status-icon';
import { ANSI_ESCAPE, truncate } from '../lib/status-item-text';

import { htmlPreviewService } from './html-preview.service';
import { pluginEnvironment } from './plugin-environment';
import { buildStatusPopoverPage } from './status-popover-page';
import {
  canRunWorkspaceCommands,
  runLocalCommand,
  runWorkspaceCommand,
  workspaceProjectKeys,
  WorkspaceCommandError,
} from './workspace-command';
import { workspaceService } from './workspace.service';

import type { PluginSource } from './plugins.service';
import type { Workspace } from '../../shared/types/workspace';

/*
 * What status bar items and sidebar panels share: entries in a settings file, and from the plugins
 * that run, whose commands Komla runs where a workspace's files are or on this computer, with
 * buttons that run commands the entry names and pages shown in Komla's sandbox.
 */

const logger = createLogger('CommandItems');

/** How long a button's command may run; buttons can start longer work, such as rerunning CI. */
export const BUTTON_COMMAND_TIMEOUT_MS = 60_000;
/** Named commands per entry; a page shows at most MAX_STATUS_POPOVER_BUTTONS buttons of them. */
export const MAX_NAMED_COMMANDS = 12;

export const ID_MESSAGE = 'ids are up to 40 letters, digits, dots, dashes and underscores';
const COLOR_MESSAGE =
  'iconColor: success, warning, error, info, muted, foreground or a hex color such as #e5c07b';

export const ICON_DESCRIPTION = `SVG markup, an image data URL (SVG, PNG, WebP, GIF or JPEG, up to ${MAX_STATUS_ICON_BYTES / 1024} KB), or a file the user keeps in the settings folder's icons folder, named \`icons/<file>\``;
export const COLOR_DESCRIPTION =
  '`success`, `warning`, `error`, `info`, `muted`, `foreground` or a hex color such as `#e5c07b`';

// The fields both kinds of entry have. Each kind describes them for `komla settings schema`.
export const commandSchema = z.string().trim().min(1).max(16_000);
export const entryIdSchema = z.string().regex(STATUS_ITEM_ID_PATTERN, ID_MESSAGE);
export const intervalSecondsSchema = z.number().int().min(10).max(86_400).default(60);
export const timeoutSecondsSchema = z.number().int().min(1).max(600).optional();
export const runOnSchema = z.enum(['workspace', 'local']).optional();
export const projectsSchema = z.array(z.string().trim().min(1)).min(1).optional();
export const refreshOnSchema = z
  .array(z.enum(KOMLA_EVENT_TYPES))
  .min(1)
  .max(KOMLA_EVENT_TYPES.length)
  .optional();
/** What `refreshOn` can name, for its description. */
export const REFRESH_ON_EVENTS = KOMLA_EVENT_TYPES.map(
  (type) => `\`${type}\` (${KOMLA_EVENT_LABELS[type].toLowerCase()})`
).join(', ');
export const iconColorSchema = z
  .string()
  .refine(isStatusItemColor, { message: COLOR_MESSAGE })
  .optional();
export const iconSchema = z
  .string()
  .trim()
  .refine((icon) => isSettingsIconPath(icon) || statusIconDataUrl(icon) !== undefined, {
    message: `icon: a file in the settings folder's icons folder, such as icons/logo.svg, SVG markup, or an image data URL of at most ${MAX_STATUS_ICON_BYTES / 1024} KB`,
  })
  .optional();
export const namedCommandsSchema = z
  .record(z.string(), commandSchema)
  .refine((commands) => Object.keys(commands).every((name) => STATUS_ITEM_ID_PATTERN.test(name)), {
    message: `command names: ${ID_MESSAGE}`,
  })
  .refine((commands) => Object.keys(commands).length <= MAX_NAMED_COMMANDS, {
    message: `at most ${MAX_NAMED_COMMANDS} commands`,
  })
  .optional();
export const NAMED_COMMANDS_DESCRIPTION = `Up to ${MAX_NAMED_COMMANDS} named commands for the page's buttons, such as \`{"rerun": "gh run rerun --failed"}\`. Komla runs one where the other commands run when its button is clicked, then runs the page again. Like the other commands, they have the \`komla\` CLI.`;

// JSON output starts with `{`; anything else, or JSON that doesn't parse, is text.
export function parseJsonOutput(output: string): unknown {
  if (!output.startsWith('{')) return undefined;
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

const buttonLabelSchema = z.string().trim().min(1).max(MAX_STATUS_BUTTON_LABEL);
const pageButtonSchema = z.union([
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
      .meta({ description: 'One of the `commands` it names, by name, for the button to run.' }),
  }),
]);
const pageOutputSchema = z
  .object({
    markdown: z
      .string()
      .optional()
      .meta({ description: 'Plain Markdown in place of `html`, for a line or two of text.' }),
    html: z.string().optional().meta({
      description:
        "A page shown in a sandbox: inline `<style>` and `<script>` work, but nothing loads from the web and it can't reach Komla. `komla skill integrations` says how to make it match Komla's theme.",
    }),
    buttons: z.array(z.unknown()).optional().catch(undefined),
  })
  .refine((output) => output.markdown !== undefined || output.html !== undefined);

/** A page's buttons as `komla settings schema` shows them; they parse one by one. */
export const pageOutputDescription = pageOutputSchema
  .safeExtend({
    buttons: z
      .array(pageButtonSchema)
      .max(MAX_STATUS_POPOVER_BUTTONS)
      .optional()
      .meta({
        description: `Shown below the page, up to ${MAX_STATUS_POPOVER_BUTTONS}. A button can't carry a command of its own, since output can include text from elsewhere, such as a pull request title.`,
      }),
  })
  .meta({ description: 'A JSON object in place of Markdown output, with `markdown` or `html`.' });

/** A page command's output: Markdown, or HTML for Komla to serve as a sandboxed page. */
export interface ParsedCommandPage {
  markdown: string;
  html?: string;
  terminal?: StatusTextSegment[][];
  buttons: StatusPopoverButton[];
}

/** The most lines of terminal text a page shows; the last ones, as a terminal would. */
const MAX_TERMINAL_LINES = 1000;

/**
 * Text printed for a terminal as lines of colored runs: each line as a carriage return leaves it,
 * without the blank lines around them, keeping the last MAX_TERMINAL_LINES and at most
 * MAX_STATUS_POPOVER_MARKDOWN characters of them.
 */
export function terminalLines(stdout: string): StatusTextSegment[][] {
  const lines = stdout
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1));
  const blank = (line: string) => line.replace(ANSI_ESCAPE, '').trim() === '';
  while (lines.length > 0 && blank(lines[0])) lines.shift();
  while (lines.length > 0 && blank(lines.at(-1)!)) lines.pop();
  const kept: StatusTextSegment[][] = [];
  let length = 0;
  for (const line of lines.slice(-MAX_TERMINAL_LINES).reverse()) {
    const segments = ansiSegments(line);
    length += segments.reduce((sum, segment) => sum + segment.text.length, 0) + 1;
    if (length > MAX_STATUS_POPOVER_MARKDOWN) break;
    kept.push(segments);
  }
  return kept.reverse();
}

/**
 * What a page command's output shows, as a status item's popover or a sidebar panel: a JSON object
 * with `markdown` or `html` and optionally `buttons`, or Markdown. A button that runs a command
 * names one of the entry's `commands`; any other is left out, as are buttons that don't parse.
 */
export function parseCommandPageOutput(
  stdout: string,
  commandNames: readonly string[],
  { terminal = false }: { terminal?: boolean } = {}
): ParsedCommandPage | null {
  const output = stdout.replace(ANSI_ESCAPE, '').trim();
  if (!output) return null;
  const parsed = pageOutputSchema.safeParse(parseJsonOutput(output));
  if (!parsed.success) {
    if (terminal) return { markdown: '', terminal: terminalLines(stdout), buttons: [] };
    return { markdown: truncate(output, MAX_STATUS_POPOVER_MARKDOWN), buttons: [] };
  }
  const buttons = (parsed.data.buttons ?? [])
    .flatMap((button): StatusPopoverButton[] => {
      const valid = pageButtonSchema.safeParse(button);
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

/** Why a command failed, as an item's tooltip or a page says it. */
export function failureMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof WorkspaceCommandError && error.timedOut) {
    return `timed out after ${timeoutMs / 1000} seconds`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message.replace(ANSI_ESCAPE, ''), MAX_STATUS_ITEM_TOOLTIP);
}

/** What every entry has, from its file or a plugin. */
export interface CommandEntry {
  id: string;
  projects?: string[];
  runOn?: 'workspace' | 'local';
  commands?: Record<string, string>;
  plugin?: PluginSource;
}

export interface CommandRunnerDependencies {
  getWorkspace(id: string): Workspace | undefined;
  /** Names of the workspace's project, its id and name, that `projects` can match. */
  getProjectKeys(workspace: Workspace): string[];
  /** False while the workspace can't run commands, as when its SSH host is not connected. */
  canRun(workspace: Workspace): boolean;
  /** Runs the command where the workspace's files are and returns its standard output. */
  run(
    workspace: Workspace,
    command: string,
    timeoutMs: number,
    env?: Record<string, string>
  ): Promise<string>;
  /** Runs the command on this computer, in the user's home folder, for a `runOn: local` entry. */
  runLocal(command: string, timeoutMs: number, env?: Record<string, string>): Promise<string>;
  now(): number;
}

/** Komla's own way to run an entry's commands, keeping at most `maxOutput` of what they print. */
export function commandRunnerDependencies(maxOutput: number): CommandRunnerDependencies {
  return {
    getWorkspace: (id) => workspaceService.get(id),
    getProjectKeys: workspaceProjectKeys,
    canRun: canRunWorkspaceCommands,
    run: (workspace, command, timeoutMs, env) =>
      runWorkspaceCommand(workspace, command, { env, timeoutMs, maxOutput }),
    runLocal: (command, timeoutMs, env) =>
      runLocalCommand(homedir(), command, { env, timeoutMs, maxOutput }),
    now: Date.now,
  };
}

export type RunCommand = (command: string, timeoutMs: number) => Promise<string>;

/**
 * The entries of one settings file, such as status-items.json, with those the plugins that run add
 * after them, and where their commands run. The file's entries win on an id.
 */
export class CommandEntries<Entry extends CommandEntry> {
  private all: Entry[] = [];
  private fileEntries: Entry[] = [];
  private pluginEntries: Entry[] = [];
  private fileProblem: string | undefined;
  private changed = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly fileName: string,
    private readonly readFile: () => string | undefined,
    private readonly parse: (content: string) => { entries: Entry[]; problem?: string },
    private readonly dependencies: CommandRunnerDependencies
  ) {}

  /** Listeners run in the order they were added, after each change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads the file again, as after it changed on disk. */
  reload(): void {
    let content: string | undefined;
    try {
      content = this.readFile();
    } catch (error) {
      logger.warn(`Could not read ${this.fileName}`, error);
      content = undefined;
    }
    const parsed = content === undefined ? { entries: [] } : this.parse(content);
    this.fileEntries = parsed.entries;
    this.fileProblem = parsed.problem;
    if (parsed.problem) logger.warn(parsed.problem);
    this.merge();
  }

  /** The entries of the plugins that run, after the file's. */
  setPluginEntries(entries: (Entry & { plugin: PluginSource })[]): void {
    this.pluginEntries = entries;
    this.merge();
  }

  private merge(): void {
    const ids = new Set(this.fileEntries.map((entry) => entry.id));
    const pluginEntries = this.pluginEntries.filter((entry) => {
      if (!ids.has(entry.id)) return true;
      logger.warn(
        `Leaving out ${entry.id} from plugin ${entry.plugin!.name}: ${this.fileName} has it`
      );
      return false;
    });
    this.all = [...this.fileEntries, ...pluginEntries];
    this.changed = this.dependencies.now();
    for (const listener of this.listeners) listener();
  }

  /** What is wrong with the file, when Komla can't read it. */
  get problem(): string | undefined {
    return this.fileProblem;
  }

  /** When Komla last read the file or the plugins' entries changed. */
  get changedAt(): number {
    return this.changed;
  }

  find(id: string): Entry | undefined {
    return this.all.find((entry) => entry.id === id);
  }

  /** The entries for a workspace's project, or none for a workspace Komla doesn't have. */
  forWorkspace(workspaceId: string): Entry[] {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) return [];
    const keys = this.dependencies.getProjectKeys(workspace);
    return this.all.filter(
      (entry) => !entry.projects || entry.projects.some((name) => keys.includes(name))
    );
  }

  /** Where the entry's runs belong: its workspace, or none for one that runs on this computer. */
  scope(workspaceId: string, entry: Pick<Entry, 'runOn'>): string {
    return statusCommandScope(workspaceId, entry);
  }

  /**
   * Where an entry's commands run, unless they can't run now, as while an SSH host is down. A
   * plugin's commands get its folder, on an SSH host Komla's copy of it there. A plugin's
   * environment is built only when a command runs, as callers also ask only whether one can.
   */
  runner(workspaceId: string, entry: Entry): RunCommand | undefined {
    const { plugin } = entry;
    if (entry.runOn === 'local') {
      return async (command, timeoutMs) =>
        this.dependencies.runLocal(command, timeoutMs, plugin && (await pluginEnvironment(plugin)));
    }
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace || !this.dependencies.canRun(workspace)) return undefined;
    return async (command, timeoutMs) =>
      this.dependencies.run(
        workspace,
        command,
        timeoutMs,
        plugin && (await pluginEnvironment(plugin, workspace, command))
      );
  }

  /** Runs one of an entry's named commands, for a button on its page. */
  async runNamedCommand(
    workspaceId: string,
    id: string,
    name: string
  ): Promise<StatusButtonRunResult> {
    // Only an entry the workspace shows, as its `projects` say.
    const entry = this.forWorkspace(workspaceId).find((each) => each.id === id);
    if (!this.dependencies.getWorkspace(workspaceId)) {
      return { error: `Komla has no workspace ${workspaceId}` };
    }
    if (!entry && this.find(id)) return { error: `This workspace doesn't show ${id}` };
    const command =
      entry?.commands && Object.hasOwn(entry.commands, name) ? entry.commands[name] : undefined;
    if (!entry || !command) {
      const source = entry?.plugin ? `Plugin ${entry.plugin.name}` : this.fileName;
      return { error: `${source} has no command ${name} for ${id}` };
    }
    const run = this.runner(workspaceId, entry);
    if (!run) return { error: "This workspace can't run commands right now" };
    try {
      await run(command, BUTTON_COMMAND_TIMEOUT_MS);
      return {};
    } catch (error) {
      return { error: failureMessage(error, BUTTON_COMMAND_TIMEOUT_MS) };
    }
  }

  /**
   * Runs a command that prints a page, a status item's popover or a sidebar panel, and serves an
   * HTML page in Komla's sandbox in the window's theme, under `pageKey`.
   */
  async runPage(
    workspaceId: string,
    entry: Entry,
    command: string,
    timeoutMs: number,
    serve: {
      pageKey: string;
      theme?: StatusPopoverTheme;
      servePage: ServePage;
      /** Plain output shows as a terminal shows it, rather than as Markdown. */
      terminal?: boolean;
    }
  ): Promise<{ content: StatusPopoverContent | null; error?: string }> {
    const run = this.runner(workspaceId, entry);
    if (!run) return { content: null };
    try {
      const stdout = await run(command, timeoutMs);
      const parsed = parseCommandPageOutput(stdout, Object.keys(entry.commands ?? {}), {
        terminal: serve.terminal,
      });
      if (!parsed?.html) return { content: parsed };
      const htmlUrl = await serve.servePage(
        serve.pageKey,
        buildStatusPopoverPage(parsed.html, serve.theme)
      );
      return { content: { markdown: '', htmlUrl, buttons: parsed.buttons } };
    } catch (error) {
      return { content: null, error: failureMessage(error, timeoutMs) };
    }
  }
}

/**
 * Serves a page in Komla's sandbox. Of the pages before it with this key, only the last stays, as
 * it may be on screen while this one loads.
 */
export type ServePage = (key: string, page: string) => Promise<string>;

/** Serves a command's page in the preview sandbox, replacing the last one with that key. */
export const serveCommandPage: ServePage = (key, page) =>
  htmlPreviewService.createContentPreviewUrl('popover.html', page, { key, fonts: true });
