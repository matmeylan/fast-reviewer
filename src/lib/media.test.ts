import { describe, expect, it } from "vitest";
import { formatBytes, imageMime, isImage, isSvg } from "./media";

describe("imageMime", () => {
  it("recognizes image extensions, ignoring case", () => {
    const cases: [string, string | null][] = [
      ["web/assets/logo.png", "image/png"],
      ["photo.JPG", "image/jpeg"],
      ["a/b.jpeg", "image/jpeg"],
      ["anim.gif", "image/gif"],
      ["hero.webp", "image/webp"],
      ["hero.AVIF", "image/avif"],
      ["old.bmp", "image/bmp"],
      ["favicon.ico", "image/x-icon"],
      ["icons/icon.Svg", "image/svg+xml"],
      ["docs/guide.pdf", null],
      ["fonts/Inter.woff2", null],
      ["src/png.ts", null],
      ["png", null],
      [".png", null],
      ["dir.png/README", null],
    ];
    for (const [path, want] of cases) expect(imageMime(path), path).toBe(want);
  });

  it("flags images and SVGs", () => {
    expect(isImage("a.png")).toBe(true);
    expect(isImage("a.pdf")).toBe(false);
    expect(isSvg("icons/a.SVG")).toBe(true);
    expect(isSvg("a.png")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("uses the largest unit that keeps the number readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });
});
