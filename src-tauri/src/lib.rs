//! Thin Tauri command layer over `fast_reviewer_core`.
//! OWNER: github-core agent. Commands (names are the IPC contract, see src/lib/api.ts):
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
