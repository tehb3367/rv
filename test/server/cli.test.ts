import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLocalSource } from '../../src/core/git.ts';
import { entryPath, listLive } from '../../src/core/registry.ts';
import { startServer, type RunningServer } from '../../src/server/server.ts';
import { Session } from '../../src/server/session.ts';
import { commitAll, initRepo, sh, tempDir, write } from '../helpers.ts';

const RV = resolve(import.meta.dir, '../../src/index.ts');
const home = tempDir('rv-home-');
process.env.RV_HOME = home;

let repo: string;
let session: Session;
let server: RunningServer;

// Async spawns: the session server runs in this test process, so a blocking spawn would deadlock it.
async function rv(args: string[], opts: { stdin?: string; cwd?: string } = {}) {
  const proc = Bun.spawn(['bun', RV, ...args], {
    cwd: opts.cwd ?? repo,
    env: { ...process.env, RV_HOME: home },
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: any = undefined;
  try {
    json = JSON.parse(out);
  } catch {
    /* not json */
  }
  return { code, out, err, json };
}
const rvAsync = rv;

beforeAll(async () => {
  repo = initRepo();
  write(repo, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
  write(repo, 'src/b.py', 'x = 1\n');
  commitAll(repo, 'base');
  sh(['git', 'checkout', '-q', '-b', 'feat'], repo);
  write(repo, 'src/a.ts', 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
  write(repo, 'src/b.py', 'x = 2\n');
  write(repo, 'src/c.go', 'package c\n');
  commitAll(repo, 'change');
  const src = await resolveLocalSource(repo, { range: 'main..feat' });
  session = await Session.open(src, () => resolveLocalSource(repo, { range: 'main..feat' }), { debounceMs: 10 });
  server = startServer(session);
});

afterAll(async () => {
  await server.stop();
});

describe('registry and discovery', () => {
  test('registry file is written with mode 0600', async () => {
    const p = entryPath(server.entry.id);
    expect(existsSync(p)).toBe(true);
    const mode = Bun.spawnSync(['stat', '-c', '%a', p]).stdout.toString().trim();
    expect(mode).toBe('600');
    const e = JSON.parse(readFileSync(p, 'utf8'));
    expect(e).toMatchObject({ id: server.entry.id, pid: process.pid, repoRoot: repo });
    expect(e.token).toHaveLength(64);
  });

  test('rv session list', async () => {
    const r = await rv(['session', 'list', '--json']);
    expect(r.code).toBe(0);
    expect(r.json).toEqual([{ id: server.entry.id, repoRoot: repo, base: session.src.base, head: session.src.head }]);
  });

  test('dead entries are removed', async () => {
    const dead = { ...server.entry, id: 's_dead', pid: 999999 };
    writeFileSync(entryPath('s_dead'), JSON.stringify(dead));
    expect(listLive().map((e) => e.id)).toEqual([server.entry.id]);
    expect(existsSync(entryPath('s_dead'))).toBe(false);
  });

  test('no session for this repo: exit 3', async () => {
    const other = initRepo();
    const r = await rv(['status', '--json'], { cwd: other });
    expect(r.code).toBe(3);
    expect(r.err).toContain('no live rv session for this repo, start one with rv diff or rv pr');
  });

  test('bad token: exit 4', async () => {
    const p = entryPath(server.entry.id);
    const orig = readFileSync(p, 'utf8');
    writeFileSync(p, JSON.stringify({ ...server.entry, token: 'x'.repeat(64) }));
    const r = await rv(['status', '--json']);
    writeFileSync(p, orig);
    expect(r.code).toBe(4);
  });

  test('several sessions: needs --session', async () => {
    const other = startServer(session);
    const r = await rv(['status', '--json']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--session');
    const r2 = await rv(['status', '--json', '--session', other.entry.id]);
    expect(r2.code).toBe(0);
    removeOther(other);
  });
});

function removeOther(other: RunningServer) {
  // stop without ending the shared session
  Bun.spawnSync(['rm', '-f', entryPath(other.entry.id)]);
}

describe('agent commands', () => {
  test('rv review --json --patch', async () => {
    const r = await rv(['review', '--json', '--patch']);
    expect(r.code).toBe(0);
    expect(r.json.files.map((f: any) => f.path)).toEqual(['src/a.ts', 'src/b.py', 'src/c.go']);
    const h = r.json.files[0].hunks[0];
    expect(h.id).toMatch(/^[0-9a-f]{10}$/);
    expect(h.lines).toContain('+export const a = 10;');
    expect(h.added).toBe(2);
    expect(h.removed).toBe(1);
    const plain = await rv(['review', '--json']);
    expect(plain.json.files[0].hunks[0].lines).toBeUndefined();
  });

  test('rv stack set: exit 2 with missing IDs, then accepted', async () => {
    const ids: string[] = session.hunks.map((h) => h.id);
    const bad = { version: 1, title: 'P', layers: [{ id: 'L1', title: 'One', why: 'w', risk: 'low', hunks: ids.slice(1) }] };
    const r = await rv(['stack', 'set', '--stdin'], { stdin: JSON.stringify(bad) });
    expect(r.code).toBe(2);
    expect(r.json.ok).toBe(false);
    expect(r.json.missing.map((m: any) => m.id)).toEqual([ids[0]]);
    const good = {
      version: 1,
      title: 'P',
      layers: [
        { id: 'L1', group: 'Core', title: 'TS', why: 'w', risk: 'med', hunks: [ids[0]] },
        { id: 'L2', title: 'Rest', why: 'w', risk: 'low', dependsOn: ['L1'], hunks: ids.slice(1) },
      ],
    };
    const file = join(tempDir(), 'plan.json');
    writeFileSync(file, JSON.stringify(good));
    const ok = await rv(['stack', 'set', '--file', file, '--json']);
    expect(ok.code).toBe(0);
    expect(ok.json).toEqual({ ok: true });
    const got = await rv(['stack', 'get', '--json']);
    expect(got.json.stale).toBe(false);
    expect(got.json.plan.layers.map((l: any) => l.id)).toEqual(['L1', 'L2']);
    const invalid = await rv(['stack', 'set', '--stdin'], { stdin: '{nope' });
    expect(invalid.code).toBe(2);
    expect(invalid.json.errors[0]).toContain('not valid JSON');
  });

  test('rv review --layer and --unreviewed', async () => {
    session.setReviewed([session.hunks[1]!.id], true);
    const r = await rv(['review', '--json', '--layer', 'L2', '--unreviewed']);
    expect(r.json.files.flatMap((f: any) => f.hunks.map((h: any) => h.id))).toEqual([session.hunks[2]!.id]);
    session.setReviewed([session.hunks[1]!.id], false);
  });

  test('rv note add, rv comments', async () => {
    const hunk = session.hunks[0]!.id;
    const r = await rv(['note', 'add', '--hunk', hunk, '--body', 'Note **md**', '--line', 'new:1', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.id).toMatch(/^c_[a-z0-9]{8}$/);
    const bad = await rv(['note', 'add', '--hunk', hunk, '--body', 'x', '--line', 'new:99', '--json']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('not in hunk');
    const list = await rv(['comments', '--json']);
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ kind: 'note', author: 'agent', line: { side: 'new', number: 1 } });
  });

  test('rv wait gets asks in under a second, each once; rv reply answers', async () => {
    const hunk = session.hunks[0]!.id;
    const waiting = rv(['wait', '--timeout', '30', '--json']);
    for (let i = 0; i < 100 && !session.agentWaiting; i++) await Bun.sleep(20);
    expect(session.agentWaiting).toBe(true);
    const ask = session.addHumanComment({ hunkId: hunk, line: { side: 'new', number: 1 }, kind: 'ask', body: 'Why 10?' });
    expect(ask.status).toBe('draft');
    const t0 = performance.now();
    expect(session.sendAsks()).toBe(1);
    const r = await waiting;
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(r.json.event).toBe('asks');
    expect(r.json.asks.map((a: any) => a.id)).toEqual([ask.id]);
    const pending = await rv(['comments', '--kind', 'ask', '--pending', '--json']);
    expect(pending.json.map((c: any) => c.id)).toEqual([ask.id]);
    // returned once: the next wait times out
    const again = await rv(['wait', '--timeout', '0.2', '--json']);
    expect(again.json).toEqual({ event: 'timeout' });
    const rep = await rv(['reply', '--to', ask.id, '--body', 'Because.', '--json']);
    expect(rep.code).toBe(0);
    const all = session.comments();
    expect(all.find((c) => c.id === ask.id)!.status).toBe('answered');
    expect(all.find((c) => c.id === rep.json.id)).toMatchObject({ kind: 'reply', parentId: ask.id, author: 'agent' });
  });

  test('rv status, navigate, export', async () => {
    session.setReviewed([session.hunks[0]!.id], true);
    const s = await rv(['status', '--json']);
    expect(s.json).toEqual({
      layers: [
        { id: 'L1', reviewed: 1, total: 1 },
        { id: 'L2', reviewed: 0, total: 2 },
      ],
      pendingAsks: 0,
      learning: false,
    });
    let nav: unknown = null;
    const off = session.bus.on((e) => e.type === 'navigate' && (nav = e.target));
    expect((await rv(['navigate', '--layer', 'L2', '--json'])).code).toBe(0);
    off();
    expect(nav).toEqual({ layer: 'L2' });
    expect((await rv(['navigate', '--layer', 'L9'])).code).toBe(1);
    const md = await rv(['export', '--md']);
    expect(md.out).toContain('# Review: P');
    expect(md.out).toContain('## L1 · TS (risk: med)');
    expect(md.out).toMatch(/### src\/a\.ts @@ .* @@ \(line new:1\)/);
    expect(md.out).toContain('> [ask] Why 10? → [reply] Because.');
  });

  test('rv submit on a local range fails clearly', async () => {
    const r = await rv(['submit', '--json']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('rv export --md');
  });

  test('reload keeps the plan and marks it stale', async () => {
    write(repo, 'src/d.ts', 'export {};\n');
    commitAll(repo, 'more');
    const r = await rv(['reload', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.stale).toBe(true);
    const got = await rv(['stack', 'get', '--json']);
    expect(got.json.stale).toBe(true);
    expect(got.json.newHunks).toHaveLength(1);
  });

  test('unknown flags are rejected', async () => {
    expect((await rv(['status', '--bogus'])).code).toBe(1);
  });
});

describe('done', () => {
  test('ending the review releases waiters with done and removes the registry file', async () => {
    const waiting = rv(['wait', '--json']);
    for (let i = 0; i < 100 && !session.agentWaiting; i++) await Bun.sleep(20);
    const id = server.entry.id;
    await server.stop();
    const r = await waiting;
    expect(r.json).toEqual({ event: 'done' });
    expect(existsSync(entryPath(id))).toBe(false);
    const state = JSON.parse(readFileSync(session.store.path, 'utf8'));
    expect(state.comments.length).toBeGreaterThan(0);
    expect(Object.keys(state.reviewed)).toHaveLength(1);
  });
});
