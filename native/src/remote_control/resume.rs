//! Rotating resume grants with the desktop's rules (`src/main/lib/remote-session-resumption.ts`):
//! a grant works once, for the desktop's passkey window after the connection that received it
//! ends, and never more than eight hours after the device last passed passkey verification. It
//! also works while that connection still looks open after a silent network drop; signing in
//! replaces that connection. A sign-in that drops before its proof verifies leaves the grant.

use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use super::crypto::random_bytes;

/// The desktop's default "Ask for passkey again after", for a trust file that doesn't say.
pub(crate) const DEFAULT_RESUME_WINDOW_MS: u64 = 15 * 60 * 1000;
pub(crate) const RESUME_MAX_AGE_MS: u64 = 8 * 60 * 60 * 1000;

struct Grant {
    device_id: String,
    verified_at: u64,
    released_at: Option<u64>,
}

pub(crate) struct ResumeGrant {
    pub(crate) token: String,
    pub(crate) expires_at: u64,
}

#[derive(Default)]
pub(crate) struct ResumeStore {
    grants: HashMap<String, Grant>,
}

impl ResumeStore {
    pub(crate) fn issue(
        &mut self,
        device_id: &str,
        verified_at: u64,
        now: u64,
        window_ms: u64,
    ) -> ResumeGrant {
        self.grants
            .retain(|_, grant| deadline(grant, window_ms) > now);
        let token = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
        self.grants.insert(
            token.clone(),
            Grant {
                device_id: device_id.to_owned(),
                verified_at,
                released_at: None,
            },
        );
        ResumeGrant {
            token,
            expires_at: verified_at + RESUME_MAX_AGE_MS,
        }
    }

    pub(crate) fn release(&mut self, token: &str, now: u64) {
        if let Some(grant) = self.grants.get_mut(token) {
            grant.released_at.get_or_insert(now);
        }
    }

    /// When the device last passed passkey verification, if the grant still works, without
    /// using it up.
    pub(crate) fn peek(
        &mut self,
        device_id: &str,
        token: &str,
        now: u64,
        window_ms: u64,
    ) -> Option<u64> {
        let grant = self.grants.get(token)?;
        if deadline(grant, window_ms) <= now {
            self.grants.remove(token);
            return None;
        }
        (grant.device_id == device_id).then_some(grant.verified_at)
    }

    /// Redeems a grant once, returning when the device last passed passkey verification.
    pub(crate) fn consume(
        &mut self,
        device_id: &str,
        token: &str,
        now: u64,
        window_ms: u64,
    ) -> Option<u64> {
        let verified_at = self.peek(device_id, token, now, window_ms)?;
        self.grants.remove(token);
        Some(verified_at)
    }

    pub(crate) fn revoke_others(&mut self, keep: impl Fn(&str) -> bool) {
        self.grants.retain(|_, grant| keep(&grant.device_id));
    }
}

fn deadline(grant: &Grant, window_ms: u64) -> u64 {
    let max_age = grant.verified_at + RESUME_MAX_AGE_MS;
    match grant.released_at {
        Some(released) => max_age.min(released + window_ms),
        None => max_age,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u64 = 2 * 60 * 1000;

    #[test]
    fn a_grant_works_once_within_its_window_after_its_connection_ends() {
        let mut store = ResumeStore::default();
        let grant = store.issue("phone", 1_000, 1_000, W);

        store.release(&grant.token, 5_000);
        assert_eq!(store.consume("tablet", &grant.token, 6_000, W), None);
        assert_eq!(store.consume("phone", &grant.token, 6_000, W), Some(1_000));
        assert_eq!(store.consume("phone", &grant.token, 6_000, W), None);

        let late = store.issue("phone", 1_000, 1_000, W);
        store.release(&late.token, 10_000);
        assert_eq!(store.consume("phone", &late.token, 10_000 + W, W), None);
    }

    #[test]
    fn peeking_leaves_the_grant_for_the_attempt_that_finishes() {
        let mut store = ResumeStore::default();
        let grant = store.issue("phone", 1_000, 1_000, W);
        store.release(&grant.token, 5_000);

        assert_eq!(store.peek("tablet", &grant.token, 6_000, W), None);
        assert_eq!(store.peek("phone", &grant.token, 6_000, W), Some(1_000));
        assert_eq!(store.peek("phone", &grant.token, 6_000, W), Some(1_000));
        assert_eq!(store.consume("phone", &grant.token, 6_000, W), Some(1_000));
        assert_eq!(store.peek("phone", &grant.token, 6_000, W), None);
    }

    #[test]
    fn a_grant_works_while_its_connection_has_not_noticed_it_dropped() {
        let mut store = ResumeStore::default();
        let grant = store.issue("phone", 1_000, 1_000, W);

        assert_eq!(store.consume("phone", &grant.token, 2_000, W), Some(1_000));
        assert_eq!(store.consume("phone", &grant.token, 2_000, W), None);
    }

    #[test]
    fn a_grant_never_outlives_eight_hours_since_the_passkey() {
        let mut store = ResumeStore::default();
        let grant = store.issue("phone", 0, RESUME_MAX_AGE_MS - 10, W);
        store.release(&grant.token, RESUME_MAX_AGE_MS - 5);

        assert_eq!(grant.expires_at, RESUME_MAX_AGE_MS);
        assert_eq!(
            store.consume("phone", &grant.token, RESUME_MAX_AGE_MS, W),
            None
        );
    }

    #[test]
    fn revoking_a_device_drops_its_grants() {
        let mut store = ResumeStore::default();
        let phone = store.issue("phone", 0, 0, W);
        let tablet = store.issue("tablet", 0, 0, W);
        store.release(&phone.token, 1);
        store.release(&tablet.token, 1);

        store.revoke_others(|device| device == "tablet");

        assert_eq!(store.consume("phone", &phone.token, 2, W), None);
        assert_eq!(store.consume("tablet", &tablet.token, 2, W), Some(0));
    }
}
