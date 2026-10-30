import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { z } from 'zod';

import { levelPickerOf, storedLevelPicker } from '../../shared/lib/level-picker';
import {
  MAX_REASONING_LEVEL_NAME_LENGTH,
  MAX_REASONING_LEVELS,
  type AgentPreset,
  type ReasoningLevel,
} from '../../shared/types/agent-preset';
import { HOOK_EVENT_LABELS, type HookEvent } from '../../shared/types/hooks';
import { levelPickerFields, terminalUpdateSchema } from '../ipc/validation/config-ipc.schemas';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { parseSettingsFile } from '../lib/settings-file';

import { hooksFileSchema } from './hooks.service';
import {
  contributionEntries,
  MAX_PLUGINS,
  NO_OTHER_FILES,
  PLUGIN_MANIFEST,
  pluginManifestSchema,
  type PluginFolder,
  type PluginManifest,
  type PluginsService,
} from './plugins.service';
import {
  commandOutputSchema,
  popoverOutputDescription,
  statusCommandsFileSchema,
} from './status-commands.service';

import type { SettingsFileAdapter } from './settings-management.service';
import type {
  SettingsApprovalChange,
  SettingsFileResource,
  TerminalConfig,
} from '../../shared/types';
import type { PluginContributionInfo, PluginState } from '../../shared/types/plugins';
import type { SettingsSchemaSection } from '../lib/settings-schema';

const FILE_VERSION = 1;

const COMMANDS_WARNING =
  'Komla runs these commands without asking again: on this computer for local workspaces, and on the SSH host for SSH workspaces.';

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function problemsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
  );
}

/** What changes from one list to the next, by id: entries added, changed and removed. */
function listChanges<Entry>(
  before: Entry[],
  after: Entry[],
  idOf: (entry: Entry) => string,
  contentOf: (entry: Entry) => unknown,
  describe: (entry: Entry) => Omit<SettingsApprovalChange, 'operation'>
): SettingsApprovalChange[] {
  const previous = new Map(before.map((entry) => [idOf(entry), entry]));
  const changes: SettingsApprovalChange[] = [];
  for (const entry of after) {
    const old = previous.get(idOf(entry));
    if (!old) changes.push({ operation: 'add', ...describe(entry) });
    else if (hashOf(contentOf(old)) !== hashOf(contentOf(entry))) {
      changes.push({ operation: 'edit', ...describe(entry) });
    }
  }
  const kept = new Set(after.map(idOf));
  for (const entry of before) {
    if (!kept.has(idOf(entry))) changes.push({ operation: 'delete', ...describe(entry) });
  }
  return changes;
}

interface CommandEntry {
  id: string;
  command: string;
  projects?: string[];
}

function projectsLabel(projects: string[] | undefined): string {
  return projects?.join(', ') ?? 'All projects';
}

/**
 * A settings file whose entries run commands, as status-items.json and hooks.json: it is changed
 * whole, and each entry added, changed or removed is listed with its command.
 */
function commandFile<Entry extends CommandEntry>({
  path,
  fileName,
  name,
  listKey,
  schema,
  outputs = [],
  describe,
}: {
  path: string;
  fileName: string;
  name: string;
  listKey: string;
  schema: z.ZodType;
  /** What the entries' commands print, for `komla settings schema`. */
  outputs?: SettingsSchemaSection[];
  describe: (entry: Entry) => Omit<SettingsApprovalChange, 'operation'>;
}): SettingsFileAdapter {
  const content = () => (existsSync(path) ? readFileSync(path, 'utf-8') : undefined);
  const entries = (): Entry[] => {
    const current = content();
    if (current === undefined) return [];
    const parsed = parseSettingsFile(fileName, current, schema);
    return 'problem' in parsed
      ? []
      : ((parsed.value as Record<string, unknown>)[listKey] as Entry[]);
  };
  return {
    name,
    schema: [{ schema }, ...outputs],
    read() {
      const current = content();
      if (current === undefined) return { _version: FILE_VERSION, [listKey]: [] };
      const parsed = parseSettingsFile(fileName, current, schema);
      if ('problem' in parsed) return { problem: parsed.problem, content: current };
      // What the file says, without the defaults Komla fills in, so it can be changed and applied.
      return JSON.parse(current.replace(/^﻿/, '')) as Record<string, unknown>;
    },
    revision: () => hashOf(content() ?? null),
    prepare(desired) {
      const parsed = schema.safeParse(desired);
      if (!parsed.success) return { problems: problemsOf(parsed.error) };
      // Both sides with the defaults filled in, so leaving out a default changes nothing.
      const after = (parsed.data as Record<string, unknown>)[listKey] as Entry[];
      const changes = listChanges(
        entries(),
        after,
        (entry) => entry.id,
        (entry) => entry,
        describe
      );
      return {
        next: { _version: FILE_VERSION, ...desired },
        changes,
        ...(changes.some((change) => change.operation !== 'delete') && {
          warning: COMMANDS_WARNING,
        }),
      };
    },
    write(next) {
      writeFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

interface StatusItemEntry extends CommandEntry {
  intervalSeconds?: number;
  runOn?: 'workspace' | 'local';
  label?: string;
  popoverCommand?: string;
  action?: string;
  icon?: string;
  iconColor?: string;
  commands?: Record<string, string>;
}

// An icon file's path, or what kind of image the item carries in its place.
function describeIcon(icon: string): string {
  if (!icon.startsWith('data:') && !icon.startsWith('<')) return icon;
  return icon.startsWith('<') || icon.startsWith('data:image/svg') ? 'An SVG image' : 'An image';
}

interface HookEntry extends CommandEntry {
  event: HookEvent;
  intervalSeconds?: number;
  runOn?: 'workspace' | 'local';
  timeoutSeconds?: number;
}

// Terminal settings as `font.size` paths, so a change lists only the values it changes.
function leaves(value: unknown, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, leaf] of leaves(child, prefix ? `${prefix}.${key}` : key)) {
        result.set(path, leaf);
      }
    }
  } else {
    result.set(prefix, value);
  }
  return result;
}

// The descriptions here are what `komla settings schema` tells agents.
const shortcutsSchema = z
  .object({
    shortcuts: z.record(z.string(), z.string().trim().max(100)).meta({
      description:
        'Each action to change and its keys, such as `"workspace.new": "Cmd+N"`. `Cmd` is ⌘ on macOS and Ctrl on Windows and Linux; an empty string unbinds the action.',
    }),
  })
  .strict()
  .meta({
    description:
      '`komla settings get shortcuts` lists every action with its keys. Apply only the shortcuts to change; the rest stay as they are.',
  });

const PRESET_COMMANDS = {
  openCommand: 'Open command',
  continueCommand: 'Continue command',
  promptCommand: 'Prompt command',
} as const;

type PresetCommand = keyof typeof PRESET_COMMANDS;
type PresetUpdates = Partial<
  Pick<AgentPreset, PresetCommand | 'launchModes' | 'reasoningLevels' | 'levelPicker'>
>;

// Arguments only: anything that would run another command, or a placeholder Komla doesn't fill in
// here, is refused.
const NOT_AN_ARGUMENT = /[;&|<>`\r\n]|\$\(|\{\{/;

const ONLY_ARGUMENTS = 'Only arguments: no `;`, `&`, `|`, `<`, `>`, backticks, `$(` or `{{…}}`.';

const argumentsSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !NOT_AN_ARGUMENT.test(value), {
    message: 'Only arguments can be added: no ;, &, |, <, >, backticks, $( or {{placeholders}}',
  })
  .meta({ description: ONLY_ARGUMENTS });

// A preset's name and program change only in Settings.
const SHOWN_BY_GET =
  'Shown by get. Keep it as it is or leave it out; change it under Settings → Agents.';

// The picker next to the agent in the new workspace dialog. Levels, when given, are the whole
// list; one given by name alone keeps its arguments.
const levelPickerSchema = z
  .object({
    ...levelPickerFields,
    title: levelPickerFields.title.meta({ description: '`Effort` when left out.' }),
    icon: levelPickerFields.icon.meta({
      description: '`gauge`, the default, shows a meter of the picked level.',
    }),
    hidden: levelPickerFields.hidden.meta({
      description:
        '`true` hides the picker in the new workspace dialog and keeps its levels; new workspaces then start with Default, while existing ones keep their level. Left out, it stays as it is.',
    }),
    levels: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(MAX_REASONING_LEVEL_NAME_LENGTH).meta({
              description:
                "Unique in the list. The user's pick follows a level's name, so rename one only when asked.",
            }),
            arguments: argumentsSchema.optional().meta({
              description: `What Komla adds where launch mode arguments go when the user picks the level. A level given by its current name alone keeps its arguments. ${ONLY_ARGUMENTS}`,
            }),
          })
          .strict()
      )
      .max(MAX_REASONING_LEVELS)
      .meta({
        description:
          'The whole list, lowest first; leave it out to keep the levels as they are. The picker also offers Default, which adds nothing, and an empty list hides it.',
      })
      .superRefine((levels, context) => {
        levels.forEach((level, index) => {
          if (levels.findIndex((other) => other.name === level.name) < index) {
            context.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: `${level.name} is already in the list`,
            });
          }
        });
      })
      .optional(),
  })
  .strict();

const agentsSchema = z
  .object({
    presets: z
      .array(
        z
          .object({
            id: z.string().meta({ description: 'The preset to change.' }),
            // What `get` shows, so its output can be applied back.
            name: z.string().optional().meta({ description: SHOWN_BY_GET }),
            program: z.string().optional().meta({ description: SHOWN_BY_GET }),
            addArguments: argumentsSchema.optional().meta({
              description: `Arguments the agent needs each time it starts. Komla adds them right after the program in each command that runs it. ${ONLY_ARGUMENTS}`,
            }),
            levelPicker: levelPickerSchema.optional().meta({
              description: 'The picker beside the agent in the new workspace dialog.',
            }),
          })
          .strict()
      )
      .max(100),
  })
  .strict()
  .meta({
    description:
      "Agent presets' arguments and level pickers. Apply only the presets to change. Anything else about a preset, such as its commands, name or launch modes, changes under Settings → Agents.",
  });

const terminalSchema = terminalUpdateSchema.strict().meta({
  description:
    'The terminal\'s font, cursor and scrollback, such as `{"font": {"size": 14}}`. Apply only the values to change; `komla settings get terminal` shows every one. Most terminal colors follow the theme, which `komla skill appearance` changes.',
});

const PRESETS_WARNING =
  "Komla runs these commands, with a level's arguments when that level is picked, without asking again each time this agent starts, by you or by another agent, wherever its workspace runs: on this computer or an SSH host.";

const levelLines = (levels: Pick<ReasoningLevel, 'name' | 'arguments'>[]) =>
  levels.map((level) => `${level.name}: ${level.arguments}`).join('\n') || 'None';
const levelsKey = (levels: Pick<ReasoningLevel, 'name' | 'arguments'>[]) =>
  JSON.stringify(levels.map((level) => [level.name, level.arguments]));

// Variables a command sets before its program, then the program itself.
const COMMAND_START =
  /^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'])*\s+)*((?:"[^"]*"|'[^']*'|[^\s"'])+)/;

/** The program a command runs, without the variables it sets. */
function programOf(command: unknown): string | undefined {
  return typeof command === 'string' ? COMMAND_START.exec(command)?.[1] : undefined;
}

/**
 * The command with the arguments right after its program, or undefined when it runs another
 * program or already has them.
 */
function withArguments(command: unknown, program: string, args: string): string | undefined {
  if (typeof command !== 'string') return undefined;
  const start = COMMAND_START.exec(command);
  if (!start || start[1] !== program) return undefined;
  const escaped = args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(command)) return undefined;
  return `${start[0]} ${args}${command.slice(start[0].length)}`;
}

// The descriptions here are what `komla settings schema plugins` tells agents.
const pluginsSchema = z
  .object({
    plugins: z
      .array(
        z.looseObject({
          id: z.string().meta({ description: 'The plugin, as `get` lists it.' }),
          enabled: z.boolean().meta({
            description:
              "`true` turns it on as its files are now, also after they changed; `false` turns it off. `get` shows the rest, such as each plugin's `state` and what it adds, which apply leaves as they are.",
          }),
          manifest: pluginManifestSchema.optional().meta({
            description: `The plugin's \`${PLUGIN_MANIFEST}\`, which apply writes into its folder, making the folder \`<id>\` for a new plugin, so a plugin can be made from any computer. Leave it out, or as \`get\` lists it, to keep it as it is. ${pluginManifestSchema.meta()?.description ?? ''}`,
          }),
        })
      )
      .max(100),
    invalid: z.array(z.unknown()).optional().meta({
      description:
        "The plugins Komla can't read, with why, which can't be turned on until they're fixed. `get` lists them, and apply leaves them out.",
    }),
  })
  .strict()
  .meta({
    description: `The plugins in Komla's plugins folder, \`~/.komla/plugins/\`: folders with a \`${PLUGIN_MANIFEST}\` that add status bar items and hooks. Apply only the plugins to change or add. A plugin runs only while it's turned on and its files are as they were then; a \`changed\` plugin's files changed since, so it doesn't run until it's turned on again.`,
  });

type PluginEntry = z.infer<typeof pluginsSchema>['plugins'][number];

/** What applying plugins writes: the manifests, then which plugins are on. */
interface PluginsNext {
  /** Each plugin to turn on, with the digest of the files the approval showed, or off. */
  enable: Record<string, string | false>;
  /** Manifests to write, as the agent wrote them; each is turned on once Komla reads it back. */
  manifests: {
    id: string;
    folder: string;
    manifest: unknown;
    enabled: boolean;
    /** The folder's other files as the approval saw them, which must be so still. */
    otherFiles: string;
    /** Whether the folder is new, so it mustn't appear before Komla writes it. */
    isNew: boolean;
  }[];
}

const PLUGINS_WARNING =
  "Komla runs these commands, and the plugin's files they use, without asking again: on this computer for local workspaces, and on the SSH host for SSH workspaces. A plugin stops when its files change, until it's turned on again.";

/** A plugin's item or hook as a settings change, with every command it runs. */
function describeContribution(
  pluginName: string,
  contribution: PluginContributionInfo
): Omit<SettingsApprovalChange, 'operation'> {
  return {
    kind: contribution.kind,
    title: `${pluginName}: ${contribution.title}`,
    contentLabel: 'Command',
    content: contribution.command,
    ...(contribution.moreCommands && {
      moreContent: contribution.moreCommands.map(({ label, command }) => ({
        label,
        content: command,
      })),
    }),
    details: [
      { label: 'When', value: contribution.when },
      ...(contribution.runOn === 'local'
        ? [{ label: 'Runs on', value: 'This computer, in your home folder' }]
        : []),
      { label: 'Id', value: contribution.id },
    ],
  };
}

/** What deciding whether a plugin can be changed as asked looks at. */
interface PluginsContext {
  folders: PluginFolder[];
  /** The ids already in the list. */
  seen: ReadonlySet<string>;
  /** How many new plugins the list makes before this one. */
  newPlugins: number;
  takenName: (name: string) => string | undefined;
}

/** Why a plugin can't be turned on or off, or written, as asked. */
function pluginProblem(
  { id, enabled, manifest }: PluginEntry,
  plugin: PluginFolder | undefined,
  context: PluginsContext
): string | undefined {
  if (context.seen.has(id)) return `${id} is in the list more than once`;
  if (manifest) return manifestProblem(id, manifest, plugin, context);
  if (!plugin) return `There is no plugin ${id}; \`komla settings get plugins\` lists them`;
  if (enabled && (plugin.state === 'invalid' || !plugin.digest)) {
    return `Plugin ${id} can't be turned on: ${plugin.problem ?? "Komla can't read it"}`;
  }
  return undefined;
}

/** Why Komla can't write this manifest for the plugin. */
function manifestProblem(
  id: string,
  manifest: PluginManifest,
  plugin: PluginFolder | undefined,
  { folders, newPlugins, takenName }: PluginsContext
): string | undefined {
  if (manifest.id !== id) return `${id}: its manifest's id is ${manifest.id}`;
  if (plugin) {
    if (plugin.folderProblem) return `Plugin ${id} ${plugin.folderProblem}`;
    return undefined;
  }
  const taken = takenName(id);
  if (taken !== undefined) {
    const other = folders.find((each) => each.folder === taken);
    return other
      ? `${id}: the plugins folder has a folder ${taken} already, for ${other.id}`
      : `${id}: the plugins folder has ${taken} already, which isn't a plugin's folder`;
  }
  if (folders.length + newPlugins >= MAX_PLUGINS) {
    return `${id}: Komla reads only ${MAX_PLUGINS} plugins, and this would be one more`;
  }
  return undefined;
}

/**
 * Whether turning a plugin on or off changes it. A changed plugin no longer runs, but turning it
 * off forgets the files it was turned on with, so they don't run again if they come back.
 */
function changesPlugin(state: PluginState, enabled: boolean): boolean {
  return enabled ? state !== 'on' : state === 'on' || state === 'changed';
}

/** What changes in what runs, from a plugin's items and hooks before to after. */
function contributionChanges(
  name: string,
  before: ReturnType<typeof contributionEntries>,
  after: ReturnType<typeof contributionEntries>
): SettingsApprovalChange[] {
  return listChanges(
    before,
    after,
    // An item and a hook may share an id.
    ({ info }) => `${info.kind}:${info.id}`,
    ({ entry }) => entry,
    ({ info }) => describeContribution(name, info)
  );
}

/**
 * What writing a plugin's manifest changes: the plugin itself, then what runs, from what ran before
 * to what runs once it's turned on, or nothing while it's off.
 */
function manifestChanges(
  { id, enabled, manifest }: PluginEntry,
  plugin: PluginFolder | undefined
): SettingsApprovalChange[] {
  const written = manifest!;
  const before =
    plugin?.state === 'on' && plugin.manifest ? contributionEntries(plugin.manifest) : [];
  const after = enabled ? contributionEntries(written) : [];
  const counts = [
    [written.contributes.statusItems?.length ?? 0, 'status bar item'],
    [written.contributes.hooks?.length ?? 0, 'hook'],
  ] as const;
  return [
    {
      operation: plugin?.hasManifest ? 'edit' : 'add',
      kind: 'plugin',
      title: written.name,
      details: [
        { label: 'Folder', value: `plugins/${plugin?.folder ?? id}` },
        {
          label: 'Adds',
          value: counts
            .filter(([count]) => count > 0)
            .map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`)
            .join(', '),
        },
        ...(enabled ? [] : [{ label: 'Runs', value: 'Only once turned on' }]),
      ],
    },
    ...contributionChanges(written.name, before, after),
  ];
}

/**
 * Writes the manifests once every plugin's folder is as the approval saw it, so none is written
 * when one has changed, then reads the plugins again.
 */
async function writeManifests(
  plugins: Pick<PluginsService, 'takenName' | 'otherFilesOf' | 'writeManifest' | 'scan'>,
  manifests: PluginsNext['manifests']
): Promise<void> {
  const unchanged = await Promise.all(
    manifests.map(async ({ folder, otherFiles, isNew }) =>
      isNew
        ? plugins.takenName(folder) === undefined
        : (await plugins.otherFilesOf(folder).catch(() => undefined)) === otherFiles
    )
  );
  const changed = manifests.find((_, index) => !unchanged[index]);
  if (changed) {
    throw new Error(
      `Plugin ${changed.id}'s files changed since the approval listed them. Apply it again.`
    );
  }
  for (const { folder, manifest } of manifests) plugins.writeManifest(folder, manifest);
  await plugins.scan();
}

export interface SettingsFilesDependencies {
  settingsPath: string;
  shortcuts: {
    /** Every shortcut action with its keys. */
    get(): Record<string, string>;
    update(shortcuts: Record<string, string>): void;
  };
  terminal: {
    get(): TerminalConfig;
    update(updates: Partial<TerminalConfig>): void;
  };
  presets: {
    list(): AgentPreset[];
    update(id: string, updates: PresetUpdates): void;
  };
  plugins: Pick<
    PluginsService,
    'folders' | 'revision' | 'setEnabled' | 'takenName' | 'otherFilesOf' | 'writeManifest' | 'scan'
  >;
}

/** The settings files `komla settings get|apply` reads and changes, beside the theme and Actions. */
export function createSettingsFiles({
  settingsPath,
  shortcuts,
  terminal,
  presets,
  plugins,
}: SettingsFilesDependencies): Record<SettingsFileResource, SettingsFileAdapter> {
  return {
    plugins: {
      name: 'Plugins',
      schema: [
        { schema: pluginsSchema },
        { title: 'What `command` prints', schema: commandOutputSchema },
        { title: 'What `popoverCommand` prints', schema: popoverOutputDescription },
      ],
      read: () => {
        // Each id once, so `get`'s entries apply back; one Komla can't read may share an id.
        const folders = plugins.folders();
        const invalid = folders.filter((plugin) => plugin.state === 'invalid');
        return {
          plugins: folders
            .filter((plugin) => plugin.state !== 'invalid')
            .map(
              ({
                id,
                state,
                written,
                digest: _digest,
                folderProblem: _folderProblem,
                hasManifest: _hasManifest,
                manifest: _manifest,
                otherFiles: _otherFiles,
                ...plugin
              }) => ({ id, enabled: state === 'on', state, ...plugin, manifest: written })
            ),
          ...(invalid.length > 0 && {
            invalid: invalid.map(({ id, name, folder, problem }) => ({
              id,
              name,
              folder,
              problem,
            })),
          }),
        };
      },
      revision: () => plugins.revision(),
      prepare(desired) {
        const parsed = pluginsSchema.safeParse(desired);
        if (!parsed.success) return { problems: problemsOf(parsed.error) };
        const folders = plugins.folders();
        // Of plugins with one id, the one that can run, if any.
        const find = (id: string) =>
          folders.find((plugin) => plugin.id === id && plugin.state !== 'invalid') ??
          folders.find((plugin) => plugin.id === id);
        const problems: string[] = [];
        const seen = new Set<string>();
        const next: PluginsNext = { enable: {}, manifests: [] };
        const changes: SettingsApprovalChange[] = [];
        parsed.data.plugins.forEach((entry, index) => {
          const plugin = find(entry.id);
          const problem = pluginProblem(entry, plugin, {
            folders,
            seen,
            newPlugins: next.manifests.filter((each) => each.isNew).length,
            takenName: (name) => plugins.takenName(name),
          });
          seen.add(entry.id);
          if (problem) {
            problems.push(problem);
            return;
          }
          const current = plugin?.state !== 'invalid' ? plugin?.manifest : undefined;
          if (entry.manifest && (!current || hashOf(current) !== hashOf(entry.manifest))) {
            changes.push(...manifestChanges(entry, plugin));
            next.manifests.push({
              id: entry.id,
              folder: plugin?.folder ?? entry.id,
              // As the agent wrote it, without the defaults Komla fills in.
              manifest: (desired.plugins as { manifest: unknown }[])[index].manifest,
              enabled: entry.enabled,
              otherFiles: plugin?.otherFiles ?? NO_OTHER_FILES,
              isNew: !plugin,
            });
            return;
          }
          if (!plugin || !changesPlugin(plugin.state, entry.enabled)) return;
          // The digest of the files the approval shows, so files that change after it don't run.
          next.enable[entry.id] = entry.enabled ? plugin.digest! : false;
          for (const contribution of plugin.contributions) {
            changes.push({
              operation: entry.enabled ? 'add' : 'delete',
              ...describeContribution(plugin.name, contribution),
            });
          }
        });
        if (problems.length > 0) return { problems };
        return {
          next,
          changes,
          ...(changes.some(
            (change) => change.kind !== 'plugin' && change.operation !== 'delete'
          ) && {
            warning: PLUGINS_WARNING,
          }),
        };
      },
      async write(next) {
        const { enable, manifests } = next as PluginsNext;
        if (manifests.length > 0) await writeManifests(plugins, manifests);
        const changes = { ...enable };
        for (const { id, folder, manifest, enabled, otherFiles } of manifests) {
          if (!enabled) {
            changes[id] = false;
            continue;
          }
          // Read back as written, with the other files the approval saw, or it doesn't run.
          const written = plugins.folders().find((each) => each.folder === folder);
          if (written?.state === 'invalid') {
            throw new Error(`Plugin ${id} ${written.problem ?? "can't be read"}`);
          }
          if (
            !written?.digest ||
            written.id !== id ||
            written.otherFiles !== otherFiles ||
            hashOf(written.manifest) !== hashOf(pluginManifestSchema.parse(manifest))
          ) {
            throw new Error(`Plugin ${id}'s files changed as Komla wrote them. Apply it again.`);
          }
          changes[id] = written.digest;
        }
        if (Object.keys(changes).length > 0) plugins.setEnabled(changes);
      },
    },
    'status-items': commandFile<StatusItemEntry>({
      path: join(settingsPath, 'status-items.json'),
      fileName: 'status-items.json',
      name: 'Status bar items',
      listKey: 'items',
      schema: statusCommandsFileSchema,
      outputs: [
        { title: 'What `command` prints', schema: commandOutputSchema },
        { title: 'What `popoverCommand` prints', schema: popoverOutputDescription },
      ],
      describe: (item) => {
        const moreContent = [
          ...(item.popoverCommand
            ? [{ label: 'Popover command, run on click', content: item.popoverCommand }]
            : []),
          ...Object.entries(item.commands ?? {}).map(([name, command]) => ({
            label: `Button command ${name}`,
            content: command,
          })),
        ];
        return {
          kind: 'status-item',
          title: item.label ?? item.id,
          contentLabel: 'Command',
          content: item.command,
          ...(moreContent.length > 0 && { moreContent }),
          details: [
            { label: 'Runs', value: `Every ${item.intervalSeconds ?? 60} seconds` },
            ...(item.runOn === 'local'
              ? [{ label: 'Runs on', value: 'This computer, in your home folder' }]
              : []),
            ...(item.icon ? [{ label: 'Icon', value: describeIcon(item.icon) }] : []),
            ...(item.action
              ? [{ label: 'On click, runs the quick command', value: item.action }]
              : []),
            { label: 'Projects', value: projectsLabel(item.projects) },
          ],
        };
      },
    }),
    hooks: commandFile<HookEntry>({
      path: join(settingsPath, 'hooks.json'),
      fileName: 'hooks.json',
      name: 'Hooks',
      listKey: 'hooks',
      schema: hooksFileSchema,
      describe: (hook) => ({
        kind: 'hook',
        title: hook.id,
        contentLabel: 'Command',
        content: hook.command,
        details: [
          {
            label: 'When',
            value:
              hook.event === 'interval'
                ? `Every ${hook.intervalSeconds} seconds, ${hook.runOn === 'local' ? 'once' : 'in each workspace'}`
                : HOOK_EVENT_LABELS[hook.event],
          },
          ...(hook.runOn === 'local'
            ? [{ label: 'Runs on', value: 'This computer, in your home folder' }]
            : []),
          { label: 'Timeout', value: `${hook.timeoutSeconds ?? 60} seconds` },
          ...(hook.event === 'interval' && hook.runOn === 'local'
            ? []
            : [{ label: 'Projects', value: projectsLabel(hook.projects) }]),
        ],
      }),
    }),
    shortcuts: {
      name: 'Keyboard shortcuts',
      schema: [{ schema: shortcutsSchema }],
      read: () => ({ shortcuts: shortcuts.get() }),
      revision: () => hashOf(shortcuts.get()),
      prepare(desired) {
        const parsed = shortcutsSchema.safeParse(desired);
        if (!parsed.success) return { problems: problemsOf(parsed.error) };
        const current = shortcuts.get();
        const unknown = Object.keys(parsed.data.shortcuts).filter((action) => !(action in current));
        if (unknown.length > 0) {
          return {
            problems: unknown.map(
              (action) => `shortcuts.${action}: Komla has no shortcut action named ${action}`
            ),
          };
        }
        const next = Object.fromEntries(
          Object.entries(parsed.data.shortcuts).filter(([action, keys]) => current[action] !== keys)
        );
        return {
          next,
          changes: Object.entries(next).map(([action, keys]) => ({
            operation: 'change' as const,
            kind: 'shortcut' as const,
            title: action,
            details: [
              // An empty string unbinds the action.
              { label: 'Keys', value: keys || 'Not set' },
              { label: 'From', value: current[action] || 'Not set' },
            ],
          })),
        };
      },
      write: (next) => shortcuts.update(next as Record<string, string>),
    },
    terminal: {
      name: 'Terminal',
      schema: [{ schema: terminalSchema }],
      read: () => ({ ...terminal.get() }),
      revision: () => hashOf(terminal.get()),
      prepare(desired) {
        const parsed = terminalSchema.safeParse(desired);
        if (!parsed.success) return { problems: problemsOf(parsed.error) };
        const current = leaves(terminal.get());
        const changes: SettingsApprovalChange[] = [];
        for (const [path, value] of leaves(parsed.data)) {
          if (current.get(path) === value) continue;
          changes.push({
            operation: 'change',
            kind: 'terminal-setting',
            title: path,
            details: [
              { label: 'Value', value: String(value) },
              // oxlint-disable-next-line typescript/no-base-to-string -- leaves are primitives or arrays
              { label: 'From', value: String(current.get(path) ?? 'not set') },
            ],
          });
        }
        return { next: parsed.data, changes };
      },
      // The schema checks each value; colors it leaves out keep their current value.
      write: (next) => terminal.update(next as Partial<TerminalConfig>),
    },
    // Adds arguments to the commands a preset starts its agent with, such as one that trusts the
    // workspace's folder, and changes its level picker. Agents never see the commands, which can
    // hold keys, nor replace them; nor a level's arguments, which go into them.
    agents: {
      name: 'Agents',
      schema: [{ schema: agentsSchema }],
      read: () => ({
        presets: presets.list().map((preset) => ({
          id: preset.id,
          name: preset.name,
          ...(programOf(preset.openCommand) && { program: programOf(preset.openCommand) }),
          levelPicker: {
            ...levelPickerOf(preset),
            // Unset levels stay unset, so a template can still give the preset its levels later.
            ...(preset.reasoningLevels && {
              levels: preset.reasoningLevels.map((level) => ({ name: level.name.trim() })),
            }),
          },
        })),
      }),
      revision: () => hashOf(presets.list()),
      prepare(desired) {
        const parsed = agentsSchema.safeParse(desired);
        if (!parsed.success) return { problems: problemsOf(parsed.error) };
        const current = new Map(presets.list().map((preset) => [preset.id, preset]));
        const problems: string[] = [];
        const next: { id: string; updates: PresetUpdates }[] = [];
        const changes: SettingsApprovalChange[] = [];
        const seen = new Set<string>();
        parsed.data.presets.forEach((entry, index) => {
          const preset = current.get(entry.id);
          if (!preset) {
            problems.push(`presets.${index}.id: Komla has no agent preset ${entry.id}`);
            return;
          }
          if (seen.has(entry.id)) {
            problems.push(`presets.${index}.id: ${entry.id} is already in the list`);
            return;
          }
          seen.add(entry.id);
          const program = programOf(preset.openCommand);
          if (entry.name !== undefined && entry.name !== preset.name) {
            problems.push(`presets.${index}.name: change it under Settings → Agents`);
          }
          if (entry.program !== undefined && entry.program !== program) {
            problems.push(`presets.${index}.program: change it under Settings → Agents`);
          }
          const updates: PresetUpdates = {};
          const moreContent: NonNullable<SettingsApprovalChange['moreContent']> = [];
          const details: SettingsApprovalChange['details'] = [];
          const picker = entry.levelPicker;
          if (picker) {
            const current = levelPickerOf(preset);
            // Left out, hidden is kept like levels, so changing the look doesn't show the picker.
            const wanted = levelPickerOf({
              levelPicker: { hidden: current.hidden, ...picker },
            });
            if (JSON.stringify(wanted) !== JSON.stringify(current)) {
              updates.levelPicker = storedLevelPicker(wanted);
            }
            if (wanted.title !== current.title) {
              details.push({
                label: 'Picker title',
                value: wanted.title,
                previous: current.title,
              });
            }
            if (wanted.icon !== current.icon) {
              details.push({ label: 'Picker icon', value: wanted.icon, previous: current.icon });
            }
            if (wanted.hidden !== current.hidden) {
              const shown = (hidden: boolean) => (hidden ? 'Hidden' : 'Shown');
              details.push({
                label: 'Picker',
                value: shown(wanted.hidden),
                previous: shown(current.hidden),
              });
            }
            // Trimmed as the schema trims what is applied, so unchanged levels compare equal.
            const levels = (preset.reasoningLevels ?? []).map((level) => ({
              ...level,
              name: level.name.trim(),
              arguments: level.arguments.trim(),
            }));
            const wantedLevels = picker.levels?.flatMap((level, levelIndex) => {
              const existing = levels.find((current) => current.name === level.name);
              const args = level.arguments ?? existing?.arguments;
              if (args === undefined) {
                problems.push(
                  `presets.${index}.levelPicker.levels.${levelIndex}.arguments: ${level.name} is a new level, so it needs arguments`
                );
                return [];
              }
              // A level keeps its id by name, so workspaces that picked it still resume with it.
              return [{ id: existing?.id ?? randomUUID(), name: level.name, arguments: args }];
            });
            // An empty list is saved too, so a template doesn't give the preset levels later.
            if (
              wantedLevels &&
              (preset.reasoningLevels === undefined ||
                levelsKey(wantedLevels) !== levelsKey(levels))
            ) {
              updates.reasoningLevels = wantedLevels;
              moreContent.push({
                label: 'Levels',
                content: levelLines(wantedLevels),
                previous: preset.reasoningLevels !== undefined ? levelLines(levels) : 'Not set',
              });
            }
          }
          const args = entry.addArguments;
          if (args !== undefined) {
            if (!program) {
              problems.push(
                `presets.${index}.id: ${preset.name} has no open command to add arguments to`
              );
              return;
            }
            for (const key of Object.keys(PRESET_COMMANDS) as PresetCommand[]) {
              const command = withArguments(preset[key], program, args);
              if (command === undefined) continue;
              updates[key] = command;
              moreContent.push({
                label: PRESET_COMMANDS[key],
                content: command,
                previous: preset[key],
              });
            }
          }
          if (Object.keys(updates).length === 0) return;
          next.push({ id: entry.id, updates });
          changes.push({
            operation: 'edit',
            kind: 'agent-preset',
            title: preset.name,
            moreContent,
            details,
          });
        });
        if (problems.length > 0) return { problems };
        // A new title, icon or visibility runs nothing.
        const runsMore = changes.some((change) => (change.moreContent?.length ?? 0) > 0);
        return { next, changes, ...(runsMore && { warning: PRESETS_WARNING }) };
      },
      write(next) {
        for (const { id, updates } of next as { id: string; updates: PresetUpdates }[]) {
          presets.update(id, updates);
        }
      },
    },
  };
}
