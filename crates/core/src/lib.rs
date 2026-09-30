//! Fast Reviewer core: GitHub access, diffing and caching. No Tauri dependency.
pub mod auth;
pub mod cache;
pub mod diff;
pub mod error;
pub mod github;
pub mod model;
pub mod service;
pub mod temp_copy;

pub use error::{Error, Result};
pub use service::{Config, Service};
