import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { lstat, readdir, readFile, realpath, stat } from 'fs/promises';
import { join, posix, relative, sep } from 'path';

import * as parcelWatcher from '@parcel/watcher';
import { z } from 'zod';

import { HOOK_EVENT_LABELS } from '../../shared/types/hooks';
import { KOMLA_EVENT_LABELS, type KomlaEventType } from '../../shared/types/komla-events';
import {
  PLUGIN_ID_PATTERN,
  type PluginContributionInfo,
  type PluginInfo,
  MAX_PLUGIN_SETTINGS,
  type PluginSettingField,
  type PluginState,
} from '../../shared/types/plugins';
import { STATUS_ITEM_ID_PATTERN } from '../../shared/types/status-items';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';
import { parseSettingsFile } from '../lib/settings-file';

import { FileWatcher } from './file-watcher';
import { hookSchema, hooksService, type Hook } from './hooks.service';
import { getKomlaBasePath } from './paths';
import { pluginSettingFieldSchema } from './plugin-settings';
import {
  sidebarPanelSchema,
  sidebarPanelsService,
  type ConfiguredSidebarPanel,
  type PluginSidebarPanel,
} from './sidebar-panels.service';
import {
  statusCommandSchema,
  statusCommandsService,
  type ConfiguredStatusCommand,
} from './status-commands.service';

import type { HostedPlugin } from './plugin-host.service';
import type { TarEntry } from '../lib/tar-archive';

const logger = createLogger('PluginsService');

export const PLUGIN_MANIFEST = 'komla-plugin.json';
const NO_MANIFEST = `has no ${PLUGIN_MANIFEST}`;
const PLUGINS_FILE = 'plugins.json';
const FILE_VERSION = 1;
export const MAX_PLUGINS = 100;
const MAX_STATUS_ITEMS = 10;
const MAX_HOOKS = 20;
const MAX_SIDEBAR_PANELS = 5;
/** A plugin's files Komla reads to tell when they change; past these, it doesn't run it. */
const MAX_PLUGIN_FILES = 5000;
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
// A module in the plugin's folder; no segment starts with a dot, so none is `..`.
const MAIN_PATH =
  /^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.(m?js|m?ts)$/;

// The descriptions are what `komla settings schema plugins` tells agents.
export const pluginManifestSchema = z
  .object({
    _version: z.number().int().optional().meta({ description: "The file's format, 1." }),
    id: z
      .string()
      .regex(PLUGIN_ID_PATTERN, 'ids are up to 24 lowercase letters, digits and dashes')
      .meta({
        description:
          'Unique among the plugins, up to 24 lowercase letters, digits and dashes. Each item and hook gets it before its own id, as `<plugin>.<id>`.',
      }),
    name: z.string().trim().min(1).max(60).meta({ description: 'Shown in Settings.' }),
    version: z.string().trim().min(1).max(40).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    main: z
      .string()
      .trim()
      .regex(
        MAIN_PATH,
        "main: a .js, .mjs, .ts or .mts file in the plugin's folder, such as main.ts"
      )
      .optional()
      .meta({
        description:
          "The plugin's code: a JavaScript or TypeScript module in its folder, such as `main.ts`, which Komla runs without a build step in a process of its own while the plugin is on, and calls as `activate(komla)`. `komla` calls Komla Operations, follows events, runs commands in a workspace, and gives the plugin's panels data, as `komla skill integrations` describes. For an integration that keeps state, or feeds a panel and a status item from one query.",
      }),
    settings: z.array(pluginSettingFieldSchema).max(MAX_PLUGIN_SETTINGS).optional().meta({
      description:
        "What the user fills in in Settings → Plugins for the plugin, such as a repository, an API's URL or a token. Its code gets them as `komla.settings.get()`, and its commands as `KOMLA_SETTING_<ID>`: on an SSH host, all but its secrets. Agents can't read or set secrets, so tell the user to enter them there.",
    }),
    contributes: z
      .object({
        statusItems: z
          .array(statusCommandSchema)
          .max(MAX_STATUS_ITEMS)
          .optional()
          .meta({ description: 'Status bar items, as in status-items.json.' }),
        hooks: z
          .array(hookSchema)
          .max(MAX_HOOKS)
          .optional()
          .meta({ description: 'Hooks, as in hooks.json.' }),
        sidebarPanels: z
          .array(sidebarPanelSchema)
          .max(MAX_SIDEBAR_PANELS)
          .optional()
          .meta({ description: 'Sidebar panels, as in sidebar-panels.json.' }),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const { statusItems = [], hooks = [], sidebarPanels = [] } = manifest.contributes;
    (manifest.settings ?? []).forEach((field, index, fields) => {
      if (fields.findIndex((other) => other.id === field.id) < index) {
        context.addIssue({
          code: 'custom',
          path: ['settings', index, 'id'],
          message: `${field.id} is already in the list`,
        });
      }
    });
    if (statusItems.length + hooks.length + sidebarPanels.length === 0 && !manifest.main) {
      context.addIssue({ code: 'custom', path: ['contributes'], message: 'adds nothing' });
    }
    statusItems.forEach((item, index) => {
      if (item.panel && !sidebarPanels.some((panel) => panel.id === item.panel)) {
        context.addIssue({
          code: 'custom',
          path: ['contributes', 'statusItems', index, 'panel'],
          message: `the plugin has no sidebar panel ${item.panel}`,
        });
      }
    });
    for (const [key, entries] of [
      ['statusItems', statusItems],
      ['hooks', hooks],
      ['sidebarPanels', sidebarPanels],
    ] as const) {
      entries.forEach((entry, index) => {
        if (entries.findIndex((other) => other.id === entry.id) < index) {
          context.addIssue({
            code: 'custom',
            path: ['contributes', key, index, 'id'],
            message: `${entry.id} is already in the list`,
          });
        } else if (!STATUS_ITEM_ID_PATTERN.test(`${manifest.id}.${entry.id}`)) {
          context.addIssue({
            code: 'custom',
            path: ['contributes', key, index, 'id'],
            message: `${manifest.id}.${entry.id} is longer than 40 characters`,
          });
        }
      });
    }
  })
  .meta({
    description: `A plugin's \`${PLUGIN_MANIFEST}\`, in its own folder in the plugins folder. Its commands get \`KOMLA_PLUGIN_DIR\`, the plugin's folder, when they run on this computer; an SSH workspace's run on its host, where that folder isn't. Its items' \`icons/<file>\` are in the plugin's folder. Keep state outside that folder: any change to its files stops the plugin. Its links must lead to files in its folder, and the folder itself can't be a link.`,
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

const pluginsFileSchema = z
  .object({
    _version: z.number().int().optional(),
    enabled: z
      .array(
        z
          .object({ id: z.string(), digest: z.string(), development: z.literal(true).optional() })
          .strict()
      )
      .max(MAX_PLUGINS),
  })
  .strict();

/** Where a plugin's item or hook comes from, for its commands and for messages. */
export interface PluginSource {
  id: string;
  name: string;
  /** The plugin's folder, which its commands get as `KOMLA_PLUGIN_DIR`. */
  dir: string;
  /** Changes with its files, so its panels' pages load again. */
  revision?: string;
  /** It runs as its files change, as while the user writes it. */
  development?: true;
}

export type PluginStatusCommand = ConfiguredStatusCommand & { plugin: PluginSource };
export type PluginHook = Hook & { plugin: PluginSource };

interface ScannedPlugin {
  folder: string;
  dir: string;
  manifest?: PluginManifest;
  /** The manifest's JSON as the file has it, without the defaults Komla fills in. */
  written?: unknown;
  /** A digest of every file in the folder but `.git`'s, which changes when any of them does. */
  digest?: string;
  /** The same of every file but the manifest, which an approval of a new manifest pins. */
  otherFiles?: string;
  problem?: string;
  /** Why the folder can't run whatever its manifest says, such as it being a link. */
  folderProblem?: string;
}

/** `otherFiles` of a folder with only a manifest, as a new plugin's is. */
export const NO_OTHER_FILES = createHash('sha256').digest('hex');

/** A plugin as `list()` has it, with what writing its manifest needs. */
export interface PluginFolder extends PluginInfo {
  folderProblem?: string;
  /** Whether it has a komla-plugin.json Komla could read, so writing one changes a plugin. */
  hasManifest: boolean;
  manifest?: PluginManifest;
  written?: unknown;
  otherFiles?: string;
}

class PluginFolderError extends Error {}

/**
 * Where the link leads, relative to the folder; throws unless that's a file the digest has, in
 * the folder and not in its `.git`.
 */
async function linkTarget(root: string, path: string, relativePath: string): Promise<string> {
  const target = await realpath(path).catch(() => undefined);
  if (target === undefined) {
    throw new PluginFolderError(`has a link, ${relativePath}, to a file that isn't there`);
  }
  const inFolder = relative(root, target).split(sep).join('/');
  if (
    (target !== root && !target.startsWith(root + sep)) ||
    inFolder === '.git' ||
    inFolder.startsWith('.git/')
  ) {
    throw new PluginFolderError(`has a link, ${relativePath}, to outside its folder`);
  }
  return inFolder;
}

/** A link in a copy of a folder, to `target`, its path in the folder, relative to the link. */
function linkEntry(relativePath: string, target: string): TarEntry {
  // A link to the folder itself leads to `.`, not nowhere.
  const relativeTarget = posix.relative(posix.dirname(relativePath), target) || '.';
  return { kind: 'link', path: relativePath, target: relativeTarget };
}

/** Windows has no executable bit; a script there is one that names its interpreter. */
function isExecutable(content: Buffer, mode: number): boolean {
  return process.platform === 'win32'
    ? content.subarray(0, 2).toString() === '#!'
    : (mode & 0o100) !== 0;
}

/**
 * A digest of a folder's files, their paths and contents, without `.git`, with the content of the
 * file `keep` names as it hashed it. Komla follows only changes to the plugins folder, so a link
 * that leads out of the folder throws, rather than letting a plugin run files it doesn't see.
 */
export async function digestFolder(
  dir: string,
  keep?: string,
  /** Gets each entry the digest has, with its content, as a copy of the folder would. */
  collect?: (entry: TarEntry) => void
): Promise<{ digest: string; kept?: Buffer; others: string }> {
  const hash = createHash('sha256');
  // Every file but `keep`, so a change to `keep` alone can be told apart from the rest.
  const others = createHash('sha256');
  const update = (relativePath: string, data: string | Buffer) => {
    hash.update(data);
    if (relativePath !== keep) others.update(data);
  };
  const root = await realpath(dir);
  let kept: Buffer | undefined;
  let files = 0;
  let bytes = 0;
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(dir, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (relativePath === '.git') continue;
      const path = join(dir, relativePath);
      if (++files > MAX_PLUGIN_FILES) {
        throw new PluginFolderError(`has more than ${MAX_PLUGIN_FILES} files and folders`);
      }
      if (entry.isDirectory()) {
        update(relativePath, `d\0${relativePath}\0`);
        collect?.({ kind: 'directory', path: relativePath });
        await walk(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await linkTarget(root, path, relativePath);
        update(relativePath, `l\0${relativePath}\0${target}\0`);
        collect?.(linkEntry(relativePath, target));
        // Its target is one of the folder's own files, which the digest has as well.
        if (relativePath === keep) kept = await readFile(join(root, target));
        continue;
      }
      if (!entry.isFile()) continue;
      // Before reading it, so one huge file isn't read only to be refused.
      const { size, mode } = await lstat(path);
      bytes += size;
      if (bytes > MAX_PLUGIN_BYTES) {
        throw new PluginFolderError(`is larger than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB`);
      }
      const content = await readFile(path);
      if (relativePath === keep) kept = content;
      update(relativePath, `f\0${relativePath}\0${content.length}\0`);
      update(relativePath, content);
      collect?.({
        kind: 'file',
        path: relativePath,
        content,
        executable: isExecutable(content, mode),
      });
    }
  };
  await walk('');
  return { digest: hash.digest('hex'), ...(kept && { kept }), others: others.digest('hex') };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether there's a file or link by that name, without following the link. */
const isFile = (path: string) =>
  lstat(path).then(
    (stats) => !stats.isDirectory(),
    () => false
  );

const parseManifest = (content: string) =>
  parseSettingsFile(PLUGIN_MANIFEST, content, pluginManifestSchema);

async function scanPlugin(folder: string, dir: string, isLink: boolean): Promise<ScannedPlugin> {
  if (isLink) {
    // Komla follows changes only to the plugins folder, so it can't tell when one elsewhere does.
    const problem = 'is a link. Copy or clone the plugin into the plugins folder';
    return { folder, dir, problem, folderProblem: problem };
  }
  let hashed;
  try {
    hashed = await digestFolder(dir, PLUGIN_MANIFEST);
  } catch (error) {
    const folderProblem = errorMessage(error);
    const problem = (await isFile(join(dir, PLUGIN_MANIFEST))) ? folderProblem : NO_MANIFEST;
    return { folder, dir, problem, folderProblem };
  }
  // The manifest as the digest has it, so what runs is what the user turned on. A folder with
  // only scripts so far has its files read too, so a manifest written into it pins them.
  const files = { folder, dir, otherFiles: hashed.others };
  if (!hashed.kept) return { ...files, problem: NO_MANIFEST };
  const parsed = parseManifest(hashed.kept.toString('utf-8'));
  if ('problem' in parsed) return { ...files, problem: parsed.problem };
  return { ...files, manifest: parsed.value, written: parsed.raw, digest: hashed.digest };
}

function statusItemInfo(pluginId: string, item: ConfiguredStatusCommand): PluginContributionInfo {
  const moreCommands = [
    ...(item.popoverCommand
      ? [{ label: 'Popover command, run on click', command: item.popoverCommand }]
      : []),
    ...buttonCommands(item.commands),
  ];
  return {
    kind: 'status-item',
    id: `${pluginId}.${item.id}`,
    title: item.label ?? item.id,
    command: item.command,
    when: `Every ${item.intervalSeconds} seconds${refreshOnText(item.refreshOn)}`,
    ...(item.runOn === 'local' && { runOn: 'local' as const }),
    ...(moreCommands.length > 0 && { moreCommands }),
  };
}

/** The events an entry runs again on, after when else it runs, as Settings says it. */
function refreshOnText(events: KomlaEventType[] | undefined): string {
  if (!events?.length) return '';
  return `, and at once when ${events.map((event) => KOMLA_EVENT_LABELS[event].replace(/^An? |^The /, (word) => word.toLowerCase())).join(', or ')}`;
}

/** A page's button commands, as Settings lists them with an item's or panel's command. */
function buttonCommands(commands: Record<string, string> | undefined) {
  return Object.entries(commands ?? {}).map(([name, command]) => ({
    label: `Button command ${name}`,
    command,
  }));
}

function sidebarPanelInfo(pluginId: string, panel: ConfiguredSidebarPanel): PluginContributionInfo {
  const moreCommands = buttonCommands(panel.commands);
  return {
    kind: 'sidebar-panel',
    id: `${pluginId}.${panel.id}`,
    title: panel.title,
    ...(panel.command && { command: panel.command }),
    ...(panel.page && { page: panel.page }),
    ...(panel.capabilities?.length && { capabilities: panel.capabilities }),
    when: panel.command
      ? `Every ${panel.intervalSeconds} seconds while the panel is open${refreshOnText(panel.refreshOn)}`
      : 'While the panel is open',
    ...(panel.runOn === 'local' && { runOn: 'local' as const }),
    ...(moreCommands.length > 0 && { moreCommands }),
  };
}

function hookInfo(pluginId: string, hook: Hook): PluginContributionInfo {
  return {
    kind: 'hook',
    id: `${pluginId}.${hook.id}`,
    title: hook.id,
    command: hook.command,
    when:
      hook.event === 'interval'
        ? `Every ${hook.intervalSeconds} seconds, ${hook.runOn === 'local' ? 'once' : 'in each workspace'}`
        : HOOK_EVENT_LABELS[hook.event],
    ...(hook.runOn === 'local' && { runOn: 'local' as const }),
  };
}

/** A plugin's items, hooks and panels, each as Settings lists it and as the manifest has it. */
export function contributionEntries(manifest: PluginManifest): {
  info: PluginContributionInfo;
  entry: ConfiguredStatusCommand | Hook | ConfiguredSidebarPanel;
}[] {
  return [
    ...(manifest.contributes.statusItems ?? []).map((item) => ({
      info: statusItemInfo(manifest.id, item),
      entry: item,
    })),
    ...(manifest.contributes.hooks ?? []).map((hook) => ({
      info: hookInfo(manifest.id, hook),
      entry: hook,
    })),
    ...(manifest.contributes.sidebarPanels ?? []).map((panel) => ({
      info: sidebarPanelInfo(manifest.id, panel),
      entry: panel,
    })),
  ];
}

function contributionsOf(manifest: PluginManifest): PluginContributionInfo[] {
  return contributionEntries(manifest).map(({ info }) => info);
}

/**
 * The plugins in Komla's plugins folder: folders whose komla-plugin.json adds status bar items,
 * hooks and sidebar panels. A plugin runs while it is turned on and its files are as they were then; plugins.json
 * keeps a digest of them for each plugin the user turned on.
 */
export class PluginsService {
  private scanned: ScannedPlugin[] = [];
  /** The plugins the user turned on: the digest of the files they saw, and whether in development. */
  private enabled = new Map<string, { digest: string; development?: true }>();
  private scanning: Promise<void> | undefined;
  private rescan = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly pluginsPath: string,
    private readonly settingsPath: string
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads every plugin's folder again; a scan asked for during one runs after it. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      const before = this.revision();
      do {
        this.rescan = false;
        this.scanned = await this.scanFolders();
      } while (this.rescan);
      this.readSettings();
      // Listeners run their items and hooks again, so only a change tells them.
      if (this.revision() !== before) this.emit();
    })().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  /** Reads plugins.json again, as after it changed on disk. */
  reloadSettings(): void {
    const before = this.revision();
    this.readSettings();
    if (this.revision() !== before) this.emit();
  }

  list(): PluginInfo[] {
    return this.folders().map(
      ({
        folderProblem: _p,
        hasManifest: _h,
        manifest: _m,
        written: _w,
        otherFiles: _o,
        ...info
      }) => info
    );
  }

  /** Every plugin, as `list()` has them, with what writing its manifest needs. */
  folders(): PluginFolder[] {
    return this.plugins().map(({ scanned, state, problem, development }) => ({
      id: scanned.manifest?.id ?? scanned.folder,
      name: scanned.manifest?.name ?? scanned.folder,
      ...(scanned.manifest?.version && { version: scanned.manifest.version }),
      ...(scanned.manifest?.description && { description: scanned.manifest.description }),
      ...(scanned.manifest?.main && { main: scanned.manifest.main }),
      folder: scanned.folder,
      state,
      ...(development && { development }),
      ...(problem && { problem }),
      ...(scanned.digest && { digest: scanned.digest }),
      contributions: scanned.manifest ? contributionsOf(scanned.manifest) : [],
      ...(scanned.manifest?.settings && { settings: scanned.manifest.settings }),
      ...(scanned.folderProblem && { folderProblem: scanned.folderProblem }),
      hasManifest: scanned.problem !== NO_MANIFEST,
      ...(scanned.manifest && { manifest: scanned.manifest, written: scanned.written }),
      ...(scanned.otherFiles && { otherFiles: scanned.otherFiles }),
    }));
  }

  /** The settings a plugin declares, by its id; none for a plugin Komla can't read. */
  settingFields(id: string): PluginSettingField[] {
    return (
      this.plugins().find((plugin) => plugin.id === id && plugin.state !== 'invalid')?.scanned
        .manifest?.settings ?? []
    );
  }

  /** The status bar items of the plugins that run, with their ids as `<plugin>.<id>`. */
  statusItems(): PluginStatusCommand[] {
    return this.running().flatMap(({ manifest, source }) =>
      (manifest.contributes.statusItems ?? []).map((item) => ({
        ...item,
        id: `${manifest.id}.${item.id}`,
        plugin: source,
      }))
    );
  }

  /** The sidebar panels of the plugins that run, with their ids as `<plugin>.<id>`. */
  sidebarPanels(): PluginSidebarPanel[] {
    return this.running().flatMap(({ manifest, source }) =>
      (manifest.contributes.sidebarPanels ?? []).map((panel) => ({
        ...panel,
        id: `${manifest.id}.${panel.id}`,
        plugin: source,
      }))
    );
  }

  /** The hooks of the plugins that run, with their ids as `<plugin>.<id>`. */
  hooks(): PluginHook[] {
    return this.running().flatMap(({ manifest, source }) =>
      (manifest.contributes.hooks ?? []).map((hook) => ({
        ...hook,
        id: `${manifest.id}.${hook.id}`,
        plugin: source,
      }))
    );
  }

  /**
   * What the plugins folder has by this name, told apart regardless of case as some file systems
   * don't: a folder, a file or a link.
   */
  takenName(name: string): string | undefined {
    try {
      return readdirSync(this.pluginsPath).find(
        (each) => each.toLowerCase() === name.toLowerCase()
      );
    } catch {
      return undefined;
    }
  }

  /** The digest of a plugin folder's files but its manifest, as they are now. */
  async otherFilesOf(folder: string): Promise<string> {
    return (await digestFolder(join(this.pluginsPath, folder), PLUGIN_MANIFEST)).others;
  }

  /**
   * Writes a plugin's komla-plugin.json into its folder in the plugins folder, making the folder
   * if it's new. The plugin's state follows once Komla reads the folder again.
   */
  writeManifest(folder: string, manifest: unknown): void {
    const dir = join(this.pluginsPath, folder);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw new Error(`The plugin folder ${folder} is a link, so Komla doesn't write into it`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(join(dir, PLUGIN_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /** Changes whenever plugins.json or a plugin's files do, as Komla last read them. */
  revision(): string {
    return createHash('sha256')
      .update(JSON.stringify([this.readSettingsContent() ?? null, this.list()]))
      .digest('hex');
  }

  /**
   * Turns plugins on, each with the digest of the files the user saw, or off with `false`. A
   * plugin Komla can't read, or whose files changed since, can't be turned on.
   */
  setEnabled(changes: Record<string, string | false>): void {
    const plugins = this.plugins();
    const enabled = new Map(this.enabled);
    for (const [id, digest] of Object.entries(changes)) {
      // Of plugins with one id, the one that can run, if any.
      const plugin =
        plugins.find((other) => other.id === id && other.state !== 'invalid') ??
        plugins.find((other) => other.id === id);
      if (!plugin) throw new Error(`There is no plugin ${id}`);
      if (digest === false) {
        enabled.delete(id);
        continue;
      }
      if (plugin.state === 'invalid' || !plugin.scanned.digest) {
        throw new Error(`Plugin ${id} ${plugin.problem ?? "can't be read"}`);
      }
      if (plugin.scanned.digest !== digest) {
        throw new Error(
          `Plugin ${id}'s files changed. Look at its commands again, then turn it on.`
        );
      }
      enabled.set(id, { digest, ...(this.enabled.get(id)?.development && { development: true }) });
    }
    this.writeSettings(enabled);
  }

  /**
   * Deletes a plugin's folder with `trash`, which moves it to the computer's trash, and forgets
   * it was on unless another folder has its id. Resolves with the id it forgot, whose settings
   * the caller forgets too.
   */
  async remove(folder: string, trash: (dir: string) => Promise<void>): Promise<string | undefined> {
    // Only a folder the plugins folder lists, so a name can't lead out of it.
    const plugin = this.plugins().find((each) => each.scanned.folder === folder);
    if (!plugin) throw new Error(`There is no plugin folder ${folder}`);
    await trash(plugin.scanned.dir);
    await this.scan();
    if (this.plugins().some((each) => each.id === plugin.id)) return undefined;
    if (this.enabled.has(plugin.id)) {
      const enabled = new Map(this.enabled);
      enabled.delete(plugin.id);
      this.writeSettings(enabled);
    }
    return plugin.id;
  }

  /**
   * Runs a plugin that is on as its files change, without the user turning it on again, or, with
   * false, only as they were when the user turned it on. For a plugin the user is writing.
   */
  setDevelopment(id: string, development: boolean): void {
    const current = this.enabled.get(id);
    if (!current) throw new Error(`Plugin ${id} isn't on`);
    const plugin = this.plugins().find((other) => other.id === id && other.state !== 'invalid');
    const enabled = new Map(this.enabled);
    enabled.set(
      id,
      development
        ? { ...current, development: true }
        : // Turning it off keeps it on as its files are now, which the user just ran.
          { digest: plugin?.scanned.digest ?? current.digest }
    );
    this.writeSettings(enabled);
  }

  private writeSettings(enabled: Map<string, { digest: string; development?: true }>): void {
    const content = {
      _version: FILE_VERSION,
      enabled: [...enabled].map(([id, { digest, development }]) => ({
        id,
        digest,
        ...(development && { development }),
      })),
    };
    mkdirSync(this.settingsPath, { recursive: true });
    writeFileAtomicSync(this.settingsFilePath(), `${JSON.stringify(content, null, 2)}\n`);
    this.reloadSettings();
  }

  private plugins(): {
    id: string;
    scanned: ScannedPlugin;
    state: PluginState;
    problem?: string;
    development?: true;
  }[] {
    const seen = new Map<string, string>();
    return this.scanned.map((scanned) => {
      const id = scanned.manifest?.id ?? scanned.folder;
      if (!scanned.manifest || scanned.problem) {
        return { id, scanned, state: 'invalid', problem: scanned.problem };
      }
      const other = seen.get(id);
      if (other !== undefined) {
        return {
          id,
          scanned,
          state: 'invalid',
          problem: `has the id ${id}, as the plugin in ${other} does`,
        };
      }
      seen.set(id, scanned.folder);
      const approved = this.enabled.get(id);
      const state: PluginState =
        approved === undefined
          ? 'off'
          : approved.digest === scanned.digest || approved.development
            ? 'on'
            : 'changed';
      return { id, scanned, state, ...(approved?.development && { development: true as const }) };
    });
  }

  private running(): { manifest: PluginManifest; source: PluginSource; digest: string }[] {
    return this.plugins()
      .filter((plugin) => plugin.state === 'on')
      .map(({ scanned, development }) => ({
        manifest: scanned.manifest!,
        source: {
          id: scanned.manifest!.id,
          name: scanned.manifest!.name,
          dir: scanned.dir,
          ...(scanned.digest && { revision: scanned.digest.slice(0, 12) }),
          ...(development && { development }),
        },
        digest: scanned.digest ?? '',
      }));
  }

  /**
   * The plugins that run and may run something where an SSH workspace's files are, its code or a
   * contribution not on this computer, which SSH hosts get a copy of, each with its digest.
   */
  pluginsForSshHosts(): { id: string; digest: string }[] {
    return this.running()
      .filter(
        ({ manifest }) =>
          manifest.main ||
          contributionEntries(manifest).some(({ entry }) => entry.runOn !== 'local')
      )
      .map(({ source, digest }) => ({ id: source.id, digest }));
  }

  /**
   * The files of a plugin that runs, in the order its digest has them, and their digest, for a
   * copy of it; throws unless they are still those of `digest`, so a copy has only the files the
   * user turned on. A plugin in development runs its files as they change, so its copy takes them
   * as they are.
   */
  async pluginFiles(id: string, digest: string): Promise<{ entries: TarEntry[]; digest: string }> {
    const plugin = this.running().find(({ source }) => source.id === id);
    if (!plugin) throw new Error(`Plugin ${id} doesn't run`);
    const entries: TarEntry[] = [];
    const read = await digestFolder(plugin.source.dir, undefined, (entry) => entries.push(entry));
    if (!plugin.source.development && (read.digest !== digest || plugin.digest !== digest)) {
      throw new Error(`Plugin ${plugin.source.name}'s files changed since it was turned on`);
    }
    return { entries, digest: read.digest };
  }

  /** The plugins that run and have code of their own, for the plugin host. */
  hostedPlugins(): HostedPlugin[] {
    return this.running().flatMap(({ manifest, source, digest }) =>
      manifest.main
        ? [
            {
              source,
              ...(manifest.version && { version: manifest.version }),
              main: join(source.dir, manifest.main),
              panels: (manifest.contributes.sidebarPanels ?? []).map((panel) => panel.id),
              digest,
            },
          ]
        : []
    );
  }

  private async scanFolders(): Promise<ScannedPlugin[]> {
    let entries;
    try {
      entries = await readdir(this.pluginsPath, { withFileTypes: true });
    } catch {
      return [];
    }
    // Links to folders too, which are listed with why they don't run.
    const isFolder = async (entry: (typeof entries)[number]) =>
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await stat(join(this.pluginsPath, entry.name)).catch(() => undefined))?.isDirectory());
    const folders = (
      await Promise.all(
        entries.map(async (entry) =>
          !entry.name.startsWith('.') && (await isFolder(entry)) ? entry : undefined
        )
      )
    )
      .filter((entry) => entry !== undefined)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_PLUGINS);
    return Promise.all(
      folders.map((entry) =>
        scanPlugin(entry.name, join(this.pluginsPath, entry.name), entry.isSymbolicLink())
      )
    );
  }

  private settingsFilePath(): string {
    return join(this.settingsPath, PLUGINS_FILE);
  }

  private readSettingsContent(): string | undefined {
    const path = this.settingsFilePath();
    try {
      return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
    } catch (error) {
      logger.warn(`Could not read ${PLUGINS_FILE}`, error);
      return undefined;
    }
  }

  private readSettings(): void {
    const content = this.readSettingsContent();
    this.enabled.clear();
    if (content === undefined) return;
    const parsed = parseSettingsFile(PLUGINS_FILE, content, pluginsFileSchema);
    if ('problem' in parsed) {
      // No plugin runs until it's fixed, rather than one the user didn't turn on.
      logger.warn(`${parsed.problem}. No plugin runs until it's fixed.`);
      return;
    }
    for (const { id, digest, development } of parsed.value.enabled) {
      this.enabled.set(id, { digest, ...(development && { development }) });
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const pluginsPath = join(getKomlaBasePath(), 'plugins');
const settingsPath = join(getKomlaBasePath(), 'settings');

export const pluginsService = new PluginsService(pluginsPath, settingsPath);

/** The plugins folder, which Settings opens. */
export function getPluginsPath(): string {
  return pluginsPath;
}

let settingsWatcher: FileWatcher | null = null;
let folderSubscription: parcelWatcher.AsyncSubscription | null = null;
let rescanTimer: ReturnType<typeof setTimeout> | undefined;
let stopFeeding: (() => void) | null = null;

/**
 * Reads the plugins and gives the ones that run to the status bar, hooks and sidebar panels, following changes to
 * the plugins folder and plugins.json.
 */
export async function watchPlugins(): Promise<void> {
  if (stopFeeding) return;
  let fed = false;
  const feed = () => {
    fed = true;
    statusCommandsService.setPluginItems(pluginsService.statusItems());
    hooksService.setPluginHooks(pluginsService.hooks());
    sidebarPanelsService.setPluginPanels(pluginsService.sidebarPanels());
  };
  stopFeeding = pluginsService.onChange(feed);
  mkdirSync(pluginsPath, { recursive: true });
  await pluginsService.scan();
  // A scan tells listeners only of a change, and the plugins may have been read already.
  if (!fed) feed();
  settingsWatcher = new FileWatcher(join(settingsPath, PLUGINS_FILE), () =>
    pluginsService.reloadSettings()
  );
  await settingsWatcher.start();
  try {
    folderSubscription = await parcelWatcher.subscribe(
      pluginsPath,
      () => {
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => void pluginsService.scan(), 300);
      },
      { ignore: ['*/.git', '*/.git/**'] }
    );
  } catch (error) {
    logger.warn('Could not follow the plugins folder', error);
  }
}

export async function stopWatchingPlugins(): Promise<void> {
  clearTimeout(rescanTimer);
  stopFeeding?.();
  stopFeeding = null;
  await settingsWatcher?.stop();
  settingsWatcher = null;
  await folderSubscription?.unsubscribe();
  folderSubscription = null;
}
