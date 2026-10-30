---
status: accepted
---

# Serve phone remote control from the Remote Companion on SSH hosts

A phone that controls SSH workspaces through the desktop stops working whenever the desktop must
open a new SSH connection and the user's SSH agent asks for a fingerprint or password: after the
laptop sleeps or changes network, when a stopped workspace starts on an idle host, or once a shared
connection expires. It also stops whenever the laptop lid is closed, although the agents keep
running in tmux on the host. Komla will therefore let the Remote Companion on an SSH host serve the
phone directly, as an exception to ADR 0001's rule that tmux control stays desktop-owned.

The host server is a second endpoint for the same phone app and the same protocol
(`packages/remote-protocol`), reimplemented in Rust because hosts have no Node or WebCrypto.
It listens on localhost only and is published with Tailscale Serve on the host, so the rule that
Komla runs no relay or gateway in the path of a remote shell still holds. It offers the parts of
remote control that need no desktop: the workspace list from the shared workspace manifests and the
live `komla-v1` sessions, agent attention from hook copies (the companion's receiving-inbox
mechanism), and attaching to a terminal's existing tmux session. Creating, starting and stopping
workspaces, voice and notification settings stay desktop-only.

The desktop remains the authority for trust. Enrollment still happens only with the desktop. While
the user is at the desk, the desktop copies each trusted phone's device public key, passkey
credential and the desktop's origin and RP ID to the host over SSH, with a lease that expires
unless the desktop renews it. The phone authenticates to the host exactly as it does to the desktop:
the host signs the handshake with its own key, whose fingerprint the desktop gave the phone over an
authenticated session, and the phone proves both its passkey (verified by the host against the
copied public key) and its installation key over the host's channel binding.

## Amendment: creating and starting workspaces on the host

Phones open SSH hosts first, so leaving creation to the desktop took it away whenever a host was
listed, with the desktop awake or not. The host server now also creates, starts and stops
workspaces and opens and closes their tabs, through the same code that starts automation runs and
offline `komla launch` workspaces: it cuts the worktree from the bare repository already on the
host, starts the agent in a `komla-<terminal>` session, and writes the workspace manifest, which the
desktop adopts or merges the next time it syncs.

What it may start comes from the desktop. Over the connection that writes `trust.json`, the desktop
writes `launch.json`: the projects that have a workspace on that host, with their paths there, and
each agent preset's POSIX commands for every launch mode it can start there, including the one that
resumes a session. Other projects never reach the host. The desktop rewrites it whenever it
connects and the content changed; when it can't be built, trust is still written and the host keeps
its last copy. The host offers only the projects whose repository it already has, because cloning
one needs the credentials the desktop forwards. Voice, push, Quick Commands, generated titles and setup
steps stay desktop-only.

## Amendment: one list of every endpoint's workspaces

A phone that opened one endpoint saw only that endpoint's workspaces, and had to switch to see the
rest. The page now signs in to every other endpoint in the background, with that endpoint's resume
grant and a fresh installation-key proof as a reconnect does, never with the passkey, only to list
its workspaces and projects. It shows one list: its own endpoint's workspaces, then those only
another endpoint lists, a host's before the desktop's. Tapping one of those opens that endpoint's
page with the workspace open. An endpoint whose grant has lapsed is named below the list until the
phone signs in there again.

A phone still holds one session per endpoint, and the desktop still serves one device at a time.
A background session says so in its hello, so it never takes over from a session someone is using:
it closes as soon as it signs in, with the code for a replaced session, and keeps the next grant.
A session in use replaces a background one, and a background one replaces another. The list names an
endpoint held this way and tries it again when the page next comes on screen; tapping the name
takes the endpoint over, as opening it would.

The desktop also writes each SSH workspace's tag into its manifest as it shows it (name, color and
spinner), which the host lists for phones that agreed to tags.

## Considered Options

- Keep the desktop as the only endpoint and hold SSH connections open longer: rejected as the
  only answer, because it cannot survive sleep, network changes or a closed lid.
- Sending creation to the desktop whenever it is reachable: rejected because creation would still
  stop with the lid closed, and the phone would need a second sign-in to the desktop for it.
- A hosted relay between the phone and the host: rejected, as for the desktop
  (`docs/REMOTE_CONTROL_SECURITY.md`).
- Registering a separate passkey with every host: rejected because a passkey is bound to the page's
  origin, and the phone app has one origin, the desktop's.

## Consequences

- The host server is a long-lived process in its own tmux server, started and stopped by the desktop;
  like the companion it has no boot daemon, so a host reboot ends it until the desktop reconnects.
- Removing a phone, or turning remote control off, reaches a host only when the desktop next
  connects to it. The lease bounds how long a host that the desktop cannot reach keeps honoring a
  removed phone.
- The host's identity key lives in a file readable only by the host user; anyone who can read it can
  already run that user's shells.
- The Rust implementation must stay byte-compatible with the TypeScript protocol; a cross-language
  test runs the TypeScript client against the Rust server.
