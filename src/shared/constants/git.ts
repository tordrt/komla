/**
 * How a git operation's message begins when uncommitted changes block it. Only for building that
 * message: a merge, rebase or pull says so in its result's `outcome`.
 */
export const UNCOMMITTED_CHANGES_PREFIX = 'Commit or stash changes before';
