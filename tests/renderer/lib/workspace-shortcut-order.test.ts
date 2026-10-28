import { describe, expect, it } from 'vitest';

import { orderWorkspacesForShortcuts } from '../../../src/renderer/lib/workspace-shortcut-order';

describe('orderWorkspacesForShortcuts', () => {
  const workspaces = [
    { id: 'second', order: 2 },
    { id: 'first', order: 1 },
  ];

  it('falls back to manual order before the sidebar has synced', () => {
    expect(orderWorkspacesForShortcuts(workspaces, null).map((workspace) => workspace.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('keeps shortcuts empty when the synced sidebar order is empty', () => {
    expect(orderWorkspacesForShortcuts(workspaces, [])).toEqual([]);
  });
});
