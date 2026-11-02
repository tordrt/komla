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
:root { --k-radius: 6px; --k-gap: 8px; }
body { padding: 10px 12px; }
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
.k-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--k-radius); background: transparent; color: var(--foreground); font: inherit; cursor: pointer; }
.k-button:hover { background: color-mix(in oklch, var(--accent) 70%, transparent); }
.k-button:disabled { opacity: 0.5; cursor: default; }
.k-button:focus-visible, .k-input:focus-visible { outline: 2px solid color-mix(in oklch, var(--primary) 60%, transparent); outline-offset: 1px; }
.k-button.k-primary { border-color: transparent; background: var(--primary); color: var(--primary-foreground); }
.k-button.k-primary:hover { background: color-mix(in oklch, var(--primary) 88%, var(--foreground)); }
.k-button.k-ghost { border-color: transparent; }
.k-input { height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--k-radius); background: transparent; color: var(--foreground); font: inherit; }
.k-progress { height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in oklch, var(--muted) 80%, transparent); }
.k-progress > span { display: block; height: 100%; width: calc(var(--value, 0) * 100%); background: var(--primary); }
.k-table { width: 100%; border-collapse: collapse; }
.k-table th { font-weight: 500; text-align: left; color: var(--muted-foreground); }
.k-table th, .k-table td { padding: 4px 6px; border-bottom: 1px solid var(--border); }
.k-empty { padding: 24px 8px; text-align: center; color: var(--muted-foreground); }
.k-spinner { width: 12px; height: 12px; flex: none; border: 2px solid color-mix(in oklch, var(--foreground) 20%, transparent); border-top-color: var(--foreground); border-radius: 50%; animation: k-spin 0.8s linear infinite; }
@keyframes k-spin { to { transform: rotate(360deg); } }
`;
