import type { SshWorkspaceLaunch } from './ssh-workspace-manifest';

/** When an automation runs: a five-field cron expression read in an IANA time zone. */
export interface AutomationSchedule {
  /** `minute hour day-of-month month day-of-week`, e.g. `0 9 * * 1-5`. */
  cron: string;
  timeZone: string;
}

/** Where an automation's runs start: this computer, or an SSH host whose cron starts them. */
export type AutomationTarget = { kind: 'local' } | { kind: 'ssh'; hostId: string };

/** An agent task Komla starts in a new workspace on a schedule. */
export interface Automation {
  id: string;
  name: string;
  prompt: string;
  /** This installation's project; undefined for an SSH automation whose repository no project here uses. */
  projectId?: string;
  /** Shown when the project isn't on this installation, e.g. one saved by another device. */
  projectName?: string;
  target: AutomationTarget;
  presetId?: string;
  launchModeId?: string;
  /** The branch runs start from; absent, the project's target branch when each run starts. */
  startBranch?: string;
  /** The agent's display name, for SSH automations saved by another device. */
  agentName?: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  /** How late a missed scheduled time may still start, e.g. after the computer slept. */
  missedRunGraceMinutes: number;
  createdAt: number;
  updatedAt: number;
}

export type AutomationRunStatus = 'started' | 'failed' | 'skipped';

/** One time an automation started, or the reason it didn't. */
export interface AutomationRun {
  id: string;
  automationId: string;
  trigger: 'schedule' | 'manual';
  /** The scheduled time this run is for; absent for manual runs. */
  scheduledFor?: number;
  startedAt: number;
  status: AutomationRunStatus;
  workspaceId?: string;
  branch?: string;
  /** Why the run failed or was skipped. */
  message?: string;
}

/** Whether the machine that runs a target's automations can start them on schedule. */
export interface AutomationSchedulerStatus {
  available: boolean;
  /** Shown when unavailable, e.g. cron isn't installed on the SSH host. */
  message?: string;
}

/**
 * Which SSH hosts listing automations reads again when stale: every host, or only those with
 * workspaces here, which Komla connects to anyway.
 */
export type AutomationHostReads = 'all' | 'in-use';

/** The automations of one target, with their recent runs, as the list shows them. */
export interface AutomationTargetSnapshot {
  target: AutomationTarget;
  automations: Automation[];
  /** Newest first, per automation id. */
  runs: Record<string, AutomationRun[]>;
  scheduler: AutomationSchedulerStatus;
  /** The host is being read; the automations are the last ones read, if any. */
  loading?: boolean;
  /** Set when the host couldn't be read; the automations are the last ones read, if any. */
  error?: string;
}

export interface SaveAutomationParams {
  /** Absent to create one. */
  id?: string;
  /** Where an edited automation was, when it moves to another target. */
  previousTarget?: AutomationTarget;
  name: string;
  prompt: string;
  projectId: string;
  target: AutomationTarget;
  presetId?: string;
  launchModeId?: string;
  startBranch?: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  missedRunGraceMinutes: number;
}

/**
 * An SSH automation as its host stores it, at `<base>/automations/<id>.json`.
 * The host's `komla automation tick`, run by cron each minute, starts each
 * run with the workspace and launch details compiled here when a device saved
 * it, so the host needs nothing from a desktop. Every device that connects to
 * the host reads the same files. Installation-local ids sit under `desktop`
 * as hints for the device that saved it.
 */
export interface HostAutomation {
  schema: 1;
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  missedRunGraceMinutes: number;
  /** The repository and worktree root new run workspaces use, like a workspace manifest's backend. */
  project: {
    remoteRepoPath: string;
    remoteProjectRoot: string;
    gitUrl: string;
    projectName?: string;
    baseBranch?: string;
    defaultBranch?: string;
    branchPrefix?: string;
  };
  /**
   * The branch runs start from instead of `project.baseBranch`, which stays their target. Absent,
   * runs follow the project's target branch, which each device that changes it saves again.
   */
  startBranch?: string;
  launch: SshWorkspaceLaunch;
  desktop?: { projectId?: string; presetId?: string; launchModeId?: string };
  createdAt: number;
  updatedAt: number;
  writtenBy?: string;
}

export const AUTOMATION_MISSED_RUN_GRACE_MINUTES = [0, 30, 60, 180, 720, 1440] as const;
export const DEFAULT_AUTOMATION_MISSED_RUN_GRACE_MINUTES = 720;
/** Runs kept per automation, newest first, besides the newest scheduled one. */
export const MAX_AUTOMATION_RUNS = 50;
