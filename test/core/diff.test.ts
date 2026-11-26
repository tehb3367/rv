import { describe, expect, test } from 'bun:test';
import { groupFiles, hunkIdFor, hunkStats, parseDiff, unquotePath } from '../../src/core/diff.ts';

const modified = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 import x from 'x';
-const a = 1;
+const a = 2;
+const b = 3;
 export {};
@@ -10,2 +11,2 @@ function f() {
-  return 1;
+  return 2;
 }
`;

describe('parseDiff', () => {
  test('modified file with several hunks, hunk at line 1', () => {
    const hunks = parseDiff(modified);
    expect(hunks).toHaveLength(2);
    const [h1, h2] = hunks;
    expect(h1!.path).toBe('src/a.ts');
    expect(h1!.fileStatus).toBe('modified');
    expect(h1!.oldStart).toBe(1);
    expect(h1!.newStart).toBe(1);
    expect(h1!.header).toBe('@@ -1,3 +1,4 @@');
    expect(h1!.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'add', 'ctx']);
    expect(h1!.lines[0]).toEqual({ kind: 'ctx', oldNo: 1, newNo: 1, text: "import x from 'x';" });
    expect(h1!.lines[2]).toEqual({ kind: 'add', newNo: 2, text: 'const a = 2;' });
    expect(h1!.lines[4]).toEqual({ kind: 'ctx', oldNo: 3, newNo: 4, text: 'export {};' });
    expect(h2!.header).toBe('@@ -10,2 +11,2 @@ function f() {');
    expect(h2!.lines[0]).toEqual({ kind: 'del', oldNo: 10, text: '  return 1;' });
    expect(hunkStats(h1!)).toEqual({ added: 2, removed: 1 });
    expect(h1!.id).toMatch(/^[0-9a-f]{10}$/);
  });

  test('added file', () => {
    const d = `diff --git a/new.py b/new.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+print("hi")
+print("there")
`;
    const [h] = parseDiff(d);
    expect(h!.fileStatus).toBe('added');
    expect(h!.path).toBe('new.py');
    expect(h!.oldPath).toBeUndefined();
    expect(h!.lines).toHaveLength(2);
    expect(h!.lines[1]!.newNo).toBe(2);
  });

  test('deleted file', () => {
    const d = `diff --git a/old.go b/old.go
deleted file mode 100644
index 3333333..0000000
--- a/old.go
+++ /dev/null
@@ -1,2 +0,0 @@
-package main
-func main() {}
`;
    const [h] = parseDiff(d);
    expect(h!.fileStatus).toBe('deleted');
    expect(h!.path).toBe('old.go');
    expect(h!.lines.every((l) => l.kind === 'del')).toBe(true);
  });

  test('pure rename becomes one pseudo-hunk; rename with edits keeps hunks', () => {
    const d = `diff --git a/a/x.ts b/b/y.ts
similarity index 100%
rename from a/x.ts
rename to b/y.ts
diff --git a/c.ts b/d.ts
similarity index 80%
rename from c.ts
rename to d.ts
index 1..2 100644
--- a/c.ts
+++ b/d.ts
@@ -1 +1 @@
-x
+y
`;
    const hunks = parseDiff(d);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.pseudo).toBe(true);
    expect(hunks[0]!.fileStatus).toBe('renamed');
    expect(hunks[0]!.path).toBe('b/y.ts');
    expect(hunks[0]!.oldPath).toBe('a/x.ts');
    expect(hunks[1]!.fileStatus).toBe('renamed');
    expect(hunks[1]!.oldPath).toBe('c.ts');
    expect(hunks[1]!.path).toBe('d.ts');
    expect(hunks[1]!.lines).toHaveLength(2);
  });

  test('binary file', () => {
    const d = `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
diff --git a/new.bin b/new.bin
new file mode 100644
index 0000000..2222222
Binary files /dev/null and b/new.bin differ
`;
    const hunks = parseDiff(d);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.fileStatus).toBe('binary');
    expect(hunks[0]!.pseudo).toBe(true);
    expect(hunks[0]!.header).toBe('binary file changed');
    expect(hunks[1]!.header).toBe('binary file added');
  });

  test('mode-only change', () => {
    const d = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;
    const [h] = parseDiff(d);
    expect(h!.fileStatus).toBe('mode');
    expect(h!.header).toBe('mode 100644 → 100755');
    expect(h!.pseudo).toBe(true);
  });

  test('no newline at end of file', () => {
    const d = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const [h] = parseDiff(d);
    expect(h!.lines).toHaveLength(2);
    expect(h!.lines[0]!.noNewline).toBe(true);
    expect(h!.lines[1]!.noNewline).toBe(true);
    expect(h!.lines[1]!.text).toBe('new');
  });

  test('CRLF line endings', () => {
    const d = modified.replace(/\n/g, '\r\n');
    const hunks = parseDiff(d);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines[1]!.text).toBe('const a = 1;');
    expect(hunks[0]!.path).toBe('src/a.ts');
    expect(hunks.map((h) => h.id)).toEqual(parseDiff(modified).map((h) => h.id));
  });

  test('blank context lines and quoted paths', () => {
    const d = `diff --git "a/sp ace\\303\\251.txt" "b/sp ace\\303\\251.txt"
--- "a/sp ace\\303\\251.txt"
+++ "b/sp ace\\303\\251.txt"
@@ -1,3 +1,3 @@
 a

-b
+c
`;
    const [h] = parseDiff(d);
    expect(h!.path).toBe('sp aceé.txt');
    expect(h!.lines.map((l) => l.kind)).toEqual(['ctx', 'ctx', 'del', 'add']);
    expect(unquotePath('"x\\ty"')).toBe('x\ty');
  });

  test('a 5,000-line diff parses in under 100 ms', () => {
    let d = '';
    for (let f = 0; f < 50; f++) {
      d += `diff --git a/f${f}.ts b/f${f}.ts\n--- a/f${f}.ts\n+++ b/f${f}.ts\n`;
      for (let h = 0; h < 10; h++) {
        const start = h * 20 + 1;
        d += `@@ -${start},5 +${start},5 @@\n`;
        d += ` ctx ${h}\n-old ${f} ${h}\n+new ${f} ${h}\n ctx\n ctx\n ctx\n`;
      }
    }
    expect(d.split('\n').length).toBeGreaterThan(3000);
    const big = d + d.replace(/f(\d+)\.ts/g, 'g$1.ts');
    expect(big.split('\n').length).toBeGreaterThan(5000);
    const t0 = performance.now();
    const hunks = parseDiff(big);
    const elapsed = performance.now() - t0;
    expect(hunks).toHaveLength(1000);
    expect(elapsed).toBeLessThan(100);
  });

  test('groupFiles keeps order', () => {
    const files = groupFiles(parseDiff(modified));
    expect(files).toHaveLength(1);
    expect(files[0]!.hunks).toHaveLength(2);
  });
});

describe('hunk IDs', () => {
  test('unchanged when an earlier hunk in the file changes', () => {
    const before = parseDiff(modified);
    const after = parseDiff(
      modified
        .replace('@@ -1,3 +1,4 @@', '@@ -1,3 +1,6 @@')
        .replace('+const b = 3;\n', '+const b = 3;\n+const c = 4;\n+const d = 5;\n')
        .replace('@@ -10,2 +11,2 @@', '@@ -10,2 +13,2 @@'),
    );
    expect(after[0]!.id).not.toBe(before[0]!.id);
    expect(after[1]!.id).toBe(before[1]!.id);
    expect(after[1]!.newStart).toBe(13);
  });

  test('identical hunks in one file get suffixes in order', () => {
    const d = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,1 @@
-a
+b
@@ -10,1 +10,1 @@
-a
+b
@@ -20,1 +20,1 @@
-a
+b
`;
    const ids = parseDiff(d).map((h) => h.id);
    const base = hunkIdFor('x.ts', '-a\n+b');
    expect(ids).toEqual([base, `${base}-2`, `${base}-3`]);
  });

  test('same body in different files gets different IDs', () => {
    const d = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -1 +1 @@
-a
+b
`;
    const [a, b] = parseDiff(d);
    expect(a!.id).not.toBe(b!.id);
    expect(a!.id.includes('-')).toBe(false);
    expect(b!.id.includes('-')).toBe(false);
  });
});
