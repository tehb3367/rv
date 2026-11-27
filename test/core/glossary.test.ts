import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import {
  RISK_BLURB,
  explainFileStatus,
  explainFileType,
  explainHunkHeader,
  explainLine,
  explainTerms,
} from '../../src/core/glossary.ts';

const terms = (text: string, path: string) => explainTerms(text, path).map((t) => t.term);

describe('learning mode glossary', () => {
  test('TypeScript words in order of appearance, without words inside strings', () => {
    expect(terms("import { db } from './db';", 'a.ts')).toEqual(['import', 'from', '"…"']);
    expect(terms("export async function load(id: string) { return await db.get('if', id); }", 'a.ts')).toEqual([
      'export', 'async', 'function', 'string', 'return', 'await', '"…"',
    ]);
    expect(terms('const f = (x) => x?.y ?? 0;', 'a.ts')).toEqual(['const', '=>', '?.', '??']);
  });

  test('JSX tags, template strings and comments', () => {
    expect(terms('export const Row = () => <span className="row">{`item ${n}`}</span>;', 'v.tsx')).toContain('<tag>');
    expect(terms('const s = `hi ${name}`;', 'a.ts')).toContain('${');
    expect(explainTerms('// fetch the user', 'a.ts')).toEqual([
      { term: 'comment', meaning: 'This line is a comment: a note for people reading the code. The computer ignores it.' },
    ]);
    expect(terms('# a python comment', 'x.py')).toEqual(['comment']);
  });

  test('Python and Go use their own words', () => {
    expect(terms('def report(x):', 'r.py')).toEqual(['def']);
    expect(terms('    return json.dumps(x)', 'r.py')).toEqual(['return', 'json']);
    expect(terms('func main() {', 'm.go')).toEqual(['func', 'main']);
    expect(terms('x := compute()', 'm.go')).toEqual([':=']);
    expect(terms('func main() {', 'm.zzz')).toEqual([]);
  });

  test('files, statuses, hunks and risk in plain words', () => {
    expect(explainFileType('src/a.ts')).toContain('TypeScript file');
    expect(explainFileType('tools/r.py')).toContain('Python file');
    expect(explainFileType('package-lock.json')).toContain('lockfile');
    expect(explainFileType('notes.zzz')).toContain("doesn't recognise");
    expect(explainFileStatus('renamed', 'old.ts')).toBe('This file was renamed or moved: it used to be old.ts.');
    expect(explainFileStatus('binary')).toContain('binary file');
    const [h] = parseDiff('--- a/x.ts\n+++ b/x.ts\n@@ -40,6 +40,9 @@ class Store\n ctx\n+a\n+b\n+c\n ctx\n ctx\n ctx\n ctx\n ctx\n');
    const said = explainHunkHeader(h!);
    expect(said).toContain('6 lines starting at line 40 of the old file');
    expect(said).toContain('9 lines starting at line 40 of the new file');
    expect(said).toContain('“class Store”');
    expect(RISK_BLURB.high).toContain('High risk');
  });

  test('explainLine: line kind, terms, and blank lines', () => {
    const [h] = parseDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+let a = 2;\n \n");
    const del = explainLine(h!.lines[0]!, h!);
    expect(del.title).toBe('removed line');
    expect(del.lines[0]).toBe('Red line with - : removed by this change. It was line 1 in the old version.');
    expect(del.lines[1]).toStartWith('const — ');
    const add = explainLine(h!.lines[1]!, h!);
    expect(add.lines[0]).toContain('It is line 1 in the new version');
    expect(add.lines[1]).toStartWith('let — ');
    expect(explainLine(h!.lines[2]!, h!).lines[1]).toContain('blank');
  });
});
