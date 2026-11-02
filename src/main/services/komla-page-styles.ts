import {
  OKLCH_CHANNELS,
  STATUS_POPOVER_THEME_COLORS,
  type StatusPopoverTheme,
} from '../../shared/types/status-items';

/*
 * What every page Komla shows in its sandbox shares, a status item's popover and a sidebar panel's
 * page alike: the window's theme as CSS variables, Komla's fonts and scrollbars, and komla.css.
 */

// No color-scheme: Chromium paints a dark scheme's frame opaque, and the popover shows through.
/** Komla's theme colors as CSS variables on the root, such as `--success`. */
export function themeStyle(theme: StatusPopoverTheme | undefined): string {
  if (!theme) return '';
  const colors = STATUS_POPOVER_THEME_COLORS.flatMap((name) => {
    const channels = theme.colors[name];
    return channels && OKLCH_CHANNELS.test(channels) ? [`--${name}: oklch(${channels});`] : [];
  });
  return `:root { ${colors.join(' ')} }`;
}

/** Komla's fonts, Nerd Font icons included, as Komla's pages serve them. */
export const KOMLA_FONT_FACES = `@font-face { font-family: 'Geist'; src: url('/__komla/fonts/geist.woff2') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Komla Icons'; src: url('/__komla/fonts/nerd-font.ttf') format('truetype'); unicode-range: U+E000-F8FF, U+F0000-FFFFD; }
@font-face { font-family: 'Komla Mono'; src: url('/__komla/fonts/nerd-font.ttf') format('truetype'); }`;

/** Scrollbars as Komla draws them. */
export const KOMLA_SCROLLBARS = `::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--foreground) 25%, transparent); border-radius: 4px; }`;

/**
 * Komla's look for its pages: classes prefixed `k-` in the window's theme, so a page looks like
 * Komla without styles of its own. A panel's page links it at KOMLA_STYLESHEET_PATH; a popover's
 * page has it inline, before the popover's own HTML.
 */
export const KOMLA_STYLESHEET = `/* Komla's look for its pages. Colors are the window's theme, as --foreground and so on. */
:root { --k-radius: 6px; --k-gap: 8px; --k-surface: var(--card); --k-page-y: 10px; --k-page-x: 12px; }
body { padding: var(--k-page-y) var(--k-page-x); }
.k-stack { display: flex; flex-direction: column; gap: var(--k-gap); }
.k-row { display: flex; align-items: center; gap: var(--k-gap); min-width: 0; }
.k-grow { flex: 1; min-width: 0; }
.k-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k-muted { color: var(--muted-foreground); }
.k-mono, code { font: 11px/1.4 'Komla Mono', ui-monospace, monospace; }
code { padding: 1px 4px; border-radius: 4px; background: color-mix(in oklch, var(--muted) 80%, transparent); }
.k-success { color: var(--success); } .k-warning { color: var(--warning); }
.k-error { color: var(--error); } .k-info { color: var(--info); }
.k-section-title { margin: 4px 0 2px; font-size: 11px; font-weight: 500; color: var(--muted-foreground); }
.k-card { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--k-radius); background: var(--card); }
.k-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.k-item { display: flex; align-items: center; gap: var(--k-gap); min-width: 0; padding: 5px 6px; border-radius: var(--k-radius); }
.k-item:hover, button.k-item:focus-visible { background: color-mix(in oklch, var(--accent) 70%, transparent); }
button.k-item { width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.k-badge { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; background: color-mix(in oklch, var(--muted) 80%, transparent); color: var(--muted-foreground); }
.k-badge.k-success { background: color-mix(in oklch, var(--success) 16%, transparent); color: var(--success); }
.k-badge.k-warning { background: color-mix(in oklch, var(--warning) 16%, transparent); color: var(--warning); }
.k-badge.k-error { background: color-mix(in oklch, var(--error) 16%, transparent); color: var(--error); }
.k-badge.k-info { background: color-mix(in oklch, var(--info) 16%, transparent); color: var(--info); }
.k-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: currentColor; }
.k-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--k-radius); background: transparent; color: var(--foreground); font: inherit; text-decoration: none; cursor: pointer; }
.k-button:hover { background: color-mix(in oklch, var(--accent) 70%, transparent); }
.k-button:disabled { opacity: 0.5; cursor: default; }
.k-button:focus-visible, .k-input:focus-visible { outline: 2px solid color-mix(in oklch, var(--primary) 60%, transparent); outline-offset: 1px; }
.k-button.k-primary { border-color: transparent; background: var(--primary); color: var(--primary-foreground); }
.k-button.k-primary:hover { background: color-mix(in oklch, var(--primary) 88%, var(--foreground)); }
.k-button.k-ghost { border-color: transparent; }
.k-input { box-sizing: border-box; height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--k-radius); background: transparent; color: var(--foreground); font: inherit; }
.k-progress { height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in oklch, var(--muted) 80%, transparent); }
.k-progress > span { display: block; height: 100%; width: calc(var(--value, 0) * 100%); background: var(--primary); }
.k-table { width: 100%; border-collapse: collapse; }
.k-table th { font-weight: 500; text-align: left; color: var(--muted-foreground); }
.k-table th, .k-table td { padding: 4px 6px; border-bottom: 1px solid var(--border); }
.k-empty { padding: 24px 8px; text-align: center; color: var(--muted-foreground); }
.k-spinner { width: 12px; height: 12px; flex: none; border: 2px solid color-mix(in oklch, var(--foreground) 20%, transparent); border-top-color: var(--foreground); border-radius: 50%; animation: k-spin 0.8s linear infinite; }
@keyframes k-spin { to { transform: rotate(360deg); } }
.k-spin { animation: k-spin 0.8s linear infinite; }

/* Icons: a Nerd Font glyph, such as &#xea6d; for search, the size of the text beside it. */
.k-icon { display: inline-block; flex: none; width: 1.2em; font: inherit; font-family: 'Komla Icons', sans-serif; font-style: normal; line-height: 1; text-align: center; }
.k-tabular { font-variant-numeric: tabular-nums; }
.k-clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--k-lines, 2); overflow: hidden; }
a.k-link { color: inherit; text-decoration: none; } a.k-link:hover { text-decoration: underline; }
.k-kbd { padding: 0 4px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; font-size: 10px; color: var(--muted-foreground); }
.k-divider { height: 1px; margin: 4px 0; border: 0; background: color-mix(in oklch, var(--border) 70%, transparent); }

/* A header that stays at the top as the page scrolls: a toolbar, and a line of meta below it. */
.k-header { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 6px; margin: calc(-1 * var(--k-page-y)) calc(-1 * var(--k-page-x)) 4px; padding: var(--k-page-y) var(--k-page-x) 8px; background: var(--k-surface); border-bottom: 1px solid color-mix(in oklch, var(--border) 60%, transparent); }
.k-toolbar { display: flex; align-items: center; gap: 4px; min-width: 0; }
.k-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; min-width: 0; font-size: 11px; color: var(--muted-foreground); }
.k-meta > .k-sep::before { content: '\\00b7'; opacity: 0.6; }

/* Inputs: a search field with its icon inside, and buttons smaller or only an icon. */
.k-input::placeholder { color: var(--muted-foreground); opacity: 0.8; }
.k-search { position: relative; display: flex; flex: 1; align-items: center; min-width: 0; }
.k-search > .k-icon { position: absolute; left: 7px; color: var(--muted-foreground); pointer-events: none; }
.k-search > .k-input { width: 100%; padding-left: 25px; background: color-mix(in oklch, var(--muted) 40%, transparent); }
.k-search > .k-input:focus { background: transparent; }
.k-search > .k-input::-webkit-search-cancel-button { filter: grayscale(1); opacity: 0.6; }
.k-button.k-small { height: 22px; padding: 0 8px; gap: 4px; font-size: 11px; }
.k-icon-button { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--k-radius); background: transparent; color: var(--muted-foreground); font: 13px/1 'Komla Icons', sans-serif; cursor: pointer; }
.k-icon-button:hover { background: color-mix(in oklch, var(--accent) 70%, transparent); color: var(--foreground); }
.k-icon-button:disabled { opacity: 0.5; cursor: default; }
.k-icon-button:focus-visible, .k-item:focus-visible, summary:focus-visible { outline: 2px solid color-mix(in oklch, var(--primary) 60%, transparent); outline-offset: -2px; }

/* Sections: a small title with a count, which folds as a <details>. */
.k-section { margin-top: 10px; }
.k-section-header { display: flex; align-items: center; gap: 6px; padding: 2px 0 4px; font-size: 11px; font-weight: 500; color: var(--muted-foreground); }
details.k-section > summary { list-style: none; cursor: pointer; user-select: none; border-radius: 4px; }
details.k-section > summary::-webkit-details-marker { display: none; }
details.k-section > summary::before { content: '\\eab6'; width: 12px; font-family: 'Komla Icons', sans-serif; font-size: 10px; text-align: center; transition: transform 0.12s; }
details.k-section[open] > summary::before { transform: rotate(90deg); }
.k-count { min-width: 8px; padding: 0 5px; border-radius: 999px; font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; background: color-mix(in oklch, var(--muted) 90%, transparent); color: var(--muted-foreground); }
.k-count.k-warning { background: color-mix(in oklch, var(--warning) 18%, transparent); color: var(--warning); }
.k-count.k-error { background: color-mix(in oklch, var(--error) 18%, transparent); color: var(--error); }

/* Rows: an item that is open, and a person's initials in a color their name picks (--k-hue, 0 to 360). */
.k-item[aria-expanded='true'], .k-item[aria-selected='true'] { background: color-mix(in oklch, var(--accent) 55%, transparent); }
.k-item[aria-expanded='true']:hover, .k-item[aria-selected='true']:hover { background: color-mix(in oklch, var(--accent) 80%, transparent); }
.k-avatar { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 50%; font-size: 9px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; background: oklch(0.62 0.13 var(--k-hue, 250) / 22%); color: color-mix(in oklch, oklch(0.62 0.15 var(--k-hue, 250)) 70%, var(--foreground)); }

/* Messages: a banner above the content, an empty state with an icon, and rows still loading. */
.k-banner { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border-radius: var(--k-radius); font-size: 11px; background: color-mix(in oklch, var(--muted) 70%, transparent); }
.k-banner.k-error { background: color-mix(in oklch, var(--error) 13%, transparent); color: color-mix(in oklch, var(--error) 65%, var(--foreground)); }
.k-banner.k-warning { background: color-mix(in oklch, var(--warning) 13%, transparent); color: color-mix(in oklch, var(--warning) 65%, var(--foreground)); }
.k-banner.k-success { background: color-mix(in oklch, var(--success) 13%, transparent); color: color-mix(in oklch, var(--success) 65%, var(--foreground)); }
.k-empty > .k-icon { display: block; width: auto; margin: 0 auto 8px; font-size: 22px; opacity: 0.55; }
.k-empty > span { display: block; }
.k-empty > strong { display: block; margin-bottom: 2px; font-weight: 500; color: var(--foreground); }
.k-skeleton { height: 10px; border-radius: 4px; background: linear-gradient(90deg, color-mix(in oklch, var(--muted) 55%, transparent) 30%, color-mix(in oklch, var(--muted) 100%, transparent) 50%, color-mix(in oklch, var(--muted) 55%, transparent) 70%); background-size: 300% 100%; animation: k-shimmer 1.4s ease-in-out infinite; }
@keyframes k-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }

/* !important, so the hidden attribute beats any k- rule that sets display; until-found keeps the browser's own. */
[hidden]:not([hidden='until-found']) { display: none !important; }
`;
