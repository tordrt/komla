import { describe, expect, it } from 'vitest';

import {
  computeInitDefaults,
  type InitDefaultsParams,
} from '../../../../src/renderer/components/terminal/inline-file-tree-defaults';

function makeParams(overrides: Partial<InitDefaultsParams> = {}): InitDefaultsParams {
  return {
    isActive: true,
    isGitWorkspace: true,
    workspaceId: 'ws-1',
    resolvedTargetBranch: 'develop',
    targetBranch: 'develop',
    defaultLiveFollow: false,
    defaultCompareTargetBranch: true,
    currentLiveFollow: undefined,
    currentComparisonBranch: undefined,
    ...overrides,
  };
}

describe('computeInitDefaults', () => {
  describe('isActive gating', () => {
    it('does not initialize when workspace is inactive', () => {
      const result = computeInitDefaults(makeParams({ isActive: false }));
      expect(result.initialized).toBe(false);
      expect(result.setLiveFollow).toBeUndefined();
      expect(result.setComparisonBranch).toBeUndefined();
    });
  });

  describe('comparison branch initialization', () => {
    it('waits for authoritative branch data instead of using fallback', () => {
      const result = computeInitDefaults(
        makeParams({
          resolvedTargetBranch: undefined,
          targetBranch: 'main', // fallback
          defaultCompareTargetBranch: true,
        })
      );
      expect(result.initialized).toBe(false);
      expect(result.setComparisonBranch).toBeUndefined();
    });

    it('sets comparison branch once authoritative data arrives', () => {
      const result = computeInitDefaults(
        makeParams({
          resolvedTargetBranch: 'develop',
          targetBranch: 'develop',
          defaultCompareTargetBranch: true,
          currentComparisonBranch: undefined,
        })
      );
      expect(result.initialized).toBe(true);
      expect(result.setComparisonBranch).toEqual({ branch: 'develop', useMergeBase: true });
    });

    it('does not overwrite an already-set comparison branch', () => {
      const result = computeInitDefaults(
        makeParams({
          resolvedTargetBranch: 'develop',
          targetBranch: 'develop',
          defaultCompareTargetBranch: true,
          currentComparisonBranch: 'custom-branch',
        })
      );
      expect(result.initialized).toBe(true);
      expect(result.setComparisonBranch).toBeUndefined();
    });

    it('skips comparison branch when defaultCompareTargetBranch is disabled', () => {
      const result = computeInitDefaults(
        makeParams({
          defaultCompareTargetBranch: false,
          resolvedTargetBranch: undefined,
          targetBranch: 'main',
        })
      );
      // Should complete initialization even without authoritative data
      expect(result.initialized).toBe(true);
      expect(result.setComparisonBranch).toBeUndefined();
    });
  });

  describe('live follow initialization', () => {
    it('sets live follow when defaultLiveFollow is enabled and not yet set', () => {
      const result = computeInitDefaults(
        makeParams({
          defaultLiveFollow: true,
          currentLiveFollow: undefined,
        })
      );
      expect(result.setLiveFollow).toBe(true);
    });

    it('does not override existing live follow setting', () => {
      const result = computeInitDefaults(
        makeParams({
          defaultLiveFollow: true,
          currentLiveFollow: false,
        })
      );
      expect(result.setLiveFollow).toBeUndefined();
    });

    it('sets live follow even while waiting for branch data', () => {
      const result = computeInitDefaults(
        makeParams({
          defaultLiveFollow: true,
          currentLiveFollow: undefined,
          defaultCompareTargetBranch: true,
          resolvedTargetBranch: undefined,
          targetBranch: 'main',
        })
      );
      // Not fully initialized (waiting for branch), but live follow is set
      expect(result.initialized).toBe(false);
      expect(result.setLiveFollow).toBe(true);
    });
  });

  describe('non-git workspaces', () => {
    it('completes immediately without setting any defaults', () => {
      const result = computeInitDefaults(
        makeParams({
          isGitWorkspace: false,
          defaultLiveFollow: true,
          defaultCompareTargetBranch: true,
        })
      );
      expect(result.initialized).toBe(true);
      expect(result.setLiveFollow).toBeUndefined();
      expect(result.setComparisonBranch).toBeUndefined();
    });
  });

  describe('hidden workspace → metadata arrives → activation flow', () => {
    it('inactive workspace with no branch data does not initialize', () => {
      const result = computeInitDefaults(
        makeParams({
          isActive: false,
          resolvedTargetBranch: undefined,
          targetBranch: 'main',
          defaultCompareTargetBranch: true,
        })
      );
      expect(result.initialized).toBe(false);
      expect(result.setComparisonBranch).toBeUndefined();
    });

    it('workspace active and real branch arrives — initializes correctly', () => {
      const result = computeInitDefaults(
        makeParams({
          isActive: true,
          resolvedTargetBranch: 'develop',
          targetBranch: 'develop',
          defaultCompareTargetBranch: true,
          currentComparisonBranch: null,
        })
      );
      expect(result.initialized).toBe(true);
      expect(result.setComparisonBranch).toEqual({ branch: 'develop', useMergeBase: true });
    });
  });
});
