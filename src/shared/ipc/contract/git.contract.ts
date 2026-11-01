import { IPC } from '../../constants/ipc-channels';
import {
  getDirectoryInfoArgsSchema,
  repoPathArgsSchema,
  worktreePathArgsSchema,
  diffAgainstBranchArgsSchema,
  fileDiffContentArgsSchema,
  fileDiffAgainstBranchArgsSchema,
  workspaceDiffArgsSchema,
  workspaceDiffAgainstBranchArgsSchema,
  workspaceFileDiffContentArgsSchema,
  workspaceFileDiffAgainstBranchArgsSchema,
  workspaceListFilesArgsSchema,
  workspaceImportExternalFileArgsSchema,
  workspaceViewerFileArgsSchema,
  workspaceViewerPreviewUrlArgsSchema,
  workspaceReadFileArgsSchema,
  workspaceSearchContentArgsSchema,
  workspaceWriteFileArgsSchema,
  workspaceDeletePathArgsSchema,
  htmlPreviewUrlArgsSchema,
  branchStatusArgsSchema,
  workspaceBranchStatusArgsSchema,
  workspaceListBranchesArgsSchema,
  workspaceCommitGraphArgsSchema,
  workspacePullRequestStatusArgsSchema,
  workspaceCommitDiffArgsSchema,
  workspaceCommitFileDiffArgsSchema,
  workspaceFetchRemoteArgsSchema,
  workspaceInspectCommitScopeArgsSchema,
  workspaceGenerateCommitDraftArgsSchema,
  workspaceCommitChangesArgsSchema,
  workspaceCreateBranchArgsSchema,
  workspaceSwitchBranchArgsSchema,
  workspaceMergeFromArgsSchema,
  workspaceRebaseOnBranchArgsSchema,
  workspacePushPullArgsSchema,
  workspaceTargetBranchActionArgsSchema,
  workspaceRestoreFileArgsSchema,
  workspaceDiscardAllChangesArgsSchema,
  mergeFromWithStashArgsSchema,
  listBranchesArgsSchema,
  rebaseOnTargetBranchArgsSchema,
  rebaseOnBranchArgsSchema,
  mergeFromArgsSchema,
  deleteBranchArgsSchema,
  fileExistsArgsSchema,
  getFileMetadataArgsSchema,
  copyFileArgsSchema,
  copyDirectoryArgsSchema,
  importExternalFileArgsSchema,
  deleteFileArgsSchema,
  renameFileArgsSchema,
  createDirectoryArgsSchema,
  writeFileArgsSchema,
  listFilesArgsSchema,
  readFileArgsSchema,
  restoreFileArgsSchema,
  inspectCommitScopeArgsSchema,
  generateCommitDraftArgsSchema,
  commitChangesArgsSchema,
  validateRemoteUrlArgsSchema,
  addRemoteArgsSchema,
  createGithubRepoArgsSchema,
  pushProjectBranchesArgsSchema,
  setGitIdentityArgsSchema,
  managedRepoFetchArgsSchema,
  managedRepoPushPullStatusArgsSchema,
  projectSyncRefreshArgsSchema,
  blameArgsSchema,
  refreshGitStatusArgsSchema,
} from '../schemas/git-ipc.schemas';

import { invoke } from './define';

import type {
  BlameHunk,
  BranchInfo,
  CommitDiff,
  ContentSearchResult,
  DirectoryInfo,
  FileChange,
  FileDiffContent,
  GitBranchQuickStatus,
  WorktreeDiff,
} from '../../../renderer/types';
import type { CommitGraph } from '../../types/commit-graph';
import type { GitIdentityStatus } from '../../types/git-identity';
import type { PullRequestStatus } from '../../types/pull-request';
import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScopeResult,
} from '../../types/utility-inference';
import type { ViewerFile, ViewerFolderFile } from '../../types/viewer-file';
import type { WorkspaceObservationProjection } from '../../types/workspace-observation';

export const gitContract = {
  [IPC.CONFIG_SELECT_DIRECTORY]: invoke().returns<string | null>(),
  [IPC.CONFIG_SELECT_ANY_DIRECTORY]: invoke().returns<string | null>(),
  [IPC.GIT_GET_DIRECTORY_INFO]: invoke(getDirectoryInfoArgsSchema).returns<DirectoryInfo>(),
  [IPC.GIT_LIST_WORKTREES]: invoke(repoPathArgsSchema).returns<string[]>(),
  [IPC.GIT_GET_WORKTREE_BRANCHES]: invoke(repoPathArgsSchema).returns<string[]>(),
  [IPC.GIT_VALIDATE_REPO]: invoke(getDirectoryInfoArgsSchema).returns<boolean>(),
  [IPC.GIT_GET_CHANGED_FILES_WITH_SUMMARY]: invoke(worktreePathArgsSchema).returns<{
    files: FileChange[];
    summary: { additions: number; deletions: number; filesChanged: number };
  }>(),
  [IPC.GIT_GET_DIFF]: invoke(worktreePathArgsSchema).returns<WorktreeDiff>(),
  [IPC.GIT_GET_DIFF_AGAINST_BRANCH]: invoke(diffAgainstBranchArgsSchema).returns<WorktreeDiff>(),
  [IPC.GIT_GET_FILE_DIFF_CONTENT]: invoke(fileDiffContentArgsSchema).returns<FileDiffContent>(),
  [IPC.GIT_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH]: invoke(
    fileDiffAgainstBranchArgsSchema
  ).returns<FileDiffContent>(),
  [IPC.WORKSPACE_GET_DIFF]: invoke(workspaceDiffArgsSchema).returns<WorktreeDiff>(),
  [IPC.WORKSPACE_GET_DIFF_AGAINST_BRANCH]: invoke(
    workspaceDiffAgainstBranchArgsSchema
  ).returns<WorktreeDiff>(),
  [IPC.WORKSPACE_GET_FILE_DIFF_CONTENT]: invoke(
    workspaceFileDiffContentArgsSchema
  ).returns<FileDiffContent>(),
  [IPC.WORKSPACE_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH]: invoke(
    workspaceFileDiffAgainstBranchArgsSchema
  ).returns<FileDiffContent>(),
  [IPC.WORKSPACE_LIST_FILES]: invoke(workspaceListFilesArgsSchema).returns<{
    files: string[];
    gitIgnoredFiles: string[];
    emptyDirs: string[];
    fileListHash?: string;
  }>(),
  [IPC.WORKSPACE_IMPORT_EXTERNAL_FILE]: invoke(
    workspaceImportExternalFileArgsSchema
  ).returns<string>(),
  [IPC.WORKSPACE_READ_VIEWER_FILE]: invoke(workspaceViewerFileArgsSchema).returns<ViewerFile>(),
  [IPC.WORKSPACE_GET_VIEWER_PREVIEW_URL]: invoke(
    workspaceViewerPreviewUrlArgsSchema
  ).returns<string>(),
  [IPC.WORKSPACE_LIST_VIEWER_FOLDER]: invoke(workspaceViewerFileArgsSchema).returns<
    ViewerFolderFile[]
  >(),
  [IPC.WORKSPACE_READ_FILE]: invoke(workspaceReadFileArgsSchema).returns<string>(),
  [IPC.WORKSPACE_SEARCH_CONTENT]: invoke(workspaceSearchContentArgsSchema).returns<
    ContentSearchResult[]
  >(),
  [IPC.WORKSPACE_READ_IMAGE_FILE]: invoke(workspaceReadFileArgsSchema).returns<{
    data: string;
    mimeType: string;
  }>(),
  [IPC.WORKSPACE_WRITE_FILE]: invoke(workspaceWriteFileArgsSchema).returns<void>(),
  [IPC.WORKSPACE_DELETE_PATH]: invoke(workspaceDeletePathArgsSchema).returns<void>(),
  [IPC.GIT_GET_HTML_PREVIEW_URL]: invoke(htmlPreviewUrlArgsSchema).returns<string>(),
  [IPC.GIT_GET_BRANCH_STATUS]: invoke(branchStatusArgsSchema).returns<GitBranchQuickStatus>(),
  [IPC.WORKSPACE_GET_BRANCH_STATUS]: invoke(
    workspaceBranchStatusArgsSchema
  ).returns<GitBranchQuickStatus>(),
  [IPC.WORKSPACE_LIST_BRANCHES]: invoke(workspaceListBranchesArgsSchema).returns<BranchInfo[]>(),
  [IPC.WORKSPACE_GET_COMMIT_GRAPH]: invoke(workspaceCommitGraphArgsSchema).returns<CommitGraph>(),
  [IPC.WORKSPACE_GET_PULL_REQUEST_STATUS]: invoke(
    workspacePullRequestStatusArgsSchema
  ).returns<PullRequestStatus>(),
  [IPC.WORKSPACE_GET_COMMIT_DIFF]: invoke(workspaceCommitDiffArgsSchema).returns<CommitDiff>(),
  [IPC.WORKSPACE_GET_COMMIT_FILE_DIFF]: invoke(
    workspaceCommitFileDiffArgsSchema
  ).returns<FileDiffContent>(),
  [IPC.WORKSPACE_FETCH_REMOTE]: invoke(workspaceFetchRemoteArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_INSPECT_COMMIT_SCOPE]: invoke(
    workspaceInspectCommitScopeArgsSchema
  ).returns<CommitScopeResult>(),
  [IPC.WORKSPACE_GENERATE_COMMIT_DRAFT]: invoke(
    workspaceGenerateCommitDraftArgsSchema
  ).returns<CommitDraftResult>(),
  [IPC.WORKSPACE_COMMIT_CHANGES]: invoke(
    workspaceCommitChangesArgsSchema
  ).returns<CommitChangesResult>(),
  [IPC.WORKSPACE_CREATE_BRANCH]: invoke(workspaceCreateBranchArgsSchema).returns<void>(),
  [IPC.WORKSPACE_SWITCH_BRANCH]: invoke(workspaceSwitchBranchArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_MERGE_FROM]: invoke(workspaceMergeFromArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_REBASE_ON_BRANCH]: invoke(workspaceRebaseOnBranchArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_PUSH]: invoke(workspacePushPullArgsSchema).returns<{
    success: boolean;
    message: string;
    errorCode?: 'rejected';
  }>(),
  [IPC.WORKSPACE_PULL]: invoke(workspacePushPullArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_PUSH_TARGET_BRANCH]: invoke(workspaceTargetBranchActionArgsSchema).returns<{
    success: boolean;
    message: string;
    errorCode?: 'rejected';
  }>(),
  [IPC.WORKSPACE_PULL_TARGET_BRANCH]: invoke(workspaceTargetBranchActionArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_MERGE_TARGET_BRANCH_FROM_REMOTE]: invoke(
    workspaceTargetBranchActionArgsSchema
  ).returns<{ success: boolean; message: string }>(),
  [IPC.WORKSPACE_MERGE_TO_TARGET_BRANCH]: invoke(workspaceTargetBranchActionArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.WORKSPACE_RESTORE_FILE]: invoke(workspaceRestoreFileArgsSchema).returns<void>(),
  [IPC.WORKSPACE_DISCARD_ALL_CHANGES]: invoke(workspaceDiscardAllChangesArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_MERGE_FROM]: invoke(mergeFromWithStashArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_LIST_BRANCHES]: invoke(listBranchesArgsSchema).returns<BranchInfo[]>(),
  [IPC.GIT_HAS_ORIGIN_REMOTE]: invoke(repoPathArgsSchema).returns<boolean>(),
  [IPC.GIT_GET_MAIN_BRANCH]: invoke(repoPathArgsSchema).returns<string>(),
  [IPC.GIT_FETCH]: invoke(repoPathArgsSchema).returns<{ success: boolean; message: string }>(),
  [IPC.GIT_PUSH]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
    errorCode?: 'rejected';
  }>(),
  [IPC.GIT_PULL]: invoke(worktreePathArgsSchema).returns<{ success: boolean; message: string }>(),
  [IPC.GIT_PULL_REBASE]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_PUSH_TARGET_BRANCH]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
    errorCode?: 'rejected';
  }>(),
  [IPC.GIT_PULL_TARGET_BRANCH]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_MERGE_TARGET_BRANCH_FROM_REMOTE]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_REBASE_ON_TARGET_BRANCH]: invoke(rebaseOnTargetBranchArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_REBASE_ON_BRANCH]: invoke(rebaseOnBranchArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_ABORT_REBASE]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_MERGE_TO_TARGET_BRANCH]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_SWITCH_BRANCH]: invoke(mergeFromArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_DELETE_BRANCH]: invoke(deleteBranchArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_DELETE_REMOTE_BRANCH]: invoke(mergeFromArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_GET_BRANCH_URL]: invoke(worktreePathArgsSchema).returns<string | null>(),
  [IPC.GIT_GET_CREATE_PR_URL]: invoke(worktreePathArgsSchema).returns<string | null>(),
  [IPC.GIT_GET_REPO_WEB_INFO]: invoke(repoPathArgsSchema).returns<{ webUrl: string | null }>(),
  [IPC.GIT_FILE_EXISTS]: invoke(fileExistsArgsSchema).returns<boolean>(),
  [IPC.GIT_GET_FILE_METADATA]: invoke(getFileMetadataArgsSchema).returns<{
    size: number;
    mtimeMs: number;
  }>(),
  [IPC.GIT_COPY_FILE]: invoke(copyFileArgsSchema).returns<void>(),
  [IPC.GIT_COPY_DIRECTORY]: invoke(copyDirectoryArgsSchema).returns<void>(),
  [IPC.GIT_IMPORT_EXTERNAL_FILE]: invoke(importExternalFileArgsSchema).returns<string>(),
  [IPC.GIT_DELETE_FILE]: invoke(deleteFileArgsSchema).returns<void>(),
  [IPC.GIT_RENAME_FILE]: invoke(renameFileArgsSchema).returns<void>(),
  [IPC.GIT_CREATE_DIRECTORY]: invoke(createDirectoryArgsSchema).returns<void>(),
  [IPC.GIT_WRITE_FILE]: invoke(writeFileArgsSchema).returns<void>(),
  [IPC.GIT_LIST_FILES]: invoke(listFilesArgsSchema).returns<{
    files: string[];
    gitIgnoredFiles: string[];
    emptyDirs: string[];
  }>(),
  [IPC.GIT_READ_FILE]: invoke(readFileArgsSchema).returns<string>(),
  [IPC.GIT_READ_IMAGE_FILE]: invoke(readFileArgsSchema).returns<{
    data: string;
    mimeType: string;
  }>(),
  [IPC.GIT_GET_MEDIA_FILE_METADATA]: invoke(readFileArgsSchema).returns<{
    mimeType: string;
    kind: 'audio' | 'video';
    size: number;
    mtimeMs: number;
  }>(),
  [IPC.GIT_READ_MEDIA_FILE]: invoke(readFileArgsSchema).returns<{
    data: string;
    mimeType: string;
    kind: 'audio' | 'video';
  }>(),
  [IPC.GIT_RESTORE_FILE]: invoke(restoreFileArgsSchema).returns<void>(),
  [IPC.GIT_DISCARD_ALL_CHANGES]: invoke(worktreePathArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_INSPECT_COMMIT_SCOPE]: invoke(inspectCommitScopeArgsSchema).returns<CommitScopeResult>(),
  [IPC.GIT_GENERATE_COMMIT_DRAFT]: invoke(
    generateCommitDraftArgsSchema
  ).returns<CommitDraftResult>(),
  [IPC.GIT_COMMIT_CHANGES]: invoke(commitChangesArgsSchema).returns<CommitChangesResult>(),
  [IPC.GIT_VALIDATE_REMOTE_URL]: invoke(validateRemoteUrlArgsSchema).returns<{
    valid: boolean;
    error?: string;
  }>(),
  [IPC.GIT_ADD_ORIGIN_REMOTE]: invoke(addRemoteArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.GIT_CREATE_GITHUB_REPO]: invoke(createGithubRepoArgsSchema).returns<{
    success: boolean;
    message: string;
    url?: string;
  }>(),
  [IPC.GIT_PUSH_PROJECT_BRANCHES]: invoke(pushProjectBranchesArgsSchema).returns<{
    success: boolean;
    message: string;
    removedOrigin?: boolean;
  }>(),
  [IPC.GIT_CHECK_GH_AUTH]: invoke().returns<{
    authenticated: boolean;
    username?: string;
    installed: boolean;
  }>(),
  [IPC.GIT_GET_IDENTITY]: invoke().returns<GitIdentityStatus>(),
  [IPC.GIT_SET_IDENTITY]: invoke(setGitIdentityArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.MANAGED_REPO_FETCH]: invoke(managedRepoFetchArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.MANAGED_REPO_PUSH]: invoke(managedRepoPushPullStatusArgsSchema).returns<{
    success: boolean;
    message: string;
  }>(),
  [IPC.MANAGED_REPO_GET_REMOTE_STATUS]: invoke(managedRepoPushPullStatusArgsSchema).returns<{
    hasRemote: boolean;
    ahead: number;
    behind: number;
    lastFetched: number | null;
  }>(),
  [IPC.PROJECT_SYNC_GET_ALL_STATUSES]: invoke().returns<
    Array<{
      projectId: string;
      hasRemote: boolean;
      behindRemote: number;
      aheadRemote: number;
      lastFetched: number | null;
      mainBranch: string;
    }>
  >(),
  [IPC.PROJECT_SYNC_REFRESH]: invoke(projectSyncRefreshArgsSchema).returns<{
    projectId: string;
    hasRemote: boolean;
    behindRemote: number;
    aheadRemote: number;
    lastFetched: number | null;
    mainBranch: string;
  } | null>(),
  [IPC.GIT_GET_BLAME]: invoke(blameArgsSchema).returns<BlameHunk[]>(),
  [IPC.GIT_REFRESH_STATUS]: invoke(refreshGitStatusArgsSchema).returns<void>(),
  [IPC.WORKSPACE_OBSERVATIONS_GET]: invoke().returns<readonly WorkspaceObservationProjection[]>(),
} as const;
