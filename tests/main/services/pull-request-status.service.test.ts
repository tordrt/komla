import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/config.service', () => ({ configService: {} }));
vi.mock('../../../src/main/services/workspace-command', () => ({
  canRunWorkspaceCommands: vi.fn(),
  runWorkspaceCommand: vi.fn(),
}));
vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: {} }));

import {
  gitHubRepository,
  parsePullRequest,
  PULL_REQUEST_COMMAND,
  pullRequestCommandForBranch,
  PUSH_WAIT_MS,
  PullRequestStatusService,
  statusForError,
  TAG_READ_INTERVAL_MS,
  WATCH_INTERVAL_MS,
} from '../../../src/main/services/pull-request-status.service';
import {
  normalizeWorkspaceTags,
  type PullRequestTagState,
  type WorkspaceTagDefinition,
} from '../../../src/shared/lib/workspace-tags';
import { isSshWorkspace, type Workspace } from '../../../src/shared/types/workspace';
import { createSshWorkspace, createWorkspace } from '../../factories';

import type { BranchStatus } from '../../../src/shared/types/workspace-observation';

const checkRun = (name: string, status: string, conclusion = '') => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/app/actions/runs/1/${name}`,
});

function ghOutput(checks: object[], overrides: object = {}): string {
  return JSON.stringify({
    number: 12,
    title: 'Add search',
    url: 'https://github.com/acme/app/pull/12',
    state: 'OPEN',
    isDraft: false,
    headRefOid: 'aaa',
    statusCheckRollup: checks,
    ...overrides,
  });
}

const running = ghOutput([
  checkRun('test', 'IN_PROGRESS'),
  checkRun('lint', 'COMPLETED', 'SUCCESS'),
]);
const passed = ghOutput([checkRun('test', 'COMPLETED', 'SUCCESS')]);
const failed = ghOutput([
  checkRun('test', 'COMPLETED', 'FAILURE'),
  checkRun('lint', 'COMPLETED', 'SUCCESS'),
]);

function branch(overrides: Partial<BranchStatus>): BranchStatus {
  return {
    currentBranch: 'feature/search',
    targetBranch: 'main',
    aheadTargetBranch: 1,
    behindTargetBranch: 0,
    hasRemote: true,
    hasOriginRemote: true,
    unpushedCommits: 0,
    behindRemote: 0,
    targetBranchHasRemote: true,
    targetBranchAheadRemote: 0,
    targetBranchBehindRemote: 0,
    ...overrides,
  };
}

describe('parsePullRequest', () => {
  it('reads check runs and commit statuses into one state', () => {
    const { pullRequest, head } = parsePullRequest(
      ghOutput([
        checkRun('build', 'COMPLETED', 'SUCCESS'),
        checkRun('docs', 'COMPLETED', 'SKIPPED'),
        {
          __typename: 'StatusContext',
          context: 'deploy',
          state: 'PENDING',
          targetUrl: 'https://ci',
        },
      ])
    );

    expect(head).toBe('aaa');
    expect(pullRequest).toEqual({
      number: 12,
      title: 'Add search',
      url: 'https://github.com/acme/app/pull/12',
      state: 'open',
      ci: 'pending',
      checks: [
        {
          name: 'CI / build',
          state: 'passed',
          url: 'https://github.com/acme/app/actions/runs/1/build',
        },
        {
          name: 'CI / docs',
          state: 'skipped',
          url: 'https://github.com/acme/app/actions/runs/1/docs',
        },
        { name: 'deploy', state: 'pending', url: 'https://ci' },
      ],
    });
  });

  it('fails as soon as one check fails, and has no state without checks', () => {
    expect(
      parsePullRequest(
        ghOutput([checkRun('test', 'COMPLETED', 'TIMED_OUT'), checkRun('lint', 'QUEUED')])
      ).pullRequest.ci
    ).toBe('failed');
    expect(parsePullRequest(ghOutput([], { statusCheckRollup: null })).pullRequest.ci).toBe('none');
  });

  it('tells drafts, merged and closed pull requests apart', () => {
    const state = (overrides: object) =>
      parsePullRequest(ghOutput([], overrides)).pullRequest.state;
    expect(state({ isDraft: true })).toBe('draft');
    expect(state({ state: 'MERGED' })).toBe('merged');
    expect(state({ state: 'CLOSED' })).toBe('closed');
  });

  it("reads its reviewers' decision, none where no review is required", () => {
    const review = (reviewDecision: unknown) =>
      parsePullRequest(ghOutput([], { reviewDecision })).pullRequest.review;
    expect(review('REVIEW_REQUIRED')).toBe('required');
    expect(review('APPROVED')).toBe('approved');
    expect(review('CHANGES_REQUESTED')).toBe('changes-requested');
    expect(review('')).toBeUndefined();
    expect(review(null)).toBeUndefined();
  });
});

describe('gitHubRepository', () => {
  it.each([
    ['https://github.com/Acme/App.git', 'github.com/acme/app'],
    ['git@github.com:Acme/App.git', 'github.com/acme/app'],
    ['ssh://git@GitHub.com:22/acme/app/', 'github.com/acme/app'],
    ['https://token@github.com/acme/my.app', 'github.com/acme/my.app'],
    ['git@acme.ghe.com:acme/app.git', 'acme.ghe.com/acme/app'],
  ])('reads %s', (url, repository) => {
    expect(gitHubRepository(url)).toBe(repository);
  });

  it.each([
    'git@gitlab.com:acme/app.git',
    'https://ghe.example.com/acme/app',
    'https://github.com/acme/app/extra',
    '/srv/git/app.git',
    'git@github.com:acme/$(touch x).git',
    'https://$(touch x).ghe.com/acme/app',
    'git@`id`.ghe.com:acme/app.git',
  ])('has none for %s', (url) => {
    expect(gitHubRepository(url)).toBeUndefined();
  });
});

describe('pullRequestCommandForBranch', () => {
  it('names the branch and its repository', () => {
    expect(pullRequestCommandForBranch('github.com/Acme/app', 'feature/search')).toBe(
      'gh pr view "feature/search" --repo "github.com/Acme/app" --json "number,title,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup"'
    );
  });
});

describe('statusForError', () => {
  it.each([
    ['no pull requests found for branch "feature/search"', { kind: 'none' }],
    [
      'none of the git remotes configured for this repository point to a known GitHub host',
      { kind: 'none' },
    ],
    [
      'To get started with GitHub CLI, please run:  gh auth login',
      { kind: 'unavailable', reason: 'signed-out' },
    ],
    ['zsh:1: command not found: gh', { kind: 'unavailable', reason: 'no-gh' }],
    [
      "gh : The term 'gh' is not recognized as the name of a cmdlet",
      { kind: 'unavailable', reason: 'no-gh' },
    ],
    ['fish: Unknown command: gh', { kind: 'unavailable', reason: 'no-gh' }],
    ['spawn gh ENOENT', { kind: 'unavailable', reason: 'no-gh' }],
    // gh is there; GitHub can't see the repository.
    [
      'HTTP 404: Not Found (https://api.github.com/graphql)',
      {
        kind: 'unavailable',
        reason: 'error',
        message: 'HTTP 404: Not Found (https://api.github.com/graphql)',
      },
    ],
    ['HTTP 502', { kind: 'unavailable', reason: 'error', message: 'HTTP 502' }],
  ])('reads %j', (message, status) => {
    expect(statusForError(new Error(message))).toEqual(status);
  });
});

describe('PullRequestStatusService', () => {
  let workspace: Workspace;
  let notifies: boolean;
  let output: string | Error;
  const run = vi.fn(async () => {
    if (output instanceof Error) throw output;
    return output;
  });
  let localOutput: string | Error;
  const runLocal = vi.fn(async () => {
    if (localOutput instanceof Error) throw localOutput;
    return localOutput;
  });
  let canRun: boolean;
  const notify = vi.fn();
  let tagging: boolean;
  let tags: WorkspaceTagDefinition[];
  const applyPullRequestTag = vi.fn((_id: string, state: PullRequestTagState | undefined) => {
    workspace.pullRequestState = state;
  });
  let service: PullRequestStatusService;

  beforeEach(() => {
    vi.useFakeTimers();
    workspace = createWorkspace({ id: 'ws-1' });
    notifies = true;
    output = running;
    localOutput = passed;
    canRun = true;
    tagging = false;
    tags = normalizeWorkspaceTags(undefined);
    run.mockClear();
    runLocal.mockClear();
    notify.mockClear();
    applyPullRequestTag.mockClear();
    service = new PullRequestStatusService({
      getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
      listWorkspaces: () => [workspace],
      canRun: () => canRun,
      run,
      runLocal,
      notifiesCiFinished: () => notifies,
      notify,
      tagsFromPullRequests: () => tagging,
      workspaceTags: () => tags,
      applyPullRequestTag,
      now: Date.now,
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  // Past the time a read is shared with the next caller.
  const later = () => vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);

  it('reads the pull request with gh where the workspace runs commands', async () => {
    await expect(service.get('ws-1')).resolves.toEqual({
      kind: 'pull-request',
      pullRequest: expect.objectContaining({ number: 12, ci: 'pending' }),
    });
    expect(run).toHaveBeenCalledWith(workspace, PULL_REQUEST_COMMAND, 15_000, 256 * 1024);
  });

  it('shares a read still running, or just made, with the next caller', async () => {
    await Promise.all([service.get('ws-1'), service.get('ws-1')]);
    await service.get('ws-1');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('notifies the workspace once when checks it saw running pass', async () => {
    await service.get('ws-1');
    output = passed;
    await later();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        kind: 'turn-complete',
        source: 'command',
        title: 'CI passed',
        body: '#12 Add search',
        badge: 'CI',
        color: 'success',
      })
    );

    await later();
    await service.get('ws-1');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('names the failed checks when they fail', async () => {
    await service.get('ws-1');
    output = failed;
    await later();

    expect(notify).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        kind: 'error',
        title: 'CI failed',
        body: 'CI / test · #12',
        color: 'error',
      })
    );
  });

  it('keeps reading running checks every half minute, and stops once they finish', async () => {
    await service.get('ws-1');
    await later();
    await later();
    expect(run).toHaveBeenCalledTimes(3);

    output = passed;
    await later();
    await later();
    await later();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('neither notifies nor watches while its notifications are off', async () => {
    notifies = false;
    await service.get('ws-1');
    output = passed;
    await later();
    await service.get('ws-1');

    expect(run).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("doesn't notify for checks that had already finished when first seen", async () => {
    output = passed;
    await service.get('ws-1');

    expect(notify).not.toHaveBeenCalled();
  });

  it('watches after a push until its checks finish, even unseen while they run', async () => {
    output = passed;
    await service.get('ws-1');
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({ unpushedCommits: 1 }) } as never);
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);

    // The pull request still has the commit from before the push.
    await later();
    expect(notify).not.toHaveBeenCalled();

    output = ghOutput([checkRun('test', 'COMPLETED', 'SUCCESS')], { headRefOid: 'bbb' });
    await later();
    expect(notify).toHaveBeenCalledWith(workspace, expect.objectContaining({ title: 'CI passed' }));
    await later();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('notifies checks that finished before the first look after a push, never read before', async () => {
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({ unpushedCommits: 1 }) } as never);
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);

    output = ghOutput([checkRun('test', 'COMPLETED', 'SUCCESS')], { headRefOid: 'bbb' });
    await later();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(workspace, expect.objectContaining({ title: 'CI passed' }));
  });

  it('keeps watching a pushed commit that shows before its checks do', async () => {
    output = passed;
    await service.get('ws-1');
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({ unpushedCommits: 1 }) } as never);
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);

    // GitHub hasn't queued the new commit's checks yet.
    output = ghOutput([], { headRefOid: 'bbb' });
    await later();
    output = ghOutput([checkRun('test', 'IN_PROGRESS')], { headRefOid: 'bbb' });
    await later();
    output = ghOutput([checkRun('test', 'COMPLETED', 'FAILURE')], { headRefOid: 'bbb' });
    await later();

    expect(notify).toHaveBeenCalledWith(workspace, expect.objectContaining({ title: 'CI failed' }));
  });

  it("doesn't watch a folder workspace's push, where the item never shows", async () => {
    workspace = createWorkspace({ id: 'ws-1', isWorktree: false });
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({ unpushedCommits: 1 }) } as never);
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);
    await later();

    expect(run).not.toHaveBeenCalled();
  });

  it('forgets a deleted workspace', async () => {
    await service.get('ws-1');
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);
    workspace = createWorkspace({ id: 'ws-2' });
    service.observeBranch({ workspaceId: 'ws-2', branch: branch({}) } as never);

    const kept = service as unknown as Record<
      'reads' | 'seen' | 'branches' | 'watches',
      Map<string, unknown>
    >;
    for (const map of [kept.reads, kept.seen, kept.branches, kept.watches]) {
      expect(map.has('ws-1')).toBe(false);
    }
    await later();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for checks a push never started', async () => {
    output = new Error('no pull requests found for branch "feature/search"');
    service.observeBranch({
      workspaceId: 'ws-1',
      branch: branch({ hasRemote: false, unpushedCommits: 0 }),
    } as never);
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);

    await vi.advanceTimersByTimeAsync(PUSH_WAIT_MS + 2 * WATCH_INTERVAL_MS);
    const reads = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * WATCH_INTERVAL_MS);

    expect(reads).toBeGreaterThan(0);
    expect(run).toHaveBeenCalledTimes(reads);
  });

  it("doesn't take switching branches for a push", async () => {
    service.observeBranch({
      workspaceId: 'ws-1',
      branch: branch({ currentBranch: 'other', unpushedCommits: 2 }),
    } as never);
    service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);
    await later();

    expect(run).not.toHaveBeenCalled();
  });

  it('says the SSH host is not connected instead of running gh', async () => {
    canRun = false;

    await expect(service.get('ws-1')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'error',
      message: 'The SSH host is not connected',
    });
    expect(run).not.toHaveBeenCalled();
  });

  describe('tagging workspaces from their pull requests', () => {
    beforeEach(() => {
      workspace.isWorktree = true;
      notifies = false;
      output = ghOutput([], { reviewDecision: 'CHANGES_REQUESTED' });
    });

    it('tags a workspace as its pull request calls for, only while turned on', async () => {
      await service.get('ws-1');
      expect(applyPullRequestTag).not.toHaveBeenCalled();

      tagging = true;
      await later();
      await service.get('ws-1');
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', 'needs-changes');

      output = new Error('no pull requests found for branch "feature/search"');
      await later();
      await service.get('ws-1');
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', undefined);
    });

    it("leaves the tag alone when gh can't read the pull request", async () => {
      tagging = true;
      output = new Error('gh auth login');

      await service.get('ws-1');

      expect(applyPullRequestTag).not.toHaveBeenCalled();
    });

    it('reads pushed worktrees once turned on, then every few minutes, and untags once off', async () => {
      service.startTagging();
      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS);
      expect(run).not.toHaveBeenCalled();

      tagging = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', 'needs-changes');

      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS - 60_000);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(2);

      tagging = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', undefined);
      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('takes tags off that it put on before a restart with tagging turned off', async () => {
      workspace.pullRequestState = 'in-review';
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(applyPullRequestTag).toHaveBeenCalledWith('ws-1', undefined);
      expect(run).not.toHaveBeenCalled();
    });

    it('starts no CI watch or notification from its reads', async () => {
      notifies = true;
      output = ghOutput([checkRun('test', 'IN_PROGRESS')]);
      tagging = true;
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);

      output = passed;
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
    });

    it('takes the tag off once the pull request is approved, and reads it again after a push', async () => {
      output = ghOutput([]);
      tagging = true;
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', 'in-review');

      output = ghOutput([], { reviewDecision: 'APPROVED' });
      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS);
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', undefined);

      output = ghOutput([], { reviewDecision: 'CHANGES_REQUESTED' });
      service.observeBranch({
        workspaceId: 'ws-1',
        branch: branch({ unpushedCommits: 1 }),
      } as never);
      service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', 'needs-changes');
    });

    it('stops reading a workspace whose repository gh finds on no GitHub host', async () => {
      output = new Error(
        'none of the git remotes configured for this repository point to a known GitHub host'
      );
      tagging = true;
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2 * TAG_READ_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(1);
      // The status bar item still reads it.
      await service.get('ws-1');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("leaves the tag alone when gh can't tell which branch it's on, as mid-rebase", async () => {
      tagging = true;
      output = new Error('could not determine current branch: not on any branch');

      await service.get('ws-1');

      expect(applyPullRequestTag).not.toHaveBeenCalled();
    });

    it('reads a repository that got its GitHub remote again after a push', async () => {
      output = new Error('no git remotes found');
      tagging = true;
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);

      output = ghOutput([]);
      service.observeBranch({
        workspaceId: 'ws-1',
        branch: branch({ hasRemote: false, unpushedCommits: 1 }),
      } as never);
      service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', 'in-review');
      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(3);
    });

    it("doesn't start a round of reads while the last one still runs", async () => {
      tagging = true;
      let finish: (value: string) => void = () => {};
      run.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000 + TAG_READ_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(1);

      finish(ghOutput([]));
      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('reads nothing once the user deleted the tags pull requests put on', async () => {
      tagging = true;
      tags = tags.filter((tag) => !tag.pullRequestState);
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(run).not.toHaveBeenCalled();
    });

    it("doesn't read a branch that was never pushed, nor a folder workspace", async () => {
      tagging = true;
      service.observeBranch({
        workspaceId: 'ws-1',
        branch: branch({ hasRemote: false, unpushedCommits: 1 }),
      } as never);
      service.startTagging();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).not.toHaveBeenCalled();

      workspace.isWorktree = false;
      service.observeBranch({ workspaceId: 'ws-1', branch: branch({}) } as never);
      await vi.advanceTimersByTimeAsync(TAG_READ_INTERVAL_MS);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('on an SSH host', () => {
    const LOCAL_COMMAND = pullRequestCommandForBranch('github.com/acme/app', 'feature/search');

    beforeEach(() => {
      workspace = createSshWorkspace({ id: 'ws-1', branchName: 'feature/search' });
      if (isSshWorkspace(workspace)) workspace.backend.gitUrl = 'git@github.com:acme/app.git';
    });

    it("reads a GitHub repository's pull request here, by the branch's name", async () => {
      await expect(service.get('ws-1')).resolves.toMatchObject({
        kind: 'pull-request',
        pullRequest: { ci: 'passed' },
      });
      expect(runLocal).toHaveBeenCalledWith(LOCAL_COMMAND, 15_000, 256 * 1024);
      expect(run).not.toHaveBeenCalled();
    });

    it('leaves the tag alone when only its name was read, with the host offline', async () => {
      tagging = true;
      canRun = false;
      localOutput = new Error('no pull requests found for branch "feature/search"');

      await expect(service.get('ws-1')).resolves.toEqual({ kind: 'none' });
      // The host could know a fork's pull request the name misses.
      expect(applyPullRequestTag).not.toHaveBeenCalled();

      canRun = true;
      output = new Error('no pull requests found for branch "feature/search"');
      await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
      await service.get('ws-1');
      expect(applyPullRequestTag).toHaveBeenLastCalledWith('ws-1', undefined);
    });

    it('reads the branch the host reports checked out, once it has', async () => {
      service.observeBranch({
        workspaceId: 'ws-1',
        branch: branch({ currentBranch: 'feature/other' }),
      } as never);
      await service.get('ws-1');

      expect(runLocal).toHaveBeenCalledWith(
        pullRequestCommandForBranch('github.com/acme/app', 'feature/other'),
        15_000,
        256 * 1024
      );
    });

    it('reads it while the host is not connected', async () => {
      canRun = false;

      await expect(service.get('ws-1')).resolves.toMatchObject({ kind: 'pull-request' });
    });

    it.each([
      ['without gh here', 'zsh:1: command not found: gh'],
      ['signed out of gh here', 'To get started with GitHub CLI, please run:  gh auth login'],
    ])("reads it with the host's gh %s", async (_, message) => {
      localOutput = new Error(message);

      await expect(service.get('ws-1')).resolves.toMatchObject({
        kind: 'pull-request',
        pullRequest: { ci: 'pending' },
      });
      expect(run).toHaveBeenCalledWith(workspace, PULL_REQUEST_COMMAND, 15_000, 256 * 1024);
    });

    it("says what's missing here when the host can't read it either", async () => {
      localOutput = new Error('zsh:1: command not found: gh');
      canRun = false;

      await expect(service.get('ws-1')).resolves.toEqual({
        kind: 'unavailable',
        reason: 'no-gh',
      });
    });

    it.each([
      ['finds no pull request, as for a fork', 'no pull requests found for branch "x"'],
      ['fails', "GraphQL: Could not resolve to a Repository with the name 'acme/app'"],
    ])("reads it with the host's checkout when gh here %s", async (_, message) => {
      localOutput = new Error(message);

      await expect(service.get('ws-1')).resolves.toMatchObject({ kind: 'pull-request' });
      expect(run).toHaveBeenCalledWith(workspace, PULL_REQUEST_COMMAND, 15_000, 256 * 1024);
    });

    it("keeps there's no pull request when the host has no gh to look", async () => {
      localOutput = new Error('no pull requests found for branch "feature/search"');
      output = new Error('bash: gh: command not found');

      await expect(service.get('ws-1')).resolves.toEqual({ kind: 'none' });
    });

    it('notifies checks only the host reads finishing', async () => {
      localOutput = new Error('no pull requests found for branch "feature/search"');
      await service.get('ws-1');
      output = passed;
      await later();
      await service.get('ws-1');

      expect(notify).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a repository off GitHub', { gitUrl: 'git@gitlab.com:acme/app.git' }],
      ['a branch name a shell would read', { branchName: 'feature/$(touch x)' }],
      ['no branch', { branchName: undefined }],
      ['a branch gh would take for a pull request number', { branchName: '1234' }],
      ['a branch gh would take for a #number', { branchName: '#12' }],
      ['a detached HEAD', { branchName: 'HEAD' }],
    ])('runs gh on the host for %s', async (_, change) => {
      if (isSshWorkspace(workspace) && 'gitUrl' in change) workspace.backend.gitUrl = change.gitUrl;
      if ('branchName' in change) workspace.branchName = change.branchName;
      await service.get('ws-1');

      expect(runLocal).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(workspace, PULL_REQUEST_COMMAND, 15_000, 256 * 1024);
    });
  });
});
