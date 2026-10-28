import { dirname } from 'path';

import { app, ipcMain, dialog, BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { projectRepoPath } from '../../../shared/lib/project-repo-path';
import { extractGitError } from '../../services/git/git-exec';
import {
  gitService,
  WorktreeDiff,
  FileDiffContent,
  GitBranchQuickStatus,
  RepoWebInfo,
  BranchInfo,
  CommitDiff,
  BlameHunk,
} from '../../services/git.service';
import { checkGhAuth, createGithubRepo } from '../../services/github-cli';
import { htmlPreviewService } from '../../services/html-preview.service';
import { managedRepoService, RemoteStatus } from '../../services/managed-repo.service';
import { projectService } from '../../services/project.service';
import { pullRequestStatusService } from '../../services/pull-request-status.service';
import { workspaceFileService } from '../../services/workspace-file.service';
import { workspaceGitService } from '../../services/workspace-git.service';
import { workspaceStatusService } from '../../services/workspace-status.service';
import {
  copyDirectoryArgsSchema,
  copyFileArgsSchema,
  deleteBranchArgsSchema,
  createDirectoryArgsSchema,
  deleteFileArgsSchema,
  renameFileArgsSchema,
  diffAgainstBranchArgsSchema,
  fileDiffAgainstBranchArgsSchema,
  fileDiffContentArgsSchema,
  fileExistsArgsSchema,
  getFileMetadataArgsSchema,
  getDirectoryInfoArgsSchema,
  importExternalFileArgsSchema,
  listBranchesArgsSchema,
  listFilesArgsSchema,
  managedRepoFetchArgsSchema,
  managedRepoPushPullStatusArgsSchema,
  mergeFromArgsSchema,
  mergeFromWithStashArgsSchema,
  projectSyncRefreshArgsSchema,
  readFileArgsSchema,
  htmlPreviewUrlArgsSchema,
  rebaseOnBranchArgsSchema,
  rebaseOnTargetBranchArgsSchema,
  repoPathArgsSchema,
  restoreFileArgsSchema,
  validateRemoteUrlArgsSchema,
  addRemoteArgsSchema,
  createGithubRepoArgsSchema,
  pushProjectBranchesArgsSchema,
  getGitIdentityArgsSchema,
  setGitIdentityArgsSchema,
  worktreePathArgsSchema,
  writeFileArgsSchema,
  blameArgsSchema,
  refreshGitStatusArgsSchema,
  getWorkspaceObservationsArgsSchema,
  branchStatusArgsSchema,
  inspectCommitScopeArgsSchema,
  generateCommitDraftArgsSchema,
  commitChangesArgsSchema,
  workspaceDiffArgsSchema,
  workspaceDiffAgainstBranchArgsSchema,
  workspaceBranchStatusArgsSchema,
  workspaceCommitDiffArgsSchema,
  workspaceCommitFileDiffArgsSchema,
  workspaceCommitGraphArgsSchema,
  workspaceFetchRemoteArgsSchema,
  workspaceListBranchesArgsSchema,
  workspaceMergeFromArgsSchema,
  workspacePullRequestStatusArgsSchema,
  workspacePushPullArgsSchema,
  workspaceRebaseOnBranchArgsSchema,
  workspaceTargetBranchActionArgsSchema,
  workspaceRestoreFileArgsSchema,
  workspaceDiscardAllChangesArgsSchema,
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
  workspaceInspectCommitScopeArgsSchema,
  workspaceGenerateCommitDraftArgsSchema,
  workspaceCommitChangesArgsSchema,
  workspaceCreateBranchArgsSchema,
  workspaceSwitchBranchArgsSchema,
} from '../validation/git-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';
import {
  assertNoNullBytes,
  assertSafePosixRelativePath,
  assertSafeRelativePath,
} from '../validation/path-safety';

import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScopeResult,
} from '../../../shared/types';
import type { CommitGraph } from '../../../shared/types/commit-graph';
import type { GitIdentityStatus } from '../../../shared/types/git-identity';
import type { PullRequestStatus } from '../../../shared/types/pull-request';
import type { ViewerFile, ViewerFolderFile } from '../../../shared/types/viewer-file';
import type { ContentSearchResult } from '../../services/search.service';

let workspaceStatusBroadcastStarted = false;
// Since Electron 43, dialogs without a defaultPath open in Downloads and the
// OS no longer restores the last-used folder, so track it ourselves.
let lastDirectoryDialogPath: string | undefined;
export function registerGitHandlers(): void {
  if (!workspaceStatusBroadcastStarted) {
    workspaceStatusBroadcastStarted = true;
    workspaceStatusService.observe((projection) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC.WORKSPACE_OBSERVATION_CHANGED, projection);
        }
      }
    });
  }
  const assertLocalGitPath = (path: string): void => {
    if (path.startsWith('ssh://')) {
      throw new Error('This action is not available for SSH workspaces yet');
    }
  };

  const applyManagedRepoTargetBranchAheadRemote = async (
    status: Pick<
      GitBranchQuickStatus,
      | 'mainBranch'
      | 'targetBranchHasRemote'
      | 'targetBranchAheadRemote'
      | 'targetBranchBehindRemote'
    >,
    projectId?: string
  ): Promise<void> => {
    if (!projectId) return;
    const project = projectService.get(projectId);
    if (project?.managed && project.managedRepoPath) {
      try {
        const remoteStatus = await managedRepoService.getRemoteStatus(
          project.managedRepoPath,
          status.mainBranch
        );
        status.targetBranchHasRemote = remoteStatus.hasRemote;
        status.targetBranchAheadRemote = remoteStatus.ahead;
        status.targetBranchBehindRemote = remoteStatus.behind;
      } catch {
        // Ignore errors, keep default 0
      }
    }
  };

  ipcMain.handle(IPC.CONFIG_SELECT_DIRECTORY, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Git Repository',
      defaultPath: lastDirectoryDialogPath ?? app.getPath('home'),
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    lastDirectoryDialogPath = dirname(selectedPath);

    // Validate it's a git repo
    const isRepo = await gitService.isGitRepo(selectedPath);
    if (!isRepo) {
      throw new Error('Selected directory is not a git repository');
    }

    return selectedPath;
  });

  // Select any directory (not restricted to git repos)
  ipcMain.handle(IPC.CONFIG_SELECT_ANY_DIRECTORY, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Directory',
      defaultPath: lastDirectoryDialogPath ?? app.getPath('home'),
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    lastDirectoryDialogPath = dirname(result.filePaths[0]);
    return result.filePaths[0];
  });

  // Get info about a directory
  ipcMain.handle(
    IPC.GIT_GET_DIRECTORY_INFO,
    handleValidated(
      IPC.GIT_GET_DIRECTORY_INFO,
      getDirectoryInfoArgsSchema,
      async (_, [path]): Promise<{ isGit: boolean; branch: string | null }> => {
        const isGit = await gitService.isGitRepo(path);
        let branch: string | null = null;

        if (isGit) {
          try {
            branch = await gitService.getCurrentBranch(path);
          } catch {
            branch = null;
          }
        }

        return { isGit, branch };
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_LIST_WORKTREES,
    handleValidated(IPC.GIT_LIST_WORKTREES, repoPathArgsSchema, async (_, [repoPath]) => {
      const worktrees = await gitService.listWorktrees(repoPath);
      return worktrees.map((w) => w.path);
    })
  );

  ipcMain.handle(
    IPC.GIT_GET_WORKTREE_BRANCHES,
    handleValidated(
      IPC.GIT_GET_WORKTREE_BRANCHES,
      repoPathArgsSchema,
      async (_, [repoPath]): Promise<string[]> => {
        const worktrees = await gitService.listWorktrees(repoPath);
        return worktrees.map((w) => w.branch);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_VALIDATE_REPO,
    handleValidated(
      IPC.GIT_VALIDATE_REPO,
      getDirectoryInfoArgsSchema,
      async (_, [path]): Promise<boolean> => {
        return gitService.isGitRepo(path);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_CHANGED_FILES_WITH_SUMMARY,
    handleValidated(
      IPC.GIT_GET_CHANGED_FILES_WITH_SUMMARY,
      worktreePathArgsSchema,
      async (_, [worktreePath]) => {
        assertLocalGitPath(worktreePath);
        const isGit = await gitService.isGitRepo(worktreePath);
        if (!isGit) {
          return {
            files: [],
            summary: { additions: 0, deletions: 0, filesChanged: 0 },
          };
        }
        return gitService.getChangedFilesWithSummary(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_DIFF,
    handleValidated(
      IPC.GIT_GET_DIFF,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<WorktreeDiff> => {
        assertLocalGitPath(worktreePath);
        const isGit = await gitService.isGitRepo(worktreePath);
        if (!isGit) {
          return {
            files: [],
            summary: { additions: 0, deletions: 0, filesChanged: 0 },
          };
        }
        return gitService.getWorkingTreeDiff(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_DIFF_AGAINST_BRANCH,
    handleValidated(
      IPC.GIT_GET_DIFF_AGAINST_BRANCH,
      diffAgainstBranchArgsSchema,
      async (_, [worktreePath, branch, useMergeBase]): Promise<WorktreeDiff> => {
        assertLocalGitPath(worktreePath);
        const isGit = await gitService.isGitRepo(worktreePath);
        if (!isGit) {
          return {
            files: [],
            summary: { additions: 0, deletions: 0, filesChanged: 0 },
          };
        }
        return gitService.getWorkingTreeDiffAgainstBranch(worktreePath, branch, useMergeBase);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_FILE_DIFF_CONTENT,
    handleValidated(
      IPC.GIT_GET_FILE_DIFF_CONTENT,
      fileDiffContentArgsSchema,
      async (_, [worktreePath, filePath, staged]): Promise<FileDiffContent> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, filePath, 'filePath');
        return gitService.getFullFileDiff(worktreePath, filePath, staged);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
    handleValidated(
      IPC.GIT_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
      fileDiffAgainstBranchArgsSchema,
      async (_, [worktreePath, filePath, branch, useMergeBase]): Promise<FileDiffContent> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, filePath, 'filePath');
        return gitService.getFullFileDiffAgainstBranch(
          worktreePath,
          filePath,
          branch,
          useMergeBase
        );
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_DIFF,
    handleValidated(
      IPC.WORKSPACE_GET_DIFF,
      workspaceDiffArgsSchema,
      async (_, [workspaceId]): Promise<WorktreeDiff> => {
        return workspaceGitService.getWorkingTreeDiff(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_DIFF_AGAINST_BRANCH,
    handleValidated(
      IPC.WORKSPACE_GET_DIFF_AGAINST_BRANCH,
      workspaceDiffAgainstBranchArgsSchema,
      async (_, [workspaceId, branch, useMergeBase]): Promise<WorktreeDiff> => {
        return workspaceGitService.getWorkingTreeDiffAgainstBranch(
          workspaceId,
          branch,
          useMergeBase
        );
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_FILE_DIFF_CONTENT,
    handleValidated(
      IPC.WORKSPACE_GET_FILE_DIFF_CONTENT,
      workspaceFileDiffContentArgsSchema,
      async (_, [workspaceId, filePath, staged]): Promise<FileDiffContent> => {
        return workspaceGitService.getFullFileDiff(workspaceId, filePath, staged);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
    handleValidated(
      IPC.WORKSPACE_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
      workspaceFileDiffAgainstBranchArgsSchema,
      async (_, [workspaceId, filePath, branch, useMergeBase]): Promise<FileDiffContent> => {
        return workspaceGitService.getFullFileDiffAgainstBranch(
          workspaceId,
          filePath,
          branch,
          useMergeBase
        );
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_LIST_FILES,
    handleValidated(
      IPC.WORKSPACE_LIST_FILES,
      workspaceListFilesArgsSchema,
      async (
        _,
        [workspaceId, includeGitIgnored]
      ): Promise<{
        files: string[];
        gitIgnoredFiles: string[];
        emptyDirs: string[];
        managedLinkPaths?: string[];
        fileListHash?: string;
      }> => workspaceFileService.listFiles(workspaceId, includeGitIgnored)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_IMPORT_EXTERNAL_FILE,
    handleValidated(
      IPC.WORKSPACE_IMPORT_EXTERNAL_FILE,
      workspaceImportExternalFileArgsSchema,
      async (_, [workspaceId, sourcePath, preferredName, executionLocation]): Promise<string> =>
        workspaceFileService.importExternalFile(
          workspaceId,
          sourcePath,
          preferredName,
          executionLocation
        )
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_READ_VIEWER_FILE,
    handleValidated(
      IPC.WORKSPACE_READ_VIEWER_FILE,
      workspaceViewerFileArgsSchema,
      async (_, [workspaceId, terminalId, source]): Promise<ViewerFile> => {
        if (source.kind === 'workspace') {
          assertSafeRelativePath('/workspace', source.filePath, 'filePath');
        }
        return workspaceFileService.readViewerFile(workspaceId, terminalId, source);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_VIEWER_PREVIEW_URL,
    handleValidated(
      IPC.WORKSPACE_GET_VIEWER_PREVIEW_URL,
      workspaceViewerPreviewUrlArgsSchema,
      async (_, [workspaceId, terminalId, source, options]): Promise<string> => {
        if (source.kind === 'workspace') {
          assertSafeRelativePath('/workspace', source.filePath, 'filePath');
        }
        return workspaceFileService.getViewerPreviewUrl(workspaceId, terminalId, source, options);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_LIST_VIEWER_FOLDER,
    handleValidated(
      IPC.WORKSPACE_LIST_VIEWER_FOLDER,
      workspaceViewerFileArgsSchema,
      async (_, [workspaceId, terminalId, source]): Promise<ViewerFolderFile[]> => {
        if (source.kind === 'workspace') {
          assertSafeRelativePath('/workspace', source.filePath, 'filePath');
        }
        return workspaceFileService.listViewerFolder(workspaceId, terminalId, source);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_READ_FILE,
    handleValidated(
      IPC.WORKSPACE_READ_FILE,
      workspaceReadFileArgsSchema,
      async (_, [workspaceId, filePath]): Promise<string> => {
        assertSafeRelativePath('/workspace', filePath, 'filePath');
        return workspaceFileService.readFile(workspaceId, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_SEARCH_CONTENT,
    handleValidated(
      IPC.WORKSPACE_SEARCH_CONTENT,
      workspaceSearchContentArgsSchema,
      async (_, [workspaceId, query, options]): Promise<ContentSearchResult[]> =>
        workspaceFileService.searchContent(workspaceId, query, options)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_READ_IMAGE_FILE,
    handleValidated(
      IPC.WORKSPACE_READ_IMAGE_FILE,
      workspaceReadFileArgsSchema,
      async (_, [workspaceId, filePath]): Promise<{ data: string; mimeType: string }> => {
        assertSafeRelativePath('/workspace', filePath, 'filePath');
        return workspaceFileService.readImageFile(workspaceId, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_WRITE_FILE,
    handleValidated(
      IPC.WORKSPACE_WRITE_FILE,
      workspaceWriteFileArgsSchema,
      async (_, [workspaceId, filePath, content]): Promise<void> => {
        assertSafePosixRelativePath(filePath, 'filePath');
        assertNoNullBytes(content, 'content');
        return workspaceFileService.writeFile(workspaceId, filePath, content);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_DELETE_PATH,
    handleValidated(
      IPC.WORKSPACE_DELETE_PATH,
      workspaceDeletePathArgsSchema,
      async (_, [workspaceId, filePath]): Promise<void> => {
        assertSafePosixRelativePath(filePath, 'filePath');
        return workspaceFileService.deletePath(workspaceId, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_HTML_PREVIEW_URL,
    handleValidated(
      IPC.GIT_GET_HTML_PREVIEW_URL,
      htmlPreviewUrlArgsSchema,
      (_, [worktreePath, filePath, content]): Promise<string> =>
        content === undefined
          ? htmlPreviewService.createPreviewUrl(worktreePath, filePath)
          : htmlPreviewService.createContentPreviewUrl(filePath, content, { web: true })
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_BRANCH_STATUS,
    handleValidated(
      IPC.GIT_GET_BRANCH_STATUS,
      branchStatusArgsSchema,
      async (_, [worktreePath, projectId]): Promise<GitBranchQuickStatus> => {
        assertLocalGitPath(worktreePath);
        const status = await gitService.getBranchQuickStatus(worktreePath);
        await applyManagedRepoTargetBranchAheadRemote(status, projectId);
        return status;
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_BRANCH_STATUS,
    handleValidated(
      IPC.WORKSPACE_GET_BRANCH_STATUS,
      workspaceBranchStatusArgsSchema,
      async (_, [workspaceId, projectId]): Promise<GitBranchQuickStatus> => {
        return workspaceGitService.getBranchQuickStatus(workspaceId, projectId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_LIST_BRANCHES,
    handleValidated(
      IPC.WORKSPACE_LIST_BRANCHES,
      workspaceListBranchesArgsSchema,
      async (_, [workspaceId, includeRemote = false]): Promise<BranchInfo[]> => {
        return workspaceGitService.listBranches(workspaceId, includeRemote);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_COMMIT_GRAPH,
    handleValidated(
      IPC.WORKSPACE_GET_COMMIT_GRAPH,
      workspaceCommitGraphArgsSchema,
      async (_, [workspaceId, query]): Promise<CommitGraph> => {
        return workspaceGitService.getCommitGraph(workspaceId, query);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_PULL_REQUEST_STATUS,
    handleValidated(
      IPC.WORKSPACE_GET_PULL_REQUEST_STATUS,
      workspacePullRequestStatusArgsSchema,
      async (_, [workspaceId]): Promise<PullRequestStatus> =>
        pullRequestStatusService.get(workspaceId)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_COMMIT_DIFF,
    handleValidated(
      IPC.WORKSPACE_GET_COMMIT_DIFF,
      workspaceCommitDiffArgsSchema,
      async (_, [workspaceId, commitHash]): Promise<CommitDiff> => {
        return workspaceGitService.getCommitDiff(workspaceId, commitHash);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GET_COMMIT_FILE_DIFF,
    handleValidated(
      IPC.WORKSPACE_GET_COMMIT_FILE_DIFF,
      workspaceCommitFileDiffArgsSchema,
      async (_, [workspaceId, commitHash, filePath]): Promise<FileDiffContent> => {
        return workspaceGitService.getCommitFileDiff(workspaceId, commitHash, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_FETCH_REMOTE,
    handleValidated(
      IPC.WORKSPACE_FETCH_REMOTE,
      workspaceFetchRemoteArgsSchema,
      async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.fetchFromRemote(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_INSPECT_COMMIT_SCOPE,
    handleValidated(
      IPC.WORKSPACE_INSPECT_COMMIT_SCOPE,
      workspaceInspectCommitScopeArgsSchema,
      async (_, [workspaceId]): Promise<CommitScopeResult> => {
        return workspaceGitService.inspectCommitScope(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GENERATE_COMMIT_DRAFT,
    handleValidated(
      IPC.WORKSPACE_GENERATE_COMMIT_DRAFT,
      workspaceGenerateCommitDraftArgsSchema,
      async (_, [workspaceId]): Promise<CommitDraftResult> => {
        return workspaceGitService.generateCommitDraft(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_COMMIT_CHANGES,
    handleValidated(
      IPC.WORKSPACE_COMMIT_CHANGES,
      workspaceCommitChangesArgsSchema,
      async (_, [workspaceId, input]): Promise<CommitChangesResult> => {
        return workspaceGitService.commitChanges(workspaceId, input);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_CREATE_BRANCH,
    handleValidated(
      IPC.WORKSPACE_CREATE_BRANCH,
      workspaceCreateBranchArgsSchema,
      async (_, [workspaceId, branchName, startPoint]): Promise<void> => {
        return workspaceGitService.createBranch(workspaceId, branchName, startPoint);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_SWITCH_BRANCH,
    handleValidated(
      IPC.WORKSPACE_SWITCH_BRANCH,
      workspaceSwitchBranchArgsSchema,
      async (_, [workspaceId, branchName]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.switchBranch(workspaceId, branchName);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_MERGE_FROM,
    handleValidated(
      IPC.WORKSPACE_MERGE_FROM,
      workspaceMergeFromArgsSchema,
      async (
        _,
        [workspaceId, branchName, options]
      ): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.mergeFrom(workspaceId, branchName, options);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_REBASE_ON_BRANCH,
    handleValidated(
      IPC.WORKSPACE_REBASE_ON_BRANCH,
      workspaceRebaseOnBranchArgsSchema,
      async (
        _,
        [workspaceId, branchName, options]
      ): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.rebaseOnBranch(workspaceId, branchName, options);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_PUSH,
    handleValidated(
      IPC.WORKSPACE_PUSH,
      workspacePushPullArgsSchema,
      async (
        event,
        [workspaceId]
      ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> => {
        return workspaceGitService.push(workspaceId, (workingDirectory) => {
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window || window.isDestroyed()) return;
          window.webContents.send(IPC.GIT_PROGRESS, {
            operation: 'fetch',
            repoPath: workingDirectory,
            percent: 0,
            stage: 'Syncing local Git state',
          });
        });
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_PULL,
    handleValidated(
      IPC.WORKSPACE_PULL,
      workspacePushPullArgsSchema,
      async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.pull(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_PUSH_TARGET_BRANCH,
    handleValidated(
      IPC.WORKSPACE_PUSH_TARGET_BRANCH,
      workspaceTargetBranchActionArgsSchema,
      async (
        event,
        [workspaceId]
      ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> => {
        return workspaceGitService.pushTargetBranch(workspaceId, (workingDirectory) => {
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window || window.isDestroyed()) return;
          window.webContents.send(IPC.GIT_PROGRESS, {
            operation: 'fetch',
            repoPath: workingDirectory,
            percent: 0,
            stage: 'Syncing local Git state',
          });
        });
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_PULL_TARGET_BRANCH,
    handleValidated(
      IPC.WORKSPACE_PULL_TARGET_BRANCH,
      workspaceTargetBranchActionArgsSchema,
      async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.pullTargetBranch(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_MERGE_TARGET_BRANCH_FROM_REMOTE,
    handleValidated(
      IPC.WORKSPACE_MERGE_TARGET_BRANCH_FROM_REMOTE,
      workspaceTargetBranchActionArgsSchema,
      async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.mergeTargetBranchFromRemote(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_MERGE_TO_TARGET_BRANCH,
    handleValidated(
      IPC.WORKSPACE_MERGE_TO_TARGET_BRANCH,
      workspaceTargetBranchActionArgsSchema,
      async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.mergeToTargetBranch(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RESTORE_FILE,
    handleValidated(
      IPC.WORKSPACE_RESTORE_FILE,
      workspaceRestoreFileArgsSchema,
      async (_, [workspaceId, filePath, status, oldPath]): Promise<void> => {
        return workspaceGitService.restoreFile(workspaceId, filePath, status, oldPath);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_DISCARD_ALL_CHANGES,
    handleValidated(
      IPC.WORKSPACE_DISCARD_ALL_CHANGES,
      workspaceDiscardAllChangesArgsSchema,
      async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
        return workspaceGitService.discardAllChanges(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_MERGE_FROM,
    handleValidated(
      IPC.GIT_MERGE_FROM,
      mergeFromWithStashArgsSchema,
      async (
        _,
        [worktreePath, branchName, options]
      ): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.mergeFrom(worktreePath, branchName, options);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_LIST_BRANCHES,
    handleValidated(
      IPC.GIT_LIST_BRANCHES,
      listBranchesArgsSchema,
      async (_, [repoPath, includeRemote = false]): Promise<BranchInfo[]> => {
        assertLocalGitPath(repoPath);
        return gitService.listBranches(repoPath, includeRemote);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_HAS_ORIGIN_REMOTE,
    handleValidated(
      IPC.GIT_HAS_ORIGIN_REMOTE,
      repoPathArgsSchema,
      async (_, [repoPath]): Promise<boolean> => {
        assertLocalGitPath(repoPath);
        return gitService.hasRemote(repoPath, 'origin');
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_MAIN_BRANCH,
    handleValidated(
      IPC.GIT_GET_MAIN_BRANCH,
      repoPathArgsSchema,
      async (_, [repoPath]): Promise<string> => {
        assertLocalGitPath(repoPath);
        return gitService.getTargetBranch(repoPath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_FETCH,
    handleValidated(
      IPC.GIT_FETCH,
      repoPathArgsSchema,
      async (event, [repoPath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(repoPath);
        const window = BrowserWindow.fromWebContents(event.sender);
        return gitService.fetchFromRemote(repoPath, (percent, stage) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.GIT_PROGRESS, {
              operation: 'fetch',
              repoPath,
              percent,
              stage,
            });
          }
        });
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_PUSH,
    handleValidated(
      IPC.GIT_PUSH,
      worktreePathArgsSchema,
      async (event, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        const window = BrowserWindow.fromWebContents(event.sender);
        return gitService.push(worktreePath, (percent, stage) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.GIT_PROGRESS, {
              operation: 'push',
              repoPath: worktreePath,
              percent,
              stage,
            });
          }
        });
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_PULL,
    handleValidated(
      IPC.GIT_PULL,
      worktreePathArgsSchema,
      async (event, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        const window = BrowserWindow.fromWebContents(event.sender);
        return gitService.pull(worktreePath, (percent, stage) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.GIT_PROGRESS, {
              operation: 'pull',
              repoPath: worktreePath,
              percent,
              stage,
            });
          }
        });
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_PULL_REBASE,
    handleValidated(
      IPC.GIT_PULL_REBASE,
      worktreePathArgsSchema,
      async (event, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        const window = BrowserWindow.fromWebContents(event.sender);
        return gitService.pullRebase(worktreePath, (percent, stage) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.GIT_PROGRESS, {
              operation: 'pull',
              repoPath: worktreePath,
              percent,
              stage,
            });
          }
        });
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_PUSH_TARGET_BRANCH,
    handleValidated(
      IPC.GIT_PUSH_TARGET_BRANCH,
      worktreePathArgsSchema,
      async (event, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        const window = BrowserWindow.fromWebContents(event.sender);
        return gitService.pushTargetBranch(worktreePath, (percent, stage) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.GIT_PROGRESS, {
              operation: 'push',
              repoPath: worktreePath,
              percent,
              stage,
            });
          }
        });
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_PULL_TARGET_BRANCH,
    handleValidated(
      IPC.GIT_PULL_TARGET_BRANCH,
      worktreePathArgsSchema,
      async (event, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        const window = BrowserWindow.fromWebContents(event.sender);
        return gitService.pullTargetBranch(worktreePath, (percent, stage) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.GIT_PROGRESS, {
              operation: 'pull',
              repoPath: worktreePath,
              percent,
              stage,
            });
          }
        });
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_MERGE_TARGET_BRANCH_FROM_REMOTE,
    handleValidated(
      IPC.GIT_MERGE_TARGET_BRANCH_FROM_REMOTE,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.mergeTargetBranchFromRemote(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_REBASE_ON_TARGET_BRANCH,
    handleValidated(
      IPC.GIT_REBASE_ON_TARGET_BRANCH,
      rebaseOnTargetBranchArgsSchema,
      async (_, [worktreePath, options]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.rebaseOnTargetBranch(worktreePath, options);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_REBASE_ON_BRANCH,
    handleValidated(
      IPC.GIT_REBASE_ON_BRANCH,
      rebaseOnBranchArgsSchema,
      async (
        _,
        [worktreePath, branchName, options]
      ): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.rebaseOnBranch(worktreePath, branchName, options);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_ABORT_REBASE,
    handleValidated(
      IPC.GIT_ABORT_REBASE,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.abortRebase(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_MERGE_TO_TARGET_BRANCH,
    handleValidated(
      IPC.GIT_MERGE_TO_TARGET_BRANCH,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.mergeToTargetBranch(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_SWITCH_BRANCH,
    handleValidated(
      IPC.GIT_SWITCH_BRANCH,
      mergeFromArgsSchema,
      async (_, [worktreePath, branchName]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.switchBranch(worktreePath, branchName);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_DELETE_BRANCH,
    handleValidated(
      IPC.GIT_DELETE_BRANCH,
      deleteBranchArgsSchema,
      async (
        _,
        [worktreePath, branchName, force = false]
      ): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.deleteBranch(worktreePath, branchName, force);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_DELETE_REMOTE_BRANCH,
    handleValidated(
      IPC.GIT_DELETE_REMOTE_BRANCH,
      mergeFromArgsSchema,
      async (_, [worktreePath, branchName]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.deleteRemoteBranch(worktreePath, branchName);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_BRANCH_URL,
    handleValidated(
      IPC.GIT_GET_BRANCH_URL,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<string | null> => {
        assertLocalGitPath(worktreePath);
        return gitService.getBranchUrl(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_CREATE_PR_URL,
    handleValidated(
      IPC.GIT_GET_CREATE_PR_URL,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<string | null> => {
        assertLocalGitPath(worktreePath);
        return gitService.getCreatePrUrl(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_REPO_WEB_INFO,
    handleValidated(
      IPC.GIT_GET_REPO_WEB_INFO,
      repoPathArgsSchema,
      async (_, [repoPath]): Promise<RepoWebInfo> => {
        assertLocalGitPath(repoPath);
        return gitService.getRepoWebInfo(repoPath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_FILE_EXISTS,
    handleValidated(
      IPC.GIT_FILE_EXISTS,
      fileExistsArgsSchema,
      async (_, [dirPath, filePath]): Promise<boolean> => {
        assertLocalGitPath(dirPath);
        assertSafeRelativePath(dirPath, filePath, 'filePath');
        return gitService.fileExists(dirPath, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_FILE_METADATA,
    handleValidated(
      IPC.GIT_GET_FILE_METADATA,
      getFileMetadataArgsSchema,
      async (_, [dirPath, filePath]): Promise<{ size: number; mtimeMs: number }> => {
        assertSafeRelativePath(dirPath, filePath, 'filePath');
        return gitService.getFileMetadata(dirPath, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_COPY_FILE,
    handleValidated(
      IPC.GIT_COPY_FILE,
      copyFileArgsSchema,
      async (_, [workingDir, src, dest]): Promise<void> => {
        assertLocalGitPath(workingDir);
        assertSafeRelativePath(workingDir, src, 'src');
        assertSafeRelativePath(workingDir, dest, 'dest');
        return gitService.copyFile(workingDir, src, dest);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_COPY_DIRECTORY,
    handleValidated(
      IPC.GIT_COPY_DIRECTORY,
      copyDirectoryArgsSchema,
      async (_, [workingDir, src, dest]): Promise<void> => {
        assertLocalGitPath(workingDir);
        assertSafeRelativePath(workingDir, src, 'src');
        assertSafeRelativePath(workingDir, dest, 'dest');
        return gitService.copyDirectory(workingDir, src, dest);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_IMPORT_EXTERNAL_FILE,
    handleValidated(
      IPC.GIT_IMPORT_EXTERNAL_FILE,
      importExternalFileArgsSchema,
      async (_, [workingDir, sourcePath, preferredName]): Promise<string> => {
        assertLocalGitPath(workingDir);
        return gitService.importExternalFile(workingDir, sourcePath, preferredName);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_DELETE_FILE,
    handleValidated(
      IPC.GIT_DELETE_FILE,
      deleteFileArgsSchema,
      async (_, [worktreePath, filePath, status]): Promise<void> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, filePath, 'filePath');
        return gitService.deleteFile(worktreePath, filePath, status);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_RENAME_FILE,
    handleValidated(
      IPC.GIT_RENAME_FILE,
      renameFileArgsSchema,
      async (_, [worktreePath, oldPath, newPath]): Promise<void> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, oldPath, 'oldPath');
        assertSafeRelativePath(worktreePath, newPath, 'newPath');
        return gitService.renameFile(worktreePath, oldPath, newPath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_CREATE_DIRECTORY,
    handleValidated(
      IPC.GIT_CREATE_DIRECTORY,
      createDirectoryArgsSchema,
      async (_, [worktreePath, dirPath]): Promise<void> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, dirPath, 'dirPath');
        return gitService.createDirectory(worktreePath, dirPath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_WRITE_FILE,
    handleValidated(
      IPC.GIT_WRITE_FILE,
      writeFileArgsSchema,
      async (_, [worktreePath, filePath, content]): Promise<void> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, filePath, 'filePath');
        assertNoNullBytes(content, 'content');
        return gitService.writeFile(worktreePath, filePath, content);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_LIST_FILES,
    handleValidated(
      IPC.GIT_LIST_FILES,
      listFilesArgsSchema,
      async (
        _,
        [dirPath, includeGitIgnored]
      ): Promise<{ files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] }> => {
        assertLocalGitPath(dirPath);
        return gitService.listFiles(dirPath, includeGitIgnored);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_READ_FILE,
    handleValidated(
      IPC.GIT_READ_FILE,
      readFileArgsSchema,
      async (_, [dirPath, filePath]): Promise<string> => {
        assertLocalGitPath(dirPath);
        assertSafeRelativePath(dirPath, filePath, 'filePath');
        return gitService.readFileContent(dirPath, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_READ_IMAGE_FILE,
    handleValidated(
      IPC.GIT_READ_IMAGE_FILE,
      readFileArgsSchema,
      async (_, [dirPath, filePath]): Promise<{ data: string; mimeType: string }> => {
        assertLocalGitPath(dirPath);
        assertSafeRelativePath(dirPath, filePath, 'filePath');
        return gitService.readImageFileContent(dirPath, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_MEDIA_FILE_METADATA,
    handleValidated(
      IPC.GIT_GET_MEDIA_FILE_METADATA,
      readFileArgsSchema,
      async (
        _,
        [dirPath, filePath]
      ): Promise<{ mimeType: string; kind: 'audio' | 'video'; size: number; mtimeMs: number }> => {
        assertLocalGitPath(dirPath);
        assertSafeRelativePath(dirPath, filePath, 'filePath');
        return gitService.getMediaFileMetadata(dirPath, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_READ_MEDIA_FILE,
    handleValidated(
      IPC.GIT_READ_MEDIA_FILE,
      readFileArgsSchema,
      async (
        _,
        [dirPath, filePath]
      ): Promise<{ data: string; mimeType: string; kind: 'audio' | 'video' }> => {
        assertLocalGitPath(dirPath);
        assertSafeRelativePath(dirPath, filePath, 'filePath');
        return gitService.readMediaFileContent(dirPath, filePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_RESTORE_FILE,
    handleValidated(
      IPC.GIT_RESTORE_FILE,
      restoreFileArgsSchema,
      async (_, [worktreePath, filePath, status, oldPath]): Promise<void> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, filePath, 'filePath');
        if (oldPath) {
          assertSafeRelativePath(worktreePath, oldPath, 'oldPath');
        }
        return gitService.restoreFile(worktreePath, filePath, status, oldPath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_DISCARD_ALL_CHANGES,
    handleValidated(
      IPC.GIT_DISCARD_ALL_CHANGES,
      worktreePathArgsSchema,
      async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
        assertLocalGitPath(worktreePath);
        return gitService.discardAllChanges(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_INSPECT_COMMIT_SCOPE,
    handleValidated(
      IPC.GIT_INSPECT_COMMIT_SCOPE,
      inspectCommitScopeArgsSchema,
      async (_, [worktreePath]): Promise<CommitScopeResult> => {
        return gitService.inspectCommitScope(worktreePath);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GENERATE_COMMIT_DRAFT,
    handleValidated(
      IPC.GIT_GENERATE_COMMIT_DRAFT,
      generateCommitDraftArgsSchema,
      async (_, [worktreePath, scope]): Promise<CommitDraftResult> => {
        return gitService.generateCommitDraft(worktreePath, scope);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_COMMIT_CHANGES,
    handleValidated(
      IPC.GIT_COMMIT_CHANGES,
      commitChangesArgsSchema,
      async (_, [worktreePath, input]): Promise<CommitChangesResult> => {
        return gitService.commitChanges(worktreePath, input);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_VALIDATE_REMOTE_URL,
    handleValidated(
      IPC.GIT_VALIDATE_REMOTE_URL,
      validateRemoteUrlArgsSchema,
      async (_, [url]): Promise<{ valid: boolean; error?: string }> => {
        return gitService.validateRemoteUrl(url);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_ADD_ORIGIN_REMOTE,
    handleValidated(
      IPC.GIT_ADD_ORIGIN_REMOTE,
      addRemoteArgsSchema,
      async (_, [repoPath, url]): Promise<{ success: boolean; message: string }> => {
        try {
          await gitService.setOriginRemote(repoPath, url);
          return { success: true, message: 'Remote added successfully' };
        } catch (error) {
          return { success: false, message: extractGitError(error, 'Failed to add remote') };
        }
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_CREATE_GITHUB_REPO,
    handleValidated(
      IPC.GIT_CREATE_GITHUB_REPO,
      createGithubRepoArgsSchema,
      async (
        _,
        [repoPath, repoName, isPrivate]
      ): Promise<{ success: boolean; message: string; url?: string }> => {
        try {
          // Step 1: Create the repo on GitHub (without --source, which doesn't handle worktrees)
          const repoUrl = await createGithubRepo(repoName, isPrivate);

          // Step 2: Point origin at it, replacing an origin that has no branches
          await gitService.setOriginRemote(repoPath, repoUrl);

          // Step 3: Push main/master branch to establish it as the default on GitHub
          const mainBranch = await gitService.getTargetBranch(repoPath);
          await gitService.pushToRemote(repoPath, 'origin', mainBranch);

          return { success: true, message: `Created and pushed to ${repoName}`, url: repoUrl };
        } catch (error) {
          const err = error as { stderr?: string; message?: string };
          const message = err.stderr?.trim() || err.message || 'Failed to create GitHub repository';
          return { success: false, message };
        }
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_PUSH_PROJECT_BRANCHES,
    handleValidated(
      IPC.GIT_PUSH_PROJECT_BRANCHES,
      pushProjectBranchesArgsSchema,
      async (
        _,
        [projectId, branches]
      ): Promise<{ success: boolean; message: string; removedOrigin?: boolean }> => {
        const project = projectService.get(projectId);
        if (!project) {
          return { success: false, message: 'Project not found' };
        }
        const repoPath = projectRepoPath(project);
        try {
          const pushed = await gitService.pushBranchesMissingFromOrigin(repoPath, branches);
          return {
            success: true,
            message: pushed.length > 0 ? `Pushed ${pushed.join(', ')}` : 'Nothing to push',
          };
        } catch (error) {
          const message = extractGitError(error, 'Failed to push to origin');
          // A URL no repository answers at would otherwise stay as origin, and the project
          // would no longer offer to be published.
          const removedOrigin = await gitService
            .removeOriginWithoutBranches(repoPath)
            .catch(() => false);
          return { success: false, message, removedOrigin };
        }
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_CHECK_GH_AUTH,
    (): Promise<{ authenticated: boolean; username?: string; installed: boolean }> => checkGhAuth()
  );

  ipcMain.handle(
    IPC.GIT_GET_IDENTITY,
    handleValidated(
      IPC.GIT_GET_IDENTITY,
      getGitIdentityArgsSchema,
      (): Promise<GitIdentityStatus> => gitService.getIdentityStatus()
    )
  );

  ipcMain.handle(
    IPC.GIT_SET_IDENTITY,
    handleValidated(
      IPC.GIT_SET_IDENTITY,
      setGitIdentityArgsSchema,
      async (_, [userName, userEmail]): Promise<{ success: boolean; message: string }> => {
        try {
          await gitService.setGlobalIdentity(userName, userEmail);
          return { success: true, message: 'Git identity saved' };
        } catch (error) {
          return { success: false, message: extractGitError(error, 'Failed to save git identity') };
        }
      }
    )
  );

  // Managed repo handlers
  ipcMain.handle(
    IPC.MANAGED_REPO_FETCH,
    handleValidated(
      IPC.MANAGED_REPO_FETCH,
      managedRepoFetchArgsSchema,
      async (_, [projectId]): Promise<{ success: boolean; message: string }> => {
        const project = projectService.get(projectId);
        if (!project) {
          return { success: false, message: 'Project not found' };
        }
        if (!project.managed || !project.managedRepoPath) {
          // For non-managed projects, fall back to regular fetch
          return gitService.fetchFromRemote(project.repositoryPath);
        }
        return managedRepoService.fetch(project.managedRepoPath);
      }
    )
  );

  ipcMain.handle(
    IPC.MANAGED_REPO_PUSH,
    handleValidated(
      IPC.MANAGED_REPO_PUSH,
      managedRepoPushPullStatusArgsSchema,
      async (_, [projectId, branchName]): Promise<{ success: boolean; message: string }> => {
        const project = projectService.get(projectId);
        if (!project) {
          return { success: false, message: 'Project not found' };
        }
        if (!project.managed || !project.managedRepoPath) {
          return { success: false, message: 'Project is not managed' };
        }
        return managedRepoService.push(project.managedRepoPath, branchName);
      }
    )
  );

  ipcMain.handle(
    IPC.MANAGED_REPO_GET_REMOTE_STATUS,
    handleValidated(
      IPC.MANAGED_REPO_GET_REMOTE_STATUS,
      managedRepoPushPullStatusArgsSchema,
      async (_, [projectId, branchName]): Promise<RemoteStatus> => {
        const project = projectService.get(projectId);
        if (!project || !project.managed || !project.managedRepoPath) {
          return { hasRemote: false, ahead: 0, behind: 0, lastFetched: null };
        }
        return managedRepoService.getRemoteStatus(project.managedRepoPath, branchName);
      }
    )
  );

  // Project sync status handlers
  ipcMain.handle(
    IPC.PROJECT_SYNC_GET_ALL_STATUSES,
    async (): Promise<
      Array<{
        projectId: string;
        hasRemote: boolean;
        behindRemote: number;
        aheadRemote: number;
        lastFetched: number | null;
        mainBranch: string;
      }>
    > => {
      const allProjects = projectService.list();
      const results: Array<{
        projectId: string;
        hasRemote: boolean;
        behindRemote: number;
        aheadRemote: number;
        lastFetched: number | null;
        mainBranch: string;
      }> = [];

      for (const project of allProjects) {
        if (!project.managed || !project.managedRepoPath) {
          continue;
        }

        try {
          const mainBranch =
            project.baseBranch || (await gitService.getMainBranch(project.managedRepoPath));
          const status = await managedRepoService.getRemoteStatus(
            project.managedRepoPath,
            mainBranch
          );
          results.push({
            projectId: project.id,
            hasRemote: status.hasRemote,
            behindRemote: status.behind,
            aheadRemote: status.ahead,
            lastFetched: status.lastFetched,
            mainBranch,
          });
        } catch {
          // Skip projects with errors
        }
      }

      return results;
    }
  );

  ipcMain.handle(
    IPC.PROJECT_SYNC_REFRESH,
    handleValidated(
      IPC.PROJECT_SYNC_REFRESH,
      projectSyncRefreshArgsSchema,
      async (
        _,
        [projectId, skipFetch]
      ): Promise<{
        projectId: string;
        hasRemote: boolean;
        behindRemote: number;
        aheadRemote: number;
        lastFetched: number | null;
        mainBranch: string;
      } | null> => {
        const project = projectService.get(projectId);
        if (!project || !project.managed || !project.managedRepoPath) {
          return null;
        }

        try {
          // Fetch from remote first to get latest refs
          if (!skipFetch) {
            await managedRepoService.fetch(project.managedRepoPath);
          }
          const mainBranch =
            project.baseBranch || (await gitService.getMainBranch(project.managedRepoPath));
          const status = await managedRepoService.getRemoteStatus(
            project.managedRepoPath,
            mainBranch
          );
          return {
            projectId: project.id,
            hasRemote: status.hasRemote,
            behindRemote: status.behind,
            aheadRemote: status.ahead,
            lastFetched: status.lastFetched,
            mainBranch,
          };
        } catch {
          return null;
        }
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_GET_BLAME,
    handleValidated(
      IPC.GIT_GET_BLAME,
      blameArgsSchema,
      async (_, [worktreePath, filePath, commitHash]): Promise<BlameHunk[]> => {
        assertLocalGitPath(worktreePath);
        assertSafeRelativePath(worktreePath, filePath, 'filePath');
        return gitService.getBlame(worktreePath, filePath, commitHash);
      }
    )
  );

  ipcMain.handle(
    IPC.GIT_REFRESH_STATUS,
    handleValidated(
      IPC.GIT_REFRESH_STATUS,
      refreshGitStatusArgsSchema,
      async (_, [workspaceId]): Promise<void> => {
        await workspaceStatusService.change({ kind: 'refresh-requested', workspaceId });
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_OBSERVATIONS_GET,
    handleValidated(IPC.WORKSPACE_OBSERVATIONS_GET, getWorkspaceObservationsArgsSchema, async () =>
      workspaceStatusService.read()
    )
  );
}
