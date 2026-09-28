//! End to end through `Service` against a fake GitHub: the diff for each file of the fixture PR
//! must be built from the right versions (merge base vs head, old path for renames) and match
//! `git diff`. The base branch has moved on since the PR branched and its tip holds different
//! contents, so diffing against the wrong commit or path gives a diff that no longer matches.
//! Own test binary because it sets `GH_TOKEN`.
mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use common::{assert_matches_git, fixture_names, read_fixture};
use fast_reviewer_core::auth::AuthConfig;
use fast_reviewer_core::model::FileDiff;
use fast_reviewer_core::{Config, Service};
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

/// Tip of the base branch: it gained commits after the PR branched off.
const BASE_TIP: &str = "b000000000000000000000000000000000000001";
/// Where the PR branched off (what GitHub's three-dot diff compares against).
const MERGE_BASE: &str = "a000000000000000000000000000000000000002";
const HEAD: &str = "c000000000000000000000000000000000000003";
/// Head after a new push to the PR.
const HEAD2: &str = "c000000000000000000000000000000000000004";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Added,
    Deleted,
    Renamed,
    Modified,
}

impl Status {
    fn graphql(self) -> &'static str {
        match self {
            Status::Added => "ADDED",
            Status::Deleted => "DELETED",
            Status::Renamed => "RENAMED",
            Status::Modified => "MODIFIED",
        }
    }
    fn rest(self) -> &'static str {
        match self {
            Status::Added => "added",
            Status::Deleted => "removed",
            Status::Renamed => "renamed",
            Status::Modified => "modified",
        }
    }
}

struct Case {
    /// Fixture holding the old/new contents and git's diff.
    fixture: String,
    old_path: String,
    path: String,
    status: Status,
}

/// Paths and status from the fixture's `diff --git a/<old> b/<new>` header.
fn fixture_case(name: &str) -> Case {
    let git = read_fixture(name, "git.diff");
    let first = git.lines().next().unwrap();
    let (a, b) = first
        .strip_prefix("diff --git a/")
        .and_then(|s| s.split_once(" b/"))
        .unwrap();
    let status = if git.contains("\nnew file mode") {
        Status::Added
    } else if git.contains("\ndeleted file mode") {
        Status::Deleted
    } else if a != b {
        Status::Renamed
    } else {
        Status::Modified
    };
    Case {
        fixture: name.to_owned(),
        old_path: a.to_owned(),
        path: b.to_owned(),
        status,
    }
}

fn cases() -> Vec<Case> {
    let mut cases: Vec<Case> = fixture_names().iter().map(|n| fixture_case(n)).collect();
    // A rename with edits (the fixture PR only has a pure rename): math.ts's change, moved.
    cases.push(Case {
        fixture: "sample__src__lib__math.ts".into(),
        old_path: "sample/src/geometry.ts".into(),
        path: "sample/src/lib/geometry.ts".into(),
        status: Status::Renamed,
    });
    cases
}

/// `GET /repos/o/r/contents/<path>?ref=<sha>` from an in-memory repo; records every request.
#[derive(Clone, Default)]
struct Contents {
    files: Arc<Mutex<HashMap<(String, String), String>>>,
    fetched: Arc<Mutex<Vec<(String, String)>>>,
}

impl Contents {
    fn put(&self, sha: &str, path: &str, text: impl Into<String>) {
        self.files
            .lock()
            .unwrap()
            .insert((sha.to_owned(), path.to_owned()), text.into());
    }
}

impl Respond for Contents {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let path = req
            .url
            .path()
            .strip_prefix("/repos/o/r/contents/")
            .unwrap()
            .to_owned();
        let sha = req
            .url
            .query_pairs()
            .find(|(k, _)| k == "ref")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        self.fetched
            .lock()
            .unwrap()
            .push((sha.clone(), path.clone()));
        match self.files.lock().unwrap().get(&(sha, path)) {
            Some(text) => ResponseTemplate::new(200).set_body_bytes(text.clone().into_bytes()),
            None => ResponseTemplate::new(404).set_body_json(json!({ "message": "Not Found" })),
        }
    }
}

/// GraphQL PR query; the head SHA can move between calls.
struct PrQuery {
    head: Arc<Mutex<String>>,
    files: Value,
}

impl Respond for PrQuery {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let head = self.head.lock().unwrap().clone();
        ResponseTemplate::new(200).set_body_json(json!({ "data": { "repository": { "pullRequest": {
            "id": "PR_node", "title": "Fixture PR", "url": "https://github.com/o/r/pull/9",
            "author": { "login": "a" }, "baseRefName": "main", "headRefName": "feature",
            "baseRefOid": BASE_TIP, "headRefOid": head,
            "changedFiles": self.files.as_array().unwrap().len(),
            "files": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": self.files }
        }}}}))
    }
}

async fn diff(svc: &Arc<Service>, path: &str) -> Arc<FileDiff> {
    svc.get_file_diff("o", "r", 9, path)
        .await
        .unwrap_or_else(|e| panic!("{path}: {e:?}"))
}

#[tokio::test]
async fn diffs_use_the_merge_base_old_paths_and_the_current_head() {
    let cases = cases();
    let server = MockServer::start().await;
    let contents = Contents::default();
    for c in &cases {
        let (old, new) = (
            read_fixture(&c.fixture, "old"),
            read_fixture(&c.fixture, "new"),
        );
        if c.status != Status::Added {
            contents.put(MERGE_BASE, &c.old_path, old.clone());
            // The base branch changed the file after the PR branched off.
            contents.put(
                BASE_TIP,
                &c.old_path,
                format!("{old}// changed on main later\n"),
            );
        }
        if c.status != Status::Deleted {
            contents.put(HEAD, &c.path, new);
        }
    }

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": "octocat" })))
        .mount(&server)
        .await;
    let head = Arc::new(Mutex::new(HEAD.to_owned()));
    let gql_files: Vec<Value> = cases
        .iter()
        .map(|c| {
            json!({ "path": c.path, "additions": 1, "deletions": 1,
            "changeType": c.status.graphql(), "viewerViewedState": "UNVIEWED" })
        })
        .collect();
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(PrQuery {
            head: head.clone(),
            files: Value::Array(gql_files),
        })
        .mount(&server)
        .await;
    // GraphQL has no previous path; the service reads renames from the REST file list.
    let rest_files: Vec<Value> = cases
        .iter()
        .map(|c| {
            let prev = (c.status == Status::Renamed).then(|| c.old_path.clone());
            json!({ "filename": c.path, "previous_filename": prev, "status": c.status.rest(),
                "additions": 1, "deletions": 1 })
        })
        .collect();
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(Value::Array(rest_files)))
        .mount(&server)
        .await;
    for h in [HEAD, HEAD2] {
        Mock::given(method("GET"))
            .and(path(format!("/repos/o/r/compare/{BASE_TIP}...{h}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "merge_base_commit": { "sha": MERGE_BASE } })),
            )
            .mount(&server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path_regex("^/repos/o/r/contents/"))
        .respond_with(contents.clone())
        .mount(&server)
        .await;

    std::env::remove_var("GITHUB_TOKEN");
    std::env::set_var("GH_TOKEN", "token");
    let svc = Service::new(Config {
        api_url: server.uri(),
        cache_dir: None,
        auth: AuthConfig {
            env: true,
            gh_cli: false,
            keychain: false,
        },
    })
    .unwrap();
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files.len(), cases.len());

    for c in &cases {
        let d = diff(&svc, &c.path).await;
        let name = format!("{} ({})", c.path, c.fixture);
        let (old, new) = (
            read_fixture(&c.fixture, "old"),
            read_fixture(&c.fixture, "new"),
        );
        assert_eq!(d.path, c.path, "{name}");
        let expect_old_path = (c.status == Status::Renamed).then(|| c.old_path.clone());
        assert_eq!(d.old_path, expect_old_path, "{name}: old path");
        assert!(!d.binary && !d.too_large, "{name}");
        // new_text is what "expand context" shows; old_text is kept for the same reason.
        let expect_old = (c.status != Status::Added).then_some(old);
        let expect_new = (c.status != Status::Deleted).then_some(new);
        assert_eq!(d.old_text, expect_old, "{name}: old side");
        assert_eq!(d.new_text, expect_new, "{name}: new side");
        assert_matches_git(&c.fixture, &d.hunks, &read_fixture(&c.fixture, "git.diff"));
    }

    let fetched = contents.fetched.lock().unwrap().clone();
    assert!(
        fetched
            .iter()
            .all(|(sha, _)| sha == MERGE_BASE || sha == HEAD),
        "fetched contents outside the merge base and head: {fetched:?}"
    );

    // A new push moves the head: reopening the PR must show the new contents, not a cached diff.
    let moved = cases
        .iter()
        .find(|c| c.path == "sample/src/lib/math.ts")
        .unwrap();
    let new2 = format!(
        "{}export const pushedLater = 1;\n",
        read_fixture(&moved.fixture, "new")
    );
    contents.put(HEAD2, &moved.path, new2.clone());
    *head.lock().unwrap() = HEAD2.to_owned();
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.head_sha, HEAD2);
    let d = diff(&svc, &moved.path).await;
    assert_eq!(d.new_text.as_deref(), Some(new2.as_str()));
    let last = d.hunks.last().unwrap().lines.last().unwrap();
    assert_eq!(last.text, "export const pushedLater = 1;");
    assert_eq!(last.new_no, Some(new2.lines().count() as u32));
}
