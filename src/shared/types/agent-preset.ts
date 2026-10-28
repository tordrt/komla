/**
 * Agent preset types shared between main and renderer processes.
 */

export interface LaunchMode {
  id: string;
  name: string; // Display label in mode picker
  arguments?: string; // Reusable arguments, e.g. "--permission-mode plan"
  color?: string; // Tailwind color key
  // Where agents may start this mode themselves; unset follows agentLaunchPolicy
  agentLaunch?: AgentLaunchPolicy;
}

/**
 * Where agents may start a launch mode through `komla agent launch` or MCP:
 * nowhere, only on an SSH host the user marked isolated, or anywhere.
 */
export type AgentLaunchPolicy = 'never' | 'isolated' | 'always';

// Optional reasoning/effort flags, composed alongside the launch mode arguments.
export interface ReasoningLevel {
  id: string;
  name: string; // Display label in the effort picker
  arguments: string; // e.g. "--effort high"
}

// Icons the level picker can show. The gauge shows a meter of the picked level instead.
export const LEVEL_PICKER_ICONS = [
  'gauge',
  'brain',
  'lightbulb',
  'lightning',
  'sparkle',
  'cpu',
  'rocket',
  'sliders',
  'timer',
  'atom',
  'flask',
  'fire',
] as const;
export type LevelPickerIcon = (typeof LEVEL_PICKER_ICONS)[number];

export const MAX_LEVEL_PICKER_TITLE_LENGTH = 24;
export const MAX_REASONING_LEVEL_NAME_LENGTH = 40;
export const MAX_REASONING_LEVELS = 12;

// How the level picker in the new workspace dialog looks, such as for a model instead of effort.
export interface LevelPicker {
  title?: string; // Unset: "Effort"
  icon?: LevelPickerIcon; // Unset: gauge
  hidden?: boolean; // Hidden: launches use the agent default, levels are kept
}

export interface AgentPreset {
  id: string;
  name: string;
  openCommand: string; // Command to start a new session
  continueCommand: string; // Command to resume or choose an existing session in the worktree
  promptCommand: string; // Command to start with an initial prompt
  launchModes: LaunchMode[];
  reasoningLevels?: ReasoningLevel[];
  levelPicker?: LevelPicker;
  isBuiltin: boolean;
}

export interface ActivePresetEntry {
  presetId: string;
  lastUsedAt: number;
  lastLaunchModeId?: string | null;
  lastReasoningLevelId?: string | null;
}
