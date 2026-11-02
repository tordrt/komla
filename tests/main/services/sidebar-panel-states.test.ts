import { describe, expect, it, vi } from 'vitest';

import {
  sidebarPanelBadge,
  SidebarPanelStates,
} from '../../../src/main/services/sidebar-panel-states';

describe('sidebarPanelBadge', () => {
  it('shows counts and text as they are, short enough for a tab', () => {
    expect(sidebarPanelBadge(3)).toEqual({ text: '3' });
    expect(sidebarPanelBadge({ text: 'Failing', tone: 'error' })).toEqual({
      text: 'Failing',
      tone: 'error',
    });
    expect(sidebarPanelBadge('  a very long badge text  ')).toEqual({ text: 'a very long ' });
  });

  it('clears on null, 0 or empty text, so a count can be set as it is', () => {
    expect(sidebarPanelBadge(null)).toBeUndefined();
    expect(sidebarPanelBadge(0)).toBeUndefined();
    expect(sidebarPanelBadge({ text: ' ' })).toBeUndefined();
  });
});

describe('SidebarPanelStates', () => {
  it("keeps a panel's badge and data per workspace, or for every one", () => {
    const states = new SidebarPanelStates();
    const changes = vi.fn();
    states.onChange(changes);
    states.setBadge('', 'prs.list', { text: '2' });
    states.post('ws-1', 'prs.list', { data: { prs: [] } });

    expect(states.get('ws-1', 'prs.list')).toEqual({
      workspaceId: 'ws-1',
      id: 'prs.list',
      data: { data: { prs: [] } },
      revision: 1,
    });
    // Posting the same data again tells nobody.
    states.post('ws-1', 'prs.list', { data: { prs: [] } });
    expect(states.get('ws-2', 'prs.list')?.badge).toEqual({ text: '2' });
    expect(changes).toHaveBeenCalledTimes(2);

    // Setting it as it is, or clearing what isn't there, tells nobody.
    states.setBadge('', 'prs.list', { text: '2' });
    states.setBadge('ws-3', 'prs.list', undefined);
    expect(changes).toHaveBeenCalledTimes(2);

    states.setBadge('', 'prs.list', undefined);
    expect(changes).toHaveBeenLastCalledWith({ workspaceId: '', id: 'prs.list' });
    expect(states.get('ws-2', 'prs.list')).toBeUndefined();
  });

  it("forgets what was set for a plugin's panels, telling windows", () => {
    const states = new SidebarPanelStates();
    states.setBadge('ws-1', 'prs.list', { text: '1' });
    states.setBadge('ws-1', 'ci', { text: '1' });
    const changes = vi.fn();
    states.onChange(changes);
    states.forget(new Set(['prs.list']));
    expect(states.all().map((state) => state.id)).toEqual(['ci']);
    expect(changes).toHaveBeenCalledWith({ workspaceId: 'ws-1', id: 'prs.list' });
  });
});
