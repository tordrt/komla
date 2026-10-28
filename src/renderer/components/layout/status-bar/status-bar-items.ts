import type { AppConfig } from '@/types';

/** Status bar items the user can show or hide from the bar's right-click menu. */
export type StatusBarItemId =
  | 'git-menu'
  | 'target-branch'
  | 'pull-request'
  | 'open-in-editor'
  | 'file-search'
  | 'file-viewer'
  | 'diff-viewer'
  | 'notes'
  | 'commit-graph'
  | 'agents'
  | 'claude-code-usage'
  | 'codex-usage'
  | 'automations'
  | 'notification-sounds'
  | 'keep-awake'
  | 'ssh-hosts'
  | 'system-metrics'
  | 'tips';

/** Where an item sits by default: the bar's left half (workspace, tools) or its right. */
export type StatusBarItemGroup = 'workspace' | 'tools' | 'app';

export const STATUS_BAR_ITEMS: { id: StatusBarItemId; label: string; group: StatusBarItemGroup }[] =
  [
    { id: 'git-menu', label: 'Git menu', group: 'workspace' },
    { id: 'target-branch', label: 'Target branch', group: 'workspace' },
    { id: 'pull-request', label: 'Pull request', group: 'workspace' },
    { id: 'open-in-editor', label: 'Open in editor', group: 'workspace' },
    { id: 'file-search', label: 'File search', group: 'tools' },
    { id: 'file-viewer', label: 'Files (full window)', group: 'tools' },
    { id: 'diff-viewer', label: 'Diff (full window)', group: 'tools' },
    { id: 'notes', label: 'Notes', group: 'tools' },
    { id: 'commit-graph', label: 'Commit graph', group: 'tools' },
    { id: 'agents', label: 'Agent activity', group: 'app' },
    { id: 'claude-code-usage', label: 'Claude Code usage', group: 'app' },
    { id: 'codex-usage', label: 'Codex usage', group: 'app' },
    { id: 'automations', label: 'Automations', group: 'app' },
    { id: 'notification-sounds', label: 'Notification sounds', group: 'app' },
    { id: 'keep-awake', label: 'Keep awake', group: 'app' },
    { id: 'ssh-hosts', label: 'SSH hosts', group: 'app' },
    { id: 'system-metrics', label: 'Resource usage', group: 'app' },
    { id: 'tips', label: 'Tips', group: 'app' },
  ];

/** A custom item, shown or hidden on its own: `command:ci` from status-items.json, `agent:tests` set by an agent. */
export type CustomStatusItemKey = `command:${string}` | `agent:${string}`;

export function isCustomStatusItemKey(id: string): id is CustomStatusItemKey {
  return id.startsWith('command:') || id.startsWith('agent:');
}

/** Off until the user turns them on: set once and rarely touched, or a detail most don't need. */
const HIDDEN_BY_DEFAULT: ReadonlySet<string> = new Set<StatusBarItemId>([
  'file-search',
  'file-viewer',
  'diff-viewer',
  'notes',
  'commit-graph',
  'claude-code-usage',
  'codex-usage',
  'keep-awake',
]);

type StatusBarItemConfig = Pick<
  AppConfig,
  | 'statusBarHiddenItems'
  | 'statusBarShownItems'
  | 'statusBarLeftItems'
  | 'statusBarRightItems'
  | 'showSystemMetrics'
  | 'showTipsInToolbar'
  | 'showEditorInToolbar'
>;

export function isStatusBarItemShown(
  config: StatusBarItemConfig | null,
  id: StatusBarItemId | CustomStatusItemKey
): boolean {
  // Predates the status bar and is off by default, so it keeps its own setting.
  if (id === 'system-metrics') return config?.showSystemMetrics === true;
  // Predates the status bar too; the settings menu offers Tips while it is off.
  if (id === 'tips') return config?.showTipsInToolbar !== false;
  if (id === 'open-in-editor') return config?.showEditorInToolbar !== false;
  if (HIDDEN_BY_DEFAULT.has(id)) return config?.statusBarShownItems?.includes(id) === true;
  return !config?.statusBarHiddenItems?.includes(id);
}

/** The config change that shows or hides one item. */
export function statusBarItemVisibilityUpdate(
  config: StatusBarItemConfig | null,
  id: StatusBarItemId | CustomStatusItemKey,
  shown: boolean
): Partial<AppConfig> {
  if (id === 'system-metrics') return { showSystemMetrics: shown };
  if (id === 'tips') return { showTipsInToolbar: shown };
  if (id === 'open-in-editor') return { showEditorInToolbar: shown };
  if (HIDDEN_BY_DEFAULT.has(id)) {
    const listed = (config?.statusBarShownItems ?? []).filter((item) => item !== id);
    return { statusBarShownItems: shown ? [...listed, id] : listed };
  }
  const hidden = (config?.statusBarHiddenItems ?? []).filter((item) => item !== id);
  return { statusBarHiddenItems: shown ? hidden : [...hidden, id] };
}

/** The config change that puts every item back as a new install shows it. */
export const STATUS_BAR_ITEMS_RESET: Partial<AppConfig> = {
  statusBarHiddenItems: [],
  statusBarShownItems: [],
  statusBarLeftItems: [],
  statusBarRightItems: [],
  showSystemMetrics: false,
  showTipsInToolbar: true,
  showEditorInToolbar: true,
};

/**
 * Whether every item shows, and sits, as it does by default, when Reset has nothing to do. Custom
 * items count wherever they come from: a hidden one, or one another workspace's items were placed
 * around, keeps Reset on.
 */
export function statusBarItemsAreDefault(
  config: StatusBarItemConfig | null,
  customKeys: CustomStatusItemKey[] = []
): boolean {
  const placement = statusBarPlacement(config, customKeys);
  const defaultPlacement = statusBarPlacement(null, customKeys);
  const savedPlacement = [
    ...(config?.statusBarLeftItems ?? []),
    ...(config?.statusBarRightItems ?? []),
  ];
  const known = new Set<string>(customKeys);
  return (
    STATUS_BAR_ITEMS.every(
      (item) => isStatusBarItemShown(config, item.id) === isStatusBarItemShown(null, item.id)
    ) &&
    !(config?.statusBarHiddenItems ?? []).some(isCustomStatusItemKey) &&
    !savedPlacement.some((id) => isCustomStatusItemKey(id) && !known.has(id)) &&
    placement.left.join() === defaultPlacement.left.join() &&
    placement.right.join() === defaultPlacement.right.join()
  );
}

/** Items the user can move along the bar: Komla's, and each custom item. */
export type StatusBarPlacedId = StatusBarItemId | CustomStatusItemKey;

export type StatusBarSide = 'left' | 'right';

export type StatusBarPlacement = Record<StatusBarSide, StatusBarPlacedId[]>;

// As many items as the settings keep per side, matching the IPC schema.
const MAX_PLACED_ITEMS = 128;

/**
 * Each item's default spot, in the order the bar shows them: the open workspace's custom items
 * close the left half.
 */
function defaultPlacement(
  customKeys: CustomStatusItemKey[]
): { id: StatusBarPlacedId; side: StatusBarSide }[] {
  return [
    ...STATUS_BAR_ITEMS.filter((item) => item.group !== 'app').map((item) => ({
      id: item.id,
      side: 'left' as const,
    })),
    ...customKeys.map((id) => ({ id, side: 'left' as const })),
    ...STATUS_BAR_ITEMS.filter((item) => item.group === 'app').map((item) => ({
      id: item.id,
      side: 'right' as const,
    })),
  ];
}

/**
 * Where each item sits, in order, with the open workspace's custom items. The user's lists come
 * first; an item they never placed, such as one added in an update or a new custom item, takes
 * its default side, after the item it follows by default.
 */
export function statusBarPlacement(
  config: StatusBarItemConfig | null,
  customKeys: CustomStatusItemKey[] = []
): StatusBarPlacement {
  const defaults = defaultPlacement(customKeys);
  const known = new Set(defaults.map((item) => item.id));
  const placed = new Set<string>();
  const pick = (ids: string[] | undefined) =>
    (ids ?? []).filter((id): id is StatusBarPlacedId => {
      if (!known.has(id as StatusBarPlacedId) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
  const placement: StatusBarPlacement = {
    left: pick(config?.statusBarLeftItems),
    right: pick(config?.statusBarRightItems),
  };
  defaults.forEach(({ id, side }, index) => {
    if (placed.has(id)) return;
    const items = placement[side];
    const previous = defaults
      .slice(0, index)
      .reverse()
      .find((item) => items.includes(item.id));
    items.splice(previous ? items.indexOf(previous.id) + 1 : 0, 0, id);
  });
  return placement;
}

/**
 * Puts back the entries of a saved list the open workspace doesn't know, such as another
 * workspace's custom items, each after the entry it followed, so moving an item here keeps their
 * places. Past the limit, those entries go first.
 */
function keepUnknownEntries(items: string[], saved: string[] | undefined, known: Set<string>) {
  const result = [...items];
  (saved ?? []).forEach((id, index) => {
    if (known.has(id) || result.includes(id)) return;
    const previous = saved!
      .slice(0, index)
      .reverse()
      .find((entry) => result.includes(entry));
    result.splice(previous ? result.indexOf(previous) + 1 : 0, 0, id);
  });
  while (result.length > MAX_PLACED_ITEMS) {
    const unknown = result.findIndex((id) => !known.has(id));
    result.splice(unknown === -1 ? MAX_PLACED_ITEMS : unknown, 1);
  }
  return result;
}

/** The config change that moves an item to `index` on `side`, counted without the item itself. */
export function statusBarItemMoveUpdate(
  config: StatusBarItemConfig | null,
  customKeys: CustomStatusItemKey[],
  id: StatusBarPlacedId,
  side: StatusBarSide,
  index: number
): Partial<AppConfig> {
  const placement = statusBarPlacement(config, customKeys);
  const known = new Set<string>([...placement.left, ...placement.right]);
  const left = placement.left.filter((item) => item !== id);
  const right = placement.right.filter((item) => item !== id);
  const items = side === 'left' ? left : right;
  items.splice(Math.max(0, Math.min(index, items.length)), 0, id);
  return {
    statusBarLeftItems: keepUnknownEntries(left, config?.statusBarLeftItems, known),
    statusBarRightItems: keepUnknownEntries(right, config?.statusBarRightItems, known),
  };
}

/**
 * Open in editor in the tab row or title bar. It shows while the status bar is off, as only the
 * bar's menu turns it back on.
 */
export function isOpenInEditorShownOutsideStatusBar(
  config: (StatusBarItemConfig & Pick<AppConfig, 'showStatusBar'>) | null
): boolean {
  return (
    !config || config.showStatusBar === false || isStatusBarItemShown(config, 'open-in-editor')
  );
}

/** Whether the status bar shows Tips; when it doesn't, the settings menus offer it instead. */
export function tipsInStatusBar(
  config: (StatusBarItemConfig & Pick<AppConfig, 'showStatusBar'>) | null
): boolean {
  return config?.showStatusBar !== false && isStatusBarItemShown(config, 'tips');
}
