/**
 * Pure logic for InlineFileTreePanel default initialization.
 * Extracted so it can be tested without React rendering.
 */

export interface InitDefaultsParams {
  isActive: boolean;
  isGitWorkspace: boolean;
  workspaceId: string;
  /** Target branch resolved from workspace/project/gitStatus (undefined when none are available yet) */
  resolvedTargetBranch: string | undefined;
  /** Full target branch with 'main' fallback */
  targetBranch: string;
  /** Whether defaultLiveFollow is enabled in config */
  defaultLiveFollow: boolean;
  /** Whether defaultCompareTargetBranch is enabled in config */
  defaultCompareTargetBranch: boolean;
  /** Current live follow value for this workspace (undefined = never set) */
  currentLiveFollow: boolean | undefined;
  /** Current comparison branch for this workspace (undefined/null = never set) */
  currentComparisonBranch: string | null | undefined;
}

export interface InitDefaultsResult {
  /** Whether initialization completed (all conditions met) */
  initialized: boolean;
  /** If set, the live follow value to persist */
  setLiveFollow?: boolean;
  /** If set, the comparison branch + useMergeBase to persist */
  setComparisonBranch?: { branch: string; useMergeBase: boolean };
}

/**
 * Determines what defaults to apply and whether initialization is complete.
 *
 * Returns `initialized: false` when we should retry later (e.g. waiting for
 * authoritative branch data). Live follow can still be set in that case since
 * it doesn't depend on branch resolution.
 */
export function computeInitDefaults(params: InitDefaultsParams): InitDefaultsResult {
  const {
    isActive,
    isGitWorkspace,
    workspaceId: _workspaceId,
    resolvedTargetBranch,
    targetBranch,
    defaultLiveFollow,
    defaultCompareTargetBranch,
    currentLiveFollow,
    currentComparisonBranch,
  } = params;

  if (!isActive) {
    return { initialized: false };
  }

  const result: InitDefaultsResult = { initialized: true };

  if (isGitWorkspace) {
    // Live follow initialization (idempotent — only sets if never configured)
    if (defaultLiveFollow && currentLiveFollow === undefined) {
      result.setLiveFollow = true;
    }

    // Comparison branch — wait for an authoritative branch source so we don't
    // permanently persist 'main' for repos with a different default branch
    if (defaultCompareTargetBranch) {
      if (!resolvedTargetBranch) {
        // Not ready yet — retry when data arrives
        result.initialized = false;
        return result;
      }
      if (currentComparisonBranch === undefined || currentComparisonBranch === null) {
        result.setComparisonBranch = { branch: targetBranch, useMergeBase: true };
      }
    }
  }

  return result;
}
