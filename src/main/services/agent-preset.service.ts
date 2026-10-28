import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { moveItem } from '../../shared/lib/move-item';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';
import {
  escapeNativeArgument,
  escapePowerShellDoubleQuoted,
} from '../lib/powershell-native-arguments';
import { getShell } from '../lib/shell';
import { usesPowerShell } from '../lib/workspace-launch-variables';

import { configService } from './config.service';
import { resolvePosixAutoTrustArgs } from './execution-location/launch-variables';
import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';

import type {
  AgentPreset,
  LaunchMode,
  ReasoningLevel,
  ActivePresetEntry,
} from '../../shared/types';

export type { AgentPreset, LaunchMode };

function reasoningLevelName(level: string): string {
  if (level === 'xhigh') return 'Extra high';
  // Hermes's `none` turns reasoning off; "None" would read as no override.
  if (level === 'none') return 'Off';
  return level[0].toUpperCase() + level.slice(1);
}

function reasoningLevels(
  levels: string[],
  toArguments: (level: string) => string
): ReasoningLevel[] {
  return levels.map((level) => ({
    id: randomUUID(),
    name: reasoningLevelName(level),
    arguments: toArguments(level),
  }));
}

export const BUILTIN_PRESETS: Omit<AgentPreset, 'id'>[] = [
  {
    name: 'Claude Code',
    openCommand: 'claude {{launchMode}}',
    continueCommand: 'claude --resume {{launchMode}}',
    // `--` keeps prompts starting with `-` (Markdown lists) from being read as options.
    promptCommand: 'claude {{launchMode}} -- {{prompt}}',
    // Auto is Claude Code's default mode since 2.1.284, so Manual brings back the prompts.
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--permission-mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Manual',
        arguments: '--permission-mode default',
        color: 'emerald',
      },
      {
        id: randomUUID(),
        name: 'Accept edits',
        arguments: '--permission-mode acceptEdits',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'Dangerously skip permissions',
        arguments: '--dangerously-skip-permissions',
        color: 'red',
      },
    ],
    reasoningLevels: reasoningLevels(
      ['low', 'medium', 'high', 'xhigh', 'max'],
      (level) => `--effort ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Codex',
    openCommand: 'codex {{launchMode}}',
    continueCommand: 'codex resume {{launchMode}}',
    promptCommand: 'codex {{launchMode}} -- {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Read only',
        arguments: '--sandbox read-only',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Workspace auto',
        arguments: '--sandbox workspace-write --ask-for-approval never',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--dangerously-bypass-approvals-and-sandbox',
        color: 'red',
      },
    ],
    // Codex has no effort flag, and its `-c` overrides start it without its shared
    // background server, so it gets no reasoning levels.
    isBuiltin: true,
  },
  {
    name: 'Grok Build',
    openCommand: 'grok {{launchMode}}',
    continueCommand: 'grok --continue {{launchMode}}',
    promptCommand: 'grok {{launchMode}} -- {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--permission-mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Auto',
        arguments: '--permission-mode auto',
        color: 'orange',
      },
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--yolo',
        color: 'red',
      },
    ],
    // Levels offered by Grok Build's default model; the CLI parses a few more.
    reasoningLevels: reasoningLevels(
      ['low', 'medium', 'high', 'xhigh'],
      (level) => `--effort ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Antigravity CLI',
    openCommand: 'agy {{antigravityAutoTrustArgs}} {{launchMode}}',
    continueCommand: 'agy {{antigravityAutoTrustArgs}} --continue {{launchMode}}',
    promptCommand: 'agy {{antigravityAutoTrustArgs}} {{launchMode}} -i {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Accept edits',
        arguments: '--mode accept-edits',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'Dangerously skip permissions',
        arguments: '--dangerously-skip-permissions',
        color: 'red',
      },
    ],
    reasoningLevels: reasoningLevels(
      ['low', 'medium', 'high', 'xhigh', 'max'],
      (level) => `--effort ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'OpenCode',
    openCommand: 'opencode {{launchMode}}',
    continueCommand: 'opencode --continue {{launchMode}}',
    // `=` keeps prompts starting with `-` from being read as options.
    promptCommand: 'opencode {{launchMode}} --prompt={{prompt}}',
    // OpenCode 2 won't start with `--agent plan`. Presets made earlier keep it for 1.x.
    launchModes: [
      {
        id: randomUUID(),
        name: 'Auto',
        arguments: '--auto',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Cursor CLI',
    // Grok Build's installer also links `agent`; Cursor's still links `cursor-agent`.
    openCommand: 'cursor-agent {{launchMode}}',
    continueCommand: 'cursor-agent --continue {{launchMode}}',
    promptCommand: 'cursor-agent {{launchMode}} -- {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Ask',
        arguments: '--mode ask',
        color: 'cyan',
      },
      {
        id: randomUUID(),
        name: 'Force',
        arguments: '--force',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'GitHub Copilot CLI',
    openCommand: 'copilot {{launchMode}}',
    // `--resume` and `--continue` pick the newest session of any workspace, so start fresh.
    continueCommand: 'copilot {{launchMode}}',
    promptCommand: 'copilot {{launchMode}} --interactive={{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Autopilot',
        arguments: '--mode autopilot',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'Allow all tools',
        arguments: '--allow-all',
        color: 'red',
      },
    ],
    reasoningLevels: reasoningLevels(
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      (level) => `--effort=${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Hermes Agent',
    openCommand: 'hermes chat {{launchMode}}',
    // `--continue` follows a breadcrumb keyed by tty device, which Komla panes
    // reuse, else the newest session anywhere, and cds into that session's
    // directory. Start fresh instead; `/resume` picks a past session.
    continueCommand: 'hermes chat {{launchMode}}',
    // On a TTY, `-q` seeds the first turn and keeps the session open.
    promptCommand: 'hermes chat {{launchMode}} -q {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--yolo',
        color: 'red',
      },
    ],
    reasoningLevels: reasoningLevels(
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      (level) => `--reasoning ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Factory Droid',
    openCommand: 'droid {{launchMode}}',
    continueCommand: 'droid {{launchMode}} --resume',
    promptCommand: 'droid {{launchMode}} {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Spec',
        arguments: '--use-spec',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Auto low',
        arguments: '--auto low',
        color: 'amber',
      },
      {
        id: randomUUID(),
        name: 'Auto medium',
        arguments: '--auto medium',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'Auto high',
        arguments: '--auto high',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Amp',
    openCommand: 'amp {{launchMode}}',
    continueCommand: 'amp {{launchMode}} threads continue',
    // Piped stdin seeds the first message and keeps Amp interactive;
    // `-x` would run headless and exit.
    promptCommand: 'echo {{prompt}} | amp {{launchMode}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Dangerously allow all',
        arguments: '--dangerously-allow-all',
        color: 'red',
      },
    ],
    // Amp's agent modes are named by effort; each also picks the model and tools.
    reasoningLevels: reasoningLevels(
      ['low', 'medium', 'high', 'ultra'],
      (level) => `--mode ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Qwen Code',
    openCommand: 'qwen {{launchMode}}',
    // `--resume` without an id opens a picker; `--continue` resumes this project's latest.
    continueCommand: 'qwen --continue {{launchMode}}',
    promptCommand: 'qwen {{launchMode}} --prompt-interactive={{prompt}}',
    // Qwen Code starts in its auto mode, so Manual brings back the prompts.
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--approval-mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Manual',
        arguments: '--approval-mode default',
        color: 'emerald',
      },
      {
        id: randomUUID(),
        name: 'Accept edits',
        arguments: '--approval-mode auto-edit',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--approval-mode yolo',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Gemini',
    openCommand: 'gemini --skip-trust {{launchMode}}',
    continueCommand: 'gemini --skip-trust {{launchMode}} --resume latest',
    // Gemini drops a positional prompt after `--`.
    promptCommand: 'gemini --skip-trust {{launchMode}} --prompt-interactive={{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--approval-mode plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Accept edits',
        arguments: '--approval-mode auto_edit',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--approval-mode yolo',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Mistral Vibe',
    openCommand: 'vibe --trust {{launchMode}}',
    // A resumed session keeps the agent it started with.
    continueCommand: 'vibe --continue --trust {{launchMode}}',
    promptCommand: 'vibe --trust {{launchMode}} -- {{prompt}}',
    // Vibe 3.0.0 removed the plan agent.
    launchModes: [
      {
        id: randomUUID(),
        name: 'Ask',
        arguments: '--agent ask',
        color: 'cyan',
      },
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--yolo',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Pi',
    openCommand: 'pi {{launchMode}}',
    continueCommand: 'pi {{launchMode}} -c',
    // `--` keeps prompts starting with `-` from being read as options. Pi
    // accepts it from 0.84.3.
    promptCommand: 'pi {{launchMode}} -- {{prompt}}',
    launchModes: [],
    reasoningLevels: reasoningLevels(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      (level) => `--thinking ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Goose',
    openCommand: 'goose session',
    // `--resume` fails without a session and isn't per directory, so start fresh.
    continueCommand: 'goose session',
    promptCommand: 'goose run --interactive --text={{prompt}}',
    launchModes: [],
    isBuiltin: true,
  },
  {
    name: 'Auggie',
    openCommand: 'auggie {{launchMode}}',
    continueCommand: 'auggie --resume {{launchMode}}',
    promptCommand: 'auggie {{launchMode}} -- {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Ask',
        arguments: '--ask',
        color: 'blue',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Devin',
    openCommand: 'devin {{launchMode}}',
    continueCommand: 'devin --continue {{launchMode}}',
    promptCommand: 'devin {{launchMode}} -- {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Accept edits',
        arguments: '--permission-mode accept-edits',
        color: 'purple',
      },
      {
        id: randomUUID(),
        name: 'Bypass',
        arguments: '--permission-mode bypass',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Kiro CLI',
    // Kiro CLI 2.33+ takes --trust-workspace.
    openCommand: 'kiro-cli chat --trust-workspace {{launchMode}}',
    continueCommand: 'kiro-cli chat --trust-workspace --resume {{launchMode}}',
    promptCommand: 'kiro-cli chat --trust-workspace {{launchMode}} -- {{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Spec',
        arguments: '--mode spec',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Trust all tools',
        arguments: '--trust-all-tools',
        color: 'red',
      },
    ],
    reasoningLevels: reasoningLevels(
      ['low', 'medium', 'high', 'xhigh', 'max'],
      (level) => `--effort ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Kimi Code',
    openCommand: 'kimi {{launchMode}}',
    continueCommand: 'kimi --continue {{launchMode}}',
    // Kimi Code only runs a prompt headless (`-p`), so it can't start with one.
    promptCommand: '',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Ask when needed',
        arguments: '--yolo',
        color: 'red',
      },
      {
        id: randomUUID(),
        name: 'Never ask',
        arguments: '--auto',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Kilo Code',
    openCommand: 'kilo {{launchMode}}',
    // `--continue` picks the repository's newest session, which may be another worktree's.
    continueCommand: 'kilo {{launchMode}}',
    promptCommand: 'kilo {{launchMode}} --prompt={{prompt}}',
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--agent plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Ask',
        arguments: '--agent ask',
        color: 'cyan',
      },
      {
        id: randomUUID(),
        name: 'Auto',
        arguments: '--auto',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Cline',
    openCommand: 'cline {{launchMode}}',
    // Cline resumes only by session id.
    continueCommand: 'cline {{launchMode}}',
    // Without `-i`, a prompt runs headless.
    promptCommand: 'cline -i {{launchMode}} -- {{prompt}}',
    // Cline auto-approves every tool unless told otherwise.
    launchModes: [
      {
        id: randomUUID(),
        name: 'Plan',
        arguments: '--plan',
        color: 'blue',
      },
      {
        id: randomUUID(),
        name: 'Manual',
        arguments: '--auto-approve false',
        color: 'emerald',
      },
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--yolo',
        color: 'red',
      },
    ],
    reasoningLevels: reasoningLevels(
      ['none', 'low', 'medium', 'high', 'xhigh'],
      (level) => `--thinking ${level}`
    ),
    isBuiltin: true,
  },
  {
    name: 'Crush',
    openCommand: 'crush {{launchMode}}',
    continueCommand: 'crush --continue {{launchMode}}',
    // `crush run` is headless, so Crush can't start with a prompt.
    promptCommand: '',
    launchModes: [
      {
        id: randomUUID(),
        name: 'YOLO',
        arguments: '--yolo',
        color: 'red',
      },
    ],
    isBuiltin: true,
  },
  {
    name: 'Shell Only',
    openCommand: '',
    continueCommand: '',
    promptCommand: '',
    launchModes: [],
    isBuiltin: true,
  },
  {
    name: 'Custom',
    openCommand: '',
    continueCommand: '',
    promptCommand: '',
    launchModes: [],
    isBuiltin: true,
  },
];

export const PRESET_CONFIG_VERSION = 1;

function reasoningLevelArguments(
  preset: AgentPreset,
  reasoningLevelId: string | null | undefined
): string | undefined {
  if (!reasoningLevelId) return undefined;
  return preset.reasoningLevels?.find((level) => level.id === reasoningLevelId)?.arguments.trim();
}

// Hand-edited preset files can leave out level fields. Keep levels that have
// an id and give them string names and arguments.
function normalizeReasoningLevels(value: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((level: unknown) => {
    if (!level || typeof level !== 'object') return [];
    const { id, name, arguments: args } = level as Record<string, unknown>;
    if (typeof id !== 'string') return [];
    return [
      {
        id,
        name: typeof name === 'string' ? name : '',
        arguments: typeof args === 'string' ? args : '',
      },
    ];
  });
}

const PRESET_CONFIG_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

interface AgentPresetsConfig {
  _version?: number;
  activePresets?: ActivePresetEntry[];
  presets: AgentPreset[];
}

// Escape a prompt string so newlines are delivered as real line breaks to the
// CLI tool.  On POSIX we wrap the content in $(printf -- '…') — inside printf's
// single-quoted format string only \, ', and % need escaping, and \n is
// interpreted as a real newline.  On Windows/PowerShell `n inside double quotes
// is a native newline escape.
function escapePromptForShell(
  prompt: string,
  shellFamily: 'desktop' | 'posix' = 'desktop'
): string {
  // Strip null bytes and normalize line endings. Standalone \r must be caught
  // because ConPTY (Windows) treats \r as Enter, which would submit partial
  // commands.
  const normalized = prompt.replaceAll('\u0000', '').replace(/\r\n|\r/g, '\n');

  // WSL mode runs commands through bash, so it needs POSIX escaping even though
  // process.platform is 'win32'.
  if (usesPowerShell(shellFamily)) {
    // Windows PowerShell 5.1 drops embedded double quotes from native program
    // arguments unless they are escaped for the C runtime; PowerShell 7.3+
    // passes them intact.
    const nativeEscaped = escapeNativeArgument(normalized);
    const value =
      nativeEscaped !== normalized && /(?:^|[\\/])powershell\.exe$/i.test(getShell())
        ? nativeEscaped
        : normalized;
    // PowerShell: `n inside double-quoted strings is a real newline.
    return escapePowerShellDoubleQuoted(value).replace(/\n/g, '`n');
  }

  // POSIX: escape for printf's single-quoted format string, then wrap in
  // $(printf -- '…').  The command substitution is evaluated inside double quotes
  // added by the build methods, so the CLI receives an argument with real
  // newline characters.
  const escaped = normalized
    .replace(/\\/g, '\\\\') // Backslashes (printf interprets \-sequences)
    .replace(/%/g, '%%') // Percent signs (printf format specifiers)
    .replace(/'/g, "'\\''") // Single quotes (end-quote, escaped quote, re-open)
    .replace(/\n/g, '\\n'); // Newlines → printf \n (becomes real newlines)

  return `$(printf -- '${escaped}')`;
}

// Create default presets with UUIDs
function createDefaultPresets(): AgentPreset[] {
  return BUILTIN_PRESETS.map((preset) => ({
    ...preset,
    id: randomUUID(),
  }));
}

function createDefaultConfig(): AgentPresetsConfig {
  return {
    _version: PRESET_CONFIG_VERSION,
    activePresets: [],
    presets: [],
  };
}

// A config with the templates pre-populated, for the defaults reference file
function createDefaultsReferenceConfig(): AgentPresetsConfig {
  return {
    _version: PRESET_CONFIG_VERSION,
    presets: createDefaultPresets(),
  };
}

class AgentPresetService {
  private settingsPath: string;
  private presetsPath: string;
  private defaultsPath: string;
  private defaultPresetsPath: string;
  private watcher: FileWatcher | null = null;
  private presets: Map<string, AgentPreset> = new Map();
  private activePresets: ActivePresetEntry[] = [];
  private initialized = false;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor() {
    const komlaPath = getKomlaBasePath();
    this.settingsPath = join(komlaPath, 'settings');
    this.presetsPath = join(this.settingsPath, 'agent-presets.json');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultPresetsPath = join(this.defaultsPath, 'agent-presets.json');

    this.ensureSettingsDirectory();
    this.loadConfig();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  private ensureSettingsDirectory(): void {
    // Create settings directory
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    // Create defaults directory if needed
    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }

    // Write defaults file for reference on first run
    if (!existsSync(this.defaultPresetsPath)) {
      const referenceConfig = createDefaultsReferenceConfig();
      writeFileSync(this.defaultPresetsPath, JSON.stringify(referenceConfig, null, 2), 'utf-8');
    }

    // Write user config if not exists — empty config (templates live in code)
    if (!existsSync(this.presetsPath)) {
      const emptyConfig = createDefaultConfig();
      writeFileSync(this.presetsPath, JSON.stringify(emptyConfig, null, 2), 'utf-8');
    }
  }

  private loadConfig(): void {
    try {
      if (existsSync(this.presetsPath)) {
        const data = readFileSync(this.presetsPath, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const sourceVersion = typeof parsed._version === 'number' ? parsed._version : 1;
        const canPersist = sourceVersion <= PRESET_CONFIG_VERSION;
        let needsSave = sourceVersion < PRESET_CONFIG_VERSION;
        const config = migrate(
          parsed,
          PRESET_CONFIG_VERSION,
          PRESET_CONFIG_MIGRATIONS
        ) as unknown as AgentPresetsConfig;
        this.presets.clear();

        // Templates copied in, as from the defaults reference file, become user presets
        for (const preset of config.presets) {
          preset.launchModes = preset.launchModes ?? [];
          preset.reasoningLevels = normalizeReasoningLevels(preset.reasoningLevels);
          if (preset.isBuiltin) {
            preset.isBuiltin = false;
            needsSave = true;
          }
          this.presets.set(preset.id, preset);
        }

        // Load activePresets, filtering out any stale entries referencing deleted presets
        if (config.activePresets && config.activePresets.length > 0) {
          const filtered = config.activePresets.filter((e) => this.presets.has(e.presetId));
          if (filtered.length !== config.activePresets.length) {
            needsSave = true;
          }
          this.activePresets = filtered;
        }

        // Persist load-time changes, but never over a file from a newer version
        if (needsSave && canPersist) {
          this.saveConfigImmediate();
        }
      }
    } catch (error) {
      console.error('Failed to load agent presets config:', error);
    }
  }

  private saveConfig(): void {
    // Debounce writes to prevent cascading freezes during rapid updates
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      try {
        this.writeConfig();
      } catch (error) {
        console.error('Failed to save agent presets config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  // Save immediately without debounce (used for changes made during load)
  private saveConfigImmediate(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.writeConfig();
  }

  private writeConfig(): void {
    const config: AgentPresetsConfig = {
      _version: PRESET_CONFIG_VERSION,
      activePresets: this.activePresets,
      presets: this.list(),
    };
    writeFileAtomicSync(this.presetsPath, JSON.stringify(config, null, 2));
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new FileWatcher(this.presetsPath, () => {
      this.loadConfig();
      this.notifyRenderer();
    });
    await this.watcher.start();
  }

  private notifyRenderer(): void {
    const data = {
      presets: this.list(),
      activePreset: this.getActive() || null,
      activePresets: this.getActivePresets(),
    };
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.AGENT_PRESETS_CHANGED, data);
      }
    }
  }

  // Create default presets from builtins
  createDefaultPresets(): AgentPreset[] {
    return createDefaultPresets();
  }

  // Get all builtin templates (not persisted, defined in code only)
  listTemplates(): Omit<AgentPreset, 'id'>[] {
    return BUILTIN_PRESETS;
  }

  // Get all user presets
  list(): AgentPreset[] {
    return Array.from(this.presets.values());
  }

  // Get a specific preset
  get(id: string): AgentPreset | undefined {
    return this.presets.get(id);
  }

  // Get the active preset
  getActive(): AgentPreset | undefined {
    return this.getFirstActive();
  }

  // Get the active preset ID
  getActiveId(): string | null {
    return this.getFirstActive()?.id ?? null;
  }

  // Get active presets list sorted by most recently used
  getActivePresets(): ActivePresetEntry[] {
    return [...this.activePresets].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  // Get the first (most recently used) active preset
  getFirstActive(): AgentPreset | undefined {
    const sorted = this.getActivePresets();
    for (const entry of sorted) {
      const preset = this.presets.get(entry.presetId);
      if (preset) return preset;
    }
    return undefined;
  }

  // Get the preset for a workspace, falling back to first active
  getPresetForWorkspace(presetId: string | null | undefined): AgentPreset | undefined {
    if (presetId) {
      const preset = this.presets.get(presetId);
      if (preset) return preset;
    }
    return this.getFirstActive();
  }

  // Add a preset to the active list
  addActivePreset(presetId: string): void {
    const preset = this.presets.get(presetId);
    if (!preset) {
      throw new Error(`Preset ${presetId} not found`);
    }
    if (this.activePresets.some((e) => e.presetId === presetId)) {
      return;
    }
    this.activePresets.push({ presetId, lastUsedAt: Date.now() });
    this.saveConfig();
  }

  // Find a preset by name (case-insensitive)
  findByNameInsensitive(name: string): AgentPreset | undefined {
    const lower = name.toLowerCase();
    for (const preset of this.presets.values()) {
      if (preset.name.toLowerCase() === lower) {
        return preset;
      }
    }
    return undefined;
  }

  // Remove a preset from the active list
  removeActivePreset(presetId: string): void {
    if (this.activePresets.length <= 1) {
      throw new Error('Cannot remove the last active preset');
    }
    this.activePresets = this.activePresets.filter((e) => e.presetId !== presetId);
    this.saveConfig();
    // Clear agent-launch defaults if they referenced this preset.
    const config = configService.get();
    if (config.agentLaunchDefaultPresetId === presetId) {
      configService.update({
        agentLaunchDefaultPresetId: undefined,
        agentLaunchDefaultLaunchModeId: undefined,
      });
    }
  }

  // Record usage of a preset (updates lastUsedAt and optionally lastLaunchModeId).
  // reasoningLevelId is only recorded when passed; undefined leaves it unchanged.
  recordPresetUsage(
    presetId: string,
    launchModeId?: string | null,
    reasoningLevelId?: string | null
  ): void {
    const entry = this.activePresets.find((e) => e.presetId === presetId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.lastLaunchModeId = launchModeId ?? null;
      if (reasoningLevelId !== undefined) {
        entry.lastReasoningLevelId = reasoningLevelId;
      }
      this.saveConfig();
      this.notifyRenderer();
    }
  }

  // Set the active preset
  setActive(id: string, launchModeId?: string | null): void {
    if (!this.presets.has(id)) {
      throw new Error(`Preset ${id} not found`);
    }
    const existing = this.activePresets.find((e) => e.presetId === id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      if (launchModeId !== undefined) {
        existing.lastLaunchModeId = launchModeId;
      }
    } else {
      this.activePresets.push({
        presetId: id,
        lastUsedAt: Date.now(),
        lastLaunchModeId: launchModeId,
      });
    }
    this.saveConfig();
  }

  // Create a new custom preset
  create(preset: Omit<AgentPreset, 'id'>): AgentPreset {
    const newPreset: AgentPreset = {
      ...preset,
      id: randomUUID(),
    };
    this.presets.set(newPreset.id, newPreset);
    this.saveConfig();
    return newPreset;
  }

  // Create presets and activate them in order, the first as the most recently used
  createActive(presets: Omit<AgentPreset, 'id'>[]): AgentPreset[] {
    const now = Date.now();
    const created = presets.map((preset, index) => {
      const newPreset: AgentPreset = { ...preset, id: randomUUID() };
      this.presets.set(newPreset.id, newPreset);
      this.activePresets.push({ presetId: newPreset.id, lastUsedAt: now - index });
      return newPreset;
    });
    this.saveConfig();
    return created;
  }

  // Update an existing preset
  update(id: string, updates: Partial<Omit<AgentPreset, 'id'>>): AgentPreset {
    const preset = this.presets.get(id);
    if (!preset) {
      throw new Error(`Preset ${id} not found`);
    }
    const updatedPreset = { ...preset, ...updates };
    this.presets.set(id, updatedPreset);
    this.saveConfig();
    this.notifyRenderer();
    // If launch modes changed and the agent-launch default no longer exists, clear it.
    if (updates.launchModes) {
      this.clearStaleAgentLaunchMode(updatedPreset);
    }
    return updatedPreset;
  }

  // Delete a preset
  delete(id: string): void {
    const preset = this.presets.get(id);
    if (!preset) {
      throw new Error(`Preset ${id} not found`);
    }
    const isActive = this.activePresets.some((entry) => entry.presetId === id);
    const hasActiveFallback = this.activePresets.some(
      (entry) => entry.presetId !== id && this.presets.has(entry.presetId)
    );
    if (isActive && !hasActiveFallback) {
      throw new Error('Cannot delete the last active preset');
    }

    const previousPresets = this.presets;
    const previousActivePresets = this.activePresets;
    const hadPendingSave = this.saveDebounceTimer !== null;
    this.presets = new Map(this.presets);
    this.presets.delete(id);
    this.activePresets = this.activePresets.filter((e) => e.presetId !== id);
    try {
      this.saveConfigImmediate();
    } catch (error) {
      this.presets = previousPresets;
      this.activePresets = previousActivePresets;
      if (hadPendingSave) this.saveConfig();
      throw error;
    }
    this.notifyRenderer();
    // Clear agent-launch defaults if they referenced this preset.
    const config = configService.get();
    if (config.agentLaunchDefaultPresetId === id) {
      configService.update({
        agentLaunchDefaultPresetId: undefined,
        agentLaunchDefaultLaunchModeId: undefined,
      });
    }
  }

  reorder(id: string, newOrder: number): void {
    if (!this.presets.has(id)) {
      throw new Error(`Preset ${id} not found`);
    }

    const presets = this.list();
    const sourceIndex = presets.findIndex((preset) => preset.id === id);
    const reordered = moveItem(presets, sourceIndex, newOrder);
    if (reordered === presets) return;

    this.presets = new Map(reordered.map((preset) => [preset.id, preset]));
    this.saveConfig();
    this.notifyRenderer();
  }

  // Clear the default agent launch mode if it no longer exists in the preset.
  private clearStaleAgentLaunchMode(preset: AgentPreset): void {
    const config = configService.get();
    if (
      config.agentLaunchDefaultPresetId === preset.id &&
      config.agentLaunchDefaultLaunchModeId &&
      !preset.launchModes.some((m) => m.id === config.agentLaunchDefaultLaunchModeId)
    ) {
      configService.update({ agentLaunchDefaultLaunchModeId: undefined });
    }
  }

  // Resolve a command template, optionally substituting {{prompt}} with the escaped prompt
  resolveCommand(
    command: string,
    prompt?: string,
    shellFamily: 'desktop' | 'posix' = 'desktop'
  ): string {
    if (!command.trim()) return '';

    if (prompt !== undefined) {
      const escapedPrompt = escapePromptForShell(prompt, shellFamily);
      if (command.includes('{{prompt}}')) {
        // A replacer function keeps `$&`-style patterns in the prompt literal.
        return command.replace(/\{\{prompt\}\}/g, () => `"${escapedPrompt}"`);
      }
      return `${command} "${escapedPrompt}"`;
    }

    // No prompt — strip placeholder if present
    return command.replace(/\s*\{\{prompt\}\}/g, '');
  }

  resolvePresetCommand(
    preset: AgentPreset,
    intent: 'open' | 'prompt' | 'continue',
    launchModeId?: string | null,
    prompt?: string,
    shellFamily: 'desktop' | 'posix' = 'desktop',
    reasoningLevelId?: string | null
  ): string {
    const mode = launchModeId
      ? preset.launchModes.find((candidate) => candidate.id === launchModeId)
      : undefined;

    const reasoningArguments = reasoningLevelArguments(preset, reasoningLevelId);

    const command =
      intent === 'continue'
        ? preset.continueCommand
        : intent === 'prompt'
          ? preset.promptCommand
          : preset.openCommand;
    if (!command.trim()) return '';

    // Reasoning flags travel with the launch mode so they land wherever the
    // template places {{launchMode}} (e.g. before Gemini's `--` prompt separator).
    const launchModeArguments = [mode?.arguments?.trim(), reasoningArguments]
      .filter(Boolean)
      .join(' ');
    if (!launchModeArguments) {
      return this.resolveCommand(
        command.replace(/\s*\{\{launchMode\}\}/g, ''),
        prompt,
        shellFamily
      );
    }

    const commandWithLaunchMode = command.includes('{{launchMode}}')
      ? command.replace(/\{\{launchMode\}\}/g, launchModeArguments)
      : `${command} ${launchModeArguments}`;
    return this.resolveCommand(commandWithLaunchMode, prompt, shellFamily);
  }

  /**
   * POSIX launch commands with a `{{prompt}}` placeholder where a shell-quoted
   * prompt goes, for a remote host to start this preset without Komla.
   */
  resolvePosixPromptTemplate(
    preset: AgentPreset,
    launchModeId?: string | null
  ): { promptCommand: string; openCommand: string } | undefined {
    const sentinel = 'KOMLA_PROMPT_PLACEHOLDER';
    const promptCommand = resolvePosixAutoTrustArgs(
      this.resolvePresetCommand(preset, 'prompt', launchModeId, sentinel, 'posix').replace(
        `"$(printf -- '${sentinel}')"`,
        '{{prompt}}'
      )
    );
    const openCommand = resolvePosixAutoTrustArgs(
      this.resolvePresetCommand(preset, 'open', launchModeId, undefined, 'posix')
    );
    if (!promptCommand.includes('{{prompt}}') || promptCommand.includes(sentinel) || !openCommand) {
      return undefined;
    }
    return { promptCommand, openCommand };
  }

  /** The POSIX command that resumes this preset's last session, if it has one. */
  resolvePosixContinueCommand(
    preset: AgentPreset,
    launchModeId?: string | null
  ): string | undefined {
    if (!preset.continueCommand.trim()) return undefined;
    return (
      resolvePosixAutoTrustArgs(
        this.resolvePresetCommand(preset, 'continue', launchModeId, undefined, 'posix')
      ) || undefined
    );
  }

  // Find preset by name
  findByName(name: string): AgentPreset | undefined {
    for (const preset of this.presets.values()) {
      if (preset.name === name) {
        return preset;
      }
    }
    return undefined;
  }

  // Get the Claude Code preset — checks user presets first, falls back to template
  getClaudeCodePreset(): AgentPreset | Omit<AgentPreset, 'id'> | undefined {
    const userPreset = this.findByName('Claude Code');
    if (userPreset) return userPreset;
    return BUILTIN_PRESETS.find((p) => p.name === 'Claude Code');
  }

  getSettingsPath(): string {
    return this.presetsPath;
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const agentPresetService = new AgentPresetService();
