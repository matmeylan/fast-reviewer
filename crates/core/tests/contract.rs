//! Serde output of `model.rs` must match `src/lib/contract.fixture.json`, which
//! `src/lib/contract.test.ts` checks against the TypeScript types.
use fast_reviewer_core::model::*;
use serde::Serialize;
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/lib/contract.fixture.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read fixture"))
        .expect("parse fixture")
}

fn to_json<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap()
}

#[test]
fn structs_serialize_like_fixture() {
    let f = fixture();
    let pr_summary = PrSummary {
        owner: "octo".into(),
        repo: "app".into(),
        number: 42,
        title: "Speed up the thing".into(),
        author: "hubot".into(),
        url: "https://github.com/octo/app/pull/42".into(),
        is_draft: false,
        updated_at: "2026-01-02T03:04:05Z".into(),
        reason: InboxReason::ReviewRequested,
    };
    let pr_detail = PrDetail {
        id: "PR_kwDOAbc".into(),
        owner: "octo".into(),
        repo: "app".into(),
        number: 42,
        title: "Speed up the thing".into(),
        author: "hubot".into(),
        url: "https://github.com/octo/app/pull/42".into(),
        base_ref: "main".into(),
        head_ref: "fast".into(),
        base_sha: "aaaaaaa".into(),
        head_sha: "bbbbbbb".into(),
        files: vec![ChangedFile {
            path: "src/new.ts".into(),
            previous_path: Some("src/old.ts".into()),
            status: FileStatus::Renamed,
            additions: 3,
            deletions: 1,
            viewed: ViewedState::Viewed,
        }],
        total_files: 3200,
        files_truncated: true,
    };
    let line = |kind, old_no, new_no, text: &str, segments| DiffLine {
        kind,
        old_no,
        new_no,
        text: text.into(),
        segments,
    };
    let file_diff = FileDiff {
        path: "src/new.ts".into(),
        old_path: Some("src/old.ts".into()),
        language: Some("typescript".into()),
        binary: false,
        too_large: false,
        hunks: vec![Hunk {
            old_start: 1,
            old_lines: 2,
            new_start: 1,
            new_lines: 2,
            lines: vec![
                line(LineKind::Context, Some(1), Some(1), "const a = 1;", None),
                line(
                    LineKind::Del,
                    Some(2),
                    None,
                    "const b = 2;",
                    Some(vec![(10, 11)]),
                ),
                line(
                    LineKind::Add,
                    None,
                    Some(2),
                    "const b = 3;",
                    Some(vec![(10, 11)]),
                ),
            ],
        }],
        old_text: Some("const a = 1;\nconst b = 2;\n".into()),
        new_text: Some("const a = 1;\nconst b = 3;\n".into()),
    };

    assert_eq!(
        to_json(&AuthStatus {
            authenticated: true,
            login: Some("octocat".into()),
            source: Some(AuthSource::GhCli),
        }),
        f["authStatus"]
    );
    assert_eq!(
        to_json(&RepoSummary {
            owner: "octo".into(),
            name: "app".into(),
            description: None,
            private: true,
            updated_at: "2026-01-02T03:04:05Z".into(),
        }),
        f["repoSummary"]
    );
    assert_eq!(to_json(&pr_summary), f["prSummary"]);
    assert_eq!(to_json(&pr_detail), f["prDetail"]);
    assert_eq!(to_json(&file_diff), f["fileDiff"]);

    // And the fixture deserializes back into the same values.
    assert_eq!(
        serde_json::from_value::<FileDiff>(f["fileDiff"].clone()).unwrap(),
        file_diff
    );
    assert_eq!(
        serde_json::from_value::<PrDetail>(f["prDetail"].clone()).unwrap(),
        pr_detail
    );
}

#[test]
fn enums_serialize_like_fixture() {
    let e = &fixture()["enums"];
    use AuthSource as A;
    use FileStatus as F;
    use InboxReason as I;
    use LineKind as L;
    use ViewedState as V;
    assert_eq!(to_json(&[A::Env, A::GhCli, A::Keychain]), e["authSource"]);
    assert_eq!(
        to_json(&[I::ReviewRequested, I::Authored, I::Other]),
        e["inboxReason"]
    );
    assert_eq!(
        to_json(&[
            F::Added,
            F::Removed,
            F::Modified,
            F::Renamed,
            F::Copied,
            F::Changed
        ]),
        e["fileStatus"]
    );
    assert_eq!(
        to_json(&[V::Viewed, V::Unviewed, V::Dismissed]),
        e["viewedState"]
    );
    assert_eq!(to_json(&[L::Context, L::Add, L::Del]), e["lineKind"]);
    assert_eq!(to_json(&()), json!(null), "set_file_viewed returns null");
}
