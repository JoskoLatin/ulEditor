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
    /// Which version of the document this is about, when the server says.
    ///
    /// A server's own analysis answers about the text it was told; a
    /// `cargo check` answers about the file on disk minutes ago and says
    /// nothing about versions. So this is `Some` for the first and `None` for
    /// the second, and an editor uses it to drop an answer about text the
    /// person has already changed — a stale underline under a corrected line
    /// is worse than a moment with no underline at all.
    pub version: Option<i64>,
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

    Some(Published {
        uri,
        diagnostics,
        version: params.get("version").and_then(|v| v.as_i64()),
    })
}

/// A path as the protocol wants it: a `file://` URL.
///
/// Windows is the awkward one — `C:\dev\x` becomes `file:///C:/dev/x`, with
/// three slashes and forward separators — and a server given a path it cannot
/// parse answers nothing at all rather than complaining.
///
/// **`\\?\` has to come off first, and leaving it on cost an afternoon.** That
/// prefix is what `fs::canonicalize` returns on Windows, and every path reaching
/// this client has been through the workspace's `resolve` — so it was not an
/// exotic input, it was *the* input. Left on, the URL came out as
/// `file:////?/C:/dev/x`, which no language server can parse.
///
/// The failure was invisible in the way this crate keeps running into.
/// **Diagnostics went on working**: rust-analyzer walks the project itself and
/// publishes about files nobody opened, so the underlines appeared exactly as
/// before while the `didOpen` was quietly ignored — and every *question* about
/// that URL was a question about a document the server had never heard of. The
/// answers came back empty, which is indistinguishable from a server that has
/// nothing to say.
pub fn file_url(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy();

    /* `\\?\UNC\server\share` is the verbatim spelling of `\\server\share`, and
    it is put back into the shorter form rather than given a branch of its
    own: a network share then produces whatever its ordinary spelling
    produces, which is the most that can honestly be claimed about a case
    nothing here opens. */
    let unprefixed = match raw.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string(),
    };

    let text = unprefixed.replace('\\', "/");
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

/* ── what the editor asks for ────────────────────────────────────────────
 *
 * Diagnostics arrive unasked; everything below is an answer to a question, and
 * a question has one property a notification does not: **the reply is whatever
 * the server felt like sending**. The protocol gives `hover.contents` four
 * shapes, `definition` four more and `completion` two, and a client that
 * handled only the shape its own server happened to send would work on one
 * machine. So every one of them is read here, and every one of them has a test
 * below — this is the half that can be checked without a language server, and
 * it is the half that goes wrong quietly.
 */

/// A range in a document, one-based, the way the editor counts.
///
/// Zero-based on the wire; the conversion happens once, here, for the same
/// reason it does for a diagnostic — a mistake in it puts the answer one line
/// above the question, which reads as a broken editor rather than as a broken
/// conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Reads a `{ start, end }` range, saturating rather than wrapping.
///
/// A server that sends an absurd position should cost one misplaced highlight,
/// not a panic.
fn span_of(range: Option<&serde_json::Value>) -> Option<Span> {
    let range = range?;
    let at = |which: &str, key: &str| -> u32 {
        range
            .get(which)
            .and_then(|node| node.get(key))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1)
            .min(u64::from(u32::MAX)) as u32
    };
    Some(Span {
        line: at("start", "line"),
        column: at("start", "character"),
        end_line: at("end", "line"),
        end_column: at("end", "character"),
    })
}

/// What a server has to say about the thing under the cursor.
///
/// One block of Markdown, because that is what the editor draws — and what
/// arrives is not always Markdown. See `hover_text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hover {
    pub markdown: String,
    /// What the answer is about, when the server bothers to say.
    ///
    /// Used to underline the word the tooltip belongs to. Absent from many
    /// answers, and a client that required it would show nothing at all for a
    /// server that is entirely within its rights.
    pub span: Option<Span>,
}

/// Flattens `hover.contents`, which has four shapes and had more.
///
/// - `MarkupContent` — `{ kind, value }`, what every current server sends;
/// - a bare string, the oldest form, still sent by some;
/// - `{ language, value }` — a `MarkedString`, deprecated since 3.15 and alive
///   in the wild, which means a fenced code block and has to be drawn as one or
///   a type signature arrives as a paragraph of prose;
/// - an array of any of those, joined by a rule.
///
/// Anything else flattens to nothing, which is the honest answer: an empty
/// hover shows no tooltip, and a tooltip reading `[object Object]` is worse
/// than silence.
fn hover_text(contents: &serde_json::Value) -> String {
    match contents {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(hover_text)
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n---\n\n"),
        serde_json::Value::Object(map) => {
            let value = map
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            match map.get("language").and_then(|v| v.as_str()) {
                /* A `MarkedString` with a language is code, and saying so is
                the whole difference between a signature and a sentence. */
                Some(language) => format!("```{language}\n{value}\n```"),
                None => value.to_string(),
            }
        }
        _ => String::new(),
    }
}

/// Reads the answer to `textDocument/hover`.
///
/// `None` for a server with nothing to say, which is the commonest answer there
/// is — a pointer spends most of its life over whitespace.
pub fn parse_hover(result: &serde_json::Value) -> Option<Hover> {
    let markdown = hover_text(result.get("contents")?);
    if markdown.trim().is_empty() {
        return None;
    }
    Some(Hover {
        markdown,
        span: span_of(result.get("range")),
    })
}

/// Somewhere else in the project — where a name was defined.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// A `file://` URL as the server gave it; the caller turns it into a path.
    pub uri: String,
    pub span: Span,
}

/// Reads the answer to `textDocument/definition`, in all four of its shapes.
///
/// `null`, one `Location`, a list of them, or a list of `LocationLink` — which
/// is a different object with different key names, sent by any server that was
/// told the client understands it. **We ask for it** (`linkSupport`), because
/// it carries `targetSelectionRange`: the name itself rather than the whole
/// body of the function, which is where a person wants the cursor to land.
///
/// A list rather than an option, because a definition genuinely can be in
/// several places — a trait method with implementations, a symbol declared
/// twice behind a `cfg`. An empty list is "nowhere", which is a real answer.
pub fn parse_locations(result: &serde_json::Value) -> Vec<Location> {
    fn one(value: &serde_json::Value, out: &mut Vec<Location>) {
        /* A `LocationLink` first: it has `targetUri`, which a `Location` never
        does, so the two are told apart by a key rather than by guessing. */
        if let Some(uri) = value.get("targetUri").and_then(|v| v.as_str()) {
            if let Some(span) = span_of(value.get("targetSelectionRange"))
                .or_else(|| span_of(value.get("targetRange")))
            {
                out.push(Location {
                    uri: uri.to_string(),
                    span,
                });
            }
            return;
        }

        if let (Some(uri), Some(span)) = (
            value.get("uri").and_then(|v| v.as_str()),
            span_of(value.get("range")),
        ) {
            out.push(Location {
                uri: uri.to_string(),
                span,
            });
        }
    }

    let mut out = Vec::new();
    match result {
        serde_json::Value::Array(items) => {
            for item in items {
                one(item, &mut out);
            }
        }
        serde_json::Value::Object(_) => one(result, &mut out),
        /* `null` is the ordinary answer over a keyword or a literal. */
        _ => {}
    }
    out
}

/// What kind of thing a completion offers.
///
/// The protocol numbers twenty-five of these and the numbers are the wire
/// format. They are named here rather than passed through, because a number
/// means nothing to the half of the program that draws an icon — and because a
/// server being creative with an unknown number should land on something
/// harmless rather than on nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionKind {
    Text,
    Method,
    Function,
    Constructor,
    Field,
    Variable,
    Class,
    Interface,
    Module,
    Property,
    Unit,
    Value,
    Enum,
    Keyword,
    Snippet,
    Color,
    File,
    Reference,
    Folder,
    EnumMember,
    Constant,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

impl CompletionKind {
    pub fn from_wire(value: Option<u64>) -> Self {
        match value {
            Some(2) => CompletionKind::Method,
            Some(3) => CompletionKind::Function,
            Some(4) => CompletionKind::Constructor,
            Some(5) => CompletionKind::Field,
            Some(6) => CompletionKind::Variable,
            Some(7) => CompletionKind::Class,
            Some(8) => CompletionKind::Interface,
            Some(9) => CompletionKind::Module,
            Some(10) => CompletionKind::Property,
            Some(11) => CompletionKind::Unit,
            Some(12) => CompletionKind::Value,
            Some(13) => CompletionKind::Enum,
            Some(14) => CompletionKind::Keyword,
            Some(15) => CompletionKind::Snippet,
            Some(16) => CompletionKind::Color,
            Some(17) => CompletionKind::File,
            Some(18) => CompletionKind::Reference,
            Some(19) => CompletionKind::Folder,
            Some(20) => CompletionKind::EnumMember,
            Some(21) => CompletionKind::Constant,
            Some(22) => CompletionKind::Struct,
            Some(23) => CompletionKind::Event,
            Some(24) => CompletionKind::Operator,
            Some(25) => CompletionKind::TypeParameter,
            /* 1 is `Text`, and so is anything nobody has heard of: a word with
            no icon beside it is still a word, which is always true. */
            _ => CompletionKind::Text,
        }
    }
}

/// One thing a server offers to finish the word with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    /// What is shown in the list.
    pub label: String,
    pub kind: CompletionKind,
    /// The type, the signature, the module it came from — a short line.
    pub detail: Option<String>,
    /// The doc comment, flattened the way a hover is.
    pub documentation: Option<String>,
    /// What is actually put into the document, which is not always the label:
    /// rust-analyzer labels a method `push(…)` and inserts `push`.
    pub insert: String,
    /// What the insertion replaces, when the server says.
    ///
    /// A `textEdit` is the server's own opinion about where the word being
    /// completed began, and it is better informed than the editor's: it knows
    /// that `::` is part of a path and that `-` is part of a CSS property.
    pub replace: Option<Span>,
    /// The order the server wants, which is neither alphabetical nor the order
    /// the list arrived in.
    pub sort_text: Option<String>,
    /// Whether the text is a snippet — placeholders and tab stops.
    ///
    /// We declare `snippetSupport: false`, so this should never be true. It is
    /// carried anyway because a server may ignore that, and an editor that
    /// pasted `println!("$1")` into somebody's code because it trusted its own
    /// capability declaration would be writing a bug on their behalf.
    pub snippet: bool,
}

/// Reads the answer to `textDocument/completion`, in both of its shapes.
///
/// A bare list, or a `CompletionList` with an `isIncomplete` flag — which is
/// how a server says "there are more; ask again when they type another letter",
/// and is returned alongside so the caller knows not to keep the answer.
pub fn parse_completions(result: &serde_json::Value) -> (Vec<Completion>, bool) {
    let (items, incomplete) = match result {
        serde_json::Value::Array(items) => (items.as_slice(), false),
        serde_json::Value::Object(map) => (
            map.get("items")
                .and_then(serde_json::Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            map.get("isIncomplete")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        ),
        _ => (&[][..], false),
    };

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(label) = item.get("label").and_then(|v| v.as_str()) else {
            /* An item with no label cannot be drawn and cannot be chosen. */
            continue;
        };

        /*
         * Three places say what to insert, in order of how much the server
         * knows: a `textEdit` (with the range it applies to), an `insertText`,
         * and failing both the label itself. `textEdit` has two shapes of its
         * own — a plain `range`, or `insert`/`replace` for a server that
         * distinguishes typing over a word from typing before one. `insert` is
         * the one taken: eating the tail of a word somebody deliberately left
         * there is the surprising half of that pair.
         */
        let edit = item.get("textEdit");
        let replace = edit
            .and_then(|edit| span_of(edit.get("range")).or_else(|| span_of(edit.get("insert"))));
        let insert = edit
            .and_then(|edit| edit.get("newText"))
            .and_then(|v| v.as_str())
            .or_else(|| item.get("insertText").and_then(|v| v.as_str()))
            .unwrap_or(label)
            .to_string();

        out.push(Completion {
            label: label.to_string(),
            kind: CompletionKind::from_wire(item.get("kind").and_then(|v| v.as_u64())),
            detail: item
                .get("detail")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            documentation: item
                .get("documentation")
                .map(hover_text)
                .filter(|text| !text.trim().is_empty()),
            insert,
            replace,
            sort_text: item
                .get("sortText")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            snippet: item
                .get("insertTextFormat")
                .and_then(serde_json::Value::as_u64)
                == Some(2),
        });
    }

    (out, incomplete)
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
    fn the_version_is_kept_when_a_server_gives_one() {
        let with = r#"{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///x","version":7,"diagnostics":[]}}"#;
        assert_eq!(published_diagnostics(with).unwrap().version, Some(7));

        /* And absent when it does not: `cargo check` answers about the file on
        disk and has no idea which keystroke the editor is on. */
        let without = r#"{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///x","diagnostics":[]}}"#;
        assert_eq!(published_diagnostics(without).unwrap().version, None);
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
    fn the_prefix_windows_canonicalisation_adds_comes_off() {
        /*
         * `fs::canonicalize` returns `\\?\C:\...` on Windows and the workspace
         * canonicalises every path before this client sees one — so this is
         * not an exotic input, it is the ordinary one. Left on, the URL was
         * `file:////?/C:/dev/x`: unparseable, ignored without complaint by
         * every server, and hidden by diagnostics that kept arriving anyway
         * because rust-analyzer finds a project's files without being told.
         */
        let verbatim = std::path::Path::new(r"\\?\C:\dev\ulEditor\src\lib.rs");
        assert_eq!(file_url(verbatim), "file:///C:/dev/ulEditor/src/lib.rs");
        assert_eq!(
            file_url(verbatim),
            file_url(std::path::Path::new(r"C:\dev\ulEditor\src\lib.rs")),
            "two spellings of one path are one document"
        );
        assert_eq!(
            path_of_url(&file_url(verbatim)).unwrap(),
            std::path::PathBuf::from("C:/dev/ulEditor/src/lib.rs")
        );
    }

    #[test]
    fn a_share_reached_the_long_way_round_looks_like_a_share() {
        /* Nothing here opens a network share. This asserts only that the
        verbatim spelling collapses onto the ordinary one rather than onto a
        third shape again. */
        assert_eq!(
            file_url(std::path::Path::new(r"\\?\UNC\server\share\a.rs")),
            file_url(std::path::Path::new(r"\\server\share\a.rs")),
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

    /* ── the answers, and every shape they arrive in ─────────────────── */

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).expect("the fixture is JSON")
    }

    #[test]
    fn a_hover_arrives_as_markup_content() {
        /* What every current server sends, and the only shape a client written
        against one server would ever handle. */
        let hover = parse_hover(&json(
            r#"{"contents":{"kind":"markdown","value":"```rust\nfn push(&mut self)\n```"},
                "range":{"start":{"line":9,"character":4},"end":{"line":9,"character":8}}}"#,
        ))
        .unwrap();

        assert!(hover.markdown.contains("fn push"));
        assert_eq!(
            hover.span,
            Some(Span {
                line: 10,
                column: 5,
                end_line: 10,
                end_column: 9,
            }),
            "zero-based on the wire, one-based here"
        );
    }

    #[test]
    fn a_hover_also_arrives_as_a_bare_string_and_as_a_marked_string() {
        /* The oldest shape, still sent. */
        assert_eq!(
            parse_hover(&json(r#"{"contents":"a plain sentence"}"#))
                .unwrap()
                .markdown,
            "a plain sentence"
        );

        /* And a `MarkedString`: deprecated since 3.15 and alive in the wild.
        The language is the whole point of it — drawn as prose, a type
        signature is a paragraph rather than a signature. */
        let fenced = parse_hover(&json(
            r#"{"contents":{"language":"rust","value":"struct Vec<T>"}}"#,
        ))
        .unwrap();
        assert_eq!(fenced.markdown, "```rust\nstruct Vec<T>\n```");
        assert_eq!(fenced.span, None, "a range is optional and often absent");
    }

    #[test]
    fn a_hover_of_several_parts_keeps_all_of_them() {
        let hover = parse_hover(&json(
            r#"{"contents":[{"language":"rust","value":"fn main()"},"the entry point",{"kind":"markdown","value":""}]}"#,
        ))
        .unwrap();

        assert!(hover.markdown.contains("fn main()"));
        assert!(hover.markdown.contains("the entry point"));
        assert!(
            hover.markdown.contains("---"),
            "the parts are separated, or two sentences run together: {:?}",
            hover.markdown
        );
        assert!(
            !hover.markdown.contains("\n\n---\n\n\n\n---"),
            "and an empty part contributes no rule of its own"
        );
    }

    #[test]
    fn nothing_to_say_is_not_an_empty_tooltip() {
        /* A pointer spends most of its life over whitespace, and this is what
        the server says about that. An empty tooltip that follows the mouse
        around is worse than no tooltip at all. */
        for nothing in [
            "null",
            r#"{"contents":""}"#,
            r#"{"contents":{"kind":"markdown","value":"   "}}"#,
            r#"{"contents":[]}"#,
            r#"{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}"#,
        ] {
            assert!(parse_hover(&json(nothing)).is_none(), "{nothing}");
        }
    }

    #[test]
    fn a_definition_arrives_as_one_location_or_as_a_list_of_them() {
        let one = parse_locations(&json(
            r#"{"uri":"file:///c:/dev/x/src/lib.rs","range":{"start":{"line":41,"character":8},"end":{"line":41,"character":15}}}"#,
        ));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].uri, "file:///c:/dev/x/src/lib.rs");
        assert_eq!((one[0].span.line, one[0].span.column), (42, 9));

        /* Several is not an error: a trait method has implementations, and a
        symbol behind a `cfg` is declared twice. */
        let many = parse_locations(&json(
            r#"[{"uri":"file:///a.rs","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}},
               {"uri":"file:///b.rs","range":{"start":{"line":4,"character":0},"end":{"line":4,"character":1}}}]"#,
        ));
        assert_eq!(many.len(), 2);
        assert_eq!(many[1].span.line, 5);
    }

    #[test]
    fn a_location_link_is_taken_by_the_name_and_not_by_the_body() {
        /*
         * This is why `linkSupport` is asked for. `targetRange` is the whole
         * function — forty lines, of which a jump would select all — and
         * `targetSelectionRange` is its name. Landing on the second is what a
         * person means by "go to the definition".
         */
        let links = parse_locations(&json(
            r#"[{"originSelectionRange":{"start":{"line":3,"character":4},"end":{"line":3,"character":8}},
                "targetUri":"file:///c:/dev/x/src/lib.rs",
                "targetRange":{"start":{"line":100,"character":0},"end":{"line":140,"character":1}},
                "targetSelectionRange":{"start":{"line":100,"character":7},"end":{"line":100,"character":11}}}]"#,
        ));

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].span.line, 101);
        assert_eq!(links[0].span.column, 8, "the name, not the body");
        assert_eq!(links[0].span.end_line, 101);
    }

    #[test]
    fn a_location_link_without_a_selection_falls_back_to_the_whole_target() {
        let links = parse_locations(&json(
            r#"[{"targetUri":"file:///a.rs","targetRange":{"start":{"line":9,"character":0},"end":{"line":12,"character":1}}}]"#,
        ));
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].span.line, 10);
    }

    #[test]
    fn nowhere_is_a_real_answer_to_where_was_this_defined() {
        /* Over a keyword, over a literal, over a comment. */
        for nothing in ["null", "[]", r#"{"uri":"file:///a.rs"}"#, r#""nonsense""#] {
            assert!(parse_locations(&json(nothing)).is_empty(), "{nothing}");
        }
    }

    #[test]
    fn completions_arrive_as_a_list_or_as_a_list_that_says_it_is_partial() {
        let (bare, incomplete) = parse_completions(&json(r#"[{"label":"push"}]"#));
        assert_eq!(bare.len(), 1);
        assert!(!incomplete);

        /* `isIncomplete` is how a server says "ask me again when they type
        another letter", and an editor that cached the list would show a
        stale one for the rest of the word. */
        let (wrapped, partial) = parse_completions(&json(
            r#"{"isIncomplete":true,"items":[{"label":"push"},{"label":"pop"}]}"#,
        ));
        assert_eq!(wrapped.len(), 2);
        assert!(partial);

        let (none, _) = parse_completions(&json("null"));
        assert!(none.is_empty());
    }

    #[test]
    fn what_is_inserted_is_not_always_what_is_shown() {
        /* rust-analyzer labels a method `push(…)` and inserts `push`. An
        editor that inserted the label would put an ellipsis into the code. */
        let (items, _) = parse_completions(&json(
            r#"[{"label":"push(…)","kind":2,"detail":"fn(&mut self, value: T)","insertText":"push",
                "sortText":"ffffffef","documentation":{"kind":"markdown","value":"Appends an element."}}]"#,
        ));

        let one = &items[0];
        assert_eq!(one.label, "push(…)");
        assert_eq!(one.insert, "push");
        assert_eq!(one.kind, CompletionKind::Method);
        assert_eq!(one.detail.as_deref(), Some("fn(&mut self, value: T)"));
        assert_eq!(one.documentation.as_deref(), Some("Appends an element."));
        assert_eq!(one.sort_text.as_deref(), Some("ffffffef"));
        assert!(!one.snippet);
    }

    #[test]
    fn a_text_edit_beats_an_insert_text_and_brings_its_own_range() {
        /* The server's opinion about where the word began is better informed
        than the editor's: it knows `::` is part of a path. */
        let (items, _) = parse_completions(&json(
            r#"[{"label":"collect","insertText":"ignored",
                "textEdit":{"range":{"start":{"line":7,"character":12},"end":{"line":7,"character":15}},
                            "newText":"collect"}}]"#,
        ));

        assert_eq!(items[0].insert, "collect");
        assert_eq!(
            items[0].replace,
            Some(Span {
                line: 8,
                column: 13,
                end_line: 8,
                end_column: 16,
            })
        );
    }

    #[test]
    fn an_insert_replace_edit_is_taken_as_the_insert() {
        /*
         * The two halves mean different things: `insert` stops where the cursor
         * is, `replace` eats the rest of the word. Somebody who put the cursor
         * in the middle of `format` and asked for a completion left the `mat`
         * there on purpose, and swallowing it is the surprising half of the
         * pair.
         */
        let (items, _) = parse_completions(&json(
            r#"[{"label":"format","textEdit":{
                "insert":{"start":{"line":0,"character":0},"end":{"line":0,"character":3}},
                "replace":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}},
                "newText":"format"}}]"#,
        ));
        assert_eq!(items[0].replace.unwrap().end_column, 4, "the insert half");
    }

    #[test]
    fn a_snippet_is_flagged_even_though_we_said_we_could_not_take_one() {
        /* We declare `snippetSupport: false`. A server that sends one anyway is
        not to be trusted with the text, and the flag is what lets the editor
        refuse it rather than paste `${1:value}` into somebody's file. */
        let (items, _) = parse_completions(&json(
            r#"[{"label":"println!","insertText":"println!(\"${1:}\")","insertTextFormat":2}]"#,
        ));
        assert!(items[0].snippet);
    }

    #[test]
    fn an_item_with_no_label_is_not_an_item() {
        let (items, _) = parse_completions(&json(r#"[{"kind":3},{"label":"real"}]"#));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "real");
    }

    #[test]
    fn every_kind_the_protocol_numbers_has_a_name_and_the_rest_are_text() {
        assert_eq!(CompletionKind::from_wire(Some(1)), CompletionKind::Text);
        assert_eq!(CompletionKind::from_wire(Some(3)), CompletionKind::Function);
        assert_eq!(CompletionKind::from_wire(Some(22)), CompletionKind::Struct);
        assert_eq!(
            CompletionKind::from_wire(Some(25)),
            CompletionKind::TypeParameter
        );
        /* A number nobody has heard of, and no number at all: a word with no
        icon beside it is still a word. */
        assert_eq!(CompletionKind::from_wire(Some(99)), CompletionKind::Text);
        assert_eq!(CompletionKind::from_wire(None), CompletionKind::Text);
    }

    #[test]
    fn an_absurd_position_costs_a_misplaced_mark_and_not_a_panic() {
        /* `u32::MAX` and beyond, which is what a server sends when something
        inside it has overflowed. Saturating is the whole of the defence. */
        let locations = parse_locations(&json(
            r#"[{"uri":"file:///a.rs","range":{"start":{"line":4294967295,"character":0},"end":{"line":4294967295,"character":1}}}]"#,
        ));
        assert_eq!(locations[0].span.line, u32::MAX);
    }
}
