//! What fits in one encrypted frame (`wire/frame-budget.ts`). The phone ends the session on a
//! frame longer than `MAX_FRAME_CHARS`, so frames are sized by their encoded bytes before they are
//! sealed: an ESC is 6 bytes in JSON, and base64 grows the ciphertext by a third.

use super::peer::MAX_FRAME_CHARS;

/// `{"type":"e2e:enc","seq":4294967295,"nonce":"<16>","ciphertext":""}`.
const TEXT_ENVELOPE_CHARS: usize = 78;
const AEAD_TAG_BYTES: usize = 16;
const PAYLOAD_TAG_BYTES: usize = 1;

/// The largest JSON body one frame carries; `MAX_ENCRYPTED_BODY_BYTES` in TypeScript.
pub(crate) const MAX_BODY_BYTES: usize =
    (MAX_FRAME_CHARS - TEXT_ENVELOPE_CHARS) / 4 * 3 - AEAD_TAG_BYTES - PAYLOAD_TAG_BYTES;

/// `MAX_BINARY_FRAME_BYTES` in `wire/binary-envelope.ts`: `[seq u32 | nonce | ciphertext]`.
pub(crate) const MAX_BINARY_FRAME_BYTES: usize = 65_536;
const BINARY_HEADER_BYTES: usize = 4 + 12;

/// The largest body one binary frame carries; `MAX_BINARY_BODY_BYTES` in TypeScript.
pub(crate) const MAX_BINARY_BODY_BYTES: usize =
    MAX_BINARY_FRAME_BYTES - BINARY_HEADER_BYTES - AEAD_TAG_BYTES - PAYLOAD_TAG_BYTES;

/// Bytes `c` takes inside a JSON string as serde_json writes it.
fn char_bytes(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{08}' | '\t' | '\n' | '\u{0c}' | '\r' => 2,
        '\u{00}'..='\u{1f}' => 6,
        _ => c.len_utf8(),
    }
}

/// Bytes of `text` inside a JSON string, without the quotes.
#[cfg(test)]
pub(crate) fn json_string_bytes(text: &str) -> usize {
    text.chars().map(char_bytes).sum()
}

/// Splits `text` into pieces of at most `max_bytes` JSON-string bytes, on character boundaries.
pub(crate) fn split_json_string(text: &str, max_bytes: usize) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (index, c) in text.char_indices() {
        let add = char_bytes(c);
        if bytes + add > max_bytes && index > start {
            pieces.push(&text[start..index]);
            start = index;
            bytes = 0;
        }
        bytes += add;
    }
    pieces.push(&text[start..]);
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_budget() {
        assert_eq!(MAX_BODY_BYTES, 49_075);
        assert_eq!(MAX_BINARY_BODY_BYTES, 65_503);
        let envelope = serde_json::json!({
            "type": "e2e:enc", "seq": 4_294_967_295u32, "nonce": "A".repeat(16), "ciphertext": "",
        });
        assert_eq!(envelope.to_string().len(), TEXT_ENVELOPE_CHARS);
    }

    #[test]
    fn counts_what_serde_json_writes() {
        for sample in [
            "plain",
            "漢字",
            "\u{1b}[31m\r\n",
            "\"\\",
            "😀",
            "\u{7f}\u{0}\u{2028}",
        ] {
            let encoded = serde_json::to_string(sample).unwrap();
            assert_eq!(json_string_bytes(sample), encoded.len() - 2, "{sample:?}");
        }
    }

    #[test]
    fn splits_into_pieces_that_fit_and_rejoin() {
        let text = "a漢\u{1b}😀\"".repeat(500);
        for max in [6, 7, 100, 10_000] {
            let pieces = split_json_string(&text, max);
            assert_eq!(pieces.concat(), text);
            assert!(pieces.iter().all(|piece| json_string_bytes(piece) <= max));
        }
        assert_eq!(split_json_string("", 10), vec![""]);
    }
}
