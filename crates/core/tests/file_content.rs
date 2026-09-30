//! `get_file_content` / `save_temp_copy` through `Service` against a fake GitHub: each side must be
//! read from the same version the diff compares (head for new, merge base and old path for old),
//! with a larger size limit than diffs, and a side the file doesn't have is `NotFound`.
//! Own test binary because it sets `GH_TOKEN`.
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use fast_reviewer_core::auth::AuthConfig;
use fast_reviewer_core::model::Side;
use fast_reviewer_core::service::{MAX_CONTENT_BYTES, MAX_DIFF_BYTES};
use fast_reviewer_core::{Config, Error, Service};
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

/// Tip of the base branch: it gained commits after the PR branched off.
const BASE_TIP: &str = "b000000000000000000000000000000000000001";
/// Where the PR branched off (what GitHub's three-dot diff compares against).
const MERGE_BASE: &str = "a000000000000000000000000000000000000002";
const HEAD: &str = "c000000000000000000000000000000000000003";

/// (commit sha, path) -> file bytes.
type Repo = HashMap<(String, String), Vec<u8>>;

/// `GET /repos/o/r/contents/<path>?ref=<sha>` from an in-memory repo; records every request.
#[derive(Clone, Default)]
struct Contents {
    files: Arc<Mutex<Repo>>,
    fetched: Arc<Mutex<Vec<(String, String)>>>,
}

impl Contents {
    fn put(&self, sha: &str, path: &str, bytes: impl Into<Vec<u8>>) {
        self.files
            .lock()
            .unwrap()
            .insert((sha.to_owned(), path.to_owned()), bytes.into());
    }
    fn fetches(&self, path: &str) -> usize {
        let fetched = self.fetched.lock().unwrap();
        fetched.iter().filter(|(_, p)| p == path).count()
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
            Some(bytes) => ResponseTemplate::new(200).set_body_bytes(bytes.clone()),
            None => ResponseTemplate::new(404).set_body_json(json!({ "message": "Not Found" })),
        }
    }
}

/// A fake PNG: binary from the first byte, distinct per version.
fn png(tag: &str) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    b.extend_from_slice(tag.as_bytes());
    b
}

async fn service(server: &MockServer, cache_dir: &Path) -> Arc<Service> {
    std::env::remove_var("GITHUB_TOKEN");
    std::env::set_var("GH_TOKEN", "token");
    Service::new(Config {
        api_url: server.uri(),
        cache_dir: Some(cache_dir.to_path_buf()),
        auth: AuthConfig {
            env: true,
            gh_cli: false,
            keychain: false,
        },
    })
    .unwrap()
}

#[tokio::test]
async fn content_comes_from_the_diffed_versions() {
    let server = MockServer::start().await;
    let contents = Contents::default();
    // (path, previous path, GraphQL status, REST status)
    let files = [
        ("img/logo.png", None, "MODIFIED", "modified"),
        ("img/new.png", None, "ADDED", "added"),
        ("img/gone.png", None, "DELETED", "removed"),
        (
            "assets/icon.svg",
            Some("icons/icon.svg"),
            "RENAMED",
            "renamed",
        ),
        ("docs/big.pdf", None, "MODIFIED", "modified"),
        ("img/lost.png", None, "MODIFIED", "modified"),
    ];
    contents.put(MERGE_BASE, "img/logo.png", png("old"));
    contents.put(BASE_TIP, "img/logo.png", png("main moved on"));
    contents.put(HEAD, "img/logo.png", png("new"));
    contents.put(HEAD, "img/new.png", png("added"));
    contents.put(MERGE_BASE, "img/gone.png", png("removed"));
    contents.put(MERGE_BASE, "icons/icon.svg", "<svg>old</svg>");
    contents.put(BASE_TIP, "icons/icon.svg", "<svg>main</svg>");
    contents.put(HEAD, "assets/icon.svg", "<svg>new</svg>");
    // Too large to diff, small enough to show or open.
    let big = vec![b'%'; MAX_DIFF_BYTES + 1];
    assert!(big.len() < MAX_CONTENT_BYTES);
    contents.put(HEAD, "docs/big.pdf", big.clone());
    // img/lost.png exists nowhere: GitHub answers 404.

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": "octocat" })))
        .mount(&server)
        .await;
    let gql_files: Vec<Value> = files
        .iter()
        .map(|(p, _, status, _)| {
            json!({ "path": p, "additions": 1, "deletions": 1,
            "changeType": status, "viewerViewedState": "UNVIEWED" })
        })
        .collect();
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "data": { "repository": { "pullRequest": {
                "id": "PR_node", "title": "Images", "url": "https://github.com/o/r/pull/9",
                "author": { "login": "a" }, "baseRefName": "main", "headRefName": "feature",
                "baseRefOid": BASE_TIP, "headRefOid": HEAD, "changedFiles": files.len(),
                "files": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": gql_files }
            }}}}),
        ))
        .mount(&server)
        .await;
    // GraphQL has no previous path; the service reads renames from the REST file list.
    let rest_files: Vec<Value> = files
        .iter()
        .map(|(p, prev, _, status)| {
            json!({ "filename": p, "previous_filename": prev, "status": status,
                "additions": 1, "deletions": 1 })
        })
        .collect();
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(Value::Array(rest_files)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/compare/{BASE_TIP}...{HEAD}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "merge_base_commit": { "sha": MERGE_BASE } })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex("^/repos/o/r/contents/"))
        .respond_with(contents.clone())
        .mount(&server)
        .await;

    let cache = tempfile::tempdir().unwrap();
    let svc = service(&server, cache.path()).await;
    // No get_pr first: the PR is loaded on demand, as for get_file_diff.
    let read = |path: &'static str, side| {
        let svc = svc.clone();
        async move { svc.get_file_content("o", "r", 9, path, side).await }
    };

    let new = read("img/logo.png", Side::New).await.unwrap();
    assert_eq!(
        (new.sha.as_str(), new.path.as_str()),
        (HEAD, "img/logo.png")
    );
    assert_eq!(new.bytes, png("new"));
    let old = read("img/logo.png", Side::Old).await.unwrap();
    assert_eq!((old.sha.as_str(), old.bytes), (MERGE_BASE, png("old")));

    // Renames: the old side is the previous path at the merge base.
    let old = read("assets/icon.svg", Side::Old).await.unwrap();
    assert_eq!(
        (old.sha.as_str(), old.path.as_str(), old.bytes),
        (MERGE_BASE, "icons/icon.svg", b"<svg>old</svg>".to_vec())
    );
    let new = read("assets/icon.svg", Side::New).await.unwrap();
    assert_eq!(new.bytes, b"<svg>new</svg>");

    assert_eq!(
        read("img/new.png", Side::New).await.unwrap().bytes,
        png("added")
    );
    assert_eq!(
        read("img/gone.png", Side::Old).await.unwrap().bytes,
        png("removed")
    );

    // A side the file doesn't have, or one GitHub doesn't know: NotFound.
    for (path, side) in [
        ("img/new.png", Side::Old),
        ("img/gone.png", Side::New),
        ("img/lost.png", Side::New),
        ("img/lost.png", Side::Old),
    ] {
        let err = read(path, side).await.err();
        assert!(
            matches!(err, Some(Error::NotFound(_))),
            "{path} {side:?}: {err:?}"
        );
    }
    // The absent sides were never requested.
    assert_eq!(contents.fetches("img/new.png"), 1);
    assert_eq!(contents.fetches("img/gone.png"), 1);

    // Too large to diff, but returned in full.
    let d = svc
        .get_file_diff("o", "r", 9, "docs/big.pdf")
        .await
        .unwrap();
    assert!(d.too_large);
    assert_eq!(read("docs/big.pdf", Side::New).await.unwrap().bytes, big);

    // Small files come from the disk cache the second time; files too large to diff are not
    // cached, so they are fetched again.
    let (logo, pdf) = (
        contents.fetches("img/logo.png"),
        contents.fetches("docs/big.pdf"),
    );
    read("img/logo.png", Side::New).await.unwrap();
    read("docs/big.pdf", Side::New).await.unwrap();
    assert_eq!(contents.fetches("img/logo.png"), logo);
    assert_eq!(contents.fetches("docs/big.pdf"), pdf + 1);

    let fetched = contents.fetched.lock().unwrap().clone();
    assert!(
        fetched
            .iter()
            .all(|(sha, _)| sha == MERGE_BASE || sha == HEAD),
        "fetched contents outside the merge base and head: {fetched:?}"
    );

    // Temp copies keep the file name, and the two sides land in different directories.
    let root = tempfile::tempdir().unwrap();
    let copy = |path: &'static str, side| {
        let (svc, root) = (svc.clone(), root.path().to_path_buf());
        async move { svc.save_temp_copy(&root, "o", "r", 9, path, side).await }
    };
    let new = copy("img/logo.png", Side::New).await.unwrap();
    let old = copy("img/logo.png", Side::Old).await.unwrap();
    assert_eq!(new, root.path().join("o/r/9/new-c00000000000/logo.png"));
    assert_eq!(old, root.path().join("o/r/9/old-a00000000000/logo.png"));
    assert_eq!(std::fs::read(&new).unwrap(), png("new"));
    assert_eq!(std::fs::read(&old).unwrap(), png("old"));
    let renamed = copy("assets/icon.svg", Side::Old).await.unwrap();
    assert_eq!(renamed.file_name().unwrap(), "icon.svg");
    assert!(matches!(
        copy("img/new.png", Side::Old).await,
        Err(Error::NotFound(_))
    ));
}
