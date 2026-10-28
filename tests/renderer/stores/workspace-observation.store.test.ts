import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspaceObservationStore } from '../../../src/renderer/stores/workspace-observation.store';

import type { WorkspaceObservationProjection } from '../../../src/shared/types';

function projection(revision: number): WorkspaceObservationProjection {
  return {
    workspaceId: 'workspace-1',
    revision,
    repositoryRevision: revision,
    workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
    branch: {
      currentBranch: 'feature',
      targetBranch: 'main',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    },
    confirmation: { kind: 'current', confirmedAt: revision },
  };
}

describe('workspace observation store', () => {
  beforeEach(() => {
    useWorkspaceObservationStore.setState({ projections: new Map() });
  });

  it('keeps the newest whole projection when delivery is reordered', () => {
    useWorkspaceObservationStore.getState().applyProjection(projection(3));
    useWorkspaceObservationStore.getState().applyProjection(projection(2));

    expect(useWorkspaceObservationStore.getState().projections.get('workspace-1')?.revision).toBe(
      3
    );
  });
});
