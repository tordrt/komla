import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { getNextAvailableColor } from '../../shared/lib/project-colors';
import { SETUP_DESTINATIONS, SETUP_STEP_PLACEMENTS, SETUP_TRIGGERS } from '../../shared/types';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';
import { migrate } from '../lib/migration';
import { removePathSync } from '../lib/remove-path';
import { isSamePath } from '../lib/same-path';

const logger = createLogger('ProjectService');

import { FileWatcher } from './file-watcher';
import { gitService, GitProgressCallback } from './git.service';
import { managedRepoService } from './managed-repo.service';
import { getKomlaBasePath } from './paths';

import type {
  SetupStepPlacement,
  AgentPlacement,
  SetupStep,
  Project,
  FolderProjectMatch,
  CreateProjectParams,
  CreateProjectFromRemoteParams,
  CreateProjectFromNewParams,
  SshWorkspaceMode,
} from '../../shared/types';

// Re-export types for consumers that import from this module
export type {
  SetupStepPlacement,
  AgentPlacement,
  SetupStep,
  Project,
  CreateProjectParams,
  CreateProjectFromRemoteParams,
  CreateProjectFromNewParams,
};

const PROJECT_VERSION = 1;
const PROJECT_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

// Empty projects file for fresh installs
const DEFAULT_PROJECTS_FILE = { _version: PROJECT_VERSION, projects: [] as Project[] };
const setupDestinations = new Set<string>(SETUP_DESTINATIONS);
const setupTriggers = new Set<string>(SETUP_TRIGGERS);
const setupPlacements = new Set<string>(SETUP_STEP_PLACEMENTS);

function isValidSetupStep(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  const agent = step.agent;
  return (
    typeof step.id === 'string' &&
    typeof step.name === 'string' &&
    typeof step.command === 'string' &&
    typeof step.placement === 'string' &&
    setupPlacements.has(step.placement) &&
    (step.actionId === undefined || typeof step.actionId === 'string') &&
    (agent === undefined ||
      (agent !== null &&
        typeof agent === 'object' &&
        !Array.isArray(agent) &&
        ((agent as Record<string, unknown>).presetId === undefined ||
          typeof (agent as Record<string, unknown>).presetId === 'string') &&
        ((agent as Record<string, unknown>).launchModeId === undefined ||
          typeof (agent as Record<string, unknown>).launchModeId === 'string'))) &&
    (step.destination === undefined ||
      (typeof step.destination === 'string' && setupDestinations.has(step.destination))) &&
    (step.trigger === undefined ||
      (typeof step.trigger === 'string' && setupTriggers.has(step.trigger)))
  );
}

function normalizeSetupSteps(project: Project): Project {
  if (!project.setupSteps) return project;
  return {
    ...project,
    setupSteps: project.setupSteps.map((step) => ({
      ...step,
      destination: step.destination ?? 'workspace-repository',
      trigger: step.trigger ?? 'every-workspace-start',
    })),
  };
}

export type WorkspaceSetupState = Required<
  Pick<Project, 'setupSteps' | 'agentPlacement' | 'agentLayoutOrder' | 'trashCleanupScript'>
>;

function stripUtf8Bom(data: string): string {
  return data.charCodeAt(0) === 0xfeff ? data.slice(1) : data;
}

function isValidProject(obj: unknown): obj is Project {
  if (typeof obj !== 'object' || obj === null) return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    typeof p['name'] === 'string' &&
    typeof p['repositoryPath'] === 'string' &&
    typeof p['defaultBranchPrefix'] === 'string' &&
    typeof p['createdAt'] === 'number' &&
    typeof p['order'] === 'number' &&
    typeof p['managed'] === 'boolean' &&
    (!('sshWorkspaceMode' in p) ||
      p['sshWorkspaceMode'] === 'remote' ||
      p['sshWorkspaceMode'] === 'local-mirror-actions') &&
    (!('kind' in p) || p['kind'] === 'git' || p['kind'] === 'directory') &&
    (!('setupSteps' in p) ||
      (Array.isArray(p['setupSteps']) && p['setupSteps'].every(isValidSetupStep)))
  );
}

class ProjectService {
  private settingsPath: string;
  private projectsPath: string;
  private defaultsPath: string;
  private defaultProjectsPath: string;
  private watcher: FileWatcher | null = null;
  private projects: Map<string, Project> = new Map();
  private initialized = false;
  private creationsInProgress: Set<string> = new Set();
  private selfWriteRevision: string | null = null;
  private gitSettingsListeners = new Set<(projectId: string) => void>();

  constructor() {
    const komlaPath = getKomlaBasePath();
    this.settingsPath = join(komlaPath, 'settings');
    this.projectsPath = join(this.settingsPath, 'projects.json');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultProjectsPath = join(this.defaultsPath, 'projects.json');

    this.ensureSettingsDirectory();
    this.loadProjects();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  private ensureSettingsDirectory(): void {
    // Create settings directory
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    // Create defaults directory if needed
    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }

    // Write defaults file for reference on first run
    if (!existsSync(this.defaultProjectsPath)) {
      writeFileSync(
        this.defaultProjectsPath,
        JSON.stringify(DEFAULT_PROJECTS_FILE, null, 2),
        'utf-8'
      );
    }

    // Write user config if not exists
    if (!existsSync(this.projectsPath)) {
      writeFileSync(this.projectsPath, JSON.stringify(DEFAULT_PROJECTS_FILE, null, 2), 'utf-8');
    }
  }

  private loadProjects(): void {
    try {
      if (existsSync(this.projectsPath)) {
        const data = readFileSync(this.projectsPath, 'utf-8');
        const parsed: unknown = JSON.parse(stripUtf8Bom(data));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          logger.error('Projects file has unexpected format, resetting to empty list');
          return;
        }

        const migrated = migrate(
          parsed as Record<string, unknown>,
          PROJECT_VERSION,
          PROJECT_MIGRATIONS
        );
        const projectsList = Array.isArray(migrated['projects']) ? migrated['projects'] : [];

        this.projects.clear();
        for (const item of projectsList) {
          if (isValidProject(item)) {
            this.projects.set(item.id, normalizeSetupSteps(item));
          } else {
            logger.warn('Skipping invalid project entry in projects.json', { entry: item });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load projects:', error);
    }
  }

  private saveProjects(propagateError = false): void {
    try {
      const projectsData = {
        _version: PROJECT_VERSION,
        projects: Array.from(this.projects.values()),
      };
      writeFileAtomicSync(this.projectsPath, JSON.stringify(projectsData, null, 2));
    } catch (error) {
      logger.error('Failed to save projects:', error);
      if (propagateError) throw error;
    }
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new FileWatcher(this.projectsPath, () => {
      let revision: string;
      try {
        revision = this.getStorageRevision();
      } catch (error) {
        logger.warn('Failed to read projects revision:', error);
        return;
      }
      if (revision === this.selfWriteRevision) {
        this.selfWriteRevision = null;
        return;
      }
      this.loadProjects();
      this.notifyRenderer();
    });
    await this.watcher.start();
  }

  private notifyRenderer(): void {
    const projects = this.list();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.PROJECTS_CHANGED, projects);
      }
    }
  }

  /**
   * Check if a project folder is orphaned (exists on disk but no project references it).
   * If orphaned, removes it and returns true. If owned by an active project, returns false.
   */
  private cleanupOrphanedFolder(projectFolderPath: string): boolean {
    if (!existsSync(projectFolderPath)) return true;

    const isOrphaned = !Array.from(this.projects.values()).some((p) => {
      if (!p.managed) return false;
      if (p.managedRepoPath && resolve(dirname(p.managedRepoPath)) === resolve(projectFolderPath)) {
        return true;
      }
      return resolve(p.repositoryPath) === resolve(projectFolderPath);
    });
    if (isOrphaned) {
      logger.info(`Cleaning up orphaned project folder: ${projectFolderPath}`);
      removePathSync(projectFolderPath, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  /**
   * Acquire an exclusive lock for creating a project at the given folder path.
   * Throws if another creation is already in progress for the same path.
   */
  private acquireCreationLock(projectFolderPath: string): void {
    if (this.creationsInProgress.has(projectFolderPath)) {
      throw new Error('A project creation is already in progress for this repository');
    }
    this.creationsInProgress.add(projectFolderPath);
  }

  private releaseCreationLock(projectFolderPath: string): void {
    this.creationsInProgress.delete(projectFolderPath);
  }

  private projectNameExists(name: string, excludeId?: string): boolean {
    const normalizedName = name.trim().toLowerCase();
    return Array.from(this.projects.values()).some(
      (project) => project.id !== excludeId && project.name.trim().toLowerCase() === normalizedName
    );
  }

  private getUniqueProjectName(baseName: string): string {
    const trimmedBaseName = baseName.trim();
    if (!trimmedBaseName) {
      throw new Error('Project name is required');
    }
    if (!this.projectNameExists(trimmedBaseName)) return trimmedBaseName;

    for (let index = 2; index < 1000; index++) {
      const candidate = `${trimmedBaseName}-${index}`;
      if (!this.projectNameExists(candidate)) return candidate;
    }

    throw new Error(`Could not find an available project name for ${trimmedBaseName}`);
  }

  private resolveProjectName(defaultName: string, requestedName?: string): string {
    const trimmedRequestedName = requestedName?.trim();
    if (trimmedRequestedName) {
      if (this.projectNameExists(trimmedRequestedName)) {
        throw new Error(`A project named "${trimmedRequestedName}" already exists`);
      }
      return trimmedRequestedName;
    }
    return this.getUniqueProjectName(defaultName);
  }

  // Public API

  async create(params: CreateProjectParams): Promise<Project> {
    if (params.kind === 'directory') {
      return this.createDirectoryProject(params);
    }

    const isValid = await gitService.isGitRepo(params.repositoryPath);
    if (!isValid) {
      return this.createDirectoryProject(params);
    }

    const repositoryPath = resolve(params.repositoryPath);
    const existing = Array.from(this.projects.values()).find(
      (project) =>
        project.kind !== 'directory' && resolve(project.repositoryPath) === repositoryPath
    );
    if (existing) {
      throw new Error(`Project already exists: ${existing.name}`);
    }

    // Auto-derive project name from git repo name unless caller provides a display name.
    const repoName = await gitService.getRepoName(params.repositoryPath);
    const name = this.resolveProjectName(repoName, params.name);

    // Get project folder path for cleanup
    const projectFolderPath = managedRepoService.getProjectFolderPath(name);

    // Clean up orphaned folder or throw if an active project owns it
    if (!this.cleanupOrphanedFolder(projectFolderPath)) {
      throw new Error(`Project already exists: ${name}`);
    }

    this.acquireCreationLock(projectFolderPath);

    // Get max order
    const maxOrder = Array.from(this.projects.values()).reduce(
      (max, p) => Math.max(max, p.order),
      -1
    );

    // Assign color - use provided color or pick next unused from palette
    let color: string;
    if (params.color) {
      color = params.color;
    } else {
      const usedColors = Array.from(this.projects.values())
        .map((p) => p.color)
        .filter(Boolean) as string[];
      color = getNextAvailableColor(usedColors);
    }

    try {
      // Create managed bare clone
      // This allows worktrees on any branch including main/master
      const managedRepoPath = await managedRepoService.createManagedRepo(
        params.repositoryPath,
        name
      );

      const project: Project = {
        id: randomUUID(),
        kind: 'git',
        name,
        repositoryPath: params.repositoryPath,
        defaultBranchPrefix: params.defaultBranchPrefix ?? '',
        baseBranch: params.baseBranch,
        createdAt: Date.now(),
        order: maxOrder + 1,
        color,
        ...(params.icon && { icon: params.icon }),
        ...(params.iconPromptAsked && { iconPromptAsked: true }),
        managed: true,
        managedRepoPath,
        aheadTargetAction: params.aheadTargetAction,
        autoPushAfterMerge: params.autoPushAfterMerge,
        aheadTargetActionId: params.aheadTargetActionId,
        behindTargetAction: params.behindTargetAction,
        autoMainBranchAction: params.autoMainBranchAction,
        autoOtherBranchAction: params.autoOtherBranchAction,
        autoMainActionId: params.autoMainActionId,
        autoOtherActionId: params.autoOtherActionId,
      };

      this.projects.set(project.id, project);
      this.saveProjects();
      return project;
    } catch (error) {
      // Clean up on failure - delete entire project folder
      if (existsSync(projectFolderPath)) {
        removePathSync(projectFolderPath, { recursive: true, force: true });
      }
      throw error;
    } finally {
      this.releaseCreationLock(projectFolderPath);
    }
  }

  private createDirectoryProject(params: CreateProjectParams): Project {
    const directoryPath = resolve(params.repositoryPath);
    if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
      throw new Error('Selected path is not a valid directory');
    }

    const existing = Array.from(this.projects.values()).find(
      (project) => project.kind === 'directory' && isSamePath(project.repositoryPath, directoryPath)
    );
    if (existing) {
      throw new Error(`Directory project already exists: ${existing.name}`);
    }

    const maxOrder = Array.from(this.projects.values()).reduce(
      (max, p) => Math.max(max, p.order),
      -1
    );
    const usedColors = Array.from(this.projects.values())
      .map((p) => p.color)
      .filter(Boolean) as string[];

    const project: Project = {
      id: randomUUID(),
      kind: 'directory',
      name: this.resolveProjectName(this.directoryProjectName(directoryPath), params.name),
      repositoryPath: directoryPath,
      defaultBranchPrefix: '',
      createdAt: Date.now(),
      order: maxOrder + 1,
      color: params.color || getNextAvailableColor(usedColors),
      ...(params.icon && { icon: params.icon }),
      ...(params.iconPromptAsked && { iconPromptAsked: true }),
      managed: false,
      aheadTargetAction: 'disabled',
      autoPushAfterMerge: false,
    };

    this.projects.set(project.id, project);
    this.saveProjects();
    return project;
  }

  /** The folder's name, or with its parent's, like "notes (work)", when a project has it. */
  private directoryProjectName(directoryPath: string): string {
    const name = basename(directoryPath) || directoryPath;
    const parent = basename(dirname(directoryPath));
    if (!this.projectNameExists(name) || !parent) return name;
    return `${name} (${parent})`;
  }

  /** The folder project at `path`, added when there is none yet, so a folder opens as one. */
  findOrCreateDirectoryProject(path: string, color?: string): Project {
    const existing = Array.from(this.projects.values()).find(
      (project) => project.kind === 'directory' && isSamePath(project.repositoryPath, path)
    );
    if (existing) return existing;
    const project = this.createDirectoryProject({ repositoryPath: path, color });
    this.notifyRenderer();
    return project;
  }

  get(id: string | null): Project | undefined {
    return id === null ? undefined : this.projects.get(id);
  }

  list(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.order - b.order);
  }

  getStorageRevision(): string {
    const contents = readFileSync(this.projectsPath, 'utf-8');
    return createHash('sha256').update(contents).digest('hex');
  }

  getStorageRevisionState():
    | { status: 'current'; revision: string }
    | { status: 'changed' | 'unreadable' } {
    try {
      const contents = readFileSync(this.projectsPath, 'utf-8');
      const migrated = migrate(
        JSON.parse(stripUtf8Bom(contents)) as Record<string, unknown>,
        PROJECT_VERSION,
        PROJECT_MIGRATIONS
      );
      const persistedRaw = Array.isArray(migrated['projects']) ? migrated['projects'] : [];
      if (!persistedRaw.every(isValidProject)) return { status: 'changed' };
      const persisted = persistedRaw.map(normalizeSetupSteps);
      if (JSON.stringify(persisted) !== JSON.stringify(Array.from(this.projects.values()))) {
        return { status: 'changed' };
      }
      return {
        status: 'current',
        revision: createHash('sha256').update(contents).digest('hex'),
      };
    } catch {
      return { status: 'unreadable' };
    }
  }

  replaceWorkspaceSetup(
    expectedRevision: string,
    projectId: string,
    setup: WorkspaceSetupState
  ): string {
    if (this.getStorageRevision() !== expectedRevision) {
      throw new Error('Projects revision changed');
    }
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const previous = { ...project };
    Object.assign(project, setup);
    const projectsData = {
      _version: PROJECT_VERSION,
      projects: Array.from(this.projects.values()),
    };
    try {
      writeFileAtomicSync(
        this.projectsPath,
        JSON.stringify(projectsData, null, 2),
        undefined,
        () => {
          if (this.getStorageRevision() !== expectedRevision) {
            throw new Error('Projects revision changed');
          }
        }
      );
    } catch (error) {
      this.projects.set(projectId, previous);
      throw error;
    }

    const revision = this.getStorageRevision();
    this.selfWriteRevision = revision;
    this.notifyRenderer();
    return revision;
  }

  async update(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<Project> {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project ${id} not found`);
    }

    if (typeof updates.name === 'string') {
      const name = updates.name.trim();
      if (!name) {
        throw new Error('Project name is required');
      }
      if (this.projectNameExists(name, id)) {
        throw new Error(`A project named "${name}" already exists`);
      }
      updates.name = name;
    }

    const { baseBranch, defaultBranchPrefix } = project;
    const normalizedUpdates = updates.setupSteps
      ? {
          ...updates,
          setupSteps: normalizeSetupSteps({ ...project, setupSteps: updates.setupSteps })
            .setupSteps,
        }
      : updates;
    Object.assign(project, normalizedUpdates);
    // An empty or unset icon goes back to the color dot. One the user set needs no prompt,
    // then or after going back to the dot.
    if (project.icon) {
      delete project.iconPromptWorkspaceId;
      project.iconPromptAsked = true;
    } else {
      delete project.icon;
    }
    this.saveProjects();
    if (project.baseBranch !== baseBranch || project.defaultBranchPrefix !== defaultBranchPrefix) {
      for (const listener of this.gitSettingsListeners) listener(id);
    }
    return project;
  }

  /** Calls `listener` after a project's target branch or branch prefix changes here. */
  onGitSettingsChange(listener: (projectId: string) => void): () => void {
    this.gitSettingsListeners.add(listener);
    return () => this.gitSettingsListeners.delete(listener);
  }

  /**
   * A new workspace of a project without an icon offers the icons found in its files,
   * unless they were offered before.
   */
  armIconPrompt(id: string, workspaceId: string): void {
    const project = this.projects.get(id);
    if (!project || project.icon || project.iconPromptAsked) return;
    project.iconPromptWorkspaceId = workspaceId;
    this.saveProjects();
    this.notifyRenderer();
  }

  /**
   * Clears the prompt armed for this workspace. True only for the caller that cleared it, so
   * one window asks, and not when icons were offered after it was armed, as a slow SSH scan
   * for an earlier workspace can.
   */
  takeIconPrompt(id: string, workspaceId: string): boolean {
    const project = this.projects.get(id);
    if (!project || project.iconPromptWorkspaceId !== workspaceId) return false;
    delete project.iconPromptWorkspaceId;
    this.saveProjects();
    this.notifyRenderer();
    return !project.iconPromptAsked;
  }

  /** Icons were found and offered; a project without them is asked at a later workspace. */
  markIconPromptAsked(id: string): void {
    const project = this.projects.get(id);
    if (!project || project.iconPromptAsked) return;
    project.iconPromptAsked = true;
    this.saveProjects();
    this.notifyRenderer();
  }

  setSshWorkspaceModeIfUnset(id: string, mode: SshWorkspaceMode): Project {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project ${id} not found`);
    }
    if (project.sshWorkspaceMode !== undefined) return project;

    project.sshWorkspaceMode = mode;
    try {
      this.saveProjects(true);
    } catch (error) {
      delete project.sshWorkspaceMode;
      throw error;
    }
    this.notifyRenderer();
    return project;
  }

  clearPresetReferences(presetId: string): void {
    let changed = false;
    for (const project of this.projects.values()) {
      if (!project.setupSteps?.some((step) => step.agent?.presetId === presetId)) continue;
      project.setupSteps = project.setupSteps.map((step) =>
        step.agent?.presetId === presetId ? { ...step, agent: {} } : step
      );
      changed = true;
    }
    if (changed) {
      this.saveProjects();
      this.notifyRenderer();
    }
  }

  clearLaunchModeReferences(presetId: string, launchModeIds: string[]): void {
    let changed = false;
    for (const project of this.projects.values()) {
      if (
        !project.setupSteps?.some(
          (step) =>
            step.agent?.presetId === presetId &&
            step.agent.launchModeId &&
            launchModeIds.includes(step.agent.launchModeId)
        )
      ) {
        continue;
      }
      project.setupSteps = project.setupSteps.map((step) =>
        step.agent?.presetId === presetId &&
        step.agent.launchModeId &&
        launchModeIds.includes(step.agent.launchModeId)
          ? { ...step, agent: { presetId } }
          : step
      );
      changed = true;
    }
    if (changed) {
      this.saveProjects();
      this.notifyRenderer();
    }
  }

  async delete(id: string): Promise<void> {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project ${id} not found`);
    }

    // Clean up managed repo if it exists
    if (project.managed && project.managedRepoPath) {
      await managedRepoService.deleteManagedRepo(project.managedRepoPath);
    }

    this.projects.delete(id);
    this.saveProjects();
  }

  async validateRepository(path: string): Promise<boolean> {
    return gitService.isGitRepo(path);
  }

  /**
   * Finds the project a folder picked with Open Folder already is: the folder itself, the
   * root of the Git repository it is in, or the repository a linked worktree belongs to,
   * such as a workspace's. A Git project wins over a folder project on the same path.
   */
  async findForFolder(path: string): Promise<FolderProjectMatch> {
    const folder = resolve(path);
    const projects = Array.from(this.projects.values()).sort(
      (a, b) => Number(a.kind === 'directory') - Number(b.kind === 'directory')
    );
    const exact = projects.find((project) => isSamePath(project.repositoryPath, folder));
    if (exact) return { project: exact, repoRoot: null };

    let repoRoot: string;
    let commonGitDir: string;
    try {
      if (!(await gitService.isGitRepo(folder))) return { project: null, repoRoot: null };
      repoRoot = resolve(await gitService.getRepoRoot(folder));
      commonGitDir = resolve(await gitService.getCommonGitDir(folder));
    } catch {
      // Such as inside a .git folder, which has no working tree to open.
      return { project: null, repoRoot: null };
    }
    const project = projects.find(
      (candidate) =>
        candidate.kind !== 'directory' &&
        (isSamePath(candidate.repositoryPath, repoRoot) ||
          isSamePath(join(candidate.repositoryPath, '.git'), commonGitDir) ||
          (candidate.managedRepoPath !== undefined &&
            isSamePath(candidate.managedRepoPath, commonGitDir)))
    );
    return project ? { project, repoRoot: null } : { project: null, repoRoot };
  }

  hasProjects(): boolean {
    return this.projects.size > 0;
  }

  getDefaultProject(): Project | undefined {
    const projects = this.list();
    return projects[0];
  }

  /**
   * Create a project by cloning from a remote URL.
   * Creates bare repo directly at ~/.komla/repos/{name}/.git
   */
  async createFromRemote(
    params: CreateProjectFromRemoteParams,
    onProgress?: GitProgressCallback
  ): Promise<Project> {
    // Extract project name from URL
    // Examples:
    //   https://github.com/user/repo.git -> repo
    //   git@github.com:user/repo.git -> repo
    const match =
      params.remoteUrl.match(/\/([^/]+?)(\.git)?$/) || params.remoteUrl.match(/:([^/]+?)(\.git)?$/);
    const defaultName = match?.[1] || 'project';
    const name = this.resolveProjectName(defaultName, params.name);

    // Get project folder path (for template files)
    const projectFolderPath = managedRepoService.getProjectFolderPath(name);

    // Clean up orphaned folder or throw if an active project owns it
    if (!this.cleanupOrphanedFolder(projectFolderPath)) {
      throw new Error(`Project already exists: ${name}`);
    }

    this.acquireCreationLock(projectFolderPath);

    try {
      // Clone directly as bare repo to ~/.komla/repos/{name}/.git
      // This creates the project folder structure automatically
      const managedRepoPath = await managedRepoService.createManagedRepoFromRemote(
        params.remoteUrl,
        name,
        onProgress
      );

      // Get max order
      const maxOrder = Array.from(this.projects.values()).reduce(
        (max, p) => Math.max(max, p.order),
        -1
      );

      // Assign color
      let color: string;
      if (params.color) {
        color = params.color;
      } else {
        const usedColors = Array.from(this.projects.values())
          .map((p) => p.color)
          .filter(Boolean) as string[];
        color = getNextAvailableColor(usedColors);
      }

      const project: Project = {
        id: randomUUID(),
        kind: 'git',
        name,
        repositoryPath: projectFolderPath, // Project folder (for template files)
        defaultBranchPrefix: params.defaultBranchPrefix ?? '',
        baseBranch: params.baseBranch,
        createdAt: Date.now(),
        order: maxOrder + 1,
        color,
        ...(params.icon && { icon: params.icon }),
        managed: true,
        managedRepoPath, // Bare repo path (for git operations)
        aheadTargetAction: params.aheadTargetAction,
        autoPushAfterMerge: params.autoPushAfterMerge,
        aheadTargetActionId: params.aheadTargetActionId,
        behindTargetAction: params.behindTargetAction,
        autoMainBranchAction: params.autoMainBranchAction,
        autoOtherBranchAction: params.autoOtherBranchAction,
        autoMainActionId: params.autoMainActionId,
        autoOtherActionId: params.autoOtherActionId,
      };

      this.projects.set(project.id, project);
      this.saveProjects();
      return project;
    } catch (error) {
      // Clean up on failure - delete entire project folder
      if (existsSync(projectFolderPath)) {
        removePathSync(projectFolderPath, { recursive: true, force: true });
      }
      throw error;
    } finally {
      this.releaseCreationLock(projectFolderPath);
    }
  }

  /**
   * Create a project with a new empty bare repository.
   * Creates bare repo at ~/.komla/repos/{name}/.git
   */
  async createFromNew(params: CreateProjectFromNewParams): Promise<Project> {
    const name = params.name.trim();
    if (!name) {
      throw new Error('Project name is required');
    }
    if (this.projectNameExists(name)) {
      throw new Error(`A project named "${name}" already exists`);
    }

    // Get project folder path
    const projectFolderPath = managedRepoService.getProjectFolderPath(name);
    const managedRepoPath = managedRepoService.getManagedRepoPath(name);

    // Clean up orphaned folder or throw if an active project owns it
    if (!this.cleanupOrphanedFolder(projectFolderPath)) {
      throw new Error(`A project with this name already exists`);
    }

    this.acquireCreationLock(projectFolderPath);

    // Create project folder
    mkdirSync(projectFolderPath, { recursive: true });

    try {
      // Create bare repo inside project folder
      await gitService.initBareRepo(managedRepoPath);

      // Get max order
      const maxOrder = Array.from(this.projects.values()).reduce(
        (max, p) => Math.max(max, p.order),
        -1
      );

      // Assign color
      let color: string;
      if (params.color) {
        color = params.color;
      } else {
        const usedColors = Array.from(this.projects.values())
          .map((p) => p.color)
          .filter(Boolean) as string[];
        color = getNextAvailableColor(usedColors);
      }

      const project: Project = {
        id: randomUUID(),
        kind: 'git',
        name,
        repositoryPath: projectFolderPath, // Project folder (for template files)
        defaultBranchPrefix: params.defaultBranchPrefix ?? '',
        createdAt: Date.now(),
        order: maxOrder + 1,
        color,
        ...(params.icon && { icon: params.icon }),
        managed: true,
        managedRepoPath, // Bare repo path (for git operations)
        aheadTargetAction: params.aheadTargetAction,
        autoPushAfterMerge: params.autoPushAfterMerge,
        aheadTargetActionId: params.aheadTargetActionId,
        behindTargetAction: params.behindTargetAction,
        autoMainBranchAction: params.autoMainBranchAction,
        autoOtherBranchAction: params.autoOtherBranchAction,
        autoMainActionId: params.autoMainActionId,
        autoOtherActionId: params.autoOtherActionId,
      };

      this.projects.set(project.id, project);
      this.saveProjects();
      return project;
    } catch (error) {
      // Clean up on failure - delete entire project folder
      if (existsSync(projectFolderPath)) {
        removePathSync(projectFolderPath, { recursive: true, force: true });
      }
      throw error;
    } finally {
      this.releaseCreationLock(projectFolderPath);
    }
  }

  getSettingsPath(): string {
    return this.projectsPath;
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const projectService = new ProjectService();
