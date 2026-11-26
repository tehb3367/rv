import { createHash } from 'node:crypto';
import type { DiffLine, FileStatus, FileSummary, Hunk } from './types.ts';

type RawHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

type FileBlock = {
  oldPath?: string;
  newPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isCopy: boolean;
  isBinary: boolean;
  oldMode?: string;
  newMode?: string;
  hunks: RawHunk[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Unquote a git C-style quoted path ("a/foo\tbar"). Returns the input when not quoted. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(esc[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string | undefined {
  const path = unquotePath(p.trim());
  if (path === '/dev/null') return undefined;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/** Split a `---`/`+++` path from a trailing tab-separated timestamp. */
function headerPath(rest: string): string | undefined {
  const r = rest.startsWith('"') ? rest : rest.split('\t')[0]!;
  return stripPrefix(r);
}

function parseGitLine(rest: string): { oldPath?: string; newPath?: string } {
  // rest is everything after "diff --git "
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.*)$/.exec(rest);
    if (m) return { oldPath: stripPrefix(m[1]!), newPath: stripPrefix(m[2]!) };
  }
  // Unquoted, same path on both sides: "a/X b/X" is 2L + 5 characters long.
  if ((rest.length - 5) % 2 === 0) {
    const len = (rest.length - 5) / 2;
    const a = rest.slice(0, 2 + len);
    const b = rest.slice(3 + len);
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) {
      return { oldPath: a.slice(2), newPath: b.slice(2) };
    }
  }
  const idx = rest.indexOf(' b/');
  if (idx >= 0) return { oldPath: stripPrefix(rest.slice(0, idx)), newPath: stripPrefix(rest.slice(idx + 1)) };
  return {};
}

function newBlock(): FileBlock {
  return { isNew: false, isDeleted: false, isRename: false, isCopy: false, isBinary: false, hunks: [] };
}

/** Parse unified diff text (as produced by `git diff` or `gh pr diff`) into hunks with stable IDs. */
export function parseDiff(text: string): Hunk[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const blocks: FileBlock[] = [];
  let cur: FileBlock | null = null;
  let i = 0;
  const n = lines.length;

  const clean = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);

  while (i < n) {
    const line = clean(lines[i]!);
    if (line.startsWith('diff --git ')) {
      cur = newBlock();
      const p = parseGitLine(line.slice(11));
      cur.oldPath = p.oldPath;
      cur.newPath = p.newPath;
      blocks.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && clean(lines[i + 1]!).startsWith('+++ ')) {
      if (!cur || cur.hunks.length > 0) {
        cur = newBlock();
        blocks.push(cur);
      }
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(clean(lines[i + 1]!).slice(4));
      if (oldP === undefined) cur.isNew = true;
      if (newP === undefined) cur.isDeleted = true;
      if (oldP !== undefined) cur.oldPath = oldP;
      if (newP !== undefined) cur.newPath = newP;
      if (oldP === undefined && newP !== undefined && cur.oldPath === undefined) cur.oldPath = newP;
      if (newP === undefined && oldP !== undefined && cur.newPath === undefined) cur.newPath = oldP;
      i += 2;
      continue;
    }
    if (!cur) {
      i++;
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      const oldStart = parseInt(hm[1]!, 10);
      const oldLines = hm[2] === undefined ? 1 : parseInt(hm[2], 10);
      const newStart = parseInt(hm[3]!, 10);
      const newLines = hm[4] === undefined ? 1 : parseInt(hm[4], 10);
      const hunk: RawHunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      let oldRem = oldLines;
      let newRem = newLines;
      let oldNo = oldStart;
      let newNo = newStart;
      i++;
      while (i < n && (oldRem > 0 || newRem > 0)) {
        const raw = clean(lines[i]!);
        const c = raw[0];
        if (c === '\\') {
          const last = hunk.lines[hunk.lines.length - 1];
          if (last) last.noNewline = true;
          i++;
          continue;
        }
        if (c === '+') {
          hunk.lines.push({ kind: 'add', newNo: newNo++, text: raw.slice(1) });
          newRem--;
        } else if (c === '-') {
          hunk.lines.push({ kind: 'del', oldNo: oldNo++, text: raw.slice(1) });
          oldRem--;
        } else if (c === ' ' || raw === '') {
          hunk.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
          oldRem--;
          newRem--;
        } else {
          break; // malformed: stop this hunk
        }
        i++;
      }
      // A trailing "\ No newline at end of file" after the counts ran out.
      while (i < n && clean(lines[i]!).startsWith('\\')) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewline = true;
        i++;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('new file mode ')) {
      cur.isNew = true;
      cur.newMode = line.slice(14).trim();
    } else if (line.startsWith('deleted file mode ')) {
      cur.isDeleted = true;
      cur.oldMode = line.slice(18).trim();
    } else if (line.startsWith('old mode ')) {
      cur.oldMode = line.slice(9).trim();
    } else if (line.startsWith('new mode ')) {
      cur.newMode = line.slice(9).trim();
    } else if (line.startsWith('rename from ')) {
      cur.isRename = true;
      cur.oldPath = unquotePath(line.slice(12));
    } else if (line.startsWith('rename to ')) {
      cur.isRename = true;
      cur.newPath = unquotePath(line.slice(10));
    } else if (line.startsWith('copy from ')) {
      cur.isCopy = true;
      cur.oldPath = unquotePath(line.slice(10));
    } else if (line.startsWith('copy to ')) {
      cur.isCopy = true;
      cur.newPath = unquotePath(line.slice(8));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      cur.isBinary = true;
      const bm = /^Binary files (.*) and (.*) differ$/.exec(line);
      if (bm) {
        if (bm[1] === '/dev/null') cur.isNew = true;
        if (bm[2] === '/dev/null') cur.isDeleted = true;
      }
    }
    i++;
  }
  return buildHunks(blocks);
}

function statusOf(b: FileBlock): FileStatus {
  if (b.isBinary) return 'binary';
  if (b.isNew || b.isCopy) return 'added';
  if (b.isDeleted) return 'deleted';
  if (b.isRename) return 'renamed';
  if (b.hunks.length === 0 && b.oldMode && b.newMode && b.oldMode !== b.newMode) return 'mode';
  return 'modified';
}

export function hunkBody(lines: DiffLine[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (i > 0) out += '\n';
    out += (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text;
  }
  return out;
}

export function hunkIdFor(path: string, body: string): string {
  return createHash('sha1').update(path + '\n' + body).digest('hex').slice(0, 10);
}

function buildHunks(blocks: FileBlock[]): Hunk[] {
  const out: Hunk[] = [];
  for (const b of blocks) {
    const path = b.newPath ?? b.oldPath;
    if (!path) continue;
    const status = statusOf(b);
    const oldPath = b.oldPath && b.oldPath !== path ? b.oldPath : undefined;
    const seen = new Map<string, number>();
    const assign = (body: string) => {
      const base = hunkIdFor(path, body);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base}-${count}`;
    };
    if (status === 'binary' || b.hunks.length === 0) {
      let header: string;
      let body: string;
      if (status === 'binary') {
        header = b.isNew ? 'binary file added' : b.isDeleted ? 'binary file deleted' : 'binary file changed';
        body = `\0binary\n${oldPath ?? ''}`;
      } else if (status === 'renamed') {
        header = `rename ${oldPath ?? path} → ${path}`;
        body = `\0rename\n${oldPath ?? ''}`;
      } else if (status === 'mode') {
        header = `mode ${b.oldMode} → ${b.newMode}`;
        body = `\0mode\n${b.oldMode}\n${b.newMode}`;
      } else if (status === 'added') {
        header = 'empty file added';
        body = '\0added';
      } else if (status === 'deleted') {
        header = 'empty file deleted';
        body = '\0deleted';
      } else {
        continue; // nothing reviewable
      }
      out.push({
        id: assign(body),
        path,
        oldPath,
        fileStatus: status,
        header,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        lines: [],
        pseudo: true,
      });
      continue;
    }
    for (const h of b.hunks) {
      out.push({
        id: assign(hunkBody(h.lines)),
        path,
        oldPath,
        fileStatus: status,
        header: h.header,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
      });
    }
  }
  return out;
}

/** Group hunks by file, keeping first-appearance order. */
export function groupFiles(hunks: Hunk[]): FileSummary[] {
  const map = new Map<string, FileSummary>();
  for (const h of hunks) {
    let f = map.get(h.path);
    if (!f) {
      f = { path: h.path, oldPath: h.oldPath, status: h.fileStatus, hunks: [] };
      map.set(h.path, f);
    }
    f.hunks.push(h);
  }
  return [...map.values()];
}

export function hunkStats(h: Hunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of h.lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}
