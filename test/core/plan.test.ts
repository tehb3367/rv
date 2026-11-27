import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import { reconcilePlan, unstackedPlan, validatePlan } from '../../src/core/plan.ts';
import type { Hunk, Plan } from '../../src/core/types.ts';

function fakeHunks(n: number): Hunk[] {
  let d = '';
  for (let i = 0; i < n; i++) d += `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n-a${i}\n+b${i}\n`;
  return parseDiff(d);
}

const hunks = fakeHunks(4);
const ids = hunks.map((h) => h.id);

function plan(layers: Plan['layers']): Plan {
  return { version: 1, title: 'T', layers };
}
const L = (id: string, hs: string[], extra: Partial<Plan['layers'][number]> = {}) => ({
  id,
  title: `Layer ${id}`,
  why: 'because',
  risk: 'low' as const,
  hunks: hs,
  ...extra,
});

describe('validatePlan', () => {
  test('accepts a plan covering every hunk once', () => {
    const r = validatePlan(plan([L('L1', [ids[0]!, ids[1]!]), L('L2', [ids[2]!, ids[3]!], { dependsOn: ['L1'], group: 'G' })]), hunks);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.layers[1]!.dependsOn).toEqual(['L1']);
  });

  test('missing hunk: rule 1, exact error shape', () => {
    const r = validatePlan(plan([L('L1', [ids[0]!, ids[1]!, ids[2]!])]), hunks);
    expect(r).toEqual({
      ok: false,
      missing: [{ id: ids[3]!, path: 'f3.ts', header: '@@ -1 +1 @@' }],
      duplicated: [],
      unknown: [],
      errors: [],
    });
  });

  test('duplicated hunk: rule 1', () => {
    const r = validatePlan(plan([L('L1', [ids[0]!, ids[1]!]), L('L2', [ids[1]!, ids[2]!, ids[3]!])]), hunks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.duplicated).toEqual([{ id: ids[1]!, layers: ['L1', 'L2'] }]);
  });

  test('unknown hunk IDs: rule 2', () => {
    const r = validatePlan(plan([L('L1', [...ids, 'deadbeef00'])]), hunks);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unknown).toEqual(['deadbeef00']);
      expect(r.missing).toEqual([]);
    }
  });

  test('layer ids unique, 1 to 30 layers, no empty layer: rule 3', () => {
    let r = validatePlan(plan([L('L1', ids.slice(0, 2)), L('L1', ids.slice(2))]), hunks);
    expect(!r.ok && r.errors).toContain('duplicate layer id L1');
    r = validatePlan(plan([]), hunks);
    expect(!r.ok && r.errors).toContain('plan must have 1 to 30 layers, got 0');
    const many = fakeHunks(31);
    r = validatePlan(plan(many.map((h, i) => L(`L${i + 1}`, [h.id]))), many);
    expect(!r.ok && r.errors).toContain('plan must have 1 to 30 layers, got 31');
    r = validatePlan(plan([L('L1', ids), L('L2', [])]), hunks);
    expect(!r.ok && r.errors).toContain('L2 has no hunks');
  });

  test('dependsOn only points earlier: rule 4', () => {
    const r = validatePlan(
      plan([L('L1', [ids[0]!], { dependsOn: ['L1'] }), L('L2', [ids[1]!]), L('L3', [ids[2]!], { dependsOn: ['L5'] }), L('L5', [ids[3]!]), ]),
      hunks,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('L1.dependsOn references itself');
      expect(r.errors).toContain('L3.dependsOn references L5, which comes later');
    }
    const r2 = validatePlan(plan([L('L1', ids, { dependsOn: ['L9'] })]), hunks);
    expect(!r2.ok && r2.errors).toContain('L1.dependsOn references L9, which does not exist');
  });

  test('length limits and risk values: rule 5', () => {
    const r = validatePlan(
      plan([L('L1', ids, { title: 'x'.repeat(61), why: 'y'.repeat(801), risk: 'huge' as 'low' })]),
      hunks,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('L1.title is 61 characters, the limit is 60');
      expect(r.errors).toContain('L1.why is 801 characters, the limit is 800');
      expect(r.errors).toContain('L1.risk must be one of low, med, high');
    }
    const ok = validatePlan(plan([L('L1', ids, { title: 'x'.repeat(60), why: 'y'.repeat(800) })]), hunks);
    expect(ok.ok).toBe(true);
  });

  test('shape errors', () => {
    expect(validatePlan(null, hunks)).toEqual({ ok: false, missing: [], duplicated: [], unknown: [], errors: ['plan must be a JSON object'] });
    const r = validatePlan({ version: 2, title: '', layers: [] }, hunks);
    expect(!r.ok && r.errors).toContain('version must be 1');
    expect(!r.ok && r.errors).toContain('title must be a non-empty string');
  });

  test('every offending ID is listed together', () => {
    const r = validatePlan(plan([L('L1', [ids[0]!, ids[0]!, 'aaaaaaaaaa', 'bbbbbbbbbb'])]), hunks);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing.map((m) => m.id)).toEqual(ids.slice(1));
      expect(r.duplicated).toEqual([{ id: ids[0]!, layers: ['L1', 'L1'] }]);
      expect(r.unknown).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
    }
  });
});

describe('stale plans', () => {
  test('added hunks go to Unplaced, removed ones drop out, stale: true', () => {
    const p = plan([L('L1', [ids[0]!, ids[1]!]), L('L2', [ids[2]!], { dependsOn: ['L1'] })]);
    const nowHunks = [hunks[1]!, hunks[2]!, hunks[3]!, ...fakeHunks(6).slice(5)];
    const r = reconcilePlan(p, nowHunks);
    expect(r.stale).toBe(true);
    expect(r.newHunks).toEqual([ids[3]!, nowHunks[3]!.id]);
    expect(r.stored!.layers.map((l) => l.hunks)).toEqual([[ids[1]!], [ids[2]!]]);
    expect(r.view.layers.map((l) => l.id)).toEqual(['L1', 'L2', 'Unplaced']);
    expect(r.view.layers[2]!.hunks).toEqual(r.newHunks);
  });

  test('empty layers are dropped along with their dependsOn references', () => {
    const p = plan([L('L1', [ids[0]!]), L('L2', [ids[1]!, ids[2]!, ids[3]!], { dependsOn: ['L1'] })]);
    const r = reconcilePlan(p, hunks.slice(1));
    expect(r.stale).toBe(false);
    expect(r.stored!.layers).toHaveLength(1);
    expect(r.stored!.layers[0]!.dependsOn).toEqual([]);
  });

  test('no plan gives the Unstacked view', () => {
    const r = reconcilePlan(null, hunks);
    expect(r.hasPlan).toBe(false);
    expect(r.view).toEqual(unstackedPlan(hunks));
    expect(r.view.layers[0]!.hunks).toEqual(ids);
  });
});

describe('layer explain (learning mode)', () => {
  test('optional, kept on accept, limited to 2000 characters', () => {
    const ok = validatePlan(plan([L('L1', ids, { explain: 'In plain words.' })]), hunks);
    expect(ok.ok && ok.plan.layers[0]!.explain).toBe('In plain words.');
    const none = validatePlan(plan([L('L1', ids)]), hunks);
    expect(none.ok && 'explain' in none.plan.layers[0]!).toBe(false);
    const long = validatePlan(plan([L('L1', ids, { explain: 'x'.repeat(2001) })]), hunks);
    expect(!long.ok && long.errors).toContain('L1.explain is 2001 characters, the limit is 2000');
    const bad = validatePlan(plan([L('L1', ids, { explain: 5 as unknown as string })]), hunks);
    expect(!bad.ok && bad.errors).toContain('L1.explain must be a string');
  });
});
