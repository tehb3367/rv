import type { Comment, Hunk, Plan } from './types.ts';

function quote(kind: string, body: string): string {
  return `[${kind}] ${body.trim().replace(/\n+/g, ' ')}`;
}

function anchorLabel(c: Comment): string {
  return c.line ? ` (line ${c.line.side}:${c.line.number})` : '';
}

/** Markdown review: one section per layer in plan order, one heading per commented hunk and anchor. */
export function exportMarkdown(plan: Plan, hunks: Hunk[], comments: Comment[], reviewed: Record<string, string> = {}): string {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const roots = comments.filter((c) => c.kind !== 'reply');
  const replies = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.kind === 'reply' && c.parentId) {
      const list = replies.get(c.parentId) ?? [];
      list.push(c);
      replies.set(c.parentId, list);
    }
  }
  const out: string[] = [`# Review: ${plan.title}`];
  if (plan.summary) out.push('', plan.summary.trim());
  for (const layer of plan.layers) {
    const done = layer.hunks.filter((id) => reviewed[id]).length;
    out.push('', `## ${layer.id} · ${layer.title} (risk: ${layer.risk})`);
    out.push(`Reviewed ${done}/${layer.hunks.length} hunks.`);
    for (const hunkId of layer.hunks) {
      const h = byId.get(hunkId);
      if (!h) continue;
      const threads = roots.filter((c) => c.hunkId === hunkId);
      if (!threads.length) continue;
      // Group by anchor so each heading names one line.
      const groups = new Map<string, Comment[]>();
      for (const c of threads) {
        const k = anchorLabel(c);
        const list = groups.get(k) ?? [];
        list.push(c);
        groups.set(k, list);
      }
      for (const [label, list] of groups) {
        out.push(`### ${h.path} ${h.header}${label}`);
        for (const c of list) {
          let line = `> ${quote(c.kind, c.body)}`;
          for (const r of replies.get(c.id) ?? []) line += ` → ${quote('reply', r.body)}`;
          out.push(line);
        }
      }
    }
  }
  return out.join('\n') + '\n';
}
