// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportShownWorkspace } from '../../../src/renderer/lib/shown-workspace';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

describe('reportShownWorkspace', () => {
  const setShownWorkspace = vi.fn();

  beforeEach(() => {
    setShownWorkspace.mockReset();
    Object.defineProperty(window, 'api', { value: { setShownWorkspace }, configurable: true });
    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1', showDashboard: false });
  });

  it('reports the selected workspace, and none on the overview, once per change', () => {
    const stop = reportShownWorkspace();
    expect(setShownWorkspace).toHaveBeenLastCalledWith('ws-1');

    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-2' });
    expect(setShownWorkspace).toHaveBeenLastCalledWith('ws-2');

    useWorkspacesStore.setState({ showDashboard: true });
    expect(setShownWorkspace).toHaveBeenLastCalledWith(null);

    // Unrelated updates send nothing.
    useWorkspacesStore.setState({ workspaces: [] });
    expect(setShownWorkspace).toHaveBeenCalledTimes(3);

    stop();
    useWorkspacesStore.setState({ showDashboard: false });
    expect(setShownWorkspace).toHaveBeenCalledTimes(3);
  });
});
