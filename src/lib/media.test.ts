import { describe, expect, it } from "vitest";
import { formatBytes, imageMime, isImage, isSvg, standaloneSvg } from "./media";

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

describe("standaloneSvg", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const repaired = (s: string) => {
    const out = standaloneSvg(bytes(s));
    return out && new TextDecoder().decode(out);
  };

  it("leaves SVGs that are valid XML alone", () => {
    expect(repaired('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect/></svg>')).toBeNull();
    const prolog = '\ufeff<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(repaired(prolog)).toBeNull();
  });

  it("rewrites SVGs that only work inline in HTML as XML", () => {
    const noXmlns = repaired('<svg width="8" height="8"><rect width="8" height="8"/></svg>')!;
    expect(noXmlns).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(noXmlns).toContain('<rect width="8" height="8"');

    const xlink = repaired('<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="#a"/></svg>')!;
    const use = new DOMParser().parseFromString(xlink, "image/svg+xml").querySelector("use")!;
    expect(use.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#a");

    expect(repaired('<svg xmlns="http://www.w3.org/2000/svg"><text>a&nbsp;b</text></svg>')).toContain("a\u00a0b");

    // Every rewrite is itself valid, so it's left alone the second time.
    for (const out of [noXmlns, xlink]) expect(repaired(out)).toBeNull();
  });

  it("gives up on files with no <svg>", () => {
    expect(repaired("not an image")).toBeNull();
    expect(repaired("")).toBeNull();
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
