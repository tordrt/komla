const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const ALL_INTERFACES_HOSTS = new Set(['0.0.0.0', '[::]']);
const LOCALHOST_HOST = 'localhost';

export function normalizeLocalDevServerUrl(input: string): string {
  try {
    const url = new URL(input);
    if (!ALL_INTERFACES_HOSTS.has(url.hostname)) return input;

    url.hostname = LOCALHOST_HOST;
    return url.toString();
  } catch {
    return input;
  }
}

export function parseLoopbackUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return null;
  }

  return url;
}

export function isLoopbackUrl(input: string): boolean {
  return parseLoopbackUrl(input) !== null;
}
