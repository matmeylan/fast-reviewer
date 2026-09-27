//! Error type for the core. Messages are shown to the user verbatim, so keep them actionable.
use std::time::{SystemTime, UNIX_EPOCH};

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// `Clone` so a single in-flight result can be shared between deduplicated callers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Not signed in to GitHub. Set GH_TOKEN, run `gh auth login`, or paste a token.")]
    NotAuthenticated,
    #[error("GitHub token invalid or expired")]
    Unauthorized,
    #[error("Not found on GitHub: {0} (check the name and that your token can access it)")]
    NotFound(String),
    #[error("{}", rate_limit_message(*.reset_at))]
    RateLimited {
        /// Unix epoch seconds at which the limit resets, when known.
        reset_at: Option<u64>,
    },
    #[error("GitHub API error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("GitHub GraphQL error: {0}")]
    GraphQl(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Unexpected response from GitHub: {0}")]
    Decode(String),
    #[error("{0}")]
    Other(String),
}

fn rate_limit_message(reset_at: Option<u64>) -> String {
    let Some(reset) = reset_at else {
        return "GitHub rate limit exceeded; try again shortly".into();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let secs = reset.saturating_sub(now);
    let day = reset % 86_400;
    format!(
        "GitHub rate limit exceeded; resets at {:02}:{:02} UTC (in {} min)",
        day / 3600,
        (day % 3600) / 60,
        secs.div_ceil(60)
    )
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_decode() {
            Error::Decode(e.to_string())
        } else {
            Error::Network(e.to_string())
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Decode(e.to_string())
    }
}

impl From<Error> for String {
    fn from(e: Error) -> Self {
        e.to_string()
    }
}
