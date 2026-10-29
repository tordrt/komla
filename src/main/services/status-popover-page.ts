import {
  STATUS_POPOVER_THEME_COLORS,
  type StatusPopoverTheme,
} from '../../shared/types/status-items';

/** OKLCH channels as Komla's themes write them, such as `0.72 0.17 150` or `0.5 0.1 250 / 40%`. */
export const OKLCH_CHANNELS = /^[0-9.%\s/+-]{1,60}$/;

// Reports the page's height, so the popover fits it; Komla caps it and the page scrolls past that.
// The root's box is as tall as what it holds, where its scrollHeight never drops below the frame.
// Escape reaches the page, not Komla, while it has focus, so it asks Komla to close the popover.
// Komla blocks the frame from leaving its page, which would leave an error page, so a click on an
// http(s) link asks Komla to open it in the browser instead. That ask carries a token this script
// sends first, before the page's own scripts run, so they can't open links without a click. It
// keeps what it reads a click with from then, as a page script could replace parent, the event's
// target, closest or a link's href and open a link of its choosing on any click.
const PAGE_SCRIPT = `(() => {
  const target = parent;
  const post = (message) => target.postMessage(message, '*');
  const apply = Reflect.apply;
  const getter = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
  const eventTarget = getter(Event.prototype, 'target');
  const preventDefault = Event.prototype.preventDefault;
  const closest = Element.prototype.closest;
  const href = getter(HTMLAnchorElement.prototype, 'href');
  const protocol = getter(HTMLAnchorElement.prototype, 'protocol');
  const token = crypto.randomUUID();
  post({ komlaPopoverToken: token });
  const report = () =>
    post({ komlaPopoverHeight: document.documentElement.getBoundingClientRect().height });
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') post({ komlaPopoverClose: true });
  });
  addEventListener('click', (event) => {
    let link;
    try {
      link = apply(closest, apply(eventTarget, event, []), ['a[href]']);
    } catch {
      return;
    }
    if (!link) return;
    apply(preventDefault, event, []);
    // An SVG link has no protocol to read; it stays put.
    let scheme;
    try {
      scheme = apply(protocol, link, []);
    } catch {
      return;
    }
    if (event.isTrusted && (scheme === 'https:' || scheme === 'http:')) {
      post({ komlaPopoverOpenLink: apply(href, link, []), token });
    }
  }, true);
})();`;

// No color-scheme: Chromium paints a dark scheme's frame opaque, and the popover shows through.
function themeStyle(theme: StatusPopoverTheme | undefined): string {
  if (!theme) return '';
  const colors = STATUS_POPOVER_THEME_COLORS.flatMap((name) => {
    const channels = theme.colors[name];
    return channels && OKLCH_CHANNELS.test(channels) ? [`--${name}: oklch(${channels});`] : [];
  });
  return `:root { ${colors.join(' ')} }`;
}

/**
 * The page an HTML popover shows: the command's HTML after Komla's theme colors as CSS variables,
 * its fonts, Nerd Font icons included, a look for `<code>`, `data-theme` on the root, and a script
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
@font-face { font-family: 'Geist'; src: url('/__komla/fonts/geist.woff2') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Komla Icons'; src: url('/__komla/fonts/nerd-font.ttf') format('truetype'); unicode-range: U+E000-F8FF, U+F0000-FFFFD; }
@font-face { font-family: 'Komla Mono'; src: url('/__komla/fonts/nerd-font.ttf') format('truetype'); }
html, body { margin: 0; background: transparent; }
body { padding: 10px 12px; font: 12px/1.5 'Geist', 'Komla Icons', system-ui, sans-serif; color: var(--foreground); }
a { color: var(--primary); }
code { font: 11px/1.4 'Komla Mono', ui-monospace, monospace; padding: 1px 4px; border-radius: 4px; background: color-mix(in oklch, var(--muted) 80%, transparent); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--foreground) 25%, transparent); border-radius: 4px; }
</style>
<script>${PAGE_SCRIPT}</script>
${html}`;
}
