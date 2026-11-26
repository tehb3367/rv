import { expect, test } from 'bun:test';
import { createHighlighterCore } from 'shiki/core';
import { Tokenizer } from '../../src/core/highlight.ts';
import { loadTheme } from '../../src/core/theme.ts';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages, bundledThemes, type BundledLanguage } from 'shiki';

// The 20 most common languages and a snippet that exercises strings, comments and keywords.
const SAMPLES: Record<string, string> = {
  typescript: 'const a: number = 1; // c\nexport function f<T>(x: T): T { return `${x}`; }',
  tsx: 'export const C = () => <div className="x">{`t ${1}`}</div>;',
  javascript: "import x from 'y';\n/* block */ const r = /ab+c/g; class A { #p = 1 }",
  jsx: 'const el = <a href="#">{items.map(i => <b key={i}>{i}</b>)}</a>;',
  python: 'def f(x: int) -> str:\n    """doc"""\n    return f"{x!r}"  # c\n@dec\nclass A: pass',
  go: 'package main\nimport "fmt"\nfunc main() { s := `raw`; fmt.Println(s) // c\n}',
  rust: 'fn main() { let s: &str = "x"; println!("{}", s); } // c\n#[derive(Debug)] struct A;',
  java: 'public class A { @Override public String toString() { return "x"; } } // c',
  c: '#include <stdio.h>\nint main(void) { printf("%d\\n", 1); /* c */ return 0; }',
  cpp: 'template<typename T> T f(T x) { return x; } // c\nauto s = R"(raw)";',
  csharp: 'namespace N { public class A { public string P { get; set; } = $"x{1}"; } }',
  ruby: 'def f(x)\n  "#{x}" # c\nend\nclass A < B; end',
  php: '<?php\nfunction f($x) { return "v: $x"; } // c\n$a = [1, 2];',
  shellscript: '#!/bin/bash\nfor f in *.txt; do echo "$f" # c\ndone',
  json: '{ "a": [1, true, null], "b": { "c": "d" } }',
  yaml: 'key: value # c\nlist:\n  - "a"\n  - 1\nanchor: &x { a: 1 }',
  html: '<!doctype html><html><body class="a"><!-- c --><script>let a = 1;</script></body></html>',
  css: '.a > b:hover { color: #fff; /* c */ margin: 0 auto !important; }',
  markdown: '# Title\n\n*em* **strong** `code`\n\n```ts\nconst a = 1;\n```',
  sql: "SELECT a, COUNT(*) FROM t WHERE b = 'x' -- c\nGROUP BY a;",
};

test('the JavaScript regex engine matches Oniguruma on the 20 most common languages', async () => {
  const langs = Object.keys(SAMPLES).map((l) => bundledLanguages[l as BundledLanguage]);
  const theme = bundledThemes['synthwave-84'];
  // The JS side goes through the runtime Tokenizer, which also warms each grammar up:
  // the very first tokenize call on a fresh JS-engine highlighter can split tokens differently.
  const js = await Tokenizer.create(await loadTheme('synthwave-84'));
  const onig = await createHighlighterCore({ themes: [theme], langs, engine: createOnigurumaEngine(import('shiki/wasm')) });
  const failing: string[] = [];
  for (const [lang, code] of Object.entries(SAMPLES)) {
    const a = (await js.tokenize(code, lang))!.map((l) => l.map((t) => [t[0], t[1]]));
    const b = onig.codeToTokens(code, { lang, theme: 'synthwave-84' }).tokens.map((l) => l.map((t) => [t.content, t.color]));
    if (JSON.stringify(a) !== JSON.stringify(b)) failing.push(lang);
  }
  if (failing.length) console.warn(`grammars differing between engines: ${failing.join(', ')}`);
  expect(failing).toEqual([]);
}, 30000);
