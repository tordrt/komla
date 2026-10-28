/** A branch, remote branch or tag pointing at a commit, by its short name (`main`, `origin/main`, `v1.0`). */
export interface CommitGraphRef {
  kind: 'branch' | 'remote' | 'tag';
  name: string;
}

export interface CommitGraphCommit {
  hash: string;
  parentHashes: string[];
  author: string;
  /** Author date, in seconds since the epoch. */
  timestamp: number;
  /** The full commit message; its first line is the subject. */
  message: string;
  refs: CommitGraphRef[];
}

/** Which commits to read: the newest from HEAD or `ref`, optionally only those touching `path`. */
export interface CommitGraphQuery {
  limit: number;
  /** How many of the newest to pass over, to read older ones. */
  skip?: number;
  ref?: string;
  /** Follows the file across renames; its commits then have no lanes to draw between them. */
  path?: string;
}

/** The newest commits reachable from HEAD or the queried ref, children before parents. */
export interface CommitGraph {
  commits: CommitGraphCommit[];
  /** Whether older commits were left out. */
  hasMore: boolean;
  /** The checked-out branch; null when HEAD is detached. */
  currentBranch: string | null;
  /** The current branch's upstream, such as `origin/feature`. */
  upstream: string | null;
}
