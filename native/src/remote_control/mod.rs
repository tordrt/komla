//! Phone access to this host without the desktop: a localhost server, published with Tailscale
//! Serve, that speaks the desktop's remote-control protocol and trusts the phones the desktop
//! trusts. See ADR 0005 and `docs/REMOTE_CONTROL_SECURITY.md`.

mod attention;
mod binary_frames;
mod ceremony;
mod crypto;
mod frame_budget;
mod launch;
mod outbox;
mod peer;
mod resume;
mod server;
mod session;
mod terminal;
mod trust;
mod webauthn;
mod workspace_control;
mod workspaces;

pub(crate) use server::{init, serve};
