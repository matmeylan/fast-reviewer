import { describe, expect, it } from "vitest";
import type { PrSummary } from "../lib/types";
import { fuzzyScore, parsePrRef, rankPrs } from "./pickerLogic";

describe("parsePrRef", () => {
  it("parses URLs and short refs", () => {
    expect(parsePrRef("https://github.com/acme/web/pull/482")).toEqual({ owner: "acme", repo: "web", number: 482 });
    expect(parsePrRef(" github.com/a-b/c.d/pull/7/files#diff-1 ")).toEqual({ owner: "a-b", repo: "c.d", number: 7 });
    expect(parsePrRef("acme/web#12")).toEqual({ owner: "acme", repo: "web", number: 12 });
  });

  it("rejects everything else", () => {
    expect(parsePrRef("acme/web")).toBeNull();
    expect(parsePrRef("https://github.com/acme/web/issues/1")).toBeNull();
    expect(parsePrRef("acme/web#0")).toBeNull();
    expect(parsePrRef("")).toBeNull();
  });
});

describe("fuzzyScore", () => {
  it("matches substrings and word-start acronyms", () => {
    expect(fuzzyScore("table", "data table")).toBeGreaterThan(0);
    expect(fuzzyScore("fpo", "Fix pagination off-by-one")).toBeGreaterThan(0);
    expect(fuzzyScore("dattab", "data table")).toBeGreaterThan(0);
    expect(fuzzyScore("table", "data table")).toBeGreaterThan(fuzzyScore("dattab", "data table"));
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("rejects scattered subsequences", () => {
    expect(fuzzyScore("xyz", "data table")).toBe(-1);
    expect(fuzzyScore("monorepo", "acme/api#91 Fix pagination off-by-one in orders endpoint")).toBe(-1);
  });

  it("requires every token", () => {
    expect(fuzzyScore("acme table", "acme/web#1 data table")).toBeGreaterThan(0);
    expect(fuzzyScore("acme chair", "acme/web#1 data table")).toBe(-1);
  });
});

describe("rankPrs", () => {
  const pr = (number: number, reason: PrSummary["reason"], title: string, updatedAt: string): PrSummary => ({
    owner: "o",
    repo: "r",
    number,
    title,
    author: "a",
    url: "",
    isDraft: false,
    updatedAt,
    reason,
  });
  const prs = [
    pr(1, "authored", "Add login", "2026-01-03"),
    pr(2, "reviewRequested", "Fix table", "2026-01-01"),
    pr(3, "reviewRequested", "Add table sorting", "2026-01-02"),
  ];

  it("puts review requests first, newest first", () => {
    expect(rankPrs(prs, "").map((p) => p.number)).toEqual([3, 2, 1]);
  });

  it("filters by fuzzy query", () => {
    expect(rankPrs(prs, "login").map((p) => p.number)).toEqual([1]);
  });
});
