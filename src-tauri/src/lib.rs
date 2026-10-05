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
//!   get_file_content(owner: String, repo: String, number: u64, path: String, side: Side) -> raw bytes
//!   open_file(owner: String, repo: String, number: u64, path: String, side: Side) -> ()
//!   set_file_viewed(prId: String, path: String, viewed: bool) -> ()
//!   list_review_threads(owner: String, repo: String, number: u64) -> Vec<ReviewThread>
//!   submit_review(owner: String, repo: String, number: u64, event: ReviewEvent, body: String, comments: Vec<NewComment>) -> SubmittedReview
//!   open_url(url: String) -> ()
//! Errors are returned as `String` messages.
//! Updates go through the updater and process plugins, called from src/lib/updater.ts.
//! The app menu's "Check for Updates…" item emits `CHECK_UPDATES_EVENT` to the UI.
use std::sync::Arc;

use fast_reviewer_core::model::{
    AuthStatus, FileDiff, NewComment, PrDetail, PrSummary, RepoSummary, ReviewEvent, ReviewThread,
    Side, SubmittedReview,
};
use fast_reviewer_core::{Config, Service};
use tauri::ipc::Response;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_opener::OpenerExt;

/// Menu item id, and the event the UI listens to (see src/lib/updater.ts).
const CHECK_UPDATES_EVENT: &str = "check-for-updates";

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

/// Raw bytes, so the UI gets an `ArrayBuffer` rather than a JSON array of numbers.
#[tauri::command]
async fn get_file_content(
    core: Core<'_>,
    owner: String,
    repo: String,
    number: u64,
    path: String,
    side: Side,
) -> CmdResult<Response> {
    let file = core
        .get_file_content(&owner, &repo, number, &path, side)
        .await?;
    Ok(Response::new(file.bytes))
}

/// Writes one side of the file to the temp dir and opens it with the OS default app. The
/// opener is called from Rust, so it needs no JS capability (and none is granted).
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    core: Core<'_>,
    owner: String,
    repo: String,
    number: u64,
    path: String,
    side: Side,
) -> CmdResult<()> {
    let root = std::env::temp_dir().join("fast-reviewer");
    let file = core
        .save_temp_copy(&root, &owner, &repo, number, &path, side)
        .await?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
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
async fn list_review_threads(
    core: Core<'_>,
    owner: String,
    repo: String,
    number: u64,
) -> CmdResult<Vec<ReviewThread>> {
    Ok(core.list_review_threads(&owner, &repo, number).await?)
}

#[tauri::command]
async fn submit_review(
    core: Core<'_>,
    owner: String,
    repo: String,
    number: u64,
    event: ReviewEvent,
    body: String,
    comments: Vec<NewComment>,
) -> CmdResult<SubmittedReview> {
    Ok(core
        .submit_review(&owner, &repo, number, event, &body, &comments)
        .await?)
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

/// Tauri's default menu with "Check for Updates…" under "About" in the app menu,
/// where macOS apps put it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(app_submenu) = menu
        .items()?
        .first()
        .and_then(|item| item.as_submenu().cloned())
    {
        let check = MenuItem::with_id(
            app,
            CHECK_UPDATES_EVENT,
            "Check for Updates…",
            true,
            None::<&str>,
        )?;
        app_submenu.insert(&check, 1)?;
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core = Service::new(Config::from_env()).expect("failed to initialise GitHub client");
    let builder = tauri::Builder::default();
    // Only macOS has an app menu bar; elsewhere a menu would add a bar to the window.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .on_menu_event(|app, event| {
            if event.id() == CHECK_UPDATES_EVENT {
                let _ = app.emit(CHECK_UPDATES_EVENT, ());
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            get_file_content,
            open_file,
            set_file_viewed,
            list_review_threads,
            submit_review,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
