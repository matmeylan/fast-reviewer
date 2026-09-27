//! After a 401 on a diff request, the next diff re-resolves the token instead of failing
//! with NotAuthenticated. Own test binary because it sets `GH_TOKEN`.
use fast_reviewer_core::auth::AuthConfig;
use fast_reviewer_core::{Config, Error, Service};
use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";

#[tokio::test]
async fn diff_after_401_re_resolves_token() {
    let server = MockServer::start().await;
    for (token, login) in [("old", "octocat"), ("new", "octocat")] {
        Mock::given(method("GET"))
            .and(path("/user"))
            .and(header("authorization", format!("Bearer {token}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "login": login })))
            .mount(&server)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": { "repository": { "pullRequest": {
            "id": "PR_node", "title": "t", "url": "u", "author": { "login": "a" },
            "baseRefName": "main", "headRefName": "f", "baseRefOid": BASE, "headRefOid": HEAD,
            "changedFiles": 2,
            "files": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [
                { "path": "a.ts", "additions": 1, "deletions": 0, "changeType": "ADDED", "viewerViewedState": "UNVIEWED" },
                { "path": "b.ts", "additions": 1, "deletions": 0, "changeType": "ADDED", "viewerViewedState": "UNVIEWED" }
            ]}
        }}}})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/repos/o/r/compare/{BASE}...{HEAD}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "merge_base_commit": { "sha": BASE } })),
        )
        .mount(&server)
        .await;
    for file in ["a.ts", "b.ts"] {
        Mock::given(method("GET"))
            .and(path(format!("/repos/o/r/contents/{file}")))
            .and(query_param("ref", HEAD))
            .and(header("authorization", "Bearer new"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"x\n".to_vec()))
            .with_priority(1)
            .mount(&server)
            .await;
    }
    // The old token has been revoked for content.
    Mock::given(method("GET"))
        .and(path("/repos/o/r/contents/a.ts"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({ "message": "Bad credentials" })),
        )
        .mount(&server)
        .await;

    std::env::remove_var("GITHUB_TOKEN");
    std::env::set_var("GH_TOKEN", "old");
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
    assert!(svc.auth_status().await.unwrap().authenticated);
    svc.get_pr("o", "r", 9).await.unwrap();

    let err = svc.get_file_diff("o", "r", 9, "a.ts").await.unwrap_err();
    assert_eq!(err, Error::Unauthorized);

    // The token was rotated; the next diff must pick it up.
    std::env::set_var("GH_TOKEN", "new");
    let d = svc.get_file_diff("o", "r", 9, "b.ts").await.unwrap();
    assert_eq!(d.new_text.as_deref(), Some("x\n"));
}
