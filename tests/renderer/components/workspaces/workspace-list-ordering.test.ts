import { describe, expect, it } from 'vitest';

import {
  getDropOrder,
  getVisibleOrderedWorkspaceIds,
  getWorkspaceDropTarget,
  placeLeftInbox,
  sortInboxFirst,
  splitWorkspaceListSections,
  trackInbox,
  type NeedsYouEntry,
  type WorkspaceGroup,
  type WorkspaceMove,
} from '../../../../src/renderer/components/workspaces/workspace-list-ordering';
import type { Workspace, WorkspaceAttention } from '../../../../src/renderer/types';
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

describe('getWorkspaceDropTarget', () => {
  // Three 40px cards, 4px apart: a 0–40, b 44–84, c 88–128.
  const cards = [
    { id: 'a', top: 0, bottom: 40 },
    { id: 'b', top: 44, bottom: 84 },
    { id: 'c', top: 88, bottom: 128 },
  ];

  it('drops before a card when the pointer is above its middle', () => {
    expect(getWorkspaceDropTarget(cards, 'a', 100)).toEqual({
      workspaceId: 'c',
      position: 'before',
    });
    expect(getWorkspaceDropTarget(cards, 'c', 30)).toEqual({
      workspaceId: 'b',
      position: 'before',
    });
  });

  it('drops in the gap between cards, as before the card below it', () => {
    expect(getWorkspaceDropTarget(cards, 'c', 42)).toEqual({
      workspaceId: 'b',
      position: 'before',
    });
  });

  it('drops before the first card above the list', () => {
    expect(getWorkspaceDropTarget(cards, 'c', -10)).toEqual({
      workspaceId: 'a',
      position: 'before',
    });
  });

  it('drops after the last card below its middle', () => {
    expect(getWorkspaceDropTarget(cards, 'a', 120)).toEqual({
      workspaceId: 'c',
      position: 'after',
    });
    expect(getWorkspaceDropTarget(cards, 'a', 400)).toEqual({
      workspaceId: 'c',
      position: 'after',
    });
  });

  it('names one slot the same way, whichever card the pointer is nearer', () => {
    // Just below a's middle and just above b's: the slot between them both times.
    expect(getWorkspaceDropTarget(cards, 'c', 21)).toEqual({
      workspaceId: 'b',
      position: 'before',
    });
    expect(getWorkspaceDropTarget(cards, 'c', 63)).toEqual({
      workspaceId: 'b',
      position: 'before',
    });
  });

  it('has no target where the dragged workspace already is', () => {
    // Over the dragged card itself, either half.
    expect(getWorkspaceDropTarget(cards, 'b', 50)).toBeNull();
    expect(getWorkspaceDropTarget(cards, 'b', 80)).toBeNull();
    // The slot just above a, which is a's own.
    expect(getWorkspaceDropTarget(cards, 'a', -10)).toBeNull();
    // Below c's middle, c's own slot.
    expect(getWorkspaceDropTarget(cards, 'c', 120)).toBeNull();
  });

  it('has no target when the dragged workspace is in another list', () => {
    expect(getWorkspaceDropTarget(cards, 'elsewhere', 60)).toBeNull();
    expect(getWorkspaceDropTarget([], 'a', 60)).toBeNull();
  });
});

const raised = (
  kind: WorkspaceAttention['kind'],
  updatedAt: number,
  extra: Partial<WorkspaceAttention> = {}
): WorkspaceAttention => ({ kind, source: 'claude-code', updatedAt, ...extra });

const workspace = (id: string, order: number, overrides: Partial<Workspace> = {}) =>
  createWorkspace({ id, order, ...overrides });

const ids = (list: Workspace[]) => list.map((w) => w.id);

describe('dropping a workspace next to another', () => {
  it('gives the order a drop before or after another card leaves', () => {
    expect(getDropOrder(5, 2, 'before')).toBe(2);
    expect(getDropOrder(1, 4, 'before')).toBe(3);
    expect(getDropOrder(5, 2, 'after')).toBe(3);
    expect(getDropOrder(1, 4, 'after')).toBe(4);
  });
});

describe('workspaces that leave the Inbox', () => {
  const inbox = (...list: string[]) =>
    new Map(list.map((id) => [id, { tier: 'notice' as const, at: 1 }]));

  it('go to the top of the workspaces below it, in their own order', () => {
    const group = [workspace('i', 0), workspace('a', 1), workspace('x', 2), workspace('y', 3)];

    expect(placeLeftInbox(group, inbox('i'), new Set(['y', 'x']))).toEqual([
      { workspaceId: 'x', targetId: 'a', position: 'before' },
      { workspaceId: 'y', targetId: 'a', position: 'before' },
    ]);
  });

  it('stay put when nothing else is below it', () => {
    const group = [workspace('i', 0), workspace('x', 1)];

    expect(placeLeftInbox(group, inbox('i'), new Set(['x']))).toEqual([]);
  });
});

describe('the Inbox', () => {
  interface Look {
    workspaces: Workspace[];
    open?: string | null;
  }

  /** Looks at the list once per step, as the sidebar does on each change, and sorts the last. */
  function sortAfter(looks: Look[]) {
    let entries: ReadonlyMap<string, NeedsYouEntry> | null = null;
    for (const [i, look] of looks.entries()) {
      entries = trackInbox(entries, look.workspaces, look.open ?? null, 1000 + i);
    }
    return ids(sortInboxFirst(looks.at(-1)!.workspaces, entries!));
  }

  it('puts the workspaces that need the user first, input and errors before done', () => {
    const list = [
      workspace('a', 0),
      workspace('b', 1, { attention: raised('turn-complete', 10) }),
      workspace('c', 2, { attention: raised('error', 30) }),
      workspace('d', 3, { attention: raised('input-required', 20) }),
      workspace('e', 4, { unread: { at: 5 } }),
    ];

    expect(sortAfter([{ workspaces: list }])).toEqual(['d', 'c', 'e', 'b', 'a']);
  });

  it('adds a workspace to the bottom of its tier', () => {
    const first = [
      workspace('a', 0),
      workspace('b', 1, { attention: raised('turn-complete', 10) }),
    ];
    const then = [workspace('a', 0, { attention: raised('turn-complete', 20) }), first[1]];

    expect(sortAfter([{ workspaces: first }, { workspaces: then }])).toEqual(['b', 'a']);
  });

  it('keeps the place of a workspace notified again, and moves one up a tier for input', () => {
    const first = [
      workspace('a', 0, { attention: raised('turn-complete', 10) }),
      workspace('b', 1, { attention: raised('turn-complete', 20) }),
    ];
    const again = [workspace('a', 0, { attention: raised('turn-complete', 30) }), first[1]];
    const input = [first[0], workspace('b', 1, { attention: raised('input-required', 40) })];

    expect(sortAfter([{ workspaces: first }, { workspaces: again }])).toEqual(['a', 'b']);
    expect(sortAfter([{ workspaces: first }, { workspaces: input }])).toEqual(['b', 'a']);
  });

  it('adds a workspace left out while open to the bottom, by when it joins', () => {
    const quiet = [workspace('a', 0), workspace('b', 1)];
    const aDone = [workspace('a', 0, { attention: raised('turn-complete', 100) }), quiet[1]];
    const bDone = [aDone[0], workspace('b', 1, { attention: raised('turn-complete', 200) })];

    expect(
      sortAfter([
        { workspaces: quiet, open: 'a' },
        { workspaces: aDone, open: 'a' },
        { workspaces: bDone, open: 'a' },
        { workspaces: bDone, open: null },
      ])
    ).toEqual(['b', 'a']);
  });

  it('drops a workspace back to its place once seen to and left', () => {
    const first = [
      workspace('a', 0),
      workspace('b', 1, { attention: raised('turn-complete', 10) }),
    ];
    const seen = [workspace('a', 0), workspace('b', 1)];

    expect(
      sortAfter([{ workspaces: first }, { workspaces: seen, open: 'b' }, { workspaces: seen }])
    ).toEqual(['a', 'b']);
  });

  it('holds the open workspace in place until it is left', () => {
    const first = [
      workspace('a', 0),
      workspace('b', 1, { attention: raised('turn-complete', 10) }),
    ];
    const seen = [workspace('a', 0), workspace('b', 1)];
    const done = [workspace('a', 0, { attention: raised('turn-complete', 20) }), first[1]];

    expect(
      sortAfter([
        { workspaces: first, open: 'b' },
        { workspaces: seen, open: 'b' },
      ])
    ).toEqual(['b', 'a']);
    expect(
      sortAfter([
        { workspaces: seen, open: 'a' },
        { workspaces: done, open: 'a' },
      ])
    ).toEqual(['b', 'a']);
    expect(
      sortAfter([
        { workspaces: seen, open: 'a' },
        { workspaces: done, open: 'a' },
        { workspaces: done, open: 'b' },
      ])
    ).toEqual(['b', 'a']);
  });
});
