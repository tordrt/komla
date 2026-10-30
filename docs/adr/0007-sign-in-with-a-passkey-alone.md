---
status: accepted
---

# Sign in to remote control with a passkey alone

Remote control required two credentials on every browser: a passkey and an installation key that
pairing stored in that browser's IndexedDB. A browser with the user's synced passkey but other
storage, such as a private window, another browser or a Home Screen app, showed "This browser is
not paired" and had to pair again, and a private window lost that pairing when it closed. The
installation key kept a synced passkey from opening a shell on a device the user hadn't paired.

Komla now treats a trusted passkey as enough to sign in. A browser that isn't paired makes a key
of its own, sends its public key in a `passkey` hello, and answers a challenge that names no
passkey with any one the desktop trusts, plus a proof by its key over the channel binding. That key
only holds the session: the resume grants it receives name it, so reconnects after a sleep or a
network drop stay silent, and a grant copied to another browser is useless without the key. The
browser keeps the key, so it signs in the same way again once its grants run out.

With the installation key no longer required, the same passkey signature must not work on two
endpoints: SSH hosts verify passkeys for the desktop's RP ID and origin, so a compromised host could
otherwise ask a phone to sign the desktop's challenge and pass the signature on, turning a host into
a shell on the computer. So the page never signs an endpoint's challenge as sent. In every sign-in
it signs a hash of the challenge and the encrypted session's channel binding, which covers the
endpoint's key, and every endpoint checks that. An SSH host not yet updated refuses these, paired
browsers too, until the desktop next connects to it and updates its companion; resume grants keep
working meanwhile. A page cached before this change still signs challenges as sent, and is replaced
the next time it loads with the desktop reachable.

The user accepts the risk that whoever holds a synced passkey can open a shell over the tailnet,
which is the only network remote control listens on. Removing the passkey's record in
Settings › Remote is the revocation: it ends and revokes every browser signed in with it, on the
desktop and, once the desktop next connects, on SSH hosts.

## Considered Options

- Keep requiring the installation key: rejected by the user as too strict for a tailnet-only
  service; every new browser had to pair, and a private window could not stay paired.
- Accept a resume grant without a browser key: rejected, because a grant in `localStorage` would
  then work anywhere it was copied.
- Accept challenges as sent from paired browsers, for hosts not yet updated: rejected, because the
  page can't tell an old host from a compromised one claiming to be old, and would then sign
  whatever that host sent.

## Consequences

- Browsers signed in with one passkey share its record: its label, its sign counter and its push
  subscription slot.
- Pairing remains how a device gets a passkey for Komla in the first place.
