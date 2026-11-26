import { parseDiff } from '../core/diff.ts';
import { run } from '../core/exec.ts';
import { RvError, loadDiffText } from '../core/git.ts';
import { GH_LOGIN_HINT, ghAuthOk } from '../core/github.ts';
import { anchorsOf, buildReviewPayload } from '../core/review-payload.ts';
import type { Submitter } from './server.ts';
import type { Session } from './session.ts';

/** Posts one GitHub review for a PR session through `gh api`. */
export function makeSubmitter(session: Session): Submitter {
  let inFlight = false;
  return async (req) => {
    const src = session.src;
    if (src.prNumber === undefined) throw new RvError('local ranges cannot be submitted; use rv export --md');
    if (inFlight) throw new RvError('a submit is already in progress');
    inFlight = true;
    try {
      if (!(await ghAuthOk(src.repoRoot))) throw new RvError(GH_LOGIN_HINT);
      // GitHub only accepts anchors inside the PR's own diff (base..head), not local worktree edits.
      const prHunks = src.headMode === 'commit' ? session.hunks : parseDiff(await loadDiffText({ ...src, headMode: 'commit' }));
      const plan = session.rec.hasPlan ? session.view : { ...session.view, title: `PR #${src.prNumber}` };
      const { payload, postedIds } = buildReviewPayload({
        plan,
        hunks: session.hunks,
        comments: session.state.comments,
        reviewed: session.state.reviewed,
        commitId: src.head,
        event: req.event ?? 'COMMENT',
        includeAsks: req.includeAsks ?? false,
        validAnchors: anchorsOf(prHunks),
      });
      const repo = src.prRepo ?? '{owner}/{repo}';
      const r = await run(
        ['gh', 'api', `repos/${repo}/pulls/${src.prNumber}/reviews`, '--method', 'POST', '--input', '-'],
        { cwd: src.repoRoot, stdin: JSON.stringify(payload), allowFail: true },
      );
      if (r.code !== 0) throw new RvError(`gh api failed: ${r.stderr.trim() || r.stdout.trim()}`);
      let url = src.prUrl ?? '';
      try {
        const res = JSON.parse(r.stdout) as { html_url?: string };
        if (res.html_url) url = res.html_url;
      } catch {
        /* keep the PR url */
      }
      session.markPosted(postedIds);
      session.flush();
      return { url };
    } finally {
      inFlight = false;
    }
  };
}
