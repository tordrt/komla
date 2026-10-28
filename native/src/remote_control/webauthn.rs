//! Verifies a WebAuthn assertion against a passkey the desktop registered, with the checks
//! `@simplewebauthn/server`'s `verifyAuthenticationResponse` makes for the desktop. Only ES256
//! credentials are supported; the desktop sends their public keys as SPKI.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use super::crypto::{sha256, verify_der};

const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;
const AUTHENTICATOR_DATA_MIN_BYTES: usize = 37;

pub(crate) struct ExpectedAssertion<'a> {
    pub(crate) challenge: &'a str,
    pub(crate) origin: &'a str,
    pub(crate) rp_id: &'a str,
    pub(crate) credential_id: &'a str,
    pub(crate) credential_public_key: &'a [u8],
}

pub(crate) fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')).ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssertionResponse {
    id: String,
    raw_id: String,
    #[serde(rename = "type")]
    kind: String,
    response: AssertionBody,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssertionBody {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    authenticator_data: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(default)]
    cross_origin: Option<bool>,
}

/// Returns the authenticator's signature counter when every check passes.
pub(crate) fn verify_assertion(
    response: &Value,
    expected: &ExpectedAssertion<'_>,
) -> Result<u32, String> {
    let response: AssertionResponse = serde_json::from_value(response.clone())
        .map_err(|_| "authentication response is malformed".to_owned())?;
    if response.kind != "public-key" {
        return Err("credential type is not public-key".to_owned());
    }
    if response.id != response.raw_id || response.id != expected.credential_id {
        return Err("assertion is for a different passkey".to_owned());
    }

    let client_data_bytes = decode_base64url(&response.response.client_data_json)
        .ok_or("clientDataJSON is not base64url")?;
    let client_data: ClientData = serde_json::from_slice(&client_data_bytes)
        .map_err(|_| "clientDataJSON is malformed".to_owned())?;
    if client_data.kind != "webauthn.get" {
        return Err(format!("unexpected client data type {}", client_data.kind));
    }
    if client_data.challenge != expected.challenge {
        return Err("challenge does not match".to_owned());
    }
    if client_data.origin != expected.origin {
        return Err(format!("unexpected origin {}", client_data.origin));
    }
    if client_data.cross_origin == Some(true) {
        return Err("cross-origin assertions are not accepted".to_owned());
    }

    let authenticator_data = decode_base64url(&response.response.authenticator_data)
        .ok_or("authenticatorData is not base64url")?;
    if authenticator_data.len() < AUTHENTICATOR_DATA_MIN_BYTES {
        return Err("authenticatorData is too short".to_owned());
    }
    if authenticator_data[..32] != sha256(expected.rp_id.as_bytes()) {
        return Err("RP ID hash does not match".to_owned());
    }
    let flags = authenticator_data[32];
    if flags & FLAG_USER_PRESENT == 0 {
        return Err("user was not present".to_owned());
    }
    if flags & FLAG_USER_VERIFIED == 0 {
        return Err("user was not verified".to_owned());
    }
    let counter = u32::from_be_bytes(
        authenticator_data[33..37]
            .try_into()
            .expect("slice is four bytes"),
    );

    let signature =
        decode_base64url(&response.response.signature).ok_or("signature is not base64url")?;
    let mut signed = authenticator_data;
    signed.extend_from_slice(&sha256(&client_data_bytes));
    if !verify_der(expected.credential_public_key, &signed, &signature) {
        return Err("passkey signature does not verify".to_owned());
    }
    Ok(counter)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{DerSignature, SigningKey};
    use p256::pkcs8::EncodePublicKey;
    use rand_core::OsRng;

    /// A software passkey that signs assertions the way an authenticator does.
    pub(crate) struct TestPasskey {
        pub(crate) key: SigningKey,
        pub(crate) credential_id: String,
    }

    impl TestPasskey {
        pub(crate) fn new() -> Self {
            Self {
                key: SigningKey::random(&mut OsRng),
                credential_id: URL_SAFE_NO_PAD.encode(b"credential-1"),
            }
        }

        pub(crate) fn spki(&self) -> Vec<u8> {
            p256::PublicKey::from(self.key.verifying_key())
                .to_public_key_der()
                .unwrap()
                .into_vec()
        }

        pub(crate) fn assert(
            &self,
            challenge: &str,
            origin: &str,
            rp_id: &str,
            flags: u8,
            counter: u32,
        ) -> Value {
            let client_data = serde_json::json!({
                "type": "webauthn.get",
                "challenge": challenge,
                "origin": origin,
                "crossOrigin": false,
            })
            .to_string();
            let mut authenticator_data = sha256(rp_id.as_bytes()).to_vec();
            authenticator_data.push(flags);
            authenticator_data.extend_from_slice(&counter.to_be_bytes());
            let mut signed = authenticator_data.clone();
            signed.extend_from_slice(&sha256(client_data.as_bytes()));
            let signature: DerSignature = self.key.sign(&signed);
            serde_json::json!({
                "id": self.credential_id,
                "rawId": self.credential_id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": URL_SAFE_NO_PAD.encode(client_data),
                    "authenticatorData": URL_SAFE_NO_PAD.encode(&authenticator_data),
                    "signature": URL_SAFE_NO_PAD.encode(signature.as_bytes()),
                },
                "clientExtensionResults": {},
            })
        }
    }

    const ORIGIN: &str = "https://mac.tail1.ts.net";
    const RP_ID: &str = "mac.tail1.ts.net";

    fn check(passkey: &TestPasskey, response: &Value, challenge: &str) -> Result<u32, String> {
        let spki = passkey.spki();
        verify_assertion(
            response,
            &ExpectedAssertion {
                challenge,
                origin: ORIGIN,
                rp_id: RP_ID,
                credential_id: &passkey.credential_id,
                credential_public_key: &spki,
            },
        )
    }

    #[test]
    fn accepts_a_user_verified_assertion_and_returns_its_counter() {
        let passkey = TestPasskey::new();
        let response = passkey.assert("abc", ORIGIN, RP_ID, 0x05, 9);

        assert_eq!(check(&passkey, &response, "abc"), Ok(9));
    }

    #[test]
    fn rejects_assertions_for_another_challenge_origin_rp_or_without_verification() {
        let passkey = TestPasskey::new();

        for (response, challenge) in [
            (passkey.assert("abc", ORIGIN, RP_ID, 0x05, 0), "other"),
            (
                passkey.assert("abc", "https://evil.ts.net", RP_ID, 0x05, 0),
                "abc",
            ),
            (passkey.assert("abc", ORIGIN, "evil.ts.net", 0x05, 0), "abc"),
            (passkey.assert("abc", ORIGIN, RP_ID, 0x01, 0), "abc"),
            (passkey.assert("abc", ORIGIN, RP_ID, 0x04, 0), "abc"),
        ] {
            assert!(check(&passkey, &response, challenge).is_err());
        }
    }

    #[test]
    fn rejects_a_signature_from_another_key_or_over_changed_data() {
        let passkey = TestPasskey::new();
        let impostor = TestPasskey::new();
        assert!(check(
            &passkey,
            &impostor.assert("abc", ORIGIN, RP_ID, 0x05, 0),
            "abc"
        )
        .is_err());

        let mut response = passkey.assert("abc", ORIGIN, RP_ID, 0x05, 0);
        let mut data =
            decode_base64url(response["response"]["authenticatorData"].as_str().unwrap()).unwrap();
        data[36] ^= 1;
        response["response"]["authenticatorData"] = Value::String(URL_SAFE_NO_PAD.encode(data));
        assert!(check(&passkey, &response, "abc").is_err());
    }

    #[test]
    fn rejects_another_credential_id() {
        let passkey = TestPasskey::new();
        let mut response = passkey.assert("abc", ORIGIN, RP_ID, 0x05, 0);
        response["id"] = Value::String("b3RoZXI".to_owned());
        response["rawId"] = Value::String("b3RoZXI".to_owned());

        assert!(check(&passkey, &response, "abc").is_err());
    }
}
