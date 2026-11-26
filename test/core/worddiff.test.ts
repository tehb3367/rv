import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import { hunkWordDiffs, pairChangedLines, wordDiff } from '../../src/core/worddiff.ts';

describe('word diff', () => {
  test('pairs runs of deleted and added lines in order', () => {
    const [h] = parseDiff(`--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@\n ctx\n-a1\n-a2\n+b1\n+b2\n+b3\n ctx\n`);
    expect(pairChangedLines(h!)).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  test('marks changed words when enough of the line is unchanged', () => {
    const wd = wordDiff('const value = compute(a, b);', 'const value = compute(a, c);')!;
    expect(wd).not.toBeNull();
    expect(wd.old).toEqual([[25, 26]]);
    expect(wd.new).toEqual([[25, 26]]);
  });

  test('suppressed when less than 20% is unchanged', () => {
    expect(wordDiff('alpha beta gamma', 'totally different text')).toBeNull();
    expect(wordDiff('', '')).toBeNull();
  });

  test('hunkWordDiffs keys by line index', () => {
    const [h] = parseDiff(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-let total = price * qty;\n+let total = price * quantity;\n`);
    const m = hunkWordDiffs(h!);
    expect([...m.keys()]).toEqual([0, 1]);
  });
});
