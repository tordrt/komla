//! The reconnect half of the desktop's pairing ceremony (`remote-control-authentication.ts`):
//! a trusted phone proves its passkey and its installation key over this session's channel
//! binding, or redeems a recent resume grant with a fresh installation-key signature. Enrollment
//! happens only with the desktop.

use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

use super::crypto::{device_proof, random_bytes, verify_p1363};
use super::peer::decode_base64;
use super::resume::ResumeStore;
use super::trust::{Trust, TrustedDevice};
use super::webauthn::{verify_assertion, ExpectedAssertion};

pub(crate) const PAIR_PROTOCOL_VERSION: u64 = 2;
pub(crate) const AUTH_CEREMONY_TIMEOUT_MS: u64 = 30_000;
/// Long enough to tap Unlock, miss Face ID and type the passcode; the phone can ask again meanwhile.
pub(crate) const PASSKEY_TIMEOUT_MS: u64 = 120_000;
/// `REMOTE_CAPABILITIES` this host supports; a phone lists its own in the hello.
pub(crate) const BINARY_FRAMES: &str = "binary-frames";
const HOST_CAPABILITIES: &[&str] = &[BINARY_FRAMES];
const MAX_CAPABILITIES: usize = 32;
const MAX_CAPABILITY_CHARS: usize = 64;

pub(crate) struct CeremonyContext<'a> {
    pub(crate) trust: &'a Trust,
    pub(crate) resume: &'a mut ResumeStore,
    pub(crate) counters: &'a mut HashMap<String, u32>,
    pub(crate) channel_binding: [u8; 32],
    pub(crate) now: u64,
}

#[derive(Debug)]
pub(crate) enum CeremonyOutcome {
    /// Send this frame and wait for the phone's answer.
    Reply(Value),
    /// Send this frame; the session may now reach terminals.
    Authenticated {
        device: TrustedDevice,
        reply: Value,
        resume_token: String,
        /// Both sides agreed to binary frames; switch after sending `reply`.
        binary_frames: bool,
    },
    /// Send this `pair:rejected` frame and close.
    Rejected(Value),
}

enum Stage {
    AwaitingHello,
    AwaitingAuthResponse {
        device: TrustedDevice,
        challenge: String,
    },
    AwaitingResumeResponse {
        device: TrustedDevice,
        challenge: String,
        /// Used up only once the proof verifies, so a dropped attempt leaves it.
        token: String,
    },
    Done,
}

pub(crate) struct Ceremony {
    stage: Stage,
    deadline: Option<u64>,
    /// What the phone's hello offered.
    capabilities: Vec<String>,
}

fn rejected(reason: &str, message: &str) -> CeremonyOutcome {
    CeremonyOutcome::Rejected(json!({
        "type": "pair:rejected",
        "reason": reason,
        "message": message,
    }))
}

fn is_device_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_resume_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A hello's `capabilities`, which may be absent; None when malformed, like the TypeScript schema.
fn hello_capabilities(frame: &Value) -> Option<Vec<String>> {
    let Some(value) = frame.get("capabilities") else {
        return Some(Vec::new());
    };
    let list = value.as_array()?;
    if list.len() > MAX_CAPABILITIES {
        return None;
    }
    list.iter()
        .map(|item| {
            item.as_str()
                .filter(|name| !name.is_empty() && name.chars().count() <= MAX_CAPABILITY_CHARS)
                .map(str::to_owned)
        })
        .collect()
}

fn only_keys(frame: &Value, keys: &[&str]) -> bool {
    frame
        .as_object()
        .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}

impl Ceremony {
    pub(crate) fn new() -> Self {
        Self {
            stage: Stage::AwaitingHello,
            deadline: None,
            capabilities: Vec::new(),
        }
    }

    /// A ceremony whose hello must arrive by `deadline`, so a connection that never signs in
    /// can't hold one of the server's few connection slots.
    pub(crate) fn awaiting_hello_until(deadline: u64) -> Self {
        Self {
            deadline: Some(deadline),
            ..Self::new()
        }
    }

    pub(crate) fn timed_out(&self, now: u64) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }

    pub(crate) fn handle(
        &mut self,
        frame: &Value,
        context: CeremonyContext<'_>,
    ) -> CeremonyOutcome {
        let stage = std::mem::replace(&mut self.stage, Stage::Done);
        let outcome = match stage {
            Stage::AwaitingHello => self.hello(frame, context),
            Stage::AwaitingAuthResponse { device, challenge } => {
                Self::auth_response(frame, context, device, &challenge)
            }
            Stage::AwaitingResumeResponse {
                device,
                challenge,
                token,
            } => Self::resume_response(frame, context, device, &challenge, &token),
            Stage::Done => rejected("internal", "the sign-in has already finished"),
        };
        self.agree_capabilities(outcome)
    }

    /// Names in pair:authenticated the hello's capabilities this host will use.
    fn agree_capabilities(&self, mut outcome: CeremonyOutcome) -> CeremonyOutcome {
        if let CeremonyOutcome::Authenticated {
            reply,
            binary_frames,
            ..
        } = &mut outcome
        {
            let agreed: Vec<&str> = HOST_CAPABILITIES
                .iter()
                .copied()
                .filter(|name| self.capabilities.iter().any(|offered| offered == name))
                .collect();
            *binary_frames = agreed.contains(&BINARY_FRAMES);
            if !agreed.is_empty() {
                reply["capabilities"] = json!(agreed);
            }
        }
        outcome
    }

    fn hello(&mut self, frame: &Value, context: CeremonyContext<'_>) -> CeremonyOutcome {
        if frame["type"] != "pair:hello" {
            return rejected("internal", "expected pair:hello");
        }
        if frame["protocolVersion"].as_u64() != Some(PAIR_PROTOCOL_VERSION) {
            return rejected(
                "protocol-version-mismatch",
                "this phone app and the Komla companion on this host differ in version",
            );
        }
        let device_id = frame["deviceId"].as_str().unwrap_or_default();
        let Some(capabilities) = hello_capabilities(frame) else {
            return rejected("internal", "the hello's capabilities are malformed");
        };
        self.capabilities = capabilities;
        match frame["mode"].as_str() {
            Some("authenticate")
                if is_device_id(device_id)
                    && only_keys(
                        frame,
                        &[
                            "type",
                            "protocolVersion",
                            "mode",
                            "deviceId",
                            "capabilities",
                        ],
                    ) =>
            {
                let Some(device) = context.trust.device(device_id, context.now).cloned() else {
                    return rejected(
                        "unknown-device",
                        "this phone may not open this host; open Komla on your computer to renew access",
                    );
                };
                let challenge = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
                let reply = json!({
                    "type": "pair:auth-challenge",
                    "challenge": challenge,
                    "rpId": device.rp_id,
                    "origin": device.origin,
                    "credentialId": device.credential_id,
                });
                self.stage = Stage::AwaitingAuthResponse { device, challenge };
                self.deadline = Some(context.now + PASSKEY_TIMEOUT_MS);
                CeremonyOutcome::Reply(reply)
            }
            Some("resume")
                if is_device_id(device_id)
                    && frame["resumeToken"].as_str().is_some_and(is_resume_token)
                    && only_keys(
                        frame,
                        &[
                            "type",
                            "protocolVersion",
                            "mode",
                            "deviceId",
                            "resumeToken",
                            "capabilities",
                        ],
                    ) =>
            {
                let Some(device) = context.trust.device(device_id, context.now).cloned() else {
                    return rejected(
                        "unknown-device",
                        "this phone may not open this host; open Komla on your computer to renew access",
                    );
                };
                let token = frame["resumeToken"].as_str().unwrap_or_default();
                if context
                    .resume
                    .peek(
                        device_id,
                        token,
                        context.now,
                        context.trust.resume_window_ms(),
                    )
                    .is_none()
                {
                    return rejected(
                        "resume-invalid",
                        "the recent session grant expired or was already used",
                    );
                };
                let challenge = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
                let reply = json!({ "type": "pair:resume-challenge", "challenge": challenge });
                self.stage = Stage::AwaitingResumeResponse {
                    device,
                    challenge,
                    token: token.to_owned(),
                };
                self.deadline = Some(context.now + AUTH_CEREMONY_TIMEOUT_MS);
                CeremonyOutcome::Reply(reply)
            }
            Some("register") => rejected(
                "unsupported-mode",
                "pair this phone with Komla on your computer",
            ),
            _ => rejected("internal", "malformed pair:hello"),
        }
    }

    fn device_signature_ok(
        frame: &Value,
        device: &TrustedDevice,
        purpose: &str,
        challenge: &str,
        channel_binding: &[u8; 32],
    ) -> bool {
        let Some(signature) = frame["deviceSignature"].as_str().and_then(decode_base64) else {
            return false;
        };
        verify_p1363(
            &device.device_public_key,
            &device_proof(purpose, challenge, channel_binding),
            &signature,
        )
    }

    fn auth_response(
        frame: &Value,
        context: CeremonyContext<'_>,
        device: TrustedDevice,
        challenge: &str,
    ) -> CeremonyOutcome {
        if frame["type"] != "pair:auth-response"
            || !only_keys(
                frame,
                &["type", "authenticationResponse", "deviceSignature"],
            )
        {
            return rejected("internal", "expected pair:auth-response");
        }
        let counter = match verify_assertion(
            &frame["authenticationResponse"],
            &ExpectedAssertion {
                challenge,
                origin: &device.origin,
                rp_id: &device.rp_id,
                credential_id: &device.credential_id,
                credential_public_key: &device.credential_public_key,
            },
        ) {
            Ok(counter) => counter,
            Err(message) => return rejected("signature-failed", &message),
        };
        let stored = context
            .counters
            .get(&device.device_id)
            .copied()
            .unwrap_or(0);
        if (stored != 0 || counter != 0) && counter <= stored {
            return rejected(
                "counter-regression",
                &format!("sign counter {counter} did not advance past {stored}"),
            );
        }
        if !Self::device_signature_ok(
            frame,
            &device,
            "authenticate",
            challenge,
            &context.channel_binding,
        ) {
            return rejected(
                "device-signature-failed",
                "the browser installation key did not sign this session",
            );
        }
        context.counters.insert(device.device_id.clone(), counter);
        let verified_at = context.now;
        Self::authenticated(context, device, verified_at)
    }

    fn resume_response(
        frame: &Value,
        context: CeremonyContext<'_>,
        device: TrustedDevice,
        challenge: &str,
        token: &str,
    ) -> CeremonyOutcome {
        if frame["type"] != "pair:resume-response"
            || !only_keys(frame, &["type", "deviceSignature"])
        {
            return rejected("internal", "expected pair:resume-response");
        }
        if !Self::device_signature_ok(
            frame,
            &device,
            "resume",
            challenge,
            &context.channel_binding,
        ) {
            return rejected(
                "device-signature-failed",
                "the browser installation key did not sign this session",
            );
        }
        // Another connection may have redeemed it meanwhile; a grant yields one session.
        let Some(verified_at) = context.resume.consume(
            &device.device_id,
            token,
            context.now,
            context.trust.resume_window_ms(),
        ) else {
            return rejected(
                "resume-invalid",
                "the recent session grant expired or was already used",
            );
        };
        Self::authenticated(context, device, verified_at)
    }

    fn authenticated(
        context: CeremonyContext<'_>,
        device: TrustedDevice,
        verified_at: u64,
    ) -> CeremonyOutcome {
        let grant = context.resume.issue(
            &device.device_id,
            verified_at,
            context.now,
            context.trust.resume_window_ms(),
        );
        let reply = json!({
            "type": "pair:authenticated",
            "deviceId": device.device_id,
            "credentialId": device.credential_id,
            "label": device.label,
            "resumeToken": grant.token,
            "resumeExpiresAt": grant.expires_at,
        });
        CeremonyOutcome::Authenticated {
            device,
            reply,
            resume_token: grant.token,
            binary_frames: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_control::crypto::HostIdentity;
    use crate::remote_control::peer::encode_base64;
    use crate::remote_control::trust::tests::{record, trust_json, ORIGIN};
    use crate::remote_control::webauthn::tests::TestPasskey;

    struct Fixture {
        device: HostIdentity,
        passkey: TestPasskey,
        trust: Trust,
        resume: ResumeStore,
        counters: HashMap<String, u32>,
        binding: [u8; 32],
    }

    impl Fixture {
        fn new() -> Self {
            let device = HostIdentity::generate();
            let passkey = TestPasskey::new();
            let trust = Trust::parse(&trust_json(
                vec![record(device.spki_der(), &passkey.spki())],
                1e12 as u64,
            ))
            .unwrap();
            Self {
                device,
                passkey,
                trust,
                resume: ResumeStore::default(),
                counters: HashMap::new(),
                binding: [7; 32],
            }
        }

        fn run(&mut self, ceremony: &mut Ceremony, frame: Value, now: u64) -> CeremonyOutcome {
            ceremony.handle(
                &frame,
                CeremonyContext {
                    trust: &self.trust,
                    resume: &mut self.resume,
                    counters: &mut self.counters,
                    channel_binding: self.binding,
                    now,
                },
            )
        }

        fn hello(&self) -> Value {
            json!({
                "type": "pair:hello",
                "protocolVersion": 2,
                "mode": "authenticate",
                "deviceId": self.device.fingerprint(),
            })
        }

        fn sign(&self, purpose: &str, challenge: &str, binding: &[u8; 32]) -> String {
            encode_base64(
                &self
                    .device
                    .sign_p1363(&device_proof(purpose, challenge, binding)),
            )
        }

        fn auth_response(&self, challenge: &str, counter: u32, binding: &[u8; 32]) -> Value {
            json!({
                "type": "pair:auth-response",
                "authenticationResponse":
                    self.passkey.assert(challenge, ORIGIN, "mac.tail1.ts.net", 0x05, counter),
                "deviceSignature": self.sign("authenticate", challenge, binding),
            })
        }

        /// Passkey sign-in; returns the resume token.
        fn sign_in(&mut self, counter: u32) -> String {
            let mut ceremony = Ceremony::new();
            let CeremonyOutcome::Reply(challenge) = self.run(&mut ceremony, self.hello(), 10)
            else {
                panic!("expected a challenge");
            };
            let challenge = challenge["challenge"].as_str().unwrap().to_owned();
            let response = self.auth_response(&challenge, counter, &self.binding.clone());
            match self.run(&mut ceremony, response, 20) {
                CeremonyOutcome::Authenticated { resume_token, .. } => resume_token,
                other => panic!("expected sign-in, got {other:?}"),
            }
        }
    }

    fn reason(outcome: CeremonyOutcome) -> String {
        match outcome {
            CeremonyOutcome::Rejected(frame) => frame["reason"].as_str().unwrap().to_owned(),
            other => panic!("expected a rejection, got {other:?}"),
        }
    }

    #[test]
    fn agrees_on_the_capabilities_both_sides_support() {
        for (offered, agreed) in [
            (
                json!(["binary-frames", "from-the-future"]),
                Some(json!(["binary-frames"])),
            ),
            (json!(["from-the-future"]), None),
        ] {
            let mut fixture = Fixture::new();
            let mut ceremony = Ceremony::new();
            let mut hello = fixture.hello();
            hello["capabilities"] = offered;
            let CeremonyOutcome::Reply(challenge) = fixture.run(&mut ceremony, hello, 10) else {
                panic!("expected a challenge");
            };
            let challenge = challenge["challenge"].as_str().unwrap().to_owned();
            let response = fixture.auth_response(&challenge, 0, &fixture.binding.clone());
            let CeremonyOutcome::Authenticated {
                reply,
                binary_frames,
                ..
            } = fixture.run(&mut ceremony, response, 20)
            else {
                panic!("expected sign-in");
            };
            assert_eq!(reply.get("capabilities").cloned(), agreed);
            assert_eq!(binary_frames, agreed.is_some());
        }
    }

    #[test]
    fn refuses_malformed_capabilities() {
        let mut fixture = Fixture::new();
        for capabilities in [json!("binary-frames"), json!([1]), json!(["x".repeat(65)])] {
            let mut hello = fixture.hello();
            hello["capabilities"] = capabilities;
            assert_eq!(
                reason(fixture.run(&mut Ceremony::new(), hello, 10)),
                "internal"
            );
        }
    }

    #[test]
    fn a_connection_that_never_says_hello_times_out() {
        let mut fixture = Fixture::new();
        let ceremony = Ceremony::awaiting_hello_until(100);
        assert!(!ceremony.timed_out(99));
        assert!(ceremony.timed_out(100));

        let mut ceremony = Ceremony::awaiting_hello_until(100);
        let CeremonyOutcome::Reply(_) = fixture.run(&mut ceremony, fixture.hello(), 90) else {
            panic!("expected a challenge");
        };
        assert!(!ceremony.timed_out(100));
        assert!(ceremony.timed_out(90 + PASSKEY_TIMEOUT_MS));
    }

    #[test]
    fn a_trusted_phone_signs_in_with_its_passkey_and_installation_key() {
        let mut fixture = Fixture::new();
        let mut ceremony = Ceremony::new();

        let CeremonyOutcome::Reply(challenge) = fixture.run(&mut ceremony, fixture.hello(), 10)
        else {
            panic!("expected a challenge");
        };
        assert_eq!(challenge["type"], "pair:auth-challenge");
        assert_eq!(challenge["origin"], ORIGIN);
        assert_eq!(challenge["rpId"], "mac.tail1.ts.net");
        // Waiting for a person, so longer than a resume.
        assert!(!ceremony.timed_out(10 + PASSKEY_TIMEOUT_MS - 1));
        assert!(ceremony.timed_out(10 + PASSKEY_TIMEOUT_MS));

        let challenge = challenge["challenge"].as_str().unwrap().to_owned();
        let response = fixture.auth_response(&challenge, 0, &fixture.binding.clone());
        let CeremonyOutcome::Authenticated { device, reply, .. } =
            fixture.run(&mut ceremony, response, 20)
        else {
            panic!("expected sign-in");
        };
        assert_eq!(device.label, "iPhone");
        assert_eq!(reply["type"], "pair:authenticated");
        assert_eq!(reply["resumeToken"].as_str().unwrap().len(), 43);
    }

    #[test]
    fn a_passkey_alone_is_not_enough_without_this_sessions_device_signature() {
        let mut fixture = Fixture::new();
        let mut ceremony = Ceremony::new();
        let CeremonyOutcome::Reply(challenge) = fixture.run(&mut ceremony, fixture.hello(), 10)
        else {
            panic!("expected a challenge");
        };
        let challenge = challenge["challenge"].as_str().unwrap().to_owned();

        let replayed_binding = fixture.auth_response(&challenge, 0, &[9; 32]);

        assert_eq!(
            reason(fixture.run(&mut ceremony, replayed_binding, 20)),
            "device-signature-failed"
        );
    }

    #[test]
    fn rejects_an_untrusted_phone_an_expired_lease_and_enrollment() {
        let mut fixture = Fixture::new();
        let mut stranger = fixture.hello();
        stranger["deviceId"] = Value::String("a".repeat(64));
        assert_eq!(
            reason(fixture.run(&mut Ceremony::new(), stranger, 10)),
            "unknown-device"
        );
        assert_eq!(
            reason(fixture.run(&mut Ceremony::new(), fixture.hello(), 1e12 as u64)),
            "unknown-device"
        );
        let mut register = fixture.hello();
        register["mode"] = Value::String("register".to_owned());
        assert_eq!(
            reason(fixture.run(&mut Ceremony::new(), register, 10)),
            "unsupported-mode"
        );
        let mut old = fixture.hello();
        old["protocolVersion"] = json!(1);
        assert_eq!(
            reason(fixture.run(&mut Ceremony::new(), old, 10)),
            "protocol-version-mismatch"
        );
    }

    #[test]
    fn a_counter_that_does_not_advance_is_rejected() {
        let mut fixture = Fixture::new();
        fixture.sign_in(5);

        let mut ceremony = Ceremony::new();
        let CeremonyOutcome::Reply(challenge) = fixture.run(&mut ceremony, fixture.hello(), 30)
        else {
            panic!("expected a challenge");
        };
        let challenge = challenge["challenge"].as_str().unwrap().to_owned();
        let response = fixture.auth_response(&challenge, 5, &fixture.binding.clone());

        assert_eq!(
            reason(fixture.run(&mut ceremony, response, 40)),
            "counter-regression"
        );
    }

    #[test]
    fn a_released_grant_resumes_once_with_a_fresh_device_signature() {
        let mut fixture = Fixture::new();
        let token = fixture.sign_in(0);
        fixture.resume.release(&token, 50);
        let resume = json!({
            "type": "pair:hello",
            "protocolVersion": 2,
            "mode": "resume",
            "deviceId": fixture.device.fingerprint(),
            "resumeToken": token,
        });

        let mut ceremony = Ceremony::new();
        let CeremonyOutcome::Reply(challenge) = fixture.run(&mut ceremony, resume.clone(), 60)
        else {
            panic!("expected a resume challenge");
        };
        assert_eq!(challenge["type"], "pair:resume-challenge");
        let challenge = challenge["challenge"].as_str().unwrap().to_owned();
        let response = json!({
            "type": "pair:resume-response",
            "deviceSignature": fixture.sign("resume", &challenge, &fixture.binding.clone()),
        });
        let CeremonyOutcome::Authenticated { reply, .. } = fixture.run(&mut ceremony, response, 70)
        else {
            panic!("expected sign-in");
        };
        assert_eq!(reply["resumeExpiresAt"], json!(20 + 8 * 60 * 60 * 1000));

        assert_eq!(
            reason(fixture.run(&mut Ceremony::new(), resume, 80)),
            "resume-invalid"
        );
    }

    #[test]
    fn a_resume_that_drops_before_its_proof_leaves_the_grant_for_one_attempt() {
        let mut fixture = Fixture::new();
        let token = fixture.sign_in(0);
        fixture.resume.release(&token, 50);
        let resume = json!({
            "type": "pair:hello",
            "protocolVersion": 2,
            "mode": "resume",
            "deviceId": fixture.device.fingerprint(),
            "resumeToken": token,
        });
        let challenge = |outcome: CeremonyOutcome| {
            let CeremonyOutcome::Reply(challenge) = outcome else {
                panic!("expected a resume challenge");
            };
            challenge["challenge"].as_str().unwrap().to_owned()
        };

        // The first attempt's connection dropped after the challenge.
        challenge(fixture.run(&mut Ceremony::new(), resume.clone(), 60));
        let mut second = Ceremony::new();
        let second_challenge = challenge(fixture.run(&mut second, resume.clone(), 70));
        let mut third = Ceremony::new();
        let third_challenge = challenge(fixture.run(&mut third, resume, 75));

        let binding = fixture.binding;
        let response = |fixture: &Fixture, challenge: &str| {
            json!({
                "type": "pair:resume-response",
                "deviceSignature": fixture.sign("resume", challenge, &binding),
            })
        };
        let second_response = response(&fixture, &second_challenge);
        let CeremonyOutcome::Authenticated { .. } = fixture.run(&mut second, second_response, 80)
        else {
            panic!("expected sign-in");
        };
        let third_response = response(&fixture, &third_challenge);
        assert_eq!(
            reason(fixture.run(&mut third, third_response, 85)),
            "resume-invalid"
        );
    }

    #[test]
    fn a_resume_signature_over_another_purpose_is_rejected() {
        let mut fixture = Fixture::new();
        let token = fixture.sign_in(0);
        fixture.resume.release(&token, 50);
        let mut ceremony = Ceremony::new();
        let CeremonyOutcome::Reply(challenge) = fixture.run(
            &mut ceremony,
            json!({
                "type": "pair:hello",
                "protocolVersion": 2,
                "mode": "resume",
                "deviceId": fixture.device.fingerprint(),
                "resumeToken": token,
            }),
            60,
        ) else {
            panic!("expected a resume challenge");
        };
        let challenge = challenge["challenge"].as_str().unwrap().to_owned();
        let response = json!({
            "type": "pair:resume-response",
            "deviceSignature": fixture.sign("authenticate", &challenge, &fixture.binding.clone()),
        });

        assert_eq!(
            reason(fixture.run(&mut ceremony, response, 70)),
            "device-signature-failed"
        );
    }
}
