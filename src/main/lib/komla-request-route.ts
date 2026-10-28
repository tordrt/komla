const MAX_TERMINAL_ID_LEN = 128;

export interface KomlaRequestRoute {
  url: URL;
  /** Path with any `/terminals/<id>` prefix removed. */
  route: string;
  terminalId?: string;
}

/**
 * Resolve a request target the way Komla's HTTP server routes it. Every route
 * also works under `/terminals/<id>`, which names the calling terminal. The
 * SSH host gateway uses the same parsing, so both sides agree on the route.
 */
export function resolveKomlaRequestRoute(rawUrl: string): KomlaRequestRoute | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    return null;
  }
  const match = /^\/terminals\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (!match) return { url, route: url.pathname };
  let terminalId: string;
  try {
    terminalId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!terminalId || terminalId.length > MAX_TERMINAL_ID_LEN) return null;
  return { url, route: match[2], terminalId };
}
