/**
 * Where the uncommitted changes Komla saved before a merge or rebase are when it could not put
 * them back into the working tree.
 */
export type GitSavedChangesRecovery =
  /** A recovery copy is in `git stash`, as the commit `stashSha`. */
  | { status: 'stored'; stashSha: string }
  /** Git could not store a copy: only the temporary commit `stashSha` holds them, until pruned. */
  | { status: 'store-failed'; stashSha: string };

/**
 * How a merge, rebase or pull in a workspace ended. Where `recovery` is absent, any changes
 * Komla saved first are back in the working tree.
 */
export type GitSyncOutcome =
  /** It finished; `upToDate` when there was nothing to bring in. */
  | { kind: 'completed'; upToDate: boolean }
  /** It finished, but the saved changes could not be put back. */
  | { kind: 'completed-unrestored'; recovery: GitSavedChangesRecovery }
  /** Nothing ran: uncommitted changes are in the way and saving them was not asked for. */
  | { kind: 'uncommitted-changes' }
  /** It stopped on conflicts in `files` and is left active in the workspace to resolve. */
  | { kind: 'conflicts'; files: string[] }
  /** It failed and was aborted, so the branch is as it was. */
  | { kind: 'aborted'; recovery?: GitSavedChangesRecovery }
  /** It failed and could not be aborted: it is still active, or Komla could not tell. */
  | {
      kind: 'abort-failed';
      operationState: 'active' | 'unknown';
      recovery?: GitSavedChangesRecovery;
    }
  /** It failed, and Komla could not inspect the workspace for what it left behind. */
  | { kind: 'unverified' }
  /** It failed or was refused, leaving nothing active. */
  | { kind: 'failed'; recovery?: GitSavedChangesRecovery };

/** A merge, rebase or pull result: `outcome` is how it ended and `message` says so to the user. */
export interface GitSyncResult {
  success: boolean;
  message: string;
  outcome: GitSyncOutcome;
}
