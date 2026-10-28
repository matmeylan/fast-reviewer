// Files the diff pane shows as images instead of text or "Binary file not shown".

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const extension = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** MIME type of an image path (by extension, case-insensitive), or null if it isn't one. */
export function imageMime(path: string): string | null {
  return IMAGE_MIME[extension(path)] ?? null;
}

export const isImage = (path: string): boolean => imageMime(path) !== null;

/** SVGs are text too, so they also have a source diff. */
export const isSvg = (path: string): boolean => extension(path) === "svg";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * SVG bytes an <img> can show, or null if `bytes` already work as they are (or hold no <svg>).
 * An <img> reads SVG as strict XML, but many SVGs in the wild only work inline in HTML: no
 * `xmlns`, an undeclared `xlink:` prefix, HTML entities like `&nbsp;`. Those are re-read with the
 * lenient HTML parser and written back as XML. Neither parser runs scripts or loads anything.
 */
export function standaloneSvg(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const text = new TextDecoder().decode(bytes);
  const xml = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = xml.documentElement;
  const valid =
    root.namespaceURI === SVG_NS && root.localName === "svg" && xml.getElementsByTagName("parsererror").length === 0;
  if (valid) return null;
  const svg = new DOMParser().parseFromString(text, "text/html").querySelector("svg");
  return svg ? new TextEncoder().encode(new XMLSerializer().serializeToString(svg)) : null;
}

/** Human file size: "512 B", "1.5 KB", "12 MB" (1 KB = 1024 B). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? Number(v.toFixed(1)) : Math.round(v)} ${units[u]}`;
}
