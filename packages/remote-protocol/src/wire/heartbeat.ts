// Helpers for the `ping` / `pong` liveness heartbeat on the remote control
// socket:
//
//     either side:  {"type":"ping"}    // after a quiet period
//     the other:    {"type":"pong"}    // its ack
//
// These envelopes interleave with `e2e:*` frames but are NOT part of the
// Peer's parser — feed a `ping` to a `Peer` and it fails closed as
// "unexpected frame." Run every inbound text frame through `classifyHeartbeatFrame`
// first; pass `null` results through to the Peer.
//
// Heartbeats are always sent as the exact two strings below. The fast
// path is exact equality so a frame like `{"type":"ping"}<garbage>`
// is NOT silently classified as a heartbeat — that would swallow a
// malformed frame the active FSM should fail closed on. A whitespace-
// tolerant variant (e.g. `{ "type": "ping" }`) is recovered via the
// JSON-parse fallback below.

const PING_FAST = '{"type":"ping"}';
const PONG_FAST = '{"type":"pong"}';

/** Pre-serialized `pong` payload, the only response a peer ever needs to send for the heartbeat. */
export const HEARTBEAT_PONG_FRAME = PONG_FAST;

/** Pre-serialized `ping` payload, which either side sends to probe a link that has gone quiet. */
export const HEARTBEAT_PING_FRAME = PING_FAST;

/** Type of a heartbeat frame, or `null` if the input is something else (admission/e2e/garbage). */
export type HeartbeatFrameKind = 'ping' | 'pong' | null;

export function classifyHeartbeatFrame(raw: string): HeartbeatFrameKind {
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
  if (t === 'ping') return 'ping';
  if (t === 'pong') return 'pong';
  return null;
}
