import type { ActionSshExecutionLocation, ActionType } from './action';
import type {
  AgentPlacement,
  AheadTargetAction,
  BehindTargetAction,
  SetupStep,
  SimpleAheadAction,
} from './project';

/**
 * An agent by name rather than id: agent presets and their launch modes get new ids on each
 * Komla installation.
 */
export interface SshProjectManifestAgent {
  agentName?: string;
  launchModeName?: string;
}

export interface SshProjectManifestSetupStep extends Omit<SetupStep, 'agent'> {
  agent?: SshProjectManifestAgent;
}

/** A Quick Command scoped to the project. */
export interface SshProjectManifestQuickCommand {
  id: string;
  title: string;
  content: string;
  type: ActionType;
  agent?: SshProjectManifestAgent;
  sshExecutionLocation?: ActionSshExecutionLocation;
  background?: boolean;
}

export interface SshProjectManifestSettings {
  defaultBranchPrefix: string;
  baseBranch?: string;
  aheadTargetAction?: AheadTargetAction;
  autoPushAfterMerge?: boolean;
  aheadTargetActionId?: string;
  behindTargetAction?: BehindTargetAction;
  autoMainBranchAction?: SimpleAheadAction;
  autoOtherBranchAction?: SimpleAheadAction;
  autoMainActionId?: string;
  autoOtherActionId?: string;
}

/**
 * Portable description of a project's settings, written to
 * `<base path>/projects/<id>.json` on an SSH host where it has workspaces, so
 * another Komla installation can copy them. The id comes from the repository's
 * origin, which is how installations match their projects.
 */
export interface SshProjectManifest {
  schema: 1;
  gitUrl: string;
  name: string;
  color?: string;
  icon?: string;
  workspaceSetup: {
    setupSteps: SshProjectManifestSetupStep[];
    agentPlacement: AgentPlacement;
    agentLayoutOrder: number;
    trashCleanupScript: string;
  };
  quickCommands: SshProjectManifestQuickCommand[];
  settings: SshProjectManifestSettings;
  updatedAt: number;
  /** The installation that wrote this copy. */
  writtenBy?: string;
}

/** What copying a project's settings from an SSH host can bring over. */
export const SSH_PROJECT_SETTINGS_PARTS = [
  'appearance',
  'workspaceSetup',
  'quickCommands',
  'settings',
] as const;
export type SshProjectSettingsPart = (typeof SSH_PROJECT_SETTINGS_PARTS)[number];

/** A project another Komla installation published on an SSH host, as offered for copying here. */
export interface SshHostProject {
  /** The Project manifest's id on the host. */
  manifestId: string;
  name: string;
  color?: string;
  icon?: string;
  gitUrl: string;
  /** This installation's project for the repository; absent when copying would add one. */
  projectId?: string;
  /** This installation published these settings for a project it has since removed. */
  removedHere?: boolean;
  /** The parts that differ from this installation's project, or that a new one would take. */
  differs: SshProjectSettingsPart[];
  /** This installation's project takes the host's settings as they change. */
  keepsInSync?: boolean;
  updatedAt: number;
}

export interface SshHostProjectImport {
  manifestId: string;
  parts: SshProjectSettingsPart[];
  /** Turns keeping the project in sync on or off; unset leaves it as it is. */
  keepInSync?: boolean;
}

export type SshHostProjectImportResult =
  | { manifestId: string; ok: true; projectId: string; added: boolean }
  | {
      manifestId: string;
      ok: false;
      error: string;
      /** The user didn't apply the changes. */
      cancelled?: boolean;
    };
