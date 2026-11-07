import { getWorkspaceLastTouchedAt } from '@/lib/workspace-state-groups';
import {
  isWorkspaceAttentionActionable,
  isWorkspaceSnoozed,
  needsAttention,
  type Workspace,
} from '@/types';

import { workspaceCardStatus } from './agent-state';

export interface WorkspaceGroup {
  key: string;
  projectInfo: { name: string; color: string; icon?: string } | null;
  projectId: string | null;
  isDirectory: boolean;
  workspaces: Workspace[];
}

// Flatten grouped workspaces into the ordered ID list used by the sidebar for
// keyboard navigation (Cmd+Arrow, Cmd+1-9) and shift-click range selection.
// Groups without projectInfo are rendered flat and always visible; groups with
// projectInfo are collapsible and contribute nothing while collapsed.
export function getVisibleOrderedWorkspaceIds(
  groups: WorkspaceGroup[],
  isExpanded: (group: WorkspaceGroup) => boolean
): string[] {
  return groups.flatMap((group) => {
    if (!group.projectInfo) return group.workspaces.map((w) => w.id);
    if (!isExpanded(group)) return [];
    return group.workspaces.map((w) => w.id);
  });
}

export interface WorkspaceListSections {
  /** On the Pinned shelf above every group, in manual order. */
  pinned: Workspace[];
  /** In their project groups. */
  grouped: Workspace[];
  /** On the Working shelf below while working workspaces are hidden, in list order. */
  working: Workspace[];
  /** On the Filtered shelf below while their tags (or Untagged) are hidden, in list order. */
  tagged: Workspace[];
  /** On the Snoozed shelf below, the soonest to wake first. */
  snoozed: Workspace[];
}

export function splitWorkspaceListSections(
  workspaces: Workspace[],
  isShelvedAsWorking: (workspace: Workspace) => boolean = () => false,
  isShelvedAsTagged: (workspace: Workspace) => boolean = () => false
): WorkspaceListSections {
  const sections: WorkspaceListSections = {
    pinned: [],
    grouped: [],
    working: [],
    tagged: [],
    snoozed: [],
  };
  for (const workspace of workspaces) {
    if (isWorkspaceSnoozed(workspace)) sections.snoozed.push(workspace);
    else if (workspace.pinned) sections.pinned.push(workspace);
    else if (isShelvedAsWorking(workspace)) sections.working.push(workspace);
    else if (isShelvedAsTagged(workspace)) sections.tagged.push(workspace);
    else sections.grouped.push(workspace);
  }
  sections.pinned.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // A snooze until notified with no time has no end to sort by, so it goes last.
  const end = (workspace: Workspace) => workspace.snoozedUntil ?? Number.MAX_SAFE_INTEGER;
  sections.snoozed.sort((a, b) => end(a) - end(b));
  return sections;
}

/** For the Stopped and Trash shelves: the last touched first, as the Overview orders them. */
export function sortByLastTouched(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort(
    (a, b) => getWorkspaceLastTouchedAt(b) - getWorkspaceLastTouchedAt(a)
  );
}

/** Marks a card that can be dragged, with its workspace's ID, for the list it's in to find. */
export const SIDEBAR_CARD_DRAG_ATTRIBUTE = 'data-drag-workspace-id';

/** The draggable cards in a list, top to bottom, with where each one is on screen. */
export function readDraggableCards(
  list: Element
): Array<{ id: string; top: number; bottom: number }> {
  return Array.from(list.querySelectorAll(`[${SIDEBAR_CARD_DRAG_ATTRIBUTE}]`), (card) => {
    const { top, bottom } = card.getBoundingClientRect();
    return { id: card.getAttribute(SIDEBAR_CARD_DRAG_ATTRIBUTE) ?? '', top, bottom };
  });
}

export interface WorkspaceDropTarget {
  workspaceId: string;
  position: 'before' | 'after';
}

/**
 * Where a workspace dragged over a list of cards would go: before the first card whose middle is
 * below the pointer, else after the last. Each slot has one name, so its line doesn't jump between
 * the cards either side, and the gaps between cards drop too. Null when the workspace would stay
 * where it is, or isn't in this list (a workspace stays in its own group or shelf).
 */
export function getWorkspaceDropTarget(
  cards: ReadonlyArray<{ id: string; top: number; bottom: number }>,
  draggedId: string,
  pointerY: number
): WorkspaceDropTarget | null {
  const draggedIndex = cards.findIndex((card) => card.id === draggedId);
  if (draggedIndex === -1) return null;
  const firstBelow = cards.findIndex((card) => pointerY < (card.top + card.bottom) / 2);
  const index = firstBelow === -1 ? cards.length : firstBelow;
  if (index === draggedIndex || index === draggedIndex + 1) return null;
  return index < cards.length
    ? { workspaceId: cards[index].id, position: 'before' }
    : { workspaceId: cards[cards.length - 1].id, position: 'after' };
}

/** How urgently a workspace needs the user: an agent waiting on input or failed, then the rest. */
export type NeedsYouTier = 'input' | 'notice';

export interface NeedsYouEntry {
  tier: NeedsYouTier;
  /** When it joined its tier, to order the top of its group by: the latest joins at the bottom. */
  at: number;
}

/**
 * Whether the workspace's card says it needs the user, and how urgently: a prompt or error leads,
 * then a done, notice or unread mark. An idle reminder doesn't count.
 */
export function getNeedsYouEntry(workspace: Workspace): NeedsYouEntry | undefined {
  const { attention } = workspaceCardStatus(workspace);
  if (attention && isWorkspaceAttentionActionable(attention)) {
    return { tier: 'input', at: attention.updatedAt };
  }
  if (needsAttention(attention)) return { tier: 'notice', at: attention!.updatedAt };
  if (workspace.unread) return { tier: 'notice', at: workspace.unread.at };
  return undefined;
}

const TIER_RANK: Record<NeedsYouTier, number> = { input: 0, notice: 1 };

function byNeedsYou(
  a: { workspace: Workspace; entry: NeedsYouEntry },
  b: { workspace: Workspace; entry: NeedsYouEntry }
): number {
  return (
    TIER_RANK[a.entry.tier] - TIER_RANK[b.entry.tier] ||
    a.entry.at - b.entry.at ||
    (a.workspace.order ?? 0) - (b.workspace.order ?? 0)
  );
}

/** Where to drop a workspace among the others in its list, as dragging it there would. */
export interface WorkspaceMove {
  workspaceId: string;
  targetId: string;
  position: 'before' | 'after';
}

/** The order a workspace gets when dropped before or after another, as the stored order counts. */
export function getDropOrder(
  oldOrder: number,
  targetOrder: number,
  position: 'before' | 'after'
): number {
  if (position === 'before') return oldOrder < targetOrder ? targetOrder - 1 : targetOrder;
  return oldOrder > targetOrder ? targetOrder + 1 : targetOrder;
}

/**
 * Where workspaces that just left the Inbox go in their group: to the top of the workspaces below
 * it, in their own order, so the last seen to leads the rest. The moves are made one after another.
 */
export function placeLeftInbox(
  group: Workspace[],
  inbox: ReadonlyMap<string, NeedsYouEntry>,
  leftIds: ReadonlySet<string>
): WorkspaceMove[] {
  const byOrder = [...group].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const top = byOrder.find((w) => !inbox.has(w.id) && !leftIds.has(w.id));
  if (!top) return [];
  return byOrder
    .filter((w) => leftIds.has(w.id))
    .map((w) => ({ workspaceId: w.id, targetId: top.id, position: 'before' }));
}

/**
 * Who is in the Inbox at the top of their group now, given who was before (null on the first
 * look). A workspace keeps the place it joined at while it stays in its tier, so a second
 * notification doesn't move it again, and the open workspace keeps its place, in the Inbox or not,
 * until it's left, so seeing to it doesn't move the card under the user. One that joins or changes
 * tier after the first look does so at `now`, so it lands at the bottom of its tier even when its
 * attention is older, as when it was raised while the workspace was open.
 */
export function trackInbox(
  previous: ReadonlyMap<string, NeedsYouEntry> | null,
  workspaces: Workspace[],
  openWorkspaceId: string | null,
  now: number
): Map<string, NeedsYouEntry> {
  const next = new Map<string, NeedsYouEntry>();
  for (const workspace of workspaces) {
    const before = previous?.get(workspace.id);
    if (previous && workspace.id === openWorkspaceId) {
      if (before) next.set(workspace.id, before);
      continue;
    }
    const current = getNeedsYouEntry(workspace);
    if (!current) continue;
    if (before?.tier === current.tier) next.set(workspace.id, before);
    else next.set(workspace.id, previous ? { tier: current.tier, at: now } : current);
  }
  return next;
}

/**
 * Puts the workspaces in the Inbox first, input before notices and each tier in the order they
 * joined it, and leaves the rest in their order.
 */
export function sortInboxFirst(
  workspaces: Workspace[],
  entries: ReadonlyMap<string, NeedsYouEntry>
): Workspace[] {
  const inbox = workspaces.flatMap((workspace) => {
    const entry = entries.get(workspace.id);
    return entry ? [{ workspace, entry }] : [];
  });
  if (inbox.length === 0) return workspaces;
  inbox.sort(byNeedsYou);
  return [
    ...inbox.map(({ workspace }) => workspace),
    ...workspaces.filter((w) => !entries.has(w.id)),
  ];
}
