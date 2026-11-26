import type { Comment, Hunk, Plan } from './types.ts';

export type GhReviewComment = { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string };
export type GhReviewPayload = {
  commit_id: string;
  event?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  body: string;
  comments: GhReviewComment[];
};

export type PayloadInput = {
  plan: Plan;
  hunks: Hunk[];
  comments: Comment[];
  reviewed: Record<string, string>;
  commitId: string;
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' | 'DRAFT';
  includeAsks: boolean;
  /** "path\0side\0line" anchors GitHub accepts; when absent every hunk line is accepted. */
  validAnchors?: Set<string>;
};

export function anchorKey(path: string, side: 'LEFT' | 'RIGHT', line: number): string {
  return `${path}\0${side}\0${line}`;
}

/** Anchors GitHub accepts for review comments: RIGHT on added/context lines, LEFT on deleted/context lines. */
export function anchorsOf(hunks: Hunk[]): Set<string> {
  const out = new Set<string>();
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind !== 'del' && l.newNo) out.add(anchorKey(h.path, 'RIGHT', l.newNo));
      if (l.kind !== 'add' && l.oldNo) out.add(anchorKey(h.path, 'LEFT', l.oldNo));
    }
  }
  return out;
}

/** Where a comment goes: its line, or the hunk's last new line when it has none. */
export function placeComment(c: Comment, h: Hunk): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  if (c.line) return { line: c.line.number, side: c.line.side === 'new' ? 'RIGHT' : 'LEFT' };
  const newLines = h.lines.filter((l) => l.kind !== 'del' && l.newNo);
  if (newLines.length) return { line: newLines[newLines.length - 1]!.newNo!, side: 'RIGHT' };
  const oldLines = h.lines.filter((l) => l.kind !== 'add' && l.oldNo);
  if (oldLines.length) return { line: oldLines[oldLines.length - 1]!.oldNo!, side: 'LEFT' };
  return null;
}

export type BuiltPayload = { payload: GhReviewPayload; postedIds: string[] };

/** Build the GitHub review for the session. Comments already posted are never included again. */
export function buildReviewPayload(i: PayloadInput): BuiltPayload {
  const byId = new Map(i.hunks.map((h) => [h.id, h]));
  const replies = new Map<string, Comment[]>();
  for (const c of i.comments) {
    if (c.kind === 'reply' && c.parentId) {
      const list = replies.get(c.parentId) ?? [];
      list.push(c);
      replies.set(c.parentId, list);
    }
  }
  const eligible = i.comments.filter(
    (c) => !c.postedAt && c.status !== 'resolved' && (c.kind === 'review' || (i.includeAsks && c.kind === 'ask')),
  );
  const comments: GhReviewComment[] = [];
  const outside: string[] = [];
  const postedIds: string[] = [];
  for (const c of eligible) {
    const h = byId.get(c.hunkId);
    if (!h) continue;
    let body = c.body.trim();
    if (c.kind === 'ask') {
      body = `**Question:** ${body}`;
      for (const r of replies.get(c.id) ?? []) body += `\n\n**Agent:** ${r.body.trim()}`;
    }
    const at = placeComment(c, h);
    const ok = at && (!i.validAnchors || i.validAnchors.has(anchorKey(h.path, at.side, at.line)));
    if (at && ok) comments.push({ path: h.path, line: at.line, side: at.side, body });
    else {
      const where = c.line ? ` line ${c.line.side}:${c.line.number}` : '';
      outside.push(`- \`${h.path}\`${where}: ${body.replace(/\n+/g, ' ')}`);
    }
    postedIds.push(c.id);
    for (const r of replies.get(c.id) ?? []) if (c.kind === 'ask') postedIds.push(r.id);
  }
  const total = i.hunks.length;
  const done = i.hunks.filter((h) => i.reviewed[h.id]).length;
  const lines = [`**${i.plan.title}**`, '', `Reviewed with rv: ${done}/${total} hunks.`, ''];
  for (const l of i.plan.layers) {
    const d = l.hunks.filter((id) => i.reviewed[id]).length;
    lines.push(`- ${l.id} ${l.title} (risk: ${l.risk}): ${d}/${l.hunks.length} reviewed${d === l.hunks.length ? ' ✓' : ''}`);
  }
  if (outside.length) lines.push('', '### Comments outside the diff', '', ...outside);
  const payload: GhReviewPayload = {
    commit_id: i.commitId,
    ...(i.event !== 'DRAFT' ? { event: i.event } : {}),
    body: lines.join('\n'),
    comments,
  };
  return { payload, postedIds };
}
