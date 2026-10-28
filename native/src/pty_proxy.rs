//! The PTY Proxy carries OSC 7501 program statuses out of a Managed Remote Terminal Session.
//! tmux drops OSC sequences it doesn't know, and it answers the Device Attributes query that
//! Claude Code sends right behind its 7501 query, so an answer from outside the pane always
//! arrives too late. The proxy runs the pane's shell on a pty of its own and reads its output
//! before tmux does: it answers each 7501 query at once, before passing on what follows it, and
//! wraps each report in tmux passthrough (`allow-passthrough on`) for Komla to read as it would
//! a local terminal's.
//!
//! Komla clears a killed program's status when the terminal's foreground process changes, but
//! over SSH that process is always `ssh`. The proxy sends the `clear` itself once the program's
//! process group is gone, or the shell has the foreground again.
//!
//! tmux passes a report on only to a client attached to see it, and Komla forgets the statuses
//! of a terminal whose SSH connection ended. Its `client-attached` hook sends the proxy SIGCONT,
//! which a shell started without the proxy ignores, and the proxy repeats a `working` or
//! `blocked` the program is still in; Komla doesn't ask again for a prompt it still shows. A turn
//! that ended meanwhile is left to the hooks waiting in the companion's mailbox.

use std::borrow::Cow;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;

const STATUS_PREFIX: &[u8] = b"\x1b]7501;";
const QUERY_REPLY: &[u8] = b"\x1b]7501;?\x1b\\";
const CLEAR_REPORT: &[u8] = b"\x1b]7501;state=clear\x1b\\";
// Reports are a few hundred bytes; a longer sequence passes through as it came.
const MAX_STATUS_BYTES: usize = 8 * 1024;
// Input waiting for the shell to read it before the proxy stops reading more.
const MAX_PENDING_INPUT_BYTES: usize = 1024 * 1024;
const READ_BYTES: usize = 64 * 1024;
// How long the start of a sequence waits for the rest before it passes through as it is.
const CARRY_FLUSH_DELAY: Duration = Duration::from_millis(100);
// The protocol's limit on a decoded message, which Komla enforces too.
const MAX_MESSAGE_BYTES: usize = 2048;
// Decodes as the desktop's atob does: padding optional, stray trailing bits ignored.
const LENIENT_BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// What a program's own report, one without an `id`, says of it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProgramReport {
    /// A `working` or `blocked` as it came, to repeat once a client attaches.
    Ongoing(Vec<u8>),
    Reporting,
    Clear,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Filtered {
    /// The output for tmux, with each report wrapped for passthrough and each query taken out.
    pub output: Vec<u8>,
    pub queries: usize,
    pub reports: Vec<ProgramReport>,
}

/// Finds OSC 7501 sequences in output that arrives in arbitrary chunks.
#[derive(Default)]
pub(crate) struct StatusFilter {
    carry: Vec<u8>,
}

impl StatusFilter {
    pub fn feed(&mut self, chunk: &[u8]) -> Filtered {
        let data: Cow<[u8]> = if self.carry.is_empty() {
            Cow::Borrowed(chunk)
        } else {
            let mut data = std::mem::take(&mut self.carry);
            data.extend_from_slice(chunk);
            Cow::Owned(data)
        };
        let mut filtered = Filtered {
            output: Vec::with_capacity(data.len()),
            ..Filtered::default()
        };
        let mut position = 0;
        while position < data.len() {
            let Some(start) = find(&data[position..], STATUS_PREFIX).map(|index| position + index)
            else {
                // A chunk can end partway through the prefix.
                let keep = partial_prefix_len(&data[position..]);
                filtered
                    .output
                    .extend_from_slice(&data[position..data.len() - keep]);
                self.carry = data[data.len() - keep..].to_vec();
                return filtered;
            };
            filtered.output.extend_from_slice(&data[position..start]);
            let body_start = start + STATUS_PREFIX.len();
            match sequence_end(&data[body_start..]) {
                SequenceEnd::Complete { body, length } => {
                    let body = &data[body_start..body_start + body];
                    if body.starts_with(b"?") {
                        filtered.queries += 1;
                    } else {
                        filtered.output.extend_from_slice(&tmux_passthrough(
                            &data[start..body_start + length],
                        ));
                        let sequence = &data[start..body_start + length];
                        if let Some(report) = program_report(body, sequence) {
                            filtered.reports.push(report);
                        }
                    }
                    position = body_start + length;
                }
                // An ESC other than ST's cancels the sequence; the terminal sees it as it came.
                SequenceEnd::Cancelled { body } => {
                    filtered
                        .output
                        .extend_from_slice(&data[start..body_start + body]);
                    position = body_start + body;
                }
                SequenceEnd::Incomplete if data.len() - start <= MAX_STATUS_BYTES => {
                    self.carry = data[start..].to_vec();
                    return filtered;
                }
                SequenceEnd::Incomplete => {
                    filtered.output.extend_from_slice(&data[start..]);
                    return filtered;
                }
            }
        }
        filtered
    }

    pub fn has_carry(&self) -> bool {
        !self.carry.is_empty()
    }

    /// Output held back as the possible start of a sequence, for when no more arrives.
    pub fn flush(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.carry)
    }
}

enum SequenceEnd {
    Complete { body: usize, length: usize },
    Cancelled { body: usize },
    Incomplete,
}

fn sequence_end(rest: &[u8]) -> SequenceEnd {
    for (index, byte) in rest.iter().enumerate() {
        match byte {
            0x07 => {
                return SequenceEnd::Complete {
                    body: index,
                    length: index + 1,
                }
            }
            0x1b => {
                return match rest.get(index + 1) {
                    Some(b'\\') => SequenceEnd::Complete {
                        body: index,
                        length: index + 2,
                    },
                    Some(_) => SequenceEnd::Cancelled { body: index },
                    None => SequenceEnd::Incomplete,
                }
            }
            _ => {}
        }
    }
    SequenceEnd::Incomplete
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let mut offset = 0;
    while let Some(index) = haystack[offset..]
        .iter()
        .position(|&byte| byte == needle[0])
    {
        let start = offset + index;
        if haystack[start..].starts_with(needle) {
            return Some(start);
        }
        offset = start + 1;
    }
    None
}

/// How many bytes at the end of `data` could begin the prefix.
fn partial_prefix_len(data: &[u8]) -> usize {
    (1..STATUS_PREFIX.len().min(data.len() + 1))
        .rev()
        .find(|&length| data.ends_with(&STATUS_PREFIX[..length]))
        .unwrap_or(0)
}

fn tmux_passthrough(sequence: &[u8]) -> Vec<u8> {
    let mut wrapped = b"\x1bPtmux;".to_vec();
    for &byte in sequence {
        if byte == 0x1b {
            wrapped.push(0x1b);
        }
        wrapped.push(byte);
    }
    wrapped.extend_from_slice(b"\x1b\\");
    wrapped
}

/// Reads the fields as Komla does; a report with an `id` is a record of the program's own.
fn program_report(body: &[u8], sequence: &[u8]) -> Option<ProgramReport> {
    let mut state = None;
    for field in body.split(|&byte| byte == b':') {
        if let Some(value) = field.strip_prefix(b"id=") {
            if !value.is_empty() {
                return None;
            }
        } else if let Some(value) = field.strip_prefix(b"state=") {
            state = Some(value);
        } else if let Some(value) = field.strip_prefix(b"msg=") {
            // Komla discards a report whose message it can't read.
            if !value.is_empty() && !is_valid_message(value) {
                return None;
            }
        }
    }
    match state? {
        b"clear" => Some(ProgramReport::Clear),
        b"working" | b"blocked" => Some(ProgramReport::Ongoing(sequence.to_vec())),
        b"idle" | b"done" | b"error" => Some(ProgramReport::Reporting),
        _ => None,
    }
}

fn is_valid_message(encoded: &[u8]) -> bool {
    let unpadded = encoded
        .strip_suffix(b"==")
        .or_else(|| encoded.strip_suffix(b"="));
    let unpadded = unpadded.unwrap_or(encoded);
    if !unpadded
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return false;
    }
    let Ok(bytes) = LENIENT_BASE64.decode(unpadded) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    text.len() <= MAX_MESSAGE_BYTES && !text.chars().any(|char| char.is_ascii_control())
}

// The write end of the pipe the signal handler wakes the loop through.
static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(signal: libc::c_int) {
    let byte = signal as u8;
    // The pipe is non-blocking and drained on every wake, so this write doesn't fail and leaves
    // errno alone.
    unsafe {
        libc::write(
            SIGNAL_PIPE.load(Ordering::Relaxed),
            (&byte as *const u8).cast(),
            1,
        )
    };
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    // Asked by the session command before it starts a shell through this proxy, so a companion
    // without it starts the shell directly.
    if args.first().map(String::as_str) == Some("--check") {
        return Ok(());
    }
    let Some((program, program_args)) = args.split_first() else {
        bail!("usage: komla __pty-proxy <program> [arguments]...");
    };
    let mut command = Command::new(program);
    command.args(program_args);

    let mut settings = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut settings) } != 0 {
        // Nothing to carry statuses through.
        return Err(command.exec()).with_context(|| format!("failed to run {program}"));
    }
    // Before the size is read and the shell starts, so a resize or the shell's exit meanwhile
    // waits in the pipe; the shell's exec resets the handlers.
    let signals = signal_pipe()?;
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ as _, &mut size) };
    let (mut master, mut slave) = (-1, -1);
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            &raw mut settings,
            &raw mut size,
        )
    } != 0
    {
        return Err(command.exec()).with_context(|| format!("failed to run {program}"));
    }
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    set_cloexec(master.as_raw_fd())?;
    set_cloexec(slave.as_raw_fd())?;

    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to run {program}"))?;
    // The command's stdio holds the only copies of the pty's other end now.
    drop(command);

    make_input_raw(settings);
    set_nonblocking(master.as_raw_fd())?;
    let status = relay(&master, signals.as_raw_fd(), &mut child)?;
    std::process::exit(exit_code(status));
}

fn relay(master: &OwnedFd, signals: RawFd, child: &mut Child) -> anyhow::Result<ExitStatus> {
    let master_fd = master.as_raw_fd();
    let shell_group = child.id() as libc::pid_t;
    let mut filter = StatusFilter::default();
    let mut pending_input = PendingInput::default();
    let mut carry_since: Option<Instant> = None;
    // The foreground process group of the program that reports its status.
    let mut reporter: Option<libc::pid_t> = None;
    let mut ongoing: Option<Vec<u8>> = None;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut buffer = vec![0; READ_BYTES];
    loop {
        // Counted from when the output was held back, so steady input can't put the flush off.
        if !filter.has_carry() {
            carry_since = None;
        } else if carry_since.is_some_and(|since| since.elapsed() >= CARRY_FLUSH_DELAY) {
            output.write_all(&filter.flush())?;
            output.flush()?;
            carry_since = None;
        }
        let timeout = filter.has_carry().then(|| {
            let since = *carry_since.get_or_insert_with(Instant::now);
            CARRY_FLUSH_DELAY.saturating_sub(since.elapsed())
        });
        let Some(ready) = wait(
            master_fd,
            signals,
            pending_input.len() < MAX_PENDING_INPUT_BYTES,
            !pending_input.is_empty(),
            timeout,
        )?
        else {
            continue;
        };
        if ready.signals {
            let mut signal = [0; 64];
            let count = unsafe { libc::read(signals, signal.as_mut_ptr().cast(), signal.len()) };
            let signal = &signal[..count.max(0) as usize];
            if signal.contains(&(libc::SIGWINCH as u8)) {
                copy_window_size(master_fd);
            }
            if let Some(report) = ongoing
                .as_deref()
                .filter(|_| signal.contains(&(libc::SIGCONT as u8)))
            {
                output.write_all(&tmux_passthrough(report))?;
                output.flush()?;
            }
            if signal.contains(&(libc::SIGCHLD as u8)) {
                if let Some(status) = child.try_wait()? {
                    // Anything the shell wrote before it exited is still to be read.
                    drain(master_fd, &mut filter, &mut output, &mut buffer)?;
                    return Ok(status);
                }
            }
        }
        if ready.input {
            match input.read(&mut buffer) {
                // The pane closed; the shell's session hangs up as the pty closes.
                Ok(0) => return Ok(ExitStatus::from_raw(0)),
                Ok(count) => pending_input.push(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error.into()),
            }
        }
        if ready.master_writable || ready.input {
            pending_input.write_to(master_fd)?;
        }
        if ready.master {
            let count = match read_nonblocking(master_fd, &mut buffer) {
                Ok(Some(count)) => count,
                Ok(None) => continue,
                // EIO: nothing holds the pty's other end open anymore.
                Err(_) => {
                    output.write_all(&filter.flush())?;
                    output.flush()?;
                    return Ok(child.wait()?);
                }
            };
            let filtered = filter.feed(&buffer[..count]);
            // Ahead of the output that follows the query, which tmux answers itself.
            for _ in 0..filtered.queries {
                pending_input.push(QUERY_REPLY);
            }
            if filtered.queries > 0 {
                pending_input.write_to(master_fd)?;
            }
            output.write_all(&filtered.output)?;
            for report in filtered.reports {
                (reporter, ongoing) = match report {
                    ProgramReport::Clear => (None, None),
                    ProgramReport::Ongoing(report) => (
                        reporter.or_else(|| foreground_group(master_fd)),
                        Some(report),
                    ),
                    ProgramReport::Reporting => {
                        (reporter.or_else(|| foreground_group(master_fd)), None)
                    }
                };
            }
            // A killed program sends no clear. Without job control it shares the shell's group,
            // and nothing tells.
            if reporter.is_some_and(|group| {
                group != shell_group
                    && (!group_exists(group) || foreground_group(master_fd) == Some(shell_group))
            }) {
                (reporter, ongoing) = (None, None);
                output.write_all(&tmux_passthrough(CLEAR_REPORT))?;
            }
            output.flush()?;
        }
    }
}

fn drain(
    master_fd: RawFd,
    filter: &mut StatusFilter,
    output: &mut impl Write,
    buffer: &mut [u8],
) -> anyhow::Result<()> {
    while let Ok(Some(count)) = read_nonblocking(master_fd, buffer) {
        output.write_all(&filter.feed(&buffer[..count]).output)?;
    }
    output.write_all(&filter.flush())?;
    output.flush()?;
    Ok(())
}

/// Ok(None) when nothing is ready to read.
fn read_nonblocking(fd: RawFd, buffer: &mut [u8]) -> io::Result<Option<usize>> {
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    if count > 0 {
        return Ok(Some(count as usize));
    }
    if count == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    let error = io::Error::last_os_error();
    match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => Ok(None),
        _ => Err(error),
    }
}

/// Input the shell hasn't taken yet. A paste goes out a few KB per write, so the written part is
/// dropped only once it is most of the buffer.
#[derive(Default)]
struct PendingInput {
    bytes: Vec<u8>,
    written: usize,
}

impl PendingInput {
    fn push(&mut self, input: &[u8]) {
        self.bytes.extend_from_slice(input);
    }

    fn len(&self) -> usize {
        self.bytes.len() - self.written
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn write_to(&mut self, fd: RawFd) -> io::Result<()> {
        while !self.is_empty() {
            let rest = &self.bytes[self.written..];
            let count = unsafe { libc::write(fd, rest.as_ptr().cast(), rest.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                match error.kind() {
                    io::ErrorKind::WouldBlock => break,
                    io::ErrorKind::Interrupted => continue,
                    _ => return Err(error),
                }
            }
            self.written += count as usize;
        }
        if self.is_empty() {
            self.bytes.clear();
            self.written = 0;
        } else if self.written > self.bytes.len() / 2 {
            self.bytes.drain(..self.written);
            self.written = 0;
        }
        Ok(())
    }
}

struct Ready {
    input: bool,
    master: bool,
    master_writable: bool,
    signals: bool,
}

/// Waits for the descriptors, or None when the timeout passes first. select, not poll, since
/// macOS's poll doesn't take terminal devices.
fn wait(
    master_fd: RawFd,
    signals: RawFd,
    read_input: bool,
    write_master: bool,
    timeout: Option<Duration>,
) -> io::Result<Option<Ready>> {
    loop {
        let mut read_set = unsafe { std::mem::zeroed::<libc::fd_set>() };
        let mut write_set = unsafe { std::mem::zeroed::<libc::fd_set>() };
        unsafe {
            libc::FD_ZERO(&mut read_set);
            libc::FD_ZERO(&mut write_set);
            if read_input {
                libc::FD_SET(libc::STDIN_FILENO, &mut read_set);
            }
            libc::FD_SET(master_fd, &mut read_set);
            libc::FD_SET(signals, &mut read_set);
            if write_master {
                libc::FD_SET(master_fd, &mut write_set);
            }
        }
        let mut wait = timeout.map(|timeout| libc::timeval {
            tv_sec: timeout.as_secs() as _,
            tv_usec: timeout.subsec_micros() as _,
        });
        let count = unsafe {
            libc::select(
                master_fd.max(signals).max(libc::STDIN_FILENO) + 1,
                &mut read_set,
                &mut write_set,
                std::ptr::null_mut(),
                wait.as_mut().map_or(std::ptr::null_mut(), |wait| wait),
            )
        };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Ok(None);
        }
        return Ok(Some(unsafe {
            Ready {
                input: libc::FD_ISSET(libc::STDIN_FILENO, &read_set),
                master: libc::FD_ISSET(master_fd, &read_set),
                master_writable: libc::FD_ISSET(master_fd, &write_set),
                signals: libc::FD_ISSET(signals, &read_set),
            }
        }));
    }
}

fn group_exists(group: libc::pid_t) -> bool {
    let exists = unsafe { libc::kill(-group, 0) } == 0;
    // EPERM: it exists but belongs to another user.
    exists || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn foreground_group(master_fd: RawFd) -> Option<libc::pid_t> {
    let group = unsafe { libc::tcgetpgrp(master_fd) };
    (group > 0).then_some(group)
}

fn copy_window_size(master_fd: RawFd) {
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    unsafe {
        if libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ as _, &mut size) == 0 {
            libc::ioctl(master_fd, libc::TIOCSWINSZ as _, &size);
        }
    }
}

fn signal_pipe() -> io::Result<OwnedFd> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in [read.as_raw_fd(), write.as_raw_fd()] {
        set_cloexec(fd)?;
        set_nonblocking(fd)?;
    }
    // The handler writes to it for as long as the process runs.
    SIGNAL_PIPE.store(write.as_raw_fd(), Ordering::Relaxed);
    std::mem::forget(write);
    for signal in [libc::SIGWINCH, libc::SIGCHLD, libc::SIGCONT] {
        let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
        action.sa_sigaction = on_signal as usize;
        action.sa_flags = libc::SA_RESTART;
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(read)
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The pane's terminal passes every byte through to the shell's, whose own settings apply. The
/// pane closes as the proxy exits, so nothing restores them.
fn make_input_raw(settings: libc::termios) {
    let mut raw = settings;
    unsafe {
        libc::cfmakeraw(&mut raw);
        libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw);
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrapped(sequence: &str) -> Vec<u8> {
        tmux_passthrough(sequence.as_bytes())
    }

    #[test]
    fn wraps_reports_for_tmux_passthrough() {
        let filtered = StatusFilter::default().feed(b"a\x1b]7501;state=working:app=x\x1b\\b");

        let mut expected = b"a".to_vec();
        expected.extend(b"\x1bPtmux;\x1b\x1b]7501;state=working:app=x\x1b\x1b\\\x1b\\");
        expected.extend(b"b");
        assert_eq!(filtered.output, expected);
        assert_eq!(
            filtered.reports,
            vec![ProgramReport::Ongoing(
                b"\x1b]7501;state=working:app=x\x1b\\".to_vec()
            )]
        );
    }

    #[test]
    fn takes_out_queries_ending_in_bel_or_st() {
        let filtered =
            StatusFilter::default().feed(b"\x1b]7501;?\x1b\\\x1b[c\x1b]7501;?\x07\x1b[c");

        assert_eq!(filtered.output, b"\x1b[c\x1b[c");
        assert_eq!(filtered.queries, 2);
        assert!(filtered.reports.is_empty());
    }

    #[test]
    fn holds_a_sequence_split_across_chunks() {
        let report = b"\x1b]7501;state=done\x1b\\";
        for split in 1..report.len() {
            let mut filter = StatusFilter::default();
            let mut output = filter.feed(&[b"x", &report[..split]].concat()).output;
            output.extend(filter.feed(&[&report[split..], b"y"].concat()).output);

            let expected = [
                b"x".to_vec(),
                wrapped("\x1b]7501;state=done\x1b\\"),
                b"y".to_vec(),
            ]
            .concat();
            assert_eq!(output, expected, "split at {split}");
            assert!(!filter.has_carry());
        }
    }

    #[test]
    fn passes_other_sequences_through() {
        let mut filter = StatusFilter::default();
        let data: &[u8] = b"\x1b]0;title\x07\x1b]750;x\x07\x1b]8;;http://x\x1b\\\x1b[31m";

        assert_eq!(filter.feed(data).output, data);
        assert!(!filter.has_carry());
    }

    #[test]
    fn holds_a_trailing_escape_until_more_output_or_a_flush() {
        let mut filter = StatusFilter::default();

        assert_eq!(filter.feed(b"ab\x1b").output, b"ab");
        assert_eq!(filter.feed(b"[1m").output, b"\x1b[1m");
        assert_eq!(filter.feed(b"\x1b]75").output, b"");
        assert_eq!(filter.flush(), b"\x1b]75");
        assert!(!filter.has_carry());
    }

    #[test]
    fn passes_a_cancelled_sequence_through() {
        let filtered = StatusFilter::default().feed(b"\x1b]7501;state=working\x1b[0m");

        assert_eq!(filtered.output, b"\x1b]7501;state=working\x1b[0m");
        assert!(filtered.reports.is_empty());
    }

    #[test]
    fn passes_an_overlong_sequence_through() {
        let mut filter = StatusFilter::default();
        let long = [
            b"\x1b]7501;state=working:msg=".as_slice(),
            &[b'a'; MAX_STATUS_BYTES],
        ]
        .concat();

        assert_eq!(filter.feed(&long).output, long);
        assert!(!filter.has_carry());
    }

    #[test]
    fn reads_the_program_report_as_komla_does() {
        let mut filter = StatusFilter::default();
        let filtered = filter.feed(
            b"\x1b]7501;state=working:id=agent-1:title=x\x07\
              \x1b]7501;state=clear:id=agent-1\x07\
              \x1b]7501;state=working:app=x\x07\
              \x1b]7501;state=blocked:kind=permission\x07\
              \x1b]7501;state=idle\x07\
              \x1b]7501;state=bogus\x07\
              \x1b]7501;state=clear\x07",
        );

        assert_eq!(
            filtered.reports,
            vec![
                ProgramReport::Ongoing(b"\x1b]7501;state=working:app=x\x07".to_vec()),
                ProgramReport::Ongoing(b"\x1b]7501;state=blocked:kind=permission\x07".to_vec()),
                ProgramReport::Reporting,
                ProgramReport::Clear
            ]
        );
    }

    #[test]
    fn skips_a_report_whose_message_komla_discards() {
        let mut filter = StatusFilter::default();
        let control = base64::engine::general_purpose::STANDARD.encode("a\nb");
        let long = base64::engine::general_purpose::STANDARD.encode("a".repeat(2049));
        let filtered = filter.feed(
            format!(
                "\x1b]7501;state=clear:msg=%%\x07\
                 \x1b]7501;state=clear:msg=abcde\x07\
                 \x1b]7501;state=clear:msg={control}\x07\
                 \x1b]7501;state=clear:msg={long}\x07\
                 \x1b]7501;state=done:msg=aGk\x07\
                 \x1b]7501;state=done:msg=aGl=\x07\
                 \x1b]7501;state=done:msg=\x07"
            )
            .as_bytes(),
        );

        assert_eq!(
            filtered.reports,
            vec![
                ProgramReport::Reporting,
                ProgramReport::Reporting,
                ProgramReport::Reporting
            ]
        );
    }
}
