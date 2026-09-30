//! High-level API used by the Tauri commands: auth state, PR metadata, cached diffs.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::{BoxFuture, FutureExt, Shared};
use tokio::sync::OnceCell;

use crate::auth::{self, AuthConfig, SOURCE_ORDER};
use crate::cache::{BlobCache, DiffCache, DiffKey};
use crate::diff;
use crate::error::{Error, Result};
use crate::github::{Content, GitHub, DEFAULT_API_URL};
use crate::model::{
    AuthSource, AuthStatus, FileDiff, FileStatus, InboxReason, PrDetail, PrSummary, RepoSummary,
    ReviewEvent, Side, SubmittedReview,
};
use crate::temp_copy;

/// Files above either limit are not diffed (`tooLarge`).
pub const MAX_DIFF_BYTES: usize = 1_500_000;
pub const MAX_DIFF_LINES: usize = 20_000;
/// Largest file `get_file_content` returns (images, files opened in their default app).
pub const MAX_CONTENT_BYTES: usize = 50_000_000;
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
    /// Bumped whenever the active token changes, so a 401 from a request made with an
    /// older token does not clear a newer one.
    generation: u64,
}

impl AuthState {
    /// Replace the state for a new (or no) token, bumping the generation.
    fn replace(&mut self, login: Option<String>, source: Option<AuthSource>, signed_out: bool) {
        *self = AuthState {
            login,
            source,
            signed_out,
            generation: self.generation.wrapping_add(1),
        };
    }
}

/// The active login and the token generation it belongs to (see `Service::on_err`).
struct Session {
    login: String,
    generation: u64,
}

type PrKey = (String, String, u64);

/// What `get_file_diff` needs to know about a PR, remembered from `get_pr`.
struct PrInfo {
    /// Order in which the `get_pr` that produced this started; a newer fetch always wins.
    seq: u64,
    base_sha: String,
    head_sha: String,
    /// path -> (previous path, status)
    files: HashMap<String, (Option<String>, FileStatus)>,
    merge_base: Arc<OnceCell<String>>,
}

type DiffFuture = Shared<BoxFuture<'static, Result<Arc<FileDiff>>>>;

/// One side of a changed file, from `get_file_content`.
pub struct FileContent {
    /// Commit it was read at: the merge base (old side) or the head (new side).
    pub sha: String,
    /// Path at that commit: the previous path on the old side of a rename.
    pub path: String,
    pub bytes: Vec<u8>,
}

pub struct Service {
    gh: GitHub,
    auth_cfg: AuthConfig,
    auth: tokio::sync::Mutex<AuthState>,
    prs: Mutex<HashMap<PrKey, Arc<PrInfo>>>,
    pr_seq: AtomicU64,
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
            pr_seq: AtomicU64::new(0),
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
                    let signed_out = st.signed_out;
                    st.replace(Some(login), Some(source), signed_out);
                    return Ok(());
                }
                // A stale token in one source should not hide a good one in the next.
                Err(Error::Unauthorized) => continue,
                Err(e) => last_err = Some(e),
            }
        }
        self.gh.set_token(None);
        let signed_out = st.signed_out;
        st.replace(None, None, signed_out);
        last_err.map_or(Ok(()), Err)
    }

    /// Ensure a token is active before an API call.
    async fn ensure_auth(&self) -> Result<Session> {
        let mut st = self.auth.lock().await;
        if st.login.is_none() {
            self.resolve(&mut st).await?;
        }
        let login = st.login.clone().ok_or(Error::NotAuthenticated)?;
        Ok(Session {
            login,
            generation: st.generation,
        })
    }

    /// After a 401, forget the token the request was made with so the next call re-resolves.
    /// A token set since then (`generation` moved on) is left alone.
    async fn on_err<T>(&self, generation: u64, r: Result<T>) -> Result<T> {
        if matches!(r, Err(Error::Unauthorized)) {
            let mut st = self.auth.lock().await;
            if st.generation == generation {
                self.gh.set_token(None);
                let signed_out = st.signed_out;
                st.replace(None, None, signed_out);
            }
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
        st.replace(Some(login), Some(AuthSource::Keychain), false);
        Ok(status(&st))
    }

    pub async fn sign_out(&self) -> Result<AuthStatus> {
        if self.auth_cfg.keychain {
            auth::keychain_delete().await.map_err(Error::Other)?;
        }
        let mut st = self.auth.lock().await;
        self.gh.set_token(None);
        st.replace(None, None, true);
        *lock(&self.user_repos) = None;
        Ok(status(&st))
    }

    /// Use a token directly, skipping all sources (tests, CLI tools).
    pub async fn use_token(&self, token: &str) -> Result<AuthStatus> {
        let login = self.gh.login_for(token).await?;
        let mut st = self.auth.lock().await;
        self.gh.set_token(Some(token.to_owned()));
        st.replace(Some(login), Some(AuthSource::Env), false);
        Ok(status(&st))
    }

    // ---- listings ----

    pub async fn list_inbox(&self) -> Result<Vec<PrSummary>> {
        let gen = self.ensure_auth().await?.generation;
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
            .on_err(gen, review.and_then(|r| authored.map(|a| (r, a))))
            .await?;
        Ok(merge_inbox(review, authored))
    }

    pub async fn search_repos(&self, query: &str) -> Result<Vec<RepoSummary>> {
        let gen = self.ensure_auth().await?.generation;
        let query = query.trim();
        if query.is_empty() {
            let mine = self.on_err(gen, self.cached_user_repos().await).await?;
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
            Err(e) if out.is_empty() => return self.on_err(gen, Err(e)).await,
            Err(_) => {}
        }
        if out.is_empty() {
            self.on_err(gen, mine).await?;
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
        let session = self.ensure_auth().await?;
        let prs = self
            .gh
            .list_repo_prs(owner, repo, Some(&session.login))
            .await;
        self.on_err(session.generation, prs).await
    }

    // ---- PR ----

    pub async fn get_pr(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
    ) -> Result<PrDetail> {
        let gen = self.ensure_auth().await?.generation;
        let seq = self.pr_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut pr = match self.gh.pr_graphql(owner, repo, number).await {
            Ok(mut pr) => {
                // GraphQL has no previous path; the old side of a rename/copy diff needs it,
                // so fetch the REST list only then, and fail rather than show a wrong diff.
                let has_renames = pr
                    .files
                    .iter()
                    .any(|f| matches!(f.status, FileStatus::Renamed | FileStatus::Copied));
                if has_renames {
                    let rest = self
                        .gh
                        .pr_files_rest(owner, repo, number, pr.changed_files)
                        .await;
                    let renames: HashMap<String, String> = self
                        .on_err(gen, rest)
                        .await?
                        .into_iter()
                        .filter_map(|f| Some((f.path, f.previous_path?)))
                        .collect();
                    for f in &mut pr.files {
                        f.previous_path = renames.get(&f.path).cloned();
                    }
                }
                pr
            }
            // Some proxies / GHE setups reject GraphQL (e.g. 403 "GraphQL is not available").
            // REST has everything but the viewed state.
            Err(e) if graphql_fallback_ok(&e) => {
                warn_rest_fallback(&e);
                let meta = self.gh.pr_rest(owner, repo, number).await;
                let mut pr = self.on_err(gen, meta).await?;
                let files = self
                    .gh
                    .pr_files_rest(owner, repo, number, pr.changed_files)
                    .await;
                pr.files = self.on_err(gen, files).await?;
                pr
            }
            Err(e) => return self.on_err(gen, Err(e)).await,
        };
        pr.files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        let listed = u32::try_from(pr.files.len()).unwrap_or(u32::MAX);
        let total_files = pr.changed_files.unwrap_or(listed).max(listed);
        let files_truncated = pr.truncated || total_files > listed;

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
            seq,
            base_sha: pr.base_ref_oid.clone(),
            head_sha: pr.head_ref_oid.clone(),
            files: pr
                .files
                .iter()
                .map(|f| (f.path.clone(), (f.previous_path.clone(), f.status)))
                .collect(),
            merge_base,
        });
        {
            // Overlapping fetches can finish out of order; keep the one that started last.
            let mut prs = lock(&self.prs);
            if prs.get(&key).is_none_or(|old| old.seq < seq) {
                prs.insert(key, info.clone());
            }
        }

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
            total_files,
            files_truncated,
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
        // Also re-resolves a token cleared by an earlier 401 and refuses cached diffs after sign-out.
        let gen = self.ensure_auth().await?.generation;
        let info = self.pr_info(owner, repo, number).await?;
        let key = DiffKey {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            number,
            path: path.to_owned(),
            old_path: info.files.get(path).and_then(|(old, _)| old.clone()),
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
        self.on_err(gen, res).await
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
                return Ok(Content::Missing);
            }
            let base = self.merge_base(owner, repo, info).await?;
            self.content(owner, repo, &base, old_path_ref).await
        };
        let new_fut = async {
            if status == FileStatus::Removed {
                return Ok(Content::Missing);
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
        let sides = [&old, &new];
        // A too-large side still holds its first bytes, enough to detect binary content.
        if sides.iter().filter_map(|c| c.bytes()).any(diff::is_binary) {
            out.binary = true;
            return Ok(out);
        }
        if sides.iter().any(|c| match c {
            Content::Missing => false,
            Content::TooLarge(_) => true,
            Content::Bytes(b) => b.len() > MAX_DIFF_BYTES || line_count(b) > MAX_DIFF_LINES,
        }) {
            out.too_large = true;
            return Ok(out);
        }
        let text = |c: Content| match c {
            Content::Bytes(b) => Some(into_string(b)),
            Content::Missing | Content::TooLarge(_) => None,
        };
        let old_text = text(old);
        let new_text = text(new);
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

    /// File contents at a commit for diffing: files over `MAX_DIFF_BYTES` are not downloaded
    /// in full (they are never diffed).
    async fn content(&self, owner: &str, repo: &str, sha: &str, path: &str) -> Result<Content> {
        self.content_up_to(owner, repo, sha, path, MAX_DIFF_BYTES)
            .await
    }

    /// File contents at a commit, via the disk cache. Files over `limit` are not downloaded in
    /// full. Only files up to `MAX_DIFF_BYTES` are cached: the cache is never pruned, and larger
    /// files are only fetched when the user asks for them.
    async fn content_up_to(
        &self,
        owner: &str,
        repo: &str,
        sha: &str,
        path: &str,
        limit: usize,
    ) -> Result<Content> {
        let repo_key = format!("{owner}/{repo}");
        if let Some(hit) = self.blobs.get(&repo_key, sha, path).await {
            return Ok(hit.map_or(Content::Missing, Content::Bytes));
        }
        let content = self.gh.file_content(owner, repo, sha, path, limit).await?;
        match &content {
            Content::Missing => self.blobs.put(&repo_key, sha, path, None).await,
            Content::Bytes(b) if b.len() <= MAX_DIFF_BYTES => {
                self.blobs.put(&repo_key, sha, path, Some(b)).await
            }
            Content::Bytes(_) | Content::TooLarge(_) => {}
        }
        Ok(content)
    }

    /// Raw bytes of one side of a changed file, up to `MAX_CONTENT_BYTES`: the head version
    /// (`Side::New`) or the merge-base version at the old path (`Side::Old`), the same two
    /// versions `get_file_diff` compares. Used for images and files opened in another app.
    pub async fn get_file_content(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
        path: &str,
        side: Side,
    ) -> Result<FileContent> {
        let gen = self.ensure_auth().await?.generation;
        let res = self.read_side(owner, repo, number, path, side).await;
        self.on_err(gen, res).await
    }

    async fn read_side(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
        path: &str,
        side: Side,
    ) -> Result<FileContent> {
        let info = self.pr_info(owner, repo, number).await?;
        let (old_path, status) = info
            .files
            .get(path)
            .cloned()
            .unwrap_or((None, FileStatus::Modified));
        // Like `compute_diff`, don't ask GitHub for a side the file doesn't have.
        match (side, status) {
            (Side::Old, FileStatus::Added) => {
                return Err(Error::NotFound(format!("old version of {path}")))
            }
            (Side::New, FileStatus::Removed) => {
                return Err(Error::NotFound(format!("new version of {path}")))
            }
            _ => {}
        }
        let (sha, at) = match side {
            Side::New => (info.head_sha.clone(), path.to_owned()),
            Side::Old => (
                self.merge_base(owner, repo, &info).await?,
                old_path.unwrap_or_else(|| path.to_owned()),
            ),
        };
        match self
            .content_up_to(owner, repo, &sha, &at, MAX_CONTENT_BYTES)
            .await?
        {
            Content::Bytes(bytes) => Ok(FileContent {
                sha,
                path: at,
                bytes,
            }),
            Content::Missing => Err(Error::NotFound(format!(
                "{at} at {}",
                sha.get(..7).unwrap_or(&sha)
            ))),
            Content::TooLarge(_) => Err(Error::Other(format!(
                "{at} is larger than {} MB",
                MAX_CONTENT_BYTES / 1_000_000
            ))),
        }
    }

    /// Write one side of a changed file under `root` (see `temp_copy::path_for`) so it can be
    /// opened in its default app, and return where it went.
    pub async fn save_temp_copy(
        self: &Arc<Self>,
        root: &Path,
        owner: &str,
        repo: &str,
        number: u64,
        path: &str,
        side: Side,
    ) -> Result<PathBuf> {
        temp_copy::check_openable(path)?;
        let file = self
            .get_file_content(owner, repo, number, path, side)
            .await?;
        let target = temp_copy::path_for(root, owner, repo, number, side, &file.sha, &file.path)?;
        temp_copy::write(&target, &file.bytes).await?;
        Ok(target)
    }

    pub async fn set_file_viewed(&self, pr_id: &str, path: &str, viewed: bool) -> Result<()> {
        let gen = self.ensure_auth().await?.generation;
        let res = self.gh.set_file_viewed(pr_id, path, viewed).await;
        self.on_err(gen, res).await
    }

    /// Submit a review on the head commit `get_pr` last saw, so it is pinned to what was
    /// reviewed even if the branch moved since. GitHub rejects a comment review without
    /// a body (422), so that is refused here without a request.
    pub async fn submit_review(
        self: &Arc<Self>,
        owner: &str,
        repo: &str,
        number: u64,
        event: ReviewEvent,
        body: &str,
    ) -> Result<SubmittedReview> {
        let body = body.trim();
        if event == ReviewEvent::Comment && body.is_empty() {
            return Err(Error::Other("Write a comment before submitting".into()));
        }
        let gen = self.ensure_auth().await?.generation;
        let info = self.pr_info(owner, repo, number).await?;
        let res = self
            .gh
            .submit_review(owner, repo, number, &info.head_sha, event, body)
            .await;
        self.on_err(gen, res).await
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
