// Re-export from modular structure
export { gitService } from './git/index';
export type {
  GitProgressCallback,
  WorktreeInfo,
  FileChange,
  WorktreeDiff,
  FileDiffContent,
  GitBranchQuickStatus,
  RepoWebInfo,
  BranchInfo,
  CommitInfo,
  CommitDiff,
  BlameHunk,
} from './git/index';
