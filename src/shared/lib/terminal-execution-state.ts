import { isSshWorkspace, type Workspace } from '../types/workspace';

import type { Terminal, TerminalStatus } from '../types/terminal';

/**
 * Terminal Execution State: what this device knows about a Terminal's current execution.
 *
 * This is the only module that reads a Terminal's `remoteSession*` fields. Callers ask the
 * questions below, and main's writers set the fields through `encodeTerminalExecution`.
 */

type ExecutionTerminal = Pick<
  Terminal,
  | 'status'
  | 'executionLocation'
  | 'remoteSessionActive'
  | 'remoteSessionResumable'
  | 'remoteSessionOnHost'
  | 'agentActive'
  | 'commandActive'
>;

type ExecutionWorkspace = Pick<Workspace, 'backend'> & {
  terminals: readonly ExecutionTerminal[];
  provisioning?: boolean;
  agentActive?: boolean;
  showsPaneSurfaces?: boolean;
};

/** Callers ask the questions below; only tests and diagnostics should name a state. */
export type TerminalExecutionState =
  /** No Managed Remote Terminal Session (a local workspace's or a Local copy's Terminal). */
  | 'unmanaged-running'
  | 'unmanaged-stopped'
  /** A Terminal Attachment here is starting. */
  | 'starting'
  | 'attached'
  /** Not attached here; its session was last known present, e.g. before a restart. */
  | 'detached'
  /** Not attached here; this device saw its session end or stopped it, or a sync found it gone. */
  | 'ended-here'
  /** Ended here, but a sync since found its session on the host, e.g. restarted elsewhere. */
  | 'restarted-elsewhere'
  /** Never seen here; a sync found its session on the host, e.g. another device runs it. */
  | 'found-on-host'
  /** Never checked here, e.g. synced from another device or restored. */
  | 'unchecked'
  /** A sync found no session on the host. That reading can come before the session starts. */
  | 'missing';

interface StateFacts {
  /** Starting or attached here. */
  live: boolean;
  /** Counts as running on this device: running-workspace limits and Restart. */
  runningHere: boolean;
  /** A sync found its session on the host while this device isn't attached. */
  onHost: boolean;
  /** This device saw its session end or stopped it, or a sync found it gone. */
  endedHere: boolean;
}

const FACTS: Record<TerminalExecutionState, StateFacts> = {
  'unmanaged-running': { live: true, runningHere: true, onHost: false, endedHere: false },
  'unmanaged-stopped': { live: false, runningHere: false, onHost: false, endedHere: false },
  starting: { live: true, runningHere: true, onHost: false, endedHere: false },
  attached: { live: true, runningHere: true, onHost: false, endedHere: false },
  detached: { live: false, runningHere: true, onHost: false, endedHere: false },
  'ended-here': { live: false, runningHere: false, onHost: false, endedHere: true },
  'restarted-elsewhere': { live: false, runningHere: false, onHost: true, endedHere: true },
  'found-on-host': { live: false, runningHere: false, onHost: true, endedHere: false },
  unchecked: { live: false, runningHere: false, onHost: false, endedHere: false },
  missing: { live: false, runningHere: false, onHost: false, endedHere: false },
};

type ExecutionBackend = Pick<Workspace, 'backend'>;

function hasManagedSession(workspace: ExecutionBackend, terminal: ExecutionTerminal): boolean {
  return isSshWorkspace(workspace) && terminal.executionLocation !== 'local-mirror';
}

export function classifyTerminalExecution(
  workspace: ExecutionBackend,
  terminal: ExecutionTerminal
): TerminalExecutionState {
  if (!hasManagedSession(workspace, terminal)) {
    return terminal.status === 'stopped' ? 'unmanaged-stopped' : 'unmanaged-running';
  }
  // While attached, what this device last saw of the session no longer applies.
  if (terminal.status === 'starting') return 'starting';
  if (terminal.status === 'running') return 'attached';
  if (terminal.remoteSessionActive === true) return 'detached';
  if (terminal.remoteSessionOnHost === true) {
    return terminal.remoteSessionActive === false ? 'restarted-elsewhere' : 'found-on-host';
  }
  if (terminal.remoteSessionActive === false) return 'ended-here';
  return terminal.remoteSessionOnHost === false ? 'missing' : 'unchecked';
}

function factsOf(workspace: ExecutionBackend, terminal: ExecutionTerminal): StateFacts {
  return FACTS[classifyTerminalExecution(workspace, terminal)];
}

/**
 * Its Managed Remote Terminal Session lives in tmux, so it outlives the Terminal Attachment:
 * it is saved with its workspace and written to the SSH host's sync manifest.
 */
export function isResumable(workspace: ExecutionWorkspace, terminal: ExecutionTerminal): boolean {
  return hasManagedSession(workspace, terminal) && terminal.remoteSessionResumable === true;
}

function shownRunning(workspace: ExecutionWorkspace, terminal: ExecutionTerminal): boolean {
  const facts = factsOf(workspace, terminal);
  return facts.runningHere || facts.onHost;
}

// --- Workspace questions ---

/**
 * Running on this device: running-workspace limits and Restart. A browser or note pane keeps
 * a workspace running without a terminal.
 */
export function isRunningHere(workspace: ExecutionWorkspace | null | undefined): boolean {
  if (!workspace) return false;
  return (
    workspace.showsPaneSurfaces === true ||
    workspace.terminals.some((terminal) => factsOf(workspace, terminal).runningHere)
  );
}

/**
 * Runs on its SSH host from this device, which the free plan limits. A Local copy or a
 * browser or note pane runs on this computer, so it doesn't count.
 */
export function isRunningOnSshHost(workspace: ExecutionWorkspace): boolean {
  return workspace.terminals.some(
    (terminal) => hasManagedSession(workspace, terminal) && factsOf(workspace, terminal).runningHere
  );
}

/** Holds one of the free plan's SSH workspace slots: running on its host, or being created. */
export function takesFreeSshSlot(workspace: ExecutionWorkspace): boolean {
  return (
    isSshWorkspace(workspace) && (workspace.provisioning === true || isRunningOnSshHost(workspace))
  );
}

/** Shown as running: also while a sync finds a session on the host, e.g. from another device. */
export function showsRunning(workspace: ExecutionWorkspace | null | undefined): boolean {
  if (!workspace) return false;
  return (
    workspace.showsPaneSurfaces === true ||
    workspace.terminals.some((terminal) => shownRunning(workspace, terminal))
  );
}

/** How many of its terminals show as running, each one a tmux session for an SSH workspace. */
export function runningTerminalCount(workspace: ExecutionWorkspace): number {
  return workspace.terminals.filter((terminal) => shownRunning(workspace, terminal)).length;
}

/** The terminal shows as running: also while a sync finds its session on the host. */
export function showsTerminalRunning(
  workspace: ExecutionWorkspace,
  terminal: ExecutionTerminal
): boolean {
  return shownRunning(workspace, terminal);
}

/** Offers Stop whenever it shows as running: stopping ends its sessions on the host, too. */
export function canStop(workspace: ExecutionWorkspace | null | undefined): boolean {
  return showsRunning(workspace);
}

/** Shows the agent working spinner, also for an agent another device runs on the host. */
export function showsWorking(workspace: ExecutionWorkspace | null | undefined): boolean {
  return !!workspace?.agentActive && showsRunning(workspace);
}

/**
 * How many of its agents work on this computer, which its sleeping would pause: one per working
 * terminal of a local workspace or an SSH workspace's Local copy, or else the local workspace's
 * own spinner, such as one turned on by hand. Agents in tmux on an SSH host work on regardless.
 */
export function agentsWorkingHere(workspace: ExecutionWorkspace): number {
  if (!showsWorking(workspace)) return 0;
  const working = workspace.terminals.filter(
    (terminal) => terminal.agentActive && shownRunning(workspace, terminal)
  );
  if (working.length === 0) return isSshWorkspace(workspace) ? 0 : 1;
  return working.filter((terminal) => !hasManagedSession(workspace, terminal)).length;
}

/** How many of the terminals agentsWorkingHere counts run only `komla notify --` commands. */
export function commandsWorkingHere(workspace: ExecutionWorkspace): number {
  if (!showsWorking(workspace)) return 0;
  return workspace.terminals.filter(
    (terminal) =>
      terminal.commandActive &&
      shownRunning(workspace, terminal) &&
      !hasManagedSession(workspace, terminal)
  ).length;
}

/**
 * Whether "Hide stopped" hides the workspace. A tab whose tmux session was never checked here
 * or by a sync, such as one another device opened, may still be running its agent.
 */
export function isHiddenByHideStopped(workspace: ExecutionWorkspace): boolean {
  if (workspace.provisioning || showsRunning(workspace)) return false;
  return !workspace.terminals.some(
    (terminal) =>
      classifyTerminalExecution(workspace, terminal) === 'unchecked' &&
      isResumable(workspace, terminal)
  );
}

/** A Monitored SSH Workspace: its status is kept current while it isn't on screen. */
export function isMonitored(workspace: ExecutionWorkspace): boolean {
  return workspace.terminals.some(
    (terminal) => hasManagedSession(workspace, terminal) && shownRunning(workspace, terminal)
  );
}

function reconnectsOnSelect(workspace: ExecutionWorkspace, terminal: ExecutionTerminal): boolean {
  if (!hasManagedSession(workspace, terminal)) return false;
  const facts = factsOf(workspace, terminal);
  if (facts.live) return false;
  return (
    facts.runningHere || facts.onHost || (!facts.endedHere && isResumable(workspace, terminal))
  );
}

/** The Terminals that selecting the workspace reattaches to their sessions. */
export function reconnectableTerminals<T extends ExecutionTerminal>(
  workspace: ExecutionWorkspace & { terminals: readonly T[] }
): T[] {
  const terminals: readonly T[] = workspace.terminals;
  return terminals.filter((terminal) => reconnectsOnSelect(workspace, terminal));
}

/** Selecting the workspace reconnects some of its Terminals, checking its SSH host first. */
export function probesOnSelect(workspace: ExecutionWorkspace): boolean {
  return workspace.terminals.some((terminal) => reconnectsOnSelect(workspace, terminal));
}

// --- Terminal questions ---

export interface PaneOffer {
  /** Its session lives in tmux: OSC 52 copy and the "Refresh SSH Session" menu item. */
  readonly managedSession: boolean;
  /** Offers the `tmux attach` command. */
  readonly attachCommand: boolean;
  /** Shows "Connecting…" whatever the renderer is doing. */
  readonly connecting: boolean;
  /** What the pane offers while stopped; null when it has no remote session to recover. */
  readonly stopped: 'reconnect' | 'restart' | null;
}

function offer(
  managedSession: boolean,
  attachCommand: boolean,
  connecting: boolean,
  stopped: PaneOffer['stopped']
): PaneOffer {
  return Object.freeze({ managedSession, attachCommand, connecting, stopped });
}

const PANE_OFFERS = {
  none: offer(false, false, false, null),
  connecting: offer(false, false, true, null),
  connectingResumable: offer(true, true, true, null),
  attachedResumable: offer(true, true, false, null),
  reconnect: offer(true, true, false, 'reconnect'),
  restart: offer(false, false, false, 'restart'),
  restartResumable: offer(true, false, false, 'restart'),
} as const;

/**
 * What a Terminal's pane offers. A stopped pane offers Reconnect exactly when selecting its
 * workspace would reconnect it. Each answer is a shared frozen object.
 */
export function paneOffer(
  workspace: ExecutionWorkspace | null | undefined,
  terminal: ExecutionTerminal | null | undefined
): PaneOffer {
  if (!workspace || !terminal || !hasManagedSession(workspace, terminal)) return PANE_OFFERS.none;
  const state = classifyTerminalExecution(workspace, terminal);
  const resumable = isResumable(workspace, terminal);
  if (state === 'starting') {
    return resumable ? PANE_OFFERS.connectingResumable : PANE_OFFERS.connecting;
  }
  if (state === 'attached') return resumable ? PANE_OFFERS.attachedResumable : PANE_OFFERS.none;
  // Retrying or opening a shell would end a session another device may have restarted.
  if (reconnectsOnSelect(workspace, terminal)) return PANE_OFFERS.reconnect;
  return resumable ? PANE_OFFERS.restartResumable : PANE_OFFERS.restart;
}

/**
 * Restarting Komla ends it here: it runs here and isn't resumable, so it isn't saved. That
 * includes an SSH Terminal whose host hasn't been checked for tmux yet.
 */
export function diesOnAppRestart(
  workspace: ExecutionWorkspace,
  terminal: ExecutionTerminal
): boolean {
  return factsOf(workspace, terminal).live && !isResumable(workspace, terminal);
}

/** This device saw its session end or stopped it, or a sync found it gone. */
export function sessionEndedHere(
  workspace: ExecutionWorkspace,
  terminal: ExecutionTerminal
): boolean {
  return factsOf(workspace, terminal).endedHere;
}

/** A sync found its session on the host while this device isn't attached, e.g. elsewhere. */
export function foundOnHost(workspace: ExecutionBackend, terminal: ExecutionTerminal): boolean {
  return factsOf(workspace, terminal).onHost;
}

/** A sync's host check looks for its session on the host. */
export function needsHostCheck(
  workspace: ExecutionWorkspace,
  terminal: ExecutionTerminal
): boolean {
  return hasManagedSession(workspace, terminal) && !factsOf(workspace, terminal).live;
}

/**
 * A host check that finds no session means it ended, e.g. another device stopped it: it was
 * last seen running, here or by a sync. One never seen running may just not have started yet.
 */
export function endsIfGoneFromHost(
  workspace: ExecutionWorkspace,
  terminal: ExecutionTerminal
): boolean {
  const facts = factsOf(workspace, terminal);
  return (
    hasManagedSession(workspace, terminal) && !facts.live && (facts.runningHere || facts.onHost)
  );
}

/** Changes whenever this device's own view of the session, or what a host check saw, changes. */
export function hostCheckStamp(terminal: ExecutionTerminal): string {
  return `${String(terminal.remoteSessionActive)}|${String(terminal.remoteSessionOnHost)}`;
}

// --- Writing (main only) ---

export type TerminalExecutionFields = Partial<
  Pick<
    Terminal,
    'status' | 'remoteSessionActive' | 'remoteSessionResumable' | 'remoteSessionOnHost'
  >
>;

export type TerminalExecutionChange =
  /** The lifecycle registry committed its state. Only the registry passes this. */
  | {
      kind: 'managed';
      attachment: 'absent' | 'starting' | 'attached';
      remoteSession: {
        kind: 'present' | 'absent' | 'unknown';
        lastObserved?: 'present' | 'absent';
      };
      persistence: 'supported' | 'unsupported' | 'unknown';
      /** Only its generation moved on, so what the last host check saw still holds. */
      keepHostCheck?: boolean;
    }
  /** Loaded from workspaces.json or adopted from another device. */
  | { kind: 'restored'; persistedActive: unknown }
  /** A sync checked the host for its session; undefined forgets an earlier check. */
  | { kind: 'host-checked'; onHost: boolean | undefined }
  | { kind: 'moved-to-local-copy' };

/** The fields to assign for a change. Assign all of them: undefined values clear a field. */
export function encodeTerminalExecution(change: TerminalExecutionChange): TerminalExecutionFields {
  switch (change.kind) {
    case 'managed': {
      const status: TerminalStatus =
        change.attachment === 'attached'
          ? 'running'
          : change.attachment === 'starting'
            ? 'starting'
            : 'stopped';
      const session = change.remoteSession;
      return {
        status,
        remoteSessionActive:
          session.kind === 'present'
            ? true
            : session.kind === 'absent'
              ? false
              : session.lastObserved === 'present'
                ? true
                : undefined,
        // What this device tracks itself is newer than what the last sync saw on the host.
        ...(change.keepHostCheck ? {} : { remoteSessionOnHost: undefined }),
        remoteSessionResumable:
          change.persistence === 'supported'
            ? true
            : change.persistence === 'unsupported'
              ? false
              : undefined,
      };
    }
    case 'restored':
      return {
        remoteSessionResumable: true,
        remoteSessionActive:
          typeof change.persistedActive === 'boolean' ? change.persistedActive : undefined,
      };
    case 'host-checked':
      return { remoteSessionOnHost: change.onHost };
    case 'moved-to-local-copy':
      return { remoteSessionResumable: undefined };
  }
}

/** What workspaces.json keeps: a session running at save time is presumed present on restart. */
export function persistedRemoteSessionActive(terminal: ExecutionTerminal): boolean | undefined {
  return terminal.status === 'running' || terminal.status === 'starting'
    ? true
    : terminal.remoteSessionActive;
}

/** How the lifecycle registry reads a Terminal it hasn't tracked yet. */
export function decodeManagedExecution(
  terminal: ExecutionTerminal
): Omit<Extract<TerminalExecutionChange, { kind: 'managed' }>, 'kind'> {
  return {
    attachment:
      terminal.status === 'running'
        ? 'attached'
        : terminal.status === 'starting'
          ? 'starting'
          : 'absent',
    remoteSession: {
      kind:
        terminal.remoteSessionActive === true
          ? 'present'
          : terminal.remoteSessionActive === false
            ? 'absent'
            : 'unknown',
    },
    persistence:
      terminal.remoteSessionResumable === true
        ? 'supported'
        : terminal.remoteSessionResumable === false
          ? 'unsupported'
          : 'unknown',
  };
}
