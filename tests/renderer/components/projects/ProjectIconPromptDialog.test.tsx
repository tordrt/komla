/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectIconPromptDialog } from '../../../../src/renderer/components/projects/ProjectIconPromptDialog';
import { PROJECT_COLORS } from '../../../../src/renderer/lib/project-colors';
import { useAgentSetupNudgeStore } from '../../../../src/renderer/stores/agent-setup-nudge.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useWindowStore } from '../../../../src/renderer/stores/window.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createProject, createWorkspace } from '../../../factories';

const iconColors = vi.hoisted((): Record<string, string[]> => ({}));

vi.mock('../../../../src/renderer/lib/icon-colors', () => ({
  readIconColors: async (dataUrl: string) => iconColors[dataUrl] ?? [],
}));

const favicon = { path: 'public/favicon.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' };
const logo = { path: 'logo.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };

const api = {
  takeProjectIconPrompt: vi.fn(),
  updateProject: vi.fn(),
};

const cloned = createProject({
  id: 'cloned',
  name: 'site',
  color: PROJECT_COLORS[3],
  iconPromptWorkspaceId: 'new',
});

function addWorkspaces(...workspaces: ReturnType<typeof createWorkspace>[]) {
  act(() => useWorkspacesStore.setState({ workspaces }));
}

describe('ProjectIconPromptDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(iconColors)) delete iconColors[key];
    (window as unknown as { api: typeof api }).api = api;
    api.takeProjectIconPrompt.mockResolvedValue([favicon, logo]);
    api.updateProject.mockImplementation(async (id: string, updates: object) => ({
      ...cloned,
      id,
      ...updates,
    }));
    useProjectsStore.setState({ projects: [cloned] });
    useWorkspacesStore.setState({ workspaces: [] });
    useWindowStore.setState({ windowId: 'window-1' });
    useAgentSetupNudgeStore.setState({ open: false, nudge: null });
  });

  it("offers the project's icons once the new local workspace is ready", async () => {
    const user = userEvent.setup();
    render(<ProjectIconPromptDialog />);

    const older = createWorkspace({ windowId: 'window-1', id: 'older', projectId: 'cloned' });
    addWorkspaces(
      older,
      createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned', provisioning: true })
    );
    expect(api.takeProjectIconPrompt).not.toHaveBeenCalled();

    addWorkspaces(older, createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));
    expect(await screen.findByRole('dialog', { name: 'Pick an icon for site' })).toBeVisible();
    expect(api.takeProjectIconPrompt).toHaveBeenCalledWith('new');
    expect(screen.getByRole('button', { name: favicon.path })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await user.click(screen.getByRole('button', { name: logo.path }));
    await user.click(screen.getByRole('button', { name: 'Use icon' }));
    expect(api.updateProject).toHaveBeenCalledWith('cloned', { icon: logo.dataUrl });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Another workspace of the project doesn't ask again.
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'second', projectId: 'cloned' }));
    expect(api.takeProjectIconPrompt).toHaveBeenCalledTimes(1);
  });

  it("suggests the icon's main color, and keeps the current one when that is picked", async () => {
    const user = userEvent.setup();
    iconColors[favicon.dataUrl] = ['#61dafb', '#e11d48'];
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));

    const colors = await screen.findByRole('group', { name: 'Project color' });
    const [first, second, current] = within(colors).getAllByRole('button');
    expect(first).toHaveAccessibleName('Icon color #61dafb');
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(second).toHaveAccessibleName('Icon color #e11d48');
    expect(current).toHaveStyle({ backgroundColor: PROJECT_COLORS[3] });

    await user.click(second);
    await user.click(screen.getByRole('button', { name: 'Use icon' }));
    expect(api.updateProject).toHaveBeenCalledWith('cloned', {
      icon: favicon.dataUrl,
      color: '#e11d48',
    });

    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'other', projectId: 'other' }));
    act(() =>
      useProjectsStore.setState({
        projects: [{ ...cloned, id: 'other', name: 'docs', iconPromptWorkspaceId: 'other' }],
      })
    );
    await user.click(
      within(await screen.findByRole('group', { name: 'Project color' })).getAllByRole(
        'button'
      )[2]
    );
    await user.click(screen.getByRole('button', { name: 'Use icon' }));
    expect(api.updateProject).toHaveBeenLastCalledWith('other', { icon: favicon.dataUrl });
  });

  it('offers the current color once when the icon has it too', async () => {
    iconColors[favicon.dataUrl] = ['#e11d48', '#61dafb'];
    useProjectsStore.setState({ projects: [{ ...cloned, color: '#61dafb' }] });
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));

    const colors = await screen.findByRole('group', { name: 'Project color' });
    expect(
      within(colors)
        .getAllByRole('button')
        .map((swatch) => swatch.getAttribute('aria-label'))
    ).toEqual(['Icon color #e11d48', 'Icon color #61dafb']);
  });

  it('keeps a color changed while the prompt waited', async () => {
    const user = userEvent.setup();
    iconColors[favicon.dataUrl] = ['#61dafb'];
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));
    const colors = await screen.findByRole('group', { name: 'Project color' });

    act(() =>
      useProjectsStore.setState({ projects: [{ ...cloned, color: PROJECT_COLORS[7] }] })
    );
    const current = within(colors).getAllByRole('button')[1];
    expect(current).toHaveStyle({ backgroundColor: PROJECT_COLORS[7] });
    await user.click(current);
    await user.click(screen.getByRole('button', { name: 'Use icon' }));
    expect(api.updateProject).toHaveBeenCalledWith('cloned', { icon: favicon.dataUrl });
  });

  it('offers no color for an icon in gray only, or the color dot', async () => {
    const user = userEvent.setup();
    iconColors[favicon.dataUrl] = ['#61dafb'];
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));

    await screen.findByRole('group', { name: 'Project color' });
    await user.click(screen.getByRole('button', { name: logo.path }));
    expect(screen.queryByRole('group', { name: 'Project color' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Color dot' }));
    expect(screen.queryByRole('group', { name: 'Project color' })).not.toBeInTheDocument();
  });

  it('keeps the color dot when that is picked or the prompt is dismissed', async () => {
    const user = userEvent.setup();
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));

    await user.click(await screen.findByRole('button', { name: 'Color dot' }));
    await user.click(screen.getByRole('button', { name: 'Keep color dot' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('shows nothing when the files have no icons, or another window asked', async () => {
    api.takeProjectIconPrompt.mockResolvedValue([]);
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));

    await waitFor(() => expect(api.takeProjectIconPrompt).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("leaves a workspace in another window to that window's prompt", async () => {
    render(<ProjectIconPromptDialog />);
    addWorkspaces(createWorkspace({ windowId: 'window-2', id: 'new', projectId: 'cloned' }));
    addWorkspaces(createWorkspace({ windowId: null, id: 'new', projectId: 'cloned' }));
    expect(api.takeProjectIconPrompt).not.toHaveBeenCalled();
  });

  it('asks again at the next workspace main arms after none or a failed call', async () => {
    api.takeProjectIconPrompt.mockRejectedValueOnce(new Error('ipc')).mockResolvedValueOnce([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ProjectIconPromptDialog />);
    const armFor = (id: string) => {
      act(() => useProjectsStore.setState({ projects: [{ ...cloned, iconPromptWorkspaceId: id }] }));
      addWorkspaces(createWorkspace({ windowId: 'window-1', id, projectId: 'cloned' }));
    };

    armFor('a');
    await waitFor(() => expect(api.takeProjectIconPrompt).toHaveBeenCalledTimes(1));
    armFor('b');
    await waitFor(() => expect(api.takeProjectIconPrompt).toHaveBeenCalledTimes(2));
    armFor('c');
    expect(await screen.findByRole('dialog', { name: 'Pick an icon for site' })).toBeVisible();
    expect(api.takeProjectIconPrompt).toHaveBeenCalledTimes(3);
    consoleError.mockRestore();
  });

  it('waits for New Workspace and the agent setup nudge to close', async () => {
    useAgentSetupNudgeStore.setState({ open: true });
    const { rerender } = render(<ProjectIconPromptDialog blocked />);
    addWorkspaces(createWorkspace({ windowId: 'window-1', id: 'new', projectId: 'cloned' }));
    await waitFor(() => expect(api.takeProjectIconPrompt).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<ProjectIconPromptDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => useAgentSetupNudgeStore.setState({ open: false }));
    expect(await screen.findByRole('dialog', { name: 'Pick an icon for site' })).toBeVisible();
  });
});
