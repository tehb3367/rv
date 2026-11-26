import { randomId, randomToken, removeEntry, writeEntry, type RegistryEntry } from '../core/registry.ts';
import { VERSION } from '../version.ts';
import { Session, SessionError, parseLineAnchor, type LineAnchor } from './session.ts';

export const VERSION_HEADER = 'X-Rv-Version';

export type SubmitRequest = { event?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' | 'DRAFT'; includeAsks?: boolean };
export type Submitter = (req: SubmitRequest) => Promise<{ url: string }>;

export type ServerOptions = { submit?: Submitter; port?: number };

export type RunningServer = {
  entry: RegistryEntry;
  url: string;
  stop: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', [VERSION_HEADER]: VERSION },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof SessionError) return json({ ok: false, error: e.message }, e.status);
  return json({ ok: false, error: (e as Error).message ?? String(e) }, 500);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new SessionError('request body must be a JSON object');
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new SessionError(`${name} is required`);
  return v;
}

function anchor(v: unknown): LineAnchor | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return parseLineAnchor(v);
  if (typeof v === 'object') {
    const o = v as { side?: unknown; number?: unknown };
    if ((o.side === 'old' || o.side === 'new') && typeof o.number === 'number') return { side: o.side, number: o.number };
  }
  throw new SessionError('line must be "new:<n>", "old:<n>" or { side, number }');
}

/** Constant-time comparison of the bearer token. */
function tokenOk(req: Request, token: string): boolean {
  const h = req.headers.get('authorization') ?? '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export async function route(session: Session, req: Request, opts: ServerOptions): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const q = url.searchParams;
  const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';
  const m = req.method;
  try {
    if (m === 'GET' && path === '/health') return json({ ok: true, version: VERSION });
    if (m === 'GET' && path === '/review')
      return json(session.review({ patch: flag('patch'), layer: q.get('layer') ?? undefined, unreviewed: flag('unreviewed') }));
    if (m === 'GET' && path === '/stack') return json(session.stack());
    if (m === 'PUT' && path === '/stack') {
      let input: unknown;
      try {
        input = JSON.parse(await req.text());
      } catch (e) {
        return json({ ok: false, missing: [], duplicated: [], unknown: [], errors: [`plan is not valid JSON: ${(e as Error).message}`] }, 422);
      }
      const r = session.setStack(input);
      return r.ok ? json({ ok: true }) : json(r, 422);
    }
    if (m === 'GET' && path === '/comments')
      return json(session.comments({ kind: q.get('kind') ?? undefined, pending: flag('pending') }));
    if (m === 'POST' && path === '/comments') {
      const b = await body(req);
      const kind = b.kind ?? 'note';
      if (kind !== 'note') throw new SessionError('agents can only add notes');
      const c = session.addNote({ hunkId: str(b.hunkId, 'hunkId'), line: anchor(b.line), body: str(b.body, 'body') });
      return json({ id: c.id });
    }
    const replyMatch = /^\/comments\/([^/]+)\/reply$/.exec(path);
    if (m === 'POST' && replyMatch) {
      const b = await body(req);
      const c = session.reply(decodeURIComponent(replyMatch[1]!), str(b.body, 'body'));
      return json({ id: c.id });
    }
    if (m === 'GET' && path === '/wait') {
      const t = Number(q.get('timeout') ?? '600');
      const timeout = Number.isFinite(t) && t >= 0 ? Math.min(t, 3600) : 600;
      return json(await session.wait(timeout, req.signal));
    }
    if (m === 'POST' && path === '/navigate') {
      const b = await body(req);
      session.navigate({
        layer: typeof b.layer === 'string' ? b.layer : undefined,
        hunk: typeof b.hunk === 'string' ? b.hunk : undefined,
        comment: typeof b.comment === 'string' ? b.comment : undefined,
      });
      return json({ ok: true });
    }
    if (m === 'GET' && path === '/status') return json(session.status());
    if (m === 'GET' && path === '/export') return json({ markdown: session.exportMarkdown() });
    if (m === 'POST' && path === '/reload') {
      const b = await body(req);
      const args = Array.isArray(b.args) ? b.args.filter((a): a is string => typeof a === 'string') : undefined;
      await session.reload(args);
      return json({ ok: true, hunks: session.hunks.length, stale: session.rec.stale });
    }
    if (m === 'POST' && path === '/submit') {
      if (!opts.submit) throw new SessionError('this session cannot be submitted to GitHub (local range); use rv export --md', 409);
      const b = await body(req);
      const ev = b.event;
      if (ev !== undefined && ev !== 'COMMENT' && ev !== 'APPROVE' && ev !== 'REQUEST_CHANGES' && ev !== 'DRAFT')
        throw new SessionError('event must be COMMENT, APPROVE, REQUEST_CHANGES or DRAFT');
      return json(await opts.submit({ event: ev, includeAsks: b.includeAsks === true }));
    }
    return json({ ok: false, error: `no route ${m} ${path}` }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}

/** Start the loopback session server and register it. */
export function startServer(session: Session, opts: ServerOptions = {}): RunningServer {
  const token = randomToken();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    idleTimeout: 0, // rv wait holds requests open for minutes
    fetch: async (req) => {
      if (!tokenOk(req, token)) return json({ ok: false, error: 'bad token' }, 401);
      return route(session, req, opts);
    },
  });
  const src = session.src;
  const entry: RegistryEntry = {
    id: randomId('s_'),
    pid: process.pid,
    port: server.port!,
    token,
    repoRoot: src.repoRoot,
    base: src.base,
    head: src.headMode === 'commit' ? src.head : src.headLabel,
    ...(src.prNumber !== undefined ? { prNumber: src.prNumber } : {}),
    startedAt: new Date().toISOString(),
    version: VERSION,
  };
  writeEntry(entry);
  let stopped = false;
  return {
    entry,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      removeEntry(entry.id);
      session.end();
      await Bun.sleep(30); // let pending `done` responses flush
      await server.stop(true);
    },
  };
}
