//! Content search for SSH workspaces, run by the desktop over SSH. It mirrors the
//! desktop's local ripgrep invocation (`--hidden --glob !.git --max-filesize`,
//! gitignore rules, binary files skipped) and prints matches as ripgrep's `--json`
//! match lines, so the desktop parses both with the same code. It uses
//! the regex engine the `ignore` crate already links instead of ripgrep's
//! searcher crates, which would add about 1 MB to every shipped companion.

use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use ignore::WalkBuilder;
use regex_automata::meta::Regex;
use regex_automata::util::syntax;
use regex_automata::{Input, Match};
use serde_json::json;

const USAGE: &str = "usage: komla __search [--ignore-case] [--multiline] [--max-results <count>] [--max-filesize <bytes>] -- <pattern>";
const SEARCH_DEADLINE: Duration = Duration::from_secs(20);
// A match in a minified file can sit on a line of a megabyte; the desktop shows one row.
const MAX_PREVIEW_BYTES: usize = 1024;

/// Why a search ended before it walked every file.
#[derive(Debug, PartialEq)]
pub(crate) enum Interruption {
    /// It ran out of time; the desktop is told, so it can say the search was cut short.
    Deadline,
    /// The desktop closed the output: it gave up on this search.
    Abandoned,
}

#[derive(Debug, PartialEq)]
pub(crate) struct SearchOptions {
    pub(crate) pattern: String,
    pub(crate) ignore_case: bool,
    pub(crate) multiline: bool,
    pub(crate) max_results: usize,
    pub(crate) max_filesize: u64,
}

pub(crate) fn parse_args(args: &[String]) -> anyhow::Result<SearchOptions> {
    let mut options = SearchOptions {
        pattern: String::new(),
        ignore_case: false,
        multiline: false,
        max_results: 100,
        max_filesize: 1024 * 1024,
    };
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--ignore-case" => options.ignore_case = true,
            "--multiline" => options.multiline = true,
            "--max-results" => {
                options.max_results = arguments
                    .next()
                    .context("--max-results requires a value")?
                    .parse()
                    .context("--max-results must be a number")?;
            }
            "--max-filesize" => {
                options.max_filesize = arguments
                    .next()
                    .context("--max-filesize requires a value")?
                    .parse()
                    .context("--max-filesize must be a number of bytes")?;
            }
            "--" => {
                let (Some(pattern), None) = (arguments.next(), arguments.next()) else {
                    bail!("{USAGE}");
                };
                options.pattern = pattern.clone();
                return Ok(options);
            }
            _ => bail!("{USAGE}"),
        }
    }
    bail!("{USAGE}")
}

pub(crate) fn run(args: &[String]) -> anyhow::Result<()> {
    let options = parse_args(args)?;
    let deadline = Instant::now() + SEARCH_DEADLINE;
    let stdout = io::stdout();
    search(Path::new("."), &options, &mut stdout.lock(), &|| {
        if output_closed() {
            Some(Interruption::Abandoned)
        } else if Instant::now() >= deadline {
            Some(Interruption::Deadline)
        } else {
            None
        }
    })
}

pub(crate) fn search(
    root: &Path,
    options: &SearchOptions,
    output: &mut dyn Write,
    interrupted: &dyn Fn() -> Option<Interruption>,
) -> anyhow::Result<()> {
    let regex = Regex::builder()
        .syntax(
            syntax::Config::new()
                .case_insensitive(options.ignore_case)
                .multi_line(true),
        )
        .build(&options.pattern)
        .context("invalid search pattern")?;
    let mut remaining = options.max_results;
    for entry in WalkBuilder::new(root)
        .hidden(false)
        .max_filesize(Some(options.max_filesize))
        .filter_entry(|entry| entry.file_name() != ".git")
        .sort_by_file_name(|a, b| a.cmp(b))
        .build()
        .filter_map(Result::ok)
    {
        if remaining == 0 {
            break;
        }
        match interrupted() {
            Some(Interruption::Deadline) => {
                writeln!(
                    output,
                    r#"{{"type":"stopped","data":{{"reason":"deadline"}}}}"#
                )?;
                return Ok(());
            }
            Some(Interruption::Abandoned) => return Ok(()),
            None => {}
        }
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        // Unreadable files are skipped, as ripgrep does. A NUL byte marks a binary file.
        let Ok(contents) = std::fs::read(entry.path()) else {
            continue;
        };
        if contents.contains(&0) {
            continue;
        }
        let path = entry.path();
        let display = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
        let blocks = if options.multiline {
            multiline_blocks(&regex, &contents, remaining)
        } else {
            line_blocks(&regex, &contents, remaining)
        };
        let mut line_number = 1;
        let mut counted = 0;
        for block in blocks {
            line_number += count_lines(&contents[counted..block.start]);
            counted = block.start;
            let written = write_match(output, &display, &contents, &block, line_number);
            // A closed output means the desktop stopped listening, which is not an error.
            if let Err(error) = written {
                if error.kind() == io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(error.into());
            }
            remaining -= 1;
        }
    }
    Ok(())
}

/// Whole lines holding one or more matches, like one ripgrep `match` message.
struct Block {
    start: usize,
    end: usize,
    matches: Vec<Match>,
}

/// Matches confined to one line each, as ripgrep reports without `--multiline`.
fn line_blocks(regex: &Regex, contents: &[u8], limit: usize) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut at = 0;
    // Search the rest of the file for a candidate, then search only its line, since
    // the candidate may have run across a newline.
    while at < contents.len() && blocks.len() < limit {
        let Some(candidate) = regex.search(&Input::new(contents).range(at..)) else {
            break;
        };
        let start = line_start(contents, candidate.start());
        if start == contents.len() {
            break;
        }
        let end = line_end(contents, candidate.start());
        let line = end - usize::from(contents[end - 1] == b'\n');
        let matches: Vec<Match> = regex
            .find_iter(Input::new(contents).range(start..line))
            .collect();
        if !matches.is_empty() {
            blocks.push(Block {
                start,
                end,
                matches,
            });
        }
        at = end;
    }
    blocks
}

/// Matches that may span lines, as ripgrep reports with `--multiline`: matches whose
/// lines overlap share one block.
fn multiline_blocks(regex: &Regex, contents: &[u8], limit: usize) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    for found in regex.find_iter(contents) {
        let last = found.end().saturating_sub(1).max(found.start());
        let end = line_end(contents, last);
        let full = blocks.len() == limit;
        match blocks.last_mut() {
            Some(block) if found.start() < block.end => {
                block.end = block.end.max(end);
                block.matches.push(found);
            }
            _ if full => break,
            _ => blocks.push(Block {
                start: line_start(contents, found.start()),
                end,
                matches: vec![found],
            }),
        }
    }
    blocks.retain(|block| block.start < contents.len());
    blocks
}

fn line_start(contents: &[u8], at: usize) -> usize {
    contents[..at]
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map_or(0, |index| index + 1)
}

/// The end of the line holding `at`, after its newline.
fn line_end(contents: &[u8], at: usize) -> usize {
    contents[at.min(contents.len())..]
        .iter()
        .position(|&byte| byte == b'\n')
        .map_or(contents.len(), |index| at + index + 1)
}

fn count_lines(contents: &[u8]) -> usize {
    contents.iter().filter(|&&byte| byte == b'\n').count()
}

/// Whether the desktop has closed this search's output, checked without writing to it.
#[cfg(unix)]
fn output_closed() -> bool {
    descriptor_closed(libc::STDOUT_FILENO)
}

#[cfg(not(unix))]
fn output_closed() -> bool {
    false
}

#[cfg(unix)]
fn descriptor_closed(descriptor: libc::c_int) -> bool {
    // macOS reports the hang-up only when asked about writing; Linux reports it either way.
    let mut poll = libc::pollfd {
        fd: descriptor,
        events: libc::POLLOUT,
        revents: 0,
    };
    let ready = unsafe { libc::poll(&mut poll, 1, 0) };
    ready > 0 && poll.revents & (libc::POLLERR | libc::POLLHUP) != 0
}

/// The part of a block the desktop shows: all of it, or a window that starts a little
/// before the first match when the block is too long for a preview row.
fn preview(contents: &[u8], block: &Block) -> (usize, usize) {
    if block.end - block.start <= MAX_PREVIEW_BYTES {
        return (block.start, block.end);
    }
    let first = block.matches[0].start();
    let mut start = first.saturating_sub(MAX_PREVIEW_BYTES / 4).max(block.start);
    while start < first && is_continuation_byte(contents[start]) {
        start += 1;
    }
    let mut end = (start + MAX_PREVIEW_BYTES).min(block.end);
    while end > start && end < contents.len() && is_continuation_byte(contents[end]) {
        end -= 1;
    }
    (start, end)
}

fn is_continuation_byte(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

fn write_match(
    output: &mut dyn Write,
    path: &str,
    contents: &[u8],
    block: &Block,
    line_number: usize,
) -> io::Result<()> {
    let (start, end) = preview(contents, block);
    let lines = &contents[start..end];
    // ripgrep also names each match's text; the desktop reads only its offsets.
    let submatches: Vec<_> = block
        .matches
        .iter()
        .filter(|found| found.start() >= start && found.start() <= end)
        .map(|found| {
            json!({
                "start": found.start() - start,
                "end": found.end().min(end) - start,
            })
        })
        .collect();
    let message = json!({
        "type": "match",
        "data": {
            "path": { "text": path },
            "lines": { "text": String::from_utf8_lossy(lines) },
            "line_number": line_number,
            "submatches": submatches,
        },
    });
    serde_json::to_writer(&mut *output, &message)?;
    writeln!(output)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::{parse_args, search, Interruption, SearchOptions, MAX_PREVIEW_BYTES};

    fn options(pattern: &str) -> SearchOptions {
        parse_args(&["--".to_owned(), pattern.to_owned()]).expect("options should parse")
    }

    fn matches(root: &std::path::Path, options: &SearchOptions) -> Vec<Value> {
        interrupted_matches(root, options, &|| None)
    }

    fn interrupted_matches(
        root: &std::path::Path,
        options: &SearchOptions,
        interrupted: &dyn Fn() -> Option<Interruption>,
    ) -> Vec<Value> {
        let mut output = Vec::new();
        search(root, options, &mut output, interrupted).expect("search should run");
        String::from_utf8(output)
            .expect("output should be UTF-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("each line should be JSON"))
            .collect()
    }

    fn summary(found: &[Value]) -> Vec<(String, u64)> {
        found
            .iter()
            .map(|message| {
                (
                    message["data"]["path"]["text"].as_str().unwrap().to_owned(),
                    message["data"]["line_number"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn parses_flags_and_requires_a_pattern() {
        let parsed = parse_args(
            &[
                "--ignore-case",
                "--multiline",
                "--max-results",
                "7",
                "--max-filesize",
                "2048",
                "--",
                "--not-a-flag",
            ]
            .map(str::to_owned),
        )
        .expect("options should parse");
        assert_eq!(
            parsed,
            SearchOptions {
                pattern: "--not-a-flag".to_owned(),
                ignore_case: true,
                multiline: true,
                max_results: 7,
                max_filesize: 2048,
            }
        );
        assert!(parse_args(&[]).is_err());
        assert!(parse_args(&["--".to_owned()]).is_err());
        assert!(parse_args(&["--bogus".to_owned(), "--".to_owned(), "x".to_owned()]).is_err());
        assert!(parse_args(&["--max-results".to_owned(), "lots".to_owned()]).is_err());
    }

    #[test]
    fn prints_matches_in_ripgrep_json_shape() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "first\nneedle and needle\n").unwrap();

        let found = matches(root.path(), &options("needle"));

        assert_eq!(found.len(), 1);
        let data = &found[0]["data"];
        assert_eq!(found[0]["type"], "match");
        assert_eq!(data["path"]["text"], "a.txt");
        assert_eq!(data["line_number"], 2);
        assert_eq!(data["lines"]["text"], "needle and needle\n");
        let offsets: Vec<(u64, u64)> = data["submatches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sub| (sub["start"].as_u64().unwrap(), sub["end"].as_u64().unwrap()))
            .collect();
        assert_eq!(offsets, [(0, 6), (11, 17)]);
    }

    #[test]
    fn searches_hidden_files_but_skips_git_ignored_binary_and_large_files() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "needle\n").unwrap();
        fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.path().join("ignored.txt"), "needle\n").unwrap();
        fs::write(root.path().join(".hidden"), "needle\n").unwrap();
        fs::write(root.path().join("binary.bin"), b"\0needle\n").unwrap();
        fs::write(
            root.path().join("large.txt"),
            format!("needle\n{}", "x".repeat(4096)),
        )
        .unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/kept.rs"), "needle\n").unwrap();
        let mut search_options = options("needle");
        search_options.max_filesize = 1024;

        let found = matches(root.path(), &search_options);

        assert_eq!(
            summary(&found),
            [(".hidden".to_owned(), 1), ("src/kept.rs".to_owned(), 1)]
        );
    }

    #[test]
    fn honours_case_and_multiline_options() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.ts"), "call(first,\n  second)\nNEEDLE\n").unwrap();

        assert!(matches(root.path(), &options("needle")).is_empty());
        let mut ignore_case = options("needle");
        ignore_case.ignore_case = true;
        assert_eq!(
            summary(&matches(root.path(), &ignore_case)),
            [("a.ts".to_owned(), 3)]
        );

        assert!(matches(root.path(), &options(r"first,\s+second")).is_empty());
        let mut multiline = options(r"first,\s+second");
        multiline.multiline = true;
        let found = matches(root.path(), &multiline);
        assert_eq!(summary(&found), [("a.ts".to_owned(), 1)]);
        assert_eq!(
            found[0]["data"]["lines"]["text"],
            "call(first,\n  second)\n"
        );
        assert_eq!(found[0]["data"]["submatches"][0]["start"], 5);
        assert_eq!(found[0]["data"]["submatches"][0]["end"], 20);
    }

    #[test]
    fn stops_at_the_result_limit_across_files() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needle\nneedle\n").unwrap();
        fs::write(root.path().join("b.txt"), "needle\n").unwrap();
        let mut limited = options("needle");
        limited.max_results = 2;

        assert_eq!(
            summary(&matches(root.path(), &limited)),
            [("a.txt".to_owned(), 1), ("a.txt".to_owned(), 2)]
        );
    }

    #[test]
    fn rejects_an_invalid_pattern() {
        let root = tempdir().unwrap();
        let mut output = Vec::new();
        assert!(search(root.path(), &options("("), &mut output, &|| None).is_err());
    }

    #[test]
    fn reports_a_search_cut_short_by_its_deadline() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needle\n").unwrap();

        let found = interrupted_matches(root.path(), &options("needle"), &|| {
            Some(Interruption::Deadline)
        });

        assert_eq!(
            found,
            [serde_json::json!({ "type": "stopped", "data": { "reason": "deadline" } })]
        );
    }

    #[test]
    fn stops_quietly_once_the_desktop_abandons_the_search() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needle\n").unwrap();

        let found = interrupted_matches(root.path(), &options("needle"), &|| {
            Some(Interruption::Abandoned)
        });

        assert!(found.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn notices_when_the_reader_of_its_output_goes_away() {
        // A child forked by another test thread holds the reader until it execs,
        // and keeps it for life without close-on-exec.
        let mut descriptors = [0; 2];
        #[cfg(target_os = "linux")]
        assert_eq!(
            unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) },
            0
        );
        // macOS has no pipe2, so a fork can still slip in before fcntl there.
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
            for descriptor in descriptors {
                assert_eq!(
                    unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) },
                    0
                );
            }
        }
        let [reader, writer] = descriptors;

        assert!(!super::descriptor_closed(writer));
        unsafe { libc::close(reader) };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !super::descriptor_closed(writer) {
            assert!(
                std::time::Instant::now() < deadline,
                "the hang-up never arrived"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        unsafe { libc::close(writer) };
    }

    #[test]
    fn previews_a_long_line_around_its_first_match() {
        let root = tempdir().unwrap();
        // Both window edges fall inside a two-byte "é", so they must move to whole characters.
        let line = format!(
            "{}é{} needle {}é{}needle\n",
            "a".repeat(2000),
            "c".repeat(254),
            "b".repeat(761),
            "b".repeat(5000)
        );
        fs::write(root.path().join("bundle.min.js"), &line).unwrap();

        let found = matches(root.path(), &options("needle"));

        let data = &found[0]["data"];
        let text = data["lines"]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_PREVIEW_BYTES);
        assert!(!text.contains('\u{fffd}'));
        let start = data["submatches"][0]["start"].as_u64().unwrap() as usize;
        assert_eq!(&text[start..start + 6], "needle");
        assert_eq!(data["submatches"].as_array().unwrap().len(), 1);
        assert_eq!(data["line_number"], 1);
    }

    #[test]
    fn stops_collecting_multiline_blocks_at_the_result_limit() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needle\nneedle\nneedle\n").unwrap();
        let mut limited = options("needle");
        limited.multiline = true;
        limited.max_results = 2;

        assert_eq!(
            summary(&matches(root.path(), &limited)),
            [("a.txt".to_owned(), 1), ("a.txt".to_owned(), 2)]
        );
    }
}
