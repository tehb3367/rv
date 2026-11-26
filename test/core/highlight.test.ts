import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import { loadDiffText, resolveLocalSource } from '../../src/core/git.ts';
import {
  DEFAULT_HIGHLIGHT,
  HighlightEngine,
  TokenCache,
  Tokenizer,
  languageFor,
  skipByContent,
  skipByName,
  tokensForLine,
  type FileTokens,
} from '../../src/core/highlight.ts';
import { HighlightClient } from '../../src/core/highlight-client.ts';
import { loadTheme } from '../../src/core/theme.ts';
import { groupFiles } from '../../src/core/diff.ts';
import { commitAll, initRepo, sh, tempDir, write } from '../helpers.ts';

const STRING_COLOR = '#FF8B39'; // synthwave-84 string colour

function tsxRepo() {
  const dir = initRepo();
  const body = Array.from({ length: 30 }, (_, i) => `  line ${i} of the template`).join('\n');
  write(dir, 'view.tsx', `export const tpl = \`\n${body}\n\`;\nexport const el = <div className="x">{tpl}</div>;\nconst gone = 1;\n`);
  write(dir, 'package-lock.json', '{"lockfileVersion": 3}\n');
  write(dir, 'notes.unknownext', 'hello\n');
  commitAll(dir, 'base');
  sh(['git', 'checkout', '-q', '-b', 'feat'], dir);
  const body2 = body.replace('  line 20 of the template', '  line 20 CHANGED in the template');
  write(dir, 'view.tsx', `export const tpl = \`\n${body2}\n\`;\nexport const el = <div className="x">{tpl}</div>;\nlet kept = 2;\n`);
  write(dir, 'package-lock.json', '{"lockfileVersion": 4}\n');
  write(dir, 'notes.unknownext', 'hello world\n');
  commitAll(dir, 'change');
  return dir;
}

async function engineFor(dir: string) {
  const src = await resolveLocalSource(dir, { range: 'main..feat' });
  const hunks = parseDiff(await loadDiffText(src));
  const tokenizer = await Tokenizer.create(await loadTheme('synthwave-84'));
  const engine = new HighlightEngine(src, tokenizer, { cache: new TokenCache(null) });
  return { src, hunks, engine };
}

describe('highlighting', () => {
  test('a TSX template string opened above the hunk still colours the hunk as a string', async () => {
    const { hunks, engine } = await engineFor(tsxRepo());
    const tsxHunks = hunks.filter((h) => h.path === 'view.tsx');
    const ft = await engine.highlightFile({ path: 'view.tsx', status: 'modified' });
    expect(ft.skipped).toBeUndefined();
    const hunk = tsxHunks.find((h) => h.lines.some((l) => l.text.includes('CHANGED')))!;
    expect(hunk.newStart).toBeGreaterThan(5); // the template opens well above the hunk
    const added = hunk.lines.find((l) => l.kind === 'add')!;
    const toks = tokensForLine(added, ft)!;
    expect(toks).toBeDefined();
    expect(toks.map((t) => t[0]).join('')).toBe(added.text);
    expect(toks.every((t) => t[1]?.toUpperCase() === STRING_COLOR)).toBe(true);
    const ctx = hunk.lines.find((l) => l.kind === 'ctx')!;
    expect(tokensForLine(ctx, ft)!.every((t) => t[1]?.toUpperCase() === STRING_COLOR)).toBe(true);
  });

  test('a deleted line uses old-file tokens', async () => {
    const { hunks, engine } = await engineFor(tsxRepo());
    const ft = await engine.highlightFile({ path: 'view.tsx', status: 'modified' });
    const hunk = hunks.find((h) => h.lines.some((l) => l.text === 'const gone = 1;'))!;
    const del = hunk.lines.find((l) => l.text === 'const gone = 1;')!;
    expect(del.kind).toBe('del');
    const toks = tokensForLine(del, ft)!;
    expect(toks.map((t) => t[0]).join('')).toBe('const gone = 1;');
    expect(toks[0]![0]).toBe('const');
    // The same line number in the new file is different code, so this proves the old side was used.
    const add = hunk.lines.find((l) => l.text === 'let kept = 2;')!;
    expect(tokensForLine(add, ft)![0]![0]).toBe('let');
  });

  test('lockfiles and unknown types render plain', async () => {
    const { engine } = await engineFor(tsxRepo());
    expect((await engine.highlightFile({ path: 'package-lock.json', status: 'modified' })).skipped).toContain('package-lock.json');
    expect((await engine.highlightFile({ path: 'notes.unknownext', status: 'modified' })).skipped).toBe('plain text');
  });

  test('skip rules', () => {
    for (const p of ['bun.lock', 'a/yarn.lock', 'Cargo.lock', 'pnpm-lock.yaml', 'dist/app.min.js', 'x.lock'])
      expect(skipByName(p, DEFAULT_HIGHLIGHT)).not.toBeNull();
    expect(skipByName('src/app.ts', DEFAULT_HIGHLIGHT)).toBeNull();
    expect(skipByContent('a\n'.repeat(5001), 10, DEFAULT_HIGHLIGHT)).toBe('over 5000 lines');
    expect(skipByContent('x', 600_000, DEFAULT_HIGHLIGHT)).toBe('over 500000 bytes');
    expect(skipByContent('x'.repeat(2001), 2001, DEFAULT_HIGHLIGHT)).toBe('a line over 2000 characters');
    expect(skipByContent('const a = 1;\n', 13, DEFAULT_HIGHLIGHT)).toBeNull();
  });

  test('language detection', () => {
    expect(languageFor('a/b.tsx')).toBe('tsx');
    expect(languageFor('x.py')).toBe('python');
    expect(languageFor('main.go')).toBe('go');
    expect(languageFor('Dockerfile')).toBe('docker');
    expect(languageFor('x.yml')).toBe('yaml');
    expect(languageFor('README')).toBeNull();
    expect(languageFor('x.zzz')).toBeNull();
  });

  test('token cache is an LRU with a disk layer', () => {
    const dir = tempDir();
    const c = new TokenCache(dir, 2);
    c.set('a', [[['x']]]);
    c.set('b', [[['y']]]);
    c.get('a');
    c.set('c', [[['z']]]);
    expect(c.size).toBe(2);
    const fresh = new TokenCache(dir, 2);
    expect(fresh.get('b')).toEqual([[['y']]]); // evicted from memory, still on disk
    expect(TokenCache.key('abc', 'synthwave-84', 'tsx')).toBe('abc:synthwave-84:tsx');
  });

  test('the worker client highlights in priority order', async () => {
    const dir = tsxRepo();
    const src = await resolveLocalSource(dir, { range: 'main..feat' });
    const hunks = parseDiff(await loadDiffText(src));
    const client = new HighlightClient('synthwave-84', DEFAULT_HIGHLIGHT, { cacheDir: null });
    const got = new Map<string, FileTokens>();
    const done = new Promise<void>((resolve) => {
      client.onResult((p, t) => {
        got.set(p, t);
        if (got.size === 3) resolve();
      });
    });
    const files = groupFiles(hunks).map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status }));
    await client.start(src, files);
    client.prioritize(['view.tsx']);
    await done;
    client.stop();
    expect(got.get('view.tsx')!.new!.length).toBeGreaterThan(30);
  }, 20000);
});
