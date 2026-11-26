import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { osc52 } from '../../src/tui/clipboard.ts';
import { resolvePrSource } from '../../src/core/github.ts';
import { Session } from '../../src/server/session.ts';
import { makeSubmitter } from '../../src/server/submit.ts';
import { makePrRepo } from '../fixtures/pr-repo.ts';
import { tempDir } from '../helpers.ts';

const RV = resolve(import.meta.dir, '../../src/index.ts');
const home = tempDir('rv-home-');
const fx = makePrRepo();
const env = { ...process.env, RV_HOME: home, PATH: `${fx.binDir}:${process.env.PATH}`, RV_STUB_GH_LOG: fx.log, RV_STUB_GH_PR_JSON: fx.prJson };
let proc: ReturnType<typeof Bun.spawn>;

async function rv(args: string[], stdin?: string) {
  const p = Bun.spawn(['bun', RV, ...args], { cwd: fx.clone, env, stdin: stdin ? Buffer.from(stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let json: any;
  try { json = JSON.parse(out); } catch { /* */ }
  return { code, out, err, json };
}

beforeAll(async () => {
  proc = Bun.spawn(['bun', RV, 'pr', '7', '--headless', '--json'], { cwd: fx.clone, env, stdout: 'pipe', stderr: 'pipe' });
  for (let i = 0; i < 100; i++) {
    const r = await rv(['session', 'list', '--json']);
    if (r.json?.length) return;
    await Bun.sleep(100);
  }
  throw new Error('rv pr did not start');
});

afterAll(() => proc.kill());

test('rv pr fetches the PR head and diffs merge-base..head', async () => {
  const s = await rv(['session', 'list', '--json']);
  expect(s.json[0].prNumber).toBe(7);
  expect(s.json[0].head).toBe(fx.head);
  const r = await rv(['review', '--json']);
  expect(r.json.files.map((f: any) => [f.path, f.status])).toEqual([
    ['src/app.ts', 'modified'],
    ['src/old.py', 'deleted'],
  ]);
});

test('rv submit posts one review with inline comments and never posts twice', async () => {
  const review = await rv(['review', '--json', '--patch']);
  const [app, old] = review.json.files;
  const plan = { version: 1, title: 'PR 7', layers: [{ id: 'L1', title: 'All', why: 'w', risk: 'low', hunks: [...app.hunks, ...old.hunks].map((h: any) => h.id) }] };
  expect((await rv(['stack', 'set', '--stdin'], JSON.stringify(plan))).code).toBe(0);
  const first = await rv(['submit', '--event', 'comment', '--json']);
  expect(first.code).toBe(0);
  expect(first.json.url).toBe('https://github.com/acme/widgets/pull/7#pullrequestreview-1');
  const calls = readFileSync(fx.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const api = calls.filter((c) => c.args[0] === 'api');
  expect(api).toHaveLength(1);
  expect(api[0].args).toEqual(['api', 'repos/acme/widgets/pulls/7/reviews', '--method', 'POST', '--input', '-']);
  expect(api[0].stdin.commit_id).toBe(fx.head);
  expect(api[0].stdin.event).toBe('COMMENT');
  expect(api[0].stdin.body).toContain('**PR 7**');
  const draft = await rv(['submit', '--event', 'draft', '--json']);
  expect(draft.code).toBe(0);
  const api2 = readFileSync(fx.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'api');
  expect('event' in api2[1].stdin).toBe(false);
});

test('rv pr without gh auth shows the login hint and exits 1', async () => {
  const bad = tempDir();
  await Bun.write(`${bad}/gh`, '#!/bin/sh\nexit 1\n');
  Bun.spawnSync(['chmod', '+x', `${bad}/gh`]);
  const p = Bun.spawn(['bun', RV, 'pr', '7', '--headless'], { cwd: fx.clone, env: { ...env, PATH: `${bad}:${process.env.PATH}` }, stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(1);
  expect(err).toContain('gh auth login');
});

test('OSC 52 clipboard escape', () => {
  expect(osc52('hi', {})).toBe('\x1b]52;c;aGk=\x07');
  expect(osc52('hi', { TMUX: '1' })).toBe('\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\');
});

test('human review comments are posted inline once, then never again', async () => {
  const oldPath = process.env.PATH;
  Object.assign(process.env, { PATH: env.PATH, RV_STUB_GH_LOG: fx.log, RV_STUB_GH_PR_JSON: fx.prJson });
  try {
    const src = await resolvePrSource('7', fx.clone);
    const s = await Session.open(src, () => resolvePrSource('7', fx.clone), { debounceMs: 5 });
    const app = s.hunks.find((h) => h.path === 'src/app.ts' && h.lines.some((l) => l.text.includes('40')))!;
    const added = app.lines.find((l) => l.kind === 'add')!;
    const removed = app.lines.find((l) => l.kind === 'del')!;
    s.addHumanComment({ hunkId: app.id, line: { side: 'new', number: added.newNo! }, kind: 'review', body: 'why 40?' });
    s.addHumanComment({ hunkId: app.id, line: { side: 'old', number: removed.oldNo! }, kind: 'review', body: 'was fine' });
    s.addHumanComment({ hunkId: app.id, line: { side: 'new', number: added.newNo! }, kind: 'ask', body: 'local only' });
    const submit = makeSubmitter(s);
    const before = readFileSync(fx.log, 'utf8').split('\n').filter(Boolean).length;
    await submit({ event: 'COMMENT' });
    await submit({ event: 'COMMENT' });
    const calls = readFileSync(fx.log, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'api');
    expect(calls).toHaveLength(2);
    expect(calls[0].stdin.comments).toEqual([
      { path: 'src/app.ts', line: added.newNo, side: 'RIGHT', body: 'why 40?' },
      { path: 'src/app.ts', line: removed.oldNo, side: 'LEFT', body: 'was fine' },
    ]);
    expect(calls[1].stdin.comments).toEqual([]);
    expect(s.state.comments.filter((c) => c.kind === 'review').every((c) => c.postedAt)).toBe(true);
    expect(s.state.comments.find((c) => c.kind === 'ask')!.postedAt).toBeUndefined();
  } finally {
    process.env.PATH = oldPath;
  }
});
