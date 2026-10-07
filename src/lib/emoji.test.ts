import { describe, expect, it } from "vitest";
import { closedShortcode, emojiTrigger, loadEmoji } from "./emoji";

describe("emojiTrigger", () => {
  it("finds a shortcode being typed at the start of the text, a line or a word", () => {
    expect(emojiTrigger(":ta", 3)).toEqual({ start: 0, query: "ta" });
    expect(emojiTrigger("nice :Tada", 10)).toEqual({ start: 5, query: "tada" });
    expect(emojiTrigger("ok\n:+1", 6)).toEqual({ start: 3, query: "+1" });
    expect(emojiTrigger("(:smi)", 5)).toEqual({ start: 1, query: "smi" });
    // Only what is before the caret counts.
    expect(emojiTrigger(":tada rest", 3)).toEqual({ start: 0, query: "ta" });
  });

  it("leaves other colons alone", () => {
    expect(emojiTrigger(":D", 2)).toBeNull();
    expect(emojiTrigger("nit: rename", 11)).toBeNull();
    expect(emojiTrigger("at 10:30", 8)).toBeNull();
    expect(emojiTrigger("see https://x", 13)).toBeNull();
    expect(emojiTrigger("a:bc", 4)).toBeNull();
    expect(emojiTrigger(":tada ", 6)).toBeNull();
  });
});

describe("closedShortcode", () => {
  it("finds a shortcode just closed with a colon", () => {
    expect(closedShortcode("lgtm :Tada:", 11)).toEqual({ start: 5, name: "tada" });
    expect(closedShortcode(":+1:", 4)).toEqual({ start: 0, name: "+1" });
    expect(closedShortcode("at 10:30:", 9)).toBeNull();
    expect(closedShortcode("::", 2)).toBeNull();
  });
});

describe("EmojiIndex", () => {
  it("looks up GitHub shortcodes", async () => {
    const index = await loadEmoji();
    expect(index.get("tada")).toBe("🎉");
    expect(index.get("+1")).toBe("👍");
    expect(index.get("thumbsup")).toBe("👍");
    expect(index.get("nope-not-an-emoji")).toBeUndefined();
  });

  it("ranks exact names, then prefixes, then words, tags and substrings", async () => {
    const index = await loadEmoji();
    expect(index.search("tada")[0]).toEqual({ emoji: "🎉", name: "tada" });
    const smi = index.search("smi").map((m) => m.name);
    expect(smi.slice(0, 2)).toEqual(["smile", "smirk"]);
    // "up" is a word of "thumbs_up"... and of many more; prefixes come first.
    expect(index.search("up")[0].name).toBe("up");
    // Tags: "party" isn't a name of 🎉.
    expect(index.search("party").map((m) => m.emoji)).toContain("🎉");
    expect(index.search("rocket", 3)).toHaveLength(1);
    expect(index.search("zzzzqq")).toEqual([]);
  });

  it("returns each emoji once, under its best name", async () => {
    const index = await loadEmoji();
    const thumbs = index.search("thumbs");
    expect(new Set(thumbs.map((m) => m.emoji)).size).toBe(thumbs.length);
    expect(thumbs.map((m) => m.name)).toEqual(expect.arrayContaining(["thumbsup", "thumbsdown"]));
  });
});
