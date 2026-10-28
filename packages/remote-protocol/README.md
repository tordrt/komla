# @komla/remote-protocol

Pure-TypeScript SDK for the end-to-end encrypted channel between the Komla
desktop and a paired client (initially a web browser, later a React Native /
Expo app). The desktop serves the socket on localhost and phones reach it
through Tailscale Serve; anything in between forwards bytes and cannot read
encrypted payloads.

This package is shared between three runtimes:

| Runtime              | WebCrypto source           | Notes                                       |
| -------------------- | -------------------------- | ------------------------------------------- |
| Browser              | `globalThis.crypto.subtle` | Native; no polyfill needed.                 |
| Electron main / Node | `globalThis.crypto.subtle` | Native since Node 16; standard on Node 20+. |
| React Native / Expo  | polyfill (see below)       | RN does not ship WebCrypto.                 |

The package itself is **WebCrypto-only** for the cryptographic surface: no
Node `crypto`, no DOM globals, no React-or-Electron-specific imports. It
additionally relies on a small set of WindowOrWorkerGlobalScope helpers for
transport-format housekeeping — `atob`, `btoa`, `TextEncoder`, `TextDecoder`
— all four of which are universal in the two primary targets (browser and
Node 16+). Only React Native needs polyfilling; see
below. It's safe to import from any runtime that exposes
`globalThis.crypto.subtle` plus those four globals — including the same
module instance used for two simultaneous sessions in one process.

## Public API

```ts
import {
  // Identity
  fingerprintFromPublicKey, // SHA-256(SPKI-DER) → lowercase hex
  isValidFingerprint, // shape check
  FINGERPRINT_HEX_LENGTH, // = 64

  // Crypto primitives (composable; the Peer uses these internally)
  verifySignature, // ECDSA-P256 / SHA-256 / IEEE-P1363
  generateEphemeralKeyPair, // ECDH-P256, non-extractable private
  importPeerPublicKey, // SPKI-DER → CryptoKey
  deriveSessionKey, // ECDH + HKDF-SHA256 → AES-GCM-256
  encrypt,
  decrypt, // AES-GCM-256 with directional nonce
  buildNonce, // 12-byte: [dir | seq BE | random(7)]

  // Wire
  parseFrame, // discriminated-union parser (zod)
  encodeBase64,
  decodeBase64, // RFC 4648 §4 (standard alphabet, padded)
  PEER_CLOSE, // 4400/4401/4408/4500 close codes

  // Peer (the FSM that drives a full session)
  Peer,
} from '@komla/remote-protocol';
```

## Using `Peer`

`Peer` owns one side of an end-to-end encrypted session. Construct it with the
runtime's WebSocket adapted to the tiny `PeerTransport` interface, register
listeners, call `connect()`, and forward the underlying socket events into
`handleMessage` / `handleClose` / `handleError`.

The handshake is asymmetric — the desktop signs both ephemeral pubkeys with
its long-term install key; the client verifies the signature against the
install pubkey it derived from the URL fingerprint. After the handshake both
sides exchange AES-GCM frames with strict-monotonic per-direction sequence
counters.

### Browser client example

```ts
import { Peer } from '@komla/remote-protocol';

const fingerprint = new URLSearchParams(location.hash.slice(1)).get('fp')!;
const ws = new WebSocket(`wss://${location.host}/remote/ws?fp=${fingerprint}`);

const peer = new Peer({
  role: 'client',
  expectedFingerprint: fingerprint,
  transport: {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  },
});

ws.addEventListener('message', (e) => peer.handleMessage(String(e.data)));
ws.addEventListener('close', (e) => peer.handleClose({ code: e.code, reason: e.reason }));
ws.addEventListener('error', () => peer.handleError(new Error('socket error')));

peer.onMessage((m) => {
  if (m.kind === 'json') console.log('got json', m.data);
  else console.log('got binary', m.data.byteLength, 'bytes');
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await peer.connect();
await peer.sendEncryptedJson({ ping: 1 });
```

### Desktop side example

```ts
import { Peer } from '@komla/remote-protocol';
import { installIdentityService } from '../services/install-identity.service';

const installPubkey = await installIdentityService.getPublicKey();
const peer = new Peer({
  role: 'desktop',
  installPubkey: new Uint8Array(installPubkey),
  sign: (data) => installIdentityService.sign(Buffer.from(data)).then((b) => new Uint8Array(b)),
  transport: { send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) },
});
// ...wire up ws events identically and call peer.connect()
```

## React Native / Expo polyfills

React Native does not ship the full WindowOrWorkerGlobalScope surface this
package depends on. An RN host must populate four globals before the first
import of `@komla/remote-protocol`:

- `globalThis.crypto.subtle` — pick one of:
  - [`react-native-quick-crypto`](https://github.com/margelo/react-native-quick-crypto) — native module, fast, full WebCrypto.
  - [`expo-crypto`](https://docs.expo.dev/versions/latest/sdk/crypto/) — Expo-managed; pair with a `subtle` shim if needed.
  - [`@peculiar/webcrypto`](https://github.com/PeculiarVentures/webcrypto) — pure JS, slower, but zero native deps.
- `atob` / `btoa` — RN does not ship these. Use any small base64 polyfill
  (e.g. [`react-native-quick-base64`](https://github.com/craftzdog/react-native-quick-base64), or a pure-JS one).
- `TextEncoder` / `TextDecoder` — recent RN versions (0.70+ with Hermes)
  ship these natively. On older RN, polyfill via
  [`text-encoding`](https://github.com/inexorabletash/text-encoding) or
  similar.

The package never imports a polyfill itself — it expects the host to wire
them up.

A future iteration may replace the `atob`/`btoa` calls with an internal
Uint8Array codec to drop that dependency entirely; that's why the package
itself doesn't ship a base64 polyfill.

## Wire format

Three message envelopes travel between the two peers:

```jsonc
// 1. Client → desktop (initiator's ephemeral)
{ "type": "e2e:offer",  "ephemeralPubkey": "<base64 SPKI-DER>" }

// 2. Desktop → client (responder's ephemeral + install pubkey + signature)
{
  "type": "e2e:answer",
  "ephemeralPubkey": "<base64 SPKI-DER>",
  "installPubkey":   "<base64 SPKI-DER>",
  "signature":       "<base64 IEEE-P1363>"   // ECDSA-P256/SHA-256
                                             // over `clientEphemSPKI ‖ desktopEphemSPKI`
}

// 3. Either direction (after handshake)
{
  "type": "e2e:enc",
  "seq":   <uint32>,            // strict-monotonic per direction, from 0
  "nonce": "<base64 12 bytes>", // [dir(1) | seq BE | random(7)]
  "ciphertext": "<base64 AES-GCM (plaintext + 16-byte tag)>"
}
```

All binary fields are **standard** base64 (RFC 4648 §4) — `+`/`/` alphabet,
padding required. **Not** base64url. P-256 SPKI-DER is a fixed 91 bytes, so
the `clientEphemSPKI ‖ desktopEphemSPKI` concatenation that the desktop signs
is unambiguous without length prefixes.

A transport intermediary such as Tailscale Serve sees `e2e:offer` and
`e2e:answer` in the clear; encrypted frames are opaque to it.

## Close codes

Application-defined WebSocket close codes (RFC 6455 §7.4 reserves 4000–4999).
Reasons are short machine-readable strings — clients should branch on them,
not parse prose.

| Code | Reason                     | When                                                               |
| ---- | -------------------------- | ------------------------------------------------------------------ |
| 4400 | `bad-request`              | Malformed/oversized frame, illegal FSM transition.                 |
| 4400 | `seq-violation`            | Inbound `e2e:enc` seq did not strictly advance.                    |
| 4400 | `nonce-direction-mismatch` | Inbound nonce's direction byte was not the expected incoming side. |
| 4400 | `nonce-seq-mismatch`       | Inbound nonce's encoded seq did not match the cleartext wire seq.  |
| 4401 | `auth-failed`              | Install fingerprint mismatch or `e2e:answer` signature invalid.    |
| 4401 | `decrypt-failed`           | AES-GCM tag mismatch in an established session (traffic tampered). |
| 4408 | `timeout`                  | Handshake did not complete within the configured budget (10s).     |
| 4500 | `internal`                 | Unexpected error inside the Peer.                                  |

`auth-failed` deliberately does not distinguish fingerprint mismatch from
signature failure on the wire — knowing which check failed is leverage for an
attacker probing the protocol.

## Build + test

```bash
npm run build       # tsc → dist/*.d.ts (declarations only)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

The package is consumed as TypeScript source by every bundler in this
monorepo (electron-vite for the desktop, Vite for the phone web app, and
vitest for tests) — `package.json#main` and `exports.default` both point at
`./src/index.ts`. There is no `.js` build artifact.

`exports.types` and `package.json#types` point at `./dist/index.d.ts`,
generated by a declaration-only `tsc` run. The declaration boundary keeps
consumers' `tsc --noEmit` from walking into the package's source under their
own potentially incompatible library configuration.

The `prepare` script runs `tsc` on `npm install`, so fresh clones and CI get
`dist/` automatically. If you edit package source between installs and want
to refresh declarations, run `npm run build -w @komla/remote-protocol` from
the repo root.

If this package is ever published to npm or imported by a non-bundling Node
consumer, also emit `.js` and switch the source to `moduleResolution:
"NodeNext"` with `.js`-suffixed relative imports — TypeScript's `bundler`
resolution does not rewrite specifiers for native Node ESM.
