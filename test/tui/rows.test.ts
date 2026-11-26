import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import { unstackedPlan } from '../../src/core/plan.ts';
import type { Comment } from '../../src/core/types.ts';
import { anchorOf, buildRows, expandTabs } from '../../src/tui/rows.ts';

const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@
 ten
+eleven
 twelve
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-\tx
+\ty = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15
`;
const hunks = parseDiff(diff);
const map = new Map(hunks.map((h) => [h.id, h]));
const plan = unstackedPlan(hunks);
const base = { layer: plan.layers[0]!, plan, hunks: map, reviewed: {}, comments: [] as Comment[], toggled: new Set<string>(), width: 60, wrap: false };

describe('row model', () => {
  test('layer card, file headers, hunk headers and lines', () => {
    const { rows, numWidth } = buildRows(base);
    expect(numWidth).toBe(3);
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'hunk')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'line')).toHaveLength(9);
    const files = rows.filter((r) => r.kind === 'text' && r.key.startsWith('f:'));
    expect(files).toHaveLength(2); // one header per file, not per hunk
  });

  test('reviewed hunks collapse to one line; toggled expands them again', () => {
    const id = hunks[0]!.id;
    const { rows } = buildRows({ ...base, reviewed: { [id]: 'now' } });
    const c = rows.find((r) => r.kind === 'collapsed')!;
    expect(c.kind === 'collapsed' && c.segs.map((s) => s.text).join('')).toContain('✓ a.ts @@ -1,3 +1,3 @@ (collapsed, 4 lines)');
    const again = buildRows({ ...base, reviewed: { [id]: 'now' }, toggled: new Set([id]) });
    expect(again.rows.some((r) => r.kind === 'collapsed')).toBe(false);
  });

  test('comment threads render under their anchor line, unanchored ones after the hunk', () => {
    const h = hunks[0]!;
    const mk = (id: string, extra: Partial<Comment>): Comment => ({
      id, hunkId: h.id, author: 'human', kind: 'ask', body: 'Q?', status: 'pending', createdAt: 'x', ...extra,
    });
    const comments = [
      mk('c_1', { line: { side: 'new', number: 2 } }),
      mk('c_2', { author: 'agent', kind: 'reply', parentId: 'c_1', body: 'A.', status: 'answered' }),
      mk('c_3', { kind: 'review', body: 'general' }),
    ];
    const { rows } = buildRows({ ...base, comments });
    const idxLine = rows.findIndex((r) => r.kind === 'line' && r.hunkId === h.id && r.lineIndex === 2);
    const next = rows[idxLine + 1]!;
    expect(next.kind === 'text' && next.commentId).toBe('c_1');
    const top = next.kind === 'text' ? next.segs.map((s) => s.text).join('') : '';
    expect(top).toContain('ask · you · pending');
    expect(rows.some((r) => r.kind === 'text' && r.commentId === 'c_2' && r.segs.some((s) => s.text.includes('reply · agent')))).toBe(true);
    const lastLine = rows.findIndex((r) => r.kind === 'line' && r.hunkId === h.id && r.lineIndex === 4);
    expect(rows.slice(lastLine + 1).find((r) => r.kind === 'text' && r.commentId)!.kind === 'text').toBe(true);
    const generalIdx = rows.findIndex((r) => r.kind === 'text' && r.commentId === 'c_3');
    expect(generalIdx).toBeGreaterThan(lastLine);
  });

  test('wrap splits long lines into continuation rows; tabs expand', () => {
    expect(expandTabs('\tx')).toBe('    x');
    const off = buildRows(base).rows.filter((r) => r.kind === 'line' && r.hunkId === hunks[2]!.id);
    const on = buildRows({ ...base, wrap: true }).rows.filter((r) => r.kind === 'line' && r.hunkId === hunks[2]!.id);
    expect(off).toHaveLength(2);
    expect(on.length).toBeGreaterThan(2);
    expect(on.some((r) => r.kind === 'line' && r.cont)).toBe(true);
  });

  test('anchorOf gives new-side numbers for adds and old-side for deletes', () => {
    const { rows } = buildRows(base);
    const del = rows.find((r) => r.kind === 'line' && hunks[0]!.lines[r.lineIndex]!.kind === 'del' && r.hunkId === hunks[0]!.id)!;
    const add = rows.find((r) => r.kind === 'line' && hunks[0]!.lines[r.lineIndex]!.kind === 'add' && r.hunkId === hunks[0]!.id)!;
    expect(anchorOf(del, map)).toEqual({ side: 'old', number: 2 });
    expect(anchorOf(add, map)).toEqual({ side: 'new', number: 2 });
  });

  test('builds rows for a 5,000-line layer quickly', () => {
    let d = '';
    for (let f = 0; f < 50; f++) {
      d += `diff --git a/f${f}.ts b/f${f}.ts\n--- a/f${f}.ts\n+++ b/f${f}.ts\n@@ -1,50 +1,50 @@\n`;
      for (let i = 0; i < 50; i++) d += `-old line ${i} of ${f}\n+new line ${i} of ${f}\n`;
    }
    const big = parseDiff(d);
    const p = unstackedPlan(big);
    const t0 = performance.now();
    const { rows } = buildRows({ ...base, layer: p.layers[0]!, plan: p, hunks: new Map(big.map((h) => [h.id, h])), width: 150 });
    expect(rows.length).toBeGreaterThan(5000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('compact rows', () => {
  test('one number column, comment indent 2, paths shortened from the left', async () => {
    const { gutterWidth, shortenPath } = await import('../../src/tui/rows.ts');
    expect(gutterWidth(3, true)).toBe(6);
    expect(gutterWidth(3, false)).toBe(11);
    expect(shortenPath('src/session/store/deep/file.ts', 18)).toBe('…/deep/file.ts');
    expect(shortenPath('short.ts', 20)).toBe('short.ts');
    const h = hunks[0]!;
    const c: Comment = { id: 'c_1', hunkId: h.id, line: { side: 'new', number: 2 }, author: 'human', kind: 'ask', body: 'Q?', status: 'pending', createdAt: 'x' };
    const { rows, numWidth } = buildRows({ ...base, width: 30, compact: true, comments: [c] });
    expect(numWidth).toBe(2);
    const box = rows.find((r) => r.kind === 'text' && r.commentId === 'c_1')!;
    expect(box.kind === 'text' && box.segs[0]!.text).toBe('  ');
    for (const r of rows) if (r.kind === 'text') expect(r.segs.reduce((n, s) => n + Bun.stringWidth(s.text), 0)).toBeLessThanOrEqual(30);
  });

  test('wrapping prefers word boundaries', () => {
    const { rows } = buildRows({ ...base, width: 30, wrap: true, compact: true });
    const parts = rows.filter((r) => r.kind === 'line' && r.hunkId === hunks[2]!.id && hunks[2]!.lines[r.lineIndex]!.kind === 'add');
    expect(parts.length).toBeGreaterThan(1);
    const text = expandTabs(hunks[2]!.lines[parts[0]!.kind === 'line' ? parts[0]!.lineIndex : 0]!.text);
    for (const p of parts.slice(0, -1)) if (p.kind === 'line') expect(/[\s,;(){}\[\]<>=+\-*/|&:]/.test(text[p.end - 1]!)).toBe(true);
  });
});
