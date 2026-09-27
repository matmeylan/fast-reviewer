//! Caches: an in-memory LRU of computed diffs and an on-disk store of file contents.
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lru::LruCache;
use sha2::{Digest, Sha256};

use crate::model::FileDiff;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DiffKey {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub path: String,
    pub base_sha: String,
    pub head_sha: String,
}

pub struct DiffCache {
    lru: Mutex<LruCache<DiffKey, Arc<FileDiff>>>,
}

impl DiffCache {
    pub fn new(capacity: usize) -> Self {
        let cap = NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::MIN);
        Self {
            lru: Mutex::new(LruCache::new(cap)),
        }
    }

    pub fn get(&self, key: &DiffKey) -> Option<Arc<FileDiff>> {
        self.lru
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
    }

    pub fn put(&self, key: DiffKey, diff: Arc<FileDiff>) {
        self.lru
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put(key, diff);
    }

    pub fn len(&self) -> usize {
        self.lru.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// File contents keyed by (repo, commit sha, path). Content at a commit is immutable,
/// so entries never need invalidation. All I/O errors are treated as cache misses.
pub struct BlobCache {
    dir: Option<PathBuf>,
}

/// A cached lookup: `Some(None)` means "known absent at that commit".
pub type Cached = Option<Option<Vec<u8>>>;

impl BlobCache {
    /// `dir = None` disables the disk cache.
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir }
    }

    /// `<OS cache dir>/fast-reviewer/blobs`
    pub fn default_dir() -> Option<PathBuf> {
        dirs::cache_dir().map(|d| d.join("fast-reviewer").join("blobs"))
    }

    fn entry(&self, repo: &str, sha: &str, path: &str) -> Option<PathBuf> {
        let dir = self.dir.as_ref()?;
        // Only full SHAs are immutable; a branch name would go stale.
        if sha.len() < 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut h = Sha256::new();
        for part in [repo, sha, path] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        let hex = hex::encode(h.finalize());
        Some(dir.join(&hex[..2]).join(&hex[2..]))
    }

    pub async fn get(&self, repo: &str, sha: &str, path: &str) -> Cached {
        let file = self.entry(repo, sha, path)?;
        match tokio::fs::read(&file).await {
            Ok(bytes) => Some(Some(bytes)),
            Err(_) => tokio::fs::metadata(absent_marker(&file))
                .await
                .ok()
                .map(|_| None),
        }
    }

    /// Best effort: write to a temp file and rename so readers never see partial content.
    pub async fn put(&self, repo: &str, sha: &str, path: &str, content: Option<&[u8]>) {
        let Some(file) = self.entry(repo, sha, path) else {
            return;
        };
        let Some(parent) = file.parent() else { return };
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return;
        }
        let target = match content {
            Some(_) => file.clone(),
            None => absent_marker(&file),
        };
        let tmp = file.with_extension(format!("tmp{}", std::process::id()));
        if tokio::fs::write(&tmp, content.unwrap_or_default())
            .await
            .is_ok()
            && tokio::fs::rename(&tmp, &target).await.is_err()
        {
            let _ = tokio::fs::remove_file(&tmp).await;
        }
    }
}

fn absent_marker(file: &Path) -> PathBuf {
    file.with_extension("absent")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[tokio::test]
    async fn blob_roundtrip_and_absent() {
        let dir = tempfile::tempdir().unwrap();
        let c = BlobCache::new(Some(dir.path().to_path_buf()));
        assert_eq!(c.get("o/r", SHA, "a.ts").await, None);
        c.put("o/r", SHA, "a.ts", Some(b"hello")).await;
        assert_eq!(
            c.get("o/r", SHA, "a.ts").await,
            Some(Some(b"hello".to_vec()))
        );
        c.put("o/r", SHA, "gone.ts", None).await;
        assert_eq!(c.get("o/r", SHA, "gone.ts").await, Some(None));
        // Other repo, same sha/path: separate entry.
        assert_eq!(c.get("o/other", SHA, "a.ts").await, None);
    }

    #[tokio::test]
    async fn refuses_non_sha_refs() {
        let dir = tempfile::tempdir().unwrap();
        let c = BlobCache::new(Some(dir.path().to_path_buf()));
        c.put("o/r", "main", "a.ts", Some(b"x")).await;
        assert_eq!(c.get("o/r", "main", "a.ts").await, None);
    }

    #[test]
    fn lru_evicts() {
        let c = DiffCache::new(1);
        let key = |p: &str| DiffKey {
            owner: "o".into(),
            repo: "r".into(),
            number: 1,
            path: p.into(),
            base_sha: "b".into(),
            head_sha: "h".into(),
        };
        let d = Arc::new(FileDiff {
            path: "a".into(),
            old_path: None,
            language: None,
            binary: false,
            too_large: false,
            hunks: vec![],
            old_text: None,
            new_text: None,
        });
        c.put(key("a"), d.clone());
        c.put(key("b"), d);
        assert!(c.get(&key("a")).is_none());
        assert!(c.get(&key("b")).is_some());
    }
}
