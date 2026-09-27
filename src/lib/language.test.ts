import { describe, expect, it } from "vitest";
import { bundledLanguages } from "shiki/langs";
import { languageForPath, languagesOf } from "./language";

describe("languageForPath (mirror of crates/core/src/diff/language.rs)", () => {
  it("maps common extensions and filenames", () => {
    const cases: [string, string | null][] = [
      ["src/app.ts", "typescript"],
      ["src/App.tsx", "tsx"],
      ["a.mjs", "javascript"],
      ["package.json", "json"],
      ["tsconfig.json", "jsonc"],
      ["index.htm", "html"],
      ["styles.css", "css"],
      ["types.pyi", "python"],
      ["README.md", "markdown"],
      ["Cargo.toml", "toml"],
      ["lib.rs", "rust"],
      ["icon.svg", "xml"],
      ["Makefile", "make"],
      ["docker/Dockerfile.dev", "dockerfile"],
      [".env.local", "dotenv"],
      ["web/assets/logo.png", null],
      ["LICENSE", null],
    ];
    for (const [path, want] of cases) expect(languageForPath(path), path).toBe(want);
  });

  it("only produces ids Shiki can load", () => {
    const paths = ["a.ts", "a.tsx", "a.py", "a.rs", "a.go", "a.vue", "a.hcl", "a.m", "a.sh", "a.j2", "a.env", "Justfile", "a.wgsl"];
    for (const p of paths) expect(languageForPath(p)! in bundledLanguages, p).toBe(true);
  });

  it("lists distinct languages, most frequent first", () => {
    expect(languagesOf(["a.ts", "b.ts", "c.py", "d.png", "e.ts", "f.py", "g.css"])).toEqual(["typescript", "python", "css"]);
  });
});
