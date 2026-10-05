//! GitHub client + service tests against a mock HTTP server.
use std::sync::Arc;

use fast_reviewer_core::auth::AuthConfig;
use fast_reviewer_core::model::{
    FileStatus, InboxReason, LineKind, NewComment, ReviewComment, ReviewEvent, ReviewThread, Side,
    SubmittedReview, ViewedState,
};
use fast_reviewer_core::{Config, Error, Service};
use serde_json::{json, Value};
use wiremock::matchers::{
    body_json, body_partial_json, body_string_contains, header, method, path, query_param,
};
use wiremock::{Mock, MockServer, ResponseTemplate};

const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";
const MERGE_BASE: &str = "3333333333333333333333333333333333333333";
const RAW: &str = "application/vnd.github.raw+json";

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
    let st = svc.use_token("test-token").await.unwrap();
    assert_eq!(st.login.as_deref(), Some("octocat"));
    (server, svc)
}

async fn setup() -> (MockServer, Arc<Service>) {
    setup_with_cache(None).await
}

fn issue(owner: &str, repo: &str, number: u64, updated: &str) -> Value {
    json!({
        "number": number,
        "title": format!("PR {number}"),
        "html_url": format!("https://github.com/{owner}/{repo}/pull/{number}"),
        "updated_at": updated,
        "draft": number == 2,
        "user": { "login": "someone" },
        "repository_url": format!("https://api.github.com/repos/{owner}/{repo}"),
        "pull_request": {}
    })
}

#[tokio::test]
async fn inbox_dedupes_and_sorts() {
    let (server, svc) = setup().await;
    Mock::given(method("GET"))
        .and(path("/search/issues"))
        .and(query_param(
            "q",
            "is:open is:pr review-requested:@me archived:false",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [
            issue("a", "x", 1, "2026-01-01T00:00:00Z"),
            issue("a", "x", 2, "2026-03-01T00:00:00Z"),
        ]})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/search/issues"))
        .and(query_param("q", "is:open is:pr author:@me archived:false"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [
            issue("a", "x", 2, "2026-03-01T00:00:00Z"),
            issue("b", "y", 7, "2026-02-01T00:00:00Z"),
        ]})))
        .expect(1)
        .mount(&server)
        .await;

    let inbox = svc.list_inbox().await.unwrap();
    let got: Vec<_> = inbox
        .iter()
        .map(|p| (p.repo.as_str(), p.number, p.reason))
        .collect();
    assert_eq!(
        got,
        vec![
            ("x", 2, InboxReason::ReviewRequested),
            ("y", 7, InboxReason::Authored),
            ("x", 1, InboxReason::ReviewRequested),
        ]
    );
    assert!(inbox[0].is_draft);
    assert_eq!(inbox[0].owner, "a");
    assert_eq!(inbox[0].url, "https://github.com/a/x/pull/2");
}

#[tokio::test]
async fn repo_prs_mark_reason_for_viewer() {
    let (server, svc) = setup().await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls"))
        .and(query_param("state", "open"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "number": 5, "title": "mine", "html_url": "u5", "updated_at": "t", "draft": false,
              "user": { "login": "OctoCat" }, "requested_reviewers": [] },
            { "number": 4, "title": "theirs", "html_url": "u4", "updated_at": "t", "draft": true,
              "user": { "login": "x" }, "requested_reviewers": [{ "login": "octocat" }] },
            { "number": 3, "title": "other", "html_url": "u3", "updated_at": "t",
              "user": { "login": "y" } }
        ])))
        .mount(&server)
        .await;
    let prs = svc.list_repo_prs("o", "r").await.unwrap();
    let reasons: Vec<_> = prs.iter().map(|p| p.reason).collect();
    assert_eq!(
        reasons,
        vec![
            InboxReason::Authored,
            InboxReason::ReviewRequested,
            InboxReason::Other
        ]
    );
    assert!(prs[1].is_draft);
}

#[tokio::test]
async fn search_repos_merges_local_and_search() {
    let (server, svc) = setup().await;
    let repo = |owner: &str, name: &str| json!({ "name": name, "owner": { "login": owner }, "description": null, "private": false, "updated_at": "t" });
    Mock::given(method("GET"))
        .and(path("/user/repos"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!([repo("me", "fast-app"), repo("me", "other")])),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/search/repositories"))
        .and(query_param("q", "fast in:name fork:true"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "items": [repo("me", "fast-app"), repo("x", "fastify")] })),
        )
        .mount(&server)
        .await;

    let names: Vec<_> = svc
        .search_repos("fast")
        .await
        .unwrap()
        .into_iter()
        .map(|r| format!("{}/{}", r.owner, r.name))
        .collect();
    assert_eq!(names, vec!["me/fast-app", "x/fastify"]);
    // Empty query: recent repos, served from the in-memory list (expect(1) above).
    assert_eq!(svc.search_repos("  ").await.unwrap().len(), 2);
}

fn gql_file(path: &str, change: &str, viewed: &str) -> Value {
    json!({ "path": path, "additions": 1, "deletions": 2, "changeType": change, "viewerViewedState": viewed })
}

fn pr_page(files: Vec<Value>, next: Option<&str>) -> Value {
    json!({ "data": { "repository": { "pullRequest": {
        "id": "PR_node", "title": "Add things", "url": "https://github.com/o/r/pull/9",
        "author": { "login": "alice" },
        "baseRefName": "main", "headRefName": "feature",
        "baseRefOid": BASE, "headRefOid": HEAD,
        "files": { "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next }, "nodes": files }
    }}}})
}

/// A PR with the given GraphQL file pages and REST rename list, plus the merge-base endpoint.
async fn mount_pr(server: &MockServer, pages: Vec<Vec<Value>>, rest: Vec<Value>) {
    let n = pages.len();
    for (i, files) in pages.into_iter().enumerate() {
        let after = if i == 0 {
            Value::Null
        } else {
            json!(format!("c{i}"))
        };
        let next = (i + 1 < n).then(|| format!("c{}", i + 1));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_partial_json(
                json!({ "variables": { "after": after, "number": 9 } }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(pr_page(files, next.as_deref())))
            .expect(1)
            .mount(server)
            .await;
    }
    for (i, chunk) in rest.chunks(100).enumerate() {
        Mock::given(method("GET"))
            .and(path("/repos/o/r/pulls/9/files"))
            .and(query_param("page", (i + 1).to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(Value::Array(chunk.to_vec())))
            .mount(server)
            .await;
    }
    if rest.len().is_multiple_of(100) {
        Mock::given(method("GET"))
            .and(path("/repos/o/r/pulls/9/files"))
            .and(query_param("page", (rest.len() / 100 + 1).to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/compare/{BASE}...{HEAD}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "merge_base_commit": { "sha": MERGE_BASE } })),
        )
        .mount(server)
        .await;
}

async fn mount_content(
    server: &MockServer,
    sha: &str,
    file: &str,
    body: Option<&[u8]>,
    times: u64,
) {
    let resp = match body {
        Some(b) => ResponseTemplate::new(200).set_body_bytes(b.to_vec()),
        None => ResponseTemplate::new(404).set_body_json(json!({ "message": "Not Found" })),
    };
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/contents/{file}")))
        .and(query_param("ref", sha))
        .and(header("accept", RAW))
        .respond_with(resp)
        .expect(times)
        .mount(server)
        .await;
}

#[tokio::test]
async fn get_pr_paginates_and_maps_renames() {
    let (server, svc) = setup().await;
    // 101 files over two GraphQL pages and two REST pages; the rename is on the last page.
    let page1: Vec<Value> = (0..100)
        .map(|i| gql_file(&format!("src/f{i:03}.ts"), "MODIFIED", "UNVIEWED"))
        .collect();
    let page2 = vec![gql_file("a/new_name.py", "RENAMED", "VIEWED")];
    let mut rest: Vec<Value> = (0..100)
        .map(|i| json!({ "filename": format!("src/f{i:03}.ts"), "status": "modified" }))
        .collect();
    rest.push(json!({ "filename": "a/new_name.py", "previous_filename": "a/old_name.py", "status": "renamed" }));
    mount_pr(&server, vec![page1, page2], rest).await;

    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.id, "PR_node");
    assert_eq!(pr.author, "alice");
    assert_eq!(
        (pr.base_ref.as_str(), pr.head_ref.as_str()),
        ("main", "feature")
    );
    assert_eq!((pr.base_sha.as_str(), pr.head_sha.as_str()), (BASE, HEAD));
    assert_eq!(pr.files.len(), 101);
    let first = &pr.files[0];
    assert_eq!(first.path, "a/new_name.py", "files sorted by path");
    assert_eq!(first.previous_path.as_deref(), Some("a/old_name.py"));
    assert_eq!(first.status, FileStatus::Renamed);
    assert_eq!(first.viewed, ViewedState::Viewed);
    assert_eq!((first.additions, first.deletions), (1, 2));
    assert!(pr.files[1..]
        .iter()
        .all(|f| f.previous_path.is_none() && f.status == FileStatus::Modified));
    assert!(pr.files.windows(2).all(|w| w[0].path < w[1].path));
}

#[tokio::test]
async fn change_types_map_to_status() {
    let (server, svc) = setup().await;
    let files = vec![
        gql_file("a", "ADDED", "UNVIEWED"),
        gql_file("b", "DELETED", "DISMISSED"),
        gql_file("c", "COPIED", "UNVIEWED"),
        gql_file("d", "CHANGED", "UNVIEWED"),
    ];
    mount_pr(&server, vec![files], vec![]).await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    let st: Vec<_> = pr.files.iter().map(|f| f.status).collect();
    assert_eq!(
        st,
        vec![
            FileStatus::Added,
            FileStatus::Removed,
            FileStatus::Copied,
            FileStatus::Changed
        ]
    );
    assert_eq!(pr.files[1].viewed, ViewedState::Dismissed);
}

async fn diff_fixture(cache: Option<std::path::PathBuf>) -> (MockServer, Arc<Service>) {
    let (server, svc) = setup_with_cache(cache).await;
    let files = vec![
        gql_file("added.ts", "ADDED", "UNVIEWED"),
        gql_file("gone.css", "DELETED", "UNVIEWED"),
        gql_file("img.png", "MODIFIED", "UNVIEWED"),
        gql_file("mod.ts", "MODIFIED", "UNVIEWED"),
        gql_file("renamed.py", "RENAMED", "UNVIEWED"),
    ];
    let rest = vec![json!({ "filename": "renamed.py", "previous_filename": "orig.py" })];
    mount_pr(&server, vec![files], rest).await;
    (server, svc)
}

#[tokio::test]
async fn file_diff_modified_uses_merge_base_and_caches() {
    let dir = tempfile::tempdir().unwrap();
    let (server, svc) = diff_fixture(Some(dir.path().to_path_buf())).await;
    mount_content(
        &server,
        MERGE_BASE,
        "mod.ts",
        Some(b"const a = 1;\nconst b = 2;\n"),
        1,
    )
    .await;
    mount_content(
        &server,
        HEAD,
        "mod.ts",
        Some(b"const a = 1;\nconst b = 3;\n"),
        1,
    )
    .await;
    // The base tip must never be used for content: GitHub diffs against the merge base.
    mount_content(&server, BASE, "mod.ts", Some(b"WRONG"), 0).await;

    let d = svc.get_file_diff("o", "r", 9, "mod.ts").await.unwrap();
    assert_eq!(d.path, "mod.ts");
    assert_eq!(d.language.as_deref(), Some("typescript"));
    assert!(!d.binary && !d.too_large);
    assert_eq!(d.old_text.as_deref(), Some("const a = 1;\nconst b = 2;\n"));
    assert_eq!(d.new_text.as_deref(), Some("const a = 1;\nconst b = 3;\n"));
    let kinds: Vec<_> = d
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter().map(|l| l.kind))
        .collect();
    assert!(kinds.contains(&LineKind::Add) && kinds.contains(&LineKind::Del));

    // Memory hit: same Arc, no network (expect(1) above).
    let again = svc.get_file_diff("o", "r", 9, "mod.ts").await.unwrap();
    assert!(Arc::ptr_eq(&d, &again));
    assert_eq!(svc.cached_diffs(), 1);
    server.verify().await;

    // A fresh service sharing the disk cache needs no content requests.
    let (server2, svc2) = diff_fixture(Some(dir.path().to_path_buf())).await;
    mount_content(&server2, MERGE_BASE, "mod.ts", None, 0).await;
    mount_content(&server2, HEAD, "mod.ts", None, 0).await;
    let d2 = svc2.get_file_diff("o", "r", 9, "mod.ts").await.unwrap();
    assert_eq!(d2.hunks, d.hunks);
}

#[tokio::test]
async fn file_diff_added_removed_renamed() {
    let (server, svc) = diff_fixture(None).await;
    mount_content(&server, HEAD, "added.ts", Some(b"x\ny\n"), 1).await;
    mount_content(&server, MERGE_BASE, "added.ts", None, 0).await;
    mount_content(&server, MERGE_BASE, "gone.css", Some(b"a { }\n"), 1).await;
    mount_content(&server, HEAD, "gone.css", None, 0).await;
    mount_content(&server, MERGE_BASE, "orig.py", Some(b"print(1)\n"), 1).await;
    mount_content(&server, HEAD, "renamed.py", Some(b"print(2)\n"), 1).await;

    let added = svc.get_file_diff("o", "r", 9, "added.ts").await.unwrap();
    assert_eq!(added.old_text, None);
    assert_eq!(added.new_text.as_deref(), Some("x\ny\n"));
    assert!(added.hunks[0].lines.iter().all(|l| l.kind == LineKind::Add));

    let gone = svc.get_file_diff("o", "r", 9, "gone.css").await.unwrap();
    assert_eq!(gone.new_text, None);
    assert!(gone.hunks[0].lines.iter().all(|l| l.kind == LineKind::Del));

    let ren = svc.get_file_diff("o", "r", 9, "renamed.py").await.unwrap();
    assert_eq!(ren.old_path.as_deref(), Some("orig.py"));
    assert_eq!(ren.old_text.as_deref(), Some("print(1)\n"));
    assert_eq!(ren.language.as_deref(), Some("python"));
}

#[tokio::test]
async fn file_diff_binary_and_too_large() {
    let (server, svc) = diff_fixture(None).await;
    mount_content(
        &server,
        MERGE_BASE,
        "img.png",
        Some(b"\x89PNG\r\n\x1a\n\0\0\0"),
        1,
    )
    .await;
    mount_content(
        &server,
        HEAD,
        "img.png",
        Some(b"\x89PNG\r\n\x1a\n\0\0\x01"),
        1,
    )
    .await;
    let big = "line\n".repeat(20_001);
    mount_content(&server, MERGE_BASE, "mod.ts", Some(b"small\n"), 1).await;
    mount_content(&server, HEAD, "mod.ts", Some(big.as_bytes()), 1).await;

    let bin = svc.get_file_diff("o", "r", 9, "img.png").await.unwrap();
    assert!(bin.binary);
    assert!(bin.hunks.is_empty() && bin.old_text.is_none() && bin.new_text.is_none());

    let large = svc.get_file_diff("o", "r", 9, "mod.ts").await.unwrap();
    assert!(large.too_large && !large.binary);
    assert!(large.hunks.is_empty() && large.new_text.is_none());
}

#[tokio::test]
async fn concurrent_diff_requests_are_deduped() {
    let (server, svc) = diff_fixture(None).await;
    let slow = |b: &'static [u8]| {
        ResponseTemplate::new(200)
            .set_body_bytes(b.to_vec())
            .set_delay(std::time::Duration::from_millis(150))
    };
    for (sha, body) in [(MERGE_BASE, b"a\n" as &[u8]), (HEAD, b"b\n")] {
        Mock::given(method("GET"))
            .and(path("/repos/o/r/contents/mod.ts"))
            .and(query_param("ref", sha))
            .respond_with(slow(body))
            .expect(1)
            .mount(&server)
            .await;
    }
    svc.get_pr("o", "r", 9).await.unwrap();
    let (a, b, c) = tokio::join!(
        svc.get_file_diff("o", "r", 9, "mod.ts"),
        svc.get_file_diff("o", "r", 9, "mod.ts"),
        svc.get_file_diff("o", "r", 9, "mod.ts"),
    );
    let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
    assert!(Arc::ptr_eq(&a, &b) && Arc::ptr_eq(&b, &c));
    server.verify().await;
}

#[tokio::test]
async fn diff_without_prior_get_pr_loads_pr() {
    let (server, svc) = diff_fixture(None).await;
    mount_content(&server, MERGE_BASE, "mod.ts", Some(b"a\n"), 1).await;
    mount_content(&server, HEAD, "mod.ts", Some(b"b\n"), 1).await;
    let d = svc.get_file_diff("o", "r", 9, "mod.ts").await.unwrap();
    assert_eq!(d.hunks.len(), 1);
}

#[tokio::test]
async fn viewed_mutations() {
    let (server, svc) = setup().await;
    for op in ["markFileAsViewed", "unmarkFileAsViewed"] {
        // Leading space so "markFileAsViewed" does not also match "unmarkFileAsViewed".
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains(format!(" {op}(input")))
            .and(body_partial_json(
                json!({ "variables": { "id": "PR_node", "path": "src/a.ts" } }),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "data": { op: { "clientMutationId": null } } })),
            )
            .expect(1)
            .mount(&server)
            .await;
    }
    svc.set_file_viewed("PR_node", "src/a.ts", true)
        .await
        .unwrap();
    svc.set_file_viewed("PR_node", "src/a.ts", false)
        .await
        .unwrap();
    server.verify().await;
}

#[tokio::test]
async fn submit_review_pins_the_reviewed_head() {
    let (server, svc) = setup().await;
    mount_pr(
        &server,
        vec![vec![gql_file("a.ts", "MODIFIED", "VIEWED")]],
        vec![],
    )
    .await;
    for (event, id, body, state) in [
        ("COMMENT", 1, "Looks good, one nit", "COMMENTED"),
        ("APPROVE", 2, "", "APPROVED"),
    ] {
        Mock::given(method("POST"))
            .and(path("/repos/o/r/pulls/9/reviews"))
            .and(header("authorization", "Bearer test-token"))
            .and(body_json(
                json!({ "commit_id": HEAD, "body": body, "event": event }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": id,
                "html_url": format!("https://github.com/o/r/pull/9#pullrequestreview-{id}"),
                "state": state,
                "commit_id": HEAD,
            })))
            .expect(1)
            .mount(&server)
            .await;
    }

    // No get_pr first: the head SHA is loaded on demand. The body is trimmed.
    let comment = svc
        .submit_review(
            "o",
            "r",
            9,
            ReviewEvent::Comment,
            "  Looks good, one nit\n",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        comment,
        SubmittedReview {
            id: 1,
            url: "https://github.com/o/r/pull/9#pullrequestreview-1".into(),
            state: "COMMENTED".into(),
        }
    );
    // Approving needs no comment.
    let approve = svc
        .submit_review("o", "r", 9, ReviewEvent::Approve, " ", &[])
        .await
        .unwrap();
    assert_eq!((approve.id, approve.state.as_str()), (2, "APPROVED"));
    server.verify().await;
}

#[tokio::test]
async fn submit_review_surfaces_validation_errors() {
    let (server, svc) = setup().await;
    mount_pr(
        &server,
        vec![vec![gql_file("a.ts", "MODIFIED", "VIEWED")]],
        vec![],
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/repos/o/r/pulls/9/reviews"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "message": "Unprocessable Entity",
            "errors": ["Can not approve your own pull request"],
            "documentation_url": "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request",
        })))
        .mount(&server)
        .await;
    let err = svc
        .submit_review("o", "r", 9, ReviewEvent::Approve, "", &[])
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "GitHub API error 422: Can not approve your own pull request"
    );
}

#[tokio::test]
async fn empty_comment_review_is_refused_locally() {
    let (server, svc) = setup().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    let before = server.received_requests().await.unwrap().len();
    let err = svc
        .submit_review("o", "r", 9, ReviewEvent::Comment, " \n\t", &[])
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "Write a comment before submitting");
    assert_eq!(server.received_requests().await.unwrap().len(), before);
    server.verify().await;
}

#[tokio::test]
async fn submit_review_sends_line_comments() {
    let (server, svc) = setup().await;
    mount_pr(
        &server,
        vec![vec![gql_file("a.ts", "MODIFIED", "VIEWED")]],
        vec![],
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/repos/o/r/pulls/9/reviews"))
        .and(body_json(json!({
            "commit_id": HEAD,
            "event": "COMMENT",
            "comments": [
                { "path": "a.ts", "line": 3, "side": "RIGHT", "body": "Rename this" },
                { "path": "a.ts", "line": 7, "side": "LEFT", "body": "Why remove this?" },
            ],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 5,
            "html_url": "https://github.com/o/r/pull/9#pullrequestreview-5",
            "state": "COMMENTED",
        })))
        .expect(1)
        .mount(&server)
        .await;
    let comment = |side, line, body: &str| NewComment {
        path: "a.ts".into(),
        side,
        line,
        body: body.into(),
    };
    // Line comments alone make a comment review: no body needed.
    let r = svc
        .submit_review(
            "o",
            "r",
            9,
            ReviewEvent::Comment,
            "",
            &[
                comment(Side::New, 3, "Rename this"),
                comment(Side::Old, 7, "Why remove this?"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(r.id, 5);
    server.verify().await;

    let err = svc
        .submit_review(
            "o",
            "r",
            9,
            ReviewEvent::Comment,
            "",
            &[comment(Side::New, 3, " \n")],
        )
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "A line comment is empty");
}

fn gql_thread(id: &str, line: Option<u32>, side: &str, outdated: bool) -> Value {
    json!({
        "id": id, "path": "src/a.ts", "line": line, "diffSide": side,
        "isResolved": id == "T2", "isOutdated": outdated,
        "comments": { "nodes": [
            { "id": format!("{id}c1"), "author": { "login": "hubot" }, "body": "Hmm",
              "createdAt": "2026-01-02T03:04:05Z", "url": format!("https://github.com/o/r/pull/9#{id}c1") },
            { "id": format!("{id}c2"), "author": null, "body": "Fixed",
              "createdAt": "2026-01-03T03:04:05Z", "url": format!("https://github.com/o/r/pull/9#{id}c2") },
        ]},
    })
}

#[tokio::test]
async fn review_threads_are_paginated_and_mapped() {
    let (server, svc) = setup().await;
    let page = |nodes: Vec<Value>, next: Option<&str>| {
        json!({ "data": { "repository": { "pullRequest": { "reviewThreads": {
            "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next },
            "nodes": nodes,
        }}}}})
    };
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("reviewThreads"))
        .and(body_partial_json(json!({ "variables": { "after": null } })))
        .respond_with(ResponseTemplate::new(200).set_body_json(page(
            vec![gql_thread("T1", Some(4), "RIGHT", false)],
            Some("c1"),
        )))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("reviewThreads"))
        .and(body_partial_json(json!({ "variables": { "after": "c1" } })))
        .respond_with(ResponseTemplate::new(200).set_body_json(page(
            vec![
                gql_thread("T2", Some(9), "LEFT", false),
                gql_thread("T3", None, "RIGHT", true),
            ],
            None,
        )))
        .expect(1)
        .mount(&server)
        .await;

    let threads = svc.list_review_threads("o", "r", 9).await.unwrap();
    let got: Vec<_> = threads
        .iter()
        .map(|t| (t.id.as_str(), t.line, t.side, t.resolved, t.outdated))
        .collect();
    assert_eq!(
        got,
        vec![
            ("T1", Some(4), Side::New, false, false),
            ("T2", Some(9), Side::Old, true, false),
            ("T3", None, Side::New, false, true),
        ]
    );
    assert_eq!(
        threads[0],
        ReviewThread {
            id: "T1".into(),
            path: "src/a.ts".into(),
            line: Some(4),
            side: Side::New,
            resolved: false,
            outdated: false,
            comments: vec![
                ReviewComment {
                    id: "T1c1".into(),
                    author: "hubot".into(),
                    body: "Hmm".into(),
                    created_at: "2026-01-02T03:04:05Z".into(),
                    url: "https://github.com/o/r/pull/9#T1c1".into(),
                },
                ReviewComment {
                    id: "T1c2".into(),
                    author: "ghost".into(),
                    body: "Fixed".into(),
                    created_at: "2026-01-03T03:04:05Z".into(),
                    url: "https://github.com/o/r/pull/9#T1c2".into(),
                },
            ],
        }
    );
    server.verify().await;
}

#[tokio::test]
async fn graphql_errors_are_reported() {
    let (server, svc) = setup().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "markFileAsViewed": null },
            "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by integration" }]
        })))
        .mount(&server)
        .await;
    let err = svc.set_file_viewed("PR_node", "a", true).await.unwrap_err();
    assert_eq!(
        err,
        Error::GraphQl("Resource not accessible by integration".into())
    );
}

#[tokio::test]
async fn missing_pr_is_not_found() {
    let (server, svc) = setup().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "repository": { "pullRequest": null } },
            "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve to a PullRequest with the number of 9." }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let err = svc.get_pr("o", "r", 9).await.unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    assert!(err.to_string().starts_with("Not found on GitHub"));
}

#[tokio::test]
async fn http_errors_map_to_messages() {
    let (server, svc) = setup().await;
    Mock::given(method("GET"))
        .and(path("/repos/o/limited/pulls"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .insert_header("x-ratelimit-reset", "4102444800")
                .set_body_json(json!({ "message": "API rate limit exceeded" })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/nope/pulls"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "message": "Not Found" })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/boom/pulls"))
        .respond_with(
            ResponseTemplate::new(502).set_body_json(json!({ "message": "Server Error" })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/forbidden/pulls"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({ "message": "Must have admin rights" })),
        )
        .mount(&server)
        .await;

    let rl = svc.list_repo_prs("o", "limited").await.unwrap_err();
    assert_eq!(
        rl,
        Error::RateLimited {
            reset_at: Some(4102444800)
        }
    );
    let msg = rl.to_string();
    assert!(
        msg.contains("rate limit") && msg.contains("00:00 UTC"),
        "{msg}"
    );

    assert!(matches!(
        svc.list_repo_prs("o", "nope").await.unwrap_err(),
        Error::NotFound(_)
    ));
    assert_eq!(
        svc.list_repo_prs("o", "boom")
            .await
            .unwrap_err()
            .to_string(),
        "GitHub API error 502: Server Error"
    );
    assert_eq!(
        svc.list_repo_prs("o", "forbidden").await.unwrap_err(),
        Error::Api {
            status: 403,
            message: "Must have admin rights".into()
        }
    );
}

#[tokio::test]
async fn unauthorized_clears_session() {
    let (server, svc) = setup().await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({ "message": "Bad credentials" })),
        )
        .mount(&server)
        .await;
    let err = svc.list_repo_prs("o", "r").await.unwrap_err();
    assert_eq!(err.to_string(), "GitHub token invalid or expired");
    // With every token source disabled, the session is now signed out.
    let st = svc.auth_status().await.unwrap();
    assert!(!st.authenticated && st.login.is_none() && st.source.is_none());
    assert_eq!(svc.list_inbox().await.unwrap_err(), Error::NotAuthenticated);
}

#[tokio::test]
async fn set_token_validates_before_storing() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("authorization", "Bearer good"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": "octocat" })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({ "message": "Bad credentials" })),
        )
        .mount(&server)
        .await;
    let svc = Service::new(Config {
        api_url: server.uri(),
        cache_dir: None,
        auth: AuthConfig::none(),
    })
    .unwrap();
    assert!(!svc.auth_status().await.unwrap().authenticated);

    assert_eq!(svc.set_token("bad").await.unwrap_err(), Error::Unauthorized);
    assert!(!svc.auth_status().await.unwrap().authenticated);
    assert!(svc.set_token("   ").await.is_err());

    let st = svc.set_token("  good\n").await.unwrap();
    assert!(st.authenticated);
    assert_eq!(st.login.as_deref(), Some("octocat"));

    let out = svc.sign_out().await.unwrap();
    assert!(!out.authenticated);
    assert!(!svc.auth_status().await.unwrap().authenticated);
}
