/**
 * Host markers in PTY output: Komla's OSC 7337 `host=` sequences, which tell
 * the pane header which host the shell is on.
 */

/**
 * OSC sequence Komla emits when a terminal enters another host, such as an SSH
 * host's terminal pool:
 *   ESC ] 7337 ; host = <hostname> BEL
 *
 * OSC 7337 is unassigned (1337 is iTerm2's). xterm.js ignores unknown OSC
 * commands, but we still strip it from the stream in main before dispatch so
 * the renderer-visible output buffer stays clean.
 */
// oxlint-disable-next-line no-control-regex
export const HOST_OSC_REGEX = /\x1b\]7337;host=([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * Strip host-hostname OSC markers from a chunk of PTY output. Returns the
 * last-seen hostname (null if the chunk had none) and the chunk with our OSC
 * sequences removed so they never reach xterm.js.
 */
export function extractHostOsc(data: string): { hostname: string | null; cleaned: string } {
  let lastHost: string | null = null;
  const cleaned = data.replace(HOST_OSC_REGEX, (_match, host: string) => {
    lastHost = host.trim();
    return '';
  });
  return { hostname: lastHost, cleaned };
}

// Cap on how much trailing OSC-prefix we'll hold between chunks. An OSC 7337
// payload is at most ~30 bytes, so a few KB is more than enough headroom while
// preventing an unterminated OSC from growing the carry buffer unbounded.
const MAX_OSC_CARRY_BYTES = 4096;

/**
 * PTY output is not message-framed — a single `printf '\x1b]7337;host=…\x07'`
 * can be delivered across two `onData` callbacks. Split the chunk into
 * a `ready` portion (safe to pass downstream now) and a `carry` portion (an
 * unterminated trailing OSC prefix, to be prepended to the next chunk).
 *
 * We look at the rightmost `\x1b]`; if no OSC terminator (`\x07` or ST `\x1b\\`)
 * appears after it, that tail is an incomplete OSC and we hold it. This
 * catches not just OSC 7337 but any OSC that straddles a chunk boundary — safe
 * because xterm.js buffers them internally anyway, and briefly deferring the
 * tail until the terminator arrives preserves ordering.
 *
 * If the carry would exceed `MAX_OSC_CARRY_BYTES`, we flush it into `ready`
 * rather than grow the buffer. At that point we've either hit a malicious
 * stream or the sender forgot to terminate the OSC — either way, stop hoarding.
 */
export function splitPendingOsc(data: string): { ready: string; carry: string } {
  const trailingEsc = data.endsWith('\x1b');
  const completePrefix = trailingEsc ? data.slice(0, -1) : data;
  const lastEsc = data.lastIndexOf('\x1b]');
  if (lastEsc === -1) {
    return trailingEsc ? { ready: completePrefix, carry: '\x1b' } : { ready: data, carry: '' };
  }

  // Terminator after the last OSC start? Then every OSC is complete.
  const bel = data.indexOf('\x07', lastEsc);
  if (bel !== -1) {
    return trailingEsc ? { ready: completePrefix, carry: '\x1b' } : { ready: data, carry: '' };
  }
  for (let i = lastEsc + 2; i < data.length - 1; i++) {
    if (data.charCodeAt(i) === 0x1b && data.charCodeAt(i + 1) === 0x5c) {
      return trailingEsc ? { ready: completePrefix, carry: '\x1b' } : { ready: data, carry: '' };
    }
  }

  const carry = data.slice(lastEsc);
  if (carry.length > MAX_OSC_CARRY_BYTES) {
    return { ready: data, carry: '' };
  }
  return { ready: data.slice(0, lastEsc), carry };
}

/** Whether a host marker names this machine; SSH terminal pools report `ssh:<hostId>`. */
export function isLocalHost(hostname: string): boolean {
  return !hostname.startsWith('ssh:');
}
