//! A phone's view of one terminal: a tmux client attached to the terminal's managed session in a
//! pseudo-terminal of the phone's size. It attaches without `-d`, so the desktop's own client stays
//! attached; tmux sizes the window for whichever client was active last.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;

use anyhow::{bail, Context};

use super::workspaces::MANAGED_SESSION_PREFIX;

const READ_CHUNK_BYTES: usize = 16 * 1024;

pub(crate) enum TerminalEvent {
    Output {
        terminal_id: String,
        attach_id: u64,
        data: String,
    },
    Exited {
        terminal_id: String,
        attach_id: u64,
    },
    /// A workspace the phone asked for was created, or why it wasn't.
    WorkspaceCreated {
        request_id: String,
        result: Result<String, String>,
    },
}

/// Decodes UTF-8 across read boundaries, replacing only bytes that can never be valid.
#[derive(Default)]
pub(crate) struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    pub(crate) fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&self.pending[..valid]).expect("prefix is valid"),
                    );
                    match error.error_len() {
                        Some(invalid) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + invalid);
                        }
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

pub(crate) fn session_target(terminal_id: &str) -> String {
    format!("={MANAGED_SESSION_PREFIX}{terminal_id}")
}

pub(crate) fn session_exists(socket: &str, terminal_id: &str) -> bool {
    Command::new("tmux")
        .args([
            "-L",
            socket,
            "has-session",
            "-t",
            &session_target(terminal_id),
        ])
        .env_remove("TMUX")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub(crate) struct TerminalClient {
    pub(crate) attach_id: u64,
    master: File,
    child: Child,
    socket: String,
    tty: String,
    /// Set when the reader had to drop output because the phone fell behind.
    pub(crate) overflowed: Arc<AtomicBool>,
}

impl TerminalClient {
    pub(crate) fn attach(
        socket: &str,
        terminal_id: &str,
        attach_id: u64,
        cols: u16,
        rows: u16,
        events: SyncSender<TerminalEvent>,
        wake: impl Fn() + Send + 'static,
    ) -> anyhow::Result<Self> {
        let mut master_fd = -1;
        let mut slave_fd = -1;
        let mut size = winsize(cols, rows);
        // SAFETY: openpty writes two descriptors it opened into the out pointers.
        let opened = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut size,
            )
        };
        if opened != 0 {
            bail!(
                "could not open a pseudo-terminal: {}",
                std::io::Error::last_os_error()
            );
        }
        // SAFETY: both descriptors are open and owned by nobody else.
        let (master, slave) = unsafe {
            (
                OwnedFd::from_raw_fd(master_fd),
                OwnedFd::from_raw_fd(slave_fd),
            )
        };
        let tty = tty_name(&slave).unwrap_or_default();
        set_cloexec(&master);

        let mut command = Command::new("tmux");
        command
            .args([
                "-L",
                socket,
                "attach-session",
                "-t",
                &session_target(terminal_id),
            ])
            .env_remove("TMUX")
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .stdin(Stdio::from(slave.try_clone().context("pty")?))
            .stdout(Stdio::from(slave.try_clone().context("pty")?))
            .stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().context("could not start tmux")?;
        drop(command);

        let master = File::from(master);
        let mut reader = master.try_clone().context("pty")?;
        let overflowed = Arc::new(AtomicBool::new(false));
        let reader_overflowed = Arc::clone(&overflowed);
        let reader_terminal = terminal_id.to_owned();
        thread::Builder::new()
            .name(format!("phone-terminal-{terminal_id}"))
            .spawn(move || {
                let mut buffer = vec![0u8; READ_CHUNK_BYTES];
                let mut carry = Utf8Carry::default();
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => {
                            let data = carry.decode(&buffer[..length]);
                            if data.is_empty() {
                                continue;
                            }
                            let event = TerminalEvent::Output {
                                terminal_id: reader_terminal.clone(),
                                attach_id,
                                data,
                            };
                            match events.try_send(event) {
                                Ok(()) => wake(),
                                Err(TrySendError::Full(_)) => {
                                    reader_overflowed.store(true, Ordering::SeqCst);
                                    wake();
                                }
                                Err(TrySendError::Disconnected(_)) => return,
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        // EIO once the client exits and the last slave descriptor closes.
                        Err(_) => break,
                    }
                }
                let _ = events.send(TerminalEvent::Exited {
                    terminal_id: reader_terminal,
                    attach_id,
                });
                wake();
            })
            .context("could not start the terminal reader")?;

        Ok(Self {
            attach_id,
            master,
            child,
            socket: socket.to_owned(),
            tty,
            overflowed,
        })
    }

    pub(crate) fn write_input(&mut self, data: &[u8]) -> anyhow::Result<()> {
        self.master.write_all(data).context("terminal input failed")
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let size = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ reads one winsize from the pointer.
        if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } < 0 {
            bail!(
                "could not resize the terminal: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(())
    }

    /// Asks tmux to repaint this client from scratch, after the phone missed output.
    pub(crate) fn refresh(&self) {
        if self.tty.is_empty() {
            return;
        }
        let _ = Command::new("tmux")
            .args(["-L", &self.socket, "refresh-client", "-t", &self.tty])
            .env_remove("TMUX")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

impl Drop for TerminalClient {
    fn drop(&mut self) {
        // Ends only this client; the session and the desktop's client keep running.
        // SAFETY: signalling our own child process.
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let _ = self.child.wait();
    }
}

fn set_cloexec(fd: &OwnedFd) {
    // SAFETY: F_SETFD on a descriptor we own.
    unsafe {
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
    }
}

fn tty_name(fd: &OwnedFd) -> Option<String> {
    let mut buffer = [0 as libc::c_char; 256];
    // SAFETY: ttyname_r writes a NUL-terminated name into the buffer.
    let result = unsafe { libc::ttyname_r(fd.as_raw_fd(), buffer.as_mut_ptr(), buffer.len()) };
    if result != 0 {
        return None;
    }
    // SAFETY: ttyname_r succeeded, so the buffer holds a C string.
    let name = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) };
    name.to_str().ok().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_characters_split_across_reads() {
        let mut carry = Utf8Carry::default();
        let text = "a✓b";
        let bytes = text.as_bytes();

        let first = carry.decode(&bytes[..2]);
        let second = carry.decode(&bytes[2..]);

        assert_eq!(first, "a");
        assert_eq!(second, "✓b");
    }

    #[test]
    fn replaces_bytes_that_are_never_valid() {
        let mut carry = Utf8Carry::default();

        assert_eq!(carry.decode(b"a\xffb"), "a\u{FFFD}b");
    }
}
