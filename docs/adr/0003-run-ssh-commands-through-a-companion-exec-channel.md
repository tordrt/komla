---
status: accepted
---

# Run SSH commands through a companion exec channel

Komla will send the shell commands it runs on an SSH host through a long-lived SSH Exec Channel
instead of one `ssh` exec per command. Each connection lane of a host, background and
interactive, gets its own channel, so a file read doesn't wait behind a sync's transfer. The
channel is a hidden `__exec-channel` role of the Komla Remote Companion executable that Komla
starts over the lane's shared connection once a command opened it, or over a connection of its
own where ssh can't share one. It reads framed requests on stdin, runs each command as
`sh -lc <command>` exactly as Komla would have sent it to `ssh`, with the request's input as its
stdin, and streams the command's output and exit status back on stdout.

This amends ADR 0001's statement that the companion "does not become a general remote RPC
service". The channel is a transport, not a place for operations:

- It runs only command text that the desktop composed. It has no operations of its own, and no
  business rule, confirmation, or capability policy moves into Rust.
- It opens no socket and listens on nothing. Only the desktop's authenticated SSH session reaches
  it, so it grants nothing that ssh exec didn't.
- It lives only as long as that SSH session. It is not the resident observer, does not run in tmux,
  and stops its commands when the session ends.
- Komla works without it. A command goes through plain ssh exec when the channel isn't open, when
  the companion isn't installed, or when the channel broke before the command was sent.

A command over a shared ssh connection costs about 2.2 round trips: one to open an SSH channel, one
for the exec request, and the output and exit status. Without connection sharing, as with Windows
OpenSSH, every command also pays a full handshake. A channel command costs about 1.1 round trips.
Measured against a Docker host at 80 ms RTT, a command took 177 ms through a shared connection,
699 ms without one, and 87 ms through the channel. Typical SSH workspace flows run 5–15 commands one
after another.

## Considered options

- Keep one ssh exec per command: rejected because the protocol round trips dominate every command
  and Windows pays a full handshake each time.
- Add domain operations to the companion, such as Git status or file reads: rejected because it
  would duplicate desktop rules in Rust and still need a transport like this one.
- Reuse the resident companion and its reverse tunnel: rejected because the tunnel carries
  companion-to-desktop HTTP and the resident process outlives the desktop's session, so commands
  would need their own authentication and lifetime rules.

## Consequences

The channel carries commands and inputs that fit in one request, such as a saved file. Uploads
from files, streaming Setup steps, rsync, terminals, and port forwards stay on their own ssh
processes, so the channel needs no flow control and a large transfer can't delay other commands.
Output is sent in 64 KiB frames so a large reply delays a small one by at most a frame.

A channel never logs in on a shared connection: it waits until a command opened that connection.
Where it logs in on its own, it does so in batch mode, and not again on a host whose login asked
for a password, passphrase, or new host key, so it adds no failed logins to the host's log.
Editing a host lets its channels finish the commands they run before they close.

A command that was sent is never retried on another path when the channel breaks, because it may
already have run; it fails as a dropped ssh connection fails. Errors keep the shape Node's
`execFile` gives, so host status, timeouts, and output limits behave as before.

Each command still runs through a login shell, so profile changes apply to the next command. The
environment of the outer SSH session is fixed when the channel opens, until it closes after
10 minutes idle. Setting `KOMLA_SSH_EXEC_CHANNEL=0` turns the channel off.
