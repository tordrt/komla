import { dirname, join, posix } from 'path';

import { app, dialog, BrowserWindow } from 'electron';

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
import { handleIpc } from '../validation/ipc-validators';
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

  handleIpc(IPC.CONFIG_SELECT_DIRECTORY, async (): Promise<string | null> => {
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
  handleIpc(IPC.CONFIG_SELECT_ANY_DIRECTORY, async (): Promise<string | null> => {
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
  handleIpc(
    IPC.GIT_GET_DIRECTORY_INFO,
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
  );

  handleIpc(IPC.GIT_LIST_WORKTREES, async (_, [repoPath]) => {
    const worktrees = await gitService.listWorktrees(repoPath);
    return worktrees.map((w) => w.path);
  });

  handleIpc(IPC.GIT_GET_WORKTREE_BRANCHES, async (_, [repoPath]): Promise<string[]> => {
    const worktrees = await gitService.listWorktrees(repoPath);
    return worktrees.map((w) => w.branch);
  });

  handleIpc(IPC.GIT_VALIDATE_REPO, async (_, [path]): Promise<boolean> => {
    return gitService.isGitRepo(path);
  });

  handleIpc(IPC.GIT_GET_CHANGED_FILES_WITH_SUMMARY, async (_, [worktreePath]) => {
    assertLocalGitPath(worktreePath);
    const isGit = await gitService.isGitRepo(worktreePath);
    if (!isGit) {
      return {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      };
    }
    return gitService.getChangedFilesWithSummary(worktreePath);
  });

  handleIpc(IPC.GIT_GET_DIFF, async (_, [worktreePath]): Promise<WorktreeDiff> => {
    assertLocalGitPath(worktreePath);
    const isGit = await gitService.isGitRepo(worktreePath);
    if (!isGit) {
      return {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      };
    }
    return gitService.getWorkingTreeDiff(worktreePath);
  });

  handleIpc(
    IPC.GIT_GET_DIFF_AGAINST_BRANCH,
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
  );

  handleIpc(
    IPC.GIT_GET_FILE_DIFF_CONTENT,
    async (_, [worktreePath, filePath, staged]): Promise<FileDiffContent> => {
      assertLocalGitPath(worktreePath);
      assertSafeRelativePath(worktreePath, filePath, 'filePath');
      return gitService.getFullFileDiff(worktreePath, filePath, staged);
    }
  );

  handleIpc(
    IPC.GIT_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
    async (_, [worktreePath, filePath, branch, useMergeBase]): Promise<FileDiffContent> => {
      assertLocalGitPath(worktreePath);
      assertSafeRelativePath(worktreePath, filePath, 'filePath');
      return gitService.getFullFileDiffAgainstBranch(worktreePath, filePath, branch, useMergeBase);
    }
  );

  handleIpc(IPC.WORKSPACE_GET_DIFF, async (_, [workspaceId]): Promise<WorktreeDiff> => {
    return workspaceGitService.getWorkingTreeDiff(workspaceId);
  });

  handleIpc(
    IPC.WORKSPACE_GET_DIFF_AGAINST_BRANCH,
    async (_, [workspaceId, branch, useMergeBase]): Promise<WorktreeDiff> => {
      return workspaceGitService.getWorkingTreeDiffAgainstBranch(workspaceId, branch, useMergeBase);
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_FILE_DIFF_CONTENT,
    async (_, [workspaceId, filePath, staged]): Promise<FileDiffContent> => {
      return workspaceGitService.getFullFileDiff(workspaceId, filePath, staged);
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
    async (_, [workspaceId, filePath, branch, useMergeBase]): Promise<FileDiffContent> => {
      return workspaceGitService.getFullFileDiffAgainstBranch(
        workspaceId,
        filePath,
        branch,
        useMergeBase
      );
    }
  );

  handleIpc(
    IPC.WORKSPACE_LIST_FILES,
    async (
      _,
      [workspaceId, includeGitIgnored]
    ): Promise<{
      files: string[];
      gitIgnoredFiles: string[];
      emptyDirs: string[];
      fileListHash?: string;
    }> => workspaceFileService.listFiles(workspaceId, includeGitIgnored)
  );

  handleIpc(
    IPC.WORKSPACE_IMPORT_EXTERNAL_FILE,
    async (_, [workspaceId, sourcePath, preferredName, executionLocation]): Promise<string> =>
      workspaceFileService.importExternalFile(
        workspaceId,
        sourcePath,
        preferredName,
        executionLocation
      )
  );

  handleIpc(
    IPC.WORKSPACE_READ_VIEWER_FILE,
    async (_, [workspaceId, terminalId, source]): Promise<ViewerFile> => {
      if (source.kind === 'workspace') {
        assertSafeRelativePath('/workspace', source.filePath, 'filePath');
      }
      return workspaceFileService.readViewerFile(workspaceId, terminalId, source);
    }
  );

  handleIpc(
    IPC.WORKSPACE_DOWNLOAD_VIEWER_FILE,
    async (event, [workspaceId, terminalId, source]): Promise<string | null> => {
      if (source.kind === 'workspace') {
        assertSafeRelativePath('/workspace', source.filePath, 'filePath');
      }
      // Fails before a Save dialog for a file that can't be downloaded.
      const { name } = workspaceFileService.prepareViewerFileDownload(
        workspaceId,
        terminalId,
        source
      );
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: 'Save File',
        defaultPath: join(app.getPath('downloads'), posix.basename(name)),
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await workspaceFileService.downloadViewerFile(
        workspaceId,
        terminalId,
        source,
        result.filePath
      );
      return result.filePath;
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_VIEWER_PREVIEW_URL,
    async (_, [workspaceId, terminalId, source, options]): Promise<string> => {
      if (source.kind === 'workspace') {
        assertSafeRelativePath('/workspace', source.filePath, 'filePath');
      }
      return workspaceFileService.getViewerPreviewUrl(workspaceId, terminalId, source, options);
    }
  );

  handleIpc(
    IPC.WORKSPACE_LIST_VIEWER_FOLDER,
    async (_, [workspaceId, terminalId, source]): Promise<ViewerFolderFile[]> => {
      if (source.kind === 'workspace') {
        assertSafeRelativePath('/workspace', source.filePath, 'filePath');
      }
      return workspaceFileService.listViewerFolder(workspaceId, terminalId, source);
    }
  );

  handleIpc(IPC.WORKSPACE_READ_FILE, async (_, [workspaceId, filePath]): Promise<string> => {
    assertSafeRelativePath('/workspace', filePath, 'filePath');
    return workspaceFileService.readFile(workspaceId, filePath);
  });

  handleIpc(
    IPC.WORKSPACE_SEARCH_CONTENT,
    async (_, [workspaceId, query, options]): Promise<ContentSearchResult[]> =>
      workspaceFileService.searchContent(workspaceId, query, options)
  );

  handleIpc(
    IPC.WORKSPACE_READ_IMAGE_FILE,
    async (_, [workspaceId, filePath]): Promise<{ data: string; mimeType: string }> => {
      assertSafeRelativePath('/workspace', filePath, 'filePath');
      return workspaceFileService.readImageFile(workspaceId, filePath);
    }
  );

  handleIpc(
    IPC.WORKSPACE_WRITE_FILE,
    async (_, [workspaceId, filePath, content]): Promise<void> => {
      assertSafePosixRelativePath(filePath, 'filePath');
      assertNoNullBytes(content, 'content');
      return workspaceFileService.writeFile(workspaceId, filePath, content);
    }
  );

  handleIpc(IPC.WORKSPACE_DELETE_PATH, async (_, [workspaceId, filePath]): Promise<void> => {
    assertSafePosixRelativePath(filePath, 'filePath');
    return workspaceFileService.deletePath(workspaceId, filePath);
  });

  handleIpc(
    IPC.GIT_GET_HTML_PREVIEW_URL,
    (_, [worktreePath, filePath, content]): Promise<string> =>
      content === undefined
        ? htmlPreviewService.createPreviewUrl(worktreePath, filePath)
        : htmlPreviewService.createContentPreviewUrl(filePath, content, { web: true })
  );

  handleIpc(
    IPC.GIT_GET_BRANCH_STATUS,
    async (_, [worktreePath, projectId]): Promise<GitBranchQuickStatus> => {
      assertLocalGitPath(worktreePath);
      const status = await gitService.getBranchQuickStatus(worktreePath);
      await applyManagedRepoTargetBranchAheadRemote(status, projectId);
      return status;
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_BRANCH_STATUS,
    async (_, [workspaceId, projectId]): Promise<GitBranchQuickStatus> => {
      return workspaceGitService.getBranchQuickStatus(workspaceId, projectId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_LIST_BRANCHES,
    async (_, [workspaceId, includeRemote = false]): Promise<BranchInfo[]> => {
      return workspaceGitService.listBranches(workspaceId, includeRemote);
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_COMMIT_GRAPH,
    async (_, [workspaceId, query]): Promise<CommitGraph> => {
      return workspaceGitService.getCommitGraph(workspaceId, query);
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_PULL_REQUEST_STATUS,
    async (_, [workspaceId]): Promise<PullRequestStatus> =>
      pullRequestStatusService.get(workspaceId)
  );

  handleIpc(
    IPC.WORKSPACE_GET_COMMIT_DIFF,
    async (_, [workspaceId, commitHash]): Promise<CommitDiff> => {
      return workspaceGitService.getCommitDiff(workspaceId, commitHash);
    }
  );

  handleIpc(
    IPC.WORKSPACE_GET_COMMIT_FILE_DIFF,
    async (_, [workspaceId, commitHash, filePath]): Promise<FileDiffContent> => {
      return workspaceGitService.getCommitFileDiff(workspaceId, commitHash, filePath);
    }
  );

  handleIpc(
    IPC.WORKSPACE_FETCH_REMOTE,
    async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.fetchFromRemote(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_INSPECT_COMMIT_SCOPE,
    async (_, [workspaceId]): Promise<CommitScopeResult> => {
      return workspaceGitService.inspectCommitScope(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_GENERATE_COMMIT_DRAFT,
    async (_, [workspaceId]): Promise<CommitDraftResult> => {
      return workspaceGitService.generateCommitDraft(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_COMMIT_CHANGES,
    async (_, [workspaceId, input]): Promise<CommitChangesResult> => {
      return workspaceGitService.commitChanges(workspaceId, input);
    }
  );

  handleIpc(
    IPC.WORKSPACE_CREATE_BRANCH,
    async (_, [workspaceId, branchName, startPoint]): Promise<void> => {
      return workspaceGitService.createBranch(workspaceId, branchName, startPoint);
    }
  );

  handleIpc(
    IPC.WORKSPACE_SWITCH_BRANCH,
    async (_, [workspaceId, branchName]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.switchBranch(workspaceId, branchName);
    }
  );

  handleIpc(
    IPC.WORKSPACE_MERGE_FROM,
    async (
      _,
      [workspaceId, branchName, options]
    ): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.mergeFrom(workspaceId, branchName, options);
    }
  );

  handleIpc(
    IPC.WORKSPACE_REBASE_ON_BRANCH,
    async (
      _,
      [workspaceId, branchName, options]
    ): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.rebaseOnBranch(workspaceId, branchName, options);
    }
  );

  handleIpc(
    IPC.WORKSPACE_PUSH,
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
  );

  handleIpc(
    IPC.WORKSPACE_PULL,
    async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.pull(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_PUSH_TARGET_BRANCH,
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
  );

  handleIpc(
    IPC.WORKSPACE_PULL_TARGET_BRANCH,
    async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.pullTargetBranch(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_MERGE_TARGET_BRANCH_FROM_REMOTE,
    async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.mergeTargetBranchFromRemote(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_MERGE_TO_TARGET_BRANCH,
    async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.mergeToTargetBranch(workspaceId);
    }
  );

  handleIpc(
    IPC.WORKSPACE_RESTORE_FILE,
    async (_, [workspaceId, filePath, status, oldPath]): Promise<void> => {
      return workspaceGitService.restoreFile(workspaceId, filePath, status, oldPath);
    }
  );

  handleIpc(
    IPC.WORKSPACE_DISCARD_ALL_CHANGES,
    async (_, [workspaceId]): Promise<{ success: boolean; message: string }> => {
      return workspaceGitService.discardAllChanges(workspaceId);
    }
  );

  handleIpc(
    IPC.GIT_MERGE_FROM,
    async (
      _,
      [worktreePath, branchName, options]
    ): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.mergeFrom(worktreePath, branchName, options);
    }
  );

  handleIpc(
    IPC.GIT_LIST_BRANCHES,
    async (_, [repoPath, includeRemote = false]): Promise<BranchInfo[]> => {
      assertLocalGitPath(repoPath);
      return gitService.listBranches(repoPath, includeRemote);
    }
  );

  handleIpc(IPC.GIT_HAS_ORIGIN_REMOTE, async (_, [repoPath]): Promise<boolean> => {
    assertLocalGitPath(repoPath);
    return gitService.hasRemote(repoPath, 'origin');
  });

  handleIpc(IPC.GIT_GET_MAIN_BRANCH, async (_, [repoPath]): Promise<string> => {
    assertLocalGitPath(repoPath);
    return gitService.getTargetBranch(repoPath);
  });

  handleIpc(
    IPC.GIT_FETCH,
    async (event, [repoPath]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(repoPath);
      const window = BrowserWindow.fromWebContents(event.sender);
      return workspaceGitService.fetchPath(repoPath, (percent, stage) => {
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
  );

  handleIpc(
    IPC.GIT_PUSH,
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
  );

  handleIpc(
    IPC.GIT_PULL,
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
  );

  handleIpc(
    IPC.GIT_PULL_REBASE,
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
  );

  handleIpc(
    IPC.GIT_PUSH_TARGET_BRANCH,
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
  );

  handleIpc(
    IPC.GIT_PULL_TARGET_BRANCH,
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
  );

  handleIpc(
    IPC.GIT_MERGE_TARGET_BRANCH_FROM_REMOTE,
    async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.mergeTargetBranchFromRemote(worktreePath);
    }
  );

  handleIpc(
    IPC.GIT_REBASE_ON_TARGET_BRANCH,
    async (_, [worktreePath, options]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.rebaseOnTargetBranch(worktreePath, options);
    }
  );

  handleIpc(
    IPC.GIT_REBASE_ON_BRANCH,
    async (
      _,
      [worktreePath, branchName, options]
    ): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.rebaseOnBranch(worktreePath, branchName, options);
    }
  );

  handleIpc(
    IPC.GIT_ABORT_REBASE,
    async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.abortRebase(worktreePath);
    }
  );

  handleIpc(
    IPC.GIT_MERGE_TO_TARGET_BRANCH,
    async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.mergeToTargetBranch(worktreePath);
    }
  );

  handleIpc(
    IPC.GIT_SWITCH_BRANCH,
    async (_, [worktreePath, branchName]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.switchBranch(worktreePath, branchName);
    }
  );

  handleIpc(
    IPC.GIT_DELETE_BRANCH,
    async (
      _,
      [worktreePath, branchName, force = false]
    ): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.deleteBranch(worktreePath, branchName, force);
    }
  );

  handleIpc(
    IPC.GIT_DELETE_REMOTE_BRANCH,
    async (_, [worktreePath, branchName]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.deleteRemoteBranch(worktreePath, branchName);
    }
  );

  handleIpc(IPC.GIT_GET_BRANCH_URL, async (_, [worktreePath]): Promise<string | null> => {
    assertLocalGitPath(worktreePath);
    return gitService.getBranchUrl(worktreePath);
  });

  handleIpc(IPC.GIT_GET_CREATE_PR_URL, async (_, [worktreePath]): Promise<string | null> => {
    assertLocalGitPath(worktreePath);
    return gitService.getCreatePrUrl(worktreePath);
  });

  handleIpc(IPC.GIT_GET_REPO_WEB_INFO, async (_, [repoPath]): Promise<RepoWebInfo> => {
    assertLocalGitPath(repoPath);
    return gitService.getRepoWebInfo(repoPath);
  });

  handleIpc(IPC.GIT_FILE_EXISTS, async (_, [dirPath, filePath]): Promise<boolean> => {
    assertLocalGitPath(dirPath);
    assertSafeRelativePath(dirPath, filePath, 'filePath');
    return gitService.fileExists(dirPath, filePath);
  });

  handleIpc(
    IPC.GIT_GET_FILE_METADATA,
    async (_, [dirPath, filePath]): Promise<{ size: number; mtimeMs: number }> => {
      assertSafeRelativePath(dirPath, filePath, 'filePath');
      return gitService.getFileMetadata(dirPath, filePath);
    }
  );

  handleIpc(IPC.GIT_COPY_FILE, async (_, [workingDir, src, dest]): Promise<void> => {
    assertLocalGitPath(workingDir);
    assertSafeRelativePath(workingDir, src, 'src');
    assertSafeRelativePath(workingDir, dest, 'dest');
    return gitService.copyFile(workingDir, src, dest);
  });

  handleIpc(IPC.GIT_COPY_DIRECTORY, async (_, [workingDir, src, dest]): Promise<void> => {
    assertLocalGitPath(workingDir);
    assertSafeRelativePath(workingDir, src, 'src');
    assertSafeRelativePath(workingDir, dest, 'dest');
    return gitService.copyDirectory(workingDir, src, dest);
  });

  handleIpc(
    IPC.GIT_IMPORT_EXTERNAL_FILE,
    async (_, [workingDir, sourcePath, preferredName]): Promise<string> => {
      assertLocalGitPath(workingDir);
      return gitService.importExternalFile(workingDir, sourcePath, preferredName);
    }
  );

  handleIpc(IPC.GIT_DELETE_FILE, async (_, [worktreePath, filePath, status]): Promise<void> => {
    assertLocalGitPath(worktreePath);
    assertSafeRelativePath(worktreePath, filePath, 'filePath');
    return gitService.deleteFile(worktreePath, filePath, status);
  });

  handleIpc(IPC.GIT_RENAME_FILE, async (_, [worktreePath, oldPath, newPath]): Promise<void> => {
    assertLocalGitPath(worktreePath);
    assertSafeRelativePath(worktreePath, oldPath, 'oldPath');
    assertSafeRelativePath(worktreePath, newPath, 'newPath');
    return gitService.renameFile(worktreePath, oldPath, newPath);
  });

  handleIpc(IPC.GIT_CREATE_DIRECTORY, async (_, [worktreePath, dirPath]): Promise<void> => {
    assertLocalGitPath(worktreePath);
    assertSafeRelativePath(worktreePath, dirPath, 'dirPath');
    return gitService.createDirectory(worktreePath, dirPath);
  });

  handleIpc(IPC.GIT_WRITE_FILE, async (_, [worktreePath, filePath, content]): Promise<void> => {
    assertLocalGitPath(worktreePath);
    assertSafeRelativePath(worktreePath, filePath, 'filePath');
    assertNoNullBytes(content, 'content');
    return gitService.writeFile(worktreePath, filePath, content);
  });

  handleIpc(
    IPC.GIT_LIST_FILES,
    async (
      _,
      [dirPath, includeGitIgnored]
    ): Promise<{ files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] }> => {
      assertLocalGitPath(dirPath);
      return gitService.listFiles(dirPath, includeGitIgnored);
    }
  );

  handleIpc(IPC.GIT_READ_FILE, async (_, [dirPath, filePath]): Promise<string> => {
    assertLocalGitPath(dirPath);
    assertSafeRelativePath(dirPath, filePath, 'filePath');
    return gitService.readFileContent(dirPath, filePath);
  });

  handleIpc(
    IPC.GIT_READ_IMAGE_FILE,
    async (_, [dirPath, filePath]): Promise<{ data: string; mimeType: string }> => {
      assertLocalGitPath(dirPath);
      assertSafeRelativePath(dirPath, filePath, 'filePath');
      return gitService.readImageFileContent(dirPath, filePath);
    }
  );

  handleIpc(
    IPC.GIT_GET_MEDIA_FILE_METADATA,
    async (
      _,
      [dirPath, filePath]
    ): Promise<{ mimeType: string; kind: 'audio' | 'video'; size: number; mtimeMs: number }> => {
      assertLocalGitPath(dirPath);
      assertSafeRelativePath(dirPath, filePath, 'filePath');
      return gitService.getMediaFileMetadata(dirPath, filePath);
    }
  );

  handleIpc(
    IPC.GIT_READ_MEDIA_FILE,
    async (
      _,
      [dirPath, filePath]
    ): Promise<{ data: string; mimeType: string; kind: 'audio' | 'video' }> => {
      assertLocalGitPath(dirPath);
      assertSafeRelativePath(dirPath, filePath, 'filePath');
      return gitService.readMediaFileContent(dirPath, filePath);
    }
  );

  handleIpc(
    IPC.GIT_RESTORE_FILE,
    async (_, [worktreePath, filePath, status, oldPath]): Promise<void> => {
      assertLocalGitPath(worktreePath);
      assertSafeRelativePath(worktreePath, filePath, 'filePath');
      if (oldPath) {
        assertSafeRelativePath(worktreePath, oldPath, 'oldPath');
      }
      return gitService.restoreFile(worktreePath, filePath, status, oldPath);
    }
  );

  handleIpc(
    IPC.GIT_DISCARD_ALL_CHANGES,
    async (_, [worktreePath]): Promise<{ success: boolean; message: string }> => {
      assertLocalGitPath(worktreePath);
      return gitService.discardAllChanges(worktreePath);
    }
  );

  handleIpc(IPC.GIT_INSPECT_COMMIT_SCOPE, async (_, [worktreePath]): Promise<CommitScopeResult> => {
    return gitService.inspectCommitScope(worktreePath);
  });

  handleIpc(
    IPC.GIT_GENERATE_COMMIT_DRAFT,
    async (_, [worktreePath, scope]): Promise<CommitDraftResult> => {
      return gitService.generateCommitDraft(worktreePath, scope);
    }
  );

  handleIpc(
    IPC.GIT_COMMIT_CHANGES,
    async (_, [worktreePath, input]): Promise<CommitChangesResult> => {
      return gitService.commitChanges(worktreePath, input);
    }
  );

  handleIpc(
    IPC.GIT_VALIDATE_REMOTE_URL,
    async (_, [url]): Promise<{ valid: boolean; error?: string }> => {
      return gitService.validateRemoteUrl(url);
    }
  );

  handleIpc(
    IPC.GIT_ADD_ORIGIN_REMOTE,
    async (_, [repoPath, url]): Promise<{ success: boolean; message: string }> => {
      try {
        await gitService.setOriginRemote(repoPath, url);
        return { success: true, message: 'Remote added successfully' };
      } catch (error) {
        return { success: false, message: extractGitError(error, 'Failed to add remote') };
      }
    }
  );

  handleIpc(
    IPC.GIT_CREATE_GITHUB_REPO,
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
  );

  handleIpc(
    IPC.GIT_PUSH_PROJECT_BRANCHES,
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
  );

  handleIpc(
    IPC.GIT_CHECK_GH_AUTH,
    (): Promise<{ authenticated: boolean; username?: string; installed: boolean }> => checkGhAuth()
  );

  handleIpc(IPC.GIT_GET_IDENTITY, (): Promise<GitIdentityStatus> => gitService.getIdentityStatus());

  handleIpc(
    IPC.GIT_SET_IDENTITY,
    async (_, [userName, userEmail]): Promise<{ success: boolean; message: string }> => {
      try {
        await gitService.setGlobalIdentity(userName, userEmail);
        return { success: true, message: 'Git identity saved' };
      } catch (error) {
        return { success: false, message: extractGitError(error, 'Failed to save git identity') };
      }
    }
  );

  // Managed repo handlers
  handleIpc(
    IPC.MANAGED_REPO_FETCH,
    async (_, [projectId]): Promise<{ success: boolean; message: string }> =>
      workspaceGitService.fetchProject(projectId)
  );

  handleIpc(
    IPC.MANAGED_REPO_PUSH,
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
  );

  handleIpc(
    IPC.MANAGED_REPO_GET_REMOTE_STATUS,
    async (_, [projectId, branchName]): Promise<RemoteStatus> => {
      const project = projectService.get(projectId);
      if (!project || !project.managed || !project.managedRepoPath) {
        return { hasRemote: false, ahead: 0, behind: 0, lastFetched: null };
      }
      return managedRepoService.getRemoteStatus(project.managedRepoPath, branchName);
    }
  );

  // Project sync status handlers
  handleIpc(
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

  handleIpc(
    IPC.PROJECT_SYNC_REFRESH,
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
  );

  handleIpc(
    IPC.GIT_GET_BLAME,
    async (_, [worktreePath, filePath, commitHash]): Promise<BlameHunk[]> => {
      assertLocalGitPath(worktreePath);
      assertSafeRelativePath(worktreePath, filePath, 'filePath');
      return gitService.getBlame(worktreePath, filePath, commitHash);
    }
  );

  handleIpc(IPC.GIT_REFRESH_STATUS, async (_, [workspaceId]): Promise<void> => {
    await workspaceStatusService.change({ kind: 'refresh-requested', workspaceId });
  });

  handleIpc(IPC.WORKSPACE_OBSERVATIONS_GET, async () => workspaceStatusService.read());
}
