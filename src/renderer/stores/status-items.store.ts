import { create } from 'zustand';

import { statusCommandScope } from '../../shared/types/status-items';

import type {
  StatusCommand,
  StatusCommandList,
  StatusCommandResult,
  StatusItemContent,
  StatusPopoverContent,
  WindowStatusItem,
} from '../../shared/types/status-items';

/**
 * A status-items.json item's output in a workspace. After a run fails, it keeps the last output
 * that worked, if any, with the error.
 */
export interface StatusCommandState {
  content: StatusItemContent | null;
  error?: string;
  /** Runs were missed while the workspace or window wasn't open, and the next is under way. */
  outdated?: boolean;
}

/** What an item's popover last showed, to show at once when it opens again. */
export interface StatusPopoverState {
  content: StatusPopoverContent | null;
  /** When its run started, as Komla serves an HTML popover's page for a while only. */
  ranAt: number;
  /** The height an HTML popover's page last had. */
  htmlHeight?: number;
  /** The theme an HTML popover's page was made with, as readPopoverTheme read it. */
  theme?: string;
  /** The page Komla served last for an agent item's HTML, to show again while it's the same. */
  agentPage?: { url: string; pageId: string; theme: string; servedAt: number };
}

interface StatusItemsState {
  /** Every workspace's items that agents set with `komla status set`. */
  agentItems: WindowStatusItem[];
  /** Each workspace's status-items.json items, once listed. */
  commandLists: Record<string, StatusCommandList>;
  /** Each item's output, by statusCommandKey. */
  results: Record<string, StatusCommandState>;
  /** Each item's last popover, by statusCommandKey; an agent item's HTML page height too. */
  popovers: Record<string, StatusPopoverState>;
}

export const useStatusItemsStore = create<StatusItemsState>(() => ({
  agentItems: [],
  commandLists: {},
  results: {},
  popovers: {},
}));

export const statusItemKey = (workspaceId: string, id: string) => `${workspaceId}\0${id}`;

/** An item's key in a workspace; one that runs on this computer shows the same in every one. */
export const statusCommandKey = (
  workspaceId: string,
  command: Pick<StatusCommand, 'id' | 'runOn'>
) => statusItemKey(statusCommandScope(workspaceId, command), command.id);

// When each item last started to run, so switching workspaces doesn't run it again before it's due.
const lastRun = new Map<string, number>();
// A listing that resolves after a newer one started is stale.
const listGeneration = new Map<string, number>();
// When status-items.json last changed, from its listings; runs that started before it may show an
// earlier command.
let editedAt = 0;

export function setAgentStatusItems(agentItems: WindowStatusItem[]): void {
  useStatusItemsStore.setState({ agentItems });
}

/** Lists a workspace's items again, keeping the list it had while they stay the same. */
export async function loadStatusCommandList(workspaceId: string): Promise<void> {
  const generation = (listGeneration.get(workspaceId) ?? 0) + 1;
  listGeneration.set(workspaceId, generation);
  const list = await window.api.listStatusCommands(workspaceId);
  if (listGeneration.get(workspaceId) !== generation) return;
  editedAt = Math.max(editedAt, list.changedAt ?? 0);
  const previous = useStatusItemsStore.getState().commandLists[workspaceId];
  if (previous && JSON.stringify(previous) === JSON.stringify(list)) return;
  useStatusItemsStore.setState((state) => ({
    commandLists: { ...state.commandLists, [workspaceId]: list },
  }));
}

// Whether an item's interval has passed since it last ran in the workspace.
function isOverdue(workspaceId: string, command: StatusCommand): boolean {
  const last = lastRun.get(statusCommandKey(workspaceId, command)) ?? 0;
  return Date.now() - last >= command.intervalSeconds * 1000;
}

/** Whether an item should run: its interval has passed, or status-items.json changed since. */
export function isStatusCommandDue(workspaceId: string, command: StatusCommand): boolean {
  const last = lastRun.get(statusCommandKey(workspaceId, command)) ?? 0;
  return last < editedAt || isOverdue(workspaceId, command);
}

/**
 * Marks an item's output as missing runs, until its next run ends: when its interval passed while
 * the workspace or window wasn't open, not when it runs again only because the file changed.
 */
export function markStatusCommandOutdated(workspaceId: string, command: StatusCommand): void {
  if (!isOverdue(workspaceId, command)) return;
  const key = statusCommandKey(workspaceId, command);
  useStatusItemsStore.setState((state) => {
    const result = state.results[key];
    if (!result?.content || result.outdated) return state;
    return { results: { ...state.results, [key]: { ...result, outdated: true } } };
  });
}

/**
 * Runs an item's command in a workspace and keeps its output, unless a later run started since. A
 * failed run keeps the output before it, unless that came from before status-items.json changed,
 * as the command may have.
 */
export async function runStatusCommand(
  workspaceId: string,
  command: Pick<StatusCommand, 'id' | 'runOn'>
): Promise<void> {
  const key = statusCommandKey(workspaceId, command);
  const previousRun = lastRun.get(key) ?? 0;
  const startedAt = Date.now();
  lastRun.set(key, startedAt);
  let error: string | undefined;
  let content: StatusItemContent | null = null;
  try {
    ({ content, error } = await window.api.runStatusCommand(workspaceId, command.id));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  if (lastRun.get(key) !== startedAt) return;
  keepStatusCommandResult(key, previousRun, content, error);
}

/** Keeps what a run `komla status refresh` asked for shows, as a run of its own would. */
export function applyStatusCommandResult(result: StatusCommandResult): void {
  const key = statusCommandKey(result.workspaceId, result);
  const previousRun = lastRun.get(key) ?? 0;
  lastRun.set(key, Date.now());
  keepStatusCommandResult(key, previousRun, result.content, result.error);
}

function keepStatusCommandResult(
  key: string,
  previousRun: number,
  content: StatusItemContent | null,
  error: string | undefined
): void {
  useStatusItemsStore.setState((state) => {
    const previous = previousRun >= editedAt ? state.results[key]?.content : undefined;
    const next: StatusCommandState =
      error === undefined ? { content } : { content: previous ?? null, error };
    return { results: { ...state.results, [key]: next } };
  });
}

/**
 * Keeps what an item's popover showed from the run that ended last, which started at `ranAt` with
 * `theme`: Komla serves a window only the latest two HTML pages it made, in the order they ended.
 */
export function keepStatusPopover(
  key: string,
  content: StatusPopoverContent | null,
  ranAt: number,
  theme: string
): void {
  setStatusPopover(key, { content, ranAt, theme });
}

export function setStatusPopover(key: string, popover: Partial<StatusPopoverState>): void {
  useStatusItemsStore.setState((state) => {
    const previous = state.popovers[key] ?? { content: null, ranAt: 0 };
    return { popovers: { ...state.popovers, [key]: { ...previous, ...popover } } };
  });
}

/** Forgets every item; for tests. */
export function resetStatusItemsStore(): void {
  lastRun.clear();
  listGeneration.clear();
  editedAt = 0;
  useStatusItemsStore.setState({ agentItems: [], commandLists: {}, results: {}, popovers: {} });
}
