import { describe, expect, test } from 'bun:test';
import { parseDiff } from '../../src/core/diff.ts';
import { anchorsOf, buildReviewPayload } from '../../src/core/review-payload.ts';
import type { Comment, Plan } from '../../src/core/types.ts';

const hunks = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,4 @@
 keep
-old
+new
 tail
diff --git a/gone.py b/gone.py
deleted file mode 100644
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`);
const [h1, h2, h3] = hunks;
const plan: Plan = { version: 1, title: 'Tidy things', layers: [{ id: 'L1', title: 'All', why: '', risk: 'low', hunks: hunks.map((h) => h.id) }] };
const mk = (id: string, extra: Partial<Comment>): Comment => ({
  id, hunkId: h1!.id, author: 'human', kind: 'review', body: 'b', status: 'draft', createdAt: 'x', ...extra,
});

describe('GitHub review payload', () => {
  test('inline comments on the right lines and sides', () => {
    const comments = [
      mk('c_new', { line: { side: 'new', number: 11 }, body: 'added line' }),
      mk('c_old', { line: { side: 'old', number: 11 }, body: 'deleted line' }),
      mk('c_ctx', { line: { side: 'new', number: 10 }, body: 'context' }),
      mk('c_none', { body: 'no anchor' }),
      mk('c_del', { hunkId: h2!.id, body: 'deleted file' }),
    ];
    const { payload, postedIds } = buildReviewPayload({
      plan, hunks, comments, reviewed: { [h1!.id]: 'x' }, commitId: 'abc', event: 'COMMENT', includeAsks: false, validAnchors: anchorsOf(hunks),
    });
    expect(payload.commit_id).toBe('abc');
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments).toEqual([
      { path: 'a.ts', line: 11, side: 'RIGHT', body: 'added line' },
      { path: 'a.ts', line: 11, side: 'LEFT', body: 'deleted line' },
      { path: 'a.ts', line: 10, side: 'RIGHT', body: 'context' },
      { path: 'a.ts', line: 12, side: 'RIGHT', body: 'no anchor' }, // the hunk's last new line
      { path: 'gone.py', line: 2, side: 'LEFT', body: 'deleted file' },
    ]);
    expect(postedIds).toHaveLength(5);
    expect(payload.body).toContain('**Tidy things**');
    expect(payload.body).toContain('Reviewed with rv: 1/3 hunks.');
    expect(payload.body).toContain('- L1 All (risk: low): 1/3 reviewed');
  });

  test('draft has no event; posted and resolved comments are never sent; asks only on request', () => {
    const comments = [
      mk('c_posted', { postedAt: 'yesterday', line: { side: 'new', number: 11 } }),
      mk('c_resolved', { status: 'resolved' }),
      mk('c_ask', { kind: 'ask', status: 'answered', body: 'why?', line: { side: 'new', number: 11 } }),
      mk('c_reply', { kind: 'reply', author: 'agent', parentId: 'c_ask', body: 'because' }),
    ];
    const base = { plan, hunks, comments, reviewed: {}, commitId: 'abc', includeAsks: false };
    const draft = buildReviewPayload({ ...base, event: 'DRAFT' });
    expect('event' in draft.payload).toBe(false);
    expect(draft.payload.comments).toEqual([]);
    expect(draft.postedIds).toEqual([]);
    const withAsks = buildReviewPayload({ ...base, event: 'APPROVE', includeAsks: true });
    expect(withAsks.payload.event).toBe('APPROVE');
    expect(withAsks.payload.comments).toEqual([{ path: 'a.ts', line: 11, side: 'RIGHT', body: '**Question:** why?\n\n**Agent:** because' }]);
    expect(withAsks.postedIds).toEqual(['c_ask', 'c_reply']);
  });

  test('comments outside the diff go into the body', () => {
    const comments = [mk('c_far', { line: { side: 'new', number: 99 }, body: 'worktree-only line' }), mk('c_bin', { hunkId: h3!.id, body: 'binary' })];
    const { payload, postedIds } = buildReviewPayload({
      plan, hunks, comments, reviewed: {}, commitId: 'abc', event: 'REQUEST_CHANGES', includeAsks: false, validAnchors: anchorsOf(hunks),
    });
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain('### Comments outside the diff');
    expect(payload.body).toContain('- `a.ts` line new:99: worktree-only line');
    expect(payload.body).toContain('- `img.png`: binary');
    expect(postedIds).toEqual(['c_far', 'c_bin']);
  });
});
