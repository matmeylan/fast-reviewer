//! Regression tests for PR loading, auth races and large-file handling.
use std::sync::Arc;
use std::time::{Duration, Instant};

use fast_reviewer_core::auth::AuthConfig;
use fast_reviewer_core::model::{FileStatus, PrState};
use fast_reviewer_core::service::MAX_DIFF_BYTES;
use fast_reviewer_core::{Config, Error, Service};
use serde_json::{json, Value};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";
const HEAD2: &str = "4444444444444444444444444444444444444444";
const MERGE_BASE: &str = "3333333333333333333333333333333333333333";

async fn setup_with_cache(cache: Option<std::path::PathBuf>) -> (MockServer, Arc<Service>) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": "octocat" })))
        .mount(&server)
        .await;
    let svc = Service::new(Config {
        api_url: server.uri(),
        cache_dir: cache,
        auth: AuthConfig::none(),
    })
    .unwrap();
    svc.use_token("test-token").await.unwrap();
    (server, svc)
}

async fn setup() -> (MockServer, Arc<Service>) {
    setup_with_cache(None).await
}

fn gql_file(path: &str, change: &str) -> Value {
    json!({ "path": path, "additions": 1, "deletions": 2, "changeType": change, "viewerViewedState": "UNVIEWED" })
}

fn pr_page(head: &str, files: Vec<Value>, total: usize, next: Option<&str>) -> Value {
    json!({ "data": { "repository": { "pullRequest": {
        "id": "PR_node", "title": "Add things", "url": "https://github.com/o/r/pull/9",
        "author": { "login": "alice" },
        "baseRefName": "main", "headRefName": "feature",
        "baseRefOid": BASE, "headRefOid": head, "changedFiles": total,
        "files": { "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next }, "nodes": files }
    }}}})
}

async fn mount_merge_base(server: &MockServer, head: &str) {
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/compare/{BASE}...{head}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "merge_base_commit": { "sha": MERGE_BASE } })),
        )
        .mount(server)
        .await;
}

async fn mount_single_page(server: &MockServer, files: Vec<Value>) {
    let n = files.len();
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pr_page(HEAD, files, n, None)))
        .mount(server)
        .await;
    mount_merge_base(server, HEAD).await;
}

async fn mount_content(server: &MockServer, sha: &str, file: &str, body: &[u8]) {
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/contents/{file}")))
        .and(query_param("ref", sha))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
        .mount(server)
        .await;
}

/// REST file listing where every requested page is full, `delay` per page.
struct RestPages {
    total: usize,
    delay: Duration,
}

impl Respond for RestPages {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let page: usize = req
            .url
            .query_pairs()
            .find(|(k, _)| k == "page")
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(1);
        let start = (page - 1) * 100;
        let files: Vec<Value> = (start..(start + 100).min(self.total))
            .map(|i| json!({ "filename": format!("f{i:05}.ts"), "status": "modified" }))
            .collect();
        ResponseTemplate::new(200)
            .set_body_json(Value::Array(files))
            .set_delay(self.delay)
    }
}

#[tokio::test]
async fn graphql_state_maps_to_pr_state() {
    for (state, draft, want) in [
        (None, false, PrState::Open),
        (Some("OPEN"), false, PrState::Open),
        (Some("OPEN"), true, PrState::Draft),
        (Some("MERGED"), false, PrState::Merged),
        (Some("CLOSED"), true, PrState::Closed),
    ] {
        let (server, svc) = setup().await;
        let mut page = pr_page(HEAD, vec![gql_file("a.ts", "MODIFIED")], 1, None);
        let pr = &mut page["data"]["repository"]["pullRequest"];
        if let Some(s) = state {
            pr["state"] = json!(s);
        }
        pr["isDraft"] = json!(draft);
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page))
            .mount(&server)
            .await;
        mount_merge_base(&server, HEAD).await;
        let pr = svc.get_pr("o", "r", 9).await.unwrap();
        assert_eq!(pr.state, want, "{state:?} draft={draft}");
    }
}

// ---- REST file list: only when needed, and in parallel ----

#[tokio::test]
async fn rest_files_skipped_without_renames() {
    let (server, svc) = setup().await;
    mount_single_page(
        &server,
        vec![gql_file("a.ts", "MODIFIED"), gql_file("b.ts", "ADDED")],
    )
    .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .expect(0)
        .mount(&server)
        .await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files.len(), 2);
    server.verify().await;
}

#[tokio::test]
async fn rest_file_pages_fetched_in_parallel_when_total_known() {
    let (server, svc) = setup().await;
    // 250 files over three GraphQL pages; one rename.
    let mut all: Vec<Value> = (0..250)
        .map(|i| gql_file(&format!("f{i:05}.ts"), "MODIFIED"))
        .collect();
    all[249] = gql_file("f00249.ts", "RENAMED");
    for (i, chunk) in all.chunks(100).enumerate() {
        let after = if i == 0 {
            Value::Null
        } else {
            json!(format!("c{i}"))
        };
        let next = (i < 2).then(|| format!("c{}", i + 1));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(wiremock::matchers::body_partial_json(
                json!({ "variables": { "after": after } }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(pr_page(
                HEAD,
                chunk.to_vec(),
                250,
                next.as_deref(),
            )))
            .mount(&server)
            .await;
    }
    mount_merge_base(&server, HEAD).await;
    for page in 1..=3 {
        let start = (page - 1) * 100;
        let files: Vec<Value> = (start..(start + 100).min(250))
            .map(|i| {
                if i == 249 {
                    json!({ "filename": "f00249.ts", "previous_filename": "old.ts", "status": "renamed" })
                } else {
                    json!({ "filename": format!("f{i:05}.ts"), "status": "modified" })
                }
            })
            .collect();
        Mock::given(method("GET"))
            .and(path("/repos/o/r/pulls/9/files"))
            .and(query_param("page", page.to_string()))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(Value::Array(files))
                    .set_delay(Duration::from_millis(400)),
            )
            .expect(1)
            .mount(&server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .and(query_param("page", "4"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .expect(0)
        .mount(&server)
        .await;

    let t = Instant::now();
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    let took = t.elapsed();
    assert_eq!(pr.files.len(), 250);
    let renamed = pr.files.iter().find(|f| f.path == "f00249.ts").unwrap();
    assert_eq!(renamed.previous_path.as_deref(), Some("old.ts"));
    // Three 400 ms pages one after another would take 1.2 s.
    assert!(took < Duration::from_millis(1000), "took {took:?}");
    server.verify().await;
}

// ---- REST failure with renames must not produce a wrong (cached) diff ----

#[tokio::test]
async fn rest_failure_with_renames_is_an_error_not_a_wrong_diff() {
    let (server, svc) = setup().await;
    mount_single_page(&server, vec![gql_file("new.py", "RENAMED")]).await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(502).set_body_json(json!({ "message": "bad gw" })))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "filename": "new.py", "previous_filename": "old.py", "status": "renamed" }
        ])))
        .mount(&server)
        .await;
    mount_content(&server, MERGE_BASE, "old.py", b"print(1)\n").await;
    mount_content(&server, HEAD, "new.py", b"print(2)\n").await;

    let err = svc.get_pr("o", "r", 9).await.unwrap_err();
    assert!(matches!(err, Error::Api { status: 502, .. }), "{err:?}");

    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files[0].previous_path.as_deref(), Some("old.py"));
    let d = svc.get_file_diff("o", "r", 9, "new.py").await.unwrap();
    assert_eq!(d.old_path.as_deref(), Some("old.py"));
    assert_eq!(d.old_text.as_deref(), Some("print(1)\n"));
}

// ---- truncation of huge PRs ----

/// GraphQL pages of 100 files that always report more, for a PR of `total` files.
struct EndlessGql {
    total: usize,
}

impl Respond for EndlessGql {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        let page: usize = body["variables"]["after"]
            .as_str()
            .and_then(|c| c.trim_start_matches('c').parse().ok())
            .unwrap_or(0);
        let files: Vec<Value> = (page * 100..(page + 1) * 100)
            .map(|i| gql_file(&format!("f{i:05}.ts"), "MODIFIED"))
            .collect();
        let next = format!("c{}", page + 1);
        let has_next = (page + 1) * 100 < self.total;
        ResponseTemplate::new(200).set_body_json(pr_page(
            HEAD,
            files,
            self.total,
            has_next.then_some(next.as_str()),
        ))
    }
}

#[tokio::test]
async fn huge_pr_reports_truncation() {
    let (server, svc) = setup().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(EndlessGql { total: 4500 })
        .mount(&server)
        .await;
    mount_merge_base(&server, HEAD).await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files.len(), 3000);
    assert_eq!(pr.total_files, 4500);
    assert!(pr.files_truncated);
}

#[tokio::test]
async fn complete_pr_is_not_truncated() {
    let (server, svc) = setup().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(EndlessGql { total: 300 })
        .mount(&server)
        .await;
    mount_merge_base(&server, HEAD).await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files.len(), 300);
    assert_eq!(pr.total_files, 300);
    assert!(!pr.files_truncated);
}

#[tokio::test]
async fn huge_pr_reports_truncation_on_rest_fallback() {
    let (server, svc) = setup().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({ "message": "GraphQL is not available" })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "number": 9, "node_id": "PR_rest", "title": "t", "html_url": "u",
            "user": { "login": "alice" }, "changed_files": 3200,
            "base": { "ref": "main", "sha": BASE }, "head": { "ref": "f", "sha": HEAD }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(RestPages {
            // GitHub stops listing at 3000.
            total: 3000,
            delay: Duration::ZERO,
        })
        .mount(&server)
        .await;
    mount_merge_base(&server, HEAD).await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files.len(), 3000);
    assert_eq!(pr.total_files, 3200);
    assert!(pr.files_truncated);
}

// ---- overlapping get_pr calls ----

#[tokio::test]
async fn older_get_pr_does_not_overwrite_newer_pr_info() {
    let (server, svc) = setup().await;
    // First request (head HEAD) is slow; second (head HEAD2, adds new.ts) is fast.
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(pr_page(HEAD, vec![gql_file("a.ts", "MODIFIED")], 1, None))
                .set_delay(Duration::from_millis(400)),
        )
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pr_page(
            HEAD2,
            vec![gql_file("a.ts", "MODIFIED"), gql_file("new.ts", "ADDED")],
            2,
            None,
        )))
        .mount(&server)
        .await;
    mount_merge_base(&server, HEAD).await;
    mount_merge_base(&server, HEAD2).await;
    mount_content(&server, HEAD2, "new.ts", b"hi\n").await;

    let slow = {
        let svc = svc.clone();
        tokio::spawn(async move { svc.get_pr("o", "r", 9).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let fresh = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(fresh.head_sha, HEAD2);
    let stale = slow.await.unwrap().unwrap();
    assert_eq!(stale.head_sha, HEAD);

    let d = svc.get_file_diff("o", "r", 9, "new.ts").await.unwrap();
    assert_eq!(d.old_text, None);
    assert_eq!(d.new_text.as_deref(), Some("hi\n"));
}

// ---- a 401 from an old token must not sign out a newly set one ----

#[tokio::test]
async fn stale_401_does_not_clear_new_token() {
    let (server, svc) = setup().await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("authorization", "Bearer new-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": "newuser" })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_json(json!({ "message": "Bad credentials" }))
                .set_delay(Duration::from_millis(400)),
        )
        .mount(&server)
        .await;

    let old = {
        let svc = svc.clone();
        tokio::spawn(async move { svc.list_repo_prs("o", "r").await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let st = svc.set_token("new-token").await.unwrap();
    assert_eq!(st.login.as_deref(), Some("newuser"));
    assert_eq!(old.await.unwrap().unwrap_err(), Error::Unauthorized);

    let st = svc.auth_status().await.unwrap();
    assert!(st.authenticated, "new token was dropped by a stale 401");
    assert_eq!(st.login.as_deref(), Some("newuser"));
}

// ---- large files ----

fn files_in(dir: &std::path::Path) -> Vec<(std::path::PathBuf, u64)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files_in(&p));
        } else {
            out.push((p.clone(), e.metadata().unwrap().len()));
        }
    }
    out
}

#[tokio::test]
async fn oversized_files_are_not_cached_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let (server, svc) = setup_with_cache(Some(dir.path().to_path_buf())).await;
    mount_single_page(
        &server,
        vec![
            gql_file("big.txt", "MODIFIED"),
            gql_file("big.bin", "MODIFIED"),
        ],
    )
    .await;
    let big = vec![b'x'; MAX_DIFF_BYTES * 2];
    let mut big_bin = big.clone();
    big_bin[0] = 0;
    mount_content(&server, MERGE_BASE, "big.txt", b"small\n").await;
    mount_content(&server, HEAD, "big.txt", &big).await;
    mount_content(&server, MERGE_BASE, "big.bin", b"\0small").await;
    mount_content(&server, HEAD, "big.bin", &big_bin).await;

    let d = svc.get_file_diff("o", "r", 9, "big.txt").await.unwrap();
    assert!(d.too_large && !d.binary);
    assert!(d.new_text.is_none() && d.hunks.is_empty());
    let b = svc.get_file_diff("o", "r", 9, "big.bin").await.unwrap();
    assert!(b.binary, "binary detection still works on a truncated read");

    let files = files_in(dir.path());
    assert!(!files.is_empty(), "small sides are still cached");
    for (p, len) in files {
        assert!(len <= MAX_DIFF_BYTES as u64, "{p:?} is {len} bytes");
    }
}

#[tokio::test]
async fn rename_status_maps_through_rest() {
    // Copies need REST too.
    let (server, svc) = setup().await;
    mount_single_page(&server, vec![gql_file("copy.ts", "COPIED")]).await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "filename": "copy.ts", "previous_filename": "orig.ts", "status": "copied" }
        ])))
        .expect(1)
        .mount(&server)
        .await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.files[0].status, FileStatus::Copied);
    assert_eq!(pr.files[0].previous_path.as_deref(), Some("orig.ts"));
    server.verify().await;
}
