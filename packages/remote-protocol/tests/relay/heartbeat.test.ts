import { describe, it, expect } from 'vitest';

import { classifyRelayFrame, RELAY_PING_FRAME, RELAY_PONG_FRAME } from '../../src/relay/heartbeat';

describe('classifyRelayFrame', () => {
  it('recognises the exact relay:ping payload the worker emits', () => {
    expect(classifyRelayFrame('{"type":"relay:ping"}')).toBe('ping');
  });

  it('recognises the exact relay:pong payload', () => {
    expect(classifyRelayFrame('{"type":"relay:pong"}')).toBe('pong');
  });

  it('recognises a whitespace-padded variant via the JSON fallback', () => {
    expect(classifyRelayFrame('{ "type": "relay:ping" }')).toBe('ping');
    expect(classifyRelayFrame('{ "type": "relay:pong" }')).toBe('pong');
  });

  it('returns null for non-relay frames', () => {
    expect(classifyRelayFrame('{"type":"e2e:offer","ephemeralPubkey":"AAAA"}')).toBeNull();
    expect(
      classifyRelayFrame('{"type":"e2e:enc","seq":1,"nonce":"AA","ciphertext":"BB"}')
    ).toBeNull();
    expect(classifyRelayFrame('{"type":"desktop:challenge","nonce":"AA"}')).toBeNull();
  });

  it('rejects frames with the relay-heartbeat prefix and trailing garbage', () => {
    // Defense in depth: a `startsWith` fast path would silently classify these
    // as heartbeats and drop them. WebSocket frames are message-bounded so the
    // worker can't actually emit such a string today, but a lenient check
    // would mask malformed frames a future relay revision (or buggy peer)
    // might emit.
    expect(classifyRelayFrame('{"type":"relay:ping"}garbage')).toBeNull();
    expect(classifyRelayFrame('{"type":"relay:pong"}{"type":"e2e:offer"}')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(classifyRelayFrame('not json')).toBeNull();
    expect(classifyRelayFrame('')).toBeNull();
    expect(classifyRelayFrame('null')).toBeNull();
  });

  it('skips the JSON fallback for oversized inputs', () => {
    const big = 'x'.repeat(200);
    expect(classifyRelayFrame(big)).toBeNull();
  });
});

describe('RELAY_PONG_FRAME', () => {
  it('matches the wire format the worker accepts', () => {
    expect(RELAY_PONG_FRAME).toBe('{"type":"relay:pong"}');
    expect(JSON.parse(RELAY_PONG_FRAME)).toEqual({ type: 'relay:pong' });
  });
});

describe('RELAY_PING_FRAME', () => {
  it('is the exact ping the desktop classifies and answers', () => {
    expect(RELAY_PING_FRAME).toBe('{"type":"relay:ping"}');
    expect(classifyRelayFrame(RELAY_PING_FRAME)).toBe('ping');
  });
});
