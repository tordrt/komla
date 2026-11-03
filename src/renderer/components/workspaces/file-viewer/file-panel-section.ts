/**
 * The look the sections below the file tree share (Notes, Imported files, Linked workspaces), so
 * they read as one set: a faint line above each, a quiet sentence-case header with its count in
 * a pill, and rows of one size with gray icons.
 */

/** The section itself; each adds its own sizing. */
export const FILE_PANEL_SECTION_CLASS = 'shrink-0 border-t border-foreground/8 pt-0.5 pb-1';

/** The header's label and caret; each adds its own layout. */
export const FILE_PANEL_SECTION_HEADER_CLASS =
  'items-center gap-1 text-xs font-medium whitespace-nowrap text-muted-foreground';

/** The section's count, after its label. */
export const FILE_PANEL_SECTION_COUNT_CLASS =
  'ml-0.5 shrink-0 rounded-full bg-foreground/[0.07] px-1.5 text-2xs font-medium tabular-nums';

/** A row: the same inset, size and type in every section. */
export const FILE_PANEL_SECTION_ROW_CLASS =
  'mx-1 flex min-h-6.5 w-[calc(100%-8px)] gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px]';

/** A row's icon. */
export const FILE_PANEL_SECTION_ICON_CLASS = 'size-3.5 shrink-0 text-muted-foreground';
