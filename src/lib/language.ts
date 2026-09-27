// File path -> Shiki language id, mirroring crates/core/src/diff/language.rs.
// Only used as a hint to warm the highlighter when a PR opens (before any diff
// arrives); the authoritative language is `FileDiff.language` from Rust.

const BY_FILENAME: Record<string, string> = {
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  fastfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  justfile: "just",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  ".eslintrc": "jsonc",
  ".eslintrc.json": "jsonc",
  ".babelrc": "jsonc",
  ".swcrc": "jsonc",
  "devcontainer.json": "jsonc",
  ".prettierrc": "json",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".gitconfig": "ini",
  "go.mod": "go",
  "go.sum": "go",
  "cargo.lock": "toml",
  pipfile: "toml",
};

const EXT_GROUPS: [string, string][] = [
  ["ts mts cts", "typescript"],
  ["tsx", "tsx"],
  ["js mjs cjs", "javascript"],
  ["jsx", "jsx"],
  ["json webmanifest har ipynb", "json"],
  ["jsonc json5", "jsonc"],
  ["jsonl ndjson", "jsonl"],
  ["html htm xhtml", "html"],
  ["css", "css"],
  ["scss", "scss"],
  ["sass", "sass"],
  ["less", "less"],
  ["styl", "stylus"],
  ["py pyi pyw", "python"],
  ["md markdown", "markdown"],
  ["mdx", "mdx"],
  ["yaml yml", "yaml"],
  ["toml", "toml"],
  ["rs", "rust"],
  ["go", "go"],
  ["java", "java"],
  ["kt kts", "kotlin"],
  ["scala sc", "scala"],
  ["groovy gradle", "groovy"],
  ["swift", "swift"],
  ["m mm", "objective-c"],
  ["rb rake gemspec", "ruby"],
  ["php", "php"],
  ["sh bash zsh ksh", "shellscript"],
  ["fish", "fish"],
  ["ps1 psm1", "powershell"],
  ["bat cmd", "bat"],
  ["sql", "sql"],
  ["xml svg plist xsd xsl csproj fsproj props", "xml"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["astro", "astro"],
  ["c h", "c"],
  ["cpp cc cxx c++ hpp hh hxx h++ ino", "cpp"],
  ["cs", "csharp"],
  ["fs fsi fsx", "fsharp"],
  ["graphql gql", "graphql"],
  ["proto", "proto"],
  ["dockerfile", "dockerfile"],
  ["mk mak", "make"],
  ["cmake", "cmake"],
  ["lua", "lua"],
  ["dart", "dart"],
  ["ex exs", "elixir"],
  ["erl hrl", "erlang"],
  ["hs", "haskell"],
  ["clj cljs cljc edn", "clojure"],
  ["ml mli", "ocaml"],
  ["r", "r"],
  ["jl", "julia"],
  ["pl pm", "perl"],
  ["zig", "zig"],
  ["nim", "nim"],
  ["nix", "nix"],
  ["tf tfvars hcl", "hcl"],
  ["ini cfg conf properties", "ini"],
  ["diff patch", "diff"],
  ["tex sty", "latex"],
  ["prisma", "prisma"],
  ["sol", "solidity"],
  ["glsl vert frag", "glsl"],
  ["wgsl", "wgsl"],
  ["hbs handlebars", "handlebars"],
  ["erb", "erb"],
  ["j2 jinja jinja2", "jinja"],
  ["twig", "twig"],
  ["liquid", "liquid"],
  ["env", "dotenv"],
];

const BY_EXT = new Map<string, string>(EXT_GROUPS.flatMap(([exts, id]) => exts.split(" ").map((e) => [e, id] as [string, string])));

/** Shiki language id for a path, or null for plain text. */
export function languageForPath(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  const byName = BY_FILENAME[name];
  if (byName) return byName;
  if (name.startsWith(".env") || name.endsWith(".env")) return "dotenv";
  if (name.startsWith("dockerfile") || name.startsWith("containerfile")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : BY_EXT.get(name.slice(dot + 1)) ?? null;
}

/** Distinct languages of `paths`, most frequent first. */
export function languagesOf(paths: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const l = languageForPath(p);
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}
