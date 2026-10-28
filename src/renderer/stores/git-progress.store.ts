import { create } from 'zustand';

export type GitOperationType =
  | 'fetch'
  | 'push'
  | 'pull'
  | 'clone'
  | 'rebase'
  | 'merge'
  | 'fast-forward'
  | 'switch'
  | 'delete';

export interface GitOperation {
  id: string;
  operation: GitOperationType;
  repoPath: string;
  percent: number;
  stage: string;
  startedAt: number;
}

/** The most recently started operation, in `repoPath` when given. */
export function latestGitOperation(
  operations: Map<string, GitOperation>,
  repoPath?: string
): GitOperation | undefined {
  let latest: GitOperation | undefined;
  for (const operation of operations.values()) {
    if (repoPath !== undefined && operation.repoPath !== repoPath) continue;
    if (!latest || operation.startedAt > latest.startedAt) latest = operation;
  }
  return latest;
}

interface GitProgressState {
  operations: Map<string, GitOperation>;
  startOperation: (id: string, operation: GitOperationType, repoPath: string) => void;
  updateProgress: (repoPath: string, percent: number, stage: string) => void;
  endOperation: (id: string) => void;
}

export const useGitProgressStore = create<GitProgressState>((set) => ({
  operations: new Map(),

  startOperation: (id, operation, repoPath) => {
    set((state) => {
      const newOps = new Map(state.operations);
      newOps.set(id, {
        id,
        operation,
        repoPath,
        percent: 0,
        stage: '',
        startedAt: Date.now(),
      });
      return { operations: newOps };
    });
  },

  updateProgress: (repoPath, percent, stage) => {
    set((state) => {
      // Events carry only the repo, so they go to the operation that's shown for it.
      const op = latestGitOperation(state.operations, repoPath);
      if (!op) return state;
      const newOps = new Map(state.operations);
      newOps.set(op.id, { ...op, percent, stage });
      return { operations: newOps };
    });
  },

  endOperation: (id) => {
    set((state) => {
      const newOps = new Map(state.operations);
      newOps.delete(id);
      return { operations: newOps };
    });
  },
}));
