/** Display-width helpers for terminal cells. */

export const TAB_WIDTH = 4;

export function width(s: string): number {
  return Bun.stringWidth(s);
}

export function charWidth(ch: string): number {
  const w = Bun.stringWidth(ch);
  return w < 0 ? 0 : w;
}

/** Cut to at most `w` cells. */
export function truncate(s: string, w: number, ellipsis = '…'): string {
  if (w <= 0) return '';
  if (width(s) <= w) return s;
  let out = '';
  let used = 0;
  const limit = w - width(ellipsis);
  for (const ch of s) {
    const cw = charWidth(ch);
    if (used + cw > limit) break;
    out += ch;
    used += cw;
  }
  return out + ellipsis;
}

export function pad(s: string, w: number): string {
  const cur = width(s);
  return cur >= w ? s : s + ' '.repeat(w - cur);
}

export function fit(s: string, w: number): string {
  return pad(truncate(s, w), w);
}

/** Word-wrap plain text to `w` cells, keeping explicit newlines. */
export function wrap(s: string, w: number): string[] {
  if (w <= 0) return [s];
  const out: string[] = [];
  for (const para of s.split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (word === '') continue;
      if (width(line + word) <= w) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = /^\s+$/.test(word) ? '' : word;
      while (width(line) > w) {
        let head = '';
        for (const ch of line) {
          if (width(head + ch) > w) break;
          head += ch;
        }
        out.push(head);
        line = line.slice(head.length);
      }
    }
    if (line.trim() || out.length === 0) out.push(line.trimEnd());
  }
  return out;
}

/** Minimal markdown flattening for the terminal: drop emphasis markers, keep code and lists readable. */
export function flattenMarkdown(md: string): string {
  return md
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .trim();
}
