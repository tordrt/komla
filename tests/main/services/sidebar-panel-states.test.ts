import { describe, expect, it, vi } from 'vitest';

import { SidebarPanelStates } from '../../../src/main/services/sidebar-panel-states';

describe('SidebarPanelStates', () => {
  it("keeps a panel's data per workspace, or for every one", () => {
    const states = new SidebarPanelStates();
    const changes = vi.fn();
    states.onChange(changes);
    states.post('', 'prs.list', { data: { prs: [1] } });
    states.post('ws-1', 'prs.list', { data: { prs: [] } });

    expect(states.get('ws-1', 'prs.list')).toEqual({
      workspaceId: 'ws-1',
      id: 'prs.list',
      data: { data: { prs: [] } },
      revision: 1,
    });
    expect(states.get('ws-2', 'prs.list')?.data).toEqual({ data: { prs: [1] } });
    // Posting the same data again tells nobody.
    states.post('ws-1', 'prs.list', { data: { prs: [] } });
    expect(changes).toHaveBeenCalledTimes(2);

    states.post('ws-1', 'prs.list', { data: { prs: [2] } });
    expect(states.get('ws-1', 'prs.list')?.revision).toBe(2);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("forgets what was set for a plugin's panels, telling windows", () => {
    const states = new SidebarPanelStates();
    states.post('ws-1', 'prs.list', { data: 1 });
    states.post('ws-1', 'ci', { data: 1 });
    const changes = vi.fn();
    states.onChange(changes);
    states.forget(new Set(['prs.list']));
    expect(states.all().map((state) => state.id)).toEqual(['ci']);
    expect(changes).toHaveBeenCalledWith({ workspaceId: 'ws-1', id: 'prs.list' });
  });
});
