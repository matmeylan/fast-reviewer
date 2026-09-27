// Small code samples used to warm Shiki grammars. TextMate rules (and their
// regexes) compile lazily on first use, so tokenizing a sample that touches the
// common constructs of a language makes the first real file much cheaper.
// Samples need not be meaningful; they only have to exercise many rules.

const JS = `import { a, type B } from "./b";
import * as c from 'c';
// line comment
/** doc comment @param x value */
export interface Props extends Base<string> { kind?: "a" | "b"; n: number[]; f(x: T): void }
export type U = Readonly<Record<string, unknown>>;
enum E { A = 1, B }
export default async function f<T>(x: T, ...rest: any[]): Promise<void> {
  const s = \`t \${x} \${rest.length > 0 ? 1.5e3 : 0x1f}\`, re = /a+[b-c]\\d/gi;
  let o = { a, b: true, c: null, d: undefined, ...rest, [k]: () => new Map() };
  for (const [k, v] of Object.entries(o)) if (k in o && !v) continue; else break;
  try { await g?.(x!) as number; } catch (e) { throw new Error(String(e)); } finally {}
  switch (x) { case 1: return; default: }
  class C extends D implements I { private static readonly y = 1; #z = 2; constructor(public p: string) { super(); } get v() { return this.#z; } }
}
`;

const JSX = `${JS}
export const App = (props: P) => (
  <div className={\`x \${props.c}\`} onClick={() => go(1)} data-id="a" {...props}>
    {props.items.map((i) => <Item key={i.id} {...i} />)}
    <>text &amp; more</>
  </div>
);
`;

const SAMPLES: Record<string, string> = {
  typescript: JS,
  javascript: JS,
  tsx: JSX,
  jsx: JSX,
  python: `from __future__ import annotations
import os, typing as t
# comment
@decorator(arg=1)
class A(Base, metaclass=M):
    """Docstring."""
    x: int = 0
    async def f(self, a: list[str], *args, **kw) -> dict[str, t.Any]:
        s = f"v={a!r:>10} {kw['k']}" + r"\\d" + b"b" + 'q'
        if a and not None or True: return {k: v for k, v in kw.items() if v is not None}
        elif (n := len(a)) > 1_000: raise ValueError("x") from None
        with open(os.path.join("a", "b")) as fh: yield await g(lambda y: y ** 2)
        try: pass
        except (KeyError, IndexError) as e: print(e, end="")
        finally: del a[0:2]
`,
  rust: `use std::{collections::HashMap, sync::Arc};
/// Doc comment
#[derive(Debug, Clone)]
pub struct S<'a, T: Clone> { pub name: &'a str, v: Vec<T> }
impl<T> Trait for S<'_, T> where T: Send + 'static {
    async fn f(&mut self, x: Option<u64>) -> Result<(), Box<dyn Error>> {
        let s = format!("{} {x:?}", r#"raw"#, 'c', b'b', 1_000u32, 2.5f64);
        match x { Some(n) if n > 0 => {}, None | _ => return Err("e".into()) }
        for (k, v) in HashMap::<String, i32>::new().iter() { println!("{k}{v}"); }
        let c = |a: &i32| -> bool { *a == 1 }; unsafe { ptr::null::<u8>() }; Ok(())
    }
}
macro_rules! m { ($e:expr) => { $e }; }
`,
  go: `package main
import ("fmt"; "strings")
// comment
type S struct { Name string \`json:"name"\`; v []int }
func (s *S) F(ctx context.Context, xs ...int) (map[string]any, error) {
	ch := make(chan int, 1); defer close(ch)
	go func() { ch <- 1 }()
	for i, x := range xs { if x > 0 && i != 0 { continue } }
	switch v := any(s).(type) { case *S: fmt.Printf("%v %s\\n", v, strings.ToUpper('a' + "b")) }
	return nil, fmt.Errorf("e: %w", err)
}
`,
  css: `@import url("a.css");
@media (max-width: 600px) { .a > .b:hover::after, #id[data-x="y"] { color: #fff !important; margin: 0 auto calc(1px + 2em); } }
:root { --c: rgb(0 0 0 / 50%); } /* comment */
@keyframes k { from { opacity: 0 } to { transform: translateX(10px) rotate(45deg) } }
`,
  html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>T</title>
<link rel="stylesheet" href="a.css"><style>.a { color: red; }</style>
<script type="module">import a from "./a.js"; const x = \`\${a}\`; if (x) console.log(1);</script></head>
<body class="b" data-x='y'><!-- comment --><a href="#">l &amp; t</a><input disabled /></body></html>
`,
  markdown: `# Title
Some *emphasis*, **bold**, \`code\` and a [link](https://example.com).
- item
  1. nested
> quote
\`\`\`ts
const x = 1;
\`\`\`
| a | b |
|---|---|
`,
  json: `{ "a": [1, 2.5, -3e2, true, false, null], "b": { "c": "d\\n" } }\n`,
  yaml: `# comment
key: value
list:
  - a: 1
    b: "s"
anchors: &x { c: true }
ref: *x
multi: |
  text
`,
};
SAMPLES.scss = SAMPLES.css;
SAMPLES.less = SAMPLES.css;
SAMPLES.jsonc = SAMPLES.json;

/** Generic C-like fallback for languages without a specific sample. */
const GENERIC = `// comment
/* block */ # hash comment
import a.b; package p;
class C { public static int f(String s, int n) { if (n > 0 && s != null) return 1; else return -2.5; } }
x = "str" + 'c' + 0x1F; y = [1, 2]; z = {a: true, b: null};
`;

export function warmSample(lang: string): string {
  return SAMPLES[lang] ?? GENERIC;
}
