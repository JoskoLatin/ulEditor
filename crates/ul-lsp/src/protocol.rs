//! The wire: JSON-RPC in a frame with a header, and what comes back out.
//!
//! This is the half of a language server client that can be checked without a
//! language server, so it is a module of its own. Everything here is a function
//! of its input.
//!
//! **The framing is the part that goes wrong quietly.** A message is a header,
//! a blank line and exactly `Content-Length` bytes of JSON, and a reader that
//! assumes one read gives one message works perfectly until the day a server
//! sends two at once — or half of one. rust-analyzer does both within a second
//! of starting: it publishes diagnostics for a dozen files as fast as it can
//! find them. So the buffer is a buffer, and messages are taken out of it only
//! when all of their bytes are there.

use serde::{Deserialize, Serialize};

/// How much unparsed input is kept before the connection is given up on.
///
/// A server that sends a header promising four gigabytes is a server that has
/// gone wrong, and holding its promise in memory is how a bad frame becomes an
/// out-of-memory. rust-analyzer's largest real message is a few hundred
/// kilobytes of diagnostics for a big file.
pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;

/// One JSON-RPC message, framed the way the protocol asks.
///
/// The header ends with a blank line, the length is in bytes rather than
/// characters, and `Content-Type` is allowed but not required — every server in
/// use omits it, and every client has to tolerate it.
pub fn frame(payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 40);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes());
    out.extend_from_slice(payload.as_bytes());
    out
}

/// What `take_message` decided about the bytes it was given.
#[derive(Debug, PartialEq, Eq)]
pub enum Taken {
    /// One whole message, and the bytes it used are gone from the buffer.
    Message(String),
    /// Nothing yet — more bytes are needed before anything can be said.
    Incomplete,
    /// The stream is not a stream of messages at all, and reading on would be
    /// guessing. The reason is for a person looking at a log, not for a retry.
    Broken(String),
}

/// Takes one message off the front of a buffer, if a whole one is there.
///
/// The buffer is drained by exactly what was consumed and left otherwise
/// untouched: what remains is the beginning of the next message, which may be
/// nothing, part of a header, or three more messages.
pub fn take_message(buffer: &mut Vec<u8>) -> Taken {
    const SEPARATOR: &[u8] = b"\r\n\r\n";

    let Some(header_end) = find(buffer, SEPARATOR) else {
        /* No blank line yet. A header is a few dozen bytes; anything longer
        than a kilobyte without one is not a header. */
        if buffer.len() > 1024 {
            return Taken::Broken("a header with no end in the first kilobyte".to_string());
        }
        return Taken::Incomplete;
    };

    let header = match std::str::from_utf8(&buffer[..header_end]) {
        Ok(text) => text,
        Err(_) => return Taken::Broken("a header that is not text".to_string()),
    };

    let mut length: Option<usize> = None;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        /* Case-insensitively, because the specification says the header is
        HTTP-shaped and HTTP headers are case-insensitive. Every server
        writes `Content-Length`; a client that only accepted that spelling
        would be right until it was not. */
        if name.trim().eq_ignore_ascii_case("content-length") {
            length = value.trim().parse::<usize>().ok();
        }
    }

    let Some(length) = length else {
        return Taken::Broken(format!("a header with no length: {header:?}"));
    };
    if length > MAX_MESSAGE {
        return Taken::Broken(format!(
            "a message of {length} bytes, which is not a message"
        ));
    }

    let body_start = header_end + SEPARATOR.len();
    if buffer.len() < body_start + length {
        return Taken::Incomplete;
    }

    let body = buffer[body_start..body_start + length].to_vec();
    buffer.drain(..body_start + length);

    match String::from_utf8(body) {
        Ok(text) => Taken::Message(text),
        Err(_) => Taken::Broken("a body that is not UTF-8".to_string()),
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/* ── what the editor is told ─────────────────────────────────────────── */

/// How bad a diagnostic is.
///
/// The protocol numbers these 1 to 4 and the numbers are the wire format;
/// anything else is a server being creative, and a hint is the safest thing to
/// call something nobody understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

impl Severity {
    pub fn from_wire(value: Option<u64>) -> Self {
        match value {
            Some(1) => Severity::Error,
            Some(2) => Severity::Warning,
            Some(3) => Severity::Info,
            _ => Severity::Hint,
        }
    }
}

/// One thing a server has to say about a line of code.
///
/// Lines and columns are **one-based** here and zero-based on the wire. The
/// conversion happens once, at the boundary, because a mistake in it is an
/// underline one line above the mistake — which looks like a broken editor
/// rather than a broken conversion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub severity: Severity,
    pub message: String,
    /// `E0308`, `unused_variables` — what the server calls this, when it does.
    pub code: Option<String>,
    /// `rustc`, `clippy`, `typescript` — which tool inside the server said it.
    pub source: Option<String>,
}

/// Everything a server said about one file, at one moment.
///
/// A publication **replaces** what was said before about that file, including
/// with an empty list — that is how a server says "fixed". A client that merged
/// instead of replacing would leave every error a person had corrected on the
/// screen forever.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub uri: String,
    pub diagnostics: Vec<Diagnostic>,
}

/// Reads a `textDocument/publishDiagnostics` notification.
///
/// Returns `None` for every other message, which is most of them: a server
/// talks a great deal about progress, capabilities and work it has begun.
pub fn published_diagnostics(message: &str) -> Option<Published> {
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    if value.get("method")?.as_str()? != "textDocument/publishDiagnostics" {
        return None;
    }

    let params = value.get("params")?;
    let uri = params.get("uri")?.as_str()?.to_string();

    let mut diagnostics = Vec::new();
    for item in params.get("diagnostics")?.as_array()? {
        let range = item.get("range");
        let start = range.and_then(|r| r.get("start"));
        let end = range.and_then(|r| r.get("end"));
        let at = |node: Option<&serde_json::Value>, key: &str| -> u32 {
            /* Zero-based on the wire, one-based here, and saturating rather
            than wrapping: a server that sends a negative or absurd position
            should cost one misplaced underline, not a panic. */
            node.and_then(|n| n.get(key))
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .saturating_add(1)
                .min(u64::from(u32::MAX)) as u32
        };

        diagnostics.push(Diagnostic {
            line: at(start, "line"),
            column: at(start, "character"),
            end_line: at(end, "line"),
            end_column: at(end, "character"),
            severity: Severity::from_wire(item.get("severity").and_then(|v| v.as_u64())),
            message: item
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            code: item.get("code").map(|value| match value {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            }),
            source: item
                .get("source")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }

    Some(Published { uri, diagnostics })
}

/// A path as the protocol wants it: a `file://` URL.
///
/// Windows is the awkward one — `C:\dev\x` becomes `file:///C:/dev/x`, with
/// three slashes and forward separators — and a server given a path it cannot
/// parse answers nothing at all rather than complaining.
pub fn file_url(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !text.starts_with('/') {
        out.push('/');
    }
    for ch in text.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            other => out.push(other),
        }
    }
    out
}

/// And back, because diagnostics arrive keyed by URL and the editor knows paths.
pub fn path_of_url(url: &str) -> Option<std::path::PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let decoded = rest
        .replace("%20", " ")
        .replace("%23", "#")
        .replace("%3F", "?")
        .replace("%3f", "?");

    /* `file:///C:/x` on Windows, `file:///home/x` everywhere else: the leading
    slash belongs to the URL, not to the path, when a drive letter follows. */
    let trimmed = decoded.strip_prefix('/').unwrap_or(&decoded);
    let looks_like_drive = trimmed.as_bytes().get(1).is_some_and(|c| *c == b':')
        && trimmed.as_bytes()[0].is_ascii_alphabetic();

    Some(std::path::PathBuf::from(if looks_like_drive {
        trimmed.to_string()
    } else {
        decoded
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(text: &str) -> Vec<u8> {
        frame(text)
    }

    #[test]
    fn a_message_is_a_header_a_blank_line_and_the_bytes() {
        let framed = frame(r#"{"jsonrpc":"2.0"}"#);
        let text = String::from_utf8(framed).unwrap();
        assert_eq!(text, "Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}");
    }

    #[test]
    fn the_length_is_in_bytes_and_not_in_characters() {
        /* "č" is two bytes and one character. A client that counted characters
        would truncate every message a Croatian diagnostic appears in — and
        it would truncate it by exactly as many bytes as there were
        diacritics, which is the sort of bug that looks like a network
        problem. */
        let payload = r#"{"message":"nečitljivo"}"#;
        let framed = String::from_utf8(frame(payload)).unwrap();
        assert!(framed.starts_with(&format!("Content-Length: {}\r\n", payload.len())));
        assert_eq!(payload.len(), payload.chars().count() + 1);
    }

    #[test]
    fn one_message_comes_out_whole() {
        let mut buffer = body(r#"{"a":1}"#);
        assert_eq!(
            take_message(&mut buffer),
            Taken::Message(r#"{"a":1}"#.to_string())
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn two_messages_in_one_read_are_two_messages() {
        /* This is what a server does the moment it finds something: publishes
        for one file, then the next, in the same write. A reader that assumed
        one read is one message would drop the second and never know. */
        let mut buffer = body(r#"{"a":1}"#);
        buffer.extend(body(r#"{"b":2}"#));

        assert_eq!(
            take_message(&mut buffer),
            Taken::Message(r#"{"a":1}"#.to_string())
        );
        assert_eq!(
            take_message(&mut buffer),
            Taken::Message(r#"{"b":2}"#.to_string())
        );
        assert_eq!(take_message(&mut buffer), Taken::Incomplete);
    }

    #[test]
    fn half_a_message_is_no_message_yet() {
        let whole = body(r#"{"hello":"world"}"#);
        let mut buffer = whole[..whole.len() - 5].to_vec();
        assert_eq!(take_message(&mut buffer), Taken::Incomplete);

        buffer.extend_from_slice(&whole[whole.len() - 5..]);
        assert_eq!(
            take_message(&mut buffer),
            Taken::Message(r#"{"hello":"world"}"#.to_string())
        );
    }

    #[test]
    fn half_a_header_is_no_message_either() {
        let mut buffer = b"Content-Len".to_vec();
        assert_eq!(take_message(&mut buffer), Taken::Incomplete);
        assert_eq!(buffer.len(), 11, "nothing was consumed");
    }

    #[test]
    fn a_content_type_header_is_tolerated() {
        let payload = r#"{"a":1}"#;
        let mut buffer = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{payload}",
            payload.len()
        )
        .into_bytes();
        assert_eq!(
            take_message(&mut buffer),
            Taken::Message(payload.to_string())
        );
    }

    #[test]
    fn the_header_name_is_read_case_insensitively() {
        let payload = r#"{"a":1}"#;
        let mut buffer = format!("content-length: {}\r\n\r\n{payload}", payload.len()).into_bytes();
        assert_eq!(
            take_message(&mut buffer),
            Taken::Message(payload.to_string())
        );
    }

    #[test]
    fn nonsense_is_reported_rather_than_read_past() {
        let mut buffer = b"Content-Length: not-a-number\r\n\r\n{}".to_vec();
        assert!(matches!(take_message(&mut buffer), Taken::Broken(_)));

        let mut absurd = format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE + 1).into_bytes();
        assert!(matches!(take_message(&mut absurd), Taken::Broken(_)));

        let mut endless = vec![b'x'; 2000];
        assert!(matches!(take_message(&mut endless), Taken::Broken(_)));
    }

    #[test]
    fn a_diagnostic_arrives_one_based() {
        let message = r#"{
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": "file:///c:/dev/x/src/lib.rs",
                "diagnostics": [{
                    "range": {
                        "start": { "line": 41, "character": 8 },
                        "end": { "line": 41, "character": 15 }
                    },
                    "severity": 1,
                    "code": "E0308",
                    "source": "rustc",
                    "message": "mismatched types"
                }]
            }
        }"#;

        let published = published_diagnostics(message).unwrap();
        assert_eq!(published.uri, "file:///c:/dev/x/src/lib.rs");

        let one = &published.diagnostics[0];
        assert_eq!((one.line, one.column), (42, 9), "zero-based on the wire");
        assert_eq!((one.end_line, one.end_column), (42, 16));
        assert_eq!(one.severity, Severity::Error);
        assert_eq!(one.code.as_deref(), Some("E0308"));
        assert_eq!(one.source.as_deref(), Some("rustc"));
    }

    #[test]
    fn a_numeric_code_survives_being_a_number() {
        let message = r#"{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///x","diagnostics":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"severity":2,"code":2304,"message":"cannot find name"}]}}"#;
        let published = published_diagnostics(message).unwrap();
        assert_eq!(published.diagnostics[0].code.as_deref(), Some("2304"));
        assert_eq!(published.diagnostics[0].severity, Severity::Warning);
    }

    #[test]
    fn an_empty_publication_is_the_message_that_something_was_fixed() {
        let message = r#"{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///x","diagnostics":[]}}"#;
        let published = published_diagnostics(message).unwrap();
        assert!(
            published.diagnostics.is_empty(),
            "and it must not be dropped"
        );
    }

    #[test]
    fn everything_else_a_server_says_is_not_a_diagnostic() {
        for other in [
            r#"{"method":"window/logMessage","params":{"type":3,"message":"hello"}}"#,
            r#"{"id":1,"result":{"capabilities":{}}}"#,
            r#"{"method":"$/progress","params":{"token":"rustAnalyzer/Indexing"}}"#,
            "not json at all",
        ] {
            assert!(published_diagnostics(other).is_none(), "{other}");
        }
    }

    #[test]
    fn a_windows_path_becomes_a_url_and_comes_back() {
        let path = std::path::Path::new(r"C:\dev\ulEditor\src\lib.rs");
        let url = file_url(path);
        assert_eq!(url, "file:///C:/dev/ulEditor/src/lib.rs");
        assert_eq!(
            path_of_url(&url).unwrap(),
            std::path::PathBuf::from("C:/dev/ulEditor/src/lib.rs")
        );
    }

    #[test]
    fn a_space_in_a_name_survives_the_round_trip() {
        let path = std::path::Path::new("/home/x/My Documents/a.rs");
        let url = file_url(path);
        assert_eq!(url, "file:///home/x/My%20Documents/a.rs");
        assert_eq!(
            path_of_url(&url).unwrap(),
            std::path::PathBuf::from("/home/x/My Documents/a.rs")
        );
    }

    #[test]
    fn a_url_that_is_not_a_file_is_nobodys_path() {
        assert!(path_of_url("untitled:Untitled-1").is_none());
        assert!(path_of_url("https://example.com/x.rs").is_none());
    }
}
