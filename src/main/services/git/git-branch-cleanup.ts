import { createLogger } from '../../lib/logger';

import { extractGitError, gitExec } from './git-exec';

import type {
  BranchDeletionResult,
  LeftoverBranch,
  LeftoverBranches,
} from '../../../shared/types/project';

const logger = createLogger('GitBranchCleanup');

// Enough to keep the check quick without starting a git process for every branch at once.
export const CHECK_CONCURRENCY = 6;

// How far back the target's history is read. A branch whose changes landed earlier than this
// shows as not landed, which keeps it rather than deleting it.
const TARGET_HISTORY_LIMIT = 20_000;

// Plain diffs, whatever the user's config says about color, external diff tools, textconv or
// renames. Binary changes include their content, or two different ones would get the same id.
const PLAIN_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary'];

// How many commits to diff in one `git log --no-walk`, which keeps the command line short.
const PATCH_ID_BATCH = 100;

export interface GitBatchCommand {
  args: string[];
  /** Pipe the output through `git patch-id --stable`. */
  patchIds?: boolean;
}

/** A command's trimmed output, or why it failed. */
export type GitBatchResult = { ok: true; output: string } | { ok: false; error: string };

/**
 * Runs git commands in one repository a batch at a time, so a repository on an SSH host
 * answers each batch in one round trip instead of one per command.
 */
export interface GitBatchRunner {
  /** Where the repository is, for logs. */
  readonly label: string;
  /** `serial` runs the commands one after another, in order, for writes that lock. */
  run(commands: GitBatchCommand[], options?: { serial?: boolean }): Promise<GitBatchResult[]>;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function localGitBatchRunner(repoPath: string): GitBatchRunner {
  return {
    label: repoPath,
    run: (commands, { serial = false } = {}) =>
      mapWithConcurrency(
        commands,
        serial ? 1 : CHECK_CONCURRENCY,
        async ({ args, patchIds }): Promise<GitBatchResult> => {
          try {
            const output = patchIds
              ? await gitExec.execGitPatchIds(repoPath, args)
              : await gitExec.execGitAsync(repoPath, args);
            return { ok: true, output };
          } catch (error) {
            return { ok: false, error: extractGitError(error, 'Git command failed') };
          }
        }
      ),
  };
}

const git = (...args: string[]): GitBatchCommand => ({ args });
const patchIds = (...args: string[]): GitBatchCommand => ({ args, patchIds: true });
const outputOf = (result: GitBatchResult) => (result.ok ? result.output : null);

function required(result: GitBatchResult, what: string): string {
  if (!result.ok) throw new Error(`Could not read ${what}: ${result.error}`);
  return result.output;
}

/** `git patch-id` output for diffs of commits, by commit. */
function parsePatchIds(output: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [patchId, commit] = line.split(' ');
    ids.set(commit, patchId);
  }
  return ids;
}

/** The files each commit changed, from `git log --name-only --format=%x1e%H`. */
function parseChangedFiles(output: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of output.split('\x1e').filter(Boolean)) {
    const [commit, ...paths] = entry.split('\n');
    files.set(commit.trim(), paths.filter(Boolean).sort().join('\n'));
  }
  return files;
}

/** Where a branch split from a target, and when that commit was made. */
interface BranchBase {
  commit: string;
  committedAt: number;
}

async function readBranchBases(
  repo: GitBatchRunner,
  into: string,
  commits: string[]
): Promise<Array<BranchBase | null>> {
  const bases = (await repo.run(commits.map((commit) => git('merge-base', into, commit)))).map(
    outputOf
  );
  const unique = [...new Set(bases.filter((base): base is string => !!base))];
  const [times] = unique.length
    ? await repo.run([git('log', '--no-walk=unsorted', '--format=%H %ct', ...unique)])
    : [{ ok: true as const, output: '' }];
  const committedAt = new Map(
    required(times, 'commit dates')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, time] = line.split(' ');
        return [commit, Number(time)] as const;
      })
  );
  return bases.map((base) =>
    base ? { commit: base, committedAt: committedAt.get(base) ?? 0 } : null
  );
}

/**
 * The target's commits since the oldest branch base, grouped by the files they changed. Equal
 * patch ids need the same files, so only commits in a matching group are ever diffed. A
 * merge-base older than that base by date may leave some out, so branches that landed there
 * show as not landed, never the other way round.
 */
class TargetHistory {
  private readonly commitsByFiles = new Map<string, string[]>();
  private readonly patchIds = new Map<string, string>();

  private constructor(
    private readonly repo: GitBatchRunner,
    changedFiles: Map<string, string>
  ) {
    for (const [commit, files] of changedFiles) {
      this.commitsByFiles.set(files, [...(this.commitsByFiles.get(files) ?? []), commit]);
    }
  }

  static async read(
    repo: GitBatchRunner,
    into: string,
    bases: BranchBase[]
  ): Promise<TargetHistory> {
    const oldest = bases.reduce<BranchBase | null>(
      (found, base) => (!found || base.committedAt < found.committedAt ? base : found),
      null
    );
    const [history] = oldest
      ? await repo.run([
          git(
            'log',
            '--no-merges',
            '--no-renames',
            '--name-only',
            '--format=%x1e%H',
            `--max-count=${TARGET_HISTORY_LIMIT}`,
            into,
            '--not',
            oldest.commit
          ),
        ])
      : [{ ok: true as const, output: '' }];
    return new TargetHistory(repo, parseChangedFiles(required(history, 'the target history')));
  }

  /** Diffs the target commits that changed any of these sets of files. */
  async loadPatchIds(fileSets: Iterable<string>): Promise<void> {
    const missing = [
      ...new Set([...fileSets].flatMap((files) => this.commitsByFiles.get(files) ?? [])),
    ].filter((commit) => !this.patchIds.has(commit));
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += PATCH_ID_BATCH) {
      batches.push(missing.slice(i, i + PATCH_ID_BATCH));
    }
    const results = await this.repo.run(
      batches.map((batch) => patchIds('log', '-p', '--no-walk=unsorted', ...PLAIN_DIFF, ...batch))
    );
    for (const [index, result] of results.entries()) {
      for (const [commit, patchId] of parsePatchIds(required(result, 'target diffs'))) {
        this.patchIds.set(commit, patchId);
      }
      // A commit without changes has no patch id.
      for (const commit of batches[index])
        if (!this.patchIds.has(commit)) this.patchIds.set(commit, '');
    }
  }

  /** The target commits that changed `files` with this patch id, once their ids are loaded. */
  matches({ patchId, files }: Change): string[] {
    return (this.commitsByFiles.get(files) ?? []).filter(
      (commit) => this.patchIds.get(commit) === patchId
    );
  }
}

/** A diff by its patch id and the files it changes, sorted and joined by newlines. */
interface Change {
  patchId: string;
  files: string;
}

/** What a branch changed since its base, for one that isn't settled without the target. */
interface BranchChanges {
  base: string;
  /** All its commits as one diff; null when that diff has no patch id, such as mode changes. */
  squashed: Change | null;
  /** Each commit's diff, leaving out empty ones; null when the branch has a merge commit. */
  commits: Change[] | null;
}

/**
 * What each branch changed since its base, or true when that adds up to nothing: the branch
 * has no commits of its own, or they cancel out, such as a change and its revert.
 */
async function readBranchChanges(
  repo: GitBatchRunner,
  branches: Array<{ commit: string; base: string }>
): Promise<Array<BranchChanges | true>> {
  const commandsPerBranch = 5;
  const results = await repo.run(
    branches.flatMap(({ commit, base }) => [
      git('diff', '--no-renames', '--name-only', base, commit),
      patchIds('diff', ...PLAIN_DIFF, base, commit),
      git('rev-list', '--merges', '-n', '1', `${base}..${commit}`),
      git('log', '--no-renames', '--name-only', '--format=%x1e%H', `${base}..${commit}`),
      patchIds('log', '-p', ...PLAIN_DIFF, `${base}..${commit}`),
    ])
  );
  return branches.map(({ base }, index) => {
    const [squashedFiles, squashed, merge, changedFiles, commits] = results
      .slice(index * commandsPerBranch, (index + 1) * commandsPerBranch)
      .map((result) => required(result, 'branch changes'));
    if (!squashedFiles) return true;
    const [squashedId] = parsePatchIds(squashed).values();
    const filesByCommit = parseChangedFiles(changedFiles);
    return {
      base,
      squashed: squashedId
        ? { patchId: squashedId, files: squashedFiles.split('\n').sort().join('\n') }
        : null,
      // A merge commit may hold a conflict resolution of its own, which no patch id covers.
      commits:
        merge === ''
          ? [...parsePatchIds(commits)].map(([commit, patchId]) => ({
              patchId,
              files: filesByCommit.get(commit) ?? '',
            }))
          : null,
    };
  });
}

/**
 * Which branches have every change already in the target: each commit has an equivalent there
 * (merged, rebased or cherry-picked), or all of them squashed into one do. Only target commits
 * made after a branch's base count.
 */
async function findLanded(
  repo: GitBatchRunner,
  into: string,
  branches: Array<{ commit: string }>
): Promise<boolean[]> {
  const bases = await readBranchBases(
    repo,
    into,
    branches.map(({ commit }) => commit)
  );
  const target = await TargetHistory.read(
    repo,
    into,
    bases.filter((base): base is BranchBase => !!base)
  );
  const changing = branches.flatMap(({ commit }, index) => {
    const base = bases[index]?.commit;
    return base && base !== commit ? [{ index, commit, base }] : [];
  });
  const changes = await readBranchChanges(repo, changing);
  const changesByIndex = new Map(changing.map(({ index }, i) => [index, changes[i]]));

  const pending = changes.filter((change): change is BranchChanges => change !== true);
  const changesOf = (branch: BranchChanges) => [
    ...(branch.squashed ? [branch.squashed] : []),
    ...(branch.commits ?? []),
  ];
  await target.loadPatchIds(
    pending.flatMap((branch) => changesOf(branch).map(({ files }) => files))
  );

  // A matching target commit only counts when it isn't part of the branch's own base.
  const checks = [
    ...new Set(
      pending.flatMap((branch) =>
        changesOf(branch).flatMap((change) =>
          target.matches(change).map((commit) => `${commit} ${branch.base}`)
        )
      )
    ),
  ];
  const results = await repo.run(
    checks.map((check) => git('merge-base', '--is-ancestor', ...check.split(' ')))
  );
  const afterBase = new Set(checks.filter((_, index) => !results[index].ok));
  const inTarget = (change: Change, base: string) =>
    target.matches(change).some((commit) => afterBase.has(`${commit} ${base}`));

  return branches.map((_, index) => {
    if (!bases[index]) return false;
    const branch = changesByIndex.get(index);
    if (branch === undefined || branch === true) return true;
    if (branch.squashed && inTarget(branch.squashed, branch.base)) return true;
    return !!branch.commits?.every((change) => inTarget(change, branch.base));
  });
}

interface RepositoryRefs {
  branches: Omit<LeftoverBranch, 'landed'>[];
  /** Branches checked out in any worktree, including the main one of a bare repository. */
  checkedOut: string[];
  headBranch: string | null;
  originBranches: Set<string>;
}

async function readRefs(repo: GitBatchRunner): Promise<RepositoryRefs> {
  const [refs, worktrees, head, origin] = await repo.run([
    git(
      'for-each-ref',
      '--format=%(refname:strip=2)%00%(objectname)%00%(committerdate:unix)%00%(contents:subject)',
      'refs/heads'
    ),
    git('worktree', 'list', '--porcelain'),
    git('symbolic-ref', '--quiet', 'HEAD'),
    git('for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'),
  ]);
  const headRef = outputOf(head);
  const headBranch = headRef?.startsWith('refs/heads/')
    ? headRef.slice('refs/heads/'.length)
    : null;
  const checkedOut = required(worktrees, 'worktrees')
    .split('\n')
    .filter((line) => line.startsWith('branch refs/heads/'))
    .map((line) => line.slice('branch refs/heads/'.length));
  return {
    branches: required(refs, 'branches')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, commit, committedAt, subject] = line.split('\0');
        return { name, commit, lastCommitAt: Number(committedAt) * 1000, subject: subject ?? '' };
      }),
    checkedOut: headBranch ? [...checkedOut, headBranch] : checkedOut,
    headBranch,
    originBranches: new Set(required(origin, "origin's branches").split('\n').filter(Boolean)),
  };
}

/**
 * The branches cleanup leaves alone, ignoring case: on macOS and Windows, `Main` can name
 * the same ref file as `main`.
 */
function branchesInUse(refs: RepositoryRefs, keep: Iterable<string>): Set<string> {
  return new Set([...keep, ...refs.checkedOut].map((name) => name.toLowerCase()));
}

export class GitBranchCleanupService {
  /**
   * Local branches no worktree has checked out and none of `keep`, newest first, each with
   * whether every change on it is already in the target branch, locally or on origin. An empty
   * `targetBranch` means the repository's HEAD branch. `skipBranchesOnOrigin` leaves out
   * branches origin also has, for a bare clone, which holds a local copy of every branch on
   * origin.
   */
  async listLeftoverBranches(
    repo: GitBatchRunner,
    targetBranch: string,
    keep: ReadonlySet<string>,
    { skipBranchesOnOrigin = false }: { skipBranchesOnOrigin?: boolean } = {}
  ): Promise<LeftoverBranches> {
    const refs = await readRefs(repo);
    const target = targetBranch || refs.headBranch || 'main';
    const inUse = branchesInUse(refs, [...keep, target]);
    const candidates = refs.branches.filter(
      ({ name }) =>
        !inUse.has(name.toLowerCase()) && !(skipBranchesOnOrigin && refs.originBranches.has(name))
    );
    const targets = await repo.run([
      git('rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`),
      git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}^{commit}`),
    ]);
    const intoCommits = [
      ...new Set(targets.map(outputOf).filter((into): into is string => !!into)),
    ];

    const landed = new Set<string>();
    for (const into of intoCommits) {
      const unsettled = candidates.filter((branch) => !landed.has(branch.name));
      const found = await findLanded(repo, into, unsettled);
      for (const [index, branch] of unsettled.entries()) if (found[index]) landed.add(branch.name);
    }
    return {
      targetBranch: target,
      branches: candidates
        .map((branch) => ({ ...branch, landed: landed.has(branch.name) }))
        .sort((a, b) => b.lastCommitAt - a.lastCommitAt),
    };
  }

  /**
   * Deletes each branch that exists under exactly that name, still points at the commit it was
   * listed with, and that no worktree has checked out and isn't in `keep`.
   */
  async deleteBranches(
    repo: GitBatchRunner,
    branches: ReadonlyArray<{ name: string; commit: string }>,
    keep: ReadonlySet<string>
  ): Promise<BranchDeletionResult> {
    const refs = await readRefs(repo);
    const inUse = branchesInUse(refs, keep);
    const commits = new Map(refs.branches.map((branch) => [branch.name, branch.commit]));
    const result: BranchDeletionResult = { deleted: [], failed: [] };
    const deletable = branches.filter(({ name, commit }) => {
      const current = commits.get(name);
      const problem = inUse.has(name.toLowerCase())
        ? 'The branch is in use.'
        : !current
          ? 'The branch no longer exists.'
          : current !== commit
            ? 'The branch has new commits.'
            : null;
      if (problem) result.failed.push({ name, message: problem });
      return !problem;
    });

    // Deletes only while the branch still points at `commit`, even if it moved just now.
    const deletes = await repo.run(
      deletable.map(({ name, commit }) => git('update-ref', '-d', `refs/heads/${name}`, commit)),
      { serial: true }
    );
    const failures = deletable.flatMap((branch, index) => {
      const outcome = deletes[index];
      return outcome.ok ? [] : [{ ...branch, error: outcome.error }];
    });
    const deleted = deletable.filter((_, index) => deletes[index].ok);
    const [current] = await Promise.all([
      repo.run(
        failures.map(({ name }) => git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`))
      ),
      // Their upstreams and other settings, which `git branch -D` would remove too.
      repo.run(
        deleted.map(({ name }) => git('config', '--remove-section', `branch.${name}`)),
        { serial: true }
      ),
    ]);
    for (const [index, { name, commit, error }] of failures.entries()) {
      const moved = outputOf(current[index]) !== commit;
      result.failed.push({ name, message: moved ? 'The branch has new commits.' : error });
    }
    for (const { name, commit } of deleted) {
      // The commit is how to get the branch back: git branch <name> <commit>
      logger.info('Deleted leftover branch', { repo: repo.label, name, commit });
      result.deleted.push(name);
    }
    return result;
  }
}

export const gitBranchCleanupService = new GitBranchCleanupService();
