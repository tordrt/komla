/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readStoredCollapsedGroups } from '../../../src/renderer/lib/sidebar-collapsed-groups';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: vi.fn(),
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));

describe('sidebar group collapse state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspacesStore.setState({ collapsedWorkspaceGroupKeys: new Set() });
  });

  it('remembers collapsed groups across reloads', () => {
    const { toggleWorkspaceGroupCollapsed } = useWorkspacesStore.getState();

    toggleWorkspaceGroupCollapsed('project:komla');
    toggleWorkspaceGroupCollapsed('dir:/tmp/notes');
    toggleWorkspaceGroupCollapsed('dir:/tmp/notes');

    expect(useWorkspacesStore.getState().collapsedWorkspaceGroupKeys).toEqual(
      new Set(['project:komla'])
    );
    expect(readStoredCollapsedGroups()).toEqual(new Set(['project:komla']));
  });

  it('starts expanded when the stored value is missing or corrupt', () => {
    expect(readStoredCollapsedGroups()).toEqual(new Set());

    window.localStorage.setItem('komla.sidebarCollapsedGroups', '{not json');
    expect(readStoredCollapsedGroups()).toEqual(new Set());

    window.localStorage.setItem('komla.sidebarCollapsedGroups', JSON.stringify(['a', 3, null]));
    expect(readStoredCollapsedGroups()).toEqual(new Set(['a']));
  });
});
