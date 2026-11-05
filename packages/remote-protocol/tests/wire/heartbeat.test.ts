import { describe, it, expect } from 'vitest';

import {
  classifyHeartbeatFrame,
  HEARTBEAT_PING_FRAME,
  HEARTBEAT_PONG_FRAME,
} from '../../src/wire/heartbeat';

describe('classifyHeartbeatFrame', () => {
  it('recognises the exact ping payload', () => {
    expect(classifyHeartbeatFrame('{"type":"ping"}')).toBe('ping');
  });

  it('recognises the exact pong payload', () => {
    expect(classifyHeartbeatFrame('{"type":"pong"}')).toBe('pong');
  });

  it('recognises a whitespace-padded variant via the JSON fallback', () => {
    expect(classifyHeartbeatFrame('{ "type": "ping" }')).toBe('ping');
    expect(classifyHeartbeatFrame('{ "type": "pong" }')).toBe('pong');
  });

  it('returns null for other frames', () => {
    expect(classifyHeartbeatFrame('{"type":"e2e:offer","ephemeralPubkey":"AAAA"}')).toBeNull();
    expect(
      classifyHeartbeatFrame('{"type":"e2e:enc","seq":1,"nonce":"AA","ciphertext":"BB"}')
    ).toBeNull();
    expect(classifyHeartbeatFrame('{"type":"desktop:challenge","nonce":"AA"}')).toBeNull();
  });

  it('rejects a heartbeat followed by trailing garbage', () => {
    // Defense in depth: a `startsWith` fast path would silently classify these
    // as heartbeats and drop them. WebSocket frames are message-bounded, but a
    // lenient check would mask malformed frames a buggy peer might emit.
    expect(classifyHeartbeatFrame('{"type":"ping"}garbage')).toBeNull();
    expect(classifyHeartbeatFrame('{"type":"pong"}{"type":"e2e:offer"}')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(classifyHeartbeatFrame('not json')).toBeNull();
    expect(classifyHeartbeatFrame('')).toBeNull();
    expect(classifyHeartbeatFrame('null')).toBeNull();
  });

  it('skips the JSON fallback for oversized inputs', () => {
    const big = 'x'.repeat(200);
    expect(classifyHeartbeatFrame(big)).toBeNull();
  });
});

describe('HEARTBEAT_PONG_FRAME', () => {
  it('matches the wire format the worker accepts', () => {
    expect(HEARTBEAT_PONG_FRAME).toBe('{"type":"pong"}');
    expect(JSON.parse(HEARTBEAT_PONG_FRAME)).toEqual({ type: 'pong' });
  });
});

describe('HEARTBEAT_PING_FRAME', () => {
  it('is the exact ping the desktop classifies and answers', () => {
    expect(HEARTBEAT_PING_FRAME).toBe('{"type":"ping"}');
    expect(classifyHeartbeatFrame(HEARTBEAT_PING_FRAME)).toBe('ping');
  });
});
