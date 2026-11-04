/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SidebarPanelState } from '../../../src/shared/types/sidebar-panels';

describe('sidebar panel states', () => {
  let changed: (state: SidebarPanelState) => void = () => {};

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listSidebarPanelStates: vi.fn(async () => []),
        onSidebarPanelStateChange: vi.fn((listener: (state: SidebarPanelState) => void) => {
          changed = listener;
          return () => {};
        }),
      },
    });
  });

  it("keeps a panel's data the same object when the same revision comes again", async () => {
    const { followSidebarPanelStates, useSidebarPanelsStore } =
      await import('../../../src/renderer/stores/sidebar-panels.store');
    followSidebarPanelStates();
    changed({ workspaceId: 'ws-1', id: 'prs', data: { data: { prs: [7] } }, revision: 1 });
    const data = useSidebarPanelsStore.getState().states['ws-1\0prs']!.data;

    changed({ workspaceId: 'ws-1', id: 'prs', data: { data: { prs: [7] } }, revision: 1 });
    expect(useSidebarPanelsStore.getState().states['ws-1\0prs']!.data).toBe(data);

    changed({ workspaceId: 'ws-1', id: 'prs', data: { data: { prs: [8] } }, revision: 2 });
    expect(useSidebarPanelsStore.getState().states['ws-1\0prs']!.data).toEqual({
      data: { prs: [8] },
    });

    changed({ workspaceId: 'ws-1', id: 'prs' });
    expect(useSidebarPanelsStore.getState().states).toEqual({});
  });
});
