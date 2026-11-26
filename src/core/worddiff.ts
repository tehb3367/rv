import { diffWordsWithSpace } from 'diff';
import type { Hunk } from './types.ts';

export type Range = [start: number, end: number];
export type WordDiff = { old: Range[]; new: Range[] };

export const MIN_UNCHANGED_RATIO = 0.2;

/** Pair runs of deleted and added lines in order, the way GitHub does. Returns [delIndex, addIndex] pairs. */
export function pairChangedLines(hunk: Hunk): [number, number][] {
  const pairs: [number, number][] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(i++);
    const adds: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(i++);
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push([dels[k]!, adds[k]!]);
  }
  return pairs;
}

/** Word diff of one line pair, or null when less than 20% of the line is unchanged. */
export function wordDiff(oldText: string, newText: string): WordDiff | null {
  const maxLen = Math.max(oldText.length, newText.length);
  if (maxLen === 0 || oldText === newText) return null;
  const parts = diffWordsWithSpace(oldText, newText);
  const out: WordDiff = { old: [], new: [] };
  let oPos = 0;
  let nPos = 0;
  let unchanged = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) {
      out.new.push([nPos, nPos + len]);
      nPos += len;
    } else if (p.removed) {
      out.old.push([oPos, oPos + len]);
      oPos += len;
    } else {
      unchanged += len;
      oPos += len;
      nPos += len;
    }
  }
  if (unchanged / maxLen < MIN_UNCHANGED_RATIO) return null;
  return out;
}

/** Changed-word ranges for every paired line in a hunk, keyed by line index. */
export function hunkWordDiffs(hunk: Hunk): Map<number, Range[]> {
  const out = new Map<number, Range[]>();
  for (const [d, a] of pairChangedLines(hunk)) {
    const wd = wordDiff(hunk.lines[d]!.text, hunk.lines[a]!.text);
    if (!wd) continue;
    if (wd.old.length) out.set(d, wd.old);
    if (wd.new.length) out.set(a, wd.new);
  }
  return out;
}
