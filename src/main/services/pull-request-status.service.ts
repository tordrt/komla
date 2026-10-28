import { homedir } from 'os';

import { CI_WATCH_LIMIT_MS, notifiesCiFinished } from '../../shared/lib/pull-request-ci';
import {
  normalizeWorkspaceTags,
  pullRequestTagState,
  type PullRequestTagState,
  type WorkspaceTagDefinition,
} from '../../shared/lib/workspace-tags';
import { COMMAND_ATTENTION_SOURCE, isSshWorkspace } from '../../shared/types/workspace';
import { gitRemoteIdentity } from '../lib/git-remote-identity';
import { MISSING_COMMAND_ERROR } from '../lib/missing-command';

import { configService } from './config.service';
import { canRunWorkspaceCommands, runLocalCommand, runWorkspaceCommand } from './workspace-command';
import { workspaceService } from './workspace.service';

import type { AgentHook } from './terminal-attention/terminal-attention';
import type {
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestCiState,
  PullRequestStatus,
  PullRequestSummary,
} from '../../shared/types/pull-request';
import type { Workspace } from '../../shared/types/workspace';
import type { WorkspaceObservationProjection } from '../../shared/types/workspace-observation';

// Quoted: PowerShell would pass a bare comma list as separate arguments.
const PULL_REQUEST_FIELDS =
  '--json "number,title,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup"';
export const PULL_REQUEST_COMMAND = `gh pr view ${PULL_REQUEST_FIELDS}`;
/** Read literally between double quotes by every shell Komla runs commands in. */
const PLAIN_ARGUMENT = /^[\w./#+-]+$/;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 256 * 1024;
/** A read this recent, or still running, is shared with the next caller. */
const FRESH_MS = 5_000;
/** How often a workspace whose checks run is read again, to say when they finish. */
export const WATCH_INTERVAL_MS = 30_000;
/** How long after a push its checks have to start. */
export const PUSH_WAIT_MS = 3 * 60_000;
/** How often each pushed worktree's pull request is read, while workspaces are tagged from them. */
export const TAG_READ_INTERVAL_MS = 5 * 60_000;
/** How often tagging checks whether it was turned on or off, or reads are due. */
const TAG_TICK_MS = 60_000;

/** A check run or commit status in `gh pr view`'s statusCheckRollup. */
interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  headRefOid?: string;
  statusCheckRollup?: GhCheck[] | null;
}

function checkState(check: GhCheck): PullRequestCheckState {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'passed';
    return check.state === 'FAILURE' || check.state === 'ERROR' ? 'failed' : 'pending';
  }
  if (check.status !== 'COMPLETED') return 'pending';
  switch (check.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
      return 'passed';
    case 'SKIPPED':
    case 'STALE':
      return 'skipped';
    default:
      return 'failed';
  }
}

function toCheck(check: GhCheck): PullRequestCheck {
  const name = check.name || check.context || 'Check';
  return {
    name:
      check.workflowName && check.workflowName !== name ? `${check.workflowName} / ${name}` : name,
    state: checkState(check),
    url: check.detailsUrl || check.targetUrl || undefined,
  };
}

/** Failed once a check fails, as `gh pr checks --fail-fast` stops, else pending while one runs. */
export function ciState(checks: readonly PullRequestCheck[]): PullRequestCiState {
  if (checks.length === 0) return 'none';
  if (checks.some((check) => check.state === 'failed')) return 'failed';
  return checks.some((check) => check.state === 'pending') ? 'pending' : 'passed';
}

/** The pull request in `gh pr view --json`'s output, and the commit its checks ran on. */
export function parsePullRequest(output: string): {
  pullRequest: PullRequestSummary;
  head?: string;
} {
  const pr = JSON.parse(output) as GhPullRequest;
  const checks = (pr.statusCheckRollup ?? []).map(toCheck);
  return {
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state:
        pr.state === 'MERGED'
          ? 'merged'
          : pr.state === 'CLOSED'
            ? 'closed'
            : pr.isDraft
              ? 'draft'
              : 'open',
      review:
        pr.reviewDecision === 'APPROVED'
          ? 'approved'
          : pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'changes-requested'
            : pr.reviewDecision === 'REVIEW_REQUIRED'
              ? 'required'
              : undefined,
      ci: ciState(checks),
      checks,
    },
    head: pr.headRefOid,
  };
}

/** The repository on GitHub, or GitHub Enterprise Cloud, that a remote URL names. */
export function gitHubRepository(url: string): string | undefined {
  const parts = gitRemoteIdentity(url).split('/');
  const [host] = parts;
  if (host !== 'github.com' && !host.endsWith('.ghe.com')) return undefined;
  return parts.length === 3 && parts.every((part) => PLAIN_ARGUMENT.test(part))
    ? parts.join('/')
    : undefined;
}

/**
 * Reads a branch's pull request by name, where no checkout of it is. A bare branch name matches
 * only pull requests from the repository's own branches, never a fork's branch of the same name.
 */
export function pullRequestCommandForBranch(repository: string, branch: string): string {
  return `gh pr view "${branch}" --repo "${repository}" ${PULL_REQUEST_FIELDS}`;
}

/** What `gh` failing says about the branch's pull request. */
export function statusForError(error: unknown): PullRequestStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /no pull requests found|none of the git remotes|no git remotes|not a git repository|could not determine|not on any branch/i.test(
      message
    )
  ) {
    return { kind: 'none' };
  }
  if (/gh auth login|GH_TOKEN|not logged in/i.test(message)) {
    return { kind: 'unavailable', reason: 'signed-out' };
  }
  if (MISSING_COMMAND_ERROR.test(message)) {
    return { kind: 'unavailable', reason: 'no-gh' };
  }
  return { kind: 'unavailable', reason: 'error', message };
}

/** The workspace's notification that its pull request's checks finished. */
export function ciFinishedNotification(pullRequest: PullRequestSummary): AgentHook {
  const passed = pullRequest.ci === 'passed';
  const failed = pullRequest.checks.filter((check) => check.state === 'failed').map((c) => c.name);
  const named = failed.slice(0, 2).join(', ');
  return {
    cwd: '',
    kind: passed ? 'turn-complete' : 'error',
    source: COMMAND_ATTENTION_SOURCE,
    title: passed ? 'CI passed' : 'CI failed',
    body: passed
      ? `#${pullRequest.number} ${pullRequest.title}`
      : `${named}${failed.length > 2 ? ` and ${failed.length - 2} more` : ''} · #${pullRequest.number}`,
    badge: 'CI',
    color: passed ? 'success' : 'error',
    // A failure ends the run's turn, as a StopFailure does.
    hookInput: { hook_event_name: passed ? 'Stop' : 'StopFailure' },
  };
}

/** What one run of `gh pr view` said, and the commit its checks ran on. */
interface GhRead {
  status: PullRequestStatus;
  head?: string;
  /** gh found none of the repository's remotes on a GitHub host, so it never has a pull request. */
  offGitHub?: boolean;
  /** gh found the branch and said it has no pull request, rather than that it couldn't tell. */
  noPullRequest?: boolean;
}

async function readGh(run: () => Promise<string>): Promise<GhRead> {
  try {
    const { pullRequest, head } = parsePullRequest(await run());
    return { status: { kind: 'pull-request', pullRequest }, head };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        status: { kind: 'unavailable', reason: 'error', message: 'gh printed no pull request' },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: statusForError(error),
      ...(/none of the git remotes|no git remotes/i.test(message) ? { offGitHub: true } : {}),
      ...(/no pull requests found/i.test(message) ? { noPullRequest: true } : {}),
    };
  }
}

export interface PullRequestStatusDependencies {
  getWorkspace(workspaceId: string): Workspace | undefined;
  listWorkspaces(): Workspace[];
  canRun(workspace: Workspace): boolean;
  run(workspace: Workspace, command: string, timeoutMs: number, maxOutput: number): Promise<string>;
  /** Runs a command on this computer, outside any workspace. */
  runLocal(command: string, timeoutMs: number, maxOutput: number): Promise<string>;
  /** Whether the end of a pull request's checks notifies its workspace. */
  notifiesCiFinished(): boolean;
  notify(workspace: Workspace, hook: AgentHook): void;
  /** Whether workspaces are tagged from their pull requests, such as "Waiting for review". */
  tagsFromPullRequests(): boolean;
  /** The user's tags, which say which one each pull request state puts on. */
  workspaceTags(): readonly WorkspaceTagDefinition[];
  /** Tags the workspace for where its pull request stands, or takes that tag off. */
  applyPullRequestTag(workspaceId: string, state: PullRequestTagState | undefined): void;
  now(): number;
}

interface Watch {
  timer: ReturnType<typeof setInterval>;
  until: number;
  /**
   * Set after a push, until its checks show: the commit the pull request had before it, or null
   * when that wasn't read, so the first commit whose checks finish counts.
   */
  awaitingChecksAfter?: string | null;
}

/**
 * The pull request of each workspace's branch, read with the GitHub CLI where the workspace's
 * commands run. An SSH workspace on GitHub is read here first, by its branch's name, so its host
 * needs no gh of its own; the host reads what that misses. While its checks run, or after a push
 * until they start, it reads them again every half minute, to notify the workspace when they
 * finish.
 */
export class PullRequestStatusService {
  private readonly reads = new Map<string, { at?: number; status: Promise<PullRequestStatus> }>();
  /** The last checks seen on each workspace's open pull request. */
  private readonly seen = new Map<string, { ci: PullRequestCiState; head?: string }>();
  private readonly watches = new Map<string, Watch>();
  private readonly branches = new Map<string, WorkspaceObservationProjection['branch']>();
  /** Workspaces whose repository isn't on GitHub, which tagging stops reading until a restart. */
  private readonly offGitHub = new Set<string>();
  private tagTimer?: ReturnType<typeof setInterval>;
  private tagging = false;
  /** A round of tag reads is running, which a slow one can make outlast the interval. */
  private readingTags = false;
  private lastTagReadAt = 0;

  constructor(private readonly dependencies: PullRequestStatusDependencies) {}

  get(workspaceId: string): Promise<PullRequestStatus> {
    this.forgetDeletedWorkspaces();
    const recent = this.reads.get(workspaceId);
    if (recent && (recent.at === undefined || this.dependencies.now() - recent.at < FRESH_MS)) {
      return recent.status;
    }
    const entry: { at?: number; status: Promise<PullRequestStatus> } = {
      status: this.read(workspaceId).finally(() => {
        entry.at = this.dependencies.now();
      }),
    };
    this.reads.set(workspaceId, entry);
    return entry.status;
  }

  /** Follows a workspace's branch, to watch its checks once a push starts them. */
  observeBranch({ workspaceId, branch }: WorkspaceObservationProjection): void {
    this.forgetDeletedWorkspaces();
    const previous = this.branches.get(workspaceId);
    this.branches.set(workspaceId, branch);
    if (!previous || previous.currentBranch !== branch.currentBranch) return;
    const pushed =
      branch.hasRemote &&
      branch.unpushedCommits === 0 &&
      (!previous.hasRemote || previous.unpushedCommits > 0);
    // The item shows only for worktrees, so folder workspaces aren't watched.
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!pushed || !workspace?.isWorktree) return;
    // A push may come with a new pull request, also to a repository that just got its remote.
    this.offGitHub.delete(workspaceId);
    if (this.tagging && this.readsForTag(workspace)) {
      void this.readForTag(workspace).catch(() => undefined);
    }
    if (!this.dependencies.notifiesCiFinished()) return;
    const watch = this.watch(workspaceId, PUSH_WAIT_MS);
    watch.awaitingChecksAfter = this.seen.get(workspaceId)?.head ?? null;
  }

  /**
   * Reads each pushed worktree's pull request every few minutes while workspaces are tagged from
   * them, and takes those tags off once that's turned off.
   */
  startTagging(): void {
    if (this.tagTimer) return;
    this.tagTimer = setInterval(() => void this.tickTagging(), TAG_TICK_MS);
    this.tagTimer.unref?.();
  }

  dispose(): void {
    for (const workspaceId of this.watches.keys()) this.unwatch(workspaceId);
    if (this.tagTimer) clearInterval(this.tagTimer);
    this.tagTimer = undefined;
  }

  private async tickTagging(): Promise<void> {
    const tagging = this.dependencies.tagsFromPullRequests();
    const turnedOn = tagging && !this.tagging;
    this.tagging = tagging;
    if (!tagging) {
      // Also after a restart, so tags from before it was turned off don't stay.
      for (const workspace of this.dependencies.listWorkspaces()) {
        if (workspace.pullRequestState === undefined) continue;
        this.dependencies.applyPullRequestTag(workspace.id, undefined);
      }
      return;
    }
    const now = this.dependencies.now();
    if (this.readingTags) return;
    if (!turnedOn && now - this.lastTagReadAt < TAG_READ_INTERVAL_MS) return;
    this.lastTagReadAt = now;
    this.readingTags = true;
    try {
      // One at a time, so a dozen worktrees don't start a dozen gh processes at once.
      for (const workspace of this.dependencies.listWorkspaces()) {
        if (!this.readsForTag(workspace)) continue;
        await this.readForTag(workspace).catch(() => undefined);
      }
    } finally {
      this.readingTags = false;
    }
  }

  /**
   * A worktree in use whose branch may have a pull request: pushed or not seen yet, or still
   * tagged from one, so the tag comes off once it's merged even if the branch left the remote.
   * None is read once the user deleted the tags pull requests would put on.
   */
  private readsForTag(workspace: Workspace): boolean {
    return (
      !!workspace.isWorktree &&
      workspace.status === 'active' &&
      !this.offGitHub.has(workspace.id) &&
      (this.branches.get(workspace.id)?.hasRemote !== false ||
        workspace.pullRequestState !== undefined) &&
      this.dependencies.workspaceTags().some((tag) => tag.pullRequestState)
    );
  }

  /**
   * Tags a workspace from its pull request. Unlike `get`, it doesn't follow the checks, so tagging
   * starts no CI watch or notification for workspaces the user never looked at.
   */
  private async readForTag(workspace: Workspace): Promise<void> {
    const recent = this.reads.get(workspace.id);
    if (recent && (recent.at === undefined || this.dependencies.now() - recent.at < FRESH_MS)) {
      await recent.status; // That read tags it.
      return;
    }
    const read = await this.readHereOrOnHost(workspace);
    // Asking again every few minutes, on an SSH host over SSH, would only get the same answer.
    if (read.offGitHub) this.offGitHub.add(workspace.id);
    this.tagFrom(workspace.id, read);
  }

  private tagFrom(workspaceId: string, read: GhRead): void {
    if (!this.dependencies.tagsFromPullRequests()) return;
    if (read.status.kind === 'pull-request') {
      this.dependencies.applyPullRequestTag(
        workspaceId,
        pullRequestTagState(read.status.pullRequest)
      );
    } else if (read.noPullRequest) {
      this.dependencies.applyPullRequestTag(workspaceId, undefined);
    }
    // Anything else, such as gh unsure of the branch mid-rebase, says nothing about the tag.
  }

  private forgetDeletedWorkspaces(): void {
    for (const map of [this.reads, this.seen, this.branches, this.watches, this.offGitHub]) {
      for (const workspaceId of map.keys()) {
        if (this.dependencies.getWorkspace(workspaceId)) continue;
        this.unwatch(workspaceId);
        map.delete(workspaceId);
      }
    }
  }

  private async read(workspaceId: string): Promise<PullRequestStatus> {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) return { kind: 'none' };
    const read = await this.readHereOrOnHost(workspace);
    if (read.status.kind === 'pull-request') {
      this.follow(workspace, read.status.pullRequest, read.head);
    } else if (read.status.kind === 'none') {
      this.follow(workspace, undefined);
    }
    this.tagFrom(workspace.id, read);
    return read.status;
  }

  private async readHereOrOnHost(workspace: Workspace): Promise<GhRead> {
    const localCommand = this.localCommand(workspace);
    const local = localCommand
      ? await readGh(() => this.dependencies.runLocal(localCommand, COMMAND_TIMEOUT_MS, MAX_OUTPUT))
      : undefined;
    if (local?.status.kind === 'pull-request') return local;
    if (!this.dependencies.canRun(workspace)) {
      // Without the host, a branch found by name alone may still have a pull request from a fork.
      if (local) return { ...local, noPullRequest: false };
      return {
        status: { kind: 'unavailable', reason: 'error', message: 'The SSH host is not connected' },
      };
    }
    // The host's checkout knows what a name can't say: a fork's upstream, a renamed remote branch.
    const host = await readGh(() =>
      this.dependencies.run(workspace, PULL_REQUEST_COMMAND, COMMAND_TIMEOUT_MS, MAX_OUTPUT)
    );
    return !local || host.status.kind === 'pull-request' || local.status.kind === 'unavailable'
      ? host
      : local;
  }

  /** For an SSH workspace on GitHub, the command that reads its branch's pull request here. */
  private localCommand(workspace: Workspace): string | undefined {
    if (!isSshWorkspace(workspace)) return undefined;
    const repository = gitHubRepository(workspace.backend.gitUrl);
    const observed = this.branches.get(workspace.id);
    // Until the host reports the branch checked out, the one the workspace was made on.
    const branch = observed ? observed.currentBranch : workspace.branchName;
    // gh takes a number, or #number, for a pull request's, and HEAD is a detached checkout.
    const usable =
      branch && branch !== 'HEAD' && !/^#?\d+$/.test(branch) && PLAIN_ARGUMENT.test(branch);
    return repository && usable ? pullRequestCommandForBranch(repository, branch) : undefined;
  }

  private follow(workspace: Workspace, pullRequest?: PullRequestSummary, head?: string): void {
    const open = pullRequest?.state === 'open' || pullRequest?.state === 'draft';
    const previous = this.seen.get(workspace.id);
    if (open) this.seen.set(workspace.id, { ci: pullRequest.ci, head });
    else this.seen.delete(workspace.id);
    if (!this.dependencies.notifiesCiFinished()) return;

    const watch = this.watches.get(workspace.id);
    const finished = open && (pullRequest.ci === 'passed' || pullRequest.ci === 'failed');
    // The pushed commit can show before GitHub queues its checks; the watch waits for them.
    const pushedCommitFinished =
      finished &&
      watch?.awaitingChecksAfter !== undefined &&
      head !== undefined &&
      head !== watch.awaitingChecksAfter;
    if (finished && (previous?.ci === 'pending' || pushedCommitFinished)) {
      this.dependencies.notify(workspace, ciFinishedNotification(pullRequest));
    }
    this.updateWatch(workspace.id, open && pullRequest.ci === 'pending', pushedCommitFinished);
  }

  // Running checks are watched for a few hours; checks a push should start, until they show.
  private updateWatch(workspaceId: string, running: boolean, pushedCommitFinished: boolean): void {
    const watch = this.watches.get(workspaceId);
    if (running) {
      if (!watch || watch.awaitingChecksAfter !== undefined) {
        this.watch(workspaceId, CI_WATCH_LIMIT_MS).awaitingChecksAfter = undefined;
      }
    } else if (
      watch &&
      (watch.awaitingChecksAfter === undefined ||
        pushedCommitFinished ||
        this.dependencies.now() > watch.until)
    ) {
      this.unwatch(workspaceId);
    }
  }

  private watch(workspaceId: string, forMs: number): Watch {
    const until = this.dependencies.now() + forMs;
    const existing = this.watches.get(workspaceId);
    if (existing) {
      existing.until = until;
      return existing;
    }
    const timer = setInterval(() => this.tick(workspaceId), WATCH_INTERVAL_MS);
    timer.unref?.();
    const watch: Watch = { timer, until };
    this.watches.set(workspaceId, watch);
    return watch;
  }

  private tick(workspaceId: string): void {
    const watch = this.watches.get(workspaceId);
    if (!watch) return;
    if (
      !this.dependencies.getWorkspace(workspaceId) ||
      !this.dependencies.notifiesCiFinished() ||
      this.dependencies.now() > watch.until
    ) {
      this.unwatch(workspaceId);
      return;
    }
    void this.get(workspaceId);
  }

  private unwatch(workspaceId: string): void {
    const watch = this.watches.get(workspaceId);
    if (!watch) return;
    clearInterval(watch.timer);
    this.watches.delete(workspaceId);
  }
}

export const pullRequestStatusService = new PullRequestStatusService({
  getWorkspace: (id) => workspaceService.get(id),
  listWorkspaces: () => workspaceService.list(),
  canRun: canRunWorkspaceCommands,
  run: (workspace, command, timeoutMs, maxOutput) =>
    runWorkspaceCommand(workspace, command, { timeoutMs, maxOutput }),
  runLocal: (command, timeoutMs, maxOutput) =>
    runLocalCommand(homedir(), command, { timeoutMs, maxOutput }),
  notifiesCiFinished: () => notifiesCiFinished(configService.get()),
  notify: (workspace, hook) => workspaceService.notifyWorkspace(workspace, hook),
  tagsFromPullRequests: () => configService.get().tagsFromPullRequests === true,
  workspaceTags: () => normalizeWorkspaceTags(configService.get().workspaceTags),
  applyPullRequestTag: (workspaceId, tag) => workspaceService.applyPullRequestTag(workspaceId, tag),
  now: Date.now,
});
