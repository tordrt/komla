import { isIP } from 'net';

// Names that always mean this machine, as seen from a local terminal.
const LOCAL_HOSTNAMES = new Set(['localhost']);

/**
 * Whether a request's Host header names this machine. A web page that points
 * its own domain at 127.0.0.1 (DNS rebinding) reaches Komla's port with that
 * domain as its Host, so only IP addresses and names that always mean this
 * machine pass. Ports are not compared: SSH tunnels arrive through other
 * ports. Browsers always send Host, so a request without one is not
 * from a web page.
 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (host === undefined || host === '') return true;
  // Only host[:port]; anything else would let URL parsing pick another host.
  if (/[@/\\?#\s]/.test(host)) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const address = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(address) !== 0) return true;
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}
