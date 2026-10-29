use anyhow::{bail, Context};
use komla::COMPANION_PROTOCOL_VERSION;

mod automation;
mod cli;
mod clock;
mod desktop;
#[cfg(unix)]
mod exec_channel;
mod lifecycle;
mod mailbox;
mod offline_workspace;
mod outbox;
#[cfg(unix)]
mod pty_proxy;
#[cfg(unix)]
mod remote_control;
mod runtime;
mod scanner;
mod search;
mod transport;

fn main() {
    if let Err(error) = run() {
        if error.downcast_ref::<cli::ReportedCliError>().is_some() {
            std::process::exit(1);
        }
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("version") => {
            println!(
                "{{\"name\":\"komla\",\"version\":\"{}\",\"protocolVersion\":{}}}",
                env!("CARGO_PKG_VERSION"),
                COMPANION_PROTOCOL_VERSION
            );
            Ok(())
        }
        Some("help" | "--help" | "-h") => {
            cli::print_help();
            Ok(())
        }
        Some("__companion") => {
            let config_path = args
                .get(2)
                .context("internal companion configuration path is required")?;
            runtime::serve(config_path)
        }
        // helpers/notify.sh passes hook input to the companion in this positional form.
        Some("notify") if is_legacy_notify_invocation(&args) => {
            mailbox::ingest(&args)
        }
        // Run by the desktop over SSH to set up and run phone access to this host.
        #[cfg(unix)]
        Some("__phone-init") => {
            let state_dir = args.get(2).context("usage: komla __phone-init <state-dir>")?;
            remote_control::init(state_dir)
        }
        #[cfg(unix)]
        Some("__phone-serve") => {
            let config = args.get(2).context("usage: komla __phone-serve <config>")?;
            remote_control::serve(config)
        }
        // Run by the desktop over SSH when its user interrupts an agent.
        Some("__relay-interrupt") => {
            let (Some(inbox), Some(terminal_id)) = (args.get(2), args.get(3)) else {
                bail!("usage: komla __relay-interrupt <inbox> <terminal-id> <source>...");
            };
            mailbox::relay_interrupt(std::path::Path::new(inbox), terminal_id, &args[4..]);
            Ok(())
        }
        // Run by the desktop over SSH to search an SSH workspace's file contents.
        Some("__search") => search::run(&args[2..]),
        // Started by the desktop over its SSH session to run its shell commands (ADR 0003).
        #[cfg(unix)]
        Some("__exec-channel") => exec_channel::run(),
        // Runs the shell of each Managed Remote Terminal Session, for OSC 7501 statuses.
        #[cfg(unix)]
        Some("__pty-proxy") => pty_proxy::run(&args[2..]),
        Some(_) => cli::run(&args[1..]),
        _ => bail!("usage: komla <launch|preview|title|notify|settings|skill|context|workspace|agent|desktop|git|mcp|automation|version> [arguments]"),
    }
}

fn is_legacy_notify_invocation(args: &[String]) -> bool {
    args.len() == 6
        && args
            .get(2..5)
            .is_some_and(|values| values.iter().all(|argument| !argument.starts_with('-')))
}

#[cfg(test)]
mod tests {
    use super::is_legacy_notify_invocation;

    #[test]
    fn legacy_notification_accepts_a_leading_hyphen_terminal_id() {
        let args = vec![
            "komla".to_owned(),
            "notify".to_owned(),
            "/tmp/inbox".to_owned(),
            "codex".to_owned(),
            "Stop".to_owned(),
            "-terminal".to_owned(),
        ];

        assert!(is_legacy_notify_invocation(&args));
    }
}
