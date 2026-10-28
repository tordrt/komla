// The panel each sidebar list sits on (a project, the Pinned shelf, or the whole list when
// workspaces aren't grouped), which the project icon prompt previews: faint in light themes and
// on --sidebar-muted in dark ones.
export const SIDEBAR_PANEL_CLASS =
  'rounded-xl bg-foreground/[0.03] p-0.5 pb-1 dark:bg-[oklch(var(--sidebar-muted))]';
