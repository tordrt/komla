// Helpers for the `relay:ping` / `relay:pong` liveness heartbeat on the remote
// control socket. The names predate the Tailscale-only transport and stay for
// wire compatibility:
//
//     desktop → client:  {"type":"relay:ping"}    // after a quiet period
//     client → desktop:  {"type":"relay:pong"}    // client's ack
//
// These envelopes interleave with `e2e:*` frames but are NOT part of the
// Peer's parser — feed a `relay:ping` to a `Peer` and it fails closed as
// "unexpected frame." Run every inbound text frame through `classifyRelayFrame`
// first; pass `null` results through to the Peer.
//
// Heartbeats are always sent as the exact two strings below. The fast
// path is exact equality so a frame like `{"type":"relay:ping"}<garbage>`
// is NOT silently classified as a heartbeat — that would swallow a
// malformed frame the active FSM should fail closed on. A whitespace-
// tolerant variant (e.g. `{ "type": "relay:ping" }`) is recovered via the
// JSON-parse fallback below.

const PING_FAST = '{"type":"relay:ping"}';
const PONG_FAST = '{"type":"relay:pong"}';

/** Pre-serialized `relay:pong` payload — the only response a peer ever needs to send for the heartbeat. */
export const RELAY_PONG_FRAME = PONG_FAST;

/** Pre-serialized `relay:ping` payload, which a client sends to probe a link that has gone quiet. */
export const RELAY_PING_FRAME = PING_FAST;

/** Type of a relay heartbeat frame, or `null` if the input is something else (admission/e2e/garbage). */
export type RelayFrameKind = 'ping' | 'pong' | null;

export function classifyRelayFrame(raw: string): RelayFrameKind {
  if (raw === PING_FAST) return 'ping';
  if (raw === PONG_FAST) return 'pong';
  // Tolerant fallback. Heartbeat frames are tiny — anything substantially
  // larger is unambiguously not a heartbeat, so we cap the parse cost.
  if (raw.length > 64) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const t = (parsed as { type?: unknown }).type;
  if (t === 'relay:ping') return 'ping';
  if (t === 'relay:pong') return 'pong';
  return null;
}
