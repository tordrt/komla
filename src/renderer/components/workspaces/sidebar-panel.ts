// Light themes lift the sidebar's surfaces off the chrome with white laid over it, which lifts on
// any chrome and keeps some of its tint; a theme's popover can sit under its chrome. Panels take
// part of the lift and cards all of it; a hovered card takes a card's lift without its shadow.
// Tailwind finds classes by their literal text, so the hover class is spelled out too.
// Off white, so the selected card's white stands out on it.
export const SIDEBAR_PANEL_LIGHT_FILL = 'bg-white/50';
export const SIDEBAR_CARD_LIGHT_FILL = 'bg-white';
export const SIDEBAR_CARD_LIGHT_HOVER = 'hover:bg-white';

// The panel each sidebar list sits on (a project, the Pinned shelf, or the whole list when
// workspaces aren't grouped), which the project icon prompt previews: on --sidebar-muted in dark
// themes, with a clear line around it, drawn as an outline so the cards' fills stay under it, and
// a fainter one in light themes, where the off-white panel is close to the chrome.
// Cards run to its edges, so they share its corners. `sidebar-panel` names it for the Theme Lab.
export const SIDEBAR_PANEL_CLASS = `sidebar-panel rounded-xl ${SIDEBAR_PANEL_LIGHT_FILL} outline-1 -outline-offset-1 outline-foreground/[0.07] dark:bg-[oklch(var(--sidebar-muted))] dark:outline-foreground/[0.14]`;

// The selected workspace card on its panel: in light themes lifted off it by a shadow and a faint
// ring inside its edge, so it doesn't overhang the panel; in dark ones a light wash and a hairline inside its edge. `sidebar-selected-card`
// names it for the Theme Lab.
export const SIDEBAR_SELECTED_CARD_FILL = `sidebar-selected-card ${SIDEBAR_CARD_LIGHT_FILL} shadow-soft-lg ring-1 ring-inset ring-foreground/[0.2] dark:bg-foreground/[0.13] dark:shadow-none dark:ring-foreground/[0.22]`;
