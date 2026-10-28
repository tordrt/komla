/**
 * Utility inference types shared between main and renderer processes.
 */

export const UTILITY_PROVIDER_IDS = ['komla-managed', 'custom'] as const;
export type UtilityProviderId = (typeof UTILITY_PROVIDER_IDS)[number];

export interface UtilityInferenceResult {
  title: string | null;
  description: string | null;
  branchName: string | null;
}

export interface CommitMessageDraft {
  subject: string;
  body: string | null;
}

export type CommitScope = 'staged' | 'all';

export interface CommitScopeResult {
  scope: CommitScope;
  fileCount: number;
  /** Files with staged changes. Lets the UI offer staged vs. all; absent for remote workspaces. */
  stagedFileCount?: number;
  /** Files with any change, staged, unstaged or untracked. */
  allFileCount?: number;
}

export interface CommitDraftResult extends CommitMessageDraft {
  scope: CommitScope;
  fileCount: number;
  generationError?: string;
}

export interface CommitChangesResult {
  commitHash: string;
  subject: string;
}

export interface UtilityOpenRouterKeyStatus {
  hasOpenRouterKey: boolean;
  isUsingFallbackStorage: boolean;
}

export type CustomEndpointTestResult = { ok: true } | { ok: false; error: string };
