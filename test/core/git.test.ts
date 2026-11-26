import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import { blobShas, loadDiffText, readBlob, resolveLocalSource } from '../../src/core/git.ts';
import { commitAll, initRepo, sh, write } from '../helpers.ts';

function repo() {
  const dir = initRepo();
  write(dir, 'a.ts', 'export const a = 1;\n');
  write(dir, 'b.txt', 'hello\n');
  commitAll(dir, 'base');
  sh(['git', 'checkout', '-q', '-b', 'feat/x'], dir);
  write(dir, 'a.ts', 'export const a = 2;\n');
  sh(['git', 'mv', 'b.txt', 'c.txt'], dir);
  commitAll(dir, 'change');
  return dir;
}

describe('git loading', () => {
  test('default range falls back to main and names the branch', async () => {
    const dir = repo();
    const src = await resolveLocalSource(dir, {});
    expect(src.baseLabel).toBe('main');
    expect(src.headLabel).toBe('feat/x');
    expect(src.key).toBe('main..feat_x');
    const hunks = parseDiff(await loadDiffText(src));
    expect(hunks.map((h) => [h.path, h.fileStatus])).toEqual([
      ['a.ts', 'modified'],
      ['c.txt', 'renamed'],
    ]);
    const old = await readBlob(src, 'old', 'a.ts');
    expect(new TextDecoder().decode(old!)).toBe('export const a = 1;\n');
    const shas = await blobShas(src, 'new', ['a.ts', 'c.txt']);
    expect(shas.size).toBe(2);
  });

  test('a..b, a...b, single ref and worktree', async () => {
    const dir = repo();
    expect((await resolveLocalSource(dir, { range: 'main..feat/x' })).key).toBe('main..feat_x');
    const tri = await resolveLocalSource(dir, { range: 'main...feat/x' });
    expect(tri.base).toBe(sh(['git', 'rev-parse', 'main'], dir).trim());
    const single = await resolveLocalSource(dir, { range: 'main' });
    expect(single.headLabel).toBe('feat/x');
    write(dir, 'untracked.go', 'package x\n');
    write(dir, 'a.ts', 'export const a = 3;\n');
    const wt = await resolveLocalSource(dir, { worktree: true });
    expect(wt.headMode).toBe('worktree');
    const hunks = parseDiff(await loadDiffText(wt));
    expect(hunks.map((h) => h.path).sort()).toEqual(['a.ts', 'c.txt', 'untracked.go']);
    expect(hunks.find((h) => h.path === 'untracked.go')!.fileStatus).toBe('added');
    const blob = await readBlob(wt, 'new', 'a.ts');
    expect(new TextDecoder().decode(blob!)).toBe('export const a = 3;\n');
  });

  test('staged', async () => {
    const dir = repo();
    write(dir, 'a.ts', 'export const a = 9;\n');
    sh(['git', 'add', 'a.ts'], dir);
    const src = await resolveLocalSource(dir, { staged: true });
    const hunks = parseDiff(await loadDiffText(src));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.find((l) => l.kind === 'add')!.text).toBe('export const a = 9;');
  });
});
