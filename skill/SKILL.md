---
name: rv-review
description: Use when a live rv session is open for this repo, or the user asks you to plan or walk them through a review in rv. Builds a layered review plan for the diff and answers the reviewer's questions.
---

# rv review

rv is a terminal tool where a human reviews a large diff as an ordered stack of layers that **you** plan.
The human runs the TUI; you drive it only through `rv` CLI commands. Every command below takes `--json`;
always pass it and parse the output.

Exit codes: `0` ok, `1` error, `2` plan validation failed, `3` no live session, `4` bad token or version mismatch.

## 1. Find the session

```sh
rv session list --json
```

- An empty list means no review is open. Tell the user to run `rv diff` (local branch) or `rv pr <number>`
  in another terminal, then stop. **Never start one yourself**: it is an interactive TUI.
- If several sessions are live for this repo, add `--session <id>` to every later command.

## 2. Read the change

```sh
rv review --json --patch
```

This returns `{ files: [{ path, status, hunks: [{ id, header, added, removed, lines }] }] }`.
Every hunk has a stable `id`; the plan, notes and replies all refer to hunks by that id.

For very large diffs (thousands of lines), read `rv review --json` without `--patch` first to see the
shape, then read the patch a layer or file at a time with your own tools (`git diff <base>..<head> -- <path>`).
Binary files, pure renames, mode-only changes and empty files appear as one hunk with no lines; they must
still be placed in a layer.

## 3. Build the plan

A plan is JSON:

```json
{
  "version": 1,
  "title": "Add session persistence",
  "summary": "optional, one paragraph",
  "layers": [
    {
      "id": "L1",
      "group": "Storage",
      "title": "Session schema",
      "why": "Adds the Session type the store writes. Check the optional fields default sensibly.",
      "risk": "low",
      "hunks": ["3f9a1c22be", "a01b77e4c0"]
    },
    {
      "id": "L2",
      "group": "Storage",
      "title": "Persist sessions to disk",
      "why": "Sessions now survive restarts. Look at error handling on write and at concurrent saves.",
      "risk": "med",
      "dependsOn": ["L1"],
      "hunks": ["9c0d11ef42"]
    }
  ]
}
```

How to slice it:

- Group into cohorts (`group`), then ordered layers. Foundations come before what depends on them:
  types, schema and config first, then core logic, then API surfaces, then UI.
- Tests go in the layer they cover, or straight after it if they are large.
- Mechanical changes (renames, formatting, generated code, lockfiles) go in a final low-risk layer.
- Aim for 3 to 12 layers of no more than about 400 changed lines each.
- `why` explains intent and what the reviewer should check. Never just restate the diff. If you wrote the
  change, use what you know about why it was made.
- `risk` is `high` for auth, data migrations, concurrency, money and public APIs; `med` for core logic;
  `low` for the rest.
- Inside a layer, list hunks in reading order (definitions before uses).

Hard rules, enforced by `rv stack set`:

1. Every hunk id in the diff appears in **exactly one** layer.
2. No unknown hunk ids.
3. Layer ids are unique, there are 1 to 30 layers, and no layer is empty.
4. `dependsOn` only names layers earlier in the list.
5. `title` is at most 60 characters, `why` at most 800, `risk` is `low`, `med` or `high`.

## 4. Submit

```sh
rv stack set --stdin --json < plan.json
```

On exit code 2 the output lists what is wrong:

```json
{ "ok": false, "missing": [{ "id": "…", "path": "…", "header": "…" }],
  "duplicated": [{ "id": "…", "layers": ["L2", "L4"] }], "unknown": ["…"], "errors": ["…"] }
```

Fix the plan from that JSON and resubmit. Put each `missing` hunk in the layer it belongs to, keep each
`duplicated` hunk in one layer only, drop `unknown` ids. **Never drop real hunks to pass validation.**

Once accepted, the TUI switches to layer view. If the diff later changes, `rv stack get --json` returns
`stale: true` with `newHunks`; place them and resubmit the whole plan.

## 5. Notes, sparingly

```sh
rv note add --hunk <id> --line new:42 --body "Retry is unbounded here; see L4." --json
```

Only for things that are not obvious from the code: at most one note per hunk and about 10 in total.
`--line new:<n>` anchors to a line in the new file, `old:<n>` to a deleted line; leave it out to attach the
note to the whole hunk. Use `--stdin` for long markdown bodies.

## 6. Answer questions in a loop

```sh
rv wait --timeout 600 --json
```

- `{ "event": "asks", "asks": [...] }`: answer each ask with
  `rv reply --to <askId> --body "<markdown>" --json`. When your answer mentions other code, point the
  reviewer at it with `rv navigate --hunk <id>` (or `--layer <id>`, `--comment <id>`). Then wait again.
- `{ "event": "timeout" }`: wait again.
- `{ "event": "done" }`: the reviewer closed rv. Stop.

Each ask is delivered once. `rv comments --kind ask --pending --json` lists asks still waiting for an answer
if you lose track.

If an ask requests a code change, make it only if the user has allowed edits in this session. Otherwise
reply with the proposed patch in a fenced block. After editing files, run `rv reload --json` so the review
picks up the change, then check `rv stack get --json` for new hunks.

## 7. Never

- Never run `rv submit` unless the user explicitly asks you to post the review to GitHub.
- Never call rv's HTTP routes directly or read its registry or state files; use the CLI.
- Never start `rv diff` or `rv pr` yourself.
