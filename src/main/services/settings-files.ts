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
import { levelPickerFields, terminalUpdateSchema } from '../ipc/validation/config-ipc.schemas';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { parseSettingsFile } from '../lib/settings-file';

import { hooksFileSchema } from './hooks.service';
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
import type { HookEvent } from '../../shared/types/hooks';
import type { SettingsSchemaSection } from '../lib/settings-schema';

const FILE_VERSION = 1;

const HOOK_EVENT_LABELS: Record<Exclude<HookEvent, 'interval'>, string> = {
  'agent.done': 'An agent finishes',
  'agent.needs-input': 'An agent needs input',
  'agent.error': 'An agent reports an error',
  'agent.prompt': 'A prompt is sent to an agent',
  'workspace.created': 'A workspace is created',
  'workspace.trashed': 'A workspace is moved to the Trash',
};

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
      const before = new Map(entries().map((entry) => [entry.id, entry]));
      // Both sides with the defaults filled in, so leaving out a default changes nothing.
      const after = (parsed.data as Record<string, unknown>)[listKey] as Entry[];
      const changes: SettingsApprovalChange[] = [];
      for (const entry of after) {
        const previous = before.get(entry.id);
        if (!previous) changes.push({ operation: 'add', ...describe(entry) });
        else if (hashOf(previous) !== hashOf(entry)) {
          changes.push({ operation: 'edit', ...describe(entry) });
        }
      }
      const kept = new Set(after.map((entry) => entry.id));
      for (const [id, entry] of before) {
        if (!kept.has(id)) changes.push({ operation: 'delete', ...describe(entry) });
      }
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
}

/** The settings files `komla settings get|apply` reads and changes, beside the theme and Actions. */
export function createSettingsFiles({
  settingsPath,
  shortcuts,
  terminal,
  presets,
}: SettingsFilesDependencies): Record<SettingsFileResource, SettingsFileAdapter> {
  return {
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
          const moreContent: { label: string; content: string }[] = [];
          const details: { label: string; value: string }[] = [];
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
                value: `${wanted.title}, from ${current.title}`,
              });
            }
            if (wanted.icon !== current.icon) {
              details.push({ label: 'Picker icon', value: `${wanted.icon}, from ${current.icon}` });
            }
            if (wanted.hidden !== current.hidden) {
              const shown = (hidden: boolean) => (hidden ? 'hidden' : 'shown');
              details.push({
                label: 'Picker',
                value: `${shown(wanted.hidden)}, from ${shown(current.hidden)}`,
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
              moreContent.push(
                { label: 'Levels', content: levelLines(wantedLevels) },
                { label: 'Levels, from', content: levelLines(levels) }
              );
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
              moreContent.push(
                { label: PRESET_COMMANDS[key], content: command },
                { label: `${PRESET_COMMANDS[key]}, from`, content: preset[key] }
              );
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
