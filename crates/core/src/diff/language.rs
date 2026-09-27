//! File path -> Shiki language id.

/// Map a file path to a Shiki language id (e.g. "typescript", "tsx", "python", "html", "css").
/// `None` means plain text.
pub fn language_for_path(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if let Some(lang) = by_filename(&lower) {
        return Some(lang);
    }
    if lower.starts_with(".env") || lower.ends_with(".env") {
        return Some("dotenv");
    }
    if lower.starts_with("dockerfile") || lower.starts_with("containerfile") {
        return Some("dockerfile");
    }
    let (_, ext) = lower.rsplit_once('.')?;
    by_extension(ext)
}

fn by_filename(name: &str) -> Option<&'static str> {
    Some(match name {
        "makefile" | "gnumakefile" => "make",
        "cmakelists.txt" => "cmake",
        "gemfile" | "rakefile" | "podfile" | "fastfile" | "brewfile" | "vagrantfile" => "ruby",
        "justfile" => "just",
        "tsconfig.json" | "jsconfig.json" | ".eslintrc" | ".eslintrc.json" | ".babelrc"
        | ".swcrc" | "devcontainer.json" => "jsonc",
        ".prettierrc" => "json",
        ".bashrc" | ".bash_profile" | ".zshrc" | ".zprofile" | ".profile" => "shellscript",
        ".editorconfig" | ".npmrc" | ".gitconfig" => "ini",
        "go.mod" | "go.sum" => "go",
        "cargo.lock" | "pipfile" => "toml",
        _ => return None,
    })
}

fn by_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "json" | "webmanifest" | "har" => "json",
        "jsonc" | "json5" => "jsonc",
        "jsonl" | "ndjson" => "jsonl",
        "html" | "htm" | "xhtml" => "html",
        "css" => "css",
        "scss" => "scss",
        "sass" => "sass",
        "less" => "less",
        "styl" => "stylus",
        "py" | "pyi" | "pyw" => "python",
        "ipynb" => "json",
        "md" | "markdown" => "markdown",
        "mdx" => "mdx",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "groovy" | "gradle" => "groovy",
        "swift" => "swift",
        "m" | "mm" => "objective-c",
        "rb" | "rake" | "gemspec" => "ruby",
        "php" => "php",
        "sh" | "bash" | "zsh" | "ksh" => "shellscript",
        "fish" => "fish",
        "ps1" | "psm1" => "powershell",
        "bat" | "cmd" => "bat",
        "sql" => "sql",
        "xml" | "svg" | "plist" | "xsd" | "xsl" | "csproj" | "fsproj" | "props" => "xml",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hh" | "hxx" | "h++" | "ino" => "cpp",
        "cs" => "csharp",
        "fs" | "fsi" | "fsx" => "fsharp",
        "graphql" | "gql" => "graphql",
        "proto" => "proto",
        "dockerfile" => "dockerfile",
        "mk" | "mak" => "make",
        "cmake" => "cmake",
        "lua" => "lua",
        "dart" => "dart",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "hs" => "haskell",
        "clj" | "cljs" | "cljc" | "edn" => "clojure",
        "ml" | "mli" => "ocaml",
        "r" => "r",
        "jl" => "julia",
        "pl" | "pm" => "perl",
        "zig" => "zig",
        "nim" => "nim",
        "nix" => "nix",
        "tf" | "tfvars" | "hcl" => "hcl",
        "ini" | "cfg" | "conf" | "properties" => "ini",
        "diff" | "patch" => "diff",
        "tex" | "sty" => "latex",
        "prisma" => "prisma",
        "sol" => "solidity",
        "glsl" | "vert" | "frag" => "glsl",
        "wgsl" => "wgsl",
        "hbs" | "handlebars" => "handlebars",
        "erb" => "erb",
        "j2" | "jinja" | "jinja2" => "jinja",
        "twig" => "twig",
        "liquid" => "liquid",
        "env" => "dotenv",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::language_for_path as lang;

    #[test]
    fn common_extensions() {
        let cases = [
            ("src/app.ts", "typescript"),
            ("a.mts", "typescript"),
            ("a.cts", "typescript"),
            ("src/App.tsx", "tsx"),
            ("a.js", "javascript"),
            ("a.mjs", "javascript"),
            ("a.cjs", "javascript"),
            ("a.jsx", "jsx"),
            ("package.json", "json"),
            ("tsconfig.json", "jsonc"),
            ("x.jsonc", "jsonc"),
            ("index.html", "html"),
            ("index.htm", "html"),
            ("styles.css", "css"),
            ("a.scss", "scss"),
            ("a.sass", "sass"),
            ("a.less", "less"),
            ("main.py", "python"),
            ("types.pyi", "python"),
            ("README.md", "markdown"),
            ("doc.mdx", "mdx"),
            ("ci.yml", "yaml"),
            ("ci.yaml", "yaml"),
            ("Cargo.toml", "toml"),
            ("lib.rs", "rust"),
            ("main.go", "go"),
            ("A.java", "java"),
            ("A.kt", "kotlin"),
            ("A.swift", "swift"),
            ("a.rb", "ruby"),
            ("a.php", "php"),
            ("a.sh", "shellscript"),
            ("a.bash", "shellscript"),
            ("a.zsh", "shellscript"),
            ("q.sql", "sql"),
            ("a.xml", "xml"),
            ("icon.svg", "xml"),
            ("C.vue", "vue"),
            ("C.svelte", "svelte"),
            ("a.c", "c"),
            ("a.h", "c"),
            ("a.cpp", "cpp"),
            ("a.hpp", "cpp"),
            ("a.cs", "csharp"),
            ("schema.graphql", "graphql"),
        ];
        for (path, want) in cases {
            assert_eq!(lang(path), Some(want), "{path}");
        }
    }

    #[test]
    fn special_filenames() {
        assert_eq!(lang("Dockerfile"), Some("dockerfile"));
        assert_eq!(lang("docker/Dockerfile.dev"), Some("dockerfile"));
        assert_eq!(lang("api.dockerfile"), Some("dockerfile"));
        assert_eq!(lang("Makefile"), Some("make"));
        assert_eq!(lang("rules.mk"), Some("make"));
        assert_eq!(lang(".env"), Some("dotenv"));
        assert_eq!(lang("config/.env.local"), Some("dotenv"));
        assert_eq!(lang("Gemfile"), Some("ruby"));
        assert_eq!(lang(".gitignore"), None);
        assert_eq!(lang("LICENSE"), None);
        assert_eq!(lang("notes.txt"), None);
    }

    #[test]
    fn case_insensitive_and_windows_paths() {
        assert_eq!(lang("SRC/APP.TS"), Some("typescript"));
        assert_eq!(lang("Main.PY"), Some("python"));
        assert_eq!(lang("dir\\file.Rs"), Some("rust"));
        assert_eq!(lang("MAKEFILE"), Some("make"));
    }

    #[test]
    fn dotted_directories_do_not_leak() {
        assert_eq!(lang("some.dir/README"), None);
        assert_eq!(lang(".github/workflows/ci.yml"), Some("yaml"));
    }
}
