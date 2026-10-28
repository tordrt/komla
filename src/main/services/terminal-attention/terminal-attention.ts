import {
  attentionOutranks,
  COMMAND_ATTENTION_SOURCE,
  isSshWorkspace,
  isWorkspaceAttentionActionable,
  isWorkspaceSnoozed,
  needsAttention,
  pickWorkspaceAttention,
} from '../../../shared/types';
import { isWorkingTitle } from '../../lib/escape-interrupt';
import { createLogger } from '../../lib/logger';
import { publishRemoteWorkspaceChange } from '../remote-workspace-events';

import { isLongRunningCommand } from './background-command';
import { CodexTitleStatus } from './codex-title-status';
import {
  BACKGROUND_HOLD_LIMIT_MS,
  hookIdentity,
  isFailedTurn,
  isSubagentLifecycle,
  NotificationLifecycle,
  waitsForBackgroundWork,
} from './notification-lifecycle';

import type { TerminalProgramStatus } from '../../../shared/lib/terminal-escape';
import type {
  Terminal,
  Workspace,
  WorkspaceAttention,
  WorkspaceAttentionEvent,
  WorkspaceAttentionKind,
  WorkspaceAttentionSource,
} from '../../../shared/types';
import type { TerminalNotificationEvent } from '../../lib/terminal-notification-events';

const logger = createLogger('TerminalAttention');

const OSC_NOTIFICATION_FALLBACK_DELAY_MS = 2000;
const RECENT_STRUCTURED_NOTIFICATION_SUPPRESSION_MS = 5000;
// How long another installation's agent shows as working here without a hook from it. A missed
// interrupt would otherwise keep its spinner on until the agent's next turn ends.
const COPIED_AGENT_ACTIVITY_TIMEOUT_MS = 30 * 60_000;
// How long tool activity after an interrupt counts as late news from the interrupted turn.
export const LATE_ACTIVITY_AFTER_INTERRUPT_MS = 15_000;
// The same after a keypress that may not have interrupted anything, such as an Esc that closed
// a menu: just long enough for a hook sent before it to arrive through an SSH host's mailbox.
export const LATE_ACTIVITY_AFTER_UNCONFIRMED_INTERRUPT_MS = 5000;
// How soon after Codex first reports its state the work it starts with follows: within 150 ms.
export const CODEX_STARTUP_MS = 1000;
// How soon after an Esc or Ctrl-C an idle from Codex counts as the interrupt it reports at once.
export const CODEX_INTERRUPT_IDLE_MS = 2000;
// How long a program whose hooks reach Komla may report done before its Stop arrives, which may
// hold the turn for background work. Claude Code's Stop arrives within about 200 ms.
export const STOP_HOOK_WAIT_MS = 1500;
// How long a program waiting on the user may stay silent after a key that answers or cancels its
// prompt before its waiting counts as stale, as when it died where Komla can't see it exit. An
// answer makes it report within milliseconds.
export const ANSWER_REPORT_WAIT_MS = 2000;
// The legacy fallback scope for hooks that don't name a Terminal.
const WORKSPACE_AGENT_SCOPE = '__workspace__';
// The source of the spinner the user turns on by hand, in the workspace scope.
const MANUAL_SPINNER_SOURCE = 'manual';
// The synthetic prompts Claude resumes a turn with after background work.
const CLAUDE_RESUME_PROMPT = /^<(?:task-notification|agent-message)[\s>]/;

/** What an agent hook reports, as the notify endpoint received it. */
export type AgentHookKind = WorkspaceAttentionKind | 'prompt-submit' | 'activity' | 'interrupted';

// Hooks that show an agent's turn running or just ending. Idle is a reminder sent after the
// turn, a generic notification says nothing about one, and an interrupt also reports Claude
// quitting, as it does when its workspace stops.
const TURN_ACTIVITY_KINDS: ReadonlySet<AgentHookKind> = new Set([
  'prompt-submit',
  'activity',
  'turn-complete',
  'input-required',
  'error',
]);

/** A turn a program reports working in its Terminal. */
interface ProgramTurn {
  /** The Codex session whose prompt started it, so that its hooks find it. */
  session?: string;
  /** The turn id its prompt carried, so that a late Stop of the turn before doesn't match it. */
  turnId?: string;
  /** Codex's own work as it starts, which shows nothing unless a prompt makes it a turn. */
  startup?: boolean;
  /** It started a server, which keeps Codex working until the server is stopped. */
  startedServer?: boolean;
  /** The reply its Stop carried, for the done the program reports after it. */
  reply?: string;
  /** The command its approval hook asked about, for a blocked that names none. */
  approval?: string;
  /** Its Stop arrived. */
  stopped?: boolean;
  /** Its Stop listed background work that resumes the turn, so its done waits for that work. */
  waitsForBackgroundWork?: boolean;
  /** The error its StopFailure reported, for the idle that ends it. */
  failure?: string;
}

/**
 * The state a program last reported in a Terminal (OSC 7501), and the turn it is in. The program
 * names itself as its agent's hook source does: claude-code, codex, antigravity.
 */
interface ProgramStatus {
  source: string;
  state: string;
  turn?: ProgramTurn;
  /** When Codex first reported its state, until it reports working. */
  startedAt?: number;
  /** When the user last pressed a key that may have interrupted it. */
  interruptedAt?: number;
  /** A server keeps Codex working, so its sessions' hooks end their turns. */
  serving?: boolean;
  /** It reported a done, so its idle no longer ends a turn as one, as Codex before 0.164 does. */
  reportsDone?: boolean;
  /** Its own hooks reach Komla, so a turn it reports done waits for the Stop they send. */
  hooked?: boolean;
  /** A done waiting for its Stop, or for the background work that Stop named. */
  heldDone?: { timer: ReturnType<typeof setTimeout>; message?: string };
  /** A turn it ended idle without its hooks saying how yet; a Stop soon after makes it a done. */
  endedIdle?: ReturnType<typeof setTimeout>;
  /** The user pressed a key that answers its prompt; it reports again before this fires. */
  answerCheck?: ReturnType<typeof setTimeout>;
  /**
   * Its own hooks last came copied from the device attached to the Terminal, which records replies.
   * Unset until one comes, so no device can tell whether its summary is the device's to record.
   */
  copiedHooks?: boolean;
  /**
   * Its last turn ended done: the summary it reports for that turn, at the done or a moment later
   * as Claude does, is the turn's reply, over the one its hooks send.
   */
  summary?: 'awaited' | 'recorded';
}

/** A parsed agent hook. Routing and delivery fields stay with the notify endpoint. */
export interface AgentHook {
  cwd?: string;
  kind?: AgentHookKind;
  source?: string;
  title?: string;
  body?: string;
  color?: string;
  badge?: string;
  icon?: string;
  iconColor?: string;
  message?: string;
  level?: string;
  /** A copy of a hook for a Terminal another Komla installation is attached to. */
  copy?: boolean;
  hookInput?: {
    session_id?: string;
    turn_id?: string;
    prompt_id?: string;
    agent_id?: string;
    hook_event_name?: string;
    [key: string]: unknown;
  };
}

/** A Claude Code tool call waiting on the user's answer, as its PermissionRequest named it. */
interface ClaudePermission {
  session?: string;
  agentId?: string;
  tool: string;
  input: Record<string, unknown>;
}

// Prompts a Terminal's Claude and its subagents show at once; older unanswered ones are dropped.
const MAX_CLAUDE_PERMISSIONS = 8;

/**
 * The tool call a Claude PermissionRequest asks about. A hook too large to forward whole names
 * none, as it loses the tool's input.
 */
function claudePermission(hook: AgentHook): ClaudePermission | undefined {
  const { tool_name: tool, tool_input: input } = hook.hookInput ?? {};
  if (typeof tool !== 'string' || typeof input !== 'object' || input === null) return undefined;
  return {
    session: hook.hookInput?.session_id,
    agentId: hook.hookInput?.agent_id,
    tool,
    input: input as Record<string, unknown>,
  };
}

/**
 * Whether a PostToolUse(Failure) ends the call a permission prompt asked about. The input it
 * names may have grown, as an answered AskUserQuestion's adds the answers.
 */
function endsClaudeToolCall(hook: AgentHook, permission: ClaudePermission): boolean {
  const input = hook.hookInput?.tool_input;
  if (
    hook.hookInput?.session_id !== permission.session ||
    hook.hookInput?.agent_id !== permission.agentId ||
    hook.hookInput?.tool_name !== permission.tool ||
    typeof input !== 'object' ||
    input === null
  ) {
    return false;
  }
  const ended = input as Record<string, unknown>;
  return Object.entries(permission.input).every(
    ([key, value]) => JSON.stringify(ended[key]) === JSON.stringify(value)
  );
}

/** Where the notify endpoint matched a hook. */
export interface HookTarget {
  workspace?: Workspace;
  terminalId?: string;
  /** The hook named a Terminal that no longer exists: it must not stop any current spinner. */
  hasInvalidTerminalId: boolean;
}

/**
 * taken: Komla took the hook, which may change nothing shown; make its delivery durable.
 * ignored: a filtered hook or a relayed interrupt; there is nothing to make durable.
 * unmatched: no workspace or Terminal for it, when it arrived or after it settled.
 */
export type HookOutcome = 'taken' | 'ignored' | 'unmatched';

declare const hookMarkBrand: unique symbol;
/** Taken before reading an SSH host, to ask afterwards whether a hook arrived meanwhile. */
export type HookMark = { readonly [hookMarkBrand]: true };

/** The workspaces whose Terminal Attention State this module keeps. */
export interface TerminalAttentionStore {
  workspaces(): Iterable<Workspace>;
  get(workspaceId: string): Workspace | undefined;
  /** Tells windows (WORKSPACE_UPDATED) and remote control that the workspace changed. */
  broadcast(workspace: Workspace): void;
  /** Saves workspaces, batched. */
  save(): void;
  /** Saves now: a held turn completed without a hook delivery to make durable. */
  saveNow(workspaceId: string): Promise<void>;
}

export interface TerminalAttentionWindows {
  /** A Terminal raised attention; windows decide whether to show it and play a sound. */
  attentionRaised(event: WorkspaceAttentionEvent): void;
  /** How many workspaces need attention, for the dock badge or taskbar. */
  badge(count: number): void;
}

export interface TerminalAttentionRelay {
  /**
   * Tells the other Komla installations showing a Terminal that its agent was interrupted here.
   * Best effort; it applies only to Terminals backed by a Managed Remote Terminal Session.
   */
  interrupted(workspace: Workspace, terminalId: string, sources: string[]): void;
}

export interface TerminalAttentionDependencies {
  store: TerminalAttentionStore;
  windows: TerminalAttentionWindows;
  relay: TerminalAttentionRelay;
  /** A user prompt reached an agent; Komla may name the workspace from it. */
  promptSubmitted(workspaceId: string, prompt: string, terminalId?: string): void;
  /** An agent ended its turn with this reply; it tells Komla what its last prompt was about. */
  agentReplied(workspaceId: string, reply: string, terminalId?: string): void;
  /**
   * An agent's turn ran or just ended in the workspace, here or on the device attached to its
   * Terminal, which counts as workspace activity.
   */
  turnActivity(workspaceId: string): void;
  /** Telemetry for the first routed notification of each kind and source. */
  milestone(name: string, properties: { notificationKind: string; source?: string }): void;
}

function toAttentionSource(value: string | undefined): WorkspaceAttentionSource {
  return value ?? 'generic';
}

/**
 * Terminal Attention State: whether each Terminal's agent is working, and the attention it raised
 * that the user hasn't resolved. It interprets agent hooks, terminal titles and alerts, and what
 * happens to a Terminal's execution, and writes the result onto the workspace's attention and
 * spinner fields.
 */
export class TerminalAttention {
  // workspace -> scope (terminal id, or the workspace scope for hooks without one) -> source -> count
  private readonly activeAgentSources = new Map<
    string,
    Map<string, Map<WorkspaceAttentionSource, number>>
  >();
  /** Spinners only copies of another installation's hooks keep on, which it can't see stop. */
  private readonly copiedAgentActivity = new Map<string, ReturnType<typeof setTimeout>>();
  /** Until when each Terminal's tool activity is late news; see isLateAgentActivity. */
  private readonly lateActivityUntil = new Map<string, number>();
  private readonly pendingOscNotifications = new Map<
    string,
    { timeout: ReturnType<typeof setTimeout>; event: TerminalNotificationEvent }
  >();
  private readonly recentStructuredNotificationByTerminal = new Map<string, number>();
  private readonly lifecycle = new NotificationLifecycle();
  private readonly codexTitleStatus: CodexTitleStatus;
  private readonly programStatuses = new Map<string, ProgramStatus>();
  /** The Terminal each Codex session prompted in, by session id. */
  private readonly codexSessions = new Map<string, string>();
  /** The prompts a Terminal's Claude showed through its PermissionRequest hook, until answered. */
  private readonly claudePermissions = new Map<string, ClaudePermission[]>();

  constructor(private readonly deps: TerminalAttentionDependencies) {
    this.codexTitleStatus = new CodexTitleStatus((terminalId, kind) =>
      this.inferCodexStatus(terminalId, kind)
    );
  }

  // ── Agent hooks ──────────────────────────────────────────────────────────

  /**
   * Takes an agent hook the notify endpoint matched. A completion may settle for up to 750 ms
   * before it shows, and an OpenCode permission request for 500 ms; a completion that waits for
   * background work may be held much longer. The promise resolves after every field the hook
   * changes has been written.
   */
  async hook(target: HookTarget, hook: AgentHook): Promise<HookOutcome> {
    // One arrives per source the attached installation had running, to replace that source's
    // undelivered activity in this installation's mailbox; the first one stops the whole tab.
    if (hook.copy && hook.kind === 'interrupted') {
      if (target.workspace && target.terminalId) {
        this.dropManualSource(target.workspace.id);
        this.clearTerminalSourcesOnly(target.workspace.id, target.terminalId);
        this.broadcastIfAgentActiveChanged(target.workspace);
      }
      return 'ignored';
    }
    if (target.terminalId && this.repeatsClaudePermission(hook, target.terminalId)) {
      return this.recordIgnoredHook(hook, target) ? 'ignored' : 'unmatched';
    }
    // A subagent's tool ends too, though its hooks are ignored otherwise.
    if (target.terminalId) this.settleClaudePermission(hook, target.terminalId);
    if (isIgnoredHook(hook)) return this.recordIgnoredHook(hook, target) ? 'ignored' : 'unmatched';
    if (!target.workspace) return 'unmatched';

    const liveScopes = new Set(
      Array.from(this.deps.store.workspaces()).flatMap((workspace) => [
        `workspace:${workspace.id}`,
        ...workspace.terminals.map((terminal) => `terminal:${terminal.id}`),
      ])
    );
    this.lifecycle.prune(liveScopes);
    // Another device attached after this one gets the hooks, and this one copies of them. A
    // Terminal reporting its status here is attached here, so its copies carry content only.
    const reportsHere =
      !hook.copy || (!!target.terminalId && this.programStatuses.has(target.terminalId));
    if (hook.source === 'codex' && reportsHere && this.reportsCodexStatus(target.workspace)) {
      return this.takeCodexHookContent(hook, target.workspace, target.terminalId);
    }
    const reportingTerminalId = reportsHere
      ? this.reportingTerminalFor(hook, target.workspace, target)
      : undefined;
    if (reportingTerminalId) {
      return this.takeProgramHookContent(hook, target.workspace, reportingTerminalId);
    }
    // A command's news for the whole workspace, as a background Quick Command's, is no Terminal's.
    const speaksForTerminals = !!target.terminalId || hook.source !== COMMAND_ATTENTION_SOURCE;
    if ((hook.hookInput?.hook_event_name || hook.kind === 'activity') && speaksForTerminals) {
      this.recordStructuredNotification(
        target.workspace,
        target.terminalId,
        target.hasInvalidTerminalId
      );
      if (target.terminalId) this.cancelPendingOscNotification(target.terminalId);
    }
    const scope = target.terminalId
      ? `terminal:${target.terminalId}`
      : `workspace:${target.workspace.id}`;
    // Late news must not cancel a completion that is still settling, so it never gets there.
    const lateActivity =
      hook.kind === 'activity' &&
      !!target.terminalId &&
      this.isLateAgentActivity(target.terminalId);
    if (lateActivity) {
      logger.debug('Ignoring tool activity reported after an interrupt', {
        terminalId: target.terminalId,
      });
      // A reply still answers its request: a single Esc doesn't interrupt OpenCode.
      this.lifecycle.recordReply(scope, hook);
    }
    // A command has no turn to settle or resume, and an agent in its terminal keeps its own.
    const decision =
      target.hasInvalidTerminalId || lateActivity
        ? hook.kind === 'activity'
          ? 'stale'
          : 'accept'
        : hook.source === COMMAND_ATTENTION_SOURCE
          ? 'accept'
          : await this.lifecycle.accept(
              scope,
              hook,
              () => {
                // A valid completion hook owns completion as soon as it starts
                // settling, before the title fallback can emit the same event.
                if (target.terminalId) {
                  this.codexTitleStatus.hook(target.terminalId, hook.source, hook.kind);
                }
              },
              () => this.completeHeldTurn(hook, target)
            );
    logger.debug('Notification lifecycle', {
      terminalId: target.terminalId,
      source: hook.source,
      kind: hook.kind,
      event: hook.hookInput?.hook_event_name,
      ...hookIdentity(hook),
      agentId: hook.hookInput?.agent_id,
      decision,
    });
    if (decision === 'closed') return 'unmatched';
    // Re-check after the grace period: a terminal may have closed meanwhile.
    if (
      decision === 'accept' &&
      target.terminalId &&
      !this.findWorkspaceByTerminalId(target.terminalId)
    ) {
      return 'unmatched';
    }
    if (decision === 'accept') {
      this.handleHook(hook, { ...target, workspace: target.workspace });
      if (target.terminalId) this.noteAgentHook(target.terminalId, !!hook.copy);
    }
    return 'taken';
  }

  /** The notify endpoint stopped: settling and held hooks close, and pending fallbacks drop. */
  hooksStopped(): void {
    this.lifecycle.clear();
    this.codexTitleStatus.clear();
    for (const pending of this.pendingOscNotifications.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingOscNotifications.clear();
    this.recentStructuredNotificationByTerminal.clear();
  }

  // ── Terminal output ──────────────────────────────────────────────────────

  /**
   * A Terminal's title changed. Codex's working title is a fallback for its missing hooks, and a
   * title spinning again shows the agent working, so its activity is current.
   */
  titleChanged(terminalId: string, title: string): void {
    this.codexTitleStatus.title(terminalId, title);
    if (isWorkingTitle(title)) this.lateActivityUntil.delete(terminalId);
  }

  /**
   * A program reported its state in the Terminal (OSC 7501): Codex 0.163 and later, Claude Code
   * 2.1.295, Antigravity 1.4, Pi and others. This comes from the Terminal's own program, so while
   * it reports, it alone keeps the Terminal's spinner and attention, and the hooks its agent runs
   * there only name the workspace and record replies. Codex's hooks run in a process its sessions
   * share, so they are matched to the Terminal by session; see takeCodexHookContent.
   */
  programStatusChanged(terminalId: string, status: TerminalProgramStatus): void {
    // A record of the program's own, such as a background subagent's, says nothing of the Terminal.
    if (status.id !== undefined) return;
    let current = this.programStatuses.get(terminalId);
    // Codex and Claude Code name no app as they quit.
    if (!status.app && !(status.state === 'clear' && current)) return;
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (!workspace) return;
    if (status.state === 'clear' || (current && current.source !== status.app)) {
      this.forgetProgramStatus(terminalId);
      this.clearTerminalSourcesOnly(workspace.id, terminalId);
      if (status.state === 'clear') return;
      current = undefined;
    }
    const source = status.app as string;
    if (!current) {
      current = { source, state: status.state, startedAt: Date.now() };
      this.programStatuses.set(terminalId, current);
    }
    clearTimeout(current.answerCheck);
    // The program works again once the user answered it, or it stopped waiting, as on a cancel.
    if (status.state === 'working' || (current.state === 'blocked' && status.state !== 'blocked')) {
      this.clearInputRequest(terminalId, source);
    }
    current.state = status.state;
    this.codexTitleStatus.close(terminalId);
    switch (status.state) {
      case 'working': {
        // Codex reports working as the user submits a prompt, before its hooks run, and a moment
        // as it starts, which its hook makes a turn when it started with a prompt.
        const startup =
          source === 'codex' &&
          current.startedAt !== undefined &&
          Date.now() - current.startedAt < CODEX_STARTUP_MS;
        current.startedAt = current.interruptedAt = current.summary = undefined;
        // The turn goes on, as when Claude resumes it for the background work its Stop named.
        this.releaseHeldDone(current);
        this.forgetEndedIdle(current);
        if (current.turn) {
          current.turn.stopped = current.turn.waitsForBackgroundWork = false;
          current.turn.reply = current.turn.failure = undefined;
        }
        current.turn ??= startup ? { startup } : {};
        if (!current.turn.startup) this.reportProgram(workspace, terminalId, { kind: 'activity' });
        return;
      }
      case 'blocked': {
        this.releaseHeldDone(current);
        current.turn ??= {};
        const message = status.msg ?? current.turn.approval;
        current.turn.approval = undefined;
        // A prompt still showing is asked once, though an SSH Terminal's host repeats it to Komla
        // after a reconnect.
        const attention = this.getTerminal(terminalId)?.attention;
        if (
          attention?.kind === 'input-required' &&
          attention.source === source &&
          attention.message === message
        ) {
          return;
        }
        this.reportProgram(workspace, terminalId, { kind: 'input-required', message });
        return;
      }
      case 'error':
        this.releaseHeldDone(current);
        current.turn = undefined;
        current.serving = false;
        this.clearTerminalSourcesOnly(workspace.id, terminalId);
        this.reportProgram(workspace, terminalId, { kind: 'error', message: status.msg });
        return;
      case 'done':
      case 'idle':
        this.programTurnEnded(workspace, terminalId, current, status);
    }
  }

  /**
   * The user pressed a key that answers or cancels a prompt (Enter, Ctrl-C, Ctrl-D, Esc). A
   * program still waiting reports what it does next at once; one that stays silent may have died
   * where Komla can't see it exit, so its input request goes.
   */
  answerKeyPressed(terminalId: string): void {
    const program = this.programStatuses.get(terminalId);
    if (program?.state !== 'blocked') return;
    clearTimeout(program.answerCheck);
    program.answerCheck = setTimeout(() => {
      if (this.programStatuses.get(terminalId) !== program) return;
      this.clearInputRequest(terminalId, program.source);
    }, ANSWER_REPORT_WAIT_MS);
  }

  /** The Terminal's attachment ended: its settling and held hooks close. */
  attachmentEnded(terminalId: string): void {
    this.forgetProgramStatus(terminalId);
    this.codexTitleStatus.close(terminalId);
    this.lifecycle.close(`terminal:${terminalId}`);
    this.lateActivityUntil.delete(terminalId);
  }

  /** A Terminal raised an OSC alert; it shows when no agent hook explains it. */
  alertRaised(alert: TerminalNotificationEvent): void {
    const workspace = this.findWorkspaceByTerminalId(alert.terminalId);
    if (!workspace) return;
    // A program that reports its state says what its alerts would, as Antigravity's approvals.
    if (this.programStatuses.has(alert.terminalId)) return;

    // Antigravity has no hook for approval prompts or questions, but raises a
    // terminal alert for them. Mid-turn, any alert other than its end-of-turn
    // one means it is waiting on the user; Stop reports the end of the turn.
    if (
      this.hasActiveAgentSource(workspace.id, 'antigravity', alert.terminalId) &&
      !/\bready for input\b/i.test(alert.message)
    ) {
      this.cancelPendingOscNotification(alert.terminalId);
      this.handleHook(
        {
          cwd: workspace.workingDirectory,
          source: 'antigravity',
          kind: 'input-required',
          message: alert.message,
        },
        { workspace, terminalId: alert.terminalId, hasInvalidTerminalId: false }
      );
      return;
    }

    if (isWorkspaceAttentionActionable(workspace.attention)) {
      return;
    }

    if (this.hasRecentStructuredNotification(alert.terminalId)) {
      this.cancelPendingOscNotification(alert.terminalId);
      return;
    }

    this.cancelPendingOscNotification(alert.terminalId);
    const timeout = setTimeout(() => {
      const pending = this.pendingOscNotifications.get(alert.terminalId);
      if (!pending || pending.event !== alert) return;
      this.pendingOscNotifications.delete(alert.terminalId);
      if (this.hasRecentStructuredNotification(alert.terminalId)) return;
      this.showTerminalAlert(alert);
    }, OSC_NOTIFICATION_FALLBACK_DELAY_MS);
    this.pendingOscNotifications.set(alert.terminalId, { timeout, event: alert });
  }

  // ── Execution this Komla installation saw end; other installations are told ──

  /**
   * The user interrupted the agent here (Ctrl-C, Ctrl-D, Esc). Its attention stays, and its late
   * activity is held back, briefly unless its title confirmed the interrupt. That holds even
   * without a title to confirm it, as with Claude under tmux: late activity would turn the
   * spinner back on until the agent's next turn ends, while an Esc that only closed a menu
   * leaves it off a few seconds.
   */
  aborted(terminalId: string, confirmed = false): void {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (!workspace) return;
    const program = this.programStatuses.get(terminalId);
    // The program reports its own state; a keypress that interrupted nothing leaves it working.
    if (program && !confirmed) {
      program.interruptedAt = Date.now();
      return;
    }
    if (program) {
      // Codex works on while a background terminal it started runs, a server or not.
      program.serving = program.state === 'working';
      this.releaseHeldDone(program);
      program.turn = undefined;
    }
    // A command run with `komla notify --` may read the keystroke and go on; it reports its end.
    this.clearTerminalSources(workspace.id, terminalId, { keepCommand: true });
    if (confirmed) this.lifecycle.recordInterrupt(`terminal:${terminalId}`);
    this.noteInterrupt(
      terminalId,
      confirmed ? LATE_ACTIVITY_AFTER_INTERRUPT_MS : LATE_ACTIVITY_AFTER_UNCONFIRMED_INTERRUPT_MS
    );
  }

  /** The Terminal's execution exited or was stopped here. Its attention stays. */
  ended(terminalId: string): void {
    this.forgetProgramStatus(terminalId);
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (workspace) this.clearTerminalSources(workspace.id, terminalId);
  }

  /** Something new replaced the Terminal's execution. Its old attention goes. */
  replaced(terminalId: string): void {
    this.forgetProgramStatus(terminalId);
    this.claudePermissions.delete(terminalId);
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (workspace) this.clearTerminalSources(workspace.id, terminalId);
    this.clearTerminalAttention(terminalId);
  }

  /** The Terminal is being removed from the workspace, which may have dropped it already. */
  removed(workspaceId: string, terminalId: string): void {
    this.forgetProgramStatus(terminalId);
    this.claudePermissions.delete(terminalId);
    this.clearTerminalSources(workspaceId, terminalId);
    this.clearTerminalAttention(terminalId);
    // Dropped already, its attention can't be cleared, but the workspace mustn't keep showing it.
    const workspace = this.deps.store.get(workspaceId);
    if (workspace?.attention?.terminalId === terminalId) {
      this.showTerminalsAttention(workspace);
      this.deps.store.broadcast(workspace);
      if (isSshWorkspace(workspace)) this.deps.store.save();
    }
  }

  /** Every Terminal of the workspace stopped here. */
  workspaceStopped(workspaceId: string): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    for (const terminal of workspace.terminals) {
      this.clearTerminalSources(workspaceId, terminal.id);
    }
    this.clearAllSources(workspaceId);
  }

  // ── Execution learned about; other installations are never told ─────────

  /** The Terminal's Managed Remote Terminal Session isn't on its host. */
  sessionGone(terminalId: string): void {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (workspace) this.clearTerminalSourcesOnly(workspace.id, terminalId);
  }

  /** Spinners kept on only by copied hooks may be stale after an SSH host reconnects. */
  hostConnected(hostId: string): void {
    this.forgetCopiedAgentActivity(hostId);
  }

  /** Hooks aren't copied here while the computer sleeps, so copied spinners may be stale. */
  machineResumed(): void {
    this.forgetCopiedAgentActivity();
  }

  // ── The user ─────────────────────────────────────────────────────────────

  /**
   * The user saw the workspace, so attention that names none of its Terminals goes. Each
   * Terminal keeps its own until the user sees that Terminal, and the workspace shows it again.
   */
  workspaceSeen(workspaceId: string): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) {
      this.updateAttentionIndicator();
      return;
    }
    const { attention, needsAttention: neededAttention } = workspace;
    this.showTerminalsAttention(workspace);
    if (workspace.attention !== attention || workspace.needsAttention !== !!neededAttention) {
      this.deps.store.broadcast(workspace);
      if (isSshWorkspace(workspace)) this.deps.store.save();
    }
  }

  /**
   * The user saw the Terminal on screen without focusing it. Its done, idle or notice leaves the
   * workspace and the badge, and stays on the Terminal as seen until the user focuses it.
   */
  terminalSeen(terminalId: string): void {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    const terminal = workspace?.terminals.find((t) => t.id === terminalId);
    const attention = terminal?.attention;
    if (!workspace || !terminal || !attention) return;
    if (attention.seen || isWorkspaceAttentionActionable(attention)) return;
    terminal.attention = { ...attention, seen: true };
    if (workspace.attention?.terminalId === terminalId) this.showTerminalsAttention(workspace);
    this.deps.store.broadcast(workspace);
    if (isSshWorkspace(workspace)) this.deps.store.save();
  }

  /**
   * The user dismissed the Terminal's attention. A prompt its program still reports waiting on
   * stays until the program reports it answered or cancelled.
   */
  dismissed(terminalId: string): void {
    if (this.awaitsAnswer(terminalId)) return;
    this.clearTerminalAttention(terminalId);
  }

  /** The user opened the Terminal from the phone remote, which is seeing its attention too. */
  viewedRemotely(workspaceId: string, terminalId: string): void {
    this.workspaceSeen(workspaceId);
    this.dismissed(terminalId);
  }

  /** The user turned the workspace's spinner on or off by hand. */
  spinnerToggled(workspaceId: string, on: boolean): void {
    if (on) this.ensureSource(workspaceId, MANUAL_SPINNER_SOURCE);
    else this.clearAllSources(workspaceId);
  }

  // ── Workspace lifecycle ──────────────────────────────────────────────────

  /** The workspace is gone. Call after its Terminals were torn down. */
  workspaceDeleted(workspaceId: string): void {
    this.activeAgentSources.delete(workspaceId);
    this.updateAttentionIndicator();
  }

  /** A workspace moved to the Trash, was snoozed, woke or was made active again. */
  workspaceStatusChanged(): void {
    this.updateAttentionIndicator();
  }

  // ── Persistence and the SSH session check ───────────────────────────────

  /**
   * Restores spinner sources saved with the workspace, by Terminal id, once it is in the store
   * but before it is announced, and counts its saved attention. Writes the fields without
   * broadcasting.
   */
  restored(
    workspace: Workspace,
    sourcesByTerminal: ReadonlyMap<string, ReadonlyMap<string, number>>
  ): void {
    const activeScopes = new Map<string, Map<WorkspaceAttentionSource, number>>();
    for (const [terminalId, sources] of sourcesByTerminal) {
      if (sources.size > 0) activeScopes.set(terminalId, new Map(sources));
    }
    if (activeScopes.size > 0) {
      this.activeAgentSources.set(workspace.id, activeScopes);
      this.recomputeAgentActive(workspace);
    }
    workspace.needsAttention = needsAttention(workspace.attention);
    this.updateAttentionIndicator();
  }

  /** Spinner sources to save for a Terminal; none while only copied hooks keep it on. */
  persistedSources(workspaceId: string, terminalId: string): Record<string, number> | undefined {
    // Copies stop while this installation is away, so this one could be stale on restart.
    if (this.copiedAgentActivity.has(terminalId)) return undefined;
    const sources = this.activeAgentSources.get(workspaceId)?.get(terminalId);
    return sources && sources.size > 0 ? Object.fromEntries(sources.entries()) : undefined;
  }

  hookMark(terminalId: string): HookMark {
    return { copiedHookTimer: this.copiedAgentActivity.get(terminalId) } as unknown as HookMark;
  }

  /** Whether a copied hook arrived for the Terminal since the mark was taken. */
  hookArrivedSince(terminalId: string, mark: HookMark): boolean {
    const { copiedHookTimer } = mark as unknown as {
      copiedHookTimer: ReturnType<typeof setTimeout> | undefined;
    };
    return this.copiedAgentActivity.get(terminalId) !== copiedHookTimer;
  }

  // ── Hook interpretation ──────────────────────────────────────────────────

  private handleHook(
    payload: AgentHook,
    target: HookTarget & { workspace: Workspace },
    inferredTitle = false
  ): Workspace {
    const workspace = this.interpretHook(payload, target, inferredTitle);
    // After the hook's own changes, so the update that activity sends carries them.
    if (payload.kind && TURN_ACTIVITY_KINDS.has(payload.kind)) {
      this.deps.turnActivity(workspace.id);
    }
    return workspace;
  }

  private interpretHook(
    payload: AgentHook,
    target: HookTarget & { workspace: Workspace },
    inferredTitle: boolean
  ): Workspace {
    const matchingWorkspace = target.workspace;

    // A routed notification means the agent's hook is wired to an active Komla
    // workspace — record the first one of each kind, per source so a second
    // agent's first success isn't swallowed by the first's.
    const notificationKind = payload.kind ?? 'generic';
    const source = payload.source ?? 'unknown';
    // A command run with `komla notify --` is no agent wired to Komla.
    const fromCommand = payload.source === COMMAND_ATTENTION_SOURCE;
    if (notificationKind !== 'activity' && !payload.copy && !fromCommand && !inferredTitle) {
      this.deps.milestone(`notification:${notificationKind}:${source}`, {
        notificationKind,
        source: payload.source,
      });
    }

    const terminalId = target.terminalId;
    const hasInvalidTerminalId = target.hasInvalidTerminalId;
    // A command's news for the whole workspace, as a background Quick Command's, is no Terminal's:
    // it leaves their OSC alerts be.
    const speaksForTerminals = !!terminalId || !fromCommand;
    if (
      terminalId &&
      !inferredTitle &&
      !fromCommand &&
      payload.kind &&
      payload.kind !== 'generic'
    ) {
      this.codexTitleStatus.hook(terminalId, payload.source, payload.kind);
    }
    if (terminalId) {
      this.cancelPendingOscNotification(terminalId);
    } else if (!hasInvalidTerminalId && speaksForTerminals) {
      this.cancelPendingOscNotificationsForWorkspace(matchingWorkspace);
    }

    // The agent stopped without news: Codex was cancelled, or Claude quit. The hook itself
    // reaches the other installations showing the Terminal, so there is nothing to relay.
    if (payload.kind === 'interrupted') {
      if (!hasInvalidTerminalId && !fromCommand) this.dropManualSource(matchingWorkspace.id);
      if (terminalId && fromCommand) {
        this.clearTerminalSource(matchingWorkspace.id, terminalId, COMMAND_ATTENTION_SOURCE);
      } else if (terminalId) {
        this.clearTerminalSourcesOnly(matchingWorkspace.id, terminalId);
        this.noteInterrupt(terminalId);
      } else if (!hasInvalidTerminalId) {
        this.clearWorkspaceScopeSource(matchingWorkspace.id, toAttentionSource(payload.source));
      }
      this.broadcastIfAgentActiveChanged(matchingWorkspace);
      return matchingWorkspace;
    }

    if (payload.kind === 'activity') {
      this.recordStructuredNotification(matchingWorkspace, terminalId, hasInvalidTerminalId);
      const attention = terminalId
        ? matchingWorkspace.terminals.find((terminal) => terminal.id === terminalId)?.attention
        : matchingWorkspace.attention;
      // Tool activity only dismisses stale completion, preserving approval/error prompts.
      if (attention?.kind === 'turn-complete' || attention?.kind === 'idle') {
        if (terminalId) this.clearTerminalAttention(terminalId);
        else if (!hasInvalidTerminalId) this.workspaceSeen(matchingWorkspace.id);
      }
      this.ensureSource(matchingWorkspace.id, toAttentionSource(payload.source), terminalId);
      this.updateAttentionIndicator();
      return matchingWorkspace;
    }

    // prompt-submit is not an attention event — route to auto-naming instead.
    // Submitting a prompt is unambiguous "user is here" signal, so clear any
    // pending attention from the sending terminal. Legacy notifications without
    // a terminal id fall back to workspace-wide clearing. A provided but stale
    // terminal id should not clear unrelated terminal attention.
    if (payload.kind === 'prompt-submit') {
      // A command's start dismisses nothing: an agent's news, or the last command's failure.
      if (terminalId && !fromCommand) {
        // A new prompt starts a turn whose activity is current.
        this.lateActivityUntil.delete(terminalId);
        this.clearTerminalAttention(terminalId);
      } else if (!terminalId && !hasInvalidTerminalId && !fromCommand) {
        this.workspaceSeen(matchingWorkspace.id);
      }
      const promptSource = toAttentionSource(payload.source);
      if (terminalId) {
        this.ensureSource(matchingWorkspace.id, promptSource, terminalId);
      } else if (!hasInvalidTerminalId) {
        // A Terminal that is gone is old news: its done couldn't stop the spinner.
        this.addSource(matchingWorkspace.id, promptSource);
      }
      // The attached installation names the workspace from the prompt, and the name syncs.
      if (payload.copy) return matchingWorkspace;
      const prompt =
        typeof payload.hookInput?.prompt === 'string' ? payload.hookInput.prompt : payload.message;
      if (!prompt) {
        logger.debug('Prompt-submit received with no message, ignoring');
        return matchingWorkspace;
      }
      // Claude resumes after background work with a synthetic <task-notification> prompt, or
      // after a background subagent with its report in an <agent-message>.
      if (payload.source === 'claude-code' && CLAUDE_RESUME_PROMPT.test(prompt.trimStart())) {
        return matchingWorkspace;
      }
      this.deps.promptSubmitted(matchingWorkspace.id, prompt, terminalId);
      logger.debug(`Prompt-submit received: workspace=${matchingWorkspace.name}`);
      return matchingWorkspace;
    }

    if (speaksForTerminals) {
      this.recordStructuredNotification(matchingWorkspace, terminalId, hasInvalidTerminalId);
    }

    // Like prompts, replies are recorded by the attached installation only, and a stale
    // Terminal can't tell which prompt a reply answers.
    if (
      payload.kind === 'turn-complete' &&
      !payload.copy &&
      !fromCommand &&
      !hasInvalidTerminalId
    ) {
      // What Komla reports for a program says nothing its summary or hooks didn't already.
      const reply = inferredTitle ? replyField(payload) : agentReply(payload);
      this.recordReply(matchingWorkspace.id, reply, terminalId);
    }

    const attention = buildAttention(payload, terminalId);
    // Terminal-scoped done/idle notifications are authoritative for the whole
    // terminal. Legacy notifications without a terminal id fall back to the
    // workspace scope. A stale terminal id is old attribution; it must not
    // stop any current spinner. A turn that ends on an error (StopFailure) ends
    // too, unlike an error a script reports from some other hook.
    const failedTurn = isFailedTurn(payload);
    if (attention.kind === 'turn-complete' || attention.kind === 'idle' || failedTurn) {
      // Nothing tells when the work the user turned the spinner on for ends, so any agent's turn
      // ending does. An idle reminder follows a turn that ended earlier, and a command is no agent.
      if (!hasInvalidTerminalId && attention.kind !== 'idle' && !fromCommand) {
        this.dropManualSource(matchingWorkspace.id);
      }
      if (attention.terminalId && fromCommand) {
        // A command's end leaves an agent working in the same terminal to its own hooks.
        this.clearTerminalSource(matchingWorkspace.id, attention.terminalId, attention.source);
      } else if (attention.terminalId) {
        this.clearTerminalSourcesOnly(matchingWorkspace.id, attention.terminalId);
        // Like an interrupt, the turn ends without the Stop its tool activity would precede.
        if (failedTurn) this.noteInterrupt(attention.terminalId);
      } else if (!hasInvalidTerminalId) {
        this.clearWorkspaceScopeSource(matchingWorkspace.id, attention.source);
      }
      this.broadcastIfAgentActiveChanged(matchingWorkspace);
    } else if (attention.kind === 'input-required' && attention.source === 'claude-code') {
      // Claude Code sends input-required while still processing (permission prompts,
      // elicitation dialogs). Other agents use input-required to signal idle.
      // Use `ensure` (not increment) — input-required is midstream within an
      // already-in-flight turn, so incrementing here would leave the spinner
      // stuck after the matching turn-complete.
      this.ensureSource(matchingWorkspace.id, attention.source, attention.terminalId);
      if (attention.terminalId && payload.hookInput?.hook_event_name === 'PermissionRequest') {
        this.recordClaudePermission(attention.terminalId, payload);
      }
    }
    // An idle reminder only ends a turn whose Stop never came. It shows nothing, so it can't take
    // the place of a done the user hasn't come back to.
    if (attention.kind === 'idle') return matchingWorkspace;
    // Don't let an informational update from another terminal hide a prompt/error
    // that still needs user action. Without a terminal, only a done defers to what
    // the workspace shows.
    const shouldPreserveWorkspaceAttention =
      (attention.kind === 'turn-complete' || !!attention.terminalId) &&
      attentionOutranks(matchingWorkspace.attention, attention) &&
      (!attention.terminalId || matchingWorkspace.attention?.terminalId !== attention.terminalId);
    const preservedWorkspaceAttention = shouldPreserveWorkspaceAttention
      ? matchingWorkspace.attention
      : undefined;
    if (shouldPreserveWorkspaceAttention && !attention.terminalId) {
      logger.debug(
        `Skipping ${attention.kind} attention: higher-priority attention already shown (workspace=${matchingWorkspace.name})`
      );
      return matchingWorkspace;
    }
    this.showAttention(matchingWorkspace.id, attention, attention.terminalId);
    // When the incoming update is terminal-scoped, the call above also overwrote
    // workspace.attention — restore the actionable workspace attention it shadowed.
    if (preservedWorkspaceAttention) {
      this.showAttention(
        matchingWorkspace.id,
        preservedWorkspaceAttention,
        preservedWorkspaceAttention.terminalId
      );
    }
    this.deps.windows.attentionRaised({
      workspaceId: matchingWorkspace.id,
      attention,
      workspaceAttention: preservedWorkspaceAttention ?? attention,
    });
    this.updateAttentionIndicator();
    logger.debug(
      `Notification received: workspace=${matchingWorkspace.name} kind=${attention.kind} source=${attention.source}`
    );
    return matchingWorkspace;
  }

  /** Background work never resumed a held turn, so its Stop completes the turn now. */
  private completeHeldTurn(hook: AgentHook, target: HookTarget): void {
    const workspace = target.terminalId
      ? this.findWorkspaceByTerminalId(target.terminalId)
      : target.workspace && this.deps.store.get(target.workspace.id);
    if (!workspace) return;
    logger.debug('Background hold expired', {
      terminalId: target.terminalId,
      source: hook.source,
    });
    const matchedWorkspace = this.handleHook(hook, {
      workspace,
      terminalId: target.terminalId,
      hasInvalidTerminalId: target.hasInvalidTerminalId,
    });
    if (target.terminalId) this.noteAgentHook(target.terminalId, !!hook.copy);
    void this.deps.store
      .saveNow(matchedWorkspace.id)
      .catch((error) => logger.error('Failed to persist held turn completion:', error));
  }

  /** Codex shows its working state in the title, which stands in for a missing root Stop. */
  private inferCodexStatus(terminalId: string, kind: 'activity' | 'turn-complete'): void {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    if (!workspace || !terminal) return;
    if (
      kind === 'turn-complete' &&
      (!terminal.agentActive || isWorkspaceAttentionActionable(terminal.attention))
    )
      return;
    const hook: AgentHook = { cwd: workspace.workingDirectory, source: 'codex', kind };
    // A live working title also cancels a settling Stop from the hook lane.
    if (kind === 'activity') {
      void this.lifecycle.accept(`terminal:${terminalId}`, hook);
      if (
        terminal.agentActive &&
        terminal.attention?.kind !== 'turn-complete' &&
        terminal.attention?.kind !== 'idle'
      )
        return;
    }
    logger.debug('Codex title fallback', { terminalId, kind });
    this.handleHook(hook, { workspace, terminalId, hasInvalidTerminalId: false }, true);
    if (kind === 'turn-complete') {
      this.lifecycle.recordInferredCompletion(`terminal:${terminalId}`, 'codex');
    }
  }

  /** Whether Codex reports its state in a Terminal of the workspace, which its hooks then leave alone. */
  private reportsCodexStatus(workspace: Workspace): boolean {
    return workspace.terminals.some((terminal) => this.codexStatus(terminal.id));
  }

  private codexStatus(terminalId: string): ProgramStatus | undefined {
    const status = this.programStatuses.get(terminalId);
    return status?.source === 'codex' ? status : undefined;
  }

  /**
   * A Codex hook while Codex reports its state in the workspace. Codex runs hooks in a process its
   * sessions share, with the environment of the Terminal that started it, so a hook may name
   * another Terminal. A session's prompt arrives after its Terminal reported working, so it binds
   * the session to the one Terminal there whose turn no session started yet. A server it started
   * keeps Codex working, as Claude's background servers don't, so its Stop ends the turn.
   */
  private takeCodexHookContent(
    hook: AgentHook,
    workspace: Workspace,
    namedTerminalId: string | undefined
  ): HookOutcome {
    const session = hook.hookInput?.session_id;
    const turnId = hook.hookInput?.turn_id;
    if (hook.kind !== 'activity' && !hook.copy) {
      this.deps.milestone(`notification:${hook.kind ?? 'generic'}:codex`, {
        notificationKind: hook.kind ?? 'generic',
        source: hook.source,
      });
    }
    if (hook.kind === 'prompt-submit') {
      const terminalId = this.bindCodexSession(workspace, session, namedTerminalId);
      const status = terminalId ? this.codexStatus(terminalId) : undefined;
      if (terminalId && status) {
        status.copiedHooks = !!hook.copy;
        // A background terminal keeps Codex working, so it reports nothing new at this prompt.
        status.turn = { session, turnId };
        // Like any prompt, it dismisses what the Terminal showed, such as the last turn's error.
        this.reportProgram(workspace, terminalId, { kind: 'prompt-submit' });
      }
      const prompt =
        typeof hook.hookInput?.prompt === 'string' ? hook.hookInput.prompt : hook.message;
      if (prompt && !hook.copy) {
        this.deps.promptSubmitted(workspace.id, prompt, terminalId ?? namedTerminalId);
      }
      return 'taken';
    }
    const terminalId = session ? this.codexSessions.get(session) : undefined;
    const status =
      terminalId && workspace.terminals.some((terminal) => terminal.id === terminalId)
        ? this.codexStatus(terminalId)
        : undefined;
    const isThisTurn = (candidate: { session?: string; turnId?: string } | undefined) =>
      !!candidate &&
      candidate.session === session &&
      (!candidate.turnId || !turnId || candidate.turnId === turnId);
    const turn = isThisTurn(status?.turn) ? status?.turn : undefined;
    if (status) status.copiedHooks = !!hook.copy;
    if (hook.kind === 'activity') {
      const command = (hook.hookInput?.tool_input as { command?: unknown } | undefined)?.command;
      if (turn && typeof command === 'string' && isLongRunningCommand(command)) {
        turn.startedServer = true;
      }
      return 'taken';
    }
    if (turn && hook.kind === 'input-required') turn.approval = hook.message;
    if (hook.kind !== 'turn-complete' && hook.kind !== 'interrupted') return 'taken';
    if (terminalId && status && turn && hook.kind === 'interrupted') {
      // Codex works on while a background terminal it started runs, a server or not.
      status.turn = undefined;
      status.serving = status.state === 'working';
      this.clearTerminalSourcesOnly(workspace.id, terminalId);
      return 'taken';
    }
    if (terminalId && status && turn && (turn.startedServer || status.serving)) {
      status.turn = undefined;
      status.serving = true;
      const { kind, message, hookInput, copy } = hook;
      this.reportProgram(workspace, terminalId, { kind, message, hookInput, copy });
      return 'taken';
    }
    if (turn && hook.kind === 'turn-complete') turn.reply = hook.message;
    const reply = hook.kind === 'turn-complete' ? agentReply(hook) : undefined;
    if (!hook.copy) this.recordReply(workspace.id, reply, status ? terminalId : namedTerminalId);
    return 'taken';
  }

  /**
   * The Terminal a Codex session prompted in: the one it prompted in before, while that is still
   * working on it, or else the one Terminal of the workspace whose turn no session started yet,
   * or failing that, where a server keeps Codex working. When more than one is, the Terminal the
   * hook names wins if it is one of them.
   */
  private bindCodexSession(
    workspace: Workspace,
    session: string | undefined,
    namedTerminalId: string | undefined
  ): string | undefined {
    if (!session) return undefined;
    const bound = this.codexSessions.get(session);
    const boundStatus = bound ? this.codexStatus(bound) : undefined;
    if (
      bound &&
      boundStatus &&
      workspace.terminals.some((terminal) => terminal.id === bound) &&
      (boundStatus.state === 'working' || boundStatus.state === 'blocked') &&
      (boundStatus.turn?.session ?? session) === session
    ) {
      return bound;
    }
    const terminalIds = workspace.terminals.map((terminal) => terminal.id);
    const started = terminalIds.filter((terminalId) => {
      const turn = this.codexStatus(terminalId)?.turn;
      return turn && !turn.session;
    });
    // A server keeps Codex working, so it reports nothing new as a new session prompts there.
    const unclaimed = started.length
      ? started
      : terminalIds.filter((terminalId) => {
          const status = this.codexStatus(terminalId);
          return status?.serving && !status.turn;
        });
    const terminalId =
      unclaimed.length === 1
        ? unclaimed[0]
        : namedTerminalId && unclaimed.includes(namedTerminalId)
          ? namedTerminalId
          : undefined;
    if (terminalId) this.codexSessions.set(session, terminalId);
    return terminalId;
  }

  /**
   * A turn the program reported working ended done or idle. Codex works on until its background
   * terminals exit, and reports done then; before 0.164 it ends every turn idle, as it does one
   * the user interrupted, at once. Other programs end a turn the user interrupted idle, and some,
   * as OpenCode 2, every turn, so the hooks of such a program say how its turn ended.
   */
  private programTurnEnded(
    workspace: Workspace,
    terminalId: string,
    current: ProgramStatus,
    status: TerminalProgramStatus
  ): void {
    current.serving = false;
    const turn = current.turn;
    if (current.heldDone) {
      // Claude reports its done again a moment later, with a summary of the turn.
      if (status.state === 'done') current.heldDone.message ??= status.msg;
      else this.endProgramTurnQuietly(workspace, terminalId, current);
      return;
    }
    if (!turn) {
      if (status.state === 'done' && status.msg) {
        this.recordSummary(workspace, terminalId, current, status.msg);
        this.fillDoneMessage(workspace, terminalId, current.source, status.msg);
      }
      return;
    }
    const idleEndsTurn = current.source === 'codex' && !current.reportsDone;
    if (status.state === 'done') current.reportsDone = true;
    const keyInterrupted =
      current.interruptedAt !== undefined &&
      Date.now() - current.interruptedAt < CODEX_INTERRUPT_IDLE_MS;
    if (turn.startup || (status.state === 'idle' && idleEndsTurn && keyInterrupted)) {
      this.endProgramTurnQuietly(workspace, terminalId, current);
      return;
    }
    if (turn.failure !== undefined) {
      this.failProgramTurn(workspace, terminalId, current, turn.failure);
      return;
    }
    if (status.state === 'idle' && !idleEndsTurn) {
      if (!turn.stopped) {
        const hooksMayTell = current.hooked && current.source !== 'codex' && !keyInterrupted;
        this.endProgramTurnQuietly(workspace, terminalId, current);
        if (hooksMayTell) this.awaitEndedIdleTurn(current, terminalId);
        return;
      }
    }
    // The Stop its hooks send may hold the turn for background work, so the done waits for it.
    const awaitsStop = current.hooked && current.source !== 'codex' && !turn.stopped;
    if (awaitsStop || turn.waitsForBackgroundWork) {
      this.holdDone(current, terminalId, status.msg, awaitsStop ? STOP_HOOK_WAIT_MS : undefined);
      return;
    }
    this.completeProgramTurn(workspace, terminalId, current, status.msg);
  }

  /** Lets a Stop or StopFailure arriving just after the idle show how the turn ended. */
  private awaitEndedIdleTurn(current: ProgramStatus, terminalId: string): void {
    current.endedIdle = setTimeout(() => {
      if (this.programStatuses.get(terminalId) === current) current.endedIdle = undefined;
    }, STOP_HOOK_WAIT_MS);
  }

  private forgetEndedIdle(current: ProgramStatus): void {
    clearTimeout(current.endedIdle);
    current.endedIdle = undefined;
  }

  /** Holds a done until the Stop it waits for, or the background work it named, is over. */
  private holdDone(
    current: ProgramStatus,
    terminalId: string,
    message: string | undefined,
    waitMs = BACKGROUND_HOLD_LIMIT_MS
  ): void {
    const timer = setTimeout(() => {
      const workspace = this.findWorkspaceByTerminalId(terminalId);
      const held = current.heldDone;
      current.heldDone = undefined;
      if (!workspace || this.programStatuses.get(terminalId) !== current) return;
      if (waitMs !== BACKGROUND_HOLD_LIMIT_MS) logger.debug('No Stop for the done', { terminalId });
      else logger.debug('Background hold expired', { terminalId, source: current.source });
      this.completeProgramTurn(workspace, terminalId, current, held?.message);
    }, waitMs);
    current.heldDone = { timer, message };
  }

  private releaseHeldDone(current: ProgramStatus): void {
    clearTimeout(current.heldDone?.timer);
    current.heldDone = undefined;
  }

  private completeProgramTurn(
    workspace: Workspace,
    terminalId: string,
    current: ProgramStatus,
    message: string | undefined
  ): void {
    const reply = current.turn?.reply;
    this.releaseHeldDone(current);
    current.turn = current.interruptedAt = undefined;
    current.summary = 'awaited';
    if (message) this.recordSummary(workspace, terminalId, current, message);
    this.reportProgram(workspace, terminalId, { kind: 'turn-complete', message: reply ?? message });
  }

  private failProgramTurn(
    workspace: Workspace,
    terminalId: string,
    current: ProgramStatus,
    message: string
  ): void {
    this.endProgramTurnQuietly(workspace, terminalId, current);
    this.reportProgram(workspace, terminalId, { kind: 'error', message });
  }

  private endProgramTurnQuietly(
    workspace: Workspace,
    terminalId: string,
    current: ProgramStatus
  ): void {
    this.releaseHeldDone(current);
    current.turn = current.interruptedAt = current.summary = undefined;
    this.clearTerminalSourcesOnly(workspace.id, terminalId);
  }

  /** Records the program's summary of the turn it ended done as the turn's reply. */
  private recordSummary(
    workspace: Workspace,
    terminalId: string,
    current: ProgramStatus,
    summary: string
  ): void {
    if (current.summary !== 'awaited' || current.copiedHooks !== false || !summary.trim()) return;
    current.summary = 'recorded';
    this.deps.agentReplied(workspace.id, summary, terminalId);
  }

  /** Records an agent's reply, unless the program in its Terminal summed up the turn. */
  private recordReply(workspaceId: string, reply: string | undefined, terminalId?: string): void {
    if (!reply) return;
    if (terminalId && this.programStatuses.get(terminalId)?.summary === 'recorded') return;
    this.deps.agentReplied(workspaceId, reply, terminalId);
  }

  /** The program summed up the turn whose done shows without a message, as Claude does. */
  private fillDoneMessage(
    workspace: Workspace,
    terminalId: string,
    source: string,
    message: string
  ): void {
    const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
    const attention = terminal?.attention;
    if (!terminal || attention?.kind !== 'turn-complete' || attention.source !== source) return;
    if (attention.message) return;
    terminal.attention = { ...attention, message };
    if (workspace.attention === attention) workspace.attention = terminal.attention;
    this.deps.store.broadcast(workspace);
    if (isSshWorkspace(workspace)) this.deps.store.save();
  }

  /**
   * A hook naming a Terminal whose program reports its state, which the hook then leaves alone.
   * Its prompt still names the workspace and its reply is recorded. The program's own agent's
   * Stop says whether background work holds the turn; another agent's hooks, as Grok runs Claude
   * Code's, say nothing of the program's turn.
   */
  private takeProgramHookContent(
    hook: AgentHook,
    workspace: Workspace,
    terminalId: string
  ): HookOutcome {
    const status = this.programStatuses.get(terminalId);
    const own = status?.source === hook.source;
    if (own && status) {
      status.hooked = true;
      status.copiedHooks = !!hook.copy;
      // The turn failed, also one whose done already showed, so no summary is its reply.
      if (isFailedTurn(hook)) status.summary = undefined;
    }
    if (own && hook.kind !== 'activity' && !hook.copy) {
      this.deps.milestone(`notification:${hook.kind ?? 'generic'}:${hook.source}`, {
        notificationKind: hook.kind ?? 'generic',
        source: hook.source,
      });
    }
    if (hook.kind === 'prompt-submit') {
      const prompt =
        typeof hook.hookInput?.prompt === 'string' ? hook.hookInput.prompt : hook.message;
      // Claude resumes after background work with a synthetic prompt, which no user sent.
      if (prompt && CLAUDE_RESUME_PROMPT.test(prompt.trimStart())) return 'taken';
      // Like any prompt, it dismisses what the Terminal showed, such as the last turn's error.
      this.lateActivityUntil.delete(terminalId);
      this.clearTerminalAttention(terminalId);
      // The device the hooks are for names the workspace and records replies, as below.
      if (prompt && !hook.copy) this.deps.promptSubmitted(workspace.id, prompt, terminalId);
      return 'taken';
    }
    const endsTurn =
      hook.kind === 'turn-complete' || hook.kind === 'interrupted' || isFailedTurn(hook);
    if (own && status?.endedIdle && endsTurn) {
      // The turn the program ended idle just now: its Stop or StopFailure says how.
      this.forgetEndedIdle(status);
      if (hook.kind === 'turn-complete' || isFailedTurn(hook)) {
        const reply = hook.kind === 'turn-complete' ? agentReply(hook) : undefined;
        if (!hook.copy) this.recordReply(workspace.id, reply, terminalId);
        const kind = hook.kind === 'turn-complete' ? 'turn-complete' : 'error';
        this.reportProgram(workspace, terminalId, { kind, message: hook.message });
      }
      return 'taken';
    }
    const turn = own ? status?.turn : undefined;
    if (turn && hook.kind === 'input-required') turn.approval = hook.message;
    if (turn && status && isFailedTurn(hook)) {
      turn.failure = hook.message ?? '';
      // The done it reported waits for a Stop, which a failed turn doesn't send.
      if (status.heldDone) this.failProgramTurn(workspace, terminalId, status, turn.failure);
    }
    // A Stop; a manual /compact sends none, and Claude's PostCompact stands in for it.
    if (hook.kind === 'turn-complete') {
      if (!hook.copy) this.recordReply(workspace.id, agentReply(hook), terminalId);
      if (!turn || !status) return 'taken';
      turn.stopped = true;
      turn.reply = hook.message;
      turn.waitsForBackgroundWork = waitsForBackgroundWork(hook);
      if (status.heldDone && !turn.waitsForBackgroundWork) {
        this.completeProgramTurn(workspace, terminalId, status, status.heldDone.message);
      } else if (status.heldDone) {
        const { message } = status.heldDone;
        this.releaseHeldDone(status);
        this.holdDone(status, terminalId, message);
      }
    }
    return 'taken';
  }

  /**
   * The Terminal whose program reports its state that an agent hook belongs to: the one it names,
   * or, for a hook naming none, the one Terminal of the workspace where its agent reports, as
   * OpenCode 2's plugin names only the folder from the service its sessions share.
   */
  private reportingTerminalFor(
    hook: AgentHook,
    workspace: Workspace,
    target: HookTarget
  ): string | undefined {
    // A notice sent by hand rather than from an agent's hook shows as it always does.
    if (hook.source === COMMAND_ATTENTION_SOURCE || !hook.hookInput?.hook_event_name) {
      return undefined;
    }
    if (target.terminalId) {
      return this.programStatuses.has(target.terminalId) ? target.terminalId : undefined;
    }
    if (target.hasInvalidTerminalId || !hook.source) return undefined;
    const reporting = workspace.terminals.filter(
      (terminal) => this.programStatuses.get(terminal.id)?.source === hook.source
    );
    return reporting.length === 1 ? reporting[0].id : undefined;
  }

  /** Applies what the program reported in the Terminal as its own hook would. */
  private reportProgram(
    workspace: Workspace,
    terminalId: string,
    hook: Pick<AgentHook, 'kind' | 'message' | 'hookInput' | 'copy'>
  ): void {
    const source = this.programStatuses.get(terminalId)?.source ?? 'codex';
    this.handleHook(
      { cwd: workspace.workingDirectory, source, ...hook },
      { workspace, terminalId, hasInvalidTerminalId: false },
      true
    );
  }

  private forgetProgramStatus(terminalId: string): void {
    const status = this.programStatuses.get(terminalId);
    if (status) {
      this.releaseHeldDone(status);
      this.forgetEndedIdle(status);
      clearTimeout(status.answerCheck);
    }
    this.programStatuses.delete(terminalId);
    for (const [session, boundTerminalId] of this.codexSessions) {
      if (boundTerminalId === terminalId) this.codexSessions.delete(session);
    }
  }

  /**
   * A prompt whose tool call can't be named can't be matched to its answer, nor its Notification
   * to it, so that Notification shows.
   */
  private recordClaudePermission(terminalId: string, hook: AgentHook): void {
    const permission = claudePermission(hook);
    const pending = this.claudePermissions.get(terminalId) ?? [];
    if (!permission) {
      this.claudePermissions.delete(terminalId);
      return;
    }
    this.claudePermissions.set(terminalId, [...pending, permission].slice(-MAX_CLAUDE_PERMISSIONS));
  }

  /**
   * Claude's Notification about a permission prompt follows its PermissionRequest 6 s later,
   * while the prompt still shows, and says less.
   */
  private repeatsClaudePermission(hook: AgentHook, terminalId: string): boolean {
    return (
      hook.source === 'claude-code' &&
      hook.hookInput?.hook_event_name === 'Notification' &&
      hook.hookInput.notification_type === 'permission_prompt' &&
      !!this.claudePermissions
        .get(terminalId)
        ?.some((permission) => permission.session === hook.hookInput?.session_id)
    );
  }

  /**
   * The tool call a Claude permission prompt asked about ended, so the prompt was answered, maybe
   * on another device, and the Terminal no longer needs input.
   */
  private settleClaudePermission(hook: AgentHook, terminalId: string): void {
    const event = hook.hookInput?.hook_event_name;
    if (
      hook.source !== 'claude-code' ||
      (event !== 'PostToolUse' && event !== 'PostToolUseFailure')
    ) {
      return;
    }
    const pending = this.claudePermissions.get(terminalId) ?? [];
    const index = pending.findIndex((permission) => endsClaudeToolCall(hook, permission));
    if (index < 0) return;
    const rest = pending.filter((_, other) => other !== index);
    if (rest.length > 0) {
      // Another prompt still waits, as a subagent's beside the lead's.
      this.claudePermissions.set(terminalId, rest);
      return;
    }
    this.claudePermissions.delete(terminalId);
    this.clearInputRequest(terminalId, 'claude-code');
  }

  /** A filtered hook still shows its agent is wired up, which silences the alert fallback. */
  private recordIgnoredHook(hook: AgentHook, target: HookTarget): boolean {
    logger.debug('Ignored background notification', {
      terminalId: target.terminalId,
      source: hook.source,
      event: hook.hookInput?.hook_event_name,
      ...hookIdentity(hook),
      agentId: hook.hookInput?.agent_id,
    });
    if (!target.workspace) return false;

    if (target.terminalId) {
      this.cancelPendingOscNotification(target.terminalId);
    } else if (!target.hasInvalidTerminalId) {
      this.cancelPendingOscNotificationsForWorkspace(target.workspace);
    }
    this.recordStructuredNotification(
      target.workspace,
      target.terminalId,
      target.hasInvalidTerminalId
    );
    return true;
  }

  // ── Terminal alerts ──────────────────────────────────────────────────────

  private showTerminalAlert(alert: TerminalNotificationEvent): void {
    const workspace = this.findWorkspaceByTerminalId(alert.terminalId);
    if (!workspace) return;

    if (isWorkspaceAttentionActionable(workspace.attention)) {
      return;
    }

    const message =
      alert.title && alert.title !== alert.message
        ? `${alert.title}: ${alert.message}`
        : alert.message;
    const attention: WorkspaceAttention = {
      kind: 'generic',
      source: 'terminal-osc',
      updatedAt: Date.now(),
      message,
      terminalId: alert.terminalId,
    };

    this.showAttention(workspace.id, attention, alert.terminalId);
    this.deps.windows.attentionRaised({
      workspaceId: workspace.id,
      attention,
      workspaceAttention: attention,
    });
    this.updateAttentionIndicator();
  }

  private cancelPendingOscNotification(terminalId: string): void {
    const pending = this.pendingOscNotifications.get(terminalId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingOscNotifications.delete(terminalId);
  }

  private cancelPendingOscNotificationsForWorkspace(workspace: Workspace): void {
    for (const terminal of workspace.terminals) {
      this.cancelPendingOscNotification(terminal.id);
    }
  }

  private recordStructuredNotification(
    workspace: Workspace,
    terminalId: string | undefined,
    hasInvalidTerminalId: boolean
  ): void {
    const now = Date.now();
    this.pruneRecentStructuredNotifications(now);

    if (terminalId) {
      this.recentStructuredNotificationByTerminal.set(terminalId, now);
      return;
    }

    if (hasInvalidTerminalId) return;

    for (const terminal of workspace.terminals) {
      this.recentStructuredNotificationByTerminal.set(terminal.id, now);
    }
  }

  private hasRecentStructuredNotification(terminalId: string): boolean {
    const now = Date.now();
    this.pruneRecentStructuredNotifications(now);

    const timestamp = this.recentStructuredNotificationByTerminal.get(terminalId);
    return (
      timestamp !== undefined && now - timestamp <= RECENT_STRUCTURED_NOTIFICATION_SUPPRESSION_MS
    );
  }

  private pruneRecentStructuredNotifications(now: number): void {
    for (const [terminalId, timestamp] of this.recentStructuredNotificationByTerminal) {
      if (now - timestamp > RECENT_STRUCTURED_NOTIFICATION_SUPPRESSION_MS) {
        this.recentStructuredNotificationByTerminal.delete(terminalId);
      }
    }
  }

  // ── Attention ────────────────────────────────────────────────────────────

  private showAttention(
    workspaceId: string,
    attention: WorkspaceAttention,
    terminalId?: string
  ): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    workspace.attention = attention;
    workspace.needsAttention = needsAttention(attention);
    if (terminalId) {
      const terminal = workspace.terminals.find((t) => t.id === terminalId);
      if (terminal) {
        terminal.attention = attention;
      }
    }
    publishRemoteWorkspaceChange();
    if (isSshWorkspace(workspace)) this.deps.store.save();
  }

  /** Whether the Terminal asks for input its program still reports waiting on. */
  private awaitsAnswer(terminalId: string): boolean {
    const program = this.programStatuses.get(terminalId);
    const attention = this.getTerminal(terminalId)?.attention;
    return (
      program?.state === 'blocked' &&
      attention?.kind === 'input-required' &&
      attention.source === program.source
    );
  }

  private clearInputRequest(terminalId: string, source: string): void {
    const attention = this.getTerminal(terminalId)?.attention;
    if (attention?.kind === 'input-required' && attention.source === source) {
      this.clearTerminalAttention(terminalId);
    }
  }

  private clearTerminalAttention(terminalId: string): void {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (!workspace) return;
    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal?.attention) return;
    terminal.attention = undefined;
    if (workspace.attention?.terminalId === terminalId) this.showTerminalsAttention(workspace);
    this.deps.store.broadcast(workspace);
    if (isSshWorkspace(workspace)) this.deps.store.save();
  }

  /** The workspace shows the most urgent attention its Terminals have that the user hasn't seen. */
  private showTerminalsAttention(workspace: Workspace): void {
    const nextAttention = pickWorkspaceAttention(workspace.terminals.map((t) => t.attention));
    workspace.attention = nextAttention;
    workspace.needsAttention = needsAttention(nextAttention);
    this.updateAttentionIndicator();
  }

  private updateAttentionIndicator(): void {
    let count = 0;
    for (const workspace of this.deps.store.workspaces()) {
      // A workspace in the Trash has no agents running, so its attention waits there.
      // A snoozed one is out of sight, so its attention waits until it wakes.
      if (
        workspace.status === 'active' &&
        !isWorkspaceSnoozed(workspace) &&
        needsAttention(workspace.attention)
      ) {
        count++;
      }
    }
    this.deps.windows.badge(count);
  }

  // ── Spinner ──────────────────────────────────────────────────────────────

  private getAgentScope(terminalId?: string): string {
    return terminalId ?? WORKSPACE_AGENT_SCOPE;
  }

  private recomputeAgentActive(workspace: Workspace): boolean {
    const scopes = this.activeAgentSources.get(workspace.id);
    const workspaceActive = !!scopes && scopes.size > 0;
    const now = Date.now();
    let terminalChanged = false;
    for (const terminal of workspace.terminals) {
      const sources = scopes?.get(terminal.id);
      const active = !!sources;
      if (!active) this.dropCopiedAgentActivity(terminal.id);
      if (!!terminal.agentActive !== active) {
        terminal.agentActive = active;
        terminal.agentActiveSince = active ? now : undefined;
        terminalChanged = true;
      }
      const commandActive =
        !!sources && Array.from(sources.keys()).every((s) => s === COMMAND_ATTENTION_SOURCE);
      if (!!terminal.commandActive !== commandActive) {
        terminal.commandActive = commandActive;
        terminalChanged = true;
      }
    }
    const workspaceChanged = !!workspace.agentActive !== workspaceActive;
    if (workspaceChanged) workspace.agentActiveSince = workspaceActive ? now : undefined;
    workspace.agentActive = workspaceActive;
    return workspaceChanged || terminalChanged;
  }

  private broadcastIfAgentActiveChanged(workspace: Workspace): void {
    if (this.recomputeAgentActive(workspace)) {
      this.deps.store.broadcast(workspace);
    }
  }

  // Increment the in-flight count for a source. Use for task-start events
  // (prompt-submit without a terminal).
  private addSource(workspaceId: string, source: WorkspaceAttentionSource): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    const sources = this.scopeSources(workspaceId, this.getAgentScope());
    sources.set(source, (sources.get(source) ?? 0) + 1);
    this.broadcastIfAgentActiveChanged(workspace);
  }

  // Ensure a source is marked active (count >= 1) without incrementing if it
  // already is. Use for midstream events that signal "the agent is still
  // here" but aren't task-start boundaries (claude-code input-required,
  // manual spinner toggle) — otherwise they'd inflate the count and leave a
  // stuck spinner.
  private ensureSource(
    workspaceId: string,
    source: WorkspaceAttentionSource,
    terminalId?: string
  ): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    const sources = this.scopeSources(workspaceId, this.getAgentScope(terminalId));
    if ((sources.get(source) ?? 0) >= 1) return;
    sources.set(source, 1);
    this.broadcastIfAgentActiveChanged(workspace);
  }

  private scopeSources(workspaceId: string, scope: string): Map<WorkspaceAttentionSource, number> {
    let scopes = this.activeAgentSources.get(workspaceId);
    if (!scopes) {
      scopes = new Map();
      this.activeAgentSources.set(workspaceId, scopes);
    }
    let sources = scopes.get(scope);
    if (!sources) {
      sources = new Map();
      scopes.set(scope, sources);
    }
    return sources;
  }

  /** Whether a source is in flight in a terminal's scope, or the workspace scope without one. */
  private hasActiveAgentSource(
    workspaceId: string,
    source: WorkspaceAttentionSource,
    terminalId?: string
  ): boolean {
    const scope = this.getAgentScope(terminalId);
    return (this.activeAgentSources.get(workspaceId)?.get(scope)?.get(source) ?? 0) > 0;
  }

  // Clear all in-flight counts for a source in the legacy workspace scope.
  // Terminal-scoped sources must be cleared by terminal id, so stale/unscoped
  // done events cannot stop an unrelated active terminal.
  private clearWorkspaceScopeSource(workspaceId: string, source: WorkspaceAttentionSource): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    const scopes = this.activeAgentSources.get(workspaceId);
    if (!scopes) return;

    const sources = scopes.get(WORKSPACE_AGENT_SCOPE);
    if (!sources) return;
    sources.delete(source);
    if (sources.size === 0) {
      scopes.delete(WORKSPACE_AGENT_SCOPE);
    }

    if (scopes.size === 0) {
      this.activeAgentSources.delete(workspaceId);
    }
    this.broadcastIfAgentActiveChanged(workspace);
  }

  /** Stops the spinner the user turned on by hand, leaving the broadcast to the caller. */
  private dropManualSource(workspaceId: string): void {
    const scopes = this.activeAgentSources.get(workspaceId);
    const sources = scopes?.get(WORKSPACE_AGENT_SCOPE);
    if (!scopes || !sources?.delete(MANUAL_SPINNER_SOURCE)) return;
    if (sources.size === 0) scopes.delete(WORKSPACE_AGENT_SCOPE);
    if (scopes.size === 0) this.activeAgentSources.delete(workspaceId);
  }

  private clearAllSources(workspaceId: string): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    this.activeAgentSources.delete(workspaceId);
    if (this.recomputeAgentActive(workspace)) {
      this.deps.store.broadcast(workspace);
    }
  }

  /**
   * Stops a tab's spinner because its agent stopped, was replaced or was interrupted here, and
   * tells the other installations showing the tab, which only see the agent's hooks.
   */
  private clearTerminalSources(
    workspaceId: string,
    terminalId: string,
    { keepCommand = false } = {}
  ): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    const scopes = this.activeAgentSources.get(workspaceId);
    if (!scopes) return;
    const terminalSources = scopes.get(terminalId);
    const commands = keepCommand ? terminalSources?.get(COMMAND_ATTENTION_SOURCE) : undefined;
    const sources = Array.from(terminalSources?.keys() ?? []).filter(
      (source) => commands === undefined || source !== COMMAND_ATTENTION_SOURCE
    );
    let removedTerminalScope: boolean;
    if (commands === undefined) {
      removedTerminalScope = scopes.delete(terminalId);
    } else {
      removedTerminalScope = sources.length > 0;
      scopes.set(terminalId, new Map([[COMMAND_ATTENTION_SOURCE, commands]]));
    }
    const removedWorkspaceScope = scopes.delete(WORKSPACE_AGENT_SCOPE);
    if (!removedTerminalScope && !removedWorkspaceScope) return;
    if (scopes.size === 0) {
      this.activeAgentSources.delete(workspaceId);
    }
    this.broadcastIfAgentActiveChanged(workspace);
    if (sources.length > 0) this.deps.relay.interrupted(workspace, terminalId, sources);
  }

  /** Stops one source's spinner in a terminal, leaving any other source there working. */
  private clearTerminalSource(
    workspaceId: string,
    terminalId: string,
    source: WorkspaceAttentionSource
  ): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    const scopes = this.activeAgentSources.get(workspaceId);
    const sources = scopes?.get(terminalId);
    if (!scopes || !sources?.delete(source)) return;
    if (sources.size === 0) scopes.delete(terminalId);
    if (scopes.size === 0) this.activeAgentSources.delete(workspaceId);
    this.broadcastIfAgentActiveChanged(workspace);
  }

  private clearTerminalSourcesOnly(workspaceId: string, terminalId: string): void {
    const workspace = this.deps.store.get(workspaceId);
    if (!workspace) return;
    const scopes = this.activeAgentSources.get(workspaceId);
    if (!scopes) return;
    if (!scopes.delete(terminalId)) return;
    if (scopes.size === 0) {
      this.activeAgentSources.delete(workspaceId);
    }
    this.broadcastIfAgentActiveChanged(workspace);
  }

  /**
   * Records whose hooks keep a tab's spinner on: this installation's own, or copies from the one
   * attached to the tab, which this one can't see interrupted.
   */
  private noteAgentHook(terminalId: string, copied: boolean): void {
    this.dropCopiedAgentActivity(terminalId);
    if (!copied || !this.getTerminal(terminalId)?.agentActive) return;
    const timer = setTimeout(() => {
      this.copiedAgentActivity.delete(terminalId);
      const workspace = this.findWorkspaceByTerminalId(terminalId);
      const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
      // Attached here since: this installation's own hooks and keystrokes keep its spinner right.
      if (!workspace || terminal?.status !== 'stopped') return;
      this.clearTerminalSourcesOnly(workspace.id, terminalId);
    }, COPIED_AGENT_ACTIVITY_TIMEOUT_MS);
    this.copiedAgentActivity.set(terminalId, timer);
  }

  /**
   * Stops the spinners that only another installation's hooks keep on, on one host or all of
   * them. Hooks aren't copied here while asleep or disconnected, so these may be stale; the
   * agent's next hook turns its spinner back on.
   */
  private forgetCopiedAgentActivity(hostId?: string): void {
    for (const terminalId of Array.from(this.copiedAgentActivity.keys())) {
      const workspace = this.findWorkspaceByTerminalId(terminalId);
      if (
        hostId &&
        !(workspace && isSshWorkspace(workspace) && workspace.backend.hostId === hostId)
      ) {
        continue;
      }
      this.dropCopiedAgentActivity(terminalId);
      if (workspace) this.clearTerminalSourcesOnly(workspace.id, terminalId);
    }
  }

  private dropCopiedAgentActivity(terminalId: string): void {
    clearTimeout(this.copiedAgentActivity.get(terminalId));
    this.copiedAgentActivity.delete(terminalId);
  }

  /** The Terminal's agent was interrupted just now; see isLateAgentActivity. */
  private noteInterrupt(terminalId: string, lateForMs = LATE_ACTIVITY_AFTER_INTERRUPT_MS): void {
    const until = Date.now() + lateForMs;
    this.lateActivityUntil.set(
      terminalId,
      Math.max(until, this.lateActivityUntil.get(terminalId) ?? 0)
    );
  }

  /**
   * Whether tool activity may be late news from a turn interrupted moments ago: hooks run in
   * the background, and over SSH they wait in a mailbox, so one can land after the interrupt.
   */
  private isLateAgentActivity(terminalId: string): boolean {
    return Date.now() < (this.lateActivityUntil.get(terminalId) ?? 0);
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  private findWorkspaceByTerminalId(terminalId: string): Workspace | undefined {
    for (const workspace of this.deps.store.workspaces()) {
      if (workspace.terminals.some((terminal) => terminal.id === terminalId)) return workspace;
    }
    return undefined;
  }

  private getTerminal(terminalId: string): Terminal | undefined {
    return this.findWorkspaceByTerminalId(terminalId)?.terminals.find(
      (terminal) => terminal.id === terminalId
    );
  }
}

/** Claude subagent completions and background-task notifications don't change what's shown. */
function isIgnoredHook(hook: AgentHook): boolean {
  const hookEventName = hook.hookInput?.hook_event_name;
  const notificationType = hook.hookInput?.notification_type;
  const isClaudeSubagentCompletion =
    typeof hook.hookInput?.agent_id === 'string' &&
    Boolean(hook.hookInput.agent_id) &&
    (hookEventName === 'Stop' ||
      hookEventName === 'SubagentStop' ||
      (hookEventName === undefined &&
        hook.hookInput.notification_type === undefined &&
        hook.kind === 'turn-complete'));
  const isIgnoredClaudeBackgroundNotification =
    notificationType === 'agent_needs_input' || notificationType === 'agent_completed';
  return (
    isSubagentLifecycle(hook) ||
    (hook.source === 'claude-code' &&
      (isClaudeSubagentCompletion || isIgnoredClaudeBackgroundNotification))
  );
}

// Claude's and Codex's Stop hooks, Codex's notify, and Gemini's AfterAgent carry the reply.
const AGENT_REPLY_FIELDS = ['last_assistant_message', 'last-assistant-message', 'prompt_response'];

// What a done says when its agent sent no reply: the stand-ins of the notify helper and of
// OpenCode's plugin, and PostCompact's.
const STAND_IN_DONE_MESSAGES = new Set([
  'Claude finished',
  'Agent finished',
  'OpenCode finished',
  'Compacted the conversation',
]);

/** The reply in an agent's done hook, or else the done's message unless it is a stand-in. */
function agentReply(hook: AgentHook): string | undefined {
  const reply = replyField(hook);
  if (reply) return reply;
  const message = hook.message?.trim();
  // The companion names the event when nothing else does.
  if (!message || message === hook.hookInput?.hook_event_name) return undefined;
  return STAND_IN_DONE_MESSAGES.has(message) ? undefined : message;
}

function replyField(hook: AgentHook): string | undefined {
  for (const field of AGENT_REPLY_FIELDS) {
    const value = hook.hookInput?.[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function buildAttention(hook: AgentHook, terminalId: string | undefined): WorkspaceAttention {
  return {
    kind: attentionKind(hook),
    source: toAttentionSource(hook.source),
    updatedAt: Date.now(),
    title: hook.title,
    body: hook.body,
    color: hook.color,
    ...(hook.badge ? { badge: hook.badge } : {}),
    ...(hook.icon ? { icon: hook.icon } : {}),
    ...(hook.iconColor ? { iconColor: hook.iconColor } : {}),
    message: hook.message,
    ...(terminalId ? { terminalId } : {}),
  };
}

function attentionKind(hook: AgentHook): WorkspaceAttentionKind {
  // 'prompt-submit' is handled before buildAttention is reached, but exclude it
  // here too so the type system reflects what can actually appear in attention.
  if (
    hook.kind &&
    hook.kind !== 'prompt-submit' &&
    hook.kind !== 'activity' &&
    hook.kind !== 'interrupted'
  ) {
    return hook.kind;
  }

  const level = hook.level?.toLowerCase();
  const message = hook.message?.toLowerCase();

  if (level === 'error' || message?.includes('error') || message?.includes('failed')) {
    return 'error';
  }

  return 'generic';
}
