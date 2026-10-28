# AGENTS.md

## Project Model

This workspace (`komla-remote-web`) builds the browser client for Komla remote control. The desktop serves the built bundle and its WebSocket endpoint from a localhost-only server, and phones reach it through Tailscale Serve. Remote control is Tailscale-only by design: Komla runs no hosted relay in the path of a remote shell.

The desktop is the authority for enrollment, authentication, workspaces, and terminal control. Terminal input is local-user shell access, so every change here, in `../packages/remote-protocol/`, or in the desktop's `remote-control-*` services moves a security boundary: read [`../docs/REMOTE_CONTROL_SECURITY.md`](../docs/REMOTE_CONTROL_SECURITY.md) first and keep each of its security invariants true.

## Boundaries

- **Shared primitives:** the encrypted Peer handshake, transcript binding, device identity, and frame schemas belong in `../packages/remote-protocol/`; desktop and browser both import it. Keep it WebCrypto-only so it runs unchanged in both.
- **Desktop identity:** `../src/main/services/install-identity.service.ts` owns the desktop's install key and fingerprint lifecycle.

## Commands

Run commands from `remote-web/`; use `npm run` as the authoritative script list. Before finishing a change, run `npm test` and `npm run typecheck`.
