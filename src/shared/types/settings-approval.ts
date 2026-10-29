import type { AppearanceSettings } from './customization';

export type SettingsApprovalOperation = 'add' | 'edit' | 'delete' | 'change';

export type SettingsApprovalChangeKind =
  | 'action'
  | 'setup-step'
  | 'agent-placement'
  | 'trash-cleanup'
  | 'theme'
  | 'custom-theme'
  | 'accent-color'
  | 'corner-radius'
  | 'status-item'
  | 'hook'
  | 'shortcut'
  | 'terminal-setting'
  | 'agent-preset'
  | 'automation'
  | 'project-setting';

export interface SettingsApprovalDetail {
  label: string;
  value: string;
  /** What an edit changes the value from. */
  previous?: string;
}

/** A user-facing description of the resulting settings value being proposed. */
export interface SettingsApprovalChange {
  operation: SettingsApprovalOperation;
  kind: SettingsApprovalChangeKind;
  title: string;
  contentLabel?: 'Command' | 'Prompt' | 'Script';
  content?: string;
  /** Further commands the change runs, each shown in full under its label, or with `previous`,
   * what an edit changes it from (or a placeholder such as "Not set"), shown as the lines it
   * removes and adds. */
  moreContent?: { label: string; content: string; previous?: string }[];
  details: SettingsApprovalDetail[];
}

/** Settings files an agent reads and changes whole with `komla settings`. */
export const SETTINGS_FILE_RESOURCES = [
  'status-items',
  'hooks',
  'shortcuts',
  'terminal',
  'agents',
] as const;
export type SettingsFileResource = (typeof SETTINGS_FILE_RESOURCES)[number];

export interface SettingsApprovalPrompt {
  id: string;
  resource:
    | 'actions'
    | 'workspace-setup'
    | 'automations'
    | 'appearance'
    | 'project-settings'
    | SettingsFileResource;
  target: string;
  /** Who proposes the change and why, in place of saying an agent wants it. */
  description?: string;
  changes: SettingsApprovalChange[];
  warning?: string;
  /** Appearance the window shows while the user decides, and keeps if they apply it. */
  preview?: AppearanceSettings;
}

export type SettingsApprovalDecision = 'apply' | 'cancel';
