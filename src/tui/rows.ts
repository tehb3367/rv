import { hunkStats } from '../core/diff.ts';
import type { Comment, Hunk, Layer, Plan } from '../core/types.ts';
import { UNPLACED_ID, UNSTACKED_ID } from '../core/types.ts';
import { RISK_BLURB } from '../core/glossary.ts';
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
  /** Phone-sized layout: one line-number column, tighter indents, shortened paths. */
  compact?: boolean;
  /** Learning mode: show the layer's plain-language explanation and what its risk level means. */
  learning?: boolean;
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

/**
 * Gutter: cursor column, old number, new number, marker and a space.
 * Compact: cursor column, one number (new side, or old for deleted lines), marker and a space.
 */
export function gutterWidth(numWidth: number, compact = false): number {
  return compact ? 1 + numWidth + 2 : 1 + numWidth + 1 + numWidth + 1 + 2;
}

/** Shorten a path from the left so it fits: "…/session/store.ts". */
export function shortenPath(path: string, max: number): string {
  if (width(path) <= max) return path;
  if (max <= 1) return '…';
  const parts = path.split('/');
  let out = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + out;
    if (width(next) + 2 > max) break;
    out = next;
  }
  out = '…/' + out;
  if (width(out) <= max) return out;
  return '…' + [...out].slice(-(max - 1)).join('');
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
export function threadRows(
  root: Comment,
  replies: Comment[],
  indent: number,
  paneWidth: number,
  keyPrefix: string,
  replyIndent = 2,
): Row[] {
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
    const boxW = Math.max(Math.min(12, paneWidth - ind), Math.min(72, paneWidth - ind - 1));
    const inner = boxW - 4;
    const role = kindRole(c);
    const status = c.kind === 'review' ? (c.postedAt ? 'posted' : c.status) : c.status;
    const full = ` ${c.kind} · ${authorLabel(c)} · ${status} `;
    const label = width(full) <= boxW - 3 ? full : ` ${c.kind} · ${status} `.slice(0, Math.max(0, boxW - 3));
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
  for (const r of replies) box(r, replyIndent);
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
  const compact = input.compact ?? false;
  const numWidth = Math.max(compact ? 2 : 3, String(maxNo).length);
  const gw = gutterWidth(numWidth, compact);
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
    if (why && compact) {
      wrap(why, paneW - 2).forEach((l, i) => cardText(`card:why${i}`, [{ text: ' ' + l }]));
    } else if (why) {
      const lines = wrap(why, paneW - 7);
      lines.forEach((l, i) =>
        cardText(`card:why${i}`, i === 0 ? [{ text: ' Why: ', role: 'muted' }, { text: l }] : [{ text: '      ' + l }]),
      );
    }
    if (input.learning) {
      const blocks: { label: string; text: string }[] = [];
      if (layer.explain) blocks.push({ label: ' In plain words: ', text: flattenMarkdown(layer.explain) });
      blocks.push({ label: ` Risk (${layer.risk}): `, text: RISK_BLURB[layer.risk].replace(/^\w+ risk: /, '') });
      for (const [bi, b] of blocks.entries()) {
        const lines = compact ? wrap(b.text, paneW - 2) : wrap(b.text, paneW - b.label.length - 1);
        if (compact) {
          cardText(`card:learn${bi}h`, [{ text: b.label.trimEnd(), role: 'ask', bold: true }]);
          lines.forEach((l, i) => cardText(`card:learn${bi}:${i}`, [{ text: ' ' + l }]));
        } else {
          lines.forEach((l, i) =>
            cardText(`card:learn${bi}:${i}`, [
              { text: i === 0 ? b.label : ' '.repeat(b.label.length), role: 'ask', bold: i === 0 },
              { text: l },
            ]),
          );
        }
      }
    }
    if (layer.dependsOn?.length) {
      const deps = layer.dependsOn
        .map((d) => {
          const dl = input.plan.layers.find((x) => x.id === d);
          return dl ? `${d} ${dl.title}` : d;
        })
        .join(', ');
      const label = ' Depends on: ';
      wrap(deps, paneW - label.length - 1).forEach((l, i) =>
        cardText(`card:deps${i}`, [{ text: i === 0 ? label : ' '.repeat(label.length), role: 'muted' }, { text: l }]),
      );
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
  const commentIndent = compact ? 2 : gw;
  for (const h of layerHunks) {
    const done = Boolean(reviewed[h.id]);
    if (isCollapsed(h.id, reviewed, toggled)) {
      const n = h.lines.length;
      const header = compact ? h.header.replace(/^(@@[^@]*@@).*$/, '$1') : h.header;
      const tail = compact ? ` (${n})` : ` (collapsed, ${n} line${n === 1 ? '' : 's'})`;
      const room = paneW - 3 - width(` ${header}`) - width(tail);
      rows.push({
        kind: 'collapsed',
        key: `h:${h.id}`,
        hunkId: h.id,
        segs: [
          { text: ' ' },
          { text: done ? '✓ ' : '▸ ', role: done ? 'riskLow' : 'muted' },
          { text: compact ? shortenPath(h.path, Math.max(8, room)) : h.path, role: 'file' },
          { text: ` ${header}`, role: 'hunk' },
          { text: tail, role: 'muted' },
        ],
      });
      prevPath = null; // show the file header again after a collapsed hunk
      continue;
    }
    if (h.path !== prevPath) {
      const t = fileTotals.get(h.path)!;
      const stats = `  ${h.fileStatus}  +${t.added} −${t.removed}`;
      const full = h.oldPath ? `${h.oldPath} → ${h.path}` : h.path;
      const name = compact ? shortenPath(full, Math.max(8, paneW - 2 - width(stats))) : full;
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
          // Prefer breaking after a space or punctuation in the last half of the row, so words stay whole.
          if (end < text.length) {
            const min = start + Math.floor((end - start) / 2);
            for (let k = end; k > min; k--) {
              if (/[\s,;(){}\[\]<>=+\-*/|&:]/.test(text[k - 1]!)) {
                end = k;
                break;
              }
            }
          }
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
