import { stat } from 'fs/promises';
import { basename, dirname, join } from 'path';

import { z } from 'zod';

import {
  AGENT_CAPABILITIES,
  type AgentCapabilityId,
} from '../../shared/constants/agent-capabilities';
import {
  MAX_SIDEBAR_PANEL_TITLE,
  RISKY_PANEL_CAPABILITIES,
  type SidebarPanel,
  type SidebarPanelData,
  type SidebarPanelList,
  type SidebarPanelResult,
} from '../../shared/types/sidebar-panels';
import { parseSettingsFile, readSettingsFile } from '../lib/settings-file';
import { ANSI_ESCAPE } from '../lib/status-item-text';

import {
  commandRunnerDependencies,
  CommandEntries,
  commandSchema,
  entryIdSchema,
  failureMessage,
  intervalSecondsSchema,
  NAMED_COMMANDS_DESCRIPTION,
  namedCommandsSchema,
  projectsSchema,
  REFRESH_ON_EVENTS,
  refreshOnSchema,
  runOnSchema,
  serveCommandPage,
  timeoutSecondsSchema,
  type CommandRunnerDependencies,
  type ServePage,
} from './command-items';
import { FileWatcher } from './file-watcher';
import { htmlPreviewService } from './html-preview.service';
import { KOMLA_STYLESHEET } from './komla-page-styles';
import { getKomlaBasePath } from './paths';
import { sidebarPanelPageHead } from './sidebar-panel-page';

import type { PluginSource } from './plugins.service';
import type { StatusButtonRunResult, StatusPopoverTheme } from '../../shared/types/status-items';

/** How long a panel's command may run, unless its `timeoutSeconds` says otherwise. */
export const SIDEBAR_PANEL_TIMEOUT_MS = 30_000;
// A panel is a page of its own, larger than a status item's popover.
const MAX_OUTPUT = 512 * 1024;
const MAX_SIDEBAR_PANELS = 20;
const SIDEBAR_PANELS_VERSION = 1;
const DEFAULT_CONTENT = JSON.stringify({ _version: SIDEBAR_PANELS_VERSION, panels: [] }, null, 2);
// A file or folder in the panels folder; no segment starts with a dot, so none is `..`.
const PAGE_PATH = /^panels(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;
const CAPABILITY_IDS = AGENT_CAPABILITIES.map(({ id }) => id) as [
  AgentCapabilityId,
  ...AgentCapabilityId[],
];

// The descriptions are what `komla settings schema sidebar-panels` tells agents.
export const sidebarPanelSchema = z
  .object({
    id: entryIdSchema.meta({ description: 'Unique in the file.' }),
    title: z.string().trim().min(1).max(MAX_SIDEBAR_PANEL_TITLE).meta({
      description:
        "The panel's tab, beside Diff and Files. Keep it to one short word, as short as theirs where it can be, such as `PRs` rather than `Pull requests`: the sidebar at its narrowest keeps room for the widest tab.",
    }),
    command: commandSchema.optional().meta({
      description:
        "Runs in the user's shell when the panel opens and on each interval while it's open. Without `page`, it prints the panel: a JSON object with an `html` page or `markdown`, as under What `command` prints, or plain text, which shows as a terminal would show it, colors included. With `page`, the page gets what it prints as data: its JSON, or its text. It gets `KOMLA_WORKSPACE_ID`, which the `komla` CLI acts on, `KOMLA_WORKSPACE_NAME`, `KOMLA_BRANCH`, `KOMLA_PROJECT` and `KOMLA_REPO_URL` (the project's origin), unless it runs with `runOn: local`.",
    }),
    page: z
      .string()
      .trim()
      .regex(PAGE_PATH, 'page: a file or folder in the panels folder, such as panels/ci/index.html')
      .optional()
      .meta({
        description:
          "The panel's own page, which loads once and stays: an HTML file, or a folder with an index.html such as a built React app, in the panels folder beside sidebar-panels.json (a plugin's own panels folder for a plugin), named `panels/<path>`. It loads what it needs from its folder, nothing from the web, and reaches Komla through `komla`, as `komla skill integrations` describes.",
      }),
    capabilities: z
      .array(z.enum(CAPABILITY_IDS))
      .max(CAPABILITY_IDS.length)
      .optional()
      .meta({
        description: `What the page may change through \`komla.call\`, beyond reading and showing notifications. Komla asks the user each time before ${RISKY_PANEL_CAPABILITIES.join(', ')}, and only from a click in the page.`,
      }),
    intervalSeconds: intervalSecondsSchema.meta({
      description:
        "How often the command runs while the panel is open. It doesn't run while the panel is closed; opening it, or its refresh button, runs it at once.",
    }),
    timeoutSeconds: timeoutSecondsSchema.meta({
      description: `How long the command may run, ${SIDEBAR_PANEL_TIMEOUT_MS / 1000} when left out. Past it, Komla stops the command and says so in the panel.`,
    }),
    refreshOn: refreshOnSchema.meta({
      description: `Events in the workspace that run the command again at once while the panel is open, besides its interval: ${REFRESH_ON_EVENTS}.`,
    }),
    runOn: runOnSchema.meta({
      description:
        "`workspace`, the default, runs its commands where the workspace's files are. `local` runs them on this computer in the home folder, even for an SSH workspace, for panels that don't depend on the workspace, such as an account's usage. `local-per-workspace` runs them on this computer in the home folder for each workspace, with its variables, for panels about the workspace that need a login or a plugin's secret only this computer has, such as its branch's pull request.",
    }),
    projects: projectsSchema.meta({
      description: 'Project names or ids to show it in; every workspace when left out.',
    }),
    commands: namedCommandsSchema.meta({ description: NAMED_COMMANDS_DESCRIPTION }),
  })
  .strict()
  .refine((panel) => panel.command !== undefined || panel.page !== undefined, {
    message: 'a panel needs a command, a page or both',
  });

export const sidebarPanelsFileSchema = z
  .object({
    _version: z.number().int().optional().meta({ description: "The file's format, 1." }),
    panels: z
      .array(sidebarPanelSchema)
      .max(MAX_SIDEBAR_PANELS)
      .refine((panels) => new Set(panels.map((panel) => panel.id)).size === panels.length, {
        message: 'each panel needs its own id',
      }),
  })
  .strict()
  .meta({
    description:
      "Panels in the workspace sidebar, as tabs beside Diff and Files, whose page comes from a command. Apply the whole file: keep every panel the user didn't ask to change. If Komla can't read the file, the sidebar says what's wrong.",
  });

export type ConfiguredSidebarPanel = z.infer<typeof sidebarPanelSchema>;
export type PluginSidebarPanel = ConfiguredSidebarPanel & { plugin: PluginSource };

/** Reads sidebar-panels.json; a problem names what is wrong with the file instead. */
export function parseSidebarPanelsFile(content: string): {
  panels: ConfiguredSidebarPanel[];
  problem?: string;
} {
  const parsed = parseSettingsFile('sidebar-panels.json', content, sidebarPanelsFileSchema);
  return 'problem' in parsed ? { panels: [], problem: parsed.problem } : parsed.value;
}

export interface SidebarPanelsDependencies extends CommandRunnerDependencies {
  readFile(): string | undefined;
  servePage: ServePage;
  /**
   * Where a panel's own page is: the folder it may load from and its HTML file in it, unless it
   * isn't there. A plugin's page is in its folder.
   */
  findPage(page: string, pluginDir?: string): Promise<{ root: string; entry: string } | undefined>;
  /** Serves a panel's own page in the window's theme, replacing the last one with that key. */
  servePanelPage(
    key: string,
    page: { root: string; entry: string },
    theme: StatusPopoverTheme | undefined
  ): Promise<string>;
}

/** A command's output as a page's data: its JSON, or its text without terminal colors. */
export function panelData(stdout: string): unknown {
  const output = stdout.replace(ANSI_ESCAPE, '').trim();
  if (/^[[{"]/.test(output)) {
    try {
      return JSON.parse(output) as unknown;
    } catch {
      // Text, then.
    }
  }
  return output;
}

/** A panel from sidebar-panels.json, or from a plugin that runs. */
type SidebarPanelEntry = ConfiguredSidebarPanel & { plugin?: PluginSource };

/**
 * The sidebar panels users and agents define in sidebar-panels.json, and plugins add: pages a
 * command prints, which Komla runs in the open workspace, or on this computer, while the panel is
 * open. They share status bar items' commands and pages: the same fields, sandbox and buttons.
 */
export class SidebarPanelsService {
  private readonly panels: CommandEntries<SidebarPanelEntry>;

  constructor(private readonly dependencies: SidebarPanelsDependencies) {
    this.panels = new CommandEntries(
      'sidebar-panels.json',
      () => dependencies.readFile(),
      (content) => {
        const { panels, problem } = parseSidebarPanelsFile(content);
        return { entries: panels, ...(problem && { problem }) };
      },
      dependencies
    );
  }

  onChange(listener: () => void): () => void {
    return this.panels.onChange(listener);
  }

  /** Reads the file again, as after it changed on disk. */
  reload(): void {
    this.panels.reload();
  }

  /** The panels of the plugins that run, after sidebar-panels.json's, which win on an id. */
  setPluginPanels(panels: PluginSidebarPanel[]): void {
    this.panels.setPluginEntries(panels);
  }

  /** The panels a workspace shows, and any problem reading the file. */
  async list(workspaceId: string): Promise<SidebarPanelList> {
    const panels = await Promise.all(
      this.panels
        .forWorkspace(workspaceId)
        .map(async ({ id, title, intervalSeconds, runOn, plugin, page, command, refreshOn }) => {
          return {
            id,
            title,
            intervalSeconds,
            ...(page && { page: true as const, ...(command && { command: true as const }) }),
            ...(runOn === 'local' && { runOn }),
            ...(command && refreshOn && { refreshOn }),
            ...(plugin && { plugin: plugin.name, pluginId: plugin.id }),
            ...(page && plugin?.revision && { revision: plugin.revision }),
            ...(plugin?.development && { development: true as const }),
          } satisfies SidebarPanel;
        })
    );
    const { problem } = this.panels;
    return { panels, ...(problem && { problem }) };
  }

  /**
   * Runs a panel's command for a workspace and shows what it prints; an HTML page takes the
   * window's theme. Each window has pages of its own, so one showing the panel doesn't replace the
   * page another shows.
   */
  async run(
    workspaceId: string,
    id: string,
    theme?: StatusPopoverTheme,
    windowKey = ''
  ): Promise<SidebarPanelResult> {
    const panel = this.find(workspaceId, id);
    const base = { id, workspaceId };
    if (!panel?.command) return { ...base, content: null };
    if (!this.panels.runner(workspaceId, panel)) {
      return { ...base, content: null, error: "This workspace can't run commands right now" };
    }
    const page = await this.panels.runPage(
      workspaceId,
      panel,
      panel.command,
      this.timeoutMs(panel),
      {
        pageKey: `sidebar-panel:${windowKey}:${this.panels.scope(workspaceId, panel)}:${id}`,
        theme,
        servePage: this.dependencies.servePage,
        terminal: true,
      }
    );
    return { ...base, ...page };
  }

  /** A panel the workspace shows. */
  find(workspaceId: string, id: string): SidebarPanelEntry | undefined {
    return this.panels.forWorkspace(workspaceId).find((each) => each.id === id);
  }

  /**
   * Where a panel's posted data belongs in a workspace: the workspace, or '' for every
   * one, as for a panel that runs on this computer or without a workspace.
   */
  scope(id: string, workspaceId: string | undefined): string {
    const panel = this.panels.find(id);
    return workspaceId && panel ? this.panels.scope(workspaceId, panel) : '';
  }

  private timeoutMs(panel: SidebarPanelEntry): number {
    return panel.timeoutSeconds === undefined
      ? SIDEBAR_PANEL_TIMEOUT_MS
      : panel.timeoutSeconds * 1000;
  }

  /**
   * Serves a panel's own page for a window, in its theme. A window has a page of its own for each
   * panel and workspace, which stays loaded while the panel shows; `komla` brings it its data.
   */
  async pageUrl(
    workspaceId: string,
    id: string,
    theme?: StatusPopoverTheme,
    windowKey = ''
  ): Promise<{ url?: string; error?: string }> {
    const panel = this.find(workspaceId, id);
    if (!panel?.page) return {};
    const where = panel.plugin ? `the plugin ${panel.plugin.name}'s folder` : 'the settings folder';
    const page = await this.dependencies.findPage(panel.page, panel.plugin?.dir);
    if (!page) return { error: `${panel.page} isn't in ${where}` };
    try {
      const url = await this.dependencies.servePanelPage(
        `sidebar-panel-page:${windowKey}:${workspaceId}:${id}`,
        page,
        theme
      );
      return { url };
    } catch (error) {
      return { error: failureMessage(error, 0) };
    }
  }

  /** Runs a page panel's command, for its page's data. */
  async runData(workspaceId: string, id: string): Promise<SidebarPanelData> {
    const panel = this.find(workspaceId, id);
    if (!panel?.command) return {};
    const run = this.panels.runner(workspaceId, panel);
    if (!run) return { error: "This workspace can't run commands right now" };
    const timeoutMs = this.timeoutMs(panel);
    try {
      return { data: panelData(await run(panel.command, timeoutMs)) };
    } catch (error) {
      return { error: failureMessage(error, timeoutMs) };
    }
  }

  /** Runs one of a panel's named commands, for a button on its page. */
  runButton(workspaceId: string, id: string, name: string): Promise<StatusButtonRunResult> {
    return this.panels.runNamedCommand(workspaceId, id, name);
  }
}

const settingsPath = join(getKomlaBasePath(), 'settings');
const sidebarPanelsPath = join(settingsPath, 'sidebar-panels.json');

export const sidebarPanelsService = new SidebarPanelsService({
  ...commandRunnerDependencies(MAX_OUTPUT),
  readFile: () => readSettingsFile(sidebarPanelsPath, DEFAULT_CONTENT),
  servePage: serveCommandPage,
  findPage: (page, pluginDir) => findPanelPage(join(pluginDir ?? settingsPath, page)),
  servePanelPage: (key, { root, entry }, theme) =>
    htmlPreviewService.createPanelPageUrl(root, entry, {
      key,
      head: sidebarPanelPageHead(theme),
      stylesheet: KOMLA_STYLESHEET,
    }),
});

/** A page's folder and its HTML file: a folder's index.html, or an HTML file in its folder. */
export async function findPanelPage(
  path: string
): Promise<{ root: string; entry: string } | undefined> {
  try {
    const found = await stat(path);
    if (found.isDirectory()) {
      return (await stat(join(path, 'index.html'))).isFile()
        ? { root: path, entry: 'index.html' }
        : undefined;
    }
    return found.isFile() && /\.html?$/i.test(path)
      ? { root: dirname(path), entry: basename(path) }
      : undefined;
  } catch {
    return undefined;
  }
}

let watcher: FileWatcher | null = null;

/** Follows changes to sidebar-panels.json, so edits show without a restart. */
export async function watchSidebarPanels(): Promise<void> {
  if (watcher) return;
  sidebarPanelsService.reload();
  watcher = new FileWatcher(sidebarPanelsPath, () => sidebarPanelsService.reload());
  await watcher.start();
}

export async function stopWatchingSidebarPanels(): Promise<void> {
  await watcher?.stop();
  watcher = null;
}
