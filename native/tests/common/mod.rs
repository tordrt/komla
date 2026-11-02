//! Helpers shared by the integration tests. Each test file is its own crate and
//! includes this with `mod common;`.

use std::io::Read;
use std::net::TcpStream;
use std::time::Duration;

/// Reads a whole request, headers and body. Windows resets a connection closed with
/// unread bytes, so a fake server that replies after a partial read can abort the CLI
/// with os error 10053.
pub fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    // A request that stalls fails the test instead of hanging it.
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    let mut expected_length = None;
    loop {
        let bytes_read = stream
            .read(&mut buffer)
            .expect("the CLI stopped sending its request for 10 seconds");
        assert!(
            bytes_read > 0,
            "HTTP request ended before its body was complete"
        );
        request.extend_from_slice(&buffer[..bytes_read]);
        if expected_length.is_none() {
            let text = String::from_utf8_lossy(&request);
            if let Some(header_end) = text.find("\r\n\r\n") {
                let content_length = text[..header_end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                expected_length = Some(header_end + 4 + content_length);
            }
        }
        if expected_length.is_some_and(|length| request.len() >= length) {
            return request;
        }
    }
}
