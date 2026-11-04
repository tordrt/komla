import { type StatusPopoverTheme } from '../../shared/types/status-items';

import {
  KOMLA_FONT_FACES,
  KOMLA_SCROLLBARS,
  KOMLA_STYLESHEET,
  themeStyle,
} from './komla-page-styles';
import { pageLinkGuard } from './page-link-guard';

// Reports the page's height, so the popover fits it; Komla caps it and the page scrolls past that.
// The root's box is as tall as what it holds, where its scrollHeight never drops below the frame.
// Escape reaches the page, not Komla, while it has focus, so it asks Komla to close the popover.
// Komla blocks the frame from leaving its page, which would leave an error page, so a click on an
// http(s) link asks Komla to open it in the browser instead. That ask carries a token this script
// sends first, before the page's own scripts run, so they can't open links without a click.
const PAGE_SCRIPT = `(() => {
  const target = parent;
  const post = (message) => target.postMessage(message, '*');
  const token = crypto.randomUUID();
  post({ komlaPopoverToken: token });
  const report = () =>
    post({ komlaPopoverHeight: document.documentElement.getBoundingClientRect().height });
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') post({ komlaPopoverClose: true });
  });
  ${pageLinkGuard('(url) => post({ komlaPopoverOpenLink: url, token })')}
})();`;

/**
 * The page an HTML popover shows: the command's HTML after Komla's theme colors as CSS variables,
 * its fonts, Nerd Font icons included, komla.css's `k-` classes, as a sidebar panel's page has them, a look for `<code>`, `data-theme` on the root, and a script
 * that reports the page's height. The page's own styles come later, so they win.
 */

export function buildStatusPopoverPage(
  html: string,
  theme: StatusPopoverTheme | undefined
): string {
  const scheme = theme?.scheme === 'light' ? 'light' : 'dark';
  return `<!doctype html>
<meta charset="utf-8">
<script>document.documentElement.dataset.theme = '${scheme}';</script>
<style>
${themeStyle(theme)}
${KOMLA_FONT_FACES}
${KOMLA_STYLESHEET}
html, body { margin: 0; background: transparent; }
body { font: 12px/1.5 'Geist', 'Komla Icons', system-ui, sans-serif; color: var(--foreground); }
a { color: var(--primary); }
code { font: 11px/1.4 'Komla Mono', ui-monospace, monospace; padding: 1px 4px; border-radius: 4px; background: color-mix(in oklch, var(--muted) 80%, transparent); }
${KOMLA_SCROLLBARS}
</style>
<script>${PAGE_SCRIPT}</script>
${html}`;
}
