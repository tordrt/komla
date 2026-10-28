//! The SSH Exec Channel (ADR 0003). The desktop starts it over its own SSH session and sends it
//! the shell commands it would otherwise run with one `ssh` exec each, which saves a round trip
//! or more per command. It runs each one as `sh -lc <command>`, as sshd would have, and owns no
//! operations of its own. It listens on nothing and stops its commands when the session ends.
//!
//! Every frame, either way, is a big-endian `u32` length of the rest, a kind byte, a big-endian
//! `u32` request id and the payload. The channel first sends `READY` with its protocol version.
//! An `EXEC` payload is a big-endian `u32` length of the command, the command and the bytes for
//! its stdin; `CANCEL` stops one. Each command answers with `STDOUT` and `STDERR` frames of at
//! most `OUTPUT_CHUNK_BYTES` and then one `EXIT` with a big-endian `i32`.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::bail;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
const READY: u8 = 0;
const EXEC: u8 = 1;
const CANCEL: u8 = 2;
const STDOUT: u8 = 16;
const STDERR: u8 = 17;
const EXIT: u8 = 18;
const HEADER_BYTES: usize = 5;
// Commands carry whole helper scripts, but nothing near this.
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
// A large output delays another command's reply by at most one frame.
const OUTPUT_CHUNK_BYTES: usize = 64 * 1024;
const CANCEL_KILL_GRACE: Duration = Duration::from_secs(5);

type Output = Arc<Mutex<dyn Write + Send>>;
/// The process group of each command still running, by request id. A command leaves it once its
/// shell exited but before it is reaped, so a cancel never signals a reused pid.
type Running = Arc<Mutex<HashMap<u32, i32>>>;

pub fn run() -> anyhow::Result<()> {
    serve(io::stdin().lock(), Arc::new(Mutex::new(io::stdout())))
}

pub(crate) fn serve(mut input: impl Read, output: Output) -> anyhow::Result<()> {
    let running: Running = Arc::default();
    send(&output, READY, 0, &PROTOCOL_VERSION.to_be_bytes());
    let result = read_requests(&mut input, &output, &running);
    // The desktop's session ended, so nobody waits for these anymore.
    for group in running.lock().expect("running commands").values() {
        signal_group(*group, libc::SIGTERM);
    }
    result
}

fn read_requests(input: &mut impl Read, output: &Output, running: &Running) -> anyhow::Result<()> {
    loop {
        let mut length = [0; 4];
        match input.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let length = u32::from_be_bytes(length) as usize;
        if !(HEADER_BYTES..=HEADER_BYTES + MAX_REQUEST_BYTES).contains(&length) {
            bail!("exec channel frame of {length} bytes is out of range");
        }
        let mut frame = vec![0; length];
        input.read_exact(&mut frame)?;
        let id = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
        let payload = &frame[HEADER_BYTES..];
        match frame[0] {
            EXEC => {
                let Some((command, input)) = payload
                    .split_first_chunk::<4>()
                    .map(|(length, rest)| (u32::from_be_bytes(*length) as usize, rest))
                    .filter(|(length, rest)| *length <= rest.len())
                    .map(|(length, rest)| rest.split_at(length))
                else {
                    bail!("exec channel request {id} is malformed");
                };
                let command = String::from_utf8_lossy(command).into_owned();
                let input = input.to_vec();
                let (output, running) = (Arc::clone(output), Arc::clone(running));
                thread::spawn(move || run_command(id, &command, input, &output, &running));
            }
            CANCEL => cancel(id, running),
            _ => {}
        }
    }
}

fn run_command(id: u32, command: &str, input: Vec<u8>, output: &Output, running: &Running) {
    let spawned = Command::new("sh")
        .arg("-lc")
        .arg(command)
        .stdin(if input.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let message = format!("komla: could not start sh: {error}\n");
            send(output, STDERR, id, message.as_bytes());
            send(output, EXIT, id, &127_i32.to_be_bytes());
            return;
        }
    };
    running
        .lock()
        .expect("running commands")
        .insert(id, child.id() as i32);
    // A command that stops reading its input fails the write, which nobody needs to hear about.
    if let Some(mut stdin) = child.stdin.take() {
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stderr = child.stderr.take().map(|stderr| {
        let output = Arc::clone(output);
        thread::spawn(move || forward(stderr, STDERR, id, &output))
    });
    if let Some(stdout) = child.stdout.take() {
        forward(stdout, STDOUT, id, output);
    }
    if let Some(stderr) = stderr {
        let _ = stderr.join();
    }
    // Like sshd, the reply waits for both outputs to close, not only for the shell to exit.
    wait_without_reaping(child.id());
    running.lock().expect("running commands").remove(&id);
    let code = match child.wait() {
        Ok(status) => status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
        Err(_) => 255,
    };
    send(output, EXIT, id, &code.to_be_bytes());
}

/// Waits until the shell exits but leaves it unreaped, so its pid, which is its group's id, can't
/// be reused while a cancel may still signal that group.
fn wait_without_reaping(pid: u32) {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let waited = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if waited == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return;
        }
    }
}

fn forward(mut stream: impl Read, kind: u8, id: u32, output: &Output) {
    let mut buffer = vec![0; OUTPUT_CHUNK_BYTES];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => send(output, kind, id, &buffer[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

fn cancel(id: u32, running: &Running) {
    let Some(group) = running.lock().expect("running commands").get(&id).copied() else {
        return;
    };
    signal_group(group, libc::SIGTERM);
    let running = Arc::clone(running);
    thread::spawn(move || {
        thread::sleep(CANCEL_KILL_GRACE);
        let running = running.lock().expect("running commands");
        if running.get(&id) == Some(&group) {
            signal_group(group, libc::SIGKILL);
        }
    });
}

fn signal_group(group: i32, signal: libc::c_int) {
    unsafe { libc::kill(-group, signal) };
}

/// Write errors mean the desktop is gone; its session closing ends the channel.
fn send(output: &Output, kind: u8, id: u32, payload: &[u8]) {
    let mut frame = Vec::with_capacity(4 + HEADER_BYTES + payload.len());
    frame.extend_from_slice(&((HEADER_BYTES + payload.len()) as u32).to_be_bytes());
    frame.push(kind);
    frame.extend_from_slice(&id.to_be_bytes());
    frame.extend_from_slice(payload);
    let mut output = output.lock().expect("exec channel output");
    let _ = output.write_all(&frame).and_then(|()| output.flush());
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use tempfile::tempdir;

    use super::{
        serve, CANCEL, EXEC, EXIT, HEADER_BYTES, MAX_REQUEST_BYTES, OUTPUT_CHUNK_BYTES,
        PROTOCOL_VERSION, READY, STDERR, STDOUT,
    };

    struct FrameSink(Sender<Vec<u8>>);

    impl Write for FrameSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.send(bytes.to_vec());
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Frame {
        kind: u8,
        id: u32,
        payload: Vec<u8>,
    }

    #[derive(Default)]
    struct Reply {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        largest_frame: usize,
    }

    struct Channel {
        requests: UnixStream,
        written: Receiver<Vec<u8>>,
        unread: Vec<u8>,
        server: JoinHandle<anyhow::Result<()>>,
    }

    impl Channel {
        fn start() -> Self {
            let (requests, input) = UnixStream::pair().expect("socket pair");
            let (sender, written) = mpsc::channel();
            let server =
                thread::spawn(move || serve(input, Arc::new(Mutex::new(FrameSink(sender)))));
            let mut channel = Self {
                requests,
                written,
                unread: Vec::new(),
                server,
            };
            let ready = channel.next_frame();
            assert_eq!(ready.kind, READY);
            assert_eq!(ready.payload, PROTOCOL_VERSION.to_be_bytes());
            channel
        }

        fn request(&mut self, kind: u8, id: u32, payload: &[u8]) {
            let mut frame = ((HEADER_BYTES + payload.len()) as u32)
                .to_be_bytes()
                .to_vec();
            frame.push(kind);
            frame.extend_from_slice(&id.to_be_bytes());
            frame.extend_from_slice(payload);
            self.requests.write_all(&frame).expect("request");
        }

        fn exec(&mut self, id: u32, command: &str) {
            self.exec_with_input(id, command, &[]);
        }

        fn exec_with_input(&mut self, id: u32, command: &str, input: &[u8]) {
            let mut payload = (command.len() as u32).to_be_bytes().to_vec();
            payload.extend_from_slice(command.as_bytes());
            payload.extend_from_slice(input);
            self.request(EXEC, id, &payload);
        }

        fn next_frame(&mut self) -> Frame {
            loop {
                if self.unread.len() >= 4 {
                    let length = u32::from_be_bytes(self.unread[..4].try_into().unwrap()) as usize;
                    if self.unread.len() >= 4 + length {
                        let frame: Vec<u8> = self.unread.drain(..4 + length).collect();
                        return Frame {
                            kind: frame[4],
                            id: u32::from_be_bytes(frame[5..9].try_into().unwrap()),
                            payload: frame[9..].to_vec(),
                        };
                    }
                }
                let bytes = self
                    .written
                    .recv_timeout(Duration::from_secs(10))
                    .expect("a frame within 10 s");
                self.unread.extend(bytes);
            }
        }

        /// The exit code and output of each request, in the order they exited.
        fn replies(&mut self, count: usize) -> Vec<(u32, i32, Reply)> {
            let mut pending: std::collections::HashMap<u32, Reply> = Default::default();
            let mut done = Vec::new();
            while done.len() < count {
                let frame = self.next_frame();
                let reply = pending.entry(frame.id).or_default();
                reply.largest_frame = reply.largest_frame.max(frame.payload.len());
                match frame.kind {
                    STDOUT => reply.stdout.extend(&frame.payload),
                    STDERR => reply.stderr.extend(&frame.payload),
                    EXIT => {
                        let code = i32::from_be_bytes(frame.payload[..4].try_into().unwrap());
                        done.push((frame.id, code, pending.remove(&frame.id).unwrap()));
                    }
                    kind => panic!("unexpected frame kind {kind}"),
                }
            }
            done
        }

        fn reply(&mut self) -> (i32, Reply) {
            let (_, code, reply) = self.replies(1).pop().unwrap();
            (code, reply)
        }
    }

    fn text(bytes: &[u8]) -> &str {
        std::str::from_utf8(bytes).unwrap()
    }

    fn wait_until_gone(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "process {pid} is still running");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn read_pid(path: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(pid) = fs::read_to_string(path).unwrap_or_default().trim().parse() {
                return pid;
            }
            assert!(Instant::now() < deadline, "no pid in {}", path.display());
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn returns_exit_code_stdout_and_stderr_separately() {
        let mut channel = Channel::start();
        channel.exec(7, "printf out; printf err >&2; exit 3");
        let (id, code, reply) = channel.replies(1).pop().unwrap();
        assert_eq!((id, code), (7, 3));
        assert_eq!(text(&reply.stdout), "out");
        assert_eq!(text(&reply.stderr), "err");
    }

    #[test]
    fn splits_large_and_binary_output_into_bounded_frames() {
        let mut channel = Channel::start();
        channel.exec(1, "head -c 300000 /dev/zero; printf '\\377\\001'");
        let (code, reply) = channel.reply();
        assert_eq!(code, 0);
        assert_eq!(reply.stdout.len(), 300_002);
        assert_eq!(&reply.stdout[300_000..], &[0xff, 0x01]);
        assert!(reply.largest_frame <= OUTPUT_CHUNK_BYTES);
    }

    #[test]
    fn gives_commands_an_empty_stdin() {
        let mut channel = Channel::start();
        channel.exec(1, "cat; echo done");
        let (code, reply) = channel.reply();
        assert_eq!((code, text(&reply.stdout)), (0, "done\n"));
    }

    #[test]
    fn feeds_a_command_its_input() {
        let mut channel = Channel::start();
        let input = vec![b'x'; 300_000];
        channel.exec_with_input(1, "wc -c", &input);
        channel.exec_with_input(2, "true", b"input nobody reads");
        let mut replies = channel.replies(2);
        replies.sort_by_key(|(id, ..)| *id);
        assert_eq!(replies[0].1, 0);
        assert_eq!(text(&replies[0].2.stdout).trim(), "300000");
        assert_eq!(replies[1].1, 0);
    }

    #[test]
    fn answers_a_quick_command_while_a_slow_one_runs() {
        let mut channel = Channel::start();
        channel.exec(1, "sleep 1; echo slow");
        channel.exec(2, "echo fast");
        let order: Vec<u32> = channel.replies(2).iter().map(|(id, ..)| *id).collect();
        assert_eq!(order, vec![2, 1]);
    }

    #[test]
    fn waits_for_output_a_background_process_still_writes_like_sshd() {
        let mut channel = Channel::start();
        channel.exec(1, "(sleep 0.3; echo late) & echo early");
        let (code, reply) = channel.reply();
        assert_eq!((code, text(&reply.stdout)), (0, "early\nlate\n"));
    }

    #[test]
    fn lets_a_pipeline_stop_on_a_closed_pipe() {
        let mut channel = Channel::start();
        channel.exec(1, "yes | head -n 1");
        let (code, reply) = channel.reply();
        assert_eq!((code, text(&reply.stdout)), (0, "y\n"));
    }

    #[test]
    fn cancel_stops_the_command_and_its_background_children() {
        let directory = tempdir().unwrap();
        let pid_file = directory.path().join("pid");
        let mut channel = Channel::start();
        channel.exec(
            4,
            &format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()),
        );
        let child = read_pid(&pid_file);
        channel.request(CANCEL, 4, &[]);
        let (code, _) = channel.reply();
        assert_eq!(code, 128 + libc::SIGTERM);
        wait_until_gone(child);
    }

    #[test]
    fn cancel_stops_a_command_that_closed_its_output() {
        let mut channel = Channel::start();
        channel.exec(1, "exec >/dev/null 2>&1; sleep 30");
        thread::sleep(Duration::from_millis(300));
        channel.request(CANCEL, 1, &[]);
        let (code, _) = channel.reply();
        assert_eq!(code, 128 + libc::SIGTERM);
    }

    #[test]
    fn stops_running_commands_when_the_session_ends() {
        let directory = tempdir().unwrap();
        let pid_file = directory.path().join("pid");
        let mut channel = Channel::start();
        channel.exec(
            1,
            &format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()),
        );
        let child = read_pid(&pid_file);
        drop(channel.requests);
        channel
            .server
            .join()
            .unwrap()
            .expect("a closed session ends the channel cleanly");
        wait_until_gone(child);
    }

    #[test]
    fn rejects_a_command_longer_than_its_request() {
        let mut channel = Channel::start();
        channel.request(EXEC, 1, &[0, 0, 0, 9, b't', b'r', b'u', b'e']);
        let error = channel.server.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("malformed"), "{error}");
    }

    #[test]
    fn rejects_a_frame_larger_than_any_request() {
        let mut channel = Channel::start();
        let length = (HEADER_BYTES + MAX_REQUEST_BYTES + 1) as u32;
        channel.requests.write_all(&length.to_be_bytes()).unwrap();
        let error = channel.server.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("out of range"), "{error}");
    }
}
