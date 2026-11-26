import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StateStore, atomicWrite, statePath } from '../../src/core/state.ts';
import { tempDir } from '../helpers.ts';

describe('StateStore', () => {
  test('debounces writes and writes atomically', async () => {
    const dir = tempDir();
    const p = statePath(dir, 'main..feat_x');
    expect(p).toBe(join(dir, 'rv', 'main..feat_x.json'));
    const store = new StateStore(p, 50);
    store.update((s) => (s.reviewed.abc = '2026-01-01T00:00:00.000Z'));
    store.update((s) => (s.reviewed.def = '2026-01-01T00:00:00.000Z'));
    expect(existsSync(p)).toBe(false);
    await Bun.sleep(120);
    expect(existsSync(p)).toBe(true);
    const saved = JSON.parse(readFileSync(p, 'utf8'));
    expect(Object.keys(saved.reviewed)).toEqual(['abc', 'def']);
    expect(saved.plan).toBeNull();
    expect(readdirSync(join(dir, 'rv')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('flush writes immediately and reload restores', () => {
    const dir = tempDir();
    const p = statePath(dir, 'pr-12');
    const store = new StateStore(p);
    store.update((s) => {
      s.plan = { version: 1, title: 'x', layers: [] };
      s.comments.push({ id: 'c_1', hunkId: 'h', author: 'human', kind: 'ask', body: 'q', status: 'draft', createdAt: 'now' });
    });
    store.flush();
    const again = new StateStore(p);
    expect(again.get().plan!.title).toBe('x');
    expect(again.get().comments).toHaveLength(1);
  });

  test('corrupt file falls back to empty state', () => {
    const dir = tempDir();
    const p = join(dir, 'bad.json');
    atomicWrite(p, '{not json');
    expect(new StateStore(p).get().comments).toEqual([]);
  });
});
