# Komla remote web client

This workspace builds the browser application served by Komla's local remote-control server.

The desktop binds the HTTP/WebSocket server to localhost. For phone access, Tailscale Serve terminates HTTPS and forwards traffic directly to that local server. The browser bundle is emitted to `public/` and packaged with Komla.

## Commands

```bash
npm run build:web
npm run test:web
npm run typecheck
```

## Trust model

The transport path is direct: browser → Tailscale HTTPS → Komla desktop. Enrollment and reconnect still run inside Komla's authenticated encrypted Peer channel.

A trusted browser is represented by two independent credentials:

- a non-exportable P-256 installation key stored in IndexedDB;
- a user-verified WebAuthn passkey.

Enrollment additionally requires the one-time 256-bit secret embedded in the QR URL fragment. Reconnect requires proof from both stored credentials, bound to the current encrypted-channel transcript. See [the security design](../docs/REMOTE_CONTROL_SECURITY.md).
