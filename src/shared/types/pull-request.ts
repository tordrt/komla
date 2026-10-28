/** How one of a pull request's checks stands: a GitHub check run or commit status. */
export type PullRequestCheckState = 'passed' | 'failed' | 'pending' | 'skipped';

export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  /** Its page on GitHub, such as the workflow run. */
  url?: string;
}

/** How a pull request's checks stand together: failed once one fails, none without checks. */
export type PullRequestCiState = 'passed' | 'failed' | 'pending' | 'none';

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** What its reviewers decided; undefined when the repository requires no review. */
  review?: 'required' | 'approved' | 'changes-requested';
  ci: PullRequestCiState;
  checks: PullRequestCheck[];
}

/** The pull request of a workspace's branch, as the GitHub CLI (`gh`) reports it. */
export type PullRequestStatus =
  | { kind: 'pull-request'; pullRequest: PullRequestSummary }
  /** The branch has no pull request, or the repository isn't on GitHub. */
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: 'no-gh' | 'signed-out' | 'error'; message?: string };
