// Minimal WebSocket-like interface the Peer needs from a transport.
//
// We don't depend on the runtime's `WebSocket` type directly because:
//
//   - browser `WebSocket` exposes events via `addEventListener`/properties
//   - Node `ws` exposes events via `on('message', ...)`
//   - Cloudflare Workers' `WebSocket` is similar to browser
//   - React Native's `WebSocket` is a third dialect
//
// All four can be wrapped trivially by the caller into a `PeerTransport`,
// keeping this package free of any runtime-specific WebSocket import.

export interface PeerTransport {
  /** Send a UTF-8 text frame. */
  send(data: string): void;
  /** Send a binary frame; needed once binary frames are enabled. */
  sendBinary?(data: Uint8Array): void;
  /** Close the underlying socket with an application-defined code/reason. */
  close(code?: number, reason?: string): void;
  /** Bytes accepted by `send` that the network hasn't taken yet, if the transport can tell. */
  bufferedAmount?(): number;
}
