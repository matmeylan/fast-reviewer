//! Read-only correctness check: diff every file of a real PR with our engine (through the
//! `Service`, exactly as the app does) and compare with `git diff` in a local clone.
//!
//! Usage:
//!   GH_TOKEN=... cargo run -p fast_reviewer_core --example compare_git -- <owner> <repo> <number> [<git clone>]
//!
//! Prints every hunk in unified format. With a clone (which must contain the PR's base and head
//! commits; `git fetch` it first), each file is also diffed with
//! `git diff --no-color -U3 -M <merge-base> <head> -- <old path> <path>` and compared:
//! hunk headers must match exactly, and the hunk bodies must either match or describe the same
//! edit with the same size (git and we may pair lines differently). Exits 1 on a mismatch.
//!
//! Never writes to GitHub (no `set_file_viewed`).
use std::process::Command;

use fast_reviewer_core::model::{ChangedFile, FileDiff, FileStatus, LineKind};
use fast_reviewer_core::{Config, Service};

type Header = (u32, u32, u32, u32);

#[derive(Debug, PartialEq, Eq)]
struct UHunk {
    header: Header,
    lines: Vec<(char, String)>,
}

#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    Binary,
    Hunks(Vec<UHunk>),
}

enum Verdict {
    Same,
    /// Same headers and edit size, different pairing of lines.
    Equivalent,
    Mismatch(String),
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (owner, repo, number, clone) = match args.as_slice() {
        [o, r, n] => (o, r, n, None),
        [o, r, n, c] => (o, r, n, Some(c.as_str())),
        _ => {
            eprintln!("usage: compare_git <owner> <repo> <number> [<git clone>]");
            std::process::exit(2);
        }
    };
    let number: u64 = number.parse()?;
    let svc = Service::new(Config {
        cache_dir: None,
        ..Config::from_env()
    })?;

    let pr = svc.get_pr(owner, repo, number).await?;
    println!(
        "# {owner}/{repo}#{number} {:?}: {} ({}) -> {} ({}), {} files",
        pr.title,
        pr.head_ref,
        short(&pr.head_sha),
        pr.base_ref,
        short(&pr.base_sha),
        pr.files.len()
    );

    let merge_base = match clone {
        Some(dir) => {
            for sha in [&pr.base_sha, &pr.head_sha] {
                if git(dir, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_err() {
                    eprintln!("commit {sha} missing in {dir}; run `git -C {dir} fetch` first");
                    std::process::exit(2);
                }
            }
            let mb = git(dir, &["merge-base", &pr.base_sha, &pr.head_sha])?;
            let mb = mb.trim().to_owned();
            println!("# merge base (git): {mb}");
            Some((dir, mb))
        }
        None => None,
    };

    let mut failures = 0;
    for f in &pr.files {
        let d = svc.get_file_diff(owner, repo, number, &f.path).await?;
        print_file(f, &d);
        let Some((dir, mb)) = &merge_base else {
            continue;
        };
        let ours = if d.binary {
            Parsed::Binary
        } else if d.too_large {
            println!("## {}: too large, not compared", f.path);
            continue;
        } else {
            Parsed::Hunks(to_uhunks(&d))
        };
        let mut cmd = vec!["diff", "--no-color", "-U3", "-M", mb, &pr.head_sha, "--"];
        if let Some(prev) = &f.previous_path {
            cmd.push(prev);
        }
        cmd.push(&f.path);
        let theirs = parse_git(&git(dir, &cmd)?);
        let problems = consistency(&d);
        match (compare(&ours, &theirs), problems.is_empty()) {
            (Verdict::Same, true) => println!("## {}: OK (identical to git)", f.path),
            (Verdict::Equivalent, true) => println!(
                "## {}: OK (same hunks and edit size as git; lines paired differently)",
                f.path
            ),
            (v, _) => {
                failures += 1;
                println!("## {}: MISMATCH", f.path);
                if let Verdict::Mismatch(why) = v {
                    println!("##   {why}");
                }
                for p in problems {
                    println!("##   {p}");
                }
                println!("##   git:  {theirs:?}");
                println!("##   ours: {ours:?}");
            }
        }
    }
    if merge_base.is_some() {
        println!("# {} files, {failures} mismatches", pr.files.len());
    }
    std::process::exit(i32::from(failures > 0));
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn kind_char(k: LineKind) -> char {
    match k {
        LineKind::Context => ' ',
        LineKind::Del => '-',
        LineKind::Add => '+',
    }
}

fn print_file(f: &ChangedFile, d: &FileDiff) {
    let old = d.old_path.as_deref().unwrap_or(&d.path);
    let (a, b) = match f.status {
        FileStatus::Added => ("/dev/null".to_owned(), format!("b/{}", d.path)),
        FileStatus::Removed => (format!("a/{old}"), "/dev/null".to_owned()),
        _ => (format!("a/{old}"), format!("b/{}", d.path)),
    };
    println!(
        "diff {:?} +{} -{} {}",
        f.status, f.additions, f.deletions, d.path
    );
    if d.binary {
        println!("Binary files {a} and {b} differ");
        return;
    }
    if d.too_large {
        println!("(too large to diff)");
        return;
    }
    println!("--- {a}\n+++ {b}");
    for h in &d.hunks {
        println!(
            "@@ -{},{} +{},{} @@",
            h.old_start, h.old_lines, h.new_start, h.new_lines
        );
        for l in &h.lines {
            println!("{}{}", kind_char(l.kind), l.text);
        }
    }
}

fn to_uhunks(d: &FileDiff) -> Vec<UHunk> {
    d.hunks
        .iter()
        .map(|h| UHunk {
            header: (h.old_start, h.old_lines, h.new_start, h.new_lines),
            lines: h
                .lines
                .iter()
                .map(|l| (kind_char(l.kind), l.text.clone()))
                .collect(),
        })
        .collect()
}

fn parse_range(s: &str) -> (u32, u32) {
    let (a, b) = s.split_once(',').unwrap_or((s, "1"));
    (a.parse().unwrap_or(0), b.parse().unwrap_or(0))
}

/// Parse `git diff` output for one file. Drops `\ No newline at end of file` markers.
fn parse_git(out: &str) -> Parsed {
    let mut hunks: Vec<UHunk> = Vec::new();
    for line in out.lines() {
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            return Parsed::Binary;
        }
        if let Some(rest) = line.strip_prefix("@@ -") {
            let ranges = rest.split_once(" @@").map_or(rest, |(r, _)| r);
            let (old, new) = ranges.split_once(" +").unwrap_or((ranges, "0,0"));
            let (os, ol) = parse_range(old);
            let (ns, nl) = parse_range(new);
            hunks.push(UHunk {
                header: (os, ol, ns, nl),
                lines: Vec::new(),
            });
        } else if let Some(h) = hunks.last_mut() {
            let mut chars = line.chars();
            if let Some(k @ (' ' | '-' | '+')) = chars.next() {
                h.lines.push((k, chars.as_str().to_owned()));
            }
        }
    }
    Parsed::Hunks(hunks)
}

fn compare(ours: &Parsed, git: &Parsed) -> Verdict {
    let (a, b) = match (ours, git) {
        _ if ours == git => return Verdict::Same,
        (Parsed::Hunks(a), Parsed::Hunks(b)) => (a, b),
        _ => return Verdict::Mismatch("binary on one side only".into()),
    };
    if a.len() != b.len() {
        return Verdict::Mismatch(format!("{} hunks vs git's {}", a.len(), b.len()));
    }
    let side = |h: &UHunk, skip: char| -> Vec<String> {
        h.lines
            .iter()
            .filter(|(k, _)| *k != skip)
            .map(|(_, t)| t.clone())
            .collect()
    };
    let count = |h: &UHunk, k: char| h.lines.iter().filter(|(x, _)| *x == k).count();
    for (x, y) in a.iter().zip(b) {
        if x.header != y.header {
            return Verdict::Mismatch(format!("header {:?} vs git's {:?}", x.header, y.header));
        }
        if side(x, '+') != side(y, '+') || side(x, '-') != side(y, '-') {
            return Verdict::Mismatch(format!("hunk {:?}: different old/new text", x.header));
        }
        if (count(x, '-'), count(x, '+')) != (count(y, '-'), count(y, '+')) {
            return Verdict::Mismatch(format!("hunk {:?}: different edit size", x.header));
        }
    }
    Verdict::Equivalent
}

/// Line numbers must follow from each hunk header and the line kinds.
fn consistency(d: &FileDiff) -> Vec<String> {
    let mut problems = Vec::new();
    for h in &d.hunks {
        let (mut o, mut n) = (h.old_start.max(1), h.new_start.max(1));
        let (mut old_count, mut new_count) = (0, 0);
        for l in &h.lines {
            let want = match l.kind {
                LineKind::Context => (Some(o), Some(n)),
                LineKind::Del => (Some(o), None),
                LineKind::Add => (None, Some(n)),
            };
            if (l.old_no, l.new_no) != want {
                problems.push(format!(
                    "line {:?}: numbers {:?} expected {want:?}",
                    l.text,
                    (l.old_no, l.new_no)
                ));
            }
            if l.kind != LineKind::Add {
                o += 1;
                old_count += 1;
            }
            if l.kind != LineKind::Del {
                n += 1;
                new_count += 1;
            }
        }
        if (old_count, new_count) != (h.old_lines, h.new_lines) {
            problems.push(format!(
                "hunk -{},{} +{},{} has {old_count}/{new_count} lines",
                h.old_start, h.old_lines, h.new_start, h.new_lines
            ));
        }
    }
    problems
}
