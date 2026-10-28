import type { SimpleAheadAction } from '../../../../shared/types';
import type { BehindTargetAction } from '@/types';

export const AHEAD_ACTION_LABELS: Record<SimpleAheadAction, string> = {
  pr: 'Create PR',
  merge: 'Fast-forward target branch',
  'agent-prompt': 'Run quick command',
  disabled: 'Disabled',
};

export const AHEAD_ACTION_DESCRIPTIONS: Record<SimpleAheadAction, string> = {
  pr: 'Opens a pull request for the workspace branch.',
  merge: 'Fast-forwards the target branch to the workspace branch.',
  'agent-prompt': 'Runs a prompt or command in a new tab.',
  disabled: 'The count is shown but not clickable.',
};

export const BEHIND_ACTION_LABELS: Record<BehindTargetAction, string> = {
  auto: 'Merge or rebase',
  rebase: 'Always rebase',
  merge: 'Always merge',
};

export const BEHIND_ACTION_DESCRIPTIONS: Record<BehindTargetAction, string> = {
  auto: 'Merges for pushed branches (safe) and rebases local-only branches (clean history).',
  rebase: 'Rebases the workspace branch on top of the target branch (cleaner history).',
  merge: 'Merges the target branch into the workspace branch (keeps a merge commit).',
};

/** What ↑N does on each kind of target before anyone picks, apart from asking first. */
export const BUILT_IN_AHEAD_ACTIONS = { main: 'pr', other: 'merge' } as const;
