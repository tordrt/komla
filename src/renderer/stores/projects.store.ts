import { create } from 'zustand';

import { disposeTerminalRenderers } from '../lib/terminal-renderer-runtime';

import { useFileListStore } from './file-list.store';
import { useLayoutStore } from './layout.store';
import { useWorkspacesStore } from './workspaces.store';

import type {
  Project,
  CreateProjectParams,
  CreateProjectFromRemoteParams,
  CreateProjectFromNewParams,
} from '../types';

interface ProjectsState {
  projects: Project[];
  expandedProjectIds: Set<string>;
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;

  // Actions
  loadProjects: () => Promise<void>;
  createProject: (params: CreateProjectParams) => Promise<Project>;
  createProjectFromRemote: (params: CreateProjectFromRemoteParams) => Promise<Project>;
  createProjectFromNew: (params: CreateProjectFromNewParams) => Promise<Project>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  reorderProject: (id: string, newOrder: number) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  toggleExpanded: (projectId: string) => void;
  expandProject: (projectId: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  clearError: () => void;
  subscribeToChanges: () => () => void;
}

let projectsLoadPromise: Promise<void> | null = null;

export const useProjectsStore = create<ProjectsState>((set, _get) => ({
  projects: [],
  expandedProjectIds: new Set<string>(),
  isLoading: false,
  hasLoaded: false,
  error: null,

  loadProjects: () => {
    if (projectsLoadPromise) return projectsLoadPromise;
    projectsLoadPromise = (async () => {
      set({ isLoading: true, error: null });
      try {
        const projects = await window.api.getProjects();
        // Expand all projects by default
        const expandedIds = new Set(projects.map((p) => p.id));
        set({ projects, expandedProjectIds: expandedIds, isLoading: false, hasLoaded: true });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false, hasLoaded: true });
      } finally {
        projectsLoadPromise = null;
      }
    })();
    return projectsLoadPromise;
  },

  createProject: async (params) => {
    set({ isLoading: true, error: null });
    try {
      const project = await window.api.createProject(params);
      set((state) => ({
        projects: [...state.projects, project],
        expandedProjectIds: new Set([...state.expandedProjectIds, project.id]),
        isLoading: false,
      }));
      return project;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  createProjectFromRemote: async (params) => {
    set({ isLoading: true, error: null });
    try {
      const project = await window.api.createProjectFromRemote(params);
      set((state) => ({
        projects: [...state.projects, project],
        expandedProjectIds: new Set([...state.expandedProjectIds, project.id]),
        isLoading: false,
      }));
      return project;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  createProjectFromNew: async (params) => {
    set({ isLoading: true, error: null });
    try {
      const project = await window.api.createProjectFromNew(params);
      set((state) => ({
        projects: [...state.projects, project],
        expandedProjectIds: new Set([...state.expandedProjectIds, project.id]),
        isLoading: false,
      }));
      return project;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  updateProject: async (id, updates) => {
    try {
      const project = await window.api.updateProject(id, updates);
      set((state) => ({
        projects: state.projects.map((p) => (p.id === id ? project : p)),
      }));
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  reorderProject: async (id, newOrder) => {
    const currentProjects = _get().projects;
    const sortedProjects = [...currentProjects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const sourceIndex = sortedProjects.findIndex((project) => project.id === id);
    if (sourceIndex === -1) return;

    const maxIndex = sortedProjects.length - 1;
    const targetIndex = Math.max(0, Math.min(Math.round(newOrder), maxIndex));
    if (sourceIndex === targetIndex) return;

    const reordered = [...sortedProjects];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);

    const withNormalizedOrder = reordered.map((project, index) => ({ ...project, order: index }));
    const updatedById = new Map(withNormalizedOrder.map((project) => [project.id, project]));

    // Optimistic update with normalized integer order
    set((state) => ({
      projects: state.projects.map((project) => updatedById.get(project.id) ?? project),
    }));

    const changedProjects = withNormalizedOrder.filter((project, index) => {
      const previous = sortedProjects[index];
      return !previous || previous.id !== project.id || previous.order !== project.order;
    });

    try {
      for (const project of changedProjects) {
        await window.api.updateProject(project.id, { order: project.order });
      }

      const projects = await window.api.getProjects();
      set({ projects });
    } catch (error) {
      // Rollback on error by reloading
      const projects = await window.api.getProjects();
      set({ projects, error: (error as Error).message });
    }
  },

  deleteProject: async (id) => {
    try {
      const { deletedWorkspaceIds } = await window.api.deleteProject(id);

      // Clean up deleted workspaces from the renderer state
      if (deletedWorkspaceIds.length > 0) {
        const workspacesState = useWorkspacesStore.getState();
        const deletedSet = new Set(deletedWorkspaceIds);

        // Dispose terminals and clear layouts for deleted workspaces
        for (const wsId of deletedWorkspaceIds) {
          const workspace = workspacesState.workspaces.find((w) => w.id === wsId);
          if (workspace) {
            disposeTerminalRenderers(workspace.terminals.map((t) => t.id));
            useLayoutStore.getState().clearWorkspaceLayout(wsId);
            if (workspace.workingDirectory) {
              useFileListStore.getState().invalidate(workspace.workingDirectory, wsId);
            }
          }
        }

        const wasSelectedDeleted = deletedSet.has(workspacesState.selectedWorkspaceId ?? '');
        if (wasSelectedDeleted) {
          useLayoutStore.getState().setCurrentWorkspace(null);
        }
        useWorkspacesStore.setState((state) => ({
          workspaces: state.workspaces.filter((w) => !deletedSet.has(w.id)),
          selectedWorkspaceId: wasSelectedDeleted ? null : state.selectedWorkspaceId,
        }));
      }

      set((state) => {
        const newExpandedIds = new Set(state.expandedProjectIds);
        newExpandedIds.delete(id);
        return {
          projects: state.projects.filter((p) => p.id !== id),
          expandedProjectIds: newExpandedIds,
        };
      });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  toggleExpanded: (projectId) => {
    set((state) => {
      const newExpandedIds = new Set(state.expandedProjectIds);
      if (newExpandedIds.has(projectId)) {
        newExpandedIds.delete(projectId);
      } else {
        newExpandedIds.add(projectId);
      }
      return { expandedProjectIds: newExpandedIds };
    });
  },

  expandProject: (projectId) => {
    set((state) => {
      if (state.expandedProjectIds.has(projectId)) return state;
      const newExpandedIds = new Set(state.expandedProjectIds);
      newExpandedIds.add(projectId);
      return { expandedProjectIds: newExpandedIds };
    });
  },

  expandAll: () => {
    set((state) => ({
      expandedProjectIds: new Set(state.projects.map((p) => p.id)),
    }));
  },

  collapseAll: () => {
    set({ expandedProjectIds: new Set() });
  },

  clearError: () => {
    set({ error: null });
  },

  subscribeToChanges: () => {
    // Subscribe to external changes (file watcher hot-reload)
    const unsubscribe = window.api.onProjectsChange((projects) => {
      // Preserve expanded state for existing projects, expand new ones
      set((state) => {
        const existingIds = new Set(state.projects.map((p) => p.id));
        const newProjects = projects.filter((p) => !existingIds.has(p.id));
        const newExpandedIds = new Set(state.expandedProjectIds);
        for (const project of newProjects) {
          newExpandedIds.add(project.id);
        }
        return { projects, expandedProjectIds: newExpandedIds, hasLoaded: true };
      });
    });
    return unsubscribe;
  },
}));
