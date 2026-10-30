import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { lstat, readdir, readFile, realpath, stat } from 'fs/promises';
import { join, relative, sep } from 'path';

import * as parcelWatcher from '@parcel/watcher';
import { z } from 'zod';

import { HOOK_EVENT_LABELS } from '../../shared/types/hooks';
import {
  PLUGIN_ID_PATTERN,
  type PluginContributionInfo,
  type PluginInfo,
  type PluginState,
} from '../../shared/types/plugins';
import { STATUS_ITEM_ID_PATTERN } from '../../shared/types/status-items';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';
import { parseSettingsFile } from '../lib/settings-file';

import { FileWatcher } from './file-watcher';
import { hookSchema, hooksService, type Hook } from './hooks.service';
import { getKomlaBasePath } from './paths';
import {
  statusCommandSchema,
  statusCommandsService,
  type ConfiguredStatusCommand,
} from './status-commands.service';

const logger = createLogger('PluginsService');

export const PLUGIN_MANIFEST = 'komla-plugin.json';
const PLUGINS_FILE = 'plugins.json';
const FILE_VERSION = 1;
const MAX_PLUGINS = 100;
const MAX_STATUS_ITEMS = 10;
const MAX_HOOKS = 20;
/** A plugin's files Komla reads to tell when they change; past these, it doesn't run it. */
const MAX_PLUGIN_FILES = 5000;
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;

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
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const { statusItems = [], hooks = [] } = manifest.contributes;
    if (statusItems.length + hooks.length === 0) {
      context.addIssue({ code: 'custom', path: ['contributes'], message: 'adds nothing' });
    }
    for (const [key, entries] of [
      ['statusItems', statusItems],
      ['hooks', hooks],
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
    enabled: z.array(z.object({ id: z.string(), digest: z.string() }).strict()).max(MAX_PLUGINS),
  })
  .strict();

/** Where a plugin's item or hook comes from, for its commands and for messages. */
export interface PluginSource {
  id: string;
  name: string;
  /** The plugin's folder, which its commands get as `KOMLA_PLUGIN_DIR`. */
  dir: string;
}

export type PluginStatusCommand = ConfiguredStatusCommand & { plugin: PluginSource };
export type PluginHook = Hook & { plugin: PluginSource };

interface ScannedPlugin {
  folder: string;
  dir: string;
  manifest?: PluginManifest;
  /** A digest of every file in the folder but `.git`'s, which changes when any of them does. */
  digest?: string;
  problem?: string;
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

/**
 * A digest of a folder's files, their paths and contents, without `.git`, with the content of the
 * file `keep` names as it hashed it. Komla follows only changes to the plugins folder, so a link
 * that leads out of the folder throws, rather than letting a plugin run files it doesn't see.
 */
export async function digestFolder(
  dir: string,
  keep?: string
): Promise<{ digest: string; kept?: Buffer }> {
  const hash = createHash('sha256');
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
        hash.update(`d\0${relativePath}\0`);
        await walk(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await linkTarget(root, path, relativePath);
        hash.update(`l\0${relativePath}\0${target}\0`);
        // Its target is one of the folder's own files, which the digest has as well.
        if (relativePath === keep) kept = await readFile(join(root, target));
        continue;
      }
      if (!entry.isFile()) continue;
      // Before reading it, so one huge file isn't read only to be refused.
      bytes += (await lstat(path)).size;
      if (bytes > MAX_PLUGIN_BYTES) {
        throw new PluginFolderError(`is larger than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB`);
      }
      const content = await readFile(path);
      if (relativePath === keep) kept = content;
      hash.update(`f\0${relativePath}\0${content.length}\0`);
      hash.update(content);
    }
  };
  await walk('');
  return { digest: hash.digest('hex'), ...(kept && { kept }) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const parseManifest = (content: string) =>
  parseSettingsFile(PLUGIN_MANIFEST, content, pluginManifestSchema);

async function scanPlugin(folder: string, dir: string, isLink: boolean): Promise<ScannedPlugin> {
  if (isLink) {
    // Komla follows changes only to the plugins folder, so it can't tell when one elsewhere does.
    return { folder, dir, problem: 'is a link. Copy or clone the plugin into the plugins folder' };
  }
  let content: string;
  try {
    content = await readFile(join(dir, PLUGIN_MANIFEST), 'utf-8');
  } catch {
    return { folder, dir, problem: `has no ${PLUGIN_MANIFEST}` };
  }
  const parsed = parseManifest(content);
  if ('problem' in parsed) return { folder, dir, problem: parsed.problem };
  let hashed;
  try {
    hashed = await digestFolder(dir, PLUGIN_MANIFEST);
  } catch (error) {
    return { folder, dir, manifest: parsed.value, problem: errorMessage(error) };
  }
  // The manifest as the digest has it, so what runs is what the user turned on.
  if (!hashed.kept) return { folder, dir, problem: `has no ${PLUGIN_MANIFEST}` };
  const hashedManifest = parseManifest(hashed.kept.toString('utf-8'));
  if ('problem' in hashedManifest) return { folder, dir, problem: hashedManifest.problem };
  return { folder, dir, manifest: hashedManifest.value, digest: hashed.digest };
}

function statusItemInfo(pluginId: string, item: ConfiguredStatusCommand): PluginContributionInfo {
  const moreCommands = [
    ...(item.popoverCommand
      ? [{ label: 'Popover command, run on click', command: item.popoverCommand }]
      : []),
    ...Object.entries(item.commands ?? {}).map(([name, command]) => ({
      label: `Button command ${name}`,
      command,
    })),
  ];
  return {
    kind: 'status-item',
    id: `${pluginId}.${item.id}`,
    title: item.label ?? item.id,
    command: item.command,
    when: `Every ${item.intervalSeconds} seconds`,
    ...(item.runOn === 'local' && { runOn: 'local' as const }),
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

function contributionsOf(manifest: PluginManifest): PluginContributionInfo[] {
  return [
    ...(manifest.contributes.statusItems ?? []).map((item) => statusItemInfo(manifest.id, item)),
    ...(manifest.contributes.hooks ?? []).map((hook) => hookInfo(manifest.id, hook)),
  ];
}

/**
 * The plugins in Komla's plugins folder: folders whose komla-plugin.json adds status bar items and
 * hooks. A plugin runs while it is turned on and its files are as they were then; plugins.json
 * keeps a digest of them for each plugin the user turned on.
 */
export class PluginsService {
  private scanned: ScannedPlugin[] = [];
  private enabled = new Map<string, string>();
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
    return this.plugins().map(({ scanned, state, problem }) => ({
      id: scanned.manifest?.id ?? scanned.folder,
      name: scanned.manifest?.name ?? scanned.folder,
      ...(scanned.manifest?.version && { version: scanned.manifest.version }),
      ...(scanned.manifest?.description && { description: scanned.manifest.description }),
      folder: scanned.folder,
      state,
      ...(problem && { problem }),
      ...(scanned.digest && { digest: scanned.digest }),
      contributions: scanned.manifest ? contributionsOf(scanned.manifest) : [],
    }));
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
      enabled.set(id, digest);
    }
    const content = {
      _version: FILE_VERSION,
      enabled: [...enabled].map(([id, digest]) => ({ id, digest })),
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
        approved === undefined ? 'off' : approved === scanned.digest ? 'on' : 'changed';
      return { id, scanned, state };
    });
  }

  private running(): { manifest: PluginManifest; source: PluginSource }[] {
    return this.plugins()
      .filter((plugin) => plugin.state === 'on')
      .map(({ scanned }) => ({
        manifest: scanned.manifest!,
        source: { id: scanned.manifest!.id, name: scanned.manifest!.name, dir: scanned.dir },
      }));
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
    for (const { id, digest } of parsed.value.enabled) this.enabled.set(id, digest);
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
 * Reads the plugins and gives the ones that run to the status bar and hooks, following changes to
 * the plugins folder and plugins.json.
 */
export async function watchPlugins(): Promise<void> {
  if (stopFeeding) return;
  let fed = false;
  const feed = () => {
    fed = true;
    statusCommandsService.setPluginItems(pluginsService.statusItems());
    hooksService.setPluginHooks(pluginsService.hooks());
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
