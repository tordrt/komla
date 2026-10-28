//! Binary terminal payloads (`app/binary-frames.ts`), used once the phone and this host agreed to
//! binary frames: output as `[0x01 | flags | generation u32 | seq u64 | id length | id | data]`,
//! input as `[0x02 | id length | id | data]`, big-endian, with UTF-8 ids and data.

use serde_json::{json, Value};

const TERMINAL_OUTPUT: u8 = 0x01;
const TERMINAL_INPUT: u8 = 0x02;
const MORE: u8 = 0x01;
const MAX_ID_CHARS: usize = 128;

/// The binary form of an `app:terminal:data` frame, or None if it isn't one.
pub(crate) fn encode_terminal_output(frame: &Value) -> Option<Vec<u8>> {
    let id = frame["terminalId"].as_str()?;
    let data = frame["data"].as_str()?;
    let generation = u32::try_from(frame["generation"].as_u64()?).ok()?;
    let seq = frame["seq"].as_u64()?;
    let id_len = u8::try_from(id.len()).ok().filter(|len| *len > 0)?;
    let mut out = Vec::with_capacity(15 + id.len() + data.len());
    out.push(TERMINAL_OUTPUT);
    out.push(if frame["more"] == true { MORE } else { 0 });
    out.extend_from_slice(&generation.to_be_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    out.push(id_len);
    out.extend_from_slice(id.as_bytes());
    out.extend_from_slice(data.as_bytes());
    Some(out)
}

/// Binary terminal input as the `app:terminal:input` frame it stands for, or None if malformed.
pub(crate) fn decode_terminal_input(bytes: &[u8]) -> Option<Value> {
    let (&kind, rest) = bytes.split_first()?;
    let (&id_len, rest) = rest.split_first()?;
    if kind != TERMINAL_INPUT || rest.len() < usize::from(id_len) {
        return None;
    }
    let (id, data) = rest.split_at(usize::from(id_len));
    let id = std::str::from_utf8(id).ok()?;
    let data = std::str::from_utf8(data).ok()?;
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return None;
    }
    Some(json!({ "type": "app:terminal:input", "terminalId": id, "data": data }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_output_like_the_typescript_codec() {
        let frame = json!({
            "type": "app:terminal:data", "workspaceId": "w", "terminalId": "t1",
            "data": "漢", "seq": 1u64 << 40, "generation": 3, "more": true,
        });
        let mut expected = vec![
            0x01, 0x01, 0, 0, 0, 3, 0, 0, 1, 0, 0, 0, 0, 0, 2, b't', b'1',
        ];
        expected.extend_from_slice("漢".as_bytes());

        assert_eq!(encode_terminal_output(&frame), Some(expected));
        assert_eq!(
            encode_terminal_output(&json!({ "type": "app:workspaces" })),
            None
        );
    }

    #[test]
    fn decodes_input_and_refuses_anything_else() {
        let mut input = vec![0x02, 2, b't', b'1'];
        input.extend_from_slice(b"ls\r");
        assert_eq!(
            decode_terminal_input(&input),
            Some(json!({ "type": "app:terminal:input", "terminalId": "t1", "data": "ls\r" }))
        );
        for bad in [
            &[][..],
            &[0x01, 1, b't'],
            &[0x02, 5, b't'],
            &[0x02, 0],
            &[0x02, 1, b't', 0xff],
        ] {
            assert_eq!(decode_terminal_input(bad), None, "{bad:?}");
        }
    }
}
