//! Thin Tauri command layer over `fast_reviewer_core`.
//! Commands (names are the IPC contract, see src/lib/api.ts):
//!   auth_status() -> AuthStatus
//!   set_token(token: String) -> AuthStatus
//!   sign_out() -> AuthStatus
//!   list_inbox() -> Vec<PrSummary>
//!   search_repos(query: String) -> Vec<RepoSummary>
//!   list_repo_prs(owner: String, repo: String) -> Vec<PrSummary>
//!   get_pr(owner: String, repo: String, number: u64) -> PrDetail
//!   get_file_diff(owner: String, repo: String, number: u64, path: String) -> FileDiff
//!   set_file_viewed(prId: String, path: String, viewed: bool) -> ()
//!   open_url(url: String) -> ()
//! Errors are returned as `String` messages.
use std::sync::Arc;

use fast_reviewer_core::model::{AuthStatus, FileDiff, PrDetail, PrSummary, RepoSummary};
use fast_reviewer_core::{Config, Service};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

type Core<'a> = State<'a, Arc<Service>>;
type CmdResult<T> = Result<T, String>;

#[tauri::command]
async fn auth_status(core: Core<'_>) -> CmdResult<AuthStatus> {
    Ok(core.auth_status().await?)
}

#[tauri::command]
async fn set_token(core: Core<'_>, token: String) -> CmdResult<AuthStatus> {
    Ok(core.set_token(&token).await?)
}

#[tauri::command]
async fn sign_out(core: Core<'_>) -> CmdResult<AuthStatus> {
    Ok(core.sign_out().await?)
}

#[tauri::command]
async fn list_inbox(core: Core<'_>) -> CmdResult<Vec<PrSummary>> {
    Ok(core.list_inbox().await?)
}

#[tauri::command]
async fn search_repos(core: Core<'_>, query: String) -> CmdResult<Vec<RepoSummary>> {
    Ok(core.search_repos(&query).await?)
}

#[tauri::command]
async fn list_repo_prs(core: Core<'_>, owner: String, repo: String) -> CmdResult<Vec<PrSummary>> {
    Ok(core.list_repo_prs(&owner, &repo).await?)
}

#[tauri::command]
async fn get_pr(core: Core<'_>, owner: String, repo: String, number: u64) -> CmdResult<PrDetail> {
    Ok(core.get_pr(&owner, &repo, number).await?)
}

#[tauri::command]
async fn get_file_diff(
    core: Core<'_>,
    owner: String,
    repo: String,
    number: u64,
    path: String,
) -> CmdResult<Arc<FileDiff>> {
    Ok(core.get_file_diff(&owner, &repo, number, &path).await?)
}

#[tauri::command]
async fn set_file_viewed(
    core: Core<'_>,
    pr_id: String,
    path: String,
    viewed: bool,
) -> CmdResult<()> {
    Ok(core.set_file_viewed(&pr_id, &path, viewed).await?)
}

#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core = Service::new(Config::from_env()).expect("failed to initialise GitHub client");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            auth_status,
            set_token,
            sign_out,
            list_inbox,
            search_repos,
            list_repo_prs,
            get_pr,
            get_file_diff,
            set_file_viewed,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
