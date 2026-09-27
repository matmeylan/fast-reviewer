//! Token sources: environment, the `gh` CLI, and the OS keychain.
//! Every source degrades to `None` on failure; nothing here panics or blocks the async runtime.
use std::time::Duration;

use crate::model::AuthSource;

pub const KEYCHAIN_SERVICE: &str = "fast-reviewer";
pub const KEYCHAIN_ACCOUNT: &str = "github-token";

/// Which token sources to consult. Tests disable the ones that touch the host.
#[derive(Debug, Clone, Copy)]
pub struct AuthConfig {
    pub env: bool,
    pub gh_cli: bool,
    pub keychain: bool,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            env: true,
            gh_cli: true,
            keychain: true,
        }
    }
}

impl AuthConfig {
    pub fn none() -> Self {
        Self {
            env: false,
            gh_cli: false,
            keychain: false,
        }
    }
}

/// Resolution order used by `auth_status`.
pub const SOURCE_ORDER: [AuthSource; 3] =
    [AuthSource::Env, AuthSource::GhCli, AuthSource::Keychain];

/// Read a token from one source, if enabled and present.
pub async fn read_token(
    cfg: &AuthConfig,
    source: AuthSource,
    gh_host: Option<&str>,
) -> Option<String> {
    match source {
        AuthSource::Env if cfg.env => env_token(),
        AuthSource::GhCli if cfg.gh_cli => gh_cli_token(gh_host).await,
        AuthSource::Keychain if cfg.keychain => keychain_get().await,
        _ => None,
    }
}

pub fn env_token() -> Option<String> {
    ["GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|t| t.trim().to_owned())
        .find(|t| !t.is_empty())
}

/// macOS GUI apps get a minimal PATH, so also probe the usual install locations.
const GH_CANDIDATES: [&str; 4] = [
    "gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
];

pub async fn gh_cli_token(host: Option<&str>) -> Option<String> {
    for bin in GH_CANDIDATES {
        let mut cmd = tokio::process::Command::new(bin);
        cmd.args(["auth", "token"]);
        if let Some(h) = host {
            cmd.args(["--hostname", h]);
        }
        cmd.env("GH_PROMPT_DISABLED", "1")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let out = match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
            Ok(Ok(out)) => out,
            // Binary missing at this location: try the next one.
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
            // gh exists but failed or hung; other locations would behave the same.
            _ => return None,
        };
        if !out.status.success() {
            return None;
        }
        let token = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        return (!token.is_empty()).then_some(token);
    }
    None
}

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// Keychain calls are synchronous (and may show an OS prompt), so run them off the runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

pub async fn keychain_get() -> Option<String> {
    // A missing Secret Service daemon on Linux can stall on D-Bus activation; don't wait forever.
    let read = blocking(|| entry().and_then(|e| e.get_password()).ok());
    tokio::time::timeout(Duration::from_secs(10), read)
        .await
        .ok()
        .flatten()
        .flatten()
        .filter(|t| !t.trim().is_empty())
}

pub async fn keychain_set(token: String) -> Result<(), String> {
    blocking(move || {
        entry()
            .and_then(|e| e.set_password(&token))
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|| Err("keychain task failed".into()))
    .map_err(|e| format!("Could not save token to the keychain: {e}"))
}

pub async fn keychain_delete() -> Result<(), String> {
    let res = blocking(|| match entry().and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .unwrap_or_else(|| Err("keychain task failed".into()));
    res.map_err(|e| format!("Could not remove token from the keychain: {e}"))
}
