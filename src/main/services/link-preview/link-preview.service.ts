import { isLocalPageUrl, isSignInPageUrl } from '../../../shared/lib/browser-tabs';

import { hasWholeHead, parsePageMetadata, serverNameFromHeaders } from './page-metadata';

import type { FetchedPage, FetchPage, FetchPageOptions } from './fetch-page';
import type { LinkPreview, LinkPreviewRequest } from '../../../shared/types';

const PAGE_OPTIONS = {
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  maxBytes: 512 * 1024,
  isEnough: (body: Buffer) => hasWholeHead(body.toString('utf8')),
};
const ICON_MAX_BYTES = 100 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
// Pages on this computer are dev servers, which may compile a page before answering.
const LOCAL_TIMEOUT_MS = 5_000;
const WEB_TIMEOUT_MS = 6_000;
const IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

// A local server keeps its page while the same process holds the port; without
// a process, the port may have been handed to another server since.
const LOCAL_PROCESS_TTL_MS = 60 * 60_000;
const LOCAL_TTL_MS = 60_000;
const WEB_TTL_MS = 24 * 60 * 60_000;
const FAILED_TTL_MS = 30_000;
const MAX_CACHED = 300;
const MAX_CACHED_IMAGES = 12;
const MAX_CONCURRENT_FETCHES = 6;

// Query parameters and path words of links meant to be opened once, as to verify an
// email, accept an invite or reset a password, or a presigned download.
const ONE_TIME_QUERY_PARAMS = new Set([
  'code',
  'key',
  'nonce',
  'otp',
  'sig',
  'signature',
  'ticket',
  'x-amz-signature',
  'x-goog-signature',
]);
const ONE_TIME_PATH_WORDS = new Set([
  'accept',
  'activate',
  'activation',
  'approve',
  'claim',
  'confirm',
  'confirmation',
  'invitation',
  'invite',
  'magic',
  'redeem',
  'reset',
  'unsubscribe',
  'verification',
  'verify',
]);

/** Whether a link looks like one that loading could use up, such as a token in an email. */
function isOneTimeLinkUrl(input: string): boolean {
  const url = new URL(input);
  const params = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  return (
    params.some((name) => ONE_TIME_QUERY_PARAMS.has(name) || name.endsWith('token')) ||
    url.pathname
      .split('/')
      .flatMap((segment) =>
        segment
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z\d]+/)
      )
      .some((word) => ONE_TIME_PATH_WORDS.has(word))
  );
}

export interface LinkPreviewServiceDeps {
  fetchLocally: FetchPage;
  /** Fetches on the SSH host of `workspaceId`; null when it isn't an SSH workspace. */
  fetchOnSshHost: (
    workspaceId: string,
    url: string,
    options: FetchPageOptions
  ) => Promise<FetchedPage | null>;
  now?: () => number;
}

export interface LinkPreviewService {
  getPreview(request: LinkPreviewRequest): Promise<LinkPreview | null>;
  /** An og:image from the internet, or from a page on this computer, as a data: URL. */
  getImage(url: string): Promise<string | null>;
}

interface CacheEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

function isOk(page: FetchedPage): boolean {
  return page.status >= 200 && page.status < 300;
}

function imageDataUrl(page: FetchedPage | null, maxBytes: number): string | null {
  if (!page || !isOk(page) || page.body.length === 0 || page.body.length >= maxBytes) return null;
  // Servers often send favicons as a generic binary type.
  const type =
    page.contentType === 'application/octet-stream' && /\.ico$/i.test(new URL(page.url).pathname)
      ? 'image/x-icon'
      : page.contentType;
  return IMAGE_TYPES.has(type) ? `data:${type};base64,${page.body.toString('base64')}` : null;
}

function isHtml(page: FetchedPage): boolean {
  return page.contentType === 'text/html' || page.contentType === 'application/xhtml+xml';
}

// Only images from this computer's own pages are read from it.
function webImageUrl(url: string | undefined): string | undefined {
  return url && !isLocalPageUrl(url) ? url : undefined;
}

/**
 * The page read for a server: its home page. A printed address may carry a one-time
 * token, as a sign-in link's does, that reading it would use up.
 */
function localPageUrl(url: string): string {
  return new URL('/', url).toString();
}

function compact(preview: LinkPreview): LinkPreview | null {
  const entries = Object.entries(preview).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function createLinkPreviewService(deps: LinkPreviewServiceDeps): LinkPreviewService {
  const now = deps.now ?? Date.now;
  const previews = new Map<string, CacheEntry<LinkPreview | null>>();
  const images = new Map<string, CacheEntry<string | null>>();
  let running = 0;
  const waiting: Array<() => void> = [];

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running >= MAX_CONCURRENT_FETCHES)
      await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  function cached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    maxEntries: number,
    load: () => Promise<T>,
    ttl: (value: T) => number
  ): Promise<T> {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
    cache.delete(key);
    const entry: CacheEntry<T> = { value: load(), expiresAt: Number.POSITIVE_INFINITY };
    cache.set(key, entry);
    void entry.value.then(
      (value) => {
        entry.expiresAt = now() + ttl(value);
      },
      () => cache.delete(key)
    );
    for (const oldest of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(oldest);
    }
    return entry.value;
  }

  type Fetch = (
    url: string,
    options: Omit<FetchPageOptions, 'timeoutMs'>
  ) => Promise<FetchedPage | null>;

  async function readIcon(fetch: Fetch, iconUrl: string | undefined, pageUrl: string) {
    const icon = await fetch(iconUrl ?? new URL('/favicon.ico', pageUrl).toString(), {
      accept: 'image/*',
      maxBytes: ICON_MAX_BYTES,
    });
    return imageDataUrl(icon, ICON_MAX_BYTES) ?? undefined;
  }

  /** A page on this computer or the SSH host: its title, and what serves it. */
  async function loadLocalPreview(fetch: Fetch, url: string, onSshHost: boolean) {
    const page = await fetch(url, PAGE_OPTIONS);
    if (!page) return null;
    const servedBy = serverNameFromHeaders(page.poweredBy, page.server);
    if (!isOk(page) || !isHtml(page)) {
      return compact({
        servedBy,
        isJson: isOk(page) && /[/+]json$/.test(page.contentType) ? true : undefined,
      });
    }
    const metadata = parsePageMetadata(page.body.toString('utf8'), page.url);
    return compact({
      title: metadata.title ?? metadata.documentTitle,
      siteName: metadata.siteName,
      description: metadata.description,
      // An image on the SSH host would have to be forwarded to load.
      imageUrl: onSshHost ? undefined : metadata.imageUrl,
      iconDataUrl: await readIcon(fetch, metadata.iconUrl, page.url),
      servedBy: metadata.framework ?? servedBy,
    });
  }

  /** The site's own name, icon and image, from its home page's Open Graph tags. */
  function loadSitePreview(fetch: Fetch, origin: string): Promise<LinkPreview | null> {
    return cached(
      previews,
      `site|${origin}`,
      MAX_CACHED,
      async () => {
        const page = await fetch(origin, PAGE_OPTIONS);
        const metadata =
          page && isOk(page) && isHtml(page)
            ? parsePageMetadata(page.body.toString('utf8'), page.url)
            : undefined;
        const iconDataUrl = await readIcon(fetch, metadata?.iconUrl, origin);
        if (!metadata?.siteName && !metadata?.title && !iconDataUrl) return null;
        return compact({
          siteName: metadata?.siteName ?? metadata?.title,
          description: metadata?.description,
          imageUrl: webImageUrl(metadata?.imageUrl),
          iconDataUrl,
          fromSite: true,
        });
      },
      (preview) => (preview ? WEB_TTL_MS : FAILED_TTL_MS)
    ).catch(() => null);
  }

  /**
   * A page elsewhere, by its own Open Graph tags. A page without them, or one that
   * needs you signed in, which shows an error or a sign-in page, is described by its
   * site's home page instead.
   */
  async function loadWebPreview(fetch: Fetch, url: string): Promise<LinkPreview | null> {
    const { origin, pathname, search } = new URL(url);
    const isHome = pathname === '/' && !search;
    // Loading a sign-in or one-time link can use it up before you click it.
    if (!isHome && !isSignInPageUrl(url) && !isOneTimeLinkUrl(url)) {
      const page = await fetch(url, PAGE_OPTIONS);
      if (page && isOk(page) && isHtml(page) && !isSignInPageUrl(page.url)) {
        const metadata = parsePageMetadata(page.body.toString('utf8'), page.url);
        if (metadata.title) {
          return compact({
            title: metadata.title,
            siteName: metadata.siteName,
            description: metadata.description,
            imageUrl: webImageUrl(metadata.imageUrl),
            iconDataUrl: await readIcon(fetch, metadata.iconUrl, page.url),
          });
        }
      }
    }
    return loadSitePreview(fetch, `${origin}/`);
  }

  async function loadPreview(request: LinkPreviewRequest): Promise<LinkPreview | null> {
    const local = request.onSshHost || isLocalPageUrl(request.url);
    const timeoutMs = local ? LOCAL_TIMEOUT_MS : WEB_TIMEOUT_MS;
    const fetch: Fetch = (url, options) =>
      limited(() =>
        request.onSshHost
          ? deps.fetchOnSshHost(request.workspaceId, url, { ...options, timeoutMs })
          : deps.fetchLocally(url, { ...options, timeoutMs, publicOnly: !local })
      );
    return local
      ? loadLocalPreview(fetch, localPageUrl(request.url), request.onSshHost)
      : loadWebPreview(fetch, request.url);
  }

  return {
    getPreview(request) {
      const local = request.onSshHost || isLocalPageUrl(request.url);
      const key = [
        request.onSshHost ? `ssh:${request.workspaceId}` : 'local',
        request.pid ?? '',
        local ? localPageUrl(request.url) : request.url,
      ].join('|');
      return cached(
        previews,
        key,
        MAX_CACHED,
        () => loadPreview(request).catch(() => null),
        (preview) => {
          if (!preview) return FAILED_TTL_MS;
          if (!local) return WEB_TTL_MS;
          return request.pid === undefined ? LOCAL_TTL_MS : LOCAL_PROCESS_TTL_MS;
        }
      );
    },

    getImage(url) {
      return cached(
        images,
        url,
        MAX_CACHED_IMAGES,
        async () =>
          imageDataUrl(
            await limited(() =>
              deps.fetchLocally(url, {
                accept: 'image/*',
                maxBytes: IMAGE_MAX_BYTES,
                timeoutMs: WEB_TIMEOUT_MS,
                publicOnly: !isLocalPageUrl(url),
              })
            ),
            IMAGE_MAX_BYTES
          ),
        (image) => (image ? WEB_TTL_MS : FAILED_TTL_MS)
      );
    },
  };
}
