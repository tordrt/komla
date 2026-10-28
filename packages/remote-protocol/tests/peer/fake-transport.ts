// In-memory pair of `PeerTransport`s — anything one side sends arrives on the
// other's `handleMessage` next microtask. No real WebSocket involved; lets
// integration tests drive both Peers in the same process without sockets,
// and unit tests inject a single fake to assert exactly what was sent.

import type { PeerTransport } from '../../src/peer/transport';

export interface FakeTransport extends PeerTransport {
  /** Frames this transport has sent, in order. */
  readonly sent: string[];
  /** Binary frames this transport has sent, in order. */
  readonly sentBinary: Uint8Array[];
  /** Hand a raw frame to the connected Peer's handleMessage. */
  deliver(raw: string): void;
  /** Close events the Peer asked to send. */
  readonly closed: Array<{ code?: number; reason?: string }>;
  /** Set by `connect()` so `send` automatically calls the partner's handler. */
  partner?: {
    handleMessage(raw: string): void;
    handleBinaryMessage?(bytes: Uint8Array): void;
    handleClose(evt: { code?: number; reason?: string }): void;
  };
  /** Drop further sends silently after the partner has closed. */
  isClosed: boolean;
}

export function createFakeTransport(): FakeTransport {
  const transport: FakeTransport = {
    sent: [],
    sentBinary: [],
    closed: [],
    isClosed: false,
    sendBinary(data) {
      if (this.isClosed) return;
      this.sentBinary.push(data);
      const partner = this.partner;
      if (partner) queueMicrotask(() => partner.handleBinaryMessage?.(data));
    },
    send(data) {
      if (this.isClosed) return;
      this.sent.push(data);
      const partner = this.partner;
      if (partner) {
        // Async delivery so the sender's "send → state mutation" flow
        // completes before the receiver runs. Mirrors a real socket where
        // the receive callback is queued, never synchronous.
        queueMicrotask(() => partner.handleMessage(data));
      }
    },
    close(code, reason) {
      if (this.isClosed) return;
      this.isClosed = true;
      this.closed.push({ code, reason });
      const partner = this.partner;
      if (partner) queueMicrotask(() => partner.handleClose({ code, reason }));
    },
    deliver(_raw) {
      // Used by unit tests that want to inject frames out-of-band; production
      // path goes through `partner` wiring below.
      throw new Error('attach a partner via createTransportPair() to deliver frames');
    },
  };
  return transport;
}

/**
 * Build two transports cross-wired so a `send` on one becomes a
 * `handleMessage` on the other's bound Peer. Caller binds Peers via
 * `bindPair(client, desktop)`.
 */
export function createTransportPair(): { a: FakeTransport; b: FakeTransport } {
  return { a: createFakeTransport(), b: createFakeTransport() };
}

export function bindPair(args: {
  aTransport: FakeTransport;
  bTransport: FakeTransport;
  a: {
    handleMessage(raw: string): void;
    handleBinaryMessage?(bytes: Uint8Array): void;
    handleClose(evt: { code?: number; reason?: string }): void;
  };
  b: {
    handleMessage(raw: string): void;
    handleBinaryMessage?(bytes: Uint8Array): void;
    handleClose(evt: { code?: number; reason?: string }): void;
  };
}): void {
  args.aTransport.partner = args.b;
  args.bTransport.partner = args.a;
}
