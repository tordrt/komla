//! Encrypted frames on their way to the phone. Sealing a frame spends its seq, and the phone
//! ends the session at any gap, so a sealed frame must reach the socket after every frame sealed
//! before it. While the socket is backed up, terminal output is skipped before it is sealed, and
//! tmux repaints the screen once the phone catches up.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};

use serde_json::Value;
use tungstenite::{Message, WebSocket};

use super::binary_frames::encode_terminal_output;
use super::peer::HostPeer;

/// Where sealed frames go: the WebSocket, or a fake in tests.
pub(crate) trait FrameSink {
    /// Queues one frame. `WriteBufferFull` hands it back unsent.
    #[allow(clippy::result_large_err)] // tungstenite's own error, which carries the refused frame
    fn write_frame(&mut self, message: Message) -> tungstenite::Result<()>;
}

impl<S: Read + Write> FrameSink for WebSocket<S> {
    fn write_frame(&mut self, message: Message) -> tungstenite::Result<()> {
        self.write(message)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The socket has the frame.
    Sent,
    /// The socket took the frame but wants to be polled for writing.
    Blocked,
    /// Sealed and waiting behind earlier frames until the socket has room.
    Held,
    /// Not sealed: terminal output the phone is too far behind to take, or a frame too large.
    Skipped,
}

#[derive(Default)]
pub(crate) struct Outbox {
    held: VecDeque<Message>,
    held_bytes: usize,
}

impl Outbox {
    /// Bytes of sealed frames still waiting for the socket.
    pub(crate) fn held_bytes(&self) -> usize {
        self.held_bytes
    }

    /// Seals `frame` and sends it, or holds it behind frames the socket couldn't take yet.
    pub(crate) fn send(
        &mut self,
        peer: &mut HostPeer,
        sink: &mut impl FrameSink,
        frame: &Value,
    ) -> Outcome {
        if !self.held.is_empty() && frame["type"] == "app:terminal:data" {
            return Outcome::Skipped;
        }
        // Terminal output goes as a binary payload once the phone agreed to binary frames.
        let binary = peer
            .uses_binary_frames()
            .then(|| encode_terminal_output(frame))
            .flatten();
        let sealed = match binary {
            Some(bytes) => peer.seal_binary(&bytes),
            None => peer.seal_json(frame),
        };
        let message = match sealed {
            Ok(message) => message,
            Err(error) => {
                eprintln!("phone frame not sealed: {error:#}");
                return Outcome::Skipped;
            }
        };
        if !self.held.is_empty() {
            self.hold(message);
            return Outcome::Held;
        }
        match Self::write(sink, message) {
            Ok(outcome) => outcome,
            Err(message) => {
                self.hold(message);
                Outcome::Held
            }
        }
    }

    /// Moves held frames to the socket as it drains; true while some are still held.
    pub(crate) fn drain(&mut self, sink: &mut impl FrameSink) -> bool {
        while let Some(message) = self.held.pop_front() {
            let bytes = message.len();
            match Self::write(sink, message) {
                Ok(_) => self.held_bytes -= bytes,
                Err(message) => {
                    self.held.push_front(message);
                    break;
                }
            }
        }
        !self.held.is_empty()
    }

    fn hold(&mut self, message: Message) {
        self.held_bytes += message.len();
        self.held.push_back(message);
    }

    /// Writes one frame, handing it back if the socket's buffer is full.
    fn write(sink: &mut impl FrameSink, message: Message) -> Result<Outcome, Message> {
        match sink.write_frame(message) {
            Ok(()) => Ok(Outcome::Sent),
            Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => {
                Ok(Outcome::Blocked)
            }
            Err(tungstenite::Error::WriteBufferFull(message)) => Err(message),
            Err(error) => {
                eprintln!("phone frame not sent: {error}");
                Ok(Outcome::Sent)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_control::crypto::HostIdentity;
    use crate::remote_control::peer::tests::TestClient;
    use crate::remote_control::peer::PeerEvent;

    /// A socket with room for `room` more frames.
    struct FakeSink {
        room: usize,
        frames: Vec<String>,
    }

    impl FrameSink for FakeSink {
        fn write_frame(&mut self, message: Message) -> tungstenite::Result<()> {
            if self.room == 0 {
                return Err(tungstenite::Error::WriteBufferFull(message));
            }
            self.room -= 1;
            self.frames.push(message.into_text()?.to_string());
            Ok(())
        }
    }

    fn established() -> (HostPeer, TestClient) {
        let identity = HostIdentity::generate();
        let mut peer = HostPeer::new();
        let mut client = TestClient::new();
        let PeerEvent::Send(answer) = peer.handle_frame(&client.offer(), &identity).unwrap() else {
            panic!("expected an answer");
        };
        client.accept(&answer, &identity.fingerprint());
        (peer, client)
    }

    fn seqs(sink: &FakeSink) -> Vec<u64> {
        sink.frames
            .iter()
            .map(|frame| {
                serde_json::from_str::<Value>(frame).unwrap()["seq"]
                    .as_u64()
                    .unwrap()
            })
            .collect()
    }

    fn output(n: u64) -> Value {
        serde_json::json!({ "type": "app:terminal:data", "seq": n, "data": "x" })
    }

    #[test]
    fn a_frame_the_socket_refuses_is_sent_later_in_order() {
        let (mut peer, client) = established();
        let mut outbox = Outbox::default();
        let mut sink = FakeSink {
            room: 1,
            frames: Vec::new(),
        };
        let list = serde_json::json!({ "type": "app:workspaces", "workspaces": [] });

        assert_eq!(outbox.send(&mut peer, &mut sink, &output(1)), Outcome::Sent);
        assert_eq!(outbox.send(&mut peer, &mut sink, &list), Outcome::Held);
        // Output while backed up is skipped before it is sealed, so it spends no seq.
        assert_eq!(
            outbox.send(&mut peer, &mut sink, &output(2)),
            Outcome::Skipped
        );
        assert_eq!(outbox.send(&mut peer, &mut sink, &list), Outcome::Held);
        assert!(outbox.held_bytes() > 0);

        sink.room = 10;
        assert!(!outbox.drain(&mut sink));
        assert_eq!(outbox.send(&mut peer, &mut sink, &output(3)), Outcome::Sent);

        assert_eq!(seqs(&sink), vec![0, 1, 2, 3]);
        assert_eq!(outbox.held_bytes(), 0);
        assert_eq!(client.decrypt(&sink.frames[3]), output(3));
    }

    #[test]
    fn holds_frames_while_the_socket_stays_full() {
        let (mut peer, _client) = established();
        let mut outbox = Outbox::default();
        let mut sink = FakeSink {
            room: 0,
            frames: Vec::new(),
        };
        let status = serde_json::json!({ "type": "app:terminal:status", "status": "stopped" });

        assert_eq!(outbox.send(&mut peer, &mut sink, &status), Outcome::Held);
        assert!(outbox.drain(&mut sink));
        sink.room = 1;
        assert!(!outbox.drain(&mut sink));
        assert_eq!(seqs(&sink), vec![0]);
    }
}
