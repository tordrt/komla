/** Theme colors a status item can take, so it reads the same in every theme. */
export const STATUS_ITEM_TONES = ['success', 'warning', 'error', 'info'] as const;
export type StatusItemTone = (typeof STATUS_ITEM_TONES)[number];

/**
 * Colors a status item's text can take: theme colors, so it reads the same in every theme, or a
 * hex color such as `#e5c07b`.
 */
export const STATUS_ITEM_THEME_COLORS = [
  'success',
  'warning',
  'error',
  'info',
  'muted',
  'foreground',
] as const;
export type StatusItemThemeColor = (typeof STATUS_ITEM_THEME_COLORS)[number];
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isStatusItemColor(value: string): boolean {
  return (STATUS_ITEM_THEME_COLORS as readonly string[]).includes(value) || HEX_COLOR.test(value);
}

/** Ids name an item within a workspace, as `tests` or `deploy`; setting one again replaces it. */
export const STATUS_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const MAX_STATUS_ITEM_TEXT = 60;
export const MAX_STATUS_ITEM_SEGMENTS = 30;
export const MAX_STATUS_ITEM_ICONS = 4;
/** The largest icon image, in bytes. */
export const MAX_STATUS_ICON_BYTES = 32 * 1024;
export const MAX_STATUS_ITEM_TOOLTIP = 500;
export const MAX_STATUS_ITEMS_PER_WORKSPACE = 20;
export const MAX_STATUS_POPOVER_MARKDOWN = 20_000;
export const MAX_STATUS_POPOVER_HTML = 60_000;
export const MAX_STATUS_POPOVER_BUTTONS = 6;
export const MAX_STATUS_BUTTON_LABEL = 40;

/** A run of an item's text in one color, from terminal colors or as its source named it. */
export interface StatusTextSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

/** An image in an item's text, as a base64 data URL; with a color, its shape shows in that color. */
export interface StatusIconSegment {
  icon: string;
  color?: string;
}

export type StatusItemSegment = StatusTextSegment | StatusIconSegment;

export function isStatusIconSegment(segment: StatusItemSegment): segment is StatusIconSegment {
  return 'icon' in segment;
}

/** What a status item shows; clicking it opens its popover, or else `link`. */
export interface StatusItemContent {
  text: string;
  /** The text in colored runs and icons, when parts of it have colors of their own or icons. */
  segments?: StatusItemSegment[];
  tone?: StatusItemTone;
  /** A theme color from STATUS_ITEM_THEME_COLORS, or a hex color. */
  color?: string;
  tooltip?: string;
  link?: string;
  /** A sandboxed HTML page shown in a popover on click, for an item an agent set. */
  popover?: string;
  /** Plain Markdown shown in the popover in place of a page, for an item an agent set. */
  popoverMarkdown?: string;
}

/**
 * A button below a popover. It opens a link, runs one of the project's Actions, or runs a command
 * the item names in status-items.json, never a command of its own: output can carry text from
 * elsewhere, such as a pull request title.
 */
export type StatusPopoverButton =
  | { label: string; link: string }
  | { label: string; action: string }
  | { label: string; run: string };

export interface StatusPopoverContent {
  markdown: string;
  /** A sandboxed page for the popover's HTML, in place of Markdown. */
  htmlUrl?: string;
  buttons: StatusPopoverButton[];
}

/** Theme colors an HTML popover gets as CSS variables, such as `var(--success)`. */
export const STATUS_POPOVER_THEME_COLORS = [
  'background',
  'foreground',
  'card',
  'muted',
  'muted-foreground',
  'border',
  'accent',
  'primary',
  'primary-foreground',
  'success',
  'warning',
  'error',
  'info',
] as const;
export type StatusPopoverThemeColor = (typeof STATUS_POPOVER_THEME_COLORS)[number];

/** The window's theme, for an HTML popover to match: each color as OKLCH channels. */
export interface StatusPopoverTheme {
  scheme: 'light' | 'dark';
  colors: Partial<Record<StatusPopoverThemeColor, string>>;
}

/** What one run of an item's popover command shows. */
export interface StatusPopoverResult {
  id: string;
  workspaceId: string;
  content: StatusPopoverContent | null;
  /** Why the command failed. */
  error?: string;
}

/** How a popover button's command went. */
export interface StatusButtonRunResult {
  error?: string;
}

/** A status item an agent set with `komla status set`, shown while its workspace is open. */
export interface AgentStatusItem extends StatusItemContent {
  id: string;
  workspaceId: string;
  updatedAt: number;
  /** A digest of popover, which changes when the page does; windows get it in the page's place. */
  popoverPageId?: string;
}

/** An agent's item as windows get it: without its popover's page, which they fetch when wanted. */
export type WindowStatusItem = Omit<AgentStatusItem, 'popover'>;

/**
 * An item from status-items.json or a plugin that runs in a workspace: a command Komla runs on an
 * interval.
 */
export interface StatusCommand {
  id: string;
  intervalSeconds: number;
  /** Runs on this computer, the same for every workspace, not where the workspace's files are. */
  runOn?: 'local';
  /** Shown while the command fails. */
  label?: string;
  /** Clicking the item runs its popover command and shows the result. */
  popover?: boolean;
  /** One of the project's Actions, by title or id, that clicking the item runs. */
  action?: string;
  /** The name of the plugin the item comes from, when it isn't status-items.json's. */
  plugin?: string;
}

export interface StatusCommandList {
  items: StatusCommand[];
  /** What is wrong with status-items.json, when Komla can't read it. */
  problem?: string;
  /** When Komla last read status-items.json; a run that started before may show an earlier command. */
  changedAt?: number;
}

/** What one run of a status command shows; nothing when content is null. */
export interface StatusCommandResult {
  id: string;
  workspaceId: string;
  content: StatusItemContent | null;
  /** Why the command failed, shown in the item's tooltip. */
  error?: string;
  ranAt: number;
  /** The item runs on this computer, so this shows in every workspace. */
  runOn?: 'local';
}

/**
 * The workspace an item's runs belong to: its own, or none for an item that runs on this
 * computer, whose output is the same in every workspace.
 */
export function statusCommandScope(
  workspaceId: string,
  item: { runOn?: 'local' | 'workspace' }
): string {
  return item.runOn === 'local' ? '' : workspaceId;
}
