//! The desktop side of `packages/remote-protocol/src/peer/peer.ts`, played by this host: answer
//! the browser's `e2e:offer` with a signed `e2e:answer`, then exchange `e2e:enc` frames whose
//! per-direction sequence numbers must be consecutive.

use anyhow::{anyhow, bail, Context};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tungstenite::Message;

use super::crypto::{
    handshake_transcript, sha256, Ephemeral, HostIdentity, SessionKey, DIRECTION_CLIENT_TO_DESKTOP,
    DIRECTION_DESKTOP_TO_CLIENT, NONCE_BYTES,
};
use super::frame_budget::{MAX_BINARY_BODY_BYTES, MAX_BINARY_FRAME_BYTES, MAX_BODY_BYTES};

/// `MAX_FRAME_CHARS` in `wire/messages.ts`; every frame is ASCII, so bytes equal UTF-16 units.
pub(crate) const MAX_FRAME_CHARS: usize = 65_536;
const PAYLOAD_JSON: u8 = 0x01;
const PAYLOAD_BINARY: u8 = 0x02;

/// `PEER_CLOSE` in `wire/close-codes.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PeerClose {
    BadRequest,
    AuthFailed,
    Timeout,
    Internal,
}

impl PeerClose {
    pub(crate) fn code(self) -> u16 {
        match self {
            Self::BadRequest => 4400,
            Self::AuthFailed => 4401,
            Self::Timeout => 4408,
            Self::Internal => 4500,
        }
    }

    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::BadRequest => "bad-request",
            Self::AuthFailed => "auth-failed",
            Self::Timeout => "timeout",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug)]
pub(crate) struct PeerError {
    pub(crate) close: PeerClose,
    pub(crate) reason: &'static str,
    pub(crate) detail: String,
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.reason, self.detail)
    }
}

impl std::error::Error for PeerError {}

fn fail(close: PeerClose, reason: &'static str, detail: impl Into<String>) -> PeerError {
    PeerError {
        close,
        reason,
        detail: detail.into(),
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum InboundFrame {
    #[serde(rename = "e2e:offer")]
    Offer {
        #[serde(rename = "ephemeralPubkey")]
        ephemeral_pubkey: String,
    },
    #[serde(rename = "e2e:enc")]
    Enc {
        seq: u32,
        nonce: String,
        ciphertext: String,
    },
}

#[derive(Serialize)]
struct AnswerFrame {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "ephemeralPubkey")]
    ephemeral_pubkey: String,
    #[serde(rename = "installPubkey")]
    install_pubkey: String,
    signature: String,
}

#[derive(Serialize)]
struct EncFrame {
    #[serde(rename = "type")]
    kind: &'static str,
    seq: u32,
    nonce: String,
    ciphertext: String,
}

/// `decodeBase64` in `wire/encoding.ts`: standard alphabet, padded, non-empty.
pub(crate) fn decode_base64(value: &str) -> Option<Vec<u8>> {
    if value.len() < 4 || value.len() % 4 != 0 {
        return None;
    }
    STANDARD.decode(value).ok()
}

pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

#[derive(Debug, PartialEq)]
pub(crate) enum Decoded {
    Json(Value),
    Binary(Vec<u8>),
}

struct Session {
    key: SessionKey,
    channel_binding: [u8; 32],
    outgoing_seq: u64,
    last_incoming_seq: i64,
}

pub(crate) struct HostPeer {
    session: Option<Session>,
    /// Sealed frames go out as binary envelopes once the phone agreed to it.
    binary_frames: bool,
}

impl HostPeer {
    pub(crate) fn new() -> Self {
        Self {
            session: None,
            binary_frames: false,
        }
    }

    /// Sends later frames as binary envelopes; incoming frames may be either kind at any time.
    pub(crate) fn enable_binary_frames(&mut self) {
        self.binary_frames = true;
    }

    pub(crate) fn uses_binary_frames(&self) -> bool {
        self.binary_frames
    }

    /// One inbound binary frame: `[seq u32 BE | nonce | ciphertext]`, after the handshake only.
    pub(crate) fn handle_binary(&mut self, raw: &[u8]) -> Result<Decoded, PeerError> {
        if self.session.is_none() {
            return Err(fail(
                PeerClose::BadRequest,
                "bad-request",
                "binary frame before the handshake",
            ));
        }
        if raw.len() > MAX_BINARY_FRAME_BYTES || raw.len() < 4 + NONCE_BYTES + 17 {
            return Err(fail(
                PeerClose::BadRequest,
                "bad-request",
                "binary frame size",
            ));
        }
        let (seq, rest) = raw.split_at(4);
        let (nonce, ciphertext) = rest.split_at(NONCE_BYTES);
        let seq = u32::from_be_bytes(seq.try_into().expect("four bytes"));
        self.open(seq, nonce, ciphertext)
    }

    pub(crate) fn is_established(&self) -> bool {
        self.session.is_some()
    }

    pub(crate) fn channel_binding(&self) -> Option<[u8; 32]> {
        self.session.as_ref().map(|session| session.channel_binding)
    }

    /// Handle one inbound text frame. Returns the answer to send while the handshake runs, or
    /// the decrypted payload once established. Any error ends the session.
    pub(crate) fn handle_frame(
        &mut self,
        raw: &str,
        identity: &HostIdentity,
    ) -> Result<PeerEvent, PeerError> {
        if raw.len() > MAX_FRAME_CHARS {
            return Err(fail(
                PeerClose::BadRequest,
                "bad-request",
                "oversized frame",
            ));
        }
        let frame: InboundFrame = serde_json::from_str(raw)
            .map_err(|_| fail(PeerClose::BadRequest, "bad-request", "unparseable frame"))?;
        match (frame, self.session.is_some()) {
            (InboundFrame::Offer { ephemeral_pubkey }, false) => {
                let client_ephemeral = decode_base64(&ephemeral_pubkey).ok_or_else(|| {
                    fail(
                        PeerClose::BadRequest,
                        "bad-request",
                        "offer ephemeralPubkey failed base64 decode",
                    )
                })?;
                let answer = self.answer(&client_ephemeral, identity)?;
                Ok(PeerEvent::Send(answer))
            }
            (
                InboundFrame::Enc {
                    seq,
                    nonce,
                    ciphertext,
                },
                true,
            ) => self
                .decrypt(seq, &nonce, &ciphertext)
                .map(PeerEvent::Message),
            (_, established) => Err(fail(
                PeerClose::BadRequest,
                "bad-request",
                format!("unexpected frame (established: {established})"),
            )),
        }
    }

    fn answer(
        &mut self,
        client_ephemeral: &[u8],
        identity: &HostIdentity,
    ) -> Result<String, PeerError> {
        let ephemeral = Ephemeral::generate();
        let transcript =
            handshake_transcript(client_ephemeral, ephemeral.spki_der(), identity.spki_der());
        let channel_binding = sha256(&transcript);
        let key = ephemeral
            .derive_session_key(client_ephemeral, &channel_binding)
            .map_err(|error| {
                fail(
                    PeerClose::BadRequest,
                    "bad-request",
                    format!("peer ephemeral SPKI rejected: {error}"),
                )
            })?;
        let answer = AnswerFrame {
            kind: "e2e:answer",
            ephemeral_pubkey: encode_base64(ephemeral.spki_der()),
            install_pubkey: encode_base64(identity.spki_der()),
            signature: encode_base64(&identity.sign_p1363(&transcript)),
        };
        self.session = Some(Session {
            key,
            channel_binding,
            outgoing_seq: 0,
            last_incoming_seq: -1,
        });
        serde_json::to_string(&answer)
            .map_err(|error| fail(PeerClose::Internal, "internal", error.to_string()))
    }

    fn decrypt(&mut self, seq: u32, nonce: &str, ciphertext: &str) -> Result<Decoded, PeerError> {
        let (Some(nonce), Some(ciphertext)) = (decode_base64(nonce), decode_base64(ciphertext))
        else {
            return Err(fail(
                PeerClose::BadRequest,
                "bad-request",
                "enc frame field failed base64 decode",
            ));
        };
        self.open(seq, &nonce, &ciphertext)
    }

    /// One encrypted frame, from a text or a binary envelope.
    fn open(&mut self, seq: u32, nonce: &[u8], ciphertext: &[u8]) -> Result<Decoded, PeerError> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| fail(PeerClose::Internal, "internal", "no session key"))?;
        if i64::from(seq) != session.last_incoming_seq + 1 {
            return Err(fail(
                PeerClose::BadRequest,
                "seq-violation",
                format!("seq {seq} did not follow {}", session.last_incoming_seq),
            ));
        }
        if nonce.len() != NONCE_BYTES {
            return Err(fail(PeerClose::BadRequest, "bad-request", "nonce length"));
        }
        if nonce[0] != DIRECTION_CLIENT_TO_DESKTOP {
            return Err(fail(
                PeerClose::BadRequest,
                "nonce-direction-mismatch",
                format!("nonce direction byte {}", nonce[0]),
            ));
        }
        if nonce[1..5] != seq.to_be_bytes() {
            return Err(fail(
                PeerClose::BadRequest,
                "nonce-seq-mismatch",
                "nonce seq did not match wire seq",
            ));
        }
        session.last_incoming_seq = i64::from(seq);
        let plaintext = session
            .key
            .decrypt(nonce, ciphertext)
            .map_err(|error| fail(PeerClose::AuthFailed, "decrypt-failed", error.to_string()))?;
        decode_payload(&plaintext)
            .ok_or_else(|| fail(PeerClose::BadRequest, "bad-request", "unknown payload tag"))
    }

    /// A JSON frame sealed into a text envelope, or a binary one once binary frames are on.
    pub(crate) fn seal_json(&mut self, value: &Value) -> anyhow::Result<Message> {
        let body = serde_json::to_vec(value)?;
        self.seal(PAYLOAD_JSON, &body)
    }

    /// A binary payload (`binary_frames.rs`); only once binary frames are on.
    pub(crate) fn seal_binary(&mut self, body: &[u8]) -> anyhow::Result<Message> {
        if !self.binary_frames {
            bail!("binary payloads need binary frames");
        }
        self.seal(PAYLOAD_BINARY, body)
    }

    #[cfg(test)]
    pub(crate) fn encrypt_json(&mut self, value: &Value) -> anyhow::Result<String> {
        match self.seal_json(value)? {
            Message::Text(text) => Ok(text),
            _ => bail!("sealed into a binary envelope"),
        }
    }

    fn seal(&mut self, tag: u8, body: &[u8]) -> anyhow::Result<Message> {
        let binary = self.binary_frames;
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("send before the session was established"))?;
        // The phone would end the session over it; refuse it before it spends a seq.
        let max = if binary {
            MAX_BINARY_BODY_BYTES
        } else {
            MAX_BODY_BYTES
        };
        if body.len() > max {
            bail!("frame of {} bytes exceeds the {max}-byte limit", body.len());
        }
        let seq = u32::try_from(session.outgoing_seq).context("outgoing seq counter overflowed")?;
        session.outgoing_seq += 1;
        let mut plaintext = Vec::with_capacity(body.len() + 1);
        plaintext.push(tag);
        plaintext.extend_from_slice(body);
        let (nonce, ciphertext) =
            session
                .key
                .encrypt(DIRECTION_DESKTOP_TO_CLIENT, seq, &plaintext)?;
        if binary {
            let mut frame = Vec::with_capacity(4 + nonce.len() + ciphertext.len());
            frame.extend_from_slice(&seq.to_be_bytes());
            frame.extend_from_slice(&nonce);
            frame.extend_from_slice(&ciphertext);
            return Ok(Message::Binary(frame));
        }
        Ok(Message::Text(serde_json::to_string(&EncFrame {
            kind: "e2e:enc",
            seq,
            nonce: encode_base64(&nonce),
            ciphertext: encode_base64(&ciphertext),
        })?))
    }
}

pub(crate) enum PeerEvent {
    Send(String),
    Message(Decoded),
}

fn decode_payload(plaintext: &[u8]) -> Option<Decoded> {
    let (&tag, body) = plaintext.split_first()?;
    match tag {
        PAYLOAD_JSON => {
            let text = std::str::from_utf8(body).ok()?;
            serde_json::from_str(text).ok().map(Decoded::Json)
        }
        PAYLOAD_BINARY => Some(Decoded::Binary(body.to_vec())),
        _ => None,
    }
}

/// Fails unless `value` is a JSON object; app and pair frames are always objects.
pub(crate) fn expect_object(decoded: Decoded) -> anyhow::Result<Value> {
    match decoded {
        Decoded::Json(value @ Value::Object(_)) => Ok(value),
        Decoded::Json(_) => bail!("frame is not an object"),
        Decoded::Binary(_) => bail!("unexpected binary frame"),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote_control::crypto::verify_p1363;

    /// A browser-side peer written against the TypeScript rules, for round trips in tests.
    pub(crate) struct TestClient {
        ephemeral: Ephemeral,
        key: Option<SessionKey>,
        seq: u32,
        pub(crate) binding: [u8; 32],
    }

    impl TestClient {
        pub(crate) fn new() -> Self {
            Self {
                ephemeral: Ephemeral::generate(),
                key: None,
                seq: 0,
                binding: [0; 32],
            }
        }

        pub(crate) fn offer(&self) -> String {
            serde_json::json!({
                "type": "e2e:offer",
                "ephemeralPubkey": encode_base64(self.ephemeral.spki_der()),
            })
            .to_string()
        }

        pub(crate) fn accept(&mut self, answer: &str, expected_fingerprint: &str) {
            let answer: Value = serde_json::from_str(answer).unwrap();
            let host_ephemeral =
                decode_base64(answer["ephemeralPubkey"].as_str().unwrap()).unwrap();
            let install = decode_base64(answer["installPubkey"].as_str().unwrap()).unwrap();
            let signature = decode_base64(answer["signature"].as_str().unwrap()).unwrap();
            assert_eq!(
                super::super::crypto::fingerprint(&install),
                expected_fingerprint
            );
            let transcript =
                handshake_transcript(self.ephemeral.spki_der(), &host_ephemeral, &install);
            assert!(verify_p1363(&install, &transcript, &signature));
            self.binding = sha256(&transcript);
            self.key = Some(
                self.ephemeral
                    .derive_session_key(&host_ephemeral, &self.binding)
                    .unwrap(),
            );
        }

        pub(crate) fn encrypt(&mut self, value: &Value) -> String {
            let mut plaintext = vec![PAYLOAD_JSON];
            plaintext.extend_from_slice(value.to_string().as_bytes());
            let (nonce, ciphertext) = self
                .key
                .as_ref()
                .unwrap()
                .encrypt(DIRECTION_CLIENT_TO_DESKTOP, self.seq, &plaintext)
                .unwrap();
            self.seq += 1;
            serde_json::json!({
                "type": "e2e:enc",
                "seq": self.seq - 1,
                "nonce": encode_base64(&nonce),
                "ciphertext": encode_base64(&ciphertext),
            })
            .to_string()
        }

        /// A binary envelope carrying `payload` (with its tag byte).
        pub(crate) fn seal_binary(&mut self, payload: &[u8]) -> Vec<u8> {
            let (nonce, ciphertext) = self
                .key
                .as_ref()
                .unwrap()
                .encrypt(DIRECTION_CLIENT_TO_DESKTOP, self.seq, payload)
                .unwrap();
            let mut frame = self.seq.to_be_bytes().to_vec();
            frame.extend_from_slice(&nonce);
            frame.extend_from_slice(&ciphertext);
            self.seq += 1;
            frame
        }

        /// The plaintext (tag byte first) and seq of a binary envelope from the host.
        pub(crate) fn open_binary(&self, frame: &[u8]) -> (u32, Vec<u8>) {
            let seq = u32::from_be_bytes(frame[..4].try_into().unwrap());
            let plaintext = self
                .key
                .as_ref()
                .unwrap()
                .decrypt(&frame[4..16], &frame[16..])
                .unwrap();
            (seq, plaintext)
        }

        pub(crate) fn decrypt(&self, frame: &str) -> Value {
            let frame: Value = serde_json::from_str(frame).unwrap();
            let nonce = decode_base64(frame["nonce"].as_str().unwrap()).unwrap();
            assert_eq!(nonce[0], DIRECTION_DESKTOP_TO_CLIENT);
            let plaintext = self
                .key
                .as_ref()
                .unwrap()
                .decrypt(
                    &nonce,
                    &decode_base64(frame["ciphertext"].as_str().unwrap()).unwrap(),
                )
                .unwrap();
            assert_eq!(plaintext[0], PAYLOAD_JSON);
            serde_json::from_slice(&plaintext[1..]).unwrap()
        }
    }

    fn established() -> (HostPeer, HostIdentity, TestClient) {
        let identity = HostIdentity::generate();
        let mut peer = HostPeer::new();
        let mut client = TestClient::new();
        let PeerEvent::Send(answer) = peer.handle_frame(&client.offer(), &identity).unwrap() else {
            panic!("expected an answer");
        };
        client.accept(&answer, &identity.fingerprint());
        (peer, identity, client)
    }

    #[test]
    fn answers_an_offer_and_exchanges_encrypted_json_both_ways() {
        let (mut peer, identity, mut client) = established();

        assert_eq!(peer.channel_binding(), Some(client.binding));
        let PeerEvent::Message(decoded) = peer
            .handle_frame(
                &client.encrypt(&serde_json::json!({"type": "ping"})),
                &identity,
            )
            .unwrap()
        else {
            panic!("expected a message");
        };
        assert_eq!(decoded, Decoded::Json(serde_json::json!({"type": "ping"})));
        let reply = peer
            .encrypt_json(&serde_json::json!({"type": "pong"}))
            .unwrap();
        assert_eq!(client.decrypt(&reply), serde_json::json!({"type": "pong"}));
    }

    #[test]
    fn a_replayed_or_skipped_frame_ends_the_session() {
        let (mut peer, identity, mut client) = established();
        let first = client.encrypt(&serde_json::json!({"n": 1}));
        peer.handle_frame(&first, &identity).unwrap();

        let replay = peer.handle_frame(&first, &identity).err().unwrap();
        assert_eq!(replay.reason, "seq-violation");

        let (mut peer, identity, mut client) = established();
        let _skipped = client.encrypt(&serde_json::json!({"n": 1}));
        let second = client.encrypt(&serde_json::json!({"n": 2}));
        assert_eq!(
            peer.handle_frame(&second, &identity).err().unwrap().reason,
            "seq-violation"
        );
    }

    #[test]
    fn refuses_a_frame_too_large_for_the_phone_without_spending_a_seq() {
        let (mut peer, _identity, client) = established();
        let too_large = serde_json::json!({ "data": "\u{1b}".repeat(10_000) });

        assert!(peer.encrypt_json(&too_large).is_err());
        let next = peer.encrypt_json(&serde_json::json!({ "n": 1 })).unwrap();

        let envelope: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(envelope["seq"], 0);
        assert!(next.len() <= MAX_FRAME_CHARS);
        assert_eq!(client.decrypt(&next), serde_json::json!({ "n": 1 }));
    }

    #[test]
    fn switches_to_binary_envelopes_on_the_same_seq_counter() {
        let (mut peer, _identity, client) = established();

        let Message::Text(first) = peer.seal_json(&serde_json::json!({ "n": 1 })).unwrap() else {
            panic!("expected text before binary frames are on");
        };
        assert!(peer.seal_binary(&[1, 2]).is_err());
        peer.enable_binary_frames();
        let Message::Binary(second) = peer.seal_json(&serde_json::json!({ "n": 2 })).unwrap()
        else {
            panic!("expected a binary envelope");
        };
        let Message::Binary(third) = peer.seal_binary(&[1, 2]).unwrap() else {
            panic!("expected a binary envelope");
        };

        assert_eq!(client.decrypt(&first), serde_json::json!({ "n": 1 }));
        let (seq, plaintext) = client.open_binary(&second);
        assert_eq!((seq, plaintext[0]), (1, PAYLOAD_JSON));
        assert_eq!(client.open_binary(&third), (2, vec![PAYLOAD_BINARY, 1, 2]));
    }

    #[test]
    fn opens_binary_frames_from_the_phone_and_checks_their_seq() {
        let (mut peer, identity, mut client) = established();
        let text = client.encrypt(&serde_json::json!({ "n": 0 }));
        peer.handle_frame(&text, &identity).unwrap();

        let binary = client.seal_binary(&[PAYLOAD_BINARY, 9]);
        assert_eq!(
            peer.handle_binary(&binary).unwrap(),
            Decoded::Binary(vec![9])
        );
        assert_eq!(
            peer.handle_binary(&binary).err().unwrap().reason,
            "seq-violation"
        );
        assert!(HostPeer::new().handle_binary(&binary).is_err());
    }

    #[test]
    fn rejects_a_frame_sealed_for_the_other_direction() {
        let (mut peer, identity, _client) = established();
        let reflected = peer.encrypt_json(&serde_json::json!({"x": 1})).unwrap();

        let error = peer.handle_frame(&reflected, &identity).err().unwrap();

        assert_eq!(error.reason, "nonce-direction-mismatch");
    }

    #[test]
    fn rejects_a_tampered_ciphertext() {
        let (mut peer, identity, mut client) = established();
        let mut frame: Value =
            serde_json::from_str(&client.encrypt(&serde_json::json!({"x": 1}))).unwrap();
        let mut ciphertext = decode_base64(frame["ciphertext"].as_str().unwrap()).unwrap();
        ciphertext[0] ^= 1;
        frame["ciphertext"] = Value::String(encode_base64(&ciphertext));

        let error = peer
            .handle_frame(&frame.to_string(), &identity)
            .err()
            .unwrap();

        assert_eq!(
            (error.close, error.reason),
            (PeerClose::AuthFailed, "decrypt-failed")
        );
    }

    #[test]
    fn rejects_frames_out_of_order_with_the_handshake() {
        let identity = HostIdentity::generate();
        let mut peer = HostPeer::new();
        let enc = r#"{"type":"e2e:enc","seq":0,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAA"}"#;
        assert!(peer.handle_frame(enc, &identity).is_err());
        assert!(peer
            .handle_frame(
                r#"{"type":"e2e:offer","ephemeralPubkey":"!!!!"}"#,
                &identity
            )
            .is_err());
        assert!(peer
            .handle_frame(
                r#"{"type":"e2e:offer","ephemeralPubkey":"AAAA","extra":1}"#,
                &identity
            )
            .is_err());
        let (mut peer, identity, client) = established();
        assert!(peer.handle_frame(&client.offer(), &identity).is_err());
    }
}
