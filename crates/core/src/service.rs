//! High-level API used by the Tauri commands: auth state, PR metadata, cached diffs.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::{BoxFuture, FutureExt, Shared};
use tokio::sync::OnceCell;

use crate::auth::{self, AuthConfig, SOURCE_ORDER};
use crate::cache::{BlobCache, DiffCache, DiffKey};
use crate::diff;
use crate::error::{Error, Result};
use crate::github::{GitHub, DEFAULT_API_URL};
use crate::model::{
    AuthSource, AuthStatus, FileDiff, FileStatus, InboxReason, PrDetail, PrSummary, RepoSummary,
};

/// Files above either limit are not diffed (`tooLarge`).
pub const MAX_DIFF_BYTES: usize = 1_500_000;
pub const MAX_DIFF_LINES: usize = 20_000;
const DIFF_CACHE_ENTRIES: usize = 200;
const CONTEXT_LINES: usize = 3;
const USER_REPOS_TTL: Duration = Duration::from_secs(300);

pub struct Config {
    pub api_url: String,
    /// Disk cache for file contents; None disables it.
    pub cache_dir: Option<PathBuf>,
    pub auth: AuthConfig,
}

impl Config {
    /// Production config: `GITHUB_API_URL` override (tests, GHE), OS cache dir, all token sources.
    pub fn from_env() -> Self {
        let api_url = std::env::var("GITHUB_API_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_API_URL.to_owned());
        Self {
            api_url,
            cache_dir: BlobCache::default_dir(),
            auth: AuthConfig::default(),
        }
    }
}

#[derive(Default)]
struct AuthState {
    login: Option<String>,
    source: Option<AuthSource>,
    /// After an explicit sign-out, ignore env / gh CLI until a token is set again.
    signed_out: bool,
}

type PrKey = (String, String, u64);

/// What `get_file_diff` needs to know about a PR, remembered from `get_pr`.
struct PrInfo {
    base_sha: String,
    head_sha: String,
    /// path -> (previous path, status)
    files: HashMap<String, (Option<String>, FileStatus)>,
    merge_base: Arc<OnceCell<String>>,
}

type DiffFuture = Shared<BoxFuture<'static, Result<Arc<FileDiff>>>>;

pub struct Service {
    gh: GitHub,
    auth_cfg: AuthConfig,
    auth: tokio::sync::Mutex<AuthState>,
    prs: Mutex<HashMap<PrKey, Arc<PrInfo>>>,
    diffs: DiffCache,
    inflight: Mutex<HashMap<DiffKey, DiffFuture>>,
    blobs: BlobCache,
    user_repos: Mutex<Option<(Instant, Arc<Vec<RepoSummary>>)>>,
}

/// GraphQL failures that REST might not share. Auth problems and missing PRs are definitive.
fn graphql_fallback_ok(e: &Error) -> bool {
    !matches!(
        e,
        Error::NotAuthenticated | Error::Unauthorized | Error::NotFound(_)
    )
}

fn warn_rest_fallback(e: &Error) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "fast-reviewer: warning: GraphQL unavailable ({e}); using REST for PRs (viewed state unavailable)"
        );
    });
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Service {
    pub fn new(cfg: Config) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            gh: GitHub::new(&cfg.api_url)?,
            auth_cfg: cfg.auth,
            auth: Default::default(),
            prs: Default::default(),
            diffs: DiffCache::new(DIFF_CACHE_ENTRIES),
            inflight: Default::default(),
            blobs: BlobCache::new(cfg.cache_dir),
            user_repos: Default::default(),
        }))
    }

    pub fn github(&self) -> &GitHub {
        &self.gh
    }

    // ---- auth ----

    /// Current auth state; resolves a token (env -> gh CLI -> keychain) if none is active.
    pub async fn auth_status(&self) -> Result<AuthStatus> {
        let mut st = self.auth.lock().await;
        if st.login.is_none() {
            self.resolve(&mut st).await?;
        }
        Ok(status(&st))
    }

    async fn resolve(&self, st: &mut AuthState) -> Result<()> {
        let host = self.gh.gh_host();
        let mut last_err = None;
        for source in SOURCE_ORDER {
            if st.signed_out && source != AuthSource::Keychain {
                continue;
            }
            let Some(token) = auth::read_token(&self.auth_cfg, source, host.as_deref()).await
            else {
                continue;
            };
            match self.gh.login_for(&token).await {
                Ok(login) => {
                    self.gh.set_token(Some(token));
                    st.login = Some(login);
                    st.source = Some(source);
                    return Ok(());
                }
                // A stale token in one source should not hide a good one in the next.
                Err(Error::Unauthorized) => continue,
                Err(e) => last_err = Some(e),
            }
        }
        self.gh.set_token(None);
        st.login = None;
        st.source = None;
        last_err.map_or(Ok(()), Err)
    }

    /// Ensure a token is active before an API call.
    async fn ensure_auth(&self) -> Result<String> {
        let mut st = self.auth.lock().await;
        if st.login.is_none() {
            self.resolve(&mut st).await?;
        }
        st.login.clone().ok_or(Error::NotAuthenticated)
    }

    /// Forget the active token after a 401 so the next call re-resolves.
    async fn on_err<T>(&self, r: Result<T>) -> Result<T> {
        if matches!(r, Err(Error::Unauthorized)) {
            let mut st = self.auth.lock().await;
            st.login = None;
            st.source = None;
            self.gh.set_token(None);
        }
        r
    }

    /// Validate a pasted token, then store it in the keychain. Keychain failures are
    /// non-fatal: the token is still used for this session.
    pub async fn set_token(&self, token: &str) -> Result<AuthStatus> {
        let token = token.trim().to_owned();
        if token.is_empty() {
            return Err(Error::Other("Token is empty".into()));
        }
        let login = self.gh.login_for(&token).await?;
        if self.auth_cfg.keychain {
            if let Err(e) = auth::keychain_set(token.clone()).await {
                eprintln!("fast-reviewer: {e}");
            }
        }
        let mut st = self.auth.lock().await;
        self.gh.set_token(Some(token));
        *st = AuthState {
            login: Some(login),
            source: Some(AuthSource::Keychain),
            signed_out: false,
        };
        Ok(status(&st))
    }

    pub async fn sign_out(&self) -> Result<AuthStatus> {
        if self.auth_cfg.keychain {
            auth::keychain_delete().await.map_err(Error::Other)?;
        }
        let mut st = self.auth.lock().await;
        self.gh.set_token(None);
        *st = AuthState {
            signed_out: true,
            ..Default::default()
        };
        *lock(&self.user_repos) = None;
        Ok(status(&st))
    }

    /// Use a token directly, skipping all sources (tests, CLI tools).
    pub async fn use_token(&self, token: &str) -> Result<AuthStatus> {
        let login = self.gh.login_for(token).await?;
        let mut st = self.auth.lock().await;
        self.gh.set_token(Some(token.to_owned()));
        *st = AuthState {
            login: Some(login),
            source: Some(AuthSource::Env),
            signed_out: false,
        };
        Ok(status(&st))
    }

    // ---- listings ----

    pub async fn list_inbox(&self) -> Result<Vec<PrSummary>> {
        self.ensure_auth().await?;
        let (review, authored) = futures::future::join(
            self.gh.search_prs(
                "is:open is:pr review-requested:@me archived:false",
                InboxReason::ReviewRequested,
            ),
            self.gh.search_prs(
                "is:open is:pr author:@me archived:false",
                InboxReason::Authored,
            ),
        )
        .await;
        let (review, authored) = self
            .on_err(review.and_then(|r| authored.map(|a| (r, a))))
            .await?;
        Ok(merge_inbox(review, authored))
    }

    pub async fn search_repos(&self, query: &str) -> Result<Vec<RepoSummary>> {
        self.ensure_auth().await?;
        let query = query.trim();
        if query.is_empty() {
            let mine = self.on_err(self.cached_user_repos().await).await?;
            return Ok(mine.iter().take(30).cloned().collect());
        }
        let search_q = match query.split_once('/') {
            Some((owner, name)) if !owner.is_empty() => {
                format!("{name} in:name user:{owner} fork:true")
            }
            _ => format!("{query} in:name fork:true"),
        };
        let (mine, found) =
            futures::future::join(self.cached_user_repos(), self.gh.search_repos(&search_q)).await;
        let needle = query.to_lowercase();
        let mut out: Vec<RepoSummary> = match &mine {
            Ok(m) => m
                .iter()
                .filter(|r| {
                    format!("{}/{}", r.owner, r.name)
                        .to_lowercase()
                        .contains(&needle)
                })
                .cloned()
                .collect(),
            Err(_) => Vec::new(),
        };
        match found {
            Ok(found) => {
                for r in found {
                    if !out.iter().any(|o| {
                        o.owner.eq_ignore_ascii_case(&r.owner)
                            && o.name.eq_ignore_ascii_case(&r.name)
                    }) {
                        out.push(r);
                    }
                }
            }
            // Search has a tight rate limit; local matches are still useful.
            Err(e) if out.is_empty() => return self.on_err(Err(e)).await,
            Err(_) => {}
        }
        if out.is_empty() {
            self.on_err(mine).await?;
        }
        out.truncate(50);
        Ok(out)
    }

    async fn cached_user_repos(&self) -> Result<Arc<Vec<RepoSummary>>> {
        if let Some((at, repos)) = lock(&self.user_repos).as_ref() {
            if at.elapsed() < USER_REPOS_TTL {
                return Ok(repos.clone());
            }
        }
        let repos = Arc::new(self.gh.user_repos().await?);
        *lock(&self.user_repos) = Some((Instant::now(), repos.clone()));
        Ok(repos)
    }

    pub async fn list_repo_prs(&self, owner: &str, repo: &str) -> Result<Vec<PrSummary>> {
        let viewer = self.ensure_auth().await?;
        self.on_err(self.gh.list_repo_prs(owner, repo, Some(&viewer)).await)
            .await
    }

    // ---- PR ----

    pub async fn get_pr(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
    ) -> Result<PrDetail> {
        self.ensure_auth().await?;
        let (pr, rest_files) = futures::future::join(
            self.gh.pr_graphql(owner, repo, number),
            self.gh.pr_files_rest(owner, repo, number),
        )
        .await;
        let mut pr = match pr {
            Ok(mut pr) => {
                // Rename info is cosmetic for the list but needed for the old side of the diff;
                // tolerate failure.
                let renames: HashMap<String, String> = rest_files
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|f| Some((f.path, f.previous_path?)))
                    .collect();
                for f in &mut pr.files {
                    f.previous_path = renames.get(&f.path).cloned();
                }
                pr
            }
            // Some proxies / GHE setups reject GraphQL (e.g. 403 "GraphQL is not available").
            // REST has everything but the viewed state.
            Err(e) if graphql_fallback_ok(&e) => {
                warn_rest_fallback(&e);
                let meta = self.gh.pr_rest(owner, repo, number).await;
                let mut pr = self.on_err(meta).await?;
                pr.files = self.on_err(rest_files).await?;
                pr
            }
            Err(e) => return self.on_err(Err(e)).await,
        };
        pr.files.sort_unstable_by(|a, b| a.path.cmp(&b.path));

        let key: PrKey = (owner.to_owned(), repo.to_owned(), number);
        let merge_base = {
            let prs = lock(&self.prs);
            match prs.get(&key) {
                Some(old) if old.base_sha == pr.base_ref_oid && old.head_sha == pr.head_ref_oid => {
                    old.merge_base.clone()
                }
                _ => Arc::new(OnceCell::new()),
            }
        };
        let info = Arc::new(PrInfo {
            base_sha: pr.base_ref_oid.clone(),
            head_sha: pr.head_ref_oid.clone(),
            files: pr
                .files
                .iter()
                .map(|f| (f.path.clone(), (f.previous_path.clone(), f.status)))
                .collect(),
            merge_base,
        });
        lock(&self.prs).insert(key, info.clone());

        // Warm the merge base so the first diff doesn't pay for it.
        if !info.merge_base.initialized() {
            let this = self.clone();
            let (o, r) = (owner.to_owned(), repo.to_owned());
            tokio::spawn(async move {
                let _ = this.merge_base(&o, &r, &info).await;
            });
        }

        Ok(PrDetail {
            id: pr.id,
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            number,
            title: pr.title,
            author: pr.author.map(|a| a.login).unwrap_or_else(|| "ghost".into()),
            url: pr.url,
            base_ref: pr.base_ref_name,
            head_ref: pr.head_ref_name,
            base_sha: pr.base_ref_oid,
            head_sha: pr.head_ref_oid,
            files: pr.files,
        })
    }

    /// GitHub diffs a PR against the merge base of base and head ("three-dot" diff).
    async fn merge_base(&self, owner: &str, repo: &str, info: &PrInfo) -> Result<String> {
        info.merge_base
            .get_or_try_init(|| async {
                match self
                    .gh
                    .merge_base(owner, repo, &info.base_sha, &info.head_sha)
                    .await
                {
                    Ok(sha) => Ok(sha),
                    // e.g. unrelated histories: fall back to the base tip.
                    Err(Error::NotFound(_)) => Ok(info.base_sha.clone()),
                    Err(e) => Err(e),
                }
            })
            .await
            .cloned()
    }

    async fn pr_info(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
    ) -> Result<Arc<PrInfo>> {
        let key: PrKey = (owner.to_owned(), repo.to_owned(), number);
        if let Some(info) = lock(&self.prs).get(&key) {
            return Ok(info.clone());
        }
        self.get_pr(owner, repo, number).await?;
        lock(&self.prs)
            .get(&key)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("{owner}/{repo}#{number}")))
    }

    pub async fn get_file_diff(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
        path: &str,
    ) -> Result<Arc<FileDiff>> {
        let info = self.pr_info(owner, repo, number).await?;
        let key = DiffKey {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            number,
            path: path.to_owned(),
            base_sha: info.base_sha.clone(),
            head_sha: info.head_sha.clone(),
        };
        if let Some(d) = self.diffs.get(&key) {
            return Ok(d);
        }
        // Dedupe concurrent requests (UI prefetch racing a click).
        let fut = {
            let mut inflight = lock(&self.inflight);
            inflight
                .entry(key.clone())
                .or_insert_with(|| {
                    let this = self.clone();
                    let key = key.clone();
                    async move {
                        let res = this.compute_diff(&key, &info).await.map(Arc::new);
                        if let Ok(d) = &res {
                            this.diffs.put(key.clone(), d.clone());
                        }
                        lock(&this.inflight).remove(&key);
                        res
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        let res = fut.await;
        self.on_err(res).await
    }

    async fn compute_diff(&self, key: &DiffKey, info: &PrInfo) -> Result<FileDiff> {
        let (owner, repo, path) = (&key.owner, &key.repo, key.path.as_str());
        let (old_path, status) = info
            .files
            .get(path)
            .cloned()
            .unwrap_or((None, FileStatus::Modified));
        let old_path_ref = old_path.as_deref().unwrap_or(path);

        let old_fut = async {
            if status == FileStatus::Added {
                return Ok(None);
            }
            let base = self.merge_base(owner, repo, info).await?;
            self.content(owner, repo, &base, old_path_ref).await
        };
        let new_fut = async {
            if status == FileStatus::Removed {
                return Ok(None);
            }
            self.content(owner, repo, &info.head_sha, path).await
        };
        let (old, new) = futures::future::try_join(old_fut, new_fut).await?;

        let language = diff::language_for_path(path).map(str::to_owned);
        let mut out = FileDiff {
            path: path.to_owned(),
            old_path,
            language,
            binary: false,
            too_large: false,
            hunks: Vec::new(),
            old_text: None,
            new_text: None,
        };
        let sides = [old.as_deref(), new.as_deref()];
        if sides.iter().flatten().any(|b| diff::is_binary(b)) {
            out.binary = true;
            return Ok(out);
        }
        if sides
            .iter()
            .flatten()
            .any(|b| b.len() > MAX_DIFF_BYTES || line_count(b) > MAX_DIFF_LINES)
        {
            out.too_large = true;
            return Ok(out);
        }
        let old_text = old.map(into_string);
        let new_text = new.map(into_string);
        // Diffing is CPU-bound; keep it off the async workers.
        let (hunks, old_text, new_text) = tokio::task::spawn_blocking(move || {
            let hunks = diff::diff_texts(
                old_text.as_deref().unwrap_or(""),
                new_text.as_deref().unwrap_or(""),
                CONTEXT_LINES,
            );
            (hunks, old_text, new_text)
        })
        .await
        .map_err(|e| Error::Other(format!("diff failed: {e}")))?;
        out.hunks = hunks;
        out.old_text = old_text;
        out.new_text = new_text;
        Ok(out)
    }

    /// File contents at a commit, via the disk cache.
    async fn content(
        &self,
        owner: &str,
        repo: &str,
        sha: &str,
        path: &str,
    ) -> Result<Option<Vec<u8>>> {
        let repo_key = format!("{owner}/{repo}");
        if let Some(hit) = self.blobs.get(&repo_key, sha, path).await {
            return Ok(hit);
        }
        let bytes = self.gh.file_content(owner, repo, sha, path).await?;
        self.blobs.put(&repo_key, sha, path, bytes.as_deref()).await;
        Ok(bytes)
    }

    pub async fn set_file_viewed(&self, pr_id: &str, path: &str, viewed: bool) -> Result<()> {
        self.ensure_auth().await?;
        self.on_err(self.gh.set_file_viewed(pr_id, path, viewed).await)
            .await
    }

    /// Number of diffs in the in-memory cache (for tests / diagnostics).
    pub fn cached_diffs(&self) -> usize {
        self.diffs.len()
    }
}

fn status(st: &AuthState) -> AuthStatus {
    AuthStatus {
        authenticated: st.login.is_some(),
        login: st.login.clone(),
        source: st.source,
    }
}

fn line_count(b: &[u8]) -> usize {
    b.iter().filter(|&&c| c == b'\n').count()
}

fn into_string(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Review requests win over authored when a PR is in both; newest first.
fn merge_inbox(review: Vec<PrSummary>, authored: Vec<PrSummary>) -> Vec<PrSummary> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<PrSummary> = review
        .into_iter()
        .chain(authored)
        .filter(|p| seen.insert((p.owner.to_lowercase(), p.repo.to_lowercase(), p.number)))
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}
