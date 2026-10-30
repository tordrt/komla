//! The secure-channel primitives of `packages/remote-protocol`, byte for byte, so a phone can
//! authenticate this host exactly as it authenticates the desktop. Any change here must match
//! `packages/remote-protocol/src/crypto/` (see `tests/remote_control_protocol.rs`).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context};
use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use p256::PublicKey;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

const HANDSHAKE_CONTEXT: &[u8] = b"komla/remote-secure-channel/v2";
const SESSION_KEY_INFO: &[u8] = b"komla-remote-protocol/v1/session-key";
const DEVICE_PROOF_CONTEXT: &[u8] = b"komla/trusted-remote-device/v2";
const PASSKEY_CHALLENGE_CONTEXT: &[u8] = b"komla/passkey-challenge/v1";

pub(crate) const NONCE_BYTES: usize = 12;
pub(crate) const DIRECTION_DESKTOP_TO_CLIENT: u8 = 0x01;
pub(crate) const DIRECTION_CLIENT_TO_DESKTOP: u8 = 0x02;

pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// `SHA-256(SPKI-DER)` as lowercase hex: the install fingerprint and the device id.
pub(crate) fn fingerprint(spki_der: &[u8]) -> String {
    sha256(spki_der)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn length_prefixed(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|part| 4 + part.len()).sum());
    for part in parts {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(part);
    }
    out
}

pub(crate) fn handshake_transcript(
    client_ephemeral: &[u8],
    desktop_ephemeral: &[u8],
    desktop_identity: &[u8],
) -> Vec<u8> {
    length_prefixed(&[
        HANDSHAKE_CONTEXT,
        client_ephemeral,
        desktop_ephemeral,
        desktop_identity,
    ])
}

/// The bytes a trusted browser signs with its installation key.
pub(crate) fn device_proof(purpose: &str, challenge: &str, channel_binding: &[u8; 32]) -> Vec<u8> {
    length_prefixed(&[
        DEVICE_PROOF_CONTEXT,
        purpose.as_bytes(),
        challenge.as_bytes(),
        channel_binding,
    ])
}

/// What a passkey signs for a challenge: tied to this encrypted session, and so to this host's key,
/// so another endpoint can't pass a signature it was given on to this one.
pub(crate) fn passkey_challenge(challenge: &str, channel_binding: &[u8; 32]) -> [u8; 32] {
    sha256(&length_prefixed(&[
        PASSKEY_CHALLENGE_CONTEXT,
        challenge.as_bytes(),
        channel_binding,
    ]))
}

pub(crate) fn public_key_from_spki(spki_der: &[u8]) -> anyhow::Result<PublicKey> {
    PublicKey::from_public_key_der(spki_der).map_err(|_| anyhow!("not a P-256 SPKI public key"))
}

/// ECDSA-P256/SHA-256 over `data` with an IEEE-P1363 (`r || s`) signature, as WebCrypto signs.
pub(crate) fn verify_p1363(spki_der: &[u8], data: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = VerifyingKey::from_public_key_der(spki_der) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify(data, &signature).is_ok()
}

/// ECDSA-P256/SHA-256 with an ASN.1 DER signature, as WebAuthn authenticators sign.
pub(crate) fn verify_der(spki_der: &[u8], data: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = VerifyingKey::from_public_key_der(spki_der) else {
        return false;
    };
    let Ok(signature) = Signature::from_der(signature) else {
        return false;
    };
    key.verify(data, &signature).is_ok()
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// This host's long-term signing key, the counterpart of the desktop's install key.
pub(crate) struct HostIdentity {
    key: SigningKey,
    spki_der: Vec<u8>,
}

impl HostIdentity {
    pub(crate) fn generate() -> Self {
        Self::from_signing_key(SigningKey::random(&mut OsRng))
    }

    pub(crate) fn from_secret_bytes(secret: &[u8]) -> anyhow::Result<Self> {
        let key = SigningKey::from_slice(secret).context("invalid host identity key")?;
        Ok(Self::from_signing_key(key))
    }

    fn from_signing_key(key: SigningKey) -> Self {
        let spki_der = PublicKey::from(key.verifying_key())
            .to_public_key_der()
            .expect("a P-256 public key always encodes")
            .into_vec();
        Self { key, spki_der }
    }

    pub(crate) fn secret_bytes(&self) -> Vec<u8> {
        self.key.to_bytes().to_vec()
    }

    pub(crate) fn spki_der(&self) -> &[u8] {
        &self.spki_der
    }

    pub(crate) fn fingerprint(&self) -> String {
        fingerprint(&self.spki_der)
    }

    pub(crate) fn sign_p1363(&self, data: &[u8]) -> Vec<u8> {
        let signature: Signature = self.key.sign(data);
        signature.to_bytes().to_vec()
    }
}

/// One handshake's ephemeral ECDH key.
pub(crate) struct Ephemeral {
    secret: EphemeralSecret,
    spki_der: Vec<u8>,
}

impl Ephemeral {
    pub(crate) fn generate() -> Self {
        let secret = EphemeralSecret::random(&mut OsRng);
        let spki_der = secret
            .public_key()
            .to_public_key_der()
            .expect("a P-256 public key always encodes")
            .into_vec();
        Self { secret, spki_der }
    }

    pub(crate) fn spki_der(&self) -> &[u8] {
        &self.spki_der
    }

    /// HKDF-SHA256 over the ECDH x-coordinate, salted with the transcript hash, as
    /// `deriveSessionKey` does with WebCrypto.
    pub(crate) fn derive_session_key(
        &self,
        peer_spki_der: &[u8],
        transcript_hash: &[u8; 32],
    ) -> anyhow::Result<SessionKey> {
        let peer = public_key_from_spki(peer_spki_der)?;
        let shared = self.secret.diffie_hellman(&peer);
        let hkdf = Hkdf::<Sha256>::new(Some(transcript_hash), shared.raw_secret_bytes());
        let mut key = [0u8; 32];
        hkdf.expand(SESSION_KEY_INFO, &mut key)
            .map_err(|_| anyhow!("session key derivation failed"))?;
        Ok(SessionKey::new(&key))
    }
}

/// AES-256-GCM with the protocol's `[direction | seq BE | random(7)]` nonces.
pub(crate) struct SessionKey {
    cipher: Aes256Gcm,
}

impl SessionKey {
    pub(crate) fn new(key: &[u8; 32]) -> Self {
        Self {
            cipher: Aes256Gcm::new(key.into()),
        }
    }

    pub(crate) fn encrypt(
        &self,
        direction: u8,
        seq: u32,
        plaintext: &[u8],
    ) -> anyhow::Result<([u8; NONCE_BYTES], Vec<u8>)> {
        let mut nonce = [0u8; NONCE_BYTES];
        nonce[0] = direction;
        nonce[1..5].copy_from_slice(&seq.to_be_bytes());
        OsRng.fill_bytes(&mut nonce[5..]);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| anyhow!("encryption failed"))?;
        Ok((nonce, ciphertext))
    }

    pub(crate) fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> anyhow::Result<Vec<u8>> {
        if nonce.len() != NONCE_BYTES {
            bail!("nonce must be {NONCE_BYTES} bytes");
        }
        self.cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| anyhow!("decryption failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_is_length_prefixed_in_wire_order() {
        let transcript = handshake_transcript(b"c", b"dd", b"");

        let mut expected = Vec::new();
        expected.extend_from_slice(&(HANDSHAKE_CONTEXT.len() as u32).to_be_bytes());
        expected.extend_from_slice(HANDSHAKE_CONTEXT);
        expected.extend_from_slice(&[0, 0, 0, 1, b'c', 0, 0, 0, 2, b'd', b'd', 0, 0, 0, 0]);
        assert_eq!(transcript, expected);
    }

    #[test]
    fn both_sides_derive_the_same_session_key() {
        let client = Ephemeral::generate();
        let host = Ephemeral::generate();
        let hash = sha256(b"transcript");

        let client_key = client.derive_session_key(host.spki_der(), &hash).unwrap();
        let host_key = host.derive_session_key(client.spki_der(), &hash).unwrap();
        let (nonce, ciphertext) = client_key
            .encrypt(DIRECTION_CLIENT_TO_DESKTOP, 7, b"hello")
            .unwrap();

        assert_eq!(nonce[0], DIRECTION_CLIENT_TO_DESKTOP);
        assert_eq!(&nonce[1..5], &7u32.to_be_bytes());
        assert_eq!(host_key.decrypt(&nonce, &ciphertext).unwrap(), b"hello");
        let other = host
            .derive_session_key(client.spki_der(), &sha256(b"other"))
            .unwrap();
        assert!(other.decrypt(&nonce, &ciphertext).is_err());
    }

    #[test]
    fn identity_signatures_verify_in_p1363_form_and_survive_a_reload() {
        let identity = HostIdentity::generate();
        let signature = identity.sign_p1363(b"data");

        assert_eq!(signature.len(), 64);
        assert!(verify_p1363(identity.spki_der(), b"data", &signature));
        assert!(!verify_p1363(identity.spki_der(), b"other", &signature));
        let reloaded = HostIdentity::from_secret_bytes(&identity.secret_bytes()).unwrap();
        assert_eq!(reloaded.fingerprint(), identity.fingerprint());
        assert_eq!(identity.spki_der().len(), 91);
    }

    #[test]
    fn rejects_keys_that_are_not_p256_spki() {
        assert!(public_key_from_spki(&[0x30, 0x00]).is_err());
        assert!(!verify_p1363(&[1, 2, 3], b"data", &[0; 64]));
        assert!(!verify_der(&[1, 2, 3], b"data", &[0x30, 0x00]));
    }
}
