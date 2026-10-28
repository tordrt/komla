import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { readFile, realpath, stat } from 'fs/promises';
import { extname, posix, relative, resolve, sep } from 'path';
import { Readable } from 'stream';
import { pathToFileURL } from 'url';

import { protocol } from 'electron';

import { assertSafeRelativePath } from '../ipc/validation/path-safety';
import { bundledFontPath } from '../lib/bundled-fonts';
import { createLogger } from '../lib/logger';
import { isWithinRoot } from '../lib/same-path';

import type { NonSharedBuffer } from 'buffer';
import type { WebContents } from 'electron';

const logger = createLogger('HtmlPreviewService');
const SCHEME = 'komla-preview';
const SESSION_TTL_MS = 60 * 60 * 1000;
/** Where a content preview that may load Komla's fonts finds them, as in `/__komla/fonts/geist.woff2`. */
const FONTS_PATH = '__komla/fonts/';

interface PreviewSessionBase {
  entryPath: string;
  createdAt: number;
  /** The page can load from https: sites, such as scripts from a CDN. */
  web: boolean;
}

interface LocalPreviewSession extends PreviewSessionBase {
  kind: 'local';
  rootPath: string;
  realRootPath: string;
}

interface ContentPreviewSession extends PreviewSessionBase {
  kind: 'content';
  content: string | NonSharedBuffer;
  /** The page can load Komla's bundled fonts. */
  fonts: boolean;
}

type PreviewSession = LocalPreviewSession | ContentPreviewSession;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function getMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function normalizeUrlPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname.replace(/^\/+/, '')).replace(/\\/g, '/');
  const normalized = posix.normalize(decoded);
  return normalized === '.' ? '' : normalized;
}

// Reject any segment starting with `.` — keeps `.git`, `.env*`, `.ssh`, and
// other commonly-sensitive dotfiles out of the preview surface. Previews
// legitimately serving dot-prefixed paths can rename them.
function containsDotfileSegment(relativePath: string): boolean {
  if (!relativePath) return false;
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

function getEntryDirectory(entryPath: string): string {
  const directory = posix.dirname(entryPath);
  return directory === '.' ? '' : directory;
}

// Return scheme + host for the navigation log without path/query/hash/userinfo.
// Blocked exfil URLs encode their payload in the query string, so logging the
// full URL would write the secret to disk and defeat the guard.
function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname ? `${parsed.protocol}//${parsed.hostname}` : parsed.protocol;
  } catch {
    return '<unparseable>';
  }
}

function makeHeaders(filePath: string, web: boolean): Headers {
  // The iframe sandbox (no allow-same-origin) gives the previewed document a
  // unique opaque origin, so it can't reach Komla. A page can read what its
  // session serves, so the CSP decides where it can send that: nowhere, or
  // with `web` to https: sites, so a page can use a CDN. Never http: or ws:,
  // which would reach Komla's own API and dev servers on this computer.
  const https = web ? ' https:' : '';
  return new Headers({
    'Content-Type': getMimeType(filePath),
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval'${https}`,
      `style-src 'self' 'unsafe-inline'${https}`,
      `img-src 'self' data: blob:${https}`,
      `font-src 'self' data:${https}`,
      `connect-src 'self'${web ? ' https: wss:' : ''}`,
      `media-src 'self' data: blob:${https}`,
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

function parseByteRange(
  rangeHeader: string,
  fileSize: number
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || fileSize === 0) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : fileSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= fileSize ||
    requestedEnd < start
  ) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, fileSize - 1) };
}

class HtmlPreviewService {
  private sessions = new Map<string, PreviewSession>();
  /** The pages made with each key: the one before the latest, then the latest. */
  private keyedTokens = new Map<string, string[]>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;

  registerProtocolHandler(): void {
    if (this.registered) return;
    this.registered = true;

    protocol.handle(SCHEME, async (request) => {
      try {
        return await this.handleRequest(request);
      } catch (err) {
        logger.warn('Failed to serve HTML preview asset', { error: String(err) });
        return new Response('Not found', { status: 404 });
      }
    });
  }

  // The iframe sandbox blocks top-level navigation and popups, and the CSP
  // blocks fetch/img/form egress — but neither blocks same-frame navigation
  // (`window.location = 'https://evil…'`). Without this guard, an
  // agent-generated preview could read workspace files via same-origin fetch
  // and exfil their contents by navigating the frame to an external URL.
  // Enforced at the Electron layer so the sandbox+CSP design holds end-to-end.
  attachNavigationGuard(webContents: WebContents): void {
    webContents.on('will-frame-navigate', (event) => {
      const fromUrl = event.frame?.url ?? '';
      if (!fromUrl.startsWith(`${SCHEME}://`)) return;
      if (event.url.startsWith(`${SCHEME}://`)) return;
      event.preventDefault();
      // Sanitize the logged destination: blocked exfil URLs may carry the
      // leaked data in their query string (e.g. `?d=<secret>`), so writing
      // `event.url` verbatim would defeat the guard via the log file. Source
      // URL contains the live preview token, so omit it entirely.
      logger.warn('Blocked navigation away from HTML preview frame', {
        toOrigin: sanitizeUrlForLog(event.url),
      });
    });
  }

  async createPreviewUrl(rootPath: string, entryPath: string): Promise<string> {
    assertSafeRelativePath(rootPath, entryPath, 'entryPath');
    const resolvedRoot = resolve(rootPath);
    const resolvedEntry = resolve(resolvedRoot, entryPath);
    const normalizedEntry = normalizeUrlPath(
      relative(resolvedRoot, resolvedEntry).split(sep).join('/')
    );
    if (containsDotfileSegment(normalizedEntry)) {
      throw new Error('entryPath references a hidden file');
    }
    const realRoot = await realpath(resolvedRoot);
    const token = randomUUID();
    this.sessions.set(token, {
      kind: 'local',
      rootPath: resolvedRoot,
      realRootPath: realRoot,
      entryPath: normalizedEntry,
      createdAt: Date.now(),
      web: true,
    });
    this.pruneOldSessions();
    this.scheduleSessionExpiry();
    return `${SCHEME}://${token}/${normalizedEntry.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * Serves content as a page. A `key` keeps only the latest two pages made with it, so a page
   * shown again and again, such as a status bar popover, keeps the one on screen while the next
   * loads; `fonts` lets it load Komla's bundled fonts, and `web` lets it load from https: sites.
   */
  async createContentPreviewUrl(
    entryPath: string,
    content: string | NonSharedBuffer,
    options: { key?: string; fonts?: boolean; web?: boolean } = {}
  ): Promise<string> {
    assertSafeRelativePath('/workspace', entryPath, 'entryPath');
    const normalizedEntry = normalizeUrlPath(entryPath);
    const extension = extname(normalizedEntry).toLowerCase();
    if (!['.html', '.htm', '.svg', '.pdf'].includes(extension)) {
      throw new Error('Content previews require an HTML, SVG or PDF entry path');
    }

    const token = randomUUID();
    if (options.key !== undefined) {
      // The page before stays, as it may still be on screen while this one loads.
      const tokens = this.keyedTokens.get(options.key) ?? [];
      for (const replaced of tokens.slice(0, -1)) this.sessions.delete(replaced);
      this.keyedTokens.set(options.key, [...tokens.slice(-1), token]);
    }
    this.sessions.set(token, {
      kind: 'content',
      content,
      entryPath: normalizedEntry,
      createdAt: Date.now(),
      fonts: options.fonts === true,
      web: options.web === true,
    });
    this.pruneOldSessions();
    this.scheduleSessionExpiry();
    return `${SCHEME}://${token}/${normalizedEntry.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.hostname;
    const session = this.sessions.get(token);
    if (!session) return new Response('Not found', { status: 404 });
    if (Date.now() - session.createdAt >= SESSION_TTL_MS) {
      this.sessions.delete(token);
      this.scheduleSessionExpiry();
      return new Response('Not found', { status: 404 });
    }

    let relativePath = normalizeUrlPath(url.pathname);
    if (!relativePath) {
      relativePath = session.entryPath;
    }

    if (session.kind === 'content') {
      if (session.fonts && relativePath.startsWith(FONTS_PATH)) {
        return this.createFontResponse(relativePath.slice(FONTS_PATH.length));
      }
      const accept = request.headers.get('accept') ?? '';
      if (relativePath !== session.entryPath && !accept.includes('text/html')) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(contentForRequest(request, session.content), {
        headers: makeHeaders(session.entryPath, session.web),
      });
    }

    const fullPath = await this.resolvePreviewPath(session, relativePath, request);
    if (extname(fullPath).toLowerCase() === '.pdf') {
      return this.createPdfResponse(fullPath, request);
    }
    const data = await readFile(fullPath);
    return new Response(data, { headers: makeHeaders(fullPath, session.web) });
  }

  // The page's sandbox gives it an opaque origin, so fonts load from it cross-origin.
  private async createFontResponse(name: string): Promise<Response> {
    const fontPath = bundledFontPath(name);
    if (!fontPath) return new Response('Not found', { status: 404 });
    const headers = makeHeaders(fontPath, false);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'max-age=3600');
    return new Response(await readFile(fontPath), { headers });
  }

  private async createPdfResponse(fullPath: string, request: Request): Promise<Response> {
    const { size } = await stat(fullPath);
    const headers = makeHeaders(fullPath, false);
    headers.set('Accept-Ranges', 'bytes');

    const rangeHeader = request.headers.get('range');
    const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
    if (rangeHeader && !range) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(size - 1, 0);
    const contentLength = size === 0 ? 0 : end - start + 1;
    headers.set('Content-Length', String(contentLength));
    if (range) {
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }

    if (request.method === 'HEAD' || size === 0) {
      return new Response(null, { status: range ? 206 : 200, headers });
    }

    const stream = Readable.toWeb(createReadStream(fullPath, { start, end }));
    return new Response(stream as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  }

  private async resolvePreviewPath(
    session: LocalPreviewSession,
    relativePath: string,
    request: Request
  ): Promise<string> {
    const target = await this.resolveAssetPath(session, relativePath);
    if (target) return target;

    const entryRelativeTarget = await this.resolveEntryRelativeAssetPath(session, relativePath);
    if (entryRelativeTarget) return entryRelativeTarget;

    // SPA fallback: when a client-side route is requested directly (e.g. the
    // user reloads `/about`), return the entry HTML so the framework router
    // can hydrate. Only do this for navigation requests so missing CSS/JS
    // still 404 instead of returning HTML.
    const accept = request.headers.get('accept') ?? '';
    if (accept.includes('text/html')) {
      const entry = await this.resolveAssetPath(session, session.entryPath);
      if (entry) return entry;
    }

    throw new Error(
      `Preview asset not found: ${pathToFileURL(resolve(session.rootPath, relativePath)).toString()}`
    );
  }

  // Lexical containment + realpath containment + dotfile block. Returns the
  // canonical filesystem path for files only; returns null for missing paths
  // (handled by the SPA fallback above).
  private async resolveAssetPath(
    session: LocalPreviewSession,
    relativePath: string
  ): Promise<string | null> {
    assertSafeRelativePath(session.rootPath, relativePath, 'previewPath');
    if (containsDotfileSegment(relativePath)) {
      throw new Error('previewPath references a hidden file');
    }
    const candidate = resolve(session.rootPath, relativePath);

    let stats;
    try {
      stats = await stat(candidate);
    } catch {
      return null;
    }

    let finalPath = candidate;
    if (stats.isDirectory()) {
      const indexPath = posix.join(relativePath, 'index.html');
      assertSafeRelativePath(session.rootPath, indexPath, 'previewPath');
      finalPath = resolve(session.rootPath, indexPath);
      try {
        const indexStats = await stat(finalPath);
        if (!indexStats.isFile()) return null;
      } catch {
        return null;
      }
    } else if (!stats.isFile()) {
      return null;
    }

    // realpath catches symlinks pointing outside the root (e.g. a checked-in
    // `creds -> /Users/you/.ssh/id_rsa`). The lexical check above can't see
    // through symlinks, so this is the boundary that actually keeps reads
    // inside the worktree.
    const realCandidate = await realpath(finalPath);
    if (!isWithinRoot(session.realRootPath, realCandidate)) {
      throw new Error('previewPath resolves outside the allowed root');
    }
    // Recheck the dotfile rule against the canonical path. The earlier check
    // only saw the requested path string, so an in-root symlink like
    // `git-config -> .git/config` would pass containment while exposing a
    // hidden file.
    const canonicalRelative = relative(session.realRootPath, realCandidate).split(sep).join('/');
    if (containsDotfileSegment(canonicalRelative)) {
      throw new Error('previewPath resolves to a hidden file');
    }
    return realCandidate;
  }

  private async resolveEntryRelativeAssetPath(
    session: LocalPreviewSession,
    relativePath: string
  ): Promise<string | null> {
    const entryDirectory = getEntryDirectory(session.entryPath);
    if (!entryDirectory) return null;
    if (relativePath === session.entryPath || relativePath.startsWith(`${entryDirectory}/`)) {
      return null;
    }
    return this.resolveAssetPath(session, posix.join(entryDirectory, relativePath));
  }

  private pruneOldSessions(): void {
    const now = Date.now();
    for (const [token, session] of Array.from(this.sessions.entries())) {
      if (now - session.createdAt >= SESSION_TTL_MS) {
        this.sessions.delete(token);
      }
    }
    for (const [key, tokens] of Array.from(this.keyedTokens.entries())) {
      const live = tokens.filter((token) => this.sessions.has(token));
      if (live.length === 0) this.keyedTokens.delete(key);
      else this.keyedTokens.set(key, live);
    }
  }

  private scheduleSessionExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.sessions.size === 0) return;

    const nextExpiry = Math.min(
      ...Array.from(this.sessions.values(), (session) => session.createdAt + SESSION_TTL_MS)
    );
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null;
        this.pruneOldSessions();
        this.scheduleSessionExpiry();
      },
      Math.max(0, nextExpiry - Date.now())
    );
    this.expiryTimer.unref?.();
  }
}

function contentForRequest(
  request: Request,
  content: string | NonSharedBuffer
): string | NonSharedBuffer | null {
  return request.method === 'HEAD' ? null : content;
}

export { HtmlPreviewService };
export const htmlPreviewService = new HtmlPreviewService();
export const HTML_PREVIEW_PROTOCOL_SCHEME = SCHEME;
