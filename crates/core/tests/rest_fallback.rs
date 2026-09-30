//! `get_pr` falls back to REST when GraphQL is rejected (e.g. a proxy returning 403
//! "GraphQL is not available"), but not on auth errors or missing PRs.
use std::sync::Arc;

use fast_reviewer_core::auth::AuthConfig;
use fast_reviewer_core::model::{FileStatus, LineKind, PrState, ViewedState};
use fast_reviewer_core::{Config, Error, Service};
use serde_json::{json, Value};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";
const MERGE_BASE: &str = "3333333333333333333333333333333333333333";

async fn setup() -> (MockServer, Arc<Service>) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": "octocat" })))
        .mount(&server)
        .await;
    let svc = Service::new(Config {
        api_url: server.uri(),
        cache_dir: None,
        auth: AuthConfig::none(),
    })
    .unwrap();
    svc.use_token("test-token").await.unwrap();
    (server, svc)
}

async fn mount_graphql(server: &MockServer, resp: ResponseTemplate) {
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(resp)
        .mount(server)
        .await;
}

fn graphql_unavailable() -> ResponseTemplate {
    ResponseTemplate::new(403).set_body_json(json!({ "message": "GraphQL is not available" }))
}

fn rest_pull() -> Value {
    json!({
        "number": 9,
        "node_id": "PR_rest_node",
        "title": "Add things",
        "html_url": "https://github.com/o/r/pull/9",
        "user": { "login": "alice" },
        "base": { "ref": "main", "sha": BASE, "label": "o:main" },
        "head": { "ref": "feature", "sha": HEAD, "label": "o:feature" },
        "state": "open"
    })
}

async fn mount_pull(server: &MockServer, resp: ResponseTemplate, times: u64) {
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9"))
        .respond_with(resp)
        .expect(times)
        .mount(server)
        .await;
}

async fn mount_files(server: &MockServer, files: Vec<Value>) {
    for (i, chunk) in files.chunks(100).enumerate() {
        Mock::given(method("GET"))
            .and(path("/repos/o/r/pulls/9/files"))
            .and(query_param("page", (i + 1).to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(Value::Array(chunk.to_vec())))
            .mount(server)
            .await;
    }
    if files.len().is_multiple_of(100) {
        Mock::given(method("GET"))
            .and(path("/repos/o/r/pulls/9/files"))
            .and(query_param("page", (files.len() / 100 + 1).to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(server)
            .await;
    }
}

fn rest_file(name: &str, status: &str, adds: u32, dels: u32) -> Value {
    json!({ "filename": name, "status": status, "additions": adds, "deletions": dels, "changes": adds + dels })
}

#[tokio::test]
async fn graphql_403_falls_back_to_rest() {
    let (server, svc) = setup().await;
    mount_graphql(&server, graphql_unavailable()).await;
    mount_pull(
        &server,
        ResponseTemplate::new(200).set_body_json(rest_pull()),
        1,
    )
    .await;
    // 101 files over two REST pages; the rename is on the second page.
    let mut files: Vec<Value> = (0..100)
        .map(|i| rest_file(&format!("src/f{i:03}.ts"), "modified", 3, 1))
        .collect();
    files.push(json!({
        "filename": "a/new_name.py", "previous_filename": "a/old_name.py",
        "status": "renamed", "additions": 0, "deletions": 0
    }));
    mount_files(&server, files).await;

    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.id, "PR_rest_node");
    assert_eq!(pr.title, "Add things");
    assert_eq!(pr.author, "alice");
    assert_eq!(pr.url, "https://github.com/o/r/pull/9");
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(
        (pr.base_ref.as_str(), pr.head_ref.as_str()),
        ("main", "feature")
    );
    assert_eq!((pr.base_sha.as_str(), pr.head_sha.as_str()), (BASE, HEAD));
    assert_eq!(pr.files.len(), 101);
    assert!(pr.files.windows(2).all(|w| w[0].path < w[1].path));
    let first = &pr.files[0];
    assert_eq!(first.path, "a/new_name.py");
    assert_eq!(first.previous_path.as_deref(), Some("a/old_name.py"));
    assert_eq!(first.status, FileStatus::Renamed);
    assert!(pr.files.iter().all(|f| f.viewed == ViewedState::Unviewed));
    assert!(pr.files[1..]
        .iter()
        .all(|f| f.status == FileStatus::Modified
            && f.previous_path.is_none()
            && (f.additions, f.deletions) == (3, 1)));
    server.verify().await;
}

#[tokio::test]
async fn rest_pull_state_maps_to_pr_state() {
    for (state, merged, draft, want) in [
        ("open", false, true, PrState::Draft),
        ("closed", true, false, PrState::Merged),
        ("closed", false, true, PrState::Closed),
    ] {
        let (server, svc) = setup().await;
        mount_graphql(&server, graphql_unavailable()).await;
        let mut pull = rest_pull();
        pull["state"] = json!(state);
        pull["merged"] = json!(merged);
        pull["draft"] = json!(draft);
        mount_pull(&server, ResponseTemplate::new(200).set_body_json(pull), 1).await;
        mount_files(&server, vec![rest_file("a", "modified", 1, 0)]).await;
        let pr = svc.get_pr("o", "r", 9).await.unwrap();
        assert_eq!(pr.state, want, "{state} merged={merged} draft={draft}");
    }
}

#[tokio::test]
async fn rest_statuses_map_to_file_status() {
    let (server, svc) = setup().await;
    mount_graphql(&server, graphql_unavailable()).await;
    mount_pull(
        &server,
        ResponseTemplate::new(200).set_body_json(rest_pull()),
        1,
    )
    .await;
    mount_files(
        &server,
        vec![
            rest_file("a", "added", 2, 0),
            rest_file("b", "removed", 0, 2),
            rest_file("c", "copied", 0, 0),
            rest_file("d", "changed", 0, 0),
            rest_file("e", "unchanged", 0, 0),
        ],
    )
    .await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    let st: Vec<_> = pr.files.iter().map(|f| f.status).collect();
    assert_eq!(
        st,
        vec![
            FileStatus::Added,
            FileStatus::Removed,
            FileStatus::Copied,
            FileStatus::Changed,
            FileStatus::Changed,
        ]
    );
    assert_eq!((pr.files[0].additions, pr.files[0].deletions), (2, 0));
}

#[tokio::test]
async fn graphql_error_payload_falls_back_to_rest() {
    let (server, svc) = setup().await;
    mount_graphql(
        &server,
        ResponseTemplate::new(200).set_body_json(json!({
            "data": null,
            "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by integration" }]
        })),
    )
    .await;
    mount_pull(
        &server,
        ResponseTemplate::new(200).set_body_json(rest_pull()),
        1,
    )
    .await;
    mount_files(&server, vec![rest_file("x.rs", "modified", 1, 1)]).await;
    let pr = svc.get_pr("o", "r", 9).await.unwrap();
    assert_eq!(pr.id, "PR_rest_node");
    assert_eq!(pr.files.len(), 1);
}

#[tokio::test]
async fn fallback_pr_serves_diffs_from_merge_base() {
    let (server, svc) = setup().await;
    mount_graphql(&server, graphql_unavailable()).await;
    mount_pull(
        &server,
        ResponseTemplate::new(200).set_body_json(rest_pull()),
        1,
    )
    .await;
    mount_files(&server, vec![rest_file("mod.ts", "modified", 1, 1)]).await;
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/compare/{BASE}...{HEAD}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "merge_base_commit": { "sha": MERGE_BASE } })),
        )
        .mount(&server)
        .await;
    for (sha, body) in [
        (MERGE_BASE, "const a = 1;\nconst b = 2;\n"),
        (HEAD, "const a = 1;\nconst b = 3;\n"),
    ] {
        Mock::given(method("GET"))
            .and(path("/repos/o/r/contents/mod.ts"))
            .and(query_param("ref", sha))
            .and(header("accept", "application/vnd.github.raw+json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .expect(1)
            .mount(&server)
            .await;
    }
    // get_file_diff without a prior get_pr loads the PR through the fallback too.
    let d = svc.get_file_diff("o", "r", 9, "mod.ts").await.unwrap();
    let kinds: Vec<_> = d
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter().map(|l| l.kind))
        .collect();
    assert_eq!(kinds, vec![LineKind::Context, LineKind::Del, LineKind::Add]);
    server.verify().await;
}

#[tokio::test]
async fn graphql_401_does_not_fall_back() {
    let (server, svc) = setup().await;
    mount_graphql(
        &server,
        ResponseTemplate::new(401).set_body_json(json!({ "message": "Bad credentials" })),
    )
    .await;
    mount_pull(
        &server,
        ResponseTemplate::new(200).set_body_json(rest_pull()),
        0,
    )
    .await;
    mount_files(&server, vec![rest_file("x.rs", "modified", 1, 1)]).await;
    let err = svc.get_pr("o", "r", 9).await.unwrap_err();
    assert_eq!(err, Error::Unauthorized);
    // The session is cleared, as for any other 401.
    assert!(!svc.auth_status().await.unwrap().authenticated);
    server.verify().await;
}

#[tokio::test]
async fn missing_pr_does_not_fall_back() {
    let (server, svc) = setup().await;
    mount_graphql(
        &server,
        ResponseTemplate::new(200).set_body_json(json!({
            "data": { "repository": { "pullRequest": null } },
            "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve to a PullRequest with the number of 9." }]
        })),
    )
    .await;
    mount_pull(&server, ResponseTemplate::new(404), 0).await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let err = svc.get_pr("o", "r", 9).await.unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    server.verify().await;
}

#[tokio::test]
async fn fallback_reports_rest_errors() {
    let (server, svc) = setup().await;
    mount_graphql(&server, graphql_unavailable()).await;
    mount_pull(
        &server,
        ResponseTemplate::new(200).set_body_json(rest_pull()),
        1,
    )
    .await;
    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/9/files"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({ "message": "boom" })))
        .mount(&server)
        .await;
    let err = svc.get_pr("o", "r", 9).await.unwrap_err();
    assert_eq!(
        err,
        Error::Api {
            status: 500,
            message: "boom".into()
        }
    );
}
