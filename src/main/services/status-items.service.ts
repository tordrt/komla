import {
  MAX_STATUS_ITEMS_PER_WORKSPACE,
  type AgentStatusItem,
  type StatusItemContent,
} from '../../shared/types/status-items';

/**
 * The status items agents set with `komla status set`, per workspace. They live as long as Komla
 * runs, like the terminals of the agents that set them.
 */
export class StatusItemsService {
  private readonly items = new Map<string, Map<string, AgentStatusItem>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): AgentStatusItem[] {
    return [...this.items.values()].flatMap((items) => [...items.values()]);
  }

  /** Sets or replaces an item; undefined when the workspace already has as many as it may. */
  set(workspaceId: string, id: string, content: StatusItemContent): AgentStatusItem | undefined {
    const items = this.items.get(workspaceId) ?? new Map<string, AgentStatusItem>();
    if (!items.has(id) && items.size >= MAX_STATUS_ITEMS_PER_WORKSPACE) return undefined;
    const item: AgentStatusItem = { ...content, id, workspaceId, updatedAt: this.now() };
    items.set(id, item);
    this.items.set(workspaceId, items);
    this.emit();
    return item;
  }

  /** Clears one item, or every item of the workspace without an id; returns how many it cleared. */
  clear(workspaceId: string, id?: string): number {
    const items = this.items.get(workspaceId);
    if (!items) return 0;
    let cleared: number;
    if (id === undefined) {
      cleared = items.size;
      this.items.delete(workspaceId);
    } else {
      cleared = items.delete(id) ? 1 : 0;
      if (items.size === 0) this.items.delete(workspaceId);
    }
    if (cleared > 0) this.emit();
    return cleared;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const statusItemsService = new StatusItemsService();
