/**
 * Reads what a page says about itself from the start of its HTML: its title,
 * Open Graph tags, icon, and the tool serving it. Only the <head> is read.
 */

export interface PageMetadata {
  /** og:title, else twitter:title. */
  title?: string;
  /** The <title>, which pages elsewhere often leave generic. */
  documentTitle?: string;
  siteName?: string;
  description?: string;
  imageUrl?: string;
  iconUrl?: string;
  /** The tool the page's markup gives away, as in "Vite" or "Next.js". */
  framework?: string;
}

const MAX_TEXT_LENGTH = 300;

// The named characters page titles use; others stay as written.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
};

// Tools built on Vite come before it, since their pages load Vite's client too.
const FRAMEWORK_MARKERS: Array<[string, RegExp]> = [
  ['Storybook', /storybook|sb-manager/i],
  ['Next.js', /\/_next\//],
  ['Nuxt', /\/_nuxt\//],
  ['SvelteKit', /\/_app\/immutable\/|__sveltekit/],
  ['Astro', /astro:scripts|\/@id\/astro/],
  ['Vite', /\/@vite\/client/],
];

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match;
  });
}

function cleanText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const cleaned = decodeEntities(text).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function tagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<\w+/, '').replace(/\/?>$/, '');
  for (const match of body.matchAll(
    /([^\s=/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  )) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function resolveHttpUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(decodeEntities(href.trim()), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const HEAD_END = /<\/head\s*>|<body[\s>]/i;

/** Whether `html` already holds the whole <head>, so no more of the page is needed. */
export function hasWholeHead(html: string): boolean {
  return HEAD_END.test(html);
}

/** Each <meta> tag's content by its property or name, lowercased; the first wins. */
function metaTags(head: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(tag);
    const key = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
    const content = attributes.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  return meta;
}

/** The first icon link, else the first Apple touch icon. */
function iconHref(head: string): string | undefined {
  let touchIcon: string | undefined;
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = tagAttributes(tag);
    const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('icon')) return attributes.get('href');
    if (rel.includes('apple-touch-icon')) touchIcon ??= attributes.get('href');
  }
  return touchIcon;
}

export function parsePageMetadata(html: string, baseUrl: string): PageMetadata {
  const end = html.search(HEAD_END);
  const rawHead = end === -1 ? html : html.slice(0, end);
  // Scripts, styles and comments can hold text that looks like tags.
  const head = rawHead
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const meta = metaTags(head);
  const icon = iconHref(head);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  return {
    title: cleanText(meta.get('og:title') ?? meta.get('twitter:title')),
    documentTitle: cleanText(titleTag),
    siteName: cleanText(meta.get('og:site_name') ?? meta.get('application-name')),
    description: cleanText(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description')
    ),
    imageUrl: resolveHttpUrl(
      meta.get('og:image:secure_url') ??
        meta.get('og:image') ??
        meta.get('og:image:url') ??
        meta.get('twitter:image'),
      baseUrl
    ),
    iconUrl: resolveHttpUrl(icon, baseUrl),
    framework: FRAMEWORK_MARKERS.find(([, marker]) => marker.test(rawHead))?.[0],
  };
}

// Python's http.server names itself after the module it's built on.
const SERVER_NAMES: Record<string, string> = {
  BaseHTTP: 'Python http.server',
  SimpleHTTP: 'Python http.server',
};

/** The tool an X-Powered-By or Server header names, without its version. */
export function serverNameFromHeaders(
  poweredBy: string | undefined,
  server: string | undefined
): string | undefined {
  const name = (poweredBy ?? server)?.trim().split(/[\s/]/)[0];
  if (!name) return undefined;
  return SERVER_NAMES[name] ?? name.slice(0, 40);
}
