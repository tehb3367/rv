import type { LineTokens } from '../core/highlight.ts';
import type { Palette } from '../core/theme.ts';
import type { DiffLine } from '../core/types.ts';
import type { Range } from '../core/worddiff.ts';
import { gutterWidth, type Role, type Seg } from './rows.ts';
import { TAB_WIDTH, charWidth, width } from './text.ts';

export type Cell = { text: string; fg?: string; bg?: string; bold?: boolean };

export function roleColor(role: Role | undefined, p: Palette): string | undefined {
  switch (role) {
    case undefined:
    case 'fg':
    case 'file':
      return p.fg;
    case 'muted':
      return p.muted;
    case 'gutter':
      return p.gutter;
    case 'focus':
      return p.focus;
    case 'add':
    case 'riskLow':
      return p.riskLow;
    case 'del':
    case 'riskHigh':
      return p.riskHigh;
    case 'riskMed':
      return p.riskMed;
    case 'ask':
    case 'hunk':
      return p.askBorder;
    case 'note':
      return p.noteBorder;
    case 'review':
      return p.reviewBorder;
  }
}

/** Merge adjacent cells with the same style. */
function merge(cells: Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    if (last && last.fg === c.fg && last.bg === c.bg && last.bold === c.bold) last.text += c.text;
    else if (c.text) out.push({ ...c });
  }
  return out;
}

/** Truncate a run of cells to `w` columns and pad with `bg` to exactly `w`. */
export function fitCells(cells: Cell[], w: number, bg?: string): Cell[] {
  const out: Cell[] = [];
  let used = 0;
  for (const c of cells) {
    if (used >= w) break;
    const cw = width(c.text);
    if (used + cw <= w) {
      out.push(c);
      used += cw;
      continue;
    }
    let t = '';
    for (const ch of c.text) {
      const chw = charWidth(ch);
      if (used + chw > w) break;
      t += ch;
      used += chw;
    }
    out.push({ ...c, text: t });
    break;
  }
  if (used < w) out.push({ text: ' '.repeat(w - used), bg });
  return merge(out);
}

export function segCells(segs: Seg[], p: Palette, bg?: string): Cell[] {
  return segs.map((s) => ({ text: s.text, fg: roleColor(s.role, p), bg, bold: s.bold }));
}

/** A styled, tab-expanded version of a diff line's text. */
export type StyledText = { text: string; fg: (string | undefined)[]; emph: boolean[] };

export function styleLine(text: string, tokens: LineTokens | undefined, emph: Range[] | undefined, p: Palette): StyledText {
  // Per code unit of the original text.
  const fgOrig: (string | undefined)[] = new Array(text.length).fill(p.fg);
  if (tokens) {
    let pos = 0;
    for (const t of tokens) {
      const color = p.color(t[1]) ?? p.fg;
      for (let i = 0; i < t[0].length && pos < text.length; i++) fgOrig[pos++] = color;
    }
  }
  const emphOrig: boolean[] = new Array(text.length).fill(false);
  for (const [s, e] of emph ?? []) for (let i = s; i < e && i < text.length; i++) emphOrig[i] = true;
  let out = '';
  const fg: (string | undefined)[] = [];
  const em: boolean[] = [];
  let col = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (ch === '\t') {
      const n = TAB_WIDTH - (col % TAB_WIDTH);
      for (let k = 0; k < n; k++) {
        out += ' ';
        fg.push(fgOrig[i]);
        em.push(emphOrig[i]!);
      }
      col += n;
    } else {
      out += ch;
      for (let k = 0; k < ch.length; k++) {
        fg.push(fgOrig[i]);
        em.push(emphOrig[i]!);
      }
      col += charWidth(ch);
    }
    i += ch.length;
  }
  return { text: out, fg, emph: em };
}

export type LineRenderInput = {
  line: DiffLine;
  styled: StyledText;
  start: number;
  end: number;
  cont: boolean;
  numWidth: number;
  paneWidth: number;
  wrap: boolean;
  cursor: boolean;
  palette: Palette;
  compact?: boolean;
};

export function lineBg(kind: DiffLine['kind'], p: Palette): string | undefined {
  return kind === 'add' ? p.addLine : kind === 'del' ? p.delLine : p.bg;
}

export function renderLine(i: LineRenderInput): Cell[] {
  const p = i.palette;
  const bg = lineBg(i.line.kind, p);
  const emphBg = i.line.kind === 'add' ? p.addWord : i.line.kind === 'del' ? p.delWord : bg;
  const cells: Cell[] = [];
  cells.push({ text: i.cursor ? '▌' : ' ', fg: p.focus, bg });
  const num = (n: number | undefined) => (n === undefined || i.cont ? ' '.repeat(i.numWidth) : String(n).padStart(i.numWidth));
  if (i.compact) cells.push({ text: num(i.line.kind === 'del' ? i.line.oldNo : i.line.newNo), fg: p.gutter, bg });
  else cells.push({ text: `${num(i.line.oldNo)} ${num(i.line.newNo)} `, fg: p.gutter, bg });
  const marker = i.cont ? ' ' : i.line.kind === 'add' ? '+' : i.line.kind === 'del' ? '-' : ' ';
  cells.push({ text: marker + ' ', fg: i.line.kind === 'add' ? p.riskLow : i.line.kind === 'del' ? p.riskHigh : p.gutter, bg });
  const codeW = i.paneWidth - gutterWidth(i.numWidth, i.compact);
  const s = i.styled;
  let used = 0;
  let overflow = false;
  for (let k = i.start; k < i.end && k < s.text.length; ) {
    const cp = s.text.codePointAt(k)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(ch);
    if (!i.wrap && used + cw > codeW - 1 && width(s.text.slice(k)) > codeW - used) {
      overflow = true;
      break;
    }
    cells.push({ text: ch, fg: s.fg[k], bg: s.emph[k] ? emphBg : bg });
    used += cw;
    k += ch.length;
  }
  if (overflow) cells.push({ text: '›', fg: p.muted, bg });
  if (i.line.noNewline && !i.cont && i.end >= s.text.length && !overflow) cells.push({ text: ' ⊘ no newline', fg: p.muted, bg });
  return fitCells(merge(cells), i.paneWidth, bg);
}
