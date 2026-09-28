// File-type icons from IntelliJ IDEA's New UI set (src/assets/file-icons, Apache 2.0).
// Small SVGs are inlined as data URLs by Vite, so rows never wait on a request.

const urls = import.meta.glob<string>("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

export interface IconUrls {
  light: string;
  dark: string;
}

const icons = new Map<string, IconUrls>();
for (const [path, url] of Object.entries(urls)) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".svg".length);
  const base = name.replace(/_dark$/, "");
  const entry = icons.get(base) ?? { light: url, dark: url };
  if (name.endsWith("_dark")) entry.dark = url;
  else entry.light = url;
  icons.set(base, entry);
}

const BY_EXT: Record<string, string> = {
  ts: "typeScript", tsx: "typeScript", mts: "typeScript", cts: "typeScript",
  js: "javaScript", jsx: "javaScript", mjs: "javaScript", cjs: "javaScript",
  css: "css", scss: "css", sass: "css", less: "css", pcss: "css",
  html: "html", htm: "html",
  json: "json", jsonc: "json", json5: "json",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  py: "python", pyi: "python", pyw: "python",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell",
  sql: "sql",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image",
  ico: "image", icns: "image", bmp: "image", avif: "image", tiff: "image",
  txt: "text", log: "text", rst: "text",
  xml: "xml", plist: "xml", xsd: "xml", xsl: "xml",
  ini: "config", cfg: "config", conf: "config", env: "config",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", jar: "archive", "7z": "archive", rar: "archive",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  csv: "csv", tsv: "csv",
  vue: "vue",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  c: "c", h: "h", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "Csharp",
  swift: "swiftLang",
  php: "php",
  graphql: "graphql", gql: "graphql",
  properties: "properties",
  patch: "patch", diff: "patch",
  wasm: "binaryData", bin: "binaryData", exe: "binaryData", dylib: "binaryData", so: "binaryData",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  ".dockerignore": "gitignore",
  ".gitignore": "gitignore",
  ".gitattributes": "gitignore",
  ".npmignore": "gitignore",
  ".editorconfig": "editorConfig",
  ".env": "config",
};

/** IntelliJ icon name for a file path (`anyType` when nothing matches). */
export function fileIconName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith(".env.")) return "config";
  if (name.endsWith(".dockerfile") || name.startsWith("dockerfile.")) return "docker";
  const dot = name.lastIndexOf(".");
  const icon = dot > 0 ? BY_EXT[name.slice(dot + 1)] : undefined;
  return icon ?? "anyType";
}

/** Light and dark URLs of an icon by name, if it ships. */
export function iconUrls(name: string): IconUrls | undefined {
  return icons.get(name);
}

export function fileIcon(path: string): IconUrls {
  return icons.get(fileIconName(path)) ?? icons.get("anyType")!;
}

export function folderIcon(): IconUrls {
  return icons.get("folder")!;
}

/** Every icon name this module can use (tests check that each one ships). */
export const USED_ICONS = new Set([...Object.values(BY_EXT), ...Object.values(BY_NAME), "anyType", "folder"]);
