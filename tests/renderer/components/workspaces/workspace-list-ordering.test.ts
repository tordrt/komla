import { describe, expect, it } from 'vitest';

import {
  getVisibleOrderedWorkspaceIds,
  splitWorkspaceListSections,
  type WorkspaceGroup,
} from '../../../../src/renderer/components/workspaces/workspace-list-ordering';
import { createWorkspace } from '../../../factories';

function makeGroup(
  overrides: Partial<WorkspaceGroup> & Pick<WorkspaceGroup, 'key'>
): WorkspaceGroup {
  return {
    projectInfo: { name: 'Example', color: '#fff' },
    projectId: null,
    isDirectory: false,
    workspaces: [],
    ...overrides,
  };
}

describe('getVisibleOrderedWorkspaceIds', () => {
  it('includes all workspaces when every group is expanded', () => {
    const groups: WorkspaceGroup[] = [
      makeGroup({
        key: 'project:a',
        projectId: 'a',
        workspaces: [createWorkspace({ id: 'ws-1' }), createWorkspace({ id: 'ws-2' })],
      }),
      makeGroup({
        key: 'project:b',
        projectId: 'b',
        workspaces: [createWorkspace({ id: 'ws-3' })],
      }),
    ];

    const ids = getVisibleOrderedWorkspaceIds(groups, () => true);

    expect(ids).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });

  it('excludes workspaces inside collapsed project groups', () => {
    const groups: WorkspaceGroup[] = [
      makeGroup({
        key: 'project:a',
        projectId: 'a',
        workspaces: [createWorkspace({ id: 'ws-1' })],
      }),
      makeGroup({
        key: 'project:b',
        projectId: 'b',
        workspaces: [createWorkspace({ id: 'ws-hidden' })],
      }),
      makeGroup({
        key: 'project:c',
        projectId: 'c',
        workspaces: [createWorkspace({ id: 'ws-3' })],
      }),
    ];

    const ids = getVisibleOrderedWorkspaceIds(groups, (g) => g.projectId !== 'b');

    expect(ids).toEqual(['ws-1', 'ws-3']);
    expect(ids).not.toContain('ws-hidden');
  });

  it('excludes collapsed repo/directory groups (non-project groups with projectInfo)', () => {
    const groups: WorkspaceGroup[] = [
      makeGroup({
        key: 'repo:my-repo',
        projectId: null,
        workspaces: [createWorkspace({ id: 'ws-hidden' })],
      }),
      makeGroup({
        key: 'dir:some-dir',
        projectId: null,
        isDirectory: true,
        workspaces: [createWorkspace({ id: 'ws-2' })],
      }),
    ];

    const ids = getVisibleOrderedWorkspaceIds(groups, (g) => g.key !== 'repo:my-repo');

    expect(ids).toEqual(['ws-2']);
  });

  it('always includes workspaces from flat groups (no projectInfo) regardless of expansion', () => {
    const groups: WorkspaceGroup[] = [
      makeGroup({
        key: 'none:ws-flat',
        projectInfo: null,
        workspaces: [createWorkspace({ id: 'ws-flat' })],
      }),
      makeGroup({
        key: 'project:a',
        projectId: 'a',
        workspaces: [createWorkspace({ id: 'ws-in-collapsed' })],
      }),
    ];

    const ids = getVisibleOrderedWorkspaceIds(groups, () => false);

    expect(ids).toEqual(['ws-flat']);
  });

  it('returns an empty list when every collapsible group is collapsed and there are no flat groups', () => {
    const groups: WorkspaceGroup[] = [
      makeGroup({
        key: 'project:a',
        projectId: 'a',
        workspaces: [createWorkspace({ id: 'ws-1' })],
      }),
      makeGroup({
        key: 'project:b',
        projectId: 'b',
        workspaces: [createWorkspace({ id: 'ws-2' })],
      }),
    ];

    const ids = getVisibleOrderedWorkspaceIds(groups, () => false);

    expect(ids).toEqual([]);
  });
});

describe('splitWorkspaceListSections', () => {
  it('lists pinned and snoozed workspaces apart, snoozed by wake time', () => {
    const sections = splitWorkspaceListSections([
      createWorkspace({ id: 'plain' }),
      createWorkspace({ id: 'snoozed-later', snoozedUntil: 9_000 }),
      createWorkspace({ id: 'pinned', pinned: true }),
      createWorkspace({ id: 'until-notified', wakesOnNotification: true }),
      createWorkspace({ id: 'pinned-snoozed', pinned: true, snoozedUntil: 5_000 }),
      createWorkspace({ id: 'pinned-second', pinned: true }),
    ]);

    expect(sections.pinned.map((w) => w.id)).toEqual(['pinned', 'pinned-second']);
    expect(sections.grouped.map((w) => w.id)).toEqual(['plain']);
    // Until notified with no time has no wake time, so it comes last.
    expect(sections.snoozed.map((w) => w.id)).toEqual([
      'pinned-snoozed',
      'snoozed-later',
      'until-notified',
    ]);
  });

  it('keeps pinned workspaces in their manual order, whatever the list is sorted by', () => {
    const sections = splitWorkspaceListSections([
      createWorkspace({ id: 'recent', pinned: true, order: 4 }),
      createWorkspace({ id: 'older', pinned: true, order: 1 }),
    ]);

    expect(sections.pinned.map((w) => w.id)).toEqual(['older', 'recent']);
  });

  it('sets working workspaces apart in list order, unless pinned or snoozed', () => {
    const working = new Set(['second', 'first', 'pinned', 'snoozed']);
    const sections = splitWorkspaceListSections(
      [
        createWorkspace({ id: 'plain' }),
        createWorkspace({ id: 'second' }),
        createWorkspace({ id: 'first' }),
        createWorkspace({ id: 'pinned', pinned: true }),
        createWorkspace({ id: 'snoozed', snoozedUntil: 5_000 }),
      ],
      (workspace) => working.has(workspace.id)
    );

    expect(sections.working.map((w) => w.id)).toEqual(['second', 'first']);
    expect(sections.grouped.map((w) => w.id)).toEqual(['plain']);
    expect(sections.pinned.map((w) => w.id)).toEqual(['pinned']);
    expect(sections.snoozed.map((w) => w.id)).toEqual(['snoozed']);
  });

  it('sets tagged workspaces apart after working ones, unless pinned or snoozed', () => {
    const sections = splitWorkspaceListSections(
      [
        createWorkspace({ id: 'plain' }),
        createWorkspace({ id: 'tagged', tag: 'Waiting for merge' }),
        createWorkspace({ id: 'working-tagged', tag: 'Waiting for merge' }),
        createWorkspace({ id: 'pinned', tag: 'Waiting for merge', pinned: true }),
        createWorkspace({ id: 'snoozed', tag: 'Waiting for merge', snoozedUntil: 5_000 }),
      ],
      (workspace) => workspace.id === 'working-tagged',
      (workspace) => !!workspace.tag
    );

    expect(sections.tagged.map((w) => w.id)).toEqual(['tagged']);
    expect(sections.working.map((w) => w.id)).toEqual(['working-tagged']);
    expect(sections.grouped.map((w) => w.id)).toEqual(['plain']);
  });
});
