/**
 * Fetches the start of a page for its preview, from this machine or an SSH
 * host. No cookies are sent, and reading stops at a byte limit.
 */

import { lookup as dnsLookup, type LookupAddress } from 'dns';
import { request as httpRequest, type IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { BlockList, isIP, type LookupFunction } from 'net';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';

import { isLocalPageUrl } from '../../../shared/lib/browser-tabs';
import { shellQuotePosix } from '../../../shared/lib/shell-quote';

import type { Readable } from 'stream';

export interface FetchedPage {
  /** The URL that answered, after redirects. */
  url: string;
  status: number;
  /** The media type alone, lowercased, as in `text/html`. */
  contentType: string;
  poweredBy?: string;
  server?: string;
  body: Buffer;
}

export interface FetchPageOptions {
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  /**
   * Stops reading once the body holds everything needed. Called with each chunk read,
   * after the last bytes of those before, as for a closing tag split between them.
   */
  isEnough?: (recent: Buffer) => boolean;
  /**
   * Refuses addresses on this computer and private networks, after redirects and DNS too,
   * so a page elsewhere can't have Komla request them.
   */
  publicOnly?: boolean;
}

export type FetchPage = (url: string, options: FetchPageOptions) => Promise<FetchedPage | null>;

const MAX_REDIRECTS = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; Komla link preview)';
// Bytes of the body before each chunk that isEnough sees again with it.
const ENOUGH_OVERLAP_BYTES = 64;

// Loopback, private, link-local, shared, benchmarking, multicast and reserved ranges.
const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address`, an IP address, is on the public internet. IPv4-mapped IPv6 counts as IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Resolves as usual, failing when any address the name has isn't public.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0);
    if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
      return callback(new Error(`${hostname} is not on the public internet`), '', 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

function decodedBody(response: IncomingMessage): Readable {
  switch (response.headers['content-encoding']) {
    case 'gzip':
      return response.pipe(createGunzip());
    case 'deflate':
      return response.pipe(createInflate());
    case 'br':
      return response.pipe(createBrotliDecompress());
    default:
      return response;
  }
}

type Answer = { redirect: string } | FetchedPage;

function requestOnce(url: URL, options: FetchPageOptions, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        headers: {
          Accept: options.accept,
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': USER_AGENT,
        },
        // Dev servers on this machine use self-signed certificates.
        rejectUnauthorized: !isLocalPageUrl(url.toString()),
        ...(options.publicOnly ? { lookup: publicLookup } : {}),
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          // A Location that isn't a URL throws here, outside the executor's reach.
          try {
            resolve({ redirect: new URL(location, url).toString() });
          } catch (error) {
            reject(error);
          }
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        let tail = Buffer.alloc(0);
        const body = decodedBody(response);
        const finish = (): void => {
          request.destroy();
          resolve({
            url: url.toString(),
            status,
            contentType: mediaType(response.headers['content-type']),
            poweredBy: response.headers['x-powered-by']?.toString(),
            server: response.headers.server?.toString(),
            body: Buffer.concat(chunks).subarray(0, options.maxBytes),
          });
        };
        body.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          length += chunk.length;
          const recent = Buffer.concat([tail, chunk]);
          tail = recent.subarray(-ENOUGH_OVERLAP_BYTES);
          if (length >= options.maxBytes || options.isEnough?.(recent)) {
            body.removeAllListeners('data');
            finish();
          }
        });
        body.once('end', finish);
        body.once('error', finish);
      }
    );
    request.once('error', reject);
    request.end();
  });
}

/** Fetches `url` from this machine, following redirects. Null when it can't be read. */
export const fetchPageLocally: FetchPage = async (url, options) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
      // An address in the URL is never looked up, so it's checked here.
      const address = current.hostname.replace(/^\[|\]$/g, '');
      if (options.publicOnly && isIP(address) !== 0 && !isPublicAddress(address)) return null;
      const answer = await requestOnce(current, options, controller.signal);
      if (!('redirect' in answer)) return answer;
      current = new URL(answer.redirect);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const HEADERS_SECTION = '@@komla-headers';
const BODY_SECTION = '@@komla-body';

/**
 * Fetches `url` with curl on an SSH host and prints the response headers and
 * the start of the body in base64. Prints nothing when curl is missing.
 */
export function buildRemoteFetchCommand(url: string, options: FetchPageOptions): string {
  const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  return [
    'command -v curl >/dev/null 2>&1 || exit 0',
    'headers=$(mktemp 2>/dev/null) || exit 0',
    `body=$(curl --noproxy '*' -sk -L --max-redirs ${MAX_REDIRECTS} -m ${seconds} -A ${shellQuotePosix(USER_AGENT)} -H ${shellQuotePosix(`Accept: ${options.accept}`)} -D "$headers" ${shellQuotePosix(url)} 2>/dev/null | head -c ${options.maxBytes} | base64 | tr -d '\\n')`,
    `printf '%s\\n' '${HEADERS_SECTION}'`,
    'cat "$headers"',
    `printf '\\n%s\\n%s\\n' '${BODY_SECTION}' "$body"`,
    'rm -f "$headers"',
  ].join('\n');
}

/** Reads the output of `buildRemoteFetchCommand`; null when curl answered nothing. */
export function parseRemoteFetch(output: string, url: string): FetchedPage | null {
  const headersStart = output.indexOf(`${HEADERS_SECTION}\n`);
  const bodyStart = output.indexOf(`\n${BODY_SECTION}\n`);
  if (headersStart === -1 || bodyStart === -1) return null;
  const headerText = output.slice(headersStart + HEADERS_SECTION.length + 1, bodyStart);
  const body = Buffer.from(output.slice(bodyStart + BODY_SECTION.length + 2).trim(), 'base64');

  // curl writes the headers of each response it follows; the last one answered.
  let current = url;
  let response: { status: number; headers: Map<string, string> } | null = null;
  for (const line of headerText.split(/\r?\n/)) {
    const statusLine = /^HTTP\/\S+\s+(\d{3})/.exec(line);
    if (statusLine) {
      const location = response?.headers.get('location');
      if (response && location) current = new URL(location, current).toString();
      response = { status: Number(statusLine[1]), headers: new Map() };
      continue;
    }
    const separator = line.indexOf(':');
    if (response && separator > 0) {
      response.headers.set(
        line.slice(0, separator).trim().toLowerCase(),
        line.slice(separator + 1).trim()
      );
    }
  }
  if (!response) return null;
  return {
    url: current,
    status: response.status,
    contentType: mediaType(response.headers.get('content-type')),
    poweredBy: response.headers.get('x-powered-by'),
    server: response.headers.get('server'),
    body,
  };
}
