import { hunkStats } from '../core/diff.ts';
import type { Comment, Hunk, Layer, Plan } from '../core/types.ts';
import { UNPLACED_ID, UNSTACKED_ID } from '../core/types.ts';
import { TAB_WIDTH, flattenMarkdown, width, wrap } from './text.ts';

/** A styled run of text. Colours are semantic roles resolved against the palette at render time. */
export type Role =
  | 'fg' | 'muted' | 'gutter' | 'focus' | 'add' | 'del' | 'riskLow' | 'riskMed' | 'riskHigh'
  | 'ask' | 'note' | 'review' | 'file' | 'hunk';
export type Seg = { text: string; role?: Role; bold?: boolean };

export type Row =
  | { kind: 'text'; key: string; segs: Seg[]; hunkId?: string; commentId?: string; layerCard?: boolean }
  | { kind: 'hunk'; key: string; hunkId: string; segs: Seg[] }
  | { kind: 'collapsed'; key: string; hunkId: string; segs: Seg[] }
  | { kind: 'line'; key: string; hunkId: string; lineIndex: number; start: number; end: number; cont: boolean };

export type BuildInput = {
  layer: Layer;
  plan: Plan;
  hunks: Map<string, Hunk>;
  reviewed: Record<string, string>;
  comments: Comment[];
  /** Hunks whose collapsed state the user flipped with `o`. */
  toggled: Set<string>;
  width: number;
  wrap: boolean;
};

export type BuiltRows = { rows: Row[]; numWidth: number; codeWidth: number };

export function riskRole(r: string): Role {
  return r === 'high' ? 'riskHigh' : r === 'med' ? 'riskMed' : 'riskLow';
}

export function expandTabs(s: string): string {
  if (!s.includes('\t')) return s;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') out += ' '.repeat(TAB_WIDTH - (width(out) % TAB_WIDTH));
    else out += ch;
  }
  return out;
}

export function isCollapsed(hunkId: string, reviewed: Record<string, string>, toggled: Set<string>): boolean {
  return Boolean(reviewed[hunkId]) !== toggled.has(hunkId);
}

/** Gutter: cursor column, old number, new number, marker. */
export function gutterWidth(numWidth: number): number {
  return 1 + numWidth + 1 + numWidth + 1 + 2;
}

function lineAnchorMatches(c: Comment, h: Hunk, idx: number): boolean {
  if (!c.line) return false;
  const l = h.lines[idx]!;
  if (c.line.side === 'new') return l.kind !== 'del' && l.newNo === c.line.number;
  return l.kind !== 'add' && l.oldNo === c.line.number;
}

function authorLabel(c: Comment): string {
  return c.author === 'human' ? 'you' : 'agent';
}

function kindRole(c: Comment): Role {
  return c.kind === 'ask' || c.kind === 'reply' ? 'ask' : c.kind === 'note' ? 'note' : 'review';
}

/** Rows for one comment thread (root plus replies), drawn as boxes. */
export function threadRows(root: Comment, replies: Comment[], indent: number, paneWidth: number, keyPrefix: string): Row[] {
  const rows: Row[] = [];
  if (root.status === 'resolved') {
    const first = flattenMarkdown(root.body).split('\n')[0] ?? '';
    rows.push({
      kind: 'text',
      key: `${keyPrefix}:${root.id}`,
      hunkId: root.hunkId,
      commentId: root.id,
      segs: [{ text: ' '.repeat(indent) }, { text: `✓ resolved ${root.kind} · ${first}`, role: 'muted' }],
    });
    return rows;
  }
  const box = (c: Comment, extra: number) => {
    const ind = indent + extra;
    const boxW = Math.max(20, Math.min(72, paneWidth - ind - 1));
    const inner = boxW - 4;
    const role = kindRole(c);
    const status = c.kind === 'review' ? (c.postedAt ? 'posted' : c.status) : c.status;
    const label = ` ${c.kind} · ${authorLabel(c)} · ${status} `;
    const top = '┌' + label + '─'.repeat(Math.max(0, boxW - 2 - width(label))) + '┐';
    rows.push({ kind: 'text', key: `${keyPrefix}:${c.id}:t`, hunkId: c.hunkId, commentId: c.id, segs: [{ text: ' '.repeat(ind) }, { text: top, role }] });
    const body = wrap(flattenMarkdown(c.body) || ' ', inner);
    body.forEach((line, i) => {
      rows.push({
        kind: 'text',
        key: `${keyPrefix}:${c.id}:b${i}`,
        hunkId: c.hunkId,
        commentId: c.id,
        segs: [
          { text: ' '.repeat(ind) },
          { text: '│ ', role },
          { text: line + ' '.repeat(Math.max(0, inner - width(line))) },
          { text: ' │', role },
        ],
      });
    });
    rows.push({
      kind: 'text',
      key: `${keyPrefix}:${c.id}:e`,
      hunkId: c.hunkId,
      commentId: c.id,
      segs: [{ text: ' '.repeat(ind) }, { text: '└' + '─'.repeat(boxW - 2) + '┘', role }],
    });
  };
  box(root, 0);
  for (const r of replies) box(r, 2);
  return rows;
}

/** Flatten one layer into rows: the layer card, then its hunks in plan order with inline comment threads. */
export function buildRows(input: BuildInput): BuiltRows {
  const { layer, hunks, reviewed, comments, toggled } = input;
  const paneW = Math.max(20, input.width);
  const rows: Row[] = [];
  const layerHunks = layer.hunks.map((id) => hunks.get(id)).filter((h): h is Hunk => Boolean(h));

  let maxNo = 1;
  for (const h of layerHunks) maxNo = Math.max(maxNo, h.oldStart + h.oldLines, h.newStart + h.newLines);
  const numWidth = Math.max(3, String(maxNo).length);
  const gw = gutterWidth(numWidth);
  const codeWidth = Math.max(10, paneW - gw);

  // ---- layer card ----
  const cardText = (key: string, segs: Seg[]) => rows.push({ kind: 'text', key, segs, layerCard: true });
  const isUnstacked = layer.id === UNSTACKED_ID;
  if (isUnstacked) {
    cardText('card:title', [{ text: ' Unstacked', bold: true }, { text: ' · no plan yet', role: 'muted' }]);
    for (const [i, l] of wrap('Every hunk in file order. Ask your agent to plan this review with the rv-review skill (rv skill path).', paneW - 2).entries())
      cardText(`card:why${i}`, [{ text: ' ' + l, role: 'muted' }]);
  } else {
    cardText('card:title', [
      { text: ` ${layer.id === UNPLACED_ID ? '' : layer.id + ' · '}${layer.title}`, bold: true },
      ...(layer.group ? [{ text: `  (${layer.group})`, role: 'muted' as Role }] : []),
    ]);
    const why = flattenMarkdown(layer.why);
    if (why) {
      const lines = wrap(why, paneW - 7);
      lines.forEach((l, i) =>
        cardText(`card:why${i}`, i === 0 ? [{ text: ' Why: ', role: 'muted' }, { text: l }] : [{ text: '      ' + l }]),
      );
    }
    if (layer.dependsOn?.length) {
      const deps = layer.dependsOn
        .map((d) => {
          const dl = input.plan.layers.find((x) => x.id === d);
          return dl ? `${d} ${dl.title}` : d;
        })
        .join(', ');
      cardText('card:deps', [{ text: ' Depends on: ', role: 'muted' }, { text: deps }]);
    }
  }
  rows.push({ kind: 'text', key: 'card:blank', segs: [{ text: '' }], layerCard: true });

  // ---- hunks ----
  const roots = comments.filter((c) => c.kind !== 'reply');
  const repliesOf = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.kind === 'reply' && c.parentId) {
      const list = repliesOf.get(c.parentId) ?? [];
      list.push(c);
      repliesOf.set(c.parentId, list);
    }
  }
  const fileTotals = new Map<string, { added: number; removed: number }>();
  for (const h of layerHunks) {
    const t = fileTotals.get(h.path) ?? { added: 0, removed: 0 };
    const s = hunkStats(h);
    t.added += s.added;
    t.removed += s.removed;
    fileTotals.set(h.path, t);
  }
  let prevPath: string | null = null;
  const commentIndent = gw;
  for (const h of layerHunks) {
    const done = Boolean(reviewed[h.id]);
    if (isCollapsed(h.id, reviewed, toggled)) {
      const n = h.lines.length;
      rows.push({
        kind: 'collapsed',
        key: `h:${h.id}`,
        hunkId: h.id,
        segs: [
          { text: ' ' },
          { text: done ? '✓ ' : '▸ ', role: done ? 'riskLow' : 'muted' },
          { text: h.path, role: 'file' },
          { text: ` ${h.header}`, role: 'hunk' },
          { text: ` (collapsed, ${n} line${n === 1 ? '' : 's'})`, role: 'muted' },
        ],
      });
      prevPath = null; // show the file header again after a collapsed hunk
      continue;
    }
    if (h.path !== prevPath) {
      const t = fileTotals.get(h.path)!;
      const name = h.oldPath ? `${h.oldPath} → ${h.path}` : h.path;
      rows.push({
        kind: 'text',
        key: `f:${h.id}`,
        hunkId: h.id,
        segs: [
          { text: ' ' },
          { text: name, role: 'file', bold: true },
          { text: `  ${h.fileStatus}  `, role: 'muted' },
          { text: `+${t.added}`, role: 'add' },
          { text: ' ' },
          { text: `−${t.removed}`, role: 'del' },
        ],
      });
      prevPath = h.path;
    }
    rows.push({
      kind: 'hunk',
      key: `h:${h.id}`,
      hunkId: h.id,
      segs: [
        { text: ' ' },
        ...(done ? [{ text: '✓ ', role: 'riskLow' as Role }] : []),
        { text: h.header, role: 'hunk' },
      ],
    });
    const hunkRoots = roots.filter((c) => c.hunkId === h.id);
    const placed = new Set<string>();
    h.lines.forEach((l, idx) => {
      const text = expandTabs(l.text);
      const w = width(text);
      if (!input.wrap || w <= codeWidth) {
        rows.push({ kind: 'line', key: `l:${h.id}:${idx}`, hunkId: h.id, lineIndex: idx, start: 0, end: text.length, cont: false });
      } else {
        let start = 0;
        let part = 0;
        while (start < text.length) {
          let end = start;
          let used = 0;
          while (end < text.length) {
            const cp = text.codePointAt(end)!;
            const ch = String.fromCodePoint(cp);
            const cw = Math.max(0, Bun.stringWidth(ch));
            if (used + cw > codeWidth) break;
            used += cw;
            end += ch.length;
          }
          if (end === start) end = start + 1;
          rows.push({ kind: 'line', key: `l:${h.id}:${idx}:${part}`, hunkId: h.id, lineIndex: idx, start, end, cont: part > 0 });
          start = end;
          part++;
        }
      }
      for (const c of hunkRoots) {
        if (!placed.has(c.id) && lineAnchorMatches(c, h, idx)) {
          placed.add(c.id);
          rows.push(...threadRows(c, repliesOf.get(c.id) ?? [], commentIndent, paneW, `c:${h.id}`));
        }
      }
    });
    for (const c of hunkRoots) {
      if (!placed.has(c.id)) rows.push(...threadRows(c, repliesOf.get(c.id) ?? [], commentIndent, paneW, `c:${h.id}`));
    }
    rows.push({ kind: 'text', key: `gap:${h.id}`, hunkId: h.id, segs: [{ text: '' }] });
  }
  if (layerHunks.length === 0) rows.push({ kind: 'text', key: 'empty', segs: [{ text: ' (no hunks)', role: 'muted' }] });
  return { rows, numWidth, codeWidth };
}

/** Line anchor of a row, for comments typed on the cursor line. */
export function anchorOf(row: Row, hunks: Map<string, Hunk>): { side: 'old' | 'new'; number: number } | undefined {
  if (row.kind !== 'line') return undefined;
  const l = hunks.get(row.hunkId)?.lines[row.lineIndex];
  if (!l) return undefined;
  if (l.kind === 'del') return { side: 'old', number: l.oldNo! };
  return { side: 'new', number: l.newNo! };
}
