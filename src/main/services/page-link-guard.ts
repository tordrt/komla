/**
 * Script for a page Komla shows in its sandbox, such as a panel's or a popover's, that keeps a
 * click on a link from leaving the page, which would leave an error page or a page without
 * Komla's script, or from running a `javascript:` URL, which could come from outside data such as
 * a pull request's. It opens an http(s) link from a real click with `open`, a JavaScript
 * expression for a function of its URL in the scope it's put in, whose caller checks the URL
 * again, and follows a `#` link within the page itself, so a hash router's links work. It
 * follows them with the URL it checked, which a click handler can't change after. It finds the
 * link through the event's path, so one in an open shadow root counts, and takes an `a` or
 * `area` with an href, HTML or SVG, as the browser would. It keeps what it reads a click with
 * when it runs, before the page's own scripts, as they could replace them to open a link of
 * their choosing on any click.
 */
export function pageLinkGuard(open: string): string {
  return `{
    const apply = Reflect.apply;
    const getter = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
    const open = ${open};
    const composedPath = Event.prototype.composedPath;
    const preventDefault = Event.prototype.preventDefault;
    const matches = Element.prototype.matches;
    const getAttribute = Element.prototype.getAttribute;
    const getAttributeNS = Element.prototype.getAttributeNS;
    const setAttribute = Element.prototype.setAttribute;
    const indexOf = String.prototype.indexOf;
    const slice = String.prototype.slice;
    // Resolves a link's URL as the browser would, for any kind of link.
    const resolver = document.createElement('a');
    const resolvedHref = getter(HTMLAnchorElement.prototype, 'href');
    const resolvedProtocol = getter(HTMLAnchorElement.prototype, 'protocol');
    const resolvedHash = getter(HTMLAnchorElement.prototype, 'hash');
    const withoutHash = (url) => {
      const at = apply(indexOf, url, ['#']);
      return at === -1 ? url : apply(slice, url, [0, at]);
    };
    const hrefOf = (node) =>
      apply(getAttribute, node, ['href']) ??
      apply(getAttributeNS, node, ['http://www.w3.org/1999/xlink', 'href']);
    const linkOf = (event) => {
      const path = apply(composedPath, event, []);
      for (let index = 0; index < path.length; index++) {
        try {
          if (!apply(matches, path[index], ['a, area'])) continue;
          const written = hrefOf(path[index]);
          if (written !== null) return written;
        } catch {}
      }
      return null;
    };
    addEventListener('click', (event) => {
      const written = linkOf(event);
      if (written === null) return;
      apply(preventDefault, event, []);
      apply(setAttribute, resolver, ['href', written]);
      const url = apply(resolvedHref, resolver, []);
      if (withoutHash(url) === withoutHash(location.href)) {
        location.hash = apply(resolvedHash, resolver, []);
        return;
      }
      const scheme = apply(resolvedProtocol, resolver, []);
      if (event.isTrusted && (scheme === 'https:' || scheme === 'http:')) open(url);
    }, true);
  }`;
}
