import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

import { createLogger } from '../lib/logger';
import { removePathSync } from '../lib/remove-path';

import { gitExec, type GitProgressCallback } from './git/git-exec';
import { gitService } from './git.service';
import { getKomlaBasePath } from './paths';

const logger = createLogger('ManagedRepoService');

export interface RemoteStatus {
  hasRemote: boolean;
  ahead: number;
  behind: number;
  lastFetched: number | null;
}

/**
 * Service for managing bare clone repositories
 *
 * When users add a project, Komla creates a project folder at ~/.komla/repos/{name}/
 * with the structure:
 *   ~/.komla/repos/{name}/
 *   ├── .git/           # Bare git repo
 *   ├── .env            # User's untracked template files
 *   └── config/local.json
 *
 * This allows:
 * - Creating worktrees on any branch (including main/master)
 * - Full control over all branches from within Komla
 * - Seamless push/pull to the user's original remote
 * - Template files that get copied to new worktrees
 *
 * Naming the bare repo `.git` makes the project folder the repository's root, so
 * agents that trust a repository at its main root (Codex) trust every worktree
 * of the project at once.
 */
class ManagedRepoService {
  private reposBasePath: string;

  constructor() {
    this.reposBasePath = join(getKomlaBasePath(), 'repos');
  }

  /**
   * Get the path where managed repos are stored
   */
  getReposBasePath(): string {
    return this.reposBasePath;
  }

  /**
   * Get the project folder path for a project name.
   * This is where template files can be placed.
   */
  getProjectFolderPath(projectName: string): string {
    const safeName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-');
    const basePath = join(this.reposBasePath, safeName);

    // If the path doesn't exist, it's safe to use
    if (!existsSync(basePath)) {
      return basePath;
    }

    // Path exists — check if it belongs to the same project name
    const markerPath = join(basePath, '.project-name');
    if (existsSync(markerPath)) {
      try {
        const existingName = readFileSync(markerPath, 'utf-8').trim();
        if (existingName === projectName) {
          return basePath; // Same project, reuse path
        }
      } catch {
        // Marker unreadable, treat as collision
      }
    } else if (projectName === safeName) {
      // No marker, such as a folder left by an interrupted create: it belongs to the
      // project whose name matches the folder exactly.
      return basePath;
    }

    // Collision: append a deterministic hash suffix
    const hash = projectName
      .split('')
      .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
    const suffix = Math.abs(hash).toString(36).slice(0, 6);
    return join(this.reposBasePath, `${safeName}-${suffix}`);
  }

  /**
   * Get the path for a managed bare repo given a project name.
   * The bare repo lives inside the project folder.
   */
  getManagedRepoPath(projectName: string): string {
    return join(this.getProjectFolderPath(projectName), '.git');
  }

  /**
   * Create a managed bare clone of a local repository
   *
   * If the source repo has an 'origin' remote, the bare clone's 'origin'
   * will point to that remote URL. Otherwise, no remote is configured.
   *
   * @param sourcePath Path to the user's original repository
   * @param projectName Name of the project (used for the managed repo directory)
   * @returns Path to the created bare clone
   */
  async createManagedRepo(sourcePath: string, projectName: string): Promise<string> {
    const projectFolderPath = this.getProjectFolderPath(projectName);
    const managedRepoPath = this.getManagedRepoPath(projectName);

    // Check if already exists
    if (existsSync(projectFolderPath)) {
      throw new Error(`Project folder already exists at ${projectFolderPath}`);
    }

    // Create project folder first
    mkdirSync(projectFolderPath, { recursive: true });
    writeFileSync(join(projectFolderPath, '.project-name'), projectName, 'utf-8');

    // Check if source repo has an origin remote with a real URL
    let originUrl: string | null = null;
    try {
      originUrl = await gitService.getRemoteUrl(sourcePath);
    } catch {
      // No origin remote
    }

    // Create bare clone inside project folder
    await gitService.cloneBare(sourcePath, managedRepoPath);

    // The bare clone now has 'origin' pointing to sourcePath (local filesystem)
    // We need to either update it to the real remote URL, or remove it entirely
    if (originUrl) {
      // Source has a remote - point to it
      await gitService.removeRemote(managedRepoPath, 'origin');
      await gitService.addRemote(managedRepoPath, 'origin', originUrl);
      // Copy remote-tracking refs from the source repo so the bare clone
      // starts with the same remote branch info the user already has locally.
      // This avoids a network fetch while still providing useful remote refs.
      await this.copyRemoteTrackingRefs(sourcePath, managedRepoPath);
    } else {
      // No remote configured - remove the useless local path remote
      await gitService.removeRemote(managedRepoPath, 'origin');
    }

    return managedRepoPath;
  }

  /**
   * Copy remote-tracking refs (refs/remotes/origin/*) from a source repo
   * into the bare clone. This gives the bare clone the same remote branch
   * info the user already has locally, without hitting the network.
   */
  private async copyRemoteTrackingRefs(sourcePath: string, managedRepoPath: string): Promise<void> {
    try {
      const output = await gitExec.execGitAsync(sourcePath, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/remotes/origin/',
      ]);

      if (!output.trim()) return;

      for (const line of output.trim().split('\n')) {
        const [refname, sha] = line.split(' ');
        if (!refname || !sha) continue;
        // Skip the symbolic HEAD ref (refs/remotes/origin/HEAD)
        if (refname === 'refs/remotes/origin/HEAD') continue;

        try {
          await gitExec.execGitAsync(managedRepoPath, ['update-ref', refname, sha]);
        } catch {
          // Object may not exist in bare clone if source had refs to commits
          // not reachable from any local branch — skip silently
        }
      }
    } catch (error) {
      // Non-fatal — the bare clone still works, just without remote-tracking refs
      logger.warn('Failed to copy remote-tracking refs:', error);
    }
  }

  /**
   * Create a managed bare clone directly from a remote URL
   * The remote URL is kept as 'origin' (the true origin of the code)
   *
   * @param remoteUrl URL of the remote repository
   * @param projectName Name of the project (used for the managed repo directory)
   * @param onProgress Optional progress callback
   * @returns Path to the created bare clone
   */
  async createManagedRepoFromRemote(
    remoteUrl: string,
    projectName: string,
    onProgress?: GitProgressCallback
  ): Promise<string> {
    const projectFolderPath = this.getProjectFolderPath(projectName);
    const managedRepoPath = this.getManagedRepoPath(projectName);

    // Check if already exists
    if (existsSync(projectFolderPath)) {
      throw new Error(`Project folder already exists at ${projectFolderPath}`);
    }

    // Create project folder first
    mkdirSync(projectFolderPath, { recursive: true });
    writeFileSync(join(projectFolderPath, '.project-name'), projectName, 'utf-8');

    // Clone directly as bare from the remote URL into project folder
    // The 'origin' remote will point to the actual remote URL
    await gitService.cloneBareFromRemote(remoteUrl, managedRepoPath, onProgress);

    // The clone command includes a --config flag that sets up the fetch refspec
    // for remote tracking refs (refs/remotes/origin/*), so they are populated
    // during the clone itself — no separate fetch needed.

    return managedRepoPath;
  }

  /**
   * Delete a managed repository.
   * Deletes the entire project folder containing the bare repo.
   */
  async deleteManagedRepo(managedRepoPath: string): Promise<void> {
    if (!existsSync(managedRepoPath)) {
      return;
    }

    const parentDir = dirname(managedRepoPath);
    removePathSync(parentDir, { recursive: true, force: true });
  }

  /**
   * Fetch all branches from the remote (origin)
   * This syncs the bare clone with the remote
   */
  async fetch(managedRepoPath: string): Promise<{ success: boolean; message: string }> {
    try {
      await gitService.fetchAllBranches(managedRepoPath, 'origin');
      return { success: true, message: 'Fetched from remote' };
    } catch (error) {
      const err = error as { message?: string };
      return { success: false, message: err.message || 'Fetch failed' };
    }
  }

  /**
   * Push a branch to the remote (origin)
   * This sends commits from the bare clone to the remote
   */
  async push(
    managedRepoPath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      await gitService.pushToRemote(managedRepoPath, 'origin', branchName);
      return { success: true, message: `Pushed ${branchName} to remote` };
    } catch (error) {
      const err = error as { message?: string };
      return { success: false, message: err.message || 'Push failed' };
    }
  }

  /**
   * Get the status of a branch relative to remote (origin)
   * Returns how many commits ahead/behind the local branch is
   */
  async getRemoteStatus(managedRepoPath: string, branchName: string): Promise<RemoteStatus> {
    try {
      // Check if origin remote exists before comparing refs
      const hasOrigin = await gitService.hasRemote(managedRepoPath, 'origin');
      if (!hasOrigin) {
        return { hasRemote: false, ahead: 0, behind: 0, lastFetched: null };
      }

      try {
        await gitExec.execGitAsync(managedRepoPath, [
          'rev-parse',
          '--verify',
          `origin/${branchName}`,
        ]);
      } catch {
        return { hasRemote: false, ahead: 0, behind: 0, lastFetched: Date.now() };
      }

      // For bare repos, we compare local branch to what we last fetched
      const { ahead, behind } = await gitService.getAheadBehind(
        managedRepoPath,
        branchName,
        `origin/${branchName}`
      );

      return { hasRemote: true, ahead, behind, lastFetched: Date.now() };
    } catch {
      return { hasRemote: false, ahead: 0, behind: 0, lastFetched: null };
    }
  }

  /**
   * Check if a managed repo exists
   */
  async exists(managedRepoPath: string): Promise<boolean> {
    if (!existsSync(managedRepoPath)) {
      return false;
    }
    return gitService.isBareRepo(managedRepoPath);
  }

  /**
   * Get the origin URL for a managed repo
   */
  async getOriginUrl(managedRepoPath: string): Promise<string | null> {
    try {
      const isBare = await gitService.isBareRepo(managedRepoPath);
      if (!isBare) return null;

      const hasOrigin = await gitService.hasRemote(managedRepoPath, 'origin');
      if (!hasOrigin) return null;

      return await gitService.getRemoteUrlByName(managedRepoPath, 'origin');
    } catch {
      return null;
    }
  }
}

export const managedRepoService = new ManagedRepoService();
