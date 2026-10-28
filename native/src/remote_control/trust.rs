//! The phones a desktop lets reach this host, copied from its trusted-device registry over SSH.
//! The desktop rewrites the file whenever a phone is added or removed and renews `expiresAt` each
//! time it connects; once the lease runs out the host trusts no phone from that desktop.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context};
use serde::Deserialize;

use super::crypto::{fingerprint, public_key_from_spki};
use super::peer::decode_base64;
use super::resume::DEFAULT_RESUME_WINDOW_MS;

const TRUST_FILE_VERSION: u32 = 1;
const MAX_TRUST_FILE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustFile {
    version: u32,
    /// Milliseconds since the epoch.
    expires_at: u64,
    /// How long a phone that left may come back without its passkey.
    #[serde(default)]
    resume_window_ms: Option<u64>,
    devices: Vec<TrustedDeviceRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedDeviceRecord {
    device_id: String,
    /// Standard base64 SPKI of the browser installation key.
    device_public_key: String,
    /// base64url passkey credential id.
    credential_id: String,
    /// Standard base64 SPKI of the passkey's ES256 public key.
    credential_public_key: String,
    label: String,
    rp_id: String,
    origin: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TrustedDevice {
    pub(crate) device_id: String,
    pub(crate) device_public_key: Vec<u8>,
    pub(crate) credential_id: String,
    pub(crate) credential_public_key: Vec<u8>,
    pub(crate) label: String,
    pub(crate) rp_id: String,
    pub(crate) origin: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Trust {
    devices: Vec<TrustedDevice>,
    expires_at: u64,
    resume_window_ms: Option<u64>,
}

impl Trust {
    pub(crate) fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let file: TrustFile =
            serde_json::from_slice(bytes).context("phone trust file is malformed")?;
        if file.version != TRUST_FILE_VERSION {
            bail!("phone trust file version {} is not supported", file.version);
        }
        let devices = file
            .devices
            .into_iter()
            .map(TrustedDevice::from_record)
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self {
            devices,
            expires_at: file.expires_at,
            resume_window_ms: file.resume_window_ms,
        })
    }

    /// Settings → Remote → "Ask for passkey again after" on the desktop.
    pub(crate) fn resume_window_ms(&self) -> u64 {
        self.resume_window_ms.unwrap_or(DEFAULT_RESUME_WINDOW_MS)
    }

    /// The device with `device_id`, unless the lease has run out.
    pub(crate) fn device(&self, device_id: &str, now_ms: u64) -> Option<&TrustedDevice> {
        if now_ms >= self.expires_at {
            return None;
        }
        self.devices
            .iter()
            .find(|device| device.device_id == device_id)
    }

    /// Browser origins a WebSocket upgrade may come from: those of the trusted phones.
    pub(crate) fn allows_origin(&self, origin: &str, now_ms: u64) -> bool {
        now_ms < self.expires_at && self.devices.iter().any(|device| device.origin == origin)
    }
}

/// The trust file's bytes, or None when there is none, which trusts nobody.
fn read_trust_file(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("could not read the phone trust file"),
    };
    if metadata.len() > MAX_TRUST_FILE_BYTES {
        bail!("phone trust file is too large");
    }
    Ok(Some(
        fs::read(path).context("could not read the phone trust file")?,
    ))
}

/// The last good copy of the trust file, reread whenever its contents change.
#[derive(Default)]
pub(crate) struct TrustFileCache {
    trust: Trust,
    bytes: Option<Vec<u8>>,
}

impl TrustFileCache {
    /// The trust file as of now. Compared by content: two rewrites within the filesystem's
    /// timestamp granularity share a modification time. A file the desktop is mid-way through
    /// replacing keeps the last good copy.
    pub(crate) fn current(&mut self, path: &Path) -> Trust {
        let reloaded = read_trust_file(path).and_then(|bytes| {
            if bytes.is_some() && bytes == self.bytes {
                return Ok(None);
            }
            let trust = bytes
                .as_deref()
                .map_or_else(|| Ok(Trust::default()), Trust::parse)?;
            Ok(Some((trust, bytes)))
        });
        match reloaded {
            Ok(Some((trust, bytes))) => {
                self.trust = trust;
                self.bytes = bytes;
            }
            Ok(None) => {}
            Err(error) => eprintln!("phone trust file not reloaded: {error:#}"),
        }
        self.trust.clone()
    }
}

/// HTTPS, with plain-HTTP localhost as the development exception the desktop also makes.
fn is_allowed_origin(origin: &str) -> bool {
    if origin.starts_with("https://") {
        return true;
    }
    let Some(rest) = origin
        .strip_prefix("http://localhost:")
        .or_else(|| origin.strip_prefix("http://127.0.0.1:"))
    else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

impl TrustedDevice {
    fn from_record(record: TrustedDeviceRecord) -> anyhow::Result<Self> {
        let device_public_key =
            decode_base64(&record.device_public_key).context("devicePublicKey is not base64")?;
        public_key_from_spki(&device_public_key).context("devicePublicKey")?;
        if fingerprint(&device_public_key) != record.device_id {
            bail!("deviceId does not match devicePublicKey");
        }
        let credential_public_key = decode_base64(&record.credential_public_key)
            .context("credentialPublicKey is not base64")?;
        public_key_from_spki(&credential_public_key).context("credentialPublicKey")?;
        if record.credential_id.is_empty() || record.label.is_empty() || record.rp_id.is_empty() {
            bail!("trusted phone record is incomplete");
        }
        if !is_allowed_origin(&record.origin) {
            bail!("trusted phone origin must be https (or localhost while developing)");
        }
        Ok(Self {
            device_id: record.device_id,
            device_public_key,
            credential_id: record.credential_id,
            credential_public_key,
            label: record.label,
            rp_id: record.rp_id,
            origin: record.origin,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote_control::crypto::HostIdentity;
    use crate::remote_control::peer::encode_base64;

    pub(crate) const ORIGIN: &str = "https://mac.tail1.ts.net";

    pub(crate) fn record(device_key: &[u8], credential_key: &[u8]) -> serde_json::Value {
        serde_json::json!({
            "deviceId": fingerprint(device_key),
            "devicePublicKey": encode_base64(device_key),
            "credentialId": "Y3JlZGVudGlhbC0x",
            "credentialPublicKey": encode_base64(credential_key),
            "label": "iPhone",
            "rpId": "mac.tail1.ts.net",
            "origin": ORIGIN,
        })
    }

    pub(crate) fn trust_json(devices: Vec<serde_json::Value>, expires_at: u64) -> Vec<u8> {
        serde_json::json!({ "version": 1, "expiresAt": expires_at, "devices": devices })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn finds_trusted_phones_until_the_lease_runs_out() {
        let device = HostIdentity::generate();
        let credential = HostIdentity::generate();
        let trust = Trust::parse(&trust_json(
            vec![record(device.spki_der(), credential.spki_der())],
            1_000,
        ))
        .unwrap();

        let found = trust.device(&device.fingerprint(), 999).unwrap();
        assert_eq!(found.label, "iPhone");
        assert!(trust.allows_origin(ORIGIN, 999));
        assert!(!trust.allows_origin("https://other.ts.net", 999));
        assert!(trust.device(&device.fingerprint(), 1_000).is_none());
        assert!(!trust.allows_origin(ORIGIN, 1_000));
    }

    #[test]
    fn rejects_records_that_do_not_hold_together() {
        let device = HostIdentity::generate();
        let credential = HostIdentity::generate();
        let mut wrong_id = record(device.spki_der(), credential.spki_der());
        wrong_id["deviceId"] = serde_json::Value::String("0".repeat(64));
        let mut plain_origin = record(device.spki_der(), credential.spki_der());
        plain_origin["origin"] = serde_json::Value::String("http://mac.tail1.ts.net".to_owned());
        let mut localhost_path = record(device.spki_der(), credential.spki_der());
        localhost_path["origin"] =
            serde_json::Value::String("http://localhost:52864/remote".to_owned());
        let mut bad_key = record(device.spki_der(), credential.spki_der());
        bad_key["credentialPublicKey"] = serde_json::Value::String("AAAA".to_owned());

        let mut localhost = record(device.spki_der(), credential.spki_der());
        localhost["origin"] = serde_json::Value::String("http://localhost:52864".to_owned());
        assert!(Trust::parse(&trust_json(vec![localhost], u64::MAX)).is_ok());

        for record in [wrong_id, plain_origin, localhost_path, bad_key] {
            assert!(Trust::parse(&trust_json(vec![record], u64::MAX)).is_err());
        }
        assert!(Trust::parse(br#"{"version":2,"expiresAt":1,"devices":[]}"#).is_err());
    }

    #[test]
    fn reads_the_desktops_passkey_window() {
        let mut file: serde_json::Value =
            serde_json::from_slice(&trust_json(Vec::new(), u64::MAX)).unwrap();
        assert_eq!(
            Trust::parse(file.to_string().as_bytes())
                .unwrap()
                .resume_window_ms(),
            DEFAULT_RESUME_WINDOW_MS
        );

        file["resumeWindowMs"] = serde_json::json!(3_600_000);
        assert_eq!(
            Trust::parse(file.to_string().as_bytes())
                .unwrap()
                .resume_window_ms(),
            3_600_000
        );
    }

    #[test]
    fn rereads_a_rewrite_that_kept_the_modification_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trust.json");
        let first = HostIdentity::generate();
        let second = HostIdentity::generate();
        let credential = HostIdentity::generate();
        let write = |device: &HostIdentity| {
            fs::write(
                &path,
                trust_json(
                    vec![record(device.spki_der(), credential.spki_der())],
                    u64::MAX,
                ),
            )
            .unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_modified(std::time::SystemTime::UNIX_EPOCH))
                .unwrap();
        };
        let mut cache = TrustFileCache::default();

        write(&first);
        assert!(cache
            .current(&path)
            .device(&first.fingerprint(), 0)
            .is_some());
        write(&second);
        let trust = cache.current(&path);

        assert!(trust.device(&first.fingerprint(), 0).is_none());
        assert!(trust.device(&second.fingerprint(), 0).is_some());
        fs::write(&path, b"{").unwrap();
        assert!(cache
            .current(&path)
            .device(&second.fingerprint(), 0)
            .is_some());
        fs::remove_file(&path).unwrap();
        assert_eq!(cache.current(&path), Trust::default());
    }

    #[test]
    fn a_missing_file_trusts_nobody() {
        let dir = tempfile::tempdir().unwrap();

        let trust = TrustFileCache::default().current(&dir.path().join("trust.json"));

        assert_eq!(trust, Trust::default());
    }
}
