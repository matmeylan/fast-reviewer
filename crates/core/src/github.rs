//! Thin GitHub REST + GraphQL client. Stateless apart from the shared connection pool and the token.
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, RETRY_AFTER, USER_AGENT};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::model::{
    ChangedFile, FileStatus, InboxReason, PrSummary, RepoSummary, ReviewEvent, SubmittedReview,
    ViewedState,
};

pub const DEFAULT_API_URL: &str = "https://api.github.com";
const RAW: &str = "application/vnd.github.raw+json";
const PAGE: usize = 100;
/// GitHub caps PR file listings at 3000 files.
const MAX_PAGES: usize = 30;
/// Concurrent REST file-list page requests (stays well under GitHub's secondary limits).
const PAGE_CONCURRENCY: usize = 8;
/// Bytes kept from a body whose declared length is already over the limit: enough for
/// binary detection (`diff::is_binary` looks at the first 8 KiB).
const SNIFF_BYTES: usize = 8192;

/// File contents fetched with a size limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    /// The path does not exist at that ref.
    Missing,
    Bytes(Vec<u8>),
    /// Longer than the limit. Holds only the first bytes read (at least `SNIFF_BYTES`
    /// when the body is that long), so binary detection still works.
    TooLarge(Vec<u8>),
}

impl Content {
    /// The bytes read, if the file exists (only a prefix for `TooLarge`).
    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Content::Missing => None,
            Content::Bytes(b) | Content::TooLarge(b) => Some(b),
        }
    }
}

pub struct GitHub {
    http: reqwest::Client,
    api: String,
    graphql: String,
    token: RwLock<Option<String>>,
}

impl GitHub {
    pub fn new(api_url: &str) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(concat!("fast-reviewer/", env!("CARGO_PKG_VERSION"))),
        );
        headers.insert(
            "X-GitHub-Api-Version",
            HeaderValue::from_static("2022-11-28"),
        );
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| Error::Other(format!("HTTP client init failed: {e}")))?;
        let api = api_url.trim_end_matches('/').to_owned();
        Ok(Self {
            http,
            graphql: graphql_url(&api),
            api,
            token: RwLock::new(None),
        })
    }

    pub fn api_url(&self) -> &str {
        &self.api
    }

    /// Host to pass to `gh auth token --hostname`, or None for github.com.
    pub fn gh_host(&self) -> Option<String> {
        let host = self.api.split("://").nth(1)?.split(['/', ':']).next()?;
        (host != "api.github.com").then(|| host.to_owned())
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.write().unwrap_or_else(|e| e.into_inner()) = token;
    }

    fn token(&self) -> Result<String> {
        self.token
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(Error::NotAuthenticated)
    }

    fn authed(&self, rb: RequestBuilder) -> Result<RequestBuilder> {
        Ok(rb.header(AUTHORIZATION, format!("Bearer {}", self.token()?)))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.api, path)
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T> {
        let rb = self
            .http
            .get(self.url(path))
            .query(query)
            .header(ACCEPT, "application/vnd.github+json");
        let resp = check(self.authed(rb)?.send().await?, path).await?;
        Ok(resp.json().await?)
    }

    async fn post_json<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let rb = self
            .http
            .post(self.url(path))
            .json(body)
            .header(ACCEPT, "application/vnd.github+json");
        let resp = check(self.authed(rb)?.send().await?, path).await?;
        Ok(resp.json().await?)
    }

    async fn graphql<T: DeserializeOwned>(&self, query: &str, variables: Value) -> Result<T> {
        let rb = self
            .http
            .post(&self.graphql)
            .json(&json!({ "query": query, "variables": variables }));
        let resp = check(self.authed(rb)?.send().await?, "graphql").await?;
        let body: GqlResponse<T> = resp.json().await?;
        if let Some(errors) = body.errors.filter(|e| !e.is_empty()) {
            let msg = errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(match errors.iter().find_map(|e| e.kind.as_deref()) {
                Some("NOT_FOUND") => Error::NotFound(msg),
                Some("RATE_LIMITED") => Error::RateLimited { reset_at: None },
                _ => Error::GraphQl(msg),
            });
        }
        body.data
            .ok_or_else(|| Error::Decode("GraphQL response without data".into()))
    }

    /// Validate `token` and return the login it belongs to. Does not touch the stored token.
    pub async fn login_for(&self, token: &str) -> Result<String> {
        let rb = self
            .http
            .get(self.url("/user"))
            .header(AUTHORIZATION, format!("Bearer {token}"));
        let user: User = check(rb.send().await?, "/user").await?.json().await?;
        Ok(user.login)
    }

    pub async fn search_prs(&self, q: &str, reason: InboxReason) -> Result<Vec<PrSummary>> {
        let page = PAGE.to_string();
        let res: SearchResult<Issue> = self
            .get_json(
                "/search/issues",
                &[
                    ("q", q),
                    ("sort", "updated"),
                    ("order", "desc"),
                    ("per_page", &page),
                ],
            )
            .await?;
        Ok(res
            .items
            .into_iter()
            .filter_map(|i| i.into_summary(reason))
            .collect())
    }

    pub async fn list_repo_prs(
        &self,
        owner: &str,
        repo: &str,
        viewer: Option<&str>,
    ) -> Result<Vec<PrSummary>> {
        let path = format!("/repos/{}/{}/pulls", enc(owner), enc(repo));
        let page = PAGE.to_string();
        let pulls: Vec<Pull> = self
            .get_json(
                &path,
                &[
                    ("state", "open"),
                    ("sort", "updated"),
                    ("direction", "desc"),
                    ("per_page", &page),
                ],
            )
            .await?;
        Ok(pulls
            .into_iter()
            .map(|p| {
                let reason = match viewer {
                    Some(v) if p.user.login.eq_ignore_ascii_case(v) => InboxReason::Authored,
                    Some(v)
                        if p.requested_reviewers
                            .iter()
                            .any(|r| r.login.eq_ignore_ascii_case(v)) =>
                    {
                        InboxReason::ReviewRequested
                    }
                    _ => InboxReason::Other,
                };
                PrSummary {
                    owner: owner.to_owned(),
                    repo: repo.to_owned(),
                    number: p.number,
                    title: p.title,
                    author: p.user.login,
                    url: p.html_url,
                    is_draft: p.draft,
                    updated_at: p.updated_at,
                    reason,
                }
            })
            .collect())
    }

    /// The viewer's repos, most recently pushed first (one page).
    pub async fn user_repos(&self) -> Result<Vec<RepoSummary>> {
        let page = PAGE.to_string();
        let repos: Vec<Repo> = self
            .get_json("/user/repos", &[("sort", "pushed"), ("per_page", &page)])
            .await?;
        Ok(repos.into_iter().map(Repo::into_summary).collect())
    }

    pub async fn search_repos(&self, q: &str) -> Result<Vec<RepoSummary>> {
        let res: SearchResult<Repo> = self
            .get_json("/search/repositories", &[("q", q), ("per_page", "30")])
            .await?;
        Ok(res.items.into_iter().map(Repo::into_summary).collect())
    }

    /// PR metadata and all changed files (GraphQL, cursor-paginated). `previous_path` is left empty.
    /// Stops after `MAX_PAGES` pages and sets `truncated` if GitHub still reports more.
    pub async fn pr_graphql(&self, owner: &str, repo: &str, number: u64) -> Result<GqlPr> {
        let mut after: Option<String> = None;
        let mut pr: Option<GqlPr> = None;
        for page_no in 0..MAX_PAGES {
            let vars = json!({ "owner": owner, "repo": repo, "number": number, "after": after });
            let data: GqlRepoData = self.graphql(PR_QUERY, vars).await?;
            let page = data
                .repository
                .and_then(|r| r.pull_request)
                .ok_or_else(|| Error::NotFound(format!("{owner}/{repo}#{number}")))?;
            let files = page.files.unwrap_or_default();
            let info = files.page_info;
            let acc = pr.get_or_insert_with(|| GqlPr {
                files: Vec::new(),
                ..page.meta
            });
            acc.files
                .extend(files.nodes.into_iter().flatten().map(GqlFile::into_changed));
            match info.end_cursor.filter(|_| info.has_next_page) {
                Some(_) if page_no + 1 == MAX_PAGES => acc.truncated = true,
                Some(c) => after = Some(c),
                None => break,
            }
        }
        pr.ok_or_else(|| Error::NotFound(format!("{owner}/{repo}#{number}")))
    }

    /// PR metadata via REST (`files` left empty). Used when GraphQL is unavailable.
    pub async fn pr_rest(&self, owner: &str, repo: &str, number: u64) -> Result<GqlPr> {
        let path = format!("/repos/{}/{}/pulls/{number}", enc(owner), enc(repo));
        let p: RestPull = self.get_json(&path, &[]).await?;
        Ok(GqlPr {
            id: p.node_id,
            title: p.title,
            url: p.html_url,
            author: p.user,
            base_ref_name: p.base.git_ref,
            head_ref_name: p.head.git_ref,
            base_ref_oid: p.base.sha,
            head_ref_oid: p.head.sha,
            changed_files: p.changed_files,
            files: Vec::new(),
            truncated: false,
        })
    }

    /// All changed files via REST (paginated), including `previous_path` for renames/copies.
    /// REST cannot see the viewer's viewed state, so `viewed` is always `Unviewed`.
    ///
    /// With `total` (the PR's changed-file count) the pages are fetched concurrently;
    /// without it, one after another until a short page.
    pub async fn pr_files_rest(
        &self,
        owner: &str,
        repo: &str,
        number: u64,
        total: Option<u32>,
    ) -> Result<Vec<ChangedFile>> {
        use futures::stream::{self, StreamExt, TryStreamExt};

        let path = format!("/repos/{}/{}/pulls/{number}/files", enc(owner), enc(repo));
        let fetch = |page: usize| {
            let path = &path;
            async move {
                let (per_page, p) = (PAGE.to_string(), page.to_string());
                self.get_json::<Vec<RestFile>>(path, &[("per_page", &per_page), ("page", &p)])
                    .await
            }
        };
        let mut out = Vec::new();
        if let Some(total) = total {
            let pages = (total as usize).div_ceil(PAGE).clamp(1, MAX_PAGES);
            let chunks: Vec<Vec<RestFile>> = stream::iter(1..=pages)
                .map(fetch)
                .buffered(PAGE_CONCURRENCY)
                .try_collect()
                .await?;
            out.extend(chunks.into_iter().flatten().map(RestFile::into_changed));
            return Ok(out);
        }
        for page in 1..=MAX_PAGES {
            let files = fetch(page).await?;
            let n = files.len();
            out.extend(files.into_iter().map(RestFile::into_changed));
            if n < PAGE {
                break;
            }
        }
        Ok(out)
    }

    pub async fn merge_base(
        &self,
        owner: &str,
        repo: &str,
        base: &str,
        head: &str,
    ) -> Result<String> {
        let path = format!(
            "/repos/{}/{}/compare/{}...{}",
            enc(owner),
            enc(repo),
            enc(base),
            enc(head)
        );
        let cmp: Compare = self.get_json(&path, &[("per_page", "1")]).await?;
        Ok(cmp.merge_base_commit.sha)
    }

    /// Raw file bytes at `git_ref`. Stops reading once the body exceeds `limit` bytes
    /// (or right away if `Content-Length` already says so) and returns `TooLarge`.
    pub async fn file_content(
        &self,
        owner: &str,
        repo: &str,
        git_ref: &str,
        path: &str,
        limit: usize,
    ) -> Result<Content> {
        let url_path = format!(
            "/repos/{}/{}/contents/{}",
            enc(owner),
            enc(repo),
            enc_path(path)
        );
        let rb = self
            .http
            .get(self.url(&url_path))
            .query(&[("ref", git_ref)])
            .header(ACCEPT, RAW);
        let resp = self.authed(rb)?.send().await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(Content::Missing);
        }
        let mut resp = check(resp, &url_path).await?;
        let declared_large = resp.content_length().is_some_and(|n| n > limit as u64);
        let stop_at = if declared_large {
            SNIFF_BYTES.min(limit)
        } else {
            limit
        };
        let mut buf = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() > stop_at {
                // Dropping `resp` abandons the rest of the body.
                return Ok(Content::TooLarge(buf));
            }
        }
        Ok(if buf.len() > limit {
            Content::TooLarge(buf)
        } else {
            Content::Bytes(buf)
        })
    }

    /// Submit a review pinned to `commit_id` (the head the viewer reviewed, not whatever
    /// the branch points to now).
    pub async fn submit_review(
        &self,
        owner: &str,
        repo: &str,
        number: u64,
        commit_id: &str,
        event: ReviewEvent,
        body: &str,
    ) -> Result<SubmittedReview> {
        let path = format!("/repos/{}/{}/pulls/{number}/reviews", enc(owner), enc(repo));
        let r: Review = self
            .post_json(
                &path,
                &json!({ "commit_id": commit_id, "body": body, "event": event }),
            )
            .await?;
        Ok(SubmittedReview {
            id: r.id,
            url: r.html_url,
            state: r.state,
        })
    }

    pub async fn set_file_viewed(&self, pr_id: &str, path: &str, viewed: bool) -> Result<()> {
        let query = if viewed { MARK_VIEWED } else { UNMARK_VIEWED };
        let _: Value = self
            .graphql(query, json!({ "id": pr_id, "path": path }))
            .await?;
        Ok(())
    }
}

fn graphql_url(api: &str) -> String {
    // GHE: https://host/api/v3 -> https://host/api/graphql
    match api.strip_suffix("/api/v3") {
        Some(root) => format!("{root}/api/graphql"),
        None => format!("{api}/graphql"),
    }
}

/// Map non-success responses to typed errors.
async fn check(resp: Response, what: &str) -> Result<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let headers = resp.headers().clone();
    let header_u64 = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
    };
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| api_message(&v))
        .unwrap_or_else(|| body.chars().take(200).collect());

    Err(match status {
        StatusCode::UNAUTHORIZED => Error::Unauthorized,
        StatusCode::NOT_FOUND => Error::NotFound(what.to_owned()),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            if header_u64("x-ratelimit-remaining") == Some(0) {
                Error::RateLimited {
                    reset_at: header_u64("x-ratelimit-reset"),
                }
            } else if let Some(secs) = header_u64(RETRY_AFTER.as_str()) {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                Error::RateLimited {
                    reset_at: Some(now + secs),
                }
            } else if message.to_ascii_lowercase().contains("rate limit") {
                Error::RateLimited {
                    reset_at: header_u64("x-ratelimit-reset"),
                }
            } else {
                Error::Api {
                    status: status.as_u16(),
                    message,
                }
            }
        }
        _ => Error::Api {
            status: status.as_u16(),
            message,
        },
    })
}

/// The useful part of a REST error body. Validation failures (422) put the reason in
/// `errors` (strings or `{ message }` objects) under a generic "Unprocessable Entity".
fn api_message(v: &Value) -> Option<String> {
    let details: Vec<&str> = v
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| e.as_str().or_else(|| e.get("message")?.as_str()))
        .collect();
    if !details.is_empty() {
        return Some(details.join("; "));
    }
    v.get("message").and_then(Value::as_str).map(str::to_owned)
}

/// Percent-encode one URL path segment.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn enc_path(path: &str) -> String {
    path.split('/').map(enc).collect::<Vec<_>>().join("/")
}

const PR_QUERY: &str = r#"query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id title url
      author { login }
      baseRefName headRefName baseRefOid headRefOid changedFiles
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType viewerViewedState }
      }
    }
  }
}"#;

const MARK_VIEWED: &str = r#"mutation($id: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}"#;

const UNMARK_VIEWED: &str = r#"mutation($id: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}"#;

// ---- wire types ----

#[derive(Deserialize)]
struct GqlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize)]
struct GqlError {
    message: String,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct GqlRepoData {
    repository: Option<GqlRepo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlRepo {
    pull_request: Option<GqlPrPage>,
}

#[derive(Deserialize)]
struct GqlPrPage {
    #[serde(flatten)]
    meta: GqlPr,
    files: Option<GqlFiles>,
}

/// PR metadata plus accumulated files (from GraphQL, or from REST via `pr_rest`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GqlPr {
    pub id: String,
    pub title: String,
    pub url: String,
    pub author: Option<Login>,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub base_ref_oid: String,
    pub head_ref_oid: String,
    /// GitHub's count of changed files; can exceed what the listing APIs return.
    #[serde(default)]
    pub changed_files: Option<u32>,
    #[serde(skip)]
    pub files: Vec<ChangedFile>,
    /// The file listing stopped at the page cap while GitHub still reported more.
    #[serde(skip)]
    pub truncated: bool,
}

#[derive(Default, Deserialize)]
struct GqlFiles {
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
    nodes: Vec<Option<GqlFile>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlFile {
    path: String,
    additions: u32,
    deletions: u32,
    change_type: String,
    viewer_viewed_state: Option<ViewedState>,
}

impl GqlFile {
    fn into_changed(self) -> ChangedFile {
        let status = match self.change_type.as_str() {
            "ADDED" => FileStatus::Added,
            "DELETED" => FileStatus::Removed,
            "RENAMED" => FileStatus::Renamed,
            "COPIED" => FileStatus::Copied,
            "MODIFIED" => FileStatus::Modified,
            _ => FileStatus::Changed,
        };
        ChangedFile {
            path: self.path,
            previous_path: None,
            status,
            additions: self.additions,
            deletions: self.deletions,
            viewed: self.viewer_viewed_state.unwrap_or(ViewedState::Unviewed),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Login {
    pub login: String,
}

#[derive(Deserialize)]
struct User {
    login: String,
}

#[derive(Deserialize)]
struct SearchResult<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Issue {
    number: u64,
    title: String,
    html_url: String,
    updated_at: String,
    #[serde(default)]
    draft: bool,
    user: Option<Login>,
    repository_url: String,
}

impl Issue {
    fn into_summary(self, reason: InboxReason) -> Option<PrSummary> {
        let mut parts = self.repository_url.rsplit('/');
        let repo = parts.next()?.to_owned();
        let owner = parts.next()?.to_owned();
        Some(PrSummary {
            owner,
            repo,
            number: self.number,
            title: self.title,
            author: self.user.map(|u| u.login).unwrap_or_else(|| "ghost".into()),
            url: self.html_url,
            is_draft: self.draft,
            updated_at: self.updated_at,
            reason,
        })
    }
}

#[derive(Deserialize)]
struct Pull {
    number: u64,
    title: String,
    html_url: String,
    updated_at: String,
    #[serde(default)]
    draft: bool,
    user: Login,
    #[serde(default)]
    requested_reviewers: Vec<Login>,
}

#[derive(Deserialize)]
struct Repo {
    name: String,
    owner: Login,
    description: Option<String>,
    private: bool,
    updated_at: String,
}

impl Repo {
    fn into_summary(self) -> RepoSummary {
        RepoSummary {
            owner: self.owner.login,
            name: self.name,
            description: self.description,
            private: self.private,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
struct RestFile {
    filename: String,
    previous_filename: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
}

impl RestFile {
    fn into_changed(self) -> ChangedFile {
        let status = match self.status.as_str() {
            "added" => FileStatus::Added,
            "removed" => FileStatus::Removed,
            "renamed" => FileStatus::Renamed,
            "copied" => FileStatus::Copied,
            "modified" => FileStatus::Modified,
            _ => FileStatus::Changed,
        };
        ChangedFile {
            path: self.filename,
            previous_path: self.previous_filename,
            status,
            additions: self.additions,
            deletions: self.deletions,
            viewed: ViewedState::Unviewed,
        }
    }
}

#[derive(Deserialize)]
struct RestPull {
    node_id: String,
    title: String,
    html_url: String,
    user: Option<Login>,
    #[serde(default)]
    changed_files: Option<u32>,
    base: RestRef,
    head: RestRef,
}

#[derive(Deserialize)]
struct RestRef {
    #[serde(rename = "ref")]
    git_ref: String,
    sha: String,
}

#[derive(Deserialize)]
struct Review {
    id: u64,
    html_url: String,
    state: String,
}

#[derive(Deserialize)]
struct Compare {
    merge_base_commit: Sha,
}

#[derive(Deserialize)]
struct Sha {
    sha: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_path_segments() {
        assert_eq!(enc_path("src/a b/#x.ts"), "src/a%20b/%23x.ts");
        assert_eq!(enc("ü"), "%C3%BC");
    }

    #[test]
    fn api_message_prefers_validation_details() {
        let v = json!({ "message": "Validation Failed", "errors": [
            { "resource": "PullRequestReview", "code": "custom", "message": "Review body is required" },
            "Can not approve your own pull request",
        ]});
        assert_eq!(
            api_message(&v).as_deref(),
            Some("Review body is required; Can not approve your own pull request")
        );
        let plain = json!({ "message": "Not Found", "errors": [] });
        assert_eq!(api_message(&plain).as_deref(), Some("Not Found"));
    }

    #[test]
    fn graphql_url_for_ghe() {
        assert_eq!(
            graphql_url("https://api.github.com"),
            "https://api.github.com/graphql"
        );
        assert_eq!(
            graphql_url("https://ghe.corp/api/v3"),
            "https://ghe.corp/api/graphql"
        );
    }

    #[test]
    fn gh_host() {
        assert_eq!(GitHub::new(DEFAULT_API_URL).unwrap().gh_host(), None);
        assert_eq!(
            GitHub::new("https://ghe.corp/api/v3")
                .unwrap()
                .gh_host()
                .as_deref(),
            Some("ghe.corp")
        );
    }
}
