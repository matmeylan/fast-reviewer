// The Rust side (crates/core/tests/contract.rs) asserts its serde output equals
// this fixture; here we assert the fixture has exactly the shape of types.ts.
import { describe, expect, it } from "vitest";
import fixture from "./contract.fixture.json";
import type {
  AuthSource,
  AuthStatus,
  ChangedFile,
  DiffLine,
  FileDiff,
  FileStatus,
  Hunk,
  LineKind,
  PrDetail,
  PrSummary,
  RepoSummary,
  ViewedState,
} from "./types";

// `Record<keyof T, true>` fails to compile if a key is missing or unknown.
type Keys<T> = Record<keyof T, true>;
const keys = <T>(k: Keys<T>) => Object.keys(k).sort();

const authStatusKeys = keys<AuthStatus>({ authenticated: true, login: true, source: true });
const repoKeys = keys<RepoSummary>({ owner: true, name: true, description: true, private: true, updatedAt: true });
const prSummaryKeys = keys<PrSummary>({
  owner: true, repo: true, number: true, title: true, author: true, url: true,
  isDraft: true, updatedAt: true, reason: true,
});
const prDetailKeys = keys<PrDetail>({
  id: true, owner: true, repo: true, number: true, title: true, author: true, url: true,
  baseRef: true, headRef: true, baseSha: true, headSha: true, files: true,
  totalFiles: true, filesTruncated: true,
});
const changedFileKeys = keys<ChangedFile>({
  path: true, previousPath: true, status: true, additions: true, deletions: true, viewed: true,
});
const fileDiffKeys = keys<FileDiff>({
  path: true, oldPath: true, language: true, binary: true, tooLarge: true, hunks: true,
  oldText: true, newText: true,
});
const hunkKeys = keys<Hunk>({ oldStart: true, oldLines: true, newStart: true, newLines: true, lines: true });
const lineKeys = keys<DiffLine>({ kind: true, oldNo: true, newNo: true, text: true, segments: true });

// Exhaustive enum lists: adding a union member without listing it fails typecheck.
const all = <T extends string>() => <A extends readonly T[]>(a: A & ([T] extends [A[number]] ? unknown : never)) => [...a];
const enums = {
  authSource: all<AuthSource>()(["env", "ghCli", "keychain"] as const),
  inboxReason: all<PrSummary["reason"]>()(["reviewRequested", "authored", "other"] as const),
  fileStatus: all<FileStatus>()(["added", "removed", "modified", "renamed", "copied", "changed"] as const),
  viewedState: all<ViewedState>()(["VIEWED", "UNVIEWED", "DISMISSED"] as const),
  lineKind: all<LineKind>()(["context", "add", "del"] as const),
};

const sorted = (o: object) => Object.keys(o).sort();

describe("IPC contract fixture", () => {
  it("struct field names match types.ts", () => {
    expect(sorted(fixture.authStatus)).toEqual(authStatusKeys);
    expect(sorted(fixture.repoSummary)).toEqual(repoKeys);
    expect(sorted(fixture.prSummary)).toEqual(prSummaryKeys);
    expect(sorted(fixture.prDetail)).toEqual(prDetailKeys);
    expect(sorted(fixture.prDetail.files[0])).toEqual(changedFileKeys);
    expect(sorted(fixture.fileDiff)).toEqual(fileDiffKeys);
    expect(sorted(fixture.fileDiff.hunks[0])).toEqual(hunkKeys);
    for (const l of fixture.fileDiff.hunks[0].lines) expect(sorted(l)).toEqual(lineKeys);
  });

  it("enum values match types.ts", () => {
    expect(fixture.enums).toEqual(enums);
  });

  it("prDetail file counts have the right types", () => {
    const d = fixture.prDetail as unknown as PrDetail;
    expect(typeof d.totalFiles).toBe("number");
    expect(typeof d.filesTruncated).toBe("boolean");
    expect(d.totalFiles).toBeGreaterThanOrEqual(d.files.length);
  });

  it("segments are [start, end) UTF-16 tuples into text", () => {
    const del = fixture.fileDiff.hunks[0].lines[1] as unknown as DiffLine;
    const [s, e] = del.segments![0];
    expect(del.text.slice(s, e)).toBe("2");
  });
});
