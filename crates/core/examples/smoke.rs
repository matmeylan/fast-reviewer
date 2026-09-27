//! Read-only smoke test against the real GitHub API.
//! Usage: GH_TOKEN=... cargo run -p fast_reviewer_core --example smoke -- <owner> <repo> <number>
use std::time::Instant;

use fast_reviewer_core::{Config, Service};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [owner, repo, number] = args.as_slice() else {
        eprintln!("usage: smoke <owner> <repo> <number>");
        std::process::exit(2);
    };
    let number: u64 = number.parse()?;
    // Temp cache dir so repeated runs measure the network path.
    let cache = std::env::temp_dir().join(format!("fast-reviewer-smoke-{}", std::process::id()));
    let svc = Service::new(Config {
        cache_dir: Some(cache.clone()),
        ..Config::from_env()
    })?;

    let auth = svc.auth_status().await?;
    println!(
        "auth: {:?} as {}",
        auth.source,
        auth.login.as_deref().unwrap_or("-")
    );

    let t = Instant::now();
    let pr = svc.get_pr(owner, repo, number).await?;
    println!(
        "{}#{} {:?} by {} ({} -> {}), {} files in {:?}",
        repo,
        pr.number,
        pr.title,
        pr.author,
        pr.head_ref,
        pr.base_ref,
        pr.files.len(),
        t.elapsed()
    );
    for f in &pr.files {
        let from = f
            .previous_path
            .as_deref()
            .map(|p| format!(" (from {p})"))
            .unwrap_or_default();
        println!(
            "  {:?} +{} -{} {:?} {}{}",
            f.status, f.additions, f.deletions, f.viewed, f.path, from
        );
    }

    if let Some(f) = pr.files.first() {
        let t = Instant::now();
        let d = svc.get_file_diff(owner, repo, number, &f.path).await?;
        let cold = t.elapsed();
        let t = Instant::now();
        svc.get_file_diff(owner, repo, number, &f.path).await?;
        let warm = t.elapsed();
        let (adds, dels) = d
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .fold((0, 0), |(a, r), l| match l.kind {
                fast_reviewer_core::model::LineKind::Add => (a + 1, r),
                fast_reviewer_core::model::LineKind::Del => (a, r + 1),
                _ => (a, r),
            });
        println!(
            "first file {}: lang={:?} binary={} tooLarge={} hunks={} +{} -{} (GitHub says +{} -{}); cold {:?}, cached {:?}",
            d.path, d.language, d.binary, d.too_large, d.hunks.len(), adds, dels, f.additions, f.deletions, cold, warm
        );
    }
    let _ = std::fs::remove_dir_all(cache);
    Ok(())
}
