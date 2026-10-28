import { describe, expect, it, vi } from 'vitest';

import { StatusItemsService } from '../../../src/main/services/status-items.service';
import { MAX_STATUS_ITEMS_PER_WORKSPACE } from '../../../src/shared/types/status-items';

describe('StatusItemsService', () => {
  it('sets, replaces and lists items per workspace', () => {
    let now = 1;
    const service = new StatusItemsService(() => now);
    service.set('workspace-1', 'tests', { text: '3 failing', tone: 'error' });
    now = 2;
    service.set('workspace-1', 'tests', { text: 'All passing', tone: 'success' });
    service.set('workspace-2', 'tests', { text: 'Running' });

    expect(service.list()).toEqual([
      {
        id: 'tests',
        workspaceId: 'workspace-1',
        text: 'All passing',
        tone: 'success',
        updatedAt: 2,
      },
      { id: 'tests', workspaceId: 'workspace-2', text: 'Running', updatedAt: 2 },
    ]);
  });

  it('refuses a new item past the limit but still replaces existing ones', () => {
    const service = new StatusItemsService();
    for (let index = 0; index < MAX_STATUS_ITEMS_PER_WORKSPACE; index++) {
      expect(service.set('workspace-1', `item-${index}`, { text: 'x' })).toBeDefined();
    }
    expect(service.set('workspace-1', 'one-more', { text: 'x' })).toBeUndefined();
    expect(service.set('workspace-1', 'item-0', { text: 'y' })).toBeDefined();
    expect(service.set('workspace-2', 'one-more', { text: 'x' })).toBeDefined();
  });

  it('clears one item or all of a workspace, notifying only when something changed', () => {
    const service = new StatusItemsService();
    const listener = vi.fn();
    service.set('workspace-1', 'a', { text: 'a' });
    service.set('workspace-1', 'b', { text: 'b' });
    service.set('workspace-2', 'a', { text: 'a' });
    service.onChange(listener);

    expect(service.clear('workspace-1', 'missing')).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(service.clear('workspace-1', 'a')).toBe(1);
    expect(service.clear('workspace-1')).toBe(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(service.list()).toEqual([expect.objectContaining({ workspaceId: 'workspace-2' })]);
  });
});
