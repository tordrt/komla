import { isAbsolute, resolve } from 'path';

import {
  isAgentCapabilityEnabled,
  turnedOffCapabilityMessage,
  type AgentCapabilityId,
} from '../../../shared/constants/agent-capabilities';
import { IPC } from '../../../shared/constants/ipc-channels';
import {
  agentLaunchWorkspacePlacement,
  plannedWorkspaceEnvironment,
  unreadyPinnedHostMessage,
  type DesiredWorkspaceEnvironment,
} from '../../../shared/lib/agent-environment';
import { canStartWithPrompt } from '../../../shared/lib/agent-preset-prompt';
import { isBrowserUrl } from '../../../shared/lib/browser-tabs';
import {
  agentLaunchPolicy,
  agentsMayLaunch,
  isIsolatedEnvironment,
  skipsPermissionPrompts,
} from '../../../shared/lib/launch-mode-permissions';
import { levelPickerOf, shownReasoningLevels } from '../../../shared/lib/level-picker';
import {
  findWorkspaceMarker,
  markerShows,
  MAX_WORKSPACE_MARKERS,
  normalizeWorkspaceMarkerLabel,
  PROGRESS_MARKER_KEY,
  showsWorkspaceProgress,
  withoutWorkspaceMarker,
  withWorkspaceMarker,
  workspaceProgress,
  type WorkspaceMarker,
} from '../../../shared/lib/workspace-markers';
import {
  findWorkspaceTag,
  MAX_WORKSPACE_TAGS,
  normalizeWorkspaceTagName,
  withWorkspaceTag,
  workspaceTagKey,
  type WorkspaceTagDefinition,
  type WorkspaceTagTone,
} from '../../../shared/lib/workspace-tags';
import { isStatusIconSegment, MAX_STATUS_ITEM_ICONS } from '../../../shared/types/status-items';
import {
  isWorkspaceAttentionActionable,
  isWorkspaceSnoozed,
} from '../../../shared/types/workspace';
import { statusIconDataUrl } from '../../lib/status-icon';
import {
  statusItemSegmentsText,
  statusItemText,
  withLeadingIcon,
} from '../../lib/status-item-text';
import { parseSnoozeUntil, wokenMarks } from '../workspace-snooze';

import { komlaOperationCapability } from './capabilities';
import {
  terminalAgentState,
  waitForTerminal,
  type TerminalAgentState,
  type TerminalWaitOptions,
  type TerminalWaitReason,
  type TerminalWaitResult,
  type TerminalWaitSnapshot,
} from './terminal-wait';

import type { AgentTurnEnd } from './agent-turn-end';
import type { KomlaOperationResults } from './result-schema';
import type {
  AgentLaunchPolicy,
  AgentPreset,
  ActivePresetEntry,
  ReasoningLevel,
} from '../../../shared/types/agent-preset';
import type {
  VirtualDesktopStartedEvent,
  VirtualDesktopViewer,
} from '../../../shared/types/dev-preview';
import type { SshHost } from '../../../shared/types/ssh';
import type {
  StatusItemContent,
  StatusItemStyle,
  StatusItemTone,
  StatusItemSegment,
} from '../../../shared/types/status-items';
import type { TerminalStatus } from '../../../shared/types/terminal';
import type {
  AddAgentTabOptions,
  CreateWorkspaceParams,
  NewWorkspaceDraft,
  Workspace,
  WorkspaceVirtualDesktop,
  WorkspaceTrashRequest,
  WorkspaceAttention,
  NOTIFY_KINDS,
} from '../../../shared/types/workspace';
import type { TerminalText } from '../../lib/terminal-text';

const MAX_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;
type ProgressResult = KomlaOperationResults['workspace.progress']['progress'];
type MarkerResult = NonNullable<KomlaOperationResults['workspace.mark']['marker']>;

/** Lets `komla trash` reply before the Trash stops the terminal it runs in. */
export const TRASH_WITHOUT_TURN_DELAY_MS = 1000;
/** A turn that runs longer, as with a spinner no Stop turns off, keeps its workspace. */
export const TRASH_TURN_LIMIT_MS = 30 * 60 * 1000;
/** How long `komla wait` and `send --wait` wait by default before checking in. */
export const TERMINAL_WAIT_DEFAULT_MS = 180_000;
/** How long a sent message's turn may take to start before `send --wait` says it hasn't. */
export const TERMINAL_SEND_START_MS = 10_000;
/** How long `komla send` waits for the user to allow a message before it gives up. */
export const TERMINAL_SEND_APPROVAL_MS = 120_000;
/** A terminal this new may still be starting its agent, whose first turn `komla wait` waits for. */
export const TERMINAL_STARTUP_MS = 60_000;
/** History lines `komla read` shows above the screen by default. */
export const TERMINAL_READ_DEFAULT_HISTORY = 50;

type OperationTerminal = NonNullable<KomlaOperationWorkspace['terminals']>[number];

/**
 * Why moving to the Trash would cut work short, if it would: another tab's, or work no tab owns. Once the
 * caller's turn ended, also a failure or question it ended with.
 */
function trashBlocker(
  workspace: KomlaOperationWorkspace,
  callerTerminalId: string | undefined,
  turnEnded: boolean
): string | undefined {
  const terminals = workspace.terminals ?? [];
  const caller = terminals.find((t) => t.id === callerTerminalId);
  if (turnEnded && isWorkspaceAttentionActionable(caller?.attention)) {
    return 'Its turn ended with an error or a question for you.';
  }
  const others = terminals.filter((t) => t !== caller);
  if (others.some((terminal) => terminal.agentActive)) {
    return 'Another tab in this workspace is still working, and the Trash would stop it.';
  }
  if (others.some((terminal) => isWorkspaceAttentionActionable(terminal.attention))) {
    return 'An agent in another tab of this workspace is waiting for input or failed.';
  }
  if (workspace.agentActive && !terminals.some((terminal) => terminal.agentActive)) {
    return 'An agent in this workspace is still working, and the Trash would stop it.';
  }
  return undefined;
}

/**
 * The text as `komla send` types it: lines and tabs only. Escape sequences or control keys in it
 * could end a paste early and reach the agent as keys, as one answering a prompt.
 */
function typedText(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
      // `send` presses Enter itself, so a final newline from a file isn't a second one.
      .replace(/\n+$/, '')
  );
}

/** What a done, error or question says: the agent's text, else the notice's. */
function attentionText(
  attention: Pick<WorkspaceAttention, 'message' | 'body' | 'title'> | undefined
): string | undefined {
  return attention?.message ?? attention?.body ?? attention?.title;
}

function callerTerminal(context: KomlaOperationContext): string | undefined {
  return context.callerTerminalId ?? context.terminalId;
}

/** How a message names a terminal: by its tab's name, else its id. */
function terminalLabel(terminal: { id: string; name?: string }): string {
  return terminal.name ? `Terminal ${terminal.name} (${terminal.id})` : `Terminal ${terminal.id}`;
}

/** What a status item's click opens: a web page, and one popover at most. */
function checkStatusItemClick(
  link: string | undefined,
  popover: string | undefined,
  popoverMarkdown: string | undefined
): void {
  if (popover !== undefined && popoverMarkdown !== undefined) {
    throw new KomlaOperationError(
      'INVALID_STATUS_POPOVER',
      'A status item takes an HTML popover or a Markdown one, not both.',
      400
    );
  }
  if (link !== undefined && !isBrowserUrl(link)) {
    throw new KomlaOperationError(
      'INVALID_STATUS_LINK',
      'Status item links must be HTTP or HTTPS URLs.',
      400
    );
  }
}

/** Where the user lets agents start a launch mode, for an agent to pass on. */
function letAgentsStartHint(preset: Pick<AgentPreset, 'name'>): string {
  return `To let agents start it, they can edit ${preset.name} in Settings → Agents, pick where agents may start it from the robot button beside the mode and save.`;
}

/** Why an agent can't start a mode allowed only isolated where it would run, for it to pass on. */
function isolatedOnlyRefusal(
  preset: Pick<AgentPreset, 'name'>,
  mode: Pick<AgentPreset['launchModes'][number], 'name'>,
  environment: DesiredWorkspaceEnvironment
): string {
  const anywhere = `edit ${preset.name} in Settings → Agents, pick "Anywhere" from the robot button beside the mode and save`;
  return environment.kind === 'ssh'
    ? `Agents may start launch mode "${mode.name}" only on an SSH host marked isolated, and this agent would start on one that isn't. To allow it, they can mark the host isolated in Settings → SSH Hosts, or ${anywhere}.`
    : `Agents may start launch mode "${mode.name}" only on an SSH host marked isolated, and this agent would start on this computer. To allow it here, they can ${anywhere}.`;
}

function isolatedOnlyEffortRefusal(
  preset: Pick<AgentPreset, 'id' | 'name'>,
  effort: Pick<ReasoningLevel, 'id' | 'name'>,
  environment: DesiredWorkspaceEnvironment
): KomlaOperationError {
  const where =
    environment.kind === 'ssh'
      ? 'on an SSH host that isn’t. To allow it, they can mark the host isolated in Settings → SSH Hosts'
      : 'on this computer';
  return new KomlaOperationError(
    'AGENT_EFFORT_REQUIRES_ISOLATION',
    `${preset.name}'s effort level "${effort.name}" skips permission prompts, so agents may start it only on an SSH host marked isolated, and this agent would start ${where}. Launch without --effort to use the agent's default.`,
    403,
    { presetId: preset.id, effortId: effort.id, environment }
  );
}

interface AgentLaunchPin {
  presetId?: string;
  modeId?: string;
}

/** The agent and mode the user pinned for agent launches. */
function pinnedAgentLaunch(
  config: ReturnType<KomlaOperationDependencies['getConfig']>
): AgentLaunchPin {
  return {
    presetId: config.agentLaunchDefaultPresetId ?? undefined,
    modeId: config.agentLaunchDefaultLaunchModeId ?? undefined,
  };
}

/** Where agents may start a mode: anywhere for the one the user pinned for agent launches. */
function pinnedAgentLaunchPolicy(
  pin: AgentLaunchPin,
  presetId: string,
  mode: AgentPreset['launchModes'][number]
): AgentLaunchPolicy {
  return presetId === pin.presetId && mode.id === pin.modeId ? 'always' : agentLaunchPolicy(mode);
}

export interface KomlaOperationContext {
  terminalId?: string;
  workspaceId?: string;
  cwd?: string;
  sshHostId?: string;
  /** `workspaceId` is one `--workspace` named, not where the command runs. */
  targeted?: boolean;
  /** When an agent ran a command an SSH host queued while Komla was away, in epoch ms. */
  requestedAt?: number;
  /** Aborted once the caller stops waiting for the answer, which ends a wait early. */
  signal?: AbortSignal;
  /** The terminal the command runs in, also when `--workspace` names where it acts. */
  callerTerminalId?: string;
  /**
   * The user has just agreed to this very operation, as to a sidebar panel's confirmation, so
   * `send` doesn't ask again. Only code in this process sets it, never a request.
   */
  userConfirmed?: boolean;
}

/**
 * The context a typed command runs in. `--workspace` names the workspace to act on in place of the
 * calling terminal's, so nothing else about the caller selects it.
 */
export function komlaCommandContext({
  targetWorkspaceId,
  ...caller
}: KomlaOperationContext & { targetWorkspaceId?: string }): KomlaOperationContext {
  return targetWorkspaceId
    ? {
        workspaceId: targetWorkspaceId,
        sshHostId: caller.sshHostId,
        targeted: true,
        requestedAt: caller.requestedAt,
        signal: caller.signal,
        // The calling terminal stays the caller's own, which `send` and `wait` refuse.
        callerTerminalId: caller.callerTerminalId ?? caller.terminalId,
      }
    : caller;
}

export interface KomlaOperationWorkspace {
  id: string;
  projectId?: string | null;
  workingDirectory?: string;
  presetId?: string | null;
  launchModeId?: string | null;
  backend?: { kind: 'local' } | { kind: 'ssh'; hostId: string; gitUrl?: string };
  windowId?: string | null;
  name?: string;
  customName?: string;
  branchName?: string;
  tag?: string;
  markers?: WorkspaceMarker[];
  provisioning?: boolean;
  snoozedUntil?: number;
  wakesOnNotification?: boolean;
  attention?: WorkspaceAttention;
  status?: Workspace['status'];
  agentActive?: boolean;
  terminals?: Array<{
    id: string;
    name?: string;
    createdAt?: number;
    status?: TerminalStatus;
    agentActive?: boolean;
    attention?: WorkspaceAttention;
  }>;
  virtualDesktops?: WorkspaceVirtualDesktop[];
  linkedWorkspaceIds?: string[];
}

export interface KomlaOperationProject {
  id: string;
  name: string;
  kind?: string;
  baseBranch?: string;
}

/** What the user is asked to allow before `komla send` types into a terminal. */
export interface TerminalSendApprovalRequest {
  /** The workspace the message goes to. */
  workspaceId: string;
  /** The terminal the command ran in; absent for a caller outside any managed terminal. */
  callerTerminalId?: string;
  /** The workspace that terminal belongs to, which `--workspace` can make another one. */
  callerWorkspaceId?: string;
  terminal: { id: string; name?: string; state: TerminalAgentState; message?: string };
  text: string;
  /** The message answers a question the agent is waiting on. */
  forced: boolean;
}

export interface KomlaOperationDependencies {
  getConfig(): {
    agentLaunchDefaultPresetId?: string | null;
    agentLaunchDefaultLaunchModeId?: string | null;
    agentLaunchDefaultSshHostId?: string;
    agentDisabledCapabilities?: readonly string[];
    /** Tag keys whose workspaces the sidebar moves to its Filtered shelf. */
    hiddenWorkspaceTags?: readonly string[];
    /** The user turned the hooks endpoint off, and `komla notify` with it. */
    disableNotificationEndpoint?: boolean;
  };
  listPresets(): AgentPreset[];
  getActivePresets(): ActivePresetEntry[];
  listProjects(): KomlaOperationProject[];
  getWorkspace(id: string): KomlaOperationWorkspace | undefined;
  listWorkspaces(): KomlaOperationWorkspace[];
  workspaceTags(): readonly WorkspaceTagDefinition[];
  saveWorkspaceTags(tags: readonly WorkspaceTagDefinition[]): void;
  findWorkspaceByTerminalId(id: string): KomlaOperationWorkspace | undefined;
  getProject(id: string): KomlaOperationProject | undefined;
  getProjectRemoteUrl(id: string): Promise<string | null>;
  resolveWorkspaceByCwd(
    cwd: string,
    sshHostId?: string
  ): {
    workspace?: KomlaOperationWorkspace;
    error?: string;
  };
  /**
   * The project of the workspaces a cwd matches, and the one of them a launch from it sits
   * beside. `error` says why matching workspaces name no single project.
   */
  resolveProjectByCwd(
    cwd: string,
    sshHostId?: string
  ): {
    project?: KomlaOperationProject;
    sourceWorkspace?: KomlaOperationWorkspace;
    error?: string;
  };
  /** Where a new workspace starts when the launch names no environment. */
  resolveEnvironment(): DesiredWorkspaceEnvironment;
  isSshHostReady(hostId: string): boolean;
  listSshHosts(): ReadonlyArray<Pick<SshHost, 'id' | 'name' | 'isolated'>>;
  /** The branch checked out in a workspace; undefined or "HEAD" when its HEAD is detached. */
  getCheckedOutBranch(workspace: KomlaOperationWorkspace): Promise<string | undefined>;
  /** Whether origin has the branch with every local commit on it. */
  isBranchOnOrigin(projectId: string, branch: string): Promise<boolean>;
  createWorkspace(params: CreateWorkspaceParams): Promise<KomlaOperationWorkspace>;
  addAgentTab(
    workspaceId: string,
    prompt?: string,
    launchModeId?: string,
    presetId?: string,
    options?: AddAgentTabOptions
  ): { id: string } | Promise<{ id: string }>;
  updateWorkspace(
    id: string,
    updates: Record<string, unknown>
  ): KomlaOperationWorkspace | undefined;
  /** Links the workspaces both ways, with a symlink to each in the other's linked-workspaces folder. */
  linkWorkspaces(originId: string, targetIds: string[]): Promise<void>;
  unlinkWorkspace(originId: string, targetId: string): Promise<void>;
  /**
   * Shows a notification on the workspace, and on the terminal when one is named, as a hook over
   * HTTP does, and saves it at once on an SSH workspace. `hasInvalidTerminalId`: the call named a
   * terminal that isn't the workspace's, so it must not stop any current spinner.
   */
  notify(
    workspace: KomlaOperationWorkspace,
    target: { terminalId?: string; hasInvalidTerminalId: boolean },
    notification: WorkspaceNotification
  ): Promise<void>;
  /** Sets a workspace's status bar item; false when the workspace has as many as it may. */
  setStatusItem(workspaceId: string, id: string, content: StatusItemContent): boolean;
  /** Clears one status bar item, or all of a workspace's; returns how many it cleared. */
  clearStatusItems(workspaceId: string, id?: string): number;
  /**
   * Runs a status-items.json item again; undefined when the workspace has no such item, and
   * 'unavailable' when it can't run commands now.
   */
  refreshStatusCommand(
    workspaceId: string,
    id: string
  ): Promise<{ content: StatusItemContent | null; error?: string } | 'unavailable' | undefined>;
  publish(channel: string, payload: unknown): void;
  getMainWindowId(): string | null;
  /** The app this computer opens vnc:// links with, such as Screen Sharing; '' when none. */
  getVncAppName(): string;
  /** Whether a window on screen shows the workspace, rather than another or the overview. */
  isWorkspaceShown(workspaceId: string): boolean;
  /** Whether an agent is mid-turn in the terminal, as when the agent itself runs a command. */
  isAgentTurnActive(terminalId: string): boolean;
  /**
   * Calls `ended` once the agent's turn in the terminal ends, as `done` when it finished. Returns
   * a function that stops watching.
   */
  watchAgentTurnEnd(
    workspaceId: string,
    terminalId: string,
    ended: (end: AgentTurnEnd) => void
  ): () => void;
  /** What a terminal shows as plain text, with that many history lines; undefined without a PTY. */
  readTerminalText(terminalId: string, history: number): Promise<TerminalText | undefined>;
  /** Types text into a terminal, bracketed as a paste when `bracketed`, then presses Enter. */
  submitToTerminal(terminalId: string, text: string, bracketed: boolean): Promise<void>;
  /**
   * Asks the user in a Komla window to allow a message into a terminal. `unanswered` when the
   * prompt ended without their choice, as when `signal` aborts or no window could show it.
   */
  approveTerminalSend(
    request: TerminalSendApprovalRequest,
    signal: AbortSignal
  ): Promise<'apply' | 'cancel' | 'unanswered'>;
  /** Whether the terminal's program still runs. */
  isTerminalRunning(terminalId: string): boolean;
  /** Returns a function that unsubscribes. */
  onWorkspaceUpdated(listener: (workspaceId: string) => void): () => void;
  /** Each prompt submitted in a terminal. Returns a function that unsubscribes. */
  onPromptSubmitted(listener: (terminalId: string) => void): () => void;
  /** Each attention a terminal raises. Returns a function that unsubscribes. */
  onAttentionRaised(listener: (attention: WorkspaceAttention) => void): () => void;
  /** Returns a function that unsubscribes. */
  onTerminalOutput(listener: (terminalId: string, data: string) => void): () => void;
  /** Returns a function that unsubscribes. */
  onTerminalExit(listener: (terminalId: string) => void): () => void;
  /**
   * Each time a program starts under a terminal's id, as when a restart replaces the one before
   * it, which doesn't exit first. Returns a function that unsubscribes.
   */
  onTerminalReset(listener: (terminalId: string) => void): () => void;
  /** Asks the window showing the workspace to move it to the Trash, or to say why it wasn't. */
  requestTrash(request: WorkspaceTrashRequest): void;
  /** Opens the folder in the window, or another, as Open Folder does. False when it's no folder. */
  requestOpenFolder(path: string, windowId: string | null | undefined): boolean;
  /**
   * Opens the VNC server on `vncPort` where the workspace runs in the app for vnc:// links, which
   * takes `vncPassword` from the link instead of asking for it. `runningVncPorts`, those of every
   * desktop running there, lets forwards to stopped desktops close.
   */
  openInVncApp(
    workspace: KomlaOperationWorkspace,
    vncPort: number,
    vncPassword?: string,
    runningVncPorts?: number[]
  ): Promise<void>;
}

/** A notification as `komla notify <title>` sends it, without an agent hook's event. */
export interface WorkspaceNotification {
  cwd?: string;
  kind: (typeof NOTIFY_KINDS)[number];
  source: string;
  title: string;
  body?: string;
  color?: string;
  badge?: string;
  /** A base64 image data URL. */
  icon?: string;
  iconColor?: string;
}

export type KomlaOperation =
  | { type: 'context.get' }
  | { type: 'agent.presets'; includeInactive?: boolean }
  | {
      type: 'agent.launch';
      destination: 'tab' | 'workspace';
      project?: string;
      preset?: string;
      mode?: string;
      /** One of the agent's reasoning levels, by id or name, as `agent.presets` lists them. */
      effort?: string;
      prompt?: string;
      name?: string;
      description?: string;
      branch?: string;
      fromCurrentBranch?: boolean;
      /** Opens New Workspace with the launch filled in, for the user to start, in place of it. */
      draft?: true;
    }
  | { type: 'workspace.list'; includeTrashed?: boolean }
  /** The user's tags, which `workspace.tag` gives a workspace with the look the user gave it. */
  | { type: 'tag.list' }
  | { type: 'workspace.title'; title: string; description?: string }
  /**
   * `until` is as `parseSnoozeUntil` reads it, in the desktop's time zone. `untilNotified` also
   * ends the snooze at the workspace's next notification; it needs no `until`.
   */
  | { type: 'workspace.snooze'; until?: string; untilNotified?: true }
  | { type: 'workspace.wake' }
  /**
   * Without a tag, takes the workspace's tag off. A tag missing from the list joins it with `tone`
   * and `icon` (a base64 image data URL); one in the list keeps the user's look. With `ifTag`,
   * changes only a workspace that has that tag. `spinner` shows the tag as `workspace.progress`
   * does, and `ifTag` names progress too, as scripts asked before progress had its own operation.
   */
  | {
      type: 'workspace.tag';
      tag?: string;
      tooltip?: string;
      tone?: WorkspaceTagTone;
      icon?: string;
      spinner?: boolean;
      ifTag?: string;
    }
  /**
   * Shows the `progress` marker with a spinner, or takes it off without a label. With `ifLabel`,
   * changes only progress of that label.
   */
  | {
      type: 'workspace.progress';
      label?: string;
      tooltip?: string;
      tone?: WorkspaceTagTone;
      ifLabel?: string;
    }
  /**
   * Shows the marker under `key`, or takes it off without a label. With `ifLabel`, changes only a
   * marker that shows that label. `all`, in place of `key`, takes every marker off.
   */
  | {
      type: 'workspace.mark';
      key?: string;
      all?: true;
      label?: string;
      tooltip?: string;
      tone?: WorkspaceTagTone;
      spinner?: boolean;
      ifLabel?: string;
    }
  | { type: 'workspace.trash' }
  /** `icon` is a base64 image data URL. */
  | ({ type: 'workspace.notify' } & Omit<WorkspaceNotification, 'cwd' | 'kind' | 'source'> &
      Partial<Pick<WorkspaceNotification, 'kind' | 'source'>>)
  /** Links or unlinks the workspace and each of `workspaceIds`, as Link Workspaces does. */
  | { type: 'workspace.link' | 'workspace.unlink'; workspaceIds: string[] }
  /** `path` is absolute, on this computer. */
  | { type: 'folder.open'; path: string }
  | {
      type: 'status.set';
      id: string;
      /** May carry terminal colors; segments name their colors instead. One of the two is set. */
      text?: string;
      /** Icons are SVG markup or image data URLs. */
      segments?: StatusItemSegment[];
      /** An icon before the text, as icons in segments are. */
      icon?: string;
      iconColor?: string;
      tone?: StatusItemTone;
      style?: StatusItemStyle;
      color?: string;
      tooltip?: string;
      link?: string;
      /** A sandboxed HTML page for the popover. */
      popover?: string;
      /** Plain Markdown for the popover, in place of a page. */
      popoverMarkdown?: string;
    }
  | { type: 'status.clear'; id?: string }
  /** Runs a status-items.json item again now. */
  | { type: 'status.refresh'; id: string }
  | { type: 'preview.open'; url?: string; open?: boolean }
  /** The calling workspace's terminals, with what each one's agent is doing. */
  | { type: 'terminal.list' }
  /** `terminal` is a terminal's id or its tab's name; `history` lines above the screen. */
  | { type: 'terminal.read'; terminal: string; history?: number }
  /**
   * Types `text` into the terminal and submits it. Refused while its agent waits for the user,
   * unless `force`. With `wait`, then waits as `terminal.wait` does for the turn it started.
   */
  | {
      type: 'terminal.send';
      terminal: string;
      text: string;
      force?: boolean;
      wait?: boolean;
      timeoutMs?: number;
    }
  /** Waits for the terminal's agent to end its turn or need the user, or for `output`. */
  | {
      type: 'terminal.wait';
      terminal: string;
      output?: string;
      timeoutMs?: number;
    }
  | {
      type: 'desktop.open';
      vncPort: number;
      url?: string;
      viewer?: VirtualDesktopViewer;
      vncPassword?: string;
      vncPorts?: number[];
      /** What the desktop is named after: the app's command, shortened. */
      app?: string;
    };

type AgentLaunchOperation = Extract<KomlaOperation, { type: 'agent.launch' }>;

function currentBranchUnavailable(): KomlaOperationError {
  return new KomlaOperationError(
    'CURRENT_BRANCH_UNAVAILABLE',
    'Starting from the current branch needs a call from a workspace in the same Git project.',
    400
  );
}

/** A draft fills in New Workspace, which starts workspaces and has no field for the rest. */
function refuseUndraftableOptions(operation: AgentLaunchOperation): void {
  if (operation.destination !== 'workspace') {
    throw new KomlaOperationError(
      'INVALID_DRAFT_OPTIONS',
      'Only a workspace launch can be a draft; a tab starts at once.',
      400
    );
  }
  const unsupported = (['name', 'description', 'branch', 'effort'] as const).filter(
    (field) => operation[field] !== undefined
  );
  if (unsupported.length) {
    throw new KomlaOperationError(
      'INVALID_DRAFT_OPTIONS',
      `A draft fills in the prompt, project, agent, mode and starting branch; New Workspace has no ${unsupported.join(', ')} to fill in.`,
      400,
      { fields: unsupported }
    );
  }
}

export type AgentLaunchResult = KomlaOperationResults['agent.launch'];

type AgentLaunchSelection = NonNullable<AgentLaunchResult['agent']>;

export type KomlaOperationResult<T extends KomlaOperation['type']> = KomlaOperationResults[T];

type AgentSelection = {
  preset?: AgentPreset;
  mode?: AgentPreset['launchModes'][number];
  effort?: ReasoningLevel;
};

export class KomlaOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'KomlaOperationError';
  }
}

export class KomlaOperationService {
  /** The terminals ('' for none) whose agents asked to trash each workspace, by its id. */
  private readonly pendingTrashes = new Map<string, Set<string>>();
  /**
   * The progress each workspace shows from `komla tag --spinner`, by its id: a later tag or bare
   * untag replaces it, as it replaced the spinning tag before progress had its own operation.
   */
  private readonly spinnerProgress = new Map<string, string>();

  /**
   * The senders ('' for one outside any terminal) the user allowed to message each terminal, as
   * `komla send` first does, by the terminal's id. Forgotten when either terminal exits or starts
   * another program, since a pane's id outlives its program.
   */
  private readonly allowedTerminalSenders = new Map<string, Set<string>>();
  /** How many times each terminal has exited or started another program, once watched. */
  private readonly terminalEpochs = new Map<string, number>();
  /** Set at the first prompt, since nothing needs to watch terminals before. */
  private watchingTerminals = false;

  constructor(private readonly dependencies: KomlaOperationDependencies) {}

  async execute<T extends KomlaOperation>(
    context: KomlaOperationContext,
    operation: T
  ): Promise<KomlaOperationResult<T['type']>> {
    return this.dispatch(context, operation) as Promise<KomlaOperationResult<T['type']>>;
  }

  private async dispatch(
    context: KomlaOperationContext,
    operation: KomlaOperation
  ): Promise<KomlaOperationResults[KomlaOperation['type']]> {
    this.requireCapability(komlaOperationCapability(operation));
    switch (operation.type) {
      case 'context.get':
        return this.getContext(context);
      case 'agent.presets':
        return this.getAgentPresets(operation.includeInactive === true);
      case 'agent.launch':
        return this.launchAgent(context, operation);
      case 'workspace.list':
        return this.listWorkspaces(context, operation.includeTrashed === true);
      case 'tag.list':
        return this.listTags();
      case 'workspace.title':
        return this.setWorkspaceTitle(context, operation);
      case 'workspace.snooze':
        return this.snoozeWorkspace(context, operation);
      case 'workspace.wake':
        return this.wakeWorkspace(context);
      case 'workspace.tag':
        return this.tagWorkspace(context, operation);
      case 'workspace.progress':
        return this.showProgress(context, operation);
      case 'workspace.mark':
        return this.markWorkspace(context, operation);
      case 'workspace.trash':
        return this.trashWorkspace(context);
      case 'workspace.notify':
        return this.notifyWorkspace(context, operation);
      case 'workspace.link':
        return this.linkWorkspaces(context, operation.workspaceIds);
      case 'workspace.unlink':
        return this.unlinkWorkspaces(context, operation.workspaceIds);
      case 'folder.open':
        return this.openFolder(context, operation.path);
      case 'status.set':
        return this.setStatusItem(context, operation);
      case 'status.clear':
        return this.clearStatusItems(context, operation.id);
      case 'status.refresh':
        return this.refreshStatusCommand(context, operation.id);
      case 'preview.open':
        return operation.open
          ? this.openPreview(context, operation.url)
          : this.offerPreview(context, operation.url);
      case 'desktop.open':
        return this.openDesktop(context, operation);
      case 'terminal.list':
        return this.listTerminals(context);
      case 'terminal.read':
        return this.readTerminal(context, operation);
      case 'terminal.send':
        return this.sendToTerminal(context, operation);
      case 'terminal.wait':
        return this.waitForTerminal(context, operation);
    }
  }

  /**
   * Lists a virtual desktop from `komla desktop run` under the workspace's globe button, and
   * opens it right away where `viewer` asks: in the app this computer opens vnc:// links with
   * (`--app`), or through noVNC at `url` in Komla's browser (`--browser`). Without a VNC app,
   * `--app` falls back to Komla's browser. While no window shows the workspace, `--app` waits
   * for one to, so another workspace's agent doesn't open a window over the user's work. Without
   * `viewer`, the workspace asks the user where to open it once a window shows it.
   */
  private async openDesktop(
    context: KomlaOperationContext,
    operation: Extract<KomlaOperation, { type: 'desktop.open' }>
  ): Promise<KomlaOperationResults['desktop.open']> {
    const workspace = this.requireWorkspace(context);
    const vncApp = this.dependencies.getVncAppName() || undefined;
    const viewer =
      operation.viewer === 'vnc-app' && !vncApp && operation.url !== undefined
        ? 'preview'
        : operation.viewer;
    if (!vncApp && (viewer === 'vnc-app' || (!viewer && operation.url === undefined))) {
      throw new KomlaOperationError(
        'DESKTOP_VIEWER_UNAVAILABLE',
        viewer === 'vnc-app'
          ? 'This computer has no app that opens vnc:// links, such as Screen Sharing on macOS.'
          : 'This computer has no app that opens vnc:// links, such as Screen Sharing on macOS. Install novnc and websockify on the host to show the desktop in Komla’s browser preview.',
        400
      );
    }
    if (viewer === 'preview' && operation.url === undefined) {
      throw new KomlaOperationError(
        'DESKTOP_VIEWER_UNAVAILABLE',
        vncApp
          ? `Install novnc and websockify on the host to show the desktop in Komla’s browser preview, or use --app to show it in ${vncApp}.`
          : 'Install novnc and websockify on the host to show the desktop in Komla’s browser preview.',
        400
      );
    }
    // Saved before it opens, so the globe button can show it again should opening fail.
    const desktop = this.rememberDesktop(workspace, operation, vncApp);
    const shown = { workspaceId: workspace.id, ...(vncApp ? { vncApp } : {}) };
    if (viewer === 'vnc-app') {
      return { desktop: { ...shown, ...(await this.showInVncApp(workspace, operation, desktop)) } };
    }
    if (viewer === 'preview') {
      this.openPreview(context, operation.url);
      return { desktop: { ...shown, viewer: 'preview' } };
    }
    this.dependencies.publish(IPC.VIRTUAL_DESKTOP_STARTED, {
      workspaceId: workspace.id,
      desktop,
    } satisfies VirtualDesktopStartedEvent);
    return { desktop: shown };
  }

  /**
   * Opens the desktop in the VNC app for `--app`, or, while no window shows the workspace, has the
   * workspace open it there once one does.
   */
  private async showInVncApp(
    workspace: KomlaOperationWorkspace,
    operation: Extract<KomlaOperation, { type: 'desktop.open' }>,
    desktop: WorkspaceVirtualDesktop
  ): Promise<{ viewer: 'vnc-app'; opensWhenShown?: true }> {
    if (!this.dependencies.isWorkspaceShown(workspace.id)) {
      this.dependencies.publish(IPC.VIRTUAL_DESKTOP_STARTED, {
        workspaceId: workspace.id,
        desktop,
        opensIn: 'vnc-app',
      } satisfies VirtualDesktopStartedEvent);
      return { viewer: 'vnc-app', opensWhenShown: true };
    }
    try {
      await this.dependencies.openInVncApp(
        workspace,
        operation.vncPort,
        operation.vncPassword,
        operation.vncPorts
      );
    } catch (error) {
      throw new KomlaOperationError(
        'DESKTOP_VIEWER_FAILED',
        `Couldn’t open the desktop in ${desktop.vncApp}: ${error instanceof Error ? error.message : String(error)}`,
        502
      );
    }
    return { viewer: 'vnc-app' };
  }

  /**
   * Lists the desktop first among the workspace's, with this computer's `vncApp` if it has one,
   * so the globe button can open it; and forgets the desktops `vncPorts` says stopped on that
   * machine, in every workspace there: a stopped desktop's display may already serve another.
   * Returns the desktop as saved.
   */
  private rememberDesktop(
    workspace: KomlaOperationWorkspace,
    operation: Extract<KomlaOperation, { type: 'desktop.open' }>,
    vncApp: string | undefined
  ): WorkspaceVirtualDesktop {
    const { vncPort, vncPassword, url, app, vncPorts } = operation;
    const replaced = (desktop: WorkspaceVirtualDesktop): boolean =>
      desktop.vncPort === vncPort || vncPorts?.includes(desktop.vncPort) === false;
    const onSameMachine = (other: KomlaOperationWorkspace): boolean =>
      other.backend?.kind === 'ssh'
        ? workspace.backend?.kind === 'ssh' && other.backend.hostId === workspace.backend.hostId
        : workspace.backend?.kind !== 'ssh';
    const save = (id: string, desktops: WorkspaceVirtualDesktop[]): void =>
      this.updateAndPublish(id, { virtualDesktops: desktops.length > 0 ? desktops : undefined });
    for (const other of this.dependencies.listWorkspaces()) {
      const desktops = other.virtualDesktops ?? [];
      if (other.id === workspace.id || !onSameMachine(other) || !desktops.some(replaced)) continue;
      save(
        other.id,
        desktops.filter((desktop) => !replaced(desktop))
      );
    }
    const desktop: WorkspaceVirtualDesktop = {
      vncPort,
      shownAt: Date.now(),
      ...(vncPassword !== undefined ? { vncPassword } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(app !== undefined ? { app } : {}),
      ...(vncApp ? { vncApp } : {}),
    };
    save(workspace.id, [
      desktop,
      ...(workspace.virtualDesktops ?? []).filter((saved) => !replaced(saved)),
    ]);
    return desktop;
  }

  /**
   * Opens a page in the workspace's browser, in the window that shows the workspace: in a new tab
   * of a browser pane it has, else in a browser in a tab of its own. Without a URL, the browser
   * shows as it is, or opens on a blank tab that finds the workspace's server.
   */
  private openPreview(
    context: KomlaOperationContext,
    url?: string
  ): KomlaOperationResults['preview.open'] {
    const workspace = this.requirePreviewWorkspace(context, url);
    this.dependencies.publish(IPC.WORKSPACE_OPEN_DEV_PREVIEW, {
      workspaceId: workspace.id,
      ...(url !== undefined ? { url, urlExecutionLocation: 'workspace' } : {}),
    });
    return {
      preview: {
        workspaceId: workspace.id,
        ...(url !== undefined ? { url } : {}),
        opened: true,
      },
    };
  }

  /**
   * Offers a page in the window that shows the workspace, without opening it: a toast opens it in
   * the default browser or Komla's, and a dot on the globe button marks it until the user looks.
   */
  private offerPreview(
    context: KomlaOperationContext,
    url?: string
  ): KomlaOperationResults['preview.open'] {
    const workspace = this.requirePreviewWorkspace(context, url);
    if (url === undefined) {
      throw new KomlaOperationError(
        'PREVIEW_URL_REQUIRED',
        "A preview needs the page's URL, unless it opens Komla's browser (komla preview --open, or open in the MCP tool).",
        400
      );
    }
    this.dependencies.publish(IPC.WORKSPACE_OPEN_DEV_PREVIEW, {
      workspaceId: workspace.id,
      url,
      urlExecutionLocation: 'workspace',
      offer: true,
    });
    return { preview: { workspaceId: workspace.id, url, opened: false } };
  }

  private requirePreviewWorkspace(
    context: KomlaOperationContext,
    url?: string
  ): KomlaOperationWorkspace {
    this.requireCapability('preview.open');
    const workspace = this.requireWorkspace(context);
    if (url !== undefined && !isBrowserUrl(url)) {
      throw new KomlaOperationError(
        'INVALID_PREVIEW_URL',
        'Preview URLs must be HTTP or HTTPS URLs.',
        400
      );
    }
    return workspace;
  }

  private setWorkspaceTitle(
    context: KomlaOperationContext,
    operation: Extract<KomlaOperation, { type: 'workspace.title' }>
  ): KomlaOperationResults['workspace.title'] {
    const workspace = this.requireWorkspace(context);
    const updated = this.dependencies.updateWorkspace(workspace.id, {
      customName: operation.title,
      ...(operation.description !== undefined ? { customDescription: operation.description } : {}),
    });
    if (!updated) {
      throw new KomlaOperationError(
        'WORKSPACE_NOT_FOUND',
        'The current Komla workspace no longer exists.',
        404
      );
    }
    this.dependencies.publish(IPC.WORKSPACE_UPDATED, updated);
    return {
      workspace: {
        id: workspace.id,
        title: operation.title,
        ...(operation.description !== undefined ? { description: operation.description } : {}),
      },
    };
  }

  private snoozeWorkspace(
    context: KomlaOperationContext,
    { until: input, untilNotified }: { until?: string; untilNotified?: boolean }
  ): KomlaOperationResults['workspace.snooze'] {
    const workspace = this.requireWorkspace(context);
    // It would wake again at once, as an agent asking for the user wakes a snoozed workspace.
    if (isWorkspaceAttentionActionable(workspace.attention)) {
      throw new KomlaOperationError(
        'WORKSPACE_NEEDS_ATTENTION',
        'An agent in this workspace is waiting for input or failed, so it stays in sight.',
        409
      );
    }
    const now = new Date();
    // A relative snooze queued on an SSH host counts from when the agent asked.
    const asked = new Date(Math.min(context.requestedAt ?? now.getTime(), now.getTime()));
    if (input === undefined) {
      if (!untilNotified) {
        throw new KomlaOperationError('INVALID_SNOOZE_TIME', 'Say when the snooze ends.', 400);
      }
      this.updateAndPublish(workspace.id, {
        snoozedUntil: undefined,
        wakesOnNotification: true,
        unread: undefined,
      });
      return { snooze: { workspaceId: workspace.id, untilNotified: true } };
    }
    const until = parseSnoozeUntil(input, asked);
    if (until === undefined) {
      throw new KomlaOperationError(
        'INVALID_SNOOZE_TIME',
        `Can't read "${input}". Snooze for a duration such as 30m, 2h or 1d, until a time such as 17:30, or until a date and time such as 2026-10-21 09:00.`,
        400
      );
    }
    if (until <= now.getTime()) {
      throw new KomlaOperationError('INVALID_SNOOZE_TIME', `${input} has already passed.`, 400);
    }
    if (until - now.getTime() > MAX_SNOOZE_MS) {
      throw new KomlaOperationError('INVALID_SNOOZE_TIME', 'Snooze for at most a year.', 400);
    }
    this.updateAndPublish(workspace.id, {
      snoozedUntil: until,
      wakesOnNotification: untilNotified ? true : undefined,
      unread: undefined,
    });
    const untilText = new Date(until).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return {
      snooze: {
        workspaceId: workspace.id,
        until,
        untilText,
        ...(untilNotified ? { untilNotified: true } : {}),
      },
    };
  }

  /** Ends a snooze now, marking the workspace Woke as a snooze that runs out does. */
  private wakeWorkspace(context: KomlaOperationContext): KomlaOperationResults['workspace.wake'] {
    const workspace = this.requireWorkspace(context);
    if (!isWorkspaceSnoozed(workspace)) {
      return { snooze: { workspaceId: workspace.id, woke: false } };
    }
    this.updateAndPublish(workspace.id, wokenMarks(Date.now()));
    return { snooze: { workspaceId: workspace.id, woke: true } };
  }

  /**
   * Tags the current workspace, as its Tag menu does. A tag the user hasn't made shows as a new
   * tag would; agents don't change the user's list of tags.
   */
  private tagWorkspace(
    context: KomlaOperationContext,
    {
      tag: input,
      tooltip,
      tone,
      icon,
      spinner,
      ifTag,
    }: Extract<KomlaOperation, { type: 'workspace.tag' }>
  ): KomlaOperationResults['workspace.tag'] {
    const workspace = this.requireWorkspace(context);
    const name = input === undefined ? undefined : normalizeWorkspaceTagName(input);
    if (input !== undefined && !name) {
      throw new KomlaOperationError('INVALID_TAG', 'Name the tag.', 400);
    }
    const unchangedTag = { workspaceId: workspace.id, tag: workspace.tag ?? null, changed: false };
    // `ifTag` names the tag or the progress, as the card shows either in one place: a script from
    // before progress had its own operation showed it as a spinning tag.
    const progressNamed = ifTag !== undefined && showsWorkspaceProgress(workspace, ifTag);
    const tagNamed =
      ifTag !== undefined &&
      workspace.tag !== undefined &&
      workspaceTagKey(workspace.tag) === workspaceTagKey(ifTag);
    // A spinner is progress, which leaves the tag and the user's list be.
    if (name && spinner) {
      if (ifTag !== undefined && !progressNamed && !tagNamed) {
        return { tag: unchangedTag, progress: this.unchangedProgress(workspace) };
      }
      const progress = this.applyProgress(workspace, { label: name, tone, tooltip });
      this.spinnerProgress.set(workspace.id, workspaceTagKey(name));
      return { tag: unchangedTag, progress };
    }
    const replacesProgress =
      progressNamed || (ifTag === undefined && this.showsSpinnerProgress(workspace));
    const clearedProgress = { workspaceId: workspace.id, label: null, changed: true };
    // `untag` takes off progress a spinner showed, and a tag of that name with it.
    if (!name && replacesProgress) {
      this.updateAndPublish(workspace.id, {
        markers: withoutWorkspaceMarker(workspace.markers, PROGRESS_MARKER_KEY),
        ...(tagNamed && { tag: undefined, tagSource: undefined }),
      });
      this.spinnerProgress.delete(workspace.id);
      return {
        tag: tagNamed ? { workspaceId: workspace.id, tag: null, changed: true } : unchangedTag,
        progress: clearedProgress,
      };
    }
    // A script that finished late leaves alone a tag put on since.
    if (ifTag !== undefined && !tagNamed && !progressNamed) return { tag: unchangedTag };
    if (!name) {
      this.updateAndPublish(workspace.id, { tag: undefined, tagSource: undefined });
      return { tag: { workspaceId: workspace.id, tag: null, changed: true } };
    }
    const tags = this.dependencies.workspaceTags();
    const existing = findWorkspaceTag(tags, name);
    if (!existing) {
      if (tags.length >= MAX_WORKSPACE_TAGS) {
        throw new KomlaOperationError(
          'TAG_LIST_FULL',
          `Komla has ${MAX_WORKSPACE_TAGS} tags already, so it can't add ${name}. Use a tag it has, or ask the user to delete one in Settings.`,
          409
        );
      }
      this.dependencies.saveWorkspaceTags(
        withWorkspaceTag(tags, name, {
          tone: tone ?? 'neutral',
          ...(icon !== undefined && { icon }),
        })
      );
    }
    const tag = existing?.name ?? name;
    // A tag replaces a spinner's progress, as it replaced a spinning tag.
    this.updateAndPublish(workspace.id, {
      tag,
      tagSource: undefined,
      tagTooltip: tooltip,
      ...(replacesProgress && {
        markers: withoutWorkspaceMarker(workspace.markers, PROGRESS_MARKER_KEY),
      }),
    });
    if (replacesProgress) this.spinnerProgress.delete(workspace.id);
    return {
      tag: { workspaceId: workspace.id, tag, changed: true, added: !existing },
      ...(replacesProgress && { progress: clearedProgress }),
    };
  }

  private showProgress(
    context: KomlaOperationContext,
    {
      label: input,
      tooltip,
      tone,
      ifLabel,
    }: Extract<KomlaOperation, { type: 'workspace.progress' }>
  ): KomlaOperationResults['workspace.progress'] {
    const workspace = this.requireWorkspace(context);
    const label = input === undefined ? undefined : normalizeWorkspaceMarkerLabel(input);
    if (input !== undefined && !label) {
      throw new KomlaOperationError('INVALID_PROGRESS', 'Name the progress.', 400);
    }
    // Without a label it clears the progress, which a tone or tooltip meant for it would hide.
    if (!label && (tone !== undefined || tooltip !== undefined)) {
      throw new KomlaOperationError(
        'INVALID_PROGRESS',
        'Name the progress the tone or tooltip is for.',
        400
      );
    }
    // A script that finished late leaves alone progress another one shows since.
    if (ifLabel !== undefined && !showsWorkspaceProgress(workspace, ifLabel)) {
      return { progress: this.unchangedProgress(workspace) };
    }
    const progress = this.applyProgress(workspace, { label, tone, tooltip });
    this.spinnerProgress.delete(workspace.id);
    return { progress };
  }

  /** Shows this progress on the workspace, or takes its progress off without a label. */
  private applyProgress(
    workspace: KomlaOperationWorkspace,
    { label, tone, tooltip }: { label?: string; tone?: WorkspaceTagTone; tooltip?: string }
  ): ProgressResult {
    const { label: shown } = this.applyMarker(
      workspace,
      PROGRESS_MARKER_KEY,
      label ? { label, tone, tooltip, spinner: true } : undefined
    );
    // Cleared even when none showed, as `komla progress --clear` always said: false means `ifLabel`.
    return { workspaceId: workspace.id, label: shown, changed: true };
  }

  private markWorkspace(
    context: KomlaOperationContext,
    operation: Extract<KomlaOperation, { type: 'workspace.mark' }>
  ): KomlaOperationResults['workspace.mark'] {
    const workspace = this.requireWorkspace(context);
    // A key left out never means every marker: a script asks for that by name.
    if (operation.all) return this.clearMarkers(workspace, operation);
    const { key, label: input, tooltip, tone, spinner, ifLabel } = operation;
    if (key === undefined) {
      throw new KomlaOperationError(
        'INVALID_MARKER',
        "Name the marker's key, or take every marker off with `all`.",
        400
      );
    }
    const label = input === undefined ? undefined : normalizeWorkspaceMarkerLabel(input);
    if (input !== undefined && !label) {
      throw new KomlaOperationError('INVALID_MARKER', 'Name the marker.', 400);
    }
    // Without a label it takes the marker off, which a look meant for it would hide.
    if (!label && (tone !== undefined || tooltip !== undefined || spinner)) {
      throw new KomlaOperationError(
        'INVALID_MARKER',
        'Name the marker the tone, tooltip or spinner is for.',
        400
      );
    }
    // Progress is work under way, which ends with Komla: a marker that stays takes another key.
    if (key === PROGRESS_MARKER_KEY && label && !spinner) {
      throw new KomlaOperationError(
        'INVALID_MARKER',
        'The progress marker shows work under way: add `spinner`, as `komla progress` does, or use another key.',
        400
      );
    }
    const current = findWorkspaceMarker(workspace, key);
    // A script that finished late leaves alone a marker another run put on since.
    if (ifLabel !== undefined && !markerShows(current, ifLabel)) {
      return {
        marker: { workspaceId: workspace.id, key, label: current?.label ?? null, changed: false },
      };
    }
    // As `komla progress` does, so a later tag leaves alone progress `komla tag --spinner` didn't show.
    if (key === PROGRESS_MARKER_KEY) this.spinnerProgress.delete(workspace.id);
    return {
      marker: this.applyMarker(
        workspace,
        key,
        label ? { label, tone, tooltip, spinner } : undefined
      ),
    };
  }

  /** Takes every marker off, as `komla unmark --all` asks. */
  private clearMarkers(
    workspace: KomlaOperationWorkspace,
    {
      key,
      label,
      tooltip,
      tone,
      spinner,
      ifLabel,
    }: Extract<KomlaOperation, { type: 'workspace.mark' }>
  ): KomlaOperationResults['workspace.mark'] {
    // `spinner: false`, as a client that sends its defaults does, asks for no look.
    const others = [key, label, tooltip, tone, ifLabel].some((value) => value !== undefined);
    if (others || spinner) {
      throw new KomlaOperationError(
        'INVALID_MARKER',
        '`all` takes every marker off, so it takes no key, label or look.',
        400
      );
    }
    const keys = (workspace.markers ?? []).map((marker) => marker.key);
    if (keys.length > 0) this.updateAndPublish(workspace.id, { markers: undefined });
    this.spinnerProgress.delete(workspace.id);
    return { cleared: { workspaceId: workspace.id, keys } };
  }

  /** Shows the marker under this key, or takes it off without a label. */
  private applyMarker(
    workspace: KomlaOperationWorkspace,
    key: string,
    shown:
      | { label: string; tone?: WorkspaceTagTone; tooltip?: string; spinner?: boolean }
      | undefined
  ): MarkerResult {
    if (!shown) {
      const shownBefore = findWorkspaceMarker(workspace, key) !== undefined;
      if (shownBefore) {
        this.updateAndPublish(workspace.id, {
          markers: withoutWorkspaceMarker(workspace.markers, key),
        });
      }
      return { workspaceId: workspace.id, key, label: null, changed: shownBefore };
    }
    const { label, tone, tooltip, spinner } = shown;
    // Progress has its own place, so `komla progress` shows whatever other scripts marked.
    const others = (workspace.markers ?? []).filter((marker) => marker.key !== PROGRESS_MARKER_KEY);
    if (
      key !== PROGRESS_MARKER_KEY &&
      !findWorkspaceMarker(workspace, key) &&
      others.length >= MAX_WORKSPACE_MARKERS
    ) {
      throw new KomlaOperationError(
        'MARKERS_FULL',
        `The workspace shows ${MAX_WORKSPACE_MARKERS} markers already, so it can't add ${key}. Take one off with \`komla unmark\`, or replace one under its key.`,
        409
      );
    }
    const marker: WorkspaceMarker = {
      key,
      label,
      tone: tone ?? 'neutral',
      ...(tooltip && { tooltip }),
      ...(spinner && { spinner: true as const }),
    };
    this.updateAndPublish(workspace.id, {
      markers: withWorkspaceMarker(workspace.markers, marker),
    });
    return { workspaceId: workspace.id, key, label, changed: true };
  }

  /** Whether the workspace still shows the progress `komla tag --spinner` put on it. */
  private showsSpinnerProgress(workspace: KomlaOperationWorkspace): boolean {
    const label = this.spinnerProgress.get(workspace.id);
    return label !== undefined && showsWorkspaceProgress(workspace, label);
  }

  private unchangedProgress(workspace: KomlaOperationWorkspace): ProgressResult {
    return {
      workspaceId: workspace.id,
      label: workspaceProgress(workspace)?.label ?? null,
      changed: false,
    };
  }

  /**
   * Moves the current workspace to the Trash once the calling agent's turn ends, so its last reply
   * and done notification aren't cut off. Other tabs' agents would stop with it, so a busy one
   * keeps it.
   */
  private trashWorkspace(context: KomlaOperationContext): KomlaOperationResults['workspace.trash'] {
    if (context.targeted) {
      throw new KomlaOperationError(
        'WORKSPACE_TARGET_NOT_ALLOWED',
        'Only a workspace itself can move it to the Trash, so `komla trash` takes no --workspace.',
        403
      );
    }
    const workspace = this.requireWorkspace(context);
    if (workspace.status !== undefined && workspace.status !== 'active') {
      throw new KomlaOperationError(
        'WORKSPACE_NOT_ACTIVE',
        'This workspace is already in the Trash.',
        409
      );
    }
    const blocker = trashBlocker(workspace, context.terminalId, false);
    if (blocker) throw new KomlaOperationError('WORKSPACE_BUSY', blocker, 409);

    const { terminalId } = context;
    const afterTurn = terminalId !== undefined && this.dependencies.isAgentTurnActive(terminalId);
    const pending = this.pendingTrashes.get(workspace.id) ?? new Set<string>();
    if (!pending.has(terminalId ?? '')) {
      pending.add(terminalId ?? '');
      this.pendingTrashes.set(workspace.id, pending);
      if (afterTurn && terminalId !== undefined) {
        this.trashAfterTurn(workspace.id, terminalId);
      } else {
        setTimeout(() => this.finishTrash(workspace.id, terminalId), TRASH_WITHOUT_TURN_DELAY_MS);
      }
    }
    return { trash: { workspaceId: workspace.id, afterTurn } };
  }

  /**
   * Shows a notification on the workspace as `komla notify <title>` does, on the calling terminal
   * unless the call names another workspace.
   */
  private async notifyWorkspace(
    context: KomlaOperationContext,
    {
      type: _type,
      kind,
      source,
      ...presentation
    }: Extract<KomlaOperation, { type: 'workspace.notify' }>
  ): Promise<KomlaOperationResults['workspace.notify']> {
    if (this.dependencies.getConfig().disableNotificationEndpoint) {
      throw new KomlaOperationError(
        'NOTIFICATIONS_DISABLED',
        'Notifications are turned off in Komla. Ask the user to turn on Hooks endpoint in Settings → Integrations & MCP → Notifications.',
        403
      );
    }
    const workspace = this.requireWorkspace(context);
    const named = context.targeted ? undefined : context.terminalId;
    // A terminal that closed, or is another workspace's, keeps its pane out of it.
    const terminalId =
      named !== undefined && this.dependencies.findWorkspaceByTerminalId(named)?.id === workspace.id
        ? named
        : undefined;
    const cwd = context.targeted
      ? workspace.workingDirectory
      : (context.cwd ?? workspace.workingDirectory);
    await this.dependencies.notify(
      workspace,
      {
        ...(terminalId !== undefined && { terminalId }),
        hasInvalidTerminalId: named !== undefined && terminalId === undefined,
      },
      {
        ...(cwd !== undefined && { cwd }),
        kind: kind ?? 'generic',
        source: source ?? 'agent',
        ...presentation,
      }
    );
    return { notification: { workspaceId: workspace.id, ...(terminalId && { terminalId }) } };
  }

  /**
   * Links the workspace to each of the others as Link Workspaces does: each gets a symlink to the
   * other in its linked-workspaces folder. Komla links local workspaces to local ones and SSH
   * workspaces to others on the same host, once they're ready and out of the Trash.
   */
  private async linkWorkspaces(
    context: KomlaOperationContext,
    workspaceIds: string[]
  ): Promise<KomlaOperationResults['workspace.link']> {
    const workspace = this.requireWorkspace(context);
    const targets = [...new Set(workspaceIds)].map((id) =>
      this.requireLinkTarget(context, workspace, id)
    );
    for (const linked of [workspace, ...targets]) {
      if (
        (linked.status !== undefined && linked.status !== 'active') ||
        linked.provisioning ||
        !linked.workingDirectory
      ) {
        throw new KomlaOperationError(
          'WORKSPACE_NOT_ACTIVE',
          `${linked.id} is in the Trash or still being created, so Komla can’t link it.`,
          409
        );
      }
    }
    const origin = this.workspaceEnvironment(workspace);
    for (const target of targets) {
      const environment = this.workspaceEnvironment(target);
      if (
        environment.kind !== origin.kind ||
        (environment.kind === 'ssh' &&
          origin.kind === 'ssh' &&
          environment.hostId !== origin.hostId)
      ) {
        throw new KomlaOperationError(
          'WORKSPACE_LINK_UNSUPPORTED',
          `${target.id} runs elsewhere: Komla links local workspaces to local ones, and SSH workspaces to others on the same host.`,
          400
        );
      }
    }
    await this.changeLinks(workspace.id, () =>
      this.dependencies.linkWorkspaces(
        workspace.id,
        targets.map((target) => target.id)
      )
    );
    return { links: this.links(workspace.id) };
  }

  /**
   * Unlinks the workspace from each of the others, both ways, even where only one side still
   * records the link. An SSH workspace linked on neither side is left alone, as unlinking it
   * reaches the host; a local one is unlinked anyway, which removes any symlinks left behind.
   */
  private async unlinkWorkspaces(
    context: KomlaOperationContext,
    workspaceIds: string[]
  ): Promise<KomlaOperationResults['workspace.unlink']> {
    const workspace = this.requireWorkspace(context);
    const linked = new Set(workspace.linkedWorkspaceIds);
    const ids = [...new Set(workspaceIds)];
    // A linked workspace may be gone already; any other id has to name a workspace.
    const targets = new Map(
      ids
        .filter((id) => !linked.has(id) || id === workspace.id)
        .map((id) => [id, this.requireLinkTarget(context, workspace, id)])
    );
    const unlinked = ids.filter((id) => {
      const target = targets.get(id);
      return (
        !target ||
        target.backend?.kind !== 'ssh' ||
        target.linkedWorkspaceIds?.includes(workspace.id) === true
      );
    });
    await this.changeLinks(workspace.id, async () => {
      for (const id of unlinked) await this.dependencies.unlinkWorkspace(workspace.id, id);
    });
    return { links: this.links(workspace.id) };
  }

  private requireLinkTarget(
    context: KomlaOperationContext,
    workspace: KomlaOperationWorkspace,
    id: string
  ): KomlaOperationWorkspace {
    if (id === workspace.id) {
      throw new KomlaOperationError('INVALID_LINK', 'A workspace can’t be linked to itself.', 400);
    }
    const target = this.dependencies.getWorkspace(id);
    if (
      !target ||
      (context.sshHostId &&
        (target.backend?.kind !== 'ssh' || target.backend.hostId !== context.sshHostId))
    ) {
      throw new KomlaOperationError(
        'WORKSPACE_NOT_FOUND',
        `No workspace has the id ${id}; \`komla workspace list\` lists them.`,
        404
      );
    }
    return target;
  }

  /**
   * Changes links, then has windows show it, as they do after Link Workspaces. Links change one
   * workspace at a time, so a failure says what the workspace is linked to by then.
   */
  private async changeLinks(workspaceId: string, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (error) {
      const links = this.links(workspaceId);
      const reason = (error instanceof Error ? error.message : String(error)).trimEnd();
      const linkedTo = links.linkedWorkspaceIds.length
        ? `The workspace is linked to ${links.linkedWorkspaceIds.join(', ')}.`
        : 'The workspace is linked to no others.';
      throw new KomlaOperationError(
        'WORKSPACE_LINK_FAILED',
        !reason ? linkedTo : `${reason}${/[.!?]$/.test(reason) ? '' : '.'} ${linkedTo}`,
        500,
        links
      );
    } finally {
      this.dependencies.publish(IPC.WORKSPACES_CHANGED, undefined);
    }
  }

  private links(workspaceId: string) {
    const linkedWorkspaceIds =
      this.dependencies.getWorkspace(workspaceId)?.linkedWorkspaceIds ?? [];
    return { workspaceId, linkedWorkspaceIds };
  }

  /** Opens a folder on this computer as Open Folder does, in the caller's window when it has one. */
  private openFolder(
    context: KomlaOperationContext,
    path: string
  ): KomlaOperationResults['folder.open'] {
    if (context.sshHostId) {
      throw new KomlaOperationError(
        'UNSUPPORTED_LOCATION',
        'komla open opens folders on this computer; folders on SSH hosts open with New Workspace.',
        400
      );
    }
    if (!isAbsolute(path)) {
      throw new KomlaOperationError('INVALID_PATH', `${path} is not an absolute path.`, 400);
    }
    const workspace = this.resolveWorkspace(context);
    const folder = resolve(path);
    if (!this.dependencies.requestOpenFolder(folder, workspace?.windowId)) {
      throw new KomlaOperationError('FOLDER_NOT_FOUND', `${folder} is not a folder.`, 404);
    }
    return { folder: { path: folder } };
  }

  /** Trashes it once the turn finishes; one interrupted, failed or running too long keeps it. */
  private trashAfterTurn(workspaceId: string, terminalId: string): void {
    const limit = setTimeout(() => {
      stopWatching();
      this.finishTrash(workspaceId, terminalId, 'Its turn ran longer than 30 minutes.');
    }, TRASH_TURN_LIMIT_MS);
    const stopWatching = this.dependencies.watchAgentTurnEnd(workspaceId, terminalId, (end) => {
      clearTimeout(limit);
      this.finishTrash(
        workspaceId,
        terminalId,
        end === 'done' ? undefined : 'Its turn was interrupted before it finished.'
      );
    });
  }

  private finishTrash(
    workspaceId: string,
    callerTerminalId: string | undefined,
    turnStopped?: string
  ): void {
    const pending = this.pendingTrashes.get(workspaceId);
    pending?.delete(callerTerminalId ?? '');
    if (pending?.size === 0) this.pendingTrashes.delete(workspaceId);
    // Another agent here asked too; the last one to finish trashes it.
    if (pending && pending.size > 0) return;
    const workspace = this.dependencies.getWorkspace(workspaceId);
    // The user may have trashed or deleted it meanwhile.
    if (!workspace || (workspace.status !== undefined && workspace.status !== 'active')) return;
    const refusal =
      trashBlocker(workspace, callerTerminalId, callerTerminalId !== undefined) ?? turnStopped;
    this.dependencies.requestTrash({ workspaceId, ...(refusal ? { refusal } : {}) });
  }

  private updateAndPublish(workspaceId: string, updates: Record<string, unknown>): void {
    const updated = this.dependencies.updateWorkspace(workspaceId, updates);
    if (!updated) {
      throw new KomlaOperationError(
        'WORKSPACE_NOT_FOUND',
        'The current Komla workspace no longer exists.',
        404
      );
    }
    this.dependencies.publish(IPC.WORKSPACE_UPDATED, updated);
  }

  private setStatusItem(
    context: KomlaOperationContext,
    {
      id,
      text: textInput,
      segments: segmentsInput,
      icon: iconInput,
      iconColor,
      tone,
      style,
      color,
      tooltip,
      link,
      popover,
      popoverMarkdown,
    }: Extract<KomlaOperation, { type: 'status.set' }>
  ): KomlaOperationResults['status.set'] {
    const workspace = this.requireWorkspace(context);
    if (textInput === undefined && segmentsInput === undefined) {
      throw new KomlaOperationError(
        'INVALID_STATUS_TEXT',
        'A status item needs text or segments.',
        400
      );
    }
    checkStatusItemClick(link, popover, popoverMarkdown);
    const iconUrl = (icon: string) => {
      const url = statusIconDataUrl(icon);
      if (url) return url;
      throw new KomlaOperationError(
        'INVALID_STATUS_ICON',
        'Status item icons are SVG markup or an image data URL (SVG, PNG, WebP, GIF or JPEG) of at most 32 KB.',
        400
      );
    };
    const icons =
      (segmentsInput?.filter(isStatusIconSegment).length ?? 0) + (iconInput === undefined ? 0 : 1);
    if (icons > MAX_STATUS_ITEM_ICONS) {
      throw new KomlaOperationError(
        'INVALID_STATUS_ICON',
        `A status item shows at most ${MAX_STATUS_ITEM_ICONS} icons, icon included.`,
        400
      );
    }
    const fitted = segmentsInput
      ? statusItemSegmentsText(
          segmentsInput.map((segment) =>
            isStatusIconSegment(segment) ? { ...segment, icon: iconUrl(segment.icon) } : segment
          )
        )
      : statusItemText(textInput ?? '');
    const { text } = fitted;
    if (!text) {
      throw new KomlaOperationError('INVALID_STATUS_TEXT', 'A status item needs text.', 400);
    }
    const segments = iconInput
      ? withLeadingIcon(fitted, iconUrl(iconInput), iconColor)
      : fitted.segments;
    const content = {
      text,
      ...(segments && { segments }),
      ...(tone !== undefined && { tone }),
      ...(style !== undefined && { style }),
      ...(color !== undefined && { color }),
      ...(tooltip !== undefined && { tooltip }),
      ...(link !== undefined && { link }),
      ...(popover !== undefined && { popover }),
      ...(popoverMarkdown !== undefined && { popoverMarkdown }),
    };
    if (!this.dependencies.setStatusItem(workspace.id, id, content)) {
      throw new KomlaOperationError(
        'STATUS_ITEM_LIMIT',
        'This workspace already has as many status items as it can show. Clear one with `komla status clear <id>` first.',
        409
      );
    }
    // The item as set, without the popover's HTML, which the caller sent and has.
    const { popover: _sent, ...shown } = content;
    return { status: { workspaceId: workspace.id, id, ...shown } };
  }

  private clearStatusItems(
    context: KomlaOperationContext,
    id?: string
  ): KomlaOperationResults['status.clear'] {
    const workspace = this.requireWorkspace(context);
    const cleared = this.dependencies.clearStatusItems(workspace.id, id);
    return { status: { workspaceId: workspace.id, ...(id !== undefined && { id }), cleared } };
  }

  private async refreshStatusCommand(
    context: KomlaOperationContext,
    id: string
  ): Promise<KomlaOperationResults['status.refresh']> {
    const workspace = this.requireWorkspace(context);
    const result = await this.dependencies.refreshStatusCommand(workspace.id, id);
    if (!result) {
      throw new KomlaOperationError(
        'STATUS_ITEM_NOT_FOUND',
        `status-items.json has no item ${id} that runs in this workspace. Status items set with \`komla status set\` don't run a command, so set them again instead.`,
        404
      );
    }
    if (result === 'unavailable') {
      throw new KomlaOperationError(
        'WORKSPACE_UNAVAILABLE',
        "This workspace can't run commands right now, as while its SSH host reconnects. Try again once it's connected.",
        409
      );
    }
    return {
      status: {
        workspaceId: workspace.id,
        id,
        refreshed: true,
        ...(result.content && { text: result.content.text }),
        ...(result.error !== undefined && { error: result.error }),
      },
    };
  }

  private async launchAgent(
    context: KomlaOperationContext,
    operation: AgentLaunchOperation
  ): Promise<AgentLaunchResult> {
    if (
      operation.destination === 'tab' &&
      (operation.name !== undefined ||
        operation.description !== undefined ||
        operation.branch !== undefined ||
        operation.fromCurrentBranch === true)
    ) {
      throw new KomlaOperationError(
        'INVALID_AGENT_DESTINATION_OPTIONS',
        'Workspace name, description, and branch options are only valid for workspace launches.',
        400
      );
    }
    const workspace = this.resolveWorkspace(context);
    if (operation.draft) return this.draftWorkspaceLaunch(context, workspace, operation);
    if (operation.destination === 'tab' && !workspace) {
      this.requireWorkspace(context);
    }
    if (operation.destination === 'workspace') {
      return this.launchAgentInWorkspace(context, workspace, operation);
    }
    const selection = this.resolveAgentSelection(
      workspace,
      operation,
      this.workspaceEnvironment(workspace!),
      operation.prompt
    );
    const terminal = await this.dependencies.addAgentTab(
      workspace!.id,
      operation.prompt,
      selection.mode?.id,
      selection.preset?.id,
      // The workspace's agent, its mode and the most recent agent stay the user's picks.
      {
        keepWorkspaceAgent: true,
        ...(selection.effort ? { reasoningLevelId: selection.effort.id } : {}),
      }
    );
    this.dependencies.publish(IPC.WORKSPACE_AGENT_TAB_ADDED, {
      workspaceId: workspace!.id,
      terminalId: terminal.id,
    });
    return {
      state: 'started',
      destination: { kind: 'tab', workspaceId: workspace!.id, terminalId: terminal.id },
      ...(selection.preset ? { agent: this.agentResult(selection) } : {}),
    };
  }

  private async launchAgentInWorkspace(
    context: KomlaOperationContext,
    workspace: KomlaOperationWorkspace | undefined,
    operation: AgentLaunchOperation
  ): Promise<AgentLaunchResult> {
    const target = this.resolveWorkspaceLaunchTarget(context, workspace, operation.project);
    const placement = this.workspaceLaunchParams(
      target.project,
      target.workspace,
      target.fromWorkspace,
      operation,
      context.sshHostId
    );
    const selection = this.resolveAgentSelection(
      target.workspace,
      operation,
      plannedWorkspaceEnvironment(placement, this.dependencies.resolveEnvironment()),
      operation.prompt
    );
    const params: CreateWorkspaceParams = {
      ...placement,
      presetId: selection.preset?.id,
      launchModeId: selection.mode?.id,
      ...(selection.effort ? { reasoningLevelId: selection.effort.id } : {}),
    };
    if (operation.fromCurrentBranch) {
      params.baseBranch = await this.currentBranchStartPoint(
        target.project,
        this.launchSourceWorkspace(target.project, target.workspace),
        params
      );
    }
    // Workspace creation would also refuse, but with an error the CLI and MCP can't show.
    if (context.sshHostId && params.environment?.kind === 'ssh' && target.project) {
      const remoteUrl = await this.dependencies.getProjectRemoteUrl(target.project.id);
      if (!remoteUrl) {
        throw new KomlaOperationError(
          'SSH_HOST_PROJECT_NEEDS_REMOTE',
          `Add a Git remote to ${target.project.name} to start it on an SSH host.`,
          400
        );
      }
    }
    const created = await this.dependencies.createWorkspace(params);
    this.dependencies.publish(IPC.WORKSPACE_CREATED, created);
    return {
      state: created.provisioning ? 'provisioning' : 'started',
      destination: {
        kind: 'workspace',
        workspaceId: created.id,
        ...(created.workingDirectory ? { path: created.workingDirectory } : {}),
        ...(created.branchName ? { branch: created.branchName } : {}),
        ...(params.baseBranch ? { branchedFrom: params.baseBranch } : {}),
      },
      ...(selection.preset ? { agent: this.agentResult(selection) } : {}),
    };
  }

  /**
   * Opens New Workspace with the launch filled in, in the calling workspace's window, and starts
   * nothing: the user changes it and starts it, so it needs no confirmation, and agents' limits on
   * which modes they may start don't apply. A draft from outside every workspace opens on no
   * project, for the user to pick one.
   */
  private async draftWorkspaceLaunch(
    context: KomlaOperationContext,
    workspace: KomlaOperationWorkspace | undefined,
    operation: AgentLaunchOperation
  ): Promise<AgentLaunchResult> {
    refuseUndraftableOptions(operation);
    const resolution =
      !workspace && context.cwd
        ? this.dependencies.resolveProjectByCwd(context.cwd, context.sshHostId)
        : undefined;
    const caller = workspace ?? resolution?.sourceWorkspace;
    const project = operation.project
      ? this.resolveProjectSelector(operation.project)
      : caller?.projectId
        ? this.dependencies.getProject(caller.projectId)
        : resolution?.project;
    const selection = this.draftAgentSelection(operation);
    const startPoint = operation.fromCurrentBranch
      ? await this.draftStartPoint(project, this.launchSourceWorkspace(project, caller))
      : {};
    this.dependencies.publish(IPC.NEW_WORKSPACE_DRAFT, {
      ...(caller ? { workspaceId: caller.id } : {}),
      ...(operation.prompt ? { prompt: operation.prompt } : {}),
      ...(project ? { projectId: project.id } : {}),
      ...startPoint,
      ...(selection.preset ? { presetId: selection.preset.id } : {}),
      ...(selection.mode ? { launchModeId: selection.mode.id } : {}),
    } satisfies NewWorkspaceDraft);
    return {
      state: 'drafted',
      destination: {
        kind: 'draft',
        ...(project ? { projectId: project.id } : {}),
        ...(startPoint.baseBranch ? { branchedFrom: startPoint.baseBranch } : {}),
      },
      ...(selection.preset ? { agent: this.agentResult(selection) } : {}),
    };
  }

  /** The agent and mode a draft names, by id or name, any the user left on. */
  private draftAgentSelection({
    preset: presetSelector,
    mode: modeSelector,
  }: AgentLaunchOperation): AgentSelection {
    if (!presetSelector) {
      if (!modeSelector) return {};
      throw new KomlaOperationError(
        'AGENT_PRESET_REQUIRED',
        'A draft names a launch mode only with its agent.',
        400
      );
    }
    const preset = this.resolvePresetSelector(this.activePresets(), presetSelector);
    return modeSelector
      ? { preset, mode: this.resolveModeSelector(preset, modeSelector) }
      : { preset };
  }

  /** Where a draft from the current branch starts: the calling workspace's branch and machine. */
  private async draftStartPoint(
    project: KomlaOperationProject | undefined,
    source: KomlaOperationWorkspace | undefined
  ): Promise<Pick<NewWorkspaceDraft, 'baseBranch' | 'sourceWorkspaceId' | 'sshHostId'>> {
    if (!source || !project || project.kind === 'directory') {
      throw currentBranchUnavailable();
    }
    return {
      baseBranch: await this.checkedOutBranch(source),
      sourceWorkspaceId: source.id,
      ...(source.backend?.kind === 'ssh' ? { sshHostId: source.backend.hostId } : {}),
    };
  }

  /** The branch checked out in the workspace, which a new one can start from. */
  private async checkedOutBranch(source: KomlaOperationWorkspace): Promise<string> {
    const branch = await this.dependencies.getCheckedOutBranch(source);
    // SSH status snapshots name a detached HEAD "HEAD".
    if (!branch || branch === 'HEAD') {
      throw new KomlaOperationError(
        'CURRENT_BRANCH_UNAVAILABLE',
        'The calling workspace has no branch checked out to start from.',
        400
      );
    }
    return branch;
  }

  /** The agents the user left on. */
  private activePresets(): AgentPreset[] {
    const activeIds = new Set(this.dependencies.getActivePresets().map((entry) => entry.presetId));
    return this.dependencies.listPresets().filter((preset) => activeIds.has(preset.id));
  }

  private resolveWorkspaceLaunchTarget(
    context: KomlaOperationContext,
    workspace: KomlaOperationWorkspace | undefined,
    projectSelector?: string
  ): {
    project?: KomlaOperationProject;
    workspace?: KomlaOperationWorkspace;
    /** The launch came from a workspace, even one whose cwd matches several synced copies. */
    fromWorkspace: boolean;
  } {
    const contextResolution =
      !workspace && context.cwd
        ? this.dependencies.resolveProjectByCwd(context.cwd, context.sshHostId)
        : undefined;
    workspace ??= contextResolution?.sourceWorkspace;
    // The cwd may match several synced copies, in which case only the project resolves.
    if (!projectSelector && !workspace && !contextResolution?.project) {
      throw this.projectRequiredError(context.sshHostId, contextResolution?.error);
    }
    const project = projectSelector
      ? this.resolveProjectSelector(projectSelector)
      : workspace?.projectId
        ? this.dependencies.getProject(workspace.projectId)
        : contextResolution?.project;
    const canReuseUrlOnlySshWorkspace =
      !projectSelector &&
      workspace?.projectId == null &&
      workspace?.backend?.kind === 'ssh' &&
      !!workspace.backend.gitUrl;
    if (!project && !canReuseUrlOnlySshWorkspace) {
      throw new KomlaOperationError(
        'PROJECT_NOT_FOUND',
        'The current Komla project could not be resolved.',
        404
      );
    }
    return { project, workspace, fromWorkspace: !!workspace || !!contextResolution?.project };
  }

  /**
   * A launch from outside every workspace, or from where workspaces of several projects meet
   * (`ambiguity` says how), names its project; this lists the ones it may.
   */
  private projectRequiredError(sshHostId?: string, ambiguity?: string): KomlaOperationError {
    // A request through an SSH host's tunnel places work on that host, where folder projects can't run.
    const projects = this.dependencies
      .listProjects()
      .filter((project) => !sshHostId || project.kind !== 'directory');
    if (ambiguity) {
      return new KomlaOperationError(
        'PROJECT_AMBIGUOUS',
        `${ambiguity} Name the project with --project.`,
        409,
        { availableProjects: projects.map(({ id, name }) => ({ id, name })) }
      );
    }
    return new KomlaOperationError(
      'PROJECT_REQUIRED',
      projects.length
        ? `This is not a Komla workspace, so name the project with --project. Projects: ${projects.map(({ name }) => name).join(', ')}.`
        : `This is not a Komla workspace, and Komla has no ${sshHostId ? 'Git ' : ''}projects to start one in. Add one in Komla first.`,
      400,
      { availableProjects: projects.map(({ id, name }) => ({ id, name })) }
    );
  }

  /** Where a launch from this computer puts its workspace: the pinned SSH host, else the caller's. */
  private localLaunchPlacement(
    config: ReturnType<KomlaOperationDependencies['getConfig']>,
    mode: 'worktree' | 'directory',
    fromWorkspace: boolean,
    sourceWorkspace: KomlaOperationWorkspace | undefined
  ): Pick<CreateWorkspaceParams, 'environment'> {
    const placement = agentLaunchWorkspacePlacement(
      config,
      { mode, sourceIsSsh: sourceWorkspace?.backend?.kind === 'ssh', fromWorkspace },
      (hostId) => this.dependencies.isSshHostReady(hostId)
    );
    if (!('unreadyHostId' in placement)) return placement;
    const { unreadyHostId } = placement;
    throw new KomlaOperationError(
      'SSH_HOST_NOT_READY',
      unreadyPinnedHostMessage(
        this.dependencies.listSshHosts().find(({ id }) => id === unreadyHostId)
      ),
      409
    );
  }

  private workspaceLaunchParams(
    project: KomlaOperationProject | undefined,
    workspace: KomlaOperationWorkspace | undefined,
    fromWorkspace: boolean,
    operation: AgentLaunchOperation,
    sshHostId?: string
  ): CreateWorkspaceParams {
    const config = this.dependencies.getConfig();
    const sourceWorkspace = this.launchSourceWorkspace(project, workspace);
    const mode = project?.kind === 'directory' ? 'directory' : 'worktree';
    // Under a tunnel every resolved workspace is on that host. Without one to
    // copy, the new workspace still goes on the host, never wherever the launch
    // defaults point.
    const tunnelHostId = sourceWorkspace ? undefined : sshHostId;
    if (tunnelHostId && mode === 'directory') {
      throw new KomlaOperationError(
        'SSH_HOST_PROJECT_UNSUPPORTED',
        "Folder projects can't run on an SSH host.",
        400
      );
    }
    return {
      mode,
      ...(project ? { projectId: project.id } : {}),
      customName: operation.name,
      customDescription: operation.description,
      initialPrompt: operation.prompt,
      branchName: project?.kind === 'directory' ? undefined : operation.branch,
      windowId: workspace?.windowId ?? this.dependencies.getMainWindowId() ?? undefined,
      ...(tunnelHostId
        ? { environment: { kind: 'ssh' as const, hostId: tunnelHostId } }
        : this.localLaunchPlacement(config, mode, fromWorkspace, sourceWorkspace)),
      deferBranchNaming: true,
      skipRecordUsage: true,
      ...(sourceWorkspace?.backend?.kind === 'ssh'
        ? {
            location: {
              kind: 'ssh' as const,
              hostId: sourceWorkspace.backend.hostId,
              gitUrl: sourceWorkspace.backend.gitUrl,
              sourceBackend: sourceWorkspace.backend as Extract<
                NonNullable<Workspace['backend']>,
                { kind: 'ssh' }
              >,
            },
            sourceWorkspaceId: sourceWorkspace.id,
          }
        : {}),
    };
  }

  /** The calling workspace a new workspace shares a repository with, if any. */
  private launchSourceWorkspace(
    project: KomlaOperationProject | undefined,
    workspace: KomlaOperationWorkspace | undefined
  ): KomlaOperationWorkspace | undefined {
    return project
      ? workspace?.projectId === project.id
        ? workspace
        : undefined
      : workspace?.projectId == null && workspace?.backend?.kind === 'ssh'
        ? workspace
        : undefined;
  }

  private async currentBranchStartPoint(
    project: KomlaOperationProject | undefined,
    source: KomlaOperationWorkspace | undefined,
    params: CreateWorkspaceParams
  ): Promise<string> {
    if (!source || params.mode !== 'worktree') throw currentBranchUnavailable();
    const branch = await this.checkedOutBranch(source);
    // A source on an SSH host shares its clone, but any other SSH host only sees
    // commits on origin.
    const environment =
      params.environment ??
      (params.location?.kind === 'ssh'
        ? undefined
        : plannedWorkspaceEnvironment(params, this.dependencies.resolveEnvironment()));
    if (
      environment?.kind === 'ssh' &&
      project &&
      !(await this.dependencies.isBranchOnOrigin(project.id, branch))
    ) {
      throw new KomlaOperationError(
        'CURRENT_BRANCH_NOT_PUSHED',
        `Komla couldn't confirm that origin has every commit on ${branch}, and the new workspace starts on an SSH host, which only sees commits on origin. Push the branch, or check that origin is reachable.`,
        400
      );
    }
    return branch;
  }

  /** `environment` is where the new agent would run. */
  private resolveAgentSelection(
    workspace: KomlaOperationWorkspace | undefined,
    {
      preset: presetSelector,
      mode: modeSelector,
      effort: effortSelector,
    }: Pick<AgentLaunchOperation, 'preset' | 'mode' | 'effort'>,
    environment: DesiredWorkspaceEnvironment,
    prompt: string | undefined
  ): AgentSelection {
    const presets = this.dependencies.listPresets();
    const activeEntries = this.dependencies.getActivePresets();
    const activeIds = new Set(activeEntries.map((entry) => entry.presetId));
    const config = this.dependencies.getConfig();
    const pin = pinnedAgentLaunch(config);
    const defaultPresetId = pin.presetId ?? workspace?.presetId ?? activeEntries.at(0)?.presetId;
    const preset = this.selectPresetForLaunch(presets, activeIds, defaultPresetId, presetSelector);
    if (!preset) {
      return this.selectionWithoutPreset(pin.presetId, pin.modeId, modeSelector, effortSelector);
    }
    this.requireLaunchablePreset(preset);
    // Otherwise the agent opens without the task, and the launcher thinks it handed it over.
    if (prompt?.trim() && !canStartWithPrompt(preset)) {
      throw new KomlaOperationError(
        'AGENT_PRESET_PROMPT_UNSUPPORTED',
        `${preset.name} can't start with a prompt. Launch it without one, or pick another agent.`,
        409,
        { presetId: preset.id }
      );
    }
    // Without a named mode the agent starts in Default, or the pinned agent in its pinned mode.
    const mode = modeSelector
      ? this.resolveModeSelector(preset, modeSelector)
      : preset.id === pin.presetId
        ? preset.launchModes.find((entry) => entry.id === pin.modeId)
        : undefined;
    // An agent may only start the modes the user lets agents start where the
    // new agent runs, or the one pinned for agent launches. Otherwise any agent
    // could launch one that acts without asking, with its own prompt, and an
    // isolated one could start it on this computer. A mode no one named is the pinned one.
    const policy = mode ? pinnedAgentLaunchPolicy(pin, preset.id, mode) : 'always';
    const isolated = () =>
      isIsolatedEnvironment(environment, { sshHosts: this.dependencies.listSshHosts() });
    if (mode && !agentsMayLaunch(policy, isolated())) {
      const isolatedOnly = policy === 'isolated';
      throw new KomlaOperationError(
        isolatedOnly ? 'AGENT_MODE_REQUIRES_ISOLATION' : 'AGENT_MODE_REQUIRES_USER',
        isolatedOnly
          ? isolatedOnlyRefusal(preset, mode, environment)
          : `Launch mode "${mode.name}" can only be started by the user. ${letAgentsStartHint(preset)}`,
        403,
        { presetId: preset.id, modeId: mode.id, ...(isolatedOnly ? { environment } : {}) }
      );
    }
    const effort = effortSelector ? this.resolveEffortSelector(preset, effortSelector) : undefined;
    // A level's arguments are the user's own, so one can skip permission prompts as a mode can.
    // Levels have no robot button, so agents may start such a level only on an isolated host.
    if (effort && skipsPermissionPrompts(effort) && !isolated()) {
      throw isolatedOnlyEffortRefusal(preset, effort, environment);
    }
    return { preset, ...(mode ? { mode } : {}), ...(effort ? { effort } : {}) };
  }

  private selectPresetForLaunch(
    presets: AgentPreset[],
    activeIds: Set<string>,
    defaultPresetId: string | null | undefined,
    selector?: string
  ): AgentPreset | undefined {
    if (selector) {
      return this.resolvePresetSelector(
        presets.filter((entry) => activeIds.has(entry.id)),
        selector
      );
    }
    return presets.find((entry) => entry.id === defaultPresetId);
  }

  private selectionWithoutPreset(
    configuredPresetId?: string,
    configuredModeId?: string,
    modeSelector?: string,
    effortSelector?: string
  ): AgentSelection {
    if (configuredPresetId) {
      return {
        preset: {
          id: configuredPresetId,
          name: configuredPresetId,
          openCommand: '',
          continueCommand: '',
          promptCommand: '',
          launchModes: [],
          isBuiltin: false,
        },
        ...(configuredModeId ? { mode: { id: configuredModeId, name: configuredModeId } } : {}),
      };
    }
    if (modeSelector || effortSelector) {
      throw new KomlaOperationError(
        'AGENT_PRESET_NOT_FOUND',
        `${modeSelector ? 'A launch mode' : 'An effort level'} cannot be selected because no active agent preset is available.`,
        404
      );
    }
    return {};
  }

  private requireLaunchablePreset(preset: AgentPreset): void {
    if (this.isLaunchablePreset(preset)) return;
    throw new KomlaOperationError(
      'AGENT_PRESET_UNAVAILABLE',
      `Agent preset "${preset.name}" does not define an agent command.`,
      409,
      { presetId: preset.id }
    );
  }

  private agentResult({ preset, mode, effort }: AgentSelection): AgentLaunchSelection {
    return {
      preset: { id: preset!.id, name: preset!.name },
      ...(mode ? { mode: { id: mode.id, name: mode.name } } : {}),
      ...(effort ? { effort: { id: effort.id, name: effort.name } } : {}),
    };
  }

  private resolveProjectSelector(selector: string): KomlaOperationProject {
    const projects = this.dependencies.listProjects();
    const exact = projects.find((project) => project.id === selector);
    if (exact) return exact;
    const matches = projects.filter(
      (project) => project.name.localeCompare(selector, undefined, { sensitivity: 'accent' }) === 0
    );
    if (matches.length === 1) return matches[0];
    throw new KomlaOperationError(
      matches.length > 1 ? 'PROJECT_AMBIGUOUS' : 'PROJECT_NOT_FOUND',
      matches.length > 1
        ? `Project name "${selector}" is ambiguous.`
        : `Project "${selector}" was not found.`,
      matches.length > 1 ? 409 : 404,
      { availableProjects: projects.map(({ id, name }) => ({ id, name })) }
    );
  }

  private resolvePresetSelector(presets: AgentPreset[], selector: string): AgentPreset {
    const exact = presets.find((preset) => preset.id === selector);
    if (exact) return exact;
    const matches = presets.filter(
      (preset) => preset.name.localeCompare(selector, undefined, { sensitivity: 'accent' }) === 0
    );
    if (matches.length === 1) return matches[0];
    throw new KomlaOperationError(
      matches.length > 1 ? 'AGENT_PRESET_AMBIGUOUS' : 'AGENT_PRESET_NOT_FOUND',
      matches.length > 1
        ? `Agent preset name "${selector}" is ambiguous.`
        : `No active agent preset matches "${selector}".`,
      matches.length > 1 ? 409 : 404,
      matches.length > 1 ? { matches: matches.map(({ id, name }) => ({ id, name })) } : undefined
    );
  }

  private resolveModeSelector(
    preset: AgentPreset,
    selector: string
  ): AgentPreset['launchModes'][number] {
    const exact = preset.launchModes.find((mode) => mode.id === selector);
    if (exact) return exact;
    const matches = preset.launchModes.filter(
      (mode) => mode.name.localeCompare(selector, undefined, { sensitivity: 'accent' }) === 0
    );
    if (matches.length === 1) return matches[0];
    throw new KomlaOperationError(
      matches.length > 1 ? 'AGENT_MODE_AMBIGUOUS' : 'AGENT_MODE_NOT_FOUND',
      matches.length > 1
        ? `Launch mode name "${selector}" is ambiguous for ${preset.name}.`
        : `No launch mode on ${preset.name} matches "${selector}".`,
      matches.length > 1 ? 409 : 404,
      matches.length > 1 ? { matches: matches.map(({ id, name }) => ({ id, name })) } : undefined
    );
  }

  /** One of the levels the agent's picker shows; a hidden picker launches at the agent default. */
  private resolveEffortSelector(preset: AgentPreset, selector: string): ReasoningLevel {
    const levels = shownReasoningLevels(preset);
    const exact = levels.find((level) => level.id === selector);
    if (exact) return exact;
    const matches = levels.filter(
      (level) => level.name.localeCompare(selector, undefined, { sensitivity: 'accent' }) === 0
    );
    if (matches.length === 1) return matches[0];
    const available = levels.map(({ id, name }) => ({ id, name }));
    throw new KomlaOperationError(
      matches.length > 1 ? 'AGENT_EFFORT_AMBIGUOUS' : 'AGENT_EFFORT_NOT_FOUND',
      matches.length > 1
        ? `Effort level name "${selector}" is ambiguous for ${preset.name}.`
        : levels.length === 0
          ? `${preset.name} has no effort levels to choose from.`
          : `No effort level on ${preset.name} matches "${selector}". Levels: ${levels.map(({ name }) => name).join(', ')}.`,
      matches.length > 1 ? 409 : 404,
      { presetId: preset.id, availableLevels: available }
    );
  }

  private getAgentPresets(includeInactive: boolean): KomlaOperationResults['agent.presets'] {
    const presets = this.dependencies.listPresets();
    const activeEntries = this.dependencies.getActivePresets();
    const activeIds = new Set(activeEntries.map((entry) => entry.presetId));
    const pin = pinnedAgentLaunch(this.dependencies.getConfig());
    const defaultPresetId = pin.presetId ?? activeEntries.at(0)?.presetId;
    // Only the pinned agent starts in a mode it wasn't asked for, which agents may always start.
    const defaultModeId = pin.presetId
      ? presets
          .find((preset) => preset.id === pin.presetId)
          ?.launchModes.find((mode) => mode.id === pin.modeId)?.id
      : undefined;
    const environment = this.dependencies.resolveEnvironment();
    return {
      ...(defaultPresetId
        ? {
            default: {
              presetId: defaultPresetId,
              ...(defaultModeId ? { modeId: defaultModeId } : {}),
            },
          }
        : {}),
      presets: presets
        .filter((preset) => includeInactive || activeIds.has(preset.id))
        .map((preset) => ({
          id: preset.id,
          name: preset.name,
          active: activeIds.has(preset.id),
          launchable: this.isLaunchablePreset(preset),
          ...(!this.isLaunchablePreset(preset)
            ? { unavailableReason: 'This preset does not define an agent command.' }
            : {}),
          environment,
          ...this.presetEffort(preset),
          // Modes only the user can start are listed too, so an agent asked for
          // one can tell the user how to allow it instead of picking another.
          modes: preset.launchModes.map((mode) => {
            const policy = pinnedAgentLaunchPolicy(pin, preset.id, mode);
            return {
              id: mode.id,
              name: mode.name,
              environment,
              launchable: policy !== 'never',
              // Agents may start it only on an SSH host marked isolated.
              ...(policy === 'isolated' ? { isolatedOnly: true } : {}),
              ...(policy === 'never'
                ? {
                    unavailableReason: `Only the user can start this mode. ${letAgentsStartHint(preset)}`,
                  }
                : {}),
            };
          }),
        })),
    };
  }

  /**
   * The levels `--effort` picks from, under the picker's title, which an agent can give another
   * meaning, such as Model. None while the picker is hidden.
   */
  private presetEffort(preset: AgentPreset): {
    effort?: { title: string; levels: Array<{ id: string; name: string; isolatedOnly?: true }> };
  } {
    const levels = shownReasoningLevels(preset);
    if (levels.length === 0) return {};
    return {
      effort: {
        title: levelPickerOf(preset).title,
        // Agents may start a level that skips permission prompts only isolated, as such a mode.
        levels: levels.map((level) => ({
          id: level.id,
          name: level.name,
          ...(skipsPermissionPrompts(level) ? { isolatedOnly: true as const } : {}),
        })),
      },
    };
  }

  private getContext(context: KomlaOperationContext): KomlaOperationResults['context.get'] {
    const workspace = this.resolveWorkspace(context);
    const project = workspace?.projectId
      ? this.dependencies.getProject(workspace.projectId)
      : undefined;
    return {
      context: {
        connected: true,
        ...(project ? { project: { id: project.id, name: project.name } } : {}),
        ...(workspace
          ? {
              workspace: {
                id: workspace.id,
                ...(workspace.workingDirectory ? { path: workspace.workingDirectory } : {}),
                environment: this.workspaceEnvironment(workspace),
              },
            }
          : {}),
        ...(context.terminalId ? { terminalId: context.terminalId } : {}),
        ...(workspace?.presetId
          ? {
              agent: {
                presetId: workspace.presetId,
                ...(workspace.launchModeId ? { modeId: workspace.launchModeId } : {}),
              },
            }
          : {}),
      },
    };
  }

  /**
   * The workspaces scripts can name with `--workspace`; through an SSH host's tunnel, only that
   * host's.
   */
  private listWorkspaces(
    context: KomlaOperationContext,
    includeTrashed: boolean
  ): KomlaOperationResults['workspace.list'] {
    const workspaces = this.dependencies
      .listWorkspaces()
      .filter((workspace) => includeTrashed || workspace.status !== 'trashed')
      .filter(
        (workspace) =>
          !context.sshHostId ||
          (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === context.sshHostId)
      )
      .map((workspace) => {
        const project = workspace.projectId
          ? this.dependencies.getProject(workspace.projectId)
          : undefined;
        const progress = workspaceProgress(workspace);
        return {
          id: workspace.id,
          name: workspace.customName || workspace.name || '',
          ...(project && { project: { id: project.id, name: project.name } }),
          ...(workspace.branchName && { branch: workspace.branchName }),
          ...(workspace.workingDirectory && { path: workspace.workingDirectory }),
          environment: this.workspaceEnvironment(workspace),
          ...(workspace.status === 'trashed' && { trashed: true as const }),
          agentActive: workspace.agentActive === true,
          ...(workspace.attention && { attention: workspace.attention.kind }),
          ...(workspace.tag && { tag: workspace.tag }),
          ...(workspace.markers?.length && {
            markers: workspace.markers.map(({ key, label, tone, spinner }) => ({
              key,
              label,
              tone,
              ...(spinner && { spinner }),
            })),
          }),
          ...(progress && { progress: progress.label }),
          ...(workspace.linkedWorkspaceIds?.length && {
            linkedWorkspaceIds: workspace.linkedWorkspaceIds,
          }),
        };
      });
    return { workspaces };
  }

  /**
   * An icon shows as `hasIcon`: its image is the user's, and too big to list for each tag. `hidden`
   * marks a tag whose workspaces leave the sidebar's list, so an agent doesn't hide one by tagging.
   */
  private listTags(): KomlaOperationResults['tag.list'] {
    const hidden = new Set(this.dependencies.getConfig().hiddenWorkspaceTags);
    const tags = this.dependencies.workspaceTags().map((tag) => ({
      name: tag.name,
      tone: tag.tone,
      ...(tag.pullRequestState && { pullRequestState: tag.pullRequestState }),
      ...(tag.icon && { hasIcon: true as const }),
      ...(hidden.has(workspaceTagKey(tag.name)) && { hidden: true as const }),
    }));
    return { tags };
  }

  private resolveWorkspace(context: KomlaOperationContext): KomlaOperationWorkspace | undefined {
    if (context.terminalId) {
      const workspace = this.dependencies.findWorkspaceByTerminalId(context.terminalId);
      if (workspace) return this.requireTrustedSshHost(workspace, context.sshHostId);
    }
    if (context.workspaceId) {
      const workspace = this.dependencies.getWorkspace(context.workspaceId);
      if (workspace) return this.requireTrustedSshHost(workspace, context.sshHostId);
    }
    return context.cwd
      ? this.dependencies.resolveWorkspaceByCwd(context.cwd, context.sshHostId).workspace
      : undefined;
  }

  private requireTrustedSshHost(
    workspace: KomlaOperationWorkspace,
    sshHostId?: string
  ): KomlaOperationWorkspace {
    if (
      sshHostId &&
      (workspace.backend?.kind !== 'ssh' || workspace.backend.hostId !== sshHostId)
    ) {
      throw new KomlaOperationError(
        'WORKSPACE_CONTEXT_CONFLICT',
        'The requested workspace is outside the trusted SSH host context.',
        403
      );
    }
    return workspace;
  }

  private listTerminals(context: KomlaOperationContext): KomlaOperationResults['terminal.list'] {
    const workspace = this.requireWorkspace(context);
    return {
      terminals: (workspace.terminals ?? []).map((terminal) => ({
        ...this.describeTerminal(terminal),
        ...(terminal.id === callerTerminal(context) ? { current: true } : {}),
      })),
    };
  }

  private async readTerminal(
    context: KomlaOperationContext,
    operation: Extract<KomlaOperation, { type: 'terminal.read' }>
  ): Promise<KomlaOperationResults['terminal.read']> {
    const { terminal } = this.resolveTerminal(context, operation.terminal);
    const screen = await this.dependencies.readTerminalText(
      terminal.id,
      operation.history ?? TERMINAL_READ_DEFAULT_HISTORY
    );
    if (!screen) throw this.terminalNotRunning(terminal);
    return { terminal: this.describeTerminal(terminal), text: screen.text };
  }

  private async sendToTerminal(
    context: KomlaOperationContext,
    operation: Extract<KomlaOperation, { type: 'terminal.send' }>
  ): Promise<KomlaOperationResults['terminal.send']> {
    const { workspace, terminal } = this.resolveTerminal(context, operation.terminal);
    if (terminal.id === callerTerminal(context)) {
      throw new KomlaOperationError(
        'TERMINAL_IS_CALLER',
        'That is the terminal this command runs in; send to another one.',
        400
      );
    }
    const text = typedText(operation.text);
    if (!text.trim()) {
      throw new KomlaOperationError(
        'EMPTY_MESSAGE',
        'The message has no text to type once its control characters are left out.',
        400
      );
    }
    let described = this.describeSendTarget(terminal, operation.force === true);
    const sender = callerTerminal(context) ?? '';
    // `--force` only matters to an agent waiting for the user, whose question the message answers.
    const forced = operation.force === true && described.state === 'blocked';
    if (
      !context.userConfirmed &&
      (forced || !this.allowedTerminalSenders.get(terminal.id)?.has(sender))
    ) {
      described = await this.confirmTerminalSend(context, {
        workspaceId: workspace.id,
        terminal,
        described,
        sender,
        text,
        forced,
      });
    }
    // Agents enable bracketed paste, so a message of several lines arrives as one.
    const screen = await this.dependencies.readTerminalText(terminal.id, 0);
    if (!screen) throw this.terminalNotRunning(terminal);
    // Watching starts before the message goes, so a quick turn can't end unseen.
    const waiting = operation.wait
      ? this.watchTerminal(workspace.id, terminal.id, {
          timeoutMs: operation.timeoutMs ?? TERMINAL_WAIT_DEFAULT_MS,
          startTimeoutMs: TERMINAL_SEND_START_MS,
          nextTurn: true,
          answering: described.state === 'blocked',
          signal: context.signal,
        })
      : undefined;
    await this.dependencies.submitToTerminal(terminal.id, text, screen.bracketedPaste);
    if (!waiting) return { sent: true, terminal: this.describeTerminal(terminal) };
    return { sent: true, ...this.waitResult(workspace.id, terminal, await waiting) };
  }

  /**
   * Has the user allow the message, then checks the terminal is still the one they were asked
   * about. Returns the terminal as it is then; throws unless it can take the message.
   */
  private async confirmTerminalSend(
    context: KomlaOperationContext,
    {
      workspaceId,
      terminal,
      described,
      sender,
      text,
      forced,
    }: {
      workspaceId: string;
      terminal: OperationTerminal;
      described: ReturnType<KomlaOperationService['describeTerminal']>;
      sender: string;
      text: string;
      forced: boolean;
    }
  ): Promise<ReturnType<KomlaOperationService['describeTerminal']>> {
    this.watchTerminalChanges();
    const targetEpoch = this.terminalEpoch(terminal.id);
    const senderEpoch = this.terminalEpoch(sender);
    const callerWorkspaceId = sender
      ? this.dependencies.findWorkspaceByTerminalId(sender)?.id
      : undefined;
    await this.requireTerminalSendApproval(context, {
      workspaceId,
      ...(sender ? { callerTerminalId: sender } : {}),
      ...(callerWorkspaceId ? { callerWorkspaceId } : {}),
      terminal: described,
      text,
      forced,
    });
    // The user took their time: what they allowed may not be what is there now.
    const current = this.dependencies
      .getWorkspace(workspaceId)
      ?.terminals?.find((candidate) => candidate.id === terminal.id);
    if (
      !current ||
      targetEpoch !== this.terminalEpoch(terminal.id) ||
      senderEpoch !== this.terminalEpoch(sender)
    ) {
      throw this.terminalChanged(terminal);
    }
    const now = this.describeSendTarget(current, forced);
    // A forced message was allowed as the answer to the question the user saw.
    if (forced && (now.state !== 'blocked' || now.message !== described.message)) {
      throw this.terminalChanged(terminal);
    }
    if (!forced) this.allowTerminalSender(terminal.id, sender);
    return now;
  }

  private allowTerminalSender(terminalId: string, sender: string): void {
    const senders = this.allowedTerminalSenders.get(terminalId) ?? new Set<string>();
    senders.add(sender);
    this.allowedTerminalSenders.set(terminalId, senders);
  }

  /** Starts forgetting allowed senders as terminals exit or start another program. */
  private watchTerminalChanges(): void {
    if (this.watchingTerminals) return;
    this.watchingTerminals = true;
    const changed = (terminalId: string): void => {
      this.terminalEpochs.set(terminalId, this.terminalEpoch(terminalId) + 1);
      this.allowedTerminalSenders.delete(terminalId);
      for (const allowed of this.allowedTerminalSenders.values()) allowed.delete(terminalId);
    };
    this.dependencies.onTerminalExit(changed);
    this.dependencies.onTerminalReset(changed);
  }

  /** How many times a terminal has exited or started another program since Komla watched. */
  private terminalEpoch(terminalId: string): number {
    return this.terminalEpochs.get(terminalId) ?? 0;
  }

  private terminalChanged(terminal: OperationTerminal): KomlaOperationError {
    return new KomlaOperationError(
      'TERMINAL_CHANGED',
      `${terminalLabel(terminal)} changed while the user decided, so nothing was typed. Read it with \`komla read ${terminal.id}\` and send again if it still fits.`,
      409
    );
  }

  /** The terminal as it is, unless `komla send` can't type into it now. */
  private describeSendTarget(
    terminal: OperationTerminal,
    forced: boolean
  ): ReturnType<KomlaOperationService['describeTerminal']> {
    const described = this.describeTerminal(terminal);
    if (described.state === 'exited') throw this.terminalNotRunning(terminal);
    if (described.state === 'blocked' && !forced) {
      throw new KomlaOperationError(
        'TERMINAL_BLOCKED',
        `${terminalLabel(terminal)} is waiting for the user${described.message ? `: ${described.message}` : ''}. Read it with \`komla read ${terminal.id}\` and ask the user; don't answer for them. --force sends anyway.`,
        409,
        { terminal: described }
      );
    }
    return described;
  }

  /** Waits for the user to allow the message; throws unless they do. */
  private async requireTerminalSendApproval(
    context: KomlaOperationContext,
    request: TerminalSendApprovalRequest
  ): Promise<void> {
    const prompt = new AbortController();
    const giveUp = (): void => prompt.abort();
    if (context.signal?.aborted) giveUp();
    context.signal?.addEventListener('abort', giveUp, { once: true });
    const timer = setTimeout(giveUp, TERMINAL_SEND_APPROVAL_MS);
    let decision: Awaited<ReturnType<KomlaOperationDependencies['approveTerminalSend']>>;
    try {
      decision = await this.dependencies.approveTerminalSend(request, prompt.signal);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', giveUp);
      // Ends the prompt if the dependency left it open.
      prompt.abort();
    }
    if (decision === 'apply') return;
    const label = terminalLabel(request.terminal);
    throw decision === 'cancel'
      ? new KomlaOperationError(
          'TERMINAL_SEND_DECLINED',
          `The user declined to let this message into ${label}. Ask them before sending it again.`,
          403
        )
      : new KomlaOperationError(
          'TERMINAL_SEND_UNAPPROVED',
          `The user didn't answer Komla's request to allow this message into ${label}, or no Komla window could show it. Nothing was typed.`,
          403
        );
  }

  private async waitForTerminal(
    context: KomlaOperationContext,
    operation: Extract<KomlaOperation, { type: 'terminal.wait' }>
  ): Promise<KomlaOperationResults['terminal.wait']> {
    const { workspace, terminal } = this.resolveTerminal(context, operation.terminal);
    if (terminal.id === callerTerminal(context)) {
      throw new KomlaOperationError(
        'TERMINAL_IS_CALLER',
        'That is the terminal this command runs in, which can’t end its turn while it waits.',
        400
      );
    }
    // A new terminal's agent may not have started its first turn yet.
    const starting =
      operation.output === undefined &&
      terminal.attention === undefined &&
      terminal.createdAt !== undefined &&
      Date.now() - terminal.createdAt < TERMINAL_STARTUP_MS;
    const result = await this.watchTerminal(workspace.id, terminal.id, {
      timeoutMs: operation.timeoutMs ?? TERMINAL_WAIT_DEFAULT_MS,
      ...(operation.output !== undefined ? { output: operation.output } : {}),
      ...(starting ? { startTimeoutMs: TERMINAL_STARTUP_MS } : {}),
      signal: context.signal,
    });
    return this.waitResult(workspace.id, terminal, result);
  }

  /**
   * Why the wait returned, with the done's, error's or question's text, which the terminal may no
   * longer show once the user saw it.
   */
  private waitResult(
    workspaceId: string,
    terminal: OperationTerminal,
    { reason, attention }: TerminalWaitResult
  ): {
    reason: TerminalWaitReason;
    message?: string;
    terminal: ReturnType<KomlaOperationService['describeTerminal']>;
  } {
    const current =
      this.dependencies
        .getWorkspace(workspaceId)
        ?.terminals?.find((candidate) => candidate.id === terminal.id) ?? terminal;
    const message = attentionText(attention);
    return {
      reason,
      ...(message ? { message } : {}),
      terminal: this.describeTerminal(current),
    };
  }

  private watchTerminal(
    workspaceId: string,
    terminalId: string,
    options: TerminalWaitOptions
  ): Promise<TerminalWaitResult> {
    return waitForTerminal(
      {
        snapshot: () => this.terminalSnapshot(workspaceId, terminalId),
        onChange: (listener) =>
          this.dependencies.onWorkspaceUpdated((id) => {
            if (id === workspaceId) listener();
          }),
        onAttention: (listener) =>
          this.dependencies.onAttentionRaised((attention) => {
            if (attention.terminalId === terminalId) listener(attention);
          }),
        onPromptSubmitted: (listener) =>
          this.dependencies.onPromptSubmitted((id) => {
            if (id === terminalId) listener();
          }),
        onOutput: (listener) =>
          this.dependencies.onTerminalOutput((id, data) => {
            if (id === terminalId) listener(data);
          }),
        onExit: (listener) =>
          this.dependencies.onTerminalExit((id) => {
            if (id === terminalId) listener();
          }),
      },
      options
    );
  }

  private terminalSnapshot(workspaceId: string, terminalId: string): TerminalWaitSnapshot {
    const terminal = this.dependencies
      .getWorkspace(workspaceId)
      ?.terminals?.find((candidate) => candidate.id === terminalId);
    return this.snapshotOf(terminal);
  }

  private snapshotOf(terminal: OperationTerminal | undefined): TerminalWaitSnapshot {
    return {
      running: terminal !== undefined && this.isTerminalRunning(terminal),
      working: terminal?.agentActive === true,
      ...(terminal?.attention ? { attention: terminal.attention } : {}),
    };
  }

  /** A tab `launch --here` just opened may not have its program yet, which isn't an exit. */
  private isTerminalRunning(terminal: OperationTerminal): boolean {
    if (this.dependencies.isTerminalRunning(terminal.id)) return true;
    return (
      terminal.status !== 'stopped' &&
      terminal.createdAt !== undefined &&
      Date.now() - terminal.createdAt < TERMINAL_STARTUP_MS
    );
  }

  private describeTerminal(terminal: OperationTerminal): {
    id: string;
    name?: string;
    state: ReturnType<typeof terminalAgentState>;
    message?: string;
  } {
    const state = terminalAgentState(this.snapshotOf(terminal));
    const attention = terminal.attention;
    const message =
      state === 'blocked' || state === 'done' || state === 'error'
        ? attentionText(attention)
        : undefined;
    return {
      id: terminal.id,
      ...(terminal.name ? { name: terminal.name } : {}),
      state,
      ...(message ? { message } : {}),
    };
  }

  /** The terminal `selector` names in the calling workspace: its id, or its tab's name. */
  private resolveTerminal(
    context: KomlaOperationContext,
    selector: string
  ): { workspace: KomlaOperationWorkspace; terminal: OperationTerminal } {
    const workspace = this.requireWorkspace(context);
    const terminals = workspace.terminals ?? [];
    const byId = terminals.find((terminal) => terminal.id === selector);
    if (byId) return { workspace, terminal: byId };
    const wanted = selector.trim().toLowerCase();
    const named = terminals.filter((terminal) => terminal.name?.trim().toLowerCase() === wanted);
    if (named.length === 1) return { workspace, terminal: named[0] };
    if (named.length > 1) {
      throw new KomlaOperationError(
        'TERMINAL_AMBIGUOUS',
        `Several terminals here are named ${selector}; name one by its id, as \`komla terminals\` lists them.`,
        409
      );
    }
    throw new KomlaOperationError(
      'TERMINAL_NOT_FOUND',
      `This workspace has no terminal ${selector}; \`komla terminals\` lists them.`,
      404
    );
  }

  private terminalNotRunning(terminal: OperationTerminal): KomlaOperationError {
    return new KomlaOperationError(
      'TERMINAL_NOT_RUNNING',
      `${terminalLabel(terminal)} has no program running on this computer, yet or any more.`,
      409
    );
  }

  private requireWorkspace(context: KomlaOperationContext): KomlaOperationWorkspace {
    const workspace = this.resolveWorkspace(context);
    if (!workspace) {
      const fallback = context.cwd
        ? this.dependencies.resolveWorkspaceByCwd(context.cwd, context.sshHostId)
        : undefined;
      if (context.targeted) {
        throw new KomlaOperationError(
          'WORKSPACE_NOT_FOUND',
          `No workspace has the id ${context.workspaceId}; \`komla workspace list --json\` lists them.`,
          404
        );
      }
      throw new KomlaOperationError(
        'WORKSPACE_NOT_FOUND',
        fallback?.error ??
          (context.cwd
            ? `No matching workspace found for cwd: ${context.cwd}`
            : 'The current Komla workspace could not be resolved.'),
        404
      );
    }
    return workspace;
  }

  private requireCapability(capability: AgentCapabilityId | undefined): void {
    if (!capability || isAgentCapabilityEnabled(capability, this.dependencies.getConfig())) return;
    throw new KomlaOperationError(
      'CAPABILITY_DISABLED',
      turnedOffCapabilityMessage(capability),
      403,
      { capability }
    );
  }

  private isLaunchablePreset(preset: AgentPreset): boolean {
    return Boolean(preset.openCommand.trim() || preset.promptCommand.trim());
  }

  private workspaceEnvironment(workspace: KomlaOperationWorkspace): DesiredWorkspaceEnvironment {
    if (workspace.backend?.kind === 'ssh') {
      return { kind: 'ssh', hostId: workspace.backend.hostId };
    }
    return { kind: 'local' };
  }
}
