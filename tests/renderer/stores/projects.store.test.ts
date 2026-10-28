import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));

import { useProjectsStore } from '../../../src/renderer/stores/projects.store';

function resetStore(): void {
  useProjectsStore.setState(useProjectsStore.getInitialState(), true);
}

const project1 = { id: 'p-1', name: 'Project 1', order: 0 };
const project2 = { id: 'p-2', name: 'Project 2', order: 1 };

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getProjects: vi.fn().mockResolvedValue([project1, project2]),
    createProject: vi.fn().mockResolvedValue({ id: 'p-new', name: 'New Project', order: 2 }),
    createProjectFromRemote: vi
      .fn()
      .mockResolvedValue({ id: 'p-remote', name: 'Remote', order: 3 }),
    createProjectFromNew: vi.fn().mockResolvedValue({ id: 'p-new2', name: 'New2', order: 4 }),
    updateProject: vi
      .fn()
      .mockImplementation(async (id: string, updates: any) => ({ ...project1, id, ...updates })),
    deleteProject: vi.fn().mockResolvedValue({ deletedWorkspaceIds: [] }),
    onProjectsChange: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('projects.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadProjects fetches and expands all projects', async () => {
    await useProjectsStore.getState().loadProjects();
    const state = useProjectsStore.getState();
    expect(state.projects).toEqual([project1, project2]);
    expect(state.expandedProjectIds.has('p-1')).toBe(true);
    expect(state.expandedProjectIds.has('p-2')).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.hasLoaded).toBe(true);
  });

  it('loadProjects handles errors', async () => {
    mockApi({ getProjects: vi.fn().mockRejectedValue(new Error('Failed')) });
    await useProjectsStore.getState().loadProjects();
    expect(useProjectsStore.getState().error).toBe('Failed');
    expect(useProjectsStore.getState().isLoading).toBe(false);
    expect(useProjectsStore.getState().hasLoaded).toBe(true);
  });

  it('createProject adds project to list and expands it', async () => {
    const result = await useProjectsStore.getState().createProject({ name: 'New' } as any);
    expect(result.id).toBe('p-new');
    const state = useProjectsStore.getState();
    expect(state.projects).toHaveLength(1);
    expect(state.expandedProjectIds.has('p-new')).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  it('createProject propagates errors', async () => {
    mockApi({ createProject: vi.fn().mockRejectedValue(new Error('Create failed')) });
    await expect(
      useProjectsStore.getState().createProject({ name: 'Fail' } as any)
    ).rejects.toThrow('Create failed');
    expect(useProjectsStore.getState().error).toBe('Create failed');
  });

  it('createProjectFromRemote adds project', async () => {
    const result = await useProjectsStore
      .getState()
      .createProjectFromRemote({ repoUrl: 'https://...' } as any);
    expect(result.id).toBe('p-remote');
    expect(useProjectsStore.getState().projects).toHaveLength(1);
  });

  it('createProjectFromNew adds project', async () => {
    const result = await useProjectsStore.getState().createProjectFromNew({ name: 'New2' } as any);
    expect(result.id).toBe('p-new2');
    expect(useProjectsStore.getState().projects).toHaveLength(1);
  });

  it('updateProject replaces project in list', async () => {
    useProjectsStore.setState({ projects: [project1, project2] as any });
    await useProjectsStore.getState().updateProject('p-1', { name: 'Updated' });
    expect(useProjectsStore.getState().projects[0].name).toBe('Updated');
    expect(useProjectsStore.getState().projects[1]).toEqual(project2);
  });

  it('deleteProject removes project and its expanded state', async () => {
    useProjectsStore.setState({
      projects: [project1, project2] as any,
      expandedProjectIds: new Set(['p-1', 'p-2']),
    });
    await useProjectsStore.getState().deleteProject('p-1');
    const state = useProjectsStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(['p-2']);
    expect(state.expandedProjectIds.has('p-1')).toBe(false);
    expect(state.expandedProjectIds.has('p-2')).toBe(true);
  });

  it('toggleExpanded toggles project expansion state', () => {
    useProjectsStore.setState({ expandedProjectIds: new Set(['p-1']) });
    useProjectsStore.getState().toggleExpanded('p-1');
    expect(useProjectsStore.getState().expandedProjectIds.has('p-1')).toBe(false);
    useProjectsStore.getState().toggleExpanded('p-1');
    expect(useProjectsStore.getState().expandedProjectIds.has('p-1')).toBe(true);
  });

  it('expandProject adds the target id and is idempotent when already expanded', () => {
    useProjectsStore.setState({ expandedProjectIds: new Set(['p-2']) });
    useProjectsStore.getState().expandProject('p-1');
    const afterAdd = useProjectsStore.getState().expandedProjectIds;
    expect(afterAdd.has('p-1')).toBe(true);
    expect(afterAdd.has('p-2')).toBe(true);

    // Idempotent: calling again should not mutate the set
    useProjectsStore.getState().expandProject('p-1');
    const afterNoop = useProjectsStore.getState().expandedProjectIds;
    expect(afterNoop).toBe(afterAdd);
  });

  it('expandAll expands all projects', () => {
    useProjectsStore.setState({
      projects: [project1, project2] as any,
      expandedProjectIds: new Set(),
    });
    useProjectsStore.getState().expandAll();
    expect(useProjectsStore.getState().expandedProjectIds.size).toBe(2);
  });

  it('collapseAll clears expanded set', () => {
    useProjectsStore.setState({ expandedProjectIds: new Set(['p-1', 'p-2']) });
    useProjectsStore.getState().collapseAll();
    expect(useProjectsStore.getState().expandedProjectIds.size).toBe(0);
  });

  it('clearError resets error', () => {
    useProjectsStore.setState({ error: 'some error' });
    useProjectsStore.getState().clearError();
    expect(useProjectsStore.getState().error).toBeNull();
  });

  it('subscribeToChanges handles new projects by expanding them', () => {
    let callback: ((projects: any[]) => void) | undefined;
    mockApi({
      onProjectsChange: vi.fn((cb: any) => {
        callback = cb;
        return vi.fn();
      }),
    });

    useProjectsStore.setState({
      projects: [project1] as any,
      expandedProjectIds: new Set(['p-1']),
    });

    useProjectsStore.getState().subscribeToChanges();

    // Simulate external change with a new project
    callback!([project1, project2] as any);
    const state = useProjectsStore.getState();
    expect(state.projects).toEqual([project1, project2]);
    expect(state.expandedProjectIds.has('p-1')).toBe(true);
    expect(state.expandedProjectIds.has('p-2')).toBe(true);
  });

  it('reorderProject reorders projects optimistically', async () => {
    const p1 = { id: 'p-1', name: 'P1', order: 0 };
    const p2 = { id: 'p-2', name: 'P2', order: 1 };
    const p3 = { id: 'p-3', name: 'P3', order: 2 };
    const api = mockApi({
      getProjects: vi.fn().mockResolvedValue([
        { ...p2, order: 0 },
        { ...p3, order: 1 },
        { ...p1, order: 2 },
      ]),
      updateProject: vi.fn().mockResolvedValue(undefined),
    });
    useProjectsStore.setState({ projects: [p1, p2, p3] as any });

    await useProjectsStore.getState().reorderProject('p-1', 2);
    expect(api.updateProject).toHaveBeenCalled();
  });

  it('reorderProject ignores missing project id', async () => {
    const api = mockApi();
    useProjectsStore.setState({ projects: [project1] as any });
    await useProjectsStore.getState().reorderProject('missing', 0);
    expect(api.updateProject).not.toHaveBeenCalled();
  });
});
