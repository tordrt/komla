import { join } from 'path';

import { z } from 'zod';

import {
  MAX_SIDEBAR_PANEL_TITLE,
  type SidebarPanel,
  type SidebarPanelList,
  type SidebarPanelResult,
} from '../../shared/types/sidebar-panels';
import { parseSettingsFile, readSettingsFile } from '../lib/settings-file';
import { readStatusIcon } from '../lib/status-icon';

import {
  COLOR_DESCRIPTION,
  commandRunnerDependencies,
  CommandEntries,
  commandSchema,
  entryIdSchema,
  ICON_DESCRIPTION,
  iconColorSchema,
  iconSchema,
  intervalSecondsSchema,
  NAMED_COMMANDS_DESCRIPTION,
  namedCommandsSchema,
  projectsSchema,
  runOnSchema,
  serveCommandPage,
  timeoutSecondsSchema,
  type CommandRunnerDependencies,
  type ServePage,
} from './command-items';
import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';

import type { PluginSource } from './plugins.service';
import type { StatusButtonRunResult, StatusPopoverTheme } from '../../shared/types/status-items';

/** How long a panel's command may run, unless its `timeoutSeconds` says otherwise. */
export const SIDEBAR_PANEL_TIMEOUT_MS = 30_000;
// A panel is a page of its own, larger than a status item's popover.
const MAX_OUTPUT = 512 * 1024;
const MAX_SIDEBAR_PANELS = 20;
const SIDEBAR_PANELS_VERSION = 1;
const DEFAULT_CONTENT = JSON.stringify({ _version: SIDEBAR_PANELS_VERSION, panels: [] }, null, 2);

// The descriptions are what `komla settings schema sidebar-panels` tells agents.
export const sidebarPanelSchema = z
  .object({
    id: entryIdSchema.meta({ description: 'Unique in the file.' }),
    title: z.string().trim().min(1).max(MAX_SIDEBAR_PANEL_TITLE).meta({
      description: "The panel's tab, beside Diff and Files. Keep it to a word or two.",
    }),
    command: commandSchema.meta({
      description:
        "Runs in the user's shell when the panel opens and on each interval while it's open, and prints the panel: a JSON object with an `html` page, as under What `command` prints, or plain Markdown.",
    }),
    intervalSeconds: intervalSecondsSchema.meta({
      description:
        "How often the command runs while the panel is open. It doesn't run while the panel is closed; opening it, or its refresh button, runs it at once.",
    }),
    timeoutSeconds: timeoutSecondsSchema.meta({
      description: `How long the command may run, ${SIDEBAR_PANEL_TIMEOUT_MS / 1000} when left out. Past it, Komla stops the command and says so in the panel.`,
    }),
    runOn: runOnSchema.meta({
      description:
        "`workspace`, the default, runs its commands where the workspace's files are. `local` runs them on this computer in the home folder, even for an SSH workspace, for panels that don't depend on the workspace, such as an account's usage.",
    }),
    projects: projectsSchema.meta({
      description: 'Project names or ids to show it in; every workspace when left out.',
    }),
    icon: iconSchema.meta({ description: `An icon before the tab's title: ${ICON_DESCRIPTION}.` }),
    iconColor: iconColorSchema.meta({
      description: `Shows the icon's shape in a color: ${COLOR_DESCRIPTION}. Without it, the icon keeps its own colors.`,
    }),
    commands: namedCommandsSchema.meta({ description: NAMED_COMMANDS_DESCRIPTION }),
  })
  .strict();

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
  /** A panel's icon as an image; a plugin's icon files are in its folder. */
  readIcon(value: string, pluginDir?: string): Promise<string | undefined>;
  servePage: ServePage;
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

  /** The panels a workspace shows, with their icons read, and any problem reading the file. */
  async list(workspaceId: string): Promise<SidebarPanelList> {
    const panels = await Promise.all(
      this.panels
        .forWorkspace(workspaceId)
        .map(async ({ id, title, icon, iconColor, intervalSeconds, runOn, plugin }) => {
          const image = icon && (await this.dependencies.readIcon(icon, plugin?.dir));
          return {
            id,
            title,
            intervalSeconds,
            ...(image && { icon: image, ...(iconColor && { iconColor }) }),
            ...(runOn === 'local' && { runOn }),
            ...(plugin && { plugin: plugin.name }),
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
    const panel = this.panels.forWorkspace(workspaceId).find((each) => each.id === id);
    const base = { id, workspaceId };
    if (!panel) return { ...base, content: null };
    if (!this.panels.runner(workspaceId, panel)) {
      return { ...base, content: null, error: "This workspace can't run commands right now" };
    }
    const timeoutMs =
      panel.timeoutSeconds === undefined ? SIDEBAR_PANEL_TIMEOUT_MS : panel.timeoutSeconds * 1000;
    const page = await this.panels.runPage(workspaceId, panel, panel.command, timeoutMs, {
      pageKey: `sidebar-panel:${windowKey}:${this.panels.scope(workspaceId, panel)}:${id}`,
      theme,
      servePage: this.dependencies.servePage,
    });
    return { ...base, ...page };
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
  readIcon: (value, pluginDir) => readStatusIcon(pluginDir ?? settingsPath, value),
  servePage: serveCommandPage,
});

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
