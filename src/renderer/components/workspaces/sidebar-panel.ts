// Light themes lift the sidebar's surfaces off the chrome with white laid over it, which lifts on
// any chrome and keeps some of its tint; a theme's popover can sit under its chrome. Panels take
// part of the lift and cards all of it; a hovered card takes a card's lift without its shadow.
// Tailwind finds classes by their literal text, so the hover class is spelled out too.
export const SIDEBAR_PANEL_LIGHT_FILL = 'bg-white/70';
export const SIDEBAR_CARD_LIGHT_FILL = 'bg-white';
export const SIDEBAR_CARD_LIGHT_HOVER = 'hover:bg-white';

// The panel each sidebar list sits on (a project, the Pinned shelf, or the whole list when
// workspaces aren't grouped), which the project icon prompt previews: on --sidebar-muted in dark
// themes, with a clear line around it, drawn as an outline so the cards' fills stay under it.
// Cards run to its edges, so they share its corners. `sidebar-panel` names it for the Theme Lab.
export const SIDEBAR_PANEL_CLASS = `sidebar-panel rounded-xl ${SIDEBAR_PANEL_LIGHT_FILL} dark:bg-[oklch(var(--sidebar-muted))] dark:outline-1 dark:-outline-offset-1 dark:outline-foreground/[0.14]`;

// The selected workspace card on its panel: in light themes lifted off it by a shadow and a faint
// ring as well; in dark ones a light wash and a hairline inside its edge. `sidebar-selected-card`
// names it for the Theme Lab.
export const SIDEBAR_SELECTED_CARD_FILL = `sidebar-selected-card ${SIDEBAR_CARD_LIGHT_FILL} shadow-soft ring-1 ring-foreground/[0.07] dark:bg-foreground/[0.08] dark:shadow-none dark:ring-inset dark:ring-foreground/[0.06]`;
